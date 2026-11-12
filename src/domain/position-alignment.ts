import { Body, KM_PER_AU, Observer } from "astronomy-engine";
import { degrees, direction, dot, topocentric, unit } from "./ephemeris.ts";
import { apparentElevation } from "./refraction.ts";
import { ecefGeodetic, ellipsoidalRay, geodeticEcef } from "./geodesy.ts";
import type { EllipsoidalPoint } from "./geodesy.ts";
import { normalizeLongitude, signedAngle } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { targetElevationRange } from "./alignment.ts";
import type { AlignmentBody } from "./alignment.ts";

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
  /** Height of the aimed point above the DEM ground, metres (0 for a summit). */
  height: number;
  name?: string;
}
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
  /** From the camera to the target's top, degrees: equal to the body's azimuth and elevation. */
  azimuth: number;
  elevation: number;
  cameraGround: number;
  /** Angle between the ray to the top and the body seen from the camera, degrees. */
  residual: number;
  sight: Sight;
  /** Distance from the camera to the first DEM obstruction, metres. */
  blockedAt?: number;
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

const bodies = { sun: Body.Sun, moon: Body.Moon } as const;
const EARTH = 6_371_008.8;
export const MIN_DISTANCE = 200;
export const distanceChoices = [10_000, 20_000, 30_000] as const;
const SCAN_STEP = 100;
const SIGHT_STEP = 50;
// The eye's own ground and the target's footprint are not obstructions.
const NEAR_EYE = 20, NEAR_TARGET = 50, SIGHT_MARGIN = 0.5;

/** Apparent direction of the body for an observer on the reference ellipsoid. */
export function skyAt(body: AlignmentBody, time: number, latitude: number, longitude: number, refraction: ShootingPlan["refraction"]) {
  const { horizon } = topocentric(bodies[body], new Date(time), new Observer(latitude, longitude, 0));
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
    if (sky.elevation >= lowest) samples.push({ time, ...sky });
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
  const { equator, horizon } = topocentric(bodies[body], new Date(time), new Observer(origin.latitude, origin.longitude, 0));
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
      points.push(travel(input.target, sample.azimuth + 180, Math.min(distance, input.maxDistance)));
  return points;
}

