import { aimAt, finishAlignment, scanAlignment } from "./alignment.ts";
import type { AlignmentInput, AlignmentScan } from "./alignment.ts";
import {
  canSkyline, conditionsAt, extraGap, filterResult, groundAim, groundTarget, lensOf, lineItems, ndc, nightSearch, placeItem, prefilterOf, scanPair,
  shootingDay, toleranceDiameters, windowItem, windowMark,
} from "./composition.ts";
import type { Composition, GroundSpec, ResultItem, SearchBasis, SkySpec, Strategy, TimeRange } from "./composition.ts";
import { clearSpot, refinePlace, sightPoints, solveGroundPair } from "./ground-pair.ts";
import type { GroundPairInput } from "./ground-pair.ts";
import { fieldOfView, normalizeLongitude } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { groundDistance, highestNear, lineOfSight, MIN_DISTANCE, SKYLINE_RADIUS, skyAt, toRay, topSeen, travel } from "./position-alignment.ts";
import type { GroundSampler, GroundTarget } from "./position-alignment.ts";
import { baseDistances, blockedMinutes, rangeCorridor, rangeDays, rangeTrack, reachableSectors, solveRangeDay } from "./range-alignment.ts";
import type { RangeInput, RangePoint } from "./range-alignment.ts";
import { bodyName, isFixedBody } from "./sky-targets.ts";
import type { ElevationTile } from "./terrain.ts";

/**
 * The search behind the 推算 panel, apart from the panel: the four ways to
 * solve a composition (camera lines, a fixed camera's times, two bodies, two
 * ground points), with terrain, light pollution and the line search's days
 * passed in. The panel runs it with the browser's loaders and its worker;
 * the command line (scripts/solve.mjs) with Node's.
 */

/** Terrain tiles under points, as the solvers sample them. */
export type LoadedSampler = GroundSampler & { zoom?: number; tiles?: ReadonlyMap<string, ElevationTile>; bounds?: number[] };
export interface RangeDay {
  day: string;
  start: number;
  end: number;
}
/** What a camera-line search reports while its days are solved. */
export interface RangeHooks {
  loadTiles: (points: { latitude: number; longitude: number }[]) => Promise<LoadedSampler>;
  planned: (sectors: [number, number][]) => void;
  day: (index: number, points: RangePoint[]) => void;
  usingWorker: (worker: boolean) => void;
}
export type SolveDays = (input: RangeInput, days: RangeDay[], signal: AbortSignal, hooks: RangeHooks) => Promise<LoadedSampler>;

export interface RunEnvironment {
  /** Terrain under the points; `progress` reports tiles read. */
  terrain: (points: { latitude: number; longitude: number }[], signal: AbortSignal, progress?: (done: number, total: number) => void) => Promise<LoadedSampler>;
  /** Artificial zenith brightness at a place, or null where the atlas has none. */
  lightPollution: (place: { latitude: number; longitude: number }, signal: AbortSignal) => Promise<{ artificialMcd: number } | null>;
  /** The camera line's days; the main thread when absent (the panel passes its worker). */
  solveDays?: SolveDays;
  /** Progress and early results (stage text, the range's rings and sectors). */
  report?: (patch: Partial<RunOutcome> & { stage?: string }) => void;
}
export interface RunOutcome {
  items: ResultItem[];
  /** Minutes (or places) whose sight the terrain cuts. */
  blocked: number;
  filtered: number;
  /** Minutes (or passes) without light pollution data for 星空可见性. */
  missing: number;
  merged: number;
  /** Minutes, passes or places where another target was not at its place. */
  extraMissed: number;
  sectors: [number, number][];
  rings: { latitude: number; longitude: number; radius: number }[];
  sampler: LoadedSampler | null;
  /** Why nothing was found, or a warning about the search. */
  note: string;
  worker: boolean;
}

/** What a search's results are tried out with: the lens, the ground point, the bodies and, for two bodies, the one followed. */
export function searchBasis(strategy: Strategy, composition: Composition, plan: ShootingPlan): SearchBasis {
  const bodies = composition.targets.filter((target): target is SkySpec => target.kind === "sky").map((target) => target.body);
  return {
    lens: lensOf(plan), ground: strategy.kind === "pair" ? null : strategy.kind === "grounds" ? strategy.first : strategy.ground, bodies,
    ...(strategy.kind === "pair" ? { follow: { body: strategy.first.body, frame: strategy.first.frame, refraction: plan.refraction } } : {}),
  };
}

