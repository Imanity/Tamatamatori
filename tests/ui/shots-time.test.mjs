// Workspace interaction tests: saved shots, time zones, the timeline and the position bar. Setup lives in harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { parseShotText } from "../../src/domain/shot.ts";
import { dayEvents } from "../../src/domain/day-events.ts";
import { cameraHeightSlider } from "../../src/domain/plan.ts";
import { dom, settle, waitForMap, workspace, input, chooseTimeZone, shootingDateTime, setShootingDateTime, value, setControl, terrainMap, readyTerrain, shotButton, panelButton, openShots, saveShotAs, savedShots, keydown } from "./harness.mjs";

test('页头删去调试文本；机位保存、修改标记、切换应用与撤销，参数、图层与右栏同步', async t => {
  await workspace(t); const map = await readyTerrain();
  const header = document.querySelector('.topbar').textContent;
  for (const removed of ['工作区原型', 'P3', '天文构图', '摄影规划']) assert.ok(!header.includes(removed), removed);
  assert.equal(shotButton().textContent.trim(), '未保存的机位');
  await openShots();
  assert.match(document.querySelector('.shot-current').textContent, /尚未保存/);
  assert.match(document.querySelector('.shot-empty').textContent, /还没有保存的机位/);
  await settle(() => panelButton('保存为机位').click());
  assert.match(document.querySelector('[aria-label="机位名称"]').value, /°N .*11-04 17:00/, 'suggested name from place and local time');
  await settle(() => setControl(document.querySelector('[aria-label="机位名称"]'), '富士 A'));
  await settle(() => panelButton('保存').click());
  assert.equal(shotButton().textContent.trim(), '富士 A'); assert.match(document.querySelector('.shot-notice').textContent, /已保存「富士 A」/);
  assert.equal(savedShots().length, 1);
  const [first] = savedShots();
  // Changing anything in the picture marks the bound shot as modified.
  await settle(() => setControl(input('焦距'), 85));
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  assert.ok(document.querySelector('.shot-modified')); assert.match(shotButton().getAttribute('aria-label'), /已修改/);
  await saveShotAs('富士 B');
  assert.equal(shotButton().textContent.trim(), '富士 B'); assert.equal(document.querySelector('.shot-modified'), null);
  assert.deepEqual(savedShots().map((entry) => entry.shot.name), ['富士 B', '富士 A']);
  // Apply A: every control, the layer switches and the information groups follow.
  await openShots();
  assert.match(document.querySelector(`[data-shot-id="${first.id}"]`).textContent, /富士 A.*35 mm · 全画幅 · 横幅 3:2/s);
  await settle(() => document.querySelector(`[data-shot-id="${first.id}"] .shot-apply`).click());
  assert.equal(document.querySelector('.shot-panel'), null); assert.equal(document.activeElement, shotButton());
  assert.equal(value('焦距'), 35); assert.equal(document.querySelector('[aria-label="显示星空"]').checked, false);
  assert.equal(document.querySelector('#info-stars').getAttribute('aria-expanded'), 'false');
  assert.equal(shotButton().textContent.trim(), '富士 A');
  assert.match(document.querySelector('.shot-toast').textContent, /已应用「富士 A」/);
  await settle(() => [...document.querySelectorAll('.shot-toast button')].find((b) => b.textContent === '撤销').click());
  assert.equal(value('焦距'), 85); assert.equal(document.querySelector('[aria-label="显示星空"]').checked, true);
  assert.equal(document.querySelector('#info-stars').getAttribute('aria-expanded'), 'true');
  assert.equal(shotButton().textContent.trim(), '富士 B'); assert.equal(document.querySelector('.shot-toast'), null);
  // Saving changes overwrites the bound entry and moves it to the top.
  await settle(() => setControl(input('焦距'), 50));
  await openShots(); await settle(() => panelButton('保存修改').click());
  assert.equal(savedShots()[0].shot.camera.focalLength, 50); assert.equal(document.querySelector('.shot-modified'), null);
  // Rename, then delete with undo.
  const second = savedShots()[0];
  await settle(() => document.querySelector(`[data-shot-id="${second.id}"] .shot-more`).click());
  await settle(() => panelButton('重命名').click());
  await settle(() => setControl(document.querySelector('[aria-label="新名称"]'), '富士 · 星空'));
  await settle(() => panelButton('确定').click());
  assert.equal(savedShots()[0].shot.name, '富士 · 星空'); assert.equal(shotButton().textContent.trim(), '富士 · 星空');
  await settle(() => document.querySelector(`[data-shot-id="${second.id}"] .shot-more`).click());
  await settle(() => panelButton('删除').click());
  assert.equal(savedShots().length, 1); assert.equal(shotButton().textContent.trim(), '未保存的机位');
  await settle(() => panelButton('撤销').click());
  assert.equal(savedShots().length, 2); assert.equal(shotButton().textContent.trim(), '富士 · 星空');
  await settle(() => keydown(document.querySelector('.shot-panel'), 'Escape'));
  assert.equal(document.querySelector('.shot-panel'), null);
  assert.equal(terrainMap(), map);
});

