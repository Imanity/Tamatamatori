// Workspace interaction tests: layout, layer groups, buildings, light pollution and weather. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { act } from "react";
import { weatherResponse } from "../fixtures/weather.mjs";
import { parseWeather, WEATHER_TTL } from "../../src/domain/environment/weather.ts";
import { ellipsoidalRay } from "../../src/domain/core/geodesy.ts";
import { stubs, TestCelestialLayer, TestStarfieldLayer, dom, weatherRequests, pollutionRequests, terrainSize, resizeObservers, groundRequests, settle, workspace, input, setShootingDateTime, value, button, setControl, geometry, waitUntil, terrainMap, readyTerrain } from "./harness.mjs";

test('精简工作区：没有左栏，图层开关位于分组标题，光照与环境默认展开，分组随开关展开与折叠', async t => {
  await workspace(t); const map = await readyTerrain(), requests = groundRequests.length;
  // Map and preview side by side, the preview wider; no separate parameter panel.
  const layout = document.querySelector('.workgrid');
  assert.equal(layout.dataset.order, 'map-first');
  assert.equal(layout.style.getPropertyValue('--first-track'), '36fr');
  assert.equal(layout.style.getPropertyValue('--second-track'), '64fr');
  assert.equal(document.querySelector('[aria-label="调整地图与预览宽度"]').getAttribute('aria-valuenow'), '36');
  assert.equal(document.querySelector('[aria-label="调整面板高度"]'), null);
  for (const selector of ['.workspace-heading', '.workspace-footer', '.base-layer', '.sidebar-bottom', '.layer-hint', '.map-footer-note', '.viewfinder-label', '.viewfinder-focal', '.terrain-height', '.parameter-note', '.info-header', '.layer-settings', '[aria-label$="设置与信息"]'])
    assert.equal(document.querySelector(selector), null, selector);
  const groups = [...document.querySelectorAll('.info-group h2 button')];
  assert.deepEqual(groups.map(group => group.id), ['info-global', 'info-buildings', 'info-sun', 'info-moon', 'info-stars', 'info-milkyWay', 'info-deepSky', 'info-stations', 'info-meteors', 'info-comets', 'info-aurora', 'info-tides']);
  // No left rail: each layer switch sits in its group's heading row.
  assert.equal(document.querySelector('aside.sidebar'), null);
  for (const [id, name] of [['buildings', '建筑'], ['sun', '太阳'], ['moon', '月亮'], ['stars', '星空'], ['milkyWay', '银河'], ['deepSky', '深空天体'], ['stations', '空间站'], ['meteors', '流星雨'], ['comets', '彗星'], ['aurora', '极光'], ['tides', '潮汐']])
    assert.ok(document.querySelector(`[aria-label="显示${name}"]`).closest(`.info-group[data-info-group="${id}"] .info-group-header`), id);
  assert.equal(document.querySelector('.info-group[data-info-group="global"] .info-group-switch'), null);
  assert.equal(document.querySelector('#info-global').textContent.includes('光照与环境'), true);
  // The first group is open; layer groups start in step with their switches.
  const expanded = () => Object.fromEntries([...document.querySelectorAll('.info-group h2 button')].map(group => [group.id.slice(5), group.getAttribute('aria-expanded') === 'true']));
  assert.deepEqual(expanded(), { global: true, buildings: false, sun: true, moon: true, stars: false, milkyWay: false, deepSky: false, stations: false, meteors: false, comets: false, aurora: false, tides: false });
  assert.equal(document.querySelector('#info-sun-body').hidden, false);
  assert.equal(document.querySelector('#info-sun-body [data-body-status="moon"]'), null);
  const global = document.querySelector('#info-global-body').textContent;
  assert.match(global, /方位.*水平视场/s); assert.match(global, /太阳高度/);
  for (const debug of [/曲面构图/, /高程基准/, /World Atlas/, /格网/, /几何高度/, /月光参考/, /明暗近似/])
    assert.doesNotMatch(global, debug);
  const moon = document.querySelector('[aria-label="显示月亮"]'), search = () => document.querySelector('#target-search');
  const collapsed = () => document.querySelector('.info-sidebar').classList.contains('is-collapsed');
  // Turning a layer off collapses its group without moving focus.
  moon.focus(); await settle(() => moon.click());
  assert.equal(moon.checked, false); assert.equal(expanded().moon, false); assert.equal(document.activeElement, moon);
  // Turning it on clears the search, reopens the rail and expands the group.
  await settle(() => setControl(search(), 'Vega'));
  await settle(() => document.querySelector('[aria-label="收起图层与信息"]').click());
  await settle(() => moon.click());
  assert.equal(search().value, ''); assert.equal(collapsed(), false);
  assert.equal(expanded().moon, true); assert.equal(document.activeElement, moon);
  // Turning it off leaves the search and a collapsed rail alone.
  await settle(() => setControl(search(), 'Vega'));
  await settle(() => document.querySelector('[aria-label="收起图层与信息"]').click());
  await settle(() => moon.click());
  assert.equal(search().value, 'Vega'); assert.equal(collapsed(), true);
  await settle(() => document.querySelector('[aria-label="展开图层与信息"]').click());
  await settle(() => setControl(search(), ''));
  assert.equal(expanded().moon, false);
  await settle(() => moon.click()); assert.equal(expanded().moon, true);
  // Group headers still collapse or expand by hand without changing the layer.
  await settle(() => document.querySelector('#info-moon').click());
  assert.equal(expanded().moon, false); assert.equal(moon.checked, true);
  await settle(() => document.querySelector('#info-global').click());
  assert.equal(expanded().global, false);
  assert.equal(terrainMap(), map); assert.equal(groundRequests.length, requests);
});

