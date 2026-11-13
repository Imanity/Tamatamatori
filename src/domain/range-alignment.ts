import { Temporal } from "@js-temporal/polyfill";
import { Body, Illumination } from "astronomy-engine";
import { celestialBodies, degrees, sunPosition } from "./ephemeris.ts";
import { ellipsoidalRay } from "./geodesy.ts";
import { fieldOfView } from "./plan.ts";
import { aimAt } from "./alignment.ts";
import { projectDirection } from "./celestial-projection.ts";
import type { ShootingPlan } from "./plan.ts";
import { skyCondition } from "./alignment.ts";
import type { AlignmentBody, SkyCondition } from "./alignment.ts";
import { bodyTrack, cameraBearing, finishPositions, groundDistance, MIN_DISTANCE, skyAt, solvePositions, travel } from "./position-alignment.ts";
import type { GroundSampler, GroundTarget, PairFrames, PositionPoint, SkySample } from "./position-alignment.ts";

/**
 * "推算 · 两者都找": a ground target over a range of dates. The composition
 * fixes how tall the subject looks (its share of the frame height, with the
 * frame centred on its top), which fixes a distance band; each day is then
 * solved like "找机位" inside that band, and runs of solutions become
 * candidates (a date, a few minutes and a short stretch of ground).
 */

/** The subject's share may differ by this fraction of itself. */
export const SHARE_TOLERANCE = 0.2;
/** Below this height above the ground a "subject size" means nothing (a summit): distances are given instead. */
export const MIN_SUBJECT = 10;
export const spanChoices = [7, 30, 90, 365] as const;
// Camera ground may lie this far below the target's ground before the altitude pre-filter could miss a solution.
const BELOW_TARGET = 300;
// Camera ground no lower than this below sea level, when the target's own ground is known.
const LOWEST_CAMERA = 500;

type Lens = Pick<ShootingPlan, "focalLength" | "sensor" | "aspectRatio" | "orientation"> & Partial<Pick<ShootingPlan, "customSensor">>;

/** Share of the frame height covered from its centre (the top) down to an object `angle` degrees below. */
export function shareOf(angle: number, lens: Lens) {
  return Math.tan(angle * degrees) / (2 * Math.tan((fieldOfView(lens).vertical / 2) * degrees));
}
/** Angle below the centre that covers `share` of the frame height. */
export function angleOf(share: number, lens: Lens) {
  return Math.atan(share * 2 * Math.tan((fieldOfView(lens).vertical / 2) * degrees)) / degrees;
}

/**
 * Distances at which a subject `height` metres tall covers `share` of the frame
 * (±SHARE_TOLERANCE), for a camera near the subject's base on level ground.
 * The solver searches a wider band and keeps solutions by their actual size.
 */
export function shareBand(height: number, share: number, lens: Lens) {
  const angle = angleOf(share, lens);
  const near = height / Math.tan(angleOf(share * (1 + SHARE_TOLERANCE), lens) * degrees);
  const far = height / Math.tan(angleOf(share * (1 - SHARE_TOLERANCE), lens) * degrees);
  return { angle, near: Math.max(MIN_DISTANCE, near), far };
}

export interface RangeInput {
  body: AlignmentBody;
  target: GroundTarget;
  refraction: ShootingPlan["refraction"];
  cameraHeight: number;
  lens: Lens;
  /** Wanted share of the frame height, or null to use the distances alone (a low target). */
  share: number | null;
  /** Searched distances: the share band widened, or MIN_DISTANCE to the chosen maximum. */
  minDistance: number;
  /**
   * The target's ground elevation (m), read before the search: the altitude
   * pre-filter then allows cameras far below it (a summit). Without it,
   * cameras are assumed no more than BELOW_TARGET under that ground.
   */
  targetGround?: number;
  maxDistance: number;
  /** Where the top and the body sit in the frame (the body on the top at the centre when absent). */
  frames?: PairFrames;
  /**
   * Where the target's foot (the ground under it) should appear, as a frame
   * y (normalised device coordinates), and how far it may be, as a share of
   * the frame height. Replaces `share` when given.
   */
  base?: { y: number; tolerance: number };
  /** Filters checked at the target before solving, with a margin (results are checked exactly afterwards). */
  prefilter?: Prefilter;
}

