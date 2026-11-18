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
  await act(async () => { assert.equal(await first.saveMany([shotFromPlan(initialPlan, '批量失败甲'), shotFromPlan(initialPlan, '批量失败乙')]), null); });
  assert.equal(first.library.shots.length, 1); assert.match(first.error, /磁盘不可用/);
  fail = false;
  const backup = JSON.stringify({ format: 'tamatamatori.library', version: 1, shots: [entry, { ...entry, id: 'two' }, { ...entry, id: 'two' }] });
  await act(async () => { assert.equal(await first.importLibrary(backup), true); });
  assert.equal(data.shots.length, 2); assert.equal(data.shots.find((value) => value.id === 'one').shot.name, '同步改名');
  const before = writes;
  await act(async () => { assert.equal((await first.saveMany([shotFromPlan(initialPlan, '批量甲'), shotFromPlan(initialPlan, '批量乙')])).length, 2); });
  assert.equal(writes, before + 1, '批量保存只提交一次，不逐个造成部分写入');
});

test('聊天多机位分组：分页、截断提示、选择批量保存和独立应用', async t => {
  const { ChatResults } = await h.appModule('/src/ui/local/ChatResults.tsx');
  const shots = Array.from({length:12},(_,index)=>shotFromPlan(initialPlan,`独立 ${index}`));
  let saved, applied;
  const host = await render(t,createElement(ChatResults,{result:{kind:'shots',id:'many',shots,total:20},
    onApply:shot=>{applied=shot;},onSave:async()=>true,onSaveMany:async values=>{saved=values;return true;}}));
  assert.equal(host.querySelectorAll('.local-proposal').length,10);
  assert.match(host.textContent,/共 20 个结果，本轮显示 12 个/);
  await h.settle(()=>host.querySelector('input[type="checkbox"]').click());
  await h.settle(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='保存所选（11）').click());
  assert.equal(saved.length,11); assert.equal(saved[0].name,'独立 1');
  await h.settle(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='下一页').click());
  assert.equal(host.querySelectorAll('.local-proposal').length,2);
  await h.settle(()=>host.querySelector('.local-proposal button').click()); assert.equal(applied.name,'独立 10');
});

test('聊天区间保留起止和精确最佳秒，滑杆选择的时刻与应用、保存一致；地图入口传完整解', async t => {
  const { ChatResults } = await h.appModule('/src/ui/local/ChatResults.tsx');
  const { windowItem } = await import('../../src/domain/solve/composition.ts');
  const start = Date.parse('2027-02-12T07:21:10Z'), end = start + 200_000, best = start + 100_000;
  const base=shotFromPlan({...initialPlan,timeZone:'Asia/Tokyo',followLocalZone:false});
  const { prepare } = await import('../../scripts/lib/solve-run.mjs');
  const result={kind:'solve',id:'interval',base,shape:'windows',total:1,blocked:0,filtered:0,missing:0,merged:0,extraMissed:0,rings:[],sectors:[],note:'',
    request:prepare({format:'tamatamatori.solve',version:2,name:'区间',targets:[{type:'body',body:'sun'}],camera:{mode:'fixed',aim:{azimuth:244.63,pitch:10.74}}}).request,
    items:[windowItem({start,end,best,deviation:0},initialPlan,{azimuth:244.63,pitch:10.74},'2027-02-12')]};
  let applied,saved,opened;
  const host=await render(t,createElement(ChatResults,{result,onApply:shot=>{applied=shot;},onSave:async shot=>{saved=shot;return true;},onOpen:value=>{opened=value;}}));
  assert.match(host.textContent,/16:21:10.*16:24:30/s); assert.match(host.textContent,/16:22:50/);
  const slider=host.querySelector('input[type="range"]');
  await h.settle(()=>h.setControl(slider,slider.max));
  await h.settle(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='应用所选机位').click());
  await h.settle(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='保存所选机位').click());
  assert.equal(Date.parse(applied.time.instant),end); assert.equal(saved.time.instant,applied.time.instant);
  await h.settle(()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='在地图与时间轴查看').click());
  assert.equal(opened.items[0].start,start); assert.equal(opened.items[0].end,end);
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

test('聊天机位线直接载入推算：地图完整线段、时间轴起止、移动机位与返回，不重新搜索', async t => {
  const { useState } = await import('react');
  const { useComposition } = await h.appModule('/src/ui/solve/useComposition.ts');
  const module = await h.appModule('/src/ui/solve/solve-module.ts');
  const { prepare } = await import('../../scripts/lib/solve-run.mjs');
  const { windowItem } = await import('../../src/domain/solve/composition.ts');
  const now = {...initialPlan,timeZone:'Asia/Tokyo',followLocalZone:false};
  const request={format:'tamatamatori.solve',version:2,targets:[{type:'ground',landmark:'tokyo-skytree'},{type:'body',body:'moon'}],
    camera:{mode:'free',maxDistance:30000},time:{mode:'range',date:'2026-11-25',days:1},timeZone:'Asia/Tokyo'};
  const prepared=prepare(request,{shotPlan:now});
  const start=Date.parse('2026-11-25T08:00Z');
  const item=windowItem({start,end:start+60000,best:start,deviation:0},now,{azimuth:90,pitch:5},'2026-11-25');
  item.points=[0,1].map(index=>({time:start+index*60000,latitude:35.7+index*.001,longitude:139.8,azimuth:90,elevation:5,
    cameraGround:10,distance:5000+index*100,residual:0,sight:'clear'}));
  item.camera={latitude:35.7,longitude:139.8};item.near=5000;item.far=5100;item.bearing=90;
  const result={kind:'solve',id:'line',base:shotFromPlan(prepared.plan),request:prepared.request,shape:'lines',total:1,items:[item],
    blocked:0,filtered:0,missing:0,merged:0,extraMissed:0,rings:[],sectors:[],note:''};
  let state,current;
  function Holder(){const [plan,setPlan]=useState(prepared.plan);current=plan;state=useComposition(plan,patch=>setPlan(value=>({...value,...patch})),true,0,module);return null;}
  await render(t,createElement(Holder));
  await act(async()=>state.loadResults(result,prepared.plan));
  assert.equal(state.run.phase,'done');assert.equal(state.stale,false); assert.equal(state.events.length,2);
  const geometry=module.compositionGeometry(state,prepared.plan.timeZone);
  const segment=geometry.features.find(feature=>feature.properties.kind==='segment');
  assert.equal(segment.geometry.coordinates.length,2);
  await act(async()=>state.tryOut(state.items[0],start+60000));
  assert.equal(Date.parse(current.instant),start+60000);assert.equal(current.latitude,35.701);
  assert.equal(state.canRestore,true);
  await act(async()=>state.restore());assert.equal(current.latitude,prepared.plan.latitude);
});
