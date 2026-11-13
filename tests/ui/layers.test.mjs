// Workspace interaction tests: paths, meteors, comets, eclipses, tides, aurora, map lines and place search. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { bodyPath } from "../../src/domain/sun-moon/body-paths.ts";
import { meteorEstimate } from "../../src/domain/sky/meteor-showers.ts";
import { cometScene } from "../../src/domain/comets/comets.ts";
import { validateCometCatalog } from "../../src/domain/comets/comet-catalog.ts";
import { stubs, TestCelestialLayer, TestStarfieldLayer, TestMarker, server, dom, groundRequests, installGlobal, settle, workspace, input, chooseTimeZone, shootingDateTime, setShootingDateTime, value, setControl, waitUntil, terrainMap, readyTerrain, cometCatalogAt } from "./harness.mjs";

test('太阳、月亮分组各有运行轨迹开关：从属于天体图层，开启后预览得到轨迹线与整点标注', async t => {
  await workspace(t); const map = await readyTerrain();
  const layer = () => map.customLayers.find(l => l instanceof TestCelestialLayer);
  const toggle = (body) => document.querySelector(`[data-info-group="${body}"] input[aria-label="显示${body === 'sun' ? '太阳' : '月亮'}运行轨迹"]`);
  assert.ok(toggle('sun') && toggle('moon'), 'each switch sits in its own group');
  assert.deepEqual([toggle('sun').checked, toggle('moon').checked], [false, false]);
  assert.equal(document.querySelector('[data-path-marker]'), null);
  await setShootingDateTime('2026-11-04T12:00');
  await settle(() => document.querySelector('button[aria-label="朝向太阳"]').click());
  const poses = map.cameraSolutions.length, requests = groundRequests.length, fields = ['经度', '纬度', '方位角', '俯仰角', '焦距'].map(value);
  await settle(() => toggle('sun').click());
  assert.equal(toggle('sun').checked, true);
  assert.equal(document.querySelector('[data-path-status="sun"]').textContent, '本次出没 · 经过画面');
  const sunLabels = [...document.querySelectorAll('[data-path-marker^="sun-"]')].map(e => e.dataset.pathMarker);
  assert.ok(sunLabels.includes('sun-12:00') && sunLabels.length >= 2, sunLabels.join());
  assert.deepEqual(layer().frame.paths.map(p => p.id), ['sun']);
  assert.ok(layer().frame.paths[0].runs.flat().length > 10 && layer().frame.paths[0].markers.length === sunLabels.length);
  // A display aid: no camera, ground or plan change.
  assert.equal(map.cameraSolutions.length, poses); assert.equal(groundRequests.length, requests);
  assert.deepEqual(['经度', '纬度', '方位角', '俯仰角', '焦距'].map(value), fields);
  // Whole hours follow the selected time zone; the instant stays.
  await chooseTimeZone('UTC');
  assert.ok(document.querySelector('[data-path-marker="sun-03:00"]'), 'noon in Tokyo is 03:00 UTC');
  assert.equal(document.querySelector('[data-path-marker="sun-12:00"]'), null);
  await chooseTimeZone('Asia/Tokyo', 'Tokyo');
  // The moon has its own pass and switch.
  const moon = bodyPath({ latitude: value('纬度'), longitude: value('经度'), timeZone: 'Asia/Tokyo', refraction: 'standard', instant: '2026-11-04T03:00:00Z' }, 'moon');
  await settle(() => toggle('moon').click());
  assert.match(document.querySelector('[data-path-status="moon"]').textContent, new RegExp(`^${{ current: '本次', next: '下一次', previous: '上一次' }[moon.pass]}出没 · `));
  assert.deepEqual(layer().frame.paths.map(p => p.id), ['sun', 'moon']);
  // Switching the Sun off takes its path with it, and switching it on again does not restore it.
  await settle(() => document.querySelector('input[aria-label="显示太阳"]').click());
  assert.deepEqual([toggle('sun').checked, toggle('sun').disabled], [false, true]);
  assert.equal(document.querySelector('[data-path-marker^="sun-"]'), null);
  assert.equal(document.querySelector('[data-path-status="sun"]'), null);
  assert.deepEqual(layer().frame.paths.map(p => p.id), ['moon']);
  await settle(() => document.querySelector('input[aria-label="显示太阳"]').click());
  assert.deepEqual([toggle('sun').checked, toggle('sun').disabled], [false, false]);
  assert.equal(toggle('moon').checked, true);
});

