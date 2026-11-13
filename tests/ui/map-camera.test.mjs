// Workspace interaction tests: map and camera linkage. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { initialBearing } from "../../src/domain/map.ts";
import { dom, settle, waitForMap, workspace, input, chooseTimeZone, shootingDateTime, setShootingDateTime, value, button, clickMap, setControl, camera, heading, geometry } from "./harness.mjs";

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
