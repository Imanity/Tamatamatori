import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import encode, { init as initEncode } from "@jsquash/webp/encode.js";
import { decodeTile } from "../scripts/lib/solve-node.mjs";
import { defaultPlan, RESULT_FORMAT, solveCommand } from "../scripts/solve.mjs";
import { parseShotText, shotFromPlan, shotLink } from "../src/domain/shot.ts";
import { initialPlan } from "../src/domain/plan.ts";
import { sampleElevationTile } from "../src/domain/terrain.ts";

const require = createRequire(import.meta.url);
const NOW = Date.parse("2026-11-14T03:00:00Z");
const flat = () => 0;

/** Runs the command with a stand-in for the network: flat terrain, dark skies. */
async function run(argv, { request, terrain = flat, pollution = { artificialMcd: 0.02 }, stdin } = {}) {
  let out = "", err = "";
  const input = request === undefined ? stdin : [JSON.stringify(request)];
  const code = await solveCommand(request === undefined ? argv : [...argv, "-"], {
    stdin: input ?? [],
    stdout: { write: (text) => { out += text; } },
    stderr: { write: (text) => { err += text; } },
    now: () => NOW,
    environment: { terrain: async () => terrain, lightPollution: async () => pollution },
  });
  return { code, out, err, json: () => JSON.parse(out) };
}
const base = { format: "tamatamatori.solve", version: 2 };
const tower = { type: "ground", landmark: "tokyo-skytree" };

test("命令行地形解码：@jsquash/webp 无损编码的 Terrarium 像素经命令行的读取路径解码后完全相同", async () => {
  // Heights −200 … 3800 m in Terrarium (R·256 + G + B/256 − 32768) on a 512 px tile.
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const height = -200 + (x * 512 + y) * (4000 / (512 * 512)), value = height + 32768;
      const index = (y * 512 + x) * 4;
      pixels[index] = Math.floor(value / 256);
      pixels[index + 1] = Math.floor(value) % 256;
      pixels[index + 2] = Math.round((value - Math.floor(value)) * 256) % 256;
      pixels[index + 3] = 255;
    }
  await initEncode(await WebAssembly.compile(await readFile(require.resolve("@jsquash/webp/codec/enc/webp_enc_simd.wasm"))));
  const webp = await encode({ data: pixels, width: 512, height: 512 }, { lossless: 1, exact: 1 });
  const decoded = await decodeTile(new Blob([webp]));
  assert.deepEqual([decoded.width, decoded.height], [512, 512]);
  assert.ok(decoded.pixels.every((value, index) => value === pixels[index]), "every byte the same");
  assert.ok(Math.abs(sampleElevationTile(decoded, 0, 0) + 200) < 0.01);
  await assert.rejects(decodeTile(new Blob([new Uint8Array([1, 2, 3])])), /地形瓦片图像无法解码/);
});

