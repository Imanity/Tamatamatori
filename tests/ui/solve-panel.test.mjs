// Workspace interaction tests: the solve (推算) panel and shot links. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { parseShotText, shotFromPlan, shotLink } from "../../src/domain/shots/shot.ts";
import { parseSolveText2 } from "../../src/domain/solve/solve.ts";
import { skyAt, toRay, travel } from "../../src/domain/solve/position-alignment.ts";
import { direction } from "../../src/domain/core/ephemeris.ts";
import { initialPlan } from "../../src/domain/core/plan.ts";
import { stubs, dom, pollutionRequests, installGlobal, settle, workspace, input, inputIn, shootingDateTime, setShootingDateTime, value, button, clickMap, setControl, waitUntil, readyTerrain, shotButton, openShots, savedShots, panel, solvability, resultStatus, dayRows, rowItems, targetRow, searchNow, searched, tokyoTime, placed, fujiRequest, openSolveLink, enterSolve, appModule } from "./harness.mjs";

test('推算·固定机位与朝向：加天体、固定机位与朝向后搜索，结果按天列出并标在时间轴；试看只改时刻与图层，返回推算前只恢复这两类字段；改动条件后结果标为过期', async t => {
  await workspace(t); await readyTerrain();
  const solveButton = () => document.querySelector('.solve-button');
  const sunSwitch = () => document.querySelector('[aria-label="显示太阳"]');
  const railTab = (name) => [...document.querySelectorAll('.rail-tabs [role="tab"]')].find((tab) => tab.textContent.trim() === name);
  assert.equal(panel(), null);
  const before = shootingDateTime();
  // The camera faces the summit of Fuji from the default shore, at 400 mm.
  await settle(() => setControl(input('方位角'), 244.63));
  await settle(() => setControl(input('俯仰角'), 10.74));
  await settle(() => setControl(input('焦距'), 400));
  await enterSolve();
  assert.equal(solveButton().getAttribute('aria-pressed'), 'true');
  assert.ok(panel());
  assert.equal(document.querySelector('.info-sidebar').getAttribute('aria-label'), '推算');
  assert.equal(document.querySelector('.info-body').hidden, true);
  assert.match(solvability(), /先加目标/);
  assert.equal(document.querySelector('.composition-search-button').disabled, true);
  // One body: any time works, unless the camera direction is fixed too.
  await settle(() => button('+ 天体').click());
  await settle(() => document.querySelector('.composition-editor input[value="sun"]').click());
  assert.match(targetRow('太阳').textContent, /天体 · 画面中心 · ±3%/);
  assert.match(solvability(), /只有一个天体/);
  await settle(() => setControl(document.querySelector('select[aria-label="机位范围"]'), 'fixed'));
  await settle(() => document.querySelector('.composition-range .composition-check input').click());
  assert.match(document.querySelector('.composition-range').textContent, /同时固定当前朝向（方位 244\.6°，俯仰 10\.7°）/);
  assert.match(solvability(), /机位与朝向固定：求太阳落到画面位置的时刻/);
  assert.ok(document.querySelector('[data-composition-marks] .alignment-mark-sun'), 'the Sun\'s place is drawn in the preview');
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 365));
  // An explicit search: two passes in the next 12 months.
  assert.equal(document.querySelector('.alignment-results'), null, 'nothing is searched before asking');
  await searchNow(); await searched();
  assert.match(resultStatus(), /12 个月内 2 天、2 段/);
  const days = dayRows().map((row) => row.querySelector('.composition-day-name strong').textContent);
  assert.match(days[0], /^2\/12 周五 16:2\d–16:2\d$/);
  assert.match(days[1], /^10\/30 .* 15:5\d–15:5\d$/);
  // Turn the Sun off; the try-out turns it on and only moves the instant.
  await settle(() => railTab('信息').click());
  await settle(() => sunSwitch().click());
  assert.equal(sunSwitch().checked, false);
  await settle(() => railTab('推算').click());
  await settle(() => dayRows()[0].querySelector('.composition-day > button[aria-label^="试看"]').click());
  assert.equal(shootingDateTime(), '2027-02-12T16:22');
  assert.equal(sunSwitch().checked, true);
  assert.equal(value('方位角'), 244.63);
  assert.equal(value('俯仰角'), 10.74);
  assert.ok(dayRows()[0].classList.contains('is-current'));
  assert.match(document.querySelector('.alignment-current').textContent, /正在试看 2\/12 周五 16:22/);
  const marker = document.querySelector('.time-marker[data-event="alignment"]');
  assert.ok(marker);
  // The Sun sits at the centre of the frame within the tolerance.
  const sun = skyAt('sun', tokyoTime(), value('纬度'), value('经度'), 'standard');
  const at = placed(direction(sun.azimuth, sun.elevation));
  assert.ok(Math.hypot(at.x * 1.5, at.y) / 2 < 0.03, `${at.x}, ${at.y}`);
  // The user's own edits survive "返回推算前"; the instant and the Sun switch go back.
  await settle(() => setControl(input('焦距'), 85));
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/, 'a new lens moves the places');
  await settle(() => button('返回推算前').click());
  assert.equal(shootingDateTime(), before);
  assert.equal(sunSwitch().checked, false);
  assert.equal(value('焦距'), 85);
  assert.equal([...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '返回推算前'), undefined, 'nothing left to return from');
  await settle(() => setControl(input('焦距'), 400));
  assert.doesNotMatch(document.querySelector('.composition-search').textContent, /条件已改/);
  // Nudging the Sun's mark changes the conditions: the results stay until searched again.
  await settle(() => document.querySelector('[data-composition-marks] .alignment-handle').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  assert.match(targetRow('太阳').textContent, /自左 50%、自上 49%/);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  assert.equal(dayRows().length, 2);
  // Leaving the mode removes the panel, the marks and the timeline instants.
  await settle(() => solveButton().click());
  assert.equal(panel(), null);
  assert.equal(document.querySelector('[data-composition-marks]'), null);
  assert.equal(document.querySelector('.time-marker[data-event="alignment"]'), null);
  assert.equal(document.querySelector('.info-body').hidden, false);
  assert.equal(document.querySelector('.rail-tabs'), null);
});

