import test from "node:test";
import assert from "node:assert/strict";
import {
  classify, conditionsAt, daySpans, extraGap, placeItem, filterResult, frameGap, frameSeparation, lineItems, ndc, nightSearch, pairGap, passes, prefilterOf, scanPair, shootingDay, templates,
  toleranceAngle, toleranceDiameters, tryPatch, windowItem, windowMark, zenithBrightness,
} from "../../src/domain/composition.ts";
import { aimAt, frameDirection, solveAlignment } from "../../src/domain/alignment.ts";
import { projectDirection } from "../../src/domain/celestial-projection.ts";
import { direction } from "../../src/domain/ephemeris.ts";
import { findPositions, highestNear, lineOfSight, SKYLINE_RADIUS, skyAt, skylineTop, terrainGrid, toRay, travel } from "../../src/domain/position-alignment.ts";
import { altitudeCeiling, rangeDays, rangeTrack, skySeparation, solveRangeDay } from "../../src/domain/range-alignment.ts";
import { evaluatePair, pairSight, solveGroundPair } from "../../src/domain/ground-pair.ts";
import { fixedBodies } from "../../src/domain/sky-targets.ts";
import { compositionOf, parseAnySolve, requestOf, solveJson2, solvePlan2 } from "../../src/domain/solve.ts";
import { describeSolve2, resultRows } from "../../src/domain/solve-report.ts";
import { resultEvents } from "../../src/domain/solve-calendar.ts";
import { initialPlan, localDateTime } from "../../src/domain/plan.ts";
import { parseShotText } from "../../src/domain/shot.ts";

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
    [at([fuji, { ...skytree, id: "t" }]), "places", /结果为机位：两个地面点的相对位置只取决于机位，与时间无关/],
    [at([fuji, { ...skytree, id: "t" }], { camera: fixed() }), null, /机位固定时，两个地面点在画面中的位置已由机位决定/],
    [at([fuji, { ...skytree, id: "t" }, { ...skytree, id: "u", latitude: 35.6586, longitude: 139.7454 }]), "places", /另有 1 个地面点按容差检查/],
    [at([fuji, { ...skytree, id: "t" }], { filters: [{ kind: "moonDown" }] }), "places", /筛选条件与时间有关，这里不用/],
    [at([fuji, sky("sun"), sky("moon"), sky("dso-mel022"), sky("dso-ngc0224")]), null, /最多 4 个目标/],
    [at([fuji, sky("moon"), sky("dso-mel022")]), "lines", /机位线.*另有 1 个目标按容差逐分钟检查/],
    [at([fuji, { ...skytree, id: "t" }, sky("moon"), sky("dso-mel022")]), "lines", /另有 2 个目标/],
    [at([fuji, sky("moon"), sky("dso-mel022")], { camera: fixed() }), "windows", /由“富士山顶”定朝向.*另有 1 个目标/],
    [at([sky("dso-mel022"), sky("moon"), sky("dso-ngc0224")]), "windows", /另有 1 个目标/],
    [at([fuji, sky("moon")], { filters: [{ kind: "moonDown" }] }), null, /目标里有月亮/],
    [at([{ ...fuji, base: 0.9 }, sky("sun")]), null, /底部位置只用于距地表至少 10 m 的点/],
    [at([{ ...skytree, base: 0.3 }, sky("moon")]), null, /底部应在顶部下方/],
    [at([fuji, sky("sun")]), "lines", /机位线/],
    [at([fuji, sky("sun")], { time: { mode: "instant", instant: "2026-11-13T00:00:00Z" } }), "points", /机位点/],
    [at([fuji, sky("sun")], { camera: fixed() }), "windows", /由“富士山顶”定朝向/],
    [at([fuji, sky("sun")], { camera: fixed(), time: { mode: "instant", instant: "2026-11-13T00:00:00Z" } }), null, /机位与时刻都已固定/],
    [at([sky("sun")], { camera: fixed({ azimuth: 200, pitch: 10 }) }), "windows", /机位与朝向固定/],
    [at([fuji, sky("sun")], { camera: fixed({ azimuth: 200, pitch: 10 }) }), null, /固定朝向时，地面点/],
    [at([sky("sun"), sky("moon")], { camera: fixed({ azimuth: 200, pitch: 10 }) }), "windows", /机位与朝向固定.*另有 1 个目标/],
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
  // The first ground point and the first body lead; the rest, in their order, are checked.
  const three = at([sky("dso-mel022"), fuji, sky("moon"), { ...skytree, id: "t" }]).strategy;
  assert.deepEqual([three.ground.id, three.sky.id, three.extras.map((extra) => extra.id)], ["g", "dso-mel022", ["moon", "t"]]);
  assert.deepEqual(at([sky("dso-mel022"), sky("moon"), sky("sun")]).strategy.extras.map((extra) => extra.id), ["sun"]);
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
  // Up to four targets; 星空可见性 with one of the listed limits, read, written and described.
  const four = read({ ...base, targets: [{ type: "ground", landmark: "tokyo-skytree" }, { type: "body", body: "moon" }, { type: "body", body: "dso-mel022" }, { type: "ground", latitude: 35.6586, longitude: 139.7454, height: 333 }], filters: [{ type: "darkSky", limit: 21.3 }] });
  assert.equal(four.ok, true, JSON.stringify(four.errors));
  assert.deepEqual(four.request.filters, [{ kind: "darkSky", limit: 21.3 }]);
  assert.deepEqual(read(JSON.parse(solveJson2(four.request))).request, four.request);
  assert.deepEqual(JSON.parse(solveJson2(four.request)).filters, [{ type: "darkSky", limit: 21.3 }]);
  assert.deepEqual(requestOf(compositionOf(four.request, initialPlan), lens, {}).filters, four.request.filters);
  assert.match(describeSolve2(four.request).at(-1).value, /星空可见性：天顶不亮于 21\.3 mag\/arcsec²/);
  assert.deepEqual(describeSolve2(four.request).map((row) => row.label).slice(1, 5), ["目标 1", "目标 2", "目标 3", "目标 4"]);
  assert.match(errors({ ...base, targets: [...four.request.targets.map(() => ({ type: "body", body: "sun" })), { type: "body", body: "moon" }] }), /targets：目前最多 4 个目标，收到 5 个/);
  assert.match(errors({ ...base, targets: [{ type: "body", body: "sun" }], filters: [{ type: "darkSky", limit: 21 }] }), /filters\[0\]\.limit：天顶天空亮度上限（mag\/arcsec²），取值 21\.7 \/ 21\.3 \/ 20\.5 \/ 19\.5，收到 21/);
  assert.match(errors({ ...base, targets: [{ type: "body", body: "sun" }], filters: [{ type: "darkSky" }] }), /filters\[0\]\.limit/);
  assert.match(errors({ ...base, targets: [{ type: "body", body: "sun" }], filters: [{ type: "glow" }] }), /"darkSky" 之一/);
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