test('流星雨图层：左栏开启后列出拍摄日期的活动流星雨与辐射点，右栏开关驱动整晚画面内估算，同一夜内移动时刻不改暗夜，关闭图层同时关闭密度', async t => {
  await workspace(t); const map = await readyTerrain();
  const layerSwitch = () => document.querySelector('input[aria-label="显示流星雨"]');
  const density = () => document.querySelector('[data-info-group="meteors"] input[aria-label="显示流星雨预估密度"]');
  const fact = () => document.querySelector('[data-meteor-fact]');
  const night = () => document.querySelector('[data-meteor-night]')?.textContent;
  assert.equal(layerSwitch().checked, false);
  assert.deepEqual([density().checked, density().disabled], [false, true]);
  assert.equal(document.querySelector('[data-info-group="meteors"] input[type="range"]'), null, 'no duration slider');
  assert.match(document.querySelector('[data-info-group="meteors"]').textContent, /流星雨已关闭/);
  await setShootingDateTime('2026-08-13T00:30');
  const requests = groundRequests.length, poses = map.cameraSolutions.length;
  await settle(() => layerSwitch().click());
  assert.equal(document.getElementById('info-meteors').getAttribute('aria-expanded'), 'true');
  const rows = [...document.querySelectorAll('[data-meteor-status]')].map((row) => row.dataset.meteorStatus);
  assert.equal(rows[0], 'PER', 'strongest shower first');
  assert.deepEqual([...rows].sort(), ['ANT', 'CAP', 'ERI', 'KCG', 'PER', 'SDA']);
  assert.match(document.querySelector('[data-meteor-status="PER"]').textContent, /ZHR 约 \d+（峰值 100，极大前后）/);
  await settle(() => document.querySelector('button[aria-label="朝向英仙座流星雨辐射点"]').click());
  assert.ok(document.querySelector('[data-meteor-label="PER"]'), 'radiant label in frame');
  assert.equal(fact(), null);
  await settle(() => density().click());
  const plan = { latitude: value('纬度'), longitude: value('经度'), instant: '2026-08-12T15:30:00Z', azimuth: value('方位角'), pitch: value('俯仰角'),
    focalLength: value('焦距'), sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' };
  const shown = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const whole = meteorEstimate(plan);
  assert.equal(fact().textContent, `流星示意 · 整晚暗夜 ${Number(whole.darkHours.toFixed(1))} 小时 · 画面内约 ${shown(whole.expected)} 颗`);
  assert.equal(night(), `暗夜 8月12日 ${clock(whole.dark.from)}—8月13日 ${clock(whole.dark.to)} · ${Number(whole.darkHours.toFixed(1))} 小时`);
  assert.match(document.querySelector('[data-meteor-estimate]').textContent, /整晚画面内约 \d+ 颗.*固定机位整晚连拍.*光污染未开启，按自然天空/);
  const starfield = map.customLayers.find((l) => l instanceof TestStarfieldLayer);
  assert.equal(starfield.frame.plan.layers.meteorDensity, true);
  assert.equal('meteorHours' in starfield.frame.plan, false);
  assert.equal(groundRequests.length, requests); assert.equal(map.cameraSolutions.length, poses + 1, 'only the explicit 朝向 turned the camera');
  // 22:00 the evening before is the same night: same dark stretch, another anchor for the alignment.
  const range = night();
  await setShootingDateTime('2026-08-12T22:00');
  const evening = meteorEstimate({ ...plan, instant: '2026-08-12T13:00:00Z' });
  assert.equal(night(), range);
  assert.equal(fact().textContent, `流星示意 · 整晚暗夜 ${Number(evening.darkHours.toFixed(1))} 小时 · 画面内约 ${shown(evening.expected)} 颗`);
  assert.notEqual(Math.round(evening.expected), Math.round(whole.expected));
  await setShootingDateTime('2026-08-13T00:30');
  // Turning the layer off takes the estimate with it; turning it on again keeps it off.
  await settle(() => layerSwitch().click());
  assert.deepEqual([density().checked, density().disabled], [false, true]);
  assert.equal(fact(), null); assert.equal(document.querySelector('[data-meteor-label]'), null);
  await settle(() => layerSwitch().click());
  assert.equal(density().checked, false);
  // The antihelion source has no maximum: a constant rate without days from peak.
  assert.match(document.querySelector('[data-meteor-status="ANT"]').textContent, /ZHR 约 4\.0 · 30\skm\/s/);
  // Variable showers list a radiant but no estimate.
  await setShootingDateTime('2026-06-25T00:30');
  assert.match(document.querySelector('[data-meteor-status="JBO"]').textContent, /ZHR 不定，不估算/);
});

test('彗星图层：左栏开启后读取已发布目录，列出拍摄时刻的彗星，右栏给出星等与暗夜/当前天光下的彗尾长度，朝向后画面出现标注，回归期外与关闭分别提示', async t => {
  const served = cometCatalogAt(3), calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return new Response(JSON.stringify(served)); });
  await workspace(t); const map = await readyTerrain();
  assert.deepEqual(calls, [], 'the catalogue is read only when the layer is on');
  const starfield = () => map.customLayers.find((l) => l instanceof TestStarfieldLayer);
  const layerSwitch = () => document.querySelector('input[aria-label="显示彗星"]');
  const group = () => document.querySelector('[data-info-group="comets"]');
  assert.equal(layerSwitch().checked, false);
  assert.match(group().textContent, /彗星已关闭/);
  // NEOWISE in the evening twilight of 2020-07-15 from the default site.
  await setShootingDateTime('2020-07-15T20:30');
  const requests = groundRequests.length;
  await settle(() => layerSwitch().click());
  assert.equal(document.getElementById('info-comets').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(calls, ['/comets/catalog.json']);
  const catalog = validateCometCatalog(served);
  const plan = { latitude: value('纬度'), longitude: value('经度'), instant: '2020-07-15T11:30:00Z' };
  const scene = cometScene(plan, catalog);
  const neowise = scene.views.find((view) => view.comet.id === 'C/2020 F3');
  assert.ok(neowise, 'NEOWISE listed');
  assert.deepEqual([...document.querySelectorAll('[data-comet-status]')].map((row) => row.dataset.cometStatus), scene.views.map((view) => view.comet.id));
  const row = document.querySelector('[data-comet-status="C/2020 F3"]');
  assert.match(row.textContent, /新智彗星 C\/2020 F3(?! \()/);
  assert.match(row.textContent, new RegExp(`${neowise.magnitude.toFixed(1)} 等`));
  assert.ok(scene.visibleShare < 1, 'evening twilight dims the tails');
  assert.match(document.querySelector('[data-comet-sky]').textContent, /天空比暗夜亮约 \d\.\d 等，彗尾约显示前 \d+%/);
  assert.match(row.querySelector('[data-comet-tail]').textContent, /离子尾 [\d.]+°? · 尘埃尾 [\d.]+[°′] · 暗夜 [\d.]+° \/ [\d.]+[°′]/);
  assert.equal(document.querySelector('[data-comet-updated]').textContent, served.fetchedAt.slice(0, 10));
  assert.equal(document.querySelector('[data-comet-feed]'), null, 'fresh catalogue: no update notice');
  assert.equal(starfield().frame.comets.key, scene.key);
  assert.equal(starfield().frame.plan.layers.comets, true);
  await settle(() => document.querySelector('button[aria-label="朝向新智彗星"]').click());
  assert.ok(document.querySelector('[data-comet-label="C/2020 F3"]'), 'head label in frame');
  assert.match(document.querySelector('[data-comet-label="C/2020 F3"]').textContent, /新智彗星/);
  assert.equal(groundRequests.length, requests, 'comets do not reload terrain');
  // Outside every apparition window of the catalogue.
  await setShootingDateTime('1991-01-15T20:30');
  assert.equal(document.querySelectorAll('[data-comet-status]').length, cometScene({ ...plan, instant: '1991-01-15T11:30:00Z' }, catalog).views.length);
  await settle(() => layerSwitch().click());
  assert.match(group().textContent, /彗星已关闭/);
  assert.equal(document.querySelector('[data-comet-label]'), null);
});

test('彗星目录：读取失败可重试并保留图层，超过 1 天未更新与自动更新暂停分别提示', async t => {
  let respond = async () => new Response('busy', { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => respond());
  await workspace(t); await readyTerrain();
  const group = () => document.querySelector('[data-info-group="comets"]');
  await setShootingDateTime('2020-07-15T20:30');
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  assert.match(document.querySelector('[data-comet-feed="error"]').textContent, /彗星目录读取失败 · 彗星目录 HTTP 503/);
  assert.equal(document.querySelectorAll('[data-comet-status]').length, 0);
  // Retry: a catalogue last updated nine days ago is shown with a staleness notice.
  const old = cometCatalogAt(9 * 24);
  respond = async () => new Response(JSON.stringify(old));
  await settle(() => group().querySelector('[data-comet-feed="error"] button').click());
  assert.match(document.querySelector('[data-comet-feed="stale"]').textContent, /目录已 9 天未更新，新发现或新近变亮的彗星可能缺失/);
  assert.ok(document.querySelector('[data-comet-status="C/2020 F3"]'));
  // A later failed update: the same comets, update paused, no staleness notice on top.
  const paused = cometCatalogAt(9 * 24, { attemptedHoursAgo: 1, fields: { status: 'error', blocked: true, error: 'cobs.si HTTP 503，自动更新已暂停，需维护者检查后手动恢复' } });
  respond = async () => new Response(JSON.stringify(paused));
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  assert.match(document.querySelector('[data-comet-feed="paused"]').textContent, new RegExp(`目录自动更新已暂停，沿用 ${old.fetchedAt.slice(0, 10)} 的目录`));
  assert.equal(document.querySelector('[data-comet-feed="stale"]'), null);
  assert.ok(document.querySelector('[data-comet-status="C/2020 F3"]'));
  // An older copy (for example from a cache) never replaces what is shown.
  respond = async () => new Response(JSON.stringify(cometCatalogAt(20 * 24)));
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  await settle(() => document.querySelector('input[aria-label="显示彗星"]').click());
  assert.match(document.querySelector('[data-comet-feed="error"]').textContent, /彗星目录刷新失败，沿用 .* 的目录 · 彗星目录更新记录回退/);
  assert.ok(document.querySelector('[data-comet-status="C/2020 F3"]'));
});

test('右栏先给结论：详细数值默认隐藏，开启后显示并在本浏览器保留；深空只展开地平线以上的目标，光污染给出定性等级', async t => {
  const first = await workspace(t); await readyTerrain();
  const body = () => document.querySelector('.info-body');
  const toggle = () => document.querySelector('[aria-label="显示详细数值"]');
  assert.equal(toggle().checked, false);
  assert.equal(body().classList.contains('show-details'), false);
  // Sun: status, then the spoken direction; exact azimuth and heights are a detail.
  const sun = document.querySelector('[data-body-status="sun"] .celestial-coordinates');
  assert.match(sun.firstChild.textContent, /^(北|东北|东|东南|南|西南|西|西北) · 高 -?\d+°$/);
  assert.match(sun.querySelector('.info-detail').textContent, /° \/ 视 .*（几何 .*°）/);
  // Lighting and environment: phase first; viewing angles only as details.
  assert.match(document.querySelector('.preview-lighting strong').textContent, /^(夜间|天文暮光|航海暮光|民用暮光|低角度日照|白昼)$/);
  assert.ok(document.querySelector('#info-global-body .info-detail-section .preview-readout'));
  await settle(() => document.querySelector('[aria-label="当地光污染"]').click());
  await waitUntil(() => /严重/.test(document.querySelector('.pollution-readout p').textContent));
  const pollution = document.querySelector('.pollution-readout p');
  assert.match(pollution.firstChild.textContent, /严重光污染，只剩亮星/, '6.5 mcd/m² is about 37 times the natural sky');
  assert.match(pollution.querySelector('.info-detail').textContent, /天顶人工亮度 ≈ 6\.500 mcd\/m²/);
  // Deep sky: targets below the horizon are folded under one line.
  await settle(() => document.querySelector('[aria-label="显示深空天体"]').click());
  const below = [...document.querySelectorAll('.sky-below [data-dso-status]')];
  const shown = [...document.querySelectorAll('#info-deepSky-body [data-dso-status]')].filter((row) => !row.closest('.sky-below'));
  assert.equal(below.length + shown.length, 15);
  assert.ok(below.length > 0 && shown.length > 0);
  assert.ok(below.every((row) => /地平线下/.test(row.textContent)));
  assert.ok(shown.every((row) => !/地平线下/.test(row.children[1].textContent)));
  assert.equal(document.querySelector('.sky-below summary').textContent, `另有 ${below.length} 个在地平线下`);
  // The switch is a viewer preference: kept across reloads, not part of the shot.
  await settle(() => toggle().click());
  assert.equal(body().classList.contains('show-details'), true);
  assert.equal(dom.window.localStorage.getItem('tamatamatori.showDetails'), '1');
  await act(async () => { await delay(350); });
  assert.doesNotMatch(dom.window.localStorage.getItem('tamatamatori.session.v1'), /showDetails|详细/);
  await first.unmount();
  await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  assert.equal(toggle().checked, true);
  assert.equal(body().classList.contains('show-details'), true);
  await settle(() => toggle().click());
  assert.equal(dom.window.localStorage.getItem('tamatamatori.showDetails'), '0');
});

test('天气“自动匹配”在选项后标注拍摄时刻的云量来源，识别中、失败与其他模型分别处理', async t => {
  const base = Date.parse('2026-11-04T00:00:00Z') / 1000;
  const time = Array.from({ length: 48 }, (_, hour) => base + hour * 3600);
  const jma = time.map((_, hour) => (hour * 7) % 100), other = time.map((_, hour) => (hour * 13 + 5) % 100);
  let resolveSource;
  installGlobal('__testWeatherSourceLoader', () => new Promise((resolve) => { resolveSource = resolve; }));
  t.after(() => { delete globalThis.__testWeatherSourceLoader; });
  const { parseBestMatchSeries } = await server.ssrLoadModule('/src/domain/environment/weather-source.ts');
  await workspace(t); await readyTerrain();
  const option = () => document.querySelector('[aria-label="天气预测模型"] option[value="best_match"]');
  assert.equal(option().textContent, '自动匹配', 'weather off: nothing to identify');
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => resolveSource);
  assert.equal(option().textContent, '自动匹配（识别来源中）');
  await act(async () => resolveSource(parseBestMatchSeries({ hourly: {
    time, cloud_cover_best_match: jma, cloud_cover_jma_seamless: jma, cloud_cover_gfs_seamless: other,
  } })));
  await settle();
  assert.equal(option().textContent, '自动匹配（日本气象厅 JMA）');
  await waitUntil(() => document.querySelector('[data-weather-phase="ready"]'));
  assert.match(document.querySelector('.weather-source').textContent, /自动匹配此刻的云量来自日本气象厅 JMA/);
  // A single global model needs no note; the auto option goes back to its plain name.
  await settle(() => setControl(document.querySelector('[aria-label="天气预测模型"]'), 'gfs_seamless'));
  assert.equal(option().textContent, '自动匹配');
  assert.doesNotMatch(document.querySelector('.weather-source')?.textContent ?? '', /云量来自/);
});

test('地图方位线：日月默认画出，随图层开关增减，银心跟随银河；图例只列出现的天体', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const features = () => map.getSource('tamatamatori-body-lines').data.features;
  const bodies = () => [...new Set(features().map((feature) => feature.properties.body))].sort();
  await waitUntil(() => features().length > 0);
  assert.deepEqual(bodies(), ['moon', 'sun']);
  const sunNow = features().find((feature) => feature.properties.body === 'sun' && feature.properties.kind === 'now');
  assert.equal(sunNow.properties.above, false, '17:00 in Tokyo: below the horizon, drawn dotted');
  assert.deepEqual(sunNow.geometry.coordinates[0], [value('经度'), value('纬度')]);
  assert.deepEqual([...document.querySelectorAll('.map-legend span:not(.map-legend-note)')].map((item) => item.textContent), ['太阳', '月亮']);
  // Each line is named at its end; the shooting direction too, its label outside the end whatever the map's rotation.
  const labels = () => map.getSource('tamatamatori-line-labels').data.features;
  const texts = () => labels().map((feature) => feature.properties.text);
  assert.ok(texts().includes('太阳 · 地平线下'), texts().join());
  assert.ok(texts().some((text) => /^月亮/.test(text)));
  assert.ok(texts().some((text) => /日落 \d\d:\d\d/.test(text)), texts().join());
  const aim = labels().find((feature) => feature.properties.text === '拍摄方向');
  assert.ok(aim);
  await settle(() => setControl(input('方位角'), 90));
  assert.equal(labels().find((feature) => feature.properties.text === '拍摄方向').properties.anchor, 'left', 'pointing east: the text to the right of the end');
  await settle(() => setControl(input('方位角'), 180));
  assert.equal(labels().find((feature) => feature.properties.text === '拍摄方向').properties.anchor, 'top');
  await settle(() => document.querySelector('[aria-label="显示月亮"]').click());
  assert.ok(!texts().some((text) => /月/.test(text)), 'labels follow the layers');
  assert.deepEqual(bodies(), ['sun']);
  await settle(() => document.querySelector('[aria-label="显示银河"]').click());
  assert.deepEqual(bodies(), ['core', 'sun']);
  assert.ok(features().some((feature) => feature.properties.body === 'core' && feature.properties.kind !== 'now'));
  assert.deepEqual([...document.querySelectorAll('.map-legend span:not(.map-legend-note)')].map((item) => item.textContent), ['太阳', '银心']);
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  await settle(() => document.querySelector('[aria-label="显示银河"]').click());
  assert.deepEqual(features(), []);
  assert.deepEqual(texts(), ['拍摄方向']);
  assert.equal(document.querySelector('.map-legend'), null);
});

