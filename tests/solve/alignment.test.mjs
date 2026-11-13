import test from "node:test";
import assert from "node:assert/strict";
import { Body, Equator, Horizon, Observer } from "astronomy-engine";
import {
  finishAlignment,
  frameDirection,
  geometricElevation,
  markOutline,
  scanAlignment,
  skyCondition,
  solveAlignment,
} from "../../src/domain/solve/alignment.ts";
import { celestialBodies, direction } from "../../src/domain/core/ephemeris.ts";
import { apparentElevation } from "../../src/domain/core/refraction.ts";
import { projectDirection } from "../../src/domain/core/celestial-projection.ts";
import { ellipsoidalRay } from "../../src/domain/core/geodesy.ts";
import { lightPeriodBounds } from "../../src/domain/time/timeline.ts";

const DAY = 86_400_000;
const rad = Math.PI / 180;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / rad;

// Lake Yamanaka shore looking at the summit of Fuji: the "diamond" (Sun) and "pearl" (Moon) scenes.
const yamanaka = { latitude: 35.4172, longitude: 138.8729 };
const summit = (() => {
  const ray = ellipsoidalRay({ ...yamanaka, ellipsoidalHeight: 982 }, { latitude: 35.3606, longitude: 138.7274, ellipsoidalHeight: 3776 });
  return {
    azimuth: ((Math.atan2(ray[0], ray[1]) / rad) + 360) % 360,
    elevation: Math.asin(ray[2] / Math.hypot(...ray)) / rad,
  };
})();

/**
 * Independent reference: the body's apparent direction from astronomy-engine
 * directly (topocentric, ellipsoid observer, the preview's refraction),
 * sampled every 10 minutes, then every 5 seconds around each dip below 2°.
 */
function sampled(input, from, to) {
  const observer = new Observer(input.latitude, input.longitude, 0);
  const body = input.target.body === "sun" ? Body.Sun : Body.Moon;
  const mark = direction(input.target.azimuth, input.target.elevation);
  const at = (time) => {
    const date = new Date(time), equator = Equator(body, date, observer, true, true);
    const horizon = Horizon(date, observer, equator.ra, equator.dec);
    const ray = direction(horizon.azimuth, apparentElevation(horizon.altitude, input.refraction));
    const radius = Math.asin((input.target.body === "sun" ? 695700 : 1737.4) / (equator.dist * 149597870.7)) / rad;
    return { separation: angle(mark, ray), radius };
  };
  const coarse = [];
  for (let time = from; time < to; time += 600_000) coarse.push({ time, separation: at(time).separation });
  const passes = [];
  for (let index = 1; index < coarse.length - 1; index++) {
    const sample = coarse[index];
    if (sample.separation > 2 || sample.separation > coarse[index - 1].separation || sample.separation > coarse[index + 1].separation) continue;
    let best = { time: sample.time, ...at(sample.time) };
    for (let time = sample.time - 900_000; time <= sample.time + 900_000; time += 5000) {
      const value = at(time);
      if (value.separation < best.separation) best = { time, ...value };
    }
    const limit = input.tolerance * 2 * best.radius;
    if (best.separation > limit) continue;
    let start = best.time, end = best.time;
    while (at(start - 5000).separation <= limit) start -= 5000;
    while (at(end + 5000).separation <= limit) end += 5000;
    passes.push({ time: best.time, separation: best.separation, start, end });
  }
  return passes;
}

function compare(input, from, to) {
  const result = solveAlignment(input, from, to);
  const reference = sampled(input, from, to);
  assert.equal(result.alignments.length, reference.length, `${input.target.body}: ${result.alignments.map((a) => a.instant)} vs ${reference.map((r) => new Date(r.time).toISOString())}`);
  result.alignments.forEach((found, index) => {
    const expected = reference[index];
    assert.ok(Math.abs(Date.parse(found.instant) - expected.time) <= 60_000, `closest approach ${found.instant}`);
    assert.ok(Math.abs(found.separation - expected.separation) <= 0.01, `separation ${found.separation} vs ${expected.separation}`);
    assert.ok(Math.abs(Date.parse(found.from) - expected.start) <= 60_000, `window start ${found.from}`);
    assert.ok(Math.abs(Date.parse(found.to) - expected.end) <= 60_000, `window end ${found.to}`);
    assert.ok(Date.parse(found.from) <= Date.parse(found.instant) && Date.parse(found.instant) <= Date.parse(found.to));
    // The preview's own disc (celestialBodies + refraction) lands on the mark at the listed instant.
    const bodies = celestialBodies({ latitude: input.latitude, longitude: input.longitude, instant: found.instant });
    const disc = bodies[input.target.body];
    const drawn = direction(disc.azimuth, apparentElevation(disc.elevation, input.refraction));
    assert.ok(Math.abs(angle(drawn, direction(input.target.azimuth, input.target.elevation)) - found.separation) < 0.003);
  });
  return result;
}

