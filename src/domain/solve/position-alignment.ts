import { KM_PER_AU, Observer } from "astronomy-engine";
import { degrees, direction, dot, topocentric } from "../core/ephemeris.ts";
import { apparentElevation } from "../core/refraction.ts";
import { ecefGeodetic, ellipsoidalRay, geodeticEcef } from "../core/geodesy.ts";
import type { EllipsoidalPoint } from "../core/geodesy.ts";
import { normalizeLongitude, signedAngle } from "../core/plan.ts";
import type { ShootingPlan } from "../core/plan.ts";
import { aimAt, frameDirection, targetElevationRange } from "./alignment.ts";
import type { AlignmentBody, FramePoint } from "./alignment.ts";
import type { View } from "../core/celestial-projection.ts";
import { astroBody, bodyLayer, DARK_SUN_ELEVATION, isFixedBody } from "../sky/sky-coordinates.ts";

/**
 * "Find the place" for a ground target and one time span: where must the
 * camera stand so that the Sun or Moon sits on the target's top? For each
 * minute the camera lies on the line from the target away from the body's
 * azimuth, at the distance where the straight (ellipsoidal) ray from the eye
 * to the top climbs at the body's apparent elevation. Heights are the DEM's
 * own numbers, as in the preview; the ray is geometric like the drawn terrain
 * and the body is apparent like the drawn disc.
 */

export interface GroundTarget {
  latitude: number;
  longitude: number;
  /** Height of the aimed point above the DEM ground, metres (0 for a summit); with `absolute`, its own elevation. */
  height: number;
  /** The height is the point's elevation (the terrain's own numbers), not a height above the ground. */
  absolute?: boolean;
  name?: string;
  /**
   * Aim at the top of the skyline within this many metres instead of the point
   * itself: from each camera, the terrain point seen highest (a summit whose
   * highest point hides behind a nearer crater rim).
   */
  skyline?: number;
}

/**
 * Where the target's top and the body should appear in the frame, for the
 * lens that frames them (normalised device coordinates, −1…1, y down). Equal
 * places put the body on the top, as without frames.
 */
export interface PairFrames {
  lens: Omit<View, "azimuth" | "pitch">;
  target: FramePoint;
  body: FramePoint;
}

/** The body direction wanted when the top is seen along `ray`: the camera aims the top at its place, the body sits at its own. */
export function wantedDirection(ray: { azimuth: number; elevation: number }, frames: PairFrames | undefined) {
  if (!frames || (frames.target.x === frames.body.x && frames.target.y === frames.body.y)) return { azimuth: ray.azimuth, elevation: ray.elevation };
  const aim = aimAt(frames.lens, ray, frames.target);
  return frameDirection({ ...frames.lens, ...aim }, frames.body.x, frames.body.y);
}

/** Bearing from the target to the camera for a body direction: opposite to where the camera must look at the top. */
export function cameraBearing(sample: { azimuth: number; elevation: number }, frames: PairFrames | undefined) {
  const wanted = wantedDirection(sample, frames);
  // First order: the top is where the body is, less the body's offset from the top.
  return sample.azimuth - signedAngle(wanted.azimuth - sample.azimuth) + 180;
}
/** Elevation of the top for a body elevation, to first order (the same idea as `cameraBearing`). */
export function topElevation(sample: { azimuth: number; elevation: number }, frames: PairFrames | undefined) {
  return sample.elevation - (wantedDirection(sample, frames).elevation - sample.elevation);
}

/** Elevation of the aimed point above the ground under it, or its own elevation for `absolute`. */
export const topHeight = (target: GroundTarget, ground: number) => (target.absolute ? target.height : ground + target.height);
/** DEM ground at a point, or null where the source has no value. */
export type GroundSampler = (latitude: number, longitude: number) => number | null;

export interface PositionInput {
  body: AlignmentBody;
  target: GroundTarget;
  /** Epoch milliseconds; whole minutes inside [start, end) are solved. */
  start: number;
  end: number;
  refraction: ShootingPlan["refraction"];
  cameraHeight: number;
  maxDistance: number;
  minDistance?: number;
  /** Where the top and the body sit in the frame; the body on the top when absent. */
  frames?: PairFrames;
}

