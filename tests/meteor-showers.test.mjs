import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeShowers, cameraLimitFor, meteorEstimate, meteorModel, meteorNight, meteorSample, meteorShowers, skyAlignment, skyBrightness, solarLongitude,
} from "../src/domain/meteor-showers.ts";
import { projectDirection } from "../src/domain/celestial-projection.ts";
import { direction } from "../src/domain/ephemeris.ts";
import { dayEvents } from "../src/domain/day-events.ts";

const data = JSON.parse(readFileSync(new URL("../src/data/meteor-showers.json", import.meta.url), "utf8"));
const rad = Math.PI / 180;
const diff = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180);
const site = { latitude: 35.4172, longitude: 138.8729 };
const lens = { focalLength: 14, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
const byCode = (code) => meteorShowers().find((s) => s.code === code);

test("IMO 2026 工作表 38 个流星雨、表 6 的 234 个辐射点全部提取，来源哈希与匹配误差保留", () => {
  assert.equal(data.showers.length, 38);
  assert.equal(new Set(data.showers.map((s) => s.code)).size, 38);
  assert.equal(data.showers.reduce((n, s) => n + s.drift.length, 0), 234, "468 degree signs on the Table 6 page");
  assert.equal(data.sources[0].sha256, "fde5388889ebda9fe13436d793da5e9935ae46b99edf20e0b19f7fe32ce1ed9f");
  assert.equal(data.sources[1].sha256, "8df129390c41df5bdefd54f8979ec18afc7ce94090316ca94a6d7a2609fe4fa1");
  assert.match(data.sources[0].rights, /No explicit licence/);
  // Table 6 tracks agree with the Table 5 radiants except the three noted showers.
  const loose = Object.entries(data.table6Matching).filter(([, d]) => d > 1.1).map(([code]) => code).sort();
  assert.deepEqual(loose, ["ERI", "KCG", "SLY"]);
  assert.equal(data.showers.filter((s) => s.zhr === null).map((s) => s.code).sort().join(), "AMO,JBO,PHO,PPU");
  for (const s of data.showers) assert.ok(s.name.endsWith("流星雨") || s.code === "ANT", s.code);
});

test("J2000 太阳黄经与 IMO 极大日期一致，并与独立低精度太阳公式相差不到 0.02°", () => {
  for (const s of meteorShowers()) {
    if (s.maxLongitude === null || s.referenceOnly) continue;
    const [month, day] = s.maximum.split("-").map(Number);
    // The listed maximum falls within that UT day.
    assert.ok(diff(solarLongitude(new Date(Date.UTC(2026, month - 1, day, 12))), s.maxLongitude) <= 0.55, s.code);
  }
  // Meeus ch. 25 (low accuracy), apparent → J2000 by removing precession since 2000.
  for (const iso of ["2026-01-03T12:00:00Z", "2026-08-13T00:00:00Z", "2026-12-14T14:00:00Z", "1950-08-12T00:00:00Z", "2099-11-17T00:00:00Z"]) {
    const jd = Date.parse(iso) / 86400000 + 2440587.5, t = (jd - 2451545) / 36525;
    const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t, m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * rad;
    const c = (1.914602 - 0.004817 * t) * Math.sin(m) + (0.019993 - 0.000101 * t) * Math.sin(2 * m) + 0.000289 * Math.sin(3 * m);
    // Geometric longitude of date, then back to the J2000 equinox (precession 5029″ per century).
    const j2000 = l0 + c - 1.396971 * t;
    assert.ok(diff(solarLongitude(new Date(iso)), j2000) < 0.02, `${iso}: ${solarLongitude(new Date(iso))} vs ${j2000}`);
  }
});

test("活动期按太阳黄经判断，可用于其他年份；不定 ZHR 的流星雨只在活动期内列出", () => {
  const codes = (instant) => activeShowers({ ...site, instant }).map((a) => a.shower.code).sort();
  assert.deepEqual(codes("2026-08-12T15:00:00Z"), ["ANT", "CAP", "ERI", "KCG", "PER", "SDA"]);
  assert.ok(codes("2026-12-14T14:00:00Z").includes("GEM"));
  assert.ok(codes("2027-01-03T20:00:00Z").includes("QUA"), "a later year reuses the solar longitude window");
  assert.ok(codes("2026-06-22T12:00:00Z").includes("JBO"));
  assert.ok(!codes("2026-09-25T12:00:00Z").includes("ANT"), "the antihelion source pauses Sep 21 – Dec 9");
  assert.ok(codes("2026-01-25T12:00:00Z").includes("COM") && codes("2026-01-25T12:00:00Z").includes("ANT"));
  assert.ok(!codes("2026-02-01T12:00:00Z").includes("COM"), "Comae Berenicids end on Jan 30");
});

test("ZHR 在极大时等于工作表值，活动期外为 0；有 MEO 峰形的按其指数下降，没有的在活动期两端降一个量级", () => {
  for (const s of meteorShowers()) {
    if (s.zhr === null) {
      assert.equal(s.zhrAt(s.maxLongitude), null, s.code);
      continue;
    }
    if (s.maxLongitude !== null) assert.ok(Math.abs(s.zhrAt(s.maxLongitude) - s.zhr) < 1e-9, s.code);
    assert.equal(s.zhrAt(s.start - 1), 0, s.code);
    assert.equal(s.zhrAt(s.end + 1), 0, s.code);
  }
  // Quadrantids: 80 at maximum, MEO growth 0.865 / decay 0.827 per degree.
  const qua = byCode("QUA");
  assert.ok(Math.abs(qua.zhrAt(qua.maxLongitude - 1) - 80 * 10 ** -0.865) < 1e-9);
  assert.ok(Math.abs(qua.zhrAt(qua.maxLongitude + 1) - 80 * 10 ** -0.827) < 1e-9);
  // Perseids stack the MEO peak and base components, scaled to the IMO 100.
  const per = byCode("PER"), peak = (d) => 80 * 10 ** (-0.35 * Math.abs(d)) + 23 * 10 ** (d < 0 ? 0.05 * d : -0.092 * d);
  assert.ok(Math.abs(per.zhrAt(per.maxLongitude + 3) - (100 * peak(3)) / peak(0)) < 1e-9);
  const eri = byCode("ERI");
  assert.equal(eri.profileSource, "window");
  assert.ok(Math.abs(eri.zhrAt(eri.start + 1e-9) / eri.zhr - 0.1) < 1e-6, "one decade lower at the start of the window");
  assert.equal(byCode("ANT").zhrAt(10), 4);
});

test("辐射点在极大时等于表 5，日常漂移取自表 6；地平坐标与独立岁差/恒星时公式相差不到 0.05°", () => {
  for (const s of meteorShowers()) {
    if (s.maxLongitude === null) continue;
    const table = data.showers.find((raw) => raw.code === s.code).radiant;
    const [ra, dec] = s.radiantAt(s.maxLongitude);
    assert.ok(diff(ra, table[0]) < 1e-6 && Math.abs(dec - table[1]) < 1e-6, s.code);
  }
  // Perseids drift about +1.3° in RA per day near maximum (Table 6: 45° Aug 10 → 51° Aug 15).
  const per = byCode("PER"), early = per.radiantAt(per.maxLongitude - 2.95), late = per.radiantAt(per.maxLongitude + 1.95);
  assert.ok(diff(late[0], early[0]) > 5 && diff(late[0], early[0]) < 7);

  const instant = "2026-08-12T17:30:00Z", active = activeShowers({ ...site, instant }).find((a) => a.shower.code === "PER");
  const [ra0, dec0] = active.radiant.map((v) => v * rad);
  const jd = Date.parse(instant) / 86400000 + 2440587.5, t = (jd - 2451545) / 36525, arcsec = rad / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t) * arcsec, z = (2306.2181 * t + 1.09468 * t * t) * arcsec, theta = (2004.3109 * t - 0.42665 * t * t) * arcsec;
  const A = Math.cos(dec0) * Math.sin(ra0 + zeta), B = Math.cos(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) - Math.sin(theta) * Math.sin(dec0);
  const ra = Math.atan2(A, B) + z, dec = Math.asin(Math.sin(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) + Math.cos(theta) * Math.sin(dec0));
  const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t) * rad;
  const hour = gmst + site.longitude * rad - ra, lat = site.latitude * rad;
  const altitude = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hour));
  const azimuth = Math.atan2(-Math.cos(dec) * Math.sin(hour), Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hour));
  const expected = direction(azimuth / rad, altitude / rad);
  const error = Math.acos(Math.min(1, expected.reduce((sum, v, i) => sum + v * active.point.direction[i], 0))) / rad;
  assert.ok(error < 0.05, `radiant direction differs by ${error}°`);
});

