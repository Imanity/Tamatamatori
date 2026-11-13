// Comet catalogue: public/comets/catalog.json, apparitions since 1990 observed brighter than mag 10.
//
//   node --experimental-strip-types scripts/update-comets.mjs            incremental (CI): at most every 20 h
//   node --experimental-strip-types scripts/update-comets.mjs --resume   resume after a failed update paused it
//   node --experimental-strip-types scripts/update-comets.mjs --force    maintainer run inside the cooldown
//   node --experimental-strip-types scripts/update-comets.mjs --full [--offline] [--only C/2020 F3,12P]
//                                                                         manual full pass, downloads cached in .cache/comets/
//
// Sources
//   COBS Comet Observation Database (https://cobs.si), CC BY-NC-SA 4.0: list of comets and visual
//     total magnitudes. Only fitted magnitude laws are kept; observer identities and individual
//     observations are never written out.
//   NASA/JPL Horizons (https://ssd.jpl.nasa.gov/horizons/): heliocentric osculating elements at the
//     perihelion of the apparition (IAU76/J2000 ecliptic) from JPL's solution with perturbations;
//     the application propagates them as a two-body orbit.
//
// Selection: the apparition COBS lists for each comet (latest or upcoming perihelion), perihelion
// from 1990, at least 8 nights of visual magnitudes, a nightly median brighter than 10.0.
// Apparitions are keyed by designation and perihelion date, so a periodic comet's next return is
// added beside the earlier one. An incremental update only revisits apparitions whose observing
// window (perihelion ± 550 days) was still open at the previous update; closed ones stay as they
// were. Like the space station feed, a failed update keeps the previous catalogue, records the
// error with the data and pauses automatic updates until a maintainer resumes them. An upstream
// that never answers (connection, DNS, timeout) is retried, then left for the next schedule
// without a pause (see scripts/lib/transport.mjs).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { overNetwork, TransportError } from './lib/transport.mjs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Body, HelioVector, MakeTime } from 'astronomy-engine';
import { cometState, magnitudeLaw, totalMagnitude, C_AU_PER_DAY } from '../src/domain/comets/comet-orbit.ts';
import { COMET_CATALOG_VERSION, COMET_REFRESH_MS, assertCatalogProgress, validateCometCatalog } from '../src/domain/comets/comet-catalog.ts';

const DAY = 86_400_000, WINDOW_DAYS = 550, MARGIN_DAYS = 30, ONGOING_DAYS = 45;
const MIN_NIGHTS = 8, PEAK_LIMIT = 10, CANDIDATE_PEAK = 12, FIT_MIN_NIGHTS = 5, FIT_MIN_SPAN = 0.08, DEFAULT_N = 4;
export const COBS_LIST = 'https://cobs.si/api/comet_list.api?is-observed=true&page=1';
const AGENT = 'Tamatamatori comet catalogue (https://github.com/Imanity/Tamatamatori)';
const jdOf = (ms) => ms / DAY + 2440587.5, msOf = (jd) => (jd - 2440587.5) * DAY;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (value, digits) => Number(value.toFixed(digits));
const perihelionOf = (item) => Date.parse(item.perihelion_date.replace(' ', 'T') + 'Z');

/** Common Simplified Chinese names; others keep the discoverer name. */
const NAMES = {
  'C/1995 O1': '海尔-波普彗星', 'C/1996 B2': '百武彗星', 'C/2006 P1': '麦克诺特彗星', 'C/2020 F3': '新智彗星',
  'C/2023 A3': '紫金山-阿特拉斯彗星', 'C/2025 A6': '莱蒙彗星', '12P': '庞斯-布鲁克斯彗星', '2P': '恩克彗星',
  'C/2021 A1': '伦纳德彗星', 'C/2022 E3': 'ZTF 彗星', 'C/2011 L4': '泛星彗星', 'C/2012 S1': '艾森彗星',
  'C/2013 R1': '洛夫乔伊彗星', 'C/2014 Q2': '洛夫乔伊彗星', 'C/2011 W3': '洛夫乔伊彗星', 'C/2024 G3': '阿特拉斯彗星',
  'C/2001 Q4': 'NEAT 彗星', 'C/2002 T7': 'LINEAR 彗星', 'C/2004 Q2': '马克霍尔茨彗星', 'C/2007 N3': '鹿林彗星',
  '13P': '奥伯斯彗星', '10P': '坦普尔 2 号彗星', '21P': '贾科比尼-津纳彗星', '46P': '维尔塔宁彗星',
  '17P': '霍姆斯彗星', '29P': '施瓦斯曼-瓦赫曼 1 号彗星', '41P': '塔特尔-贾科比尼-克雷萨克彗星', '45P': '本田-姆尔科斯-帕伊杜沙科娃彗星',
  'C/2025 R2': 'SWAN 彗星', 'C/2026 A1': 'MAPS 彗星', 'C/2019 Y4': '阿特拉斯彗星', 'C/2020 M3': '阿特拉斯彗星',
};

