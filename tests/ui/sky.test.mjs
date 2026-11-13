// Workspace interaction tests: stars, Milky Way, deep sky, stations, constellations and sidebar search. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { act } from "react";
import { skyReference } from "../../src/domain/starfield.ts";
import { TestMap, TestStarfieldLayer, groundRequests, settle, workspace, shootingDateTime, setShootingDateTime, value, button, setControl, waitUntil, terrainMap, readyTerrain } from "./harness.mjs";

test('星空与银河独立开关、朝向及实际相机反馈联动，不重载 DEM 或修改其他参数',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),1320));
  assert.equal(document.querySelector('.sky-readout'),null);
  const fields=['经度','纬度','焦距','离地高度'].map(value),time=shootingDateTime();
  const poses=map.cameraSolutions.length,environments=map.environments.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  assert.equal(map.cameraSolutions.length,poses);assert.equal(map.environments.length,environments);
  assert.doesNotMatch(document.querySelector('#info-stars-body').textContent,/亮星目录|定位符号|按当前 DEM 遮挡/);
  assert.doesNotMatch(document.querySelector('#info-milkyWay-body').textContent,/银河细节|全景衍生/);
  assert.ok(document.querySelector('[data-sky-status="银心"]'));
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  assert.ok(document.querySelector('[data-sky-label="北极星"]'));
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:{azimuth:180,pitch:0},states:{[id]:'clear'}}));
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(document.querySelector('[data-sky-status="北极星"]'),null);
  assert.ok(document.querySelector('[data-sky-status="银心"]'));
  assert.equal(document.querySelector('[aria-label="显示银河"]').checked,true);
  assert.equal(groundRequests.length,requests);assert.equal(terrainMap(),map);
  assert.deepEqual(['经度','纬度','焦距','离地高度'].map(value),fields);assert.equal(shootingDateTime(),time);
});

test('银河对比度滑杆即时联动，重置/关闭重开/布局保留正确，未重载地形或作废几何状态',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  assert.equal(document.querySelector('#galaxy-contrast').disabled,true);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  const slider=()=>document.querySelector('#galaxy-contrast'),layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer);
  assert.equal(slider().value,'100');assert.equal(document.querySelector('[aria-label="重置银河对比度"]').disabled,true);
  const fields=['经度','纬度','焦距','离地高度','方位角','俯仰角'].map(value),time=shootingDateTime();
  const originalFrame=layer.frame,poses=map.cameraSolutions.length,environments=map.environments.length;
  for (const percent of [25,200]) {
    await settle(()=>setControl(slider(),percent));assert.equal(layer.contrast,percent);
    assert.equal(slider().getAttribute('aria-valuetext'),`${percent}%`);
    assert.equal(document.querySelector('.galaxy-contrast output').textContent,`${percent}%`);
    assert.equal(layer.frame,originalFrame);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
    assert.equal(map.cameraSolutions.length,poses);assert.equal(map.environments.length,environments);
    assert.deepEqual(['经度','纬度','焦距','离地高度','方位角','俯仰角'].map(value),fields);assert.equal(shootingDateTime(),time);
  }
  await settle(()=>document.querySelector('[aria-label="重置银河对比度"]').click());assert.equal(slider().value,'100');assert.equal(layer.contrast,100);
  await settle(()=>setControl(slider(),150));await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(slider().disabled,true);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(slider().value,'150');
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());assert.equal(slider().value,'150');
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());assert.equal(slider().value,'150');
});