test("天空亮度：满月附近亮 3—4 等、光污染叠加；相机极限星等每亮 10 倍减 1.25 等", () => {
  const zenith = [0, 0, 1];
  assert.ok(Math.abs(skyBrightness(zenith, null) - meteorModel.naturalMcd) < 1e-12);
  assert.ok(Math.abs(skyBrightness(zenith, null, 6.5) - meteorModel.naturalMcd - 6.5) < 1e-12);
  const mag = (mcd) => (20.7233 - Math.log(mcd / 3.1831e-3 / 34.08)) / 0.92104;
  const full = { direction: direction(0, 60), illuminatedFraction: 1 };
  // 60° from a full Moon at 60° elevation, sky at 60° elevation: about 18.4 mag/arcsec² (dark ≈ 21.9).
  const lit = skyBrightness(direction(120, 60), full);
  assert.ok(mag(lit) > 17.8 && mag(lit) < 19, `${mag(lit)}`);
  assert.ok(skyBrightness(direction(10, 60), full) > lit, "brighter near the Moon");
  assert.ok(skyBrightness(direction(120, 60), { ...full, illuminatedFraction: 0.5 }) < lit / 5, "a quarter Moon is far fainter");
  assert.equal(skyBrightness(direction(120, 60), { ...full, direction: direction(0, -5) }), skyBrightness(direction(120, 60), null));
  assert.equal(cameraLimitFor(meteorModel.naturalMcd), meteorModel.cameraLimit);
  assert.ok(Math.abs(cameraLimitFor(meteorModel.naturalMcd * 10) - (meteorModel.cameraLimit - 1.25)) < 1e-12);
});

