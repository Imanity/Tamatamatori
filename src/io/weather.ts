import { parseWeather, weatherLocationKey, weatherVariables, weatherModels, WEATHER_TTL } from "../domain/environment/weather.ts";
import type { WeatherModel } from "../domain/environment/weather.ts";
import type { WeatherForecast } from "../domain/environment/weather.ts";
import type { MapPoint } from "../domain/core/map.ts";
import { bestMatchCandidates, parseBestMatchSeries } from "../domain/environment/weather-source.ts";
import { estimateOpenMeteoCost, rateLimitMessage } from "../domain/environment/api-usage.ts";
import { recordOpenMeteo } from "./api-usage.ts";
import type { BestMatchSeries } from "../domain/environment/weather-source.ts";

const cache = new Map<string, WeatherForecast>();

class WeatherHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`天气数据请求失败（${status}）`); this.status = status; }
}

/** Retry transport failures once; invalid data, cancellation and rate limits need a different response. */
async function weatherJson(url: string, signal: AbortSignal, cost: number, {
  attempts = 2, timeout = 20_000, onRetry,
}: { attempts?: number; timeout?: number; onRetry?: (attempt: number) => void } = {}): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const abort = AbortSignal.any([signal, controller.signal]);
    try {
      const response = await fetch(url, { signal: abort });
      const wait = recordOpenMeteo(response, cost);
      if (response.status === 429) throw new Error(rateLimitMessage(wait));
      if (!response.ok) throw new WeatherHttpError(response.status);
      const value: unknown = await response.json();
      abort.throwIfAborted();
      return value;
    } catch (cause) {
      signal.throwIfAborted(); // Closing weather or changing position must never start a retry.
      const transient = timedOut || cause instanceof TypeError ||
        (cause instanceof WeatherHttpError && [408, 500, 502, 503, 504].includes(cause.status));
      if (!transient) throw cause;
      if (attempt >= attempts) {
        const retried = attempts > 1 ? "（已自动重试）" : "";
        if (timedOut) throw new Error(`天气数据读取超时${retried}，请稍后重试`);
        if (cause instanceof WeatherHttpError) throw new Error(`${cause.message}${retried}`);
        throw new Error(`暂时无法连接 Open-Meteo${retried}，请检查网络或稍后重试`);
      }
    } finally { clearTimeout(timer); }
    onRetry?.(attempt + 1);
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(pause); signal.removeEventListener("abort", stop); reject(signal.reason); };
      const pause = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 1000);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }
}

export async function loadWeather(point: MapPoint, signal: AbortSignal, now = Date.now(), model: WeatherModel = "best_match", onRetry?: (attempt: number) => void) {
  signal.throwIfAborted();
  if (!Object.hasOwn(weatherModels, model)) throw new RangeError("未知天气预报模型");
  const key = `${weatherLocationKey(point)}/${model}`, cached = cache.get(key);
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < WEATHER_TTL) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const parameters = new URLSearchParams({
    latitude: String(point.latitude), longitude: String(point.longitude),
    hourly: Object.values(weatherVariables).join(","), forecast_days: "7",
    timezone: "GMT", timeformat: "unixtime", wind_speed_unit: "ms",
    models: model,
  });
  const value = await weatherJson(`https://api.open-meteo.com/v1/forecast?${parameters}`, signal,
    estimateOpenMeteoCost({ variables: Object.keys(weatherVariables).length, days: 7 }), { onRetry });
  const data = parseWeather(value, now);
  signal.throwIfAborted();
  cache.delete(key);
  cache.set(key, data);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return data;
}

const sourceCache = new Map<string, { fetchedAt: number; series: BestMatchSeries }>();

/**
 * Hourly cloud cover of best_match and its candidate models in one request,
 * to tell which model best_match uses at the shooting hour.
 */
export async function loadWeatherSource(point: MapPoint, signal: AbortSignal, now = Date.now()) {
  signal.throwIfAborted();
  const key = weatherLocationKey(point), cached = sourceCache.get(key);
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < WEATHER_TTL) return cached.series;
  const parameters = new URLSearchParams({
    latitude: String(point.latitude), longitude: String(point.longitude),
    hourly: "cloud_cover", forecast_days: "7", timezone: "GMT", timeformat: "unixtime",
    models: ["best_match", ...bestMatchCandidates.map((candidate) => candidate.id)].join(","),
  });
  // Optional attribution must not keep an expensive multi-model request alive indefinitely.
  const value = await weatherJson(`https://api.open-meteo.com/v1/forecast?${parameters}`, signal,
    estimateOpenMeteoCost({ models: bestMatchCandidates.length + 1, days: 7 }), { attempts: 1, timeout: 10_000 });
  const series = parseBestMatchSeries(value);
  signal.throwIfAborted();
  sourceCache.delete(key);
  sourceCache.set(key, { fetchedAt: now, series });
  if (sourceCache.size > 4) sourceCache.delete(sourceCache.keys().next().value!);
  return series;
}
