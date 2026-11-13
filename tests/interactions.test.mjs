import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { initialBearing } from "../src/domain/map.ts";
import { skyReference } from "../src/domain/starfield.ts";
import { constellationScene } from "../src/domain/constellations.ts";
import {deepSkyScene} from '../src/domain/deep-sky.ts';
import { weatherResponse } from './fixtures/weather.mjs';
import { parseWeather, WEATHER_TTL } from '../src/domain/weather.ts';
import { ellipsoidalRay } from '../src/domain/geodesy.ts';
import { parseShotText, shotFromPlan, shotLink } from '../src/domain/shot.ts';
import { parseSolveText2 } from '../src/domain/solve.ts';
import { skyAt, toRay, travel } from '../src/domain/position-alignment.ts';
import { projectDirection } from '../src/domain/celestial-projection.ts';
import { direction } from '../src/domain/ephemeris.ts';
import { dayEvents } from '../src/domain/day-events.ts';
import { cameraHeightSlider, initialPlan } from '../src/domain/plan.ts';
import { bodyPath } from '../src/domain/body-paths.ts';
import { activeShowers, meteorEstimate } from '../src/domain/meteor-showers.ts';
import { cometScene } from '../src/domain/comets.ts';
import { validateCometCatalog } from '../src/domain/comet-catalog.ts';

// Exercise real React handlers and state with an SDK test double; no WebGL is
// simulated, and these checks do not claim browser rendering verification.
class Events {
  handlers = new Map();
  on(name, callback) {
    const callbacks = this.handlers.get(name) ?? [];
    callbacks.push(callback);
    this.handlers.set(name, callbacks);
    return this;
  }
  emit(name, event) {
    for (const callback of this.handlers.get(name) ?? []) callback(event);
  }
}

class TestMap extends Events {
  static instances = [];
  sources = new Map();
  transitions = [];
  cameraSolutions = [];
  cameraViews = [];
  environments = [];
  paint = new Map();
  resizes = 0;
  renderedHeight = 0;
  customLayers = [];
  constructor(options) {
    super();
    this.options = options;
    options.container.classList.add("maplibregl-map");
    this.center = { lng: options.center[0], lat: options.center[1] };
    this.zoom = options.zoom;
    this.bearing = options.bearing;
    if (typeof options.style === "object")
      for (const [id, source] of Object.entries(options.style.sources))
        this.addSource(id, source);
    TestMap.instances.push(this);
    queueMicrotask(() => {
      this.emit("style.load");
      this.emit("idle");
    });
  }
  addControl() {
    return this;
  }
  addSource(id, source) {
    this.sources.set(id, {
      data: source.data,
      updates: 0,
      setData(data) {
        this.data = structuredClone(data);
        this.updates++;
      },
    });
  }
  getSource(id) {
    return this.sources.get(id);
  }
  addLayer(layer) { if (layer.type === "custom") this.customLayers.push(layer); }
  triggerRepaint() {}
  getCenter() {
    return this.center;
  }
  getZoom() {
    return this.zoom;
  }
  getBearing() {
    return this.bearing;
  }
  getPitch() { return this.pitch ?? 90; }
  setSourceTileLodParams(levels, ratio, id) {
    this.detail = { levels, ratio, id };
    this.detailWrites = (this.detailWrites ?? 0) + 1;
    this.sources.get(id).calculateTileZoom = () => 12;
  }
  getBounds() {
    return { contains: () => true };
  }
  areTilesLoaded() {
    return this.tilesLoaded ?? true;
  }
  isSourceLoaded(id) {
    return this.sources.has(id);
  }
  queryTerrainElevation() {
    return this.renderedHeight;
  }
  setVerticalFieldOfView(value) {
    this.verticalFov = value;
  }
  setSky(value) {
    this.environments.push(structuredClone(value));
  }
  setPaintProperty(layer, property, value) {
    this.paint.set(`${layer}/${property}`, structuredClone(value));
  }
  calculateCameraOptionsFromTo(eye, altitude, target, targetAltitude) {
    this.cameraSolutions.push({ eye, altitude, target, targetAltitude });
    return {
      center: [target.lng, target.lat],
      elevation: targetAltitude,
      zoom: 18,
    };
  }
  jumpTo(options) {
    this.cameraViews.push(options);
    if (options.pitch !== undefined) this.pitch = options.pitch;
    if (options.bearing !== undefined) this.bearing = options.bearing;
  }
  easeTo(options) {
    this.transitions.push(options);
    if (options.center)
      this.center = { lng: options.center[0], lat: options.center[1] };
    if (options.zoom !== undefined) this.zoom = options.zoom;
    this.emit("move");
    this.emit("moveend");
  }
  fitBounds(bounds, options) {
    this.transitions.push({ bounds, ...options });
    const [[west, south], [east, north]] = bounds;
    this.center = { lng: (west + east) / 2, lat: (south + north) / 2 };
    this.emit("move");
    this.emit("moveend");
  }
  resize() { this.resizes++; }
  remove() {
    this.customLayers.forEach((layer) => layer.onRemove?.());
    this.removed = true;
    this.handlers.clear();
  }
}

// GPU state is a component test double; actual depth clipping is browser-tested.
class TestCelestialLayer {
  type = "custom";
  constructor(report, onCamera) { this.report = report; this.onCamera = onCamera; }
  setVisible(visible) { this.visible = visible; }
  setScene(frame) {
    this.frame = frame;
    this.report({ planKey: frame.planKey, states: { sun: frame.ready ? "clear" : "waiting", moon: frame.ready ? "clear" : "waiting" } });
  }
  invalidate() { if (this.frame) this.report({ planKey: this.frame.planKey, states: { sun: "waiting", moon: "waiting" } }); }
  onRemove() { this.removed = true; }
}

class TestStarfieldLayer {
  type = "custom";
  constructor(report) { this.report=report; }
  setContrast(percent=100) { this.contrast=percent; }
  setCameraResponse(response='stock') { this.cameraResponse=response; }
  setScene(frame) {
    this.frame=frame;
    const sky=skyReference(frame.plan);
    const figures=frame.plan.layers.constellations?constellationScene(frame.plan).anchors:[];
    const deep=frame.plan.layers.deepSky?deepSkyScene(frame.plan).objects:[];
    const stations=frame.plan.layers.stations?(frame.stations?.points??[]):[];
    const radiants=frame.plan.layers.meteors?activeShowers(frame.plan).map(a=>a.point):[];
    const heads=frame.plan.layers.comets?(frame.comets?.views??[]).map(v=>v.point):[];
    this.report({planKey:frame.planKey,orbitKey:frame.stations?.key,ready:frame.ready,view:{azimuth:frame.plan.azimuth,pitch:frame.plan.pitch},states:Object.fromEntries([...sky.points,sky.core,...figures,...deep,...stations,...radiants,...heads,...deep.map(p=>({...p,id:p.id+':label'}))].map(p=>[p.id,frame.ready?'clear':'waiting'])),deepSky:{phase:frame.plan.layers.deepSky?'ready':'off'}});
  }
  invalidate() { if(this.frame)this.report({planKey:this.frame.planKey,ready:false,view:null,states:{}}); }
  onRemove() { this.removed=true; }
}

class TestBuildingLayer {
  id="preview-buildings";type="custom";loads=0;key="";
  constructor(report){this.report=report;}
  setVisible(visible){this.visible=visible;}
  setScene(plan,_environment,_sun,_visibility,retry=0){
    const key=`${!!plan.layers.buildings}/${plan.longitude}/${plan.latitude}/${retry}`;
    if(key===this.key)return;this.key=key;this.loads++;
    this.status={key:`${plan.longitude}/${plan.latitude}`,phase:plan.layers.buildings?"ready":"off",limited:false,tiles:4,polygons:200,triangles:2400,bytes:172800,skipped:0,version:"test-fixture"};
    this.report(this.status);
  }
  onRemove(){this.removed=true;}
}

class TestMarker extends Events {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.positionWrites = 0;
    TestMarker.instances.push(this);
  }
  setLngLat([lng, lat]) {
    this.point = { lng, lat };
    this.positionWrites++;
    return this;
  }
  getLngLat() {
    return this.point;
  }
  getElement() {
    return this.options.element;
  }
  setRotation(angle) {
    this.rotation = angle;
    return this;
  }
  addTo(map) {
    map.options.container.append(this.options.element);
    return this;
  }
  remove() {
    this.options.element.remove();
    this.handlers.clear();
  }
}

let server, App, createRoot, dom;
let sequence = 0;
let groundResponse;
let pollutionResponse;
let weatherLoader;
const weatherRequests = [];
const pollutionRequests = [];
const terrainSize = { width: 600, height: 400 };
const resizeObservers = [];
const groundRequests = [];
const frames = new Map();
const nativeCapture = new WeakMap();
const originalGlobals = new Map();

function installGlobal(name, value) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

before(async () => {
  installGlobal("__testWeatherLoader", (point, signal, now, model) => { weatherRequests.push({ point, signal, model }); return weatherLoader(point, signal, now, model); });
  installGlobal("__testCelestialLayer", TestCelestialLayer);
  installGlobal("__testStarfieldLayer", TestStarfieldLayer);
  installGlobal("__testBuildingLayer", TestBuildingLayer);
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "PointerEvent",
  ])
    installGlobal(name, name === "window" ? dom.window : dom.window[name]);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // JSDOM has no modal top layer. Verify the native method entry points here;
  // real focus containment, Escape and responsive layout are browser-checked.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.classList.contains("terrain-canvas") ? terrainSize.width : 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("terrain-canvas") ? terrainSize.height : 0;
    },
  });
  installGlobal("__testPollutionLoader", (point, signal) => {
    pollutionRequests.push({ point, signal });
    return pollutionResponse(point, signal);
  });
  installGlobal("__testGroundLoader", (point, _url, signal) => {
    groundRequests.push({ point, signal });
    return groundResponse(point, signal);
  });
  installGlobal("requestAnimationFrame", (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  installGlobal("cancelAnimationFrame", (id) => frames.delete(id));
  installGlobal(
    "ResizeObserver",
    class {
      constructor(callback) {
        this.callback = callback;
        resizeObservers.push(this);
      }
      observe(target) {
        this.target = target;
      }
      disconnect() {}
    },
  );
  dom.window.HTMLElement.prototype.setPointerCapture = function (id) {
    nativeCapture.set(this, id);
  };
  dom.window.HTMLElement.prototype.hasPointerCapture = function (id) {
    return nativeCapture.get(this) === id;
  };
  dom.window.HTMLElement.prototype.releasePointerCapture = function () {
    nativeCapture.delete(this);
  };
  installGlobal("__testMapSDK", {
    Map: TestMap,
    Marker: TestMarker,
    NavigationControl: class {},
    ScaleControl: class {},
  });
  ({ createRoot } = await import("react-dom/client"));
  server = await createServer({
    cacheDir: "node_modules/.vite-tests",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: "custom",
    plugins: [
      {
        name: "test-map-sdk",
        enforce: "pre",
        load(id) {
          if (id.replaceAll("\\", "/").endsWith("/src/preview/starfield-layer.ts"))
            return "export const StarfieldLayer = globalThis.__testStarfieldLayer;";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/building-layer.ts"))
            return "export const BuildingLayer = globalThis.__testBuildingLayer;";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/celestial-layer.ts"))
            return "export const CelestialLayer = globalThis.__testCelestialLayer;";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/light-pollution.ts"))
            return "export const sampleLightPollution = (...args) => globalThis.__testPollutionLoader(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/weather.ts"))
            return "export const loadWeather = (...args) => globalThis.__testWeatherLoader(...args);\n" +
              "export const loadWeatherSource = (...args) => (globalThis.__testWeatherSourceLoader ?? (() => Promise.reject(new Error('no source'))))(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/tides.ts"))
            return "export const loadTides = (...args) => (globalThis.__testTideLoader ?? (() => Promise.reject(new Error('no tides'))))(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/aurora.ts"))
            return "export const loadKp = (...args) => (globalThis.__testKpLoader ?? (() => Promise.reject(new Error('no kp'))))(...args);\n" +
              "export const loadOvation = (...args) => (globalThis.__testOvationLoader ?? (() => Promise.reject(new Error('no ovation'))))(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/geocode.ts"))
            return "export const searchPlaces = (...args) => globalThis.__testPlaceSearch(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/elevation.ts"))
            return "export const groundElevation = (...args) => globalThis.__testGroundLoader(...args);\n" +
              // Line sampling for 推算 · 找机位: flat ground at 0 m unless a test installs another.
              "export const elevationTiles = (...args) => (globalThis.__testElevationTiles ?? (async (points, url, signal, progress) => { progress?.(1, 1); return () => 0; }))(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/feasibility.ts"))
            return "export const loadFeatures = (...args) => (globalThis.__testFeatures ?? (async () => ({ features: { water: [], buildings: [] }, tiles: 0, fetched: 0 })))(...args);";
          if (id.replaceAll("\\", "/").endsWith("/src/map/sdk.ts"))
            return "export const {Map, Marker, NavigationControl, ScaleControl} = globalThis.__testMapSDK;";
        },
      },
    ],
  });
  ({ default: App } = await server.ssrLoadModule("/src/App.tsx"));
});

after(async () => {
  await server?.close();
  dom?.window.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function settle(action = () => {}) {
  await act(async () => {
    action();
  });
  for (let index = 0; frames.size && index < 8; index++) {
    const batch = [...frames.values()];
    frames.clear();
    await act(async () => {
      for (const callback of batch) callback(index * 16);
    });
  }
  assert.equal(frames.size, 0, "animation work should settle");
}

async function waitForMap() {
  for (let index = 0; index < 200; index++) {
    const map = TestMap.instances
      .filter(
        (instance) =>
          !instance.removed && instance.getSource("tamatamatori-view"),
      )
      .at(-1);
    if (map) {
      await settle();
      return map;
    }
    await act(async () => {
      await delay(5);
    });
  }
  throw new Error("Map test double did not initialize");
}

async function workspace(
  t,
  elevation = async () => ({ height: 1000, zoom: 12 }),
  { keepStorage = false } = {},
) {
  groundResponse = elevation;
  pollutionRequests.length = 0;
  weatherRequests.length = 0;
  weatherLoader = async () => parseWeather(weatherResponse(), Date.now());
  pollutionResponse = async () => ({ artificialMcd: 6.5 });
  groundRequests.length = 0;
  resizeObservers.length = 0;
  TestMap.instances.length = 0;
  TestMarker.instances.length = 0;
  // Saved shots and the restored session must not leak between tests;
  // `keepStorage` simulates a page reload within one test.
  if (!keepStorage) dom.window.localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    frames.clear();
  });
  await act(async () => root.render(createElement(App)));
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, map: await waitForMap(), unmount };
}

function input(label) {
  return inputIn(document, label);
}
/** A labelled input inside one part of the page (the same label may appear elsewhere). */
function inputIn(root, label) {
  const field = [...root.querySelectorAll("label")].find(
    (element) =>
      element.querySelector(".field-label")?.textContent.trim() === label,
  );
  assert.ok(field, `missing input ${label}`);
  return field.querySelector("input");
}
async function chooseTimeZone(zone, query = zone) {
  await settle(() => document.querySelector(".timezone-trigger").click());
  await settle(() => setControl(document.querySelector('[aria-label="搜索时区"]'), query));
  await settle(() => document.querySelector(`.timezone-list [data-zone="${zone}"]`).click());
}
function shootingDateTime() {
  return `${document.querySelector('input[type="date"]').value}T${document.querySelector('input[type="time"]').value.slice(0, 5)}`;
}
async function setShootingDateTime(local) {
  await settle(() => setControl(document.querySelector('input[type="date"]'), local.slice(0, 10)));
  await settle(() => setControl(document.querySelector('input[type="time"]'), local.slice(11)));
}
function value(label) {
  return Number(input(label).value);
}
function button(label) {
  const match = [...document.querySelectorAll("button")].find(
    (element) => element.textContent.trim() === label,
  );
  assert.ok(match, `missing button ${label}`);
  return match;
}
function clickMap(map, lng, lat) {
  map.emit("click", {
    lngLat: { lng, lat },
    originalEvent: { target: map.options.container },
  });
}
function setControl(element, value) {
  const prototype =
    element.tagName === "SELECT"
      ? dom.window.HTMLSelectElement.prototype
      : element.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(
    element,
    String(value),
  );
  element.dispatchEvent(
    new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
}
function camera() {
  return TestMarker.instances.find(
    (marker) => marker.getElement().className === "camera-position-marker",
  );
}
function heading() {
  return TestMarker.instances.find(
    (marker) => marker.getElement().className === "camera-direction-marker",
  );
}
function geometry(map) {
  return map.getSource("tamatamatori-view").data;
}

test("默认空白点击不改变机位；明确放置只生效一次，且可取消", async (t) => {
  const { map } = await workspace(t);
  const latitude = value("纬度"),
    longitude = value("经度");
  await settle(() => clickMap(map, 140, 36));
  assert.equal(value("纬度"), latitude);
  assert.equal(value("经度"), longitude);
  await settle(() => button("放置机位").click());
  await settle(() => clickMap(map, 140, 36));
  assert.equal(value("纬度"), 36);
  assert.equal(value("经度"), 140);
  await settle(() => clickMap(map, 142, 38));
  assert.equal(value("纬度"), 36);
  await settle(() => button("放置机位").click());
  await settle(() =>
    button("放置机位").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await settle(() => clickMap(map, 143, 39));
  assert.equal(value("经度"), 140);
});

test("机位拖动中即更新参数和扇形，并保持时间不变", async (t) => {
  const { map } = await workspace(t);
  const time = shootingDateTime();
  const marker = camera();
  const positionWrites = marker.positionWrites;
  await settle(() => {
    marker.emit("dragstart");
    marker.setLngLat([139, 35.6]);
    marker.emit("drag");
  });
  assert.equal(value("纬度"), 35.6);
  assert.equal(value("经度"), 139);
  assert.deepEqual(
    geometry(map).features[0].geometry.coordinates[0][0],
    [139, 35.6],
  );
  assert.equal(
    shootingDateTime(),
    time,
  );
  assert.equal(
    marker.positionWrites,
    positionWrites + 1,
    "SDK keeps control of the marker while it is being dragged",
  );
  await settle(() => marker.emit("dragend"));
});

test("方向拖动中即更新扇形；地图旋转保持地理朝向且在换位后保留浏览角", async (t) => {
  const { map } = await workspace(t);
  const latitude = value("纬度"),
    longitude = value("经度");
  await settle(() => {
    const marker = heading();
    marker.emit("dragstart");
    marker.setLngLat([longitude + 0.02, latitude]);
    marker.emit("drag");
  });
  assert.ok(Math.abs(value("方位角") - 90) < 0.1);
  assert.equal(value("纬度"), latitude);
  assert.equal(value("经度"), longitude);
  await settle(() => heading().emit("dragend"));
  const azimuth = value("方位角");
  await settle(() => {
    map.bearing = 75;
    map.emit("rotate");
    map.emit("moveend");
  });
  assert.equal(value("方位角"), azimuth);
  assert.equal(heading().rotation, azimuth);
  assert.equal(map.options.dragRotate, true);
  await settle(() => document.querySelector('[aria-label="对调地图与预览位置"]').click());
  // Swapping only reorders the panels: the same map keeps its browsing bearing.
  assert.equal(await waitForMap(), map);
  assert.ok(!map.removed);
  assert.equal(map.bearing, 75);
  assert.equal(heading().rotation, azimuth);
});

test("缩放过程按帧更新扇形，连续事件合并，不等待 moveend", async (t) => {
  const { map } = await workspace(t);
  const source = map.getSource("tamatamatori-view");
  const before = geometry(map).features[1].geometry.coordinates[1];
  const count = source.updates;
  await settle(() => {
    for (let index = 0; index < 5; index++) {
      map.zoom += 0.2;
      map.emit("zoom");
    }
  });
  const after = geometry(map).features[1].geometry.coordinates[1];
  assert.notDeepEqual(after, before);
  assert.equal(source.updates - count, 1);
  assert.equal(value("焦距"), 35);
  await settle(() =>
    document.querySelector('button[aria-label="全球视图"]').click(),
  );
  assert.ok(map.transitions.at(-1).duration > 0);
});

test("拖动预览联动地图方向和俯仰，结束后不继续转动或移动机位", async (t) => {
  const { map } = await workspace(t);
  const frame = document.querySelector(".viewfinder");
  frame.getBoundingClientRect = () => ({ width: 600, height: 400 });
  const longitude = value("经度"),
    latitude = value("纬度"),
    azimuth = value("方位角"),
    pitch = value("俯仰角");
  const pointer = (type, x, y) =>
    frame.dispatchEvent(
      new dom.window.PointerEvent(type, {
        pointerId: 1,
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    );
  await settle(() => pointer("pointerdown", 300, 200));
  await settle(() => pointer("pointermove", 370, 250));
  assert.notEqual(value("方位角"), azimuth);
  assert.ok(value("俯仰角") > pitch);
  assert.equal(value("经度"), longitude);
  assert.equal(value("纬度"), latitude);
  const line = geometry(map).features[1].geometry.coordinates;
  assert.ok(
    Math.abs(
      initialBearing(
        { longitude: line[0][0], latitude: line[0][1] },
        { longitude: line[1][0], latitude: line[1][1] },
      ) - value("方位角"),
    ) < 1e-6,
  );
  await settle(() => pointer("pointerup", 370, 250));
  const stopped = value("方位角");
  await settle(() => pointer("pointermove", 450, 300));
  assert.equal(value("方位角"), stopped);
});

test("24 小时滑杆更新同一天的当地时间，焦距上限和竖幅同步到地图及取景框", async (t) => {
  const { map } = await workspace(t);
  const date = document.querySelector('input[type="date"]').value;
  await settle(() =>
    setControl(
      document.querySelector('input[aria-label="24 小时时间滑杆"]'),
      720,
    ),
  );
  assert.equal(
    shootingDateTime(),
    `${date}T12:00`,
  );
  await settle(() =>
    setControl(document.querySelector('input[aria-label="焦距滑块"]'), 1000),
  );
  assert.equal(value("焦距"), 1000);
  assert.equal(input("焦距").max, "1000");
  const before = geometry(map).features[0].geometry.coordinates[0][1];
  await settle(() =>
    setControl(
      document.querySelector('select[aria-label="拍摄画幅方向"]'),
      "portrait",
    ),
  );
  assert.equal(
    document.querySelector(".viewfinder").style.aspectRatio,
    String(2 / 3),
  );
  assert.notDeepEqual(
    geometry(map).features[0].geometry.coordinates[0][1],
    before,
  );
});

test("时间滑杆遇到夏令时跳过的钟点时显示错误并保留原时间", async (t) => {
  await workspace(t);
  await chooseTimeZone("America/New_York");
  await setShootingDateTime('2026-03-08T03:30');
  assert.equal(shootingDateTime(), "2026-03-08T03:30");
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  await settle(() => setControl(slider, 150));
  assert.equal(shootingDateTime(), "2026-03-08T03:30");
  assert.equal(slider.value, "210");
  assert.equal(slider.getAttribute("aria-invalid"), "true");
  assert.ok(
    document.getElementById("time-error").textContent.includes("夏令时"),
  );
});

async function waitUntil(predicate) {
  for (let index = 0; index < 200; index++) {
    await act(async () => {
      await delay(5);
    });
    await settle();
    const result = predicate();
    if (result) return result;
  }
  throw new Error("Terrain state did not settle");
}
function terrainMap() {
  return TestMap.instances
    .filter((map) => !map.removed && typeof map.options.style === "object")
    .at(-1);
}
async function readyTerrain() {
  return waitUntil(() => {
    const map = terrainMap();
    return map?.cameraSolutions.length &&
      document.querySelector(".terrain-canvas")?.dataset.ready === "true"
      ? map
      : null;
  });
}

test("三维预览启用真实地形与水体；缺失 DEM 返回的零值不覆盖独立高程", async (t) => {
  await workspace(t);
  const map = await readyTerrain();
  assert.equal(map.options.style.terrain.exaggeration, 1);
  assert.equal(
    map.options.style.layers.find((layer) => layer.id === "preview-water")[
      "source-layer"
    ],
    "water",
  );
  assert.equal(map.options.interactive, false);
  assert.equal(map.options.centerClampedToGround, false);
  const pose = map.cameraSolutions.at(-1);
  assert.equal(pose.altitude, 1001.6);
  assert.equal(pose.eye.lng, value("经度"));
  assert.equal(pose.eye.lat, value("纬度"));
  assert.equal(map.cameraViews.at(-1).pitch, 94);
  assert.ok(
    document.querySelector(".ground-elevation").textContent.includes("1000.0"),
  );
  assert.ok(
    document
      .querySelector(".about-dialog")
      .textContent.includes("Mapterhorn"),
  );
  await settle(() => {
    map.renderedHeight = 1012;
    map.emit("sourcedata");
  });
  assert.equal(map.cameraSolutions.at(-1).altitude, 1013.6);
});

test("SDK 样式后加载时，预览容器仍显式填满取景框", async (t) => {
  const style = document.createElement("style");
  // jsdom does not calculate layout. Verify the explicit fill dimensions with
  // the real SDK stylesheet; actual pixel sizes still need browser verification.
  style.textContent = [
    "../src/preview/terrain.css",
    "../node_modules/maplibre-gl/dist/maplibre-gl.css",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  document.head.append(style);
  t.after(() => style.remove());
  await workspace(t);
  await readyTerrain();
  const canvas = document.querySelector(".terrain-canvas");
  assert.ok(canvas.classList.contains("maplibregl-map"));
  const computed = dom.window.getComputedStyle(canvas);
  assert.equal(computed.width, "100%");
  assert.equal(computed.height, "100%");
});

test("隐藏面板有高程后保持等待，恢复有效尺寸即可建立相机", async (t) => {
  terrainSize.width = 0;
  terrainSize.height = 0;
  t.after(() => {
    terrainSize.width = 600;
    terrainSize.height = 400;
  });
  await workspace(t);
  await waitUntil(() => groundRequests.length);
  const map = terrainMap();
  assert.equal(map.cameraSolutions.length, 0);
  await settle(() => {
    terrainSize.width = 600;
    terrainSize.height = 400;
    for (const observer of resizeObservers)
      if (observer.target === document.querySelector(".terrain-canvas"))
        observer.callback([{ contentRect: terrainSize }]);
  });
  assert.equal(await readyTerrain(), map);
});

test("预览尺寸变化只同步相机，对调面板不重建预览并保留拍摄参数", async (t) => {
  await workspace(t);
  const old = await readyTerrain();
  const fields = ["经度", "纬度", "方位角", "俯仰角", "焦距", "离地高度"];
  const before = fields.map(value);
  const requests = groundRequests.length;
  const updates = old.cameraSolutions.length;
  t.after(() => {
    terrainSize.width = 600;
    terrainSize.height = 400;
  });
  await settle(() => {
    terrainSize.width = 450;
    terrainSize.height = 300;
    for (const observer of resizeObservers)
      if (observer.target === document.querySelector(".terrain-canvas"))
        observer.callback([{ contentRect: terrainSize }]);
  });
  assert.equal(terrainMap(), old);
  assert.ok(old.resizes > 0);
  assert.equal(old.cameraSolutions.length, updates + 1);
  assert.equal(groundRequests.length, requests);
  assert.deepEqual(fields.map(value), before);
  await settle(() => document.querySelector('[aria-label="对调地图与预览位置"]').click());
  assert.equal(await readyTerrain(), old);
  assert.ok(!old.removed);
  assert.equal(old.cameraSolutions.length, updates + 1);
  assert.equal(groundRequests.length, requests);
  assert.deepEqual(fields.map(value), before);
  assert.equal(old.cameraViews.at(-1).bearing, before[2]);
});

test("地形相机随高度、方向和横竖幅更新，镜头或时间编辑不重复请求机位高程", async (t) => {
  await workspace(t);
  const map = await readyTerrain(),
    requests = groundRequests.length;
  await settle(() => setControl(input("离地高度"), 5));
  assert.equal(map.cameraSolutions.at(-1).altitude, 1005);
  await settle(() => setControl(input("方位角"), 123.4));
  await settle(() => setControl(input("俯仰角"), 30));
  assert.equal(map.cameraViews.at(-1).bearing, 123.4);
  assert.equal(map.cameraViews.at(-1).pitch, 120);
  await settle(() =>
    setControl(document.querySelector('input[aria-label="焦距滑块"]'), 1000),
  );
  const landscapeFov = map.verticalFov;
  await settle(() =>
    setControl(
      document.querySelector('select[aria-label="拍摄画幅方向"]'),
      "portrait",
    ),
  );
  assert.ok(map.verticalFov > landscapeFov);
  assert.equal(terrainMap(), map);
  const cameraUpdates = map.cameraSolutions.length;
  await settle(() =>
    setControl(
      document.querySelector('input[aria-label="24 小时时间滑杆"]'),
      700,
    ),
  );
  assert.equal(map.cameraSolutions.length, cameraUpdates);
  assert.equal(groundRequests.length, requests);
});

test("时间驱动环境并合并连续更新，切换时区不重绘，对调面板保留最新夜景", async (t) => {
  await workspace(t);
  const map = await readyTerrain();
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  await settle(() => setControl(slider, 720));
  const day = map.environments.at(-1);
  const poses = map.cameraSolutions.length, requests = groundRequests.length;
  const fields = ["经度", "纬度", "方位角", "俯仰角", "焦距", "离地高度"].map(value);
  const writes = map.environments.length;
  await settle(() => {
    setControl(slider, 1020);
    setControl(slider, 0);
  });
  const night = map.environments.at(-1);
  assert.notDeepEqual(night, day);
  assert.equal(map.environments.length, writes + 1);
  assert.equal(map.paint.get("preview-shading/hillshade-exaggeration"), 0);
  assert.ok(document.querySelector(".preview-lighting").textContent.includes("夜间"));
  assert.equal(map.cameraSolutions.length, poses);
  assert.equal(groundRequests.length, requests);
  await chooseTimeZone("America/New_York");
  assert.equal(map.environments.length, writes + 1);
  assert.deepEqual(["经度", "纬度", "方位角", "俯仰角", "焦距", "离地高度"].map(value), fields);
  await settle(() => document.querySelector('[aria-label="对调地图与预览位置"]').click());
  assert.equal(await readyTerrain(), map);
  assert.ok(!map.removed);
  assert.equal(map.environments.length, writes + 1);
  assert.deepEqual(map.environments.at(-1), night);
});

test("月光随日期变化，隐藏月亮保留环境及夜间参考，不重建相机或读取 DEM", async (t) => {
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T00:00');
  const dark=structuredClone(map.environments.at(-1));
  const poses=map.cameraSolutions.length,requests=groundRequests.length;
  await setShootingDateTime('2026-11-25T00:00');
  const lit=structuredClone(map.environments.at(-1));
  assert.notDeepEqual(lit,dark);
  const writes=map.environments.length;
  assert.ok(document.querySelector('.preview-moonlight').textContent.includes('100%'));
  await settle(()=>document.querySelector('input[aria-label="显示月亮"]').click());
  assert.equal(map.environments.length,writes);
  assert.deepEqual(map.environments.at(-1),lit);
  assert.ok(document.querySelector('[data-body-status="moon"]').textContent.includes('已关闭'));
  assert.ok(document.querySelector('.preview-moonlight').textContent.includes('100%'));
  assert.equal(map.cameraSolutions.length,poses);assert.equal(groundRequests.length,requests);
});

test("日月开关、主动朝向与状态联动，关闭太阳不改变光照、机位或镜头", async (t) => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  document.head.append(style);
  t.after(() => style.remove());
  await workspace(t);
  const map = await readyTerrain();
  const toggleStyle = dom.window.getComputedStyle(document.querySelector('input[aria-label="显示太阳"]'));
  assert.ok(parseFloat(toggleStyle.width) <= 40);
  assert.ok(parseFloat(toggleStyle.minHeight) <= 20, "layer switches must not inherit text-field sizing");
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  await settle(() => setControl(slider, 720));
  const fields = ["经度", "纬度", "焦距", "离地高度"].map(value);
  const time = shootingDateTime();
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes("视场外"));
  await settle(() => document.querySelector('button[aria-label="朝向太阳"]').click());
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes("未被地形遮挡"));
  assert.ok(document.querySelector('[data-celestial-body="sun"]'));
  const poses = map.cameraSolutions.length, environments = map.environments.length, requests = groundRequests.length;
  await settle(() => document.querySelector('input[aria-label="显示太阳"]').click());
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes("已关闭"));
  assert.equal(document.querySelector('[data-celestial-body="sun"]'), null);
  assert.equal(document.querySelector('input[aria-label="显示月亮"]').checked, true);
  assert.equal(map.cameraSolutions.length, poses);
  assert.equal(map.environments.length, environments);
  assert.equal(groundRequests.length, requests);
  assert.deepEqual(["经度", "纬度", "焦距", "离地高度"].map(value), fields);
  assert.equal(shootingDateTime(), time);
  await settle(() => document.querySelector('[aria-label="对调地图与预览位置"]').click());
  await readyTerrain();
  assert.equal(document.querySelector('input[aria-label="显示太阳"]').checked, false);
  assert.equal(document.querySelector('input[aria-label="显示月亮"]').checked, true);
  await settle(() => setControl(slider, 1020));
  assert.ok(document.querySelector('[data-body-status="moon"]').textContent.includes("地平线下"));
  assert.equal(document.querySelector('button[aria-label="朝向月亮"]').disabled, true);
});

test("画外日月显示各自箭头，关闭或朝向入画后消失，地平线下不显示",async(t)=>{
  await workspace(t);const map=await readyTerrain();
  const slider=document.querySelector('input[aria-label="24 小时时间滑杆"]');
  await settle(()=>setControl(slider,720));
  assert.equal(document.querySelectorAll('[data-body-direction]').length,2);
  assert.ok(document.querySelector('[data-body-direction="sun"]').getAttribute('aria-label').includes('左上方'));
  const fields=['经度','纬度','焦距','离地高度'].map(value),requests=groundRequests.length;
  const environment=structuredClone(map.environments.at(-1));
  await settle(()=>document.querySelector('input[aria-label="显示月亮"]').click());
  assert.equal(document.querySelector('[data-body-direction="moon"]'),null);
  await settle(()=>document.querySelector('button[aria-label="朝向太阳"]').click());
  assert.equal(document.querySelector('[data-body-direction="sun"]'),null);
  assert.ok(document.querySelector('[data-celestial-body="sun"]'));
  assert.deepEqual(['经度','纬度','焦距','离地高度'].map(value),fields);
  assert.equal(groundRequests.length,requests);assert.deepEqual(map.environments.at(-1),environment);
  await settle(()=>setControl(slider,1020));
  assert.equal(document.querySelectorAll('[data-body-direction]').length,0);
});

test("靠近日月的箭头并排，实际相机反馈决定画外方向而不改计划",async(t)=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T12:00');
  const groups=document.querySelectorAll('.celestial-direction-group');
  assert.equal(groups.length,1);assert.equal(groups[0].querySelectorAll('[data-body-direction]').length,2);
  const layer=map.customLayers.find(layer=>layer instanceof TestCelestialLayer);
  const before=['方位角','俯仰角'].map(value);
  const previous=document.querySelector('[data-body-direction="sun"] svg').style.transform;
  await settle(()=>layer.onCamera({planKey:layer.frame.planKey,longitude:value('经度'),latitude:value('纬度'),altitude:982.1,azimuth:0,pitch:0}));
  assert.deepEqual(['方位角','俯仰角'].map(value),before);
  assert.ok(document.querySelector('[data-body-direction="sun"]').getAttribute('aria-label').includes('后方'));
  assert.notEqual(document.querySelector('[data-body-direction="sun"] svg').style.transform,previous);
});