export function sources(date) {
  return {
    photometry: { name: 'COBS Comet Observation Database', url: 'https://cobs.si', license: 'CC BY-NC-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      changes: '按近日点前/后分别拟合夜间目视总星等中位数的 m = H + 5 log Δ + 2.5 n log r；仅保存拟合结果，不含观测者与单条观测。' },
    orbit: { name: 'NASA/JPL Horizons', url: 'https://ssd.jpl.nasa.gov/horizons/', citation: `NASA/JPL Solar System Dynamics. Data retrieved on ${date}. Horizons System. https://ssd.jpl.nasa.gov`,
      changes: '近日点时刻的日心密切根数（IAU76/J2000 黄道），应用内按二体轨道传播。' },
  };
}
const SELECTION = `1990 年起近日点、COBS 至少 ${MIN_NIGHTS} 夜目视星等且夜间中位最亮不暗于 ${PEAK_LIMIT}.0 等的回归；按编号与近日点日期区分，周期彗星的新回归与旧回归并存。`;

/**
 * Rate-limited JSON client. Upstream HTTP failures throw, so an update stops instead of
 * silently publishing a partial catalogue. `cacheDir` (manual runs only) keeps responses.
 */
export function client({ fetchImpl = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)), cacheDir = null, offline = false, maxRequests = 400 } = {}) {
  let requests = 0;
  async function get(url, cacheName) {
    if (cacheDir && cacheName) {
      try { return JSON.parse(await readFile(resolve(cacheDir, cacheName), 'utf8')); } catch {}
      if (offline) throw new Error(`离线模式缺少缓存 ${cacheName}`);
    }
    if (++requests > maxRequests) throw new Error(`上游请求超过 ${maxRequests} 次上限`);
    let body;
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await overNetwork(host, () => fetchImpl(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(30000) }));
        if (response.ok) { body = await overNetwork(host, () => response.json()); break; }
      } catch (error) {
        // No answer: retried like a 5xx; invalid JSON and other errors stop the update.
        if (!(error instanceof TransportError) || attempt === 2) throw error;
        await pause(5000 * (attempt + 1));
        continue;
      }
      if (attempt === 2 || (response.status < 500 && response.status !== 429)) throw new Error(`${host} HTTP ${response.status}`);
      await pause(5000 * (attempt + 1));
    }
    if (cacheDir && cacheName) {
      await mkdir(dirname(resolve(cacheDir, cacheName)), { recursive: true });
      await writeFile(resolve(cacheDir, cacheName), JSON.stringify(body));
    }
    await pause(1200);
    return body;
  }
  return { get, cacheDir, offline, get requests() { return requests; } };
}

const slug = (des) => des.replace(/[^\w]+/g, '_');
/**
 * Nightly material for the fit: [date, magnitude, tail length, tail unit, tail position angle].
 * Observer identities are dropped before anything is kept, also in the manual cache.
 */