const DAY = 86_400_000, MINUTE = 60_000, SLICE = 30 * DAY;
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));
const aborted = () => new DOMException("已取消", "AbortError");

/** The camera line's days on the current thread: plan (usable minutes, corridor), terrain, then each day. */
export const solveDaysHere: SolveDays = async (input, days, signal, hooks) => {
  hooks.usingWorker(false);
  const tracks = [];
  for (let index = 0; index < days.length; index++) {
    if (index % 15 === 0) await yieldNow();
    if (signal.aborted) throw aborted();
    tracks.push(rangeTrack(input, days[index]));
  }
  hooks.planned(reachableSectors(tracks, input.frames));
  const sampler = await hooks.loadTiles(rangeCorridor(input, tracks));
  for (let index = 0; index < days.length; index++) {
    await yieldNow();
    if (signal.aborted) throw aborted();
    hooks.day(index, solveRangeDay(input, days[index], tracks[index], sampler));
  }
  return sampler;
};

/** The search's days: one instant, or its dates (noon to noon at night). */
function searchRange(time: TimeRange, timeZone: string, night: boolean) {
  if (time.mode === "instant") {
    const start = Math.floor(Date.parse(time.instant) / MINUTE) * MINUTE;
    return { from: start, to: start + 1, days: [{ day: shootingDay(start, timeZone, night), start, end: start + 1 }] };
  }
  const days = rangeDays(time.date, time.days, timeZone, night ? "noon" : "midnight");
  return { from: days[0].start, to: days.at(-1)!.end, days };
}

const darkSky = (composition: Composition) => composition.filters.some((filter) => filter.kind === "darkSky");
const skylineRing = (target: GroundSpec, bearings = [0, 90, 180, 270]) =>
  (target.skyline && canSkyline(target) ? bearings.map((bearing) => travel(target, bearing, SKYLINE_RADIUS)) : []);

/**
 * Runs one search. `plan` is the shooting plan it starts from (lens, camera
 * height, refraction, time zone, the instant and, for two bodies with a free
 * camera, the camera). Resolves to null when cancelled.
 */