test('推算：可解性提示随目标、范围与筛选变化；高纬度冬季给出达不到的原因；窄屏进入模式时出现并选中“推算”标签，退出后移除', async t => {
  const listeners = new Set();
  const narrow = { matches: true, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  const original = window.matchMedia;
  window.matchMedia = (query) => query === '(max-width: 1099px)' ? narrow : { matches: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { window.matchMedia = original; });
  await workspace(t); await readyTerrain();
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(1, 1); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const layout = document.querySelector('.app-layout');
  const tabs = () => [...document.querySelectorAll('.mobile-tabs [role="tab"]')].map((tab) => tab.textContent.trim());
  await settle(() => setControl(input('纬度'), 69.65));
  await settle(() => setControl(input('经度'), 18.96));
  await settle(() => setControl(input('方位角'), 180));
  await settle(() => setControl(input('俯仰角'), 10));
  await setShootingDateTime('2026-11-25T12:00');
  await enterSolve();
  assert.deepEqual(tabs(), ['地图', '相机', '图层', '推算']);
  assert.equal(layout.dataset.mobileTab, 'solve');
  assert.equal(document.querySelector('.rail-tabs'), null, 'the bottom tabs choose the content on narrow screens');
  assert.equal(document.querySelector('.solve-body').hidden, false);
  // A ground point from the landmark list.
  await settle(() => button('+ 地面点').click());
  assert.match(document.querySelector('.composition-pending').textContent, /在地图上单击要拍的地方/);
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  assert.ok(targetRow('晴空塔'));
  assert.match(targetRow('晴空塔').textContent, /距地表 634 m · 自左 50%、自上 67%/);
  assert.match(solvability(), /只有一个地面点：任何机位都能对准它/);
  await settle(() => button('+ 天体').click());
  assert.ok(targetRow('月亮'));
  assert.match(targetRow('月亮').textContent, /自左 50%、自上 67%/, 'a new body starts on the ground point');
  assert.match(solvability(), /结果为机位线/);
  assert.doesNotMatch(solvability(), /另有/);
  // Up to four targets: the rest are checked minute by minute.
  await settle(() => button('+ 天体').click());
  assert.equal(document.querySelectorAll('.composition-target-list > li').length, 3);
  assert.match(solvability(), /结果为机位线.*另有 1 个目标按容差逐分钟检查/);
  assert.equal(document.querySelector('.composition-targets .alignment-hint'), null, 'no how-to once there are targets');
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-tower'));
  assert.match(targetRow('东京塔').textContent, /自左 30%、自上 78%/, 'a second ground point lower left');
  assert.match(solvability(), /另有 2 个目标/);
  assert.equal(button('+ 天体').disabled, true, 'four targets at most');
  assert.equal(button('+ 地面点').disabled, true);
  for (const target of [...document.querySelectorAll('.composition-target-list > li')].slice(2))
    await settle(() => target.querySelector('[aria-label^="删除目标"]').click());
  assert.equal(document.querySelectorAll('.composition-target-list > li').length, 2);
  await settle(() => setControl(document.querySelector('select[aria-label="时间范围"]'), 'instant'));
  assert.match(solvability(), /时刻固定：结果为机位点/);
  await settle(() => setControl(document.querySelector('select[aria-label="机位范围"]'), 'fixed'));
  assert.match(solvability(), /机位与时刻都已固定/);
  assert.equal(document.querySelector('.composition-search-button').disabled, true);
  await settle(() => setControl(document.querySelector('select[aria-label="时间范围"]'), 'range'));
  assert.match(solvability(), /机位固定：由“晴空塔”定朝向，求月亮经过画面位置的时刻/);
  await settle(() => document.querySelector('.composition-range .composition-check input').click());
  assert.match(solvability(), /固定朝向时，地面点在画面中的位置由朝向决定/);
  // A filter that contradicts a target is named.
  await settle(() => setControl(document.querySelector('select[aria-label="添加筛选"]'), 'moonDown'));
  assert.match(solvability(), /目标里有月亮，却要求“月亮在地平线下”/);
  await settle(() => document.querySelector('[aria-label="删除筛选 月亮在地平线下"]').click());
  // The Sun 10° high in the south from Tromsø, fixed camera and direction: never that high in late November.
  await settle(() => document.querySelector('[aria-label="删除目标 晴空塔"]').click());
  await settle(() => targetRow('月亮').querySelector('.composition-target-name').click());
  if (!targetRow('月亮').querySelector('.composition-editor')) await settle(() => targetRow('月亮').querySelector('.composition-target-name').click());
  await settle(() => targetRow('月亮').querySelector('input[value="sun"]').click());
  await settle(() => setControl(inputIn(targetRow('太阳'), '自上'), 50));
  assert.match(solvability(), /机位与朝向固定：求太阳落到画面位置的时刻/);
  await searchNow(); await searched();
  assert.match(resultStatus(), /太阳达不到画面位置对应的高度（10\.0°）/);
  await settle(() => [...document.querySelectorAll('.mobile-tabs [role="tab"]')].find((tab) => tab.textContent.trim() === '图层').click());
  assert.equal(document.querySelector('.solve-body').hidden, true);
  assert.equal(document.querySelector('.info-body').hidden, false);
  await settle(() => document.querySelector('.solve-button').click());
  assert.deepEqual(tabs(), ['地图', '相机', '图层']);
});

test('推算·地面点与天体（机位线）：地标与太阳各在画面位置，按天结果、地图与时间轴；试看让两者落在各自的位置，段内滑杆同时移动机位与时刻，返回推算前恢复；地图点选地面点与海拔', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const tiles = [];
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { tiles.push(points.length); progress?.(3, 3); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const features = () => map.getSource('tamatamatori-alignment').data.features;
  // Labels can fold into dots next to sunrise or sunset; the accessible name always names them.
  const markers = () => [...document.querySelectorAll('.time-marker[data-event="alignment"]')].map((marker) => marker.getAttribute('aria-label').replace(/^跳到(\S+) .*$/, '$1'));
  const before = { latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime(), azimuth: value('方位角'), pitch: value('俯仰角') };
  await enterSolve();
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  assert.equal(Number(inputIn(targetRow('晴空塔'), '距地表').value), 634);
  assert.ok(document.querySelector('.composition-ground-handle'), 'the ground point is drawn in the preview');
  // The Sun above the tower: the tower's top on the lower third line, the Sun at the centre.
  await settle(() => button('+ 天体').click());
  await settle(() => targetRow('月亮').querySelector('input[value="sun"]').click());
  await settle(() => setControl(inputIn(targetRow('太阳'), '自上'), 50));
  assert.match(targetRow('太阳').textContent, /画面中心/);
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await searchNow();
  await waitUntil(() => /当天 1 天、\d+ 段，共 \d+ 分钟/.test(resultStatus()));
  // The target's own ground first (for the altitude pre-filter), then the corridor once.
  assert.ok(tiles.length === 2 && tiles[0] === 1 && tiles[1] > 100, `the terrain corridor is read once before solving: ${tiles}`);
  assert.doesNotMatch(panel().textContent, /DEM|通视/);
  const kinds = new Set(features().map((feature) => feature.properties.kind));
  assert.ok(['target', 'ring', 'segment', 'label'].every((kind) => kinds.has(kind)), [...kinds].join());
  assert.ok(map.transitions.some((move) => move.bounds), 'the map fits the result');
  assert.match(document.querySelector('[data-alignment-legend]').textContent, /线上各点在标注时刻对齐/);
  assert.ok(markers().includes('对齐始') && markers().includes('对齐终'));
  // The Sun 6° above the top all day: daylight only, one stretch, listed at once.
  assert.equal(dayRows().length, 1);
  assert.ok(rowItems().length >= 1, 'one day: its stretches are listed at once');
  assert.match(rowItems()[0].textContent, /白天/);
  assert.match(rowItems()[0].textContent, /\d\d:\d\d–\d\d:\d\d.*目标在.+ · 距 [\d.]+—[\d.]+ km/);
  // A try-out puts the tower's top and the Sun at their places.
  await settle(() => rowItems()[0].querySelector('button').click());
  assert.ok(rowItems()[0].classList.contains('is-current'));
  assert.notEqual(shootingDateTime(), before.time);
  const top = toRay({ latitude: value('纬度'), longitude: value('经度'), ellipsoidalHeight: 1.6 }, { latitude: 35.71004508243534, longitude: 139.81071889400482, ellipsoidalHeight: 634 });
  const topAt = placed(top.ray);
  assert.ok(Math.abs(topAt.x) < 2e-3 && Math.abs(topAt.y - 1 / 3) < 2e-3, `top at ${topAt.x}, ${topAt.y}`);
  const sun = skyAt('sun', tokyoTime(), value('纬度'), value('经度'), 'standard');
  const sunAt = placed(direction(sun.azimuth, sun.elevation));
  assert.ok(Math.hypot(sunAt.x, sunAt.y) < 3e-3, `Sun at ${sunAt.x}, ${sunAt.y}`);
  assert.match(document.querySelector('.alignment-current').textContent, /正在试看 \d+\/\d+ .* \d\d:\d\d · 距地面目标 [\d.]+ km（目标在.+）/);
  assert.ok(document.querySelector('.position-profile svg'), 'profile from the camera to the top');
  assert.ok(features().some((feature) => feature.properties.kind === 'segment' && feature.properties.selected));
  const time = shootingDateTime();
  await settle(() => setControl(document.querySelector('input[aria-label="在这段内移动"]'), 0));
  assert.ok(shootingDateTime() < time, 'the slider moves back to the start of the stretch');
  assert.ok(rowItems()[0].classList.contains('is-current'));
  await settle(() => button('返回推算前').click());
  assert.deepEqual({ latitude: value('纬度'), longitude: value('经度'), time: shootingDateTime(), azimuth: value('方位角'), pitch: value('俯仰角') }, before);
  // A ground point picked on the map: Escape cancels; the pick replaces the place.
  await settle(() => targetRow('晴空塔').querySelector('.composition-target-name').click());
  await settle(() => button('在地图上重新点选').click());
  assert.match(document.querySelector('.map-interaction-hint').textContent, /单击放置推算目标/);
  await settle(() => document.querySelector('.real-map').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(button('在地图上重新点选').getAttribute('aria-pressed'), 'false');
  await settle(() => button('在地图上重新点选').click());
  await settle(() => clickMap(map, 138.7274, 35.3606));
  assert.equal(value('纬度'), before.latitude, 'placing the target does not move the camera');
  assert.match(targetRow('地图上选的点').textContent, /距地表 634 m/);
  assert.match(document.querySelector('.composition-editor').textContent, /35\.36060, 138\.72740/);
  // A summit by its elevation: the foot has no meaning then.
  await settle(() => [...document.querySelectorAll('.composition-editor .alignment-aim label')].find((label) => label.textContent.includes('海拔')).querySelector('input').click());
  assert.equal(Number(inputIn(document.querySelector('.composition-editor'), '海拔').value), 3776);
  assert.match(targetRow('地图上选的点').textContent, /海拔 3776 m/);
  assert.equal(document.querySelector('.composition-editor .composition-check input').disabled, true);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  // Leaving the mode clears the map overlay and the timeline marks.
  await settle(() => document.querySelector('.solve-button').click());
  assert.equal(features().length, 0);
  assert.deepEqual(markers(), []);
});

test('推算·底部位置定主体大小：“月亮落在塔尖”模板，多日结果的主体占比在容差内，试看时塔底落在底部位置；拖动底部改变条件；矮目标不能设底部', async t => {
  const { map } = await workspace(t); await readyTerrain();
  const loads = [];
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { loads.push(points.length); progress?.(2, 2); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const kinds = () => new Set(map.getSource('tamatamatori-alignment').data.features.map((feature) => feature.properties.kind));
  await enterSolve();
  await settle(() => button('月亮落在塔尖').click());
  assert.match(targetRow('晴空塔').textContent, /距地表 634 m · 自左 50%、自上 35% · ±3% · 主体约 35%/);
  assert.ok(targetRow('月亮'));
  assert.ok(document.querySelector('.composition-foot-handle'), 'the foot is drawn in the preview');
  assert.match(solvability(), /结果为机位线/);
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 7));
  await searchNow();
  await waitUntil(() => /7 天内 \d+ 天、\d+ 段/.test(resultStatus()));
  assert.equal(loads.filter((count) => count > 1).length, 1, 'the terrain corridor is read once for all days');
  assert.ok(['target', 'ring', 'sector', 'segment', 'label'].every((kind) => kinds().has(kind)), [...kinds()].join());
  assert.ok(dayRows().length >= 5);
  // Expand a day: every stretch keeps the tower's share within ±3% of 35%.
  await settle(() => dayRows()[0].querySelector('.composition-day-name').click());
  assert.ok(rowItems().length > 0);
  for (const row of rowItems()) {
    const share = row.textContent.match(/主体 (\d+)%—(\d+)%/);
    assert.ok(share && Number(share[1]) >= 31 && Number(share[2]) <= 39, row.textContent);
  }
  // A try-out puts the top at 35% and the foot near 70% of the frame height.
  await settle(() => rowItems()[0].querySelector('button').click());
  const eye = { latitude: value('纬度'), longitude: value('经度'), ellipsoidalHeight: 1.6 };
  const tower = { latitude: 35.71004508243534, longitude: 139.81071889400482 };
  const top = placed(toRay(eye, { ...tower, ellipsoidalHeight: 634 }).ray), foot = placed(toRay(eye, { ...tower, ellipsoidalHeight: 0 }).ray);
  assert.ok(Math.abs((top.y + 1) / 2 - 0.35) < 2e-3, `top ${top.y}`);
  assert.ok(Math.abs((foot.y + 1) / 2 - 0.7) <= 0.031, `foot ${foot.y}`);
  // Moving the foot down asks for a bigger tower: the results are stale.
  await settle(() => document.querySelector('.composition-foot-handle').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.match(targetRow('晴空塔').textContent, /主体约 36%/);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  // A low target has no size: the foot is switched off and cannot be set.
  await settle(() => targetRow('晴空塔').querySelector('.composition-target-name').click());
  await settle(() => setControl(inputIn(targetRow('晴空塔'), '距地表'), 5));
  assert.equal(targetRow('晴空塔').querySelector('.composition-check input').checked, false);
  assert.equal(targetRow('晴空塔').querySelector('.composition-check input').disabled, true);
  assert.equal(document.querySelector('.composition-foot-handle'), null);
});

test('推算·更多目标与星空可见性：第三个地面点随走廊读取地形并逐分钟检查，不在位置的分钟计数；星空可见性按机位读取光污染，没有数据的分钟单独计数', async t => {
  await workspace(t); await readyTerrain();
  const loads = [];
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { loads.push(points); progress?.(2, 2); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  await enterSolve();
  // The Moon on Skytree's top with Tokyo Tower lower left: one day.
  await settle(() => button('月亮落在塔尖').click());
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await setShootingDateTime('2026-11-25T12:00');
  await searchNow(); await searched();
  const alone = resultStatus().match(/共 (\d+) 分钟/);
  assert.ok(alone && Number(alone[1]) > 0, resultStatus());
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-tower'));
  assert.match(solvability(), /另有 1 个目标按容差逐分钟检查/);
  assert.match(document.querySelector('.composition-search').textContent, /条件已改/);
  loads.length = 0;
  await searchNow(); await searched();
  assert.ok(loads.at(-1).some((point) => Math.abs(point.latitude - 35.6586) < 1e-3 && Math.abs(point.longitude - 139.7454) < 1e-3), 'the tower ground is read with the corridor');
  assert.match(resultStatus(), /\d+ 分钟其他目标不在位置/);
  assert.match(resultStatus(), /有 \d+ 分钟月亮与“晴空塔”对齐，但其他目标都不在设定位置/);

  // 星空可见性 on the deep-sky template: light pollution read per camera, missing data counted apart.
  await settle(() => button('深空天体在山顶上方').click());
  await settle(() => setControl(document.querySelector('.composition-range input[aria-label="起始日期"]'), '2026-12-10'));
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 7));
  await searchNow(); await searched();
  assert.match(resultStatus(), /7 天内 \d+ 天/, 'dark, moonless nights before the filter');
  await settle(() => setControl(document.querySelector('select[aria-label="添加筛选"]'), 'darkSky'));
  const limit = document.querySelector('select[aria-label="星空可见性"]');
  assert.equal(limit.value, '21.3');
  assert.deepEqual([...limit.options].map((option) => option.value), ['21.7', '21.3', '20.5', '19.5']);
  assert.match(limit.title, /只在天文夜（太阳低于 −18°）判断/, 'how it is computed, on hover');
  pollutionRequests.length = 0;
  const before = resultStatus().match(/共 (\d+) 分钟/)[1];
  // No data anywhere: every minute is counted apart, none listed.
  stubs.pollutionResponse = async () => null;
  await searchNow(); await searched();
  assert.ok(pollutionRequests.length > 0, 'light pollution is read');
  assert.ok(new Set(pollutionRequests.map((request) => `${request.point.latitude.toFixed(2)}/${request.point.longitude.toFixed(2)}`)).size === pollutionRequests.length, 'once per cell');
  assert.match(resultStatus(), new RegExp(`都不满足筛选条件（其中 ${before} 分钟缺少光污染数据）`));
  assert.match(resultStatus(), new RegExp(`，${before} 分钟缺少光污染数据）$`));
  // A dark site keeps them all.
  stubs.pollutionResponse = async () => ({ artificialMcd: 0.02 });
  await searchNow(); await searched();
  assert.match(resultStatus(), new RegExp(`共 ${before} 分钟`));
  // A night search: rows run from noon to noon, named after the evening.
  assert.match(dayRows()[0].querySelector('.composition-day-name strong').textContent, /^12\/1\d 周.夜 \d\d:\d\d–\d\d:\d\d$/);
  // A bright site fails it instead.
  stubs.pollutionResponse = async () => ({ artificialMcd: 6.5 });
  await settle(() => setControl(document.querySelector('select[aria-label="星空可见性"]'), '21.7'));
  await searchNow(); await searched();
  assert.doesNotMatch(resultStatus(), /缺少光污染数据/);
  assert.match(resultStatus(), /不满足筛选条件|不满足筛选/);
  await settle(() => document.querySelector('[aria-label="删除筛选 星空可见性"]').click());
  assert.equal(document.querySelector('select[aria-label="星空可见性"]'), null);
});

test('机位链接：打开带 #shot= 的地址先预览，应用后清除 hash 并可撤销；关闭预览不改计划', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const before = { focal: value('焦距'), azimuth: value('方位角') };
  const dialog = () => document.querySelector('.shot-dialog[open]');
  const hashOf = (shot) => shotLink(shot, 'http://localhost/').slice('http://localhost/'.length);
  await settle(() => { dom.window.location.hash = hashOf(shotFromPlan({ ...initialPlan, focalLength: 85, azimuth: 200 }, '链接机位')); });
  await waitUntil(() => dialog());
  assert.match(dialog().querySelector('h2').textContent, /导入机位/);
  assert.match(dialog().querySelector('.shot-summary').textContent, /方位 200\.0°.*85 mm/s);
  assert.equal(dialog().querySelector('[aria-label="导入机位名称"]').value, '链接机位');
  assert.equal(value('焦距'), before.focal, 'nothing changes before confirming');
  await settle(() => [...dialog().querySelectorAll('footer button')].find((b) => b.textContent === '仅应用').click());
  assert.equal(dialog(), null);
  assert.equal(dom.window.location.hash, '');
  assert.equal(value('焦距'), 85); assert.equal(value('方位角'), 200);
  assert.match(document.querySelector('.shot-toast').textContent, /已应用「链接机位」/);
  await settle(() => [...document.querySelectorAll('.shot-toast button')].find((b) => b.textContent === '撤销').click());
  assert.equal(value('焦距'), before.focal); assert.equal(value('方位角'), before.azimuth);
  // Closing the preview leaves the plan and still drops the hash; a broken link lists its problems.
  await settle(() => { dom.window.location.hash = hashOf(shotFromPlan({ ...initialPlan, focalLength: 50 }, '不应用')); });
  await waitUntil(() => dialog());
  await settle(() => dialog().querySelector('header button').click());
  assert.equal(dom.window.location.hash, ''); assert.equal(value('焦距'), before.focal);
  await settle(() => { dom.window.location.hash = 'shot=json:' + encodeURIComponent('{"format":"tamatamatori.shot","version":1}'); });
  await waitUntil(() => dialog());
  assert.match(dialog().querySelector('.shot-errors').textContent, /position：缺少该字段/);
  await settle(() => dialog().querySelector('header button').click());
  assert.equal(dom.window.location.hash, '');
});

