import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initialPlan } from '../src/domain/plan.ts';
import { orbitEpoch, orbitWindow, stationElements, validateOrbitSnapshot, assertOrbitProgress, matchingStations, ORBIT_REFRESH_MS, ORBIT_SOURCE } from '../src/domain/orbit-data.ts';
import { stationPosition, stationScene } from '../src/domain/stations.ts';
import { cachedOrbits, loadOrbits, ORBIT_CACHE_KEY } from '../src/preview/orbit-feed.ts';
import { updateStations } from '../scripts/update-stations.mjs';

const reference = JSON.parse(await readFile(new URL('./fixtures/stations-reference.json', import.meta.url), 'utf8'));
const seed = { version: 1, source: ORBIT_SOURCE, fetchedAt: null, attemptedAt: null, status: 'seed', error: null, blocked: false, objects: reference.elements };
const now = Date.parse('2026-11-06T10:00:00Z');
const ready = { ...seed, status: 'ready', fetchedAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString() };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('ISS/天宫 GP 输入对照独立 C++ SGP4 与 ERFA 地固/地平坐标', () => {
  assert.equal(reference.rows.length, 32);
  for (const row of reference.rows) {
    const element = reference.elements.find((entry) => entry.NORAD_CAT_ID === row.noradId);
    const actual = stationPosition({ ...initialPlan, ...row.observer, instant: row.instant }, element, row.observer.altitude);
    const angle = Math.acos(Math.min(1, actual.direction.reduce((sum, value, index) => sum + value * row.direction[index], 0))) * 180 / Math.PI;
    assert.ok(angle < 0.003, `${row.noradId} angular error ${angle}`);
    assert.ok(Math.abs(actual.rangeKm - row.rangeKm) < 0.01);
    for (const field of ['latitude', 'longitude']) assert.ok(Math.abs(actual[field] - row.subpoint[field]) < 0.001);
    assert.ok(Math.abs(actual.heightKm - row.subpoint.heightKm) < 0.01);
    assert.ok(actual.shadow >= 0 && actual.shadow <= 1);
  }
});

test('历元始终 UTC，拒绝日期溢出、坐标系统和非数轨道，不合并重复目录', () => {
  assert.equal(orbitEpoch('2026-11-05T20:28:36.809184'), Date.parse('2026-11-05T20:28:36.809184Z'));
  for (const epoch of ['2026-02-30T00:00:00', '2026-11-05', '2026-11-05T00:00:00+09:00']) assert.throws(() => orbitEpoch(epoch));
  for (const patch of [{ BSTAR: null }, { MEAN_MOTION: '15' }, { ECCENTRICITY: 2 }, { REF_FRAME: 'J2000' }, { TIME_SYSTEM: 'TAI' }, { INCLINATION: NaN }])
    assert.throws(() => stationElements([{ ...seed.objects[0], ...patch }]));
  assert.throws(() => stationElements([seed.objects[0], seed.objects[0]]));
  assert.throws(() => validateOrbitSnapshot({ ...ready, fetchedAt: '2027-01-01T00:00:00Z' }, now));
  assert.throws(() => validateOrbitSnapshot({ ...ready, fetchedAt: undefined }, now));
  assert.throws(() => validateOrbitSnapshot({ ...ready, source: 'https://invalid.example/' }, now));
  assert.equal(validateOrbitSnapshot(seed, now).objects.length, 2);
});

test('24/72 小时边界对历史和未来一致，过期仍显示原因并停止所有绘制', () => {
  for (const sign of [-1, 1]) {
    for (const [hours, state] of [[24, 'current'], [24.001, 'warning'], [72, 'warning'], [72.001, 'expired']]) {
      assert.equal(orbitWindow('2026-11-06T00:00:00Z', new Date(Date.parse('2026-11-06T00:00:00Z') + hours * sign * 3_600_000).toISOString()).state, state);
    }
  }
  const expired = stationScene({ ...initialPlan, instant: '2027-01-01T00:00:00Z' }, seed);
  assert.equal(expired.points.length, 0); assert.equal(expired.trail.length, 0);
  assert.ok(expired.rows.every((row) => /停止绘制/.test(row.message)));
  assert.equal(stationScene(initialPlan, null).rows.length, 2);
  assert.equal(stationScene(initialPlan, { ...seed, objects: seed.objects.slice(0, 1) }).rows[1].point, undefined);
});

