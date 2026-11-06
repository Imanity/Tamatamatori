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
    this.report({planKey:frame.planKey,orbitKey:frame.stations?.key,ready:frame.ready,view:{azimuth:frame.plan.azimuth,pitch:frame.plan.pitch},states:Object.fromEntries([...sky.points,sky.core,...figures,...deep,...stations,...deep.map(p=>({...p,id:p.id+':label'}))].map(p=>[p.id,frame.ready?'clear':'waiting'])),deepSky:{phase:frame.plan.layers.deepSky?'ready':'off'}});
  }
  invalidate() { if(this.frame)this.report({planKey:this.frame.planKey,ready:false,view:null,states:{}}); }
  onRemove() { this.removed=true; }
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
  installGlobal("__testCelestialLayer", TestCelestialLayer);
  installGlobal("__testStarfieldLayer", TestStarfieldLayer);
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
          if (id.replaceAll("\\", "/").endsWith("/src/preview/celestial-layer.ts"))
            return "export const CelestialLayer = globalThis.__testCelestialLayer;";
          if (id.replaceAll("\\", "/").endsWith("/src/preview/elevation.ts"))
            return "export const groundElevation = (...args) => globalThis.__testGroundLoader(...args);";
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
) {
  groundResponse = elevation;
  groundRequests.length = 0;
  resizeObservers.length = 0;
  TestMap.instances.length = 0;
  TestMarker.instances.length = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    frames.clear();
  });
  await act(async () => root.render(createElement(App)));
  return { host, map: await waitForMap() };
}