test('推算·机位最近距离：新建条件缺省 2 km，钻石富士模板 10 km 且不加筛选；结果都在最近距离之外，地图画出内圈', async t => {
  const { map } = await workspace(t); await readyTerrain();
  // A 3000 m cone on flat ground at Fuji's summit.
  const cone = (latitude, longitude) => Math.max(0, 3000 - 0.3 * Math.hypot((latitude - 35.3606) * 111000, (longitude - 138.7274) * 111000 * Math.cos(35.36 * Math.PI / 180)));
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(1, 1); return cone; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  await enterSolve();
  const nearest = () => document.querySelector('select[aria-label="机位最近距离"]');
  assert.equal(nearest().value, '2000');
  assert.deepEqual([...nearest().options].map((option) => option.textContent), ['不限', '1 km', '2 km', '5 km', '10 km']);
  await settle(() => setControl(document.querySelector('select[aria-label="机位最远距离"]'), 10000));
  assert.deepEqual([...nearest().options].map((option) => option.value), ['200', '1000', '2000', '5000'], 'nearer than the farthest');
  await settle(() => button('钻石富士').click());
  assert.equal(nearest().value, '10000');
  assert.equal(document.querySelector('select[aria-label="机位最远距离"]').value, '30000');
  assert.equal(document.querySelectorAll('.composition-filters .composition-remove').length, 0, 'no golden-hour filter');
  await settle(() => setControl(document.querySelector('.composition-range input[aria-label="起始日期"]'), '2026-11-25'));
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await searchNow(); await searched();
  assert.match(resultStatus(), /当天 1 天、\d+ 段/);
  await settle(() => dayRows()[0]?.querySelector('.composition-day-name')?.click());
  for (const row of rowItems()) {
    const range = row.textContent.match(/距 ([\d.]+)(?:—([\d.]+))? km/);
    assert.ok(range && Number(range[1]) >= 10, row.textContent);
  }
  const rings = map.getSource('tamatamatori-alignment').data.features.filter((feature) => feature.properties.kind === 'ring');
  assert.equal(rings.length, 2, 'the farthest and the nearest');
});