test("星空可见性：天顶亮度由自然天光、光污染与月光合成，只在天文夜成立；没有光污染数据单独计", () => {
  const night = { sunElevation: -30, sky: "night", moonAzimuth: 0, moonElevation: -20, moonLit: 1 };
  const natural = zenithBrightness(night, 0);
  assert.ok(Math.abs(natural - 22.0) < 0.05, `${natural}`);
  // Artificial light as bright as the natural sky makes it 0.75 mag brighter; a full Moon high up much brighter.
  assert.ok(Math.abs(zenithBrightness(night, 0.174) - (natural - 2.5 * Math.log10(2))) < 0.01);
  const moonlit = zenithBrightness({ ...night, moonElevation: 50, moonAzimuth: 180 }, 0);
  assert.ok(moonlit < 20, `${moonlit}`);
  assert.ok(zenithBrightness({ ...night, moonElevation: 50, moonAzimuth: 180, moonLit: 0.1 }, 0) > moonlit);
  const filter = [{ kind: "darkSky", limit: 21.3 }];
  assert.equal(filterResult(filter, night, 0), "pass");
  assert.equal(filterResult(filter, night, 0.3), "fail");
  assert.equal(filterResult(filter, { ...night, sunElevation: -15 }, 0), "fail", "astronomical twilight");
  assert.equal(filterResult(filter, night, null), "missing");
  assert.equal(filterResult([...filter, { kind: "moonDown" }], { ...night, moonElevation: 5 }, null), "fail", "a failing filter wins over missing data");
  assert.equal(passes(filter, night), true, "not read yet: not checked");
});