function input(label) {
  const field = [...document.querySelectorAll("label")].find(
    (element) =>
      element.querySelector(".field-label")?.textContent.trim() === label,
  );
  assert.ok(field, `missing input ${label}`);
  return field.querySelector("input");
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
  const time = document.querySelector('input[type="datetime-local"]').value;
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
    document.querySelector('input[type="datetime-local"]').value,
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
  await settle(() =>
    setControl(document.querySelector('select[aria-label="地图面板位置"]'), 1),
  );
  const movedMap = await waitForMap();
  assert.notEqual(movedMap, map);
  assert.equal(movedMap.options.bearing, 75);
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
  const date = document
    .querySelector('input[type="datetime-local"]')
    .value.slice(0, 10);
  await settle(() =>
    setControl(
      document.querySelector('input[aria-label="24 小时时间滑杆"]'),
      720,
    ),
  );
  assert.equal(
    document.querySelector('input[type="datetime-local"]').value,
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
  const zone = [...document.querySelectorAll("select")].find(
    (element) => element.value === "Asia/Tokyo",
  );
  await settle(() => setControl(zone, "America/New_York"));
  const dateTime = document.querySelector('input[type="datetime-local"]');
  await settle(() => setControl(dateTime, "2026-03-08T03:30"));
  assert.equal(dateTime.value, "2026-03-08T03:30");
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  await settle(() => setControl(slider, 150));
  assert.equal(dateTime.value, "2026-03-08T03:30");
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
    document.querySelector(".terrain-height").textContent.includes("1000.0"),
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

test("预览尺寸变化只同步相机，面板换位后保留拍摄参数并释放旧实例", async (t) => {
  await workspace(t);
  const old = await readyTerrain();
  const fields = ["经度", "纬度", "方位角", "俯仰角", "焦距", "相机离地高度"];
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
  await settle(() => setControl(document.querySelector('select[aria-label="拍摄预览面板位置"]'), 0));
  const moved = await readyTerrain();
  assert.notEqual(moved, old);
  assert.equal(old.removed, true);
  assert.deepEqual(fields.map(value), before);
  assert.equal(moved.cameraViews.at(-1).bearing, before[2]);
  assert.equal(moved.cameraSolutions.at(-1).altitude, 1000 + before[5]);
});

test("地形相机随高度、方向和横竖幅更新，镜头或时间编辑不重复请求机位高程", async (t) => {
  await workspace(t);
  const map = await readyTerrain(),
    requests = groundRequests.length;
  await settle(() => setControl(input("相机离地高度"), 5));
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

test("时间驱动环境并合并连续更新，切换时区不重绘，布局重建保留最新夜景", async (t) => {
  await workspace(t);
  const map = await readyTerrain();
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  await settle(() => setControl(slider, 720));
  const day = map.environments.at(-1);
  const poses = map.cameraSolutions.length, requests = groundRequests.length;
  const fields = ["经度", "纬度", "方位角", "俯仰角", "焦距", "相机离地高度"].map(value);
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
  const zone = [...document.querySelectorAll("select")].find((element) => element.value === "Asia/Tokyo");
  await settle(() => setControl(zone, "America/New_York"));
  assert.equal(map.environments.length, writes + 1);
  assert.deepEqual(["经度", "纬度", "方位角", "俯仰角", "焦距", "相机离地高度"].map(value), fields);
  await settle(() => setControl(document.querySelector('select[aria-label="拍摄预览面板位置"]'), 0));
  const moved = await readyTerrain();
  assert.equal(map.removed, true);
  assert.deepEqual(moved.environments.at(-1), night);
});

test("月光随日期变化，隐藏月亮保留环境及夜间参考，不重建相机或读取 DEM", async (t) => {
  await workspace(t);const map=await readyTerrain();
  const time=document.querySelector('input[type="datetime-local"]');
  await settle(()=>setControl(time,'2026-11-09T00:00'));
  const dark=structuredClone(map.environments.at(-1));
  const poses=map.cameraSolutions.length,requests=groundRequests.length;
  await settle(()=>setControl(time,'2026-11-25T00:00'));
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
  const fields = ["经度", "纬度", "焦距", "相机离地高度"].map(value);
  const time = document.querySelector('input[type="datetime-local"]').value;
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes("视场外"));
  await settle(() => document.querySelector('button[aria-label="朝向太阳"]').click());
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes("当前 DEM 未遮挡"));
  assert.ok(document.querySelector('[data-celestial-body="sun"]'));
  const poses = map.cameraSolutions.length, environments = map.environments.length, requests = groundRequests.length;
  await settle(() => document.querySelector('input[aria-label="显示太阳"]').click());
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes("已关闭"));
  assert.equal(document.querySelector('[data-celestial-body="sun"]'), null);
  assert.equal(document.querySelector('input[aria-label="显示月亮"]').checked, true);
  assert.equal(map.cameraSolutions.length, poses);
  assert.equal(map.environments.length, environments);
  assert.equal(groundRequests.length, requests);
  assert.deepEqual(["经度", "纬度", "焦距", "相机离地高度"].map(value), fields);
  assert.equal(document.querySelector('input[type="datetime-local"]').value, time);
  await settle(() => setControl(document.querySelector('select[aria-label="拍摄预览面板位置"]'), 0));
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
  const fields=['经度','纬度','焦距','相机离地高度'].map(value),requests=groundRequests.length;
  const environment=structuredClone(map.environments.at(-1));
  await settle(()=>document.querySelector('input[aria-label="显示月亮"]').click());
  assert.equal(document.querySelector('[data-body-direction="moon"]'),null);
  await settle(()=>document.querySelector('button[aria-label="朝向太阳"]').click());
  assert.equal(document.querySelector('[data-body-direction="sun"]'),null);
  assert.ok(document.querySelector('[data-celestial-body="sun"]'));
  assert.deepEqual(['经度','纬度','焦距','相机离地高度'].map(value),fields);
  assert.equal(groundRequests.length,requests);assert.deepEqual(map.environments.at(-1),environment);
  await settle(()=>setControl(slider,1020));
  assert.equal(document.querySelectorAll('[data-body-direction]').length,0);
});

test("靠近日月的箭头并排，实际相机反馈决定画外方向而不改计划",async(t)=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(document.querySelector('input[type="datetime-local"]'),'2026-11-09T12:00'));
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

test("折射修改只更新日月轮廓，地形更新使遮挡失效，重建释放旧深度图层", async (t) => {
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
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('当前 DEM 未遮挡'));
  await settle(()=>setControl(document.querySelector('select[aria-label="拍摄预览面板位置"]'),0));
  const restored = await readyTerrain();assert.equal(layer.removed,true);
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
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('当前 DEM 未遮挡'));
});