test("折射修改只更新日月轮廓，地形更新使遮挡失效，对调面板保留深度图层", async (t) => {
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('button[aria-label="朝向太阳"]').click());
  const layer=map.customLayers.find(layer=>layer instanceof TestCelestialLayer), outline=structuredClone(layer.frame.bodies.find(body=>body.id==='sun').outline);
  const poses=map.cameraSolutions.length, requests=groundRequests.length;
  const before=["经度","纬度","方位角","俯仰角","焦距"].map(value);
  await settle(()=>setControl(document.querySelector('select[aria-label="大气折射模型"]'),'none'));
  assert.equal(map.cameraSolutions.length,poses);assert.equal(groundRequests.length,requests);
  assert.deepEqual(["经度","纬度","方位角","俯仰角","焦距"].map(value),before);
  assert.notDeepEqual(layer.frame.bodies.find(body=>body.id==='sun').outline,outline);
  await settle(()=>{map.tilesLoaded=false;map.emit('dataloading');});
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('遮挡待测'));
  await settle(()=>{map.tilesLoaded=true;map.emit('sourcedata');});
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('未被地形遮挡'));
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());
  const restored = await readyTerrain();assert.equal(restored,map);assert.ok(!layer.removed);
  assert.equal(document.querySelector('select[aria-label="大气折射模型"]').value,'none');
  await settle(()=>restored.emit('error',{sourceId:'terrain-dem'}));
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('遮挡未知'));
  await settle(()=>setControl(document.querySelector('select[aria-label="大气折射模型"]'),'standard'));
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('遮挡未知'));
});

test("地形高程失败允许重试，并释放旧预览实例、保留拍摄计划", async (t) => {
  await workspace(t, async () => {
    throw new Error("test elevation offline");
  });
  const old = await waitUntil(() =>
    document.querySelector(".terrain-feedback-error") ? terrainMap() : null,
  );
  const longitude = value("经度"),
    focal = value("焦距");
  assert.equal(
    document.querySelector(".terrain-canvas").dataset.ready,
    "false",
  );
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('button[aria-label="朝向太阳"]').click());
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('遮挡未知'));
  groundResponse = async () => ({ height: 2500, zoom: 12 });
  await settle(() => button("重试预览").click());
  const restored = await readyTerrain();
  assert.notEqual(restored, old);
  assert.equal(old.removed, true);
  assert.equal(restored.cameraSolutions.at(-1).altitude, 2501.6);
  assert.equal(value("经度"), longitude);
  assert.equal(value("焦距"), focal);
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('未被地形遮挡'));
});

test("引擎避让反馈实际高度和俯仰，日月随实际姿态投影，计划保持不变", async (t) => {
  await workspace(t); const map = await readyTerrain();
  await settle(() => setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(() => document.querySelector('button[aria-label="朝向太阳"]').click());
  const layer = map.customLayers.find(layer=>layer instanceof TestCelestialLayer), outline = structuredClone(layer.frame.bodies.find(b => b.id === 'sun').outline);
  const before = ["经度", "纬度", "俯仰角", "方位角", "离地高度", "焦距"].map(value);
  const labelTop = document.querySelector('[data-celestial-body="sun"]').style.top;
  const expected = map.cameraSolutions.at(-1), pitch = value("俯仰角") - 5;
  await settle(() => {
    map.pitch = 90 + pitch;
    layer.onCamera({ planKey: layer.frame.planKey, longitude: value("经度"), latitude: value("纬度"),
      altitude: expected.altitude + 1.7, azimuth: value("方位角"), pitch });
    map.emit('render');
  });
  assert.deepEqual(["经度", "纬度", "俯仰角", "方位角", "离地高度", "焦距"].map(value), before);
  assert.ok(document.querySelector('.camera-adjustment').textContent.includes('引擎避让'));
  assert.ok(document.querySelector('.camera-adjustment').textContent.includes(pitch.toFixed(2)));
  assert.ok(document.querySelector('.preview-readout').textContent.includes(pitch.toFixed(1)));
  assert.notDeepEqual(layer.frame.bodies.find(b => b.id === 'sun').outline, outline);
  assert.notEqual(document.querySelector('[data-celestial-body="sun"]').style.top, labelTop);
  await settle(() => {
    map.pitch = 90 + value("俯仰角");
    layer.onCamera({ planKey: layer.frame.planKey, longitude: value("经度"), latitude: value("纬度"),
      altitude: expected.altitude, azimuth: value("方位角"), pitch: value("俯仰角") });
    map.emit('render');
  });
  assert.equal(document.querySelector('.camera-adjustment'), null);
});

test("镜头与画幅变化复用地形屏幕细节函数，不重建预览或重复加载机位高程", async(t)=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  const before=['经度','纬度','方位角','俯仰角','离地高度'].map(value);
  const calculate=map.sources.get('preview-terrain').calculateTileZoom,writes=map.detailWrites;
  await settle(()=>button('200 mm').click());
  await settle(()=>setControl(document.querySelector('select[aria-label="拍摄画幅方向"]'),'portrait'));
  assert.equal(map.detailWrites,writes);
  await settle(()=>button('1000 mm').click());
  await settle(()=>button('8 mm').click());
  assert.equal(map.sources.get('preview-terrain').calculateTileZoom,calculate);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  assert.deepEqual(['经度','纬度','方位角','俯仰角','离地高度'].map(value),before);
});

test("切换机位取消过期高程请求；等待新高程时保留旧画面并标记未就绪", async (t) => {
  const pending = [];
  await workspace(
    t,
    (point, signal) =>
      new Promise((resolve) => pending.push({ point, signal, resolve })),
  );
  await waitUntil(() => pending.length === 1);
  await settle(() => setControl(input("经度"), 139));
  await waitUntil(() => pending.length === 2);
  assert.equal(pending[0].signal.aborted, true);
  await settle(() => pending[0].resolve({ height: 9000, zoom: 12 }));
  assert.equal(
    document.querySelector(".terrain-canvas").dataset.ready,
    "false",
  );
  await settle(() => pending[1].resolve({ height: 1100, zoom: 12 }));
  const map = await readyTerrain();
  assert.equal(map.cameraSolutions.at(-1).eye.lng, 139);
  assert.equal(map.cameraSolutions.at(-1).altitude, 1101.6);
  await settle(() => setControl(input("经度"), 140));
  assert.equal(
    document.querySelector(".terrain-canvas").dataset.ready,
    "false",
  );
  await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].resolve({ height: 1200, zoom: 12 }));
  await readyTerrain();
  assert.equal(map.cameraSolutions.at(-1).eye.lng, 140);
  assert.equal(map.cameraSolutions.at(-1).altitude, 1201.6);
});

test('星空与银河独立开关、朝向及实际相机反馈联动，不重载 DEM 或修改其他参数',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),1320));
  assert.equal(document.querySelector('.sky-readout'),null);
  const fields=['经度','纬度','焦距','离地高度'].map(value),time=shootingDateTime();
  const poses=map.cameraSolutions.length,environments=map.environments.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  assert.equal(map.cameraSolutions.length,poses);assert.equal(map.environments.length,environments);
  assert.doesNotMatch(document.querySelector('#info-stars-body').textContent,/亮星目录|定位符号|按当前 DEM 遮挡/);
  assert.doesNotMatch(document.querySelector('#info-milkyWay-body').textContent,/银河细节|全景衍生/);
  assert.ok(document.querySelector('[data-sky-status="银心"]'));
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  assert.ok(document.querySelector('[data-sky-label="北极星"]'));
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:{azimuth:180,pitch:0},states:{[id]:'clear'}}));
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(document.querySelector('[data-sky-status="北极星"]'),null);
  assert.ok(document.querySelector('[data-sky-status="银心"]'));
  assert.equal(document.querySelector('[aria-label="显示银河"]').checked,true);
  assert.equal(groundRequests.length,requests);assert.equal(terrainMap(),map);
  assert.deepEqual(['经度','纬度','焦距','离地高度'].map(value),fields);assert.equal(shootingDateTime(),time);
});

test('银河对比度滑杆即时联动，重置/关闭重开/布局保留正确，未重载地形或作废几何状态',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  assert.equal(document.querySelector('#galaxy-contrast').disabled,true);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  const slider=()=>document.querySelector('#galaxy-contrast'),layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer);
  assert.equal(slider().value,'100');assert.equal(document.querySelector('[aria-label="重置银河对比度"]').disabled,true);
  const fields=['经度','纬度','焦距','离地高度','方位角','俯仰角'].map(value),time=shootingDateTime();
  const originalFrame=layer.frame,poses=map.cameraSolutions.length,environments=map.environments.length;
  for (const percent of [25,200]) {
    await settle(()=>setControl(slider(),percent));assert.equal(layer.contrast,percent);
    assert.equal(slider().getAttribute('aria-valuetext'),`${percent}%`);
    assert.equal(document.querySelector('.galaxy-contrast output').textContent,`${percent}%`);
    assert.equal(layer.frame,originalFrame);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
    assert.equal(map.cameraSolutions.length,poses);assert.equal(map.environments.length,environments);
    assert.deepEqual(['经度','纬度','焦距','离地高度','方位角','俯仰角'].map(value),fields);assert.equal(shootingDateTime(),time);
  }
  await settle(()=>document.querySelector('[aria-label="重置银河对比度"]').click());assert.equal(slider().value,'100');assert.equal(layer.contrast,100);
  await settle(()=>setControl(slider(),150));await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(slider().disabled,true);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(slider().value,'150');
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());assert.equal(slider().value,'150');
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());assert.equal(slider().value,'150');
});

test('深空搜索开启与朝向，未改机/改机响应切换保留几何、时刻与 DEM',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>setControl(document.querySelector('#target-search'),'M42'));
  assert.equal(document.querySelector('[aria-label="显示深空天体"]').checked,false);
  assert.match(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/图层已关闭/);
  const time=shootingDateTime(),fields=['经度','纬度','焦距','离地高度'].map(value);
  await settle(()=>document.querySelector('[aria-label="开启并朝向猎户座大星云"]').click());
  assert.equal(document.querySelector('[aria-label="显示深空天体"]').checked,true);
  assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'));
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),originalFrame=layer.frame,requests=groundRequests.length,poses=map.cameraSolutions.length;
  // The response setting lives in the deep-sky group, shown once the search is cleared.
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  await settle(()=>setControl(document.querySelector('[aria-label="深空相机响应"]'),'ha-modified'));
  assert.equal(layer.cameraResponse,'ha-modified');assert.equal(layer.frame,originalFrame);assert.equal(groundRequests.length,requests);assert.equal(terrainMap(),map);assert.equal(map.cameraSolutions.length,poses);
  assert.deepEqual(['经度','纬度','焦距','离地高度'].map(value),fields);assert.equal(shootingDateTime(),time);
  assert.equal(document.querySelectorAll('[data-dso-status]').length,15);assert.match(document.querySelector('.preview-meta').textContent,/天文改机/);
  assert.doesNotMatch(document.querySelector('#info-deepSky-body').textContent,/源图色彩|未作具体相机定标|遮挡按画面内/);
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());assert.equal(document.querySelector('[data-dso-label]'),null);
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());assert.equal(document.querySelector('[aria-label="深空相机响应"]').value,'ha-modified');
});

test('深空部分遮挡不等于中心名称可见，轮廓加载失败单独反馈',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向猎户座大星云"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id='dso-ngc1976',key=layer.frame.planKey;
  const report=(label,phase='ready')=>layer.report({planKey:key,ready:true,view:null,states:{[id]:'partial',[id+':label']:label},deepSky:{phase,message:phase==='error'?'深空结构加载失败，请关闭再开启深空天体重试。':undefined}});
  await settle(()=>report('blocked'));assert.match(document.querySelector('[data-dso-status="猎户座大星云"]').textContent,/部分山体遮挡/);assert.equal(document.querySelector('[data-dso-label="猎户座大星云"]'),null);
  await settle(()=>report('clear'));assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'));
  await settle(()=>setControl(document.querySelector('#target-search'),'M42'));await settle(()=>report('clear','error'));
  assert.match(document.querySelector('.deep-sky-feedback').textContent,/加载失败/);assert.equal(document.querySelector('.terrain-feedback-error'),null);assert.equal(document.querySelector('[data-dso-label]'),null);
  assert.match(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/深空轮廓加载失败/);
  await settle(()=>layer.report({planKey:key,ready:true,view:null,states:{[id]:'clear',[id+':label']:'clear'},
    deepSky:{phase:'error',message:'马头资料加载失败'},deepSkyTargets:{[id]:{phase:'ready'},'dso-ic0434':{phase:'error'}}}));
  assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'),'another failed resource must not hide ready labels');
  assert.doesNotMatch(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/加载失败/);
});

test('银河纹理状态与遮挡分开，搜索时也显示失败，地形与星点保持可用',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer);
  await settle(()=>setControl(document.querySelector('#target-search'),'银心'));
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{},milkyWay:{phase:'loading'}}));
  assert.equal(document.querySelector('.sky-texture-feedback'), null);
  await act(async () => { await delay(850); });
  assert.match(document.querySelector('.sky-texture-feedback').textContent,/加载银河/);
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{},milkyWay:{phase:'error',message:'银河纹理加载失败，请关闭再开启银河重试。'}}));
  assert.match(document.querySelector('.sky-texture-feedback').textContent,/加载失败/);
  assert.equal(document.querySelector('.terrain-feedback-error'),null);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);assert.ok(document.querySelector('[data-search-target="galactic-center"]'));
  assert.ok(document.querySelector('.about-dialog a[href="https://www.eso.org/public/images/eso0932a/"]'));
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(document.querySelector('.sky-texture-feedback'),null);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{},milkyWay:{phase:'ready'}}));
  assert.equal(document.querySelector('.sky-texture-feedback'),null);assert.equal(groundRequests.length,requests);
});

test('星空名称等待实际遮挡结果，山体遮挡或失败不沿用旧名称，重试保留开关',async t=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),1320));
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{[id]:'blocked'}}));
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent,/山体遮挡/);
  await settle(()=>{map.tilesLoaded=false;map.emit('dataloading');});
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent,/待测/);
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:false,view:null,states:{},message:'测试星空图形失败'}));
  assert.ok(document.querySelector('.terrain-feedback-error'));assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent,/遮挡未知/);
  await settle(()=>button('重试预览').click());await readyTerrain();
  assert.equal(layer.removed,true);assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  assert.ok(document.querySelector('[data-sky-label="北极星"]'));
});

