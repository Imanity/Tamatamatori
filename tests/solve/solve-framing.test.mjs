import test from "node:test";
import assert from "node:assert/strict";
import { aimAt, frameDirection } from "../../src/domain/solve/alignment.ts";
import { findPositions, pointPlan } from "../../src/domain/solve/position-alignment.ts";
import { blockedMinutes, mergeCandidates, rangeCandidates } from "../../src/domain/solve/range-alignment.ts";
import { skyCondition } from "../../src/domain/solve/alignment.ts";
import { sunPosition } from "../../src/domain/core/ephemeris.ts";
import { initialPlan } from "../../src/domain/core/plan.ts";
import { parseSolve } from "../../src/domain/solve/solve.ts";
import { tilePixel, tileSampler } from "../../src/domain/core/terrain.ts";
import { LINE_TILE_LIMIT, lineTiles } from "../../src/io/elevation.ts";
import { destination } from "../../src/domain/core/map.ts";

const rad = Math.PI / 180;
const R = 6_371_008.8;
const skytree = { latitude: 35.71004508243534, longitude: 139.81071889400482, height: 634 };
const day = (date) => Date.parse(`${date}T00:00:00+09:00`);
const base = (body, date, extra = {}) => ({ body, target: skytree, start: day(date), end: day(date) + 86_400_000, refraction: "standard", cameraHeight: 1.6, maxDistance: 30_000, ...extra });
const separation = (a, b) => {
  const u = [Math.cos(a.elevation * rad) * Math.sin(a.azimuth * rad), Math.cos(a.elevation * rad) * Math.cos(a.azimuth * rad), Math.sin(a.elevation * rad)];
  const v = [Math.cos(b.elevation * rad) * Math.sin(b.azimuth * rad), Math.cos(b.elevation * rad) * Math.cos(b.azimuth * rad), Math.sin(b.elevation * rad)];
  return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) / rad;
};
function haversine(a, b) {
  const dphi = (b.latitude - a.latitude) * rad, dlambda = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

test("画面位置：相机方向反解后，目标方向投影回给定的画面位置（焦距、横竖幅、画幅比与仰角）；够不到的位置向中心收拢", () => {
  let checked = 0;
  for (const focalLength of [14, 35, 200, 1000])
    for (const orientation of ["landscape", "portrait"])
      for (const aspectRatio of ["3:2", "16:9", "1:1"])
        for (const elevation of [-0.25, 3, 20, 55])
          for (const frame of [{ x: 0, y: 0 }, { x: 0, y: 1 / 3 }, { x: -0.6, y: -1 / 3 }, { x: 0.9, y: 0.85 }]) {
            const lens = { focalLength, sensor: "full-frame", aspectRatio, orientation };
            const target = { azimuth: 303.7, elevation };
            const aim = aimAt(lens, target, frame);
            assert.ok(aim.azimuth >= 0 && aim.azimuth < 360 && Math.abs(aim.pitch) <= 90);
            const back = frameDirection({ ...lens, ...aim }, frame.x, frame.y);
            const miss = separation(back, target);
            if (miss > 1e-5) {
              // Only a place past the zenith is out of reach: then a place on the way to the centre shows it.
              assert.ok(focalLength === 14 && elevation === 55 && frame.y !== 0, `${focalLength} ${orientation} ${aspectRatio} ${elevation} ${JSON.stringify(frame)}: ${miss}`);
              continue;
            }
            checked++;
          }
  assert.ok(checked > 370, `${checked} exact`);
  // The centre is the direction itself; straight below the centre keeps the bearing and looks up.
  const lens = { focalLength: 200, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
  assert.deepEqual(aimAt(lens, { azimuth: 120, elevation: 4 }, { x: 0, y: 0 }), { azimuth: 120, pitch: 4 });
  const lower = aimAt(lens, { azimuth: 120, elevation: 4 }, { x: 0, y: 1 / 3 });
  assert.ok(Math.abs(lower.azimuth - 120) < 1e-9 && lower.pitch > 4);
  // Out of reach at a wide top corner: the result still frames the direction (closer to the centre).
  const wide = { focalLength: 14, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
  const corner = aimAt(wide, { azimuth: 10, elevation: 70 }, { x: -0.9, y: -0.9 });
  const misses = Array.from({ length: 2001 }, (_, step) => separation(frameDirection({ ...wide, ...corner }, -0.00045 * step, -0.00045 * step), { azimuth: 10, elevation: 70 }));
  assert.ok(Math.min(...misses) < 0.05, `closest ${Math.min(...misses)}° on the way to the corner`);
  assert.ok(misses.at(-1) > 1, "the corner itself is out of reach");
});

test("画面位置：试看与就地转动写入的方向让目标顶部落在画面位置上，机位与时刻不变", () => {
  const result = findPositions(base("moon", "2026-11-25"), () => 0);
  const point = result.points[Math.floor(result.points.length / 2)];
  const plan = { ...initialPlan, focalLength: 200 };
  const centred = pointPlan(plan.layers, point, "moon");
  const framed = pointPlan(plan.layers, point, "moon", { frame: { x: 0.25, y: 1 / 3 }, lens: plan });
  assert.deepEqual([framed.latitude, framed.longitude, framed.instant], [centred.latitude, centred.longitude, centred.instant]);
  assert.deepEqual([centred.azimuth, centred.pitch], [Math.round(point.azimuth * 1e4) / 1e4, Math.round(point.elevation * 1e4) / 1e4]);
  const seen = frameDirection({ ...plan, azimuth: framed.azimuth, pitch: framed.pitch }, 0.25, 1 / 3);
  assert.ok(separation(seen, point) < 1e-3, "the top (and the Moon on it) sits at the frame place, to the rounding of the fields");
});

test("可拍时段：被地形挡住的分钟不列出并单独计数，一段在被挡处拆开；找机位另按天空条件分段，键名含中点", () => {
  // A 300 m ring 5.0–5.3 km around the tower, flat elsewhere (as in the solver's own ridge test).
  const ring = (latitude, longitude) => {
    const distance = haversine(skytree, { latitude, longitude });
    return distance >= 5000 && distance <= 5300 ? 300 : 0;
  };
  const result = findPositions(base("moon", "2026-11-25"), ring);
  const blocked = result.points.filter((point) => point.sight === "blocked");
  assert.ok(blocked.length > 20);
  const plain = rangeCandidates({ body: "moon" }, result.points);
  const listed = plain.flatMap((candidate) => candidate.points);
  assert.equal(listed.length, result.points.length - blocked.length, "every unblocked minute is listed once");
  assert.ok(listed.every((point) => point.sight !== "blocked"));
  assert.equal(blockedMinutes(result.points), new Set(blocked.map((point) => point.time)).size);
  for (const candidate of plain) {
    for (let index = 1; index < candidate.points.length; index++)
      assert.equal(candidate.points[index].time - candidate.points[index - 1].time, 60_000, "a stretch has no gap");
    assert.equal(candidate.clear, 1, "the whole ring has terrain data");
  }
  // The blocked stretch splits a line: the minutes either side are separate rows.
  const branches = new Set(plain.map((candidate) => candidate.points[0].branch));
  assert.ok(plain.length > branches.size, "a blocked middle makes two rows of one line");
  // Splitting by sky: each row has one sky condition, the same as every minute of it.
  const split = rangeCandidates({ body: "moon" }, result.points, { splitSky: true });
  assert.ok(split.length > plain.length);
  for (const candidate of split.filter((_, index) => index % 3 === 0))
    for (const point of [candidate.points[0], candidate.points.at(-1)])
      assert.equal(skyCondition(sunPosition({ latitude: point.latitude, longitude: point.longitude, instant: new Date(point.time).toISOString() }).elevation), candidate.sky);
  assert.ok(split.every((candidate) => candidate.key.endsWith(`@${candidate.middle.time}/${candidate.middle.latitude.toFixed(6)}/${candidate.middle.longitude.toFixed(6)}`)));
  // Pieces of one line (split by the ridge or the sky) are never merged into each other.
  for (const branch of new Set(split.map((candidate) => candidate.points[0].branch)))
    assert.equal(mergeCandidates(split.filter((candidate) => candidate.points[0].branch === branch)).merged, 0);
  // Everything blocked: nothing listed, all counted.
  const wall = findPositions(base("moon", "2026-11-25", { maxDistance: 10_000 }), (latitude, longitude) => {
    const distance = haversine(skytree, { latitude, longitude });
    return distance >= 100 && distance <= 190 ? 5000 : 0;
  });
  assert.ok(wall.points.length > 0);
  assert.equal(rangeCandidates({ body: "moon" }, wall.points).length, 0);
  assert.ok(blockedMinutes(wall.points) > 0);
});

test("读取范围：对齐线经过的 z12 瓦片超过上限时降一级读取，仍超过再降；按键名推断级别，平地采样一致", () => {
  const disc = (radius) => Array.from({ length: 360 }, (_, bearing) => Array.from({ length: Math.ceil(radius / 500) }, (_, step) => destination(skytree, bearing, (step + 1) * 500))).flat();
  const near = lineTiles(disc(8_000));
  assert.equal(near.zoom, 12);
  assert.ok(near.keys.size <= LINE_TILE_LIMIT);
  const wide = lineTiles(disc(30_000));
  assert.ok(wide.zoom < 12 && wide.keys.size <= LINE_TILE_LIMIT, `z${wide.zoom}: ${wide.keys.size}`);
  assert.ok([...wide.keys.keys()].every((key) => key.startsWith(`${wide.zoom}/`)));
  assert.throws(() => lineTiles(disc(400_000)), /超过单次 40 块的上限，请缩小最远距离/);
  // A flat 100 m tile set at that zoom samples 100 m everywhere inside it.
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([128, 100, 0, 255], index);
  const tiles = new Map([...wide.keys.keys()].map((key) => [key, { width: 512, height: 512, pixels }]));
  const sampler = tileSampler(tiles);
  assert.equal(sampler(skytree.latitude, skytree.longitude), 100);
  const edge = destination(skytree, 45, 29_000);
  assert.equal(sampler(edge.latitude, edge.longitude), 100);
  assert.ok(Math.abs(tilePixel(12, 35.71) - 15.5) < 0.1 && Math.abs(tilePixel(11, 35.71) - 31.0) < 0.1);
});

test("推算请求的画面位置：只用于找机位与两者都找，x、y 在 0—1 之间", () => {
  const range = { format: "tamatamatori.solve", version: 1, kind: "range", body: "moon", target: { landmark: "tokyo-skytree" } };
  assert.deepEqual(parseSolve({ ...range, frame: { x: 0.5, y: 0.333 } }).request.frame, { x: 0.5, y: 0.333 });
  assert.equal(parseSolve(range).request.frame, undefined);
  assert.equal(parseSolve(range).defaults.includes("frame"), false, "the centre is not a default worth listing");
  const errors = (value) => (parseSolve(value).ok ? [] : parseSolve(value).errors).join("\n");
  assert.match(errors({ ...range, frame: { x: 1.2, y: 0.5 } }), /frame\.x：应在 0～1 之间，收到 1\.2/);
  assert.match(errors({ ...range, frame: { x: 0.5 } }), /frame\.y：应为数字/);
  assert.match(errors({ ...range, frame: { x: 0.5, y: 0.5, z: 1 } }), /frame\.z：未知字段/);
  assert.match(errors({ ...range, frame: [0.5, 0.5] }), /frame：应为对象/);
  assert.match(errors({ format: "tamatamatori.solve", version: 1, kind: "time", body: "sun", mark: { azimuth: 1, elevation: 1 }, frame: { x: 0.5, y: 0.5 } }), /frame：kind 为 "time" 时不使用该字段/);
});