test('建筑入口联动右栏、转向调焦复用几何，失败独立重试且不重建 DEM', async t => {
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  const toggle=document.querySelector('[aria-label="显示建筑"]');assert.equal(toggle.checked,false);
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'false');
  await settle(()=>toggle.click());
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'true');
  const layer=map.customLayers.find(l=>l.id==='preview-buildings');
  assert.equal(document.querySelector('.building-readout').dataset.buildingPhase,'ready');
  const loads=layer.loads;
  await settle(()=>setControl(input('焦距'),85));
  assert.equal(layer.loads,loads);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  await settle(()=>layer.report({...layer.status,phase:'error',message:'测试建筑请求失败'}));
  assert.match(document.querySelector('.building-readout').textContent,/建筑未应用.*测试建筑请求失败/s);
  assert.equal(document.querySelector('.terrain-feedback-error'),null);
  await settle(()=>[...document.querySelectorAll('.building-readout button')].find(b=>b.textContent==='重新读取建筑').click());
  assert.equal(layer.loads,loads+1);assert.equal(document.querySelector('.building-readout').dataset.buildingPhase,'ready');
  await settle(()=>toggle.click());assert.equal(document.querySelector('.building-readout').dataset.buildingPhase,'off');
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'false');
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('分组标题的图层开关开启时就地展开、不滚动信息栏也不移动焦点，关闭即折叠', async t => {
  await workspace(t); await readyTerrain();
  const body = document.querySelector('.info-body'), scrolls = [];
  body.scrollTo = (options) => scrolls.push(options);
  body.scrollTop = 120;
  for (const [id, name] of [['stars', '星空'], ['milkyWay', '银河'], ['comets', '彗星']]) {
    const toggle = document.querySelector(`[aria-label="显示${name}"]`);
    toggle.focus();
    await settle(() => toggle.click());
    assert.equal(document.querySelector(`#info-${id}`).getAttribute('aria-expanded'), 'true', id);
    assert.equal(document.activeElement, toggle);
    await act(async () => { await delay(30); });
    await settle(() => toggle.click());
    assert.equal(document.querySelector(`#info-${id}`).getAttribute('aria-expanded'), 'false', id);
  }
  assert.deepEqual(scrolls, []);
  assert.equal(body.scrollTop, 120);
});

