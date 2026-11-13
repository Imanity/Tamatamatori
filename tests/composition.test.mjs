import test from "node:test";
import assert from "node:assert/strict";
import {
  classify, conditionsAt, frameGap, lineItems, ndc, pairGap, passes, scanPair, toleranceDiameters, tryPatch, windowItem, windowMark,
} from "../src/domain/composition.ts";
import { aimAt, frameDirection, solveAlignment } from "../src/domain/alignment.ts";
import { projectDirection } from "../src/domain/celestial-projection.ts";
import { direction } from "../src/domain/ephemeris.ts";
import { findPositions, skyAt, toRay } from "../src/domain/position-alignment.ts";
import { rangeDays, rangeTrack, solveRangeDay } from "../src/domain/range-alignment.ts";
import { compositionOf, parseAnySolve, requestOf, solveJson2, solvePlan2 } from "../src/domain/solve.ts";
import { describeSolve2, resultRows } from "../src/domain/solve-report.ts";
import { resultEvents } from "../src/domain/solve-calendar.ts";
import { initialPlan, localDateTime } from "../src/domain/plan.ts";
import { parseShotText } from "../src/domain/shot.ts";

const lens = { focalLength: 105, sensor: "full-frame", aspectRatio: "3:2", orientation: "portrait" };
const fuji = { kind: "ground", id: "g", name: "富士山顶", latitude: 35.3606, longitude: 138.7274, height: 0, reference: "ground", frame: { x: 0.5, y: 2 / 3 }, base: null, tolerance: 0.03 };
const skytree = { kind: "ground", id: "s", name: "晴空塔", landmark: "tokyo-skytree", latitude: 35.71004508243534, longitude: 139.81071889400482, height: 634, reference: "ground", frame: { x: 0.5, y: 0.35 }, base: null, tolerance: 0.03 };
const sky = (body, frame = { x: 0.5, y: 0.5 }, tolerance = 0.03) => ({ kind: "sky", id: body, body, frame, tolerance });
const free = { mode: "free", maxDistance: 30_000 };
const fixed = (aim = null) => ({ mode: "fixed", latitude: 35.4172, longitude: 138.8729, aim });
const days = (count = 30) => ({ mode: "range", date: "2026-11-13", days: count });
const at = (targets, extra = {}) => classify({ targets, camera: free, time: days(), filters: [], ...extra });
const separation = (a, b) => {
  const u = direction(a.azimuth, a.elevation), v = direction(b.azimuth, b.elevation);
  return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * 180 / Math.PI;
};

test("可解性：每种目标、范围与筛选的组合给出结果形式或原因", () => {
  const cases = [
    [at([]), null, /先加目标/],
    [at([sky("sun")]), null, /只有一个天体/],
    [at([fuji]), null, /只有一个地面点/],
    [at([fuji, { ...skytree, id: "t" }]), null, /两个地面点作主约束将在第三步支持/],
    [at([fuji, sky("sun"), sky("moon")]), null, /目前最多 2 个目标/],
    [at([fuji, sky("moon")], { filters: [{ kind: "moonDown" }] }), null, /目标里有月亮/],
    [at([{ ...fuji, base: 0.9 }, sky("sun")]), null, /底部位置只用于距地表至少 10 m 的点/],
    [at([{ ...skytree, base: 0.3 }, sky("moon")]), null, /底部应在顶部下方/],
    [at([fuji, sky("sun")]), "lines", /机位线/],
    [at([fuji, sky("sun")], { time: { mode: "instant", instant: "2026-11-13T00:00:00Z" } }), "points", /机位点/],
    [at([fuji, sky("sun")], { camera: fixed() }), "windows", /由“富士山顶”定朝向/],
    [at([fuji, sky("sun")], { camera: fixed(), time: { mode: "instant", instant: "2026-11-13T00:00:00Z" } }), null, /机位与时刻都已固定/],
    [at([sky("sun")], { camera: fixed({ azimuth: 200, pitch: 10 }) }), "windows", /机位与朝向固定/],
    [at([fuji, sky("sun")], { camera: fixed({ azimuth: 200, pitch: 10 }) }), null, /固定朝向时，地面点/],
    [at([sky("sun"), sky("moon")], { camera: fixed({ azimuth: 200, pitch: 10 }) }), null, /固定朝向时只支持一个天体/],
    [at([sky("dso-mel022"), sky("moon")]), "windows", /与机位基本无关（月亮略有视差）/],
    [at([sky("dso-mel022"), sky("moon")], { time: { mode: "instant", instant: "2026-11-13T00:00:00Z" } }), null, /时刻固定时无从搜索/],
  ];
  for (const [result, shape, message] of cases) {
    assert.equal(result.shape, shape, result.message);
    assert.equal(!!result.strategy, shape !== null);
    assert.match(result.message, message);
  }
  assert.equal(at([fuji, sky("sun")]).strategy.kind, "line");
  assert.equal(at([sky("dso-mel022"), sky("moon")]).strategy.kind, "pair");
});