export interface SkySample {
  time: number;
  azimuth: number;
  elevation: number;
}
export type Sight = "clear" | "blocked" | "unknown";
export interface PositionPoint {
  time: number;
  latitude: number;
  longitude: number;
  /** Ground distance from the target, metres. */
  distance: number;
  /** From the camera to the target's top, degrees (the body's direction when it sits on the top). */
  azimuth: number;
  elevation: number;
  cameraGround: number;
  /** Angle between where the body should be (from the ray to the top and the frames) and where it is, degrees. */
  residual: number;
  sight: Sight;
  /** Distance from the camera to the first DEM obstruction, metres. */
  blockedAt?: number;
  /** The skyline top aimed at (a target with `skyline`), and how far it lies from the target point. */
  top?: { latitude: number; longitude: number; ellipsoidalHeight: number; offset: number };
  branch: number;
}
export interface PositionSlice {
  points: Omit<PositionPoint, "branch">[];
  /** Elevation angles of the top seen from the scanned line points, degrees. */
  angles: { min: number; max: number };
  /** Minutes whose line had no DEM value somewhere. */
  gaps: number;
}
export type PositionReason = "below" | "out-of-range" | "no-ground";
export interface PositionResult {
  points: PositionPoint[];
  /** Body apparent elevation over the solved minutes, degrees. */
  sky: { min: number; max: number } | null;
  angles: { min: number; max: number } | null;
  minutes: number;
  blocked: number;
  unknown: number;
  gaps: number;
  targetGround: number | null;
  reason: PositionReason | null;
}

const EARTH = 6_371_008.8;
export const MIN_DISTANCE = 200;
export const distanceChoices = [10_000, 20_000, 30_000] as const;
const SCAN_STEP = 100;
const SIGHT_STEP = 50;
// The eye's own ground and the target's footprint are not obstructions.
const NEAR_EYE = 20, NEAR_TARGET = 50, SIGHT_MARGIN = 0.5;

/** Apparent direction of the body for an observer on the reference ellipsoid. */
export function skyAt(body: AlignmentBody, time: number, latitude: number, longitude: number, refraction: ShootingPlan["refraction"]) {
  const { horizon } = topocentric(astroBody(body), new Date(time), new Observer(latitude, longitude, 0));
  return { azimuth: horizon.azimuth, elevation: apparentElevation(horizon.altitude, refraction) };
}

// The local horizon tilts by about 0.27° over 30 km, so a camera far from the
// target may still see the body above its horizon.
const HORIZON_MARGIN = 0.4;

/** The body for every whole minute of the span while its disc can be drawn near the target. */
export function bodyTrack(input: PositionInput): SkySample[] {
  const samples: SkySample[] = [];
  const lowest = targetElevationRange[0] - HORIZON_MARGIN * Math.min(1, input.maxDistance / 30_000);
  for (let time = Math.ceil(input.start / 60_000) * 60_000; time < input.end; time += 60_000) {
    const sky = skyAt(input.body, time, input.target.latitude, input.target.longitude, input.refraction);
    if (sky.elevation < lowest) continue;
    // A fixed body is only looked for in a dark enough sky.
    // (The geometric Sun elevation; Date-based, so the worker needs no Temporal.)
    if (isFixedBody(input.body) && skyAt("sun", time, input.target.latitude, input.target.longitude, "none").elevation > DARK_SUN_ELEVATION) continue;
    samples.push({ time, ...sky });
  }
  return samples;
}

function enu(latitude: number, longitude: number) {
  const phi = latitude * degrees, lambda = longitude * degrees;
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi), sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
  return {
    east: [-sinLambda, cosLambda, 0] as const,
    north: [-sinPhi * cosLambda, -sinPhi * sinLambda, cosPhi] as const,
    up: [cosPhi * cosLambda, cosPhi * sinLambda, sinPhi] as const,
  };
}

/**
 * The body at one instant as seen from any ground point near `origin`: its
 * position is fixed in Earth coordinates, and each point has its own horizon
 * (and, for the Moon, parallax). Observers sit on the ellipsoid like the
 * preview's; one ephemeris call serves the whole minute.
 */