test('建筑分组显示加载进度、范围与精模朝向，不显示缓存和调试计数', async t => {
  await workspace(t);
  const catalog=JSON.parse(readFileSync(new URL('../../src/data/landmarks.generated.json', import.meta.url),'utf8'));
  const skytree=catalog.find(target=>target.id==='tokyo-skytree');
  const longitude=Number((skytree.longitude-0.05).toFixed(4)),latitude=Number(skytree.latitude.toFixed(4));
  await settle(()=>setControl(input('经度'),longitude));await settle(()=>setControl(input('纬度'),latitude));
  const map=await readyTerrain();
  await settle(()=>document.querySelector('[aria-label="显示建筑"]').click());
  assert.equal(document.querySelector('#info-buildings').getAttribute('aria-expanded'),'true');
  const layer=map.customLayers.find(l=>l.id==='preview-buildings'),readout=()=>document.querySelector('.building-readout');
  await settle(()=>layer.report({...layer.status,phase:'loading',progress:{stage:'tiles',done:12,total:48}}));
  const bar=readout().querySelector('progress');assert.equal(bar.value,12);assert.equal(bar.max,48);
  assert.match(readout().textContent,/读取 OSM 建筑 25%/);
  assert.match(readout().querySelector('[data-landmark-id="tokyo-skytree"]').textContent,/加载中/);
  await settle(()=>layer.report({...layer.status,phase:'ready',progress:undefined,coverage:3200,candidates:500,polygons:200,
    landmarks:[{id:'tokyo-skytree',phase:'applied',distance:4500,ground:5,triangles:88581,message:''},{id:'tokyo-tower',phase:'fallback',reason:'budget',distance:9000,message:''}]}));
  const text=readout().textContent;
  assert.equal(readout().querySelector('progress'),null);
  assert.match(text,/约 3\.2 km 内（已达瓦片数量上限）/);assert.match(text,/已省略 300 个/);assert.match(text,/已加载 1 \/ 2/);
  assert.match(readout().querySelector('[data-landmark-id="tokyo-skytree"]').textContent,/已加载/);
  assert.match(readout().querySelector('[data-landmark-id="tokyo-tower"]').textContent,/超出绘制上限/);
  for(const debug of [/已读取瓦片/,/三角面/,/来源版本/,/本次载入/,/分块体块/,/test-fixture/])assert.doesNotMatch(text,debug);
  await settle(()=>document.querySelector(`[aria-label="朝向${skytree.name}"]`).click());
  const [east,north,up]=ellipsoidalRay({longitude,latitude,ellipsoidalHeight:1001.6},{longitude:skytree.longitude,latitude:skytree.latitude,ellipsoidalHeight:5+skytree.bounds.height/2});
  assert.ok(Math.abs(value('方位角')-(Math.atan2(east,north)*180/Math.PI+360)%360)<0.06,`方位 ${value('方位角')}`);
  assert.ok(Math.abs(value('俯仰角')-Math.atan2(up,Math.hypot(east,north))*180/Math.PI)<0.06,`俯仰 ${value('俯仰角')}`);
  for(const removed of [/缓存/,/清理/])assert.doesNotMatch(readout().textContent,removed);
});