test('短轨迹采样与主标记分开，实际高度改变视线，机位/时间/轨道更新改变版本', () => {
  const plan = { ...initialPlan, instant: '2026-11-06T00:00:00Z' };
  const scene = stationScene(plan, seed, 1000);
  assert.equal(scene.points.length, 2); assert.equal(scene.trail.length, 72);
  assert.ok(scene.trail.every((point) => point.name === undefined && Number.isFinite(point.elevation)));
  assert.notDeepEqual(scene.points[0].direction, stationScene(plan, seed, 0).points[0].direction);
  assert.notEqual(scene.key, stationScene({ ...plan, instant: '2026-11-06T00:00:10Z' }, seed, 1000).key);
  assert.notEqual(scene.key, stationScene(plan, { ...seed, objects: [{ ...seed.objects[0], MEAN_ANOMALY: 10 }] }, 1000).key);
  assert.throws(() => stationPosition({ ...plan, latitude: 91 }, seed.objects[0]));
});

test('同源快照验证、缓存损坏、超时/取消与上游回退保留边界', async () => {
  assert.equal(cachedOrbits({ getItem: () => '{' }), null);
  assert.equal(cachedOrbits({ getItem: (key) => { assert.equal(key, ORBIT_CACHE_KEY); return JSON.stringify(seed); } }).objects.length, 2);
  const controller = new AbortController();
  const next = await loadOrbits('/Tamatamatori/orbits/stations.json', controller.signal, null, async (url, options) => {
    assert.equal(url, '/Tamatamatori/orbits/stations.json'); assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-cache'); return response(seed);
  });
  assert.equal(next.objects.length, 2);
  await assert.rejects(loadOrbits('/feed', controller.signal, null, async () => response({}, 503)), /503/);
  await assert.rejects(loadOrbits('/feed', controller.signal, null, async () => response({})), /无效/);
  const older = { ...seed, objects: [{ ...seed.objects[0], EPOCH: '2026-10-01T00:00:00' }] };
  assert.throws(() => assertOrbitProgress(seed, older), /历元回退/);
  assert.throws(() => assertOrbitProgress(ready, seed), /回退/);
  controller.abort();
  await assert.rejects(loadOrbits('/feed', controller.signal, seed, async (_url, options) => { options.signal.throwIfAborted(); }), /aborted/i);
});

test('上游检查遵守两小时冷却，先保存尝试，再进行唯一下载', async () => {
  let calls = 0, saved = false;
  const fetchImpl = async (_url, options) => { assert.ok(saved); assert.equal(options.redirect, 'manual'); calls++; return response(seed.objects); };
  const skipped = await updateStations(ready, { now: now + ORBIT_REFRESH_MS - 1, fetchImpl });
  assert.equal(skipped, ready); assert.equal(calls, 0);
  const updated = await updateStations(ready, { now: now + ORBIT_REFRESH_MS, fetchImpl, saveAttempt: async (data) => {
    saved = true; assert.equal(data.blocked, true); assert.equal(data.fetchedAt, ready.fetchedAt);
  } });
  assert.equal(calls, 1); assert.equal(updated.status, 'ready');
  assert.equal(updated.objects[0].EPOCH, ready.objects[0].EPOCH);
  assert.notEqual(updated.fetchedAt, ready.fetchedAt);
});