test('白昼星点隐藏独立于 DEM 遮挡，夜间恢复，银心参考仍可定位',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  // Night layers put the slider on noon-to-noon: minute 0 is 12:00, 600 is 22:00.
  assert.equal(document.querySelector('.timeline').dataset.mode,'night');
  await settle(()=>setControl(document.querySelector('.time-slider'),0));
  assert.equal(document.querySelector('input[type="time"]').value,'12:00:00');
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  const status=()=>document.querySelector('[data-sky-status="北极星"]');
  assert.match(status().textContent,/天空较亮/);assert.equal(status().dataset.skyOpacity,'0.000');
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('.preview-lighting').textContent,/白昼/);
  assert.equal(document.querySelector('[data-sky-status="银心"]').dataset.skyOpacity,'1.000');
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{[id]:'blocked'}}));
  assert.match(status().textContent,/山体遮挡/);
  await settle(()=>setControl(document.querySelector('.time-slider'),600));
  assert.equal(document.querySelector('input[type="time"]').value,'22:00:00');
  assert.ok(Number(status().dataset.skyOpacity)>0.06);assert.ok(document.querySelector('[data-sky-label="北极星"]'));
  const darkOpacity=Number(status().dataset.skyOpacity);
  await setShootingDateTime('2026-11-25T00:00');
  assert.ok(Number(status().dataset.skyOpacity)<darkOpacity,'a high full Moon must dim the star');
  const before=status().dataset.skyOpacity;
  await settle(()=>document.querySelector('[aria-label="显示月亮"]').click());
  assert.equal(status().dataset.skyOpacity,before);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('拍摄信息只在右侧栏出现，版权独立于预览；收起和恢复不重建地图或丢失状态',async t=>{
  await workspace(t);const map=await readyTerrain(),sidebar=document.querySelector('.info-sidebar');
  assert.ok(sidebar.querySelector('.preview-readout'));assert.ok(sidebar.querySelector('.celestial-readout'));
  assert.equal(document.querySelector('.preview-content .preview-readout'),null);
  assert.equal(document.querySelector('.preview-content .preview-attribution'),null);
  assert.equal(sidebar.querySelector('.about-dialog'),null);
  const requests=groundRequests.length;
  await settle(()=>document.querySelector('[aria-label="收起图层与信息"]').click());
  assert.ok(sidebar.classList.contains('is-collapsed'));
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('[aria-label="展开图层与信息"]').click());
  assert.equal(sidebar.classList.contains('is-collapsed'),false);
  assert.match(sidebar.querySelector('.preview-lighting').textContent,/白昼/);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('About 汇集所有署名与下载，开关图层和弹窗不重建地图或改变计划', async (t) => {
  const { map: browserMap } = await workspace(t);
  const map = await readyTerrain();
  const dialog = document.querySelector('#about-dialog');
  const trigger = document.querySelector('.topbar [aria-controls="about-dialog"]');
  assert.equal(dialog.open, false);
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(browserMap.options.attributionControl.compact, true);
  assert.equal(document.querySelector('.preview-attribution'), null);
  const catalog = JSON.parse(readFileSync(new URL('../src/data/deep-sky.json', import.meta.url), 'utf8'));
  assert.equal(dialog.querySelectorAll('[data-credit-source]').length, catalog.imageSources.length);
  for (const source of catalog.imageSources) {
    const credit = dialog.querySelector(`[data-credit-source="${source.catalogId}"]`);
    assert.ok(credit.textContent.includes(source.credit));
    assert.equal(credit.querySelector('a').getAttribute('href'), source.page);
    assert.equal(credit.querySelectorAll('a[download]').length, 1);
  }
  assert.match(dialog.querySelector('[data-credit-source="IC0434"]').textContent, /火树/);
  const landmarkCatalog = JSON.parse(readFileSync(new URL('../src/data/landmarks.generated.json', import.meta.url), 'utf8'));
  const downloads = [...dialog.querySelectorAll('a[download]')];
  assert.equal(downloads.length, catalog.imageSources.length + 7 + 2 * landmarkCatalog.length);
  // Comets: COBS share-alike, non-commercial terms beside the derived data download, JPL citation, tail formula.
  const cometSection = dialog.querySelector('[aria-labelledby="about-comets-title"]');
  assert.match(cometSection.textContent, /COBS Comet Observation Database · CC BY-NC-SA 4\.0.*仅限非商业使用/s);
  assert.match(cometSection.querySelector('a[download]').textContent, /下载彗星目录/);
  assert.equal(cometSection.querySelector('a[download]').getAttribute('href'), '/comets/catalog.json');
  assert.match(cometSection.textContent, /NASA\/JPL Solar System Dynamics\. Data retrieved on/);
  assert.match(cometSection.textContent, /每 3 小时自动检查/);
  assert.match(cometSection.textContent, /Kammerer/);
  const landmarkSection=dialog.querySelector('[aria-labelledby="about-landmarks-title"]');
  assert.match(landmarkSection.textContent,/Noah.*CC BY 4.0/);
  assert.equal(landmarkSection.querySelectorAll('a[download]').length,2*landmarkCatalog.length);
  for(const target of landmarkCatalog){const credit=landmarkSection.querySelector(`[data-landmark-credit="${target.id}"]`);assert.ok(credit);assert.ok(credit.textContent.includes(target.credit.author));assert.ok(credit.querySelector('a[href="'+target.credit.licenseUrl+'"]'));
    // Non-commercial terms must be visible next to the licence and on the download link, and only where they apply.
    const restricted=target.credit.use==='仅限非商业使用';assert.equal(target.credit.license.includes('NC'),restricted);
    assert.equal(credit.textContent.includes('仅限非商业使用'),restricted);if(restricted)assert.match(credit.querySelector('a[download]').textContent,/CC BY-NC 4\.0，仅限非商业使用/);}
  assert.ok(landmarkCatalog.some(target=>target.credit.use),'catalogue carries at least one non-commercial landmark');
  assert.match(landmarkSection.textContent,/NanoRay.*CC BY 4.0/);
  assert.equal(new Set(downloads.map((link) => link.getAttribute('href'))).size, downloads.length);
  const fields = ['经度', '纬度', '焦距', '离地高度', '方位角', '俯仰角'];
  const before = fields.map(value), time = shootingDateTime();
  const requests = groundRequests.length, maps = TestMap.instances.length;
  for (const label of ['显示星空', '显示银河', '显示星座名称与连线', '显示深空天体']) {
    await settle(() => document.querySelector(`[aria-label="${label}"]`).click());
  }
  await settle(() => trigger.click());
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelectorAll('[data-credit-source]').length, catalog.imageSources.length);
  await settle(() => dialog.querySelector('button').click());
  assert.equal(dialog.open, false);
  await settle(() => trigger.click());
  assert.equal(dialog.open, true);
  assert.equal(terrainMap(), map);
  assert.equal(TestMap.instances.length, maps);
  assert.equal(groundRequests.length, requests);
  assert.deepEqual(fields.map(value), before);
  assert.equal(shootingDateTime(), time);
});

test('空间站按需读取同源轨道、搜索开启与朝向、秒级时间联动，地形和机位保留', async (t) => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/stations-reference.json', import.meta.url), 'utf8'));
  const feed = { version: 1, source: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json', fetchedAt: null, attemptedAt: null, status: 'seed', error: null, blocked: false, objects: fixture.elements };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, signal: options.signal });
    return new Response(JSON.stringify(feed));
  });
  await workspace(t);
  const map = await readyTerrain(), requests = groundRequests.length;
  const fields = ['经度', '纬度', '焦距', '离地高度'];
  const before = fields.map(value);
  assert.equal(calls.length, 0);
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, false);
  await setShootingDateTime('2026-11-06T19:35');
  await settle(() => setControl(document.querySelector('#target-search'), 'ISS'));
  await waitUntil(() => document.querySelector('[aria-label="开启并朝向国际空间站 ISS"]'));
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/orbits/stations.json');
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, false);
  await settle(() => document.querySelector('[aria-label="开启并朝向国际空间站 ISS"]').click());
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, true);
  assert.ok(document.querySelector('[data-station-label="25544"]'));
  assert.match(document.querySelector('.station-readout').textContent, /地影中/);
  const layer = map.customLayers.find((entry) => entry instanceof TestStarfieldLayer);
  const oldKey = layer.frame.stations.key;
  await settle(() => button('+10 秒').click());
  assert.notEqual(layer.frame.stations.key, oldKey);
  assert.match(document.querySelector('.station-instant').textContent, /10:35:10 UTC/);
  await settle(() => layer.report({ planKey: layer.frame.planKey, orbitKey: 'old', ready: true, view: null, states: { 'station-25544': 'clear' } }));
  assert.equal(document.querySelector('[data-station-label="25544"]'), null);
  await setShootingDateTime('2027-01-01T00:00');
  assert.equal(layer.frame.stations.points.length, 0);
  assert.match(document.querySelector('.station-readout').textContent, /停止绘制/);
  await setShootingDateTime('2026-11-06T19:35');
  await settle(() => layer.report({ planKey: layer.frame.planKey, ready: false, view: null, states: {}, message: '地形不可用' }));
  assert.match(document.querySelector('.station-readout').textContent, /遮挡未知/);
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  await settle(() => setControl(document.querySelector('#target-search'), ''));
  assert.equal(document.querySelector('.station-readout'), null);
  assert.equal(calls.length, 1);
  assert.equal(terrainMap(), map); assert.equal(groundRequests.length, requests);
  assert.deepEqual(fields.map(value), before);
});

test('空间站加载取消忽略迟到响应，后台恢复按到期检查，网页失败与上游暂停分别显示', async (t) => {
  t.after(() => { delete document.visibilityState; });
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/stations-reference.json', import.meta.url), 'utf8'));
  const feed = { version: 1, source: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json', fetchedAt: null, attemptedAt: '2026-11-06T10:00:00Z', status: 'error', error: '上游 HTTP 403，自动更新已暂停', blocked: true, objects: fixture.elements };
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })));
  let now = Date.parse('2026-11-06T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await workspace(t); await readyTerrain();
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  await waitUntil(() => pending.length === 1);
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  assert.equal(pending[0].options.signal.aborted, true);
  await settle(() => pending[0].resolve(new Response(JSON.stringify(feed))));
  assert.equal(document.querySelector('.station-readout'), null);
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  await waitUntil(() => pending.length === 2);
  await settle(() => pending[1].resolve(new Response(JSON.stringify(feed))));
  assert.match(document.querySelector('.station-feed-status').textContent, /上游 HTTP 403/);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  now += 301000;
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(pending.length, 2);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].reject(new Error('已发布快照不可用')));
  assert.match(document.querySelector('.station-feed-status').textContent, /已发布快照不可用/);
  assert.match(document.querySelector('.station-feed-status').textContent, /上游 HTTP 403/);
  assert.equal(document.querySelectorAll('[data-station-status]').length, 2);
  delete document.visibilityState;
});

test('星座默认关闭并从属于星空；主要亮星名称、星座定位与开关联动',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').checked,false);
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.ok(document.querySelectorAll('[data-sky-status]').length>=90);
  await settle(()=>document.querySelector('[aria-label="朝向参宿五"]').click());
  assert.ok(document.querySelector('[data-sky-label="参宿五"]'));
  await settle(()=>document.querySelector('[aria-label="显示星座名称与连线"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向猎户座"]').click());
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(document.querySelector('[data-constellation-label="猎户座"]'), null);assert.equal(document.querySelector('[data-sky-status="参宿五"]'),null);
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').disabled, true);
  await settle(()=>document.querySelector('[aria-label="显示星座名称与连线"]').click());
  assert.equal(document.querySelector('[data-constellation-label]'),null);assert.equal(document.querySelector('[data-constellation-status]'),null);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('侧栏搜索发现未开启目标，输入不改变构图，明确选择才开启图层和朝向',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  const fields=['纬度','经度','方位角','俯仰角','焦距'].map(value),requests=groundRequests.length;
  await settle(()=>setControl(document.querySelector('#target-search'),'ＯＲＩ'));
  assert.match(document.querySelector('.target-search-results').textContent,/猎户座/);
  assert.match(document.querySelector('.target-search-results').textContent,/图层已关闭/);
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,false);
  assert.deepEqual(['纬度','经度','方位角','俯仰角','焦距'].map(value),fields);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  await settle(()=>document.querySelector('[aria-label="开启并朝向猎户座"]').click());
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  await settle(()=>setControl(document.querySelector('#target-search'),'不存在的目标_zzzz'));
  assert.match(document.querySelector('.target-search-results').textContent,/没有找到匹配目标/);
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  assert.equal(document.querySelector('.target-search-results'),null);assert.ok(document.querySelector('.info-body .preview-readout'));
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('缓存视野的加载事件在没有后续 sourcedata 时恢复深空图层',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());
  await settle(()=>setControl(document.querySelector('#target-search'),'M31'));
  await settle(()=>document.querySelector('[aria-label="朝向仙女座星系"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),oldKey=layer.frame.key;
  await settle(()=>map.emit('dataloading'));
  assert.notEqual(layer.frame.key,oldKey);assert.equal(layer.frame.ready,true);
  assert.match(document.querySelector('.target-search-results').textContent,/未被地形遮挡/);
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  await settle(()=>setControl(document.querySelector('[aria-label="深空相机响应"]'),'ha-modified'));
  assert.equal(layer.frame.ready,true);assert.ok(document.querySelector('[data-dso-label="仙女座星系"]'));
});

test('侧栏收起、面板交换保留搜索，地平线下的未开启目标只启用图层',async t=>{
  await workspace(t);await readyTerrain();
  await setShootingDateTime('2026-11-25T00:00');
  await settle(()=>setControl(document.querySelector('#target-search'),'Vega'));
  const pose=['方位角','俯仰角'].map(value);
  await settle(()=>document.querySelector('[aria-label="开启图层织女星"]').click());
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  assert.deepEqual(['方位角','俯仰角'].map(value),pose);
  assert.match(document.querySelector('.target-search-results').textContent,/地平线下/);
  await settle(()=>document.querySelector('[aria-label="收起图层与信息"]').click());
  await settle(()=>document.querySelector('[aria-label="展开图层与信息"]').click());
  assert.equal(document.querySelector('#target-search').value,'Vega');
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());await readyTerrain();
  assert.equal(document.querySelector('#target-search').value,'Vega');assert.ok(document.querySelector('[data-search-target]'));
});


test('精简工作区：没有左栏，图层开关位于分组标题，光照与环境默认展开，分组随开关展开与折叠', async t => {
  await workspace(t); const map = await readyTerrain(), requests = groundRequests.length;
  // Map and preview side by side, the preview wider; no separate parameter panel.
  const layout = document.querySelector('.workgrid');
  assert.equal(layout.dataset.order, 'map-first');
  assert.equal(layout.style.getPropertyValue('--first-track'), '36fr');
  assert.equal(layout.style.getPropertyValue('--second-track'), '64fr');
  assert.equal(document.querySelector('[aria-label="调整地图与预览宽度"]').getAttribute('aria-valuenow'), '36');
  assert.equal(document.querySelector('[aria-label="调整面板高度"]'), null);
  for (const selector of ['.workspace-heading', '.workspace-footer', '.base-layer', '.sidebar-bottom', '.layer-hint', '.map-footer-note', '.viewfinder-label', '.viewfinder-focal', '.terrain-height', '.parameter-note', '.info-header', '.layer-settings', '[aria-label$="设置与信息"]'])
    assert.equal(document.querySelector(selector), null, selector);
  const groups = [...document.querySelectorAll('.info-group h2 button')];
  assert.deepEqual(groups.map(group => group.id), ['info-global', 'info-buildings', 'info-sun', 'info-moon', 'info-stars', 'info-milkyWay', 'info-deepSky', 'info-stations', 'info-meteors', 'info-comets', 'info-aurora', 'info-tides']);
  // No left rail: each layer switch sits in its group's heading row.
  assert.equal(document.querySelector('aside.sidebar'), null);
  for (const [id, name] of [['buildings', '建筑'], ['sun', '太阳'], ['moon', '月亮'], ['stars', '星空'], ['milkyWay', '银河'], ['deepSky', '深空天体'], ['stations', '空间站'], ['meteors', '流星雨'], ['comets', '彗星'], ['aurora', '极光'], ['tides', '潮汐']])
    assert.ok(document.querySelector(`[aria-label="显示${name}"]`).closest(`.info-group[data-info-group="${id}"] .info-group-header`), id);
  assert.equal(document.querySelector('.info-group[data-info-group="global"] .info-group-switch'), null);
  assert.equal(document.querySelector('#info-global').textContent.includes('光照与环境'), true);
  // The first group is open; layer groups start in step with their switches.
  const expanded = () => Object.fromEntries([...document.querySelectorAll('.info-group h2 button')].map(group => [group.id.slice(5), group.getAttribute('aria-expanded') === 'true']));
  assert.deepEqual(expanded(), { global: true, buildings: false, sun: true, moon: true, stars: false, milkyWay: false, deepSky: false, stations: false, meteors: false, comets: false, aurora: false, tides: false });
  assert.equal(document.querySelector('#info-sun-body').hidden, false);
  assert.equal(document.querySelector('#info-sun-body [data-body-status="moon"]'), null);
  const global = document.querySelector('#info-global-body').textContent;
  assert.match(global, /方位.*水平视场/s); assert.match(global, /太阳高度/);
  for (const debug of [/曲面构图/, /高程基准/, /World Atlas/, /格网/, /几何高度/, /月光参考/, /明暗近似/])
    assert.doesNotMatch(global, debug);
  const moon = document.querySelector('[aria-label="显示月亮"]'), search = () => document.querySelector('#target-search');
  const collapsed = () => document.querySelector('.info-sidebar').classList.contains('is-collapsed');
  // Turning a layer off collapses its group without moving focus.
  moon.focus(); await settle(() => moon.click());
  assert.equal(moon.checked, false); assert.equal(expanded().moon, false); assert.equal(document.activeElement, moon);
  // Turning it on clears the search, reopens the rail and expands the group.
  await settle(() => setControl(search(), 'Vega'));
  await settle(() => document.querySelector('[aria-label="收起图层与信息"]').click());
  await settle(() => moon.click());
  assert.equal(search().value, ''); assert.equal(collapsed(), false);
  assert.equal(expanded().moon, true); assert.equal(document.activeElement, moon);
  // Turning it off leaves the search and a collapsed rail alone.
  await settle(() => setControl(search(), 'Vega'));
  await settle(() => document.querySelector('[aria-label="收起图层与信息"]').click());
  await settle(() => moon.click());
  assert.equal(search().value, 'Vega'); assert.equal(collapsed(), true);
  await settle(() => document.querySelector('[aria-label="展开图层与信息"]').click());
  await settle(() => setControl(search(), ''));
  assert.equal(expanded().moon, false);
  await settle(() => moon.click()); assert.equal(expanded().moon, true);
  // Group headers still collapse or expand by hand without changing the layer.
  await settle(() => document.querySelector('#info-moon').click());
  assert.equal(expanded().moon, false); assert.equal(moon.checked, true);
  await settle(() => document.querySelector('#info-global').click());
  assert.equal(expanded().global, false);
  assert.equal(terrainMap(), map); assert.equal(groundRequests.length, requests);
});

test('建筑入口联动右栏、转向调焦复用几何，失败独立重试且不重建 DEM', async t => {
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  const toggle=document.querySelector('[aria-label="显示建筑"]');assert.equal(toggle.checked,false);
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'false');
  await settle(()=>toggle.click());
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'true');
  const layer=map.customLayers.find(l=>l.id==='preview-buildings');
  assert.equal(document.querySelector('.building-readout').dataset.buildingPhase,'ready');
  const loads=layer.loads;
  await settle(()=>setControl(input('焦距'),85));
  assert.equal(layer.loads,loads);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  await settle(()=>layer.report({...layer.status,phase:'error',message:'测试建筑请求失败'}));
  assert.match(document.querySelector('.building-readout').textContent,/建筑未应用.*测试建筑请求失败/s);
  assert.equal(document.querySelector('.terrain-feedback-error'),null);
  await settle(()=>[...document.querySelectorAll('.building-readout button')].find(b=>b.textContent==='重新读取建筑').click());
  assert.equal(layer.loads,loads+1);assert.equal(document.querySelector('.building-readout').dataset.buildingPhase,'ready');
  await settle(()=>toggle.click());assert.equal(document.querySelector('.building-readout').dataset.buildingPhase,'off');
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'false');
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('分组标题的图层开关开启时就地展开、不滚动信息栏也不移动焦点，关闭即折叠', async t => {
  await workspace(t); await readyTerrain();
  const body = document.querySelector('.info-body'), scrolls = [];
  body.scrollTo = (options) => scrolls.push(options);
  body.scrollTop = 120;
  for (const [id, name] of [['stars', '星空'], ['milkyWay', '银河'], ['comets', '彗星']]) {
    const toggle = document.querySelector(`[aria-label="显示${name}"]`);
    toggle.focus();
    await settle(() => toggle.click());
    assert.equal(document.querySelector(`#info-${id}`).getAttribute('aria-expanded'), 'true', id);
    assert.equal(document.activeElement, toggle);
    await act(async () => { await delay(30); });
    await settle(() => toggle.click());
    assert.equal(document.querySelector(`#info-${id}`).getAttribute('aria-expanded'), 'false', id);
  }
  assert.deepEqual(scrolls, []);
  assert.equal(body.scrollTop, 120);
});

test('建筑分组显示加载进度、范围与精模朝向，不显示缓存和调试计数', async t => {
  await workspace(t);
  const catalog=JSON.parse(readFileSync(new URL('../src/data/landmarks.generated.json', import.meta.url),'utf8'));
  const skytree=catalog.find(target=>target.id==='tokyo-skytree');
  const longitude=Number((skytree.longitude-0.05).toFixed(4)),latitude=Number(skytree.latitude.toFixed(4));
  await settle(()=>setControl(input('经度'),longitude));await settle(()=>setControl(input('纬度'),latitude));
  const map=await readyTerrain();
  await settle(()=>document.querySelector('[aria-label="显示建筑"]').click());
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'true');
  const layer=map.customLayers.find(l=>l.id==='preview-buildings'),readout=()=>document.querySelector('.building-readout');
  await settle(()=>layer.report({...layer.status,phase:'loading',progress:{stage:'tiles',done:12,total:48}}));
  const bar=readout().querySelector('progress');assert.equal(bar.value,12);assert.equal(bar.max,48);
  assert.match(readout().textContent,/读取 OSM 建筑 25%/);
  assert.match(readout().querySelector('[data-landmark-id="tokyo-skytree"]').textContent,/加载中/);
  await settle(()=>layer.report({...layer.status,phase:'ready',progress:undefined,coverage:3200,candidates:500,polygons:200,
    landmarks:[{id:'tokyo-skytree',phase:'applied',distance:4500,ground:5,triangles:88581,message:''},{id:'tokyo-tower',phase:'fallback',reason:'budget',distance:9000,message:''}]}));
  const text=readout().textContent;
  assert.equal(readout().querySelector('progress'),null);
  assert.match(text,/约 3\.2 km 内（已达瓦片数量上限）/);assert.match(text,/已省略 300 个/);assert.match(text,/已加载 1 \/ 2/);
  assert.match(readout().querySelector('[data-landmark-id="tokyo-skytree"]').textContent,/已加载/);
  assert.match(readout().querySelector('[data-landmark-id="tokyo-tower"]').textContent,/超出绘制上限/);
  for(const debug of [/已读取瓦片/,/三角面/,/来源版本/,/本次载入/,/分块体块/,/test-fixture/])assert.doesNotMatch(text,debug);
  await settle(()=>document.querySelector(`[aria-label="朝向${skytree.name}"]`).click());
  const [east,north,up]=ellipsoidalRay({longitude,latitude,ellipsoidalHeight:1001.6},{longitude:skytree.longitude,latitude:skytree.latitude,ellipsoidalHeight:5+skytree.bounds.height/2});
  assert.ok(Math.abs(value('方位角')-(Math.atan2(east,north)*180/Math.PI+360)%360)<0.06,`方位 ${value('方位角')}`);
  assert.ok(Math.abs(value('俯仰角')-Math.atan2(up,Math.hypot(east,north))*180/Math.PI)<0.06,`俯仰 ${value('俯仰角')}`);
  for(const removed of [/缓存/,/清理/])assert.doesNotMatch(readout().textContent,removed);
});

test('星座和银河子设置位于右栏；镜头与时间在预览下方，坐标、方向与高度在地图下方，不再有参数栏', async t => {
  await workspace(t); await readyTerrain();
  const stars = document.querySelector('[aria-label="显示星座名称与连线"]');
  assert.ok(stars.closest('#info-stars-body')); assert.equal(stars.disabled, true);
  assert.equal(document.querySelector('.sidebar [aria-label="显示星座名称与连线"]'), null);
  assert.ok(document.querySelector('#galaxy-contrast').closest('#info-milkyWay-body'));
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  await settle(() => stars.click()); assert.equal(stars.checked, true);
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(stars.checked, false); assert.equal(stars.disabled, true);
  assert.equal(document.querySelector('.panel-parameters'), null);
  assert.equal(document.querySelectorAll('.panel').length, 2);
  // Direction sits under the coordinates below the map; lens and time below the frame.
  for (const label of ['方位角', '俯仰角']) assert.ok(input(label).closest('.panel-map .position-bar .position-view'), label);
  assert.equal(document.querySelector('.preview-meta input'), null);
  for (const control of [input('焦距'), document.querySelector('[aria-label="焦距滑块"]'), document.querySelector('[aria-label="传感器"]'),
    document.querySelector('[aria-label="画幅比例"]'), document.querySelector('[aria-label="拍摄画幅方向"]')])
    assert.ok(control.closest('.panel-preview .camera-bar'));
  const date = document.querySelector('input[type="date"]'), clock = document.querySelector('input[type="time"]');
  assert.equal(date.closest('.time-row'), clock.closest('.time-row'));
  assert.equal(document.querySelector('.timezone-trigger').closest('.time-row'), clock.closest('.time-row'));
  assert.ok(clock.closest('.panel-preview .timeline'));
  // Position and height below the map; the ground elevation comes from the preview.
  for (const label of ['纬度', '经度', '离地高度']) assert.ok(input(label).closest('.panel-map .position-bar'), label);
  const bar = document.querySelector('.position-bar');
  assert.ok(bar.querySelector('.position-coordinates').compareDocumentPosition(bar.querySelector('.position-view')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(document.querySelector('.panel-map .ground-elevation').textContent, /1000\.0/);
  assert.equal(document.querySelector('.preview-meta').textContent.includes('1000.0'), false);
  // Rare settings move next to what they affect.
  assert.ok(document.querySelector('[aria-label="大气折射模型"]').closest('#info-global-body .environment-settings'));
  assert.ok(document.querySelector('[aria-label="深空相机响应"]').closest('#info-deepSky-body'));
  await settle(() => setControl(clock, '19:35:12'));
  await settle(() => setControl(date, '2026-11-07'));
  assert.equal(clock.value, '19:35:12');
  assert.doesNotMatch(document.querySelector('.preview-meta').textContent, /未改机/);
  await settle(() => document.querySelector('[aria-label="显示深空天体"]').click());
  assert.match(document.querySelector('.preview-meta').textContent, /未改机/);
  await settle(() => setControl(document.querySelector('[aria-label="深空相机响应"]'), 'ha-modified'));
  assert.match(document.querySelector('.preview-meta').textContent, /天文改机/);
});

test('滚轮调焦与地图和参数同步，连续事件累积，缩放边界和浏览器组合键保留', async t => {
  const { map: browserMap } = await workspace(t); const map = await readyTerrain(), requests = groundRequests.length;
  const frame = document.querySelector('.viewfinder'), before = ['经度', '纬度', '方位角', '俯仰角'].map(value);
  const sector = structuredClone(geometry(browserMap));
  const wheel = (deltaY, options = {}) => {
    const event = new dom.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...options });
    frame.dispatchEvent(event); return event;
  };
  let event;
  await settle(() => { event = wheel(-100); wheel(-100); });
  assert.equal(event.defaultPrevented, true); assert.equal(value('焦距'), 52.2);
  assert.notDeepEqual(geometry(browserMap), sector);
  await settle(() => wheel(-10000)); assert.equal(value('焦距'), 1000);
  await settle(() => wheel(10000)); assert.equal(value('焦距'), 8);
  await settle(() => { event = wheel(-100, { ctrlKey: true }); });
  assert.equal(event.defaultPrevented, false); assert.equal(value('焦距'), 8);
  await settle(() => wheel(-3, { deltaMode: 1 })); assert.ok(value('焦距') > 8);
  assert.deepEqual(['经度', '纬度', '方位角', '俯仰角'].map(value), before);
  assert.equal(groundRequests.length, requests); assert.equal(terrainMap(), map);
});

