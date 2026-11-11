import { parseKpForecast, parseOutlook, parseOvation } from "../domain/aurora.ts";
import type { KpBlock, Ovation } from "../domain/aurora.ts";

/** NOAA SWPC products; public US government data, read directly (CORS allowed). */
const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
const OUTLOOK_URL = "https://services.swpc.noaa.gov/text/27-day-outlook.txt";
const OVATION_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
const ttl = { kp: 30 * 60_000, outlook: 6 * 3_600_000, ovation: 5 * 60_000 };

const cache: { kp?: { at: number; value: KpBlock[] }; outlook?: { at: number; value: KpBlock[] }; ovation?: { at: number; value: Ovation } } = {};

async function fetched(url: string, signal: AbortSignal, what: string) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${what}请求失败（${response.status}）`);
  return response;
}

/** Kp forecast and the 27-day outlook; each is cached on its own schedule. */
export async function loadKp(signal: AbortSignal, now = Date.now()) {
  signal.throwIfAborted();
  const kp = cache.kp && now - cache.kp.at < ttl.kp && now >= cache.kp.at ? cache.kp.value
    : parseKpForecast(await (await fetched(KP_URL, signal, "Kp 预报")).json());
  cache.kp = cache.kp?.value === kp ? cache.kp : { at: now, value: kp };
  const outlook = cache.outlook && now - cache.outlook.at < ttl.outlook && now >= cache.outlook.at ? cache.outlook.value
    : parseOutlook(await (await fetched(OUTLOOK_URL, signal, "27 天展望")).text());
  cache.outlook = cache.outlook?.value === outlook ? cache.outlook : { at: now, value: outlook };
  return { kp, outlook, fetchedAt: Math.min(cache.kp.at, cache.outlook.at) };
}

/** OVATION nowcast (about 0.9 MB); read only when the shooting instant is near now. */
export async function loadOvation(signal: AbortSignal, now = Date.now()) {
  signal.throwIfAborted();
  if (cache.ovation && now - cache.ovation.at < ttl.ovation && now >= cache.ovation.at) return cache.ovation.value;
  const value = parseOvation(await (await fetched(OVATION_URL, signal, "极光临近预报")).json());
  cache.ovation = { at: now, value };
  return value;
}