test('上游 HTTP/无效数据失败暂停，后续任务不重试，手动恢复仍受冷却限制', async () => {
  for (const status of [301, 403, 404, 500]) {
    let calls = 0;
    const failed = await updateStations(ready, { now: now + ORBIT_REFRESH_MS, fetchImpl: async () => { calls++; return response({}, status); } });
    assert.equal(calls, 1); assert.equal(failed.blocked, true); assert.equal(failed.fetchedAt, ready.fetchedAt);
    assert.deepEqual(failed.objects, ready.objects); assert.match(failed.error, new RegExp(String(status)));
    assert.equal(await updateStations(failed, { now: now + ORBIT_REFRESH_MS * 5, fetchImpl: async () => { throw new Error('must not retry'); } }), failed);
    assert.equal(await updateStations(failed, { now: now + ORBIT_REFRESH_MS + 1, resume: true, fetchImpl: async () => { throw new Error('must cool down'); } }), failed);
    const recovered = await updateStations(failed, { now: now + ORBIT_REFRESH_MS * 2, resume: true, fetchImpl: async () => response(seed.objects) });
    assert.equal(recovered.status, 'ready'); assert.equal(recovered.blocked, false);
  }
  for (const objects of [[], [{ ...seed.objects[0], MEAN_MOTION: null }]]) {
    const failed = await updateStations(ready, { now: now + ORBIT_REFRESH_MS, fetchImpl: async () => response(objects) });
    assert.equal(failed.status, 'error'); assert.equal(failed.blocked, true);
  }
});

test('上游历元早于已发布版本或缺少某站时保留较新的轨道并记录说明，不暂停，下一次检查照常更新', async () => {
  const [iss, css] = ready.objects;
  // 2026-11-07: upstream served ISS with an epoch older than the published one; this paused every update for days.
  const regressed = await updateStations(ready, { now: now + ORBIT_REFRESH_MS, fetchImpl: async () => response([{ ...iss, EPOCH: '2026-11-04T09:00:00.000000' }, css]) });
  assert.deepEqual([regressed.status, regressed.blocked, regressed.error], ['ready', false, null]);
  assert.notEqual(regressed.fetchedAt, ready.fetchedAt);
  assert.deepEqual(regressed.objects, [iss, css]);
  assert.match(regressed.notice, /国际空间站 ISS 上游历元 2026-11-04T09:00:00\.000000 早于已发布的 2026-11-05T20:28:36\.809184，保留较新的轨道/);
  // The next scheduled check runs without a manual resume and takes a newer epoch.
  const newer = { ...iss, EPOCH: '2026-11-06T09:00:00.000000', MEAN_ANOMALY: 12.5 };
  const later = await updateStations(regressed, { now: now + ORBIT_REFRESH_MS * 2, fetchImpl: async () => response([newer, css]) });
  assert.deepEqual([later.status, later.blocked, later.notice], ['ready', false, null]);
  assert.deepEqual(later.objects, [newer, css]);
  // A station missing from one response keeps its published element.
  const partial = await updateStations(later, { now: now + ORBIT_REFRESH_MS * 3, fetchImpl: async () => response([newer]) });
  assert.equal(partial.status, 'ready');
  assert.deepEqual(partial.objects, [newer, css]);
  assert.match(partial.notice, /天宫空间站 本次上游缺少轨道，保留已发布的历元/);
  // Published snapshots still never move backwards.
  assert.doesNotThrow(() => assertOrbitProgress(ready, regressed));
  assert.equal(validateOrbitSnapshot(regressed, now + ORBIT_REFRESH_MS).notice, regressed.notice);
  assert.throws(() => validateOrbitSnapshot({ ...regressed, notice: 3 }), /格式或来源无效/);
});

test('空间站搜索匹配中文、CSS/ISS 和 NORAD，轨道 workflow 仅发布任务请求上游', async () => {
  for (const query of ['ISS', '国际空间站', '２５５４４', 'ZARYA']) assert.equal(matchingStations(query)[0].noradId, 25544);
  for (const query of ['天宫', '天和', 'CSS', '48274', 'Tiangong']) assert.equal(matchingStations(query)[0].noradId, 48274);
  assert.equal(matchingStations('').length, 0); assert.equal(matchingStations('空间站').length, 2);
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /23 \*\/3 \* \* \*/);
  assert.match(workflow, /matrix.node-version == '24'.*github.event_name != 'pull_request'.*PAGES_ENABLED/);
  assert.match(workflow, /actions\/cache\/restore@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/cache\/save@[0-9a-f]{40}/);
});
