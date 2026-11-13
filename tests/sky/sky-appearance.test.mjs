import test from "node:test";
import assert from "node:assert/strict";
import {
  skyAppearance,
  starOpacity,
  skyAppearanceLabel,
  STAR_LABEL_ALPHA,
} from "../../src/domain/sky/sky-appearance.ts";
import { initialPlan, instantFromLocal } from "../../src/domain/core/plan.ts";
import { skyReference } from "../../src/domain/sky/starfield.ts";
const moon = { elevation: -30, illuminatedFraction: 1 };
const point = (magnitude) => ({ id: "star", magnitude });
const at = (sun, phase = 1, height = -30) =>
  skyAppearance(sun, { elevation: height, illuminatedFraction: phase });
const close = (a, b, t = 1e-6) =>
  assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);

test("暗夜保留目录亮星，白昼隐藏星点与银河，银心仅作方向参考", () => {
  const dark = at(-30),
    day = at(20);
  assert.equal(dark.galaxyStrength, 1);
  assert.equal(day.galaxyStrength, 0);
  for (const magnitude of [-4.5, -2, 0, 2, 4.5]) {
    assert.ok(starOpacity(point(magnitude), dark) > STAR_LABEL_ALPHA);
    assert.equal(starOpacity(point(magnitude), day), 0);
  }
  assert.equal(starOpacity({ id: "galactic-center", magnitude: 0 }, day), 1);
  assert.match(skyAppearanceLabel(day), /白昼/);
  assert.match(skyAppearanceLabel(dark), /暗夜/);
  assert.ok(starOpacity(point(0), at(-6)) > starOpacity(point(2), at(-6)));
  assert.ok(starOpacity(point(-4), at(-1)) > starOpacity(point(0), at(-1)));
});

test("暮光分界、月出月落平滑；日出时任何星等都不反向变亮", () => {
  for (const height of [-18, -12, -6, -2, 0]) {
    const a = at(height - 0.00001, 1, 60),
      b = at(height + 0.00001, 1, 60);
    for (const key of ["displayMagnitude", "starScale", "galaxyStrength"])
      close(a[key], b[key], 1e-4);
  }
  close(at(-30, 1, -0.00001).moonlight, at(-30, 1, 0.00001).moonlight, 0.001);
  for (const phase of [0, 0.5, 1])
    for (const elevation of [-30, 0, 30, 90]) {
      let before = at(-90, phase, elevation);
      for (let sun = -89.8; sun <= 90; sun += 0.2) {
        const after = at(sun, phase, elevation);
        assert.ok(after.galaxyStrength <= before.galaxyStrength + 1e-10);
        for (const mag of [-4, -2, 0, 2, 4.5])
          assert.ok(
            starOpacity(point(mag), after) <=
              starOpacity(point(mag), before) + 1e-10,
          );
        before = after;
      }
    }
});

test("同一太阳高度下，月相越亮、月亮越高，星空和银河越弱；地平线下不参与", () => {
  for (const phase of [0, 0.25, 0.5, 0.75, 1]) {
    let previous = at(-30, phase, -1);
    for (const elevation of [0, 5, 30, 60, 90]) {
      const next = at(-30, phase, elevation);
      assert.ok(next.galaxyStrength <= previous.galaxyStrength);
      for (const magnitude of [0, 2, 4.5])
        assert.ok(
          starOpacity(point(magnitude), next) <=
            starOpacity(point(magnitude), previous),
        );
      previous = next;
    }
  }
  assert.deepEqual(at(-30, 0, 90), at(-30, 1, -1));
  const dark = at(-30, 0, 90),
    full = at(-30, 1, 90);
  assert.ok(full.galaxyStrength < dark.galaxyStrength * 0.15);
  assert.ok(starOpacity(point(4.5), full) < STAR_LABEL_ALPHA);
  assert.ok(starOpacity(point(0), full) > STAR_LABEL_ALPHA);
});

test("真实新月、上弦、满月夜间由星历驱动，图层/镜头/时区不改变明暗", () => {
  const sample = (local) => {
    const plan = {
      ...initialPlan,
      instant: instantFromLocal(local, "Asia/Tokyo"),
    };
    const sky = skyReference(plan);
    return { plan, appearance: skyAppearance(sky.sunElevation, sky.moon) };
  };
  const dark = sample("2026-11-09T00:00"),
    quarter = sample("2026-11-17T19:00"),
    full = sample("2026-11-25T00:00");
  for (const s of [dark, quarter, full])
    assert.ok(s.appearance.sunElevation < -18);
  assert.ok(dark.appearance.galaxyStrength > quarter.appearance.galaxyStrength);
  assert.ok(quarter.appearance.galaxyStrength > full.appearance.galaxyStrength);
  const altered = skyReference({
    ...full.plan,
    timeZone: "UTC",
    focalLength: 1000,
    orientation: "portrait",
    azimuth: 0,
    layers: { sun: false, moon: false, stars: false, milkyWay: false },
  });
  assert.deepEqual(
    skyAppearance(altered.sunElevation, altered.moon),
    full.appearance,
  );
});

test("无效高度、亮面比例和星等明确失败", () => {
  for (const sun of [NaN, Infinity, -91, 91])
    assert.throws(() => skyAppearance(sun, moon));
  for (const value of [
    { elevation: NaN, illuminatedFraction: 1 },
    { elevation: 91, illuminatedFraction: 1 },
    { elevation: 30, illuminatedFraction: NaN },
    { elevation: 30, illuminatedFraction: -0.1 },
    { elevation: 30, illuminatedFraction: 1.1 },
  ])
    assert.throws(() => skyAppearance(-30, value));
  assert.throws(() => starOpacity(point(NaN), at(-30)));
});