test('深空搜索开启与朝向，未改机/改机响应切换保留几何、时刻与 DEM',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>setControl(document.querySelector('#target-search'),'M42'));
  assert.equal(document.querySelector('[aria-label="显示深空天体"]').checked,false);
  assert.match(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/图层已关闭/);
  const time=shootingDateTime(),fields=['经度','纬度','焦距','离地高度'].map(value);
  await settle(()=>document.querySelector('[aria-label="开启并朝向猎户座大星云"]').click());
  assert.equal(document.querySelector('[aria-label="显示深空天体"]').checked,true);
  assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'));
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),originalFrame=layer.frame,requests=groundRequests.length,poses=map.cameraSolutions.length;
  // The response setting lives in the deep-sky group, shown once the search is cleared.
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  await settle(()=>setControl(document.querySelector('[aria-label="深空相机响应"]'),'ha-modified'));
  assert.equal(layer.cameraResponse,'ha-modified');assert.equal(layer.frame,originalFrame);assert.equal(groundRequests.length,requests);assert.equal(terrainMap(),map);assert.equal(map.cameraSolutions.length,poses);
  assert.deepEqual(['经度','纬度','焦距','离地高度'].map(value),fields);assert.equal(shootingDateTime(),time);
  assert.equal(document.querySelectorAll('[data-dso-status]').length,15);assert.match(document.querySelector('.preview-meta').textContent,/天文改机/);
  assert.doesNotMatch(document.querySelector('#info-deepSky-body').textContent,/源图色彩|未作具体相机定标|遮挡按画面内/);
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());assert.equal(document.querySelector('[data-dso-label]'),null);
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());assert.equal(document.querySelector('[aria-label="深空相机响应"]').value,'ha-modified');
});

test('深空部分遮挡不等于中心名称可见，轮廓加载失败单独反馈',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向猎户座大星云"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id='dso-ngc1976',key=layer.frame.planKey;
  const report=(label,phase='ready')=>layer.report({planKey:key,ready:true,view:null,states:{[id]:'partial',[id+':label']:label},deepSky:{phase,message:phase==='error'?'深空结构加载失败，请关闭再开启深空天体重试。':undefined}});
  await settle(()=>report('blocked'));assert.match(document.querySelector('[data-dso-status="猎户座大星云"]').textContent,/部分山体遮挡/);assert.equal(document.querySelector('[data-dso-label="猎户座大星云"]'),null);
  await settle(()=>report('clear'));assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'));
  await settle(()=>setControl(document.querySelector('#target-search'),'M42'));await settle(()=>report('clear','error'));
  assert.match(document.querySelector('.deep-sky-feedback').textContent,/加载失败/);assert.equal(document.querySelector('.terrain-feedback-error'),null);assert.equal(document.querySelector('[data-dso-label]'),null);
  assert.match(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/深空轮廓加载失败/);
  await settle(()=>layer.report({planKey:key,ready:true,view:null,states:{[id]:'clear',[id+':label']:'clear'},
    deepSky:{phase:'error',message:'马头资料加载失败'},deepSkyTargets:{[id]:{phase:'ready'},'dso-ic0434':{phase:'error'}}}));
  assert.ok(document.querySelector('[data-dso-label="猎户座大星云"]'),'another failed resource must not hide ready labels');
  assert.doesNotMatch(document.querySelector('[data-search-target="dso-ngc1976"]').textContent,/加载失败/);
});

test('银河纹理状态与遮挡分开，搜索时也显示失败，地形与星点保持可用',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer);
  await settle(()=>setControl(document.querySelector('#target-search'),'银心'));
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{},milkyWay:{phase:'loading'}}));
  assert.equal(document.querySelector('.sky-texture-feedback'), null);
  await act(async () => { await delay(850); });
  assert.match(document.querySelector('.sky-texture-feedback').textContent,/加载银河/);
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{},milkyWay:{phase:'error',message:'银河纹理加载失败，请关闭再开启银河重试。'}}));
  assert.match(document.querySelector('.sky-texture-feedback').textContent,/加载失败/);
  assert.equal(document.querySelector('.terrain-feedback-error'),null);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);assert.ok(document.querySelector('[data-search-target="galactic-center"]'));
  assert.ok(document.querySelector('.about-dialog a[href="https://www.eso.org/public/images/eso0932a/"]'));
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());assert.equal(document.querySelector('.sky-texture-feedback'),null);
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{},milkyWay:{phase:'ready'}}));
  assert.equal(document.querySelector('.sky-texture-feedback'),null);assert.equal(groundRequests.length,requests);
});

test('星空名称等待实际遮挡结果，山体遮挡或失败不沿用旧名称，重试保留开关',async t=>{
  await workspace(t);const map=await readyTerrain();
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),1320));
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{[id]:'blocked'}}));
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent,/山体遮挡/);
  await settle(()=>{map.tilesLoaded=false;map.emit('dataloading');});
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent,/待测/);
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:false,view:null,states:{},message:'测试星空图形失败'}));
  assert.ok(document.querySelector('.terrain-feedback-error'));assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('[data-sky-status="北极星"]').textContent,/遮挡未知/);
  await settle(()=>button('重试预览').click());await readyTerrain();
  assert.equal(layer.removed,true);assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  assert.ok(document.querySelector('[data-sky-label="北极星"]'));
});