test('地点搜索只在提交时查询，坐标直接定位不发请求；选中结果只移动地图，“设为机位”才改计划', async t => {
  const queries = [];
  installGlobal('__testPlaceSearch', async (query) => {
    queries.push(query);
    if (query === '无此地') return [];
    if (query === '出错') throw new Error('地点搜索失败（503）');
    return [{ name: '富士山', detail: '富士山, 静冈县, 日本', latitude: 35.3606, longitude: 138.7274, bounds: [35.35, 35.37, 138.71, 138.74] }];
  });
  t.after(() => { delete globalThis.__testPlaceSearch; });
  const { map } = await workspace(t); await readyTerrain();
  const before = { latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime() };
  await settle(() => document.querySelector('[aria-label="搜索地点"]').click());
  const field = () => document.querySelector('.map-search input[type="search"]');
  await settle(() => setControl(field(), '富士'));
  assert.deepEqual(queries, [], 'typing alone never searches');
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await waitUntil(() => document.querySelector('.map-search-results button'));
  assert.deepEqual(queries, ['富士']);
  assert.match(document.querySelector('.map-search-credit').textContent, /OpenStreetMap 贡献者.*Nominatim/);
  await settle(() => document.querySelector('.map-search-results button').click());
  assert.equal(document.querySelector('.map-search'), null);
  assert.match(document.querySelector('.map-target-card').textContent, /富士山/);
  assert.ok(map.transitions.some((move) => move.bounds), 'the map fits the place');
  assert.deepEqual({ latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime() }, before, 'browsing only');
  const target = TestMarker.instances.find((marker) => marker.getElement().classList.contains('map-target-marker'));
  assert.deepEqual(target.getLngLat(), { lng: 138.7274, lat: 35.3606 });
  await settle(() => document.querySelector('.map-target-apply').click());
  assert.equal(value('纬度'), 35.3606); assert.equal(value('经度'), 138.7274);
  assert.equal(document.querySelector('.map-target-card'), null);
  // Coordinates locate directly; empty results and failures are told apart.
  await settle(() => document.querySelector('[aria-label="搜索地点"]').click());
  await settle(() => setControl(field(), '48.8584, 2.2945'));
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(queries, ['富士']);
  assert.match(document.querySelector('.map-target-card').textContent, /坐标位置.*48\.85840, 2\.29450/);
  await settle(() => document.querySelector('[aria-label="移除地图标记"]').click());
  await settle(() => document.querySelector('[aria-label="搜索地点"]').click());
  await settle(() => setControl(field(), '无此地'));
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await waitUntil(() => /没有找到/.test(document.querySelector('.map-search-status')?.textContent ?? ''));
  await settle(() => setControl(field(), '出错'));
  await settle(() => document.querySelector('.map-search form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await waitUntil(() => /503/.test(document.querySelector('.map-search-error')?.textContent ?? ''));
});

test('我的位置：成功时放置本机标记且不改计划，权限拒绝与不支持分别提示', async t => {
  const original = Object.getOwnPropertyDescriptor(dom.window.navigator, 'geolocation');
  let respond;
  Object.defineProperty(dom.window.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (success, failure) => { respond = { success, failure }; } },
  });
  t.after(() => {
    if (original) Object.defineProperty(dom.window.navigator, 'geolocation', original);
    else delete dom.window.navigator.geolocation;
  });
  await workspace(t); await readyTerrain();
  const before = { latitude: value('纬度'), longitude: value('经度') };
  const locate = () => document.querySelector('[aria-label="我的位置"]');
  await settle(() => locate().click());
  assert.equal(locate().disabled, true);
  assert.match(document.querySelector('.map-feedback').textContent, /正在获取当前位置/);
  await settle(() => respond.success({ coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 35 } }));
  assert.equal(locate().disabled, false);
  assert.match(document.querySelector('.map-target-card').textContent, /我的位置.*31\.23040, 121\.47370 · 精度约 35 m/);
  assert.ok(TestMarker.instances.find((marker) => marker.getElement().classList.contains('map-target-device')));
  assert.deepEqual({ latitude: value('纬度'), longitude: value('经度') }, before);
  await settle(() => locate().click());
  await settle(() => respond.failure({ code: 1 }));
  assert.match(document.querySelector('.map-feedback').textContent, /未获得定位权限/);
  Object.defineProperty(dom.window.navigator, 'geolocation', { configurable: true, value: undefined });
  await settle(() => locate().click());
  assert.match(document.querySelector('.map-feedback').textContent, /此浏览器不支持定位/);
});

