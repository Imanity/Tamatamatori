import type { MapPoint } from "../core/map.ts";
import { destination } from "../core/map.ts";

/**
 * Sea level from the Open-Meteo Marine API (`sea_level_height_msl`): the
 * MeteoFrance SMOC model via Copernicus Marine, about 8 km cells, hourly,
 * relative to global mean sea level — not chart datum.
 */
export const TIDE_TTL = 3 * 3_600_000;
const HOUR = 3_600_000;
/** Beyond this the chosen sea cell may differ noticeably from the coast at the camera. */
export const TIDE_FAR_KM = 20;

export interface TideSeries {
  fetchedAt: number;
  /** The sea cell used and its distance from the camera. */
  cell: { latitude: number; longitude: number; distance: number };
  /** UTC milliseconds of the first hourly value. */
  start: number;
  /** Hourly heights in metres; null where the model has no value. */
  heights: (number | null)[];
}

export class TideRangeError extends Error {
  constructor() {
    super("超出潮位数据范围（2022 年起至约 10 天后）");
    this.name = "TideRangeError";
  }
}
export class NoSeaError extends Error {
  constructor() {
    super("机位附近约 30 km 内没有海洋格点");
    this.name = "NoSeaError";
  }
}

/** The camera and two rings around it (about 12 and 30 km): a coastal camera often sits in a land cell. */
export function tideProbes(point: MapPoint): MapPoint[] {
  const probes: MapPoint[] = [{ latitude: point.latitude, longitude: point.longitude }];
  for (const [radius, offset] of [[12_000, 0], [30_000, 30]] as const)
    for (let index = 0; index < 6; index++) {
      const found = destination(point, offset + index * 60, radius);
      probes.push({ latitude: found.latitude, longitude: ((found.longitude + 540) % 360) - 180 });
    }
  return probes;
}

/** UTC calendar dates covering the span with a three-hour margin on each side. */
export function tideDates(span: { start: string; end: string }) {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  return { start: day(Date.parse(span.start) - 3 * HOUR), end: day(Date.parse(span.end) + 3 * HOUR) };
}

/** Cache and request identity: the camera to about 100 m and the UTC dates. */
export const tideKey = (point: MapPoint, span: { start: string; end: string }) => {
  const dates = tideDates(span);
  return `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}/${dates.start}/${dates.end}`;
};

export function distanceKm(a: MapPoint, b: MapPoint) {
  const radians = Math.PI / 180, phi1 = a.latitude * radians, phi2 = b.latitude * radians;
  const h = Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin((b.longitude - a.longitude) * radians / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Picks the nearest returned cell with any value. Responses are one object per
 * probe (a list), each with unixtime `hourly.time` and `hourly.sea_level_height_msl`.
 */
export function parseTides(value: unknown, camera: MapPoint, now: number): TideSeries {
  const items = Array.isArray(value) ? value : [value];
  let best: TideSeries | null = null;
  for (const item of items) {
    const record = item as { latitude?: unknown; longitude?: unknown; hourly?: { time?: unknown; sea_level_height_msl?: unknown } };
    const times = record?.hourly?.time, heights = record?.hourly?.sea_level_height_msl;
    if (!finite(record?.latitude) || !finite(record?.longitude) || !Array.isArray(times) || !Array.isArray(heights) ||
      times.length !== heights.length || !times.length || !times.every(finite))
      throw new Error("潮位数据格式无法识别");
    const values = heights.map((height) => (finite(height) && Math.abs(height) < 30 ? height : null));
    if (!values.some((height) => height !== null)) continue;
    for (let index = 1; index < times.length; index++)
      if (times[index] - times[index - 1] !== 3600) throw new Error("潮位数据不是逐小时序列");
    const cell = { latitude: record.latitude, longitude: record.longitude };
    const distance = distanceKm(camera, cell);
    if (!best || distance < best.cell.distance)
      best = { fetchedAt: now, cell: { ...cell, distance }, start: times[0] * 1000, heights: values };
  }
  if (!best) throw new NoSeaError();
  return best;
}

/**
 * Height and rate (m/h) at an instant by cubic Hermite interpolation of the
 * hourly values; null outside the series or next to a gap.
 */
export function tideAt(series: TideSeries, time: number) {
  const position = (time - series.start) / HOUR, index = Math.floor(position), t = position - index;
  const at = (i: number) => series.heights[i] ?? null;
  const p0 = at(index - 1), p1 = at(index), p2 = at(index + 1), p3 = at(index + 2);
  if (p1 === null || (p2 === null && t > 0)) return null;
  if (t === 0 && p2 === null) return p0 === null ? null : { height: p1, rate: p1 - p0 };
  const m1 = p0 !== null ? (p2! - p0) / 2 : p2! - p1, m2 = p3 !== null ? (p3 - p1) / 2 : p2! - p1;
  const t2 = t * t, t3 = t2 * t;
  const height = (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2! + (t3 - t2) * m2;
  const rate = (6 * t2 - 6 * t) * p1 + (3 * t2 - 4 * t + 1) * m1 + (-6 * t2 + 6 * t) * p2! + (3 * t2 - 2 * t) * m2;
  return { height, rate };
}

export interface TideExtreme { kind: "high" | "low"; time: number; height: number }
/** Highs and lows in [from, to): hourly turning points refined by a parabola through three values. */
export function tideExtremes(series: TideSeries, from: number, to: number): TideExtreme[] {
  const found: TideExtreme[] = [];
  for (let index = 1; index + 1 < series.heights.length; index++) {
    const a = series.heights[index - 1], b = series.heights[index], c = series.heights[index + 1];
    if (a === null || b === null || c === null) continue;
    const high = b > a && b >= c, low = b < a && b <= c;
    if (!high && !low) continue;
    const curvature = a - 2 * b + c;
    const offset = curvature === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * curvature)));
    const time = series.start + (index + offset) * HOUR;
    if (time < from || time >= to) continue;
    found.push({ kind: high ? "high" : "low", time: Math.round(time / 60_000) * 60_000, height: b - (a - c) * offset / 4 });
  }
  return found;
}

/** Whether the series has values throughout [from, to]. */
export function tideCovers(series: TideSeries, from: number, to: number) {
  const first = Math.floor((from - series.start) / HOUR), last = Math.ceil((to - series.start) / HOUR);
  if (first < 0 || last >= series.heights.length) return false;
  for (let index = first; index <= last; index++) if (series.heights[index] === null) return false;
  return true;
}

/** The tide at the shooting instant and the next high and low after it. */
export function tideNow(series: TideSeries, instant: string) {
  const time = Date.parse(instant), now = tideAt(series, time);
  if (!now) return null;
  const after = tideExtremes(series, time + 60_000, series.start + series.heights.length * HOUR);
  return {
    height: now.height,
    rising: now.rate > 0,
    nextHigh: after.find((entry) => entry.kind === "high") ?? null,
    nextLow: after.find((entry) => entry.kind === "low") ?? null,
  };
}

export const tideHeight = (height: number) => `${height >= 0 ? "+" : "−"}${Math.abs(height).toFixed(2)} m`;
