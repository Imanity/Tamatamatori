import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { initialPlan } from '../../src/domain/core/plan.ts';
import { shotFromPlan } from '../../src/domain/shots/shot.ts';
process.env.TMT_UI_MODE = 'desktop';
const h = await import('./harness.mjs');

async function render(t, component) {
  const host = document.createElement('div'); document.body.append(host);
  const root = h.createRoot(host); await act(async () => root.render(component));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return host;
}

test('本地机位存储：等待后端、写入成功才更新，不回退浏览器库；跨实例同步与失败重试', async (t) => {
  const native = globalThis.fetch; t.after(() => { globalThis.fetch = native; });
  const entry = { id: 'one', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), shot: shotFromPlan(initialPlan, '服务器机位') };
  let data = { version: 1, revision: 0, shots: [entry] }, fail = false, writes = 0;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, '/api/shots');
    if (fail) return Response.json({ error: '磁盘不可用' }, { status: 500 });
    if (options.method === 'PUT') { writes++; const next = JSON.parse(options.body); assert.equal(next.revision, data.revision); data = { ...next, revision: data.revision + 1 }; }
    return Response.json(data);
  };
  window.localStorage.clear();
  const { useShotLibrary } = await h.appModule('/src/ui/shots/useShotLibrary.ts');
  let first, second;
  function Pair() { first = useShotLibrary(); second = useShotLibrary(); return createElement('span', null, first.loading ? '读取中' : first.library.shots[0]?.shot.name); }
  await render(t, createElement(Pair));
  await h.waitUntil(() => first.writable && second.writable);
  assert.equal(first.library.shots[0].shot.name, '服务器机位');
  await act(async () => { await first.rename('one', '同步改名'); });
  await h.waitUntil(() => second.library.shots[0]?.shot.name === '同步改名');
  assert.equal(writes, 1); assert.equal(window.localStorage.getItem('tamatamatori.shots.v1'), null);
  fail = true;
  await act(async () => { assert.equal(await first.saveNew(shotFromPlan(initialPlan, '不能假保存')), null); });
  assert.equal(first.library.shots.length, 1); assert.match(first.error, /磁盘不可用/);
  fail = false;
  const backup = JSON.stringify({ format: 'tamatamatori.library', version: 1, shots: [entry, { ...entry, id: 'two' }, { ...entry, id: 'two' }] });
  await act(async () => { assert.equal(await first.importLibrary(backup), true); });
  assert.equal(data.shots.length, 2); assert.equal(data.shots.find((value) => value.id === 'one').shot.name, '同步改名');
});

test('本地聊天 UI：分段 SSE、计划快照、提案不自动应用、保存和停止；模型 HTML 只显示为文字', async (t) => {
  const native = globalThis.fetch; t.after(() => { globalThis.fetch = native; });
  const shot = shotFromPlan(initialPlan, '候选机位');
  let sent, applied, saved, turns = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/agents') return Response.json([{ id: 'codex', available: true, loggedIn: true, message: '已登录' }]);
    if (url === '/api/chats') return Response.json([]);
    if (url === '/api/stop') return Response.json({ stopped: true });
    assert.equal(url, '/api/chat'); sent = JSON.parse(options.body); turns++;
    if (turns > 1) return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(new DOMException('abort', 'AbortError'))); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const payload = [{ type: 'session', id: 'test-id' }, { type: 'delta', text: '月亮候选<img src=x onerror=alert(1)>' }, { type: 'proposal', shot }, { type: 'done' }].map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
    const bytes = new TextEncoder().encode(payload);
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }));
  };
  const { default: LocalChat } = await h.appModule('/src/ui/local/LocalChat.tsx');
  const host = await render(t, createElement(LocalChat, { plan: initialPlan, onApply: (value) => { applied = value; }, onSave: async (value) => { saved = value; return true; } }));
  await h.settle(() => h.button('对话').click());
  await h.waitUntil(() => !h.button('发送').disabled || host.textContent.includes('已登录'));
  await h.settle(() => h.setControl(host.querySelector('textarea'), '找月亮'));
  await h.settle(() => h.button('发送').click());
  await h.waitUntil(() => host.querySelector('.local-proposal'));
  assert.equal(sent.plan.format, 'tamatamatori.shot'); assert.equal(applied, undefined);
  assert.ok(host.textContent.includes('月亮候选<img')); assert.equal(host.querySelector('img'), null);
  await h.settle(() => h.button('保存机位').click()); assert.equal(saved.name, '候选机位');
  await h.settle(() => h.button('应用试看').click()); assert.equal(applied.name, '候选机位');
  await h.settle(() => h.button('对话').click());
  await h.settle(() => h.setControl(host.querySelector('textarea'), '继续'));
  await h.settle(() => h.button('发送').click());
  await h.waitUntil(() => host.textContent.includes('停止'));
  await h.settle(() => h.button('停止').click());
  await h.waitUntil(() => host.querySelector('[role="alert"]')?.textContent.includes('已停止'));
});
