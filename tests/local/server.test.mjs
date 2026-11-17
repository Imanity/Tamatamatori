import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createLocalApp } from '../../server/app.mjs';
import { ShotStore, lockDirectory } from '../../server/shot-store.mjs';
import { executeTool } from '../../server/tools.mjs';
import { initialPlan } from '../../src/domain/core/plan.ts';
import { shotFromPlan } from '../../src/domain/shots/shot.ts';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tmt-local-'));
  const dataDir = join(directory, 'data'), distDir = join(directory, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<html>local</html>');
  const app = createLocalApp({ dataDir, distDir, ...options });
  await new Promise((yes) => app.server.listen(0, '127.0.0.1', yes));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const home = await fetch(base), cookie = home.headers.get('set-cookie').split(';')[0];
  const request = (path, value, method = value ? 'POST' : 'GET') => fetch(base + path, { method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
  t.after(async () => {
    await app.stop(); app.server.closeAllConnections(); await new Promise((yes) => app.server.close(yes));
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('tmt-local-'));
    await rm(target, { recursive: true, force: true });
  });
  return { ...app, directory, dataDir, base, cookie, request };
}
const shot = () => shotFromPlan(initialPlan, '富士山');
const entry = (id = 'one') => ({ id, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', shot: shot() });

test('本地文件库：持久化、备份、版本冲突与并发保存不丢失更新', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.store.read()).revision, 0);
  const results = await Promise.allSettled([app.store.save({ version: 1, revision: 0, shots: [entry()] }), app.store.save({ version: 1, revision: 0, shots: [entry('two')] })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  await app.store.save({ version: 1, revision: 1, shots: [] });
  assert.equal(JSON.parse(await readFile(join(app.dataDir, 'shots.json.bak'), 'utf8')).shots[0].id, 'one');
  assert.deepEqual(await new ShotStore(app.dataDir).read(), { version: 1, revision: 2, shots: [] });
});

test('本地文件库损坏时不覆盖原件；保留无法读取的条目', async (t) => {
  const app = await fixture(t);
  await app.store.save({ version: 1, revision: 0, shots: [{ broken: '保留' }] });
  assert.deepEqual((await app.store.read()).shots, [{ broken: '保留' }]);
  await writeFile(app.store.file, '{damaged');
  await assert.rejects(app.store.save({ version: 1, revision: 1, shots: [] }), /停止覆盖/);
  assert.equal(await readFile(app.store.file, 'utf8'), '{damaged');
});

test('本地数据目录排他锁不接管仍运行的进程', async (t) => {
  const app = await fixture(t), release = await lockDirectory(app.dataDir);
  await assert.rejects(lockDirectory(app.dataDir), /已有本地服务/);
  await release(); const again = await lockDirectory(app.dataDir); await again();
});

test('本地 HTTP：同源会话、Host 与 CSRF 校验；不向 Pages 开放后端', async (t) => {
  const app = await fixture(t);
  assert.equal((await fetch(app.base + '/api/shots')).status, 401);
  assert.equal((await fetch(app.base + '/api/shots', { headers: { Cookie: app.cookie, Origin: 'https://imanity.github.io' } })).status, 403);
  assert.equal((await fetch(app.base + '/api/shots', { method: 'PUT', headers: { Cookie: app.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(app.base + '/api/capabilities', { headers: { Cookie: 'tmt_local=' + 'x'.repeat(64) } })).status, 401);
  assert.equal((await app.request('/api/capabilities')).status, 200);
  const saved = await app.request('/api/shots', { version: 1, revision: 0, shots: [entry()] }, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal((await app.request('/api/shots', { version: 1, revision: 0, shots: [] }, 'PUT')).status, 409);
  assert.equal((await (await app.request('/api/shots')).json()).shots[0].shot.name, '富士山');
  assert.equal((await app.request('/api/tools', { name: 'current_plan' })).status, 403);
});

test('本地聊天完整替身链路：工具读取计划、提出机位、流式输出、继续和记录持久化', async (t) => {
  const agent = async ({ session, url, token, emit, signal }) => {
    assert.equal(signal.aborted, false);
    const call = async (name, args = {}) => {
      const response = await fetch(url + '/api/tools', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: session.id, name, arguments: args }) });
      return response.json();
    };
    const current = await call('current_plan'); assert.equal(current.structuredContent.name, '富士山');
    const unauthorized = await fetch(url + '/api/shots', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, revision: 0, shots: [] }) });
    assert.equal(unauthorized.status, 401, 'Agent 工具令牌不能直接改机位文件');
    await call('propose', { shot: shot() });
    session.nativeId = 'native-test-session'; emit({ type: 'delta', text: '找到一个候选' });
  };
  const app = await fixture(t, { agent });
  const response = await app.request('/api/chat', { provider: 'codex', message: '月亮在山顶', plan: shot() });
  const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const id = events.find((event) => event.type === 'session').id;
  assert.ok(events.some((event) => event.type === 'proposal'));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.equal((await app.store.read()).shots.length, 0, '工具提案不直接写机位库');
  const chat = await (await app.request('/api/chats/' + id)).json();
  assert.equal(chat.nativeId, 'native-test-session'); assert.equal(chat.messages[1].text, '找到一个候选');
  assert.equal((await app.request('/api/chat', { provider: 'claude', id, message: '继续', plan: shot() })).status, 400);
  const continued = await app.request('/api/chat', { provider: 'codex', id, message: '继续', plan: shot() });
  assert.equal(continued.status, 200); await continued.text();
});