test('星座和银河子设置位于右栏；镜头与时间在预览下方，坐标、方向与高度在地图下方，不再有参数栏', async t => {
  await workspace(t); await readyTerrain();
  const stars = document.querySelector('[aria-label="显示星座名称与连线"]');
  assert.ok(stars.closest('#info-stars-body')); assert.equal(stars.disabled, true);
  assert.equal(document.querySelector('.sidebar [aria-label="显示星座名称与连线"]'), null);
  assert.ok(document.querySelector('#galaxy-contrast').closest('#info-milkyWay-body'));
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  await settle(() => stars.click()); assert.equal(stars.checked, true);
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(stars.checked, false); assert.equal(stars.disabled, true);
  assert.equal(document.querySelector('.panel-parameters'), null);
  assert.equal(document.querySelectorAll('.panel').length, 2);
  // Direction sits under the coordinates below the map; lens and time below the frame.
  for (const label of ['方位角', '俯仰角']) assert.ok(input(label).closest('.panel-map .position-bar .position-view'), label);
  assert.equal(document.querySelector('.preview-meta input'), null);
  for (const control of [input('焦距'), document.querySelector('[aria-label="焦距滑块"]'), document.querySelector('[aria-label="传感器"]'),
    document.querySelector('[aria-label="画幅比例"]'), document.querySelector('[aria-label="拍摄画幅方向"]')])
    assert.ok(control.closest('.panel-preview .camera-bar'));
  const date = document.querySelector('input[type="date"]'), clock = document.querySelector('input[type="time"]');
  assert.equal(date.closest('.time-row'), clock.closest('.time-row'));
  assert.equal(document.querySelector('.timezone-trigger').closest('.time-row'), clock.closest('.time-row'));
  assert.ok(clock.closest('.panel-preview .timeline'));
  // Position and height below the map; the ground elevation comes from the preview.
  for (const label of ['纬度', '经度', '离地高度']) assert.ok(input(label).closest('.panel-map .position-bar'), label);
  const bar = document.querySelector('.position-bar');
  assert.ok(bar.querySelector('.position-coordinates').compareDocumentPosition(bar.querySelector('.position-view')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(document.querySelector('.panel-map .ground-elevation').textContent, /1000\.0/);
  assert.equal(document.querySelector('.preview-meta').textContent.includes('1000.0'), false);
  // Rare settings move next to what they affect.
  assert.ok(document.querySelector('[aria-label="大气折射模型"]').closest('#info-global-body .environment-settings'));
  assert.ok(document.querySelector('[aria-label="深空相机响应"]').closest('#info-deepSky-body'));
  await settle(() => setControl(clock, '19:35:12'));
  await settle(() => setControl(date, '2026-11-07'));
  assert.equal(clock.value, '19:35:12');
  assert.doesNotMatch(document.querySelector('.preview-meta').textContent, /未改机/);
  await settle(() => document.querySelector('[aria-label="显示深空天体"]').click());
  assert.match(document.querySelector('.preview-meta').textContent, /未改机/);
  await settle(() => setControl(document.querySelector('[aria-label="深空相机响应"]'), 'ha-modified'));
  assert.match(document.querySelector('.preview-meta').textContent, /天文改机/);
});

test('滚轮调焦与地图和参数同步，连续事件累积，缩放边界和浏览器组合键保留', async t => {
  const { map: browserMap } = await workspace(t); const map = await readyTerrain(), requests = groundRequests.length;
  const frame = document.querySelector('.viewfinder'), before = ['经度', '纬度', '方位角', '俯仰角'].map(value);
  const sector = structuredClone(geometry(browserMap));
  const wheel = (deltaY, options = {}) => {
    const event = new dom.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...options });
    frame.dispatchEvent(event); return event;
  };
  let event;
  await settle(() => { event = wheel(-100); wheel(-100); });
  assert.equal(event.defaultPrevented, true); assert.equal(value('焦距'), 52.2);
  assert.notDeepEqual(geometry(browserMap), sector);
  await settle(() => wheel(-10000)); assert.equal(value('焦距'), 1000);
  await settle(() => wheel(10000)); assert.equal(value('焦距'), 8);
  await settle(() => { event = wheel(-100, { ctrlKey: true }); });
  assert.equal(event.defaultPrevented, false); assert.equal(value('焦距'), 8);
  await settle(() => wheel(-3, { deltaMode: 1 })); assert.ok(value('焦距') > 8);
  assert.deepEqual(['经度', '纬度', '方位角', '俯仰角'].map(value), before);
  assert.equal(groundRequests.length, requests); assert.equal(terrainMap(), map);
});

test('新机位保留有效画布，短暂更新无加载提示，持续等待和失败明确反馈', async t => {
  const pending = [];
  await workspace(t, () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  await waitUntil(() => pending.length === 1);
  await settle(() => pending[0].resolve({ height: 1000 }));
  const map = await readyTerrain(), canvas = document.querySelector('.terrain-canvas');
  await settle(() => setControl(input('经度'), 139));
  assert.equal(canvas.dataset.ready, 'false'); assert.equal(canvas.dataset.rendered, 'true');
  assert.equal(document.querySelector('.terrain-feedback'), null);
  assert.match(document.querySelector('.ground-elevation').textContent, /待更新/);
  await waitUntil(() => pending.length === 2);
  await act(async () => { await delay(850); });
  assert.match(document.querySelector('.terrain-feedback').textContent, /暂留上一机位/);
  await settle(() => pending[1].resolve({ height: 1200 }));
  assert.equal(canvas.dataset.ready, 'true'); assert.equal(canvas.dataset.rendered, 'true');
  assert.equal(document.querySelector('.terrain-feedback'), null);
  assert.equal(map.cameraSolutions.at(-1).eye.lng, 139);
  await settle(() => setControl(input('经度'), 140));
  await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].reject(new Error('测试高程请求失败')));
  assert.equal(canvas.dataset.rendered, 'false');
  assert.match(document.querySelector('.terrain-feedback-error').textContent, /测试高程请求失败/);
});


