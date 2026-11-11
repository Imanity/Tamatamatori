import { Body, GeoVector, MakeTime, RotateVector, Rotation_EQJ_EQD, SiderealTime } from "astronomy-engine";
import type { MapPoint } from "./map.ts";
import { sunPosition } from "./ephemeris.ts";

/**
 * Aurora chances from NOAA SWPC data and two published approximations:
 * a centred dipole for geomagnetic coordinates, and Carbary (2005) for the
 * equatorward edge of the auroral oval against Kp and magnetic local time.
 */

/**
 * Eccentric dipole (Fraser-Smith 1987) from the IGRF-14 degree 1—2 Gauss
 * coefficients at 2025.0 (nT): the dipole axis of the centred dipole, moved
 * to the offset centre that best fits degree 2. It follows the Atlantic and
 * Pacific asymmetry of corrected geomagnetic latitude better than a centred
 * dipole.
 */
const igrf = { g10: -29350.0, g11: -1410.3, h11: 4545.5, g20: -2556.2, g21: 2950.9, h21: -3133.6, g22: 1648.7, h22: -814.2 };
const radians = Math.PI / 180, degrees = 180 / Math.PI;
type Vector = [number, number, number];
const B0 = Math.hypot(igrf.g10, igrf.g11, igrf.h11);
/** Northern geomagnetic pole of the dipole axis (about 80.8°N, 72.8°W). */
export const GEOMAGNETIC_POLE = {
  latitude: 90 - Math.acos(-igrf.g10 / B0) * degrees,
  longitude: Math.atan2(-igrf.h11, -igrf.g11) * degrees,
} as const;
/** Offset of the dipole centre from the Earth's centre, in Earth radii (x to 0°E, y to 90°E, z north). */
export const DIPOLE_CENTRE: Vector = (() => {
  const { g10, g11, h11, g20, g21, h21, g22, h22 } = igrf, root3 = Math.sqrt(3), b2 = B0 * B0;
  const l0 = 2 * g10 * g20 + root3 * (g11 * g21 + h11 * h21);
  const l1 = -g11 * g20 + root3 * (g10 * g21 + g11 * g22 + h11 * h22);
  const l2 = -h11 * g20 + root3 * (g10 * h21 - h11 * g22 + g11 * h22);
  const e = (l0 * g10 + l1 * g11 + l2 * h11) / (4 * b2);
  return [(l1 - g11 * e) / (3 * b2), (l2 - h11 * e) / (3 * b2), (l0 - g10 * e) / (3 * b2)];
})();
const toVector = (latitude: number, longitude: number): Vector =>
  [Math.cos(latitude * radians) * Math.cos(longitude * radians), Math.cos(latitude * radians) * Math.sin(longitude * radians), Math.sin(latitude * radians)];