test('时间轴标出黄金时刻与蓝调时刻：属于太阳图层，点击跳到起点，极夜时说明没有', async t => {
  await workspace(t); await readyTerrain();
  await setShootingDateTime('2026-11-04T12:00');
  const periods = () => [...document.querySelectorAll('.light-period')].map((item) => item.dataset.period);
  assert.deepEqual(periods(), ['blue', 'golden', 'golden', 'blue']);
  const evening = document.querySelectorAll('.light-period[data-period="golden"]')[1];
  assert.match(evening.getAttribute('aria-label'), /^跳到黄金时刻开始 16:11–17:03$/);
  assert.match(evening.title, /−4°—6°/);
  await settle(() => evening.click());
  assert.equal(shootingDateTime(), '2026-11-04T16:11');
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  assert.deepEqual(periods(), []);
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  await settle(() => setControl(input('纬度'), 78.2232));
  await settle(() => setControl(input('经度'), 15.6267));
  await chooseTimeZone('Arctic/Longyearbyen', 'Longyearbyen');
  await setShootingDateTime('2026-12-15T12:00');
  assert.deepEqual(periods(), []);
  assert.match(document.querySelector('.time-missing').textContent, /黄金时刻与蓝调时刻/);
});

test('自定义传感器：从当前尺寸开始，修改宽高即改变视场，切回预设恢复预设尺寸', async t => {
  await workspace(t); await readyTerrain();
  const sensor = document.querySelector('[aria-label="传感器"]');
  const horizontal = () => Number(document.querySelector('[aria-label^="取景辅助线"]').getAttribute('aria-label').match(/水平视场 ([\d.]+)/)[1]);
  const fullFrame = horizontal();
  assert.equal(document.querySelector('.custom-sensor'), null);
  await settle(() => setControl(sensor, 'custom'));
  assert.equal(value('传感器宽'), 36); assert.equal(value('传感器高'), 24);
  assert.equal(horizontal(), fullFrame);
  await settle(() => setControl(input('传感器宽'), 43.8));
  await settle(() => setControl(input('传感器高'), 32.9));
  assert.ok(horizontal() > fullFrame);
  assert.equal(horizontal().toFixed(1), (2 * Math.atan(43.8 / 70) * 180 / Math.PI).toFixed(1));
  await settle(() => setControl(input('传感器宽'), 0.5));
  assert.match(document.querySelector('.sensor-field .field-error').textContent, /1 至 100 mm/);
  await settle(() => setControl(sensor, 'aps-c'));
  assert.equal(document.querySelector('.custom-sensor'), null);
  assert.ok(horizontal() < fullFrame);
  await settle(() => setControl(sensor, 'custom'));
  assert.equal(value('传感器宽'), 43.8, 'the custom size is remembered while the page is open');
});

