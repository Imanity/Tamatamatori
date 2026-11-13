import { Temporal } from "@js-temporal/polyfill";
import { Body, Illumination } from "astronomy-engine";
import { aimAt, bodyRadius, frameDirection, skyCondition } from "./alignment.ts";
import type { AlignmentBody, FramePoint, SkyCondition } from "./alignment.ts";
import { projectDirection } from "../core/celestial-projection.ts";
import type { View } from "../core/celestial-projection.ts";
import { direction } from "../core/ephemeris.ts";
import { fieldOfView, frameAspectRatio } from "../core/plan.ts";
import type { ShootingPlan } from "../core/plan.ts";
import { lineOfSight, pointPlan, SKYLINE_RADIUS, skyAt, toRay, topHeight } from "./position-alignment.ts";
import type { GroundSampler, GroundTarget, PositionPoint } from "./position-alignment.ts";
import type { GroundPlace } from "./ground-pair.ts";
import { skyBrightness } from "../sky/meteor-showers.ts";
import { mergeCandidates, MIN_SUBJECT, rangeCandidates, skySeparation } from "./range-alignment.ts";
import type { Prefilter } from "./range-alignment.ts";
import { bodyLayer, bodyName, DARK_SUN_ELEVATION, isFixedBody } from "../sky/sky-targets.ts";
import { landmarks } from "../buildings/landmarks.ts";

/**
 * 构图约束搜索: what should appear where in the frame (targets), where and
 * when to look (the search range) and which results to keep (filters). One
 * model for what were 找时间, 找机位 and 两者都找; `classify` says what a
 * set of targets can determine and which solver answers it.
 */

export type HeightReference = "ground" | "sea";
/** A place in the frame from its top-left, 0—1 (as requests write it). */
export interface FrameSpot {
  x: number;
  y: number;
}
export const DEFAULT_TOLERANCE = 0.03;
export const TARGET_LIMIT = 4;
export const toleranceChoices = [0.01, 0.02, 0.03, 0.05, 0.08] as const;

export interface GroundSpec {
  kind: "ground";
  id: string;
  name: string;
  landmark?: string;
  latitude: number;
  longitude: number;
  /** Metres above the ground under the point ("ground") or the point's own elevation ("sea"). */
  height: number;
  reference: HeightReference;
  frame: FrameSpot;
  /** Frame y (0—1) of the ground under the point: fixes how tall it looks. Heights above the ground only. */
  base: number | null;
  tolerance: number;
  /** A summit: aim at the highest point seen of the skyline nearby (heights under 10 m above the ground only). */
  skyline?: boolean;
}
/** Whether a ground point can be aimed at its skyline top: natural ground, not a tower or a sea-level height. */
export const canSkyline = (target: Pick<GroundSpec, "reference" | "height">) => target.reference === "ground" && target.height < MIN_SUBJECT;
/** The solver's target for a ground point. */
export const groundTarget = (ground: GroundSpec): GroundTarget => ({
  latitude: ground.latitude, longitude: ground.longitude, height: ground.height, absolute: ground.reference === "sea", name: ground.name,
  ...(ground.skyline && canSkyline(ground) ? { skyline: SKYLINE_RADIUS } : {}),
});
export interface SkySpec {
  kind: "sky";
  id: string;
  body: AlignmentBody;
  frame: FrameSpot;
  tolerance: number;
}
export type TargetSpec = GroundSpec | SkySpec;

export type CameraRange =
  | { mode: "free"; maxDistance: number; minDistance: number }
  | { mode: "near"; latitude: number; longitude: number; radius: number }
  | { mode: "fixed"; latitude: number; longitude: number; aim: { azimuth: number; pitch: number } | null };
export type TimeRange = { mode: "range"; date: string; days: number } | { mode: "instant"; instant: string };
export type FilterSpec =
  | { kind: "sky"; sky: SkyCondition[] }
  | { kind: "moonDown" }
  | { kind: "moonLit"; range: [number, number] }
  | { kind: "darkSky"; limit: number };

export interface Composition {
  targets: TargetSpec[];
  camera: CameraRange;
  time: TimeRange;
  filters: FilterSpec[];
}
export type Lens = Omit<View, "azimuth" | "pitch" | "refraction"> & Partial<Pick<ShootingPlan, "customSensor">>;
export const lensOf = (plan: ShootingPlan): Lens =>
  ({ focalLength: plan.focalLength, sensor: plan.sensor, customSensor: plan.customSensor, aspectRatio: plan.aspectRatio, orientation: plan.orientation });