test('新机位保留有效画布，短暂更新无加载提示，持续等待和失败明确反馈', async t => {
  const pending = [];
  await workspace(t, () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  await waitUntil(() => pending.length === 1);
  await settle(() => pending[0].resolve({ height: 1000 }));
  const map = await readyTerrain(), canvas = document.querySelector('.terrain-canvas');
  await settle(() => setControl(input('经度'), 139));
  assert.equal(canvas.dataset.ready, 'false'); assert.equal(canvas.dataset.rendered, 'true');
  assert.equal(document.querySelector('.terrain-feedback'), null);
  assert.match(document.querySelector('.ground-elevation').textContent, /待更新/);
  await waitUntil(() => pending.length === 2);
  await act(async () => { await delay(850); });
  assert.match(document.querySelector('.terrain-feedback').textContent, /暂留上一机位/);
  await settle(() => pending[1].resolve({ height: 1200 }));
  assert.equal(canvas.dataset.ready, 'true'); assert.equal(canvas.dataset.rendered, 'true');
  assert.equal(document.querySelector('.terrain-feedback'), null);
  assert.equal(map.cameraSolutions.at(-1).eye.lng, 139);
  await settle(() => setControl(input('经度'), 140));
  await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].reject(new Error('测试高程请求失败')));
  assert.equal(canvas.dataset.rendered, 'false');
  assert.match(document.querySelector('.terrain-feedback-error').textContent, /测试高程请求失败/);
});


test('画幅切换先同步画布尺寸再应用相机，无需等待 ResizeObserver', async t => {
  await workspace(t); const map = await readyTerrain(), calls = [];
  t.after(() => { terrainSize.width = 600; terrainSize.height = 400; });
  const resize = map.resize.bind(map), solve = map.calculateCameraOptionsFromTo.bind(map);
  map.resize = () => { calls.push('resize'); resize(); };
  map.calculateCameraOptionsFromTo = (...args) => { calls.push('camera'); return solve(...args); };
  await settle(() => {
    terrainSize.width = 400;
    setControl(document.querySelector('[aria-label="画幅比例"]'), '1:1');
  });
  assert.deepEqual(calls, ['resize', 'camera']);
  assert.equal(document.querySelector('.viewfinder').style.aspectRatio, '1');
  assert.equal(document.querySelector('.terrain-canvas').dataset.rendered, 'true');
  assert.equal(terrainMap(), map);
});


test('光污染位于“光照与环境”组，按当地数据更新天空和星点，镜头和方向复用数据', async t => {
  await workspace(t); const map = await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  const button = document.querySelector('input[aria-label="当地光污染"]');
  assert.deepEqual([...document.querySelectorAll('.preview-tools button')].map(e => e.getAttribute('aria-label')), ['显示构图线']);
  assert.ok(document.querySelector('.environment-settings').contains(button));
  assert.equal(button.checked, false); assert.equal(pollutionRequests.length, 0);
  const sky = structuredClone(map.environments.at(-1)), requests = groundRequests.length;
  const layer = map.customLayers.find(l => l instanceof TestStarfieldLayer);
  const pose = map.cameraSolutions.length;
  const before = [...document.querySelectorAll('[data-sky-status]')].map(e => Number(e.dataset.skyOpacity));
  await settle(() => button.click());
  await waitUntil(() => layer.frame.artificialMcd === 6.5);
  assert.equal(button.checked, true);
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /2015.*6.500/);
  assert.equal(layer.frame.artificialMcd, 6.5); assert.notDeepEqual(map.environments.at(-1), sky);
  const after = [...document.querySelectorAll('[data-sky-status]')].map(e => Number(e.dataset.skyOpacity));
  assert.ok(after.every((value,index) => value <= before[index]));
  assert.ok(after.some((value,index) => value < before[index] - .2));
  assert.equal(map.cameraSolutions.length, pose); assert.equal(groundRequests.length, requests);
  await settle(() => setControl(input('焦距'), 85));
  await settle(() => setControl(input('方位角'), 120));
  assert.equal(pollutionRequests.length, 1); assert.equal(groundRequests.length, requests);
  await settle(() => button.click());
  assert.equal(layer.frame.artificialMcd, undefined); assert.equal(document.querySelector('.pollution-status'), null);
  assert.deepEqual(map.environments.at(-1), sky); assert.equal(terrainMap(), map);
});

test('光污染取消过期位置与关闭请求，无覆盖、失败和重试均有独立状态', async t => {
  await workspace(t); await readyTerrain();
  const pending = [];
  pollutionResponse = (point, signal) => new Promise((resolve,reject) => pending.push({ point, signal, resolve, reject }));
  const toggle = document.querySelector('input[aria-label="当地光污染"]');
  await settle(() => toggle.click()); await waitUntil(() => pending.length === 1);
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /正在读取/);
  await settle(() => setControl(input('经度'), 139));
  await waitUntil(() => pending.length === 2); assert.equal(pending[0].signal.aborted, true);
  await settle(() => pending[0].resolve({ artificialMcd: 99 }));
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /正在读取/);
  await settle(() => toggle.click()); assert.equal(pending[1].signal.aborted, true);
  await settle(() => pending[1].resolve({ artificialMcd: 99 }));
  assert.equal(document.querySelector('.pollution-status'), null);
  await settle(() => toggle.click()); await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].reject(new Error('测试光污染读取失败')));
  assert.match(document.querySelector('.pollution-error').textContent, /未应用.*失败/);
  await settle(() => document.querySelector('.pollution-status button').click());
  await waitUntil(() => pending.length === 4);
  await settle(() => pending[3].resolve({ artificialMcd: 1 }));
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /2015.*1\.000/);
  await settle(() => setControl(input('纬度'), 80));
  assert.match(document.querySelector('.pollution-unavailable').textContent, /超出.*覆盖/);
  assert.equal(pending.length, 4); assert.equal(toggle.checked, true);
  await settle(() => toggle.click()); assert.equal(document.querySelector('.pollution-status'), null);
});


test('已加载预览隐藏后恢复同一尺寸时重新提交星空帧', async t => {
  await workspace(t); const map = await readyTerrain();
  const layer = map.customLayers.find(l => l instanceof TestStarfieldLayer);
  const old = layer.frame.key;
  const observer = resizeObservers.find(o => o.target === document.querySelector('.terrain-canvas'));
  await settle(() => observer.callback([{ contentRect: { width: 0, height: 0 } }]));
  await settle(() => observer.callback([{ contentRect: terrainSize }]));
  assert.notEqual(layer.frame.key, old); assert.equal(layer.frame.ready, true);
});

test('天气按需开启，数据与环境联动，时间和镜头复用机位序列，关闭恢复晴空', async t => {
  await workspace(t); const map = await readyTerrain();
  weatherLoader = async () => {
    const raw = weatherResponse(); raw.hourly.cloud_cover.fill(100); raw.hourly.cloud_cover_low.fill(100);
    return parseWeather(raw, Date.now());
  };
  const button = document.querySelector('[aria-label="天气效果"]');
  const layer = map.customLayers.find(l => l instanceof TestCelestialLayer);
  const before = structuredClone(map.environments.at(-1)), ground = groundRequests.length;
  assert.equal(button.checked, false); assert.equal(weatherRequests.length, 0);
  await settle(() => button.click());
  await waitUntil(() => document.querySelector('[data-weather-phase="ready"]'));
  assert.equal(layer.frame.weather.low, 1); assert.notDeepEqual(map.environments.at(-1), before);
  // Conclusion first (sky cover in words, chance of rain); exact values follow as details.
  assert.match(document.querySelector('.weather-readout [role="status"]').textContent, /^(晴朗|少云|多云|阴天) · 降水概率 \d+%$/);
  assert.ok([...document.querySelectorAll('.weather-readout .info-detail')].some((p) => /总云量/.test(p.textContent)));
  assert.match(document.querySelector('.weather-readout').textContent, /总云量.*降水.*Open-Meteo/s);
  for (const debug of [/起报批次/, /点位云量/, /云高与形态/, /模型 /, /获取 /, /预报 /])
    assert.doesNotMatch(document.querySelector('.weather-readout').textContent, debug);
  assert.equal(document.querySelector('.weather-status'), null);
  await setShootingDateTime('2026-11-05T01:00');
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  await settle(() => setControl(input('方位角'), 0));
  await settle(() => setControl(input('俯仰角'), 35)); await readyTerrain();
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent, /云层遮蔽/);
  await settle(() => setControl(input('焦距'), 85));
  await setShootingDateTime('2026-11-04T18:30');
  assert.equal(weatherRequests.length, 1); assert.equal(groundRequests.length, ground);
  assert.equal(layer.frame.weather.time, Date.parse('2026-11-04T09:30Z'));
  await settle(() => button.click());
  assert.equal(layer.frame.weather, undefined); assert.equal(terrainMap(), map);
  await setShootingDateTime('2026-11-04T17:00');
  assert.deepEqual(map.environments.at(-1), before);
});

test('天气机位请求取消、错误重试、超范围与缺值分别反馈，迟到数据不覆盖', async t => {
  await workspace(t); await readyTerrain();
  const pending = [];
  weatherLoader = (point, signal) => new Promise((resolve, reject) => pending.push({ point, signal, resolve, reject }));
  const button = document.querySelector('[aria-label="天气效果"]');
  await settle(() => button.click()); await waitUntil(() => pending.length === 1);
  assert.equal(document.querySelector('.weather-status'), null);
  await settle(() => setControl(input('经度'), 139));
  await waitUntil(() => pending.length === 2); assert.ok(pending[0].signal.aborted);
  await settle(() => pending[0].resolve(parseWeather(weatherResponse(), Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="loading"]'));
  await settle(() => pending[1].reject(new Error('测试天气下载失败')));
  assert.match(document.querySelector('.weather-status').textContent, /天气未应用.*失败/);
  await settle(() => document.querySelector('.weather-status button').click());
  await waitUntil(() => pending.length === 3);
  const response = weatherResponse(); response.hourly.cloud_cover_low[8] = null;
  await settle(() => pending[2].resolve(parseWeather(response, Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="missing"]'));
  await setShootingDateTime('2026-11-20T17:00');
  assert.ok(document.querySelector('[data-weather-phase="outside"]'));
  assert.equal(document.querySelector('.weather-status button').textContent, '使用当前时间');
  assert.equal(weatherRequests.length, 3);
  await settle(() => button.click()); assert.equal(document.querySelector('.weather-status'), null);
});

test('天气返回页面核对缓存年龄，过期时暂停效果并自动刷新', async t => {
  let clock = Date.UTC(2026, 10, 4, 8);
  t.mock.method(Date, 'now', () => clock);
  await workspace(t); const map = await readyTerrain();
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => document.querySelector('[data-weather-phase="ready"]'));
  clock += WEATHER_TTL;
  let resolve;
  weatherLoader = () => new Promise(done => { resolve = done; });
  await settle(() => dom.window.dispatchEvent(new dom.window.Event('focus')));
  await waitUntil(() => weatherRequests.length === 2);
  assert.ok(document.querySelector('[data-weather-phase="stale"]'));
  assert.equal(map.customLayers.find(l => l instanceof TestCelestialLayer).frame.weather, undefined);
  await settle(() => resolve(parseWeather(weatherResponse(), clock)));
  assert.ok(document.querySelector('[data-weather-phase="ready"]'));
  assert.equal(weatherRequests.length, 2);
});

test('环境分组保留关闭时的模型选择，切换模型取消旧数据且不改机位或重载 DEM', async t => {
  await workspace(t); const map = await readyTerrain(), ground = groundRequests.length;
  const select = document.querySelector('[aria-label="天气预测模型"]');
  assert.ok(document.querySelector('.environment-settings').contains(select));
  assert.deepEqual([...select.options].map((option) => option.value), ['best_match', 'gfs_seamless', 'icon_seamless', 'ecmwf_ifs']);
  assert.deepEqual([...select.options].map((option) => option.textContent).slice(1), ['NOAA GFS', 'DWD ICON', 'ECMWF IFS 9 km']);
  await settle(() => setControl(select, 'gfs_seamless'));
  assert.equal(weatherRequests.length, 0);
  const pending = [];
  weatherLoader = (point, signal, now, model) => new Promise(resolve => pending.push({ signal, model, resolve }));
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => pending.length === 1);
  assert.equal(pending[0].model, 'gfs_seamless');
  await settle(() => setControl(select, 'ecmwf_ifs'));
  await waitUntil(() => pending.length === 2);
  assert.ok(pending[0].signal.aborted);
  await settle(() => pending[0].resolve(parseWeather(weatherResponse(), Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="loading"]'));
  const raw = weatherResponse(); raw.hourly.visibility.fill(null);
  await settle(() => pending[1].resolve(parseWeather(raw, Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="ready"]'));
  assert.equal(pending[1].model, 'ecmwf_ifs');
  assert.match(document.querySelector('.weather-readout').textContent, /能见度 模型未提供/);
  assert.equal(terrainMap(), map); assert.equal(groundRequests.length, ground);
});

const shotButton = () => document.querySelector('.shot-button');
const panelButton = (text) => [...document.querySelectorAll('.shot-panel button')].find((b) => b.textContent.trim() === text);
const openShots = async () => { if (!document.querySelector('.shot-panel')) await settle(() => shotButton().click()); };
async function saveShotAs(name) {
  await openShots();
  await settle(() => (panelButton('保存为机位') ?? panelButton('另存为新机位')).click());
  await settle(() => setControl(document.querySelector('[aria-label="机位名称"]'), name));
  await settle(() => panelButton('保存').click());
}
const savedShots = () => JSON.parse(dom.window.localStorage.getItem('tamatamatori.shots.v1') ?? '{"shots":[]}').shots;
const keydown = (element, key) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));

test('页头删去调试文本；机位保存、修改标记、切换应用与撤销，参数、图层与右栏同步', async t => {
  await workspace(t); const map = await readyTerrain();
  const header = document.querySelector('.topbar').textContent;
  for (const removed of ['工作区原型', 'P3', '天文构图', '摄影规划']) assert.ok(!header.includes(removed), removed);
  assert.equal(shotButton().textContent.trim(), '未保存的机位');
  await openShots();
  assert.match(document.querySelector('.shot-current').textContent, /尚未保存/);
  assert.match(document.querySelector('.shot-empty').textContent, /还没有保存的机位/);
  await settle(() => panelButton('保存为机位').click());
  assert.match(document.querySelector('[aria-label="机位名称"]').value, /°N .*11-04 17:00/, 'suggested name from place and local time');
  await settle(() => setControl(document.querySelector('[aria-label="机位名称"]'), '富士 A'));
  await settle(() => panelButton('保存').click());
  assert.equal(shotButton().textContent.trim(), '富士 A'); assert.match(document.querySelector('.shot-notice').textContent, /已保存「富士 A」/);
  assert.equal(savedShots().length, 1);
  const [first] = savedShots();
  // Changing anything in the picture marks the bound shot as modified.
  await settle(() => setControl(input('焦距'), 85));
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  assert.ok(document.querySelector('.shot-modified')); assert.match(shotButton().getAttribute('aria-label'), /已修改/);
  await saveShotAs('富士 B');
  assert.equal(shotButton().textContent.trim(), '富士 B'); assert.equal(document.querySelector('.shot-modified'), null);
  assert.deepEqual(savedShots().map((entry) => entry.shot.name), ['富士 B', '富士 A']);
  // Apply A: every control, the layer switches and the information groups follow.
  await openShots();
  assert.match(document.querySelector(`[data-shot-id="${first.id}"]`).textContent, /富士 A.*35 mm · 全画幅 · 横幅 3:2/s);
  await settle(() => document.querySelector(`[data-shot-id="${first.id}"] .shot-apply`).click());
  assert.equal(document.querySelector('.shot-panel'), null); assert.equal(document.activeElement, shotButton());
  assert.equal(value('焦距'), 35); assert.equal(document.querySelector('[aria-label="显示星空"]').checked, false);
  assert.equal(document.querySelector('#info-stars').getAttribute('aria-expanded'), 'false');
  assert.equal(shotButton().textContent.trim(), '富士 A');
  assert.match(document.querySelector('.shot-toast').textContent, /已应用「富士 A」/);
  await settle(() => [...document.querySelectorAll('.shot-toast button')].find((b) => b.textContent === '撤销').click());
  assert.equal(value('焦距'), 85); assert.equal(document.querySelector('[aria-label="显示星空"]').checked, true);
  assert.equal(document.querySelector('#info-stars').getAttribute('aria-expanded'), 'true');
  assert.equal(shotButton().textContent.trim(), '富士 B'); assert.equal(document.querySelector('.shot-toast'), null);
  // Saving changes overwrites the bound entry and moves it to the top.
  await settle(() => setControl(input('焦距'), 50));
  await openShots(); await settle(() => panelButton('保存修改').click());
  assert.equal(savedShots()[0].shot.camera.focalLength, 50); assert.equal(document.querySelector('.shot-modified'), null);
  // Rename, then delete with undo.
  const second = savedShots()[0];
  await settle(() => document.querySelector(`[data-shot-id="${second.id}"] .shot-more`).click());
  await settle(() => panelButton('重命名').click());
  await settle(() => setControl(document.querySelector('[aria-label="新名称"]'), '富士 · 星空'));
  await settle(() => panelButton('确定').click());
  assert.equal(savedShots()[0].shot.name, '富士 · 星空'); assert.equal(shotButton().textContent.trim(), '富士 · 星空');
  await settle(() => document.querySelector(`[data-shot-id="${second.id}"] .shot-more`).click());
  await settle(() => panelButton('删除').click());
  assert.equal(savedShots().length, 1); assert.equal(shotButton().textContent.trim(), '未保存的机位');
  await settle(() => panelButton('撤销').click());
  assert.equal(savedShots().length, 2); assert.equal(shotButton().textContent.trim(), '富士 · 星空');
  await settle(() => keydown(document.querySelector('.shot-panel'), 'Escape'));
  assert.equal(document.querySelector('.shot-panel'), null);
  assert.equal(terrainMap(), map);
});

test('导入机位：错误带字段路径，部分 JSON 补默认值，任意时区与保存并应用，分享码往返', async t => {
  await workspace(t); await readyTerrain();
  await openShots(); await settle(() => panelButton('导入机位').click());
  const dialog = document.querySelector('.shot-dialog[open]'), field = dialog.querySelector('textarea');
  await settle(() => setControl(field, '{"format":"tamatamatori.shot","version":1,"view":{"azimuth":"西南"}}'));
  const errors = dialog.querySelector('.shot-errors').textContent;
  assert.match(errors, /view.azimuth：应为数字/); assert.match(errors, /position：缺少该字段/);
  assert.ok([...dialog.querySelectorAll('footer button')].every((b) => b.disabled));
  const json = { format: 'tamatamatori.shot', version: 1, name: '埃菲尔铁塔 · 冬夜', position: { latitude: 48.8530, longitude: 2.3499, heightAboveGround: 2 },
    view: { azimuth: 250, pitch: 8 }, camera: { focalLength: 200 }, time: { local: '2026-12-20T22:15', timeZone: 'Europe/Paris' }, layers: { moon: false, milkyWay: true } };
  await settle(() => setControl(field, '```json\n' + JSON.stringify(json, null, 2) + '\n```'));
  assert.equal(dialog.querySelector('.shot-errors'), null);
  assert.match(dialog.querySelector('.shot-summary').textContent, /埃菲尔铁塔附近.*2026-12-20 22:15 · Europe\/Paris.*200 mm.*太阳、银河/s);
  assert.match(dialog.querySelector('.shot-defaults').textContent, /camera.sensor/);
  assert.equal(dialog.querySelector('[aria-label="导入机位名称"]').value, '埃菲尔铁塔 · 冬夜');
  await settle(() => [...dialog.querySelectorAll('footer button')].find((b) => b.textContent === '保存并应用').click());
  assert.equal(dialog.open, false);
  assert.equal(value('焦距'), 200); assert.equal(value('纬度'), 48.853);
  assert.equal(document.querySelector('input[type="date"]').value, '2026-12-20');
  assert.match(document.querySelector('.timezone-trigger').textContent, /巴黎.*UTC\+1/);
  assert.equal(document.querySelector('[aria-label="显示银河"]').checked, true); assert.equal(document.querySelector('[aria-label="显示月亮"]').checked, false);
  assert.equal(shotButton().textContent.trim(), '埃菲尔铁塔 · 冬夜'); assert.equal(savedShots().length, 1);
  // Share the current shot and read the code back.
  await openShots(); await settle(() => panelButton('分享').click());
  const share = document.querySelector('.shot-dialog[open]'), code = share.querySelector('[aria-label="分享码"]').value;
  assert.match(code, /^tmt1:/);
  const parsed = parseShotText(code);
  assert.equal(parsed.ok, true); assert.equal(parsed.shot.name, '埃菲尔铁塔 · 冬夜'); assert.equal(parsed.plan.timeZone, 'Europe/Paris');
  assert.equal(parsed.plan.instant, '2026-12-20T21:15:00Z'); assert.equal(parsed.plan.focalLength, 200);
  const { $schema, ...written } = JSON.parse(share.querySelector('[aria-label="机位 JSON"]').value);
  assert.equal($schema, 'http://localhost/shot.schema.json'); assert.deepEqual(written, parsed.shot);
  // The link leads the dialog and reads back to the same shot.
  const link = share.querySelector('[aria-label="分享链接"]').value;
  assert.ok(link.startsWith('http://localhost/#shot=tmt1:')); assert.deepEqual(parseShotText(link).shot, parsed.shot);
  await settle(() => share.querySelector('header button').click());
  assert.equal(share.open, false);
});

test('时区选择：常用分组标出当前时区，中文城市搜索与键盘选择，Escape 不改时区，只改显示不改拍摄时刻', async t => {
  await workspace(t); await readyTerrain();
  const instant = document.querySelector('input[type="time"]').value, trigger = document.querySelector('.timezone-trigger');
  // New sessions follow the position's own zone ("当地时区").
  assert.match(trigger.textContent, /当地.*东京.*UTC\+9/);
  await settle(() => trigger.click());
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const groups = [...document.querySelectorAll('.timezone-group')].map((g) => g.textContent);
  assert.deepEqual(groups, ['常用'], 'only the common group is labelled; all zones follow a divider');
  assert.equal(document.querySelectorAll('.timezone-divider').length, 1);
  const options = [...document.querySelectorAll('.timezone-list [role="option"]')];
  assert.equal(options[0].dataset.zone, 'local');
  assert.match(options[0].textContent, /当地时区.*Asia\/Tokyo/);
  assert.deepEqual([...document.querySelectorAll('.timezone-list [aria-selected="true"]')].map((o) => o.dataset.zone), ['local']);
  assert.ok(options.some((o) => o.dataset.zone === 'Asia/Tokyo' && o.getAttribute('aria-selected') === 'false'));
  assert.ok(document.querySelectorAll('.timezone-list [role="option"]').length > 300);
  const search = document.querySelector('[aria-label="搜索时区"]');
  await settle(() => setControl(search, '悉尼'));
  assert.equal(document.querySelector('.timezone-list [role="option"]').dataset.zone, 'Australia/Sydney');
  assert.equal(search.getAttribute('aria-activedescendant'), document.querySelector('.timezone-list [role="option"]').id);
  await settle(() => keydown(search, 'Enter'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(document.activeElement, trigger);
  assert.match(trigger.textContent, /悉尼.*UTC\+11/, 'Sydney is on daylight time in November');
  assert.doesNotMatch(trigger.textContent, /当地/, 'a chosen zone no longer follows the position');
  assert.notEqual(document.querySelector('input[type="time"]').value, instant, 'display time changes with the zone');
  await settle(() => trigger.click());
  await settle(() => setControl(document.querySelector('[aria-label="搜索时区"]'), 'utc-3'));
  assert.ok([...document.querySelectorAll('.timezone-list [role="option"]')].some((o) => o.dataset.zone === 'America/Sao_Paulo'));
  await settle(() => keydown(document.querySelector('[aria-label="搜索时区"]'), 'Escape'));
  assert.equal(document.querySelector('.timezone-picker'), null); assert.match(trigger.textContent, /悉尼/);
  await settle(() => trigger.click());
  await settle(() => setControl(document.querySelector('[aria-label="搜索时区"]'), 'zzzz'));
  assert.match(document.querySelector('.timezone-note').textContent, /没有匹配的时区/);
});

test('刷新后恢复上次工作状态与关联机位，损坏的会话安静回退到默认机位', async t => {
  const first = await workspace(t); await readyTerrain();
  await settle(() => setControl(input('焦距'), 120));
  await chooseTimeZone('Asia/Shanghai', '北京');
  await saveShotAs('恢复测试');
  await settle(() => setControl(input('方位角'), 200));
  await act(async () => { await delay(350); });
  const session = JSON.parse(dom.window.localStorage.getItem('tamatamatori.session.v1'));
  assert.equal(session.shot.camera.focalLength, 120); assert.equal(session.shot.view.azimuth, 200); assert.equal(session.activeId, savedShots()[0].id);
  await first.unmount();
  const second = await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  assert.equal(value('焦距'), 120); assert.equal(value('方位角'), 200);
  assert.match(document.querySelector('.timezone-trigger').textContent, /北京/);
  assert.equal(shotButton().textContent.trim(), '恢复测试'); assert.ok(document.querySelector('.shot-modified'), 'azimuth changed after saving');
  await second.unmount();
  dom.window.localStorage.setItem('tamatamatori.session.v1', '{"version":1,"shot":{"format":"tamatamatori.shot"}}');
  await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  assert.equal(value('焦距'), 35); assert.equal(shotButton().textContent.trim(), '未保存的机位');
  assert.equal(savedShots().length, 1, 'saved shots are untouched');
});

test('本地存储不可用时说明无法保存、禁用保存，分享与仅应用仍可用', async t => {
  dom.window.localStorage.clear();
  const own = Object.getOwnPropertyDescriptor(dom.window, 'localStorage');
  Object.defineProperty(dom.window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  t.after(() => { if (own) Object.defineProperty(dom.window, 'localStorage', own); else delete dom.window.localStorage; });
  await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  await openShots();
  assert.match(document.querySelector('.shot-warning').textContent, /无法使用本地存储/);
  assert.equal(panelButton('保存为机位').disabled, true);
  await settle(() => panelButton('分享').click());
  assert.match(document.querySelector('.shot-dialog[open] [aria-label="分享码"]').value, /^tmt1:/);
  await settle(() => document.querySelector('.shot-dialog[open] header button').click());
  await openShots(); await settle(() => panelButton('导入机位').click());
  const dialog = document.querySelector('.shot-dialog[open]');
  await settle(() => setControl(dialog.querySelector('textarea'), JSON.stringify({ format: 'tamatamatori.shot', version: 1, position: { latitude: 35, longitude: 139 }, view: { azimuth: 10 }, time: { instant: '2026-11-04T08:00:00Z' } })));
  const [only, keep] = dialog.querySelectorAll('footer button');
  assert.equal(keep.disabled, true); assert.equal(only.disabled, false);
  await settle(() => only.click());
  assert.equal(value('方位角'), 10); assert.equal(shotButton().textContent.trim(), '未保存的机位');
});

test('拍摄时间：微调按钮跨午夜，前后一天保留钟点，夏令时缺失钟点报错并保留原时刻', async t => {
  await workspace(t); await readyTerrain();
  const press = (label) => settle(() => document.querySelector(`[aria-label="${label}"]`).click());
  await setShootingDateTime('2026-11-04T23:55');
  await press('推后 10 分钟');
  assert.equal(shootingDateTime(), '2026-11-05T00:05');
  await press('前一天');
  assert.equal(shootingDateTime(), '2026-11-04T00:05');
  await press('提前 1 小时');
  assert.equal(shootingDateTime(), '2026-11-03T23:05');
  await press('推后 1 分钟'); await press('推后 1 小时');
  assert.equal(shootingDateTime(), '2026-11-04T00:06');
  assert.equal(document.querySelector('.date-field .weekday').textContent, '周三');
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  assert.match(slider.getAttribute('aria-valuetext'), /^00:06:00 Asia\/Tokyo · 夜间$/);
  assert.ok(document.querySelector('.time-band').style.background.includes('linear-gradient'), 'daylight band painted');
  await chooseTimeZone('America/New_York');
  await setShootingDateTime('2026-03-07T02:30');
  await press('后一天');
  assert.equal(shootingDateTime(), '2026-03-07T02:30', '02:30 does not exist on 8 March');
  assert.match(document.getElementById('time-error').textContent, /夏令时/);
  await press('推后 1 小时');
  assert.equal(shootingDateTime(), '2026-03-07T03:30');
  assert.equal(document.getElementById('time-error'), null);
});

test('时间轴只标注已开启图层的事件：点击刻度跳转，上一/下一事件逐个移动，夜空图层改为中午到次日中午，极夜说明缺少的日出日落', async t => {
  await workspace(t); await readyTerrain();
  await setShootingDateTime('2026-11-04T12:00');
  const plan = { latitude: value('纬度'), longitude: value('经度'), timeZone: 'Asia/Tokyo', refraction: 'standard', instant: '2026-11-04T03:00:00Z' };
  const expected = Object.fromEntries(dayEvents(plan).map((event) => [event.id, event]));
  const marker = (id) => document.querySelector(`.time-marker[data-event="${id}"]`);
  const kinds = () => [...document.querySelectorAll('.time-marker')].map((b) => b.dataset.event);
  const steps = () => [...document.querySelectorAll('.time-event-step')];
  const local = (instant) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
  // Sun and Moon are on by default: their rise and set only, in time order.
  assert.equal(document.querySelector('.timeline').dataset.mode, 'day');
  assert.deepEqual(kinds(), ['moonrise', 'sunrise', 'moonset', 'sunset']);
  assert.equal(marker('sunset').getAttribute('aria-label'), `跳到日落 ${local(expected.sunset.instant).slice(0, 5)}`);
  assert.match(marker('sunset').title, /标准折射.*不含地形遮挡/);
  await settle(() => marker('sunset').click());
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.sunset.instant));
  assert.ok(marker('sunset').classList.contains('is-current'));
  assert.equal(steps()[1].disabled, true, 'sunset is the last event of the day');
  assert.match(steps()[0].getAttribute('aria-label'), /上一事件：月落/);
  await settle(() => steps()[0].click());
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.moonset.instant));
  await settle(() => steps()[1].click());
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.sunset.instant));
  // Turning the Moon off drops its markers; a night layer adds the dark span and moves to noon-to-noon.
  await settle(() => document.querySelector('[aria-label="显示月亮"]').click());
  assert.deepEqual(kinds(), ['sunrise', 'sunset']);
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(document.querySelector('.timeline').dataset.mode, 'night');
  assert.match(document.querySelector('.time-slider').getAttribute('aria-label'), /中午到次日中午/);
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.sunset.instant), 'the axis changes, not the instant');
  assert.deepEqual(kinds(), ['sunset', 'dusk', 'dawn', 'sunrise']);
  assert.equal(marker('dusk').getAttribute('aria-label'), `跳到昏影 ${local(expected.dusk.instant).slice(0, 5)}`);
  assert.deepEqual([...document.querySelectorAll('.time-slider-ticks span')].map((tick) => tick.textContent), ['12:00', '18:00', '11/5', '06:00', '11:59']);
  await settle(() => marker('dawn').click());
  assert.equal(shootingDateTime().slice(0, 10), '2026-11-05');
  assert.equal(document.querySelector('.timeline').dataset.mode, 'night');
  assert.deepEqual(kinds(), ['sunset', 'dusk', 'dawn', 'sunrise'], 'early morning stays on the same night');
  // Refraction changes the rise/set definition, not twilight.
  await settle(() => setControl(document.querySelector('select[aria-label="大气折射模型"]'), 'none'));
  assert.match(marker('sunrise').title, /无折射/);
  assert.match(marker('dusk').title, /地平下 18°/);
  // Polar night: the enabled Sun layer has no rise or set in the span.
  await settle(() => setControl(input('纬度'), 78.2232));
  await settle(() => setControl(input('经度'), 15.6267));
  await chooseTimeZone('Arctic/Longyearbyen', 'Longyearbyen');
  await setShootingDateTime('2026-12-15T12:00');
  assert.equal(marker('sunrise'), null);
  assert.match(document.querySelector('.time-missing').textContent, /本时段无：日出、日落/);
});