test("整晚：拍摄时刻所在的地方平太阳时正午到次日正午，凌晨仍属前一晚；暗夜两端与天文昏影/晨光相差不超过半个步长", () => {
  const noon = Date.UTC(2026, 7, 12, 12) - (site.longitude / 15) * 3600000;
  // 19:00, 00:30 and 11:00 Japan time (local mean time 9 h 15 m ahead of UTC) all belong to the night of Aug 12.
  for (const instant of ["2026-08-12T10:00:00Z", "2026-08-12T15:30:00Z", "2026-08-13T02:00:00Z"])
    assert.deepEqual(meteorNight({ ...site, instant }), { from: noon, to: noon + 86400000 }, instant);
  assert.equal(meteorNight({ ...site, instant: "2026-08-13T03:00:00Z" }).from, noon + 86400000, "after local noon: the next night");
  const estimate = meteorEstimate({ ...site, ...lens, instant: "2026-08-12T15:30:00Z", azimuth: 45, pitch: 35 });
  assert.deepEqual(estimate.night, meteorNight({ ...site, instant: "2026-08-12T15:30:00Z" }));
  const event = (instant, id) => Date.parse(dayEvents({ ...site, instant, timeZone: "Asia/Tokyo", refraction: "standard" }).find((e) => e.id === id).instant);
  const dusk = event("2026-08-12T10:00:00Z", "dusk"), dawn = event("2026-08-13T00:00:00Z", "dawn");
  assert.ok(Math.abs(estimate.dark.from - dusk) <= 300000 && Math.abs(estimate.dark.to - dawn) <= 300000,
    `${(estimate.dark.from - dusk) / 60000} / ${(estimate.dark.to - dawn) / 60000} min`);
  assert.ok(Math.abs(estimate.darkHours - (estimate.dark.to - estimate.dark.from) / 3600000) < 1e-9, "one continuous dark stretch");
});

