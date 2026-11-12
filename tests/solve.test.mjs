import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  SOLVE_FORMAT, SOLVE_VERSION, frameOfRequest, parseSolve, parseSolveText, solveJson, solveLink, solvePlan, solveRequestOf, solveStart,
} from "../src/domain/solve.ts";
import { describeSolve, positionRows, rangeRows, solveReport, timeRows, REPORT_ROWS } from "../src/domain/solve-report.ts";
import { initialPlan, localDateTime } from "../src/domain/plan.ts";
import { parseShotText, shotFromPlan, shotJson, shotLink, SHARE_PREFIX } from "../src/domain/shot.ts";
import { PUBLIC_SITE, siteBase } from "../src/domain/site.ts";
import { landmarks } from "../src/domain/landmarks.ts";

const base = { format: SOLVE_FORMAT, version: SOLVE_VERSION };
const skytree = landmarks.find((landmark) => landmark.id === "tokyo-skytree");
const time = { ...base, kind: "time", body: "moon", mark: { azimuth: 244.6, elevation: 10.7 }, camera: { latitude: 35.4172, longitude: 138.8729, heightAboveGround: 1.6 },
  date: "2026-11-12", days: 365, timeZone: "Asia/Tokyo", tolerance: 0.25, phase: [0.9, 1], sky: ["blue", "night"] };
const position = { ...base, kind: "position", body: "sun", target: { landmark: "tokyo-skytree" }, date: "2026-12-21", timeZone: "Asia/Tokyo", maxDistance: 20000 };
const range = { ...base, name: "富士山顶", kind: "range", body: "sun", target: { latitude: 35.3606, longitude: 138.7274, height: 0, name: "富士山顶" },
  date: "2027-01-01", days: 90, timeZone: "Asia/Tokyo", share: 0.25, maxDistance: 30000 };
const errorsOf = (value) => {
  const parsed = parseSolve(value);
  assert.equal(parsed.ok, false, "expected errors");
  return parsed.errors.join("\n");
};

test("推算请求：三种求法读出并往返 JSON 与链接，地标目标按目录补齐坐标与高度", () => {
  for (const value of [time, position, range]) {
    const parsed = parseSolve(value);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    const again = parseSolve(JSON.parse(solveJson(parsed.request)));
    assert.deepEqual(again.request, parsed.request, `${value.kind} JSON round trip`);
    const link = solveLink(parsed.request, PUBLIC_SITE);
    assert.ok(link.startsWith(`${PUBLIC_SITE}#solve=json:%7B`));
    assert.deepEqual(parseSolveText(link).request, parsed.request, `${value.kind} link round trip`);
    // `$schema` is written first and ignored on reading; code fences are accepted.
    const withSchema = solveJson(parsed.request, `${PUBLIC_SITE}solve.schema.json`);
    assert.equal(Object.keys(JSON.parse(withSchema))[0], "$schema");
    assert.deepEqual(parseSolveText("```json\n" + withSchema + "\n```").request, parsed.request);
  }
  const landmark = parseSolve(position);
  assert.equal(landmark.landmark, true);
  assert.deepEqual(landmark.request.target, { landmark: "tokyo-skytree", latitude: skytree.latitude, longitude: skytree.longitude, height: skytree.bounds.height, name: skytree.name });
  // The landmark is written by its id only; a lower height is kept.
  assert.deepEqual(JSON.parse(solveJson(parseSolve({ ...position, target: { landmark: "tokyo-skytree", height: 450 } }).request)).target, { landmark: "tokyo-skytree", height: 450 });
  const placed = parseSolve(range);
  assert.equal(placed.landmark, false);
  assert.equal(placed.request.name, "富士山顶");
  // Raw (unencoded) JSON after #solve= reads too, as an AI might write it.
  assert.equal(parseSolveText(`https://example.org/#solve=json:${JSON.stringify(time)}`).ok, true);
});