/** The search's sky and Moon filters, as a pre-check of each minute at the target. */
export interface Prefilter {
  sky?: readonly SkyCondition[];
  moonDown?: boolean;
  moonLit?: readonly [number, number];
  /** 星空可见性: astronomical night (the Sun below −18°). */
  night?: boolean;
  /**
   * Further bodies at a set angle (degrees) from the searched body, within
   * `tolerance`: the angle between two frame places is the same wherever the
   * camera points, so minutes far from it cannot place both.
   */
  separations?: readonly { body: AlignmentBody; angle: number; tolerance: number }[];
}
const unitOf = (sample: { azimuth: number; elevation: number }) => {
  const azimuth = sample.azimuth * degrees, elevation = sample.elevation * degrees;
  return [Math.sin(azimuth) * Math.cos(elevation), Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation)];
};
/** The angle between two sky directions, degrees. */
export function skySeparation(a: { azimuth: number; elevation: number }, b: { azimuth: number; elevation: number }) {
  const one = unitOf(a), two = unitOf(b);
  return Math.acos(Math.max(-1, Math.min(1, one[0] * two[0] + one[1] * two[1] + one[2] * two[2]))) / degrees;
}
// Cameras stand within about 30 km: the Sun and Moon there differ by under 0.3° from the target.
const PREFILTER_MARGIN = 0.5;
// Refraction near the horizon squeezes a separation by up to about 0.2°.
const SEPARATION_MARGIN = 0.3;
/** Whether a minute can pass the filters somewhere near the target (`body`: the searched body, for separations). */
export function prefilterPasses(filter: Prefilter, time: number, latitude: number, longitude: number, body?: AlignmentBody) {
  if (filter.separations?.length && body) {
    const own = skyAt(body, time, latitude, longitude, "none");
    for (const other of filter.separations) {
      const seen = skyAt(other.body, time, latitude, longitude, "none");
      if (seen.elevation < -1 || Math.abs(skySeparation(own, seen) - other.angle) > other.tolerance + SEPARATION_MARGIN) return false;
    }
  }
  if (filter.sky || filter.night) {
    const sun = skyAt("sun", time, latitude, longitude, "none").elevation;
    if (filter.sky && ![sun - PREFILTER_MARGIN, sun, sun + PREFILTER_MARGIN].some((elevation) => filter.sky!.includes(skyCondition(elevation)))) return false;
    if (filter.night && sun - PREFILTER_MARGIN >= -18) return false;
  }
  if (filter.moonDown && skyAt("moon", time, latitude, longitude, "none").elevation > PREFILTER_MARGIN) return false;
  if (filter.moonLit) {
    const lit = Illumination(Body.Moon, new Date(time)).phase_fraction;
    if (lit < filter.moonLit[0] - 0.01 || lit > filter.moonLit[1] + 0.01) return false;
  }
  return true;
}

/**
 * Distances to search for a foot at frame y `base` below a top at `top`
 * (normalised device coordinates). The band of `shareBand` assumes the top at
 * the centre, so it is widened; solutions are kept by their actual foot.
 */
export function baseDistances(target: GroundTarget, top: number, base: number, lens: Lens, maxDistance: number) {
  const share = (base - top) / 2;
  if (!(share > 0) || target.absolute || target.height < MIN_SUBJECT) return null;
  const band = shareBand(target.height, share, lens);
  return { share, near: band.near, far: Math.min(band.far, maxDistance), minDistance: Math.max(MIN_DISTANCE, band.near * 0.6), maxDistance: Math.min(maxDistance, band.far * 1.6) };
}

/** The distances to search and the band shown, for a share or for plain distances. */
export function rangeDistances(target: GroundTarget, share: number | null, lens: Lens, maxDistance: number) {
  if (share === null || target.height < MIN_SUBJECT) return { share: null, angle: null, near: MIN_DISTANCE, far: maxDistance, minDistance: MIN_DISTANCE, maxDistance };
  const band = shareBand(target.height, share, lens);
  // Terrain moves the eye: search a little wider and keep solutions by their actual size.
  return { share, angle: band.angle, near: band.near, far: Math.min(band.far, maxDistance), minDistance: Math.max(MIN_DISTANCE, band.near * 0.8), maxDistance: Math.min(maxDistance, band.far * 1.25) };
}