const rotateZ = ([x, y, z]: Vector, angle: number): Vector =>
  [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
const rotateY = ([x, y, z]: Vector, angle: number): Vector =>
  [x * Math.cos(angle) + z * Math.sin(angle), y, -x * Math.sin(angle) + z * Math.cos(angle)];
const tilt = (GEOMAGNETIC_POLE.latitude - 90) * radians;
const spherical = ([x, y, z]: Vector): MapPoint => {
  const length = Math.hypot(x, y, z);
  return { latitude: Math.asin(Math.max(-1, Math.min(1, z / length))) * degrees, longitude: Math.atan2(y, x) * degrees };
};

/** Eccentric-dipole latitude and longitude (degrees) of a surface point. */
export function geomagnetic(point: MapPoint): MapPoint {
  const [x, y, z] = toVector(point.latitude, point.longitude), [cx, cy, cz] = DIPOLE_CENTRE;
  return spherical(rotateY(rotateZ([x - cx, y - cy, z - cz], -GEOMAGNETIC_POLE.longitude * radians), tilt));
}
/** The surface point with the given eccentric-dipole coordinates. */
export function geographic(point: MapPoint): MapPoint {
  const d = rotateZ(rotateY(toVector(point.latitude, point.longitude), -tilt), GEOMAGNETIC_POLE.longitude * radians);
  const c = DIPOLE_CENTRE, b = d[0] * c[0] + d[1] * c[1] + d[2] * c[2], cc = c[0] ** 2 + c[1] ** 2 + c[2] ** 2;
  const s = -b + Math.sqrt(b * b - cc + 1);
  return spherical([c[0] + s * d[0], c[1] + s * d[1], c[2] + s * d[2]]);
}

/** The point under the Sun. */
export function subsolarPoint(instant: string): MapPoint {
  const time = MakeTime(new Date(instant));
  const sun = RotateVector(Rotation_EQJ_EQD(time), GeoVector(Body.Sun, time, true));
  const ra = Math.atan2(sun.y, sun.x) * degrees, distance = Math.hypot(sun.x, sun.y, sun.z);
  const longitude = ((ra - SiderealTime(time) * 15) % 360 + 540) % 360 - 180;
  return { latitude: Math.asin(sun.z / distance) * degrees, longitude };
}

/** Magnetic local time in hours: 12 under the Sun's magnetic meridian, 0 opposite. */
export function magneticLocalTime(point: MapPoint, instant: string) {
  const own = geomagnetic(point).longitude, sun = geomagnetic(subsolarPoint(instant)).longitude;
  return (((12 + (own - sun) / 15) % 24) + 24) % 24;
}

/**
 * Carbary (2005), equatorward boundary: latitude = c0 + c1·Kp per MLT hour.
 * Hours 9—13 have no fit (dayside); they are interpolated between 8 and 14.
 * Coefficients as transcribed in carbary-auroral-model 0.0.1 (MIT), Tables 1—4.
 */
const equatorward: Record<number, [number, number]> = {
  0: [67.22, -1.89], 1: [67.09, -1.91], 2: [67.57, -1.99], 3: [68.41, -2.06], 4: [69.26, -2.07],
  5: [70.67, -2.39], 6: [72.44, -2.99], 7: [73.77, -2.38], 8: [76.44, -2.63],
  14: [84.18, -3.09], 15: [83.79, -3.46], 16: [80.34, -3.09], 17: [78.34, -2.99], 18: [76.76, -3.07],
  19: [74.08, -2.66], 20: [72.56, -2.6], 21: [70.23, -2.23], 22: [69.26, -2.24], 23: [67.56, -1.88],
};
const hours = Object.keys(equatorward).map(Number).sort((a, b) => a - b);
export function ovalBoundary(kp: number, mlt: number) {
  const value = (hour: number) => equatorward[hour][0] + equatorward[hour][1] * kp;
  const t = ((mlt % 24) + 24) % 24;
  let below = hours.filter((hour) => hour <= t).at(-1), above = hours.find((hour) => hour > t);
  let span: number;
  if (below === undefined) { below = hours.at(-1)!; span = t + 24 - below; }
  else span = t - below;
  if (above === undefined) above = hours[0];
  const width = ((above - below) % 24 + 24) % 24 || 24;
  return value(below) + (value(above) - value(below)) * (span / width);
}

const EARTH_KM = 6371;
/** Visible top of the aurora assumed for horizon views, km. */
export const AURORA_TOP_KM = 200;
/** Elevation (degrees) of aurora at `height` km seen from `angle` degrees of arc away. */
export function auroraElevation(height: number, angle: number) {
  const theta = angle * radians;
  return Math.atan2(Math.cos(theta) - EARTH_KM / (EARTH_KM + height), Math.sin(theta)) * degrees;
}
/** Arc (degrees) at which the aurora top stands `elevation` degrees above the horizon. */
export function viewArc(elevation: number) {
  let low = 0, high = 30;
  for (let step = 0; step < 50; step++) {
    const middle = (low + high) / 2;
    if (auroraElevation(AURORA_TOP_KM, middle) > elevation) low = middle; else high = middle;
  }
  return (low + high) / 2;
}
/** Elevation of the aurora top that counts as "can be seen" (camera, clear horizon). */
export const VIEW_ELEVATION = 5;
const VIEW_ARC = viewArc(VIEW_ELEVATION);

export type AuroraKind = "overhead" | "low" | "horizon" | "none";
export interface AuroraView {
  kp: number;
  magneticLatitude: number;
  mlt: number;
  /** Equatorward edge of the oval at this MLT, magnetic latitude (absolute). */
  boundary: number;
  kind: AuroraKind;
  /** Elevation of the aurora top, degrees (90 when overhead). */
  top: number;
  /** Bearing towards this hemisphere's geomagnetic pole. */
  bearing: number;
  /** Smallest Kp (thirds) that brings the top above VIEW_ELEVATION here; null if none up to 9. */
  neededKp: number | null;
}

function bearingTo(from: MapPoint, to: MapPoint) {
  const phi1 = from.latitude * radians, phi2 = to.latitude * radians, dl = (to.longitude - from.longitude) * radians;
  return (Math.atan2(Math.sin(dl) * Math.cos(phi2), Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl)) * degrees + 360) % 360;
}

