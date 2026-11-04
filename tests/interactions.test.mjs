import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { initialBearing } from "../src/domain/map.ts";

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
    return true;
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
      .querySelector(".preview-attribution")
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

test("折射修改只更新日月轮廓，地形更新使遮挡失效，重建释放旧深度图层", async (t) => {
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('button[aria-label="朝向太阳"]').click());
  const layer=map.customLayers[0], outline=structuredClone(layer.frame.bodies.find(body=>body.id==='sun').outline);
  const poses=map.cameraSolutions.length, requests=groundRequests.length;
  const before=["经度","纬度","方位角","俯仰角","焦距"].map(value);
  await settle(()=>setControl(document.querySelector('select[aria-label="大气折射模型"]'),'none'));
  assert.equal(map.cameraSolutions.length,poses);assert.equal(groundRequests.length,requests);
  assert.deepEqual(["经度","纬度","方位角","俯仰角","焦距"].map(value),before);
  assert.notDeepEqual(layer.frame.bodies.find(body=>body.id==='sun').outline,outline);
  await settle(()=>map.emit('dataloading'));
  assert.ok(document.querySelector('[data-body-status="sun"]').textContent.includes('遮挡待测'));
  await settle(()=>map.emit('sourcedata'));
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
  const layer = map.customLayers[0], outline = structuredClone(layer.frame.bodies.find(b => b.id === 'sun').outline);
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