test("推算请求 v2：缺省、往返与带路径的报错；v1 三种求法的转换", () => {
  const read = (value) => parseAnySolve(value, lens);
  const minimal = read({ format: "tamatamatori.solve", version: 2, targets: [{ type: "ground", landmark: "tokyo-skytree" }, { type: "body", body: "moon" }] });
  assert.equal(minimal.ok, true, JSON.stringify(minimal.errors));
  assert.deepEqual(minimal.request.targets[0], { type: "ground", landmark: "tokyo-skytree", latitude: skytree.latitude, longitude: skytree.longitude, height: 634, name: "晴空塔", reference: "ground", frame: { x: 0.5, y: 0.5 }, base: null, tolerance: 0.03 });
  assert.deepEqual(minimal.request.camera, { mode: "free", maxDistance: 30000 });
  assert.deepEqual(minimal.request.time, { mode: "range", days: 30 });
  assert.deepEqual(minimal.defaults, ["lens", "camera", "time", "timeZone"]);
  assert.deepEqual(read(JSON.parse(solveJson2(minimal.request))).request, minimal.request);
  // A sea-level height keeps its own range; a foot needs a height above the ground.
  assert.equal(read({ format: "tamatamatori.solve", version: 2, targets: [{ type: "ground", latitude: 35.36, longitude: 138.73, height: 3776, reference: "sea" }, { type: "body", body: "sun" }] }).ok, true);
  const errors = (value) => (read(value).ok ? "" : read(value).errors.join("\n"));
  const base = { format: "tamatamatori.solve", version: 2 };
  assert.match(errors({ ...base, targets: [{ type: "ground", latitude: 35, longitude: 138, height: 1200 }] }), /targets\[0\]\.height：应在 0～1000 之间/);
  assert.match(errors({ ...base, targets: [{ type: "ground", latitude: 35, longitude: 138, frame: { x: 0.5, y: 0.6 }, base: 0.4 }] }), /targets\[0\]\.base：底部应在 frame\.y 下方/);
  assert.match(errors({ ...base, targets: [{ type: "body", body: "pluto" }] }), /targets\[0\]\.body：应为/);
  assert.match(errors({ ...base, targets: [{ type: "body", body: "sun" }], camera: { mode: "free" }, time: { mode: "range", days: 1096 } }), /time\.days：机位不固定时最多 365 天/);
  assert.match(errors({ ...base, targets: [{ type: "body", body: "sun" }], time: { mode: "instant", instant: "tomorrow" } }), /time\.instant：应为 UTC 时刻/);
  assert.match(errors({ ...base, version: 3, targets: [] }), /更新版本的应用（版本 3）/);
  // Version 1: 找时间 becomes a fixed camera and direction with the body at the centre; its tolerance a share of the frame.
  const v1 = { format: "tamatamatori.solve", version: 1 };
  const time = read({ ...v1, kind: "time", body: "sun", mark: { azimuth: 244.63, elevation: 10.74 }, camera: { latitude: 35.4, longitude: 138.8, heightAboveGround: 2 }, date: "2026-11-04", days: 365, tolerance: 0.25 });
  assert.equal(time.from, 1);
  assert.deepEqual(time.request.camera, { mode: "fixed", latitude: 35.4, longitude: 138.8, aim: { azimuth: 244.63, pitch: 10.74 }, heightAboveGround: 2 });
  assert.ok(Math.abs(time.request.targets[0].tolerance * 19.45 - 0.25 * 2 * 0.2666) < 0.002, `${time.request.targets[0].tolerance}`);
  assert.deepEqual(time.request.filters, []);
  const position = read({ ...v1, kind: "position", body: "moon", target: { landmark: "tokyo-skytree" }, frame: { x: 0.5, y: 0.4 }, date: "2026-11-25", maxDistance: 20000 });
  assert.deepEqual(position.request.targets.map((target) => target.frame), [{ x: 0.5, y: 0.4 }, { x: 0.5, y: 0.4 }]);
  assert.deepEqual(position.request.camera, { mode: "free", maxDistance: 20000 });
  assert.deepEqual(position.request.time, { mode: "range", date: "2026-11-25", days: 1 });
  const range = read({ ...v1, kind: "range", body: "moon", target: { landmark: "tokyo-skytree" }, days: 90, share: 0.3, phase: [0.9, 1] });
  assert.equal(range.request.targets[0].base, 0.8);
  assert.deepEqual(range.request.filters, [{ kind: "moonLit", range: [0.9, 1] }]);
  // The panel's conditions as a request and back.
  const composition = compositionOf(range.request, initialPlan);
  assert.equal(composition.time.date, localDateTime(initialPlan.instant, initialPlan.timeZone).slice(0, 10), "an absent date is the opener's shooting date");
  const written = requestOf(composition, lens, { timeZone: "Asia/Tokyo" });
  assert.deepEqual(read(JSON.parse(solveJson2(written))).request, written);
  // The plan a request opens on: lens, fixed camera and aim, a one-day date.
  const opened = solvePlan2(time.request, initialPlan);
  assert.deepEqual([opened.latitude, opened.longitude, opened.cameraHeight, opened.azimuth, opened.pitch], [35.4, 138.8, 2, 244.63, 10.74]);
  const lensed = solvePlan2({ ...minimal.request, lens: { focalLength: 400, sensor: "aps-c", aspectRatio: "16:9", orientation: "portrait" } }, initialPlan);
  assert.deepEqual([lensed.focalLength, lensed.sensor, lensed.aspectRatio, lensed.orientation], [400, "aps-c", "16:9", "portrait"]);
  assert.equal(localDateTime(solvePlan2(position.request, initialPlan).instant, "Asia/Tokyo"), "2026-11-25T17:00");
  assert.deepEqual(solvePlan2(minimal.request, initialPlan), initialPlan, "nothing to change");
  // In words, for the link preview and the report.
  const rows = describeSolve2(range.request);
  assert.deepEqual(rows.map((row) => row.label), ["镜头", "目标 1", "目标 2", "机位", "时间", "时区", "筛选"]);
  assert.match(rows[1].value, /晴空塔 · 35\.71005, 139\.81072 · 距地表 634 m · 画面中心 · 容差 ±3% · 底部自上 80% · 已接入地标（tokyo-skytree）/);
  assert.match(rows.at(-1).value, /月亮亮面 90%—100%/);
});

