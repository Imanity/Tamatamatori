import test from "node:test";
import assert from "node:assert/strict";
import { weatherResponse } from "./fixtures/weather.mjs";
import { parseWeather, sampleWeather, weatherLocationKey, WEATHER_TTL } from "../src/domain/weather.ts";
import { loadWeather } from "../src/preview/weather.ts";
import { cloudOpacity, weatherClouds } from "../src/domain/weather-appearance.ts";
import { direction } from "../src/domain/ephemeris.ts";
import { environmentForSky } from "../src/preview/environment.ts";

const start = Date.UTC(2026, 10, 4);
const at = (hours) => new Date(start + hours * 3600000).toISOString();
const sample = () => sampleWeather(parseWeather(weatherResponse(), start), at(0));

test("天气按 UTC 插值云量、能见度和跨北风向，降水采用前一小时累计区间", () => {
  const response = weatherResponse();
  response.hourly.cloud_cover_low[0] = 10; response.hourly.cloud_cover_low[1] = 90;
  response.hourly.wind_direction_10m[1] = 10;
  response.hourly.precipitation[0] = 0; response.hourly.precipitation[1] = 8;
  response.hourly.precipitation_probability[1] = 70;
  const data = parseWeather(response, start);
  assert.equal(sampleWeather(data, at(0)).precipitation, 0);
  const middle = sampleWeather(data, at(0.5));
  assert.equal(middle.low, 0.5); assert.equal(middle.windDirection, 0);
  assert.equal(middle.precipitation, 8); assert.equal(middle.probability, 0.7);
  assert.deepEqual(sampleWeather(data, "2026-11-04T09:30:00+09:00"), middle);
  assert.equal(sampleWeather(data, at(-0.001)), null);
  assert.ok(sampleWeather(data, at(167))); assert.equal(sampleWeather(data, at(167.01)), null);
});

test("天气缺测独立于真实零值，无效单位、乱序和异常数值拒绝应用", () => {
  const raw = weatherResponse(); raw.hourly.cloud_cover_low[0] = 0;
  assert.equal(sampleWeather(parseWeather(raw, start), at(0)).low, 0);
  raw.hourly.cloud_cover_low[1] = null;
  assert.equal(sampleWeather(parseWeather(raw, start), at(0.5)), null);
  for (const alter of [r => r.hourly_units.rain = "cm", r => r.hourly.time[1] = r.hourly.time[0],
    r => r.hourly.cloud_cover[0] = 101, r => r.hourly.visibility[0] = -1, r => r.utc_offset_seconds = 3600]) {
    const response = weatherResponse(); alter(response); assert.throws(() => parseWeather(response, start));
  }
  assert.throws(() => parseWeather(null, start));
  assert.throws(() => weatherLocationKey({ latitude: 91, longitude: 0 }));
});

test("天气七天请求、半小时缓存、四机位驻留和过期更新保持有界", async t => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async url => { urls.push(String(url)); return Response.json(weatherResponse()); });
  const signal = new AbortController().signal, point = { latitude: 34, longitude: 130 };
  const first = await loadWeather(point, signal, start);
  assert.equal(await loadWeather(point, signal, start + WEATHER_TTL - 1), first);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.host, "api.open-meteo.com"); assert.equal(url.searchParams.get("forecast_days"), "7");
  assert.equal(url.searchParams.get("timeformat"), "unixtime"); assert.equal(url.searchParams.get("wind_speed_unit"), "ms");
  const next = await loadWeather(point, signal, start + WEATHER_TTL);
  assert.notEqual(next, first); assert.equal(urls.length, 2);
  for (let index = 0; index < 4; index++) await loadWeather({ latitude: 33, longitude: index }, signal, start + WEATHER_TTL);
  await loadWeather(point, signal, start + WEATHER_TTL + 1); assert.equal(urls.length, 7);
});