export const distanceChoices = [10_000, 20_000, 30_000] as const;
export const nearChoices = [1_000, 3_000, 10_000] as const;
/** Nearest camera distance from the ground point when the camera is free; the first is the solver's own floor. */
export const nearestChoices = [200, 1_000, 2_000, 5_000, 10_000] as const;
export const DEFAULT_NEAREST = 2_000;
export const nearestLabel = (distance: number) => (distance <= 200 ? "不限" : `${distance / 1000} km`);
export const dayChoices = [1, 7, 30, 90, 365, 1096] as const;
/** 3 years only with a fixed camera (a time search per day is cheap; a line search is not). */
export const dayLabel = (days: number) => (days === 1 ? "当天" : days === 365 ? "12 个月" : days === 1096 ? "3 年" : `${days} 天`);
export const MAX_LINE_DAYS = 365;

/** Normalised device coordinates (−1…1, y down) of a frame place. */
export const ndc = (spot: FrameSpot): FramePoint => ({ x: spot.x * 2 - 1, y: spot.y * 2 - 1 });
export const spotOf = (point: FramePoint): FrameSpot => ({ x: (point.x + 1) / 2, y: (point.y + 1) / 2 });
const percent = (value: number) => `${Math.round(value * 100)}%`;
/** A frame place in words: the centre, or percentages from the top-left. */
export function spotWords(spot: FrameSpot) {
  return Math.abs(spot.x - 0.5) < 0.005 && Math.abs(spot.y - 0.5) < 0.005 ? "画面中心" : `自左 ${percent(spot.x)}、自上 ${percent(spot.y)}`;
}
/** Distance between two frame places, as a share of the frame height. */
export function frameGap(a: FramePoint, b: FramePoint, lens: Lens) {
  return Math.hypot(((a.x - b.x) / 2) * frameAspectRatio(lens), (a.y - b.y) / 2);
}
/** A share of the frame height as an angle, degrees (small-angle; tolerances only). */
export const toleranceAngle = (tolerance: number, lens: Lens) => tolerance * fieldOfView(lens).vertical;

export const targetName = (target: TargetSpec) => (target.kind === "ground" ? target.name : bodyName(target.body));
export function heightWords(target: GroundSpec) {
  return target.reference === "sea" ? `海拔 ${target.height} m` : target.height === 0 ? "地面上的点" : `距地表 ${target.height} m`;
}

// ---------------------------------------------------------------- 可解性

/**
 * The solver's pair (a ground point and a body, two bodies, or one body for
 * a fixed aim) and the targets checked on top of it, minute by minute.
 */
export type Strategy =
  | { kind: "line"; ground: GroundSpec; sky: SkySpec; extras: TargetSpec[] }
  | { kind: "window"; ground: GroundSpec | null; sky: SkySpec; extras: TargetSpec[] }
  | { kind: "pair"; first: SkySpec; second: SkySpec; extras: TargetSpec[] }
  | { kind: "grounds"; first: GroundSpec; second: GroundSpec; extras: TargetSpec[] };
export type Shape = "lines" | "points" | "windows" | "places";
export interface Solvability {
  strategy: Strategy | null;
  shape: Shape | null;
  /** What the search will find, or why it cannot run. */
  message: string;
}

