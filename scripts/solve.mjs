// 推算命令行（AI 第二级，docs/plan/solver-tool.md）：读入推算请求 v2（或 v1），
// 在本机运行与网页相同的搜索，输出 JSON 或 Markdown，并为每个结果附上打开该试看机位的链接。
//
//   npm run solve -- request.json [--format json|markdown] [--site URL] [--shot 机位链接或 JSON 文件] [--terrain TileJSON]
//   cat request.json | npm run solve -- -
//
// 退出码：0 完成（没有结果也算），1 搜索失败，2 请求无效，3 不能搜索。
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { classify, lensOf, tryPatch } from '../src/domain/solve/composition.ts';
import { runComposition, searchBasis } from '../src/domain/solve/composition-run.ts';
import { skyConditionNames } from '../src/domain/solve/alignment.ts';
import { compassDirection, initialPlan, localDateTime, sensors } from '../src/domain/core/plan.ts';
import { compositionOf, parseSolveText2, solveJson2, solveLink2, solvePlan2 } from '../src/domain/solve/solve.ts';
import { describeSolve2, outcomeReport } from '../src/domain/solve/solve-report.ts';
import { parseShotText, shotFromPlan, shotLink } from '../src/domain/shots/shot.ts';
import { PUBLIC_SITE } from '../src/domain/core/site.ts';
import { DEFAULT_TERRAIN_URL } from '../src/domain/core/terrain.ts';
import { nodeEnvironment } from './lib/solve-node.mjs';

export const RESULT_FORMAT = 'tamatamatori.solve-result';
const USAGE = `用法：npm run solve -- <请求文件|-> [--format json|markdown] [--site URL] [--shot 机位链接、JSON 或文件] [--terrain TileJSON 地址]`;

/** The command line's plan when no --shot is given: 24 mm full frame 3:2 landscape, 1.6 m, standard refraction, now. */
export function defaultPlan(now = Date.now(), timeZone = 'UTC') {
  return {
    ...initialPlan, focalLength: 24, sensor: 'full-frame', customSensor: null, aspectRatio: '3:2', orientation: 'landscape',
    cameraHeight: 1.6, refraction: 'standard', instant: new Date(Math.floor(now / 60_000) * 60_000).toISOString().replace('.000Z', 'Z'),
    timeZone, followLocalZone: false,
  };
}

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

/** The words for each default the request left to the command line. */
function defaultWords(defaults, plan, request, fromShot) {
  const words = [];
  const lens = `${plan.focalLength} mm · ${sensors[plan.sensor]?.label ?? plan.sensor} · ${plan.aspectRatio} ${plan.orientation === 'portrait' ? '竖幅' : '横幅'}`;
  const source = fromShot ? '取自 --shot 的机位' : '命令行缺省';
  if (defaults.includes('lens')) words.push(`镜头：${lens}（${source}）`);
  if (defaults.includes('camera')) words.push('机位：不限，离地面目标最远 30 km（请求缺省）');
  if (defaults.includes('time')) words.push(`时间：${localDateTime(plan.instant, plan.timeZone).slice(0, 10)} 起 30 天（${fromShot ? '取自 --shot 的日期' : '今天'}）`);
  if (defaults.includes('timeZone')) words.push(`时区：${plan.timeZone}（${source}）`);
  if (request.camera.heightAboveGround === undefined) words.push(`离地高度：${plan.cameraHeight} m（${source}）`);
  words.push(`大气折射：${plan.refraction === 'standard' ? '标准' : '无'}（${source}）`);
  for (const field of defaults.filter((entry) => /^targets\[\d+\]\.height$/.test(entry))) words.push(`${field}：0（请求缺省，山顶类地面点）`);
  return words;
}