test('推算·看得见的山顶：山顶可勾选、塔不可；“移到附近最高点”把点移到最高处并说明距离', async t => {
  const { map } = await workspace(t); await readyTerrain();
  // A 3000 m cone at Fuji's summit.
  const cone = (latitude, longitude) => Math.max(0, 3000 - 0.3 * Math.hypot((latitude - 35.3606) * 111195, (longitude - 138.7274) * 111195 * Math.cos(35.36 * Math.PI / 180)));
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(1, 1); return cone; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  await enterSolve();
  await settle(() => button('钻石富士').click());
  await settle(() => targetRow('富士山顶').querySelector('.composition-target-name').click());
  const skyline = () => [...targetRow('富士山顶').querySelectorAll('.composition-check')].find((label) => /看得见的山顶/.test(label.textContent));
  assert.ok(skyline(), 'a summit can be aimed at its skyline');
  assert.equal(skyline().querySelector('input').checked, true, 'on in the template');
  await settle(() => setControl(inputIn(targetRow('富士山顶'), '距地表'), 50));
  assert.equal(skyline(), undefined, 'not for a 50 m tower');
  await settle(() => setControl(inputIn(targetRow('富士山顶'), '距地表'), 0));
  // On the summit already; then a point picked about 300 m off it moves back to the top.
  await settle(() => button('移到附近最高点').click());
  await waitUntil(() => /已在/.test(targetRow('富士山顶').querySelector('.composition-snap')?.textContent ?? ''));
  assert.match(targetRow('富士山顶').querySelector('.composition-snap').textContent, /已在 500 m 内的最高处（3000 m）/);
  await settle(() => button('在地图上重新点选').click());
  await settle(() => clickMap(map, 138.7274, 35.3633));
  const row = () => [...document.querySelectorAll('.composition-target-list > li')][0];
  if (!row().querySelector('.composition-editor')) await settle(() => row().querySelector('.composition-target-name').click());
  assert.match(row().querySelector('.composition-editor .alignment-hint').textContent, /^35\.36330, 138\.72740$/);
  await settle(() => button('移到附近最高点').click());
  await waitUntil(() => /已移动/.test(row().querySelector('.composition-snap')?.textContent ?? ''));
  const moved = row().querySelector('.composition-snap').textContent.match(/已移动 (\d+) m，到地形高程 (\d+) m 处/);
  assert.ok(moved && Math.abs(Number(moved[1]) - 300) <= 20 && Number(moved[2]) >= 2995, row().querySelector('.composition-snap').textContent);
  assert.match(row().querySelector('.composition-editor .alignment-hint').textContent, /^35\.360\d\d, 138\.727\d\d$/);
});