/** What a set of targets, a search range and filters can determine, and how (第 4 节). */
export function classify(composition: Composition): Solvability {
  const { targets, camera, time, filters } = composition;
  const grounds = targets.filter((target): target is GroundSpec => target.kind === "ground");
  const skies = targets.filter((target): target is SkySpec => target.kind === "sky");
  const stop = (message: string): Solvability => ({ strategy: null, shape: null, message });
  if (!targets.length) return stop("先加目标：一个地面点和一个天体，或两个天体。");
  if (targets.length > TARGET_LIMIT) return stop(`最多 ${TARGET_LIMIT} 个目标。`);
  if (!skies.length && grounds.length < 2) return stop("只有一个地面点：任何机位都能对准它。再加一个地面点或天体。");
  if (skies.some((sky) => sky.body === "moon") && filters.some((filter) => filter.kind === "moonDown"))
    return stop("目标里有月亮，却要求“月亮在地平线下”：请删掉其中一个。");
  for (const ground of grounds) {
    if (ground.base === null) continue;
    if (ground.reference === "sea" || ground.height < MIN_SUBJECT) return stop(`“${ground.name}”的底部位置只用于距地表至少 ${MIN_SUBJECT} m 的点（塔、楼）。`);
    if (ground.base <= ground.frame.y) return stop(`“${ground.name}”的底部应在顶部下方。`);
  }
  const fixed = camera.mode === "fixed";
  if (!skies.length) {
    // Two ground points: their places in the frame depend on the camera's place and aim alone.
    if (fixed) return stop("机位固定时，两个地面点在画面中的位置已由机位决定：直接看预览即可。");
    const extras = grounds.slice(2);
    return {
      strategy: { kind: "grounds", first: grounds[0], second: grounds[1], extras },
      shape: "places",
      message: `结果为机位：两个地面点的相对位置只取决于机位，与时间无关。${extras.length ? `另有 ${extras.length} 个地面点按容差检查。` : ""}${filters.length ? "筛选条件与时间有关，这里不用。" : ""}`,
    };
  }
  if (fixed && time.mode === "instant") return stop("机位与时刻都已固定，没有可搜索的量；直接看预览即可。");
  const more = (extras: TargetSpec[]) => (extras.length ? `另有 ${extras.length} 个目标按容差逐分钟检查。` : "");
  if (fixed && camera.aim) {
    if (grounds.length) return stop("固定朝向时，地面点在画面中的位置由朝向决定：请删掉地面点，或不固定朝向。");
    const extras = skies.slice(1);
    return { strategy: { kind: "window", ground: null, sky: skies[0], extras }, shape: "windows", message: `机位与朝向固定：求${bodyName(skies[0].body)}落到画面位置的时刻。${more(extras)}` };
  }
  if (targets.length === 1) return stop("只有一个天体：只要它在地平线上，任何时刻都能对准。再加一个地面点或天体。");
  if (grounds.length) {
    const [ground] = grounds, [sky] = skies;
    const extras = targets.filter((target) => target !== ground && target !== sky);
    if (fixed) return { strategy: { kind: "window", ground, sky, extras }, shape: "windows", message: `机位固定：由“${ground.name}”定朝向，求${bodyName(sky.body)}经过画面位置的时刻。${more(extras)}` };
    return time.mode === "instant"
      ? { strategy: { kind: "line", ground, sky, extras }, shape: "points", message: `时刻固定：结果为机位点。${more(extras)}` }
      : { strategy: { kind: "line", ground, sky, extras }, shape: "lines", message: `结果为机位线：每个时刻一处机位。${more(extras)}` };
  }
  if (time.mode === "instant") return stop("天体之间的相对位置只随时间变化；时刻固定时无从搜索。");
  const extras = skies.slice(2);
  return {
    strategy: { kind: "pair", first: skies[0], second: skies[1], extras },
    shape: "windows",
    message: `结果为时刻：天体在画面中的相对位置与机位基本无关${skies.some((sky) => sky.body === "moon") ? "（月亮略有视差）" : ""}，按${fixed ? "固定" : "当前"}机位计算。${more(extras)}`,
  };
}

// ---------------------------------------------------------------- 筛选

export interface Conditions {
  sunElevation: number;
  sky: SkyCondition;
  moonAzimuth: number;
  moonElevation: number;
  moonLit: number;
}
/** Sun and Moon at an instant and place: geometric elevations, as the timeline's sky conditions. */
export function conditionsAt(time: number, latitude: number, longitude: number): Conditions {
  const sun = skyAt("sun", time, latitude, longitude, "none").elevation;
  const moon = skyAt("moon", time, latitude, longitude, "none");
  return { sunElevation: sun, sky: skyCondition(sun), moonAzimuth: moon.azimuth, moonElevation: moon.elevation, moonLit: Illumination(Body.Moon, new Date(time)).phase_fraction };
}

/** Sky brightness limits for 星空可见性 (zenith, mag/arcsec²), darkest first. */
export const darkSkyChoices = [
  { limit: 21.7, label: "很暗（银河结构清楚）" },
  { limit: 21.3, label: "暗（银河明显）" },
  { limit: 20.5, label: "郊外（银河可见）" },
  { limit: 19.5, label: "郊区（以亮星为主）" },
] as const;
/** The Sun below this for 星空可见性: astronomical night (twilight is not modelled). */
export const ASTRONOMICAL_NIGHT = -18;
/** Luminance (mcd/m²) as a surface brightness in mag/arcsec² (1 cd/m² ≈ 12.58 mag/arcsec²). */
export const surfaceMagnitude = (mcd: number) => -2.5 * Math.log10(mcd / 1.08e8);
/**
 * Zenith sky brightness from the natural sky, light pollution (`artificialMcd`,
 * World Atlas) and moonlight (Krisciunas–Schaefer), mag/arcsec²; brighter is smaller.
 */