export function skyField(body: AlignmentBody, time: number, origin: { latitude: number; longitude: number }, refraction: ShootingPlan["refraction"]) {
  const { equator, horizon } = topocentric(astroBody(body), new Date(time), new Observer(origin.latitude, origin.longitude, 0));
  const range = equator.dist * KM_PER_AU * 1000;
  const [e, n, u] = direction(horizon.azimuth, horizon.altitude);
  const basis = enu(origin.latitude, origin.longitude);
  const base = geodeticEcef({ ...origin, ellipsoidalHeight: 0 });
  const position = [0, 1, 2].map((axis) => base[axis] + range * (e * basis.east[axis] + n * basis.north[axis] + u * basis.up[axis]));
  return (latitude: number, longitude: number) => {
    const at = geodeticEcef({ latitude, longitude, ellipsoidalHeight: 0 }), local = enu(latitude, longitude);
    const v = [position[0] - at[0], position[1] - at[1], position[2] - at[2]];
    const east = v[0] * local.east[0] + v[1] * local.east[1];
    const north = v[0] * local.north[0] + v[1] * local.north[1] + v[2] * local.north[2];
    const up = v[0] * local.up[0] + v[1] * local.up[1] + v[2] * local.up[2];
    return {
      azimuth: ((Math.atan2(east, north) / degrees) % 360 + 360) % 360,
      elevation: apparentElevation(Math.atan2(up, Math.hypot(east, north)) / degrees, refraction),
    };
  };
}

/** Point at a ground distance and bearing on a sphere; the solver corrects bearings on the ellipsoid. */
export function travel(from: { latitude: number; longitude: number }, bearing: number, meters: number) {
  const phi = from.latitude * degrees, angle = meters / EARTH, heading = bearing * degrees;
  const latitude = Math.asin(Math.sin(phi) * Math.cos(angle) + Math.cos(phi) * Math.sin(angle) * Math.cos(heading));
  const longitude = from.longitude * degrees + Math.atan2(Math.sin(heading) * Math.sin(angle) * Math.cos(phi), Math.cos(angle) - Math.sin(phi) * Math.sin(latitude));
  return { latitude: latitude / degrees, longitude: normalizeLongitude(longitude / degrees) };
}

/** Points along the lines the solver will read, for loading DEM tiles first. */
export function corridor(input: PositionInput, track: readonly SkySample[], spacing = 1000) {
  const points = [{ latitude: input.target.latitude, longitude: input.target.longitude }];
  const step = Math.max(1, Math.floor(track.length / 60));
  const chosen = track.filter((_, index) => index % step === 0 || index === track.length - 1);
  for (const sample of chosen)
    for (let distance = spacing / 2; distance <= input.maxDistance + spacing / 2; distance += spacing / 2)
      points.push(travel(input.target, cameraBearing(sample, input.frames), Math.min(distance, input.maxDistance)));
  return points;
}

export const toRay = (eye: EllipsoidalPoint, top: EllipsoidalPoint) => {
  const ray = ellipsoidalRay(eye, top);
  const length = Math.hypot(...ray);
  return {
    ray,
    azimuth: ((Math.atan2(ray[0], ray[1]) / degrees) % 360 + 360) % 360,
    elevation: Math.asin(ray[2] / length) / degrees,
  };
};

/** Whether the straight line from the eye to the top passes above the DEM ground. */
export function lineOfSight(eye: EllipsoidalPoint, top: EllipsoidalPoint, sampler: GroundSampler, step = SIGHT_STEP) {
  const from = geodeticEcef(eye), to = geodeticEcef(top);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const count = Math.max(2, Math.ceil(length / step));
  const profile: { distance: number; ground: number | null; sight: number }[] = [];
  let sight: Sight = "clear", blockedAt: number | undefined;
  for (let index = 0; index <= count; index++) {
    const share = index / count;
    const point = ecefGeodetic([from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share, from[2] + (to[2] - from[2]) * share]);
    const ground = sampler(point.latitude, point.longitude);
    const distance = share * length;
    profile.push({ distance, ground, sight: point.ellipsoidalHeight });
    if (distance < NEAR_EYE || length - distance < NEAR_TARGET) continue;
    if (ground === null) {
      if (sight === "clear") sight = "unknown";
    } else if (ground > point.ellipsoidalHeight + SIGHT_MARGIN && sight !== "blocked") {
      sight = "blocked";
      blockedAt = distance;
    }
  }
  return { sight, blockedAt, profile, length };
}

