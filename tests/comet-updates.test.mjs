import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Body, HelioVector, MakeTime } from 'astronomy-engine';
import { updateComets, client, COBS_LIST, parseElements } from '../scripts/update-comets.mjs';
import { validateCometCatalog, assertCatalogProgress, catalogFreshness, COMET_REFRESH_MS, COMET_STALE_MS } from '../src/domain/comet-catalog.ts';
import { cometState, magnitudeLaw, totalMagnitude, C_AU_PER_DAY } from '../src/domain/comet-orbit.ts';

const DAY = 86_400_000;
const seed = validateCometCatalog(JSON.parse(readFileSync(new URL('../public/comets/catalog.json', import.meta.url), 'utf8')));
const now = Date.parse('2026-11-12T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const jdOf = (ms) => ms / DAY + 2440587.5, msOf = (jd) => (jd - 2440587.5) * DAY;
const previousAt = (hoursAgo, fields = {}) => ({ ...structuredClone(seed), fetchedAt: iso(now - hoursAgo * 3_600_000), attemptedAt: iso(now - hoursAgo * 3_600_000), ...fields });
const tenP = seed.comets.find((comet) => comet.id === '10P'), neowise = seed.comets.find((comet) => comet.id === 'C/2020 F3');
// A new comet near perihelion in two weeks, and a faint one.
const fresh = { q: 0.62, e: 0.9995, tp: jdOf(now + 14 * DAY), node: 210.5, peri: 95.25, incl: 61.3 };
const faint = { q: 1.9, e: 0.98, tp: jdOf(now - 60 * DAY), node: 20.5, peri: 15.25, incl: 11.3 };

/** Visual magnitudes a law and orbit would produce on nights between two dates, three reports a night. */
function nights(orbit, law, fromMs, toMs, step = 3) {
  const rows = [];
  for (let t = fromMs; t <= toMs; t += step * DAY) {
    const jd = jdOf(t + 0.5 * DAY), e = HelioVector(Body.Earth, MakeTime(jd - 2451545));
    let lt = 0, s, d;
    for (let k = 0; k < 3; k++) { s = cometState(orbit, jd - lt); d = s.r.map((x, i) => x - [e.x, e.y, e.z][i]); lt = Math.hypot(...d) / C_AU_PER_DAY; }
    const m = totalMagnitude(magnitudeLaw({ pre: law, post: law }, orbit.tp, jd), Math.hypot(...s.r), Math.hypot(...d));
    for (const offset of [-0.1, 0, 0.1]) rows.push({ obs_date: `${day(t)} 20:00:00`, magnitude: (m + offset).toFixed(1), tail_length: null, tail_length_unit: null, tail_pa: null, observer: { last_name: 'not kept' } });
  }
  return rows;
}
const horizons = (orbit) => ({ result: `Rec #:90000001 (+COV) Soln.date: 2026-Nov-01_00:00:00\n$$SOE\n${orbit.tp}, A.D. X, ${orbit.e}, ${orbit.q}, ${orbit.incl}, ${orbit.node}, ${orbit.peri}, ${orbit.tp}, 0, 0, 0, 0, 0, 0,\n$$EOE\n` });
const listEntry = (name, tp, peak, fullname = name) => ({ name, fullname, perihelion_date: `${day(msOf(tp))} ${new Date(msOf(tp)).toISOString().slice(11, 16)}`, peak_mag: String(peak) });

function upstream({ list, failCobs = false, extra = {} } = {}) {
  const calls = [];
  const entries = list ?? [
    listEntry('C/2020 F3', neowise.orbit.tp, 0.8, 'C/2020 F3 (NEOWISE)'),
    listEntry('10P', tenP.orbit.tp, 8.9, '10P/Tempel'),
    listEntry('C/2026 X1', fresh.tp, 5, 'C/2026 X1 (Test)'),
    listEntry('C/2026 X2', faint.tp, 11, 'C/2026 X2 (Faint)'),
    listEntry('C/2028 Z9', jdOf(now + 600 * DAY), 9, 'C/2028 Z9 (Future)'),
  ];
  const observations = {
    '10P': nights(tenP.orbit, tenP.photometry.pre, Date.parse(tenP.window.from), now - DAY),
    'C/2026 X1': nights(fresh, { H: 6, n: 4 }, now - 120 * DAY, now - DAY),
    'C/2026 X2': nights(faint, { H: 9, n: 4 }, now - 200 * DAY, now - DAY),
    ...extra.observations,
  };
  const orbits = { '10P': tenP.orbit, 'C/2026 X1': fresh, 'C/2026 X2': faint, ...extra.orbits };
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (url === COBS_LIST) return Response.json({ objects: entries });
    if (u.host === 'cobs.si') {
      if (failCobs) return new Response('down', { status: 500 });
      const des = u.searchParams.get('des'), rows = observations[des] ?? [];
      const from = u.searchParams.get('from_date').slice(0, 10), to = u.searchParams.get('to_date').slice(0, 10);
      const objects = rows.filter((row) => row.obs_date.slice(0, 10) >= from && row.obs_date.slice(0, 10) < to);
      return objects.length ? Response.json({ info: { page: 1, pages: 1 }, objects }) : Response.json({ code: '404', message: 'No observations found' });
    }
    if (u.host === 'ssd.jpl.nasa.gov') {
      const des = /DES=([^;]+);/.exec(u.searchParams.get('COMMAND'))[1];
      return Response.json(horizons(orbits[des]));
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl, http: client({ fetchImpl, pause: async () => {} }) };
}

test('彗星目录更新：两小时冷却与暂停期间不访问上游，恢复后继续', async () => {
  for (const previous of [previousAt(1.5), previousAt(30, { status: 'error', blocked: true, error: 'x，自动更新已暂停' })]) {
    const { calls, http } = upstream();
    const { catalog, report } = await updateComets(previous, { now, http });
    assert.equal(catalog, previous);
    assert.equal(report, null);
    assert.equal(calls.length, 0);
  }
  assert.equal(COMET_REFRESH_MS, 2 * 3_600_000);
  // A scheduled run three hours (or a little less, when the previous one started late) after the last attempt updates.
  for (const hours of [2.1, 3]) {
    const { calls, http } = upstream();
    assert.equal((await updateComets(previousAt(hours), { now, http })).catalog.status, 'ready');
    assert.ok(calls.length > 0);
  }
  const { calls, http } = upstream();
  const resumed = await updateComets(previousAt(30, { status: 'error', blocked: true, error: 'x，自动更新已暂停' }), { now, http, resume: true });
  assert.equal(resumed.catalog.status, 'ready');
  assert.ok(calls.length > 0);
});

test('彗星目录更新：先记录尝试再请求；已结束的回归不请求也不改变，进行中的刷新，新彗星加入，暗彗星与无观测期跳过', async () => {
  const { calls, http } = upstream(), order = [];
  const previous = previousAt(30);
  const wrapped = { ...http, get: async (...args) => { order.push('request'); return http.get(...args); } };
  const { catalog, report } = await updateComets(previous, { now, http: wrapped, saveAttempt: async (pending) => {
    order.push('saved');
    assert.deepEqual([pending.status, pending.blocked, pending.attemptedAt], ['error', true, iso(now)]);
    assert.equal(pending.fetchedAt, previous.fetchedAt);
  } });
  assert.equal(order[0], 'saved');
  assert.equal(catalog.status, 'ready');
  assert.deepEqual([catalog.fetchedAt, catalog.attemptedAt, catalog.blocked, catalog.error], [iso(now), iso(now), false, null]);
  validateCometCatalog(catalog, now);
  // NEOWISE's window closed long before the previous update: no request, record untouched.
  assert.ok(!calls.some((url) => url.includes('2020%20F3') || url.includes('2020+F3')));
  assert.deepEqual(catalog.comets.find((comet) => comet.key === neowise.key), neowise);
  // Every closed apparition of the seed is kept as it was.
  for (const comet of previous.comets.filter((c) => c.key !== tenP.key)) assert.deepEqual(catalog.comets.find((c) => c.key === comet.key), comet);
  assert.deepEqual(report.refreshed, [tenP.key]);
  const added = catalog.comets.find((comet) => comet.id === 'C/2026 X1');
  assert.deepEqual(report.added, [added.key]);
  assert.equal(added.key, `C/2026 X1/${day(msOf(fresh.tp))}`);
  assert.equal(added.status, 'ongoing');
  assert.equal(added.name, 'Test 彗星');
  assert.ok(Math.abs(added.photometry.pre.H - 6) < 0.15 && Math.abs(added.photometry.pre.n - 4) < 0.15, JSON.stringify(added.photometry));
  assert.deepEqual(report.skipped.map(([name]) => name).sort(), ['C/2026 X2', 'C/2028 Z9']);
  assert.match(report.skipped.find(([name]) => name === 'C/2026 X2')[1], /最亮夜中位/);
  assert.equal(report.skipped.find(([name]) => name === 'C/2028 Z9')[1], '尚无观测期');
  assert.equal(catalog.comets.length, previous.comets.length + 1);
  // Observer names never reach the catalogue.
  assert.doesNotMatch(JSON.stringify(catalog), /not kept/);
  // Requests: list, observations of the open candidates, elements of the included ones.
  assert.equal(calls.filter((url) => url.includes('ssd.jpl.nasa.gov')).length, 2);
  // The wrapper copies the client, so count on the original.
  assert.equal(http.requests, calls.length);
});

test('彗星目录更新：周期彗星的下一次回归加入，本次回归保留', async () => {
  const later = now + 5.3 * 365.25 * DAY, next = { ...tenP.orbit, tp: tenP.orbit.tp + 5.4 * 365.25 };
  const { http } = upstream({ list: [listEntry('10P', next.tp, 9, '10P/Tempel')], extra: {
    // The COBS list now names the next return; the fake keys observations by designation, so serve the next return's.
    observations: { '10P': nights(next, { H: 4, n: 4 }, later - 150 * DAY, later - DAY) }, orbits: { '10P': next },
  } });
  const { catalog, report } = await updateComets(previousAt(30), { now: later, http });
  assert.equal(catalog.status, 'ready', catalog.error);
  assert.deepEqual(report.skipped, []);
  const returns = catalog.comets.filter((comet) => comet.id === '10P').map((comet) => comet.key);
  assert.deepEqual(returns, [tenP.key, `10P/${day(msOf(next.tp))}`]);
  assert.deepEqual(report.added, [returns[1]]);
});

test('彗星目录更新：上游无应答先重试，仍无应答则沿用原目录、不暂停，下一次定时任务照常更新；无效数据仍暂停', async () => {
  const previous = previousAt(30);
  let attempts = 0;
  const pauses = [];
  const down = client({ fetchImpl: async () => { attempts++; throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, pause: async (ms) => { pauses.push(ms); } });
  const { catalog, report } = await updateComets(previous, { now, http: down });
  assert.equal(attempts, 3, 'retried like a 5xx');
  assert.deepEqual(pauses, [5000, 10000]);
  assert.deepEqual([catalog.status, catalog.blocked, catalog.error, catalog.fetchedAt, catalog.attemptedAt], ['ready', false, null, previous.fetchedAt, iso(now)]);
  assert.deepEqual(catalog.comets, previous.comets);
  assert.equal(report.unreachable, 'cobs.si 暂时无法连接（ENOTFOUND）');
  validateCometCatalog(catalog, now);
  assert.equal(catalogFreshness(catalog, now).paused, false);
  const next = await updateComets(catalog, { now: now + COMET_REFRESH_MS, http: upstream().http });
  assert.deepEqual([next.catalog.status, next.catalog.fetchedAt], ['ready', iso(now + COMET_REFRESH_MS)]);
  // One unanswered request among answered ones is simply retried within the run.
  const flaky = upstream();
  let first = true;
  const http = client({ fetchImpl: async (url, options) => { if (first) { first = false; throw new TypeError('fetch failed'); } return flaky.fetchImpl(url, options); }, pause: async () => {} });
  assert.equal((await updateComets(previous, { now, http })).catalog.fetchedAt, iso(now));
  const garbled = await updateComets(previous, { now, http: client({ fetchImpl: async () => new Response('{', { status: 200 }), pause: async () => {} }) });
  assert.deepEqual([garbled.catalog.status, garbled.catalog.blocked], ['error', true]);
});

test('彗星目录更新：上游失败保留原目录并暂停，请求数有上限', async () => {
  const previous = previousAt(30);
  const failing = upstream({ failCobs: true });
  const { catalog } = await updateComets(previous, { now, http: failing.http });
  assert.deepEqual([catalog.status, catalog.blocked, catalog.fetchedAt, catalog.attemptedAt], ['error', true, previous.fetchedAt, iso(now)]);
  assert.match(catalog.error, /cobs\.si HTTP 500，自动更新已暂停，需维护者检查后手动恢复/);
  assert.deepEqual(catalog.comets, previous.comets);
  validateCometCatalog(catalog, now);
  // A page then shows the previous comets with a paused notice.
  assert.equal(catalogFreshness(catalog, now).paused, true);
  const capped = await updateComets(previous, { now, http: client({ fetchImpl: upstream().fetchImpl, pause: async () => {}, maxRequests: 2 }) });
  assert.match(capped.catalog.error, /上游请求超过 2 次上限/);
  assert.deepEqual(capped.catalog.comets, previous.comets);
});

test('彗星目录校验：重复、越界与状态不一致被拒绝；更新不得丢失回归或时间回退；超过 1 天未更新视为过期', () => {
  const base = previousAt(30);
  assert.throws(() => validateCometCatalog({ ...base, comets: [...base.comets, base.comets[0]] }, now), /重复/);
  assert.throws(() => validateCometCatalog({ ...base, comets: [{ ...base.comets[0], orbit: { ...base.comets[0].orbit, e: 12 } }] }, now), /条目无效/);
  assert.throws(() => validateCometCatalog({ ...base, comets: [{ ...base.comets[0], key: 'X/2000-01-01' }] }, now), /条目无效/);
  assert.throws(() => validateCometCatalog({ ...base, status: 'error' }, now), /状态不一致/);
  assert.doesNotThrow(() => validateCometCatalog(base, now));
  assert.throws(() => validateCometCatalog({ ...base, fetchedAt: iso(now + DAY) }, now), /格式无效/);
  assert.throws(() => assertCatalogProgress(base, { ...base, comets: base.comets.slice(1) }), /丢失 1 次回归/);
  assert.throws(() => assertCatalogProgress(base, previousAt(40)), /回退/);
  assert.doesNotThrow(() => assertCatalogProgress(base, previousAt(2)));
  assert.equal(catalogFreshness(previousAt(23), now).stale, false);
  assert.equal(catalogFreshness(previousAt(25), now).stale, true);
  assert.equal(COMET_STALE_MS, DAY);
  assert.equal(parseElements('no table'), null);
});
