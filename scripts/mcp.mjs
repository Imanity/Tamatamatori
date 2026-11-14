// 推算 MCP 服务器（AI 第二级，docs/plan/solver-tool.md 第 9 节）：stdio 传输，
// 每行一条 JSON-RPC 2.0 消息。工具：solve（推算）、validate_request（校验请求）、
// describe_format（说明格式）。与命令行共用 lib/solve-run.mjs，结果相同。
//
//   node --experimental-strip-types scripts/mcp.mjs [--site URL] [--terrain TileJSON 地址]
//
// 标准输出只写协议消息；其余（包括 Node 的警告）都在标准错误。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { SHOT_SCHEMA_FILE, SOLVE_SCHEMA_FILE } from '../src/domain/core/site.ts';
import { ROOT } from './lib/solve-node.mjs';
import { DEFAULT_TERRAIN_URL, PUBLIC_SITE, parseShot, prepare, resultObject, search, validation } from './lib/solve-run.mjs';

/** Protocol versions this server speaks, newest first; a client's other version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {
  name: 'tamatamatori',
  title: 'Tamatamatori 推算',
  version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
};
const INSTRUCTIONS = `用 Tamatamatori 的本地求解器推算拍摄机位与时间：先用 describe_format 读推算请求 v2 的格式（目标、画面位置、搜索范围、筛选，以及固定方向天体与地标的 id），写好请求后可先用 validate_request 检查，再用 solve 搜索；结果不理想时放宽容差、日期或距离再算。
- 数值都由求解器计算，不要自己估算方位、高度或时刻。
- 坐标给出的目标未经核实，地标 id 只限格式说明中已接入的。
- 结果是几何对齐：不含天气，遮挡只看地形，不代表一定能拍到。
- 把结果的 link（#shot= 机位链接）交给用户，用户在网页中先预览、确认后才应用；requestLink 打开整个推算条件。`;

const DEFAULT_MAX_RESULTS = 20;
const requestProperty = {
  description: '推算请求 v2：JSON 对象，或它的 JSON 文本、#solve= 链接（v1 也可，会转换）。字段见 describe_format。',
  anyOf: [{ type: 'object' }, { type: 'string' }],
};
const shotProperty = {
  type: 'string',
  description: '可选：作为当前计划的机位链接（#shot=）或机位 JSON 文本，提供请求没写的镜头、离地高度、日期与时区。不给时为 24 mm 全画幅 3:2 横幅、离地 1.6 m、标准折射、今天。',
};
export const TOOLS = [
  {
    name: 'solve',
    title: '推算机位与时间',
    description: '在本机运行 Tamatamatori 的推算（与网页同一求解器）。返回 tamatamatori.solve-result：每个结果的日期与时段（两个地面点时与时间无关）、机位坐标、朝向、离地面目标的方向与距离、偏差、天空与月亮，以及打开该机位试看的 #shot= 链接；另有被地形挡住、被筛掉等计数，数据来源与限制。需要联网读取 Mapterhorn 地形瓦片，长的搜索要十几秒。请求无效或不能搜索时返回原因。',
    inputSchema: {
      type: 'object',
      properties: {
        request: requestProperty,
        shot: shotProperty,
        maxResults: { type: 'integer', minimum: 1, maximum: 200, default: DEFAULT_MAX_RESULTS, description: '最多列出的结果数，缺省 20；其余只计数（truncated）。' },
      },
      required: ['request'],
    },
    annotations: { title: '推算机位与时间', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'validate_request',
    title: '校验推算请求',
    description: '检查推算请求而不搜索，不联网。返回规范化后的请求与它的 #solve= 链接、请求描述、用到的缺省值、能否搜索（不能时说明原因）；请求无效时列出带字段路径的问题。',
    inputSchema: {
      type: 'object',
      properties: { request: requestProperty, shot: shotProperty },
      required: ['request'],
    },
    annotations: { title: '校验推算请求', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'describe_format',
    title: '推算请求格式',
    description: '返回推算请求 v2 的说明（能求出什么、字段、固定方向天体与已接入地标的 id、示例），或机位格式的说明；schema 为 true 时返回 JSON Schema。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['solve', 'shot'], default: 'solve', description: 'solve：推算请求；shot：机位（试看链接的内容）。' },
        schema: { type: 'boolean', default: false, description: '为 true 时返回 JSON Schema，否则返回 Markdown 说明。' },
      },
    },
    annotations: { title: '推算请求格式', readOnlyHint: true, openWorldHint: false },
  },
];
const labels = { fallback: '工具缺省', shot: '取自 shot 参数的机位', shotDate: '取自 shot 参数的日期' };
const formatFiles = {
  solve: { markdown: 'public/solve-format.md', schema: `public/${SOLVE_SCHEMA_FILE}` },
  shot: { markdown: 'public/shot-format.md', schema: `public/${SHOT_SCHEMA_FILE}` },
};

const text = (value) => ({ type: 'text', text: value });
const toolError = (message) => ({ content: [text(message)], isError: true });
const structured = (value) => ({ content: [text(JSON.stringify(value))], structuredContent: value });
const list = (lines) => lines.map((line) => `- ${line}`).join('\n');

/**
 * The server, without the transport: `receive(line)` takes one line from the
 * client and `write(line)` sends one. `environment` replaces the network
 * loaders (tests); `now` is the clock for the default date.
 */
