// Workspace interaction tests: the 3D preview, terrain, sun and moon. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubs, TestCelestialLayer, dom, terrainSize, resizeObservers, groundRequests, settle, workspace, input, chooseTimeZone, shootingDateTime, setShootingDateTime, value, button, setControl, waitUntil, terrainMap, readyTerrain } from "./harness.mjs";

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
    "../../src/preview/terrain.css",
    "../../node_modules/maplibre-gl/dist/maplibre-gl.css",
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
  style.textContent = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
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
  stubs.groundResponse = async () => ({ height: 2500, zoom: 12 });
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