test('画幅切换先同步画布尺寸再应用相机，无需等待 ResizeObserver', async t => {
  await workspace(t); const map = await readyTerrain(), calls = [];
  t.after(() => { terrainSize.width = 600; terrainSize.height = 400; });
  const resize = map.resize.bind(map), solve = map.calculateCameraOptionsFromTo.bind(map);
  map.resize = () => { calls.push('resize'); resize(); };
  map.calculateCameraOptionsFromTo = (...args) => { calls.push('camera'); return solve(...args); };
  await settle(() => {
    terrainSize.width = 400;
    setControl(document.querySelector('[aria-label="画幅比例"]'), '1:1');
  });
  assert.deepEqual(calls, ['resize', 'camera']);
  assert.equal(document.querySelector('.viewfinder').style.aspectRatio, '1');
  assert.equal(document.querySelector('.terrain-canvas').dataset.rendered, 'true');
  assert.equal(terrainMap(), map);
});


test('光污染位于“光照与环境”组，按当地数据更新天空和星点，镜头和方向复用数据', async t => {
  await workspace(t); const map = await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  const button = document.querySelector('input[aria-label="当地光污染"]');
  assert.deepEqual([...document.querySelectorAll('.preview-tools button')].map(e => e.getAttribute('aria-label')), ['显示构图线']);
  assert.ok(document.querySelector('.environment-settings').contains(button));
  assert.equal(button.checked, false); assert.equal(pollutionRequests.length, 0);
  const sky = structuredClone(map.environments.at(-1)), requests = groundRequests.length;
  const layer = map.customLayers.find(l => l instanceof TestStarfieldLayer);
  const pose = map.cameraSolutions.length;
  const before = [...document.querySelectorAll('[data-sky-status]')].map(e => Number(e.dataset.skyOpacity));
  await settle(() => button.click());
  await waitUntil(() => layer.frame.artificialMcd === 6.5);
  assert.equal(button.checked, true);
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /2015.*6.500/);
  assert.equal(layer.frame.artificialMcd, 6.5); assert.notDeepEqual(map.environments.at(-1), sky);
  const after = [...document.querySelectorAll('[data-sky-status]')].map(e => Number(e.dataset.skyOpacity));
  assert.ok(after.every((value,index) => value <= before[index]));
  assert.ok(after.some((value,index) => value < before[index] - .2));
  assert.equal(map.cameraSolutions.length, pose); assert.equal(groundRequests.length, requests);
  await settle(() => setControl(input('焦距'), 85));
  await settle(() => setControl(input('方位角'), 120));
  assert.equal(pollutionRequests.length, 1); assert.equal(groundRequests.length, requests);
  await settle(() => button.click());
  assert.equal(layer.frame.artificialMcd, undefined); assert.equal(document.querySelector('.pollution-status'), null);
  assert.deepEqual(map.environments.at(-1), sky); assert.equal(terrainMap(), map);
});