/** Radius of the skyline a summit target is aimed at, and the spacing of its terrain samples, metres. */
export const SKYLINE_RADIUS = 800;
const SKYLINE_STEP = 25;
const METRES_PER_DEGREE = EARTH * degrees;
type SkylinePoint = EllipsoidalPoint & { east: number; north: number; offset: number };

/** Terrain samples on a grid within `radius` of a point (east and north offsets in metres), skipping gaps. */
export function terrainGrid(center: { latitude: number; longitude: number }, radius: number, sampler: GroundSampler, step = SKYLINE_STEP) {
  const across = METRES_PER_DEGREE * Math.cos(center.latitude * degrees);
  const points: { latitude: number; longitude: number; ground: number; east: number; north: number }[] = [];
  for (let north = -radius; north <= radius + 1e-9; north += step)
    for (let east = -radius; east <= radius + 1e-9; east += step) {
      if (Math.hypot(east, north) > radius + 1e-9) continue;
      const latitude = center.latitude + north / METRES_PER_DEGREE, longitude = normalizeLongitude(center.longitude + east / across);
      const ground = sampler(latitude, longitude);
      if (ground !== null) points.push({ latitude, longitude, ground, east, north });
    }
  return points;
}
/** The highest terrain point within `radius` (for “移到附近最高点” and the altitude pre-filter), or null without data. */
export function highestNear(center: { latitude: number; longitude: number }, radius: number, sampler: GroundSampler, step = SKYLINE_STEP) {
  let best: ReturnType<typeof terrainGrid>[number] | null = null;
  for (const point of terrainGrid(center, radius, sampler, step)) if (!best || point.ground > best.ground) best = point;
  return best ? { latitude: best.latitude, longitude: best.longitude, ground: best.ground, offset: Math.hypot(best.east, best.north) } : null;
}

const skylines = new WeakMap<GroundSampler, Map<string, ((eye: EllipsoidalPoint) => SkylinePoint) | null>>();
/**
 * The summit platform of the skyline counts this far (metres of height) below
 * its highest point, as in the field comparison (alignment-validation.md).
 */
export const SKYLINE_DROP = 100;
// Degrees; about a tenth of the Sun's diameter.
const SKYLINE_SETTLED = 0.05;
const SKYLINE_REUSE = 1000;
// Times a bracket is solved again with the top its solution sees.
const SKYLINE_ROUNDS = 4;
/**
 * The top of a summit target as seen from an eye: the middle of its platform.
 * Of the terrain within `target.skyline` metres, the skyline is, for every
 * strip across the line of sight, the point at the largest elevation angle;
 * the platform is the unbroken run of strips around the highest one that stay
 * within SKYLINE_DROP (as an angle at that distance) of it, and the aimed
 * point is the skyline in its middle strip. From a far side a flat summit's
 * highest point may lie at one end of a wide platform, while photographs (a
 * Diamond Fuji) put the Sun in its middle.
 *
 * For each 1° of bearing from the target and each reference distance (steps
 * of 1.1×), the samples are grouped by the direction they are seen in from
 * there (25 m wide at that distance); only the upper hull of a group (offset
 * toward the eye against height) can form the skyline. An eye takes the
 * groups of its nearest reference distance, bins their points by the
 * direction it sees them in (25 m at the target's distance, as the comparison
 * does) and keeps the highest per bin. An eye inside or near the area takes
 * the highest point seen.
 */
