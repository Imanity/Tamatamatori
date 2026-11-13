import { Body, Illumination } from "astronomy-engine";
import { aimAt, bodyRadius, frameDirection, skyCondition } from "./alignment.ts";
import type { AlignmentBody, FramePoint, SkyCondition } from "./alignment.ts";
import { projectDirection } from "./celestial-projection.ts";
import type { View } from "./celestial-projection.ts";
import { direction } from "./ephemeris.ts";
import { fieldOfView, frameAspectRatio } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { pointPlan, skyAt } from "./position-alignment.ts";
import type { PositionPoint } from "./position-alignment.ts";
import { mergeCandidates, MIN_SUBJECT, rangeCandidates } from "./range-alignment.ts";
import { bodyLayer, bodyName, DARK_SUN_ELEVATION, isFixedBody } from "./sky-targets.ts";
import { landmarks } from "./landmarks.ts";

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
export const TARGET_LIMIT = 2;
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
}
export interface SkySpec {
  kind: "sky";
  id: string;
  body: AlignmentBody;
  frame: FrameSpot;
  tolerance: number;
}
export type TargetSpec = GroundSpec | SkySpec;

export type CameraRange =
  | { mode: "free"; maxDistance: number }
  | { mode: "near"; latitude: number; longitude: number; radius: number }
  | { mode: "fixed"; latitude: number; longitude: number; aim: { azimuth: number; pitch: number } | null };
export type TimeRange = { mode: "range"; date: string; days: number } | { mode: "instant"; instant: string };
export type FilterSpec =
  | { kind: "sky"; sky: SkyCondition[] }
  | { kind: "moonDown" }
  | { kind: "moonLit"; range: [number, number] };

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

export type Strategy =
  | { kind: "line"; ground: GroundSpec; sky: SkySpec }
  | { kind: "window"; ground: GroundSpec | null; sky: SkySpec }
  | { kind: "pair"; first: SkySpec; second: SkySpec };
export type Shape = "lines" | "points" | "windows";
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
  if (targets.length > TARGET_LIMIT) return stop(`目前最多 ${TARGET_LIMIT} 个目标；更多目标将在下一步支持。`);
  if (grounds.length > 1) return stop("两个地面点作主约束将在第三步支持；请保留一个地面点，另加一个天体。");
  if (skies.some((sky) => sky.body === "moon") && filters.some((filter) => filter.kind === "moonDown"))
    return stop("目标里有月亮，却要求“月亮在地平线下”：请删掉其中一个。");
  const base = grounds.find((ground) => ground.base !== null);
  if (base && (base.reference === "sea" || base.height < MIN_SUBJECT))
    return stop(`“${base.name}”的底部位置只用于距地表至少 ${MIN_SUBJECT} m 的点（塔、楼）。`);
  if (base && base.base! <= base.frame.y) return stop(`“${base.name}”的底部应在顶部下方。`);
  const fixed = camera.mode === "fixed";
  if (fixed && time.mode === "instant") return stop("机位与时刻都已固定，没有可搜索的量；直接看预览即可。");
  if (fixed && camera.aim) {
    if (grounds.length) return stop("固定朝向时，地面点在画面中的位置由朝向决定：请删掉地面点，或不固定朝向。");
    if (skies.length > 1) return stop("固定朝向时只支持一个天体。");
    return { strategy: { kind: "window", ground: null, sky: skies[0] }, shape: "windows", message: `机位与朝向固定：求${bodyName(skies[0].body)}落到画面位置的时刻。` };
  }
  if (targets.length === 1)
    return stop(grounds.length
      ? "只有一个地面点：任何机位都能对准它。再加一个天体。"
      : "只有一个天体：只要它在地平线上，任何时刻都能对准。再加一个地面点或天体。");
  if (grounds.length === 1) {
    const [ground] = grounds, [sky] = skies;
    if (fixed) return { strategy: { kind: "window", ground, sky }, shape: "windows", message: `机位固定：由“${ground.name}”定朝向，求${bodyName(sky.body)}经过画面位置的时刻。` };
    return time.mode === "instant"
      ? { strategy: { kind: "line", ground, sky }, shape: "points", message: "时刻固定：结果为机位点。" }
      : { strategy: { kind: "line", ground, sky }, shape: "lines", message: "结果为机位线：每个时刻一处机位，在地图上画成线。" };
  }
  if (time.mode === "instant") return stop("两个天体的相对位置只随时间变化；时刻固定时无从搜索。");
  return {
    strategy: { kind: "pair", first: skies[0], second: skies[1] },
    shape: "windows",
    message: `结果为时刻：两个天体在画面中的相对位置与机位基本无关${skies.some((sky) => sky.body === "moon") ? "（月亮略有视差）" : ""}，按${fixed ? "固定" : "当前"}机位计算。`,
  };
}

// ---------------------------------------------------------------- 筛选

export interface Conditions {
  sunElevation: number;
  sky: SkyCondition;
  moonElevation: number;
  moonLit: number;
}
/** Sun and Moon at an instant and place: geometric elevations, as the timeline's sky conditions. */
export function conditionsAt(time: number, latitude: number, longitude: number): Conditions {
  const sun = skyAt("sun", time, latitude, longitude, "none").elevation;
  const moon = skyAt("moon", time, latitude, longitude, "none").elevation;
  return { sunElevation: sun, sky: skyCondition(sun), moonElevation: moon, moonLit: Illumination(Body.Moon, new Date(time)).phase_fraction };
}
export function passes(filters: readonly FilterSpec[], conditions: Conditions) {
  return filters.every((filter) =>
    filter.kind === "sky" ? filter.sky.includes(conditions.sky)
      : filter.kind === "moonDown" ? conditions.moonElevation < 0
        : conditions.moonLit >= filter.range[0] - 1e-9 && conditions.moonLit <= filter.range[1] + 1e-9);
}
export const filterNames: Record<FilterSpec["kind"], string> = { sky: "天空条件", moonDown: "月亮在地平线下", moonLit: "月亮亮面" };

