import { parseWeather, weatherLocationKey, weatherVariables, weatherModels, WEATHER_TTL } from "../domain/environment/weather.ts";
import type { WeatherModel } from "../domain/environment/weather.ts";
import type { WeatherForecast } from "../domain/environment/weather.ts";
import type { MapPoint } from "../domain/core/map.ts";
import { bestMatchCandidates, parseBestMatchSeries } from "../domain/environment/weather-source.ts";
import { estimateOpenMeteoCost, rateLimitMessage } from "../domain/environment/api-usage.ts";
import { recordOpenMeteo } from "./api-usage.ts";
import type { BestMatchSeries } from "../domain/environment/weather-source.ts";

const cache = new Map<string, WeatherForecast>();

export async function loadWeather(point: MapPoint, signal: AbortSignal, now = Date.now(), model: WeatherModel = "best_match") {
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
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${parameters}`, { signal });
  const wait = recordOpenMeteo(response, estimateOpenMeteoCost({ variables: Object.keys(weatherVariables).length, days: 7 }));
  if (response.status === 429) throw new Error(rateLimitMessage(wait));
  if (!response.ok) throw new Error(`天气数据请求失败（${response.status}）`);
  const data = parseWeather(await response.json(), now);
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
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${parameters}`, { signal });
  recordOpenMeteo(response, estimateOpenMeteoCost({ models: bestMatchCandidates.length + 1, days: 7 }));
  if (!response.ok) throw new Error(`自动匹配来源请求失败（${response.status}）`);
  const series = parseBestMatchSeries(await response.json());
  signal.throwIfAborted();
  sourceCache.delete(key);
  sourceCache.set(key, { fetchedAt: now, series });
  if (sourceCache.size > 4) sourceCache.delete(sourceCache.keys().next().value!);
  return series;
}