test('白昼星点隐藏独立于 DEM 遮挡，夜间恢复，银心参考仍可定位',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  await settle(()=>document.querySelector('[aria-label="显示银河"]').click());
  // Night layers put the slider on noon-to-noon: minute 0 is 12:00, 600 is 22:00.
  assert.equal(document.querySelector('.timeline').dataset.mode,'night');
  await settle(()=>setControl(document.querySelector('.time-slider'),0));
  assert.equal(document.querySelector('input[type="time"]').value,'12:00:00');
  await settle(()=>document.querySelector('[aria-label="朝向北极星"]').click());
  const status=()=>document.querySelector('[data-sky-status="北极星"]');
  assert.match(status().textContent,/天空较亮/);assert.equal(status().dataset.skyOpacity,'0.000');
  assert.equal(document.querySelector('[data-sky-label="北极星"]'),null);
  assert.match(document.querySelector('.preview-lighting').textContent,/白昼/);
  assert.equal(document.querySelector('[data-sky-status="银心"]').dataset.skyOpacity,'1.000');
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),id=skyReference(layer.frame.plan).points.find(p=>p.name==='北极星').id;
  await settle(()=>layer.report({planKey:layer.frame.planKey,ready:true,view:null,states:{[id]:'blocked'}}));
  assert.match(status().textContent,/山体遮挡/);
  await settle(()=>setControl(document.querySelector('.time-slider'),600));
  assert.equal(document.querySelector('input[type="time"]').value,'22:00:00');
  assert.ok(Number(status().dataset.skyOpacity)>0.06);assert.ok(document.querySelector('[data-sky-label="北极星"]'));
  const darkOpacity=Number(status().dataset.skyOpacity);
  await setShootingDateTime('2026-11-25T00:00');
  assert.ok(Number(status().dataset.skyOpacity)<darkOpacity,'a high full Moon must dim the star');
  const before=status().dataset.skyOpacity;
  await settle(()=>document.querySelector('[aria-label="显示月亮"]').click());
  assert.equal(status().dataset.skyOpacity,before);assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('拍摄信息只在右侧栏出现，版权独立于预览；收起和恢复不重建地图或丢失状态',async t=>{
  await workspace(t);const map=await readyTerrain(),sidebar=document.querySelector('.info-sidebar');
  assert.ok(sidebar.querySelector('.preview-readout'));assert.ok(sidebar.querySelector('.celestial-readout'));
  assert.equal(document.querySelector('.preview-content .preview-readout'),null);
  assert.equal(document.querySelector('.preview-content .preview-attribution'),null);
  assert.equal(sidebar.querySelector('.about-dialog'),null);
  const requests=groundRequests.length;
  await settle(()=>document.querySelector('[aria-label="收起图层与信息"]').click());
  assert.ok(sidebar.classList.contains('is-collapsed'));
  await settle(()=>setControl(document.querySelector('input[aria-label="24 小时时间滑杆"]'),720));
  await settle(()=>document.querySelector('[aria-label="展开图层与信息"]').click());
  assert.equal(sidebar.classList.contains('is-collapsed'),false);
  assert.match(sidebar.querySelector('.preview-lighting').textContent,/白昼/);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('About 汇集所有署名与下载，开关图层和弹窗不重建地图或改变计划', async (t) => {
  const { map: browserMap } = await workspace(t);
  const map = await readyTerrain();
  const dialog = document.querySelector('#about-dialog');
  const trigger = document.querySelector('.topbar [aria-controls="about-dialog"]');
  assert.equal(dialog.open, false);
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(browserMap.options.attributionControl.compact, true);
  assert.equal(document.querySelector('.preview-attribution'), null);
  const catalog = JSON.parse(readFileSync(new URL('../../src/data/deep-sky.json', import.meta.url), 'utf8'));
  assert.equal(dialog.querySelectorAll('[data-credit-source]').length, catalog.imageSources.length);
  for (const source of catalog.imageSources) {
    const credit = dialog.querySelector(`[data-credit-source="${source.catalogId}"]`);
    assert.ok(credit.textContent.includes(source.credit));
    assert.equal(credit.querySelector('a').getAttribute('href'), source.page);
    assert.equal(credit.querySelectorAll('a[download]').length, 1);
  }
  assert.match(dialog.querySelector('[data-credit-source="IC0434"]').textContent, /火树/);
  const landmarkCatalog = JSON.parse(readFileSync(new URL('../../src/data/landmarks.generated.json', import.meta.url), 'utf8'));
  const downloads = [...dialog.querySelectorAll('a[download]')];
  assert.equal(downloads.length, catalog.imageSources.length + 7 + 2 * landmarkCatalog.length);
  // Comets: COBS share-alike, non-commercial terms beside the derived data download, JPL citation, tail formula.
  const cometSection = dialog.querySelector('[aria-labelledby="about-comets-title"]');
  assert.match(cometSection.textContent, /COBS Comet Observation Database · CC BY-NC-SA 4\.0.*仅限非商业使用/s);
  assert.match(cometSection.querySelector('a[download]').textContent, /下载彗星目录/);
  assert.equal(cometSection.querySelector('a[download]').getAttribute('href'), '/comets/catalog.json');
  assert.match(cometSection.textContent, /NASA\/JPL Solar System Dynamics\. Data retrieved on/);
  assert.match(cometSection.textContent, /每 3 小时自动检查/);
  assert.match(cometSection.textContent, /Kammerer/);
  const landmarkSection=dialog.querySelector('[aria-labelledby="about-landmarks-title"]');
  assert.match(landmarkSection.textContent,/Noah.*CC BY 4.0/);
  assert.equal(landmarkSection.querySelectorAll('a[download]').length,2*landmarkCatalog.length);
  for(const target of landmarkCatalog){const credit=landmarkSection.querySelector(`[data-landmark-credit="${target.id}"]`);assert.ok(credit);assert.ok(credit.textContent.includes(target.credit.author));assert.ok(credit.querySelector('a[href="'+target.credit.licenseUrl+'"]'));
    // Non-commercial terms must be visible next to the licence and on the download link, and only where they apply.
    const restricted=target.credit.use==='仅限非商业使用';assert.equal(target.credit.license.includes('NC'),restricted);
    assert.equal(credit.textContent.includes('仅限非商业使用'),restricted);if(restricted)assert.match(credit.querySelector('a[download]').textContent,/CC BY-NC 4\.0，仅限非商业使用/);}
  assert.ok(landmarkCatalog.some(target=>target.credit.use),'catalogue carries at least one non-commercial landmark');
  assert.match(landmarkSection.textContent,/NanoRay.*CC BY 4.0/);
  assert.equal(new Set(downloads.map((link) => link.getAttribute('href'))).size, downloads.length);
  const fields = ['经度', '纬度', '焦距', '离地高度', '方位角', '俯仰角'];
  const before = fields.map(value), time = shootingDateTime();
  const requests = groundRequests.length, maps = TestMap.instances.length;
  for (const label of ['显示星空', '显示银河', '显示星座名称与连线', '显示深空天体']) {
    await settle(() => document.querySelector(`[aria-label="${label}"]`).click());
  }
  await settle(() => trigger.click());
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelectorAll('[data-credit-source]').length, catalog.imageSources.length);
  await settle(() => dialog.querySelector('button').click());
  assert.equal(dialog.open, false);
  await settle(() => trigger.click());
  assert.equal(dialog.open, true);
  assert.equal(terrainMap(), map);
  assert.equal(TestMap.instances.length, maps);
  assert.equal(groundRequests.length, requests);
  assert.deepEqual(fields.map(value), before);
  assert.equal(shootingDateTime(), time);
});

test('空间站按需读取同源轨道、搜索开启与朝向、秒级时间联动，地形和机位保留', async (t) => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/stations-reference.json', import.meta.url), 'utf8'));
  const feed = { version: 1, source: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json', fetchedAt: null, attemptedAt: null, status: 'seed', error: null, blocked: false, objects: fixture.elements };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, signal: options.signal });
    return new Response(JSON.stringify(feed));
  });
  await workspace(t);
  const map = await readyTerrain(), requests = groundRequests.length;
  const fields = ['经度', '纬度', '焦距', '离地高度'];
  const before = fields.map(value);
  assert.equal(calls.length, 0);
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, false);
  await setShootingDateTime('2026-11-06T19:35');
  await settle(() => setControl(document.querySelector('#target-search'), 'ISS'));
  await waitUntil(() => document.querySelector('[aria-label="开启并朝向国际空间站 ISS"]'));
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/orbits/stations.json');
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, false);
  await settle(() => document.querySelector('[aria-label="开启并朝向国际空间站 ISS"]').click());
  assert.equal(document.querySelector('[aria-label="显示空间站"]').checked, true);
  assert.ok(document.querySelector('[data-station-label="25544"]'));
  assert.match(document.querySelector('.station-readout').textContent, /地影中/);
  const layer = map.customLayers.find((entry) => entry instanceof TestStarfieldLayer);
  const oldKey = layer.frame.stations.key;
  await settle(() => button('+10 秒').click());
  assert.notEqual(layer.frame.stations.key, oldKey);
  assert.match(document.querySelector('.station-instant').textContent, /10:35:10 UTC/);
  await settle(() => layer.report({ planKey: layer.frame.planKey, orbitKey: 'old', ready: true, view: null, states: { 'station-25544': 'clear' } }));
  assert.equal(document.querySelector('[data-station-label="25544"]'), null);
  await setShootingDateTime('2027-01-01T00:00');
  assert.equal(layer.frame.stations.points.length, 0);
  assert.match(document.querySelector('.station-readout').textContent, /停止绘制/);
  await setShootingDateTime('2026-11-06T19:35');
  await settle(() => layer.report({ planKey: layer.frame.planKey, ready: false, view: null, states: {}, message: '地形不可用' }));
  assert.match(document.querySelector('.station-readout').textContent, /遮挡未知/);
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  await settle(() => setControl(document.querySelector('#target-search'), ''));
  assert.equal(document.querySelector('.station-readout'), null);
  assert.equal(calls.length, 1);
  assert.equal(terrainMap(), map); assert.equal(groundRequests.length, requests);
  assert.deepEqual(fields.map(value), before);
});