test('光污染取消过期位置与关闭请求，无覆盖、失败和重试均有独立状态', async t => {
  await workspace(t); await readyTerrain();
  const pending = [];
  stubs.pollutionResponse = (point, signal) => new Promise((resolve,reject) => pending.push({ point, signal, resolve, reject }));
  const toggle = document.querySelector('input[aria-label="当地光污染"]');
  await settle(() => toggle.click()); await waitUntil(() => pending.length === 1);
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /正在读取/);
  await settle(() => setControl(input('经度'), 139));
  await waitUntil(() => pending.length === 2); assert.equal(pending[0].signal.aborted, true);
  await settle(() => pending[0].resolve({ artificialMcd: 99 }));
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /正在读取/);
  await settle(() => toggle.click()); assert.equal(pending[1].signal.aborted, true);
  await settle(() => pending[1].resolve({ artificialMcd: 99 }));
  assert.equal(document.querySelector('.pollution-status'), null);
  await settle(() => toggle.click()); await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].reject(new Error('测试光污染读取失败')));
  assert.match(document.querySelector('.pollution-error').textContent, /未应用.*失败/);
  await settle(() => document.querySelector('.pollution-status button').click());
  await waitUntil(() => pending.length === 4);
  await settle(() => pending[3].resolve({ artificialMcd: 1 }));
  assert.equal(document.querySelector('.pollution-status'), null);
  assert.match(document.querySelector('.pollution-readout').textContent, /2015.*1\.000/);
  await settle(() => setControl(input('纬度'), 80));
  assert.match(document.querySelector('.pollution-unavailable').textContent, /超出.*覆盖/);
  assert.equal(pending.length, 4); assert.equal(toggle.checked, true);
  await settle(() => toggle.click()); assert.equal(document.querySelector('.pollution-status'), null);
});


test('已加载预览隐藏后恢复同一尺寸时重新提交星空帧', async t => {
  await workspace(t); const map = await readyTerrain();
  const layer = map.customLayers.find(l => l instanceof TestStarfieldLayer);
  const old = layer.frame.key;
  const observer = resizeObservers.find(o => o.target === document.querySelector('.terrain-canvas'));
  await settle(() => observer.callback([{ contentRect: { width: 0, height: 0 } }]));
  await settle(() => observer.callback([{ contentRect: terrainSize }]));
  assert.notEqual(layer.frame.key, old); assert.equal(layer.frame.ready, true);
});

test('天气按需开启，数据与环境联动，时间和镜头复用机位序列，关闭恢复晴空', async t => {
  await workspace(t); const map = await readyTerrain();
  stubs.weatherLoader = async () => {
    const raw = weatherResponse(); raw.hourly.cloud_cover.fill(100); raw.hourly.cloud_cover_low.fill(100);
    return parseWeather(raw, Date.now());
  };
  const button = document.querySelector('[aria-label="天气效果"]');
  const layer = map.customLayers.find(l => l instanceof TestCelestialLayer);
  const before = structuredClone(map.environments.at(-1)), ground = groundRequests.length;
  assert.equal(button.checked, false); assert.equal(weatherRequests.length, 0);
  await settle(() => button.click());
  await waitUntil(() => document.querySelector('[data-weather-phase="ready"]'));
  assert.equal(layer.frame.weather.low, 1); assert.notDeepEqual(map.environments.at(-1), before);
  // Conclusion first (sky cover in words, chance of rain); exact values follow as details.
  assert.match(document.querySelector('.weather-readout [role="status"]').textContent, /^(晴朗|少云|多云|阴天) · 降水概率 \d+%$/);
  assert.ok([...document.querySelectorAll('.weather-readout .info-detail')].some((p) => /总云量/.test(p.textContent)));
  assert.match(document.querySelector('.weather-readout').textContent, /总云量.*降水.*Open-Meteo/s);
  for (const debug of [/起报批次/, /点位云量/, /云高与形态/, /模型 /, /获取 /, /预报 /])
    assert.doesNotMatch(document.querySelector('.weather-readout').textContent, debug);
  assert.equal(document.querySelector('.weather-status'), null);
  await setShootingDateTime('2026-11-05T01:00');
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  await settle(() => setControl(input('方位角'), 0));
  await settle(() => setControl(input('俯仰角'), 35)); await readyTerrain();
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent, /云层遮蔽/);
  await settle(() => setControl(input('焦距'), 85));
  await setShootingDateTime('2026-11-04T18:30');
  assert.equal(weatherRequests.length, 1); assert.equal(groundRequests.length, ground);
  assert.equal(layer.frame.weather.time, Date.parse('2026-11-04T09:30Z'));
  await settle(() => button.click());
  assert.equal(layer.frame.weather, undefined); assert.equal(terrainMap(), map);
  await setShootingDateTime('2026-11-04T17:00');
  assert.deepEqual(map.environments.at(-1), before);
});