test("引擎避让反馈实际高度和俯仰，日月随实际姿态投影，计划保持不变", async (t) => {
  await workspace(t); const map = await readyTerrain();
  await settle(() => setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(() => document.querySelector('button[aria-label="朝向太阳"]').click());
  const layer = map.customLayers.find(layer=>layer instanceof TestCelestialLayer), outline = structuredClone(layer.frame.bodies.find(b => b.id === 'sun').outline);
  const before = ["经度", "纬度", "俯仰角", "方位角", "相机离地高度", "焦距"].map(value);
  const labelTop = document.querySelector('[data-celestial-body="sun"]').style.top;
  const expected = map.cameraSolutions.at(-1), pitch = value("俯仰角") - 5;
  await settle(() => {
    map.pitch = 90 + pitch;
    layer.onCamera({ planKey: layer.frame.planKey, longitude: value("经度"), latitude: value("纬度"),
      altitude: expected.altitude + 1.7, azimuth: value("方位角"), pitch });
    map.emit('render');
  });
  assert.deepEqual(["经度", "纬度", "俯仰角", "方位角", "相机离地高度", "焦距"].map(value), before);
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
  const before=['经度','纬度','方位角','俯仰角','相机离地高度'].map(value);
  const calculate=map.sources.get('preview-terrain').calculateTileZoom,writes=map.detailWrites;
  await settle(()=>button('200 mm').click());
  await settle(()=>setControl(document.querySelector('select[aria-label="拍摄画幅方向"]'),'portrait'));
  assert.equal(map.detailWrites,writes);
  await settle(()=>button('1000 mm').click());
  await settle(()=>button('8 mm').click());
  assert.equal(map.sources.get('preview-terrain').calculateTileZoom,calculate);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  assert.deepEqual(['经度','纬度','方位角','俯仰角','相机离地高度'].map(value),before);
});

test("切换机位取消过期高程请求；等待新高程时隐藏旧位置画面", async (t) => {
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
  const fields=['经度','纬度','焦距','相机离地高度'].map(value),time=input('当地日期与时间').value;
  const poses=map.cameraSolutions.length,environments=map.environments.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  assert.equal(map.cameraSolutions.length,poses);assert.equal(map.environments.length,environments);
  assert.match(document.querySelector('.sky-readout').textContent,/925/);
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
  assert.deepEqual(['经度','纬度','焦距','相机离地高度'].map(value),fields);assert.equal(input('当地日期与时间').value,time);
});

test('银河对比度滑杆即时联动，重置/关闭重开/布局保留正确，未重载地形或作废几何状态',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  assert.equal(document.querySelector('#galaxy-contrast'),null);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  const slider=()=>document.querySelector('#galaxy-contrast'),layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer);
  assert.equal(slider().value,'100');assert.equal(document.querySelector('[aria-label="重置银河对比度"]').disabled,true);
  const fields=['经度','纬度','焦距','相机离地高度','方位角','俯仰角'].map(value),time=input('当地日期与时间').value;
  const originalFrame=layer.frame,poses=map.cameraSolutions.length,environments=map.environments.length;
  for (const percent of [25,200]) {
    await settle(()=>setControl(slider(),percent));assert.equal(layer.contrast,percent);
    assert.equal(slider().getAttribute('aria-valuetext'),`${percent}%`);
    assert.match(document.querySelector('.sky-readout').textContent,new RegExp(`对比度 ${percent}%`));
    assert.equal(layer.frame,originalFrame);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
    assert.equal(map.cameraSolutions.length,poses);assert.equal(map.environments.length,environments);
    assert.deepEqual(['经度','纬度','焦距','相机离地高度','方位角','俯仰角'].map(value),fields);assert.equal(input('当地日期与时间').value,time);
  }
  await settle(()=>document.querySelector('[aria-label="重置银河对比度"]').click());assert.equal(slider().value,'100');assert.equal(layer.contrast,100);
  await settle(()=>setControl(slider(),150));await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(slider(),null);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(slider().value,'150');
  await settle(()=>setControl(document.querySelector('[aria-label="拍摄预览面板位置"]'),'0'));assert.equal(slider().value,'150');
  await settle(()=>button('重置布局').click());assert.equal(slider().value,'150');
});