test('预览周围的行固定存在：云量条、黄金/蓝调行与状态行不随数据或图层出现消失，数据提示浮在画面上', async t => {
  await workspace(t); const map = await readyTerrain();
  const rows = () => ['.light-periods', '.cloud-strip', '.time-status', '.time-markers'].map((selector) => document.querySelectorAll(`.timeline ${selector}`).length);
  assert.deepEqual(rows(), [1, 1, 1, 1]);
  // Without weather the strip is an empty slot; with a forecast it is painted.
  assert.equal(document.querySelector('.cloud-strip').classList.contains('has-clouds'), false);
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  await waitUntil(() => document.querySelector('.cloud-strip.has-clouds'));
  // Switching the model clears the forecast for a moment; the slot stays.
  stubs.weatherLoader = () => new Promise(() => {});
  await settle(() => setControl(document.querySelector('[aria-label="天气预测模型"]'), 'gfs_seamless'));
  assert.equal(document.querySelector('.cloud-strip.has-clouds'), null);
  assert.deepEqual(rows(), [1, 1, 1, 1]);
  // The Sun layer off leaves the golden/blue row empty but in place.
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  assert.equal(document.querySelectorAll('.light-period').length, 0);
  assert.deepEqual(rows(), [1, 1, 1, 1]);
  // Light-pollution and weather alerts sit over the frame, not above it.
  stubs.pollutionResponse = async () => { throw new Error('测试光污染失败'); };
  await settle(() => document.querySelector('[aria-label="当地光污染"]').click());
  await waitUntil(() => document.querySelector('.pollution-status'));
  assert.ok(document.querySelector('.pollution-status').closest('.viewfinder-wrap .preview-alerts'));
  assert.equal(document.querySelector('.preview-content > .pollution-status, .preview-content > .weather-status'), null);
  assert.equal(terrainMap(), map);
});