test('空间站加载取消忽略迟到响应，后台恢复按到期检查，网页失败与上游暂停分别显示', async (t) => {
  t.after(() => { delete document.visibilityState; });
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/stations-reference.json', import.meta.url), 'utf8'));
  const feed = { version: 1, source: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json', fetchedAt: null, attemptedAt: '2026-11-06T10:00:00Z', status: 'error', error: '上游 HTTP 403，自动更新已暂停', blocked: true, objects: fixture.elements };
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })));
  let now = Date.parse('2026-11-06T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await workspace(t); await readyTerrain();
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  await waitUntil(() => pending.length === 1);
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  assert.equal(pending[0].options.signal.aborted, true);
  await settle(() => pending[0].resolve(new Response(JSON.stringify(feed))));
  assert.equal(document.querySelector('.station-readout'), null);
  await settle(() => document.querySelector('[aria-label="显示空间站"]').click());
  await waitUntil(() => pending.length === 2);
  await settle(() => pending[1].resolve(new Response(JSON.stringify(feed))));
  assert.match(document.querySelector('.station-feed-status').textContent, /上游 HTTP 403/);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  now += 301000;
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(pending.length, 2);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitUntil(() => pending.length === 3);
  await settle(() => pending[2].reject(new Error('已发布快照不可用')));
  assert.match(document.querySelector('.station-feed-status').textContent, /已发布快照不可用/);
  assert.match(document.querySelector('.station-feed-status').textContent, /上游 HTTP 403/);
  assert.equal(document.querySelectorAll('[data-station-status]').length, 2);
  delete document.visibilityState;
});

