import { aimAt } from "./alignment.ts";
import type { FramePoint } from "./alignment.ts";
import { projectDirection } from "../core/celestial-projection.ts";
import type { View } from "../core/celestial-projection.ts";
import { degrees } from "../core/ephemeris.ts";
import type { EllipsoidalPoint } from "../core/geodesy.ts";
import { frameAspectRatio, normalizeLongitude } from "../core/plan.ts";
import { lineOfSight, toRay, topSeen, travel } from "./position-alignment.ts";
import type { GroundSampler, GroundTarget, Sight } from "./position-alignment.ts";

/**
 * "推算" with two ground points as the main constraint: where they sit in the
 * frame depends only on the camera's place and aim, not on the time. The
 * camera's two coordinates and its aim's two angles are fixed by the two
 * points' two frame coordinates each, so the answers are places, each with
 * the patch of ground around it where the second point stays within its
 * tolerance.
 *
 * Over the search range a grid (1° of bearing, 2% steps of distance) finds
 * where the second point lands nearest its place once the camera is aimed so
 * the first point sits exactly at its own; Gauss–Newton on the ground then
 * settles each local minimum.
 */

export type PairLens = Omit<View, "azimuth" | "pitch">;
export interface GroundPairInput {
  first: GroundTarget;
  /** Normalised device coordinates (−1…1, y down). */
  firstFrame: FramePoint;
  second: GroundTarget;
  secondFrame: FramePoint;
  /** Allowed gap of the second point from its place, share of the frame height. */
  tolerance: number;
  lens: PairLens;
  cameraHeight: number;
  /** The ring searched: around the first point (or a chosen place), metres. */
  center: { latitude: number; longitude: number };
  minDistance: number;
  maxDistance: number;
}
/** One ground point as seen from a camera place. */
export interface SeenPoint {
  top: EllipsoidalPoint;
  /** Ground distance from the camera, metres. */
  distance: number;
  azimuth: number;
  elevation: number;
}
export interface GroundPlace {
  latitude: number;
  longitude: number;
  ground: number;
  aim: { azimuth: number; pitch: number };
  /** Gap of the second point from its place, share of the frame height. */
  gap: number;
  first: SeenPoint;
  second: SeenPoint;
  /** Outline of the ground where the second point stays within its tolerance. */
  area: { latitude: number; longitude: number }[];
  /** Farthest and nearest outline points from the place, metres. */
  reach: { longest: number; shortest: number };
}
export interface PairEvaluation {
  /** Gap of the second point, share of the frame height, and its two parts (x scaled to the height). */
  gap: number;
  gx: number;
  gy: number;
  eye: EllipsoidalPoint;
  aim: { azimuth: number; pitch: number };
  first: SeenPoint;
  second: SeenPoint;
}

const EARTH = 6_371_008.8;
const METRES_PER_DEGREE = EARTH * degrees;
/** Grid steps: bearing (degrees) and distance (ratio, with a floor in metres). */
const GRID_BEARING = 1, GRID_RATIO = 1.02, GRID_FLOOR = 20;
/** Local minima of the grid worth settling: within this gap (share of the frame height). */
const CANDIDATE_GAP = 0.25;
/** Solutions closer than this are one. */
const SAME_PLACE = 50;
/** The tolerance outline: directions, and how far it may reach. */
const AREA_DIRECTIONS = 24, AREA_LIMIT = 5_000;

function seen(eye: EllipsoidalPoint, top: EllipsoidalPoint): SeenPoint {
  const ray = toRay(eye, top);
  const east = (top.longitude - eye.longitude) * METRES_PER_DEGREE * Math.cos(eye.latitude * degrees), north = (top.latitude - eye.latitude) * METRES_PER_DEGREE;
  return { top, distance: Math.hypot(east, north), azimuth: ray.azimuth, elevation: ray.elevation };
}

/** The camera at a place, aimed so the first point sits at its place: where the second lands, and how far from its own. */
export function evaluatePair(input: GroundPairInput, place: { latitude: number; longitude: number }, sampler: GroundSampler): PairEvaluation | null {
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || Math.abs(place.latitude) > 89.9) return null;
  const ground = sampler(place.latitude, place.longitude);
  if (ground === null) return null;
  const eye = { latitude: place.latitude, longitude: place.longitude, ellipsoidalHeight: ground + input.cameraHeight };
  const firstTop = topSeen(input.first, eye, sampler), secondTop = topSeen(input.second, eye, sampler);
  if (!firstTop || !secondTop) return null;
  const toFirst = toRay(eye, firstTop), toSecond = toRay(eye, secondTop);
  const aim = aimAt(input.lens, toFirst, input.firstFrame);
  const placed = projectDirection({ ...input.lens, ...aim }, toSecond.ray);
  if (!placed) return null;
  const gx = ((placed.x - input.secondFrame.x) / 2) * frameAspectRatio(input.lens), gy = (placed.y - input.secondFrame.y) / 2;
  return { gap: Math.hypot(gx, gy), gx, gy, eye, aim, first: seen(eye, firstTop), second: seen(eye, secondTop) };
}

