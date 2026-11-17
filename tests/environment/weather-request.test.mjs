import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWeather, loadWeatherSource } from '../../src/io/weather.ts';
import { weatherResponse } from '../fixtures/weather.mjs';

const now = Date.UTC(2026, 10, 17);
const flush = async () => { for (let step = 0; step < 12; step++) await Promise.resolve(); };
const signal = () => new AbortController().signal;
function hangingFetch(requestSignal) {
  return new Promise((_, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
}

test('天气网络中断与暂时性 HTTP 错误只自动重试一次，成功后复用缓存', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [index, failure] of [new TypeError('Failed to fetch'), 408, 500, 502, 503, 504].entries()) {
    let calls = 0; const progress = [], point = { latitude: 40, longitude: index };
    t.mock.method(globalThis, 'fetch', async () => {
      if (++calls === 1) { if (typeof failure === 'number') return new Response('', { status: failure }); throw failure; }
      return Response.json(weatherResponse());
    });
    const request = loadWeather(point, signal(), now, 'best_match', (attempt) => progress.push(attempt));
    await flush(); assert.equal(calls, 1); assert.deepEqual(progress, [2]);
    t.mock.timers.tick(999); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(1);
    const result = await request; assert.equal(calls, 2);
    assert.equal(await loadWeather(point, signal(), now), result); assert.equal(calls, 2);
  }
});

test('天气重试耗尽会结束；取消发生在退避等待时不再发送请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('Failed to fetch'); });
  const request = loadWeather({ latitude: 41, longitude: 0 }, signal(), now);
  const rejected = assert.rejects(request, /无法连接 Open-Meteo.*已自动重试/);
  await flush(); t.mock.timers.tick(1000); await rejected; assert.equal(calls, 2);
  const controller = new AbortController();
  const stopped = loadWeather({ latitude: 41, longitude: 1 }, controller.signal, now);
  const cancelled = assert.rejects(stopped, { name: 'AbortError' });
  await flush(); controller.abort(); await cancelled;
  t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 3);
});

test('天气每次连接最多 20 秒，第二次超时后报错；外部取消不当作超时重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { calls++; return hangingFetch(options.signal); });
  const request = loadWeather({ latitude: 42, longitude: 0 }, signal(), now);
  const rejected = assert.rejects(request, /读取超时.*已自动重试/);
  t.mock.timers.tick(20_000); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(20_000); await rejected;
  const controller = new AbortController();
  const cancelled = assert.rejects(loadWeather({ latitude: 42, longitude: 1 }, controller.signal, now), { name: 'AbortError' });
  controller.abort(); await cancelled; t.mock.timers.tick(60_000); assert.equal(calls, 3);
});

test('天气已收到响应头但正文挂起也受超时约束，正文中断后可自动重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++calls > 1) return Response.json(weatherResponse());
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    } }));
  });
  const request = loadWeather({ latitude: 43, longitude: 0 }, signal(), now);
  await flush(); t.mock.timers.tick(20_000); await flush();
  t.mock.timers.tick(1000); await request; assert.equal(calls, 2);
});

test('天气限流、永久 HTTP 错误、非法 JSON 与无效数据不自动重试', async (t) => {
  for (const [index, response] of [new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
    new Response('', { status: 400 }), new Response('{invalid'), Response.json({ hourly: null })].entries()) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return response; });
    await assert.rejects(loadWeather({ latitude: 44, longitude: index }, signal(), now), index === 0 ? /限流.*30 秒/ : undefined);
    assert.equal(calls, 1);
  }
});

test('可选来源识别最多 10 秒且不自动重试，失败不缓存，随后可重新读取', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { calls++; return hangingFetch(options.signal); });
  const point = { latitude: 45, longitude: 0 };
  const failed = assert.rejects(loadWeatherSource(point, signal(), now), /读取超时/);
  t.mock.timers.tick(10_000); await failed;
  t.mock.timers.tick(60_000); assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ hourly: {
    time: [now / 1000], cloud_cover_best_match: [10], cloud_cover_jma_seamless: [10],
  } }); });
  const source = await loadWeatherSource(point, signal(), now);
  assert.deepEqual(source.bestMatch, [10]); assert.equal(calls, 2);
});