test("固定机位：由地面点定朝向后，求天体经过画面位置的时刻，与直接按该方向的找时间一致", () => {
  const camera = { latitude: 35.4172, longitude: 138.8729 };
  const eye = { ...camera, ellipsoidalHeight: 830 + 1.6 }, top = { latitude: fuji.latitude, longitude: fuji.longitude, ellipsoidalHeight: 3776 };
  const ray = toRay(eye, top);
  const ground = { ...fuji, frame: { x: 0.45, y: 0.6 } }, moon = sky("moon", { x: 0.58, y: 0.42 });
  const aim = aimAt(lens, ray, ndc(ground.frame));
  const mark = windowMark(moon, lens, aim);
  // The aim puts the summit at its place, and the mark is where the Moon's place points.
  const summit = projectDirection({ ...lens, ...aim }, ray.ray);
  assert.ok(Math.abs(summit.x + 0.1) < 1e-9 && Math.abs(summit.y - 0.2) < 1e-9);
  const placed = projectDirection({ ...lens, ...aim }, direction(mark.azimuth, mark.elevation));
  assert.ok(Math.abs(placed.x - 0.16) < 1e-9 && Math.abs(placed.y + 0.16) < 1e-9);
  const input = { ...camera, refraction: "standard", target: { body: "moon", ...mark }, tolerance: toleranceDiameters(moon, lens) };
  const from = Date.parse("2026-11-13T00:00:00+09:00"), to = from + 365 * 86_400_000;
  const result = solveAlignment(input, from, to);
  assert.ok(result.alignments.length > 0);
  for (const found of result.alignments) {
    const best = Date.parse(found.instant), seen = skyAt("moon", best, camera.latitude, camera.longitude, "standard");
    const gap = projectDirection({ ...lens, ...aim }, direction(seen.azimuth, seen.elevation));
    assert.ok(frameGap(gap, { x: 0.16, y: -0.16 }, lens) <= 0.03 * 1.1, `${found.instant}: ${gap.x}, ${gap.y}`);
  }
  // A result row tries out the instant, the camera and the aim; the Moon's layer goes on.
  const item = windowItem({ start: from, end: from + 60_000, best: from + 30_000, deviation: 0.01 }, camera, aim, "2026-11-13");
  const patch = tryPatch(item, { lens, ground, bodies: ["moon"] }, { ...initialPlan.layers, moon: false });
  assert.deepEqual([patch.latitude, patch.longitude, patch.instant, patch.layers.moon], [35.4172, 138.8729, "2026-11-12T15:00:30Z", true]);
  assert.ok(Math.abs(patch.azimuth - aim.azimuth) < 1e-4 && Math.abs(patch.pitch - aim.pitch) < 1e-4);
});