/** Local calendar days from `start` (a date in `timeZone`), as epoch-millisecond spans. */
/**
 * The days of a search. At night (`seam` "noon") a day runs from local noon to
 * the next noon and is named after its evening, so a night is never cut.
 */
export function rangeDays(start: string, days: number, timeZone: string, seam: "midnight" | "noon" = "midnight") {
  const first = Temporal.PlainDate.from(start);
  const at = (date: Temporal.PlainDate) => date.toZonedDateTime({ timeZone, plainTime: seam === "noon" ? "12:00" : undefined }).epochMilliseconds;
  return Array.from({ length: days }, (_, index) => {
    const date = first.add({ days: index });
    return { day: date.toString(), start: at(date), end: at(date.add({ days: 1 })) };
  });
}

/**
 * Highest apparent elevation the body can have for a solution inside the
 * band: the top seen from the nearest searched distance, from ground as low
 * as BELOW_TARGET under the target's own ground.
 */
export function altitudeCeiling(input: Pick<RangeInput, "target" | "minDistance" | "frames" | "targetGround">) {
  // With the target's ground known, the top's own elevation over camera ground down to 500 m below sea level;
  // otherwise an absolute top over ground near sea level, a top over ground at most BELOW_TARGET lower.
  const rise = input.targetGround !== undefined
    ? (input.target.absolute ? input.target.height : input.targetGround + input.target.height) + LOWEST_CAMERA
    : input.target.absolute ? input.target.height + 50 : input.target.height + BELOW_TARGET;
  const top = Math.atan(rise / input.minDistance) / degrees;
  if (!input.frames) return top;
  // The body may sit above the top in the frame: add that much, generously (it is only a pre-filter).
  const lift = Math.max(0, (input.frames.target.y - input.frames.body.y) / 2) * fieldOfView(input.frames.lens).vertical;
  return top + lift * 1.2 + 1;
}

/** The body's minutes of one day that can still give a solution in the band. */
export function rangeTrack(input: RangeInput, span: { start: number; end: number }) {
  const ceiling = altitudeCeiling(input);
  const { prefilter, target } = input;
  return bodyTrack({ ...input, start: span.start, end: span.end }).filter((sample) => sample.elevation <= ceiling
    && (!prefilter || prefilterPasses(prefilter, sample.time, target.latitude, target.longitude, input.body)));
}

/** Points from the target out to the band's far edge along every bearing used, for loading DEM tiles. */
export function rangeCorridor(input: RangeInput, tracks: readonly (readonly SkySample[])[], spacing = 500) {
  const bearings = new Set<number>();
  for (const track of tracks) for (const sample of track) bearings.add(Math.round((((cameraBearing(sample, input.frames) % 360) + 360) % 360) * 4) / 4);
  const points = [{ latitude: input.target.latitude, longitude: input.target.longitude }];
  for (const bearing of bearings)
    for (let distance = spacing; distance <= input.maxDistance + spacing; distance += spacing)
      points.push(travel(input.target, bearing, Math.min(distance, input.maxDistance)));
  return points;
}

/** Bearings from the target (merged within 1°) where the camera can be over the range. */
export function reachableSectors(tracks: readonly (readonly SkySample[])[], frames?: PairFrames) {
  const bearings = [...new Set(tracks.flatMap((track) => track.map((sample) => Math.round((((cameraBearing(sample, frames) % 360) + 360) % 360) * 10) / 10)))].sort((a, b) => a - b);
  const sectors: [number, number][] = [];
  for (const bearing of bearings) {
    const last = sectors.at(-1);
    if (last && bearing - last[1] <= 1) last[1] = bearing;
    else sectors.push([bearing, bearing]);
  }
  // Join across north.
  if (sectors.length > 1 && sectors[0][0] + 360 - sectors.at(-1)![1] <= 1) {
    const first = sectors.shift()!;
    sectors[sectors.length - 1][1] = first[1] + 360;
  }
  return sectors;
}

