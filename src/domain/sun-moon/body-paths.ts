import { Temporal } from "@js-temporal/polyfill";
import { Body } from "astronomy-engine";
import type { Observer } from "astronomy-engine";
import type { ShootingPlan } from "../core/plan.ts";
import type { Vector3 } from "../core/ephemeris.ts";
import { add, direction, dot, observerContext, scale, topocentric } from "../core/ephemeris.ts";
import { refractDirection } from "../core/refraction.ts";
import type { View } from "../core/celestial-projection.ts";
import { cameraBasis, projectDirection } from "../core/celestial-projection.ts";

export type PathBodyId = "sun" | "moon";
/** Passes are looked for this far before and after the shooting instant. */
export const PATH_SEARCH_HOURS = 36;
export const PATH_STEP_MINUTES = 5;
const hour = 3_600_000;
const searchHalf = PATH_SEARCH_HOURS * hour;
const step = PATH_STEP_MINUTES * 60_000;

type PathInput = Pick<ShootingPlan, "latitude" | "longitude" | "instant" | "timeZone" | "refraction">;

/**
 * Which pass above the sea-level horizon is drawn: the one containing the
 * shooting instant, else the nearer of the previous and next; "long" is a pass
 * over 24 h (the Sun or Moon does not set), shown for 24 h around the instant.
 */
export type PathPass = "current" | "next" | "previous" | "long";

export interface PathMarker {
  /** UTC milliseconds of a whole local hour. */
  time: number;
  label: string;
  /** Local date relative to the shooting date: −1 previous day, 1 next day. */
  day: number;
  /** Apparent direction, the same refraction as the rendered disc. */
  direction: Vector3;
  /** Apparent direction one sample later, for the label side. */
  next: Vector3;
}
export interface BodyPath {
  id: PathBodyId;
  /** Null when the centre stays below the horizon for the whole search. */
  pass: PathPass | null;
  /** UTC milliseconds, chronological; includes the shooting instant when it lies in the pass. */
  times: number[];
  points: Vector3[];
  markers: PathMarker[];
}

// Geometric directions on an epoch-aligned grid, so moving the shooting time
// only computes the samples that enter the search.
const cache = new Map<string, Vector3>();
function geometric(id: PathBodyId, observer: Observer, site: string, time: number): Vector3 {
  const key = `${site}/${id}/${time}`;
  let value = cache.get(key);
  if (!value) {
    if (cache.size >= 8000) cache.clear();
    const { horizon } = topocentric(id === "sun" ? Body.Sun : Body.Moon, new Date(time), observer);
    value = direction(horizon.azimuth, horizon.altitude);
    cache.set(key, value);
  }
  return value;
}

/**
 * Apparent sky path of the Sun or Moon for one pass above the sea-level
 * horizon, sampled every 5 minutes with the shooting instant as a vertex so
 * the line passes through the drawn disc. Observer, ephemeris and refraction
 * are those of the disc; terrain is not considered.
 */
export function bodyPath(plan: PathInput, id: PathBodyId): BodyPath {
  // The preview layer and the labels ask for the same path; results are immutable.
  const memoKey = [id, plan.latitude, plan.longitude, plan.instant, plan.timeZone, plan.refraction].join("/");
  const hit = recent.find((entry) => entry.key === memoKey);
  if (hit) return hit.path;
  const path = computePath(plan, id);
  recent.unshift({ key: memoKey, path });
  recent.length = Math.min(recent.length, 4);
  return path;
}
const recent: { key: string; path: BodyPath }[] = [];

