import { KM_PER_AU, MakeTime, Observer, Refraction, SearchAltitude, SearchHourAngle } from "astronomy-engine";
import { celestialBodies, degrees, direction, dot, sunPosition, topocentric, unit } from "./ephemeris.ts";
import type { Vector3 } from "./ephemeris.ts";
import { apparentElevation } from "./refraction.ts";
import { cameraBasis } from "./celestial-projection.ts";
import type { View } from "./celestial-projection.ts";
import { lightPeriodBounds } from "./timeline.ts";
import type { ShootingPlan } from "./plan.ts";
import { astroBody, DARK_SUN_ELEVATION, fixedPlace, isFixedBody } from "./sky-coordinates.ts";
import type { SolveBodyId } from "./sky-coordinates.ts";

/**
 * "Find the time" for a fixed camera: when does the Sun or Moon sit at a
 * chosen place in the frame? The place is an apparent direction in the sky
 * (the preview's refraction), so a candidate puts the drawn disc on the mark.
 * Seeds are the daily crossings of the target elevation and both
 * culminations; each is refined to the closest approach along the body's path.
 */

/** The Sun, the Moon or a fixed body (sky-targets.ts). */
export type AlignmentBody = SolveBodyId;
export interface AlignmentTarget {
  body: AlignmentBody;
  /** Apparent direction as drawn in the preview (the plan's refraction), degrees. */
  azimuth: number;
  elevation: number;
}
export type SkyCondition = "day" | "golden" | "blue" | "twilight" | "night";
export const skyConditions: readonly SkyCondition[] = ["day", "golden", "blue", "twilight", "night"];
export const skyConditionNames: Record<SkyCondition, string> = {
  day: "白天", golden: "黄金", blue: "蓝调", twilight: "暮光", night: "暗夜",
};

/** Sky by the Sun centre's geometric elevation, as the timeline's golden and blue hour. */
export function skyCondition(sunElevation: number): SkyCondition {
  if (sunElevation >= lightPeriodBounds.golden[1]) return "day";
  if (sunElevation >= lightPeriodBounds.golden[0]) return "golden";
  if (sunElevation >= lightPeriodBounds.blue[0]) return "blue";
  if (sunElevation >= -18) return "twilight";
  return "night";
}

/** Mean apparent radii, degrees; the mark is drawn with these. */
export const meanRadius: Record<"sun" | "moon", number> = { sun: 0.2666, moon: 0.2591 };
/** The radius of the drawn mark: the mean disc, or a fixed body's nominal size. */
export const bodyRadius = (body: AlignmentBody) => (isFixedBody(body) ? fixedPlace(body)?.radius ?? 0.25 : meanRadius[body]);
/** Apparent elevation of a mark: the disc must be drawn (upper limb above the sea-level horizon). */
export const targetElevationRange = [-0.25, 89] as const;
export const toleranceChoices = [0.1, 0.25, 0.5, 1] as const;

export interface AlignmentInput {
  latitude: number;
  longitude: number;
  refraction: ShootingPlan["refraction"];
  target: AlignmentTarget;
  /** How far the centre may sit from the mark, in diameters of the body at that time. */
  tolerance: number;
  /** Moon only: lit fraction of the disc, 0–1, inclusive. */
  phase?: readonly [number, number];
  /** Moon only: allowed skies; every sky when absent. */
  sky?: readonly SkyCondition[];
}

export interface AlignmentCandidate {
  /** Closest approach, epoch milliseconds. */
  time: number;
  /** Centre to mark, degrees. */
  separation: number;
  radius: number;
}
export interface AlignmentScan {
  candidates: AlignmentCandidate[];
  /** Highest and lowest apparent elevation at the culminations scanned, degrees. */
  reach: { max: number; min: number };
}

export interface Alignment {
  instant: string;
  /** Centre within the tolerance from … to. */
  from: string;
  to: string;
  separation: number;
  diameter: number;
  /** Where the centre sits from the mark, as seen in the frame. */
  offset: string;
  azimuth: number;
  elevation: number;
  /** Moon only. */
  illuminated: number | null;
  phaseAngle: number | null;
  sunElevation: number;
  sky: SkyCondition;
}
export interface AlignmentMiss {
  instant: string;
  separation: number;
  diameter: number;
  offset: string;
}
export type AlignmentReason = "too-high" | "too-low" | "missed" | "filtered";
export interface AlignmentResult {
  alignments: Alignment[];
  /** Aligned but outside the moon-phase or sky choice (counted once, phase first). */
  filtered: { phase: number; sky: number };
  /** The closest pass that stays outside the tolerance. */
  nearest: AlignmentMiss | null;
  reach: { max: number; min: number };
  /** Why nothing is listed; null when something is. */
  reason: AlignmentReason | null;
}