test("推算请求：缺省项给默认值并列出，经度与方位取模，月亮条件只用于月亮", () => {
  const minimal = parseSolve({ ...base, kind: "time", body: "sun", mark: { azimuth: -15, elevation: 3 } });
  assert.equal(minimal.ok, true);
  assert.deepEqual(minimal.defaults, ["camera", "date", "days", "tolerance", "timeZone"]);
  assert.equal(minimal.request.mark.azimuth, 345);
  assert.equal(minimal.request.days, 365);
  assert.equal(minimal.request.tolerance, 0.25);
  const target = parseSolve({ ...base, kind: "range", body: "moon", target: { latitude: 10, longitude: 190 } });
  assert.deepEqual(target.defaults, ["target.height", "date", "days", "maxDistance", "share", "timeZone"]);
  assert.deepEqual(target.request.target, { latitude: 10, longitude: -170, height: 0, name: "链接中的目标" });
  assert.equal(target.request.share, 0.3);
  assert.equal(target.request.days, 30);
  assert.equal(parseSolve({ ...base, kind: "position", body: "moon", target: { landmark: "tokyo-tower" } }).request.maxDistance, 30000);
  assert.equal(parseSolve({ ...time, timeZone: "asia/tokyo" }).request.timeZone, "Asia/Tokyo");
});

test("推算请求：错误一次列全并带字段路径，高版本拒绝", () => {
  assert.match(errorsOf({ ...time, extra: 1 }), /extra：未知字段/);
  assert.match(errorsOf({ ...time, target: { landmark: "tokyo-skytree" } }), /target：kind 为 "time" 时不使用该字段/);
  assert.match(errorsOf({ ...position, mark: { azimuth: 1, elevation: 2 }, days: 7 }), /mark：kind 为 "position" 时不使用该字段[\s\S]*days：kind 为 "position" 时不使用该字段/);
  assert.match(errorsOf({ ...base, kind: "time", body: "sun" }), /mark：找时间需要/);
  assert.match(errorsOf({ ...base, kind: "range", body: "sun" }), /target：需要地面目标/);
  assert.match(errorsOf({ ...position, target: { landmark: "tokyo-skytree", latitude: 1, longitude: 2 } }), /landmark 与 latitude\/longitude 只能二选一/);
  assert.match(errorsOf({ ...position, target: { landmark: "fuji" } }), /target.landmark：未知地标 "fuji"，可用：.*tokyo-skytree/);
  assert.match(errorsOf({ ...range, target: { latitude: 95, longitude: 0, height: 2000 } }), /target.height：应在 0～1000 之间[\s\S]*target.latitude：应在 -90～90 之间/);
  assert.match(errorsOf({ ...time, mark: { azimuth: "西南", elevation: 95 } }), /mark.azimuth：应为数字，收到 "西南"[\s\S]*mark.elevation：应在 -0.25～89 之间/);
  assert.match(errorsOf({ ...time, days: 30, tolerance: 0.3 }), /tolerance：应为 0.1 \/ 0.25 \/ 0.5 \/ 1 之一/);
  assert.match(errorsOf({ ...range, days: 1096 }), /days：应为 7 \/ 30 \/ 90 \/ 365 之一/);
  assert.match(errorsOf({ ...range, share: 0.8 }), /share：应在 0.05～0.5 之间/);
  assert.match(errorsOf({ ...range, phase: [0, 1] }), /phase：只用于月亮/);
  assert.match(errorsOf({ ...time, phase: [1, 0.5] }), /phase：应为 \[下限, 上限\]/);
  assert.match(errorsOf({ ...time, sky: ["night", "night"] }), /sky：应为不重复的/);
  assert.match(errorsOf({ ...time, date: "2026/11/12", timeZone: "Mars/Olympus" }), /date：应为当地日期[\s\S]*timeZone：应为有效的 IANA 时区/);
  assert.match(errorsOf({ ...time, date: "2101-01-01" }), /date：只支持 1900—2100 年/);
  assert.match(errorsOf({ ...time, format: "tamatamatori.shot" }), /format：应为 "tamatamatori.solve"/);
  assert.match(errorsOf({ ...time, name: "名".repeat(41) }), /name：最多 40 字/);
  const newer = parseSolve({ ...time, version: 2 });
  assert.deepEqual(newer, { ok: false, errors: ["version：此推算请求来自更新版本的应用（版本 2），请刷新页面后再打开"] });
  assert.match(parseSolveText("#solve=json:%E0%A4%A").errors[0], /编码无效/);
  assert.match(parseSolveText("x".repeat(17 * 1024)).errors[0], /超过 16 KB/);
  assert.match(parseSolveText("solve please").errors[0], /无法识别/);
});