export async function runComposition(strategy: Strategy, composition: Composition, plan: ShootingPlan, env: RunEnvironment, signal: AbortSignal): Promise<RunOutcome | null> {
  const outcome: RunOutcome = { items: [], blocked: 0, filtered: 0, missing: 0, merged: 0, extraMissed: 0, sectors: [], rings: [], sampler: null, note: "", worker: false };
  const report = (patch: Partial<RunOutcome> & { stage?: string }) => {
    const { stage: _stage, ...rest } = patch;
    Object.assign(outcome, rest);
    env.report?.(patch);
  };
  const lens = lensOf(plan);
  const terrain = (points: { latitude: number; longitude: number }[], label = "读取地形") =>
    env.terrain(points, signal, (done, total) => report({ stage: `${label} ${done}/${total} 块…` }));

  /** The cameras' light pollution for 星空可见性, read per ~1 km cell. */
  const pollutionAt = async (places: readonly { latitude: number; longitude: number }[]) => {
    const cell = (place: { latitude: number; longitude: number }) => `${Math.round(place.latitude * 100)}/${Math.round(place.longitude * 100)}`;
    const cells = new Map<string, { latitude: number; longitude: number }>();
    for (const place of places) cells.set(cell(place), place);
    const values = new Map<string, number | null>();
    let done = 0;
    for (const [key, place] of cells) {
      try {
        values.set(key, (await env.lightPollution(place, signal))?.artificialMcd ?? null);
      } catch (error) {
        if (signal.aborted) throw error;
        values.set(key, null);
      }
      if (++done % 25 === 0) report({ stage: `读取光污染 ${done}/${cells.size}…` });
    }
    return (place: { latitude: number; longitude: number }) => values.get(cell(place)) ?? null;
  };

  try {
    if (strategy.kind === "line") await searchLine(strategy);
    else if (strategy.kind === "window") await searchWindow(strategy);
    else if (strategy.kind === "grounds") await searchGrounds(strategy);
    else await searchPair(strategy);
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
  return signal.aborted ? null : outcome;

  /** Two ground points: camera places over the range, then their sight lines. */
  async function searchGrounds(strategy: Extract<Strategy, { kind: "grounds" }>) {
    const { first, second } = strategy;
    const camera = composition.camera;
    const center = camera.mode === "near" ? { latitude: camera.latitude, longitude: camera.longitude } : { latitude: first.latitude, longitude: first.longitude };
    const minDistance = camera.mode === "free" ? Math.max(MIN_DISTANCE, camera.minDistance) : 0;
    const maxDistance = camera.mode === "free" ? camera.maxDistance : camera.mode === "near" ? camera.radius : 30_000;
    const rings = [{ ...center, radius: maxDistance }, ...(minDistance > MIN_DISTANCE ? [{ ...center, radius: minDistance }] : [])];
    const input: GroundPairInput = {
      first: groundTarget(first), firstFrame: ndc(first.frame), second: groundTarget(second), secondFrame: ndc(second.frame),
      tolerance: second.tolerance, lens, cameraHeight: plan.cameraHeight, center, minDistance, maxDistance,
    };
    // The terrain over the whole range, and around each ground point.
    const area = [center, ...Array.from({ length: 24 }, (_, index) => [0.25, 0.5, 0.75, 1].map((share) => travel(center, index * 15, maxDistance * share))).flat()];
    const grounds = [first, second, ...strategy.extras.filter((extra): extra is GroundSpec => extra.kind === "ground")];
    report({ rings, stage: "读取地形中…" });
    const sampler = await terrain([...area, ...grounds.flatMap((ground) => [ground, ...skylineRing(ground)])]);
    if (signal.aborted) return;
    report({ stage: "推算中…" });
    await yieldNow();
    const solved = solveGroundPair(input, sampler);
    if (signal.aborted) return;
    // The sight lines of each place, with the terrain all along them.
    let blocked = 0, extraMissed = 0;
    const items: ResultItem[] = [];
    let lines: LoadedSampler | null = null;
    if (solved.places.length) {
      report({ stage: "检查视线…" });
      lines = await terrain([...solved.places.flatMap((place) => sightPoints(place)), ...grounds.flatMap((ground) => [ground, ...skylineRing(ground)])], "读取视线上的地形");
      if (signal.aborted) return;
      const instant = Date.parse(plan.instant);
      for (const coarse of solved.places) {
        // Settled again on the sight lines' finer terrain.
        const refined = refinePlace(input, coarse, lines);
        if (!refined) continue;
        // The exact place, or the clear spot within its tolerance that lands the second point nearest.
        const clear = clearSpot(input, refined, lines);
        if (!clear) { blocked++; continue; }
        const { place, sight, moved } = clear;
        const other = strategy.extras.length ? extraGap(strategy.extras, { latitude: place.latitude, longitude: place.longitude, ground: place.ground }, instant, place.aim,
          { lens, refraction: plan.refraction, cameraHeight: plan.cameraHeight, sampler: lines }) : 0;
        if (other === null) { extraMissed++; continue; }
        const item = placeItem(place, instant, sight.first === "unknown" || sight.second === "unknown", moved);
        items.push(other > item.deviation ? { ...item, deviation: other } : item);
      }
    }
    const note = items.length ? ""
      : blocked ? `有 ${blocked} 个机位能让两点落在设定位置，但视线被地形挡住。`
        : extraMissed ? `有 ${extraMissed} 个机位能让两点落在设定位置，但其他地面点不在设定位置。`
          : `所选范围内没有机位能让“${second.name}”落在设定位置（容差 ±${percent(second.tolerance)}）。`;
    report({ items, blocked, extraMissed, sampler: lines ?? sampler, rings, note });
  }

  async function searchLine(strategy: Extract<Strategy, { kind: "line" }>) {
    const { ground, sky } = strategy;
    const target: GroundTarget = groundTarget(ground);
    // A skyline target needs the terrain all around its point.
    const around = target.skyline ? [0, 45, 90, 135, 180, 225, 270, 315].map((bearing) => travel(target, bearing, target.skyline!)) : [];
    const frames = { lens, target: ndc(ground.frame), body: ndc(sky.frame) };
    let minDistance = MIN_DISTANCE, maxDistance = composition.camera.mode === "free" ? composition.camera.maxDistance : 30_000;
    const rings: RunOutcome["rings"] = [];
    let centre: { latitude: number; longitude: number; radius: number } | null = null;
    if (composition.camera.mode === "near") {
      const distance = groundDistance(target, composition.camera);
      if (distance - composition.camera.radius > 30_000) throw new Error("机位范围离地面目标超过 30 km：请换一处，或改用“不限”。");
      minDistance = Math.max(MIN_DISTANCE, distance - composition.camera.radius);
      maxDistance = Math.min(30_000, distance + composition.camera.radius);
      centre = { latitude: composition.camera.latitude, longitude: composition.camera.longitude, radius: composition.camera.radius };
      rings.push(centre);
    } else {
      minDistance = Math.max(MIN_DISTANCE, composition.camera.mode === "free" ? composition.camera.minDistance : MIN_DISTANCE);
      rings.push({ latitude: target.latitude, longitude: target.longitude, radius: maxDistance });
      if (minDistance > MIN_DISTANCE) rings.push({ latitude: target.latitude, longitude: target.longitude, radius: minDistance });
    }
    let base: RangeInput["base"];
    let share: number | null = null;
    if (ground.base !== null) {
      const band = baseDistances(target, frames.target.y, ground.base * 2 - 1, lens, maxDistance);
      if (!band) throw new Error("底部位置只用于距地表至少 10 m 的点。");
      minDistance = Math.max(minDistance, band.minDistance);
      maxDistance = Math.min(maxDistance, band.maxDistance);
      base = { y: ground.base * 2 - 1, tolerance: ground.tolerance };
      share = ground.base - ground.frame.y;
    }
    if (minDistance >= maxDistance) {
      report({ rings, note: "按设定的主体大小，机位应在所选范围之外：请放宽范围，或调整底部位置。" });
      return;
    }
    const span = searchRange(composition.time, plan.timeZone, nightSearch(composition, strategy));
    const prefilter = prefilterOf(composition.filters, sky, strategy.extras, lens);
    const extraGrounds = strategy.extras.filter((extra): extra is GroundSpec => extra.kind === "ground");
    const input: RangeInput = {
      body: sky.body, target, refraction: plan.refraction, cameraHeight: plan.cameraHeight, lens,
      share: null, minDistance, maxDistance, frames, ...(base ? { base } : {}), ...(prefilter ? { prefilter } : {}),
    };
    const collected: RangePoint[] = [];
    // The target's own ground first: the altitude pre-filter then allows cameras far below a summit.
    report({ stage: "读取地形中…" });
    const near = await env.terrain([target, ...around], signal);
    if (signal.aborted) return;
    // For a skyline target, its highest point bounds what any camera can see.
    const own = target.skyline ? highestNear(target, target.skyline, near)?.ground ?? null : near(target.latitude, target.longitude);
    if (own !== null) input.targetGround = own;
    let sectors: [number, number][] = [];
    const sampler = await (env.solveDays ?? solveDaysHere)(input, span.days, signal, {
      usingWorker: (worker) => report({ worker }),
      planned: (found) => {
        sectors = found;
        report({ sectors: found, stage: "读取地形中…" });
      },
      loadTiles: async (points) => {
        // Further ground points need their own ground too.
        const loaded = await terrain([...points, ...around, ...extraGrounds]);
        report({ stage: "推算中…" });
        return loaded;
      },
      day: (index, points) => {
        collected.push(...points);
        report({ stage: `推算中 ${index + 1}/${span.days.length} 天…` });
      },
    });
    if (signal.aborted) return;
    const inRange = centre ? collected.filter((point) => groundDistance(point, centre) <= centre.radius) : collected;
    const blocked = blockedMinutes(inRange);
    // Further targets: each unblocked minute, the camera aimed at the ground point's place.
    let extraMissed = 0;
    const points = strategy.extras.length ? inRange.flatMap((point) => {
      if (point.sight === "blocked") return [point];
      const gap = extraGap(strategy.extras, { latitude: point.latitude, longitude: point.longitude, ground: point.cameraGround }, point.time, aimAt(lens, point, frames.target),
        { lens, refraction: plan.refraction, cameraHeight: plan.cameraHeight, sampler });
      if (gap === null) {
        extraMissed++;
        return [];
      }
      return [{ ...point, gap }];
    }) : inRange;
    let artificial: ((place: { latitude: number; longitude: number }) => number | null) | undefined;
    if (darkSky(composition)) {
      report({ stage: "读取光污染…" });
      const night = points.filter((point) => point.sight !== "blocked" && skyAt("sun", point.time, point.latitude, point.longitude, "none").elevation < -17.5);
      artificial = await pollutionAt(night);
      if (signal.aborted) return;
    }
    const listed = lineItems(points, { body: sky.body, filters: composition.filters, splitSky: span.days.length === 1, share, artificial });
    const note = listed.items.length ? ""
      : extraMissed > 0 && !(listed.filtered + listed.missing) ? `有 ${extraMissed} 分钟${bodyName(sky.body)}与“${ground.name}”对齐，但其他目标都不在设定位置。`
        : blocked > 0 && !(listed.filtered + listed.missing) ? `有 ${blocked} 分钟几何上对齐，但视线都被地形挡住。可以换日期、放宽机位范围或提高离地高度。`
          : listed.filtered + listed.missing > 0 ? `有 ${listed.filtered + listed.missing} 分钟对齐，但都不满足筛选条件${listed.missing ? `（其中 ${listed.missing} 分钟缺少光污染数据）` : ""}。`
            : !sectors.length ? `这段时间${bodyName(sky.body)}达不到所需的高度。`
              : "所选范围内没有解。";
    report({ items: listed.items, blocked, filtered: listed.filtered, missing: listed.missing, merged: listed.merged, extraMissed, sampler, rings, note });
  }

  async function searchWindow(strategy: Extract<Strategy, { kind: "window" }>) {
    if (composition.camera.mode !== "fixed") throw new Error("时刻搜索需要固定机位");
    const camera = { latitude: composition.camera.latitude, longitude: composition.camera.longitude };
    let aim = composition.camera.aim;
    let note = "", sampler: LoadedSampler | null = null;
    const grounds = [strategy.ground, ...strategy.extras].filter((target): target is GroundSpec => !!target && target.kind === "ground");
    if (grounds.length) {
      // The terrain along the sight line to each ground point.
      const line = grounds.flatMap((target) => {
        const length = groundDistance(camera, target);
        if (length > 120_000) throw new Error(`固定机位离“${target.name}”超过 120 km。`);
        const steps = Math.max(2, Math.ceil(length / 400));
        return Array.from({ length: steps + 1 }, (_, index) => ({
          latitude: camera.latitude + ((target.latitude - camera.latitude) * index) / steps,
          longitude: normalizeLongitude(camera.longitude + ((target.longitude - camera.longitude) * index) / steps),
        }));
      });
      report({ stage: "读取地形中…" });
      sampler = await terrain([...line, ...grounds.flatMap((target) => skylineRing(target))]);
    }
    if (strategy.ground && sampler) {
      const ground = strategy.ground;
      const target: GroundTarget = groundTarget(ground);
      const cameraGround = sampler(camera.latitude, camera.longitude);
      const eye = cameraGround === null ? null : { ...camera, ellipsoidalHeight: cameraGround + plan.cameraHeight };
      const top = eye && topSeen(target, eye, sampler);
      if (!eye || !top) throw new Error("机位或地面目标处没有地形数据。");
      aim = groundAim(ground, lens, toRay(eye, top));
      const sight = lineOfSight(eye, top, sampler);
      if (sight.sight === "blocked") note = `从这个机位看，“${ground.name}”在距机位 ${km(sight.blockedAt ?? 0)} km 处被地形挡住。`;
    }
    if (!aim) throw new Error("缺少朝向");
    const sky = strategy.sky;
    const mark = windowMark(sky, lens, aim);
    const input: AlignmentInput = { latitude: camera.latitude, longitude: camera.longitude, refraction: plan.refraction, target: { body: sky.body, ...mark }, tolerance: toleranceDiameters(sky, lens) };
    const night = nightSearch(composition, strategy);
    const span = searchRange(composition.time, plan.timeZone, night);
    const scans: AlignmentScan[] = [];
    for (let cursor = span.from; cursor < span.to; cursor += SLICE) {
      await yieldNow();
      if (signal.aborted) return;
      scans.push(scanAlignment(input, cursor, Math.min(span.to, cursor + SLICE)));
      report({ stage: `推算中 ${Math.round((Math.min(1, (cursor + SLICE - span.from) / (span.to - span.from))) * 100)}%…` });
    }
    const result = finishAlignment(input, scans, span.from, span.to);
    const vertical = fieldOfView(lens).vertical;
    const artificial = darkSky(composition) ? (await pollutionAt([camera]))(camera) : undefined;
    let filtered = 0, missing = 0, extraMissed = 0;
    const cameraGround = sampler?.(camera.latitude, camera.longitude) ?? null;
    const items = result.alignments.flatMap((found) => {
      const best = Date.parse(found.instant);
      const verdict = filterResult(composition.filters, conditionsAt(best, camera.latitude, camera.longitude), artificial);
      if (verdict !== "pass") {
        if (verdict === "fail") filtered++;
        else missing++;
        return [];
      }
      const other = strategy.extras.length ? extraGap(strategy.extras, { ...camera, ground: cameraGround }, best, aim!, { lens, refraction: plan.refraction, cameraHeight: plan.cameraHeight, sampler }) : 0;
      if (other === null) {
        extraMissed++;
        return [];
      }
      return [windowItem({ start: Date.parse(found.from), end: Date.parse(found.to), best, deviation: Math.max(found.separation / vertical, other) }, camera, aim!, shootingDay(best, plan.timeZone, night))];
    });
    if (!items.length) {
      const name = bodyName(sky.body);
      note = [note, result.reason === "too-high" ? `${name}达不到画面位置对应的高度（${mark.elevation.toFixed(1)}°）。`
        : result.reason === "too-low" ? `${name}始终高于画面位置对应的高度（${mark.elevation.toFixed(1)}°）。`
          : extraMissed ? `有 ${extraMissed} 次${name}经过画面位置，但其他目标都不在设定位置。`
            : filtered || missing || result.reason === "filtered" ? `有 ${filtered + missing + result.filtered.phase + result.filtered.sky} 次对齐，但都不满足筛选条件${isFixedBody(sky.body) ? "或天色不够暗（太阳须低于 −6°）" : ""}${missing ? `（其中 ${missing} 次缺少光污染数据）` : ""}。`
              : `${name}没有经过画面位置（容差 ±${percent(sky.tolerance)}）。`].filter(Boolean).join(" ");
    }
    report({ items, filtered, missing, extraMissed, sampler, note });
  }

  async function searchPair(strategy: Extract<Strategy, { kind: "pair" }>) {
    const camera = composition.camera.mode === "free" ? { latitude: plan.latitude, longitude: plan.longitude } : { latitude: composition.camera.latitude, longitude: composition.camera.longitude };
    const night = nightSearch(composition, strategy);
    const span = searchRange(composition.time, plan.timeZone, night);
    const extras = strategy.extras.filter((extra): extra is SkySpec => extra.kind === "sky");
    const input = { first: strategy.first, second: strategy.second, extras, lens, ...camera, refraction: plan.refraction };
    const windows = [];
    for (let cursor = span.from; cursor < span.to; cursor += SLICE) {
      await yieldNow();
      if (signal.aborted) return;
      windows.push(...scanPair(input, cursor, Math.min(span.to, cursor + SLICE)));
      report({ stage: `推算中 ${Math.round((Math.min(1, (cursor + SLICE - span.from) / (span.to - span.from))) * 100)}%…` });
    }
    const artificial = darkSky(composition) ? (await pollutionAt([camera]))(camera) : undefined;
    let filtered = 0, missing = 0;
    const items = windows.flatMap((window) => {
      const verdict = filterResult(composition.filters, conditionsAt(window.best, camera.latitude, camera.longitude), artificial);
      if (verdict !== "pass") {
        if (verdict === "fail") filtered++;
        else missing++;
        return [];
      }
      const aim = aimAt(lens, skyAt(strategy.first.body, window.best, camera.latitude, camera.longitude, plan.refraction), ndc(strategy.first.frame));
      return [windowItem(window, camera, aim, shootingDay(window.best, plan.timeZone, night))];
    });
    const note = items.length ? "" : filtered + missing ? `有 ${filtered + missing} 次到达相对位置，但都不满足筛选条件${missing ? `（其中 ${missing} 次缺少光污染数据）` : ""}。`
      : `${strategy.extras.length ? "这些天体" : `${bodyName(strategy.first.body)}与${bodyName(strategy.second.body)}`}在所选日期内没有到达设定的相对位置。`;
    report({ items, filtered, missing, note });
  }
}