export function createServer({ write, environment = null, now = () => Date.now(), site = PUBLIC_SITE, terrain = DEFAULT_TERRAIN_URL } = {}) {
  const running = new Map(), cancelled = new Set();
  const send = (message) => write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const error = (id, code, message) => send({ id, error: { code, message } });

  /** The request's text and the plan it opens on, or a tool error. */
  function input(args) {
    if (args.request === undefined || args.request === null) return { error: toolError('缺少 request：推算请求 v2 的 JSON 对象、JSON 文本或 #solve= 链接。') };
    if (typeof args.request !== 'object' && typeof args.request !== 'string') return { error: toolError('request 应为 JSON 对象或字符串。') };
    let shotPlan = null;
    if (args.shot !== undefined && args.shot !== null && args.shot !== '') {
      if (typeof args.shot !== 'string') return { error: toolError('shot 应为机位链接或机位 JSON 文本。') };
      const shot = parseShot(args.shot);
      if (!shot.ok) return { error: toolError(`shot 无效：\n${list(shot.errors)}`) };
      shotPlan = shot.plan;
    }
    return { prepared: prepare(args.request, { shotPlan, now: now(), labels }) };
  }

  async function solveTool(args, signal, progress) {
    const read = input(args);
    if (read.error) return read.error;
    const { prepared } = read;
    if (prepared.status === 'invalid') return toolError(`推算请求无效：\n${list(prepared.errors)}`);
    if (prepared.status === 'unsolvable') return toolError(`不能搜索：${prepared.solvable.message}`);
    const max = args.maxResults ?? DEFAULT_MAX_RESULTS;
    if (!Number.isInteger(max) || max < 1 || max > 200) return toolError('maxResults 应为 1—200 的整数。');
    const searched = await search(prepared, { terrain, environment, signal, report: progress });
    if (searched.status === 'cancelled') return null;
    if (searched.status === 'failed') return toolError(`搜索失败：${searched.message}`);
    return structured(resultObject(prepared, searched, { site, terrain, maxResults: max }));
  }

  function validateTool(args) {
    const read = input(args);
    return read.error ?? structured(validation(read.prepared, { site }));
  }

  async function describeTool(args) {
    const format = args.format ?? 'solve';
    if (!formatFiles[format]) return toolError('format 应为 solve 或 shot。');
    const file = formatFiles[format][args.schema ? 'schema' : 'markdown'];
    return { content: [text(await readFile(join(ROOT, file), 'utf8'))] };
  }

  async function call(id, params) {
    const name = params?.name, args = params?.arguments ?? {};
    if (!TOOLS.some((tool) => tool.name === name)) return error(id, -32602, `未知工具：${name}`);
    if (typeof args !== 'object' || Array.isArray(args)) return error(id, -32602, 'arguments 应为对象');
    const controller = new AbortController();
    running.set(id, controller);
    // Progress for clients that ask: the executor's stages, at most every 300 ms.
    const token = params?._meta?.progressToken;
    let step = 0, said = '', saidAt = 0;
    const progress = (patch) => {
      if (token === undefined || !patch.stage || patch.stage === said || Date.now() - saidAt < 300) return;
      said = patch.stage;
      saidAt = Date.now();
      send({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message: patch.stage } });
    };
    try {
      const result = name === 'solve' ? await solveTool(args, controller.signal, progress)
        : name === 'validate_request' ? validateTool(args) : await describeTool(args);
      // A request the client cancelled gets no response; a stopped search returns null.
      if (result && !cancelled.has(id)) send({ id, result });
    } finally {
      running.delete(id);
      cancelled.delete(id);
    }
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return error(message?.id ?? null, -32600, '无效请求');
    const { id, method, params } = message;
    if (typeof method !== 'string') return; // A response to us; this server sends no requests.
    const notification = id === undefined;
    if (notification) {
      if (method === 'notifications/cancelled' && running.has(params?.requestId)) {
        cancelled.add(params.requestId);
        running.get(params.requestId).abort();
      }
      return;
    }
    try {
      if (method === 'initialize') {
        const asked = params?.protocolVersion;
        return send({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        });
      }
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
      if (method === 'tools/call') return await call(id, params);
      return error(id, -32601, `未知方法：${method}`);
    } catch (failure) {
      return error(id, -32603, failure instanceof Error ? failure.message : String(failure));
    }
  }

  /** One line from the client: a message or, for older clients, a batch. */
  function receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, '无法解析 JSON');
      return Promise.resolve();
    }
    return Array.isArray(message) ? Promise.all(message.map(handle)) : handle(message);
  }

  /** Stops every running search (the client went away). */
  const close = () => { for (const controller of running.values()) controller.abort(); };
  return { receive, handle, close };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  let site = option('--site', PUBLIC_SITE);
  if (!site.endsWith('/')) site += '/';
  const server = createServer({ write: (line) => process.stdout.write(line), site, terrain: option('--terrain', DEFAULT_TERRAIN_URL) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => { if (line.trim()) void server.receive(line); });
  lines.on('close', () => server.close());
}