test("载入请求：找时间转向期望位置并移到给出的机位，找机位把时刻移到当天，时区改为固定；两者都找不改计划", () => {
  const plan = { ...initialPlan, followLocalZone: true };
  const opened = solvePlan(parseSolve(time).request, plan);
  assert.deepEqual({ latitude: opened.latitude, longitude: opened.longitude, cameraHeight: opened.cameraHeight, azimuth: opened.azimuth, pitch: opened.pitch },
    { latitude: 35.4172, longitude: 138.8729, cameraHeight: 1.6, azimuth: 244.6, pitch: 10.7 });
  assert.equal(opened.instant, plan.instant);
  assert.equal(opened.followLocalZone, false);
  assert.equal(solveStart(parseSolve(time).request, opened), "2026-11-12");
  // Without a camera, the date falls back to the shooting date in the plan's own zone.
  const loose = parseSolve({ ...base, kind: "time", body: "sun", mark: { azimuth: 10, elevation: 5 } }).request;
  assert.equal(solveStart(loose, plan), localDateTime(plan.instant, plan.timeZone).slice(0, 10));
  assert.deepEqual(solvePlan(loose, plan), { ...plan, azimuth: 10, pitch: 5 });
  // 找机位: the clock time stays when the span still starts that day, else noon.
  const day = parseSolve(position).request;
  const kept = solvePlan(day, { ...plan, instant: "2026-11-04T08:00:00Z" });
  assert.equal(localDateTime(kept.instant, "Asia/Tokyo"), "2026-12-21T17:00");
  const night = solvePlan(day, { ...plan, instant: "2026-11-04T20:00:00Z", layers: { ...plan.layers, stars: true } });
  assert.equal(localDateTime(night.instant, "Asia/Tokyo"), "2026-12-21T12:00", "05:00 would belong to the night before");
  const zoned = solvePlan({ ...day, timeZone: "Europe/Paris" }, { ...plan, instant: "2026-11-04T08:00:00Z" });
  assert.equal(zoned.timeZone, "Europe/Paris");
  assert.equal(localDateTime(zoned.instant, "Europe/Paris"), "2026-12-21T09:00");
  const unchanged = solvePlan({ ...parseSolve(range).request, timeZone: undefined }, plan);
  assert.deepEqual(unchanged, plan);
});