test("两个天体：分钟扫描的时段与独立逐分钟检查一致；试看跟随第一个天体对准", () => {
  const input = { first: sky("dso-mel022", { x: 0.6, y: 0.4 }), second: sky("moon", { x: 0.4, y: 0.6 }, 0.05), lens: { ...lens, focalLength: 135, orientation: "landscape" }, latitude: 35.4172, longitude: 138.8729, refraction: "standard" };
  const from = Date.parse("2026-11-13T00:00:00+09:00"), to = from + 365 * 86_400_000;
  const windows = scanPair(input, from, to);
  assert.ok(windows.length > 0, "once in the year the Moon sits lower left of the Pleiades");
  // Independent check: every minute inside a window is within the tolerance, the minutes around it are not.
  for (const window of windows) {
    for (let time = window.start; time <= window.end; time += 60_000) assert.ok(pairGap(input, time) <= 0.05, new Date(time).toISOString());
    for (const outside of [window.start - 60_000, window.end + 60_000]) {
      const gap = pairGap(input, outside);
      assert.ok(gap === null || gap > 0.05, new Date(outside).toISOString());
    }
    assert.equal(pairGap(input, window.best), window.deviation);
  }
  // Brute force over one window's day finds no other minutes.
  const day = Math.floor(windows[0].best / 86_400_000) * 86_400_000;
  const inside = [];
  for (let time = day; time < day + 86_400_000; time += 60_000) { const gap = pairGap(input, time); if (gap !== null && gap <= 0.05) inside.push(time); }
  const covered = windows.flatMap((window) => Array.from({ length: (window.end - window.start) / 60_000 + 1 }, (_, index) => window.start + index * 60_000)).filter((time) => time >= day && time < day + 86_400_000);
  assert.deepEqual(inside, covered);
  // The try-out keeps the first body at its place at any minute of the window.
  const window = windows[0];
  const item = windowItem(window, { latitude: input.latitude, longitude: input.longitude }, { azimuth: 0, pitch: 0 }, "2027-01-01");
  const basis = { lens: input.lens, ground: null, bodies: ["dso-mel022", "moon"], follow: { body: "dso-mel022", frame: input.first.frame, refraction: "standard" } };
  for (const time of [window.start, window.end]) {
    const patch = tryPatch(item, basis, initialPlan.layers, time);
    const pleiades = skyAt("dso-mel022", time, input.latitude, input.longitude, "standard");
    const seen = projectDirection({ ...input.lens, azimuth: patch.azimuth, pitch: patch.pitch }, direction(pleiades.azimuth, pleiades.elevation));
    assert.ok(Math.abs(seen.x - 0.2) < 1e-3 && Math.abs(seen.y + 0.2) < 1e-3);
    assert.equal(patch.layers.deepSky, true);
    assert.equal(patch.layers.moon, true);
  }
});