test('星座默认关闭并从属于星空；主要亮星名称、星座定位与开关联动',async t=>{
  await workspace(t);const map=await readyTerrain(),requests=groundRequests.length;
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').checked,false);
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.ok(document.querySelectorAll('[data-sky-status]').length>=90);
  await settle(()=>document.querySelector('[aria-label="朝向参宿五"]').click());
  assert.ok(document.querySelector('[data-sky-label="参宿五"]'));
  await settle(()=>document.querySelector('[aria-label="显示星座名称与连线"]').click());
  await settle(()=>document.querySelector('[aria-label="朝向猎户座"]').click());
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));
  await settle(()=>document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(document.querySelector('[data-constellation-label="猎户座"]'), null);assert.equal(document.querySelector('[data-sky-status="参宿五"]'),null);
  assert.equal(document.querySelector('[aria-label="显示星座名称与连线"]').disabled, true);
  await settle(()=>document.querySelector('[aria-label="显示星座名称与连线"]').click());
  assert.equal(document.querySelector('[data-constellation-label]'),null);assert.equal(document.querySelector('[data-constellation-status]'),null);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('侧栏搜索发现未开启目标，输入不改变构图，明确选择才开启图层和朝向',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  const fields=['纬度','经度','方位角','俯仰角','焦距'].map(value),requests=groundRequests.length;
  await settle(()=>setControl(document.querySelector('#target-search'),'ＯＲＩ'));
  assert.match(document.querySelector('.target-search-results').textContent,/猎户座/);
  assert.match(document.querySelector('.target-search-results').textContent,/图层已关闭/);
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,false);
  assert.deepEqual(['纬度','经度','方位角','俯仰角','焦距'].map(value),fields);
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
  await settle(()=>document.querySelector('[aria-label="开启并朝向猎户座"]').click());
  assert.ok(document.querySelector('[data-constellation-label="猎户座"]'));
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  await settle(()=>setControl(document.querySelector('#target-search'),'不存在的目标_zzzz'));
  assert.match(document.querySelector('.target-search-results').textContent,/没有找到匹配目标/);
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  assert.equal(document.querySelector('.target-search-results'),null);assert.ok(document.querySelector('.info-body .preview-readout'));
  assert.equal(terrainMap(),map);assert.equal(groundRequests.length,requests);
});