test('日食：太阳分组给出食况与食带位置，时间轴标出接触时刻，地图画出食带，预览信息条写出遮挡，跳转只改时间', async t => {
  const { map } = await workspace(t); await readyTerrain();
  await settle(() => setControl(input('纬度'), 25.687));
  await settle(() => setControl(input('经度'), 32.64));
  await chooseTimeZone('UTC');
  await setShootingDateTime('2027-08-02T10:05');
  const sun = () => document.querySelector('[data-eclipse="sun"]');
  assert.match(sun().textContent, /日全食中/);
  assert.match(sun().textContent, /本时段日全食/);
  assert.match(sun().textContent, /机位在全食带内/);
  assert.match(sun().textContent, /减光滤镜/);
  const contacts = () => [...document.querySelectorAll('.time-marker[data-event="solar-eclipse"]')]
    .map((marker) => marker.getAttribute('aria-label').replace(/^跳到/, '').split(' ')[0]);
  assert.deepEqual(contacts(), ['初亏', '食既', '食甚', '生光', '复圆']);
  assert.equal(document.querySelector('[data-eclipse-fact]').textContent, '日全食 · 天空按暮光近似');
  const kinds = () => map.getSource('tamatamatori-eclipse').data.features.map((feature) => feature.properties.kind);
  await waitUntil(() => kinds().length);
  assert.deepEqual(kinds(), ['band', 'centre', 'umbra']);
  assert.match(document.querySelector('[data-eclipse-legend]').textContent, /全食带/);
  // Outside the band: the nearest edge is to the south of Madrid.
  await settle(() => setControl(input('纬度'), 40.4));
  await settle(() => setControl(input('经度'), -3.7));
  assert.match(document.querySelector('[data-eclipse-path]').textContent, /离全食带约 \d+ km（(南|东南|西南)）/);
  // Jumping changes the time only.
  await setShootingDateTime('2027-08-02T06:00');
  assert.equal(document.querySelector('[data-eclipse-fact]'), null);
  await settle(() => document.querySelector('[aria-label="跳到日食食甚"]').click());
  assert.equal(shootingDateTime(), "2027-08-02T08:51");
  assert.equal(value('纬度'), 40.4);
  // The Sun layer owns all of it.
  await settle(() => document.querySelector('[aria-label="显示太阳"]').click());
  assert.deepEqual(contacts(), []);
  assert.equal(sun(), null);
  await waitUntil(() => !kinds().length);
});