test("机位线的结果：筛选去掉不符合的分钟并计数，按天分段；底部位置按实际投影保留，试看把顶部与天体放到各自位置", () => {
  // The Moon over Skytree on flat ground for three days, the top at 35% and the Moon just above it.
  const target = { latitude: skytree.latitude, longitude: skytree.longitude, height: 634 };
  const frames = { lens, target: ndc({ x: 0.5, y: 0.35 }), body: ndc({ x: 0.5, y: 0.3 }) };
  const input = { body: "moon", target, refraction: "standard", cameraHeight: 1.6, lens, share: null, minDistance: 200, maxDistance: 30_000, frames, base: { y: ndc({ x: 0, y: 0.7 }).y, tolerance: 0.03 } };
  const span = rangeDays("2026-11-24", 3, "Asia/Tokyo");
  const points = span.flatMap((day) => solveRangeDay(input, day, rangeTrack(input, day), () => 0));
  assert.ok(points.length > 20, `${points.length}`);
  for (const point of points) {
    // The foot, seen with the camera aimed so the top sits at 35%, is within 3% of 70%.
    const aim = aimAt(lens, point, frames.target);
    const foot = projectDirection({ ...lens, ...aim }, toRay({ latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: 1.6 }, { ...target, ellipsoidalHeight: 0 }).ray);
    assert.ok(Math.abs((foot.y + 1) / 2 - 0.7) <= 0.03 + 1e-9, `${foot.y}`);
    assert.ok(Math.abs(point.share - ((foot.y + 1) / 2 - 0.35)) < 1e-9);
  }
  const all = lineItems(points, { body: "moon", filters: [], splitSky: false, share: 0.35 });
  const evening = [{ kind: "sky", sky: ["blue", "twilight", "night"] }];
  const dark = lineItems(points, { body: "moon", filters: evening, splitSky: false, share: 0.35 });
  assert.ok(dark.items.length > 0 && dark.filtered > 0, `${dark.items.length} rows, ${dark.filtered} filtered`);
  const listed = (items) => items.reduce((sum, item) => sum + item.points.length, 0);
  assert.ok(listed(dark.items) < listed(all.items) && listed(dark.items) + dark.filtered <= points.length);
  for (const item of dark.items) {
    for (const point of item.points) assert.ok(passes(evening, conditionsAt(point.time, point.latitude, point.longitude)));
    assert.ok(item.deviation <= 0.03 + 1e-9);
    assert.ok(item.share[0] >= 0.32 && item.share[1] <= 0.38);
  }
  // A try-out of a row: the top at 35% and the Moon at 30%.
  const item = dark.items[0];
  const patch = tryPatch(item, { lens, ground: { ...skytree, frame: { x: 0.5, y: 0.35 } }, bodies: ["moon"] }, initialPlan.layers);
  const point = item.points.find((entry) => entry.time === item.best);
  const view = { ...lens, azimuth: patch.azimuth, pitch: patch.pitch };
  const top = projectDirection(view, direction(point.azimuth, point.elevation));
  const moon = skyAt("moon", item.best, point.latitude, point.longitude, "standard");
  const seen = projectDirection(view, direction(moon.azimuth, moon.elevation));
  assert.ok(Math.abs(top.y - frames.target.y) < 2e-3 && Math.abs(top.x) < 2e-3);
  assert.ok(Math.abs(seen.y - frames.body.y) < 2e-3 && Math.abs(seen.x) < 2e-3);
  // Report rows and calendar events, one per row, each linking to its try-out.
  const { header, rows } = resultRows(dark.items, "Asia/Tokyo");
  assert.deepEqual(header, ["日期", "时段", "机位（试看处）", "目标方向与距离", "最大偏差", "天空", "月亮"]);
  assert.equal(rows.length, dark.items.length);
  const events = resultEvents(dark.items, { plan: initialPlan, body: "moon", place: "晴空塔", site: "https://example.org/", basis: { lens, ground: { ...skytree, frame: { x: 0.5, y: 0.35 } }, bodies: ["moon"] }, names: "月亮" });
  assert.equal(events.length, dark.items.length);
  assert.equal(events[0].summary, "月亮 · 晴空塔");
  const opened = parseShotText(events[0].url);
  assert.equal(opened.plan.instant, patch.instant);
  assert.equal(opened.plan.azimuth, patch.azimuth);
});