export function zenithBrightness(conditions: Conditions, artificialMcd: number) {
  const moon = conditions.moonElevation > 0 ? { direction: direction(conditions.moonAzimuth, conditions.moonElevation), illuminatedFraction: conditions.moonLit } : null;
  return surfaceMagnitude(skyBrightness([0, 0, 1], moon, artificialMcd));
}

/**
 * Whether a minute passes the filters. 星空可见性 needs the camera's light
 * pollution: `undefined` when not read yet (not checked), null when there is no data ("missing").
 */
export function filterResult(filters: readonly FilterSpec[], conditions: Conditions, artificialMcd?: number | null): "pass" | "fail" | "missing" {
  let missing = false;
  for (const filter of filters) {
    if (filter.kind === "sky" && !filter.sky.includes(conditions.sky)) return "fail";
    if (filter.kind === "moonDown" && conditions.moonElevation >= 0) return "fail";
    if (filter.kind === "moonLit" && (conditions.moonLit < filter.range[0] - 1e-9 || conditions.moonLit > filter.range[1] + 1e-9)) return "fail";
    if (filter.kind === "darkSky") {
      if (conditions.sunElevation >= ASTRONOMICAL_NIGHT) return "fail";
      if (artificialMcd === null) missing = true;
      else if (artificialMcd !== undefined && zenithBrightness(conditions, artificialMcd) < filter.limit) return "fail";
    }
  }
  return missing ? "missing" : "pass";
}
export const passes = (filters: readonly FilterSpec[], conditions: Conditions, artificialMcd?: number | null) => filterResult(filters, conditions, artificialMcd) === "pass";
export const filterNames: Record<FilterSpec["kind"], string> = { sky: "天空条件", moonDown: "月亮在地平线下", moonLit: "月亮亮面", darkSky: "星空可见性" };

// ---------------------------------------------------------------- 其他目标

/** What checking the extra targets needs besides the camera and the aim. */
export interface ExtraContext {
  lens: Lens;
  refraction: ShootingPlan["refraction"];
  cameraHeight: number;
  /** Terrain for extra ground points (their height and the sight line). */
  sampler?: GroundSampler | null;
}
/**
 * The largest gap (share of the frame height) of the extra targets from their
 * places, the camera aimed at `aim`; null when one is not there: outside its
 * tolerance, below the horizon (or in daylight for a fixed body), hidden by
 * the terrain or without terrain data.
 */
export function extraGap(extras: readonly TargetSpec[], camera: { latitude: number; longitude: number; ground?: number | null }, time: number, aim: { azimuth: number; pitch: number }, context: ExtraContext) {
  const view = { ...context.lens, ...aim };
  let worst = 0, sun: number | null = null;
  for (const extra of extras) {
    let ray: [number, number, number];
    if (extra.kind === "sky") {
      const seen = skyAt(extra.body, time, camera.latitude, camera.longitude, context.refraction);
      if (isFixedBody(extra.body) && sun === null) sun = skyAt("sun", time, camera.latitude, camera.longitude, "none").elevation;
      if (!visible(extra.body, seen.elevation, sun ?? -90)) return null;
      ray = direction(seen.azimuth, seen.elevation) as [number, number, number];
    } else {
      const sampler = context.sampler;
      const ground = sampler?.(extra.latitude, extra.longitude) ?? null;
      const own = camera.ground ?? sampler?.(camera.latitude, camera.longitude) ?? null;
      if (ground === null || own === null) return null;
      const eye = { latitude: camera.latitude, longitude: camera.longitude, ellipsoidalHeight: own + context.cameraHeight };
      const top = { latitude: extra.latitude, longitude: extra.longitude, ellipsoidalHeight: topHeight({ latitude: extra.latitude, longitude: extra.longitude, height: extra.height, absolute: extra.reference === "sea" }, ground) };
      ray = toRay(eye, top).ray;
      const placed = projectDirection(view, ray);
      if (!placed || frameGap(placed, ndc(extra.frame), context.lens) > extra.tolerance) return null;
      if (lineOfSight(eye, top, sampler!).sight === "blocked") return null;
    }
    const placed = projectDirection(view, ray);
    if (!placed) return null;
    const gap = frameGap(placed, ndc(extra.frame), context.lens);
    if (gap > extra.tolerance) return null;
    worst = Math.max(worst, gap);
  }
  return worst;
}

// ---------------------------------------------------------------- 时刻搜索

/** The angle (degrees) between two frame places: the same wherever a level camera points. */
export function frameSeparation(lens: Lens, a: FrameSpot, b: FrameSpot) {
  const view = { ...lens, azimuth: 0, pitch: 0 };
  const one = ndc(a), two = ndc(b);
  return skySeparation(frameDirection(view, one.x, one.y), frameDirection(view, two.x, two.y));
}