test('推算·两个地面点：结果为与时间无关的机位，地图画出机位与容差内范围；试看只改机位与朝向；导出日历不可用', async t => {
  const { map } = await workspace(t); await readyTerrain();
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(1, 1); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  await enterSolve();
  // Skytree's top upper left, Tokyo Tower's top lower right.
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-tower'));
  assert.match(solvability(), /结果为机位：两个地面点的相对位置只取决于机位，与时间无关/);
  const edit = async (name) => { if (!targetRow(name).querySelector('.composition-editor')) await settle(() => targetRow(name).querySelector('.composition-target-name').click()); };
  await edit('东京塔');
  await settle(() => setControl(inputIn(targetRow('东京塔'), '自左'), 62));
  await settle(() => setControl(inputIn(targetRow('东京塔'), '自上'), 58));
  await edit('晴空塔');
  await settle(() => setControl(inputIn(targetRow('晴空塔'), '自左'), 42));
  await settle(() => setControl(inputIn(targetRow('晴空塔'), '自上'), 30));
  const before = shootingDateTime();
  await searchNow(); await searched();
  assert.match(resultStatus(), /^\d+ 个机位/);
  const places = () => [...document.querySelectorAll('.composition-places > li')];
  assert.ok(places().length >= 1);
  assert.match(places()[0].textContent, /机位 1.*“晴空塔”在.+ km · “东京塔”在.+ km.*容差内约 \d+×\d+ m/s);
  assert.equal(document.querySelectorAll('.composition-days > li').length, 0, 'not listed by day');
  const kinds = () => map.getSource('tamatamatori-alignment').data.features.map((feature) => feature.properties.kind);
  assert.ok(['area', 'dot', 'label'].every((kind) => kinds().includes(kind)), kinds().join());
  assert.match(document.querySelector('[data-alignment-legend]').textContent, /目标 · 机位与容差内范围/);
  // A try-out moves the camera and turns it; the time stays.
  await settle(() => places()[0].querySelector('button').click());
  assert.equal(shootingDateTime(), before);
  assert.match(document.querySelector('.alignment-results .alignment-current').textContent, /正在试看机位 1 · 距“晴空塔” [\d.]+ km、距“东京塔” [\d.]+ km/);
  const eye = { latitude: value('纬度'), longitude: value('经度'), ellipsoidalHeight: 1.6 };
  const skytreeTop = placed(toRay(eye, { latitude: 35.71004508243534, longitude: 139.81071889400482, ellipsoidalHeight: 634 }).ray);
  assert.ok(Math.abs((skytreeTop.x + 1) / 2 - 0.42) < 2e-3 && Math.abs((skytreeTop.y + 1) / 2 - 0.30) < 2e-3, JSON.stringify(skytreeTop));
  assert.equal(button('导出日历').disabled, true);
  assert.match(button('导出日历').title, /与时间无关/);
  assert.equal(button('存为机位').disabled, false);
});