async function observations(http, des, from, to) {
  const cachePath = http.cacheDir && resolve(http.cacheDir, `cobs/${slug(des)}_${from}_${to}.json`);
  if (cachePath) {
    try { return JSON.parse(await readFile(cachePath, 'utf8')); } catch {}
    if (http.offline) throw new Error(`离线模式缺少缓存 ${cachePath}`);
  }
  const rows = [];
  for (let page = 1; page < 60; page++) {
    const query = new URLSearchParams({ des, format: 'json', obs_type: 'V', exclude_faint: 'true', exclude_not_accurate: 'true',
      from_date: `${from} 00:00`, to_date: `${to} 00:00`, page: String(page) });
    const body = await http.get(`https://cobs.si/api/obs_list.api?${query}`);
    if (body.code) { if (String(body.code) === '404' || /no observ/i.test(body.message ?? '')) break; throw new Error(`COBS ${des}: ${body.message}`); }
    for (const o of body.objects ?? []) rows.push([o.obs_date, o.magnitude === null ? null : +o.magnitude,
      o.tail_length === null ? null : +o.tail_length, o.tail_length_unit, o.tail_pa]);
    if (!body.info || page >= body.info.pages) break;
  }
  if (cachePath) { await mkdir(dirname(cachePath), { recursive: true }); await writeFile(cachePath, JSON.stringify(rows)); }
  return rows;
}

