import test from "node:test";
import assert from "node:assert/strict";
import { DARK_SUN_ELEVATION, bodyKind, bodyLayer, bodyName, fixedBodies, fixedBody, isSolveBody, sizeWord } from "../../src/domain/sky/sky-targets.ts";
import { bodyRadius, solveAlignment, targetElevationRange } from "../../src/domain/solve/alignment.ts";
import { bodyTrack, pointPlan, restoredLayers, skyAt, triedLayers } from "../../src/domain/solve/position-alignment.ts";
import { skyReference } from "../../src/domain/sky/starfield.ts";
import { sunPosition } from "../../src/domain/core/ephemeris.ts";
import { initialPlan } from "../../src/domain/core/plan.ts";
import { parseSolve } from "../../src/domain/solve/solve.ts";

const fuji = { latitude: 35.4172, longitude: 138.8729 };
const angle = (a, b) => {
  const r = Math.PI / 180;
  const v = (p) => [Math.cos(p.elevation * r) * Math.sin(p.azimuth * r), Math.cos(p.elevation * r) * Math.cos(p.azimuth * r), Math.sin(p.elevation * r)];
  const [x, y] = [v(a), v(b)];
  return Math.acos(Math.min(1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2])) / r;
};

test("固定方向天体：银心、90 颗有名亮星与 15 个深空目标，id 唯一；名称、图层、标记大小与类别", () => {
  assert.equal(fixedBodies.length, 1 + 90 + 15);
  assert.equal(new Set(fixedBodies.map((body) => body.id)).size, fixedBodies.length);
  assert.equal(fixedBodies[0].id, "galactic-center");
  assert.equal(fixedBodies[1].name, "天狼星", "stars by magnitude");
  assert.deepEqual([bodyName("galactic-center"), bodyName("hyg-90979"), bodyName("dso-ngc0224"), bodyName("moon")], ["银心", "织女星", "仙女座星系", "月亮"]);
  assert.deepEqual(["sun", "moon", "galactic-center", "hyg-90979", "dso-ngc0224"].map(bodyLayer), ["sun", "moon", "milkyWay", "stars", "deepSky"]);
  assert.deepEqual(["galactic-center", "hyg-90979", "dso-ngc0224"].map(bodyKind), ["core", "star", "deepSky"]);
  assert.deepEqual([bodyRadius("sun"), bodyRadius("galactic-center"), bodyRadius("hyg-90979")], [0.2666, 1, 0.25]);
  assert.ok(Math.abs(bodyRadius("dso-ngc0224") - fixedBody("dso-ngc0224").radius) < 1e-12 && bodyRadius("dso-ngc0224") > 1, "M31 by its long axis");
  assert.deepEqual([sizeWord("moon"), sizeWord("hyg-90979")], ["视直径", "标记直径"]);
  assert.ok(isSolveBody("hyg-90979") && !isSolveBody("hyg-1") && !isSolveBody("venus"));
});

test("位置与预览一致：银心与亮星的方位、高度同 skyReference 相差不到 0.02°（只差自行）", () => {
  for (const instant of ["2026-08-15T12:00:00Z", "2026-12-01T15:30:00Z"]) {
    const sky = skyReference({ ...fuji, instant });
    const time = Date.parse(instant);
    const core = skyAt("galactic-center", time, fuji.latitude, fuji.longitude, "none");
    assert.ok(angle(core, sky.core) < 0.005, `core ${angle(core, sky.core)}`);
    for (const id of ["hyg-32263", "hyg-90979", "hyg-11734", "hyg-80519", "hyg-97338"]) {
      const point = sky.points.find((item) => item.id === id);
      const solved = skyAt(id, time, fuji.latitude, fuji.longitude, "none");
      assert.ok(angle(solved, point) < 0.02, `${id} ${angle(solved, point)}`);
    }
  }
});

test("找时间：银心经过暗夜里的期望位置时给出该时刻，白天经过的被筛掉并计入天空条件", () => {
  const at = Date.parse("2026-08-15T12:00:00Z"); // 21:00 JST
  const mark = skyAt("galactic-center", at, fuji.latitude, fuji.longitude, "standard");
  assert.ok(mark.elevation > targetElevationRange[0]);
  const input = { ...fuji, refraction: "standard", target: { body: "galactic-center", ...mark }, tolerance: 0.25 };
  const result = solveAlignment(input, at - 3 * 86_400_000, at + 3 * 86_400_000);
  const found = result.alignments.find((item) => Math.abs(Date.parse(item.instant) - at) < 120_000);
  assert.ok(found, JSON.stringify(result.alignments.map((item) => item.instant)));
  assert.ok(found.separation < 0.01);
  assert.equal(found.diameter, 2, "the 2° mark");
  for (const item of result.alignments) assert.ok(item.sunElevation <= DARK_SUN_ELEVATION, item.instant);
  // The same direction is reached four minutes earlier each day; in spring the pass is by day.
  const spring = Date.parse("2026-04-01T00:00:00Z");
  const daytime = solveAlignment(input, spring, spring + 5 * 86_400_000);
  assert.equal(daytime.alignments.length, 0);
  assert.ok(daytime.filtered.sky > 0);
  assert.equal(daytime.reason, "filtered");
});