test('推算请求链接：先预览镜头、目标、范围与将改动的字段，取消不改计划；确认后载入条件并自动搜索，撤销恢复计划与模式；复制推算请求与结果；版本 1 转换；报错', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  t.after(() => { delete dom.window.navigator.clipboard; });
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(3, 3); return () => 0; });
  t.after(() => { delete globalThis.__testElevationTiles; });
  const before = { azimuth: value('方位角'), pitch: value('俯仰角'), time: shootingDateTime(), focal: value('焦距') };
  let dialog = await openSolveLink(fujiRequest);
  assert.match(dialog.querySelector('.shot-summary').textContent,
    /富士山顶夕阳.*镜头400 mm · 全画幅 · 3:2 横幅.*目标 1太阳 · 画面中心 · 容差 ±3%.*机位固定为当前机位，朝向固定（方位 244\.63°，俯仰 10\.74°）.*2026-11-04 起 12 个月.*Asia\/Tokyo.*筛选无/s);
  assert.match(dialog.querySelector('.solve-changes').textContent, /镜头：400 mm · 3:2 横幅.*方向：固定为请求中的朝向（方位 244\.63°，俯仰 10\.74°）.*时区：固定为 Asia\/Tokyo（不再随机位）/s);
  await settle(() => button('取消').click());
  assert.equal(dialog.open, false); assert.equal(dom.window.location.hash, '');
  assert.equal(value('方位角'), before.azimuth); assert.equal(value('焦距'), before.focal); assert.equal(panel(), null);
  // Confirming loads the conditions, applies the lens and direction, and searches at once.
  dialog = await openSolveLink(fujiRequest);
  await settle(() => button('载入并推算').click());
  assert.equal(dom.window.location.hash, '');
  assert.equal(document.querySelector('.solve-button').getAttribute('aria-pressed'), 'true');
  assert.equal(value('焦距'), 400); assert.equal(value('方位角'), 244.63); assert.equal(value('俯仰角'), 10.74);
  assert.ok(targetRow('太阳'));
  assert.equal(document.querySelector('select[aria-label="机位范围"]').value, 'fixed');
  assert.equal(document.querySelector('.composition-range .composition-check input').checked, true);
  assert.equal(document.querySelector('input[aria-label="起始日期"]').value, '2026-11-04');
  assert.match(document.querySelector('.shot-toast').textContent, /已载入推算请求「富士山顶夕阳」/);
  await searched();
  assert.equal(dayRows().length, 2);
  // "复制推算请求" writes a self-contained version 2 link; "复制结果" a Markdown table.
  await settle(() => button('复制推算请求').click());
  await waitUntil(() => copied.length === 1);
  assert.ok(copied[0].startsWith('http://localhost/#solve=json:'));
  const back = parseSolveText2(copied[0], initialPlan);
  assert.equal(back.ok, true);
  assert.equal(back.request.version, 2);
  assert.deepEqual(back.request.lens, fujiRequest.lens);
  assert.deepEqual(back.request.targets, [{ type: 'body', body: 'sun', frame: { x: 0.5, y: 0.5 }, tolerance: 0.03 }]);
  assert.deepEqual(back.request.camera, { mode: 'fixed', latitude: value('纬度'), longitude: value('经度'), aim: { azimuth: 244.63, pitch: 10.74 }, heightAboveGround: value('离地高度') });
  assert.deepEqual(back.request.time, fujiRequest.time);
  await settle(() => button('复制结果').click());
  await waitUntil(() => copied.length === 2);
  assert.match(copied[1], /^## Tamatamatori 推算结果/);
  assert.match(copied[1], /\| 2027-02-12 \| 16:2\d–16:2\d \|[\s\S]*\| 2027-10-30 \| 15:5\d–15:5\d \|/);
  assert.match(document.querySelector('.alignment-copied').textContent, /已复制结果/);
  // Undo restores the plan and leaves the mode it entered.
  await settle(() => [...document.querySelectorAll('.shot-toast button')].find((b) => b.textContent === '撤销').click());
  assert.equal(value('方位角'), before.azimuth); assert.equal(value('俯仰角'), before.pitch); assert.equal(value('焦距'), before.focal);
  assert.equal(document.querySelector('.solve-button').getAttribute('aria-pressed'), 'false');
  assert.equal(panel(), null);
  // A version 1 request (找机位) is converted: the landmark and the Sun at the centre, one day, the shooting date moved.
  dialog = await openSolveLink({ format: 'tamatamatori.solve', version: 1, kind: 'position', body: 'sun', target: { landmark: 'tokyo-skytree' }, date: '2026-12-21', maxDistance: 20000 });
  assert.match(dialog.querySelector('.shot-preview').textContent, /旧版（v1）请求，已按当前镜头转换/);
  assert.match(dialog.querySelector('.shot-summary').textContent, /晴空塔 · 35\.71005, 139\.81072 · 距地表 634 m · 画面中心 · 容差 ±3% · 已接入地标（tokyo-skytree）.*太阳 · 画面中心.*不限，离地面目标最远 20 km.*2026-12-21 当天/s);
  assert.match(dialog.querySelector('.solve-changes').textContent, /拍摄时刻：2026-11-04 17:00（Asia\/Tokyo） → 2026-12-21 17:00（Asia\/Tokyo）/);
  await settle(() => button('载入并推算').click());
  assert.ok(targetRow('晴空塔') && targetRow('太阳'));
  assert.equal(document.querySelector('select[aria-label="机位最远距离"]').value, '20000');
  assert.equal(document.querySelector('select[aria-label="跨度"]').value, '1');
  assert.equal(shootingDateTime(), '2026-12-21T17:00');
  await searched();
  assert.match(resultStatus(), /当天 1 天、\d+ 段/);
  // A broken request lists its problems with their paths and cannot be loaded.
  dialog = await openSolveLink({ ...fujiRequest, targets: [{ type: 'body', body: 'sun', frame: { x: 1.5 } }], camera: { mode: 'orbit' } });
  assert.match(dialog.querySelector('.shot-errors').textContent, /targets\[0\]\.frame\.x：应在 0～1 之间，收到 1\.5[\s\S]*targets\[0\]\.frame\.y：应为数字[\s\S]*camera\.mode：应为 "free" \/ "near" \/ "fixed" 之一/);
  assert.equal(button('载入并推算').disabled, true);
  await settle(() => button('取消').click());
  assert.equal(dom.window.location.hash, '');
});

