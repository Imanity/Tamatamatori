// Shared setup for the workspace interaction tests (tests/ui/*.test.mjs):
// the map SDK and GPU layer doubles, jsdom globals, a Vite SSR server that
// loads the real App, and helpers to drive it.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { skyReference } from "../../src/domain/starfield.ts";
import { constellationScene } from "../../src/domain/constellations.ts";
import { deepSkyScene } from "../../src/domain/deep-sky.ts";
import { weatherResponse } from "../fixtures/weather.mjs";
import { parseWeather } from "../../src/domain/weather.ts";
import { projectDirection } from "../../src/domain/celestial-projection.ts";
import { activeShowers } from "../../src/domain/meteor-showers.ts";

// Exercise real React handlers and state with an SDK test double; no WebGL is
// simulated, and these checks do not claim browser rendering verification.
export class Events {
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

export class TestMap extends Events {
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
export class TestCelestialLayer {
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

export class TestStarfieldLayer {
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

export class TestBuildingLayer {
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

export class TestMarker extends Events {
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

export let server, App, createRoot, dom;
export let sequence = 0;
// Loaders a test may replace (stubs.weatherLoader = …).
export const stubs = { groundResponse: undefined, pollutionResponse: undefined, weatherLoader: undefined };
export const weatherRequests = [];
export const pollutionRequests = [];
export const terrainSize = { width: 600, height: 400 };
export const resizeObservers = [];
export const groundRequests = [];
export const frames = new Map();
export const nativeCapture = new WeakMap();
export const originalGlobals = new Map();

export function installGlobal(name, value) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

before(async () => {
  installGlobal("__testWeatherLoader", (point, signal, now, model) => { weatherRequests.push({ point, signal, model }); return stubs.weatherLoader(point, signal, now, model); });
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
    return stubs.pollutionResponse(point, signal);
  });
  installGlobal("__testGroundLoader", (point, _url, signal) => {
    groundRequests.push({ point, signal });
    return stubs.groundResponse(point, signal);
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

export async function settle(action = () => {}) {
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

export async function waitForMap() {
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

export async function workspace(
  t,
  elevation = async () => ({ height: 1000, zoom: 12 }),
  { keepStorage = false } = {},
) {
  stubs.groundResponse = elevation;
  pollutionRequests.length = 0;
  weatherRequests.length = 0;
  stubs.weatherLoader = async () => parseWeather(weatherResponse(), Date.now());
  stubs.pollutionResponse = async () => ({ artificialMcd: 6.5 });
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

export function input(label) {
  return inputIn(document, label);
}
/** A labelled input inside one part of the page (the same label may appear elsewhere). */
export function inputIn(root, label) {
  const field = [...root.querySelectorAll("label")].find(
    (element) =>
      element.querySelector(".field-label")?.textContent.trim() === label,
  );
  assert.ok(field, `missing input ${label}`);
  return field.querySelector("input");
}
export async function chooseTimeZone(zone, query = zone) {
  await settle(() => document.querySelector(".timezone-trigger").click());
  await settle(() => setControl(document.querySelector('[aria-label="搜索时区"]'), query));
  await settle(() => document.querySelector(`.timezone-list [data-zone="${zone}"]`).click());
}
export function shootingDateTime() {
  return `${document.querySelector('input[type="date"]').value}T${document.querySelector('input[type="time"]').value.slice(0, 5)}`;
}
export async function setShootingDateTime(local) {
  await settle(() => setControl(document.querySelector('input[type="date"]'), local.slice(0, 10)));
  await settle(() => setControl(document.querySelector('input[type="time"]'), local.slice(11)));
}
export function value(label) {
  return Number(input(label).value);
}
export function button(label) {
  const match = [...document.querySelectorAll("button")].find(
    (element) => element.textContent.trim() === label,
  );
  assert.ok(match, `missing button ${label}`);
  return match;
}
export function clickMap(map, lng, lat) {
  map.emit("click", {
    lngLat: { lng, lat },
    originalEvent: { target: map.options.container },
  });
}
export function setControl(element, value) {
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
export function camera() {
  return TestMarker.instances.find(
    (marker) => marker.getElement().className === "camera-position-marker",
  );
}
export function heading() {
  return TestMarker.instances.find(
    (marker) => marker.getElement().className === "camera-direction-marker",
  );
}
export function geometry(map) {
  return map.getSource("tamatamatori-view").data;
}

export async function waitUntil(predicate) {
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
export function terrainMap() {
  return TestMap.instances
    .filter((map) => !map.removed && typeof map.options.style === "object")
    .at(-1);
}
export async function readyTerrain() {
  return waitUntil(() => {
    const map = terrainMap();
    return map?.cameraSolutions.length &&
      document.querySelector(".terrain-canvas")?.dataset.ready === "true"
      ? map
      : null;
  });
}

export const shotButton = () => document.querySelector('.shot-button');
export const panelButton = (text) => [...document.querySelectorAll('.shot-panel button')].find((b) => b.textContent.trim() === text);
export const openShots = async () => { if (!document.querySelector('.shot-panel')) await settle(() => shotButton().click()); };
export async function saveShotAs(name) {
  await openShots();
  await settle(() => (panelButton('保存为机位') ?? panelButton('另存为新机位')).click());
  await settle(() => setControl(document.querySelector('[aria-label="机位名称"]'), name));
  await settle(() => panelButton('保存').click());
}
export const savedShots = () => JSON.parse(dom.window.localStorage.getItem('tamatamatori.shots.v1') ?? '{"shots":[]}').shots;
export const keydown = (element, key) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));

export const publishedComets = JSON.parse(readFileSync(new URL('../../public/comets/catalog.json', import.meta.url), 'utf8'));
/** The published catalogue with update times relative to the real clock, as the browser would see it. */
export function cometCatalogAt(hoursAgo, extra = {}) {
  const stamp = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  return { ...publishedComets, fetchedAt: stamp(hoursAgo), attemptedAt: stamp(extra.attemptedHoursAgo ?? hoursAgo), ...extra.fields };
}

// ---- 推算（构图约束搜索）: helpers shared by the tests below.
export const panel = () => document.querySelector('.composition-panel');
export const solvability = () => document.querySelector('.composition-solvability')?.textContent ?? '';
export const resultStatus = () => document.querySelector('.alignment-results .alignment-status')?.textContent ?? '';
export const dayRows = () => [...document.querySelectorAll('.composition-days > li')];
export const rowItems = () => [...document.querySelectorAll('.composition-days .position-list li')];
export const targetRow = (name) => [...document.querySelectorAll('.composition-target-list > li')].find((li) => li.querySelector('.composition-target-name strong').textContent === name);
export const searchNow = () => settle(() => document.querySelector('.composition-search-button').click());
export const searched = () => waitUntil(() => { const text = resultStatus(); return !!text && !/读取|推算中|准备/.test(text); });
export const tokyoTime = () => Date.parse(`${document.querySelector('input[type="date"]').value}T${document.querySelector('input[type="time"]').value.padEnd(8, ':00').slice(0, 8)}+09:00`);
/** Where a direction lands in the current frame (normalised device coordinates). */
export function placed(ray) {
  const view = { focalLength: value('焦距'), sensor: 'full-frame', aspectRatio: '3:2', orientation: document.querySelector('select[aria-label="拍摄画幅方向"]')?.value ?? 'landscape', azimuth: value('方位角'), pitch: value('俯仰角') };
  return projectDirection(view, ray);
}

export const fujiRequest = { format: 'tamatamatori.solve', version: 2, name: '富士山顶夕阳', lens: { focalLength: 400, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
  targets: [{ type: 'body', body: 'sun' }], camera: { mode: 'fixed', aim: { azimuth: 244.63, pitch: 10.74 } }, time: { mode: 'range', date: '2026-11-04', days: 365 }, timeZone: 'Asia/Tokyo' };
export async function openSolveLink(value) {
  await settle(() => { dom.window.location.hash = `solve=json:${encodeURIComponent(JSON.stringify(value))}`; });
  await waitUntil(() => document.querySelector('.solve-dialog')?.open);
  return document.querySelector('.solve-dialog');
}