function classify(kp: number, latitude: number, mlt: number) {
  const boundary = ovalBoundary(kp, mlt);
  if (latitude >= boundary) return { boundary, kind: "overhead" as const, top: 90 };
  const top = auroraElevation(AURORA_TOP_KM, boundary - latitude);
  return { boundary, top, kind: top >= 15 ? "low" as const : top >= VIEW_ELEVATION ? "horizon" as const : "none" as const };
}

export function auroraView(point: MapPoint, instant: string, kp: number): AuroraView {
  const magnetic = geomagnetic(point), latitude = Math.abs(magnetic.latitude), mlt = magneticLocalTime(point, instant);
  const pole = magnetic.latitude >= 0 ? GEOMAGNETIC_POLE : { latitude: -GEOMAGNETIC_POLE.latitude, longitude: GEOMAGNETIC_POLE.longitude + 180 };
  let neededKp: number | null = null;
  for (let step = 0; step <= 27; step++)
    if (classify(step / 3, latitude, mlt).kind !== "none") { neededKp = step / 3; break; }
  return { kp, magneticLatitude: magnetic.latitude, mlt, ...classify(kp, latitude, mlt), bearing: bearingTo(point, pole), neededKp };
}

/** Kp in the usual thirds notation: 5−, 5, 5+. */
export function kpLabel(kp: number) {
  const thirds = Math.round(kp * 3), whole = Math.round(thirds / 3), rest = thirds - whole * 3;
  return `${whole}${rest > 0 ? "+" : rest < 0 ? "−" : ""}`;
}

/* ---- NOAA SWPC products ------------------------------------------------------------------ */

export type KpKind = "observed" | "estimated" | "predicted" | "outlook";
export interface KpBlock { start: number; end: number; kp: number; kind: KpKind }

/** `noaa-planetary-k-index-forecast.json`: 3-hour blocks, time tags in UTC. */
export function parseKpForecast(value: unknown): KpBlock[] {
  if (!Array.isArray(value)) throw new Error("Kp 预报格式无法识别");
  const blocks = value.map((entry) => {
    const record = entry as { time_tag?: unknown; kp?: unknown; observed?: unknown };
    const start = typeof record.time_tag === "string" ? Date.parse(`${record.time_tag}Z`) : NaN;
    if (!Number.isFinite(start) || typeof record.kp !== "number" || !(record.kp >= 0 && record.kp <= 9) ||
      !["observed", "estimated", "predicted"].includes(String(record.observed)))
      throw new Error("Kp 预报格式无法识别");
    return { start, end: start + 3 * 3_600_000, kp: record.kp, kind: record.observed as KpKind };
  });
  if (!blocks.length) throw new Error("Kp 预报为空");
  return blocks.sort((a, b) => a.start - b.start);
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `27-day-outlook.txt`: one UTC day per row with the largest expected Kp. */
export function parseOutlook(text: string): KpBlock[] {
  const blocks: KpBlock[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d{4})\s+([A-Z][a-z]{2})\s+(\d{2})\s+\d+\s+\d+\s+(\d)\s*$/);
    if (!match) continue;
    const month = months.indexOf(match[2]);
    if (month < 0) continue;
    const start = Date.UTC(Number(match[1]), month, Number(match[3]));
    blocks.push({ start, end: start + 86_400_000, kp: Number(match[4]), kind: "outlook" });
  }
  if (!blocks.length) throw new Error("27 天展望格式无法识别");
  return blocks;
}

/** The 3-hour value covering the instant, else the outlook day, else null. */
export function kpAt(time: number, forecast: KpBlock[] | null, outlook: KpBlock[] | null) {
  return forecast?.find((block) => block.start <= time && time < block.end) ??
    outlook?.find((block) => block.start <= time && time < block.end) ?? null;
}