test("命令行：机位线的结果带试看链接，链接打开的机位与时刻就是结果；缺省值逐项列出", async () => {
  const request = { ...base, name: "月亮落在塔尖", targets: [{ ...tower, frame: { x: 0.5, y: 0.35 } }, { type: "body", body: "moon", frame: { x: 0.5, y: 0.35 } }],
    camera: { mode: "free", maxDistance: 30000 }, time: { mode: "range", date: "2026-11-25", days: 1 }, timeZone: "Asia/Tokyo" };
  const { code, json, err } = await run(["--site", "https://example.org/app"], { request });
  assert.equal(code, 0, err);
  const result = json();
  assert.equal(result.format, RESULT_FORMAT);
  assert.equal(result.version, 1);
  assert.equal(result.solvable.shape, "lines");
  assert.match(result.requestLink, /^https:\/\/example\.org\/app\/#solve=json:/);
  assert.deepEqual(result.defaults, ["镜头：24 mm · 全画幅 · 3:2 横幅（命令行缺省）", "离地高度：1.6 m（命令行缺省）", "大气折射：标准（命令行缺省）"]);
  assert.deepEqual(result.plan.lens, { focalLength: 24, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" });
  assert.ok(result.results.length > 0 && result.counts.results === result.results.length);
  for (const item of result.results) {
    assert.match(item.best.local, /^2026-11-2[56] \d\d:\d\d$/);
    assert.equal(item.target.name, "晴空塔");
    const opened = parseShotText(item.link);
    assert.equal(opened.ok, true);
    assert.equal(opened.plan.instant, item.best.utc);
    assert.equal(opened.plan.latitude, item.camera.latitude);
    assert.equal(opened.plan.longitude, item.camera.longitude);
    assert.equal(opened.plan.focalLength, 24);
    assert.equal(opened.plan.layers.moon, true);
  }
  assert.match(result.sources[0], /^地形：Mapterhorn/);
  // The same search as Markdown.
  const markdown = await run(["--format", "markdown"], { request });
  assert.equal(markdown.code, 0);
  assert.match(markdown.out, /^## Tamatamatori 推算结果/);
  assert.match(markdown.out, /\| 日期 \| 时段 \| 机位（试看处） \|/);
  assert.match(markdown.out, /用命令行在本机计算/);
});

test("命令行：固定机位、两个天体与两个地面点各给出结果；--shot 作为当前计划", async () => {
  // A fixed camera and direction: the Sun through the frame centre.
  const fixed = await run([], { request: { ...base, targets: [{ type: "body", body: "sun" }], camera: { mode: "fixed", latitude: 35.4, longitude: 138.8, aim: { azimuth: 244.63, pitch: 10.74 } },
    time: { mode: "range", date: "2026-11-04", days: 365 }, timeZone: "Asia/Tokyo" } });
  assert.equal(fixed.code, 0, fixed.err);
  const windows = fixed.json();
  assert.equal(windows.solvable.shape, "windows");
  assert.ok(windows.results.length >= 1);
  assert.ok(windows.results.every((item) => item.start.utc <= item.best.utc && item.best.utc <= item.end.utc && item.aim.azimuth === 244.63));
  assert.equal(windows.sources.some((line) => /Mapterhorn/.test(line)), false, "no terrain read");
  // Two bodies.
  const pair = await run([], { request: { ...base, lens: { focalLength: 135, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" },
    targets: [{ type: "body", body: "dso-mel022", frame: { x: 0.6, y: 0.4 } }, { type: "body", body: "moon", frame: { x: 0.4, y: 0.6 }, tolerance: 0.05 }],
    time: { mode: "range", date: "2026-11-13", days: 365 }, timeZone: "Asia/Tokyo" } });
  assert.equal(pair.code, 0, pair.err);
  assert.equal(pair.json().solvable.shape, "windows");
  // Two ground points: places, not times.
  const places = await run([], { request: { ...base, lens: { focalLength: 50, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" },
    targets: [{ type: "ground", latitude: 35.70, longitude: 139.80, height: 600, name: "东塔", frame: { x: 0.4, y: 0.3 } },
      { type: "ground", latitude: 35.70, longitude: 139.745, height: 300, name: "西塔", frame: { x: 0.65, y: 0.55 } }],
    camera: { mode: "free", maxDistance: 30000, minDistance: 200 } } });
  assert.equal(places.code, 0, places.err);
  const found = places.json();
  assert.equal(found.solvable.shape, "places");
  assert.equal(found.results.length, 1);
  const place = found.results[0];
  assert.equal(place.timeless, true);
  assert.equal(place.start, undefined);
  assert.deepEqual([place.place.first.name, place.place.second.name], ["东塔", "西塔"]);
  assert.equal(parseShotText(place.link).plan.instant, defaultPlan(NOW).instant, "a place keeps the plan's time");
  // --shot: the lens, height and time come from that shot.
  const shot = shotLink(shotFromPlan({ ...initialPlan, focalLength: 85, cameraHeight: 30 }, "当前"), "https://example.org/");
  const opened = await run(["--shot", shot], { request: { ...base, targets: [{ ...tower, frame: { x: 0.5, y: 0.35 } }, { type: "body", body: "moon", frame: { x: 0.5, y: 0.35 } }],
    time: { mode: "range", date: "2026-11-25", days: 1 } } });
  assert.equal(opened.code, 0, opened.err);
  const fromShot = opened.json();
  assert.equal(fromShot.plan.lens.focalLength, 85);
  assert.equal(fromShot.plan.cameraHeight, 30);
  assert.ok(fromShot.defaults.includes("镜头：85 mm · 全画幅 · 3:2 横幅（取自 --shot 的机位）"), fromShot.defaults.join());
});

test("命令行：无效请求退出码 2 并列出问题，不能搜索的请求退出码 3，参数错误也说明用法", async () => {
  const invalid = await run([], { request: { ...base, targets: [{ type: "body", body: "pluto" }] } });
  assert.equal(invalid.code, 2);
  assert.match(invalid.err, /推算请求无效：\n- targets\[0\]\.body：应为/);
  assert.equal(invalid.out, "");
  const alone = await run([], { request: { ...base, targets: [tower] } });
  assert.equal(alone.code, 3);
  assert.match(alone.err, /不能搜索：只有一个地面点/);
  const badFormat = await run(["--format", "xml", "-"], {});
  assert.equal(badFormat.code, 2);
  assert.match(badFormat.err, /--format 应为 json 或 markdown\n用法：npm run solve --/);
  const help = await run(["--help"], {});
  assert.equal(help.code, 0);
  assert.match(help.out, /^用法：/);
  // A link works as well as JSON, from standard input.
  const link = `https://example.org/#solve=json:${encodeURIComponent(JSON.stringify({ ...base, targets: [tower, { type: "body", body: "moon" }], time: { mode: "range", date: "2026-11-25", days: 1 } }))}`;
  const fromLink = await run(["-"], { stdin: [link] });
  assert.equal(fromLink.code, 0, fromLink.err);
  assert.equal(fromLink.json().solvable.shape, "lines");
});