test("复制推算请求：面板状态写成自足的请求，读回一致；缺期望位置或目标时为空", () => {
  const state = {
    kind: "range", body: "moon", mark: null, camera: { latitude: 35.4, longitude: 138.8, heightAboveGround: 1.6 },
    target: { id: "tokyo-skytree", latitude: skytree.latitude, longitude: skytree.longitude, height: 634, name: skytree.name },
    date: "2026-11-12", days: 30, timeZone: "Asia/Tokyo", tolerance: 0.25, share: 0.3, maxDistance: 30000, phase: [0.9, 1], sky: ["day", "golden", "blue", "twilight", "night"],
  };
  const request = solveRequestOf(state);
  assert.equal(request.sky, undefined, "all sky conditions are the default");
  assert.deepEqual(request.phase, [0.9, 1]);
  assert.deepEqual(JSON.parse(solveJson(request)).target, { landmark: "tokyo-skytree", height: 634 });
  assert.deepEqual(parseSolveText(solveLink(request, "http://localhost/")).request, request);
  const time = solveRequestOf({ ...state, kind: "time", body: "sun", mark: { azimuth: 244.63, elevation: 10.74 }, days: 365, phase: [0, 1] });
  assert.deepEqual(Object.keys(time), ["format", "version", "name", "kind", "body", "mark", "camera", "date", "timeZone", "days", "tolerance"]);
  assert.equal(JSON.parse(solveJson(time)).name, undefined, "an empty name is not written");
  assert.deepEqual(parseSolve(JSON.parse(solveJson(time))).request, time);
  const placed = solveRequestOf({ ...state, kind: "position", target: { ...state.target, id: undefined, name: "地图上的目标" } });
  assert.deepEqual(placed.target, { latitude: skytree.latitude, longitude: skytree.longitude, height: 634, name: "地图上的目标" });
  assert.equal(placed.days, undefined);
  assert.deepEqual(parseSolve(JSON.parse(solveJson(placed))).request, placed);
  assert.equal(solveRequestOf({ ...state, kind: "time" }), null);
  assert.equal(solveRequestOf({ ...state, target: null }), null);
  // The framing: written from the top-left (0—1) only when it is not the centre; read back to the panel's coordinates.
  assert.equal(request.frame, undefined);
  assert.equal(solveRequestOf({ ...state, frame: { x: 0, y: 0 } }).frame, undefined);
  const framed = solveRequestOf({ ...state, frame: { x: -0.5, y: -1 / 3 } });
  assert.deepEqual(framed.frame, { x: 0.25, y: 0.333 });
  assert.deepEqual(Object.keys(JSON.parse(solveJson(framed))).slice(4, 7), ["target", "frame", "date"]);
  assert.deepEqual(parseSolve(JSON.parse(solveJson(framed))).request, framed);
  const back = frameOfRequest(framed.frame);
  assert.ok(Math.abs(back.x + 0.5) < 1e-9 && Math.abs(back.y + 0.334) < 1e-9);
  assert.deepEqual(frameOfRequest(undefined), { x: 0, y: 0 });
  assert.equal(solveRequestOf({ ...state, kind: "time", mark: { azimuth: 1, elevation: 1 }, frame: { x: 0.5, y: 0.5 } }).frame, undefined, "找时间 has no framing");
});

