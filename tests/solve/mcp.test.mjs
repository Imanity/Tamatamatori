import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, PROTOCOL_VERSIONS, TOOLS } from "../../scripts/mcp.mjs";
import { solveCommand } from "../../scripts/solve.mjs";
import { parseShotText, shotFromPlan, shotLink } from "../../src/domain/shots/shot.ts";
import { initialPlan } from "../../src/domain/core/plan.ts";

const NOW = Date.parse("2026-11-14T03:00:00Z");
const flat = { terrain: async () => () => 0, lightPollution: async () => ({ artificialMcd: 0.02 }) };
const base = { format: "tamatamatori.solve", version: 2 };
const tower = { type: "ground", landmark: "tokyo-skytree" };
const moonOnTower = { ...base, name: "月亮落在塔尖", targets: [{ ...tower, frame: { x: 0.5, y: 0.35 } }, { type: "body", body: "moon", frame: { x: 0.5, y: 0.35 } }],
  camera: { mode: "free", maxDistance: 30000 }, time: { mode: "range", date: "2026-11-25", days: 1 }, timeZone: "Asia/Tokyo" };

/** A server on a stand-in for the network, and the messages it sent. */
function harness(environment = flat) {
  const sent = [];
  const server = createServer({ write: (line) => sent.push(JSON.parse(line)), environment, now: () => NOW, site: "https://example.org/app/" });
  let next = 0;
  const call = async (method, params) => {
    const id = ++next;
    await server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    return sent.find((message) => message.id === id);
  };
  const tool = async (name, args, meta) => (await call("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result;
  return { server, sent, call, tool };
}

test("MCP：握手协商协议版本，列出三个工具，ping；未知方法、坏 JSON、无效消息与未知工具按协议报错", async () => {
  const { server, sent, call } = harness();
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "tamatamatori");
  assert.match(init.result.instructions, /describe_format[\s\S]*validate_request[\s\S]*solve[\s\S]*#shot=/);
  // A version the server does not know gets the newest it speaks.
  assert.equal((await call("initialize", { protocolVersion: "2099-01-01" })).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  await server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.deepEqual((await call("ping")).result, {});
  const tools = (await call("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["solve", "validate_request", "describe_format"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 20 && tool.annotations.readOnlyHint);
  }
  assert.deepEqual(TOOLS.find((tool) => tool.name === "solve").inputSchema.required, ["request"]);
  assert.equal((await call("resources/list")).error.code, -32601);
  assert.equal((await call("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  const count = sent.length;
  await server.receive("{not json");
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "无法解析 JSON" } });
  await server.receive(JSON.stringify({ id: 9, method: "ping" }));
  assert.equal(sent.at(-1).error.code, -32600);
  // Batches (older protocol versions) are answered one by one; responses to us are ignored.
  await server.receive(JSON.stringify([{ jsonrpc: "2.0", id: 20, method: "ping" }, { jsonrpc: "2.0", id: 21, result: {} }]));
  assert.deepEqual(sent.slice(count + 2).map((message) => message.id), [20]);
});

test("MCP 校验：规范化请求、链接、描述与缺省；无效请求列出字段路径；只有一个地面点说明不能搜索；坏的 shot 为工具错误", async () => {
  const { tool } = harness();
  const ok = await tool("validate_request", { request: moonOnTower });
  assert.equal(ok.isError, undefined);
  const value = ok.structuredContent;
  assert.equal(value.ok, true);
  assert.equal(value.canSearch, true);
  assert.equal(value.solvable.shape, "lines");
  assert.match(value.requestLink, /^https:\/\/example\.org\/app\/#solve=json:/);
  assert.ok(value.defaults.includes("镜头：24 mm · 全画幅 · 3:2 横幅（工具缺省）"), value.defaults.join());
  assert.equal(value.request.targets[0].landmark, "tokyo-skytree");
  assert.deepEqual(JSON.parse(ok.content[0].text), value, "the text mirrors the structured content");
  // A #solve= link works as well as the object.
  assert.equal((await tool("validate_request", { request: value.requestLink })).structuredContent.canSearch, true);
  const invalid = (await tool("validate_request", { request: { ...base, targets: [{ type: "body", body: "pluto" }] } })).structuredContent;
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /targets\[0\]\.body：应为/);
  const alone = (await tool("validate_request", { request: { ...base, targets: [tower] } })).structuredContent;
  assert.equal(alone.canSearch, false);
  assert.match(alone.solvable.message, /只有一个地面点/);
  const badShot = await tool("validate_request", { request: moonOnTower, shot: "tmt1:not-a-shot" });
  assert.equal(badShot.isError, true);
  assert.match(badShot.content[0].text, /^shot 无效/);
  // The shot's lens and height become the plan.
  const shot = shotLink(shotFromPlan({ ...initialPlan, focalLength: 85, cameraHeight: 30 }, "当前"), "https://example.org/");
  assert.ok((await tool("validate_request", { request: { ...moonOnTower }, shot })).structuredContent.defaults.some((line) => line.includes("85 mm") && line.includes("取自 shot 参数的机位")));
  assert.equal((await tool("validate_request", {})).isError, true);
});

test("MCP 推算：结果与命令行相同，带试看链接；maxResults 截断并计数；无效与不能搜索为工具错误", async () => {
  const { tool } = harness();
  const result = await tool("solve", { request: moonOnTower });
  assert.equal(result.isError, undefined);
  const value = result.structuredContent;
  assert.equal(value.format, "tamatamatori.solve-result");
  assert.ok(value.results.length > 1 && value.counts.results === value.results.length);
  assert.equal(value.truncated, undefined);
  for (const item of value.results) {
    const opened = parseShotText(item.link);
    assert.equal(opened.ok, true);
    assert.equal(opened.plan.instant, item.best.utc);
    assert.equal(opened.plan.latitude, item.camera.latitude);
  }
  // The same search on the command line gives the same results.
  let out = "";
  const code = await solveCommand(["--site", "https://example.org/app/", "-"], {
    stdin: [JSON.stringify(moonOnTower)], stdout: { write: (text) => { out += text; } }, stderr: { write() {} }, now: () => NOW, environment: flat,
  });
  assert.equal(code, 0);
  const cli = JSON.parse(out);
  assert.deepEqual(value.results, cli.results);
  assert.deepEqual(value.counts, cli.counts);
  assert.deepEqual(value.request, cli.request);
  // Only the first results are listed; the counts keep the total.
  const one = (await tool("solve", { request: moonOnTower, maxResults: 1 })).structuredContent;
  assert.equal(one.results.length, 1);
  assert.deepEqual(one.truncated, { shown: 1, total: value.results.length });
  assert.equal(one.counts.results, value.results.length);
  assert.equal((await tool("solve", { request: moonOnTower, maxResults: 0 })).isError, true);
  const invalid = await tool("solve", { request: { ...base, targets: [{ type: "body", body: "pluto" }] } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /^推算请求无效：\n- targets\[0\]\.body/);
  const alone = await tool("solve", { request: { ...base, targets: [tower] } });
  assert.match(alone.content[0].text, /^不能搜索：只有一个地面点/);
  // A search that fails says why.
  const broken = await harness({ ...flat, terrain: async () => { throw new Error("地形读取失败"); } }).tool("solve", { request: moonOnTower });
  assert.equal(broken.isError, true);
  assert.match(broken.content[0].text, /^搜索失败：地形读取失败/);
});

test("MCP 说明格式：推算请求与机位的说明与 schema；进度通知按 progressToken 发出，取消的推算不再回应", async () => {
  const { tool } = harness();
  assert.match((await tool("describe_format", {})).content[0].text, /^# Tamatamatori 推算请求格式 v2/);
  assert.match((await tool("describe_format", { format: "shot" })).content[0].text, /^# Tamatamatori 机位格式/);
  assert.equal(JSON.parse((await tool("describe_format", { schema: true })).content[0].text).$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal((await tool("describe_format", { format: "xml" })).isError, true);
  // Terrain that waits until the search is cancelled.
  const waiting = harness({ ...flat, terrain: (points, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  const pending = waiting.server.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "solve", arguments: { request: moonOnTower }, _meta: { progressToken: "p1" } } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const progress = waiting.sent.filter((message) => message.method === "notifications/progress");
  assert.ok(progress.length >= 1, "progress before the terrain read");
  assert.equal(progress[0].params.progressToken, "p1");
  assert.match(progress[0].params.message, /读取地形/);
  await waiting.server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "test" } }));
  await pending;
  assert.equal(waiting.sent.some((message) => message.id === 7), false, "no response after cancellation");
});

test("MCP 子进程：经标准输入输出握手、列出工具并校验一次，标准输出只有协议消息", { timeout: 30000 }, async () => {
  const script = fileURLToPath(new URL("../../scripts/mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "validate_request", arguments: { request: moonOnTower } } },
  ];
  child.stdin.write(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const deadline = Date.now() + 20000;
  while (out.split("\n").filter(Boolean).length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const messages = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [1, 2, 3]);
  assert.ok(messages.every((message) => message.jsonrpc === "2.0"));
  assert.equal(messages[0].result.protocolVersion, "2025-03-26");
  assert.equal(messages[1].result.tools.length, 3);
  assert.equal(messages[2].result.structuredContent.canSearch, true);
});
