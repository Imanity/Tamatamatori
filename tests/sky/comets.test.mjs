import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GM_SUN, propagate, perihelionState, cometState, magnitudeLaw, totalMagnitude, heliocentricMagnitude,
  tailLengthAu, comaDiameterKm, AU_KM, PERIHELION_BLEND_DAYS,
} from '../../src/domain/comet-orbit.ts';
import { cometScene as sceneOf, inWindow, visibleTailDegrees, TAIL_FADE_MAGNITUDES, COMET_LIST_LIMIT } from '../../src/domain/comets.ts';
import { validateCometCatalog } from '../../src/domain/comet-catalog.ts';

// The published seed catalogue; closed apparitions never change in later updates.
const catalog = validateCometCatalog(JSON.parse(readFileSync(new URL('../../public/comets/catalog.json', import.meta.url), 'utf8')));
const comets = catalog.comets;
const cometScene = (plan, mcd = 0) => sceneOf(plan, catalog, mcd);
import { cometMesh, COMET_ATTRIBUTES, COMET_STRIDE, tailOpacity, headOpacity, tailPeak } from '../../src/preview/comet-tails.ts';
import { direction } from '../../src/domain/ephemeris.ts';

const norm = (v) => Math.hypot(...v);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const energy = (s, mu = GM_SUN) => (norm(s.v) ** 2) / 2 - mu / norm(s.r);
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.reduce((s, x, i) => s + x * b[i], 0) / norm(a) / norm(b)))) * 180 / Math.PI;

test('二体传播：椭圆整周期回到原处，双曲与近抛物线保持能量与角动量，正反传播互逆', () => {
  const a = 2, e = 0.5, q = a * (1 - e);
  const start = perihelionState({ q, e, tp: 0, node: 40, peri: 70, incl: 20 });
  const period = 2 * Math.PI * Math.sqrt(a ** 3 / GM_SUN);
  const back = propagate(start.r, start.v, period);
  assert.ok(norm(sub(back.r, start.r)) < 1e-9, `period ${norm(sub(back.r, start.r))}`);
  for (const ecc of [1.3, 1.0000002, 0.9999998, 0.97]) {
    const s = perihelionState({ q: 0.4, e: ecc, tp: 0, node: 10, peri: 200, incl: 130 });
    for (const dt of [-400, -30, 0.5, 90, 500]) {
      const t = propagate(s.r, s.v, dt);
      assert.ok(Math.abs(energy(t) - energy(s)) < 1e-12 * Math.max(1, Math.abs(energy(s)) * 1e6), `energy e=${ecc} dt=${dt}`);
      assert.ok(norm(sub(cross(t.r, t.v), cross(s.r, s.v))) < 1e-13, `momentum e=${ecc} dt=${dt}`);
      const again = propagate(t.r, t.v, -dt);
      assert.ok(norm(sub(again.r, s.r)) < 1e-10, `inverse e=${ecc} dt=${dt}`);
    }
  }
});