/**
 * What a line search can skip before solving: the filters, checked at the
 * target with a margin (exactly afterwards), and further bodies whose angle
 * from the searched body cannot fit their places. Null when nothing applies.
 */
export function prefilterOf(filters: readonly FilterSpec[], sky: SkySpec, extras: readonly TargetSpec[], lens: Lens): Prefilter | null {
  const prefilter: Prefilter = {};
  for (const filter of filters) {
    if (filter.kind === "sky") prefilter.sky = filter.sky;
    else if (filter.kind === "moonDown") prefilter.moonDown = true;
    else if (filter.kind === "moonLit") prefilter.moonLit = filter.range;
    else prefilter.night = true;
  }
  const separations = extras.filter((extra): extra is SkySpec => extra.kind === "sky")
    .map((extra) => ({ body: extra.body, angle: frameSeparation(lens, extra.frame, sky.frame), tolerance: toleranceAngle(extra.tolerance, lens) }));
  if (separations.length) prefilter.separations = separations;
  return Object.keys(prefilter).length ? prefilter : null;
}

/** The body's direction for a fixed camera: through its frame place, the camera aimed at the ground point (or fixed). */
export function windowMark(sky: SkySpec, lens: Lens, aim: { azimuth: number; pitch: number }) {
  const place = ndc(sky.frame);
  return frameDirection({ ...lens, ...aim }, place.x, place.y);
}
/** A frame-height tolerance in the body's diameters, as 找时间 counts it. */
export const toleranceDiameters = (sky: SkySpec, lens: Lens) => toleranceAngle(sky.tolerance, lens) / (2 * bodyRadius(sky.body));
/** The aim that puts a ground point (seen along `ray`) at its frame place. */
export const groundAim = (ground: GroundSpec, lens: Lens, ray: { azimuth: number; elevation: number }) => aimAt(lens, ray, ndc(ground.frame));

export interface PairInput {
  first: SkySpec;
  second: SkySpec;
  /** Further bodies checked at each minute. */
  extras?: readonly SkySpec[];
  lens: Lens;
  latitude: number;
  longitude: number;
  refraction: ShootingPlan["refraction"];
}
export interface PairWindow {
  start: number;
  end: number;
  /** Minute of the smallest gap. */
  best: number;
  /** Largest gap of a body from its place there, share of the frame height. */
  deviation: number;
}
const MINUTE = 60_000, COARSE = 10 * MINUTE;
export const visible = (body: AlignmentBody, elevation: number, sun: number) => elevation > -0.25 && (!isFixedBody(body) || sun <= DARK_SUN_ELEVATION);

/** Gap of the second body from its place with the first aimed at its own; null while either cannot be drawn. */
export function pairGap(input: PairInput, time: number) {
  const a = skyAt(input.first.body, time, input.latitude, input.longitude, input.refraction);
  const b = skyAt(input.second.body, time, input.latitude, input.longitude, input.refraction);
  const fixed = isFixedBody(input.first.body) || isFixedBody(input.second.body);
  const sun = fixed ? skyAt("sun", time, input.latitude, input.longitude, "none").elevation : -90;
  if (!visible(input.first.body, a.elevation, sun) || !visible(input.second.body, b.elevation, sun)) return null;
  const aim = aimAt(input.lens, a, ndc(input.first.frame));
  const seen = projectDirection({ ...input.lens, ...aim }, direction(b.azimuth, b.elevation));
  return seen ? frameGap(seen, ndc(input.second.frame), input.lens) : null;
}

/**
 * Times when two bodies sit at their places relative to each other: a
 * 10-minute scan, refined to the minute wherever the gap comes near the
 * tolerance. One slice of a range; windows are runs of whole minutes.
 */