// The Moon just above Skytree's top, 24 mm landscape, on flat ground for two nights.
const wide = { focalLength: 24, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
const wideFrames = { lens: wide, target: ndc({ x: 0.5, y: 0.6 }), body: ndc({ x: 0.5, y: 0.5 }) };
const wideInput = { body: "moon", target: { latitude: skytree.latitude, longitude: skytree.longitude, height: 634 }, refraction: "standard", cameraHeight: 1.6, lens: wide, share: null, minDistance: 200, maxDistance: 30_000, frames: wideFrames };
const wideSolve = (input) => rangeDays("2026-11-27", 2, "Asia/Tokyo").flatMap((day) => solveRangeDay(input, day, rangeTrack(input, day), () => 0));
const wideContext = { lens: wide, refraction: "standard", cameraHeight: 1.6, sampler: () => 0 };
const wideAim = (point) => aimAt(wide, point, wideFrames.target);
/** A third target where a named star stands at one dark minute: the frame place it has there. */
function starInFrame(points) {
  const dark = points.filter((point) => point.sight !== "blocked" && skyAt("sun", point.time, point.latitude, point.longitude, "none").elevation < -12);
  const chosen = dark[Math.floor(dark.length / 2)];
  const view = { ...wide, ...wideAim(chosen) };
  for (const body of fixedBodies.filter((entry) => entry.kind === "star")) {
    const seen = skyAt(body.id, chosen.time, chosen.latitude, chosen.longitude, "standard");
    const place = seen.elevation > 5 ? projectDirection(view, direction(seen.azimuth, seen.elevation)) : null;
    if (place && Math.abs(place.x) < 0.7 && Math.abs(place.y) < 0.7 && place.y < 0.3) return { dark, chosen, extra: sky(body.id, { x: (place.x + 1) / 2, y: (place.y + 1) / 2 }, 0.03) };
  }
  throw new Error("no named star in the frame");
}
const withExtra = (points, extra) => points.flatMap((point) => {
  if (point.sight === "blocked") return [];
  const gap = extraGap([extra], { latitude: point.latitude, longitude: point.longitude, ground: 0 }, point.time, wideAim(point), wideContext);
  return gap === null ? [] : [{ ...point, gap }];
});

test("第三、四个目标：天体与地面点按试看朝向逐分钟检查，与独立投影一致；结果是两目标结果的子集", () => {
  const points = wideSolve(wideInput).filter((point) => point.sight !== "blocked");
  const { dark, chosen, extra } = starInFrame(points);
  assert.ok(dark.length > 30, `${dark.length}`);
  let kept = 0;
  for (const point of points) {
    const aim = wideAim(point);
    const gap = extraGap([extra], { latitude: point.latitude, longitude: point.longitude, ground: 0 }, point.time, aim, wideContext);
    // Independently: the star's angle from the ray through its frame place, against the tolerance as an angle.
    const seen = skyAt(extra.body, point.time, point.latitude, point.longitude, "standard");
    const sun = skyAt("sun", point.time, point.latitude, point.longitude, "none").elevation;
    const angle = separation(frameDirection({ ...wide, ...aim }, 2 * extra.frame.x - 1, 2 * extra.frame.y - 1), seen);
    if (gap === null) assert.ok(sun >= -6 || seen.elevation <= 0 || angle > toleranceAngle(0.03, wide) * 0.75, `${new Date(point.time).toISOString()} ${angle}`);
    else {
      kept++;
      assert.ok(sun < -6 && angle <= toleranceAngle(gap, wide) + 1e-6, `${new Date(point.time).toISOString()} ${angle} ${gap}`);
    }
  }
  assert.ok(kept > 0 && kept < points.length, `${kept} of ${points.length}`);
  assert.ok(extraGap([extra], { latitude: chosen.latitude, longitude: chosen.longitude, ground: 0 }, chosen.time, wideAim(chosen), wideContext) < 1e-3);
  // The list with the third target is a subset of the list without it, its deviation the larger of the two.
  const two = lineItems(points, { body: "moon", filters: [], splitSky: false, share: null });
  const three = lineItems(withExtra(points, extra), { body: "moon", filters: [], splitSky: false, share: null });
  const minutes = (items) => new Set(items.flatMap((item) => item.points.map((point) => `${point.time}/${point.latitude.toFixed(6)}`)));
  const all = minutes(two.items);
  assert.ok(three.items.length > 0);
  for (const minute of minutes(three.items)) assert.ok(all.has(minute), minute);
  for (const item of three.items) assert.ok(item.deviation >= Math.max(...item.points.map((point) => point.gap)) - 1e-12);

  // A ground point: in place with open ground, out of place when moved, hidden behind a ridge, unknown without terrain.
  const tower = { kind: "ground", id: "tower", name: "东京塔", latitude: 35.6586, longitude: 139.7454, height: 333, reference: "ground", base: null, tolerance: 0.03 };
  const eye = { latitude: 35.62, longitude: 139.70, ellipsoidalHeight: 1.6 };
  const ray = toRay(eye, { latitude: tower.latitude, longitude: tower.longitude, ellipsoidalHeight: 333 }).ray;
  const placed = { ...tower, frame: { x: 0.3, y: 0.4 } };
  const aim = aimAt(wide, { azimuth: Math.atan2(ray[0], ray[1]) * 180 / Math.PI, elevation: Math.atan2(ray[2], Math.hypot(ray[0], ray[1])) * 180 / Math.PI }, ndc(placed.frame));
  const camera = { latitude: eye.latitude, longitude: eye.longitude, ground: 0 };
  const time = Date.parse("2026-11-27T12:00:00Z");
  assert.ok(extraGap([placed], camera, time, aim, wideContext) < 1e-6);
  assert.equal(extraGap([{ ...placed, frame: { x: 0.36, y: 0.4 } }], camera, time, aim, wideContext), null);
  const ridge = (latitude, longitude) => (Math.abs(latitude - (eye.latitude + tower.latitude) / 2) < 0.003 && Math.abs(longitude - (eye.longitude + tower.longitude) / 2) < 0.003 ? 600 : 0);
  assert.equal(extraGap([placed], camera, time, aim, { ...wideContext, sampler: ridge }), null);
  assert.equal(extraGap([placed], camera, time, aim, { ...wideContext, sampler: () => null }), null);
});

test("第三个天体的预筛：按与主天体的角距跳过分钟，逐分钟检查后的结果与不预筛时相同", () => {
  // The angle between two frame places does not depend on where the camera points.
  const a = { x: 0.2, y: 0.3 }, b = { x: 0.7, y: 0.8 };
  for (const aim of [{ azimuth: 0, pitch: 0 }, { azimuth: 123, pitch: 40 }, { azimuth: 300, pitch: -20 }]) {
    const view = { ...wide, ...aim };
    const one = frameDirection(view, 2 * a.x - 1, 2 * a.y - 1), two = frameDirection(view, 2 * b.x - 1, 2 * b.y - 1);
    assert.ok(Math.abs(skySeparation(one, two) - frameSeparation(wide, a, b)) < 1e-9);
  }
  const full = wideSolve(wideInput);
  const { extra } = starInFrame(full);
  // The panel's pre-filter: a further body is enough, with or without filters; ground points add nothing.
  const moon = sky("moon", { x: 0.5, y: 0.5 });
  const prefilter = prefilterOf([], moon, [extra, { ...skytree, id: "t" }], wide);
  assert.deepEqual(prefilter, { separations: [{ body: extra.body, angle: frameSeparation(wide, extra.frame, moon.frame), tolerance: toleranceAngle(extra.tolerance, wide) }] });
  assert.equal(prefilterOf([], moon, [{ ...skytree, id: "t" }], wide), null);
  assert.deepEqual(prefilterOf([{ kind: "darkSky", limit: 21.3 }, { kind: "moonLit", range: [0, 0.5] }], moon, [], wide), { night: true, moonLit: [0, 0.5] });
  const quick = wideSolve({ ...wideInput, prefilter });
  assert.ok(quick.length < full.length * 0.6, `${quick.length} of ${full.length}`);
  const kept = (points) => withExtra(points, extra).map((point) => `${point.time}/${point.latitude.toFixed(6)}`);
  assert.ok(kept(full).length > 0);
  assert.deepEqual(kept(quick), kept(full));
});

test("夜间搜索按夜分段：中午到次日中午、以傍晚命名；日期行相隔 3 小时以上的时段分开", () => {
  const tokyo = (local) => Date.parse(`${local}+09:00`);
  const nights = rangeDays("2027-01-09", 2, "Asia/Tokyo", "noon");
  assert.deepEqual(nights.map((day) => [day.day, day.start, day.end]), [
    ["2027-01-09", tokyo("2027-01-09T12:00:00"), tokyo("2027-01-10T12:00:00")],
    ["2027-01-10", tokyo("2027-01-10T12:00:00"), tokyo("2027-01-11T12:00:00")],
  ]);
  assert.equal(rangeDays("2027-01-09", 1, "Asia/Tokyo")[0].start, tokyo("2027-01-09T00:00:00"));
  // Which searches are about the night.
  const strategy = (targets, filters = []) => classify({ targets, camera: free, time: days(), filters }).strategy;
  const night = (targets, filters = []) => nightSearch({ filters }, strategy(targets, filters));
  assert.equal(night([fuji, sky("dso-ngc0224")]), true, "a fixed body");
  assert.equal(night([fuji, sky("sun")]), false);
  assert.equal(night([fuji, sky("moon")]), false);
  assert.equal(night([fuji, sky("moon")], [{ kind: "sky", sky: ["twilight", "night"] }]), true);
  assert.equal(night([fuji, sky("moon")], [{ kind: "sky", sky: ["golden", "night"] }]), false);
  assert.equal(night([fuji, sky("moon")], [{ kind: "darkSky", limit: 21.3 }]), true);
  assert.equal(night([sky("dso-mel022"), sky("moon")]), false, "a pair with the Moon");
  assert.equal(night([sky("dso-mel022"), sky("hyg-21368")]), true);
  assert.equal(shootingDay(tokyo("2027-01-10T00:20:00"), "Asia/Tokyo", true), "2027-01-09");
  assert.equal(shootingDay(tokyo("2027-01-10T00:20:00"), "Asia/Tokyo", false), "2027-01-10");
  assert.equal(shootingDay(tokyo("2027-01-10T13:00:00"), "Asia/Tokyo", true), "2027-01-10");
  // A row's spans: an early run and a late one stay apart, near runs join.
  const at = (from, to) => ({ start: tokyo(`2027-01-10T${from}:00`), end: tokyo(`2027-01-10T${to}:00`) });
  assert.deepEqual(daySpans([at("23:30", "23:59"), at("00:00", "00:20"), at("00:40", "01:00")]), [{ start: tokyo("2027-01-10T00:00:00"), end: tokyo("2027-01-10T01:00:00") }, at("23:30", "23:59")]);
});

test("机位最近距离：请求的读取、往返与报错；钻石富士模板最近 10 km、不加黄金时刻", () => {
  const read = (value) => parseAnySolve(value, lens);
  const base = { format: "tamatamatori.solve", version: 2, targets: [{ type: "ground", landmark: "tokyo-skytree" }, { type: "body", body: "moon" }] };
  const near = read({ ...base, camera: { mode: "free", maxDistance: 30000, minDistance: 10000 } });
  assert.equal(near.ok, true, JSON.stringify(near.errors));
  assert.deepEqual(near.request.camera, { mode: "free", maxDistance: 30000, minDistance: 10000 });
  assert.deepEqual(read(JSON.parse(solveJson2(near.request))).request, near.request);
  assert.match(describeSolve2(near.request)[3].value, /不限，离地面目标 10—30 km/);
  // Absent, it stays absent and means no limit (200 m), as before.
  const plain = read({ ...base, camera: { mode: "free", maxDistance: 20000 } });
  assert.deepEqual(plain.request.camera, { mode: "free", maxDistance: 20000 });
  assert.deepEqual(compositionOf(plain.request, initialPlan).camera, { mode: "free", maxDistance: 20000, minDistance: 200 });
  assert.equal(requestOf(compositionOf(near.request, initialPlan), lens, {}).camera.minDistance, 10000);
  const errors = (value) => (read(value).ok ? "" : read(value).errors.join("\n"));
  assert.match(errors({ ...base, camera: { mode: "free", maxDistance: 10000, minDistance: 10000 } }), /camera\.minDistance：应小于 maxDistance（10000），收到 10000/);
  assert.match(errors({ ...base, camera: { mode: "free", minDistance: 3000 } }), /camera\.minDistance：应为 200 \/ 1000 \/ 2000 \/ 5000 \/ 10000 之一/);
  const diamond = templates.find((template) => template.id === "diamond-fuji").build(initialPlan, "2026-11-13");
  assert.deepEqual(diamond.camera, { mode: "free", maxDistance: 30000, minDistance: 10000 });
  assert.deepEqual(diamond.filters, []);
});

test("高度预筛：读到目标所在地形时按顶部海拔放宽，远处看山顶的解不再被当作“天体太高”跳过", () => {
  // A cone 3000 m high on flat ground; the Sun on its summit seen from 10–30 km stands 5.7°–16.7° high.
  const summit = { latitude: 35.36, longitude: 138.73, height: 0 };
  const cone = (latitude, longitude) => Math.max(0, 3000 - 0.3 * Math.hypot((latitude - summit.latitude) * 111_000, (longitude - summit.longitude) * 111_000 * Math.cos(summit.latitude * Math.PI / 180)));
  const frames = { lens, target: { x: 0, y: 0 }, body: { x: 0, y: 0 } };
  const input = { body: "sun", target: summit, refraction: "standard", cameraHeight: 1.6, lens, share: null, minDistance: 10_000, maxDistance: 30_000, frames };
  assert.ok(altitudeCeiling(input) < 3, "the old guess: ground at most 300 m under the target");
  assert.ok(altitudeCeiling({ ...input, targetGround: 3000 }) > 19);
  const day = rangeDays("2026-12-01", 1, "Asia/Tokyo")[0];
  const solve = (extra) => solveRangeDay({ ...input, ...extra }, day, rangeTrack({ ...input, ...extra }, day), cone).filter((point) => point.sight !== "blocked");
  assert.equal(solve({}).length, 0, "every minute skipped before");
  const found = solve({ targetGround: 3000 });
  assert.ok(found.length > 20, `${found.length}`);
  for (const point of found) {
    assert.ok(point.distance >= 10_000 - 1 && point.distance <= 30_000 + 1, `${point.distance}`);
    assert.ok(point.elevation > 5 && point.elevation < 17.5, `${point.elevation}`);
  }
});

// A 3000 m cone with a crater rim 600 m to its north-east (bearings 0°–90°) rising to 2960 m:
// from the north-east the rim, nearer, stands higher than the summit and hides it.
const peak = { latitude: 35.36, longitude: 138.73 };
const metres = (latitude, longitude) => ({ north: (latitude - peak.latitude) * 111_195, east: (longitude - peak.longitude) * 111_195 * Math.cos(peak.latitude * Math.PI / 180) });
const rimmed = (latitude, longitude) => {
  const { north, east } = metres(latitude, longitude);
  const r = Math.hypot(north, east), bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  return Math.max(0, 3000 - 0.3 * r) + (bearing <= 90 ? 140 * Math.exp(-(((r - 600) / 60) ** 2)) : 0);
};
const summitTarget = { ...peak, height: 0 };

/**
 * The platform middle computed independently, the way the field comparison does it
 * (scripts/alignment-validation.mjs): azimuth bins of 25 m at the target's distance,
 * the highest point per bin, the unbroken run within 100 m (as an angle) of the peak.
 */
function platformMiddle(eye, grid, distance, look) {
  const width = 25 / distance * 180 / Math.PI;
  const bins = new Map();
  for (const point of grid) {
    const seen = toRay(eye, { ...point, ellipsoidalHeight: point.ground });
    const across = ((seen.azimuth - look + 540) % 360) - 180, index = Math.round(across / width);
    if (!bins.has(index) || seen.elevation > bins.get(index).elevation) bins.set(index, { across, elevation: seen.elevation });
  }
  const sorted = [...bins].sort((a, b) => a[0] - b[0]);
  let peak = 0;
  sorted.forEach(([, value], index) => { if (value.elevation > sorted[peak][1].elevation) peak = index; });
  const floor = sorted[peak][1].elevation - 100 / distance * 180 / Math.PI;
  // Over at most one bin below the floor.
  const on = (at) => at >= 0 && at < sorted.length && sorted[at][1].elevation >= floor;
  const next = (at, step) => (Math.abs(sorted[at + step]?.[0] - sorted[at][0]) === 1 && on(at + step) ? at + step
    : Math.abs(sorted[at + 2 * step]?.[0] - sorted[at][0]) === 2 && on(at + 2 * step) ? at + 2 * step : null);
  let first = peak, last = peak;
  for (let step = next(first, -1); step !== null; step = next(first, -1)) first = step;
  for (let step = next(last, 1); step !== null; step = next(last, 1)) last = step;
  // A bin at either end of the run within 0.01° of the floor makes that end a coin toss: the middle is then not compared.
  const ambiguous = [first - 2, first - 1, first, last, last + 1, last + 2].some((at) => sorted[at] && Math.abs(sorted[at][1].elevation - floor) < 0.01);
  return { across: (sorted[first][1].across + sorted[last][1].across) / 2, floor, peak: sorted[peak][1].elevation, ambiguous };
}

test("看得见的山顶：每个方向选出平台中点，与独立的按方位分格计算一致；东北方向是更近的火口缘", () => {
  const skyline = skylineTop({ ...summitTarget, skyline: SKYLINE_RADIUS }, rimmed);
  const grid = terrainGrid(peak, SKYLINE_RADIUS, rimmed);
  let ambiguous = 0; // cases further than 25 m from the middle
  for (const bearing of [0, 30, 45, 60, 90, 135, 180, 225, 270, 315])
    for (const distance of [5_000, 15_000, 30_000]) {
      const place = travel(peak, bearing, distance);
      const eye = { ...place, ellipsoidalHeight: rimmed(place.latitude, place.longitude) + 1.6 };
      const chosen = skyline(eye);
      const look = (bearing + 180) % 360;
      const expected = platformMiddle(eye, grid, distance, look);
      const seen = toRay(eye, chosen);
      const across = ((seen.azimuth - look + 540) % 360) - 180;
      // Across the line of sight within 40 m of the middle, and on the platform.
      // Across the line of sight within 25 m of the middle; a run end on the floor may move it further.
      const apart = Math.abs(across - expected.across) * Math.PI / 180 * distance;
      if (apart > 25) {
        assert.ok(expected.ambiguous && apart <= 100, `${bearing}° ${distance} m: ${apart.toFixed(1)} m from the middle`);
        ambiguous++;
      }
      assert.ok(seen.elevation >= expected.floor - 1e-3 && seen.elevation <= expected.peak + 1e-6, `${bearing}° ${distance} m: ${seen.elevation} not in [${expected.floor}, ${expected.peak}]`);
      if (bearing >= 30 && bearing <= 60 && distance >= 15_000) assert.ok(Math.abs(chosen.offset - 600) < 80, `rim from ${bearing}°: ${chosen.offset}`);
    }
  assert.ok(ambiguous <= 1, `${ambiguous} of 30 cases off the middle`);
  // The highest point near a spot 300 m off the summit is the summit; near the rim with a small radius, the rim.
  const off = travel(peak, 200, 300);
  const top = highestNear(off, 500, rimmed);
  assert.ok(Math.hypot(metres(top.latitude, top.longitude).north, metres(top.latitude, top.longitude).east) < 20 && top.ground > 2995, JSON.stringify(top));
  const rim = highestNear(travel(peak, 45, 650), 120, rimmed);
  assert.ok(rim.ground > 2955 && rim.ground < 2965, `${rim.ground}`);
});

test("看得见的最高处：东北的机位线不对准时视线都被火口缘挡住，对准后成立，太阳落在看得见的山顶上", () => {
  // Winter afternoons: the Sun in the south-west, cameras north-east of the cone.
  const input = { body: "sun", target: summitTarget, start: Date.parse("2026-12-15T13:00:00+09:00"), end: Date.parse("2026-12-15T16:30:00+09:00"), refraction: "standard", cameraHeight: 1.6, maxDistance: 30_000, minDistance: 10_000 };
  const northEast = (point) => { const { north, east } = metres(point.latitude, point.longitude); const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360; return bearing > 20 && bearing < 70; };
  const plain = findPositions(input, rimmed).points.filter(northEast);
  assert.ok(plain.length > 10, `${plain.length}`);
  assert.ok(plain.every((point) => point.sight === "blocked"), "the summit hides behind the rim");
  const aimed = findPositions({ ...input, target: { ...summitTarget, skyline: SKYLINE_RADIUS } }, rimmed).points.filter(northEast);
  const clear = aimed.filter((point) => point.sight === "clear");
  assert.ok(clear.length > 10, `${clear.length} of ${aimed.length}`);
  for (const point of clear) {
    assert.ok(Math.abs(point.top.offset - 600) < 60, `${point.top.offset}`);
    const eye = { latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: point.cameraGround + 1.6 };
    // Independently: the Sun's direction from the camera is the direction to the top, which no grid point outdoes.
    const sun = skyAt("sun", point.time, point.latitude, point.longitude, "standard");
    const seen = toRay(eye, point.top);
    assert.ok(separation(seen, sun) < 0.01, `${separation(seen, sun)}`);
    assert.equal(lineOfSight(eye, point.top, rimmed).sight, "clear");
    assert.ok(point.distance >= 10_000 - 1);
  }
});

test("看得见的最高处：请求的读取、往返与报错；钻石富士与深空模板默认对准", () => {
  const read = (value) => parseAnySolve(value, lens);
  const base = { format: "tamatamatori.solve", version: 2 };
  const summit = read({ ...base, targets: [{ type: "ground", latitude: 35.3606, longitude: 138.7274, skyline: true }, { type: "body", body: "sun" }] });
  assert.equal(summit.ok, true, JSON.stringify(summit.errors));
  assert.equal(summit.request.targets[0].skyline, true);
  assert.deepEqual(read(JSON.parse(solveJson2(summit.request))).request, summit.request);
  assert.equal(JSON.parse(solveJson2(summit.request)).targets[0].skyline, true);
  assert.equal(compositionOf(summit.request, initialPlan).targets[0].skyline, true);
  assert.equal(requestOf(compositionOf(summit.request, initialPlan), lens, {}).targets[0].skyline, true);
  assert.match(describeSolve2(summit.request)[1].value, /对准看得见的山顶/);
  const errors = (value) => (read(value).ok ? "" : read(value).errors.join("\n"));
  assert.match(errors({ ...base, targets: [{ type: "ground", landmark: "tokyo-skytree", skyline: true }] }), /targets\[0\]\.skyline：只用于距地表不到 10 m 的点/);
  assert.match(errors({ ...base, targets: [{ type: "ground", latitude: 35.36, longitude: 138.73, height: 3776, reference: "sea", skyline: true }] }), /targets\[0\]\.skyline/);
  assert.match(errors({ ...base, targets: [{ type: "ground", latitude: 35.36, longitude: 138.73, skyline: "yes" }] }), /targets\[0\]\.skyline：应为 true 或 false/);
  assert.equal(read({ ...base, targets: [{ type: "ground", landmark: "tokyo-skytree" }] }).request.targets[0].skyline, undefined);
  for (const id of ["diamond-fuji", "deep-sky-over-summit"]) assert.equal(templates.find((template) => template.id === id).build(initialPlan, "2026-11-13").targets[0].skyline, true, id);
  assert.equal(templates.find((template) => template.id === "moon-on-tower").build(initialPlan, "2026-11-13").targets[0].skyline, undefined);
});

// Two towers on flat ground: 600 m and, 5 km west, 300 m; a 50 mm landscape frame.
const towers = {
  first: { latitude: 35.70, longitude: 139.80, height: 600 }, firstFrame: { x: -0.2, y: -0.4 },
  second: { latitude: 35.70, longitude: 139.745, height: 300 }, secondFrame: { x: 0.3, y: 0.1 }, tolerance: 0.03,
  lens: { focalLength: 50, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" }, cameraHeight: 1.6,
  center: { latitude: 35.70, longitude: 139.80 }, minDistance: 200, maxDistance: 30_000,
};
const level = () => 0;

test("两个地面点：机位让两点各落在设定位置，与独立的正向投影一致；容差内范围的边界偏差等于容差；左右对调得到另一侧的机位", () => {
  const { places, evaluated } = solveGroundPair(towers, level);
  assert.ok(evaluated > 50_000, `${evaluated}`);
  assert.equal(places.length, 1, JSON.stringify(places.map((place) => [place.latitude, place.longitude])));
  const place = places[0];
  // Independently: the rays through each point's frame place, from the aim found, point at the two tops.
  const view = { ...towers.lens, ...place.aim };
  assert.ok(separation(frameDirection(view, towers.firstFrame.x, towers.firstFrame.y), place.first) < 1e-4);
  assert.ok(separation(frameDirection(view, towers.secondFrame.x, towers.secondFrame.y), place.second) < 1e-4);
  assert.ok(place.gap < 1e-6);
  // The outline: at its points the second tower is just at the tolerance.
  assert.equal(place.area.length, 24);
  for (const point of place.area) {
    const gap = evaluatePair(towers, point, level).gap;
    assert.ok(Math.abs(gap - towers.tolerance) < 0.002, `${gap}`);
  }
  assert.ok(place.reach.shortest > 10 && place.reach.longest < 5_000 && place.reach.longest >= place.reach.shortest);
  assert.deepEqual(pairSight(towers, place, level), { first: "clear", second: "clear" });
  // Swapped left and right: the camera stands on the other side of the line between the towers.
  const swapped = solveGroundPair({ ...towers, firstFrame: { x: 0.2, y: -0.4 }, secondFrame: { x: -0.3, y: 0.1 } }, level).places;
  assert.equal(swapped.length, 1);
  assert.ok(Math.sign(swapped[0].latitude - 35.70) === -Math.sign(place.latitude - 35.70), `${swapped[0].latitude} vs ${place.latitude}`);
  // Out of reach: the lower, farther tower cannot stand above the higher one in the frame from anywhere this close.
  assert.equal(solveGroundPair({ ...towers, firstFrame: { x: 0, y: 0.4 }, secondFrame: { x: 0.05, y: -0.4 }, maxDistance: 3_000 }, level).places.length, 0);
});

test("两个地面点：中间有山时第二个点的视线被挡；结果行与试看只给机位和朝向", () => {
  const place = solveGroundPair(towers, level).places[0];
  // A 1000 m hill halfway along the camera's line to the second tower.
  const middle = { latitude: (place.latitude + towers.second.latitude) / 2, longitude: (place.longitude + towers.second.longitude) / 2 };
  const hill = (latitude, longitude) => (Math.hypot((latitude - middle.latitude) * 111_000, (longitude - middle.longitude) * 90_000) < 300 ? 1000 : 0);
  assert.deepEqual(pairSight(towers, place, hill), { first: "clear", second: "blocked" });
  const instant = Date.parse("2026-11-13T12:00:00Z");
  const item = placeItem(place, instant);
  assert.equal(item.place.area.length, 24);
  assert.equal(item.deviation, place.gap);
  const patch = tryPatch(item, { lens: towers.lens, ground: null, bodies: [] }, initialPlan.layers);
  assert.deepEqual(Object.keys(patch).sort(), ["azimuth", "latitude", "longitude", "pitch"], "neither the time nor the layers");
  const { rows } = resultRows([item], "Asia/Tokyo");
  assert.equal(rows[0][0], "—");
  assert.equal(rows[0][1], "与时间无关");
  assert.match(rows[0][3], /^[东南西北]+ [\d.]+ km；[东南西北]+ [\d.]+ km$/);
});
