import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { celestialBodies, direction, moonPhaseLabel, sunPosition } from "../src/domain/ephemeris.ts";
import { bodyPolygons, projectDirection } from "../src/domain/celestial-projection.ts";
import { initialPlan as defaultPlan, fieldOfView, signedAngle } from "../src/domain/plan.ts";
const initialPlan = { ...defaultPlan, refraction: "none" };

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
const area = (points) => Math.abs(points.reduce((sum, a, index) => {
  const b = points[(index + 1) % points.length]; return sum + a.x * b.y - a.y * b.x;
}, 0) / 2);
const disc = (azimuth, elevation, angularRadius = 0.25) => ({ id: "sun", azimuth, elevation, angularRadius, direction: direction(azimuth, elevation), distanceKm: 1.5e8 });

test("日月测站位置、距离、角直径及月面比例符合离线 JPL 基准", () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/sun-moon-reference.json', import.meta.url), 'utf8'));
  assert.equal(fixture.records.length, 8);
  for (const reference of fixture.records) {
    const body = celestialBodies(reference)[reference.id];
    close(signedAngle(body.azimuth - reference.azimuth), 0, 0.05);
    close(body.elevation, reference.elevation, 0.05);
    close(body.angularRadius * 2, reference.angularDiameter, 0.002);
    close(body.distanceKm / reference.distanceKm, 1, 0.001);
    if (body.id === "moon") close(body.illuminatedFraction, reference.illuminatedFraction, 0.003);
  }
});

test("日月共享太阳坐标、保持 UTC 与时区不变性，角直径处于合理范围", () => {
  const bodies = celestialBodies(initialPlan);
  assert.deepEqual(sunPosition(initialPlan), { azimuth: bodies.sun.azimuth, elevation: bodies.sun.elevation });
  assert.deepEqual(celestialBodies({ ...initialPlan, timeZone: "UTC" }), bodies);
  assert.deepEqual(celestialBodies({ ...initialPlan, instant: "2026-11-04T17:00:00+09:00" }), bodies);
  for (const instant of ["2026-01-01T00:00Z", "2026-07-01T00:00Z"])
    for (const body of Object.values(celestialBodies({ ...initialPlan, instant }))) {
      assert.ok(body.angularRadius * 2 > 0.45 && body.angularRadius * 2 < 0.6);
      assert.ok(body.azimuth >= 0 && body.azimuth < 360);
    }
});

test("USNO 公开月相时刻对应新月、满月和上下弦，测站亮面比例合理", () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/moon-phases-reference.json', import.meta.url), 'utf8'));
  for (const reference of fixture.records) {
    const moon = celestialBodies({ ...initialPlan, instant: reference.instant }).moon;
    close(signedAngle(moon.phaseAngle - reference.phase), 0, 0.1);
    assert.equal(moonPhaseLabel(moon.phaseAngle), reference.label);
    close(moon.illuminatedFraction, reference.fraction, 0.015);
  }
});

test("日月在日期变更线相接，极点有限，非法输入明确失败", () => {
  const a = celestialBodies({ ...initialPlan, longitude: -180 }), b = celestialBodies({ ...initialPlan, longitude: 180 });
  for (const id of ["sun", "moon"]) {
    close(a[id].azimuth, b[id].azimuth);
    close(a[id].elevation, b[id].elevation);
  }
  for (const latitude of [-90, 90]) for (const body of Object.values(celestialBodies({ ...initialPlan, latitude })))
    assert.ok(Number.isFinite(body.elevation) && Number.isFinite(body.azimuth));
  assert.throws(() => celestialBodies({ ...initialPlan, latitude: NaN }));
  assert.throws(() => celestialBodies({ ...initialPlan, instant: "2026-11-04T12:00" }));
});

test("针孔投影处理正前方、真北接缝、背面与天顶，不分离计算水平垂直偏移", () => {
  for (const pitch of [-45, 0, 35, 90]) {
    const plan = { ...initialPlan, azimuth: 359, pitch };
    const centre = projectDirection(plan, direction(359, pitch));
    close(centre.x, 0); close(centre.y, 0);
  }
  const plan = { ...initialPlan, azimuth: 359, pitch: 20 };
  assert.ok(projectDirection(plan, direction(1, 20)).x > 0);
  assert.equal(projectDirection(plan, direction(179, -20)), null);
  const tilted = projectDirection({ ...plan, pitch: 70 }, direction(30, 70));
  assert.ok(tilted.y < 0, "same geographic altitude is not a straight image row at large pitch");
});

test("圆盘角尺寸随焦距和画幅投影，像素圆盘不被最小显示尺寸放大", () => {
  const body = disc(247, 20);
  for (const orientation of ["landscape", "portrait"])
    for (const focalLength of [8, 35, 200, 1000]) {
      const plan = { ...initialPlan, pitch: 20, orientation, focalLength };
      const { outline, state } = bodyPolygons(plan, body);
      assert.equal(state, "画面内");
      const radius = Math.max(...outline.map((point) => point.x));
      close(radius, Math.tan(body.angularRadius * Math.PI / 180) / Math.tan(fieldOfView(plan).horizontal * Math.PI / 360), 1e-7);
      const width = orientation === "portrait" ? 400 : 600, height = orientation === "portrait" ? 600 : 400;
      close(radius * width, Math.max(...outline.map((point) => point.y)) * height, 1e-7);
    }
});

test("圆盘跨视场边缘仍显示，跨几何地平线只绘制地平线上方部分", () => {
  const plan = { ...initialPlan, azimuth: 0, pitch: 0 };
  const edge = fieldOfView(plan).horizontal / 2;
  const partial = bodyPolygons(plan, disc(edge + 0.1, 2));
  assert.equal(partial.state, "画面内");
  assert.ok(partial.centre.x > 1);
  assert.equal(bodyPolygons(plan, disc(edge + 1, 2)).state, "视场外");
  const horizon = bodyPolygons(plan, disc(0, -0.1));
  assert.equal(horizon.state, "画面内");
  assert.ok(horizon.outline.every((point) => point.y <= 1e-8));
  assert.equal(bodyPolygons(plan, disc(0, -1)).state, "地平线下");
});

test("月相亮区面积符合比例，亮侧朝实际光源而非固定屏幕方向", () => {
  const plan = { ...initialPlan, azimuth: 0, pitch: 0, focalLength: 200 };
  // Geographic horizon clipping would cut half the disc; use elevation 30°.
  plan.pitch = 30;
  const base = { ...disc(0, 30), id: "moon", phaseAngle: 90, illuminatedFraction: 0.5 };
  const centre = base.direction;
  for (const cosine of [-1, 0, 0.8, 1]) {
    const lightDirection = [Math.sqrt(1 - cosine * cosine), centre[1] * cosine, centre[2] * cosine];
    const polygons = bodyPolygons(plan, { ...base, lightDirection });
    close(area(polygons.illuminated) / area(polygons.outline), (1 - cosine) / 2, 0.002);
  }
  const right = bodyPolygons(plan, { ...base, lightDirection: [1, 0, 0] }).illuminated;
  const left = bodyPolygons(plan, { ...base, lightDirection: [-1, 0, 0] }).illuminated;
  assert.ok(right.reduce((sum, point) => sum + point.x, 0) > 0);
  assert.ok(left.reduce((sum, point) => sum + point.x, 0) < 0);
  assert.deepEqual([0, 90, 180, 270].map(moonPhaseLabel), ["新月附近", "上弦附近", "满月附近", "下弦附近"]);
});