test('深空搜索开启与朝向，未改机/改机响应切换保留几何、时刻与 DEM',async t=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-09T01:00'));
  await settle(()=>setControl(document.querySelector('#target-search'),'M42'));
  assert.equal(document.querySelector('[aria-label="显示深空天体"]').checked,false);
  assert.match(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/图层已关闭/);
  const time=input('当地日期与时间').value,fields=['经度','纬度','焦距','相机离地高度'].map(value);
  await settle(()=>document.querySelector('[aria-label="开启并朝向猎户座大星云"]').click());
  assert.equal(document.querySelector('[aria-label="显示深空天体"]').checked,true);
  assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'));
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),originalFrame=layer.frame,requests=groundRequests.length,poses=map.cameraSolutions.length;
  await settle(()=>setControl(document.querySelector('[aria-label="深空相机响应"]'),'ha-modified'));
  assert.equal(layer.cameraResponse,'ha-modified');assert.equal(layer.frame,originalFrame);assert.equal(groundRequests.length,requests);assert.equal(terrainMap(),map);assert.equal(map.cameraSolutions.length,poses);
  assert.deepEqual(['经度','纬度','焦距','相机离地高度'].map(value),fields);assert.equal(input('当地日期与时间').value,time);
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  assert.equal(document.querySelectorAll('[data-dso-status]').length,15);assert.match(document.querySelector('.sky-readout').textContent,/天文改机/);
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());assert.equal(document.querySelector('[data-dso-label]'),null);
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());assert.equal(document.querySelector('[aria-label="深空相机响应"]').value,'ha-modified');
});

test('深空部分遮挡不等于中心名称可见，轮廓加载失败单独反馈',async t=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-09T01:00'));
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
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  const status=()=>document.querySelector('[data-sky-status="北极星"]');
  assert.match(status().textContent,/天空较亮/);assert.equal(status().dataset.skyOpacity,'0.000');
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('.sky-appearance').textContent,/白昼/);
  assert.equal(document.querySelector('[data-sky-status="银心"]').dataset.skyOpacity,'1.000');
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{[id]:'blocked'}}));
  assert.match(status().textContent,/山体遮挡/);
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),1320));
  assert.ok(Number(status().dataset.skyOpacity)>0.06);assert.ok(document.querySelector('[data-sky-label="北极星"]'));
  const darkOpacity=Number(status().dataset.skyOpacity);
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-25T00:00'));
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
  await settle(()=>document.querySelector('[aria-label="收起拍摄信息"]').click());
  assert.ok(sidebar.classList.contains('is-collapsed'));
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('.desktop-info-toggle').click());
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
  const downloads = [...dialog.querySelectorAll('a[download]')];
  assert.equal(downloads.length, catalog.imageSources.length + 5);
  assert.equal(new Set(downloads.map((link) => link.getAttribute('href'))).size, downloads.length);
  const fields = ['经度', '纬度', '焦距', '相机离地高度', '方位角', '俯仰角'];
  const before = fields.map(value), time = input('当地日期与时间').value;
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
  assert.equal(input('当地日期与时间').value, time);
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
  const fields = ['经度', '纬度', '焦距', '相机离地高度'];
  const before = fields.map(value);
  assert.equal(calls.length, 0);
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, false);
  await settle(() => setControl(input('当地日期与时间'), '2026-11-06T19:35'));
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
  await settle(() => setControl(input('当地日期与时间'), '2027-01-01T00:00'));
  assert.equal(layer.frame.stations.points.length, 0);
  assert.match(document.querySelector('.station-readout').textContent, /停止绘制/);
  await settle(() => setControl(input('当地日期与时间'), '2026-11-06T19:35'));
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