export interface Ovation { observed: number; forecast: number; values: Uint8Array }
/** `ovation_aurora_latest.json`: [longitude 0—359, latitude −90—90, probability %]. */
export function parseOvation(value: unknown): Ovation {
  const record = value as { "Observation Time"?: unknown; "Forecast Time"?: unknown; coordinates?: unknown };
  const observed = Date.parse(String(record?.["Observation Time"])), forecast = Date.parse(String(record?.["Forecast Time"]));
  if (!Number.isFinite(observed) || !Number.isFinite(forecast) || !Array.isArray(record.coordinates))
    throw new Error("极光临近预报格式无法识别");
  const values = new Uint8Array(360 * 181);
  for (const entry of record.coordinates) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [lon, lat, chance] = entry as number[];
    if (!Number.isInteger(lon) || !Number.isInteger(lat) || lon < 0 || lon > 359 || lat < -90 || lat > 90) continue;
    values[(lat + 90) * 360 + lon] = Math.max(0, Math.min(100, Math.round(chance)));
  }
  return { observed, forecast, values };
}
export function ovationAt(ovation: Ovation, point: MapPoint) {
  const lon = ((Math.round(point.longitude) % 360) + 360) % 360, lat = Math.max(-90, Math.min(90, Math.round(point.latitude)));
  return ovation.values[(lat + 90) * 360 + lon];
}
/** The nowcast applies within 45 minutes of its forecast time. */
export const ovationApplies = (ovation: Ovation | null, time: number) =>
  !!ovation && Math.abs(time - ovation.forecast) <= 45 * 60_000;

/* ---- Timeline and map -------------------------------------------------------------------- */

export interface AuroraChance { from: number; to: number; best: AuroraView; kind: KpKind }
/**
 * Runs inside the span where the sky is dark (Sun below −12°) and the aurora
 * could be seen, sampled every 30 minutes.
 */
export function auroraChances(point: MapPoint, span: { start: string; end: string }, forecast: KpBlock[] | null, outlook: KpBlock[] | null) {
  const runs: AuroraChance[] = [];
  let current: AuroraChance | null = null;
  for (let time = Date.parse(span.start); time < Date.parse(span.end); time += 1_800_000) {
    const block = kpAt(time, forecast, outlook), instant = new Date(time).toISOString();
    const dark = sunPosition({ ...point, instant }).elevation < -12;
    const view = block && dark ? auroraView(point, instant, block.kp) : null;
    if (view && view.kind !== "none") {
      if (!current) current = { from: time, to: time + 1_800_000, best: view, kind: block!.kind };
      else {
        current.to = time + 1_800_000;
        if (view.top > current.best.top) current.best = view;
      }
    } else if (current) { runs.push(current); current = null; }
  }
  if (current) runs.push(current);
  return runs;
}

/** Equatorward edge and the line where the top reaches VIEW_ELEVATION, both hemispheres, [lon, lat] lines. */
export function auroraLines(instant: string, kp: number) {
  const sun = geomagnetic(subsolarPoint(instant)).longitude;
  const lines: { kind: "edge" | "view"; coordinates: [number, number][] }[] = [];
  for (const hemisphere of [1, -1])
    for (const kind of ["edge", "view"] as const) {
      const coordinates: [number, number][] = [];
      for (let mlon = -180; mlon <= 180; mlon += 3) {
        const mlt = 12 + (mlon - sun) / 15, boundary = ovalBoundary(kp, mlt) - (kind === "view" ? VIEW_ARC : 0);
        const place = geographic({ latitude: hemisphere * boundary, longitude: mlon });
        const last = coordinates.at(-1);
        let longitude = place.longitude;
        if (last) while (longitude - last[0] > 180) longitude -= 360;
        if (last) while (longitude - last[0] < -180) longitude += 360;
        coordinates.push([longitude, place.latitude]);
      }
      lines.push({ kind, coordinates });
    }
  return lines;
}

/** Nowcast cells of at least 10 %, merged along each latitude row by band (10/30/60 %). */
export function ovationCells(ovation: Ovation) {
  const band = (value: number) => (value >= 60 ? 3 : value >= 30 ? 2 : value >= 10 ? 1 : 0);
  const cells: { band: number; ring: [number, number][] }[] = [];
  for (let lat = -90; lat <= 90; lat++) {
    let start = -1, level = 0;
    for (let lon = 0; lon <= 360; lon++) {
      const current = lon < 360 ? band(ovation.values[(lat + 90) * 360 + lon]) : 0;
      if (current !== level) {
        if (level > 0) {
          const west = start - 0.5 > 180 ? start - 0.5 - 360 : start - 0.5, east = west + (lon - start);
          cells.push({ band: level, ring: [[west, lat - 0.5], [east, lat - 0.5], [east, lat + 0.5], [west, lat + 0.5], [west, lat - 0.5]] });
        }
        start = lon; level = current;
      }
    }
  }
  return cells;
}
