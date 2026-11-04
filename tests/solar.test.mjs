import test from "node:test";
import assert from "node:assert/strict";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { solarPosition, daylightPhase } from "../src/domain/solar.ts";
import { initialPlan, instantFromLocal } from "../src/domain/plan.ts";
import { terrainStyle } from "../src/domain/terrain.ts";
import { environmentForSun, applyEnvironment } from "../src/preview/environment.ts";

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
const rgb = (color) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));

test("太阳位置与 NREL SPA 公开样例的角度一致到本轮 0.1 度容差", () => {
  // https://www.nlr.gov/docs/fy08osti/34302.pdf, Table A5.1.
  // SPA's zenith includes refraction; ours is geometric and differs by ~0.016°.
  const sun = solarPosition({ latitude: 39.742476, longitude: -105.1786, instant: "2003-10-17T19:30:30Z" });
  close(sun.azimuth, 194.340241, 0.1);
  close(sun.elevation, 90 - 50.111622, 0.1);
});

test("太阳按机位与 UTC 计算，显示时区和等价时刻不改变位置", () => {
  const instant = instantFromLocal("2026-11-04T12:00", "Asia/Tokyo");
  const sun = solarPosition({ ...initialPlan, instant });
  assert.deepEqual(solarPosition({ ...initialPlan, instant, timeZone: "America/New_York" }), sun);
  assert.deepEqual(solarPosition({ ...initialPlan, instant: "2026-11-04T12:00:00+09:00" }), sun);
  assert.ok(sun.elevation > 30);
  assert.ok(solarPosition({ ...initialPlan, instant: "2026-11-03T15:00:00Z" }).elevation < -18);
  assert.ok(solarPosition({ ...initialPlan, longitude: -41.1271, instant }).elevation < -18);
});

test("日期变更线相接、跨 UTC 午夜连续，负时间戳与日期边界有效", () => {
  const at = (longitude, instant = "2026-11-04T00:00:00Z") => solarPosition({ latitude: 15, longitude, instant });
  close(at(-180).azimuth, at(180).azimuth);
  close(at(-180).elevation, at(180).elevation);
  const before = at(0, "2026-11-03T23:59:59Z"), after = at(0, "2026-11-04T00:00:01Z");
  close(before.elevation, after.elevation, 0.02);
  close(before.azimuth, after.azimuth, 0.02);
  for (const instant of ["1900-01-01T00:00:00Z", "2000-02-29T12:00:00Z", "2100-12-31T23:59:59Z",
    instantFromLocal("1900-01-01T00:00", "Asia/Tokyo"),
    instantFromLocal("2100-12-31T23:59", "America/New_York"),
  ])
    assert.ok(Number.isFinite(at(0, instant).elevation));
});

test("南北半球季节与极昼极夜由太阳高度决定，极点结果有限", () => {
  for (const hour of [0, 6, 12, 18]) {
    const time = `${String(hour).padStart(2, "0")}:00:00Z`;
    for (const latitude of [70, 90]) {
      const northSummer = solarPosition({ latitude, longitude: 0, instant: `2026-06-21T${time}` });
      const northWinter = solarPosition({ latitude, longitude: 0, instant: `2026-12-21T${time}` });
      assert.ok(northSummer.elevation > 0);
      assert.ok(northWinter.elevation < 0);
      assert.ok(Number.isFinite(northSummer.azimuth));
      assert.ok(solarPosition({ latitude: -latitude, longitude: 0, instant: `2026-06-21T${time}` }).elevation < 0);
      assert.ok(solarPosition({ latitude: -latitude, longitude: 0, instant: `2026-12-21T${time}` }).elevation > 0);
    }
  }
});

test("无效坐标、无时区时间和模型日期范围被拒绝", () => {
  for (const patch of [
    { latitude: 91 }, { longitude: NaN }, { longitude: 181 },
    { instant: "invalid" }, { instant: "2026-11-04T12:00:00" },
    { instant: "1898-12-31T23:59:59Z" }, { instant: "2102-01-01T00:00:00Z" },
  ]) assert.throws(() => solarPosition({ ...initialPlan, ...patch }));
});

test("昼夜文字和配色连续，地平线下关闭直射，夜间保留构图明度", () => {
  const phases = [-20, -15, -9, -3, 3, 30].map(daylightPhase);
  assert.deepEqual(phases, ["夜间", "天文暮光", "航海暮光", "民用暮光", "低角度日照", "白昼"]);
  const environment = (elevation) => environmentForSun({ elevation, azimuth: 190 });
  const night = environment(-30), dusk = environment(-3), day = environment(40);
  assert.ok(rgb(night.ground).some((value) => value > 0));
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(rgb(night.ground)[channel] < rgb(dusk.ground)[channel]);
    assert.ok(rgb(dusk.ground)[channel] < rgb(day.ground)[channel]);
  }
  for (const elevation of [-30, -6, 0]) assert.equal(environment(elevation).shading["hillshade-exaggeration"], 0);
  for (const elevation of [-18, -12, -6, 0, 6, 25])
    for (const property of ["sky-color", "horizon-color", "fog-color"]) {
      const before = rgb(environment(elevation - 0.001).sky[property]);
      const after = rgb(environment(elevation + 0.001).sky[property]);
      before.forEach((value, channel) => close(value, after[channel], 1));
    }
});

test("环境生成的昼夜样式通过真实 SDK 校验，光源锚定真北且参数有效", () => {
  for (const elevation of [-90, -18, -6, 0, 6, 40, 90])
    for (const azimuth of [0, 190, 359.99]) {
      const style = terrainStyle();
      const environment = environmentForSun({ elevation, azimuth });
      applyEnvironment({
        setSky(sky) { style.sky = sky; },
        setPaintProperty(id, property, value) { style.layers.find((layer) => layer.id === id).paint[property] = value; },
      }, environment);
      assert.deepEqual(validateStyleMin(style).map((error) => error.message), []);
      assert.equal(environment.shading["hillshade-illumination-anchor"], "map");
      assert.ok(environment.shading["hillshade-illumination-altitude"] >= 0);
    }
});