test('当地时区随机位变化并提示一次，拍摄时刻不变；改选固定时区后不再跟随', async t => {
  await workspace(t); await readyTerrain();
  const trigger = document.querySelector('.timezone-trigger');
  const before = shootingDateTime();
  const latitude = input('纬度');
  const paste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    latitude.dispatchEvent(event);
  };
  await settle(() => paste('48.8584, 2.2945'));
  assert.match(trigger.textContent, /当地.*巴黎.*UTC\+1/);
  assert.match(document.querySelector('.time-zone-notice').textContent, /时区随机位改为巴黎（UTC\+1），拍摄时刻不变/);
  // 2026-11-04T08:00Z: 17:00 in Tokyo is 09:00 in Paris.
  assert.equal(before.slice(11), '17:00');
  assert.equal(shootingDateTime(), '2026-11-04T09:00');
  await chooseTimeZone('Asia/Tokyo');
  assert.doesNotMatch(trigger.textContent, /当地/);
  await settle(() => paste('40.7128, -74.006'));
  assert.match(trigger.textContent, /东京/);
  assert.equal(shootingDateTime(), '2026-11-04T17:00');
  // Choosing "当地时区" again follows New York.
  await settle(() => trigger.click());
  await settle(() => document.querySelector('.timezone-list [data-zone="local"]').click());
  assert.match(trigger.textContent, /当地.*纽约.*UTC[−-]5/);
  assert.equal(shootingDateTime(), '2026-11-04T03:00');
});

test('离地高度滑条按对数刻度同步数值框，方向键按 0.1 m / 1 m 微调', async t => {
  await workspace(t); await readyTerrain();
  const slider = document.querySelector('input[aria-label="离地高度滑块"]');
  await settle(() => setControl(slider, cameraHeightSlider.toPosition(10)));
  assert.equal(value('离地高度'), 10);
  assert.equal(slider.getAttribute('aria-valuetext'), '10 m');
  await settle(() => keydown(slider, 'ArrowLeft'));
  assert.equal(value('离地高度'), 9.9);
  await settle(() => setControl(slider, cameraHeightSlider.max));
  assert.equal(value('离地高度'), 100);
  await settle(() => keydown(slider, 'ArrowUp'));
  assert.equal(value('离地高度'), 100);
  await settle(() => setControl(input('离地高度'), 1.5));
  assert.equal(slider.value, String(cameraHeightSlider.toPosition(1.5)));
  await settle(() => keydown(slider, 'ArrowRight'));
  assert.equal(value('离地高度'), 1.6);
});

test('机位条位于地图下方：粘贴“纬度, 经度”一次填入两项，单个数值照常输入，地面高程来自预览', async t => {
  await workspace(t); await readyTerrain();
  const latitude = input('纬度');
  assert.ok(latitude.closest('.panel-map .position-bar'));
  assert.match(document.querySelector('.ground-elevation').textContent, /1000\.0/);
  const paste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    latitude.dispatchEvent(event);
    return event;
  };
  let event;
  await settle(() => { event = paste('35.6586, 139.7454'); });
  assert.equal(event.defaultPrevented, true);
  assert.equal(value('纬度'), 35.6586);
  assert.equal(value('经度'), 139.7454);
  await settle(() => { event = paste('36'); });
  assert.equal(event.defaultPrevented, false, 'a single number is left to the input');
  assert.equal(value('经度'), 139.7454);
});

test('预览双指捏合按两指间距比例调焦，不改方向；松开一指后不再转动', async t => {
  await workspace(t); await readyTerrain();
  const frame = document.querySelector('.viewfinder');
  frame.getBoundingClientRect = () => ({ width: 600, height: 400 });
  const touch = (type, pointerId, clientX, clientY) => frame.dispatchEvent(new dom.window.PointerEvent(type, {
    pointerId, pointerType: 'touch', button: 0, clientX, clientY, bubbles: true,
  }));
  const pose = ['方位角', '俯仰角'].map(value);
  assert.equal(value('焦距'), 35);
  await settle(() => touch('pointerdown', 1, 250, 200));
  await settle(() => touch('pointerdown', 2, 350, 200));
  await settle(() => touch('pointermove', 2, 450, 200));
  assert.equal(value('焦距'), 70);
  await settle(() => touch('pointermove', 1, 400, 200));
  assert.equal(value('焦距'), 17.5);
  assert.deepEqual(['方位角', '俯仰角'].map(value), pose);
  await settle(() => touch('pointerup', 2, 450, 200));
  await settle(() => touch('pointermove', 1, 300, 260));
  assert.equal(value('焦距'), 17.5);
  assert.deepEqual(['方位角', '俯仰角'].map(value), pose);
  await settle(() => touch('pointerup', 1, 300, 260));
});

