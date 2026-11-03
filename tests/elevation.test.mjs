import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/domain/plan.ts";
import { groundElevation } from "../src/preview/elevation.ts";

function imageEnvironment(t, { transparent = false } = {}) {
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  for (let index = 0; index < pixels.length; index += 4)
    pixels.set([131, 232, 0, transparent ? 0 : 255], index);
  let closed = 0;
  const originals = ["document", "createImageBitmap"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: pixels }),
        }),
      }),
    },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({
      width: 512,
      height: 512,
      close() {
        closed++;
      },
    }),
  });
  t.after(() => {
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    }
  });
  return { closed: () => closed };
}
function metadata(id, encoding = "terrarium") {
  return {
    encoding,
    scheme: "xyz",
    tiles: [`https://terrain.test/${id}/{z}/{x}/{y}.webp`],
    bounds: [-180, -85.05, 180, 85.05],
  };
}

test("机位高程读取并缓存解码瓦片，释放位图资源", async (t) => {
  const image = imageEnvironment(t),
    urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return url.endsWith(".json")
      ? Response.json(metadata("cache"))
      : new Response(new Blob([new Uint8Array([1])]));
  });
  const signal = new AbortController().signal;
  const first = await groundElevation(
    initialPlan,
    "https://terrain.test/cache.json",
    signal,
  );
  const second = await groundElevation(
    initialPlan,
    "https://terrain.test/cache.json",
    signal,
  );
  assert.ok(Math.abs(first.height - 1000) < 1e-8);
  assert.deepEqual(second, first);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes("/12/"));
  assert.equal(image.closed(), 1);
});

test("地形请求已取消时不发出请求，覆盖外和编码错误不会伪造高程", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const fetch = t.mock.method(globalThis, "fetch", async (url) =>
    Response.json(
      metadata(
        url.includes("wrong") ? "wrong" : "bounds",
        url.includes("wrong") ? "mapbox" : "terrarium",
      ),
    ),
  );
  await assert.rejects(
    groundElevation(
      initialPlan,
      "https://terrain.test/canceled.json",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(
    groundElevation(
      initialPlan,
      "https://terrain.test/wrong.json",
      new AbortController().signal,
    ),
    /Terrarium/,
  );
  await assert.rejects(
    groundElevation(
      { longitude: 0, latitude: 89 },
      "https://terrain.test/bounds.json",
      new AbortController().signal,
    ),
    /覆盖范围/,
  );
});

test("元数据返回后检查取消状态，不继续解码过期机位", async (t) => {
  let resolveMetadata;
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
  );
  const controller = new AbortController();
  const result = groundElevation(
    initialPlan,
    "https://terrain.test/inflight.json",
    controller.signal,
  );
  controller.abort();
  resolveMetadata(Response.json(metadata("inflight")));
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("透明高程不作为海平面，失败瓦片可在重试时重新下载", async (t) => {
  imageEnvironment(t, { transparent: true });
  const fetch = t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith(".json")
      ? Response.json(metadata("missing"))
      : new Response(new Blob([new Uint8Array([1])])),
  );
  const signal = new AbortController().signal;
  await assert.rejects(
    groundElevation(initialPlan, "https://terrain.test/missing.json", signal),
    /缺失/,
  );
  await assert.rejects(
    groundElevation(initialPlan, "https://terrain.test/missing.json", signal),
    /缺失/,
  );
  assert.equal(fetch.mock.callCount(), 3);
});