test('导入机位：错误带字段路径，部分 JSON 补默认值，任意时区与保存并应用，分享码往返', async t => {
  await workspace(t); await readyTerrain();
  await openShots(); await settle(() => panelButton('导入机位').click());
  const dialog = document.querySelector('.shot-dialog[open]'), field = dialog.querySelector('textarea');
  await settle(() => setControl(field, '{"format":"tamatamatori.shot","version":1,"view":{"azimuth":"西南"}}'));
  const errors = dialog.querySelector('.shot-errors').textContent;
  assert.match(errors, /view.azimuth：应为数字/); assert.match(errors, /position：缺少该字段/);
  assert.ok([...dialog.querySelectorAll('footer button')].every((b) => b.disabled));
  const json = { format: 'tamatamatori.shot', version: 1, name: '埃菲尔铁塔 · 冬夜', position: { latitude: 48.8530, longitude: 2.3499, heightAboveGround: 2 },
    view: { azimuth: 250, pitch: 8 }, camera: { focalLength: 200 }, time: { local: '2026-12-20T22:15', timeZone: 'Europe/Paris' }, layers: { moon: false, milkyWay: true } };
  await settle(() => setControl(field, '```json\n' + JSON.stringify(json, null, 2) + '\n```'));
  assert.equal(dialog.querySelector('.shot-errors'), null);
  assert.match(dialog.querySelector('.shot-summary').textContent, /埃菲尔铁塔附近.*2026-12-20 22:15 · Europe\/Paris.*200 mm.*太阳、银河/s);
  assert.match(dialog.querySelector('.shot-defaults').textContent, /camera.sensor/);
  assert.equal(dialog.querySelector('[aria-label="导入机位名称"]').value, '埃菲尔铁塔 · 冬夜');
  await settle(() => [...dialog.querySelectorAll('footer button')].find((b) => b.textContent === '保存并应用').click());
  assert.equal(dialog.open, false);
  assert.equal(value('焦距'), 200); assert.equal(value('纬度'), 48.853);
  assert.equal(document.querySelector('input[type="date"]').value, '2026-12-20');
  assert.match(document.querySelector('.timezone-trigger').textContent, /巴黎.*UTC\+1/);
  assert.equal(document.querySelector('[aria-label="显示银河"]').checked, true); assert.equal(document.querySelector('[aria-label="显示月亮"]').checked, false);
  assert.equal(shotButton().textContent.trim(), '埃菲尔铁塔 · 冬夜'); assert.equal(savedShots().length, 1);
  // Share the current shot and read the code back.
  await openShots(); await settle(() => panelButton('分享').click());
  const share = document.querySelector('.shot-dialog[open]'), code = share.querySelector('[aria-label="分享码"]').value;
  assert.match(code, /^tmt1:/);
  const parsed = parseShotText(code);
  assert.equal(parsed.ok, true); assert.equal(parsed.shot.name, '埃菲尔铁塔 · 冬夜'); assert.equal(parsed.plan.timeZone, 'Europe/Paris');
  assert.equal(parsed.plan.instant, '2026-12-20T21:15:00Z'); assert.equal(parsed.plan.focalLength, 200);
  const { $schema, ...written } = JSON.parse(share.querySelector('[aria-label="机位 JSON"]').value);
  assert.equal($schema, 'http://localhost/shot.schema.json'); assert.deepEqual(written, parsed.shot);
  // The link leads the dialog and reads back to the same shot.
  const link = share.querySelector('[aria-label="分享链接"]').value;
  assert.ok(link.startsWith('http://localhost/#shot=tmt1:')); assert.deepEqual(parseShotText(link).shot, parsed.shot);
  await settle(() => share.querySelector('header button').click());
  assert.equal(share.open, false);
});