test('推算结果落地：试看后一键存为机位并成为当前机位，机位面板同步；导出日历每个结果一个事件，链接打开同一试看', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const blobs = [], downloads = [];
  const { createObjectURL, revokeObjectURL } = URL, click = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.href }); };
  t.after(() => { URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; dom.window.HTMLAnchorElement.prototype.click = click; });
  await openSolveLink(fujiRequest);
  await settle(() => button('载入并推算').click());
  await searched();
  assert.equal(dayRows().length, 2);
  const status = () => document.querySelector('.alignment-copied').textContent;
  assert.match(document.querySelector('.alignment-export h3').textContent, /保存与导出/);
  assert.equal(button('存为机位').disabled, true, 'nothing tried out yet');
  assert.equal(button('存为机位').title, '先试看一个结果');
  assert.equal(document.querySelector('.alignment-export .alignment-hint'), null, 'the buttons carry their own notes');
  // Try the first one and keep it.
  await settle(() => dayRows()[0].querySelector('.composition-day > button[aria-label^="试看"]').click());
  assert.equal(shootingDateTime(), '2027-02-12T16:22');
  assert.equal(button('存为机位').disabled, false);
  await settle(() => button('存为机位').click());
  const name = '35.417°N 138.873°E · 太阳 02-12 16:22';
  assert.match(status(), new RegExp(`已存为机位「${name}」`));
  assert.equal(savedShots().length, 1);
  assert.equal(savedShots()[0].shot.name, name);
  assert.equal(savedShots()[0].shot.time.instant.slice(0, 16), '2027-02-12T07:22');
  assert.equal(savedShots()[0].shot.layers.sun, true);
  assert.equal(savedShots()[0].shot.camera.focalLength, 400);
  assert.equal(shotButton().textContent.trim(), name, 'it becomes the current shot');
  await openShots();
  assert.ok([...document.querySelectorAll('.shot-list .shot-apply strong')].some((item) => item.textContent.includes(name)), 'the shot menu sees it at once');
  await settle(() => shotButton().click());
  // The calendar: both results, in UTC, each with a link to its try-out.
  await settle(() => button('导出日历').click());
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'tamatamatori-solve-20261104.ics');
  const text = await blobs[0].text();
  assert.equal(blobs[0].type, 'text/calendar;charset=utf-8');
  const unfolded = text.replace(/\r\n /g, '').split('\r\n');
  assert.equal(unfolded.filter((line) => line === 'BEGIN:VEVENT').length, 2);
  assert.ok(unfolded.some((line) => line.startsWith('DTSTART:20270212T0722')), unfolded.filter((line) => line.startsWith('DTSTART')).join());
  assert.ok(unfolded.some((line) => line.startsWith('DTSTART:20271030T065')));
  assert.ok(unfolded.includes('SUMMARY:太阳 · 35.417°N 138.873°E'));
  const link = unfolded.find((line) => line.startsWith('URL:')).slice(4);
  assert.ok(link.startsWith('http://localhost/#shot=tmt1:'));
  assert.equal(parseShotText(link).plan.instant.slice(0, 16), '2027-02-12T07:22');
  assert.match(status(), /已导出 2 个事件/);
});

test('检查机位：按需读取水体与建筑，每段的试看机位标出水面与建筑遮挡并汇总；机位或离地高度改变后清空；失败可重试', async t => {
  await workspace(t); await readyTerrain();
  installGlobal('__testElevationTiles', async (points, url, signal, progress) => { progress?.(2, 2); return () => 0; });
  const requests = [];
  // Water around the first listed position; a 500 m building 250 m along the second one's sight line.
  const around = (point, size) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([east, north]) => travel(travel(point, 90, east * size / 2), 0, north * size / 2));
  installGlobal('__testFeatures', async (points, url, signal, progress) => {
    requests.push(points.length);
    progress?.(3, 3);
    return { features: { water: [{ rings: [around(points[0], 60)] }], buildings: [{ rings: [around(points[10], 40)], height: 500, base: 0 }] }, tiles: 3, fetched: 3 };
  });
  t.after(() => { delete globalThis.__testElevationTiles; delete globalThis.__testFeatures; });
  await enterSolve();
  await settle(() => button('+ 地面点').click());
  await settle(() => setControl(document.querySelector('.composition-pending select[aria-label="选择地标"]'), 'tokyo-skytree'));
  await settle(() => button('+ 天体').click());
  await settle(() => targetRow('月亮').querySelector('input[value="sun"]').click());
  await settle(() => setControl(document.querySelector('select[aria-label="跨度"]'), 1));
  await searchNow(); await searched();
  assert.ok(rowItems().length >= 2);
  assert.equal(document.querySelectorAll('.feasibility-tag').length, 0, 'nothing is read before asking');
  assert.equal(requests.length, 0);
  await settle(() => button('检查机位（水面、建筑）').click());
  await waitUntil(() => document.querySelector('.feasibility-summary'));
  assert.equal(requests.length, 1);
  const listed = rowItems().length, checked = listed;
  assert.equal(requests[0], 9 * checked, 'the camera and eight points along each sight line');
  const tags = rowItems().map((row) => row.querySelector('.feasibility-tag')?.textContent ?? '');
  assert.match(tags[0], /^机位在水面 · 2 km 内无建筑遮挡$/);
  assert.ok(rowItems()[0].querySelector('.feasibility-tag').classList.contains('is-problem'));
  assert.match(tags[1], /^2\d\d m 处建筑高出视线 \d+ m$/);
  assert.ok(tags.slice(2).every((tag) => tag === '2 km 内无建筑遮挡'));
  assert.match(document.querySelector('.feasibility-summary').textContent,
    new RegExp(`检查了 ${checked}/${listed} 个机位：水面 1、建筑轮廓内 0、2 km 内被建筑挡住 1、未发现问题 ${checked - 2}。读取 3 块矢量瓦片（新下载 3 块）。$`));
  // Moving a mark marks the search stale but leaves the listed positions and their tags.
  await settle(() => document.querySelector('[data-composition-marks] .alignment-handle').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  assert.ok(document.querySelector('.feasibility-summary'));
  // A higher camera moves every position: the old tags go at once.
  await settle(() => setControl(input('离地高度'), 20));
  assert.equal(document.querySelector('.feasibility-summary'), null);
  assert.equal(document.querySelectorAll('.feasibility-tag').length, 0);
  // A failure says so and can be retried.
  installGlobal('__testFeatures', async () => { throw new Error('矢量瓦片请求失败（503）'); });
  await settle(() => button('检查机位（水面、建筑）').click());
  await waitUntil(() => /检查失败：矢量瓦片请求失败（503）/.test(document.querySelector('.feasibility .field-error')?.textContent ?? ''));
  assert.ok(button('重试检查'));
});