const toRay = (eye: EllipsoidalPoint, top: EllipsoidalPoint) => {
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

/** Solves a run of minutes; slices of one span are merged by `finishPositions`. */
export function solvePositions(input: PositionInput, track: readonly SkySample[], sampler: GroundSampler): PositionSlice {
  const targetGround = sampler(input.target.latitude, input.target.longitude);
  const points: PositionSlice["points"] = [];
  const angles = { min: Infinity, max: -Infinity };
  let gaps = 0;
  if (targetGround === null) return { points, angles, gaps: track.length };
  const top = { latitude: input.target.latitude, longitude: input.target.longitude, ellipsoidalHeight: targetGround + input.target.height };
  const minimum = input.minDistance ?? MIN_DISTANCE;
  const eyeAt = (bearing: number, distance: number) => {
    const point = travel(input.target, bearing, distance);
    const ground = sampler(point.latitude, point.longitude);
    return ground === null ? null : { ...point, ground, eye: { ...point, ellipsoidalHeight: ground + input.cameraHeight } };
  };
  for (const sample of track) {
    const sky = skyField(input.body, sample.time, input.target, input.refraction);
    // Elevation of the top seen from a point of the line, minus the body's there.
    const offset = (bearing: number, distance: number) => {
      const eye = eyeAt(bearing, distance);
      return eye ? toRay(eye.eye, top).elevation - sky(eye.latitude, eye.longitude).elevation : null;
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
    const start = sample.azimuth + 180;
    let previous: number | null = null, gap = false;
    const brackets: [number, number][] = [];
    for (let distance = minimum; distance <= input.maxDistance + 1e-6; distance += SCAN_STEP) {
      const eye = eyeAt(start, distance);
      if (!eye) { gap = true; previous = null; continue; }
      const elevation = toRay(eye.eye, top).elevation;
      angles.min = Math.min(angles.min, elevation);
      angles.max = Math.max(angles.max, elevation);
      const value = elevation - sky(eye.latitude, eye.longitude).elevation;
      if (previous !== null && Math.sign(value) !== Math.sign(previous) && value !== 0)
        brackets.push([distance - SCAN_STEP, distance]);
      previous = value;
    }
    if (gap) gaps++;
    for (const [low, high] of brackets) {
      let bearing = start, distance = root(bearing, low, high);
      // Meridians converge: turn the line until the ray's own azimuth matches the body's.
      for (let pass = 0; pass < 4 && distance !== null; pass++) {
        const eye = eyeAt(bearing, distance);
        if (!eye) { distance = null; break; }
        const turn = signedAngle(sky(eye.latitude, eye.longitude).azimuth - toRay(eye.eye, top).azimuth);
        if (Math.abs(turn) < 1e-7) break;
        bearing += turn;
        const near = distance;
        distance = null;
        for (const span of [200, 800, 3200]) {
          distance = root(bearing, Math.max(minimum, near - span), Math.min(input.maxDistance, near + span));
          if (distance !== null) break;
        }
      }
      if (distance === null) continue;
      const eye = eyeAt(bearing, distance);
      if (!eye) continue;
      // The disc is drawn only above the camera's own sea-level horizon.
      const wanted = skyAt(input.body, sample.time, eye.latitude, eye.longitude, input.refraction);
      if (wanted.elevation < targetElevationRange[0]) continue;
      const seen = toRay(eye.eye, top);
      const body = direction(wanted.azimuth, wanted.elevation);
      const residual = Math.acos(Math.max(-1, Math.min(1, dot(unit(seen.ray), body)))) / degrees;
      const sight = lineOfSight(eye.eye, top, sampler);
      points.push({
        time: sample.time, latitude: eye.latitude, longitude: eye.longitude, distance,
        azimuth: seen.azimuth, elevation: seen.elevation, cameraGround: eye.ground, residual,
        sight: sight.sight, ...(sight.blockedAt !== undefined ? { blockedAt: sight.blockedAt } : {}),
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

/** Profile from a camera point to the target's top, for the panel's chart. */
export function positionProfile(input: Pick<PositionInput, "target" | "cameraHeight">, camera: { latitude: number; longitude: number }, sampler: GroundSampler) {
  const targetGround = sampler(input.target.latitude, input.target.longitude);
  const cameraGround = sampler(camera.latitude, camera.longitude);
  if (targetGround === null || cameraGround === null) return null;
  return lineOfSight(
    { ...camera, ellipsoidalHeight: cameraGround + input.cameraHeight },
    { latitude: input.target.latitude, longitude: input.target.longitude, ellipsoidalHeight: targetGround + input.target.height },
    sampler,
  );
}

/**
 * The plan fields a try-out of a solved point writes: the camera, the
 * instant, the direction to the top and the body's layer. Rounded for the
 * input fields: 1e-6° is about 0.1 m, 1e-4° under 1 cm at 5 km.
 */
export function pointPlan(layers: ShootingPlan["layers"], point: Pick<PositionPoint, "latitude" | "longitude" | "time" | "azimuth" | "elevation">, body: AlignmentBody) {
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    latitude: round(point.latitude, 6), longitude: round(point.longitude, 6),
    instant: new Date(point.time).toISOString().replace(".000Z", "Z"),
    azimuth: round(point.azimuth, 4), pitch: round(point.elevation, 4),
    layers: { ...layers, [body]: true },
  };
}

/** Solutions of the same minute closer than `radius` metres to an earlier listed one are left out (clear sight listed first). */
export function distinctPoints<T extends Pick<PositionPoint, "time" | "latitude" | "longitude" | "sight">>(points: readonly T[], radius = 200) {
  const rank = { clear: 0, unknown: 1, blocked: 2 } as const;
  const kept: T[] = [];
  const byTime = new Map<number, T[]>();
  for (const point of points) byTime.set(point.time, [...(byTime.get(point.time) ?? []), point]);
  for (const group of byTime.values()) {
    const chosen: T[] = [];
    for (const point of [...group].sort((a, b) => rank[a.sight] - rank[b.sight]))
      if (!chosen.some((other) => groundDistance(other, point) < radius)) chosen.push(point);
    kept.push(...group.filter((point) => chosen.includes(point)));
  }
  return kept.sort((a, b) => a.time - b.time);
}

/** Great-circle distance in metres (mean radius); enough to compare nearby solutions. */
export function groundDistance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const phi1 = a.latitude * degrees, phi2 = b.latitude * degrees;
  const dPhi = phi2 - phi1, dLambda = (b.longitude - a.longitude) * degrees;
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
