import test from "node:test";
import assert from "node:assert/strict";
import {
  NoSeaError, distanceKm, parseTides, tideAt, tideCovers, tideDates, tideExtremes, tideHeight, tideNow, tideProbes,
} from "../../src/domain/environment/tides.ts";

const HOUR = 3_600_000;
const within = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} vs ${expected} (±${tolerance})`);
// A synthetic semidiurnal tide (M2 period) sampled hourly like the API.
const PERIOD = 12.4206 * HOUR, AMPLITUDE = 0.8, PHASE = 0.7;
const origin = Date.UTC(2026, 10, 12);
const exact = (time) => AMPLITUDE * Math.sin((2 * Math.PI * (time - origin)) / PERIOD + PHASE);
const response = (latitude, longitude, values) => ({
  latitude, longitude,
  hourly: { time: values.map((_, index) => (origin + index * HOUR) / 1000), sea_level_height_msl: values },
});
const sine = (hours = 72) => Array.from({ length: hours }, (_, index) => Number(exact(origin + index * HOUR).toFixed(2)));

test("潮位探测点：机位与约 12 km、30 km 两圈共 13 点；日期按时段前后各留 3 小时", () => {
  const camera = { latitude: 35.3, longitude: 139.5 }, probes = tideProbes(camera);
  assert.equal(probes.length, 13);
  assert.deepEqual(probes[0], camera);
  for (const probe of probes.slice(1, 7)) within(distanceKm(camera, probe), 12, 0.05);
  for (const probe of probes.slice(7)) within(distanceKm(camera, probe), 30, 0.05);
  assert.deepEqual(tideDates({ start: "2026-11-11T15:00:00Z", end: "2026-11-12T15:00:00Z" }), { start: "2026-11-11", end: "2026-11-12" });
  assert.deepEqual(tideDates({ start: "2026-11-11T01:00:00Z", end: "2026-11-11T22:00:00Z" }), { start: "2026-11-10", end: "2026-11-12" });
});

test("潮位格点：取有数据且离机位最近的格点；全为空时报附近无海洋格点；格式错误报错", () => {
  const camera = { latitude: 35.3, longitude: 139.5 };
  const land = response(35.3, 139.5, Array(72).fill(null));
  const far = response(35.1, 139.5, sine()), near = response(35.25, 139.45, sine());
  const series = parseTides([land, far, near], camera, 1);
  assert.deepEqual([series.cell.latitude, series.cell.longitude], [35.25, 139.45]);
  within(series.cell.distance, distanceKm(camera, { latitude: 35.25, longitude: 139.45 }), 1e-9);
  assert.equal(series.start, origin);
  assert.throws(() => parseTides([land, land], camera, 1), NoSeaError);
  assert.throws(() => parseTides([{ latitude: 1 }], camera, 1), /格式无法识别/);
  assert.throws(() => parseTides({ ...near, hourly: { time: [3600, 7200, 14400], sea_level_height_msl: [0.1, 0.2, 0.3] } }, camera, 1), /逐小时/);
});

test("潮位插值与高低潮：与解析正弦潮对照，高度差 ≤ 2 cm、高低潮时刻差 ≤ 6 分钟", () => {
  const series = parseTides(response(35.25, 139.45, sine()), { latitude: 35.3, longitude: 139.5 }, 1);
  for (let time = origin + HOUR; time < origin + 70 * HOUR; time += 17 * 60_000) {
    const value = tideAt(series, time);
    within(value.height, exact(time), 0.02, "高度");
    const rate = (2 * Math.PI / (PERIOD / HOUR)) * AMPLITUDE * Math.cos((2 * Math.PI * (time - origin)) / PERIOD + PHASE);
    within(value.rate, rate, 0.04, "涨落速率");
  }
  const extremes = tideExtremes(series, origin, origin + 72 * HOUR);
  assert.ok(extremes.length >= 10);
  for (const extreme of extremes) {
    // Analytic extremes: phase = π/2 (high) or 3π/2 (low) modulo 2π.
    const phase = (2 * Math.PI * (extreme.time - origin)) / PERIOD + PHASE;
    const target = extreme.kind === "high" ? Math.PI / 2 : 3 * Math.PI / 2;
    const offset = ((phase - target) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    within(Math.abs(offset) * PERIOD / (2 * Math.PI) / 60_000, 0, 6, "时刻（分钟）");
    within(Math.abs(extreme.height), AMPLITUDE, 0.02, "高低潮");
  }
  assert.ok(extremes.every((entry, index) => index === 0 || entry.kind !== extremes[index - 1].kind));
});

test("此刻与下次：涨落方向、下一次高潮与低潮；空值处不插值、不覆盖", () => {
  const values = sine();
  for (let index = 40; index < 72; index++) values[index] = null;
  const series = parseTides(response(35.25, 139.45, values), { latitude: 35.3, longitude: 139.5 }, 1);
  const at = new Date(origin + 5 * HOUR).toISOString(), now = tideNow(series, at);
  within(now.height, exact(origin + 5 * HOUR), 0.02);
  assert.equal(now.rising, Math.cos((2 * Math.PI * 5 * HOUR) / PERIOD + PHASE) > 0);
  assert.ok(now.nextHigh.time > Date.parse(at) && now.nextLow.time > Date.parse(at));
  assert.equal(tideNow(series, new Date(origin + 45 * HOUR).toISOString()), null);
  assert.equal(tideCovers(series, origin, origin + 30 * HOUR), true);
  assert.equal(tideCovers(series, origin, origin + 50 * HOUR), false);
  assert.equal(tideHeight(0.4249), "+0.42 m");
  assert.equal(tideHeight(-0.6), "−0.60 m");
});