export type RangePoint = PositionPoint & { day: string; share: number | null };

/** One day of the range: "找机位" in the band, each solution with its actual subject share. */
export function solveRangeDay(input: RangeInput, day: { day: string; start: number; end: number }, track: readonly SkySample[], sampler: GroundSampler) {
  const targetGround = sampler(input.target.latitude, input.target.longitude);
  if (targetGround === null || !track.length) return [];
  const position = { ...input, start: day.start, end: day.end };
  const result = finishPositions(track, [solvePositions(position, track, sampler)], targetGround);
  const foot = { latitude: input.target.latitude, longitude: input.target.longitude, ellipsoidalHeight: targetGround };
  const low = input.share === null ? 0 : input.share * (1 - SHARE_TOLERANCE), high = input.share === null ? Infinity : input.share * (1 + SHARE_TOLERANCE);
  const points: RangePoint[] = [];
  for (const point of result.points) {
    const ray = ellipsoidalRay({ latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: point.cameraGround + input.cameraHeight }, foot);
    if (input.base && input.frames) {
      // The foot where the camera, aimed so the top sits at its place, actually shows it.
      const aim = aimAt(input.frames.lens, point, input.frames.target);
      const seen = projectDirection({ ...input.frames.lens, ...aim }, [ray[0], ray[1], ray[2]]);
      if (!seen || Math.abs(seen.y - input.base.y) / 2 > input.base.tolerance) continue;
      points.push({ ...point, day: day.day, share: (seen.y - input.frames.target.y) / 2 });
      continue;
    }
    const below = Math.asin(ray[2] / Math.hypot(...ray)) / degrees;
    const angle = point.elevation - below;
    const share = input.share === null ? null : shareOf(angle, input.lens);
    if (share !== null && (share < low || share > high)) continue;
    points.push({ ...point, day: day.day, share });
  }
  return points;
}

/**
 * A run of consecutive minutes of one alignment line (one day of it for
 * 两者都找) whose sight to the target is not cut by the terrain: one row of the
 * results, tried out at its middle minute.
 */
export interface Candidate<T extends PositionPoint = RangePoint> {
  key: string;
  /** Local date for 两者都找; empty for 找机位 (one span). */
  day: string;
  points: T[];
  middle: T;
  start: number;
  end: number;
  near: number;
  far: number;
  share: readonly [number, number] | null;
  sky: SkyCondition;
  /** Moon only. */
  illuminated: number | null;
  /** Share of the minutes with terrain data all along the sight line (the rest: data missing somewhere). */
  clear: number;
}
export type RangeCandidate = Candidate<RangePoint>;

/**
 * Runs of consecutive minutes of one branch (and day), leaving out the
 * minutes whose sight line the terrain cuts: a run blocked in the middle
 * becomes two. With `splitSky` (找机位: one long day per line) a run also
 * breaks where the sky changes (day, golden hour, blue hour…), so each row has one.
 * The key names the run and its middle, so a different solution never takes an old row's place.
 */