const DAY = 86_400_000;
const radiusKm = { sun: 695700, moon: 1737.4 } as const;
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));

/** Geometric elevation whose apparent elevation (the preview's refraction) is `apparent`. */
export function geometricElevation(apparent: number, refraction: ShootingPlan["refraction"]) {
  if (refraction === "none") return apparent;
  let elevation = apparent;
  for (let pass = 0; pass < 12; pass++) elevation = apparent - Math.max(0, Refraction("normal", elevation));
  return elevation;
}

/** Apparent direction of the body for the camera's ground point, as the preview draws it. */
function place(body: AlignmentBody, time: number, observer: Observer, refraction: ShootingPlan["refraction"]) {
  const { equator, horizon } = topocentric(astroBody(body), new Date(time), observer);
  const elevation = apparentElevation(horizon.altitude, refraction);
  return {
    ray: direction(horizon.azimuth, elevation),
    azimuth: horizon.azimuth,
    elevation,
    radius: isFixedBody(body) ? bodyRadius(body) : Math.asin(radiusKm[body] / (equator.dist * KM_PER_AU)) / degrees,
  };
}

/** Tangent plane at the mark: x to the right (increasing azimuth), y up. */
function markFrame(target: AlignmentTarget) {
  const centre = direction(target.azimuth, target.elevation);
  const az = target.azimuth * degrees;
  const right: Vector3 = [Math.cos(az), -Math.sin(az), 0];
  return { centre, right, up: cross(right, centre) };
}
type MarkFrame = ReturnType<typeof markFrame>;
function tangent(frame: MarkFrame, ray: Vector3) {
  const depth = dot(ray, frame.centre);
  return depth > 0.05 ? { x: dot(ray, frame.right) / depth, y: dot(ray, frame.up) / depth } : null;
}
const angleTo = (frame: MarkFrame, ray: Vector3) => Math.acos(clampUnit(dot(frame.centre, unit(ray)))) / degrees;

const offsetNames = ["偏右", "偏右上", "偏上", "偏左上", "偏左", "偏左下", "偏下", "偏右下"];
/** Where the centre sits from the mark in the frame (the camera does not roll). */
function offsetName(frame: MarkFrame, ray: Vector3, separation: number, diameter: number) {
  const point = tangent(frame, ray);
  if (!point || separation < diameter * 0.02) return "几乎居中";
  const angle = Math.atan2(point.y, point.x) / degrees;
  return offsetNames[(Math.round(angle / 45) + 8) % 8];
}

// Velocity step and the largest correction per refinement step.
const STEP = 30_000;
const MAX_JUMP = 45 * 60_000;

/** Closest approach of the body's path to the mark near the seed (Newton steps on a locally straight path). */
function closest(input: AlignmentInput, frame: MarkFrame, observer: Observer, seed: number): AlignmentCandidate {
  const at = (time: number) => place(input.target.body, time, observer, input.refraction);
  let time = seed;
  for (let pass = 0; pass < 10; pass++) {
    const a = tangent(frame, at(time).ray), b = tangent(frame, at(time + STEP).ray);
    if (!a || !b) break;
    const vx = (b.x - a.x) / STEP, vy = (b.y - a.y) / STEP, speed = vx * vx + vy * vy;
    if (!(speed > 0)) break;
    const jump = Math.max(-MAX_JUMP, Math.min(MAX_JUMP, -(a.x * vx + a.y * vy) / speed));
    time += jump;
    if (Math.abs(jump) < 250) break;
  }
  const final = at(time);
  return { time, separation: angleTo(frame, final.ray), radius: final.radius };
}