test('本地聊天取消会传到 Agent，未完成对话不会误报完成', async (t) => {
  let aborted = false;
  const app = await fixture(t, { turnTimeout: 50, agent: async ({ signal }) => new Promise((_, no) => signal.addEventListener('abort', () => { aborted = true; no(new Error('cancel')); }, { once: true })) });
  const text = await (await app.request('/api/chat', { provider: 'codex', message: '测试停止', plan: shot() })).text();
  assert.ok(aborted); assert.match(text, /已停止/); assert.doesNotMatch(text, /"type":"done"/);
});

test('本地摄影工具拒绝未知工具、错误机位和读取不存在条目', async (t) => {
  const app = await fixture(t), chat = { plan: shot() }, signal = new AbortController().signal;
  await assert.rejects(executeTool({ name: 'shell' }, chat, app.store, () => {}, signal), /未开放/);
  await assert.rejects(executeTool({ name: 'propose', arguments: { shot: {} } }, chat, app.store, () => {}, signal));
  await assert.rejects(executeTool({ name: 'get_shot', arguments: { id: '../secret' } }, chat, app.store, () => {}, signal), /找不到/);
  const result = await executeTool({ name: 'validate_request', arguments: { request: {} } }, chat, app.store, () => {}, signal);
  assert.ok(result.structuredContent);
});

test('本地推算 Worker 运行真实求解器并生成可校验候选（固定朝向，不读取地形）', async (t) => {
  const app = await fixture(t), events = [];
  const request = { format: 'tamatamatori.solve', version: 2,
    lens: { focalLength: 400, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
    targets: [{ type: 'body', body: 'sun' }], camera: { mode: 'fixed', aim: { azimuth: 244.63, pitch: 10.74 } },
    time: { mode: 'range', date: '2026-11-04', days: 365 }, timeZone: 'Asia/Tokyo' };
  const result = await executeTool({ name: 'solve', arguments: { request, maxResults: 1 } }, { plan: shot() }, app.store, (event) => events.push(event), new AbortController().signal);
  assert.equal(result.structuredContent.format, 'tamatamatori.solve-result');
  assert.ok(result.structuredContent.results.length > 0);
  assert.equal(result.structuredContent.terrainReads.length, 0);
  assert.equal(events.filter((event) => event.type === 'proposal').length, 1);
});