export function rangeCandidates<T extends PositionPoint & { day?: string; share?: number | null }>(input: Pick<RangeInput, "body">, points: readonly T[], options: { splitSky?: boolean } = {}): Candidate<T>[] {
  const candidates: Candidate<T>[] = [];
  const runs = new Map<string, { points: T[]; sky: SkyCondition | null }[]>();
  const skyAt = (point: T) => skyCondition(sunPosition({ latitude: point.latitude, longitude: point.longitude, instant: new Date(point.time).toISOString() }).elevation);
  for (const point of points.filter((item) => item.sight !== "blocked").sort((a, b) => a.time - b.time)) {
    const key = `${point.day ?? ""}/${point.branch}`;
    const sky = options.splitSky ? skyAt(point) : null;
    const list = runs.get(key) ?? [];
    const run = list.at(-1);
    if (run && point.time - run.points.at(-1)!.time <= 60_000 && run.sky === sky) run.points.push(point);
    else list.push({ points: [point], sky });
    runs.set(key, list);
  }
  for (const [key, list] of runs)
    list.forEach(({ points: run, sky }, index) => {
      const middle = run[Math.floor(run.length / 2)];
      const instant = new Date(middle.time).toISOString();
      const position = { latitude: middle.latitude, longitude: middle.longitude, instant };
      const shares = run.map((point) => point.share).filter((share): share is number => typeof share === "number");
      candidates.push({
        key: `${key}/${index}@${middle.time}/${middle.latitude.toFixed(6)}/${middle.longitude.toFixed(6)}`,
        day: middle.day ?? "",
        points: run,
        middle,
        start: run[0].time,
        end: run.at(-1)!.time,
        near: Math.min(...run.map((point) => point.distance)),
        far: Math.max(...run.map((point) => point.distance)),
        share: shares.length ? [Math.min(...shares), Math.max(...shares)] : null,
        sky: sky ?? skyCondition(sunPosition(position).elevation),
        illuminated: input.body === "moon" ? celestialBodies(position).moon.illuminatedFraction : null,
        clear: run.filter((point) => point.sight === "clear").length / run.length,
      });
    });
  return candidates.sort((a, b) => a.start - b.start);
}

/** Minutes (of each day) with a solution whose sight line the terrain cuts: counted, never listed. */
export function blockedMinutes(points: readonly (PositionPoint & { day?: string })[]) {
  return new Set(points.filter((point) => point.sight === "blocked").map((point) => `${point.day ?? ""}/${point.time}`)).size;
}

/** Moon phase and sky filters, counted once each (phase first) like "找时间"; the Sun is never filtered. */
export function filterCandidates<T extends Candidate<PositionPoint>>(candidates: readonly T[], filters: { phase?: readonly [number, number]; sky?: readonly SkyCondition[] }, body?: AlignmentBody) {
  const kept: T[] = [];
  const filtered = { phase: 0, sky: 0 };
  for (const candidate of candidates) {
    if (candidate.illuminated !== null && filters.phase && (candidate.illuminated < filters.phase[0] || candidate.illuminated > filters.phase[1])) filtered.phase++;
    else if (body !== "sun" && filters.sky && !filters.sky.includes(candidate.sky)) filtered.sky++;
    else kept.push(candidate);
  }
  return { kept, filtered };
}

/** The whole range in one call (tests and the worker), day by day. */
export function solveRange(input: RangeInput, days: ReturnType<typeof rangeDays>, sampler: GroundSampler, onDay?: (index: number, points: RangePoint[]) => void) {
  const points: RangePoint[] = [];
  days.forEach((day, index) => {
    const found = solveRangeDay(input, day, rangeTrack(input, day), sampler);
    points.push(...found);
    onDay?.(index, found);
  });
  return points;
}

type Placed = { time: number; latitude: number; longitude: number; branch?: number };
/**
 * Candidates of one day whose spans touch or overlap are one place in
 * practice (separate roots on the same sight line) when their middles lie
 * within `radius` metres, or when every minute of one has a point of the
 * other at the same minute within `radius`. The one with the most minutes stays.
 */
export function mergeCandidates<T extends { day?: string; start: number; end: number; middle: Placed; points: readonly Placed[]; clear: number }>(candidates: readonly T[], radius = 300) {
  const order = [...candidates].sort((a, b) => b.points.length - a.points.length || b.clear - a.clear || a.start - b.start);
  const covered = (inner: T, outer: T) => inner.points.every((point) =>
    outer.points.some((other) => other.time === point.time && groundDistance(other, point) < radius));
  const kept: T[] = [];
  for (const candidate of order) {
    // Separate roots are different branches; pieces of one line (split by sky or terrain) stay apart.
    const twin = kept.some((other) => other.day === candidate.day &&
      (other.points[0].branch === undefined || other.points[0].branch !== candidate.points[0].branch) &&
      candidate.start <= other.end + 60_000 && candidate.end >= other.start - 60_000 &&
      (groundDistance(other.middle, candidate.middle) < radius || covered(candidate, other)));
    if (!twin) kept.push(candidate);
  }
  return { candidates: kept.sort((a, b) => a.start - b.start), merged: candidates.length - kept.length };
}