test('天气机位请求取消、错误重试、超范围与缺值分别反馈，迟到数据不覆盖', async t => {
  await workspace(t); await readyTerrain();
  const pending = [];
  stubs.weatherLoader = (point, signal) => new Promise((resolve, reject) => pending.push({ point, signal, resolve, reject }));
  const button = document.querySelector('[aria-label="天气效果"]');
  await settle(() => button.click()); await waitUntil(() => pending.length === 1);
  assert.equal(document.querySelector('.weather-status'), null);
  await settle(() => setControl(input('经度'), 139));
  await waitUntil(() => pending.length === 2); assert.ok(pending[0].signal.aborted);
  await settle(() => pending[0].resolve(parseWeather(weatherResponse(), Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="loading"]'));
  await settle(() => pending[1].reject(new Error('测试天气下载失败')));
  assert.match(document.querySelector('.weather-status').textContent, /天气未应用.*失败/);
  await settle(() => document.querySelector('.weather-status button').click());
  await waitUntil(() => pending.length === 3);
  const response = weatherResponse(); response.hourly.cloud_cover_low[8] = null;
  await settle(() => pending[2].resolve(parseWeather(response, Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="missing"]'));
  await setShootingDateTime('2026-11-20T17:00');
  assert.ok(document.querySelector('[data-weather-phase="outside"]'));
  assert.equal(document.querySelector('.weather-status button').textContent, '使用当前时间');
  assert.equal(weatherRequests.length, 3);
  await settle(() => button.click()); assert.equal(document.querySelector('.weather-status'), null);
});

test('天气返回页面核对缓存年龄，过期时暂停效果并自动刷新', async t => {
  let clock = Date.UTC(2026, 10, 4, 8);
  t.mock.method(Date, 'now', () => clock);
  await workspace(t); const map = await readyTerrain();
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => document.querySelector('[data-weather-phase="ready"]'));
  clock += WEATHER_TTL;
  let resolve;
  stubs.weatherLoader = () => new Promise(done => { resolve = done; });
  await settle(() => dom.window.dispatchEvent(new dom.window.Event('focus')));
  await waitUntil(() => weatherRequests.length === 2);
  assert.ok(document.querySelector('[data-weather-phase="stale"]'));
  assert.equal(map.customLayers.find(l => l instanceof TestCelestialLayer).frame.weather, undefined);
  await settle(() => resolve(parseWeather(weatherResponse(), clock)));
  assert.ok(document.querySelector('[data-weather-phase="ready"]'));
  assert.equal(weatherRequests.length, 2);
});

test('环境分组保留关闭时的模型选择，切换模型取消旧数据且不改机位或重载 DEM', async t => {
  await workspace(t); const map = await readyTerrain(), ground = groundRequests.length;
  const select = document.querySelector('[aria-label="天气预测模型"]');
  assert.ok(document.querySelector('.environment-settings').contains(select));
  assert.deepEqual([...select.options].map((option) => option.value), ['best_match', 'gfs_seamless', 'icon_seamless', 'ecmwf_ifs']);
  assert.deepEqual([...select.options].map((option) => option.textContent).slice(1), ['NOAA GFS', 'DWD ICON', 'ECMWF IFS 9 km']);
  await settle(() => setControl(select, 'gfs_seamless'));
  assert.equal(weatherRequests.length, 0);
  const pending = [];
  stubs.weatherLoader = (point, signal, now, model) => new Promise(resolve => pending.push({ signal, model, resolve }));
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => pending.length === 1);
  assert.equal(pending[0].model, 'gfs_seamless');
  await settle(() => setControl(select, 'ecmwf_ifs'));
  await waitUntil(() => pending.length === 2);
  assert.ok(pending[0].signal.aborted);
  await settle(() => pending[0].resolve(parseWeather(weatherResponse(), Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="loading"]'));
  const raw = weatherResponse(); raw.hourly.visibility.fill(null);
  await settle(() => pending[1].resolve(parseWeather(raw, Date.now())));
  assert.ok(document.querySelector('[data-weather-phase="ready"]'));
  assert.equal(pending[1].model, 'ecmwf_ifs');
  assert.match(document.querySelector('.weather-readout').textContent, /能见度 模型未提供/);
  assert.equal(terrainMap(), map); assert.equal(groundRequests.length, ground);
});