test('窄屏：预览与时间轴常驻，相机条移入“相机”标签，切换标签不重建地图或预览，变宽后恢复', async t => {
  const listeners = new Set();
  const narrow = { matches: true, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  const original = window.matchMedia;
  window.matchMedia = (query) => query === '(max-width: 1099px)' ? narrow : { matches: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { window.matchMedia = original; });
  const { map } = await workspace(t); const terrain = await readyTerrain();
  const layout = document.querySelector('.app-layout');
  const tabs = () => [...document.querySelectorAll('.mobile-tabs [role="tab"]')];
  const tab = (name) => tabs().find((element) => element.textContent.trim() === name);
  assert.deepEqual(tabs().map((element) => element.textContent.trim()), ['地图', '相机', '图层']);
  assert.equal(layout.dataset.mobileTab, 'map');
  assert.equal(document.querySelector('.panel-preview .camera-bar'), null);
  assert.ok(input('焦距').closest('.mobile-camera'));
  assert.ok(document.querySelector('.panel-preview .timeline'));
  await settle(() => tab('相机').click());
  assert.equal(layout.dataset.mobileTab, 'camera');
  assert.equal(tab('相机').getAttribute('aria-selected'), 'true');
  await settle(() => setControl(input('焦距'), 85));
  await settle(() => tab('图层').click());
  assert.equal(layout.dataset.mobileTab, 'layers');
  assert.equal(await waitForMap(), map);
  assert.ok(!map.removed);
  assert.equal(await readyTerrain(), terrain);
  await settle(() => { narrow.matches = false; for (const listener of listeners) listener(); });
  assert.ok(input('焦距').closest('.panel-preview .camera-bar'));
  assert.equal(document.querySelector('.mobile-camera'), null);
  assert.equal(value('焦距'), 85);
  assert.equal(await readyTerrain(), terrain);
});

test('太阳、月亮分组各有运行轨迹开关：从属于天体图层，开启后预览得到轨迹线与整点标注', async t => {
  await workspace(t); const map = await readyTerrain();
  const layer = () => map.customLayers.find(l => l instanceof TestCelestialLayer);
  const toggle = (body) => document.querySelector(`[data-info-group="${body}"] input[aria-label="显示${body === 'sun' ? '太阳' : '月亮'}运行轨迹"]`);
  assert.ok(toggle('sun') && toggle('moon'), 'each switch sits in its own group');
  assert.deepEqual([toggle('sun').checked, toggle('moon').checked], [false, false]);
  assert.equal(document.querySelector('[data-path-marker]'), null);
  await setShootingDateTime('2026-11-04T12:00');
  await settle(() => document.querySelector('button[aria-label="朝向太阳"]').click());
  const poses = map.cameraSolutions.length, requests = groundRequests.length, fields = ['经度', '纬度', '方位角', '俯仰角', '焦距'].map(value);
  await settle(() => toggle('sun').click());
  assert.equal(toggle('sun').checked, true);
  assert.equal(document.querySelector('[data-path-status="sun"]').textContent, '本次出没 · 经过画面');
  const sunLabels = [...document.querySelectorAll('[data-path-marker^="sun-"]')].map(e => e.dataset.pathMarker);
  assert.ok(sunLabels.includes('sun-12:00') && sunLabels.length >= 2, sunLabels.join());
  assert.deepEqual(layer().frame.paths.map(p => p.id), ['sun']);
  assert.ok(layer().frame.paths[0].runs.flat().length > 10 && layer().frame.paths[0].markers.length === sunLabels.length);
  // A display aid: no camera, ground or plan change.
  assert.equal(map.cameraSolutions.length, poses); assert.equal(groundRequests.length, requests);
  assert.deepEqual(['经度', '纬度', '方位角', '俯仰角', '焦距'].map(value), fields);
  // Whole hours follow the selected time zone; the instant stays.
  await chooseTimeZone('UTC');
  assert.ok(document.querySelector('[data-path-marker="sun-03:00"]'), 'noon in Tokyo is 03:00 UTC');
  assert.equal(document.querySelector('[data-path-marker="sun-12:00"]'), null);
  await chooseTimeZone('Asia/Tokyo', 'Tokyo');
  // The moon has its own pass and switch.
  const moon = bodyPath({ latitude: value('纬度'), longitude: value('经度'), timeZone: 'Asia/Tokyo', refraction: 'standard', instant: '2026-11-04T03:00:00Z' }, 'moon');
  await settle(() => toggle('moon').click());
  assert.match(document.querySelector('[data-path-status="moon"]').textContent, new RegExp(`^${{ current: '本次', next: '下一次', previous: '上一次' }[moon.pass]}出没 · `));
  assert.deepEqual(layer().frame.paths.map(p => p.id), ['sun', 'moon']);
  // Switching the Sun off takes its path with it, and switching it on again does not restore it.
  await settle(() => document.querySelector('input[aria-label="显示太阳"]').click());
  assert.deepEqual([toggle('sun').checked, toggle('sun').disabled], [false, true]);
  assert.equal(document.querySelector('[data-path-marker^="sun-"]'), null);
  assert.equal(document.querySelector('[data-path-status="sun"]'), null);
  assert.deepEqual(layer().frame.paths.map(p => p.id), ['moon']);
  await settle(() => document.querySelector('input[aria-label="显示太阳"]').click());
  assert.deepEqual([toggle('sun').checked, toggle('sun').disabled], [false, false]);
  assert.equal(toggle('moon').checked, true);
});

test('流星雨图层：左栏开启后列出拍摄日期的活动流星雨与辐射点，右栏开关驱动整晚画面内估算，同一夜内移动时刻不改暗夜，关闭图层同时关闭密度', async t => {
  await workspace(t); const map = await readyTerrain();
  const layerSwitch = () => document.querySelector('input[aria-label="显示流星雨"]');
  const density = () => document.querySelector('[data-info-group="meteors"] input[aria-label="显示流星雨预估密度"]');
  const fact = () => document.querySelector('[data-meteor-fact]');
  const night = () => document.querySelector('[data-meteor-night]')?.textContent;
  assert.equal(layerSwitch().checked, false);
  assert.deepEqual([density().checked, density().disabled], [false, true]);
  assert.equal(document.querySelector('[data-info-group="meteors"] input[type="range"]'), null, 'no duration slider');
  assert.match(document.querySelector('[data-info-group="meteors"]').textContent, /流星雨已关闭/);
  await setShootingDateTime('2026-08-13T00:30');
  const requests = groundRequests.length, poses = map.cameraSolutions.length;
  await settle(() => layerSwitch().click());
  assert.equal(document.getElementById('info-meteors').getAttribute('aria-expanded'), 'true');
  const rows = [...document.querySelectorAll('[data-meteor-status]')].map((row) => row.dataset.meteorStatus);
  assert.equal(rows[0], 'PER', 'strongest shower first');
  assert.deepEqual([...rows].sort(), ['ANT', 'CAP', 'ERI', 'KCG', 'PER', 'SDA']);
  assert.match(document.querySelector('[data-meteor-status="PER"]').textContent, /ZHR 约 \d+（峰值 100，极大前后）/);
  await settle(() => document.querySelector('button[aria-label="朝向英仙座流星雨辐射点"]').click());
  assert.ok(document.querySelector('[data-meteor-label="PER"]'), 'radiant label in frame');
  assert.equal(fact(), null);
  await settle(() => density().click());
  const plan = { latitude: value('纬度'), longitude: value('经度'), instant: '2026-08-12T15:30:00Z', azimuth: value('方位角'), pitch: value('俯仰角'),
    focalLength: value('焦距'), sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' };
  const shown = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const whole = meteorEstimate(plan);
  assert.equal(fact().textContent, `流星示意 · 整晚暗夜 ${Number(whole.darkHours.toFixed(1))} 小时 · 画面内约 ${shown(whole.expected)} 颗`);
  assert.equal(night(), `暗夜 8月12日 ${clock(whole.dark.from)}—8月13日 ${clock(whole.dark.to)} · ${Number(whole.darkHours.toFixed(1))} 小时`);
  assert.match(document.querySelector('[data-meteor-estimate]').textContent, /整晚画面内约 \d+ 颗.*固定机位整晚连拍.*光污染未开启，按自然天空/);
  const starfield = map.customLayers.find((l) => l instanceof TestStarfieldLayer);
  assert.equal(starfield.frame.plan.layers.meteorDensity, true);
  assert.equal('meteorHours' in starfield.frame.plan, false);
  assert.equal(groundRequests.length, requests); assert.equal(map.cameraSolutions.length, poses + 1, 'only the explicit 朝向 turned the camera');
  // 22:00 the evening before is the same night: same dark stretch, another anchor for the alignment.
  const range = night();
  await setShootingDateTime('2026-08-12T22:00');
  const evening = meteorEstimate({ ...plan, instant: '2026-08-12T13:00:00Z' });
  assert.equal(night(), range);
  assert.equal(fact().textContent, `流星示意 · 整晚暗夜 ${Number(evening.darkHours.toFixed(1))} 小时 · 画面内约 ${shown(evening.expected)} 颗`);
  assert.notEqual(Math.round(evening.expected), Math.round(whole.expected));
  await setShootingDateTime('2026-08-13T00:30');
  // Turning the layer off takes the estimate with it; turning it on again keeps it off.
  await settle(() => layerSwitch().click());
  assert.deepEqual([density().checked, density().disabled], [false, true]);
  assert.equal(fact(), null); assert.equal(document.querySelector('[data-meteor-label]'), null);
  await settle(() => layerSwitch().click());
  assert.equal(density().checked, false);
  // The antihelion source has no maximum: a constant rate without days from peak.
  assert.match(document.querySelector('[data-meteor-status="ANT"]').textContent, /ZHR 约 4\.0 · 30\skm\/s/);
  // Variable showers list a radiant but no estimate.
  await setShootingDateTime('2026-06-25T00:30');
  assert.match(document.querySelector('[data-meteor-status="JBO"]').textContent, /ZHR 不定，不估算/);
});

const publishedComets = JSON.parse(readFileSync(new URL('../public/comets/catalog.json', import.meta.url), 'utf8'));
/** The published catalogue with update times relative to the real clock, as the browser would see it. */
function cometCatalogAt(hoursAgo, extra = {}) {
  const stamp = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  return { ...publishedComets, fetchedAt: stamp(hoursAgo), attemptedAt: stamp(extra.attemptedHoursAgo ?? hoursAgo), ...extra.fields };
}

test('彗星图层：左栏开启后读取已发布目录，列出拍摄时刻的彗星，右栏给出星等与暗夜/当前天光下的彗尾长度，朝向后画面出现标注，回归期外与关闭分别提示', async t => {
  const served = cometCatalogAt(3), calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return new Response(JSON.stringify(served)); });
  await workspace(t); const map = await readyTerrain();
  assert.deepEqual(calls, [], 'the catalogue is read only when the layer is on');
  const starfield = () => map.customLayers.find((l) => l instanceof TestStarfieldLayer);
  const layerSwitch = () => document.querySelector('input[aria-label="显示彗星"]');
  const group = () => document.querySelector('[data-info-group="comets"]');
  assert.equal(layerSwitch().checked, false);
  assert.match(group().textContent, /彗星已关闭/);
  // NEOWISE in the evening twilight of 2020-07-15 from the default site.
  await setShootingDateTime('2020-07-15T20:30');
  const requests = groundRequests.length;
  await settle(() => layerSwitch().click());
  assert.equal(document.getElementById('info-comets').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(calls, ['/comets/catalog.json']);
  const catalog = validateCometCatalog(served);
  const plan = { latitude: value('纬度'), longitude: value('经度'), instant: '2020-07-15T11:30:00Z' };
  const scene = cometScene(plan, catalog);
  const neowise = scene.views.find((view) => view.comet.id === 'C/2020 F3');
  assert.ok(neowise, 'NEOWISE listed');
  assert.deepEqual([...document.querySelectorAll('[data-comet-status]')].map((row) => row.dataset.cometStatus), scene.views.map((view) => view.comet.id));
  const row = document.querySelector('[data-comet-status="C/2020 F3"]');
  assert.match(row.textContent, /新智彗星 C\/2020 F3(?! \()/);
  assert.match(row.textContent, new RegExp(`${neowise.magnitude.toFixed(1)} 等`));
  assert.ok(scene.visibleShare < 1, 'evening twilight dims the tails');
  assert.match(document.querySelector('[data-comet-sky]').textContent, /天空比暗夜亮约 \d\.\d 等，彗尾约显示前 \d+%/);
  assert.match(row.querySelector('[data-comet-tail]').textContent, /离子尾 [\d.]+°? · 尘埃尾 [\d.]+[°′] · 暗夜 [\d.]+° \/ [\d.]+[°′]/);
  assert.equal(document.querySelector('[data-comet-updated]').textContent, served.fetchedAt.slice(0, 10));
  assert.equal(document.querySelector('[data-comet-feed]'), null, 'fresh catalogue: no update notice');
  assert.equal(starfield().frame.comets.key, scene.key);
  assert.equal(starfield().frame.plan.layers.comets, true);
  await settle(() => document.querySelector('button[aria-label="朝向新智彗星"]').click());
  assert.ok(document.querySelector('[data-comet-label="C/2020 F3"]'), 'head label in frame');
  assert.match(document.querySelector('[data-comet-label="C/2020 F3"]').textContent, /新智彗星/);
  assert.equal(groundRequests.length, requests, 'comets do not reload terrain');
  // Outside every apparition window of the catalogue.
  await setShootingDateTime('1991-01-15T20:30');
  assert.equal(document.querySelectorAll('[data-comet-status]').length, cometScene({ ...plan, instant: '1991-01-15T11:30:00Z' }, catalog).views.length);
  await settle(() => layerSwitch().click());
  assert.match(group().textContent, /彗星已关闭/);
  assert.equal(document.querySelector('[data-comet-label]'), null);
});

test('彗星目录：读取失败可重试并保留图层，超过 1 天未更新与自动更新暂停分别提示', async t => {
  let respond = async () => new Response('busy', { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => respond());
  await workspace(t); await readyTerrain();
  const group = () => document.querySelector('[data-info-group="comets"]');
  await setShootingDateTime('2020-07-15T20:30');
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  assert.match(document.querySelector('[data-comet-feed="error"]').textContent, /彗星目录读取失败 · 彗星目录 HTTP 503/);
  assert.equal(document.querySelectorAll('[data-comet-status]').length, 0);
  // Retry: a catalogue last updated nine days ago is shown with a staleness notice.
  const old = cometCatalogAt(9 * 24);
  respond = async () => new Response(JSON.stringify(old));
  await settle(() => group().querySelector('[data-comet-feed="error"] button').click());
  assert.match(document.querySelector('[data-comet-feed="stale"]').textContent, /目录已 9 天未更新，新发现或新近变亮的彗星可能缺失/);
  assert.ok(document.querySelector('[data-comet-status="C/2020 F3"]'));
  // A later failed update: the same comets, update paused, no staleness notice on top.
  const paused = cometCatalogAt(9 * 24, { attemptedHoursAgo: 1, fields: { status: 'error', blocked: true, error: 'cobs.si HTTP 503，自动更新已暂停，需维护者检查后手动恢复' } });
  respond = async () => new Response(JSON.stringify(paused));
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  assert.match(document.querySelector('[data-comet-feed="paused"]').textContent, new RegExp(`目录自动更新已暂停，沿用 ${old.fetchedAt.slice(0, 10)} 的目录`));
  assert.equal(document.querySelector('[data-comet-feed="stale"]'), null);
  assert.ok(document.querySelector('[data-comet-status="C/2020 F3"]'));
  // An older copy (for example from a cache) never replaces what is shown.
  respond = async () => new Response(JSON.stringify(cometCatalogAt(20 * 24)));
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  assert.match(document.querySelector('[data-comet-feed="error"]').textContent, /彗星目录刷新失败，沿用 .* 的目录 · 彗星目录更新记录回退/);
  assert.ok(document.querySelector('[data-comet-status="C/2020 F3"]'));
});

test('右栏先给结论：详细数值默认隐藏，开启后显示并在本浏览器保留；深空只展开地平线以上的目标，光污染给出定性等级', async t => {
  const first = await workspace(t); await readyTerrain();
  const body = () => document.querySelector('.info-body');
  const toggle = () => document.querySelector('[aria-label="显示详细数值"]');
  assert.equal(toggle().checked, false);
  assert.equal(body().classList.contains('show-details'), false);
  // Sun: status, then the spoken direction; exact azimuth and heights are a detail.
  const sun = document.querySelector('[data-body-status="sun"] .celestial-coordinates');
  assert.match(sun.firstChild.textContent, /^(北|东北|东|东南|南|西南|西|西北) · 高 -?\d+°$/);
  assert.match(sun.querySelector('.info-detail').textContent, /° \/ 视 .*（几何 .*°）/);
  // Lighting and environment: phase first; viewing angles only as details.
  assert.match(document.querySelector('.preview-lighting strong').textContent, /^(夜间|天文暮光|航海暮光|民用暮光|低角度日照|白昼)$/);
  assert.ok(document.querySelector('#info-global-body .info-detail-section .preview-readout'));
  await settle(() => document.querySelector('[aria-label="当地光污染"]').click());
  await waitUntil(() => /严重/.test(document.querySelector('.pollution-readout p').textContent));
  const pollution = document.querySelector('.pollution-readout p');
  assert.match(pollution.firstChild.textContent, /严重光污染，只剩亮星/, '6.5 mcd/m² is about 37 times the natural sky');
  assert.match(pollution.querySelector('.info-detail').textContent, /天顶人工亮度 ≈ 6\.500 mcd\/m²/);
  // Deep sky: targets below the horizon are folded under one line.
  await settle(() => document.querySelector('[aria-label="显示深空天体"]').click());
  const below = [...document.querySelectorAll('.sky-below [data-dso-status]')];
  const shown = [...document.querySelectorAll('#info-deepSky-body [data-dso-status]')].filter((row) => !row.closest('.sky-below'));
  assert.equal(below.length + shown.length, 15);
  assert.ok(below.length > 0 && shown.length > 0);
  assert.ok(below.every((row) => /地平线下/.test(row.textContent)));
  assert.ok(shown.every((row) => !/地平线下/.test(row.children[1].textContent)));
  assert.equal(document.querySelector('.sky-below summary').textContent, `另有 ${below.length} 个在地平线下`);
  // The switch is a viewer preference: kept across reloads, not part of the shot.
  await settle(() => toggle().click());
  assert.equal(body().classList.contains('show-details'), true);
  assert.equal(dom.window.localStorage.getItem('tamatamatori.showDetails'), '1');
  await act(async () => { await delay(350); });
  assert.doesNotMatch(dom.window.localStorage.getItem('tamatamatori.session.v1'), /showDetails|详细/);
  await first.unmount();
  await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  assert.equal(toggle().checked, true);
  assert.equal(body().classList.contains('show-details'), true);
  await settle(() => toggle().click());
  assert.equal(dom.window.localStorage.getItem('tamatamatori.showDetails'), '0');
});

test('天气“自动匹配”在选项后标注拍摄时刻的云量来源，识别中、失败与其他模型分别处理', async t => {
  const base = Date.parse('2026-11-04T00:00:00Z') / 1000;
  const time = Array.from({ length: 48 }, (_, hour) => base + hour * 3600);
  const jma = time.map((_, hour) => (hour * 7) % 100), other = time.map((_, hour) => (hour * 13 + 5) % 100);
  let resolveSource;
  installGlobal('__testWeatherSourceLoader', () => new Promise((resolve) => { resolveSource = resolve; }));
  t.after(() => { delete globalThis.__testWeatherSourceLoader; });
  const { parseBestMatchSeries } = await server.ssrLoadModule('/src/domain/weather-source.ts');
  await workspace(t); await readyTerrain();
  const option = () => document.querySelector('[aria-label="天气预测模型"] option[value="best_match"]');
  assert.equal(option().textContent, '自动匹配', 'weather off: nothing to identify');
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => resolveSource);
  assert.equal(option().textContent, '自动匹配（识别来源中）');
  await act(async () => resolveSource(parseBestMatchSeries({ hourly: {
    time, cloud_cover_best_match: jma, cloud_cover_jma_seamless: jma, cloud_cover_gfs_seamless: other,
  } })));
  await settle();
  assert.equal(option().textContent, '自动匹配（日本气象厅 JMA）');
  await waitUntil(() => document.querySelector('[data-weather-phase="ready"]'));
  assert.match(document.querySelector('.weather-source').textContent, /自动匹配此刻的云量来自日本气象厅 JMA/);
  // A single global model needs no note; the auto option goes back to its plain name.
  await settle(() => setControl(document.querySelector('[aria-label="天气预测模型"]'), 'gfs_seamless'));
  assert.equal(option().textContent, '自动匹配');
  assert.doesNotMatch(document.querySelector('.weather-source')?.textContent ?? '', /云量来自/);
});

test('地图方位线：日月默认画出，随图层开关增减，银心跟随银河；图例只列出现的天体', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const features = () => map.getSource('tamatamatori-body-lines').data.features;
  const bodies = () => [...new Set(features().map((feature) => feature.properties.body))].sort();
  await waitUntil(() => features().length > 0);
  assert.deepEqual(bodies(), ['moon', 'sun']);
  const sunNow = features().find((feature) => feature.properties.body === 'sun' && feature.properties.kind === 'now');
  assert.equal(sunNow.properties.above, false, '17:00 in Tokyo: below the horizon, drawn dotted');
  assert.deepEqual(sunNow.geometry.coordinates[0], [value('经度'), value('纬度')]);
  assert.deepEqual([...document.querySelectorAll('.map-legend span:not(.map-legend-note)')].map((item) => item.textContent), ['太阳', '月亮']);
  // Each line is named at its end; the shooting direction too, its label outside the end whatever the map's rotation.
  const labels = () => map.getSource('tamatamatori-line-labels').data.features;
  const texts = () => labels().map((feature) => feature.properties.text);
  assert.ok(texts().includes('太阳 · 地平线下'), texts().join());
  assert.ok(texts().some((text) => /^月亮/.test(text)));
  assert.ok(texts().some((text) => /日落 \d\d:\d\d/.test(text)), texts().join());
  const aim = labels().find((feature) => feature.properties.text === '拍摄方向');
  assert.ok(aim);
  await settle(() => setControl(input('方位角'), 90));
  assert.equal(labels().find((feature) => feature.properties.text === '拍摄方向').properties.anchor, 'left', 'pointing east: the text to the right of the end');
  await settle(() => setControl(input('方位角'), 180));
  assert.equal(labels().find((feature) => feature.properties.text === '拍摄方向').properties.anchor, 'top');
  await settle(() => document.querySelector('[aria-label="显示月亮"]').click());
  assert.ok(!texts().some((text) => /月/.test(text)), 'labels follow the layers');
  assert.deepEqual(bodies(), ['sun']);
  await settle(() => document.querySelector('[aria-label="显示银河"]').click());
  assert.deepEqual(bodies(), ['core', 'sun']);
  assert.ok(features().some((feature) => feature.properties.body === 'core' && feature.properties.kind !== 'now'));
  assert.deepEqual([...document.querySelectorAll('.map-legend span:not(.map-legend-note)')].map((item) => item.textContent), ['太阳', '银心']);
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  await settle(() => document.querySelector('[aria-label="显示银河"]').click());
  assert.deepEqual(features(), []);
  assert.deepEqual(texts(), ['拍摄方向']);
  assert.equal(document.querySelector('.map-legend'), null);
});

test('地点搜索只在提交时查询，坐标直接定位不发请求；选中结果只移动地图，“设为机位”才改计划', async t => {
  const queries = [];
  installGlobal('__testPlaceSearch', async (query) => {
    queries.push(query);
    if (query === '无此地') return [];
    if (query === '出错') throw new Error('地点搜索失败（503）');
    return [{ name: '富士山', detail: '富士山, 静冈县, 日本', latitude: 35.3606, longitude: 138.7274, bounds: [35.35, 35.37, 138.71, 138.74] }];
  });
  t.after(() => { delete globalThis.__testPlaceSearch; });
  const { map } = await workspace(t); await readyTerrain();
  const before = { latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime() };
  await settle(() => document.querySelector('[aria-label="搜索地点"]').click());
  const field = () => document.querySelector('.map-search input[type="search"]');
  await settle(() => setControl(field(), '富士'));
  assert.deepEqual(queries, [], 'typing alone never searches');
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await waitUntil(() => document.querySelector('.map-search-results button'));
  assert.deepEqual(queries, ['富士']);
  assert.match(document.querySelector('.map-search-credit').textContent, /OpenStreetMap 贡献者.*Nominatim/);
  await settle(() => document.querySelector('.map-search-results button').click());
  assert.equal(document.querySelector('.map-search'), null);
  assert.match(document.querySelector('.map-target-card').textContent, /富士山/);
  assert.ok(map.transitions.some((move) => move.bounds), 'the map fits the place');
  assert.deepEqual({ latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime() }, before, 'browsing only');
  const target = TestMarker.instances.find((marker) => marker.getElement().classList.contains('map-target-marker'));
  assert.deepEqual(target.getLngLat(), { lng: 138.7274, lat: 35.3606 });
  await settle(() => document.querySelector('.map-target-apply').click());
  assert.equal(value('纬度'), 35.3606); assert.equal(value('经度'), 138.7274);
  assert.equal(document.querySelector('.map-target-card'), null);
  // Coordinates locate directly; empty results and failures are told apart.
  await settle(() => document.querySelector('[aria-label="搜索地点"]').click());
  await settle(() => setControl(field(), '48.8584, 2.2945'));
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(queries, ['富士']);
  assert.match(document.querySelector('.map-target-card').textContent, /坐标位置.*48\.85840, 2\.29450/);
  await settle(() => document.querySelector('[aria-label="移除地图标记"]').click());
  await settle(() => document.querySelector('[aria-label="搜索地点"]').click());
  await settle(() => setControl(field(), '无此地'));
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await waitUntil(() => /没有找到/.test(document.querySelector('.map-search-status')?.textContent ?? ''));
  await settle(() => setControl(field(), '出错'));
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await waitUntil(() => /503/.test(document.querySelector('.map-search-error')?.textContent ?? ''));
});

test('我的位置：成功时放置本机标记且不改计划，权限拒绝与不支持分别提示', async t => {
  const original = Object.getOwnPropertyDescriptor(dom.window.navigator, 'geolocation');
  let respond;
  Object.defineProperty(dom.window.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (success, failure) => { respond = { success, failure }; } },
  });
  t.after(() => {
    if (original) Object.defineProperty(dom.window.navigator, 'geolocation', original);
    else delete dom.window.navigator.geolocation;
  });
  await workspace(t); await readyTerrain();
  const before = { latitude: value('纬度'), longitude: value('经度') };
  const locate = () => document.querySelector('[aria-label="我的位置"]');
  await settle(() => locate().click());
  assert.equal(locate().disabled, true);
  assert.match(document.querySelector('.map-feedback').textContent, /正在获取当前位置/);
  await settle(() => respond.success({ coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 35 } }));
  assert.equal(locate().disabled, false);
  assert.match(document.querySelector('.map-target-card').textContent, /我的位置.*31\.23040, 121\.47370 · 精度约 35 m/);
  assert.ok(TestMarker.instances.find((marker) => marker.getElement().classList.contains('map-target-device')));
  assert.deepEqual({ latitude: value('纬度'), longitude: value('经度') }, before);
  await settle(() => locate().click());
  await settle(() => respond.failure({ code: 1 }));
  assert.match(document.querySelector('.map-feedback').textContent, /未获得定位权限/);
  Object.defineProperty(dom.window.navigator, 'geolocation', { configurable: true, value: undefined });
  await settle(() => locate().click());
  assert.match(document.querySelector('.map-feedback').textContent, /此浏览器不支持定位/);
});

test('时间轴标出黄金时刻与蓝调时刻：属于太阳图层，点击跳到起点，极夜时说明没有', async t => {
  await workspace(t); await readyTerrain();
  await setShootingDateTime('2026-11-04T12:00');
  const periods = () => [...document.querySelectorAll('.light-period')].map((item) => item.dataset.period);
  assert.deepEqual(periods(), ['blue', 'golden', 'golden', 'blue']);
  const evening = document.querySelectorAll('.light-period[data-period="golden"]')[1];
  assert.match(evening.getAttribute('aria-label'), /^跳到黄金时刻开始 16:11–17:03$/);
  assert.match(evening.title, /−4°—6°/);
  await settle(() => evening.click());
  assert.equal(shootingDateTime(), '2026-11-04T16:11');
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  assert.deepEqual(periods(), []);
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  await settle(() => setControl(input('纬度'), 78.2232));
  await settle(() => setControl(input('经度'), 15.6267));
  await chooseTimeZone('Arctic/Longyearbyen', 'Longyearbyen');
  await setShootingDateTime('2026-12-15T12:00');
  assert.deepEqual(periods(), []);
  assert.match(document.querySelector('.time-missing').textContent, /黄金时刻与蓝调时刻/);
});

test('自定义传感器：从当前尺寸开始，修改宽高即改变视场，切回预设恢复预设尺寸', async t => {
  await workspace(t); await readyTerrain();
  const sensor = document.querySelector('[aria-label="传感器"]');
  const horizontal = () => Number(document.querySelector('[aria-label^="取景辅助线"]').getAttribute('aria-label').match(/水平视场 ([\d.]+)/)[1]);
  const fullFrame = horizontal();
  assert.equal(document.querySelector('.custom-sensor'), null);
  await settle(() => setControl(sensor, 'custom'));
  assert.equal(value('传感器宽'), 36); assert.equal(value('传感器高'), 24);
  assert.equal(horizontal(), fullFrame);
  await settle(() => setControl(input('传感器宽'), 43.8));
  await settle(() => setControl(input('传感器高'), 32.9));
  assert.ok(horizontal() > fullFrame);
  assert.equal(horizontal().toFixed(1), (2 * Math.atan(43.8 / 70) * 180 / Math.PI).toFixed(1));
  await settle(() => setControl(input('传感器宽'), 0.5));
  assert.match(document.querySelector('.sensor-field .field-error').textContent, /1 至 100 mm/);
  await settle(() => setControl(sensor, 'aps-c'));
  assert.equal(document.querySelector('.custom-sensor'), null);
  assert.ok(horizontal() < fullFrame);
  await settle(() => setControl(sensor, 'custom'));
  assert.equal(value('传感器宽'), 43.8, 'the custom size is remembered while the page is open');
});

test('预览周围的行固定存在：云量条、黄金/蓝调行与状态行不随数据或图层出现消失，数据提示浮在画面上', async t => {
  await workspace(t); const map = await readyTerrain();
  const rows = () => ['.light-periods', '.cloud-strip', '.time-status', '.time-markers'].map((selector) => document.querySelectorAll(`.timeline ${selector}`).length);
  assert.deepEqual(rows(), [1, 1, 1, 1]);
  // Without weather the strip is an empty slot; with a forecast it is painted.
  assert.equal(document.querySelector('.cloud-strip').classList.contains('has-clouds'), false);
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => document.querySelector('.cloud-strip.has-clouds'));
  // Switching the model clears the forecast for a moment; the slot stays.
  weatherLoader = () => new Promise(() => {});
  await settle(() => setControl(document.querySelector('[aria-label="天气预测模型"]'), 'gfs_seamless'));
  assert.equal(document.querySelector('.cloud-strip.has-clouds'), null);
  assert.deepEqual(rows(), [1, 1, 1, 1]);
  // The Sun layer off leaves the golden/blue row empty but in place.
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  assert.equal(document.querySelectorAll('.light-period').length, 0);
  assert.deepEqual(rows(), [1, 1, 1, 1]);
  // Light-pollution and weather alerts sit over the frame, not above it.
  pollutionResponse = async () => { throw new Error('测试光污染失败'); };
  await settle(() => document.querySelector('[aria-label="当地光污染"]').click());
  await waitUntil(() => document.querySelector('.pollution-status'));
  assert.ok(document.querySelector('.pollution-status').closest('.viewfinder-wrap .preview-alerts'));
  assert.equal(document.querySelector('.preview-content > .pollution-status, .preview-content > .weather-status'), null);
  assert.equal(terrainMap(), map);
});

test('日食：太阳分组给出食况与食带位置，时间轴标出接触时刻，地图画出食带，预览信息条写出遮挡，跳转只改时间', async t => {
  const { map } = await workspace(t); await readyTerrain();
  await settle(() => setControl(input('纬度'), 25.687));
  await settle(() => setControl(input('经度'), 32.64));
  await chooseTimeZone('UTC');
  await setShootingDateTime('2027-08-02T10:05');
  const sun = () => document.querySelector('[data-eclipse="sun"]');
  assert.match(sun().textContent, /日全食中/);
  assert.match(sun().textContent, /本时段日全食/);
  assert.match(sun().textContent, /机位在全食带内/);
  assert.match(sun().textContent, /减光滤镜/);
  const contacts = () => [...document.querySelectorAll('.time-marker[data-event="solar-eclipse"]')]
    .map((marker) => marker.getAttribute('aria-label').replace(/^跳到/, '').split(' ')[0]);
  assert.deepEqual(contacts(), ['初亏', '食既', '食甚', '生光', '复圆']);
  assert.equal(document.querySelector('[data-eclipse-fact]').textContent, '日全食 · 天空按暮光近似');
  const kinds = () => map.getSource('tamatamatori-eclipse').data.features.map((feature) => feature.properties.kind);
  await waitUntil(() => kinds().length);
  assert.deepEqual(kinds(), ['band', 'centre', 'umbra']);
  assert.match(document.querySelector('[data-eclipse-legend]').textContent, /全食带/);
  // Outside the band: the nearest edge is to the south of Madrid.
  await settle(() => setControl(input('纬度'), 40.4));
  await settle(() => setControl(input('经度'), -3.7));
  assert.match(document.querySelector('[data-eclipse-path]').textContent, /离全食带约 \d+ km（(南|东南|西南)）/);
  // Jumping changes the time only.
  await setShootingDateTime('2027-08-02T06:00');
  assert.equal(document.querySelector('[data-eclipse-fact]'), null);
  await settle(() => document.querySelector('[aria-label="跳到日食食甚"]').click());
  assert.equal(shootingDateTime(), "2027-08-02T08:51");
  assert.equal(value('纬度'), 40.4);
  // The Sun layer owns all of it.
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  assert.deepEqual(contacts(), []);
  assert.equal(sun(), null);
  await waitUntil(() => !kinds().length);
});

test('月食与下次：月亮分组给出月偏食与接触时刻（不标半影始末），没有食时给出下次可见月食并可跳到食甚', async t => {
  await workspace(t); await readyTerrain();
  await settle(() => setControl(input('纬度'), 35.68));
  await settle(() => setControl(input('经度'), 139.77));
  await chooseTimeZone('Asia/Tokyo', 'Tokyo');
  await setShootingDateTime('2026-11-12T21:00');
  const moon = () => document.querySelector('[data-eclipse="moon"]');
  assert.match(moon().textContent, /下次可见月食：2028-07-07 月偏食/);
  assert.match(document.querySelector('[data-eclipse="sun"]').textContent, /下次本地可见：2030-06-01 日偏食/);
  assert.match(document.querySelector('[data-eclipse="sun"]').textContent, /下次日环食（全球）：2027-02-0[67]/);
  await settle(() => document.querySelector('[aria-label="跳到下次月食食甚"]').click());
  assert.equal(shootingDateTime(), '2028-07-07T03:19');
  assert.match(moon().textContent, /月偏食中/);
  assert.match(moon().textContent, /本时段月偏食/);
  assert.match(moon().textContent, /本影食分 0\.\d\d/);
  const contacts = [...document.querySelectorAll('.time-marker[data-event="lunar-eclipse"]')]
    .map((marker) => marker.getAttribute('aria-label').replace(/^跳到/, '').split(' ')[0]);
  assert.deepEqual(contacts, ['初亏', '食甚', '复圆']);
  assert.equal(document.querySelector('[data-eclipse-fact]').textContent, '月食 · 地影色为示意');
});

test('潮汐图层：读取最近海洋格点，右栏给出潮位与涨落，时间轴标高低潮，地图标格点；失败可重试，超出范围与无海洋格点分别说明', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const tides = await server.ssrLoadModule('/src/domain/tides.ts');
  const requests = [];
  const series = (span) => {
    const start = Date.parse(span.start) - 3 * 3_600_000;
    const heights = Array.from({ length: 30 }, (_, index) => Number((0.7 * Math.sin((2 * Math.PI * index) / 12.42)).toFixed(2)));
    return { fetchedAt: Date.now(), cell: { latitude: 35.29, longitude: 139.46, distance: 4.2 }, start, heights };
  };
  installGlobal('__testTideLoader', async (point, span) => { requests.push({ point, span }); return series(span); });
  t.after(() => { delete globalThis.__testTideLoader; });
  await setShootingDateTime('2026-11-12T10:00');
  await settle(() => document.querySelector('[aria-label="显示潮汐"]').click());
  await waitUntil(() => document.querySelector('.tide-now'));
  assert.equal(requests.length, 1);
  assert.match(document.querySelector('.tide-now').textContent, /^[+−]\d\.\d\d m · (涨潮中|落潮中)$/);
  assert.match(document.querySelector('.tide-readout').textContent, /下次高潮/);
  assert.match(document.querySelector('.tide-readout').textContent, /潮位格点距机位约 4 km/);
  assert.ok(document.querySelector('.tide-chart path.tide-curve').getAttribute('d').startsWith('M'));
  const marks = [...document.querySelectorAll('.time-marker[data-event^="tide-"]')].map((marker) => marker.dataset.event);
  assert.ok(marks.includes('tide-high') && marks.includes('tide-low'), marks.join());
  assert.match(document.querySelector('[data-tide-fact]').textContent, /^潮位 [+−]\d\.\d\d m · (涨潮|落潮)$/);
  await waitUntil(() => map.getSource('tamatamatori-environment')?.data.features.some((feature) => feature.properties.kind === 'tide-cell'));
  assert.ok(document.querySelector('[data-tide-legend]'));
  // A failed request offers a retry; out-of-range and no-sea answers are explained, not retried.
  installGlobal('__testTideLoader', async () => { throw new Error('潮位数据请求失败（500）'); });
  await setShootingDateTime('2026-11-13T10:00');
  await waitUntil(() => document.querySelector('.tide-status button'));
  assert.match(document.querySelector('.tide-status').textContent, /潮位数据请求失败（500）/);
  installGlobal('__testTideLoader', async () => { throw new tides.TideRangeError(); });
  await settle(() => document.querySelector('.tide-status button').click());
  await waitUntil(() => /超出潮位数据范围/.test(document.querySelector('.tide-status')?.textContent ?? ''));
  assert.equal(document.querySelector('.tide-status button'), null);
  installGlobal('__testTideLoader', async () => { throw new tides.NoSeaError(); });
  await setShootingDateTime('2026-11-14T10:00');
  await waitUntil(() => /没有海洋格点/.test(document.querySelector('.tide-status')?.textContent ?? ''));
  assert.equal(document.querySelectorAll('.time-marker[data-event^="tide-"]').length, 0);
  // Off: no markers, no fact, no map cell.
  await settle(() => document.querySelector('[aria-label="显示潮汐"]').click());
  assert.equal(document.querySelector('[data-tide-fact]'), null);
  await waitUntil(() => !map.getSource('tamatamatori-environment').data.features.length);
});