test('时区选择：常用分组标出当前时区，中文城市搜索与键盘选择，Escape 不改时区，只改显示不改拍摄时刻', async t => {
  await workspace(t); await readyTerrain();
  const instant = document.querySelector('input[type="time"]').value, trigger = document.querySelector('.timezone-trigger');
  // New sessions follow the position's own zone ("当地时区").
  assert.match(trigger.textContent, /当地.*东京.*UTC\+9/);
  await settle(() => trigger.click());
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const groups = [...document.querySelectorAll('.timezone-group')].map((g) => g.textContent);
  assert.deepEqual(groups, ['常用'], 'only the common group is labelled; all zones follow a divider');
  assert.equal(document.querySelectorAll('.timezone-divider').length, 1);
  const options = [...document.querySelectorAll('.timezone-list [role="option"]')];
  assert.equal(options[0].dataset.zone, 'local');
  assert.match(options[0].textContent, /当地时区.*Asia\/Tokyo/);
  assert.deepEqual([...document.querySelectorAll('.timezone-list [aria-selected="true"]')].map((o) => o.dataset.zone), ['local']);
  assert.ok(options.some((o) => o.dataset.zone === 'Asia/Tokyo' && o.getAttribute('aria-selected') === 'false'));
  assert.ok(document.querySelectorAll('.timezone-list [role="option"]').length > 300);
  const search = document.querySelector('[aria-label="搜索时区"]');
  await settle(() => setControl(search, '悉尼'));
  assert.equal(document.querySelector('.timezone-list [role="option"]').dataset.zone, 'Australia/Sydney');
  assert.equal(search.getAttribute('aria-activedescendant'), document.querySelector('.timezone-list [role="option"]').id);
  await settle(() => keydown(search, 'Enter'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(document.activeElement, trigger);
  assert.match(trigger.textContent, /悉尼.*UTC\+11/, 'Sydney is on daylight time in November');
  assert.doesNotMatch(trigger.textContent, /当地/, 'a chosen zone no longer follows the position');
  assert.notEqual(document.querySelector('input[type="time"]').value, instant, 'display time changes with the zone');
  await settle(() => trigger.click());
  await settle(() => setControl(document.querySelector('[aria-label="搜索时区"]'), 'utc-3'));
  assert.ok([...document.querySelectorAll('.timezone-list [role="option"]')].some((o) => o.dataset.zone === 'America/Sao_Paulo'));
  await settle(() => keydown(document.querySelector('[aria-label="搜索时区"]'), 'Escape'));
  assert.equal(document.querySelector('.timezone-picker'), null); assert.match(trigger.textContent, /悉尼/);
  await settle(() => trigger.click());
  await settle(() => setControl(document.querySelector('[aria-label="搜索时区"]'), 'zzzz'));
  assert.match(document.querySelector('.timezone-note').textContent, /没有匹配的时区/);
});

test('刷新后恢复上次工作状态与关联机位，损坏的会话安静回退到默认机位', async t => {
  const first = await workspace(t); await readyTerrain();
  await settle(() => setControl(input('焦距'), 120));
  await chooseTimeZone('Asia/Shanghai', '北京');
  await saveShotAs('恢复测试');
  await settle(() => setControl(input('方位角'), 200));
  await act(async () => { await delay(350); });
  const session = JSON.parse(dom.window.localStorage.getItem('tamatamatori.session.v1'));
  assert.equal(session.shot.camera.focalLength, 120); assert.equal(session.shot.view.azimuth, 200); assert.equal(session.activeId, savedShots()[0].id);
  await first.unmount();
  const second = await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  assert.equal(value('焦距'), 120); assert.equal(value('方位角'), 200);
  assert.match(document.querySelector('.timezone-trigger').textContent, /北京/);
  assert.equal(shotButton().textContent.trim(), '恢复测试'); assert.ok(document.querySelector('.shot-modified'), 'azimuth changed after saving');
  await second.unmount();
  dom.window.localStorage.setItem('tamatamatori.session.v1', '{"version":1,"shot":{"format":"tamatamatori.shot"}}');
  await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  assert.equal(value('焦距'), 35); assert.equal(shotButton().textContent.trim(), '未保存的机位');
  assert.equal(savedShots().length, 1, 'saved shots are untouched');
});

test('本地存储不可用时说明无法保存、禁用保存，分享与仅应用仍可用', async t => {
  dom.window.localStorage.clear();
  const own = Object.getOwnPropertyDescriptor(dom.window, 'localStorage');
  Object.defineProperty(dom.window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  t.after(() => { if (own) Object.defineProperty(dom.window, 'localStorage', own); else delete dom.window.localStorage; });
  await workspace(t, undefined, { keepStorage: true }); await readyTerrain();
  await openShots();
  assert.match(document.querySelector('.shot-warning').textContent, /无法使用本地存储/);
  assert.equal(panelButton('保存为机位').disabled, true);
  await settle(() => panelButton('分享').click());
  assert.match(document.querySelector('.shot-dialog[open] [aria-label="分享码"]').value, /^tmt1:/);
  await settle(() => document.querySelector('.shot-dialog[open] header button').click());
  await openShots(); await settle(() => panelButton('导入机位').click());
  const dialog = document.querySelector('.shot-dialog[open]');
  await settle(() => setControl(dialog.querySelector('textarea'), JSON.stringify({ format: 'tamatamatori.shot', version: 1, position: { latitude: 35, longitude: 139 }, view: { azimuth: 10 }, time: { instant: '2026-11-04T08:00:00Z' } })));
  const [only, keep] = dialog.querySelectorAll('footer button');
  assert.equal(keep.disabled, true); assert.equal(only.disabled, false);
  await settle(() => only.click());
  assert.equal(value('方位角'), 10); assert.equal(shotButton().textContent.trim(), '未保存的机位');
});

test('拍摄时间：微调按钮跨午夜，前后一天保留钟点，夏令时缺失钟点报错并保留原时刻', async t => {
  await workspace(t); await readyTerrain();
  const press = (label) => settle(() => document.querySelector(`[aria-label="${label}"]`).click());
  await setShootingDateTime('2026-11-04T23:55');
  await press('推后 10 分钟');
  assert.equal(shootingDateTime(), '2026-11-05T00:05');
  await press('前一天');
  assert.equal(shootingDateTime(), '2026-11-04T00:05');
  await press('提前 1 小时');
  assert.equal(shootingDateTime(), '2026-11-03T23:05');
  await press('推后 1 分钟'); await press('推后 1 小时');
  assert.equal(shootingDateTime(), '2026-11-04T00:06');
  assert.equal(document.querySelector('.date-field .weekday').textContent, '周三');
  const slider = document.querySelector('input[aria-label="24 小时时间滑杆"]');
  assert.match(slider.getAttribute('aria-valuetext'), /^00:06:00 Asia\/Tokyo · 夜间$/);
  assert.ok(document.querySelector('.time-band').style.background.includes('linear-gradient'), 'daylight band painted');
  await chooseTimeZone('America/New_York');
  await setShootingDateTime('2026-03-07T02:30');
  await press('后一天');
  assert.equal(shootingDateTime(), '2026-03-07T02:30', '02:30 does not exist on 8 March');
  assert.match(document.getElementById('time-error').textContent, /夏令时/);
  await press('推后 1 小时');
  assert.equal(shootingDateTime(), '2026-03-07T03:30');
  assert.equal(document.getElementById('time-error'), null);
});

test('时间轴只标注已开启图层的事件：点击刻度跳转，上一/下一事件逐个移动，夜空图层改为中午到次日中午，极夜说明缺少的日出日落', async t => {
  await workspace(t); await readyTerrain();
  await setShootingDateTime('2026-11-04T12:00');
  const plan = { latitude: value('纬度'), longitude: value('经度'), timeZone: 'Asia/Tokyo', refraction: 'standard', instant: '2026-11-04T03:00:00Z' };
  const expected = Object.fromEntries(dayEvents(plan).map((event) => [event.id, event]));
  const marker = (id) => document.querySelector(`.time-marker[data-event="${id}"]`);
  const kinds = () => [...document.querySelectorAll('.time-marker')].map((b) => b.dataset.event);
  const steps = () => [...document.querySelectorAll('.time-event-step')];
  const local = (instant) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
  // Sun and Moon are on by default: their rise and set only, in time order.
  assert.equal(document.querySelector('.timeline').dataset.mode, 'day');
  assert.deepEqual(kinds(), ['moonrise', 'sunrise', 'moonset', 'sunset']);
  assert.equal(marker('sunset').getAttribute('aria-label'), `跳到日落 ${local(expected.sunset.instant).slice(0, 5)}`);
  assert.match(marker('sunset').title, /标准折射.*不含地形遮挡/);
  await settle(() => marker('sunset').click());
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.sunset.instant));
  assert.ok(marker('sunset').classList.contains('is-current'));
  assert.equal(steps()[1].disabled, true, 'sunset is the last event of the day');
  assert.match(steps()[0].getAttribute('aria-label'), /上一事件：月落/);
  await settle(() => steps()[0].click());
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.moonset.instant));
  await settle(() => steps()[1].click());
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.sunset.instant));
  // Turning the Moon off drops its markers; a night layer adds the dark span and moves to noon-to-noon.
  await settle(() => document.querySelector('[aria-label="显示月亮"]').click());
  assert.deepEqual(kinds(), ['sunrise', 'sunset']);
  await settle(() => document.querySelector('[aria-label="显示星空"]').click());
  assert.equal(document.querySelector('.timeline').dataset.mode, 'night');
  assert.match(document.querySelector('.time-slider').getAttribute('aria-label'), /中午到次日中午/);
  assert.equal(document.querySelector('input[type="time"]').value, local(expected.sunset.instant), 'the axis changes, not the instant');
  assert.deepEqual(kinds(), ['sunset', 'dusk', 'dawn', 'sunrise']);
  assert.equal(marker('dusk').getAttribute('aria-label'), `跳到昏影 ${local(expected.dusk.instant).slice(0, 5)}`);
  assert.deepEqual([...document.querySelectorAll('.time-slider-ticks span')].map((tick) => tick.textContent), ['12:00', '18:00', '11/5', '06:00', '11:59']);
  await settle(() => marker('dawn').click());
  assert.equal(shootingDateTime().slice(0, 10), '2026-11-05');
  assert.equal(document.querySelector('.timeline').dataset.mode, 'night');
  assert.deepEqual(kinds(), ['sunset', 'dusk', 'dawn', 'sunrise'], 'early morning stays on the same night');
  // Refraction changes the rise/set definition, not twilight.
  await settle(() => setControl(document.querySelector('select[aria-label="大气折射模型"]'), 'none'));
  assert.match(marker('sunrise').title, /无折射/);
  assert.match(marker('dusk').title, /地平下 18°/);
  // Polar night: the enabled Sun layer has no rise or set in the span.
  await settle(() => setControl(input('纬度'), 78.2232));
  await settle(() => setControl(input('经度'), 15.6267));
  await chooseTimeZone('Arctic/Longyearbyen', 'Longyearbyen');
  await setShootingDateTime('2026-12-15T12:00');
  assert.equal(marker('sunrise'), null);
  assert.match(document.querySelector('.time-missing').textContent, /本时段无：日出、日落/);
});