/** Crossings of the mark's elevation and both culminations inside [from, to). */
function seeds(input: AlignmentInput, observer: Observer, from: number, to: number) {
  const body = astroBody(input.target.body);
  const altitude = geometricElevation(input.target.elevation, input.refraction);
  const times: number[] = [];
  for (const way of [1, -1] as const) {
    let start = from;
    while (start < to) {
      let found = null;
      try {
        found = SearchAltitude(body, observer, way, MakeTime(new Date(start)), (to - start) / DAY, altitude);
      } catch {
        found = null;
      }
      const time = found?.date.getTime();
      if (time === undefined || time >= to) break;
      times.push(time);
      start = time + 60_000;
    }
  }
  const reach = { max: -Infinity, min: Infinity };
  for (const hourAngle of [0, 12]) {
    let start = from;
    while (start < to) {
      const time = SearchHourAngle(body, observer, hourAngle, MakeTime(new Date(start)), +1).time.date.getTime();
      if (time >= to) break;
      times.push(time);
      const elevation = place(input.target.body, time, observer, input.refraction).elevation;
      if (hourAngle === 0) reach.max = Math.max(reach.max, elevation);
      else reach.min = Math.min(reach.min, elevation);
      start = time + 3_600_000;
    }
  }
  return { times, reach };
}

function observerOf(input: Pick<AlignmentInput, "latitude" | "longitude">) {
  // Reference ellipsoid height, as the drawn discs (see ephemeris.observerContext).
  return new Observer(input.latitude, input.longitude, 0);
}

/** One slice of the search; slices of a range are merged by `finishAlignment`. */
export function scanAlignment(input: AlignmentInput, from: number, to: number): AlignmentScan {
  const observer = observerOf(input);
  const frame = markFrame(input.target);
  const found = seeds(input, observer, from, to);
  return {
    candidates: found.times.map((seed) => closest(input, frame, observer, seed)),
    reach: found.reach,
  };
}

/** Time range for the search: whole local days from a start date. */
export const spanChoices = [
  { days: 30, label: "30 天" },
  { days: 90, label: "90 天" },
  { days: 365, label: "12 个月" },
  { days: 1096, label: "3 年" },
] as const;

/** Instants where the centre is exactly `limit` degrees from the mark, around the closest approach. */
function alignedWindow(separationAt: (time: number) => number, centre: number, limit: number) {
  const edge = (sign: 1 | -1) => {
    let inside = centre, step = 60_000, outside = centre + sign * step;
    while (separationAt(outside) <= limit) {
      inside = outside;
      step *= 2;
      if (step > 6 * 3_600_000) return inside;
      outside = centre + sign * step;
    }
    while (Math.abs(outside - inside) > 1000) {
      const middle = (inside + outside) / 2;
      if (separationAt(middle) <= limit) inside = middle;
      else outside = middle;
    }
    return inside;
  };
  return [edge(-1), edge(1)] as const;
}

const second = (time: number) => new Date(Math.round(time / 1000) * 1000).toISOString().replace(".000Z", "Z");