test('极光图层：按拍摄时刻选 Kp 口径，给出能否看到与方向，时间轴标出可能时段，地图画边界与可见线，并把时间轴改为夜间', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const start = Date.UTC(2026, 10, 10, 0);
  const kp = Array.from({ length: 40 }, (_, index) => ({ start: start + index * 3 * 3_600_000, end: start + (index + 1) * 3 * 3_600_000, kp: 6, kind: 'predicted' }));
  const outlook = [{ start: Date.UTC(2026, 10, 20), end: Date.UTC(2026, 10, 21), kp: 3, kind: 'outlook' }];
  installGlobal('__testKpLoader', async () => ({ kp, outlook, fetchedAt: Date.now() }));
  t.after(() => { delete globalThis.__testKpLoader; });
  await settle(() => setControl(input('纬度'), 55.95));
  await settle(() => setControl(input('经度'), -3.19));
  await chooseTimeZone('Europe/London', 'London');
  await setShootingDateTime('2026-11-11T23:00');
  await settle(() => document.querySelector('[aria-label="显示极光"]').click());
  await waitUntil(() => document.querySelector('.aurora-verdict'));
  assert.equal(document.querySelector('.timeline').dataset.mode, 'night');
  assert.match(document.querySelector('.aurora-source').textContent, /Kp 预报/);
  assert.match(document.querySelector('.aurora-verdict').textContent, /Kp 6 · 可能低悬北方天空，顶部约 \d+°/);
  assert.match(document.querySelector('.aurora-need').textContent, /本地需 Kp ≥/);
  assert.equal(document.querySelectorAll('.time-marker[data-event="aurora"]').length, 1);
  assert.match(document.querySelector('[data-aurora-fact]').textContent, /^极光 Kp 6 · 北方低空$/);
  await waitUntil(() => map.getSource('tamatamatori-environment')?.data.features.filter((feature) => /^aurora-(edge|view)$/.test(feature.properties.kind)).length === 4);
  assert.ok(document.querySelector('[data-aurora-legend]'));
  // Daytime: the verdict stays but the sky is too bright; no preview fact.
  await setShootingDateTime('2026-11-11T13:00');
  assert.match(document.querySelector('.aurora-dark').textContent, /天太亮/);
  assert.equal(document.querySelector('[data-aurora-fact]'), null);
  // Outlook days and beyond.
  await setShootingDateTime('2026-11-20T23:00');
  assert.match(document.querySelector('.aurora-source').textContent, /27 天展望/);
  await setShootingDateTime('2026-12-30T23:00');
  assert.match(document.querySelector('.aurora-status').textContent, /超出预报时效/);
  // Failure and retry.
  installGlobal('__testKpLoader', async () => { throw new Error('Kp 预报请求失败（503）'); });
  await settle(() => document.querySelector('[aria-label="显示极光"]').click());
  await settle(() => document.querySelector('[aria-label="显示极光"]').click());
  await waitUntil(() => document.querySelector('.aurora-status button'));
  installGlobal('__testKpLoader', async () => ({ kp, outlook, fetchedAt: Date.now() }));
  await setShootingDateTime('2026-11-11T23:00');
  await settle(() => document.querySelector('.aurora-status button').click());
  await waitUntil(() => document.querySelector('.aurora-verdict'));
});

test('Open-Meteo 用量：开启天气或潮汐时在光照与环境中显示本浏览器的近 24 小时用量，接近上限与限流分别提示', async t => {
  await workspace(t); await readyTerrain();
  const usage = await server.ssrLoadModule('/src/preview/api-usage.ts');
  const line = () => document.querySelector('.api-usage');
  assert.equal(line(), null);
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  assert.match(line().textContent, /^Open-Meteo 用量（本浏览器）：近 24 小时约 0 \/ 10,000 次/);
  assert.equal(line().dataset.usage, 'ok');
  const now = Date.now();
  await settle(() => usage.recordOpenMeteo(new Response('{}', { headers: { 'X-RateLimit-Cost': '1.2', 'X-RateLimit-Remaining': '590', 'X-RateLimit-Limit': '600', 'X-RateLimit-Reset': String(Math.floor(now / 1000) + 50), 'X-RateLimit-Window': '60' } }), 1, now));
  await settle(() => usage.recordOpenMeteo(new Response('{}'), 13, now));
  assert.match(line().textContent, /近 24 小时约 14\.2 \/ 10,000 次/);
  assert.match(line().querySelector('.info-detail').textContent, /近 1 小时 14\.2 \/ 5,000 · 近 1 分钟 14\.2 \/ 600 · 同一 IP 本分钟剩余 590 · 按访问者 IP 计数/);
  // Near the hourly limit, then rate-limited.
  await settle(() => usage.recordOpenMeteo(new Response('{}'), 4000, now));
  assert.equal(line().dataset.usage, 'near');
  assert.match(line().textContent, /接近免费上限/);
  await settle(() => usage.recordOpenMeteo(new Response('{}', { status: 429, headers: { 'Retry-After': '40' } }), 1, now));
  assert.equal(line().dataset.usage, 'limited');
  assert.match(line().textContent, /已限流，约 \d+ 秒后恢复/);
  // Still listed while weather is off, because calls were made today.
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  assert.ok(line());
});

// ---- 推算（构图约束搜索）: helpers shared by the tests below.
const panel = () => document.querySelector('.composition-panel');
const solvability = () => document.querySelector('.composition-solvability')?.textContent ?? '';
const resultStatus = () => document.querySelector('.alignment-results .alignment-status')?.textContent ?? '';
const dayRows = () => [...document.querySelectorAll('.composition-days > li')];
const rowItems = () => [...document.querySelectorAll('.composition-days .position-list li')];
const targetRow = (name) => [...document.querySelectorAll('.composition-target-list > li')].find((li) => li.querySelector('.composition-target-name strong').textContent === name);
const searchNow = () => settle(() => document.querySelector('.composition-search-button').click());
const searched = () => waitUntil(() => { const text = resultStatus(); return !!text && !/读取|推算中|准备/.test(text); });
const tokyoTime = () => Date.parse(`${document.querySelector('input[type="date"]').value}T${document.querySelector('input[type="time"]').value.padEnd(8, ':00').slice(0, 8)}+09:00`);
/** Where a direction lands in the current frame (normalised device coordinates). */
function placed(ray) {
  const view = { focalLength: value('焦距'), sensor: 'full-frame', aspectRatio: '3:2', orientation: document.querySelector('select[aria-label="拍摄画幅方向"]')?.value ?? 'landscape', azimuth: value('方位角'), pitch: value('俯仰角') };
  return projectDirection(view, ray);
}

test('推算·固定机位与朝向：加天体、固定机位与朝向后搜索，结果按天列出并标在时间轴；试看只改时刻与图层，返回推算前只恢复这两类字段；改动条件后结果标为过期', async t => {
  await workspace(t); await readyTerrain();
  const solveButton = () => document.querySelector('.solve-button');
  const sunSwitch = () => document.querySelector('[aria-label="显示太阳"]');
  const railTab = (name) => [...document.querySelectorAll('.rail-tabs [role="tab"]')].find((tab) => tab.textContent.trim() === name);
  assert.equal(panel(), null);
  const before = shootingDateTime();
  // The camera faces the summit of Fuji from the default shore, at 400 mm.
  await settle(() => setControl(input('方位角'), 244.63));
  await settle(() => setControl(input('俯仰角'), 10.74));
  await settle(() => setControl(input('焦距'), 400));
  await settle(() => solveButton().click());
  assert.equal(solveButton().getAttribute('aria-pressed'), 'true');
  assert.ok(panel());
  assert.equal(document.querySelector('.info-sidebar').getAttribute('aria-label'), '推算');
  assert.equal(document.querySelector('.info-body').hidden, true);
  assert.match(solvability(), /先加目标/);
  assert.equal(document.querySelector('.composition-search-button').disabled, true);
  // One body: any time works, unless the camera direction is fixed too.
  await settle(() => button('+ 天体').click());
  await settle(() => document.querySelector('.composition-editor input[value="sun"]').click());
  assert.match(targetRow('太阳').textContent, /天体 · 画面中心 · ±3%/);
  assert.match(solvability(), /只有一个天体/);
  await settle(() => setControl(document.querySelector('select[aria-label="机位范围"]'), 'fixed'));
  await settle(() => document.querySelector('.composition-range .composition-check input').click());
  assert.match(document.querySelector('.composition-range').textContent, /同时固定当前朝向（方位 244\.6°，俯仰 10\.7°）/);
  assert.match(solvability(), /机位与朝向固定：求太阳落到画面位置的时刻/);
  assert.ok(document.querySelector('[data-composition-marks] .alignment-mark-sun'), 'the Sun\'s place is drawn in the preview');
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 365));
  // An explicit search: two passes in the next 12 months.
  assert.equal(document.querySelector('.alignment-results'), null, 'nothing is searched before asking');
  await searchNow(); await searched();
  assert.match(resultStatus(), /12 个月内 2 天、2 段/);
  const days = dayRows().map((row) => row.querySelector('.composition-day-name strong').textContent);
  assert.match(days[0], /^2\/12 周五 16:2\d–16:2\d$/);
  assert.match(days[1], /^10\/30 .* 15:5\d–15:5\d$/);
  // Turn the Sun off; the try-out turns it on and only moves the instant.
  await settle(() => railTab('信息').click());
  await settle(() => sunSwitch().click());
  assert.equal(sunSwitch().checked, false);
  await settle(() => railTab('推算').click());
  await settle(() => dayRows()[0].querySelector('.composition-day > button[aria-label^="试看"]').click());
  assert.equal(shootingDateTime(), '2027-02-12T16:22');
  assert.equal(sunSwitch().checked, true);
  assert.equal(value('方位角'), 244.63);
  assert.equal(value('俯仰角'), 10.74);
  assert.ok(dayRows()[0].classList.contains('is-current'));
  assert.match(document.querySelector('.alignment-current').textContent, /正在试看 2\/12 周五 16:22/);
  const marker = document.querySelector('.time-marker[data-event="alignment"]');
  assert.ok(marker);
  // The Sun sits at the centre of the frame within the tolerance.
  const sun = skyAt('sun', tokyoTime(), value('纬度'), value('经度'), 'standard');
  const at = placed(direction(sun.azimuth, sun.elevation));
  assert.ok(Math.hypot(at.x * 1.5, at.y) / 2 < 0.03, `${at.x}, ${at.y}`);
  // The user's own edits survive "返回推算前"; the instant and the Sun switch go back.
  await settle(() => setControl(input('焦距'), 85));
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/, 'a new lens moves the places');
  await settle(() => button('返回推算前').click());
  assert.equal(shootingDateTime(), before);
  assert.equal(sunSwitch().checked, false);
  assert.equal(value('焦距'), 85);
  assert.equal([...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '返回推算前'), undefined, 'nothing left to return from');
  await settle(() => setControl(input('焦距'), 400));
  assert.doesNotMatch(document.querySelector('.composition-search').textContent, /条件已改/);
  // Nudging the Sun's mark changes the conditions: the results stay until searched again.
  await settle(() => document.querySelector('[data-composition-marks] .alignment-handle').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  assert.match(targetRow('太阳').textContent, /自左 50%、自上 49%/);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  assert.equal(dayRows().length, 2);
  // Leaving the mode removes the panel, the marks and the timeline instants.
  await settle(() => solveButton().click());
  assert.equal(panel(), null);
  assert.equal(document.querySelector('[data-composition-marks]'), null);
  assert.equal(document.querySelector('.time-marker[data-event="alignment"]'), null);
  assert.equal(document.querySelector('.info-body').hidden, false);
  assert.equal(document.querySelector('.rail-tabs'), null);
});

test('推算：可解性提示随目标、范围与筛选变化；高纬度冬季给出达不到的原因；窄屏进入模式时出现并选中“推算”标签，退出后移除', async t => {
  const listeners = new Set();
  const narrow = { matches: true, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  const original = window.matchMedia;
  window.matchMedia = (query) => query === '(max-width: 1099px)' ? narrow : { matches: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { window.matchMedia = original; });
  await workspace(t); await readyTerrain();
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(1, 1); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const layout = document.querySelector('.app-layout');
  const tabs = () => [...document.querySelectorAll('.mobile-tabs [role="tab"]')].map((tab) => tab.textContent.trim());
  await settle(() => setControl(input('纬度'), 69.65));
  await settle(() => setControl(input('经度'), 18.96));
  await settle(() => setControl(input('方位角'), 180));
  await settle(() => setControl(input('俯仰角'), 10));
  await setShootingDateTime('2026-11-25T12:00');
  await settle(() => document.querySelector('.solve-button').click());
  assert.deepEqual(tabs(), ['地图', '相机', '图层', '推算']);
  assert.equal(layout.dataset.mobileTab, 'solve');
  assert.equal(document.querySelector('.rail-tabs'), null, 'the bottom tabs choose the content on narrow screens');
  assert.equal(document.querySelector('.solve-body').hidden, false);
  // A ground point from the landmark list.
  await settle(() => button('+ 地面点').click());
  assert.match(document.querySelector('.composition-pending').textContent, /在地图上单击要拍的地方/);
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  assert.ok(targetRow('晴空塔'));
  assert.match(targetRow('晴空塔').textContent, /距地表 634 m · 自左 50%、自上 67%/);
  assert.match(solvability(), /只有一个地面点：任何机位都能对准它/);
  await settle(() => button('+ 天体').click());
  assert.ok(targetRow('月亮'));
  assert.match(targetRow('月亮').textContent, /自左 50%、自上 67%/, 'a new body starts on the ground point');
  assert.match(solvability(), /结果为机位线/);
  assert.doesNotMatch(solvability(), /另有/);
  // Up to four targets: the rest are checked minute by minute.
  await settle(() => button('+ 天体').click());
  assert.equal(document.querySelectorAll('.composition-target-list > li').length, 3);
  assert.match(solvability(), /结果为机位线.*另有 1 个目标按容差逐分钟检查/);
  assert.equal(document.querySelector('.composition-targets .alignment-hint'), null, 'no how-to once there are targets');
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-tower'));
  assert.match(targetRow('东京塔').textContent, /自左 30%、自上 78%/, 'a second ground point lower left');
  assert.match(solvability(), /另有 2 个目标/);
  assert.equal(button('+ 天体').disabled, true, 'four targets at most');
  assert.equal(button('+ 地面点').disabled, true);
  for (const target of [...document.querySelectorAll('.composition-target-list > li')].slice(2))
    await settle(() => target.querySelector('[aria-label^="删除目标"]').click());
  assert.equal(document.querySelectorAll('.composition-target-list > li').length, 2);
  await settle(() => setControl(document.querySelector('select[aria-label="时间范围"]'), 'instant'));
  assert.match(solvability(), /时刻固定：结果为机位点/);
  await settle(() => setControl(document.querySelector('select[aria-label="机位范围"]'), 'fixed'));
  assert.match(solvability(), /机位与时刻都已固定/);
  assert.equal(document.querySelector('.composition-search-button').disabled, true);
  await settle(() => setControl(document.querySelector('select[aria-label="时间范围"]'), 'range'));
  assert.match(solvability(), /机位固定：由“晴空塔”定朝向，求月亮经过画面位置的时刻/);
  await settle(() => document.querySelector('.composition-range .composition-check input').click());
  assert.match(solvability(), /固定朝向时，地面点在画面中的位置由朝向决定/);
  // A filter that contradicts a target is named.
  await settle(() => setControl(document.querySelector('select[aria-label="添加筛选"]'), 'moonDown'));
  assert.match(solvability(), /目标里有月亮，却要求“月亮在地平线下”/);
  await settle(() => document.querySelector('[aria-label="删除筛选 月亮在地平线下"]').click());
  // The Sun 10° high in the south from Tromsø, fixed camera and direction: never that high in late November.
  await settle(() => document.querySelector('[aria-label="删除目标 晴空塔"]').click());
  await settle(() => targetRow('月亮').querySelector('.composition-target-name').click());
  if (!targetRow('月亮').querySelector('.composition-editor')) await settle(() => targetRow('月亮').querySelector('.composition-target-name').click());
  await settle(() => targetRow('月亮').querySelector('input[value="sun"]').click());
  await settle(() => setControl(inputIn(targetRow('太阳'), '自上'), 50));
  assert.match(solvability(), /机位与朝向固定：求太阳落到画面位置的时刻/);
  await searchNow(); await searched();
  assert.match(resultStatus(), /太阳达不到画面位置对应的高度（10\.0°）/);
  await settle(() => [...document.querySelectorAll('.mobile-tabs [role="tab"]')].find((tab) => tab.textContent.trim() === '图层').click());
  assert.equal(document.querySelector('.solve-body').hidden, true);
  assert.equal(document.querySelector('.info-body').hidden, false);
  await settle(() => document.querySelector('.solve-button').click());
  assert.deepEqual(tabs(), ['地图', '相机', '图层']);
});

test('推算·地面点与天体（机位线）：地标与太阳各在画面位置，按天结果、地图与时间轴；试看让两者落在各自的位置，段内滑杆同时移动机位与时刻，返回推算前恢复；地图点选地面点与海拔', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const tiles = [];
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { tiles.push(points.length); progress?.(3, 3); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const features = () => map.getSource('tamatamatori-alignment').data.features;
  // Labels can fold into dots next to sunrise or sunset; the accessible name always names them.
  const markers = () => [...document.querySelectorAll('.time-marker[data-event="alignment"]')].map((marker) => marker.getAttribute('aria-label').replace(/^跳到(\S+) .*$/, '$1'));
  const before = { latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime(), azimuth: value('方位角'), pitch: value('俯仰角') };
  await settle(() => document.querySelector('.solve-button').click());
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  assert.equal(Number(inputIn(targetRow('晴空塔'), '距地表').value), 634);
  assert.ok(document.querySelector('.composition-ground-handle'), 'the ground point is drawn in the preview');
  // The Sun above the tower: the tower's top on the lower third line, the Sun at the centre.
  await settle(() => button('+ 天体').click());
  await settle(() => targetRow('月亮').querySelector('input[value="sun"]').click());
  await settle(() => setControl(inputIn(targetRow('太阳'), '自上'), 50));
  assert.match(targetRow('太阳').textContent, /画面中心/);
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await searchNow();
  await waitUntil(() => /当天 1 天、\d+ 段，共 \d+ 分钟/.test(resultStatus()));
  // The target's own ground first (for the altitude pre-filter), then the corridor once.
  assert.ok(tiles.length === 2 && tiles[0] === 1 && tiles[1] > 100, `the terrain corridor is read once before solving: ${tiles}`);
  assert.doesNotMatch(panel().textContent, /DEM|通视/);
  const kinds = new Set(features().map((feature) => feature.properties.kind));
  assert.ok(['target', 'ring', 'segment', 'label'].every((kind) => kinds.has(kind)), [...kinds].join());
  assert.ok(map.transitions.some((move) => move.bounds), 'the map fits the result');
  assert.match(document.querySelector('[data-alignment-legend]').textContent, /线上各点在标注时刻对齐/);
  assert.ok(markers().includes('对齐始') && markers().includes('对齐终'));
  // The Sun 6° above the top all day: daylight only, one stretch, listed at once.
  assert.equal(dayRows().length, 1);
  assert.ok(rowItems().length >= 1, 'one day: its stretches are listed at once');
  assert.match(rowItems()[0].textContent, /白天/);
  assert.match(rowItems()[0].textContent, /\d\d:\d\d–\d\d:\d\d.*目标在.+ · 距 [\d.]+—[\d.]+ km/);
  // A try-out puts the tower's top and the Sun at their places.
  await settle(() => rowItems()[0].querySelector('button').click());
  assert.ok(rowItems()[0].classList.contains('is-current'));
  assert.notEqual(shootingDateTime(), before.time);
  const top = toRay({ latitude: value('纬度'), longitude: value('经度'), ellipsoidalHeight: 1.6 }, { latitude: 35.71004508243534, longitude: 139.81071889400482, ellipsoidalHeight: 634 });
  const topAt = placed(top.ray);
  assert.ok(Math.abs(topAt.x) < 2e-3 && Math.abs(topAt.y - 1 / 3) < 2e-3, `top at ${topAt.x}, ${topAt.y}`);
  const sun = skyAt('sun', tokyoTime(), value('纬度'), value('经度'), 'standard');
  const sunAt = placed(direction(sun.azimuth, sun.elevation));
  assert.ok(Math.hypot(sunAt.x, sunAt.y) < 3e-3, `Sun at ${sunAt.x}, ${sunAt.y}`);
  assert.match(document.querySelector('.alignment-current').textContent, /正在试看 \d+\/\d+ .* \d\d:\d\d · 距地面目标 [\d.]+ km（目标在.+）/);
  assert.ok(document.querySelector('.position-profile svg'), 'profile from the camera to the top');
  assert.ok(features().some((feature) => feature.properties.kind === 'segment' && feature.properties.selected));
  const time = shootingDateTime();
  await settle(() => setControl(document.querySelector('input[aria-label="在这段内移动"]'), 0));
  assert.ok(shootingDateTime() < time, 'the slider moves back to the start of the stretch');
  assert.ok(rowItems()[0].classList.contains('is-current'));
  await settle(() => button('返回推算前').click());
  assert.deepEqual({ latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime(), azimuth: value('方位角'), pitch: value('俯仰角') }, before);
  // A ground point picked on the map: Escape cancels; the pick replaces the place.
  await settle(() => targetRow('晴空塔').querySelector('.composition-target-name').click());
  await settle(() => button('在地图上重新点选').click());
  assert.match(document.querySelector('.map-interaction-hint').textContent, /单击放置推算目标/);
  await settle(() => document.querySelector('.real-map').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(button('在地图上重新点选').getAttribute('aria-pressed'), 'false');
  await settle(() => button('在地图上重新点选').click());
  await settle(() => clickMap(map, 138.7274, 35.3606));
  assert.equal(value('纬度'), before.latitude, 'placing the target does not move the camera');
  assert.match(targetRow('地图上选的点').textContent, /距地表 634 m/);
  assert.match(document.querySelector('.composition-editor').textContent, /35\.36060, 138\.72740/);
  // A summit by its elevation: the foot has no meaning then.
  await settle(() => [...document.querySelectorAll('.composition-editor .alignment-aim label')].find((label) => label.textContent.includes('海拔')).querySelector('input').click());
  assert.equal(Number(inputIn(document.querySelector('.composition-editor'), '海拔').value), 3776);
  assert.match(targetRow('地图上选的点').textContent, /海拔 3776 m/);
  assert.equal(document.querySelector('.composition-editor .composition-check input').disabled, true);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  // Leaving the mode clears the map overlay and the timeline marks.
  await settle(() => document.querySelector('.solve-button').click());
  assert.equal(features().length, 0);
  assert.deepEqual(markers(), []);
});

test('推算·底部位置定主体大小：“月亮落在塔尖”模板，多日结果的主体占比在容差内，试看时塔底落在底部位置；拖动底部改变条件；矮目标不能设底部', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const loads = [];
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { loads.push(points.length); progress?.(2, 2); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const kinds = () => new Set(map.getSource('tamatamatori-alignment').data.features.map((feature) => feature.properties.kind));
  await settle(() => document.querySelector('.solve-button').click());
  await settle(() => button('月亮落在塔尖').click());
  assert.match(targetRow('晴空塔').textContent, /距地表 634 m · 自左 50%、自上 35% · ±3% · 主体约 35%/);
  assert.ok(targetRow('月亮'));
  assert.ok(document.querySelector('.composition-foot-handle'), 'the foot is drawn in the preview');
  assert.match(solvability(), /结果为机位线/);
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 7));
  await searchNow();
  await waitUntil(() => /7 天内 \d+ 天、\d+ 段/.test(resultStatus()));
  assert.equal(loads.filter((count) => count > 1).length, 1, 'the terrain corridor is read once for all days');
  assert.ok(['target', 'ring', 'sector', 'segment', 'label'].every((kind) => kinds().has(kind)), [...kinds()].join());
  assert.ok(dayRows().length >= 5);
  // Expand a day: every stretch keeps the tower's share within ±3% of 35%.
  await settle(() => dayRows()[0].querySelector('.composition-day-name').click());
  assert.ok(rowItems().length > 0);
  for (const row of rowItems()) {
    const share = row.textContent.match(/主体 (\d+)%—(\d+)%/);
    assert.ok(share && Number(share[1]) >= 31 && Number(share[2]) <= 39, row.textContent);
  }
  // A try-out puts the top at 35% and the foot near 70% of the frame height.
  await settle(() => rowItems()[0].querySelector('button').click());
  const eye = { latitude: value('纬度'), longitude: value('经度'), ellipsoidalHeight: 1.6 };
  const tower = { latitude: 35.71004508243534, longitude: 139.81071889400482 };
  const top = placed(toRay(eye, { ...tower, ellipsoidalHeight: 634 }).ray), foot = placed(toRay(eye, { ...tower, ellipsoidalHeight: 0 }).ray);
  assert.ok(Math.abs((top.y + 1) / 2 - 0.35) < 2e-3, `top ${top.y}`);
  assert.ok(Math.abs((foot.y + 1) / 2 - 0.7) <= 0.031, `foot ${foot.y}`);
  // Moving the foot down asks for a bigger tower: the results are stale.
  await settle(() => document.querySelector('.composition-foot-handle').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.match(targetRow('晴空塔').textContent, /主体约 36%/);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  // A low target has no size: the foot is switched off and cannot be set.
  await settle(() => targetRow('晴空塔').querySelector('.composition-target-name').click());
  await settle(() => setControl(inputIn(targetRow('晴空塔'), '距地表'), 5));
  assert.equal(targetRow('晴空塔').querySelector('.composition-check input').checked, false);
  assert.equal(targetRow('晴空塔').querySelector('.composition-check input').disabled, true);
  assert.equal(document.querySelector('.composition-foot-handle'), null);
});

test('推算·更多目标与星空可见性：第三个地面点随走廊读取地形并逐分钟检查，不在位置的分钟计数；星空可见性按机位读取光污染，没有数据的分钟单独计数', async t => {
  await workspace(t); await readyTerrain();
  const loads = [];
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { loads.push(points); progress?.(2, 2); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  await settle(() => document.querySelector('.solve-button').click());
  // The Moon on Skytree's top with Tokyo Tower lower left: one day.
  await settle(() => button('月亮落在塔尖').click());
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await setShootingDateTime('2026-11-25T12:00');
  await searchNow(); await searched();
  const alone = resultStatus().match(/共 (\d+) 分钟/);
  assert.ok(alone && Number(alone[1]) > 0, resultStatus());
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-tower'));
  assert.match(solvability(), /另有 1 个目标按容差逐分钟检查/);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  loads.length = 0;
  await searchNow(); await searched();
  assert.ok(loads.at(-1).some((point) => Math.abs(point.latitude - 35.6586) < 1e-3 && Math.abs(point.longitude - 139.7454) < 1e-3), 'the tower ground is read with the corridor');
  assert.match(resultStatus(), /\d+ 分钟其他目标不在位置/);
  assert.match(resultStatus(), /有 \d+ 分钟月亮与“晴空塔”对齐，但其他目标都不在设定位置/);

  // 星空可见性 on the deep-sky template: light pollution read per camera, missing data counted apart.
  await settle(() => button('深空天体在山顶上方').click());
  await settle(() => setControl(document.querySelector('.composition-range input[aria-label="起始日期"]'), '2026-12-10'));
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 7));
  await searchNow(); await searched();
  assert.match(resultStatus(), /7 天内 \d+ 天/, 'dark, moonless nights before the filter');
  await settle(() => setControl(document.querySelector('select[aria-label="添加筛选"]'), 'darkSky'));
  const limit = document.querySelector('select[aria-label="星空可见性"]');
  assert.equal(limit.value, '21.3');
  assert.deepEqual([...limit.options].map((option) => option.value), ['21.7', '21.3', '20.5', '19.5']);
  assert.match(limit.title, /只在天文夜（太阳低于 −18°）判断/, 'how it is computed, on hover');
  pollutionRequests.length = 0;
  const before = resultStatus().match(/共 (\d+) 分钟/)[1];
  // No data anywhere: every minute is counted apart, none listed.
  pollutionResponse = async () => null;
  await searchNow(); await searched();
  assert.ok(pollutionRequests.length > 0, 'light pollution is read');
  assert.ok(new Set(pollutionRequests.map((request) => `${request.point.latitude.toFixed(2)}/${request.point.longitude.toFixed(2)}`)).size === pollutionRequests.length, 'once per cell');
  assert.match(resultStatus(), new RegExp(`都不满足筛选条件（其中 ${before} 分钟缺少光污染数据）`));
  assert.match(resultStatus(), new RegExp(`，${before} 分钟缺少光污染数据）$`));
  // A dark site keeps them all.
  pollutionResponse = async () => ({ artificialMcd: 0.02 });
  await searchNow(); await searched();
  assert.match(resultStatus(), new RegExp(`共 ${before} 分钟`));
  // A night search: rows run from noon to noon, named after the evening.
  assert.match(dayRows()[0].querySelector('.composition-day-name strong').textContent, /^12\/10 周四夜 0\d:\d\d–0\d:\d\d$/);
  // A bright site fails it instead.
  pollutionResponse = async () => ({ artificialMcd: 6.5 });
  await settle(() => setControl(document.querySelector('select[aria-label="星空可见性"]'), '21.7'));
  await searchNow(); await searched();
  assert.doesNotMatch(resultStatus(), /缺少光污染数据/);
  assert.match(resultStatus(), /不满足筛选条件|不满足筛选/);
  await settle(() => document.querySelector('[aria-label="删除筛选 星空可见性"]').click());
  assert.equal(document.querySelector('select[aria-label="星空可见性"]'), null);
});