async function elements(http, des, perihelionMs) {
  const jd = jdOf(Date.parse(isoDay(perihelionMs) + 'T00:00:00Z'));
  const query = new URLSearchParams({ format: 'json', COMMAND: `'DES=${des};CAP;NOFRAG;'`, EPHEM_TYPE: 'ELEMENTS', CENTER: "'500@10'",
    REF_PLANE: 'ECLIPTIC', REF_SYSTEM: 'ICRF', TLIST: `'${jd}'`, TP_TYPE: 'ABSOLUTE', OUT_UNITS: 'AU-D', CSV_FORMAT: 'YES', OBJ_DATA: 'YES' });
  const body = await http.get(`https://ssd.jpl.nasa.gov/api/horizons.api?${query}`, `horizons/${slug(des)}_${isoDay(perihelionMs)}.json`);
  return parseElements(String(body.result ?? ''));
}
export function parseElements(text) {
  const block = text.split('$$SOE')[1]?.split('$$EOE')[0];
  if (!block) return null;
  const cells = block.trim().split(',').map((cell) => cell.trim());
  // JDTDB, Calendar, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
  const [, , ec, qr, incl, node, peri, tp] = cells;
  const orbit = { q: +qr, e: +ec, tp: +tp, node: +node, peri: +peri, incl: +incl,
    solution: /Soln\.date:\s*(\S+)/.exec(text)?.[1] ?? null, record: /Rec #:\s*(\d+)/.exec(text)?.[1] ?? null };
  return [orbit.q, orbit.e, orbit.tp, orbit.node, orbit.peri, orbit.incl].every(Number.isFinite) ? orbit : null;
}

const median = (values) => { const s = [...values].sort((a, b) => a - b), k = (s.length - 1) / 2; return (s[Math.floor(k)] + s[Math.ceil(k)]) / 2; };
function geometry(orbit, jd) {
  const v = HelioVector(Body.Earth, MakeTime(jd - 2451545)), earth = [v.x, v.y, v.z];
  let lt = 0, state, d;
  for (let k = 0; k < 3; k++) { state = cometState(orbit, jd - lt); d = state.r.map((x, i) => x - earth[i]); lt = Math.hypot(...d) / C_AU_PER_DAY; }
  return { r: Math.hypot(...state.r), delta: Math.hypot(...d) };
}

/** Least squares of reduced magnitude against log r with 2.5-sigma clipping; n fixed when the arc is too short. */
function fitLaw(points, fixedN) {
  let used = points;
  for (let pass = 0; pass < 4; pass++) {
    const free = fixedN === undefined;
    let H, n;
    if (free) {
      const mx = used.reduce((s, p) => s + p.x, 0) / used.length, my = used.reduce((s, p) => s + p.y, 0) / used.length;
      let sxx = 0, sxy = 0; for (const p of used) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
      const K = sxy / sxx; H = my - K * mx; n = K / 2.5;
    } else { n = fixedN; H = used.reduce((s, p) => s + p.y - 2.5 * n * p.x, 0) / used.length; }
    const residual = (p) => p.y - H - 2.5 * n * p.x;
    const rms = Math.sqrt(used.reduce((s, p) => s + residual(p) ** 2, 0) / used.length);
    const kept = points.filter((p) => Math.abs(residual(p)) <= Math.max(2.5 * rms, 0.3));
    if (kept.length === used.length || kept.length < FIT_MIN_NIGHTS) return { H, n, rms, nights: used.length, fixed: !free };
    used = kept;
  }
  return fitLaw(used, fixedN);
}
function branch(points, otherN) {
  if (points.length < FIT_MIN_NIGHTS) return null;
  const xs = points.map((p) => p.x), span = Math.max(...xs) - Math.min(...xs);
  const extent = { from: Math.min(...points.map((p) => p.t)), to: Math.max(...points.map((p) => p.t)), range: [10 ** Math.min(...xs), 10 ** Math.max(...xs)] };
  if (span >= FIT_MIN_SPAN) {
    const free = fitLaw(points);
    if (free.n >= 1 && free.n <= 8) return { ...free, ...extent };
  }
  return { ...fitLaw(points, otherN ?? DEFAULT_N), ...extent };
}

/** COBS list entries worth fetching: perihelion from 1990 to two years ahead, listed peak brighter than 12. */
export function candidates(list, now) {
  return (list.objects ?? []).filter((o) => o.perihelion_date && o.peak_mag !== null && o.peak_mag !== '' && +o.peak_mag <= CANDIDATE_PEAK &&
    o.perihelion_date >= '1990-01-01' && perihelionOf(o) <= now + 2 * 365 * DAY);
}

/** One apparition: observations, fit and elements; `{ comet }` or `{ skip }` with the reason. */
export async function processCandidate(http, item, now) {
  const des = item.name, perihelion = perihelionOf(item);
  const from = isoDay(perihelion - WINDOW_DAYS * DAY), to = isoDay(Math.min(perihelion + WINDOW_DAYS * DAY, now));
  if (from >= to) return { skip: '尚无观测期' };
  const nights = new Map();
  for (const [date, magnitude] of await observations(http, des, from, to)) {
    if (magnitude === null || !(magnitude > -12 && magnitude < 20)) continue;
    const day = date.slice(0, 10);
    if (!nights.has(day)) nights.set(day, []);
    nights.get(day).push(magnitude);
  }
  if (nights.size < MIN_NIGHTS) return { skip: `目视夜数 ${nights.size}` };
  const brightest = Math.min(...[...nights.values()].map(median));
  if (brightest > PEAK_LIMIT) return { skip: `最亮夜中位 ${brightest.toFixed(1)}` };
  const orbit = await elements(http, des, perihelion);
  if (!orbit) return { skip: 'Horizons 无此回归的解' };
  if (Math.abs(msOf(orbit.tp) - perihelion) > 30 * DAY) return { skip: `近日点不一致 ${isoDay(msOf(orbit.tp))}` };
  const points = [...nights].map(([day, mags]) => {
    const t = Date.parse(day + 'T12:00:00Z'), g = geometry(orbit, jdOf(t));
    return { t, x: Math.log10(g.r), y: median(mags) - 5 * Math.log10(g.delta), pre: jdOf(t) < orbit.tp };
  });
  const prePoints = points.filter((p) => p.pre), postPoints = points.filter((p) => !p.pre);
  let pre = branch(prePoints);
  const post = branch(postPoints, pre && !pre.fixed ? pre.n : undefined);
  if (pre?.fixed && post && !post.fixed) pre = branch(prePoints, post.n);
  if (!pre && !post) return { skip: '无法拟合' };
  const days = [...nights.keys()].sort(), first = Date.parse(days[0]), last = Date.parse(days.at(-1));
  const ongoing = last >= now - ONGOING_DAYS * DAY;
  const window = {
    from: isoDay(Math.max(perihelion - WINDOW_DAYS * DAY, first - MARGIN_DAYS * DAY)),
    to: isoDay(ongoing ? perihelion + WINDOW_DAYS * DAY : Math.min(perihelion + WINDOW_DAYS * DAY, last + MARGIN_DAYS * DAY)),
  };
  // The law only varies over the distances it was fitted to; outside them the end value holds.
  const law = (fit) => ({ H: round(fit.H, 2), n: round(fit.n, 2), range: [Math.floor(fit.range[0] * 1000) / 1000, Math.ceil(fit.range[1] * 1000) / 1000] });
  const photometry = { pre: law(pre ?? post), post: law(post ?? pre) };
  let peak = { magnitude: Infinity, date: '' };
  for (let t = Date.parse(window.from); t <= Date.parse(window.to); t += DAY / 2) {
    const g = geometry(orbit, jdOf(t)), m = totalMagnitude(magnitudeLaw(photometry, orbit.tp, jdOf(t)), g.r, g.delta);
    if (m < peak.magnitude) peak = { magnitude: round(m, 1), date: isoDay(t) };
  }
  // A branch without its own nights reuses the other branch's law ("mirrored").
  const describe = (fit) => fit ? { source: 'cobs', nights: fit.nights, rms: round(fit.rms, 2), fixedN: fit.fixed, from: isoDay(fit.from), to: isoDay(fit.to) } : { source: 'mirrored' };
  // The record's apparition is the perihelion of the elements, which may differ from the list by hours.
  const elementsDay = isoDay(msOf(orbit.tp));
  return {
    comet: {
      key: `${des}/${elementsDay}`, id: des, apparition: elementsDay,
      name: NAMES[des] ?? item.fullname.replace(/^.*\((.*)\)$/, '$1 彗星'),
      designation: item.fullname,
      orbit: { q: orbit.q, e: orbit.e, tp: orbit.tp, node: orbit.node, peri: orbit.peri, incl: orbit.incl, solution: orbit.solution, record: orbit.record },
      photometry,
      fit: { pre: describe(pre), post: describe(post) },
      observed: { from: days[0], to: days.at(-1), nights: nights.size, brightest: round(brightest, 1) },
      window, status: ongoing ? 'ongoing' : 'complete', peak,
    },
  };
}

/**
 * Incremental update with the station feed's safeguards: a cooldown between upstream updates,
 * the attempt persisted before any request, and a failed update kept as a paused error state
 * on top of the previous valid catalogue.
 */
export async function updateComets(previous, { now = Date.now(), resume = false, full = false, force = false, saveAttempt = async () => {}, http = client(), log = () => {} } = {}) {
  if (!full) {
    if (!previous) throw new Error('增量更新需要已有目录');
    // `force` (maintainer runs only) skips the cooldown, never a pause.
    if ((!force && now - Date.parse(previous.attemptedAt) < COMET_REFRESH_MS) || (previous.blocked && !resume)) return { catalog: previous, report: null };
  }
  const attemptedAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pending = previous && { ...previous, attemptedAt, status: 'error', blocked: true, error: '彗星目录更新未完成，自动更新已暂停' };
  if (pending) await saveAttempt(pending);
  const report = { checked: 0, added: [], refreshed: [], skipped: [], kept: 0 };
  try {
    const list = await http.get(COBS_LIST, 'cobs-comet-list.json');
    if (!Array.isArray(list.objects) || !list.objects.length) throw new Error('COBS 彗星列表为空');
    const byKey = new Map((previous?.comets ?? []).map((comet) => [comet.key, comet]));
    // The same apparition: same designation, perihelion within 30 days (a refreshed orbit may move it by hours).
    const sameApparition = (comet) => [...byKey.values()].find((old) => old.id === comet.id && Math.abs(old.orbit.tp - comet.orbit.tp) < 30);
    const replaced = new Set();
    // Windows still open at the previous update can have gained observations since.
    const since = previous ? Date.parse(previous.fetchedAt) - 2 * DAY : -Infinity;
    for (const item of candidates(list, now)) {
      if (!full && perihelionOf(item) + WINDOW_DAYS * DAY < since) continue;
      report.checked++;
      const result = await processCandidate(http, item, now);
      if (result.skip) { report.skipped.push([item.name, result.skip]); continue; }
      const old = sameApparition(result.comet);
      if (old && old.key !== result.comet.key) { byKey.delete(old.key); replaced.add(old.key); }
      byKey.set(result.comet.key, result.comet);
      (old ? report.refreshed : report.added).push(result.comet.key);
      log(`${old ? '更新' : '新增'} ${result.comet.key} · 夜数 ${result.comet.observed.nights} · 最亮 ${result.comet.observed.brightest} · 模型峰值 ${result.comet.peak.magnitude}`);
    }
    const comets = [...byKey.values()].sort((a, b) => a.orbit.tp - b.orbit.tp);
    report.kept = comets.length - report.added.length - report.refreshed.length;
    const catalog = validateCometCatalog({ version: COMET_CATALOG_VERSION, status: 'ready', fetchedAt: attemptedAt, attemptedAt, error: null, blocked: false,
      sources: sources(attemptedAt.slice(0, 10)), selection: SELECTION, comets }, now);
    assertCatalogProgress(previous && { ...previous, comets: previous.comets.filter((comet) => !replaced.has(comet.key)) }, catalog);
    return { catalog, report: { ...report, requests: http.requests } };
  } catch (error) {
    if (!pending) throw error;
    // Upstream never answered: keep the catalogue as published and try again on the next schedule.
    if (error instanceof TransportError && !previous.blocked)
      return { catalog: { ...previous, attemptedAt }, report: { ...report, requests: http.requests, unreachable: error.message } };
    return { catalog: { ...pending, error: `${error instanceof Error ? error.message : '更新失败'}，自动更新已暂停，需维护者检查后手动恢复` }, report: { ...report, requests: http.requests } };
  }
}

async function writeCatalog(path, catalog) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(catalog, null, 1) + '\n');
  await rename(temporary, path);
}

