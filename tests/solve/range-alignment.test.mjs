import test from "node:test";
import assert from "node:assert/strict";
import {
  altitudeCeiling,
  filterCandidates,
  rangeCandidates,
  rangeCorridor,
  rangeDays,
  rangeDistances,
  rangeTrack,
  reachableSectors,
  shareBand,
  shareOf,
  solveRange,
  solveRangeDay,
} from "../../src/domain/solve/range-alignment.ts";
import { bodyTrack } from "../../src/domain/solve/position-alignment.ts";
import { projectDirection } from "../../src/domain/core/celestial-projection.ts";
import { direction } from "../../src/domain/core/ephemeris.ts";
import { ellipsoidalRay } from "../../src/domain/core/geodesy.ts";
import { terrainTile, tileKey } from "../../src/domain/core/terrain.ts";
import { rangeWorker } from "../../src/io/range-worker.ts";

const rad = Math.PI / 180, R = 6_371_008.8;
const skytree = { latitude: 35.71004508243534, longitude: 139.81071889400482, height: 634 };
const lens = { focalLength: 200, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
const flat = () => 0;
const haversine = (a, b) => {
  const dphi = (b.latitude - a.latitude) * rad, dlambda = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const ring = (latitude, longitude) => { const d = haversine(skytree, { latitude, longitude }); return d >= 5000 && d <= 5300 ? 300 : 0; };
function setup(share = 0.3, body = "moon", extra = {}) {
  const distances = rangeDistances(skytree, share, lens, 30_000);
  return { body, target: skytree, refraction: "standard", cameraHeight: 1.6, lens, share: distances.share, minDistance: distances.minDistance, maxDistance: distances.maxDistance, ...extra };
}
const days = rangeDays("2026-11-12", 14, "Asia/Tokyo");

test("两者都找：主体占比与独立的投影一致；距离带两端在平地上给出 ±20% 的占比", () => {
  const input = setup();
  const points = solveRange(input, days.slice(0, 3), flat);
  assert.ok(points.length > 10);
  for (const point of points) {
    // Aim at the top, as a try-out does, and project the base: its offset from the centre is the share.
    const view = { ...lens, azimuth: point.azimuth, pitch: point.elevation };
    const ray = ellipsoidalRay({ latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: point.cameraGround + 1.6 }, { ...skytree, ellipsoidalHeight: 0 });
    const base = projectDirection(view, [ray[0], ray[1], ray[2]].map((v) => v / Math.hypot(...ray)));
    // The ellipsoid normal at the target tilts the base by ~1e-5° sideways; negligible.
    assert.ok(Math.abs(base.x) < 1e-4, "base straight below the top");
    assert.ok(Math.abs(base.y / 2 - point.share) < 1e-6, `${base.y / 2} vs ${point.share}`);
    assert.ok(point.share >= 0.24 - 1e-9 && point.share <= 0.36 + 1e-9);
  }
  const band = shareBand(634, 0.3, lens);
  for (const [distance, expected] of [[band.near, 0.36], [band.far, 0.24]]) {
    const eye = { latitude: skytree.latitude - distance / 111_000, longitude: skytree.longitude, ellipsoidalHeight: 1.6 };
    const top = ellipsoidalRay(eye, { ...skytree, ellipsoidalHeight: 634 }), bottom = ellipsoidalRay(eye, { ...skytree, ellipsoidalHeight: 0 });
    const angle = (Math.asin(top[2] / Math.hypot(...top)) - Math.asin(bottom[2] / Math.hypot(...bottom))) / rad;
    assert.ok(Math.abs(shareOf(angle, lens) - expected) < 0.01, `${distance}: ${shareOf(angle, lens)}`);
  }
  // A low target has no size: plain distances.
  assert.deepEqual(rangeDistances({ ...skytree, height: 5 }, 0.3, lens, 20_000), { share: null, angle: null, near: 200, far: 20_000, minDistance: 200, maxDistance: 20_000 });
});

test("两者都找：按高度上限预筛不漏解（平地与环形山脊），扇区覆盖所有候选方位，DEM 走廊覆盖所有解", () => {
  const input = setup();
  for (const sampler of [flat, ring]) {
    for (const day of days.slice(0, 7)) {
      const filtered = solveRangeDay(input, day, rangeTrack(input, day), sampler);
      const full = solveRangeDay(input, day, bodyTrack({ ...input, start: day.start, end: day.end }), sampler);
      assert.deepEqual(filtered.map((p) => [p.time, p.distance.toFixed(3)]), full.map((p) => [p.time, p.distance.toFixed(3)]), day.day);
    }
  }
  assert.ok(Math.abs(altitudeCeiling(input) - Math.atan((634 + 300) / input.minDistance) / rad) < 1e-12);
  const tracks = days.map((day) => rangeTrack(input, day));
  const sectors = reachableSectors(tracks);
  const points = solveRange(input, days, flat);
  const tiles = new Set(rangeCorridor(input, tracks).map((point) => tileKey(terrainTile(point))));
  for (const point of points) {
    const bearing = (point.azimuth + 180) % 360;
    assert.ok(sectors.some(([from, to]) => (bearing >= from - 0.2 && bearing <= to + 0.2) || (bearing + 360 >= from - 0.2 && bearing + 360 <= to + 0.2)), `bearing ${bearing}`);
    assert.ok(tiles.has(tileKey(terrainTile(point))), "camera tile loaded");
  }
});

test("两者都找：候选按天与连续分钟分段，月相与天空条件按次筛选；Worker 消息处理与主线程结果一致", () => {
  const input = setup();
  const points = solveRange(input, days, flat);
  const candidates = rangeCandidates(input, points);
  assert.ok(candidates.length >= days.length, `${candidates.length} candidates`);
  for (const candidate of candidates) {
    assert.ok(candidate.points.every((p, i, all) => p.day === candidate.day && (i === 0 || p.time - all[i - 1].time === 60_000)));
    assert.ok(candidate.near <= candidate.middle.distance && candidate.middle.distance <= candidate.far);
    assert.ok(candidate.share[0] >= 0.24 - 1e-9 && candidate.share[1] <= 0.36 + 1e-9);
    assert.ok(candidate.illuminated >= 0 && candidate.illuminated <= 1);
    assert.equal(candidate.clear, 1);
  }
  assert.equal(points.length, candidates.reduce((sum, c) => sum + c.points.length, 0));
  const bright = filterCandidates(candidates, { phase: [0.5, 1] });
  assert.equal(bright.filtered.phase, candidates.filter((c) => c.illuminated < 0.5).length);
  assert.equal(bright.kept.length + bright.filtered.phase, candidates.length);
  const night = filterCandidates(candidates, { sky: ["night"] });
  assert.equal(night.kept.length, candidates.filter((c) => c.sky === "night").length);
  assert.equal(filterCandidates(rangeCandidates({ ...input, body: "sun" }, solveRange({ ...input, body: "sun" }, days.slice(0, 3), flat)), { sky: ["night"], phase: [0.9, 1] }, "sun").filtered.sky, 0, "the Sun is not filtered");
  // Flat Terrarium tiles (0 m) under the corridor, handled like the worker does.
  const corridor = rangeCorridor(input, days.slice(0, 3).map((day) => rangeTrack(input, day)));
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 128; pixels[i + 3] = 255; }
  const tiles = new Map(corridor.map((point) => [tileKey(terrainTile(point)), { width: 512, height: 512, pixels }]));
  const replies = [];
  const handle = rangeWorker((reply) => replies.push(reply));
  handle({ type: "plan", id: 3, input, days: days.slice(0, 3) });
  assert.equal(replies[0].type, "planned");
  assert.deepEqual(replies[0].corridor, corridor);
  handle({ type: "solve", id: 3, tiles: [...tiles] });
  assert.deepEqual(replies.map((r) => r.type), ["planned", "day", "day", "day", "done"]);
  const fromWorker = replies.filter((r) => r.type === "day").flatMap((r) => r.points);
  assert.deepEqual(fromWorker.map((p) => [p.time, p.distance.toFixed(2)]), solveRange(input, days.slice(0, 3), flat).map((p) => [p.time, p.distance.toFixed(2)]));
  const failed = [];
  const broken = rangeWorker((reply) => failed.push(reply));
  broken({ type: "solve", id: 4, tiles: [] });
  assert.deepEqual(failed.at(-1), { id: 4, type: "error", message: "推算计划缺失，请重试" });
});