test('星座默认关闭且独立于星空；主要亮星名称、星座定位与开关联动',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').checked,false);
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-09T01:00'));
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.ok(document.querySelectorAll('[data-sky-status]').length>=90);
  await settle(()=>document.querySelector('[aria-label="朝向参宿五"]').click());
  assert.ok(document.querySelector('[data-sky-label="参宿五"]'));
  await settle(()=>document.querySelector('[aria-label="显示星座名称与连线"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向猎户座"]').click());
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));assert.equal(document.querySelector('[data-sky-status="参宿五"]'),null);
  await settle(()=>document.querySelector('[aria-label="显示星座名称与连线"]').click());
  assert.equal(document.querySelector('[data-constellation-label]'),null);assert.equal(document.querySelector('[data-constellation-status]'),null);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('侧栏搜索发现未开启目标，输入不改变构图，明确选择才开启图层和朝向',async t=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-09T01:00'));
  const fields=['纬度','经度','方位角','俯仰角','焦距'].map(value),requests=groundRequests.length;
  await settle(()=>setControl(document.querySelector('#target-search'),'ＯＲＩ'));
  assert.match(document.querySelector('.target-search-results').textContent,/猎户座/);
  assert.match(document.querySelector('.target-search-results').textContent,/图层已关闭/);
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').checked,false);
  assert.deepEqual(['纬度','经度','方位角','俯仰角','焦距'].map(value),fields);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  await settle(()=>document.querySelector('[aria-label="开启并朝向猎户座"]').click());
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').checked,true);
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,false);
  await settle(()=>setControl(document.querySelector('#target-search'),'不存在的目标_zzzz'));
  assert.match(document.querySelector('.target-search-results').textContent,/没有找到匹配目标/);
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  assert.equal(document.querySelector('.target-search-results'),null);assert.ok(document.querySelector('.info-body .preview-readout'));
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('缓存视野的加载事件在没有后续 sourcedata 时恢复深空图层',async t=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-09T01:00'));
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());
  await settle(()=>setControl(document.querySelector('#target-search'),'M31'));
  await settle(()=>document.querySelector('[aria-label="朝向仙女座星系"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),oldKey=layer.frame.key;
  await settle(()=>map.emit('dataloading'));
  assert.notEqual(layer.frame.key,oldKey);assert.equal(layer.frame.ready,true);
  assert.match(document.querySelector('.target-search-results').textContent,/当前 DEM 未遮挡/);
  await settle(()=>setControl(document.querySelector('[aria-label="深空相机响应"]'),'ha-modified'));
  assert.equal(layer.frame.ready,true);assert.ok(document.querySelector('[data-dso-label="仙女座星系"]'));
});

test('侧栏收起、面板交换保留搜索，地平线下的未开启目标只启用图层',async t=>{
  await workspace(t);await readyTerrain();
  await settle(()=>setControl(input('当地日期与时间'),'2026-11-25T00:00'));
  await settle(()=>setControl(document.querySelector('#target-search'),'Vega'));
  const pose=['方位角','俯仰角'].map(value);
  await settle(()=>document.querySelector('[aria-label="开启图层织女星"]').click());
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  assert.deepEqual(['方位角','俯仰角'].map(value),pose);
  assert.match(document.querySelector('.target-search-results').textContent,/地平线下/);
  await settle(()=>document.querySelector('[aria-label="收起拍摄信息"]').click());
  await settle(()=>document.querySelector('.desktop-info-toggle').click());
  assert.equal(document.querySelector('#target-search').value,'Vega');
  await settle(()=>setControl(document.querySelector('select[aria-label="拍摄预览面板位置"]'),0));await readyTerrain();
  assert.equal(document.querySelector('#target-search').value,'Vega');assert.ok(document.querySelector('[data-search-target]'));
});
