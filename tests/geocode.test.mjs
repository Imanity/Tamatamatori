import test from "node:test";
import assert from "node:assert/strict";
import { parsePlaces, searchPlaces } from "../src/preview/geocode.ts";

test("地点搜索解析结果、跳过无效坐标，保留范围框", () => {
  const places = parsePlaces([
    { lat: "35.3606", lon: "138.7274", name: "富士山", display_name: "富士山, 静冈县, 日本", boundingbox: ["35.35", "35.37", "138.71", "138.74"] },
    { lat: "91", lon: "0", display_name: "无效" },
    { lat: "48.8584", lon: "2.2945", name: "", display_name: "Tour Eiffel, Paris, France" },
  ]);
  assert.equal(places.length, 2);
  assert.deepEqual(places[0], { name: "富士山", detail: "富士山, 静冈县, 日本", latitude: 35.3606, longitude: 138.7274, bounds: [35.35, 35.37, 138.71, 138.74] });
  assert.equal(places[1].name, "Tour Eiffel");
  assert.equal(places[1].bounds, null);
  assert.throws(() => parsePlaces({ error: "x" }));
});

test("地点搜索只在提交时请求：相同查询走缓存，相邻请求至少间隔 1.1 秒，限流单独提示，可取消", async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), at: Date.now() });
    if (String(url).includes("q=blocked")) return new Response("", { status: 429 });
    return new Response(JSON.stringify([{ lat: "1", lon: "2", name: "A", display_name: "A" }]), { status: 200 });
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await searchPlaces("   ", signal), []);
  assert.equal(calls.length, 0);
  await searchPlaces("Mount Fuji", signal);
  await searchPlaces("mount fuji ", signal);
  assert.equal(calls.length, 1, "the same query is answered from the cache");
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://nominatim.openstreetmap.org/search");
  assert.equal(url.searchParams.get("format"), "jsonv2");
  assert.equal(url.searchParams.get("limit"), "8");
  await searchPlaces("Paris", signal);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 1100, `${calls[1].at - calls[0].at} ms apart`);
  await assert.rejects(searchPlaces("blocked", signal), /暂时拒绝请求/);
  const controller = new AbortController();
  const pending = searchPlaces("Tokyo", controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls.some((call) => call.url.includes("Tokyo")), false, "aborted while waiting: never sent");
});

test("定时器比墙上时钟早到时再等一次，相邻请求仍至少间隔 1.1 秒", async (t) => {
  // CI on 2026-11-12 measured 1098 ms: Node timers may fire early by the wall clock.
  const realNow = Date.now, realTimeout = globalThis.setTimeout, realFetch = globalThis.fetch;
  t.after(() => { Date.now = realNow; globalThis.setTimeout = realTimeout; globalThis.fetch = realFetch; });
  let now = realNow() + 3_600_000;
  Date.now = () => now;
  globalThis.setTimeout = (callback, milliseconds) => realTimeout(() => {
    now += milliseconds > 2 ? milliseconds - 2 : milliseconds;
    callback();
  }, 0);
  const sent = [];
  globalThis.fetch = async () => { sent.push(now); return new Response("[]", { status: 200 }); };
  const signal = new AbortController().signal;
  await searchPlaces("early timer one", signal);
  await searchPlaces("early timer two", signal);
  assert.equal(sent.length, 2);
  assert.ok(sent[1] - sent[0] >= 1100, `${sent[1] - sent[0]} ms apart`);
});

test("计时从请求发出算起：第一次请求在取时间与发出之间时钟走了 1 ms，下一次仍至少间隔 1.1 秒", async (t) => {
  // CI on 2026-11-12 (Node 24) measured 1099 ms: the time was taken before the request was built and sent,
  // and the clock moved on while the first one was being built but not while the second was.
  const realNow = Date.now, realTimeout = globalThis.setTimeout, realFetch = globalThis.fetch, realParameters = globalThis.URLSearchParams;
  t.after(() => { Date.now = realNow; globalThis.setTimeout = realTimeout; globalThis.fetch = realFetch; globalThis.URLSearchParams = realParameters; });
  let now = realNow() + 7_200_000, built = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback, milliseconds) => realTimeout(() => {
    now += milliseconds;
    callback();
  }, 0);
  globalThis.URLSearchParams = class extends realParameters {
    constructor(...args) {
      super(...args);
      if (built++ === 0) now += 1;
    }
  };
  const sent = [];
  globalThis.fetch = async () => { sent.push(now); return new Response("[]", { status: 200 }); };
  const signal = new AbortController().signal;
  await searchPlaces("ticking clock one", signal);
  await searchPlaces("ticking clock two", signal);
  assert.equal(sent.length, 2);
  assert.ok(sent[1] - sent[0] >= 1100, `${sent[1] - sent[0]} ms apart`);
});