test('天体目标：银心在固定机位与朝向下只在天暗时给出结果，试看开启银河、返回推算前关闭；两个天体按相对位置求时刻；恒星与深空从列表选择', async t => {
  await workspace(t); await readyTerrain();
  t.after(() => dom.window.history.replaceState(null, '', '/'));
  const at = Date.parse('2026-08-15T12:00:00Z'); // 21:00 in Tokyo
  const centre = skyAt('galactic-center', at, 35.4172, 138.8729, 'standard');
  await openSolveLink({ format: 'tamatamatori.solve', version: 2, targets: [{ type: 'body', body: 'galactic-center', tolerance: 0.01 }],
    camera: { mode: 'fixed', aim: { azimuth: Math.round(centre.azimuth * 1000) / 1000, pitch: Math.round(centre.elevation * 1000) / 1000 } },
    time: { mode: 'range', date: '2026-08-10', days: 30 }, timeZone: 'Asia/Tokyo' });
  assert.match(document.querySelector('.solve-dialog .shot-summary').textContent, /目标 1银心 · 画面中心 · 容差 ±1%/);
  await settle(() => button('载入并推算').click());
  await searched();
  assert.ok(targetRow('银心'));
  // A fixed body: a night search, its rows named after the evening.
  const august15 = dayRows().find((row) => /^8\/15 周六夜 (20:5\d|21:0\d)–21:0\d$/.test(row.querySelector('.composition-day-name strong').textContent));
  assert.ok(august15, dayRows().map((row) => row.textContent).join(' | '));
  assert.ok(dayRows().every((row) => /暮光|暗夜/.test(row.textContent)), 'only dark skies');
  const milkyWay = () => document.querySelector('[aria-label="显示银河"]');
  assert.equal(milkyWay().checked, false);
  await settle(() => august15.querySelector('.composition-day > button[aria-label^="试看"]').click());
  assert.equal(milkyWay().checked, true, 'the try-out shows the Milky Way');
  assert.ok(document.querySelector('[data-composition-marks] .alignment-mark-core'));
  await settle(() => button('返回推算前').click());
  assert.equal(milkyWay().checked, false);
  // Two bodies: the Pleiades upper right, the Moon lower left, wherever the camera stands.
  await openSolveLink({ format: 'tamatamatori.solve', version: 2, lens: { focalLength: 135, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
    targets: [{ type: 'body', body: 'dso-mel022', frame: { x: 0.6, y: 0.4 } }, { type: 'body', body: 'moon', frame: { x: 0.4, y: 0.6 }, tolerance: 0.05 }],
    time: { mode: 'range', date: '2026-11-13', days: 365 }, timeZone: 'Asia/Tokyo' });
  assert.match(document.querySelector('.solve-dialog .shot-summary').textContent, /只有天体时与机位基本无关/);
  await settle(() => button('载入并推算').click());
  assert.match(solvability(), /结果为时刻：天体在画面中的相对位置与机位基本无关（月亮略有视差）/);
  await searched();
  assert.ok(dayRows().length >= 1, resultStatus());
  await settle(() => dayRows()[0].querySelector('.composition-day > button[aria-label^="试看"]').click());
  const time = tokyoTime();
  const pleiades = skyAt('dso-mel022', time, value('纬度'), value('经度'), 'standard'), moon = skyAt('moon', time, value('纬度'), value('经度'), 'standard');
  const first = placed(direction(pleiades.azimuth, pleiades.elevation)), second = placed(direction(moon.azimuth, moon.elevation));
  assert.ok(Math.abs(first.x - 0.2) < 2e-3 && Math.abs(first.y + 0.2) < 2e-3, `Pleiades at ${first.x}, ${first.y}`);
  assert.ok(Math.hypot(((second.x + 0.2) / 2) * 1.5, (second.y - 0.2) / 2) <= 0.05, `Moon at ${second.x}, ${second.y}`);
  // The list of fixed bodies: deep-sky targets first, then the named stars.
  await settle(() => targetRow('昴星团').querySelector('.composition-target-name').click());
  const select = () => targetRow('昴星团')?.querySelector('select[aria-label="恒星或深空目标"]') ?? document.querySelector('select[aria-label="恒星或深空目标"]');
  assert.deepEqual([...select().querySelectorAll('optgroup')].map((group) => [group.label, group.children.length]), [['深空目标', 15], ['亮星', 90]]);
  await settle(() => setControl(select(), 'hyg-90979'));
  assert.ok(targetRow('织女星'));
  assert.ok(document.querySelector('[data-composition-marks] .alignment-mark-star'));
  assert.match(document.querySelector('[data-composition-marks] .alignment-mark-star .alignment-handle').getAttribute('aria-label'), /^织女星在画面中的位置/);
  await settle(() => targetRow('织女星').querySelector('input[value="moon"]').click());
  assert.equal(document.querySelector('select[aria-label="恒星或深空目标"]'), null);
});

test('推算模块按需读取：进入推算才读取，读取中与失败分别提示，重试后可用；条件从进入时的拍摄日期开始', async (t) => {
  const { solveModule } = await appModule('/src/ui/solve/useComposition.ts');
  const real = solveModule.get;
  let pending = null;
  t.mock.method(solveModule, 'loaded', () => null);
  const get = t.mock.method(solveModule, 'get', () => new Promise((resolve, reject) => { pending = { resolve, reject }; }));
  await workspace(t); await readyTerrain();
  await setShootingDateTime('2026-12-01T12:00');
  assert.equal(get.mock.callCount(), 0, 'not read before the mode is entered');
  await settle(() => document.querySelector('.solve-button').click());
  assert.equal(get.mock.callCount(), 1);
  assert.match(document.querySelector('.solve-body .module-status').textContent, /^推算模块读取中…$/);
  assert.equal(panel(), null);
  // The map and the timeline draw nothing of the mode yet.
  assert.equal(document.querySelector('.time-marker[data-event="alignment"]'), null);
  await settle(() => pending.reject(new Error('网络中断')));
  const failed = document.querySelector('.solve-body .module-status.is-error');
  assert.match(failed.textContent, /推算模块读取失败：网络中断/);
  assert.equal(failed.getAttribute('role'), 'alert');
  // Retrying reads it again.
  get.mock.mockImplementation(() => real());
  await settle(() => button('重试').click());
  await waitUntil(() => document.querySelector('.composition-templates'));
  assert.equal(get.mock.callCount(), 2);
  assert.equal(document.querySelector('.module-status'), null);
  assert.equal(document.querySelector('input[aria-label="起始日期"]').value, '2026-12-01');
  // Leaving and entering again keeps the module: no further read.
  await settle(() => document.querySelector('.solve-button').click());
  await settle(() => document.querySelector('.solve-button').click());
  assert.ok(panel());
  assert.equal(get.mock.callCount(), 2);
});

test('#solve= 链接等推算模块读到后才打开预览；模块读取失败时提示并清除链接，再开链接重新读取', async (t) => {
  const { solveModule } = await appModule('/src/ui/solve/useComposition.ts');
  const real = solveModule.get;
  let pending = null;
  t.mock.method(solveModule, 'loaded', () => null);
  t.mock.method(solveModule, 'get', () => new Promise((resolve, reject) => { pending = { resolve, reject }; }));
  await workspace(t); await readyTerrain();
  const link = `solve=json:${encodeURIComponent(JSON.stringify(fujiRequest))}`;
  await settle(() => { dom.window.location.hash = link; });
  await waitUntil(() => pending);
  assert.equal(document.querySelector('.solve-dialog'), null);
  await settle(() => pending.reject(new Error('网络中断')));
  assert.match(document.querySelector('.shot-toast').textContent, /无法打开推算链接：推算模块读取失败（网络中断）/);
  assert.equal(dom.window.location.hash, '');
  assert.equal(document.querySelector('.solve-button').getAttribute('aria-pressed'), 'false');
  // The same link again reads the module again and opens the preview; nothing changes until it is confirmed.
  pending = null;
  await settle(() => { dom.window.location.hash = link; });
  await waitUntil(() => pending);
  const module = await real();
  await settle(() => pending.resolve(module));
  await waitUntil(() => document.querySelector('.solve-dialog')?.open);
  assert.match(document.querySelector('.solve-dialog .shot-summary').textContent, /太阳/);
  assert.equal(document.querySelector('.solve-button').getAttribute('aria-pressed'), 'false');
  await settle(() => button('取消').click());
  assert.equal(dom.window.location.hash, '');
});