export function scanPair(input: PairInput, from: number, to: number): PairWindow[] {
  const limit = input.second.tolerance;
  const coarse: { time: number; gap: number | null }[] = [];
  for (let time = Math.ceil(from / COARSE) * COARSE; time < to; time += COARSE) coarse.push({ time, gap: pairGap(input, time) });
  const minutes = new Set<number>();
  coarse.forEach((sample, index) => {
    const near = [coarse[index - 1], sample, coarse[index + 1]].filter(Boolean);
    const step = Math.max(...near.map((other) => (other.gap === null || sample.gap === null ? 0 : Math.abs(other.gap - sample.gap))));
    if (sample.gap === null || sample.gap > limit + Math.max(0.01, 1.5 * step)) return;
    for (let time = sample.time - COARSE; time <= sample.time + COARSE; time += MINUTE) if (time >= from && time < to) minutes.add(time);
  });
  const windows: PairWindow[] = [];
  let open: PairWindow | null = null;
  const extras = input.extras ?? [];
  const firstPlace = ndc(input.first.frame);
  // The second body and the extras, the first aimed at its place.
  const check = (time: number) => {
    const gap = pairGap(input, time);
    if (gap === null || gap > limit || !extras.length) return gap;
    const first = skyAt(input.first.body, time, input.latitude, input.longitude, input.refraction);
    const other = extraGap(extras, input, time, aimAt(input.lens, first, firstPlace), { lens: input.lens, refraction: input.refraction, cameraHeight: 0 });
    return other === null ? null : Math.max(gap, other);
  };
  for (const time of [...minutes].sort((a, b) => a - b)) {
    const gap = check(time);
    if (gap !== null && gap <= limit) {
      if (open && time - open.end <= MINUTE) {
        open.end = time;
        if (gap < open.deviation) { open.deviation = gap; open.best = time; }
      } else {
        if (open) windows.push(open);
        open = { start: time, end: time, best: time, deviation: gap };
      }
    } else if (open) {
      windows.push(open);
      open = null;
    }
  }
  if (open) windows.push(open);
  return windows;
}

// ---------------------------------------------------------------- 模板

const fuji = { latitude: 35.3606, longitude: 138.7274 };
export interface Template {
  id: string;
  name: string;
  hint: string;
  build: (plan: ShootingPlan, date: string) => Composition;
}
let serial = 0;
export const newId = () => `t${++serial}`;
const summit = (frame: FrameSpot): GroundSpec =>
  ({ kind: "ground", id: newId(), name: "富士山顶", ...fuji, height: 0, reference: "ground", frame, base: null, tolerance: DEFAULT_TOLERANCE, skyline: true });
export const templates: readonly Template[] = [
  {
    id: "diamond-fuji",
    name: "钻石富士",
    hint: "日出、日落时太阳落在富士山顶正中；90 天内，机位不限。",
    build: (_plan, date) => ({
      targets: [summit({ x: 0.5, y: 0.6 }), { kind: "sky", id: newId(), body: "sun", frame: { x: 0.5, y: 0.6 }, tolerance: DEFAULT_TOLERANCE }],
      // Seen from 10–30 km the summit stands 5°–15° high: no golden-hour filter, and not from the mountain itself.
      camera: { mode: "free", maxDistance: 30_000, minDistance: 10_000 }, time: { mode: "range", date, days: 90 }, filters: [],
    }),
  },
  {
    id: "moon-on-tower",
    name: "月亮落在塔尖",
    hint: "月亮落在晴空塔塔尖，塔身占画面约 35%；30 天内。",
    build: (_plan, date) => {
      const tower = landmarks.find((landmark) => landmark.id === "tokyo-skytree")!;
      return {
        targets: [
          { kind: "ground", id: newId(), name: tower.name, landmark: tower.id, latitude: tower.latitude, longitude: tower.longitude, height: tower.bounds.height, reference: "ground", frame: { x: 0.5, y: 0.35 }, base: 0.7, tolerance: DEFAULT_TOLERANCE },
          { kind: "sky", id: newId(), body: "moon", frame: { x: 0.5, y: 0.35 }, tolerance: DEFAULT_TOLERANCE },
        ],
        camera: { mode: "free", maxDistance: 30_000, minDistance: 200 }, time: { mode: "range", date, days: 30 }, filters: [],
      };
    },
  },
  {
    id: "deep-sky-over-summit",
    name: "深空天体在山顶上方",
    hint: "仙女座星系在富士山顶正上方，山顶在下三分线；暗夜、月亮在地平线下，90 天内。",
    build: (_plan, date) => ({
      targets: [summit({ x: 0.5, y: 2 / 3 }), { kind: "sky", id: newId(), body: "dso-ngc0224", frame: { x: 0.5, y: 0.52 }, tolerance: DEFAULT_TOLERANCE }],
      camera: { mode: "free", maxDistance: 30_000, minDistance: DEFAULT_NEAREST }, time: { mode: "range", date, days: 90 }, filters: [{ kind: "sky", sky: ["night"] }, { kind: "moonDown" }],
    }),
  },
];

// ---------------------------------------------------------------- 结果

/**
 * One result row: a stretch of minutes on one local day. Along a camera line
 * (`points`) the camera moves with the minutes; for a still camera (time
 * windows) it stands at `camera` and looks along `aim`.
 */
