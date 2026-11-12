import { Temporal } from "@js-temporal/polyfill";
import { celestialBodies, degrees, sunPosition } from "./ephemeris.ts";
import { ellipsoidalRay } from "./geodesy.ts";
import { fieldOfView } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { skyCondition } from "./alignment.ts";
import type { AlignmentBody, SkyCondition } from "./alignment.ts";
import { bodyTrack, finishPositions, MIN_DISTANCE, solvePositions, travel } from "./position-alignment.ts";
import type { GroundSampler, GroundTarget, PositionPoint, SkySample } from "./position-alignment.ts";

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
  maxDistance: number;
}

/** The distances to search and the band shown, for a share or for plain distances. */
export function rangeDistances(target: GroundTarget, share: number | null, lens: Lens, maxDistance: number) {
  if (share === null || target.height < MIN_SUBJECT) return { share: null, angle: null, near: MIN_DISTANCE, far: maxDistance, minDistance: MIN_DISTANCE, maxDistance };
  const band = shareBand(target.height, share, lens);
  // Terrain moves the eye: search a little wider and keep solutions by their actual size.
  return { share, angle: band.angle, near: band.near, far: Math.min(band.far, maxDistance), minDistance: Math.max(MIN_DISTANCE, band.near * 0.8), maxDistance: Math.min(maxDistance, band.far * 1.25) };
}

/** Local calendar days from `start` (a date in `timeZone`), as epoch-millisecond spans. */
export function rangeDays(start: string, days: number, timeZone: string) {
  const first = Temporal.PlainDate.from(start);
  return Array.from({ length: days }, (_, index) => {
    const date = first.add({ days: index });
    return {
      day: date.toString(),
      start: date.toZonedDateTime({ timeZone }).epochMilliseconds,
      end: date.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds,
    };
  });
}

/**
 * Highest apparent elevation the body can have for a solution inside the
 * band: the top seen from the nearest searched distance, from ground as low
 * as BELOW_TARGET under the target's own ground.
 */
export function altitudeCeiling(input: Pick<RangeInput, "target" | "minDistance">) {
  return Math.atan((input.target.height + BELOW_TARGET) / input.minDistance) / degrees;
}

/** The body's minutes of one day that can still give a solution in the band. */
export function rangeTrack(input: RangeInput, span: { start: number; end: number }) {
  const ceiling = altitudeCeiling(input);
  return bodyTrack({ ...input, start: span.start, end: span.end }).filter((sample) => sample.elevation <= ceiling);
}

/** Points from the target out to the band's far edge along every bearing used, for loading DEM tiles. */
export function rangeCorridor(input: RangeInput, tracks: readonly (readonly SkySample[])[], spacing = 500) {
  const bearings = new Set<number>();
  for (const track of tracks) for (const sample of track) bearings.add(Math.round(((sample.azimuth + 180) % 360) * 4) / 4);
  const points = [{ latitude: input.target.latitude, longitude: input.target.longitude }];
  for (const bearing of bearings)
    for (let distance = spacing; distance <= input.maxDistance + spacing; distance += spacing)
      points.push(travel(input.target, bearing, Math.min(distance, input.maxDistance)));
  return points;
}

/** Bearings from the target (merged within 1°) where the camera can be over the range. */
export function reachableSectors(tracks: readonly (readonly SkySample[])[]) {
  const bearings = [...new Set(tracks.flatMap((track) => track.map((sample) => Math.round(((sample.azimuth + 180) % 360) * 10) / 10)))].sort((a, b) => a - b);
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
  const base = { latitude: input.target.latitude, longitude: input.target.longitude, ellipsoidalHeight: targetGround };
  const low = input.share === null ? 0 : input.share * (1 - SHARE_TOLERANCE), high = input.share === null ? Infinity : input.share * (1 + SHARE_TOLERANCE);
  const points: RangePoint[] = [];
  for (const point of result.points) {
    const ray = ellipsoidalRay({ latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: point.cameraGround + input.cameraHeight }, base);
    const below = Math.asin(ray[2] / Math.hypot(...ray)) / degrees;
    const angle = point.elevation - below;
    const share = input.share === null ? null : shareOf(angle, input.lens);
    if (share !== null && (share < low || share > high)) continue;
    points.push({ ...point, day: day.day, share });
  }
  return points;
}

export interface RangeCandidate {
  key: string;
  day: string;
  points: RangePoint[];
  middle: RangePoint;
  start: number;
  end: number;
  near: number;
  far: number;
  share: readonly [number, number] | null;
  sky: SkyCondition;
  /** Moon only. */
  illuminated: number | null;
  /** Share of the minutes whose sight line clears the DEM. */
  clear: number;
}

/** Runs of consecutive minutes of one branch on one day. */
export function rangeCandidates(input: Pick<RangeInput, "body" | "target">, points: readonly RangePoint[]) {
  const candidates: RangeCandidate[] = [];
  const runs = new Map<string, RangePoint[][]>();
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    const key = `${point.day}/${point.branch}`;
    const list = runs.get(key) ?? [];
    const run = list.at(-1);
    if (run && point.time - run.at(-1)!.time <= 60_000) run.push(point);
    else list.push([point]);
    runs.set(key, list);
  }
  for (const [key, list] of runs)
    list.forEach((run, index) => {
      const middle = run[Math.floor(run.length / 2)];
      const instant = new Date(middle.time).toISOString();
      const position = { latitude: middle.latitude, longitude: middle.longitude, instant };
      const shares = run.map((point) => point.share).filter((share): share is number => share !== null);
      candidates.push({
        key: `${key}/${index}`,
        day: middle.day,
        points: run,
        middle,
        start: run[0].time,
        end: run.at(-1)!.time,
        near: Math.min(...run.map((point) => point.distance)),
        far: Math.max(...run.map((point) => point.distance)),
        share: shares.length ? [Math.min(...shares), Math.max(...shares)] : null,
        sky: skyCondition(sunPosition(position).elevation),
        illuminated: input.body === "moon" ? celestialBodies(position).moon.illuminatedFraction : null,
        clear: run.filter((point) => point.sight === "clear").length / run.length,
      });
    });
  return candidates.sort((a, b) => a.start - b.start);
}

/** Moon phase and sky filters, counted once each (phase first) like "找时间". */
export function filterCandidates(candidates: readonly RangeCandidate[], filters: { phase?: readonly [number, number]; sky?: readonly SkyCondition[] }) {
  const kept: RangeCandidate[] = [];
  const filtered = { phase: 0, sky: 0 };
  for (const candidate of candidates) {
    if (candidate.illuminated !== null && filters.phase && (candidate.illuminated < filters.phase[0] || candidate.illuminated > filters.phase[1])) filtered.phase++;
    else if (candidate.illuminated !== null && filters.sky && !filters.sky.includes(candidate.sky)) filtered.sky++;
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