test("复制结果：Markdown 列出请求、链接与结果表，超过上限只计数，单元格转义竖线", () => {
  const request = parseSolve(time).request;
  const rows = describeSolve(request);
  assert.deepEqual(rows.map((row) => row.label), ["求解", "期望位置", "机位", "日期", "时区", "条件"]);
  assert.match(rows.at(-1).value, /中心偏离 ≤ 0.25 个视直径；亮面 90%—100%；天空：蓝调、暗夜/);
  assert.match(describeSolve(parseSolve(range).request).find((row) => row.label === "目标来源").value, /未核实/);
  assert.match(describeSolve(parseSolve({ ...base, kind: "time", body: "sun", mark: { azimuth: 1, elevation: 1 } }).request).find((row) => row.label === "机位").value, /沿用当前机位/);
  const found = { instant: "2027-02-12T07:22:30Z", from: "2027-02-12T07:22:00Z", to: "2027-02-12T07:23:00Z", separation: 0.05, diameter: 0.5, offset: "偏左|下",
    azimuth: 244.6, elevation: 10.7, illuminated: 0.95, phaseAngle: 20, sunElevation: -10, sky: "night" };
  const table = timeRows({ alignments: [found], filtered: { phase: 0, sky: 0 }, nearest: null, reach: { max: 60, min: -60 }, reason: null }, "Asia/Tokyo");
  const markdown = solveReport({ request, link: "https://example.org/#solve=json:x", timeZone: "Asia/Tokyo", basis: "机位离地 1.6 m。", status: "12 个月内 1 次。", ...table });
  assert.match(markdown, /^## Tamatamatori 推算结果\n\n- 求解：找时间 · 月亮\n/);
  assert.match(markdown, /- 推算请求：https:\/\/example.org\/#solve=json:x/);
  assert.match(markdown, /\| 日期 \| 时刻 \| 容差内 \| 偏离（视直径） \| 方位 \| 视高度 \| 天空 \| 亮面 \|/);
  assert.match(markdown, /\| 2027-02-12 \| 16:22 \| 16:22–16:23 \| 0.10（偏左\\\|下） \| 244.60° \| 10.70° \| 暗夜 \| 95% \|/);
  assert.match(markdown, /时刻按 Asia\/Tokyo。机位离地 1.6 m。\n.*不代表实景一定可见/);
  const many = Array.from({ length: REPORT_ROWS + 5 }, (_, index) => ({ ...found, instant: new Date(Date.parse(found.instant) + index * 86_400_000).toISOString() }));
  const long = solveReport({ request, link: "", timeZone: "UTC", basis: "", status: "", ...timeRows({ ...many.length && { alignments: many }, filtered: { phase: 0, sky: 0 }, nearest: null, reach: { max: 0, min: 0 }, reason: null }, "UTC") });
  assert.match(long, /另有 5 条未列出。/);
  assert.equal(long.split("\n").filter((line) => line.startsWith("| 20")).length, REPORT_ROWS);
  const point = { time: Date.parse("2026-12-21T07:30:00Z"), latitude: 35.6, longitude: 139.7, distance: 12345, azimuth: 61.2, elevation: 3.21, cameraGround: -0.4, residual: 0, sight: "blocked", branch: 0 };
  assert.deepEqual(positionRows([point], "Asia/Tokyo").rows[0], ["2026-12-21 16:30", "12.3", "35.60000, 139.70000", "东北 61.2°", "3.21°", "0 m", "被地形挡住"]);
  const candidate = { key: "a", day: "2026-11-25", points: [point], middle: point, start: point.time, end: point.time + 600_000, near: 2100, far: 2400, share: [0.28, 0.33], sky: "blue", illuminated: 0.99, clear: 0.5 };
  assert.deepEqual(rangeRows([candidate], "Asia/Tokyo").rows[0], ["2026-11-25", "16:30–16:40", "2.10—2.40", "28%—33%", "35.60000, 139.70000", "蓝调", "99%", "50%"]);
});

test("机位链接：分享链接与带 $schema 的 JSON 都能读回同一机位", () => {
  const shot = shotFromPlan({ ...initialPlan, focalLength: 85 }, "富士");
  const site = siteBase({ origin: "https://imanity.github.io" }, "/Tamatamatori/");
  assert.equal(site, PUBLIC_SITE);
  assert.equal(siteBase({ origin: "http://127.0.0.1:5173" }), "http://127.0.0.1:5173/");
  const link = shotLink(shot, site);
  assert.ok(link.startsWith(`${PUBLIC_SITE}#shot=${SHARE_PREFIX}`));
  assert.deepEqual(parseShotText(link).shot, shot);
  const json = shotJson(shot, `${PUBLIC_SITE}shot.schema.json`);
  assert.equal(Object.keys(JSON.parse(json))[0], "$schema");
  assert.deepEqual(parseShotText(json).shot, shot);
  assert.deepEqual(parseShotText(`${PUBLIC_SITE}#shot=json:${encodeURIComponent(json)}`).shot, shot);
});

// A small JSON Schema evaluator covering the keywords the generated schemas use.
function validate(schema, value, path = "") {
  if (schema === true) return [];
  if (schema === false) return [`${path}：不允许`];
  const errors = [];
  const type = (item) => (Array.isArray(item) ? "array" : item === null ? "null" : Number.isInteger(item) ? "integer" : typeof item);
  if (schema.type && !(schema.type === type(value) || (schema.type === "number" && type(value) === "integer"))) return [`${path}：类型应为 ${schema.type}`];
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}：应为 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}：不在枚举中`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}：小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}：大于 ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}：过长`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}：过短`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}：格式不符`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}：项数过少`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}：项数过多`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}：有重复项`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`)));
  }
  if (type(value) === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}：缺少`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && key in schema.properties) errors.push(...validate(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}：未知字段`);
    }
  }
  for (const part of schema.allOf ?? []) errors.push(...validate(part, value, path));
  if (schema.anyOf && !schema.anyOf.some((part) => !validate(part, value, path).length)) errors.push(`${path}：不满足 anyOf`);
  if (schema.oneOf && schema.oneOf.filter((part) => !validate(part, value, path).length).length !== 1) errors.push(`${path}：不满足 oneOf`);
  if (schema.not && !validate(schema.not, value, path).length) errors.push(`${path}：不应匹配 not`);
  if (schema.if) errors.push(...validate(validate(schema.if, value, path).length ? schema.else ?? true : schema.then ?? true, value, path));
  return errors;
}