test("估算：英仙座极大夜整晚 14 mm 数十颗；月光、光污染、低空消光会减少，无暗夜与辐射点不升起时不计", () => {
  const night = { ...site, ...lens, instant: "2026-08-12T15:00:00Z", azimuth: 45, pitch: 35 };
  const dark = meteorEstimate(night);
  assert.ok(dark.expected > 20 && dark.expected < 150, `${dark.expected}`);
  assert.equal(dark.byShower[0].code, "PER");
  assert.ok(meteorEstimate(night, 6.5).expected < dark.expected * 0.4, "suburban light pollution");
  // Same azimuth, lower aim: the band near the horizon loses to extinction.
  assert.ok(meteorEstimate({ ...night, pitch: 5, focalLength: 50 }).expected < meteorEstimate({ ...night, pitch: 40, focalLength: 50 }).expected);
  // Helsinki at midsummer: the Sun never sinks to −18°.
  const white = meteorEstimate({ latitude: 60.17, longitude: 24.94, ...lens, instant: "2026-06-21T22:00:00Z", azimuth: 0, pitch: 20 });
  assert.deepEqual([white.dark, white.darkHours, white.expected], [null, 0, 0]);
  // Ursids from Sydney: active, but the radiant never rises.
  const sydney = { latitude: -33.87, longitude: 151.21, ...lens, instant: "2026-12-22T13:00:00Z", azimuth: 0, pitch: 20 };
  assert.ok(activeShowers(sydney).some((a) => a.shower.code === "URS"));
  const south = meteorEstimate(sydney);
  assert.ok(south.darkHours > 3);
  assert.equal(south.byShower.find((item) => item.code === "URS"), undefined);
  // Moonlight: the antihelion source keeps ZHR 4 all spring; full Moon 2026-03-03 against new Moon 03-19.
  const spring = { ...night, azimuth: 180, pitch: 40 };
  const full = meteorEstimate({ ...spring, instant: "2026-03-03T14:00:00Z" }), dark2 = meteorEstimate({ ...spring, instant: "2026-03-19T14:00:00Z" });
  assert.deepEqual([full.byShower.map((x) => x.code), dark2.byShower.map((x) => x.code)], [["ANT"], ["ANT"]]);
  assert.ok(full.expected < dark2.expected * 0.5, `${full.expected} vs ${dark2.expected}`);
});

// Independent horizontal direction of a J2000 position: IAU 1976 precession and GMST (nutation ignored).
function horizontalOf(ra0, dec0, instant) {
  const jd = Date.parse(instant) / 86400000 + 2440587.5, t = (jd - 2451545) / 36525, arcsec = rad / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t) * arcsec, z = (2306.2181 * t + 1.09468 * t * t) * arcsec, theta = (2004.3109 * t - 0.42665 * t * t) * arcsec;
  const A = Math.cos(dec0) * Math.sin(ra0 + zeta), B = Math.cos(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) - Math.sin(theta) * Math.sin(dec0);
  const ra = Math.atan2(A, B) + z, dec = Math.asin(Math.sin(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) + Math.cos(theta) * Math.sin(dec0));
  const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t) * rad;
  const hour = gmst + site.longitude * rad - ra, lat = site.latitude * rad;
  const altitude = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hour));
  const azimuth = Math.atan2(-Math.cos(dec) * Math.sin(hour), Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hour));
  return direction(azimuth / rad, altitude / rad);
}
const angle = (u, v) => Math.acos(Math.min(1, u.reduce((s, x, i) => s + x * v[i], 0)));
const stepMiddle = (time) => new Date(Math.floor(time / 600000) * 600000 + 300000);

test("星空对齐：把某一时刻的地平方向转到拍摄时刻同一颗星的位置，与独立岁差/恒星时公式相差不到 0.05°", () => {
  const anchor = "2026-12-13T11:00:00Z";
  for (const [ra, dec] of [[279.23, 38.78], [113.65, 28.03], [37.95, 89.26], [88.79, 7.41]])
    for (const hours of [-3, 0.5, 4, 11.5]) {
      const later = new Date(Date.parse(anchor) + hours * 3600000);
      const moved = skyAlignment({ ...site, instant: anchor }, later)(horizontalOf(ra * rad, dec * rad, later.toISOString()));
      const error = angle(moved, horizontalOf(ra * rad, dec * rad, anchor)) / rad;
      assert.ok(error < 0.05, `${ra}/${dec} after ${hours} h: ${error}°`);
    }
});

