import type { MapPoint } from "./map.ts";

export const WEATHER_TTL = 30 * 60_000;
export const weatherVariables = {
  cloud: "cloud_cover",
  low: "cloud_cover_low",
  mid: "cloud_cover_mid",
  high: "cloud_cover_high",
  precipitation: "precipitation",
  probability: "precipitation_probability",
  rain: "rain",
  showers: "showers",
  snow: "snowfall",
  visibility: "visibility",
  windSpeed: "wind_speed_10m",
  windDirection: "wind_direction_10m",
} as const;
type WeatherField = keyof typeof weatherVariables;
type WeatherValues = Record<WeatherField, number>;
export type WeatherHour = { time: number } & Record<WeatherField, number | null>;
export interface WeatherForecast {
  latitude: number;
  longitude: number;
  fetchedAt: number;
  hours: WeatherHour[];
}
export type WeatherSample = WeatherValues & { time: number };
const fractionFields = new Set<WeatherField>(["cloud", "low", "mid", "high", "probability"]);
const continuousFields: WeatherField[] = ["cloud", "low", "mid", "high", "visibility", "windSpeed"];
const intervalFields: WeatherField[] = ["precipitation", "probability", "rain", "showers", "snow"];

export function weatherLocationKey(point: MapPoint) {
  if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180)
    throw new RangeError("天气需要有效的机位经纬度");
  return `${point.latitude}/${point.longitude}`;
}

export function parseWeather(value: unknown, fetchedAt: number): WeatherForecast {
  const data = value as {
    latitude: number; longitude: number; utc_offset_seconds: number;
    hourly?: Record<string, unknown[]>; hourly_units?: Record<string, string>;
  } | null;
  const times = data?.hourly?.time;
  if (!data || !Number.isFinite(data.latitude) || Math.abs(data.latitude) > 90 ||
      !Number.isFinite(data?.longitude) || Math.abs(data.longitude) > 180 ||
      data.utc_offset_seconds !== 0 || !Number.isFinite(fetchedAt) ||
      !Array.isArray(times) || times.length < 2 || times.length > 384)
    throw new Error("天气数据的坐标或时间格式无效");
  for (const [field, variable] of Object.entries(weatherVariables)) {
    const values = data.hourly![variable];
    const expected = fractionFields.has(field as WeatherField) ? "%"
      : field === "windSpeed" ? "m/s" : field === "windDirection" ? "°"
        : field === "visibility" ? "m" : field === "snow" ? "cm" : "mm";
    if (!Array.isArray(values) || values.length !== times.length || data.hourly_units?.[variable] !== expected)
      throw new Error("天气数据字段或单位不完整");
  }
  const hours = times.map((time: unknown, index: number) => {
    if (typeof time !== "number" || !Number.isSafeInteger(time) || Math.abs(time) > 8.64e12 ||
        (index > 0 && time - (times[index - 1] as number) !== 3600))
      throw new Error("天气时间序列无效");
    const hour = { time: time * 1000 } as WeatherHour;
    for (const [field, variable] of Object.entries(weatherVariables)) {
      const raw = data.hourly![variable][index];
      if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 ||
          (fractionFields.has(field as WeatherField) && raw > 100) || (field === "windDirection" && raw > 360)))
        throw new Error("天气数据含无效数值");
      hour[field as WeatherField] = raw === null ? null : fractionFields.has(field as WeatherField) ? (raw as number) / 100 : raw as number;
    }
    return hour;
  });
  return { latitude: data.latitude, longitude: data.longitude, fetchedAt, hours };
}

export function sampleWeather(forecast: WeatherForecast, instant: string): WeatherSample | null {
  const time = Date.parse(instant), hours = forecast.hours;
  if (!Number.isFinite(time) || time < hours[0].time || time > hours.at(-1)!.time) return null;
  const position = (time - hours[0].time) / 3_600_000;
  const a = hours[Math.floor(position)], b = hours[Math.ceil(position)], weight = position % 1;
  const result = { time } as WeatherSample;
  for (const field of continuousFields) {
    if (a[field] === null || b[field] === null) return null;
    result[field] = a[field]! + (b[field]! - a[field]!) * weight;
  }
  for (const field of intervalFields) {
    if (b[field] === null) return null;
    result[field] = b[field]!;
  }
  if (a.windDirection === null || b.windDirection === null) return null;
  const turn = ((b.windDirection - a.windDirection + 540) % 360) - 180;
  result.windDirection = (a.windDirection + turn * weight + 360) % 360;
  return result;
}