export interface ResultItem {
  key: string;
  day: string;
  start: number;
  end: number;
  /** The minute a try-out goes to. */
  best: number;
  points: (PositionPoint & { share?: number | null })[] | null;
  camera: { latitude: number; longitude: number };
  /** Distances from the ground point along the stretch, metres. */
  near: number | null;
  far: number | null;
  /** Direction from the camera to the ground point at `best`, degrees. */
  bearing: number | null;
  /** Largest gap of a target from its place, share of the frame height (0 for exact camera lines). */
  deviation: number;
  /** How much of the frame height the target spans (top to foot), when a foot is placed. */
  share: readonly [number, number] | null;
  sky: SkyCondition;
  moonElevation: number;
  moonLit: number;
  /** Share of the minutes with terrain data all along the sight line. */
  clear: number;
  aim: { azimuth: number; pitch: number } | null;
  /** A camera place for two ground points: not tied to a time (start, end and best are the search's instant). */
  place?: PlaceFacts;
}
export interface PlaceFacts {
  /** Ground distance and direction from the camera to each of the two points. */
  first: { distance: number; azimuth: number };
  second: { distance: number; azimuth: number };
  /** Outline of the ground where the second point stays within its tolerance, and its reach from the place. */
  area: { latitude: number; longitude: number }[];
  reach: { longest: number; shortest: number };
  /** Some sight line crosses ground without terrain data. */
  unknown: boolean;
  /** Metres moved from the exact place, inside the tolerance, to a spot whose sight lines are not cut. */
  moved: number;
}
/** A result row for a camera place found from two ground points. */
export function placeItem(place: GroundPlace, instant: number, unknown = false, moved = 0): ResultItem {
  const camera = { latitude: place.latitude, longitude: place.longitude };
  const conditions = conditionsAt(instant, camera.latitude, camera.longitude);
  return {
    key: `place/${camera.latitude.toFixed(6)}/${camera.longitude.toFixed(6)}`, day: "", start: instant, end: instant, best: instant,
    points: null, camera, near: place.first.distance, far: place.first.distance, bearing: place.first.azimuth, deviation: place.gap, share: null,
    sky: conditions.sky, moonElevation: conditions.moonElevation, moonLit: conditions.moonLit, clear: unknown ? 0 : 1, aim: place.aim,
    place: {
      first: { distance: place.first.distance, azimuth: place.first.azimuth }, second: { distance: place.second.distance, azimuth: place.second.azimuth },
      area: place.area, reach: place.reach, unknown, moved,
    },
  };
}
export interface DayGroup {
  day: string;
  items: ResultItem[];
}

/**
 * Whether a search is about the night: its leading body is a fixed one (searched
 * only in the dark), or the filters allow only the dark. Its days then run
 * from noon to noon and are named after their evening.
 */
export function nightSearch(composition: Pick<Composition, "filters">, strategy: Strategy) {
  if (strategy.kind === "grounds") return false;
  const lead = strategy.kind === "pair" ? [strategy.first, strategy.second] : [strategy.sky];
  if (lead.every((sky) => isFixedBody(sky.body))) return true;
  return composition.filters.some((filter) => filter.kind === "darkSky"
    || (filter.kind === "sky" && filter.sky.every((sky) => sky === "twilight" || sky === "night")));
}
/** The day a time belongs to: its local date, or at night the date of the evening before. */
export function shootingDay(time: number, timeZone: string, night: boolean) {
  return Temporal.Instant.fromEpochMilliseconds(night ? time - 12 * 3_600_000 : time).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}
/** A day's stretches as spans for its row: those less than `gap` apart run together. */
export function daySpans(items: readonly { start: number; end: number }[], gap = 3 * 3_600_000) {
  const spans: { start: number; end: number }[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const last = spans.at(-1);
    if (last && item.start - last.end < gap) last.end = Math.max(last.end, item.end);
    else spans.push({ start: item.start, end: item.end });
  }
  return spans;
}

export function groupByDay(items: readonly ResultItem[]): DayGroup[] {
  const days = new Map<string, ResultItem[]>();
  for (const item of [...items].sort((a, b) => a.start - b.start)) days.set(item.day, [...(days.get(item.day) ?? []), item]);
  return [...days].map(([day, list]) => ({ day, items: list }));
}

/**
 * Camera-line minutes (already free of blocked sight and checked against the
 * extra targets, whose largest gap is `gap`) into result rows: minutes failing
 * a filter are left out (counted; those without light pollution data
 * separately), runs break where they do and, on a single day, where the sky
 * changes; nearly coincident runs once.
 */