test('二体传播：抛物线与 Barker 方程独立解一致，椭圆与 Kepler 方程独立解一致', () => {
  // Parabola: tan(ν/2) = s with s³/3 + s = sqrt(GM/(2 q³)) t.
  const q = 0.3, s0 = perihelionState({ q, e: 1, tp: 0, node: 0, peri: 0, incl: 0 });
  for (const t of [-200, -10, 3, 60, 365]) {
    const W = Math.sqrt(GM_SUN / (2 * q ** 3)) * t;
    let s = 0; for (let k = 0; k < 100; k++) s -= (s ** 3 / 3 + s - W) / (s * s + 1);
    const nu = 2 * Math.atan(s), r = q * (1 + s * s);
    const got = propagate(s0.r, s0.v, t).r;
    assert.ok(Math.abs(norm(got) - r) < 1e-11, `parabola r t=${t}`);
    // In the ecliptic frame the true anomaly is the angle from perihelion; the equator rotation preserves angles.
    assert.ok(Math.abs(angle(got, s0.r) - Math.abs(nu) * 180 / Math.PI) < 1e-8, `parabola ν t=${t}`);
  }
  const a = 3.1, e = 0.64, el = { q: a * (1 - e), e, tp: 100, node: 120, peri: 15, incl: 7 };
  for (const t of [-500, 100, 230, 1700]) {
    const M = Math.sqrt(GM_SUN / a ** 3) * (t - el.tp);
    let E = M; for (let k = 0; k < 100; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    assert.ok(Math.abs(norm(cometState(el, t).r) - a * (1 - e * Math.cos(E))) < 1e-11, `ellipse t=${t}`);
  }
});

test('亮度：近日点前后分段定律在近日点附近平滑过渡，远离近日点各用各的；Kammerer 公式取值', () => {
  const photometry = { pre: { H: 7, n: 4.5 }, post: { H: 6, n: 3.5 } }, tp = 1000;
  assert.deepEqual(magnitudeLaw(photometry, tp, tp - 30), photometry.pre);
  assert.deepEqual(magnitudeLaw(photometry, tp, tp + PERIHELION_BLEND_DAYS + 1), photometry.post);
  let previous = magnitudeLaw(photometry, tp, tp - PERIHELION_BLEND_DAYS).H;
  for (let t = tp - PERIHELION_BLEND_DAYS; t <= tp + PERIHELION_BLEND_DAYS; t += 0.25) {
    const H = magnitudeLaw(photometry, tp, t).H;
    assert.ok(Math.abs(H - previous) < 0.07, `continuous at ${t}`); previous = H;
  }
  assert.equal(totalMagnitude({ H: 5, n: 4 }, 1, 1), 5);
  assert.ok(Math.abs(totalMagnitude({ H: 5, n: 4 }, 0.5, 2) - (5 + 5 * Math.log10(2) + 10 * Math.log10(0.5))) < 1e-12);
  // Hand evaluation of Kammerer's formulas for m_h = 2, r = 0.5 au.
  const L0 = 10 ** (-0.0075 * 4 - 0.38 + 2.1), L = L0 * (1 - 10 ** -2) * (1 - 10 ** -1);
  assert.ok(Math.abs(tailLengthAu(2, 0.5) * AU_KM / 1e6 - L) < 1e-9);
  const D0 = 10 ** (-0.0033 * 4 - 0.14 + 3.25), D = D0 * (1 - 10 ** -1) * (1 - 10 ** -0.5);
  assert.ok(Math.abs(comaDiameterKm(2, 0.5) / 1000 - D) < 1e-9);
  // Brighter comets have longer tails; tails shrink far from the Sun.
  assert.ok(tailLengthAu(1, 0.6) > tailLengthAu(4, 0.6));
  assert.ok(tailLengthAu(heliocentricMagnitude({ H: 6, n: 4 }, 3), 3) < 0.01 * tailLengthAu(heliocentricMagnitude({ H: 6, n: 4 }, 0.5), 0.5) * 30);
});

const neowise = { latitude: 35.7, longitude: 139.7, instant: '2020-07-15T11:30:00Z' };
const findView = (plan, id, mcd = 0) => cometScene(plan, mcd).views.find((view) => view.comet.id === id);
/** Head direction without the magnitude limit: the scene's light-time and frame steps for one comet. */
function headOnly(comet, plan) {
  const original = comet.photometry;
  comet.photometry = { pre: { H: 0, n: 0 }, post: { H: 0, n: 0 } };
  try { return cometScene({ ...plan, latitude: plan.latitude + 1e-9 }).views.find((view) => view.comet === comet); }
  finally { comet.photometry = original; }
}

test('彗星场景：回归窗口内才列出，彗尾从彗核出发，离子尾长于尘埃尾，暮光越深可见比例越大，白昼与光污染缩短彗尾', () => {
  const view = findView(neowise, 'C/2020 F3');
  assert.ok(view, 'NEOWISE listed');
  assert.ok(angle(view.ion[0].ray, view.point.direction) < 1e-6 && angle(view.dust[0].ray, view.point.direction) < 1e-6);
  assert.ok(view.ionDegrees > view.dustDegrees && view.dustDegrees > 1, `${view.ionDegrees} ${view.dustDegrees}`);
  assert.equal(view.extrapolated, false);
  assert.ok(view.magnitude > 1.5 && view.magnitude < 3.5, `magnitude ${view.magnitude}`);
  // Every listed comet lies in its window and is brighter than the limit.
  const scene = cometScene(neowise);
  assert.equal(scene.inWindow, comets.filter((c) => inWindow(c, Date.parse(neowise.instant))).length);
  assert.ok(scene.views.every((v) => v.magnitude <= COMET_LIST_LIMIT));
  assert.equal(findView({ ...neowise, instant: '2019-06-01T11:30:00Z' }, 'C/2020 F3'), undefined);
  // Evening twilight deepens: more of the tail shows; daylight hides it.
  const dusk = cometScene(neowise), later = cometScene({ ...neowise, instant: '2020-07-15T13:30:00Z' }), noon = cometScene({ ...neowise, instant: '2020-07-15T03:00:00Z' });
  assert.ok(dusk.visibleShare < later.visibleShare && later.visibleShare <= 1);
  assert.equal(noon.visibleShare, 0);
  assert.ok(Math.abs(dusk.visibleShare - Math.max(0, 1 - dusk.skyFade / TAIL_FADE_MAGNITUDES)) < 1e-12);
  const polluted = cometScene({ ...neowise, instant: '2020-07-15T13:30:00Z' }, 2);
  assert.ok(polluted.visibleShare < later.visibleShare);
  const full = findView({ ...neowise, instant: '2020-07-15T13:30:00Z' }, 'C/2020 F3');
  assert.ok(visibleTailDegrees(full.ion, polluted.visibleShare) < visibleTailDegrees(full.ion, later.visibleShare));
  assert.ok(Math.abs(visibleTailDegrees(full.ion, 1) - full.ionDegrees) < 1e-9);
  assert.equal(visibleTailDegrees(full.ion, 0), 0);
});

test('彗星网格：属性铺满步长，方向为单位向量，彗核与两条彗尾都有顶点；白昼无网格；不透明度随长度与天光单调减弱', () => {
  assert.deepEqual(COMET_ATTRIBUTES.map(([, size, offset]) => [offset, size]).reduce((end, [offset, size]) => (assert.equal(offset, end * 4), end + size), 0), COMET_STRIDE);
  const scene = cometScene({ ...neowise, instant: '2020-07-15T13:30:00Z' });
  const mesh = cometMesh(scene.views, 'standard', scene.skyFade);
  assert.equal(mesh.length % COMET_STRIDE, 0);
  const kinds = new Set();
  for (let i = 0; i < mesh.length; i += COMET_STRIDE) {
    assert.ok(Math.abs(Math.hypot(mesh[i], mesh[i + 1], mesh[i + 2]) - 1) < 1e-6 && Math.abs(Math.hypot(mesh[i + 3], mesh[i + 4], mesh[i + 5]) - 1) < 1e-6);
    // A segment fading out ends at zero opacity; nothing exceeds the head's 0.9.
    assert.ok(mesh[i + 8] >= 0 && mesh[i + 8] <= 0.9);
    kinds.add(mesh[i + 9]);
  }
  assert.deepEqual([...kinds].sort(), [0, 1, 2]);
  const noon = cometScene({ ...neowise, instant: '2020-07-15T03:00:00Z' });
  assert.equal(cometMesh(noon.views, 'standard', noon.skyFade).length, 0);
  let previous = Infinity;
  for (let at = 0; at <= 1; at += 0.05) { const a = tailOpacity(0.5, at, 0); assert.ok(a <= previous + 1e-12); previous = a; }
  assert.equal(tailOpacity(0.5, 1, 0), 0);
  assert.equal(tailOpacity(0.5, 0.5, TAIL_FADE_MAGNITUDES * 0.5), 0);
  assert.ok(headOpacity(6, 0) > headOpacity(6, 2) && headOpacity(6, 2) > headOpacity(6, 4));
  assert.ok(headOpacity(3, 2) >= headOpacity(6, 2));
  assert.ok(tailPeak(1) > tailPeak(6) && tailPeak(12) === 0.1);
});

test('位置：与 JPL Horizons 无折射测站方位/高度对照（32 个时刻，含近日点前后 400 天与近地掠过）', () => {
  const reference = JSON.parse(readFileSync(new URL('../fixtures/comet-reference.json', import.meta.url), 'utf8'));
  assert.equal(reference.records.length, 32);
  const errors = [];
  for (const record of reference.records) {
    const comet = comets.find((c) => c.id === record.id);
    const plan = { latitude: record.latitude, longitude: record.longitude, instant: record.instant };
    // Faint dates are not listed by the scene, so compare the head direction through a lowered limit.
    const view = cometScene(plan).views.find((v) => v.comet.id === record.id) ?? headOnly(comet, plan);
    errors.push(angle(view.point.direction, direction(record.azimuth, record.elevation)) * 60);
  }
  errors.sort((a, b) => a - b);
  // Two-body motion from perihelion elements: within 1.5′ except Hyakutake 40 days before its 0.10 au pass of Earth.
  assert.ok(errors[errors.length - 2] < 1.5, `second worst ${errors[errors.length - 2]}′`);
  assert.ok(errors.at(-1) < 8, `worst ${errors.at(-1)}′`);
  assert.ok(errors[Math.floor(errors.length / 2)] < 0.3, `median ${errors[Math.floor(errors.length / 2)]}′`);
});

test('彗尾：与 COBS 每夜目视彗尾报告对照（12 颗彗星），暗夜长度接近第 90 百分位，方向与报告的位置角一致', async () => {
  const { HelioDistance, Body } = await import('astronomy-engine');
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/comet-tails.json', import.meta.url), 'utf8'));
  const site = { latitude: 0, longitude: 0 }, pole = direction(0, 0);
  const pa = (head, tip) => {
    const along = pole.map((x, i) => x - pole.reduce((s, y, k) => s + y * head[k], 0) * head[i]), north = along.map((x) => x / norm(along));
    const east = cross(north, head), d = sub(tip, head);
    return (Math.atan2(d.reduce((s, x, i) => s + x * east[i], 0), d.reduce((s, x, i) => s + x * north[i], 0)) * 180 / Math.PI + 360) % 360;
  };
  const wrap = (a) => Math.abs(((a + 540) % 360) - 180);
  const dark = [], twilight = [], angles = [];
  for (const comet of fixture.comets) for (const night of comet.nights) {
    const instant = `${night.day}T12:00:00Z`, view = cometScene({ ...site, instant }).views.find((v) => v.comet.id === comet.id);
    assert.ok(view, `${comet.id} ${night.day}`);
    const R = HelioDistance(Body.Earth, new Date(instant));
    const elongation = Math.acos((R * R + view.delta ** 2 - view.r ** 2) / (2 * R * view.delta)) * 180 / Math.PI;
    const row = { ratio: view.ionDegrees / night.p90, inside: view.ionDegrees >= 0.5 * night.median && view.ionDegrees <= 1.5 * night.max };
    (elongation >= 35 ? dark : twilight).push(row);
    if (night.positionAngle !== null)
      angles.push(Math.min(wrap(night.positionAngle - pa(view.point.direction, view.ion.at(-1).ray)), wrap(night.positionAngle - pa(view.point.direction, view.dust.at(-1).ray))));
  }
  const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  assert.ok(dark.length > 300 && twilight.length > 100);
  const darkRatio = median(dark.map((row) => row.ratio));
  assert.ok(darkRatio > 0.7 && darkRatio < 1.3, `dark-sky ion / p90 ${darkRatio}`);
  assert.ok(dark.filter((row) => row.inside).length >= 0.85 * dark.length, 'dark nights inside [0.5 median, 1.5 max]');
  // Comets seen only in twilight show shorter tails than the dark-sky length.
  assert.ok(median(twilight.map((row) => row.ratio)) > darkRatio);
  assert.ok(median(angles) < 6, `position angle ${median(angles)}°`);
});
