// The solve steps shared by the command line (scripts/solve.mjs) and the MCP
// server (scripts/mcp.mjs): read a request, fill in what it leaves out, search
// on this machine with the same executor as the web page, and build the
// result JSON with a try-out link for each result.
import { classify, lensOf, tryPatch } from '../../src/domain/solve/composition.ts';
import { runComposition, searchBasis } from '../../src/domain/solve/composition-run.ts';
import { skyConditionNames } from '../../src/domain/solve/alignment.ts';
import { compassDirection, initialPlan, localDateTime, sensors } from '../../src/domain/core/plan.ts';
import { compositionOf, parseSolveText2, solveJson2, solveLink2, solvePlan2 } from '../../src/domain/solve/solve.ts';
import { describeSolve2, outcomeReport } from '../../src/domain/solve/solve-report.ts';
import { parseShotText, shotFromPlan, shotLink } from '../../src/domain/shots/shot.ts';
import { PUBLIC_SITE } from '../../src/domain/core/site.ts';
import { DEFAULT_TERRAIN_URL } from '../../src/domain/core/terrain.ts';
import { nodeEnvironment } from './solve-node.mjs';

export const RESULT_FORMAT = 'tamatamatori.solve-result';
export { PUBLIC_SITE, DEFAULT_TERRAIN_URL };

/** The plan when no shot is given: 24 mm full frame 3:2 landscape, 1.6 m, standard refraction, now. */
export function defaultPlan(now = Date.now(), timeZone = 'UTC') {
  return {
    ...initialPlan, focalLength: 24, sensor: 'full-frame', customSensor: null, aspectRatio: '3:2', orientation: 'landscape',
    cameraHeight: 1.6, refraction: 'standard', instant: new Date(Math.floor(now / 60_000) * 60_000).toISOString().replace('.000Z', 'Z'),
    timeZone, followLocalZone: false,
  };
}

/** A shot link or JSON as the current plan: { ok, plan } or { ok: false, errors }. */
export const parseShot = (text) => parseShotText(text);

/** How the default words name where a value came from. */
export const commandLineLabels = { fallback: '命令行缺省', shot: '取自 --shot 的机位', shotDate: '取自 --shot 的日期' };

/** The words for each default the request left to the caller. */
function defaultWords(defaults, plan, request, fromShot, labels) {
  const words = [];
  const lens = `${plan.focalLength} mm · ${sensors[plan.sensor]?.label ?? plan.sensor} · ${plan.aspectRatio} ${plan.orientation === 'portrait' ? '竖幅' : '横幅'}`;
  const source = fromShot ? labels.shot : labels.fallback;
  if (defaults.includes('lens')) words.push(`镜头：${lens}（${source}）`);
  if (defaults.includes('camera')) words.push('机位：不限，离地面目标最远 30 km（请求缺省）');
  if (defaults.includes('time')) words.push(`时间：${localDateTime(plan.instant, plan.timeZone).slice(0, 10)} 起 30 天（${fromShot ? labels.shotDate : '今天'}）`);
  if (defaults.includes('timeZone')) words.push(`时区：${plan.timeZone}（${source}）`);
  if (request.camera.heightAboveGround === undefined) words.push(`离地高度：${plan.cameraHeight} m（${source}）`);
  words.push(`大气折射：${plan.refraction === 'standard' ? '标准' : '无'}（${source}）`);
  for (const field of defaults.filter((entry) => /^targets\[\d+\]\.height$/.test(entry))) words.push(`${field}：0（请求缺省，山顶类地面点）`);
  return words;
}

/**
 * Reads a request (JSON text, a #solve= link, or a request object) against the
 * current plan (a shot's plan, or the defaults). Returns
 * { status: 'invalid', errors } or { status: 'unsolvable' | 'ready', … }.
 */
export function prepare(input, { shotPlan = null, now = Date.now(), labels = commandLineLabels } = {}) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const parsed = parseSolveText2(text, lensOf(shotPlan ?? defaultPlan(now)));
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  const request = parsed.request;
  const plan = solvePlan2(request, shotPlan ?? defaultPlan(now, request.timeZone ?? 'UTC'));
  const composition = compositionOf(request, plan);
  const solvable = classify(composition);
  const prepared = {
    request, plan, composition, solvable,
    defaults: defaultWords(parsed.defaults, plan, request, !!shotPlan, labels),
  };
  return solvable.strategy ? { status: 'ready', ...prepared, strategy: solvable.strategy } : { status: 'unsolvable', ...prepared };
}