function computePath(plan: PathInput, id: PathBodyId): BodyPath {
  const { date, observer } = observerContext(plan);
  const site = `${plan.latitude}/${plan.longitude}`;
  const centre = date.getTime();
  const apparent = (time: number) => refractDirection(geometric(id, observer, site, time), plan.refraction);
  const grid: number[] = [];
  for (let time = Math.ceil((centre - searchHalf) / step) * step; time <= centre + searchHalf; time += step) grid.push(time);
  const times = [...new Set([...grid, centre])].sort((a, b) => a - b);
  const above = times.map((time) => apparent(time)[2] > 0);

  // Runs of samples whose centre is above the horizon, as [first, last] indices.
  const runs: [number, number][] = [];
  above.forEach((up, index) => {
    if (!up) return;
    const last = runs[runs.length - 1];
    if (last && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  });
  const at = times.indexOf(centre);
  let chosen = runs.find(([first, last]) => first <= at && at <= last);
  let pass: PathPass | null = chosen ? "current" : null;
  if (!chosen) {
    const next = runs.find(([first]) => first > at), previous = [...runs].reverse().find(([, last]) => last < at);
    const ahead = next ? times[next[0]] - centre : Infinity, behind = previous ? centre - times[previous[1]] : Infinity;
    if (next || previous) [chosen, pass] = ahead <= behind ? [next!, "next"] : [previous!, "previous"];
  }
  if (!chosen || !pass) return { id, pass: null, times: [], points: [], markers: [] };

  // Include the samples just below the horizon, so clipping finds the crossing.
  let start = times[Math.max(0, chosen[0] - 1)], end = times[Math.min(times.length - 1, chosen[1] + 1)];
  if (end - start > 24 * hour) {
    // At most one turn of the sky, kept around the shooting instant where possible.
    if (pass === "current") start = Math.min(Math.max(start, centre - 12 * hour), end - 24 * hour);
    else if (pass === "previous") start = end - 24 * hour;
    end = start + 24 * hour;
    pass = pass === "current" ? "long" : pass;
  }
  const kept = [...new Set([start, ...times.filter((time) => time > start && time < end), end])];

  const zone = plan.timeZone;
  const shootingDate = Temporal.Instant.fromEpochMilliseconds(centre).toZonedDateTimeISO(zone).toPlainDate();
  const markers: PathMarker[] = [];
  let local = Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(zone).round({ smallestUnit: "hour", roundingMode: "ceil" });
  // Half-open, so a 24-hour pass does not mark both of its ends (only a DST fall-back repeats a label).
  while (local.epochMilliseconds < end) {
    const time = local.epochMilliseconds;
    const direction = apparent(time);
    if (direction[2] > 0)
      markers.push({
        time,
        label: `${String(local.hour).padStart(2, "0")}:00`,
        day: Temporal.PlainDate.compare(local.toPlainDate(), shootingDate),
        direction,
        next: apparent(time + step),
      });
    let next = local.add({ hours: 1 });
    // A half-hour DST shift moves wall-clock minutes; return to whole hours.
    if (next.minute || next.second || next.millisecond) next = next.round({ smallestUnit: "hour", roundingMode: "ceil" });
    local = next;
  }
  return { id, pass, times: kept, points: kept.map(apparent), markers };
}

type Run = Vector3[];
type Plane = (point: Vector3) => number;

/** Splits polylines where they leave the half-space plane(p) ≥ 0, in 3D before projection. */
function clipRuns(runs: Run[], plane: Plane): Run[] {
  const output: Run[] = [];
  for (const run of runs) {
    let current: Run = [];
    for (let index = 0; index < run.length; index++) {
      const a = run[index], da = plane(a);
      if (index > 0) {
        const b = run[index - 1], db = plane(b);
        if (db >= 0 !== da >= 0) current.push(add(b, scale(add(a, scale(b, -1)), db / (db - da))));
      }
      if (da >= 0) current.push(a);
      else {
        if (current.length >= 2) output.push(current);
        current = [];
      }
    }
    if (current.length >= 2) output.push(current);
  }
  return output;
}

export type PathState = "画面内" | "视场外" | "地平线下";
type Point = { x: number; y: number };
export interface PathMarkerView {
  time: number;
  label: string;
  day: number;
  point: Point;
  /** Screen direction of travel in normalised device units, or null at the frame edge. */
  tangent: Point | null;
}

/**
 * Projects a path into the frame. Runs are clipped at the sea-level horizon
 * (as the disc) and at a frame extended by `margin`, so the GPU never receives
 * points behind the camera; markers are those strictly inside the frame.
 */
export function pathView(view: View, path: BodyPath, margin = 1.1) {
  const basis = cameraBasis(view);
  const depth = (p: Vector3) => dot(p, basis.forward);
  const frame = (extent: number): Plane[] => [
    (p) => depth(p) * basis.tx * extent - dot(p, basis.right),
    (p) => depth(p) * basis.tx * extent + dot(p, basis.right),
    (p) => depth(p) * basis.ty * extent - dot(p, basis.up),
    (p) => depth(p) * basis.ty * extent + dot(p, basis.up),
  ];
  const above = clipRuns([path.points], (p) => p[2]);
  // Behind the camera is outside the frame, not below the horizon.
  const ahead = clipRuns(above, (p) => depth(p) - 1e-6);
  const project = (runs: Run[]) => runs.map((run) => run.map((p) => projectDirection(view, p)!));
  const runs = project(frame(margin).reduce(clipRuns, ahead));
  const inside = frame(1).reduce(clipRuns, ahead);
  const state: PathState = !above.length ? "地平线下" : inside.length ? "画面内" : "视场外";
  const markers: PathMarkerView[] = [];
  for (const marker of path.markers) {
    if (marker.direction[2] <= 0) continue;
    const point = projectDirection(view, marker.direction);
    if (!point || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
    const next = projectDirection(view, marker.next);
    markers.push({
      time: marker.time, label: marker.label, day: marker.day, point,
      tangent: next ? { x: next.x - point.x, y: next.y - point.y } : null,
    });
  }
  return { id: path.id, pass: path.pass, state, runs, markers };
}
export type PathView = ReturnType<typeof pathView>;