test('机位链接：打开带 #shot= 的地址先预览，应用后清除 hash 并可撤销；关闭预览不改计划', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const before = { focal: value('焦距'), azimuth: value('方位角') };
  const dialog = () => document.querySelector('.shot-dialog[open]');
  const hashOf = (shot) => shotLink(shot, 'http://localhost/').slice('http://localhost/'.length);
  await settle(() => { dom.window.location.hash = hashOf(shotFromPlan({ ...initialPlan, focalLength: 85, azimuth: 200 }, '链接机位')); });
  await waitUntil(() => dialog());
  assert.match(dialog().querySelector('h2').textContent, /导入机位/);
  assert.match(dialog().querySelector('.shot-summary').textContent, /方位 200\.0°.*85 mm/s);
  assert.equal(dialog().querySelector('[aria-label="导入机位名称"]').value, '链接机位');
  assert.equal(value('焦距'), before.focal, 'nothing changes before confirming');
  await settle(() => [...dialog().querySelectorAll('footer button')].find((b) => b.textContent === '仅应用').click());
  assert.equal(dialog(), null);
  assert.equal(dom.window.location.hash, '');
  assert.equal(value('焦距'), 85); assert.equal(value('方位角'), 200);
  assert.match(document.querySelector('.shot-toast').textContent, /已应用「链接机位」/);
  await settle(() => [...document.querySelectorAll('.shot-toast button')].find((b) => b.textContent === '撤销').click());
  assert.equal(value('焦距'), before.focal); assert.equal(value('方位角'), before.azimuth);
  // Closing the preview leaves the plan and still drops the hash; a broken link lists its problems.
  await settle(() => { dom.window.location.hash = hashOf(shotFromPlan({ ...initialPlan, focalLength: 50 }, '不应用')); });
  await waitUntil(() => dialog());
  await settle(() => dialog().querySelector('header button').click());
  assert.equal(dom.window.location.hash, ''); assert.equal(value('焦距'), before.focal);
  await settle(() => { dom.window.location.hash = 'shot=json:' + encodeURIComponent('{"format":"tamatamatori.shot","version":1}'); });
  await waitUntil(() => dialog());
  assert.match(dialog().querySelector('.shot-errors').textContent, /position：缺少该字段/);
  await settle(() => dialog().querySelector('header button').click());
  assert.equal(dom.window.location.hash, '');
});

const fujiRequest = { format: 'tamatamatori.solve', version: 2, name: '富士山顶夕阳', lens: { focalLength: 400, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
  targets: [{ type: 'body', body: 'sun' }], camera: { mode: 'fixed', aim: { azimuth: 244.63, pitch: 10.74 } }, time: { mode: 'range', date: '2026-11-04', days: 365 }, timeZone: 'Asia/Tokyo' };
async function openSolveLink(value) {
  await settle(() => { dom.window.location.hash = `solve=json:${encodeURIComponent(JSON.stringify(value))}`; });
  await waitUntil(() => document.querySelector('.solve-dialog')?.open);
  return document.querySelector('.solve-dialog');
}

test('推算·机位最近距离：新建条件缺省 2 km，钻石富士模板 10 km 且不加筛选；结果都在最近距离之外，地图画出内圈', async t => {
  const { map } = await workspace(t); await readyTerrain();
  // A 3000 m cone on flat ground at Fuji's summit.
  const cone = (latitude, longitude) => Math.max(0, 3000 - 0.3 * Math.hypot((latitude - 35.3606) * 111000, (longitude - 138.7274) * 111000 * Math.cos(35.36 * Math.PI / 180)));
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(1, 1); return cone; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  await settle(() => document.querySelector('.solve-button').click());
  const nearest = () => document.querySelector('select[aria-label="机位最近距离"]');
  assert.equal(nearest().value, '2000');
  assert.deepEqual([...nearest().options].map((option) => option.textContent), ['不限', '1 km', '2 km', '5 km', '10 km']);
  await settle(() => setControl(document.querySelector('select[aria-label="机位最远距离"]'), 10000));
  assert.deepEqual([...nearest().options].map((option) => option.value), ['200', '1000', '2000', '5000'], 'nearer than the farthest');
  await settle(() => button('钻石富士').click());
  assert.equal(nearest().value, '10000');
  assert.equal(document.querySelector('select[aria-label="机位最远距离"]').value, '30000');
  assert.equal(document.querySelectorAll('.composition-filters .composition-remove').length, 0, 'no golden-hour filter');
  await settle(() => setControl(document.querySelector('.composition-range input[aria-label="起始日期"]'), '2026-11-25'));
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await searchNow(); await searched();
  assert.match(resultStatus(), /当天 1 天、\d+ 段/);
  await settle(() => dayRows()[0]?.querySelector('.composition-day-name')?.click());
  for (const row of rowItems()) {
    const range = row.textContent.match(/距 ([\d.]+)(?:—([\d.]+))? km/);
    assert.ok(range && Number(range[1]) >= 10, row.textContent);
  }
  const rings = map.getSource('tamatamatori-alignment').data.features.filter((feature) => feature.properties.kind === 'ring');
  assert.equal(rings.length, 2, 'the farthest and the nearest');
});

test('推算请求链接：先预览镜头、目标、范围与将改动的字段，取消不改计划；确认后载入条件并自动搜索，撤销恢复计划与模式；复制推算请求与结果；版本 1 转换；报错', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  t.after(() => { delete dom.window.navigator.clipboard; });
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(3, 3); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const before = { azimuth: value('方位角'), pitch: value('俯仰角'), time: shootingDateTime(), focal: value('焦距') };
  let dialog = await openSolveLink(fujiRequest);
  assert.match(dialog.querySelector('.shot-summary').textContent,
    /富士山顶夕阳.*镜头400 mm · 全画幅 · 3:2 横幅.*目标 1太阳 · 画面中心 · 容差 ±3%.*机位固定为当前机位，朝向固定（方位 244\.63°，俯仰 10\.74°）.*2026-11-04 起 12 个月.*Asia\/Tokyo.*筛选无/s);
  assert.match(dialog.querySelector('.solve-changes').textContent, /镜头：400 mm · 3:2 横幅.*方向：固定为请求中的朝向（方位 244\.63°，俯仰 10\.74°）.*时区：固定为 Asia\/Tokyo（不再随机位）/s);
  await settle(() => button('取消').click());
  assert.equal(dialog.open, false); assert.equal(dom.window.location.hash, '');
  assert.equal(value('方位角'), before.azimuth); assert.equal(value('焦距'), before.focal); assert.equal(panel(), null);
  // Confirming loads the conditions, applies the lens and direction, and searches at once.
  dialog = await openSolveLink(fujiRequest);
  await settle(() => button('载入并推算').click());
  assert.equal(dom.window.location.hash, '');
  assert.equal(document.querySelector('.solve-button').getAttribute('aria-pressed'), 'true');
  assert.equal(value('焦距'), 400); assert.equal(value('方位角'), 244.63); assert.equal(value('俯仰角'), 10.74);
  assert.ok(targetRow('太阳'));
  assert.equal(document.querySelector('select[aria-label="机位范围"]').value, 'fixed');
  assert.equal(document.querySelector('.composition-range .composition-check input').checked, true);
  assert.equal(document.querySelector('input[aria-label="起始日期"]').value, '2026-11-04');
  assert.match(document.querySelector('.shot-toast').textContent, /已载入推算请求「富士山顶夕阳」/);
  await searched();
  assert.equal(dayRows().length, 2);
  // "复制推算请求" writes a self-contained version 2 link; "复制结果" a Markdown table.
  await settle(() => button('复制推算请求').click());
  await waitUntil(() => copied.length === 1);
  assert.ok(copied[0].startsWith('http://localhost/#solve=json:'));
  const back = parseSolveText2(copied[0], initialPlan);
  assert.equal(back.ok, true);
  assert.equal(back.request.version, 2);
  assert.deepEqual(back.request.lens, fujiRequest.lens);
  assert.deepEqual(back.request.targets, [{ type: 'body', body: 'sun', frame: { x: 0.5, y: 0.5 }, tolerance: 0.03 }]);
  assert.deepEqual(back.request.camera, { mode: 'fixed', latitude: value('纬度'), longitude: value('经度'), aim: { azimuth: 244.63, pitch: 10.74 }, heightAboveGround: value('离地高度') });
  assert.deepEqual(back.request.time, fujiRequest.time);
  await settle(() => button('复制结果').click());
  await waitUntil(() => copied.length === 2);
  assert.match(copied[1], /^## Tamatamatori 推算结果/);
  assert.match(copied[1], /\| 2027-02-12 \| 16:2\d–16:2\d \|[\s\S]*\| 2027-10-30 \| 15:5\d–15:5\d \|/);
  assert.match(document.querySelector('.alignment-copied').textContent, /已复制结果/);
  // Undo restores the plan and leaves the mode it entered.
  await settle(() => [...document.querySelectorAll('.shot-toast button')].find((b) => b.textContent === '撤销').click());
  assert.equal(value('方位角'), before.azimuth); assert.equal(value('俯仰角'), before.pitch); assert.equal(value('焦距'), before.focal);
  assert.equal(document.querySelector('.solve-button').getAttribute('aria-pressed'), 'false');
  assert.equal(panel(), null);
  // A version 1 request (找机位) is converted: the landmark and the Sun at the centre, one day, the shooting date moved.
  dialog = await openSolveLink({ format: 'tamatamatori.solve', version: 1, kind: 'position', body: 'sun', target: { landmark: 'tokyo-skytree' }, date: '2026-12-21', maxDistance: 20000 });
  assert.match(dialog.querySelector('.shot-preview').textContent, /旧版（v1）请求，已按当前镜头转换/);
  assert.match(dialog.querySelector('.shot-summary').textContent, /晴空塔 · 35\.71005, 139\.81072 · 距地表 634 m · 画面中心 · 容差 ±3% · 已接入地标（tokyo-skytree）.*太阳 · 画面中心.*不限，离地面目标最远 20 km.*2026-12-21 当天/s);
  assert.match(dialog.querySelector('.solve-changes').textContent, /拍摄时刻：2026-11-04 17:00（Asia\/Tokyo） → 2026-12-21 17:00（Asia\/Tokyo）/);
  await settle(() => button('载入并推算').click());
  assert.ok(targetRow('晴空塔') && targetRow('太阳'));
  assert.equal(document.querySelector('select[aria-label="机位最远距离"]').value, '20000');
  assert.equal(document.querySelector('select[aria-label="跨度"]').value, '1');
  assert.equal(shootingDateTime(), '2026-12-21T17:00');
  await searched();
  assert.match(resultStatus(), /当天 1 天、\d+ 段/);
  // A broken request lists its problems with their paths and cannot be loaded.
  dialog = await openSolveLink({ ...fujiRequest, targets: [{ type: 'body', body: 'sun', frame: { x: 1.5 } }], camera: { mode: 'orbit' } });
  assert.match(dialog.querySelector('.shot-errors').textContent, /targets\[0\]\.frame\.x：应在 0～1 之间，收到 1\.5[\s\S]*targets\[0\]\.frame\.y：应为数字[\s\S]*camera\.mode：应为 "free" \/ "near" \/ "fixed" 之一/);
  assert.equal(button('载入并推算').disabled, true);
  await settle(() => button('取消').click());
  assert.equal(dom.window.location.hash, '');
});

test('推算结果落地：试看后一键存为机位并成为当前机位，机位面板同步；导出日历每个结果一个事件，链接打开同一试看', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const blobs = [], downloads = [];
  const { createObjectURL, revokeObjectURL } = URL, click = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.href }); };
  t.after(() => { URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; dom.window.HTMLAnchorElement.prototype.click = click; });
  await openSolveLink(fujiRequest);
  await settle(() => button('载入并推算').click());
  await searched();
  assert.equal(dayRows().length, 2);
  const status = () => document.querySelector('.alignment-copied').textContent;
  assert.match(document.querySelector('.alignment-export h3').textContent, /保存与导出/);
  assert.equal(button('存为机位').disabled, true, 'nothing tried out yet');
  assert.equal(button('存为机位').title, '先试看一个结果');
  assert.equal(document.querySelector('.alignment-export .alignment-hint'), null, 'the buttons carry their own notes');
  // Try the first one and keep it.
  await settle(() => dayRows()[0].querySelector('.composition-day > button[aria-label^="试看"]').click());
  assert.equal(shootingDateTime(), '2027-02-12T16:22');
  assert.equal(button('存为机位').disabled, false);
  await settle(() => button('存为机位').click());
  const name = '35.417°N 138.873°E · 太阳 02-12 16:22';
  assert.match(status(), new RegExp(`已存为机位「${name}」`));
  assert.equal(savedShots().length, 1);
  assert.equal(savedShots()[0].shot.name, name);
  assert.equal(savedShots()[0].shot.time.instant.slice(0, 16), '2027-02-12T07:22');
  assert.equal(savedShots()[0].shot.layers.sun, true);
  assert.equal(savedShots()[0].shot.camera.focalLength, 400);
  assert.equal(shotButton().textContent.trim(), name, 'it becomes the current shot');
  await openShots();
  assert.ok([...document.querySelectorAll('.shot-list .shot-apply strong')].some((item) => item.textContent.includes(name)), 'the shot menu sees it at once');
  await settle(() => shotButton().click());
  // The calendar: both results, in UTC, each with a link to its try-out.
  await settle(() => button('导出日历').click());
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'tamatamatori-solve-20261104.ics');
  const text = await blobs[0].text();
  assert.equal(blobs[0].type, 'text/calendar;charset=utf-8');
  const unfolded = text.replace(/\r\n /g, '').split('\r\n');
  assert.equal(unfolded.filter((line) => line === 'BEGIN:VEVENT').length, 2);
  assert.ok(unfolded.some((line) => line.startsWith('DTSTART:20270212T0722')), unfolded.filter((line) => line.startsWith('DTSTART')).join());
  assert.ok(unfolded.some((line) => line.startsWith('DTSTART:20271030T065')));
  assert.ok(unfolded.includes('SUMMARY:太阳 · 35.417°N 138.873°E'));
  const link = unfolded.find((line) => line.startsWith('URL:')).slice(4);
  assert.ok(link.startsWith('http://localhost/#shot=tmt1:'));
  assert.equal(parseShotText(link).plan.instant.slice(0, 16), '2027-02-12T07:22');
  assert.match(status(), /已导出 2 个事件/);
});

test('检查机位：按需读取水体与建筑，每段的试看机位标出水面与建筑遮挡并汇总；机位或离地高度改变后清空；失败可重试', async t => {
  await workspace(t); await readyTerrain();
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(2, 2); return () => 0; });
  const requests = [];
  // Water around the first listed position; a 500 m building 250 m along the second one's sight line.
  const around = (point, size) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([east, north]) => travel(travel(point, 90, east * size / 2), 0, north * size / 2));
  installGlobal('__testFeatures', async (points, url, signal, progress) => {
    requests.push(points.length);
    progress?.(3, 3);
    return { features: { water: [{ rings: [around(points[0], 60)] }], buildings: [{ rings: [around(points[10], 40)], height: 500, base: 0 }] }, tiles: 3, fetched: 3 };
  });
  t.after(() => { delete globalThis.__testElevationTiles; delete globalThis.__testFeatures; });
  await settle(() => document.querySelector('.solve-button').click());
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  await settle(() => button('+ 天体').click());
  await settle(() => targetRow('月亮').querySelector('input[value="sun"]').click());
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await searchNow(); await searched();
  assert.ok(rowItems().length >= 2);
  assert.equal(document.querySelectorAll('.feasibility-tag').length, 0, 'nothing is read before asking');
  assert.equal(requests.length, 0);
  await settle(() => button('检查机位（水面、建筑）').click());
  await waitUntil(() => document.querySelector('.feasibility-summary'));
  assert.equal(requests.length, 1);
  const listed = rowItems().length, checked = listed;
  assert.equal(requests[0], 9 * checked, 'the camera and eight points along each sight line');
  const tags = rowItems().map((row) => row.querySelector('.feasibility-tag')?.textContent ?? '');
  assert.match(tags[0], /^机位在水面 · 2 km 内无建筑遮挡$/);
  assert.ok(rowItems()[0].querySelector('.feasibility-tag').classList.contains('is-problem'));
  assert.match(tags[1], /^2\d\d m 处建筑高出视线 \d+ m$/);
  assert.ok(tags.slice(2).every((tag) => tag === '2 km 内无建筑遮挡'));
  assert.match(document.querySelector('.feasibility-summary').textContent,
    new RegExp(`检查了 ${checked}/${listed} 个机位：水面 1、建筑轮廓内 0、2 km 内被建筑挡住 1、未发现问题 ${checked - 2}。读取 3 块矢量瓦片（新下载 3 块）。$`));
  // Moving a mark marks the search stale but leaves the listed positions and their tags.
  await settle(() => document.querySelector('[data-composition-marks] .alignment-handle').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  assert.ok(document.querySelector('.feasibility-summary'));
  // A higher camera moves every position: the old tags go at once.
  await settle(() => setControl(input('离地高度'), 20));
  assert.equal(document.querySelector('.feasibility-summary'), null);
  assert.equal(document.querySelectorAll('.feasibility-tag').length, 0);
  // A failure says so and can be retried.
  installGlobal('__testFeatures', async () => { throw new Error('矢量瓦片请求失败（503）'); });
  await settle(() => button('检查机位（水面、建筑）').click());
  await waitUntil(() => /检查失败：矢量瓦片请求失败（503）/.test(document.querySelector('.feasibility .field-error')?.textContent ?? ''));
  assert.ok(button('重试检查'));
});

test('天体目标：银心在固定机位与朝向下只在天暗时给出结果，试看开启银河、返回推算前关闭；两个天体按相对位置求时刻；恒星与深空从列表选择', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const at = Date.parse('2026-08-15T12:00:00Z'); // 21:00 in Tokyo
  const centre = skyAt('galactic-center', at, 35.4172, 138.8729, 'standard');
  await openSolveLink({ format: 'tamatamatori.solve', version: 2, targets: [{ type: 'body', body: 'galactic-center', tolerance: 0.01 }],
    camera: { mode: 'fixed', aim: { azimuth: Math.round(centre.azimuth * 1000) / 1000, pitch: Math.round(centre.elevation * 1000) / 1000 } },
    time: { mode: 'range', date: '2026-08-10', days: 30 }, timeZone: 'Asia/Tokyo' });
  assert.match(document.querySelector('.solve-dialog .shot-summary').textContent, /目标 1银心 · 画面中心 · 容差 ±1%/);
  await settle(() => button('载入并推算').click());
  await searched();
  assert.ok(targetRow('银心'));
  // A fixed body: a night search, its rows named after the evening.
  const august15 = dayRows().find((row) => /^8\/15 周六夜 (20:5\d|21:0\d)–21:0\d$/.test(row.querySelector('.composition-day-name strong').textContent));
  assert.ok(august15, dayRows().map((row) => row.textContent).join(' | '));
  assert.ok(dayRows().every((row) => /暮光|暗夜/.test(row.textContent)), 'only dark skies');
  const milkyWay = () => document.querySelector('[aria-label="显示银河"]');
  assert.equal(milkyWay().checked, false);
  await settle(() => august15.querySelector('.composition-day > button[aria-label^="试看"]').click());
  assert.equal(milkyWay().checked, true, 'the try-out shows the Milky Way');
  assert.ok(document.querySelector('[data-composition-marks] .alignment-mark-core'));
  await settle(() => button('返回推算前').click());
  assert.equal(milkyWay().checked, false);
  // Two bodies: the Pleiades upper right, the Moon lower left, wherever the camera stands.
  await openSolveLink({ format: 'tamatamatori.solve', version: 2, lens: { focalLength: 135, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
    targets: [{ type: 'body', body: 'dso-mel022', frame: { x: 0.6, y: 0.4 } }, { type: 'body', body: 'moon', frame: { x: 0.4, y: 0.6 }, tolerance: 0.05 }],
    time: { mode: 'range', date: '2026-11-13', days: 365 }, timeZone: 'Asia/Tokyo' });
  assert.match(document.querySelector('.solve-dialog .shot-summary').textContent, /只有天体时与机位基本无关/);
  await settle(() => button('载入并推算').click());
  assert.match(solvability(), /结果为时刻：天体在画面中的相对位置与机位基本无关（月亮略有视差）/);
  await searched();
  assert.ok(dayRows().length >= 1, resultStatus());
  await settle(() => dayRows()[0].querySelector('.composition-day > button[aria-label^="试看"]').click());
  const time = tokyoTime();
  const pleiades = skyAt('dso-mel022', time, value('纬度'), value('经度'), 'standard'), moon = skyAt('moon', time, value('纬度'), value('经度'), 'standard');
  const first = placed(direction(pleiades.azimuth, pleiades.elevation)), second = placed(direction(moon.azimuth, moon.elevation));
  assert.ok(Math.abs(first.x - 0.2) < 2e-3 && Math.abs(first.y + 0.2) < 2e-3, `Pleiades at ${first.x}, ${first.y}`);
  assert.ok(Math.hypot(((second.x + 0.2) / 2) * 1.5, (second.y - 0.2) / 2) <= 0.05, `Moon at ${second.x}, ${second.y}`);
  // The list of fixed bodies: deep-sky targets first, then the named stars.
  await settle(() => targetRow('昴星团').querySelector('.composition-target-name').click());
  const select = () => targetRow('昴星团')?.querySelector('select[aria-label="恒星或深空目标"]') ?? document.querySelector('select[aria-label="恒星或深空目标"]');
  assert.deepEqual([...select().querySelectorAll('optgroup')].map((group) => [group.label, group.children.length]), [['深空目标', 15], ['亮星', 90]]);
  await settle(() => setControl(select(), 'hyg-90979'));
  assert.ok(targetRow('织女星'));
  assert.ok(document.querySelector('[data-composition-marks] .alignment-mark-star'));
  assert.match(document.querySelector('[data-composition-marks] .alignment-mark-star .alignment-handle').getAttribute('aria-label'), /^织女星在画面中的位置/);
  await settle(() => targetRow('织女星').querySelector('input[value="moon"]').click());
  assert.equal(document.querySelector('select[aria-label="恒星或深空目标"]'), null);
});