export function lineItems(points: readonly (PositionPoint & { day: string; share: number | null; gap?: number })[], input: {
  body: AlignmentBody;
  filters: readonly FilterSpec[];
  splitSky: boolean;
  /** Wanted top-to-foot share, when a foot is placed. */
  share: number | null;
  /** The camera's light pollution, for 星空可见性. */
  artificial?: (point: { latitude: number; longitude: number }) => number | null | undefined;
}) {
  let filtered = 0, missing = 0;
  const kept = input.filters.length ? points.filter((point) => {
    if (point.sight === "blocked") return true;
    const result = filterResult(input.filters, conditionsAt(point.time, point.latitude, point.longitude), input.artificial?.(point));
    if (result === "fail") filtered++;
    if (result === "missing") missing++;
    return result === "pass";
  }) : [...points];
  const merged = mergeCandidates(rangeCandidates({ body: input.body }, kept, { splitSky: input.splitSky }));
  const items: ResultItem[] = merged.candidates.map((candidate) => {
    const middle = candidate.middle, conditions = conditionsAt(middle.time, middle.latitude, middle.longitude);
    const deviation = Math.max(...candidate.points.map((point) =>
      Math.max(input.share === null ? 0 : Math.abs((point.share ?? input.share) - input.share), point.gap ?? 0)));
    return {
      key: candidate.key, day: candidate.day, start: candidate.start, end: candidate.end, best: middle.time,
      points: candidate.points, camera: { latitude: middle.latitude, longitude: middle.longitude },
      near: candidate.near, far: candidate.far, bearing: middle.azimuth, deviation, share: candidate.share,
      sky: candidate.sky, moonElevation: conditions.moonElevation, moonLit: conditions.moonLit, clear: candidate.clear, aim: null,
    };
  });
  return { items, filtered, missing, merged: merged.merged };
}

/** A time window of a still camera as a result row (`day` in the plan's zone). */
export function windowItem(window: { start: number; end: number; best: number; deviation: number }, camera: { latitude: number; longitude: number }, aim: { azimuth: number; pitch: number }, day: string): ResultItem {
  const conditions = conditionsAt(window.best, camera.latitude, camera.longitude);
  return {
    key: `${day}/${window.best}/${camera.latitude.toFixed(6)}/${camera.longitude.toFixed(6)}`, day,
    start: window.start, end: window.end, best: window.best, points: null, camera,
    near: null, far: null, bearing: null, deviation: window.deviation, share: null,
    sky: conditions.sky, moonElevation: conditions.moonElevation, moonLit: conditions.moonLit, clear: 1, aim,
  };
}

/** What a search was made with: the lens, the ground point (lines and fixed cameras) and the bodies. */
export interface SearchBasis {
  lens: Lens;
  ground: GroundSpec | null;
  bodies: AlignmentBody[];
  /** Two bodies: the first is kept at its place as the minutes move (the aim follows it). */
  follow?: { body: AlignmentBody; frame: FrameSpot; refraction: ShootingPlan["refraction"] };
}
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
/**
 * The plan fields a try-out writes: camera, instant, direction and the
 * bodies' layers. Along a line the minute `time` picks the camera there and
 * the top goes to its place; a still camera keeps its aim.
 */
export function tryPatch(item: ResultItem, basis: SearchBasis, layers: ShootingPlan["layers"], time = item.best): Partial<ShootingPlan> {
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  // A camera place for two ground points: the place and the aim, never the time.
  if (item.place && item.aim)
    return { latitude: round(item.camera.latitude, 6), longitude: round(item.camera.longitude, 6), azimuth: round(item.aim.azimuth, 4), pitch: round(item.aim.pitch, 4) };
  if (item.points && basis.ground) {
    const point = item.points.find((entry) => entry.time === time) ?? item.points.find((entry) => entry.time === item.best) ?? item.points[0];
    const patch = pointPlan(layers, point, basis.bodies[0], { frame: ndc(basis.ground.frame), lens: basis.lens });
    return { ...patch, layers: { ...patch.layers, ...Object.fromEntries(basis.bodies.map((body) => [bodyLayer(body), true])) } };
  }
  const aim = basis.follow
    ? aimAt(basis.lens, skyAt(basis.follow.body, time, item.camera.latitude, item.camera.longitude, basis.follow.refraction), ndc(basis.follow.frame))
    : item.aim;
  return {
    latitude: round(item.camera.latitude, 6), longitude: round(item.camera.longitude, 6), instant: iso(time),
    ...(aim ? { azimuth: round(aim.azimuth, 4), pitch: round(aim.pitch, 4) } : {}),
    layers: { ...layers, ...Object.fromEntries(basis.bodies.map((body) => [bodyLayer(body), true])) },
  };
}