test("天气取消后不写入缓存，失败和限流可以重试", async t => {
  const point = { latitude: 32, longitude: 120 }, controller = new AbortController();
  let finish, count = 0;
  t.mock.method(globalThis, "fetch", async () => { count++; return await new Promise(resolve => { finish = resolve; }); });
  const request = loadWeather(point, controller.signal, start);
  controller.abort(); finish(Response.json(weatherResponse()));
  await assert.rejects(request, { name: "AbortError" });
  t.mock.method(globalThis, "fetch", async () => { count++; return new Response("", { status: 429 }); });
  await assert.rejects(loadWeather(point, new AbortController().signal, start), /受限/);
  t.mock.method(globalThis, "fetch", async () => { count++; return Response.json(weatherResponse()); });
  await loadWeather(point, new AbortController().signal, start); assert.equal(count, 3);
});

test("云层透过有界且随覆盖单调变化，视角无关的方向与时间保持连续", () => {
  const weather = sample(), point = { latitude: 35, longitude: 139 };
  for (let azimuth = 0; azimuth < 360; azimuth += 15) for (const height of [1, 10, 45, 90]) {
    const ray = direction(azimuth, height);
    let previous = -1;
    for (const amount of [0, 0.2, 0.5, 0.8, 1]) {
      const opacity = cloudOpacity(ray, weatherClouds({ ...weather, low: amount, mid: amount, high: amount }, point));
      assert.ok(opacity >= previous && opacity >= 0 && opacity <= 1); previous = opacity;
      if (amount === 0) assert.equal(opacity, 0);
      if (amount === 1) assert.ok(opacity > 0.999);
    }
    const clouds = weatherClouds(weather, point), moved = weatherClouds({ ...weather, time: weather.time + 1000 }, point);
    assert.ok(Math.abs(cloudOpacity(ray, clouds) - cloudOpacity(ray, moved)) < 0.005);
  }
  const clouds = weatherClouds(weather, point);
  assert.equal(cloudOpacity(direction(0, -1), clouds), cloudOpacity(direction(0, 0), clouds));
  assert.equal(cloudOpacity(direction(90, 30)), 0);
});

test("高处机位的远云在地平线收敛为平均覆盖，原限幅角度两侧连续", () => {
  const weather = { ...sample(), time: Date.parse('2026-11-06T21:29Z'), low: 0.55, mid: 0.18, high: 0 };
  const clouds = weatherClouds(weather, { latitude: 39.8206, longitude: 141.5275 });
  const mean = 1 - (1 - 0.55 * 0.99) * (1 - 0.18 * 0.94);
  const cutoff = Math.asin(0.12) * 180 / Math.PI;
  for (let azimuth = 0; azimuth < 360; azimuth += 5) {
    for (const elevation of [-2, -0.001, 0])
      assert.ok(Math.abs(cloudOpacity(direction(azimuth, elevation), clouds) - mean) < 1e-12);
    assert.ok(Math.abs(cloudOpacity(direction(azimuth, 0.01), clouds) - mean) < 0.00001);
    for (const elevation of [0, cutoff]) {
      const before = cloudOpacity(direction(azimuth, elevation - 0.000001), clouds);
      const after = cloudOpacity(direction(azimuth, elevation + 0.000001), clouds);
      assert.ok(Math.abs(after - before) < 0.0001);
    }
  }
  const row = elevation => Array.from({ length: 360 }, (_, azimuth) => cloudOpacity(direction(azimuth, elevation), clouds));
  const range = values => Math.max(...values) - Math.min(...values);
  assert.ok(range(row(0.1)) < 0.001, 'distant horizon must not retain contrasty vertical cloud columns');
  assert.ok(range(row(10)) > 0.1, 'resolved clouds retain structure above the horizon');
});

test("阴天减弱坡面直射，能见度影响雾混合，天气关闭精确恢复", () => {
  const sun = { elevation: 35, azimuth: 90 }, moon = { elevation: -10, illuminatedFraction: 0.5 };
  const clear = environmentForSky(sun, moon), cloudy = environmentForSky(sun, moon, 0, { ...sample(), cloud: 1, visibility: 500 });
  assert.ok(cloudy.shading["hillshade-exaggeration"] < clear.shading["hillshade-exaggeration"]);
  assert.ok(cloudy.sky["horizon-fog-blend"] > clear.sky["horizon-fog-blend"]);
  assert.deepEqual(environmentForSky(sun, moon, 0, undefined), clear);
});