export function skylineTop(target: GroundTarget, sampler: GroundSampler) {
  const key = `${target.latitude}/${target.longitude}/${target.height}/${target.skyline}`;
  const cached = skylines.get(sampler)?.get(key);
  if (cached !== undefined) return cached;
  const radius = target.skyline ?? SKYLINE_RADIUS;
  const samples: SkylinePoint[] = terrainGrid(target, radius, sampler).map((point) => ({
    latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: point.ground + target.height,
    east: point.east, north: point.north, offset: Math.hypot(point.east, point.north),
  }));
  const across = METRES_PER_DEGREE * Math.cos(target.latitude * degrees);
  type Candidate = { point: SkylinePoint; along: number; side: number };
  type Fan = { index: number; candidates: Candidate[] };
  const fans = new Map<string, Fan[]>();
  const fansOf = (bin: number, reference: number) => {
    const key = `${bin}/${reference}`, found = fans.get(key);
    if (found) return found;
    const east = Math.sin(bin * degrees), north = Math.cos(bin * degrees);
    const width = SKYLINE_STEP / reference;
    const groups = new Map<number, Candidate[]>();
    for (const point of samples) {
      const side = point.east * north - point.north * east, along = point.east * east + point.north * north;
      const index = Math.round(side / (reference - along) / width);
      const list = groups.get(index) ?? [];
      list.push({ point, along, side });
      groups.set(index, list);
    }
    const result: Fan[] = [...groups].sort((a, b) => a[0] - b[0]).map(([index, list]) => {
      // Upper hull from the far side to the near side; only its part from the highest point toward the eye can be on top.
      const sorted = list.sort((a, b) => a.along - b.along);
      const upper: typeof sorted = [];
      for (const item of sorted) {
        while (upper.length >= 2) {
          const [o, a] = [upper[upper.length - 2], upper[upper.length - 1]];
          if ((a.along - o.along) * (item.point.ellipsoidalHeight - o.point.ellipsoidalHeight) - (a.point.ellipsoidalHeight - o.point.ellipsoidalHeight) * (item.along - o.along) >= 0) upper.pop();
          else break;
        }
        upper.push(item);
      }
      const peak = upper.reduce((best, item, at) => (item.point.ellipsoidalHeight > upper[best].point.ellipsoidalHeight ? at : best), 0);
      return { index, candidates: upper.slice(peak) };
    });
    fans.set(key, result);
    return result;
  };
  // Reference distances 1.1× apart, all beyond the area.
  const referenceFor = (distance: number) => {
    const step = Math.log(1.1), lowest = Math.ceil(Math.log((radius + 250) / 1000) / step);
    return 1000 * 1.1 ** Math.max(lowest, Math.round(Math.log(distance / 1000) / step));
  };
  const angle = (eye: EllipsoidalPoint, point: SkylinePoint) => toRay(eye, point).elevation;
  const result = samples.length ? (eye: EllipsoidalPoint) => {
    const east = (eye.longitude - target.longitude) * across, north = (eye.latitude - target.latitude) * METRES_PER_DEGREE;
    const distance = Math.hypot(east, north);
    if (distance < radius + 300) return samples.reduce((best, point) => (angle(eye, point) > angle(eye, best) ? point : best));
    const bin = ((Math.round(Math.atan2(east, north) / degrees) % 360) + 360) % 360;
    // Each group is one direction: its skyline point by the planar slope (with the Earth's curvature) and
    // where it is seen across the line of sight; the caller measures the aimed point exactly.
    const groups = fansOf(bin, referenceFor(distance));
    const slopes = new Float64Array(groups.length), picks: Candidate[] = new Array(groups.length);
    let highest = 0;
    for (let at = 0; at < groups.length; at++) {
      let best = -Infinity, pick = groups[at].candidates[0];
      for (const candidate of groups[at].candidates) {
        const length = distance - candidate.along;
        const value = (candidate.point.ellipsoidalHeight - eye.ellipsoidalHeight) / length - length / (2 * EARTH);
        if (value > best) { best = value; pick = candidate; }
      }
      slopes[at] = best;
      picks[at] = pick;
      if (best > slopes[highest]) highest = at;
    }
    const line = groups.map((group, at) => ({ index: group.index, slope: slopes[at] }));
    const floor = slopes[highest] - SKYLINE_DROP / distance;
    let first = highest, last = highest;
    // The run goes on over a single direction below the floor (a 25 m sample missing a narrow crest).
    const on = (at: number) => at >= 0 && at < line.length && line[at].slope >= floor;
    const next = (at: number, step: number) => (Math.abs(line[at + step]?.index - line[at].index) === 1 && on(at + step) ? at + step
      : Math.abs(line[at + 2 * step]?.index - line[at].index) === 2 && on(at + 2 * step) ? at + 2 * step : null);
    for (let step = next(first, -1); step !== null; step = next(first, -1)) first = step;
    for (let step = next(last, 1); step !== null; step = next(last, 1)) last = step;
    const sideways = (at: number) => picks[at].side / (distance - picks[at].along);
    const middle = (sideways(first) + sideways(last)) / 2;
    let chosen = first;
    for (let at = first + 1; at <= last; at++) if (Math.abs(sideways(at) - middle) < Math.abs(sideways(chosen) - middle)) chosen = at;
    return picks[chosen].point;
  } : null;
  if (!skylines.has(sampler)) skylines.set(sampler, new Map());
  skylines.get(sampler)!.set(key, result);
  return result;
}

