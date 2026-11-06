import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORBIT_SOURCE, ORBIT_REFRESH_MS, stationElements, validateOrbitSnapshot, assertOrbitProgress } from '../src/domain/orbit-data.ts';

export async function updateStations(previous, { now = Date.now(), fetchImpl = fetch, resume = false, saveAttempt = async () => {} } = {}) {
  const lastAttempt = Date.parse(previous.attemptedAt ?? '');
  if (now - lastAttempt < ORBIT_REFRESH_MS || (previous.blocked && !resume)) return previous;
  const attemptedAt = new Date(now).toISOString();
  // Persist before I/O so interrupted jobs do not forget an upstream request.
  const pending = { ...previous, attemptedAt, status: 'error', blocked: true, error: '上游检查未完成，自动更新已暂停' };
  await saveAttempt(pending);
  try {
    const response = await fetchImpl(ORBIT_SOURCE, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
    if (response.status !== 200) throw new Error(`上游 HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error('轨道响应超出大小限制');
    const objects = stationElements(JSON.parse(text));
    if (!objects.length) throw new Error('上游未提供所选空间站的轨道');
    const next = validateOrbitSnapshot({ version: 1, source: ORBIT_SOURCE, status: 'ready', fetchedAt: attemptedAt, attemptedAt, error: null, blocked: false, objects }, now);
    assertOrbitProgress(previous, next);
    return next;
  } catch (error) {
    return { ...pending, error: `${error instanceof Error ? error.message : '轨道响应无效'}，自动更新已暂停，需维护者检查后手动恢复` };
  }
}

async function writeSnapshot(path, snapshot) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n');
  await rename(temporary, path);
}

async function main() {
  const output = resolve('public/orbits/stations.json'), cache = resolve('.cache/station-feed.json');
  const candidates = [];
  for (const path of [output, cache]) {
    try { candidates.push(validateOrbitSnapshot(JSON.parse(await readFile(path, 'utf8')))); }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`忽略无效轨道缓存 ${path}`); }
  }
  // Cache eviction must not immediately repeat a recent published request.
  if (process.env.CI && /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '')) {
    const [owner, repository] = process.env.GITHUB_REPOSITORY.split('/');
    try {
      const response = await fetch(`https://${owner}.github.io/${repository}/orbits/stations.json`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) candidates.push(validateOrbitSnapshot(await response.json()));
    } catch { console.warn('已发布快照暂不可读，使用本次持久缓存'); }
  }
  candidates.sort((a, b) => Date.parse(b.attemptedAt ?? '1970-01-01Z') - Date.parse(a.attemptedAt ?? '1970-01-01Z'));
  const previous = candidates[0];
  if (!previous) throw new Error('缺少有效的初始轨道快照');
  const next = await updateStations(previous, {
    resume: process.argv.includes('--resume'),
    saveAttempt: async (snapshot) => { await writeSnapshot(cache, snapshot); },
  });
  await writeSnapshot(cache, next);
  await writeSnapshot(output, next);
  console.log(JSON.stringify({ status: next.status, fetchedAt: next.fetchedAt, attemptedAt: next.attemptedAt, objects: next.objects.length }));
  if (next.error) {
    const message = next.error.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.warn(`::warning::${message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