/**
 * Searches a prepared request. `environment` replaces the network loaders (tests);
 * `report` receives the executor's stage patches. Returns { status: 'done',
 * outcome, reads, seconds }, { status: 'cancelled' } or { status: 'failed', message }.
 */
export async function search(prepared, { terrain = DEFAULT_TERRAIN_URL, environment = null, signal = new AbortController().signal, report = () => {} } = {}) {
  // Each terrain read: its zoom and how many tiles it took.
  const reads = [];
  const loaders = environment ?? nodeEnvironment(terrain);
  const env = {
    ...loaders, report,
    terrain: async (points, abort, progress) => {
      let tiles = 0;
      const sampler = await loaders.terrain(points, abort, (done, total) => { tiles = total; progress?.(done, total); });
      reads.push({ zoom: sampler.zoom ?? null, tiles });
      return sampler;
    },
  };
  const started = Date.now();
  try {
    const outcome = await runComposition(prepared.strategy, prepared.composition, prepared.plan, env, signal);
    if (!outcome || signal.aborted) return { status: 'cancelled' };
    return { status: 'done', outcome, reads, seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    if (signal.aborted) return { status: 'cancelled' };
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
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

const LIMITS = '基于地理与天文数据的构图模拟，不含天气；遮挡只看地形起伏，不含建筑、树木与大气折射对视线的抬升，不代表实景一定可见。坐标目标未经核实，须在地图上确认。';

/**
 * The result JSON (format tamatamatori.solve-result v1). With `maxResults`,
 * only the first results are listed and `truncated` says how many there are.
 */
export function resultObject(prepared, searched, { site = PUBLIC_SITE, terrain = DEFAULT_TERRAIN_URL, maxResults = Infinity } = {}) {
  const { request, plan, composition, solvable, strategy } = prepared;
  const { outcome } = searched;
  const basis = searchBasis(strategy, composition, plan);
  const names = {
    ground: strategy.kind === 'grounds' ? strategy.first.name : strategy.kind === 'pair' ? null : strategy.ground?.name ?? null,
    second: strategy.kind === 'grounds' ? strategy.second.name : null,
  };
  const darkSky = composition.filters.some((filter) => filter.kind === 'darkSky');
  const usedTerrain = strategy.kind !== 'pair' && (strategy.kind !== 'window' || !!strategy.ground || strategy.extras.some((extra) => extra.kind === 'ground'));
  const listed = outcome.items.slice(0, maxResults);
  return {
    format: RESULT_FORMAT,
    version: 1,
    request: JSON.parse(solveJson2(request)),
    requestLink: solveLink2(request, site),
    defaults: prepared.defaults,
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
    results: listed.map((item, index) => resultJson(item, index, { plan, basis, site, names })),
    ...(listed.length < outcome.items.length ? { truncated: { shown: listed.length, total: outcome.items.length } } : {}),
    seconds: round(searched.seconds, 1),
    terrainReads: searched.reads,
    sources: [
      ...(usedTerrain ? [`地形：Mapterhorn（${terrain}），署名见 https://mapterhorn.com/attribution`] : []),
      ...(darkSky ? ['光污染：Falchi 等 World Atlas 2015（GFZ 数据，CC BY-NC 4.0，仅限非商业使用）'] : []),
      '星历：astronomy-engine',
    ],
    limits: LIMITS,
  };
}

/** The result as the panel's "复制结果" Markdown. */
export function resultMarkdown(prepared, searched, { site = PUBLIC_SITE, computedBy }) {
  const { request, plan, composition, strategy } = prepared;
  return outcomeReport({ request, link: solveLink2(request, site), plan, composition, strategy, outcome: searched.outcome, computedBy });
}

/** What a request asks and whether it can be searched, without searching (no network). */
export function validation(prepared, { site = PUBLIC_SITE } = {}) {
  if (prepared.status === 'invalid') return { ok: false, errors: prepared.errors };
  const { request, solvable, defaults } = prepared;
  return {
    ok: true,
    canSearch: prepared.status === 'ready',
    solvable: { shape: solvable.shape, message: solvable.message },
    describe: describeSolve2(request),
    defaults,
    request: JSON.parse(solveJson2(request)),
    requestLink: solveLink2(request, site),
  };
}
