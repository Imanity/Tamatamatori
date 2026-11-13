import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createServer } from "vite";
import { lightPollutionAtlas as atlas, lightPollutionCells, decodePollutionValue, interpolatePollution } from "../../src/domain/environment/light-pollution.ts";
import { skyAppearance, starOpacity } from "../../src/domain/sky/sky-appearance.ts";
import { environmentForSky } from "../../src/render/scene/environment.ts";

const reference = JSON.parse(readFileSync(new URL("../fixtures/light-pollution-reference.json", import.meta.url), "utf8"));
const tileData = new Map();
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} vs ${b}`);

test("126 份静态分块与 SHA256、尺寸和源格网说明一致", () => {
  assert.equal(atlas.tiles.length, 126);
  assert.equal(atlas.license, "CC BY-NC 4.0");
  assert.equal(atlas.sourceSha256, reference.sourceSha256);
  assert.equal(atlas.encoding.compression, "gzip");
  assert.equal(atlas.width, 14400); assert.equal(atlas.height, 5400);
  let total = 0;
  for (const tile of atlas.tiles) {
    assert.ok(tile.file.endsWith('.bin'));
    const input = readFileSync(new URL(`../../public/${atlas.directory}${tile.file}`, import.meta.url));
    assert.equal(input.length, tile.bytes);
    assert.equal(createHash("sha256").update(input).digest("hex"), tile.sha256);
    const bytes = gunzipSync(input);
    assert.equal(bytes.length, tile.width * tile.height);
    tileData.set(`${tile.x}/${tile.y}`, { tile, bytes });
    total += input.length;
  }
  assert.equal(total, 7830068);
});

test("九处源 TIFF 参考验证像元中心、3×3 平均、量化与双线性插值", () => {
  for (const sample of reference.samples) {
    const cells = lightPollutionCells(sample);
    assert.equal(cells.length, sample.cells.length);
    const result = cells.map((cell, index) => {
      const expected = sample.cells[index];
      assert.equal(cell.x, expected.x); assert.equal(cell.y, expected.y);
      close(cell.weight, expected.weight);
      const { tile, bytes } = tileData.get(`${Math.floor(cell.x / atlas.tileSize)}/${Math.floor(cell.y / atlas.tileSize)}`);
      const code = bytes[(cell.y % atlas.tileSize) * tile.width + cell.x % atlas.tileSize];
      assert.equal(code, expected.code);
      close(decodePollutionValue(code), expected.decodedMcd);
      assert.ok(Math.abs((expected.decodedMcd + .001) / (expected.sourceMeanMcd + .001) - 1) <= Math.expm1(1 / 32) + 1e-12);
      return { code, weight: cell.weight };
    });
    close(interpolatePollution(result).artificialMcd, sample.artificialMcd);
  }
});

test("日期变更线与纬度边界保持连续，缺测和真实零值分别表达", () => {
  assert.equal(lightPollutionCells({ latitude: 75.001, longitude: 0 }), null);
  assert.equal(lightPollutionCells({ latitude: -60, longitude: 0 }), null);
  assert.equal(lightPollutionCells({ latitude: NaN, longitude: 0 }), null);
  assert.deepEqual(lightPollutionCells({ latitude: 20, longitude: -180 }), lightPollutionCells({ latitude: 20, longitude: 180 }));
  close(lightPollutionCells({ latitude: atlas.rasterNorth - 2000.5 * atlas.pixelSize, longitude: atlas.west + atlas.pixelSize / 2 })[0].weight, 1);
  assert.equal(decodePollutionValue(0), null); assert.equal(decodePollutionValue(1), 0);
  assert.equal(interpolatePollution([{ code: 0, weight: .5 }, { code: 1, weight: .5 }]), null);
  assert.deepEqual(interpolatePollution([{ code: 1, weight: 1 }]), { artificialMcd: 0 });
  assert.throws(() => decodePollutionValue(256)); assert.throws(() => decodePollutionValue(1.5));
});

test("人工亮度线性叠加，暗星与银河单调减弱，白昼和地表配色保持既有模型", () => {
  const moon = { elevation: -30, illuminatedFraction: 0 };
  const dark = skyAppearance(-30, moon);
  const city = skyAppearance(-30, moon, 6.5);
  close(city.displayMagnitude, dark.displayMagnitude - 2.5 * Math.log10((.174 + 6.5) / .174));
  let before = dark;
  for (const artificial of [0, .01, .1, 1, 10, 100, 333]) {
    const next = skyAppearance(-30, moon, artificial);
    assert.ok(next.galaxyStrength <= before.galaxyStrength);
    assert.ok(next.pollutionGlow >= before.pollutionGlow);
    for (const magnitude of [-4, 0, 2, 4.5])
      assert.ok(starOpacity({ id: "star", magnitude }, next) <= starOpacity({ id: "star", magnitude }, before));
    before = next;
  }
  assert.equal(starOpacity({ id: "galactic-center", magnitude: 0 }, city), 1);
  const sun = { elevation: -30, azimuth: 200 };
  const base = environmentForSky(sun, moon), polluted = environmentForSky(sun, moon, 6.5);
  assert.notDeepEqual(polluted.sky, base.sky);
  for (const key of ["ground", "water", "landcover", "shading"]) assert.deepEqual(polluted[key], base[key]);
  assert.deepEqual(environmentForSky({ ...sun, elevation: 20 }, moon, 333), environmentForSky({ ...sun, elevation: 20 }, moon));
  assert.throws(() => skyAppearance(-30, moon, -1)); assert.throws(() => skyAppearance(-30, moon, NaN));
});

test("真实分块按需读取、缓存、校验、失败重试与取消，不请求上游", async t => {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const { sampleLightPollution } = await server.ssrLoadModule("/src/io/light-pollution.ts");
  const calls = [];
  let failure = "", pending;
  const responseFor = url => new Response(readFileSync(new URL(`../../public/${url.split("?")[0].slice(1)}`, import.meta.url)));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, signal: options.signal });
    assert.ok(url.startsWith("/light-pollution/atlas-2015/"));
    if (failure === "http") return new Response("missing", { status: 503 });
    if (failure === "short") return new Response(new Uint8Array(2));
    if (failure === "corrupt") {
      const body = new Uint8Array(await responseFor(url).arrayBuffer()); body[20] ^= 1;
      return new Response(body);
    }
    if (failure === "pending") return new Promise(resolve => { pending = () => resolve(responseFor(url)); });
    return responseFor(url);
  });
  const signal = () => new AbortController().signal;
  close((await sampleLightPollution(reference.samples[0], signal())).artificialMcd, reference.samples[0].artificialMcd);
  const count = calls.length;
  await sampleLightPollution(reference.samples[1], signal()); assert.equal(calls.length, count);
  assert.equal(await sampleLightPollution({ latitude: 80, longitude: 0 }, signal()), null); assert.equal(calls.length, count);
  failure = "corrupt"; await assert.rejects(sampleLightPollution(reference.samples[2], signal()), /版本校验/);
  failure = "short"; await assert.rejects(sampleLightPollution(reference.samples[3], signal()), /不完整/);
  const sydney = { latitude: -33.86, longitude: 151.2 };
  failure = "http"; await assert.rejects(sampleLightPollution(sydney, signal()), /503/);
  failure = ""; assert.ok((await sampleLightPollution(sydney, signal())).artificialMcd > 0);
  failure = "pending";
  const controller = new AbortController();
  const delayed = sampleLightPollution({ latitude: -33, longitude: -70 }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); pending();
  await assert.rejects(delayed, { name: "AbortError" });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(sampleLightPollution(sydney, aborted.signal), { name: "AbortError" });
});

test("光污染下的月相、月亮高度和暮光变亮均不会反向增强星空", () => {
  const compare = (next, previous) => {
    assert.ok(next.galaxyStrength <= previous.galaxyStrength + 1e-12);
    assert.ok(next.displayMagnitude <= previous.displayMagnitude + 1e-12);
    for (const magnitude of [-4, 0, 2, 4.5])
      assert.ok(starOpacity({ id: 'star', magnitude }, next) <= starOpacity({ id: 'star', magnitude }, previous) + 1e-12);
  };
  for (const artificial of [.1, 1, 6.5, 100]) {
    let before = skyAppearance(-30, { elevation: 90, illuminatedFraction: 0 }, artificial);
    for (let phase = .01; phase <= 1; phase += .01) {
      const next = skyAppearance(-30, { elevation: 90, illuminatedFraction: phase }, artificial);
      compare(next, before); before = next;
    }
    before = skyAppearance(-30, { elevation: -1, illuminatedFraction: 1 }, artificial);
    for (let elevation = 0; elevation <= 90; elevation += 1) {
      const next = skyAppearance(-30, { elevation, illuminatedFraction: 1 }, artificial);
      compare(next, before); before = next;
    }
    const moon = { elevation: 60, illuminatedFraction: .75 };
    before = skyAppearance(-30, moon, artificial);
    for (let sun = -29.9; sun <= 20; sun += .1) {
      const next = skyAppearance(sun, moon, artificial);
      compare(next, before); before = next;
    }
  }
});