/** A place moved east and north by some metres (local plane; the steps are small). */
const shifted = (place: { latitude: number; longitude: number }, east: number, north: number) => ({
  latitude: place.latitude + north / METRES_PER_DEGREE,
  longitude: normalizeLongitude(place.longitude + east / (METRES_PER_DEGREE * Math.cos(place.latitude * degrees))),
});

/** Gauss–Newton on the ground from a grid point: the place where the second point lands closest to its place. */
function settle(input: GroundPairInput, start: { latitude: number; longitude: number }, sampler: GroundSampler, scale: number) {
  let place = start, here = evaluatePair(input, place, sampler);
  if (!here) return null;
  const step = Math.min(50, Math.max(2, scale * 0.001));
  for (let pass = 0; pass < 25 && here.gap > 1e-7; pass++) {
    const east = evaluatePair(input, shifted(place, step, 0), sampler), north = evaluatePair(input, shifted(place, 0, step), sampler);
    if (!east || !north) break;
    const a = (east.gx - here.gx) / step, b = (north.gx - here.gx) / step, c = (east.gy - here.gy) / step, d = (north.gy - here.gy) / step;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break;
    // Solve J·Δ = −g (at most a tenth of the scale at once), then halve the step until the gap shrinks.
    let de = (-here.gx * d + here.gy * b) / det, dn = (here.gx * c - here.gy * a) / det;
    const limit = Math.max(200, scale * 0.1), length = Math.hypot(de, dn);
    if (length > limit) { de *= limit / length; dn *= limit / length; }
    let moved = false;
    for (let halving = 0; halving < 12; halving++) {
      const next = shifted(place, de, dn), there = evaluatePair(input, next, sampler);
      if (there && there.gap < here.gap) {
        place = next;
        here = there;
        moved = true;
        break;
      }
      de /= 2;
      dn /= 2;
    }
    if (!moved || Math.hypot(de, dn) < 0.01) break;
  }
  return { place, evaluation: here };
}

/** Outline of the ground around a place where the gap stays within the tolerance. */
function toleranceArea(input: GroundPairInput, place: { latitude: number; longitude: number }, sampler: GroundSampler) {
  const within = (east: number, north: number) => {
    const found = evaluatePair(input, shifted(place, east, north), sampler);
    return !!found && found.gap <= input.tolerance;
  };
  const area: { latitude: number; longitude: number }[] = [];
  let longest = 0, shortest = Infinity;
  for (let index = 0; index < AREA_DIRECTIONS; index++) {
    const angle = (2 * Math.PI * index) / AREA_DIRECTIONS, east = Math.sin(angle), north = Math.cos(angle);
    let inside = 0, outside = 10;
    while (outside <= AREA_LIMIT && within(east * outside, north * outside)) {
      inside = outside;
      outside *= 2;
    }
    if (outside > AREA_LIMIT) outside = AREA_LIMIT;
    else
      for (let pass = 0; pass < 12; pass++) {
        const middle = (inside + outside) / 2;
        if (within(east * middle, north * middle)) inside = middle;
        else outside = middle;
      }
    const reach = outside > AREA_LIMIT - 1 ? AREA_LIMIT : (inside + outside) / 2;
    longest = Math.max(longest, reach);
    shortest = Math.min(shortest, reach);
    area.push(shifted(place, east * reach, north * reach));
  }
  return { area, reach: { longest, shortest } };
}

/** The grid of the search: bearings by 1°, distances from the nearest to the farthest by 2%. */
export function pairGrid(input: Pick<GroundPairInput, "minDistance" | "maxDistance">) {
  const distances: number[] = [];
  for (let distance = Math.max(50, input.minDistance); distance < input.maxDistance; distance = Math.max(distance * GRID_RATIO, distance + GRID_FLOOR))
    distances.push(distance);
  distances.push(input.maxDistance);
  const bearings = Array.from({ length: Math.round(360 / GRID_BEARING) }, (_, index) => index * GRID_BEARING);
  return { bearings, distances };
}

/**
 * Places where the two ground points sit at their frame places (the second
 * within its tolerance), best first; `progress` reports the share of the grid
 * done. Sight lines are checked by `pairSight` once their terrain is loaded.
 */