test('月食与下次：月亮分组给出月偏食与接触时刻（不标半影始末），没有食时给出下次可见月食并可跳到食甚', async t => {
  await workspace(t); await readyTerrain();
  await settle(() => setControl(input('纬度'), 35.68));
  await settle(() => setControl(input('经度'), 139.77));
  await chooseTimeZone('Asia/Tokyo', 'Tokyo');
  await setShootingDateTime('2026-11-12T21:00');
  const moon = () => document.querySelector('[data-eclipse="moon"]');
  assert.match(moon().textContent, /下次可见月食：2028-07-07 月偏食/);
  assert.match(document.querySelector('[data-eclipse="sun"]').textContent, /下次本地可见：2030-06-01 日偏食/);
  assert.match(document.querySelector('[data-eclipse="sun"]').textContent, /下次日环食（全球）：2027-02-0[67]/);
  await settle(() => document.querySelector('[aria-label="跳到下次月食食甚"]').click());
  assert.equal(shootingDateTime(), '2028-07-07T03:19');
  assert.match(moon().textContent, /月偏食中/);
  assert.match(moon().textContent, /本时段月偏食/);
  assert.match(moon().textContent, /本影食分 0\.\d\d/);
  const contacts = [...document.querySelectorAll('.time-marker[data-event="lunar-eclipse"]')]
    .map((marker) => marker.getAttribute('aria-label').replace(/^跳到/, '').split(' ')[0]);
  assert.deepEqual(contacts, ['初亏', '食甚', '复圆']);
  assert.equal(document.querySelector('[data-eclipse-fact]').textContent, '月食 · 地影色为示意');
});

test('潮汐图层：读取最近海洋格点，右栏给出潮位与涨落，时间轴标高低潮，地图标格点；失败可重试，超出范围与无海洋格点分别说明', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const tides = await server.ssrLoadModule('/src/domain/environment/tides.ts');
  const requests = [];
  const series = (span) => {
    const start = Date.parse(span.start) - 3 * 3_600_000;
    const heights = Array.from({ length: 30 }, (_, index) => Number((0.7 * Math.sin((2 * Math.PI * index) / 12.42)).toFixed(2)));
    return { fetchedAt: Date.now(), cell: { latitude: 35.29, longitude: 139.46, distance: 4.2 }, start, heights };
  };
  installGlobal('__testTideLoader', async (point, span) => { requests.push({ point, span }); return series(span); });
  t.after(() => { delete globalThis.__testTideLoader; });
  await setShootingDateTime('2026-11-12T10:00');
  await settle(() => document.querySelector('[aria-label="显示潮汐"]').click());
  await waitUntil(() => document.querySelector('.tide-now'));
  assert.equal(requests.length, 1);
  assert.match(document.querySelector('.tide-now').textContent, /^[+−]\d\.\d\d m · (涨潮中|落潮中)$/);
  assert.match(document.querySelector('.tide-readout').textContent, /下次高潮/);
  assert.match(document.querySelector('.tide-readout').textContent, /潮位格点距机位约 4 km/);
  assert.ok(document.querySelector('.tide-chart path.tide-curve').getAttribute('d').startsWith('M'));
  const marks = [...document.querySelectorAll('.time-marker[data-event^="tide-"]')].map((marker) => marker.dataset.event);
  assert.ok(marks.includes('tide-high') && marks.includes('tide-low'), marks.join());
  assert.match(document.querySelector('[data-tide-fact]').textContent, /^潮位 [+−]\d\.\d\d m · (涨潮|落潮)$/);
  await waitUntil(() => map.getSource('tamatamatori-environment')?.data.features.some((feature) => feature.properties.kind === 'tide-cell'));
  assert.ok(document.querySelector('[data-tide-legend]'));
  // A failed request offers a retry; out-of-range and no-sea answers are explained, not retried.
  installGlobal('__testTideLoader', async () => { throw new Error('潮位数据请求失败（500）'); });
  await setShootingDateTime('2026-11-13T10:00');
  await waitUntil(() => document.querySelector('.tide-status button'));
  assert.match(document.querySelector('.tide-status').textContent, /潮位数据请求失败（500）/);
  installGlobal('__testTideLoader', async () => { throw new tides.TideRangeError(); });
  await settle(() => document.querySelector('.tide-status button').click());
  await waitUntil(() => /超出潮位数据范围/.test(document.querySelector('.tide-status')?.textContent ?? ''));
  assert.equal(document.querySelector('.tide-status button'), null);
  installGlobal('__testTideLoader', async () => { throw new tides.NoSeaError(); });
  await setShootingDateTime('2026-11-14T10:00');
  await waitUntil(() => /没有海洋格点/.test(document.querySelector('.tide-status')?.textContent ?? ''));
  assert.equal(document.querySelectorAll('.time-marker[data-event^="tide-"]').length, 0);
  // Off: no markers, no fact, no map cell.
  await settle(() => document.querySelector('[aria-label="显示潮汐"]').click());
  assert.equal(document.querySelector('[data-tide-fact]'), null);
  await waitUntil(() => !map.getSource('tamatamatori-environment').data.features.length);
});

