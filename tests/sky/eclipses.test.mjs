import test from "node:test";
import assert from "node:assert/strict";
import { MakeTime } from "astronomy-engine";
import {
  centralPath, eclipsesInSpan, greatCircle, lunarEclipseAfter, nextCentralEclipse, nextLunarEclipse, nextSolarEclipse, pathRelation,
  pathSample, umbraFootprint,
} from "../../src/domain/sun-moon/eclipses.ts";
import {
  TOTALITY_ELEVATION, discDifference, discIntersection, discOverlap, eclipseSkyElevation,
} from "../../src/domain/core/eclipse-geometry.ts";
import { celestialBodies } from "../../src/domain/core/ephemeris.ts";

const within = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} vs ${expected} (±${tolerance})`);
const area = (loop) => Math.abs(loop.reduce((sum, p, i) => {
  const q = loop[(i + 1) % loop.length];
  return sum + p.x * q.y - q.x * p.y;
}, 0)) / 2;
const total = (loops) => loops.reduce((sum, loop) => sum + area(loop), 0);
/** "25 38.3N" / "032 58.8E" → signed degrees. */
const dm = (text) => {
  const [, d, m, h] = text.match(/(\d+) (\d+\.\d)([NSEW])/);
  return (/[SW]/.test(h) ? -1 : 1) * (Number(d) + Number(m) / 60);
};
const deltaT = (iso) => { const time = MakeTime(new Date(iso)); return (time.tt - time.ut) * 86400; };
const seconds = (a, b) => (Date.parse(a) - Date.parse(b)) / 1000;

test("圆面相交：月牙、光环、全遮与不相交的面积与相交公式一致", () => {
  const sun = { x: 0, y: 0, r: 1 };
  for (const [x, y, r] of [[3, 0, 1], [1.2, 0.4, 1.05], [0.5, -0.2, 0.9], [0.1, 0.05, 0.92], [0, 0, 0.6], [0.05, 0, 1.08], [0, 0, 1]]) {
    const moon = { x, y, r }, distance = Math.hypot(x, y), covered = discOverlap(1, r, distance);
    within(total(discDifference(sun, moon)) / Math.PI, 1 - covered, 0.002, `差集 ${x},${y},${r}`);
    within(total(discIntersection(sun, moon)) / Math.PI, covered, 0.002, `交集 ${x},${y},${r}`);
  }
  // A ring is cut into two pieces so no polygon needs a hole; totality leaves nothing.
  assert.equal(discDifference(sun, { x: 0.1, y: 0, r: 0.9 }).length, 2);
  assert.equal(discDifference(sun, { x: 0.02, y: 0, r: 1.05 }).length, 0);
  assert.equal(discIntersection(sun, { x: 5, y: 0, r: 1 }).length, 0);
});

test("食时天空：无食时原样返回，遮挡越多越暗，全食按民用晨昏光结束近似", () => {
  for (const elevation of [-30, -8, -3, 0, 12, 45, 80]) assert.equal(eclipseSkyElevation(elevation, 0), elevation);
  let previous = Infinity;
  for (const obscuration of [0.1, 0.3, 0.5, 0.8, 0.95, 0.999, 1]) {
    const value = eclipseSkyElevation(40, obscuration);
    assert.ok(value < previous && value <= 40, `${obscuration}: ${value}`);
    previous = value;
  }
  assert.equal(eclipseSkyElevation(40, 1), TOTALITY_ELEVATION);
  // A Sun already below the floor is not brightened.
  assert.equal(eclipseSkyElevation(-10, 1), -10);
  within(eclipseSkyElevation(-3, 1), -6, 1e-9);
});

// NASA eclipse web site (Fred Espenak, NASA GSFC), path tables in UT with the
// printed ΔT. Our ΔT comes from astronomy-engine, so each NASA time is moved by
// the ΔT difference to compare the same dynamical instant.
const paths = [
  {
    date: "2027-08-02", kind: "total", deltaT: 71.7, rows: [
      ["08:30", "33 51.7N", "027 04.0W", "32 16.4N", "024 52.3W", "33 05.1N", "025 54.2W"],
      ["09:10", "35 49.9N", "010 01.5E", "33 37.2N", "009 40.4E", "34 43.4N", "009 51.5E"],
      ["10:06", "26 34.9N", "033 44.1E", "24 41.7N", "032 14.2E", "25 38.3N", "032 58.8E"],
      ["10:30", "20 57.0N", "041 13.6E", "19 15.0N", "039 31.5E", "20 06.1N", "040 22.2E"],
      ["11:10", "09 21.8N", "054 21.9E", "07 57.0N", "052 28.0E", "08 39.7N", "053 24.4E"],
    ],
  },
  {
    date: "2027-02-06", kind: "annular", deltaT: 71.6, rows: [
      ["15:10", "39 45.3S", "065 17.4W", "42 10.8S", "064 09.6W", "40 57.6S", "064 43.6W"],
      ["16:00", "30 17.7S", "049 22.3W", "32 08.4S", "047 20.3W", "31 12.8S", "048 21.9W"],
      ["16:30", "23 25.4S", "042 16.5W", "25 02.3S", "039 59.9W", "24 13.6S", "041 08.8W"],
      ["17:10", "12 42.3S", "032 11.0W", "14 08.7S", "029 29.6W", "13 25.2S", "030 51.3W"],
    ],
  },
];

test("中心食带：与 NASA 路径表同一时刻的中心线 ≤ 3 km、两侧界线 ≤ 4.5 km", () => {
  for (const { date, kind, deltaT: nasa, rows } of paths) {
    const central = nextCentralEclipse(`${date}T00:00:00Z`);
    assert.equal(central.kind, kind);
    assert.ok(central.instant.startsWith(date));
    const shift = nasa - deltaT(central.instant);
    for (const [time, nlat, nlon, slat, slon, clat, clon] of rows) {
      const sample = pathSample(Date.parse(`${date}T${time}:00Z`) + shift * 1000);
      assert.equal(sample.kind, kind);
      within(greatCircle({ latitude: dm(clat), longitude: dm(clon) }, sample.centre).distance, 0, 3, `${date} ${time} 中心线`);
      const limits = [[dm(nlat), dm(nlon)], [dm(slat), dm(slon)]];
      for (const [latitude, longitude] of limits) {
        const nearest = Math.min(...sample.edges.map((edge) => greatCircle({ latitude, longitude }, edge).distance));
        within(nearest, 0, 4.5, `${date} ${time} 界线`);
      }
    }
    const path = centralPath(central.instant);
    assert.equal(path.kind, kind);
    assert.ok(path.samples.length > 300);
  }
});

test("中心线上的本地食况：类型、食甚时刻与中心食持续时间符合 NASA", () => {
  // [date, NASA ΔT, row UT, centre lat, lon, central duration s, kind]
  for (const [date, nasa, time, lat, lon, duration, kind] of [
    ["2027-08-02", 71.7, "10:06", "25 38.3N", "032 58.8E", 6 * 60 + 22.7, "total"],
    ["2027-08-02", 71.7, "09:10", "34 43.4N", "009 51.5E", 5 * 60 + 41.5, "total"],
    ["2027-02-06", 71.6, "16:00", "31 12.8S", "048 21.9W", 7 * 60 + 50.8, "annular"],
  ]) {
    const place = { latitude: dm(lat), longitude: dm(lon), refraction: "none" };
    const [eclipse] = eclipsesInSpan(place, { start: `${date}T00:00:00Z`, end: `${date}T23:59:00Z` }, { sun: true, moon: false });
    assert.equal(eclipse.kind, kind);
    const second = eclipse.contacts.find((c) => c.id === "U2"), third = eclipse.contacts.find((c) => c.id === "U3");
    // Solar and lunar radii follow astronomy-engine (695,700 / 1,737.4 km), slightly larger
    // than NASA's constants: totality runs a few seconds longer and annularity shorter.
    within(seconds(third.instant, second.instant), duration, 8, `${date} ${time} 持续时间`);
    const reference = Date.parse(`${date}T${time}:00Z`) + (nasa - deltaT(eclipse.peak.instant)) * 1000;
    within(seconds(eclipse.peak.instant, new Date(reference).toISOString()), 0, 20, `${date} ${time} 食甚`);
  }
});

// NASA 2021—2030 lunar eclipse decade table: greatest eclipse in TD, umbral
// magnitude, partial and total phase durations (minutes, rounded).
const lunar = [
  ["2026-03-03T11:34:52", "total", 1.151, 207, 58],
  ["2026-08-28T04:14:04", "partial", 0.93, 198, 0],
  ["2027-02-20T23:14:06", "penumbral", -0.057, 0, 0],
  ["2028-01-12T04:14:13", "partial", 0.066, 56, 0],
  ["2028-07-06T18:20:57", "partial", 0.389, 141, 0],
  ["2028-12-31T16:53:15", "total", 1.246, 209, 71],
];

test("月食：类型、食甚（TD 换算 UT）、本影食分与偏食/全食持续时间符合 NASA 十年表", () => {
  // The geometry is the same everywhere; visibility is checked elsewhere.
  for (const [td, kind, magnitude, partial, totality] of lunar) {
    const guess = `${td}Z`;
    const ut = new Date(Date.parse(guess) - deltaT(guess) * 1000).toISOString();
    const found = lunarEclipseAfter({ latitude: 0, longitude: 0, refraction: "none" }, new Date(Date.parse(ut) - 86_400_000).toISOString());
    assert.ok(found, td);
    assert.equal(found.kind, kind, td);
    within(seconds(found.peak.instant, ut), 0, 30, `${td} 食甚`);
    within(found.magnitude, magnitude, 0.02, `${td} 食分`);
    const span = (a, b) => {
      const from = found.contacts.find((c) => c.id === a), to = found.contacts.find((c) => c.id === b);
      return from && to ? seconds(to.instant, from.instant) / 60 : 0;
    };
    within(span("U1", "U4"), partial, 3, `${td} 偏食时长`);
    within(span("U2", "U3"), totality, 3, `${td} 全食时长`);
  }
});

test("日月位置带出食况：全食时遮挡 1、天空按暮光；月全食时月光几乎消失；平时不变", () => {
  const luxor = celestialBodies({ latitude: 25.687, longitude: 32.64, instant: "2027-08-02T10:05:07Z" });
  assert.equal(luxor.sun.obscuration, 1);
  assert.equal(luxor.sun.skyElevation, TOTALITY_ELEVATION);
  const madrid = celestialBodies({ latitude: 40.4, longitude: -3.7, instant: "2027-08-02T09:00:00Z" });
  assert.ok(madrid.sun.obscuration > 0.7 && madrid.sun.obscuration < 0.9);
  assert.ok(madrid.sun.skyElevation < madrid.sun.elevation);
  const plain = celestialBodies({ latitude: 35.68, longitude: 139.77, instant: "2026-11-11T03:00:00Z" });
  assert.equal(plain.sun.obscuration, 0);
  assert.equal(plain.sun.skyElevation, plain.sun.elevation);
  assert.equal(plain.moon.brightness, 1);
  assert.equal(plain.moon.shadow, undefined);
  const lunarTotal = celestialBodies({ latitude: 35.68, longitude: 139.77, instant: "2028-12-31T16:52:00Z" });
  assert.equal(lunarTotal.moon.brightness, 0.002);
  within(lunarTotal.moon.shadow.umbra, 0.72, 0.02);
  within(lunarTotal.moon.shadow.penumbra, 1.27, 0.02);
  // Umbral magnitude from the drawn geometry agrees with the table (1.246).
  const separation = Math.acos(lunarTotal.moon.direction.reduce((s, v, i) => s + v * lunarTotal.moon.shadow.direction[i], 0)) * 180 / Math.PI;
  within((lunarTotal.moon.shadow.umbra + lunarTotal.moon.angularRadius - separation) / (2 * lunarTotal.moon.angularRadius), 1.246, 0.03);
  const partial = celestialBodies({ latitude: 35.68, longitude: 139.77, instant: "2028-12-31T15:32:00Z" });
  assert.ok(partial.moon.brightness > 0.002 && partial.moon.brightness < 1);
});

test("本地可见与下次：东京下次日食 2030-06-01 偏食，下次月食 2028-07-06 月偏食带食月落前结束", () => {
  const tokyo = { latitude: 35.68, longitude: 139.77, refraction: "standard" };
  const solar = nextSolarEclipse(tokyo, "2026-11-11T00:00:00Z");
  assert.equal(solar.kind, "partial");
  assert.ok(solar.peak.instant.startsWith("2030-06-01"));
  assert.ok(solar.obscuration > 0.6 && solar.obscuration < 0.85);
  // The 2028-01-12 partial lunar eclipse happens in Tokyo's daytime and is skipped.
  const moon = nextLunarEclipse(tokyo, "2026-11-11T00:00:00Z");
  assert.equal(moon.kind, "partial");
  assert.ok(moon.peak.instant.startsWith("2028-07-06"));
  assert.ok(moon.visible);
  assert.equal(moon.contacts.find((c) => c.id === "P4").above, false);
  // The total eclipse of 2027-08-02 is invisible from Tokyo (night side).
  assert.deepEqual(eclipsesInSpan(tokyo, { start: "2027-08-01T15:00:00Z", end: "2027-08-02T15:00:00Z" }, { sun: true, moon: true }), []);
});

test("机位与食带：带内直接判定；带外给出最近界线的距离与方向；此刻本影位于中心线上", () => {
  const central = nextCentralEclipse("2027-08-01T00:00:00Z"), path = centralPath(central.instant);
  const span = { start: "2027-08-02T00:00:00Z", end: "2027-08-02T23:59:00Z" };
  const luxor = { latitude: 25.687, longitude: 32.64, refraction: "standard" };
  const [inside] = eclipsesInSpan(luxor, span, { sun: true, moon: false });
  assert.deepEqual(pathRelation(luxor, path, inside), { inside: true });
  const madrid = { latitude: 40.4, longitude: -3.7, refraction: "standard" };
  const [outside] = eclipsesInSpan(madrid, span, { sun: true, moon: false });
  assert.equal(outside.kind, "partial");
  const relation = pathRelation(madrid, path, outside);
  assert.equal(relation.inside, false);
  assert.ok(relation.distance > 150 && relation.distance < 450, `${relation.distance}`);
  assert.ok(relation.bearing > 120 && relation.bearing < 240, `${relation.bearing}`);
  const footprint = umbraFootprint(central.instant);
  const centre = pathSample(Date.parse(central.instant)).centre;
  const radii = footprint.map(([longitude, latitude]) => greatCircle({ latitude, longitude }, centre).distance);
  assert.ok(Math.min(...radii) > 100 && Math.max(...radii) < 160, radii.join());
  assert.equal(umbraFootprint("2027-08-02T15:00:00Z"), null);
});
