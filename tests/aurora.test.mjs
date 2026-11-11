import test from "node:test";
import assert from "node:assert/strict";
import {
  AURORA_TOP_KM, DIPOLE_CENTRE, GEOMAGNETIC_POLE, VIEW_ELEVATION, auroraChances, auroraElevation, auroraLines, auroraView,
  geographic, geomagnetic, kpAt, kpLabel, magneticLocalTime, ovalBoundary, ovationApplies, ovationAt, ovationCells,
  parseKpForecast, parseOutlook, parseOvation, subsolarPoint, viewArc,
} from "../src/domain/aurora.ts";

const within = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} vs ${expected} (±${tolerance})`);

test("地磁坐标：IGRF-14 偏心偶极的极点与中心偏移符合文献量级，往返一致", () => {
  // Dipole pole near 80.8°N, 72.8°W (WMM2025 / IGRF-14).
  within(GEOMAGNETIC_POLE.latitude, 80.8, 0.1);
  within(GEOMAGNETIC_POLE.longitude, -72.76, 0.1);
  // The eccentric dipole centre sits roughly 550—650 km toward the western Pacific (about 20°N, 140°E).
  const [x, y, z] = DIPOLE_CENTRE.map((value) => value * 6371);
  within(Math.hypot(x, y, z), 600, 60, "偏移 km");
  within(Math.asin(z / Math.hypot(x, y, z)) * 180 / Math.PI, 22, 6, "偏移方向纬度");
  within(Math.atan2(y, x) * 180 / Math.PI, 137, 8, "偏移方向经度");
  for (const point of [{ latitude: 51.5, longitude: -0.13 }, { latitude: -42.9, longitude: 147.3 }, { latitude: 69.6, longitude: 18.9 }, { latitude: 0, longitude: -170 }]) {
    const back = geographic(geomagnetic(point));
    within(back.latitude, point.latitude, 1e-9);
    within(back.longitude, point.longitude, 1e-9);
  }
  // High-latitude sites keep their order and rough corrected-geomagnetic values.
  const lat = (latitude, longitude) => geomagnetic({ latitude, longitude }).latitude;
  within(lat(69.65, 18.96), 66.5, 1.5, "特罗姆瑟");
  within(lat(51.5, -0.13), 50, 1.5, "伦敦");
  assert.ok(lat(-42.88, 147.33) < -50, "霍巴特在南半球");
});

test("磁地方时：机位位于日下点的磁子午线时约 12 时，对侧约 0 时", () => {
  const instant = "2026-06-21T12:00:00Z", sun = subsolarPoint(instant);
  within(sun.latitude, 23.44, 0.05);
  within(magneticLocalTime(sun, instant), 12, 0.01);
  const opposite = geographic({ latitude: 60, longitude: geomagnetic(sun).longitude + 180 });
  const mlt = magneticLocalTime(opposite, instant);
  assert.ok(mlt < 0.05 || mlt > 23.95, `${mlt}`);
});

test("Carbary 极光带边界：夜侧随 Kp 线性南扩，相邻时段连续，白天缺测按两侧插值", () => {
  within(ovalBoundary(0, 0), 67.22, 1e-9);
  within(ovalBoundary(5, 0), 67.22 - 1.89 * 5, 1e-9);
  for (const mlt of [0, 2.5, 6, 11, 18, 21.7, 23.9])
    for (let kp = 0; kp < 9; kp++) assert.ok(ovalBoundary(kp + 1, mlt) < ovalBoundary(kp, mlt));
  for (let mlt = 0; mlt < 24; mlt += 0.25)
    assert.ok(Math.abs(ovalBoundary(4, mlt + 0.25) - ovalBoundary(4, mlt)) < 2.5, `${mlt}`);
  within(ovalBoundary(3, 11), 76.44 - 2.63 * 3 + ((84.18 - 3.09 * 3) - (76.44 - 2.63 * 3)) * 0.5, 1e-9);
  within(ovalBoundary(3, 23.5), (67.56 - 1.88 * 3 + 67.22 - 1.89 * 3) / 2, 1e-9);
});

test("可见几何：200 km 极光顶部在 10° 弧距处高出地平线约 5°；头顶、低空、贴近地平线与看不到", () => {
  within(auroraElevation(AURORA_TOP_KM, 0), 90, 1e-9);
  within(auroraElevation(AURORA_TOP_KM, viewArc(VIEW_ELEVATION)), VIEW_ELEVATION, 1e-6);
  within(viewArc(VIEW_ELEVATION), 10, 0.2);
  const instant = "2026-11-11T00:00:00Z";
  const tromso = auroraView({ latitude: 69.65, longitude: 18.96 }, instant, 3);
  assert.equal(tromso.kind, "overhead");
  assert.equal(tromso.neededKp, 0);
  const tokyo = auroraView({ latitude: 35.68, longitude: 139.77 }, instant, 9);
  assert.equal(tokyo.kind, "none");
  assert.equal(tokyo.neededKp, null);
  const london = [3, 5, 7].map((kp) => auroraView({ latitude: 51.5, longitude: -0.13 }, instant, kp));
  assert.deepEqual(london.map((view) => view.kind), ["none", "horizon", "low"]);
  assert.ok(london[0].neededKp > 3 && london[0].neededKp <= 5);
  // Northern observers look roughly north, southern ones roughly south.
  const north = london[1].bearing, south = auroraView({ latitude: -42.88, longitude: 147.33 }, instant, 7).bearing;
  assert.ok(north > 300 || north < 60, `${north}`);
  assert.ok(south > 120 && south < 240, `${south}`);
});

test("与 NOAA 地磁暴分级的可见纬度对照：G2—G4 的说明值介于本模型可见线与边界之间（磁午夜）", () => {
  // NOAA space weather scales: aurora seen as low as ~55° (G2, Kp 6), ~50° (G3, Kp 7), ~45° (G4, Kp 8) geomagnetic latitude.
  for (const [kp, noaa] of [[6, 55], [7, 50], [8, 45]]) {
    const edge = ovalBoundary(kp, 0), view = edge - viewArc(VIEW_ELEVATION);
    assert.ok(view <= noaa && noaa <= edge + 1, `Kp ${kp}: ${view.toFixed(1)}—${edge.toFixed(1)} vs ${noaa}`);
  }
});

const forecastJson = [
  { time_tag: "2026-11-10T21:00:00", kp: 2.33, observed: "observed", noaa_scale: null },
  { time_tag: "2026-11-11T00:00:00", kp: 2.67, observed: "estimated", noaa_scale: null },
  { time_tag: "2026-11-11T03:00:00", kp: 5.33, observed: "predicted", noaa_scale: "G1" },
];
const outlookText = `:Product: 27-day Space Weather Outlook Table 27DO.txt
#   UTC      Radio Flux   Planetary   Largest
#  Date       10.7 cm      A Index    Kp Index
2026 Nov 11     120          10          3
2026 Nov 12     120          10          3
2026 Nov 17      95          20          5
`;

test("NOAA 产品解析：Kp 预报三档、27 天展望、取值先用 3 小时值再用展望；OVATION 网格与适用时窗", () => {
  const forecast = parseKpForecast(forecastJson), outlook = parseOutlook(outlookText);
  assert.deepEqual(forecast.map((block) => block.kind), ["observed", "estimated", "predicted"]);
  assert.equal(forecast[2].start, Date.UTC(2026, 10, 11, 3));
  assert.equal(outlook.length, 3);
  assert.deepEqual(outlook[2], { start: Date.UTC(2026, 10, 17), end: Date.UTC(2026, 10, 18), kp: 5, kind: "outlook" });
  assert.equal(kpAt(Date.UTC(2026, 10, 11, 4), forecast, outlook).kp, 5.33);
  assert.equal(kpAt(Date.UTC(2026, 10, 12, 4), forecast, outlook).kind, "outlook");
  assert.equal(kpAt(Date.UTC(2026, 11, 30), forecast, outlook), null);
  assert.throws(() => parseKpForecast([{ time_tag: "x", kp: 3, observed: "observed" }]), /Kp/);
  assert.throws(() => parseOutlook("nothing"), /展望/);
  assert.deepEqual([4.67, 5, 5.33, 0].map(kpLabel), ["5−", "5", "5+", "0"]);
  const ovation = parseOvation({
    "Observation Time": "2026-11-11T07:03:00Z", "Forecast Time": "2026-11-11T07:53:00Z",
    coordinates: [[18, 69, 40], [19, 69, 35], [20, 69, 8], [359, 70, 65], [0, 70, 62]],
  });
  assert.equal(ovationAt(ovation, { latitude: 69.4, longitude: 18.3 }), 40);
  // −0.6° rounds to the 359° cell.
  assert.equal(ovationAt(ovation, { latitude: 70, longitude: -0.6 }), 65);
  assert.equal(ovationAt(ovation, { latitude: 70, longitude: 0.4 }), 62);
  assert.equal(ovationApplies(ovation, Date.parse("2026-11-11T08:30:00Z")), true);
  assert.equal(ovationApplies(ovation, Date.parse("2026-11-11T09:00:00Z")), false);
  const cells = ovationCells(ovation);
  // 18—19° merge into one 30—60 % run; 20° is below 10 %; 359° and 0° stay separate runs.
  assert.deepEqual(cells.map((cell) => [cell.band, cell.ring[0][0], cell.ring[1][0]]), [[2, 17.5, 19.5], [3, -0.5, 0.5], [3, -1.5, -0.5]]);
});

test("时间轴极光时段与地图线：只在够暗且可见时出现；两个半球的边界与可见线经度连续", () => {
  const kp = (value) => Array.from({ length: 16 }, (_, index) => ({ start: Date.UTC(2026, 10, 11, 12) + index * 3 * 3_600_000, end: Date.UTC(2026, 10, 11, 15) + index * 3 * 3_600_000, kp: value, kind: "predicted" }));
  const span = { start: "2026-11-11T11:00:00Z", end: "2026-11-12T11:00:00Z" };
  const edinburgh = auroraChances({ latitude: 55.95, longitude: -3.19 }, span, kp(6), null);
  assert.equal(edinburgh.length, 1);
  assert.ok(edinburgh[0].from >= Date.UTC(2026, 10, 11, 17) && edinburgh[0].to <= Date.UTC(2026, 10, 12, 7), JSON.stringify(edinburgh[0]));
  assert.deepEqual(auroraChances({ latitude: 35.68, longitude: 139.77 }, span, kp(9), null), []);
  assert.deepEqual(auroraChances({ latitude: 55.95, longitude: -3.19 }, span, null, null), []);
  const lines = auroraLines("2026-11-11T22:00:00Z", 5);
  assert.deepEqual(lines.map((line) => line.kind), ["edge", "view", "edge", "view"]);
  for (const [index, line] of lines.entries()) {
    assert.ok(line.coordinates.every(([, latitude]) => index < 2 ? latitude > 40 : latitude < -30));
    for (let i = 1; i < line.coordinates.length; i++) assert.ok(Math.abs(line.coordinates[i][0] - line.coordinates[i - 1][0]) < 30);
  }
});