test('当地时区随机位变化并提示一次，拍摄时刻不变；改选固定时区后不再跟随', async t => {
  await workspace(t); await readyTerrain();
  const trigger = document.querySelector('.timezone-trigger');
  const before = shootingDateTime();
  const latitude = input('纬度');
  const paste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    latitude.dispatchEvent(event);
  };
  await settle(() => paste('48.8584, 2.2945'));
  assert.match(trigger.textContent, /当地.*巴黎.*UTC\+1/);
  assert.match(document.querySelector('.time-zone-notice').textContent, /时区随机位改为巴黎（UTC\+1），拍摄时刻不变/);
  // 2026-11-04T08:00Z: 17:00 in Tokyo is 09:00 in Paris.
  assert.equal(before.slice(11), '17:00');
  assert.equal(shootingDateTime(), '2026-11-04T09:00');
  await chooseTimeZone('Asia/Tokyo');
  assert.doesNotMatch(trigger.textContent, /当地/);
  await settle(() => paste('40.7128, -74.006'));
  assert.match(trigger.textContent, /东京/);
  assert.equal(shootingDateTime(), '2026-11-04T17:00');
  // Choosing "当地时区" again follows New York.
  await settle(() => trigger.click());
  await settle(() => document.querySelector('.timezone-list [data-zone="local"]').click());
  assert.match(trigger.textContent, /当地.*纽约.*UTC[−-]5/);
  assert.equal(shootingDateTime(), '2026-11-04T03:00');
});