// ---------------------------------------------------------------- 时刻搜索

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
  /** Gap between the second body and its place there, share of the frame height. */
  deviation: number;
}
const MINUTE = 60_000, COARSE = 10 * MINUTE;
const visible = (body: AlignmentBody, elevation: number, sun: number) => elevation > -0.25 && (!isFixedBody(body) || sun <= DARK_SUN_ELEVATION);

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
  for (const time of [...minutes].sort((a, b) => a - b)) {
    const gap = pairGap(input, time);
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
  ({ kind: "ground", id: newId(), name: "富士山顶", ...fuji, height: 0, reference: "ground", frame, base: null, tolerance: DEFAULT_TOLERANCE });
export const templates: readonly Template[] = [
  {
    id: "diamond-fuji",
    name: "钻石富士",
    hint: "日出、日落时太阳落在富士山顶正中；90 天内，机位不限。",
    build: (_plan, date) => ({
      targets: [summit({ x: 0.5, y: 0.6 }), { kind: "sky", id: newId(), body: "sun", frame: { x: 0.5, y: 0.6 }, tolerance: DEFAULT_TOLERANCE }],
      camera: { mode: "free", maxDistance: 30_000 }, time: { mode: "range", date, days: 90 }, filters: [{ kind: "sky", sky: ["golden"] }],
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
        camera: { mode: "free", maxDistance: 30_000 }, time: { mode: "range", date, days: 30 }, filters: [],
      };
    },
  },
  {
    id: "deep-sky-over-summit",
    name: "深空天体在山顶上方",
    hint: "仙女座星系在富士山顶正上方，山顶在下三分线；暗夜、月亮在地平线下，90 天内。",
    build: (_plan, date) => ({
      targets: [summit({ x: 0.5, y: 2 / 3 }), { kind: "sky", id: newId(), body: "dso-ngc0224", frame: { x: 0.5, y: 0.52 }, tolerance: DEFAULT_TOLERANCE }],
      camera: { mode: "free", maxDistance: 30_000 }, time: { mode: "range", date, days: 90 }, filters: [{ kind: "sky", sky: ["night"] }, { kind: "moonDown" }],
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
}
export interface DayGroup {
  day: string;
  items: ResultItem[];
}

export function groupByDay(items: readonly ResultItem[]): DayGroup[] {
  const days = new Map<string, ResultItem[]>();
  for (const item of [...items].sort((a, b) => a.start - b.start)) days.set(item.day, [...(days.get(item.day) ?? []), item]);
  return [...days].map(([day, list]) => ({ day, items: list }));
}

/**
 * Camera-line minutes (already free of blocked sight) into result rows:
 * minutes failing a filter are left out (counted), runs break where they
 * do and, on a single day, where the sky changes; nearly coincident runs once.
 */
export function lineItems(points: readonly (PositionPoint & { day: string; share: number | null })[], input: {
  body: AlignmentBody;
  filters: readonly FilterSpec[];
  splitSky: boolean;
  /** Wanted top-to-foot share, when a foot is placed. */
  share: number | null;
}) {
  let filtered = 0;
  const kept = input.filters.length ? points.filter((point) => {
    const ok = point.sight === "blocked" || passes(input.filters, conditionsAt(point.time, point.latitude, point.longitude));
    if (!ok) filtered++;
    return ok;
  }) : [...points];
  const merged = mergeCandidates(rangeCandidates({ body: input.body }, kept, { splitSky: input.splitSky }));
  const items: ResultItem[] = merged.candidates.map((candidate) => {
    const middle = candidate.middle, conditions = conditionsAt(middle.time, middle.latitude, middle.longitude);
    const deviation = input.share === null ? 0 : Math.max(...candidate.points.map((point) => Math.abs((point.share ?? input.share!) - input.share!)));
    return {
      key: candidate.key, day: candidate.day, start: candidate.start, end: candidate.end, best: middle.time,
      points: candidate.points, camera: { latitude: middle.latitude, longitude: middle.longitude },
      near: candidate.near, far: candidate.far, bearing: middle.azimuth, deviation, share: candidate.share,
      sky: candidate.sky, moonElevation: conditions.moonElevation, moonLit: conditions.moonLit, clear: candidate.clear, aim: null,
    };
  });
  return { items, filtered, merged: merged.merged };
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
  if (item.points && basis.ground) {
    const point = item.points.find((entry) => entry.time === time) ?? item.points.find((entry) => entry.time === item.best) ?? item.points[0];
    return pointPlan(layers, point, basis.bodies[0], { frame: ndc(basis.ground.frame), lens: basis.lens });
  }
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const aim = basis.follow
    ? aimAt(basis.lens, skyAt(basis.follow.body, time, item.camera.latitude, item.camera.longitude, basis.follow.refraction), ndc(basis.follow.frame))
    : item.aim;
  return {
    latitude: round(item.camera.latitude, 6), longitude: round(item.camera.longitude, 6), instant: iso(time),
    ...(aim ? { azimuth: round(aim.azimuth, 4), pitch: round(aim.pitch, 4) } : {}),
    layers: { ...layers, ...Object.fromEntries(basis.bodies.map((body) => [bodyLayer(body), true])) },
  };
}