/** Solves a run of minutes; slices of one span are merged by `finishPositions`. */
export function solvePositions(input: PositionInput, track: readonly SkySample[], sampler: GroundSampler): PositionSlice {
  const targetGround = sampler(input.target.latitude, input.target.longitude);
  const points: PositionSlice["points"] = [];
  const angles = { min: Infinity, max: -Infinity };
  let gaps = 0;
  if (targetGround === null) return { points, angles, gaps: track.length };
  const fixed = { latitude: input.target.latitude, longitude: input.target.longitude, ellipsoidalHeight: topHeight(input.target, targetGround) };
  const skyline = input.target.skyline ? skylineTop(input.target, sampler) : null;
  // The top this eye sees: the target point, or the highest point of the skyline toward it.
  const topFor = (eye: EllipsoidalPoint): EllipsoidalPoint => (skyline ? skyline(eye) : fixed);
  const want = (ray: { azimuth: number; elevation: number }) => wantedDirection(ray, input.frames);
  const minimum = input.minDistance ?? MIN_DISTANCE;
  const eyeAt = (bearing: number, distance: number) => {
    const point = travel(input.target, bearing, distance);
    const ground = sampler(point.latitude, point.longitude);
    return ground === null ? null : { ...point, ground, eye: { ...point, ellipsoidalHeight: ground + input.cameraHeight } };
  };
  for (const sample of track) {
    const sky = skyField(input.body, sample.time, input.target, input.refraction);
    // While solving one bracket the top is held fixed (for a skyline, the point last seen as its top).
    let held: EllipsoidalPoint = fixed;
    // Elevation where the body should be (from the top seen at a point of the line), minus the body's there.
    const offset = (bearing: number, distance: number) => {
      const eye = eyeAt(bearing, distance);
      return eye ? want(toRay(eye.eye, held)).elevation - sky(eye.latitude, eye.longitude).elevation : null;
    };
    const root = (bearing: number, low: number, high: number) => {
      let a = low, b = high, fa = offset(bearing, a);
      const fb = offset(bearing, b);
      if (fa === null || fb === null || Math.sign(fa) === Math.sign(fb)) return null;
      for (let pass = 0; pass < 20; pass++) {
        const middle = (a + b) / 2, value = offset(bearing, middle);
        if (value === null) return null;
        if (Math.sign(value) === Math.sign(fa)) { a = middle; fa = value; } else b = middle;
      }
      return (a + b) / 2;
    };
    const start = cameraBearing(sample, input.frames);
    let previous: number | null = null, gap = false;
    const brackets: [number, number][] = [];
    // The skyline top moves slowly along one line: the scan reuses it within a kilometre (it only brackets roots).
    let scanTop: EllipsoidalPoint = fixed, scanTopAt = -Infinity;
    for (let distance = minimum; distance <= input.maxDistance + 1e-6; distance += SCAN_STEP) {
      const eye = eyeAt(start, distance);
      if (!eye) { gap = true; previous = null; continue; }
      if (skyline && distance - scanTopAt >= SKYLINE_REUSE) { scanTop = topFor(eye.eye); scanTopAt = distance; }
      const ray = toRay(eye.eye, skyline ? scanTop : fixed);
      angles.min = Math.min(angles.min, ray.elevation);
      angles.max = Math.max(angles.max, ray.elevation);
      const value = want(ray).elevation - sky(eye.latitude, eye.longitude).elevation;
      if (previous !== null && Math.sign(value) !== Math.sign(previous) && value !== 0)
        brackets.push([distance - SCAN_STEP, distance]);
      previous = value;
    }
    if (gap) gaps++;
    for (const [low, high] of brackets) {
      // A skyline top: solve with the top held, then hold the top the solution sees, until it stays the same.
      const first = skyline ? eyeAt(start, (low + high) / 2) : null;
      held = first ? topFor(first.eye) : fixed;
      let bearing = start, distance: number | null = null;
      for (let round = 0; round < (skyline ? SKYLINE_ROUNDS : 1); round++) {
        const near: number | null = distance;
        distance = near === null ? root(bearing, low, high) : null;
        for (const span of near === null ? [] : [200, 800, 3200]) {
          distance = root(bearing, Math.max(minimum, near! - span), Math.min(input.maxDistance, near! + span));
          if (distance !== null) break;
        }
        // Meridians converge (and an offset depends on the pitch): turn the line until the wanted azimuth matches the body's.
        for (let pass = 0; pass < 6 && distance !== null; pass++) {
          const eye = eyeAt(bearing, distance);
          if (!eye) { distance = null; break; }
          const turn = signedAngle(sky(eye.latitude, eye.longitude).azimuth - want(toRay(eye.eye, held)).azimuth);
          if (Math.abs(turn) < 1e-7) break;
          bearing += turn;
          const from = distance;
          distance = null;
          for (const span of [200, 800, 3200]) {
            distance = root(bearing, Math.max(minimum, from - span), Math.min(input.maxDistance, from + span));
            if (distance !== null) break;
          }
        }
        if (distance === null || !skyline) break;
        const eye = eyeAt(bearing, distance);
        if (!eye) { distance = null; break; }
        const seen = topFor(eye.eye);
        if (seen.latitude === held.latitude && seen.longitude === held.longitude) break;
        held = seen;
      }
      if (distance === null) continue;
      const eye = eyeAt(bearing, distance);
      if (!eye) continue;
      // The disc is drawn only above the camera's own sea-level horizon.
      const wanted = skyAt(input.body, sample.time, eye.latitude, eye.longitude, input.refraction);
      if (wanted.elevation < targetElevationRange[0]) continue;
      const top = topFor(eye.eye);
      const seen = toRay(eye.eye, top);
      const aimed = want(seen);
      const body = direction(wanted.azimuth, wanted.elevation);
      const residual = Math.acos(Math.max(-1, Math.min(1, dot(direction(aimed.azimuth, aimed.elevation), body)))) / degrees;
      // A skyline top may jump between minutes of the line search's own loop: keep only settled solutions.
      if (skyline && residual > SKYLINE_SETTLED) continue;
      const sight = lineOfSight(eye.eye, top, sampler);
      points.push({
        time: sample.time, latitude: eye.latitude, longitude: eye.longitude, distance,
        azimuth: seen.azimuth, elevation: seen.elevation, cameraGround: eye.ground, residual,
        sight: sight.sight, ...(sight.blockedAt !== undefined ? { blockedAt: sight.blockedAt } : {}),
        ...(skyline ? { top: { latitude: top.latitude, longitude: top.longitude, ellipsoidalHeight: top.ellipsoidalHeight, offset: (top as SkylinePoint).offset } } : {}),
      });
    }
  }
  return { points, angles, gaps };
}