test('极光图层：按拍摄时刻选 Kp 口径，给出能否看到与方向，时间轴标出可能时段，地图画边界与可见线，并把时间轴改为夜间', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const start = Date.UTC(2026, 10, 10, 0);
  const kp = Array.from({ length: 40 }, (_, index) => ({ start: start + index * 3 * 3_600_000, end: start + (index + 1) * 3 * 3_600_000, kp: 6, kind: 'predicted' }));
  const outlook = [{ start: Date.UTC(2026, 10, 20), end: Date.UTC(2026, 10, 21), kp: 3, kind: 'outlook' }];
  installGlobal('__testKpLoader', async () => ({ kp, outlook, fetchedAt: Date.now() }));
  t.after(() => { delete globalThis.__testKpLoader; });
  await settle(() => setControl(input('纬度'), 55.95));
  await settle(() => setControl(input('经度'), -3.19));
  await chooseTimeZone('Europe/London', 'London');
  await setShootingDateTime('2026-11-11T23:00');
  await settle(() => document.querySelector('[aria-label="显示极光"]').click());
  await waitUntil(() => document.querySelector('.aurora-verdict'));
  assert.equal(document.querySelector('.timeline').dataset.mode, 'night');
  assert.match(document.querySelector('.aurora-source').textContent, /Kp 预报/);
  assert.match(document.querySelector('.aurora-verdict').textContent, /Kp 6 · 可能低悬北方天空，顶部约 \d+°/);
  assert.match(document.querySelector('.aurora-need').textContent, /本地需 Kp ≥/);
  assert.equal(document.querySelectorAll('.time-marker[data-event="aurora"]').length, 1);
  assert.match(document.querySelector('[data-aurora-fact]').textContent, /^极光 Kp 6 · 北方低空$/);
  await waitUntil(() => map.getSource('tamatamatori-environment')?.data.features.filter((feature) => /^aurora-(edge|view)$/.test(feature.properties.kind)).length === 4);
  assert.ok(document.querySelector('[data-aurora-legend]'));
  // Daytime: the verdict stays but the sky is too bright; no preview fact.
  await setShootingDateTime('2026-11-11T13:00');
  assert.match(document.querySelector('.aurora-dark').textContent, /天太亮/);
  assert.equal(document.querySelector('[data-aurora-fact]'), null);
  // Outlook days and beyond.
  await setShootingDateTime('2026-11-20T23:00');
  assert.match(document.querySelector('.aurora-source').textContent, /27 天展望/);
  await setShootingDateTime('2026-12-30T23:00');
  assert.match(document.querySelector('.aurora-status').textContent, /超出预报时效/);
  // Failure and retry.
  installGlobal('__testKpLoader', async () => { throw new Error('Kp 预报请求失败（503）'); });
  await settle(() => document.querySelector('[aria-label="显示极光"]').click());
  await settle(() => document.querySelector('[aria-label="显示极光"]').click());
  await waitUntil(() => document.querySelector('.aurora-status button'));
  installGlobal('__testKpLoader', async () => ({ kp, outlook, fetchedAt: Date.now() }));
  await setShootingDateTime('2026-11-11T23:00');
  await settle(() => document.querySelector('.aurora-status button').click());
  await waitUntil(() => document.querySelector('.aurora-verdict'));
});

test('Open-Meteo 用量：开启天气或潮汐时在光照与环境中显示本浏览器的近 24 小时用量，接近上限与限流分别提示', async t => {
  await workspace(t); await readyTerrain();
  const usage = await server.ssrLoadModule('/src/io/api-usage.ts');
  const line = () => document.querySelector('.api-usage');
  assert.equal(line(), null);
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  assert.match(line().textContent, /^Open-Meteo 用量（本浏览器）：近 24 小时约 0 \/ 10,000 次/);
  assert.equal(line().dataset.usage, 'ok');
  const now = Date.now();
  await settle(() => usage.recordOpenMeteo(new Response('{}', { headers: { 'X-RateLimit-Cost': '1.2', 'X-RateLimit-Remaining': '590', 'X-RateLimit-Limit': '600', 'X-RateLimit-Reset': String(Math.floor(now / 1000) + 50), 'X-RateLimit-Window': '60' } }), 1, now));
  await settle(() => usage.recordOpenMeteo(new Response('{}'), 13, now));
  assert.match(line().textContent, /近 24 小时约 14\.2 \/ 10,000 次/);
  assert.match(line().querySelector('.info-detail').textContent, /近 1 小时 14\.2 \/ 5,000 · 近 1 分钟 14\.2 \/ 600 · 同一 IP 本分钟剩余 590 · 按访问者 IP 计数/);
  // Near the hourly limit, then rate-limited.
  await settle(() => usage.recordOpenMeteo(new Response('{}'), 4000, now));
  assert.equal(line().dataset.usage, 'near');
  assert.match(line().textContent, /接近免费上限/);
  await settle(() => usage.recordOpenMeteo(new Response('{}', { status: 429, headers: { 'Retry-After': '40' } }), 1, now));
  assert.equal(line().dataset.usage, 'limited');
  assert.match(line().textContent, /已限流，约 \d+ 秒后恢复/);
  // Still listed while weather is off, because calls were made today.
  await settle(() => document.querySelector('[aria-label="天气效果"]').click());
  assert.ok(line());
});