async function main() {
  const args = process.argv.slice(2), full = args.includes('--full');
  const output = resolve('public/comets/catalog.json'), state = resolve('.cache/comet-catalog.json');
  const found = [];
  for (const path of [output, state]) {
    try { found.push(validateCometCatalog(JSON.parse(await readFile(path, 'utf8')))); }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`忽略无效彗星目录 ${path}：${error.message}`); }
  }
  // Cache eviction must not repeat a recent published update.
  if (process.env.CI && /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '')) {
    const [owner, repository] = process.env.GITHUB_REPOSITORY.split('/');
    try {
      const response = await fetch(`https://${owner}.github.io/${repository}/comets/catalog.json`, { signal: AbortSignal.timeout(15000) });
      if (response.ok) found.push(validateCometCatalog(await response.json()));
    } catch { console.warn('已发布彗星目录暂不可读，使用仓库快照与持久缓存'); }
  }
  found.sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt));
  const previous = found[0] ?? null;
  const http = client(full ? { cacheDir: resolve('.cache/comets'), offline: args.includes('--offline'), maxRequests: 5000 } : {});
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
  if (only) {
    const get = http.get;
    http.get = async (url, name) => { const body = await get(url, name); return url === COBS_LIST ? { ...body, objects: body.objects.filter((o) => only.includes(o.name)) } : body; };
  }
  const { catalog, report } = await updateComets(previous, {
    full, resume: args.includes('--resume'), force: args.includes('--force'), http, log: (line) => console.log(line),
    saveAttempt: async (pending) => { await writeCatalog(state, pending); },
  });
  await writeCatalog(state, catalog);
  await writeCatalog(output, catalog);
  console.log(JSON.stringify({ status: catalog.status, fetchedAt: catalog.fetchedAt, attemptedAt: catalog.attemptedAt, comets: catalog.comets.length,
    ...(report ? { checked: report.checked, added: report.added.length, refreshed: report.refreshed.length, kept: report.kept, skipped: report.skipped.length, requests: report.requests } : { skippedRun: '冷却或已暂停，未访问上游' }) }));
  if (report && full) await writeFile(resolve('.cache/comets/skipped.json'), JSON.stringify(report.skipped, null, 1));
  if (report?.unreachable) console.warn(`::warning::${report.unreachable}，沿用原目录，下次定时检查重试`);
  if (catalog.error) {
    const message = catalog.error.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.warn(`::warning::${message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