test('离地高度滑条按对数刻度同步数值框，方向键按 0.1 m / 1 m 微调', async t => {
  await workspace(t); await readyTerrain();
  const slider = document.querySelector('input[aria-label="离地高度滑块"]');
  await settle(() => setControl(slider, cameraHeightSlider.toPosition(10)));
  assert.equal(value('离地高度'), 10);
  assert.equal(slider.getAttribute('aria-valuetext'), '10 m');
  await settle(() => keydown(slider, 'ArrowLeft'));
  assert.equal(value('离地高度'), 9.9);
  await settle(() => setControl(slider, cameraHeightSlider.max));
  assert.equal(value('离地高度'), 100);
  await settle(() => keydown(slider, 'ArrowUp'));
  assert.equal(value('离地高度'), 100);
  await settle(() => setControl(input('离地高度'), 1.5));
  assert.equal(slider.value, String(cameraHeightSlider.toPosition(1.5)));
  await settle(() => keydown(slider, 'ArrowRight'));
  assert.equal(value('离地高度'), 1.6);
});

test('机位条位于地图下方：粘贴“纬度, 经度”一次填入两项，单个数值照常输入，地面高程来自预览', async t => {
  await workspace(t); await readyTerrain();
  const latitude = input('纬度');
  assert.ok(latitude.closest('.panel-map .position-bar'));
  assert.match(document.querySelector('.ground-elevation').textContent, /1000\.0/);
  const paste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    latitude.dispatchEvent(event);
    return event;
  };
  let event;
  await settle(() => { event = paste('35.6586, 139.7454'); });
  assert.equal(event.defaultPrevented, true);
  assert.equal(value('纬度'), 35.6586);
  assert.equal(value('经度'), 139.7454);
  await settle(() => { event = paste('36'); });
  assert.equal(event.defaultPrevented, false, 'a single number is left to the input');
  assert.equal(value('经度'), 139.7454);
});