test("偏移的机位线与重合时一致：两者画面位置相同就是天体落在顶部；四分之一画面外的偏移也逐分钟成立", () => {
  const target = { latitude: skytree.latitude, longitude: skytree.longitude, height: 634 };
  const base = { body: "moon", target, start: Date.parse("2026-11-25T00:00:00+09:00"), end: Date.parse("2026-11-26T00:00:00+09:00"), refraction: "standard", cameraHeight: 1.6, maxDistance: 30_000 };
  const plain = findPositions(base, () => 0);
  const same = findPositions({ ...base, frames: { lens, target: { x: 0.2, y: 0.1 }, body: { x: 0.2, y: 0.1 } } }, () => 0);
  assert.deepEqual(same.points.map((point) => [point.time, point.latitude.toFixed(7)]), plain.points.map((point) => [point.time, point.latitude.toFixed(7)]));
  const frames = { lens, target: { x: 0, y: 0.3 }, body: { x: 0.5, y: -0.25 } };
  const offset = findPositions({ ...base, frames }, () => 0);
  assert.ok(offset.points.length > 100);
  for (const point of offset.points.filter((_, index) => index % 7 === 0)) {
    const aim = aimAt(lens, point, frames.target);
    const moon = skyAt("moon", point.time, point.latitude, point.longitude, "standard");
    const seen = projectDirection({ ...lens, ...aim }, direction(moon.azimuth, moon.elevation));
    assert.ok(Math.hypot(seen.x - 0.5, seen.y + 0.25) < 1e-4, `${new Date(point.time).toISOString()}: ${seen.x}, ${seen.y}`);
    assert.ok(separation(frameDirection({ ...lens, ...aim }, 0.5, -0.25), moon) < 1e-3);
  }
});

test("预筛：按目标处的天空与月亮条件先跳过分钟，精确筛选后的结果与不预筛时完全相同", () => {
  const target = { latitude: skytree.latitude, longitude: skytree.longitude, height: 634 };
  const frames = { lens, target: ndc({ x: 0.5, y: 0.35 }), body: ndc({ x: 0.5, y: 0.35 }) };
  const base = { body: "moon", target, refraction: "standard", cameraHeight: 1.6, lens, share: null, minDistance: 200, maxDistance: 30_000, frames };
  const span = rangeDays("2026-11-20", 6, "Asia/Tokyo");
  for (const filters of [[{ kind: "sky", sky: ["blue", "twilight"] }], [{ kind: "moonLit", range: [0.9, 1] }], [{ kind: "sky", sky: ["golden"] }, { kind: "moonLit", range: [0.75, 1] }]]) {
    const prefilter = Object.fromEntries(filters.map((filter) => (filter.kind === "sky" ? ["sky", filter.sky] : ["moonLit", filter.range])));
    const solve = (input) => span.flatMap((day) => solveRangeDay(input, day, rangeTrack(input, day), () => 0));
    const full = lineItems(solve(base), { body: "moon", filters, splitSky: false, share: null });
    const quick = solve({ ...base, prefilter });
    const fast = lineItems(quick, { body: "moon", filters, splitSky: false, share: null });
    assert.ok(full.items.length > 0, JSON.stringify(filters));
    // Branch numbers depend on which minutes were solved; the stretches themselves (minutes and places) are the same.
    const stretch = (item) => `${item.day} ${item.start}–${item.end} ${item.key.split("@")[1]}`;
    assert.deepEqual(fast.items.map(stretch), full.items.map(stretch), JSON.stringify(filters));
    assert.ok(quick.length < solve(base).length, "fewer minutes are solved");
  }
});