/** Merges slices: one branch per continuous run of solutions, and the summary. */
export function finishPositions(track: readonly SkySample[], slices: readonly PositionSlice[], targetGround: number | null): PositionResult {
  const raw = slices.flatMap((slice) => slice.points).sort((a, b) => a.time - b.time || a.distance - b.distance);
  const points: PositionPoint[] = [];
  let branches = 0;
  let open: PositionPoint[] = [];
  for (let index = 0; index < raw.length;) {
    const time = raw[index].time, minute: PositionPoint[] = [];
    while (index < raw.length && raw[index].time === time) {
      const point = raw[index++];
      // Continue the branch whose previous minute ended closest. Low bodies move the
      // solution kilometres per minute, so the allowed jump grows with distance.
      const near = open.filter((last) => last.time === time - 60_000 && !minute.some((taken) => taken.branch === last.branch))
        .sort((a, b) => Math.abs(a.distance - point.distance) - Math.abs(b.distance - point.distance))[0];
      const jump = near ? Math.abs(near.distance - point.distance) : Infinity;
      const branch = near && jump < Math.max(2000, 0.35 * Math.max(near.distance, point.distance)) ? near.branch : branches++;
      minute.push({ ...point, branch });
    }
    points.push(...minute);
    open = minute;
  }
  const minutes = new Set(points.map((point) => point.time)).size;
  const angles = slices.reduce((all, slice) => ({ min: Math.min(all.min, slice.angles.min), max: Math.max(all.max, slice.angles.max) }), { min: Infinity, max: -Infinity });
  const sky = track.length ? { min: Math.min(...track.map((s) => s.elevation)), max: Math.max(...track.map((s) => s.elevation)) } : null;
  const reason: PositionReason | null = points.length ? null
    : targetGround === null ? "no-ground"
      : !track.length ? "below"
        : "out-of-range";
  return {
    points,
    sky,
    angles: Number.isFinite(angles.min) ? angles : null,
    minutes,
    blocked: points.filter((point) => point.sight === "blocked").length,
    unknown: points.filter((point) => point.sight === "unknown").length,
    gaps: slices.reduce((sum, slice) => sum + slice.gaps, 0),
    targetGround,
    reason,
  };
}

