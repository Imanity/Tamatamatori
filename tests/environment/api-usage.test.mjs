import test from "node:test";
import assert from "node:assert/strict";
import {
  OPEN_METEO_LIMITS, addUsage, emptyUsage, estimateOpenMeteoCost, rateLimitMessage, readUsage, retryAfterSeconds, usageTotals,
} from "../../src/domain/api-usage.ts";
import { openMeteoUsage, recordOpenMeteo, subscribeUsage } from "../../src/preview/api-usage.ts";

test("Open-Meteo 计费估算与实测响应头一致：天气 1.2、自动匹配来源 1.6、两坐标 2.0、潮汐 13", () => {
  // Measured X-RateLimit-Cost on 2026-11-11.
  assert.equal(estimateOpenMeteoCost({ variables: 12, days: 7 }), 1.2);
  assert.equal(estimateOpenMeteoCost({ models: 16, days: 7 }), 1.6);
  assert.equal(estimateOpenMeteoCost({ locations: 2 }), 2);
  assert.equal(estimateOpenMeteoCost({ locations: 13, days: 3 }), 13);
  // Beyond two weeks or ten variables the cost grows proportionally.
  assert.equal(estimateOpenMeteoCost({ variables: 15, days: 14 }), 1.5);
  assert.equal(estimateOpenMeteoCost({ days: 28 }), 2);
  assert.deepEqual(OPEN_METEO_LIMITS, { minute: 600, hour: 5000, day: 10000 });
});

test("用量窗口：按分钟累加，近 1 分钟、1 小时、24 小时滚动求和，超过一天的记录丢弃", () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 30);
  let log = emptyUsage();
  log = addUsage(log, now - 25 * 3_600_000, 50);
  log = addUsage(log, now - 5 * 3_600_000, 13);
  log = addUsage(log, now - 30 * 60_000, 1.6);
  log = addUsage(log, now - 10_000, 1.2);
  log = addUsage(log, now, 1.2);
  assert.deepEqual(usageTotals(log, now), { minute: 2.4, hour: 4, day: 17 });
  // The 25-hour-old minute was dropped when later costs were added.
  assert.equal(Object.keys(log.buckets).length, 3);
  assert.deepEqual(usageTotals(log, now + 2 * 86_400_000), { minute: 0, hour: 0, day: 0 });
});

test("存储读取只接受合法记录；Retry-After 支持秒数与日期；限流提示", () => {
  assert.deepEqual(readUsage(null), emptyUsage());
  assert.deepEqual(readUsage({ buckets: { 60000: 1.2, x: 3, 120000: -1, 180000: "2" } }), { buckets: { 60000: 1.2 } });
  assert.deepEqual(readUsage({ buckets: {}, server: { remaining: 1 }, limitedUntil: "soon" }), { buckets: {} });
  const now = Date.UTC(2026, 10, 11, 12);
  assert.equal(retryAfterSeconds("30", now), 30);
  assert.equal(retryAfterSeconds(new Date(now + 90_000).toUTCString(), now), 90);
  assert.equal(retryAfterSeconds(null, now), null);
  assert.equal(rateLimitMessage(30), "Open-Meteo 限流：同一 IP 用量已满，约 30 秒后可重试");
  assert.equal(rateLimitMessage(null), "Open-Meteo 限流：同一 IP 用量已满，请稍后重试");
});

test("记录响应：优先用响应头的消耗与本分钟剩余，缺头时用估算；429 记下限流时间，其他失败不计", () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0);
  let notified = 0;
  const stop = subscribeUsage(() => { notified++; });
  const before = usageTotals(openMeteoUsage(), now).day;
  recordOpenMeteo(new Response("{}", { headers: {
    "X-RateLimit-Cost": "1.2", "X-RateLimit-Remaining": "598.8", "X-RateLimit-Limit": "600.0",
    "X-RateLimit-Reset": String(now / 1000 + 60), "X-RateLimit-Window": "60",
  } }), 5, now);
  recordOpenMeteo(new Response("{}"), 13, now + 1000);
  recordOpenMeteo(new Response("{}", { status: 500 }), 13, now + 2000);
  assert.equal(usageTotals(openMeteoUsage(), now + 3000).day - before, 14.2);
  assert.deepEqual(openMeteoUsage().server, { remaining: 598.8, limit: 600, reset: now + 60_000, at: now });
  assert.equal(recordOpenMeteo(new Response("{}", { status: 429, headers: { "Retry-After": "45" } }), 1, now + 3000), 45);
  assert.equal(openMeteoUsage().limitedUntil, now + 48_000);
  // A later success after the wait clears the limit.
  recordOpenMeteo(new Response("{}"), 1, now + 60_000);
  assert.equal(openMeteoUsage().limitedUntil, undefined);
  assert.equal(notified, 4);
  stop();
});
