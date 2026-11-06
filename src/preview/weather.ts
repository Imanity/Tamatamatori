import { parseWeather, weatherLocationKey, weatherVariables, WEATHER_TTL } from "../domain/weather.ts";
import type { WeatherForecast } from "../domain/weather.ts";
import type { MapPoint } from "../domain/map.ts";

const cache = new Map<string, WeatherForecast>();

export async function loadWeather(point: MapPoint, signal: AbortSignal, now = Date.now()) {
  signal.throwIfAborted();
  const key = weatherLocationKey(point), cached = cache.get(key);
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < WEATHER_TTL) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const parameters = new URLSearchParams({
    latitude: String(point.latitude), longitude: String(point.longitude),
    hourly: Object.values(weatherVariables).join(","), forecast_days: "7",
    timezone: "GMT", timeformat: "unixtime", wind_speed_unit: "ms",
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${parameters}`, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? "天气服务请求受限，请稍后重试" : `天气数据请求失败（${response.status}）`);
  const data = parseWeather(await response.json(), now);
  signal.throwIfAborted();
  cache.delete(key);
  cache.set(key, data);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return data;
}
