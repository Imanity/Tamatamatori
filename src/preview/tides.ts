import type { MapPoint } from "../domain/map.ts";
import { parseTides, tideDates, tideKey, tideProbes, TideRangeError, TIDE_TTL } from "../domain/tides.ts";
import type { TideSeries } from "../domain/tides.ts";
import { estimateOpenMeteoCost, rateLimitMessage } from "../domain/api-usage.ts";
import { recordOpenMeteo } from "./api-usage.ts";

const cache = new Map<string, TideSeries>();

/**
 * Hourly sea level for the camera and two rings of probes in one request;
 * the nearest cell with data is used. Requests carry only coordinates and
 * dates.
 */
export async function loadTides(point: MapPoint, span: { start: string; end: string }, signal: AbortSignal, now = Date.now()) {
  signal.throwIfAborted();
  const key = tideKey(point, span), cached = cache.get(key);
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < TIDE_TTL) return cached;
  const probes = tideProbes(point), dates = tideDates(span);
  const parameters = new URLSearchParams({
    latitude: probes.map((probe) => probe.latitude.toFixed(4)).join(","),
    longitude: probes.map((probe) => probe.longitude.toFixed(4)).join(","),
    hourly: "sea_level_height_msl", timezone: "GMT", timeformat: "unixtime",
    start_date: dates.start, end_date: dates.end, cell_selection: "sea",
  });
  const response = await fetch(`https://marine-api.open-meteo.com/v1/marine?${parameters}`, { signal });
  // The marine API sends no cost header; each probe location counts as one call.
  const days = (Date.parse(dates.end) - Date.parse(dates.start)) / 86_400_000 + 1;
  const wait = recordOpenMeteo(response, estimateOpenMeteoCost({ locations: probes.length, days }));
  if (response.status === 429) throw new Error(rateLimitMessage(wait));
  if (response.status === 400) {
    const body = await response.json().catch(() => null) as { reason?: string } | null;
    if (body?.reason && /out of allowed range/i.test(body.reason)) throw new TideRangeError();
  }
  if (!response.ok) throw new Error(`潮位数据请求失败（${response.status}）`);
  const series = parseTides(await response.json(), point, now);
  signal.throwIfAborted();
  cache.set(key, series);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return series;
}