test("找机位：固定方向天体只取太阳低于 −6° 的分钟；试看开启对应图层，返回推算前连同星座一起恢复", () => {
  const input = {
    body: "hyg-90979", target: { ...fuji, height: 100 }, start: Date.parse("2026-08-15T00:00:00Z"), end: Date.parse("2026-08-16T00:00:00Z"),
    refraction: "standard", cameraHeight: 1.6, maxDistance: 30_000,
  };
  const track = bodyTrack(input);
  assert.ok(track.length > 100);
  for (const sample of track)
    assert.ok(sunPosition({ ...fuji, instant: new Date(sample.time).toISOString() }).elevation <= DARK_SUN_ELEVATION);
  const daylight = bodyTrack({ ...input, body: "sun" });
  assert.ok(daylight.some((sample) => sunPosition({ ...fuji, instant: new Date(sample.time).toISOString() }).elevation > 0));
  const layers = { ...initialPlan.layers, stars: false, constellations: false, milkyWay: false };
  const tried = pointPlan(layers, { ...fuji, time: track[0].time, azimuth: 10, elevation: 20 }, "hyg-90979");
  assert.equal(tried.layers.stars, true);
  assert.equal(pointPlan(layers, { ...fuji, time: 0, azimuth: 0, elevation: 0 }, "galactic-center").layers.milkyWay, true);
  const before = triedLayers(layers);
  const after = restoredLayers({ ...tried.layers, constellations: true }, before);
  assert.deepEqual({ stars: after.stars, constellations: after.constellations, milkyWay: after.milkyWay }, { stars: false, constellations: false, milkyWay: false });
});

test("推算请求：body 接受银心、亮星与深空 id；月相只用于月亮，天空条件不用于太阳", () => {
  const base = { format: "tamatamatori.solve", version: 1, kind: "time", mark: { azimuth: 180, elevation: 20 } };
  assert.equal(parseSolve({ ...base, body: "galactic-center", sky: ["night"] }).ok, true);
  assert.deepEqual(parseSolve({ ...base, body: "hyg-90979" }).request.body, "hyg-90979");
  assert.deepEqual(parseSolve({ format: "tamatamatori.solve", version: 1, kind: "range", body: "dso-ngc0224", target: { landmark: "tokyo-skytree" }, sky: ["night", "twilight"] }).request.sky, ["twilight", "night"]);
  assert.match(parseSolve({ ...base, body: "hyg-1" }).errors[0], /body：应为 "sun"、"moon"、"galactic-center"，或亮星（hyg-…）、深空目标（dso-…）的 id/);
  assert.match(parseSolve({ ...base, body: "galactic-center", phase: [0, 1] }).errors.join(), /phase：只用于月亮/);
  assert.match(parseSolve({ ...base, body: "sun", sky: ["night"] }).errors.join(), /sky：只用于月亮与固定方向天体/);
});

test("两者都找的 Worker 只认消息带来的固定天体：没有目录也能规划；缺少时回报错误", async () => {
  const { rangeWorker } = await import("../../src/io/range-worker.ts");
  const { rangeDays, rangeDistances } = await import("../../src/domain/solve/range-alignment.ts");
  const lens = { focalLength: 200, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
  const tower = { latitude: 35.71, longitude: 139.81, height: 634 };
  const distances = rangeDistances(tower, 0.3, lens, 30_000);
  // An id the catalogue does not have: only the message can tell the worker where it is (the Galactic Centre's coordinates).
  const input = { body: "hyg-999999", target: tower, refraction: "standard", cameraHeight: 1.6, lens, share: distances.share,
    minDistance: distances.minDistance, maxDistance: distances.maxDistance };
  const days = rangeDays("2026-08-01", 3, "Asia/Tokyo");
  const failed = [];
  rangeWorker((reply) => failed.push(reply))({ type: "plan", id: 1, input, days });
  assert.equal(failed[0].type, "error");
  assert.match(failed[0].message, /未知天体：hyg-999999/);
  const replies = [];
  rangeWorker((reply) => replies.push(reply))({ type: "plan", id: 2, input, days, fixed: [{ id: "hyg-999999", kind: "core", ra: 17.7611, dec: -29.0078, radius: 1 }] });
  assert.equal(replies[0].type, "planned");
  assert.ok(replies[0].minutes > 0);
});