test('预览双指捏合按两指间距比例调焦，不改方向；松开一指后不再转动', async t => {
  await workspace(t); await readyTerrain();
  const frame = document.querySelector('.viewfinder');
  frame.getBoundingClientRect = () => ({ width: 600, height: 400 });
  const touch = (type, pointerId, clientX, clientY) => frame.dispatchEvent(new dom.window.PointerEvent(type, {
    pointerId, pointerType: 'touch', button: 0, clientX, clientY, bubbles: true,
  }));
  const pose = ['方位角', '俯仰角'].map(value);
  assert.equal(value('焦距'), 35);
  await settle(() => touch('pointerdown', 1, 250, 200));
  await settle(() => touch('pointerdown', 2, 350, 200));
  await settle(() => touch('pointermove', 2, 450, 200));
  assert.equal(value('焦距'), 70);
  await settle(() => touch('pointermove', 1, 400, 200));
  assert.equal(value('焦距'), 17.5);
  assert.deepEqual(['方位角', '俯仰角'].map(value), pose);
  await settle(() => touch('pointerup', 2, 450, 200));
  await settle(() => touch('pointermove', 1, 300, 260));
  assert.equal(value('焦距'), 17.5);
  assert.deepEqual(['方位角', '俯仰角'].map(value), pose);
  await settle(() => touch('pointerup', 1, 300, 260));
});

test('窄屏：预览与时间轴常驻，相机条移入“相机”标签，切换标签不重建地图或预览，变宽后恢复', async t => {
  const listeners = new Set();
  const narrow = { matches: true, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  const original = window.matchMedia;
  window.matchMedia = (query) => query === '(max-width: 1099px)' ? narrow : { matches: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { window.matchMedia = original; });
  const { map } = await workspace(t); const terrain = await readyTerrain();
  const layout = document.querySelector('.app-layout');
  const tabs = () => [...document.querySelectorAll('.mobile-tabs [role="tab"]')];
  const tab = (name) => tabs().find((element) => element.textContent.trim() === name);
  assert.deepEqual(tabs().map((element) => element.textContent.trim()), ['地图', '相机', '图层']);
  assert.equal(layout.dataset.mobileTab, 'map');
  assert.equal(document.querySelector('.panel-preview .camera-bar'), null);
  assert.ok(input('焦距').closest('.mobile-camera'));
  assert.ok(document.querySelector('.panel-preview .timeline'));
  await settle(() => tab('相机').click());
  assert.equal(layout.dataset.mobileTab, 'camera');
  assert.equal(tab('相机').getAttribute('aria-selected'), 'true');
  await settle(() => setControl(input('焦距'), 85));
  await settle(() => tab('图层').click());
  assert.equal(layout.dataset.mobileTab, 'layers');
  assert.equal(await waitForMap(), map);
  assert.ok(!map.removed);
  assert.equal(await readyTerrain(), terrain);
  await settle(() => { narrow.matches = false; for (const listener of listeners) listener(); });
  assert.ok(input('焦距').closest('.panel-preview .camera-bar'));
  assert.equal(document.querySelector('.mobile-camera'), null);
  assert.equal(value('焦距'), 85);
  assert.equal(await readyTerrain(), terrain);
});