test("找时间：富士山顶的太阳与月亮，12 个月内与独立逐分钟采样一致，试看时刻的预览圆面落在标记处", () => {
  const from = Date.parse("2026-11-12T15:00:00Z"), to = from + 365 * DAY;
  const sun = compare({ ...yamanaka, refraction: "standard", target: { body: "sun", ...summit }, tolerance: 0.25 }, from, to);
  assert.deepEqual(sun.alignments.map((a) => a.instant.slice(0, 10)), ["2027-02-12", "2027-10-30"]);
  assert.ok(sun.alignments.every((a) => a.sky === "day" && a.illuminated === null));
  // A wider tolerance gives the Moon several passes and both offsets within it.
  const moon = compare({ ...yamanaka, refraction: "standard", target: { body: "moon", ...summit }, tolerance: 1 }, from, to);
  assert.ok(moon.alignments.length >= 3, `moon passes: ${moon.alignments.length}`);
  assert.ok(moon.alignments.every((a) => a.illuminated >= 0 && a.illuminated <= 1));
  // Without refraction the same mark is reached at other instants.
  compare({ ...yamanaka, refraction: "none", target: { body: "sun", ...summit }, tolerance: 0.25 }, from, to);
});

test("找时间：东京低空月出方向，12 个月内与独立采样一致", () => {
  const from = Date.parse("2026-11-12T15:00:00Z"), to = from + 365 * DAY;
  const result = compare({ latitude: 35.7101, longitude: 139.8107, refraction: "standard", target: { body: "moon", azimuth: 100, elevation: 1.5 }, tolerance: 0.5 }, from, to);
  assert.ok(result.alignments.length >= 1);
  assert.ok(result.alignments.every((a) => Math.abs(a.elevation - 1.5) < 0.6));
});

test("无解原因：高纬度冬季太阳达不到期望高度，极昼时太阳始终高于期望高度，方位不符时给出最接近的一次", () => {
  const tromso = { latitude: 69.65, longitude: 18.96, refraction: "standard", tolerance: 0.25 };
  const winter = solveAlignment({ ...tromso, target: { body: "sun", azimuth: 180, elevation: 10 } }, Date.parse("2026-11-20T00:00:00Z"), Date.parse("2027-01-10T00:00:00Z"));
  assert.equal(winter.reason, "too-high");
  assert.equal(winter.alignments.length, 0);
  assert.ok(winter.reach.max < 10, `highest ${winter.reach.max}`);
  const summer = solveAlignment({ ...tromso, target: { body: "sun", azimuth: 0, elevation: 0.5 } }, Date.parse("2026-06-10T00:00:00Z"), Date.parse("2026-06-30T00:00:00Z"));
  assert.equal(summer.reason, "too-low");
  assert.ok(summer.reach.min > 1.5, `lowest ${summer.reach.min}`);
  // Tokyo: the Sun never sets at azimuth 330°, but it reaches 5°; the nearest pass is named.
  const missed = solveAlignment({ latitude: 35.68, longitude: 139.77, refraction: "standard", tolerance: 0.25, target: { body: "sun", azimuth: 330, elevation: 5 } },
    Date.parse("2026-11-12T00:00:00Z"), Date.parse("2027-11-12T00:00:00Z"));
  assert.equal(missed.reason, "missed");
  assert.ok(missed.nearest && missed.nearest.separation > 1);
  assert.match(missed.nearest.offset, /^偏/);
});