export function solveGroundPair(input: GroundPairInput, sampler: GroundSampler, progress?: (done: number) => void) {
  const { bearings, distances } = pairGrid(input);
  const gaps = bearings.map(() => new Float64Array(distances.length));
  let missing = 0;
  bearings.forEach((bearing, row) => {
    distances.forEach((distance, column) => {
      const found = evaluatePair(input, travel(input.center, bearing, distance), sampler);
      if (!found) missing++;
      gaps[row][column] = found ? found.gap : Infinity;
    });
    progress?.((row + 1) / bearings.length);
  });
  // Local minima of the gap over the grid (bearings wrap round).
  const starts: { row: number; column: number; gap: number }[] = [];
  for (let row = 0; row < bearings.length; row++)
    for (let column = 0; column < distances.length; column++) {
      const value = gaps[row][column];
      if (!(value < CANDIDATE_GAP)) continue;
      let lowest = true;
      for (let dr = -1; dr <= 1 && lowest; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const other = gaps[(row + dr + bearings.length) % bearings.length][column + dc];
          if (other !== undefined && other < value) { lowest = false; break; }
        }
      if (lowest) starts.push({ row, column, gap: value });
    }
  starts.sort((a, b) => a.gap - b.gap);
  const places: GroundPlace[] = [];
  for (const start of starts) {
    const settled = settle(input, travel(input.center, bearings[start.row], distances[start.column]), sampler, distances[start.column]);
    if (!settled || settled.evaluation.gap > input.tolerance) continue;
    const { place, evaluation } = settled;
    const centre = Math.hypot(...offsetOf(input.center, place));
    if (centre < Math.max(0, input.minDistance - 1) || centre > input.maxDistance + 1) continue;
    if (places.some((other) => Math.hypot(...offsetOf(other, place)) < SAME_PLACE)) continue;
    places.push({
      latitude: place.latitude, longitude: place.longitude, ground: evaluation.eye.ellipsoidalHeight - input.cameraHeight,
      aim: evaluation.aim, gap: evaluation.gap, first: evaluation.first, second: evaluation.second,
      ...toleranceArea(input, place, sampler),
    });
  }
  return { places: places.sort((a, b) => a.gap - b.gap), evaluated: bearings.length * distances.length, missing };
}

/**
 * A place settled again on finer terrain (the sight lines' tiles): the grid
 * may run on coarser tiles over a wide range, and the tops, aim and outline
 * must match the terrain the sight lines are checked on. Null when the second
 * point no longer fits.
 */
export function refinePlace(input: GroundPairInput, place: GroundPlace, sampler: GroundSampler): GroundPlace | null {
  const settled = settle(input, place, sampler, place.first.distance);
  if (!settled || settled.evaluation.gap > input.tolerance) return null;
  const { place: at, evaluation } = settled;
  return {
    latitude: at.latitude, longitude: at.longitude, ground: evaluation.eye.ellipsoidalHeight - input.cameraHeight,
    aim: evaluation.aim, gap: evaluation.gap, first: evaluation.first, second: evaluation.second,
    ...toleranceArea(input, at, sampler),
  };
}

/** East and north metres from one place to another (local plane). */
function offsetOf(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): [number, number] {
  return [(to.longitude - from.longitude) * METRES_PER_DEGREE * Math.cos(from.latitude * degrees), (to.latitude - from.latitude) * METRES_PER_DEGREE];
}

/** Whether each of the two points can be seen from a place (the sampler must cover both sight lines). */
export function pairSight(input: Pick<GroundPairInput, "cameraHeight">, place: GroundPlace, sampler: GroundSampler): { first: Sight; second: Sight } {
  const eye = { latitude: place.latitude, longitude: place.longitude, ellipsoidalHeight: place.ground + input.cameraHeight };
  return { first: lineOfSight(eye, place.first.top, sampler).sight, second: lineOfSight(eye, place.second.top, sampler).sight };
}

/**
 * A spot within the place's tolerance outline from which neither point is
 * hidden: the place itself when it is clear, else the clear spot (inner and
 * outer rings of the outline) with the smallest gap. `moved` is how far it
 * lies from the place. Null when every spot tried is blocked.
 */
export function clearSpot(input: GroundPairInput, place: GroundPlace, sampler: GroundSampler) {
  const own = pairSight(input, place, sampler);
  if (own.first !== "blocked" && own.second !== "blocked") return { place, sight: own, moved: 0 };
  let best: { place: GroundPlace; sight: { first: Sight; second: Sight }; moved: number } | null = null;
  for (const share of [0.3, 0.6, 0.9])
    for (const edge of place.area) {
      const spot = { latitude: place.latitude + (edge.latitude - place.latitude) * share, longitude: place.longitude + (edge.longitude - place.longitude) * share };
      const found = evaluatePair(input, spot, sampler);
      if (!found || found.gap > input.tolerance || (best && found.gap >= best.place.gap)) continue;
      const candidate: GroundPlace = { ...place, latitude: spot.latitude, longitude: spot.longitude, ground: found.eye.ellipsoidalHeight - input.cameraHeight, aim: found.aim, gap: found.gap, first: found.first, second: found.second };
      const sight = pairSight(input, candidate, sampler);
      if (sight.first === "blocked" || sight.second === "blocked") continue;
      best = { place: candidate, sight, moved: Math.hypot(...offsetOf(place, spot)) };
    }
  return best;
}

/** Points along both sight lines of a place, for loading their terrain. */
export function sightPoints(place: GroundPlace, spacing = 500) {
  const points: { latitude: number; longitude: number }[] = [];
  for (const top of [place.first.top, place.second.top]) {
    const steps = Math.max(2, Math.ceil(Math.hypot(...offsetOf(place, top)) / spacing));
    for (let index = 0; index <= steps; index++)
      points.push({ latitude: place.latitude + ((top.latitude - place.latitude) * index) / steps, longitude: normalizeLongitude(place.longitude + ((top.longitude - place.longitude) * index) / steps) });
  }
  return points;
}