test("示意流星：整晚固定机位拍到的部分对齐到拍摄时刻星空，全部从拍摄时刻的辐射点发散，数量落在估算的泊松范围内", () => {
  const plan = { ...site, ...lens, instant: "2026-08-12T15:00:00Z", azimuth: 45, pitch: 35 };
  const a = meteorSample(plan), b = meteorSample({ ...plan });
  assert.deepEqual(a, b);
  // Meteors of the whole dark night, before and after the shooting instant.
  const { dark } = meteorEstimate(plan), anchorTime = Date.parse(plan.instant);
  assert.ok(a.streaks.every((s) => s.time >= dark.from && s.time < dark.to));
  assert.ok(a.streaks.some((s) => s.time < anchorTime - 3600000) && a.streaks.some((s) => s.time > anchorTime + 3600000));
  // Moving the shooting time by a minute keeps the night and turns the whole stack with the sky.
  const shifted = meteorSample({ ...plan, instant: "2026-08-12T15:01:00Z" });
  const byId = (sample) => new Map(sample.streaks.map((x) => [`${x.code}|${x.time}`, x]));
  const before = byId(a), after = byId(shifted), shared = [...before.keys()].filter((id) => after.has(id));
  assert.ok(shared.length >= 0.95 * Math.min(before.size, after.size), `${shared.length} of ${before.size}/${after.size}`);
  const turn = skyAlignment({ ...plan, instant: "2026-08-12T15:01:00Z" }, new Date(plan.instant));
  for (const id of shared.filter((id) => before.get(id).along[0] === 0 && after.get(id).along[0] === 0))
    assert.ok(angle(turn(before.get(id).start), after.get(id).start) < 1e-6, id);

  // Whole meteors scatter around the estimate; every kept part lies in the frame above the horizon.
  const geminids = { ...plan, instant: "2026-12-13T11:00:00Z" };
  for (const [view, sample] of [[plan, a], [geminids, meteorSample(geminids)]]) {
    const expected = meteorEstimate(view).expected, whole = sample.streaks.filter((s) => s.along[0] === 0).length;
    assert.ok(Math.abs(whole - expected) < 4 * Math.sqrt(expected), `${whole} vs ${expected}`);
    for (const s of sample.streaks)
      for (const ray of [s.start, s.end]) {
        const p = projectDirection(view, ray);
        assert.ok(p && Math.abs(p.x) <= 1 + 1e-9 && Math.abs(p.y) <= 1 + 1e-9 && ray[2] >= -1e-9);
      }
  }

  const g = meteorSample(geminids), anchor = activeShowers(geminids).find((x) => x.shower.code === "GEM").point.direction;
  const gem = g.streaks.filter((x) => x.code === "GEM");
  assert.ok(gem.length > 30 && gem.some((s) => s.time > Date.parse(geminids.instant) + 6 * 3600000), "late meteors of the night are kept");
  for (const s of gem) {
    // Back to the sky of its own step: the recorded part was inside the fixed frame.
    const back = skyAlignment({ ...geminids, instant: stepMiddle(s.time).toISOString() }, new Date(geminids.instant));
    for (const ray of [back(s.start), back(s.end)]) {
      const p = projectDirection(geminids, ray);
      assert.ok(p && Math.abs(p.x) <= 1 + 1e-9 && Math.abs(p.y) <= 1 + 1e-9, "recorded by the fixed camera");
    }
    assert.ok(s.along[0] >= 0 && s.along[0] < s.along[1] && s.along[1] <= 1 + 1e-9);
    assert.ok(angle(s.end, anchor) > angle(s.start, anchor), "moves away from the radiant of the shooting instant");
    // On a great circle through that radiant; only its drift during the night (about 1° a day) remains.
    const n = [s.start[1] * s.end[2] - s.start[2] * s.end[1], s.start[2] * s.end[0] - s.start[0] * s.end[2], s.start[0] * s.end[1] - s.start[1] * s.end[0]];
    assert.ok(Math.abs(n.reduce((sum, x, i) => sum + x * anchor[i], 0)) / Math.hypot(...n) < Math.sin(0.4 * rad));
  }
  assert.equal(a.thinning, 1);
});

test("对齐叠加：画面越窄，越快离开锚点星空，只留下拍摄时刻前后的流星", () => {
  // Geminid maximum, shooting instant 02:00, aimed at the radiant; the dark night runs from about 18:00 to 05:10.
  const plan = { ...site, ...lens, instant: "2026-12-13T17:00:00Z" };
  const radiant = activeShowers(plan).find((a) => a.shower.code === "GEM").point;
  const spread = (focalLength) => {
    const view = { ...plan, focalLength, azimuth: radiant.azimuth, pitch: radiant.elevation };
    const hours = meteorSample(view).streaks.map((s) => Math.abs(s.time - Date.parse(plan.instant)) / 3600000);
    return { count: hours.length, farthest: Math.max(...hours), expected: meteorEstimate(view).expected };
  };
  const wide = spread(14), normal = spread(35), tele = spread(135);
  assert.ok(wide.farthest > 5, `${wide.farthest} h`);
  assert.ok(normal.count > 5 && normal.farthest < 4, `${normal.count} / ${normal.farthest} h`);
  assert.ok(wide.expected > normal.expected && normal.expected > tele.expected && tele.expected < 2, `${wide.expected} / ${normal.expected} / ${tele.expected}`);
});