test("公开格式：生成文件与代码常量一致，schema 接受应用写出的机位与请求并拒绝解析器拒绝的情形", () => {
  const check = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/formats.mjs", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const shotSchema = JSON.parse(readFileSync("public/shot.schema.json", "utf8"));
  const solveSchema = JSON.parse(readFileSync("public/solve.schema.json", "utf8"));
  assert.equal(shotSchema.$id, `${PUBLIC_SITE}shot.schema.json`);
  // Everything the app writes is accepted.
  const custom = shotFromPlan({ ...initialPlan, sensor: "custom", customSensor: { width: 43.8, height: 32.9 }, layers: { ...initialPlan.layers, stars: true, constellations: true } }, "中画幅");
  for (const shot of [shotFromPlan(initialPlan), custom]) assert.deepEqual(validate(shotSchema, JSON.parse(shotJson(shot, shotSchema.$id))), []);
  for (const value of [time, position, range]) assert.deepEqual(validate(solveSchema, JSON.parse(solveJson(parseSolve(value).request, solveSchema.$id))), [], value.kind);
  // The documents' own examples are valid too.
  for (const [file, schema] of [["public/shot-format.md", shotSchema], ["public/solve-format.md", solveSchema]]) {
    // Line endings as checked out (CRLF on Windows with autocrlf).
    const examples = [...readFileSync(file, "utf8").replace(/\r\n/g, "\n").matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
    assert.ok(examples.length >= 1, file);
    for (const example of examples) assert.deepEqual(validate(schema, example), [], file);
  }
  // Cases the parser rejects are rejected by the schema as well.
  const shot = JSON.parse(shotJson(shotFromPlan(initialPlan)));
  for (const broken of [
    { ...shot, extra: 1 },
    { ...shot, layers: { ...shot.layers, constellations: true, stars: false } },
    { ...shot, camera: { ...shot.camera, sensorSize: { width: 30, height: 20 } } },
    { ...shot, camera: { ...shot.camera, sensor: "custom" } },
    { ...shot, position: { ...shot.position, heightAboveGround: 0 } },
    { ...shot, time: { timeZone: "Asia/Tokyo" } },
  ]) assert.ok(validate(shotSchema, broken).length, JSON.stringify(broken).slice(0, 80));
  for (const broken of [
    { ...time, target: { landmark: "tokyo-skytree" } },
    { ...position, days: 7 },
    { ...range, phase: [0, 1] },
    { ...range, days: 1096 },
    { ...position, target: { landmark: "tokyo-skytree", latitude: 1, longitude: 2 } },
    { ...position, target: { landmark: "fuji" } },
    { ...base, kind: "time", body: "sun" },
    { ...time, sky: ["night", "night"] },
  ]) {
    assert.equal(parseSolve(broken).ok, false);
    assert.ok(validate(solveSchema, broken).length, JSON.stringify(broken).slice(0, 80));
  }
  const llms = readFileSync("public/llms.txt", "utf8");
  assert.match(llms, /^# Tamatamatori\n\n> /);
  for (const file of ["shot-format.md", "solve-format.md", "shot.schema.json", "solve.schema.json"]) assert.ok(llms.includes(`${PUBLIC_SITE}${file}`), file);
  const solveDoc = readFileSync("public/solve-format.md", "utf8");
  for (const landmark of landmarks) assert.ok(solveDoc.includes(`\`${landmark.id}\``), landmark.id);
  const html = readFileSync("index.html", "utf8");
  for (const file of ["llms.txt", "shot-format.md", "solve-format.md"]) assert.match(html, new RegExp(`<link rel="alternate" [^>]*href="/${file.replace(".", "\\.")}"`));
});