test('缓存视野的加载事件在没有后续 sourcedata 时恢复深空图层',async t=>{
  await workspace(t);const map=await readyTerrain();
  await setShootingDateTime('2026-11-09T01:00');
  await settle(()=>document.querySelector('[aria-label="显示深空天体"]').click());
  await settle(()=>setControl(document.querySelector('#target-search'),'M31'));
  await settle(()=>document.querySelector('[aria-label="朝向仙女座星系"]').click());
  const layer=map.customLayers.find(l=>l instanceof TestStarfieldLayer),oldKey=layer.frame.key;
  await settle(()=>map.emit('dataloading'));
  assert.notEqual(layer.frame.key,oldKey);assert.equal(layer.frame.ready,true);
  assert.match(document.querySelector('.target-search-results').textContent,/未被地形遮挡/);
  await settle(()=>document.querySelector('[aria-label="清除目标搜索"]').click());
  await settle(()=>setControl(document.querySelector('[aria-label="深空相机响应"]'),'ha-modified'));
  assert.equal(layer.frame.ready,true);assert.ok(document.querySelector('[data-dso-label="仙女座星系"]'));
});

test('侧栏收起、面板交换保留搜索，地平线下的未开启目标只启用图层',async t=>{
  await workspace(t);await readyTerrain();
  await setShootingDateTime('2026-11-25T00:00');
  await settle(()=>setControl(document.querySelector('#target-search'),'Vega'));
  const pose=['方位角','俯仰角'].map(value);
  await settle(()=>document.querySelector('[aria-label="开启图层织女星"]').click());
  assert.equal(document.querySelector('[aria-label="显示星空"]').checked,true);
  assert.deepEqual(['方位角','俯仰角'].map(value),pose);
  assert.match(document.querySelector('.target-search-results').textContent,/地平线下/);
  await settle(()=>document.querySelector('[aria-label="收起图层与信息"]').click());
  await settle(()=>document.querySelector('[aria-label="展开图层与信息"]').click());
  assert.equal(document.querySelector('#target-search').value,'Vega');
  await settle(()=>document.querySelector('[aria-label="对调地图与预览位置"]').click());await readyTerrain();
  assert.equal(document.querySelector('#target-search').value,'Vega');assert.ok(document.querySelector('[data-search-target]'));
});