const iso = (time) => new Date(time).toISOString().replace('.000Z', 'Z');
const local = (time, timeZone) => localDateTime(iso(time), timeZone).replace('T', ' ').slice(0, 16);
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** One result for the JSON output, with the link that opens its try-out. */
function resultJson(item, index, context) {
  const { plan, basis, site, names } = context;
  const tried = { ...plan, ...tryPatch(item, basis, plan.layers) };
  const link = shotLink(shotFromPlan(tried, `推算结果 ${index + 1}`), site);
  const timed = !item.place;
  return {
    index: index + 1,
    ...(timed ? {
      day: item.day,
      start: { utc: iso(item.start), local: local(item.start, plan.timeZone) },
      end: { utc: iso(item.end), local: local(item.end, plan.timeZone) },
      best: { utc: iso(item.best), local: local(item.best, plan.timeZone) },
    } : { timeless: true }),
    camera: { latitude: round(item.camera.latitude, 6), longitude: round(item.camera.longitude, 6) },
    aim: item.aim ? { azimuth: round(item.aim.azimuth, 4), pitch: round(item.aim.pitch, 4) } : { azimuth: round(tried.azimuth, 4), pitch: round(tried.pitch, 4) },
    ...(item.bearing !== null && item.near !== null && !item.place ? {
      target: { name: names.ground, direction: compassDirection(item.bearing), azimuth: round(item.bearing, 2), distanceKm: [round(item.near / 1000, 2), round(item.far / 1000, 2)] },
    } : {}),
    ...(item.place ? {
      place: {
        first: { name: names.ground, direction: compassDirection(item.place.first.azimuth), distanceKm: round(item.place.first.distance / 1000, 2) },
        second: { name: names.second, direction: compassDirection(item.place.second.azimuth), distanceKm: round(item.place.second.distance / 1000, 2) },
        toleranceAreaM: [Math.round(item.place.reach.shortest * 2), Math.round(item.place.reach.longest * 2)],
        movedM: Math.round(item.place.moved),
        terrainGaps: item.place.unknown,
      },
    } : {}),
    ...(item.share ? { subjectShare: [round(item.share[0], 3), round(item.share[1], 3)] } : {}),
    deviation: round(item.deviation, 4),
    ...(timed ? {
      sky: skyConditionNames[item.sky],
      moon: item.moonElevation < 0 ? { up: false, lit: round(item.moonLit, 3) } : { up: true, elevation: round(item.moonElevation, 1), lit: round(item.moonLit, 3) },
    } : {}),
    link,
  };
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
  let base = null;
  if (options.shot) {
    let shotText = options.shot;
    if (!/^(tmt1:|https?:|\{|`)/.test(shotText.trim())) shotText = await readFile(shotText, 'utf8').catch(() => shotText);
    const shot = parseShotText(shotText);
    if (!shot.ok) {
      stderr.write(`--shot 无效：\n${shot.errors.map((line) => `- ${line}`).join('\n')}\n`);
      return 2;
    }
    base = shot.plan;
  }
  const lensBase = base ?? defaultPlan(io.now?.() ?? Date.now());
  const parsed = parseSolveText2(text, lensOf(lensBase));
  if (!parsed.ok) {
    stderr.write(`推算请求无效：\n${parsed.errors.map((line) => `- ${line}`).join('\n')}\n`);
    return 2;
  }
  const request = parsed.request;
  base ??= defaultPlan(io.now?.() ?? Date.now(), request.timeZone ?? 'UTC');
  const plan = solvePlan2(request, base);
  const composition = compositionOf(request, plan);
  const solvable = classify(composition);
  if (!solvable.strategy) {
    stderr.write(`不能搜索：${solvable.message}\n`);
    return 3;
  }
  const strategy = solvable.strategy;
  // Progress on stderr, at most once a second.
  let said = '', saidAt = 0;
  const report = (patch) => {
    if (!patch.stage || patch.stage === said || Date.now() - saidAt < 1000) return;
    said = patch.stage;
    saidAt = Date.now();
    stderr.write(`${patch.stage}\n`);
  };
  // Each terrain read: its zoom and how many tiles it took.
  const reads = [];
  const loaders = io.environment ?? nodeEnvironment(options.terrain);
  const environment = {
    ...loaders, report,
    terrain: async (points, signal, progress) => {
      let tiles = 0;
      const sampler = await loaders.terrain(points, signal, (done, total) => { tiles = total; progress?.(done, total); });
      reads.push({ zoom: sampler.zoom ?? null, tiles });
      return sampler;
    },
  };
  const started = Date.now();
  let outcome;
  try {
    outcome = await runComposition(strategy, composition, plan, environment, new AbortController().signal);
  } catch (error) {
    stderr.write(`搜索失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const link = solveLink2(request, options.site);
  const computedBy = '用命令行在本机计算';
  if (options.format === 'markdown') {
    stdout.write(outcomeReport({ request, link, plan, composition, strategy, outcome, computedBy }));
    return 0;
  }
  const basis = searchBasis(strategy, composition, plan);
  const names = {
    ground: strategy.kind === 'grounds' ? strategy.first.name : strategy.kind === 'pair' ? null : strategy.ground?.name ?? null,
    second: strategy.kind === 'grounds' ? strategy.second.name : null,
  };
  const darkSky = composition.filters.some((filter) => filter.kind === 'darkSky');
  const usedTerrain = strategy.kind !== 'pair' && (strategy.kind !== 'window' || !!strategy.ground || strategy.extras.some((extra) => extra.kind === 'ground'));
  const result = {
    format: RESULT_FORMAT,
    version: 1,
    request: JSON.parse(solveJson2(request)),
    requestLink: link,
    defaults: defaultWords(parsed.defaults, plan, request, !!options.shot),
    plan: {
      lens: { focalLength: plan.focalLength, sensor: plan.sensor, aspectRatio: plan.aspectRatio, orientation: plan.orientation },
      cameraHeight: plan.cameraHeight, refraction: plan.refraction, timeZone: plan.timeZone,
    },
    solvable: { shape: solvable.shape, message: solvable.message },
    describe: describeSolve2(request),
    counts: {
      results: outcome.items.length, blocked: outcome.blocked, filtered: outcome.filtered, missingLightPollution: outcome.missing,
      merged: outcome.merged, otherTargetsMissed: outcome.extraMissed,
    },
    note: outcome.note,
    results: outcome.items.map((item, index) => resultJson(item, index, { plan, basis, site: options.site, names })),
    seconds: round((Date.now() - started) / 1000, 1),
    terrainReads: reads,
    sources: [
      ...(usedTerrain ? [`地形：Mapterhorn（${options.terrain}），署名见 https://mapterhorn.com/attribution`] : []),
      ...(darkSky ? ['光污染：Falchi 等 World Atlas 2015（GFZ 数据，CC BY-NC 4.0，仅限非商业使用）'] : []),
      '星历：astronomy-engine',
    ],
    limits: '基于地理与天文数据的构图模拟，不含天气；遮挡只看地形起伏，不含建筑、树木与大气折射对视线的抬升，不代表实景一定可见。坐标目标未经核实，须在地图上确认。',
  };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  solveCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; });
