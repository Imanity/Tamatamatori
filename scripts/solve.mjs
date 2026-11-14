// 推算命令行（AI 第二级，docs/plan/solver-tool.md）：读入推算请求 v2（或 v1），
// 在本机运行与网页相同的搜索，输出 JSON 或 Markdown，并为每个结果附上打开该试看机位的链接。
//
//   npm run solve -- request.json [--format json|markdown] [--site URL] [--shot 机位链接或 JSON 文件] [--terrain TileJSON]
//   cat request.json | npm run solve -- -
//
// 退出码：0 完成（没有结果也算），1 搜索失败，2 请求无效，3 不能搜索。
// 读请求、补缺省、搜索与组装结果在 lib/solve-run.mjs，MCP 服务器（scripts/mcp.mjs）共用。
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DEFAULT_TERRAIN_URL, PUBLIC_SITE, parseShot, prepare, resultMarkdown, resultObject, search } from './lib/solve-run.mjs';

export { RESULT_FORMAT, defaultPlan } from './lib/solve-run.mjs';
const USAGE = `用法：npm run solve -- <请求文件|-> [--format json|markdown] [--site URL] [--shot 机位链接、JSON 或文件] [--terrain TileJSON 地址]`;

function parseArguments(argv) {
  const options = { format: 'json', site: PUBLIC_SITE, terrain: DEFAULT_TERRAIN_URL, shot: null, input: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} 需要一个值`);
      return next;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--format') options.format = value();
    else if (arg === '--site') options.site = value();
    else if (arg === '--terrain') options.terrain = value();
    else if (arg === '--shot') options.shot = value();
    else if (arg.startsWith('--')) throw new Error(`未知选项 ${arg}`);
    else if (options.input === null) options.input = arg;
    else throw new Error(`多余的参数 ${arg}`);
  }
  if (!['json', 'markdown'].includes(options.format)) throw new Error('--format 应为 json 或 markdown');
  if (!/^https?:\/\//.test(options.site)) throw new Error('--site 应为 http(s) 地址');
  if (!options.site.endsWith('/')) options.site += '/';
  return options;
}

async function readText(source, stdin) {
  if (source === '-') {
    let text = '';
    for await (const chunk of stdin) text += chunk;
    return text;
  }
  return readFile(source, 'utf8');
}

/**
 * Runs the command. `io` carries stdin, stdout and stderr (streams with
 * write), the clock and, for tests, an executor environment to use instead of
 * the network one. Resolves to the exit code.
 */
export async function solveCommand(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help || options.input === null) {
    (options.help ? stdout : stderr).write(`${USAGE}\n`);
    return options.help ? 0 : 2;
  }
  let text;
  try {
    text = await readText(options.input, io.stdin ?? process.stdin);
  } catch (error) {
    stderr.write(`无法读取请求：${error.message}\n`);
    return 2;
  }
  // The plan the request opens on: --shot, or the command line's defaults.
  let shotPlan = null;
  if (options.shot) {
    let shotText = options.shot;
    if (!/^(tmt1:|https?:|\{|`)/.test(shotText.trim())) shotText = await readFile(shotText, 'utf8').catch(() => shotText);
    const shot = parseShot(shotText);
    if (!shot.ok) {
      stderr.write(`--shot 无效：\n${shot.errors.map((line) => `- ${line}`).join('\n')}\n`);
      return 2;
    }
    shotPlan = shot.plan;
  }
  const prepared = prepare(text, { shotPlan, now: io.now?.() ?? Date.now() });
  if (prepared.status === 'invalid') {
    stderr.write(`推算请求无效：\n${prepared.errors.map((line) => `- ${line}`).join('\n')}\n`);
    return 2;
  }
  if (prepared.status === 'unsolvable') {
    stderr.write(`不能搜索：${prepared.solvable.message}\n`);
    return 3;
  }
  // Progress on stderr, at most once a second.
  let said = '', saidAt = 0;
  const report = (patch) => {
    if (!patch.stage || patch.stage === said || Date.now() - saidAt < 1000) return;
    said = patch.stage;
    saidAt = Date.now();
    stderr.write(`${patch.stage}\n`);
  };
  const searched = await search(prepared, { terrain: options.terrain, environment: io.environment ?? null, report });
  if (searched.status !== 'done') {
    stderr.write(`搜索失败：${searched.status === 'failed' ? searched.message : '已取消'}\n`);
    return 1;
  }
  if (options.format === 'markdown') {
    stdout.write(resultMarkdown(prepared, searched, { site: options.site, computedBy: '用命令行在本机计算' }));
    return 0;
  }
  stdout.write(`${JSON.stringify(resultObject(prepared, searched, { site: options.site, terrain: options.terrain }), null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  solveCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; });