/** Merges slices: one closest approach per pass, then tolerance, phase and sky. */
export function finishAlignment(input: AlignmentInput, scans: readonly AlignmentScan[], from: number, to: number): AlignmentResult {
  const observer = observerOf(input);
  const frame = markFrame(input.target);
  const at = (time: number) => place(input.target.body, time, observer, input.refraction);
  // Seeds of one pass converge on the same approach; keep the closest per 20 minutes.
  const sorted = scans.flatMap((scan) => scan.candidates)
    .filter((candidate) => candidate.time >= from && candidate.time < to)
    .sort((a, b) => a.time - b.time);
  const passes: AlignmentCandidate[] = [];
  for (const candidate of sorted) {
    const last = passes.at(-1);
    if (last && candidate.time - last.time < 20 * 60_000) {
      if (candidate.separation < last.separation) passes[passes.length - 1] = candidate;
    } else passes.push(candidate);
  }
  const reach = scans.reduce((all, scan) => ({ max: Math.max(all.max, scan.reach.max), min: Math.min(all.min, scan.reach.min) }),
    { max: -Infinity, min: Infinity });
  const alignments: Alignment[] = [];
  const filtered = { phase: 0, sky: 0 };
  let nearest: AlignmentCandidate | null = null;
  for (const pass of passes) {
    const diameter = 2 * pass.radius, limit = input.tolerance * diameter;
    if (pass.separation > limit) {
      if (!nearest || pass.separation / (2 * pass.radius) < nearest.separation / (2 * nearest.radius)) nearest = pass;
      continue;
    }
    const instant = second(pass.time);
    const sunElevation = sunPosition({ latitude: input.latitude, longitude: input.longitude, instant }).elevation;
    const sky = skyCondition(sunElevation);
    let illuminated: number | null = null, phaseAngle: number | null = null;
    if (input.target.body === "moon") {
      const moon = celestialBodies({ latitude: input.latitude, longitude: input.longitude, instant }).moon;
      illuminated = moon.illuminatedFraction;
      phaseAngle = moon.phaseAngle;
      if (input.phase && (illuminated < input.phase[0] || illuminated > input.phase[1])) {
        filtered.phase++;
        continue;
      }
    }
    // Fixed bodies only in a dark enough sky; then, like the Moon, the chosen skies.
    if (input.target.body !== "sun" && ((isFixedBody(input.target.body) && sunElevation > DARK_SUN_ELEVATION) || (input.sky && !input.sky.includes(sky)))) {
      filtered.sky++;
      continue;
    }
    const [start, end] = alignedWindow((time) => angleTo(frame, at(time).ray), pass.time, limit);
    const position = at(pass.time);
    alignments.push({
      instant, from: second(start), to: second(end),
      separation: pass.separation, diameter,
      offset: offsetName(frame, position.ray, pass.separation, diameter),
      azimuth: position.azimuth, elevation: position.elevation,
      illuminated, phaseAngle, sunElevation, sky,
    });
  }
  const mean = 2 * bodyRadius(input.target.body) * input.tolerance;
  const reason: AlignmentReason | null = alignments.length ? null
    : filtered.phase + filtered.sky > 0 ? "filtered"
      : reach.max !== -Infinity && input.target.elevation - mean > reach.max ? "too-high"
        : reach.min !== Infinity && input.target.elevation + mean < reach.min ? "too-low"
          : "missed";
  const miss = nearest ? (() => {
    const position = at(nearest.time), diameter = 2 * nearest.radius;
    return { instant: second(nearest.time), separation: nearest.separation, diameter, offset: offsetName(frame, position.ray, nearest.separation, diameter) };
  })() : null;
  return { alignments, filtered, nearest: miss, reach, reason };
}

/** The whole search in one call (tests and small ranges); the panel scans in slices. */
export function solveAlignment(input: AlignmentInput, from: number, to: number, slice = 30 * DAY) {
  const scans: AlignmentScan[] = [];
  for (let start = from; start < to; start += slice) scans.push(scanAlignment(input, start, Math.min(to, start + slice)));
  return finishAlignment(input, scans, from, to);
}

/** Apparent direction through a point of the frame (normalised device coordinates, y down). */
export function frameDirection(view: View, x: number, y: number) {
  const basis = cameraBasis(view);
  const ray = unit([
    basis.forward[0] + x * basis.tx * basis.right[0] - y * basis.ty * basis.up[0],
    basis.forward[1] + x * basis.tx * basis.right[1] - y * basis.ty * basis.up[1],
    basis.forward[2] + x * basis.tx * basis.right[2] - y * basis.ty * basis.up[2],
  ]);
  const azimuth = ((Math.atan2(ray[0], ray[1]) / degrees) % 360 + 360) % 360;
  return { azimuth, elevation: Math.asin(clampUnit(ray[2])) / degrees };
}

/** Points of the mark's outline in the frame (normalised device coordinates), or null when behind the camera. */
export function markOutline(view: View, target: AlignmentTarget, radius = bodyRadius(target.body), samples = 48) {
  const frame = markFrame(target), basis = cameraBasis(view), size = Math.tan(radius * degrees);
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < samples; index++) {
    const angle = (2 * Math.PI * index) / samples;
    const ray: Vector3 = [0, 1, 2].map((axis) => frame.centre[axis] + size * (Math.cos(angle) * frame.right[axis] + Math.sin(angle) * frame.up[axis])) as unknown as Vector3;
    const depth = dot(ray, basis.forward);
    if (depth <= 1e-9) return null;
    points.push({ x: dot(ray, basis.right) / (depth * basis.tx), y: -dot(ray, basis.up) / (depth * basis.ty) });
  }
  return points;
}