/** The whole span in one call (tests); the panel solves in slices after loading the DEM. */
export function findPositions(input: PositionInput, sampler: GroundSampler) {
  const track = bodyTrack(input);
  const slices: PositionSlice[] = [];
  for (let index = 0; index < track.length; index += 60) slices.push(solvePositions(input, track.slice(index, index + 60), sampler));
  return finishPositions(track, slices, sampler(input.target.latitude, input.target.longitude));
}

/** The top an eye sees of a target: the point itself, or its skyline top. Null without terrain data. */
export function topSeen(target: GroundTarget, eye: EllipsoidalPoint, sampler: GroundSampler): (EllipsoidalPoint & { offset?: number }) | null {
  if (target.skyline) {
    const skyline = skylineTop(target, sampler);
    if (skyline) return skyline(eye);
  }
  const ground = sampler(target.latitude, target.longitude);
  return ground === null ? null : { latitude: target.latitude, longitude: target.longitude, ellipsoidalHeight: topHeight(target, ground) };
}

/** Profile from a camera point to the target's top (its skyline top when aimed so), for the panel's chart. */
export function positionProfile(input: Pick<PositionInput, "target" | "cameraHeight">, camera: { latitude: number; longitude: number }, sampler: GroundSampler) {
  const cameraGround = sampler(camera.latitude, camera.longitude);
  if (cameraGround === null) return null;
  const eye = { ...camera, ellipsoidalHeight: cameraGround + input.cameraHeight };
  const top = topSeen(input.target, eye, sampler);
  return top ? lineOfSight(eye, top, sampler) : null;
}

/** Where the target's top (and the body on it) should sit in the frame, and the lens that frames it. */
export interface Framing {
  frame: FramePoint;
  lens: Omit<View, "azimuth" | "pitch">;
}

/**
 * The plan fields a try-out of a solved point writes: the camera, the
 * instant, the direction and the body's layer. The direction puts the
 * target's top at the chosen place in the frame (the centre without a
 * framing). Rounded for the input fields: 1e-6° is about 0.1 m, 1e-4° under 1 cm at 5 km.
 */
export function pointPlan(layers: ShootingPlan["layers"], point: Pick<PositionPoint, "latitude" | "longitude" | "time" | "azimuth" | "elevation">, body: AlignmentBody, framing?: Framing) {
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const aim = framing ? aimAt(framing.lens, point, framing.frame) : { azimuth: point.azimuth, pitch: point.elevation };
  return {
    latitude: round(point.latitude, 6), longitude: round(point.longitude, 6),
    instant: new Date(point.time).toISOString().replace(".000Z", "Z"),
    azimuth: round(aim.azimuth, 4), pitch: round(aim.pitch, 4),
    layers: { ...layers, [bodyLayer(body)]: true },
  };
}

/** The layers a try-out may switch on (the body's own), kept for "返回推算前". */
export type TriedLayers = Pick<ShootingPlan["layers"], "sun" | "moon" | "stars" | "milkyWay" | "deepSky">;
export const triedLayers = (layers: ShootingPlan["layers"]): TriedLayers =>
  ({ sun: layers.sun, moon: layers.moon, stars: layers.stars, milkyWay: layers.milkyWay, deepSky: layers.deepSky });
/** The layers back as they were; a path or the constellation figures go with their base layer. */
export function restoredLayers(current: ShootingPlan["layers"], before: TriedLayers): ShootingPlan["layers"] {
  return {
    ...current, ...before,
    sunPath: before.sun && !!current.sunPath, moonPath: before.moon && !!current.moonPath,
    constellations: before.stars && current.constellations,
  };
}

/** Great-circle distance in metres (mean radius); enough to compare nearby solutions. */
export function groundDistance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const phi1 = a.latitude * degrees, phi2 = b.latitude * degrees;
  const dPhi = phi2 - phi1, dLambda = (b.longitude - a.longitude) * degrees;
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