test("月相与天空条件筛选按次计数，太阳不受天空条件筛选", () => {
  const from = Date.parse("2026-11-12T15:00:00Z"), to = from + 365 * DAY;
  const base = { ...yamanaka, refraction: "standard", target: { body: "moon", ...summit }, tolerance: 1 };
  const all = solveAlignment(base, from, to);
  const bright = solveAlignment({ ...base, phase: [0.5, 1] }, from, to);
  const dim = all.alignments.filter((a) => a.illuminated < 0.5).length;
  assert.equal(bright.alignments.length, all.alignments.length - dim);
  assert.equal(bright.filtered.phase, dim);
  const night = solveAlignment({ ...base, sky: ["night"] }, from, to);
  assert.equal(night.alignments.length, all.alignments.filter((a) => a.sky === "night").length);
  assert.equal(night.filtered.sky, all.alignments.length - night.alignments.length);
  assert.equal(solveAlignment({ ...base, phase: [2, 3] }, from, to).reason, "filtered");
  const sun = solveAlignment({ ...yamanaka, refraction: "standard", target: { body: "sun", ...summit }, tolerance: 0.25, sky: ["night"], phase: [0.9, 1] }, from, to);
  assert.equal(sun.alignments.length, 2);
  // Sky bands follow the timeline's golden and blue hour.
  assert.equal(skyCondition(lightPeriodBounds.golden[1]), "day");
  assert.equal(skyCondition(0), "golden");
  assert.equal(skyCondition(-5), "blue");
  assert.equal(skyCondition(-10), "twilight");
  assert.equal(skyCondition(-18.5), "night");
});

test("容差边界：容差恰好落在最接近距离两侧时结果出现与消失；分段扫描与一次扫描相同", () => {
  const from = Date.parse("2027-02-10T00:00:00Z"), to = Date.parse("2027-02-15T00:00:00Z");
  const input = { ...yamanaka, refraction: "standard", target: { body: "sun", ...summit }, tolerance: 0.25 };
  const [pass] = solveAlignment(input, from, to).alignments;
  const ratio = pass.separation / pass.diameter;
  assert.equal(solveAlignment({ ...input, tolerance: ratio * 1.01 }, from, to).alignments.length, 1);
  assert.equal(solveAlignment({ ...input, tolerance: ratio * 0.99 }, from, to).alignments.length, 0);
  const whole = solveAlignment(input, from, to, 10 * DAY);
  const sliced = finishAlignment(input, [scanAlignment(input, from, from + 2.3 * DAY), scanAlignment(input, from + 2.3 * DAY, to)], from, to);
  assert.deepEqual(sliced.alignments.map((a) => a.instant), whole.alignments.map((a) => a.instant));
});

test("画面点与方向互逆，标记轮廓以期望位置为中心，视高度换算与折射模型一致", () => {
  const view = { azimuth: 244, pitch: 8, focalLength: 200, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
  for (const [x, y] of [[0, 0], [0.6, -0.4], [-0.9, 0.8]]) {
    const found = frameDirection(view, x, y);
    const back = projectDirection(view, direction(found.azimuth, found.elevation));
    assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9);
  }
  const centre = frameDirection(view, 0, 0);
  assert.ok(Math.abs(centre.azimuth - 244) < 1e-9 && Math.abs(centre.elevation - 8) < 1e-9);
  const outline = markOutline(view, { body: "moon", azimuth: 244.2, elevation: 8.1 });
  const middle = projectDirection(view, direction(244.2, 8.1));
  const meanX = outline.reduce((sum, p) => sum + p.x, 0) / outline.length, meanY = outline.reduce((sum, p) => sum + p.y, 0) / outline.length;
  assert.ok(Math.abs(meanX - middle.x) < 1e-4 && Math.abs(meanY - middle.y) < 1e-4);
  assert.equal(markOutline({ ...view, azimuth: 64 }, { body: "moon", azimuth: 244.2, elevation: 8.1 }), null);
  for (const apparent of [-0.2, 0, 1, 5, 30]) {
    const geometric = geometricElevation(apparent, "standard");
    assert.ok(Math.abs(apparentElevation(geometric, "standard") - apparent) < 1e-6, `${apparent}`);
  }
  assert.equal(geometricElevation(3, "none"), 3);
});
