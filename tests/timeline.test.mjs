import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import {
  fixedRiseSet,
  instantAtWindowMinute,
  neighbourEvent,
  sunElevationAcross,
  timelineEvents,
  timelineMode,
  timelineWindow,
  visiblePasses,
  windowMinute,
} from "../src/domain/timeline.ts";
import { dayEvents, limbAltitude } from "../src/domain/day-events.ts";
import { localTimeZone } from "../src/domain/zone-lookup.ts";
import { stationPosition } from "../src/domain/stations.ts";
import { sunPosition } from "../src/domain/ephemeris.ts";
import { initialPlan } from "../src/domain/plan.ts";

const orbits = JSON.parse(readFileSync(new URL("../public/orbits/stations.json", import.meta.url), "utf8"));
const comets = JSON.parse(readFileSync(new URL("../public/comets/catalog.json", import.meta.url), "utf8"));
const noLayers = { sun: false, moon: false, stars: false, milkyWay: false, constellations: false, deepSky: false, stations: false, meteors: false, comets: false };
const plan = (latitude, longitude, layers) => ({ latitude, longitude, refraction: "standard", cameraHeight: 1.6, layers: { ...noLayers, ...layers } });
const rad = Math.PI / 180;

test("时间轴范围：白天为当地日期 0—24 时，夜空类图层开启时为中午到次日中午，凌晨属前一晚", () => {
  assert.equal(timelineMode(noLayers), "day");
  for (const key of ["stars", "milkyWay", "deepSky", "meteors", "comets"]) assert.equal(timelineMode({ ...noLayers, [key]: true }), "night", key);
  assert.equal(timelineMode({ ...noLayers, sun: true, moon: true, stations: true }), "day");
  const day = timelineWindow("2026-11-04T08:00:00Z", "Asia/Tokyo", "day");
  assert.deepEqual(day, { mode: "day", date: "2026-11-04", startHour: 0, start: "2026-11-03T15:00:00Z", end: "2026-11-04T15:00:00Z" });
  const evening = timelineWindow("2026-11-04T08:00:00Z", "Asia/Tokyo", "night");
  assert.deepEqual(evening, { mode: "night", date: "2026-11-04", startHour: 12, start: "2026-11-04T03:00:00Z", end: "2026-11-05T03:00:00Z" });
  // 02:30 on the 5th belongs to the night of the 4th; noon starts the next night.
  assert.equal(timelineWindow("2026-11-04T17:30:00Z", "Asia/Tokyo", "night").date, "2026-11-04");
  assert.equal(timelineWindow("2026-11-05T03:00:00Z", "Asia/Tokyo", "night").date, "2026-11-05");
  assert.equal(windowMinute("2026-11-04T17:30:00Z", evening, "Asia/Tokyo"), 870);
  assert.equal(instantAtWindowMinute(evening, 870, "Asia/Tokyo"), "2026-11-04T17:30:00Z");
  for (const minute of [0, 1, 359, 720, 1200, 1439])
    assert.equal(windowMinute(instantAtWindowMinute(evening, minute, "Asia/Tokyo"), evening, "Asia/Tokyo"), minute);
  assert.throws(() => instantAtWindowMinute(evening, 1440, "Asia/Tokyo"));
  assert.throws(() => instantAtWindowMinute(evening, 1.5, "Asia/Tokyo"));
});

test("夜间时间轴跨夏令时按墙上钟点计分钟，跳过的钟点拒绝，色带覆盖整段", () => {
  // New York springs forward at 02:00 on 8 March 2026: the night of the 7th is 23 hours long.
  const night = timelineWindow("2026-03-08T03:00:00Z", "America/New_York", "night");
  assert.equal(night.date, "2026-03-07");
  assert.equal(Date.parse(night.end) - Date.parse(night.start), 23 * 3_600_000);
  assert.throws(() => instantAtWindowMinute(night, 14 * 60 + 30, "America/New_York"), "02:30 does not exist");
  assert.equal(instantAtWindowMinute(night, 15 * 60, "America/New_York"), "2026-03-08T07:00:00Z");
  assert.equal(windowMinute("2026-03-08T07:00:00Z", night, "America/New_York"), 15 * 60);
  const band = sunElevationAcross({ latitude: 40.71, longitude: -74 }, night, "America/New_York");
  assert.equal(band.length, 145);
  assert.ok(band[0].elevation > 0 && band[72].elevation < -18, "noon to midnight");
});

test("日月与暗夜事件在白天轴上与原当地日期计算一致，只出现已开启图层的事件", () => {
  const instant = "2026-11-04T08:00:00Z";
  const day = timelineWindow(instant, "Asia/Tokyo", "day");
  const original = Object.fromEntries(dayEvents({ ...initialPlan, instant }).map((event) => [event.id, event.instant]));
  const sun = timelineEvents(plan(35.4172, 138.8729, { sun: true }), day);
  assert.deepEqual(sun.events.map((event) => event.kind), ["sunrise", "sunset"]);
  for (const event of sun.events) assert.equal(event.instant, original[event.kind]);
  const both = timelineEvents(plan(35.4172, 138.8729, { sun: true, moon: true }), day);
  assert.deepEqual(both.events.map((event) => event.kind), ["moonrise", "sunrise", "moonset", "sunset"]);
  assert.deepEqual(timelineEvents(plan(35.4172, 138.8729, {}), day), { events: [], missing: [] });
  const night = timelineWindow(instant, "Asia/Tokyo", "night");
  const stars = timelineEvents(plan(35.4172, 138.8729, { stars: true }), night);
  assert.deepEqual(stars.events.map((event) => event.kind), ["dusk", "dawn"]);
  assert.ok(Date.parse(stars.events[0].instant) < Date.parse(stars.events[1].instant));
});

test("极夜的时段内没有日出日落时列入“本时段无”", () => {
  const window = timelineWindow("2026-12-15T11:00:00Z", "Arctic/Longyearbyen", "day");
  const result = timelineEvents(plan(78.22, 15.65, { sun: true }), window);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.missing, ["日出", "日落"]);
});

/**
 * Independent reference for a fixed J2000 direction: Meeus precession,
 * IAU 1982 mean sidereal time and spherical altitude, sampled every 15 s.
 */
function referenceCrossings(raHours, decDegrees, latitude, longitude, start, end, horizon) {
  const altitudeAt = (time) => {
    const jd = time / 86_400_000 + 2440587.5, t = (jd - 2451545) / 36525;
    const zeta = (2306.2181 * t + 0.30188 * t * t) / 3600 * rad;
    const z = (2306.2181 * t + 1.09468 * t * t) / 3600 * rad;
    const theta = (2004.3109 * t - 0.42665 * t * t) / 3600 * rad;
    const a0 = raHours * 15 * rad, d0 = decDegrees * rad;
    const A = Math.cos(d0) * Math.sin(a0 + zeta);
    const B = Math.cos(theta) * Math.cos(d0) * Math.cos(a0 + zeta) - Math.sin(theta) * Math.sin(d0);
    const C = Math.sin(theta) * Math.cos(d0) * Math.cos(a0 + zeta) + Math.cos(theta) * Math.sin(d0);
    const ra = Math.atan2(A, B) + z, dec = Math.asin(C);
    const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t) * rad;
    const hour = gmst + longitude * rad - ra;
    return Math.asin(Math.sin(latitude * rad) * Math.sin(dec) + Math.cos(latitude * rad) * Math.cos(dec) * Math.cos(hour)) / rad;
  };
  const found = [];
  let previous = altitudeAt(start) - horizon;
  for (let time = start + 15_000; time <= end; time += 15_000) {
    const current = altitudeAt(time) - horizon;
    if (previous < 0 !== current < 0) found.push({ direction: current > previous ? 1 : -1, time });
    previous = current;
  }
  return found;
}

test("银心出没与独立岁差、恒星时逐 15 秒采样相差不超过 1 分钟，并随折射模式改变", () => {
  const ra = 17 + 45 / 60 + 40.034047 / 3600, dec = -29 - 28.21601 / 3600;
  for (const [latitude, longitude, zone, instant] of [
    [35.4172, 138.8729, "Asia/Tokyo", "2026-11-04T08:00:00Z"],
    [-33.86, 151.21, "Australia/Sydney", "2026-06-15T08:00:00Z"],
    [40.71, -74, "America/New_York", "2026-07-20T03:00:00Z"],
  ]) {
    const window = timelineWindow(instant, zone, "night");
    for (const refraction of ["standard", "none"]) {
      const subject = { ...plan(latitude, longitude, { milkyWay: true }), refraction };
      const found = fixedRiseSet(subject, window, ra, dec);
      const reference = referenceCrossings(ra, dec, latitude, longitude, Date.parse(window.start), Date.parse(window.end), limbAltitude(0, refraction));
      assert.equal(found.length, reference.length, `${zone} ${refraction}`);
      found.forEach((event, index) => {
        assert.equal(event.direction, reference[index].direction);
        assert.ok(Math.abs(event.time - reference[index].time) <= 60_000, `${zone} ${refraction} ${new Date(event.time).toISOString()}`);
      });
      const events = timelineEvents(subject, window).events.filter((event) => event.kind.startsWith("core"));
      assert.equal(events.length, found.length);
    }
    const standard = fixedRiseSet(plan(latitude, longitude, {}), window, ra, dec)[0];
    const geometric = fixedRiseSet({ ...plan(latitude, longitude, {}), refraction: "none" }, window, ra, dec)[0];
    if (standard && geometric) assert.notEqual(standard.time, geometric.time);
  }
});

test("流星雨取时段中点 ZHR 最高的活动流星雨辐射点；拱极或没有活动流星雨时分别说明", () => {
  const perseids = timelineWindow("2026-08-12T12:00:00Z", "Asia/Singapore", "night");
  const result = timelineEvents(plan(1.35, 103.82, { meteors: true }), perseids);
  const radiant = result.events.filter((event) => event.kind.startsWith("radiant"));
  assert.deepEqual(radiant.map((event) => event.kind).sort(), ["radiant-rise", "radiant-set"]);
  assert.ok(radiant.every((event) => event.detail.startsWith("英仙座")), radiant.map((event) => event.detail).join());
  // From Tokyo the Perseid radiant (Dec ≈ +58°) never sets.
  const tokyo = timelineEvents(plan(35.68, 139.76, { meteors: true }), timelineWindow("2026-08-12T12:00:00Z", "Asia/Tokyo", "night"));
  assert.equal(tokyo.events.some((event) => event.kind.startsWith("radiant")), false);
  assert.ok(tokyo.missing.some((item) => item.startsWith("英仙座") && item.endsWith("（全程在地平线上）")), tokyo.missing.join());
  // The Milky Way core never rises from Svalbard.
  const north = timelineEvents(plan(78.22, 15.65, { milkyWay: true }), timelineWindow("2026-12-15T11:00:00Z", "Arctic/Longyearbyen", "night"));
  assert.ok(north.missing.includes("银心升落（全程在地平线下）"), north.missing.join());
  const quiet = timelineEvents(plan(35.68, 139.76, { meteors: true }), timelineWindow("2026-03-01T12:00:00Z", "Asia/Tokyo", "night"));
  if (!quiet.events.some((event) => event.kind.startsWith("radiant"))) assert.ok(quiet.missing.some((item) => /流星雨|辐射点/.test(item)));
});

test("彗星取时段中点最亮的列表彗星，按中点位置近似出没；目录未读取时不推断", () => {
  const window = timelineWindow("2024-10-15T12:00:00Z", "Asia/Tokyo", "night");
  const subject = plan(35.68, 139.76, { comets: true });
  const result = timelineEvents(subject, window, { comets });
  const events = result.events.filter((event) => event.kind.startsWith("comet"));
  assert.deepEqual(events.map((event) => event.kind), ["comet-set", "comet-rise"]);
  assert.ok(events.every((event) => event.detail.startsWith("紫金山-阿特拉斯彗星") && /近似/.test(event.detail)));
  // Evening comet that week: it sets after dusk begins and rises after dawn.
  const dusk = result.events.find((event) => event.kind === "dusk");
  assert.ok(Math.abs(Date.parse(events[0].instant) - Date.parse(dusk.instant)) < 3 * 3_600_000);
  const unknown = timelineEvents(subject, window);
  assert.equal(unknown.events.some((event) => event.kind.startsWith("comet")), false);
  assert.equal(unknown.missing.length, 0);
});

test("空间站可见过境满足高于 10°、受照、太阳低于 −6°，轨道数据不覆盖时单独说明", () => {
  const subject = plan(31.23, 121.47, { stations: true });
  const window = timelineWindow("2026-11-09T12:00:00Z", "Asia/Shanghai", "night");
  const { passes, covered } = visiblePasses(subject, window, orbits);
  assert.equal(covered, true);
  assert.ok(passes.length >= 2);
  for (const pass of passes) {
    const element = orbits.objects.find((entry) => entry.NORAD_CAT_ID === pass.station.noradId);
    for (const time of [pass.from, pass.to]) {
      const point = stationPosition({ ...initialPlan, latitude: 31.23, longitude: 121.47, instant: new Date(time).toISOString() }, element);
      assert.ok(point.elevation >= 10 && point.shadow < 1, `${pass.station.name} ${new Date(time).toISOString()}`);
      assert.ok(sunPosition({ latitude: 31.23, longitude: 121.47, instant: new Date(time).toISOString() }).elevation < -5.9);
    }
    assert.ok(pass.peak >= 10 && pass.to >= pass.from);
  }
  const events = timelineEvents(subject, window, { orbits }).events;
  assert.deepEqual(events.map((event) => event.kind), passes.map(() => "station-pass"));
  assert.ok(events.every((event) => /^(ISS|天宫)$/.test(event.label) && /可见过境/.test(event.detail)));
  const stale = timelineEvents(subject, timelineWindow("2026-10-01T12:00:00Z", "Asia/Shanghai", "night"), { orbits });
  assert.deepEqual(stale.events, []);
  assert.deepEqual(stale.missing, ["空间站过境（轨道数据不覆盖本时段）"]);
  assert.deepEqual(timelineEvents(subject, window).missing, [], "orbits not loaded: nothing is claimed");
});

test("上一/下一事件严格早于或晚于当前时刻，时刻本身的事件不算", () => {
  const events = ["2026-11-04T06:00:00Z", "2026-11-04T08:00:00Z", "2026-11-04T10:00:00Z"].map((instant, index) => ({
    key: String(index), kind: "sunrise", label: String(index), instant, detail: "",
  }));
  assert.equal(neighbourEvent(events, "2026-11-04T08:00:00Z", 1).instant, "2026-11-04T10:00:00Z");
  assert.equal(neighbourEvent(events, "2026-11-04T08:00:00Z", -1).instant, "2026-11-04T06:00:00Z");
  assert.equal(neighbourEvent(events, "2026-11-04T10:00:00Z", 1), null);
  assert.equal(neighbourEvent(events, "2026-11-04T05:00:00Z", -1), null);
});

test("当地时区按坐标查询 IANA 时区，经度回绕，坐标无效时返回 null", () => {
  assert.equal(localTimeZone(35.4172, 138.8729), "Asia/Tokyo");
  assert.equal(localTimeZone(31.23, 121.47), "Asia/Shanghai");
  assert.equal(localTimeZone(48.8584, 2.2945), "Europe/Paris");
  assert.equal(localTimeZone(40.71, -74), "America/New_York");
  assert.equal(localTimeZone(-33.86, 151.21), "Australia/Sydney");
  // Documented limitation: Xinjiang resolves to Urumqi (UTC+6), not Beijing time.
  assert.equal(localTimeZone(39.47, 75.99), "Asia/Urumqi");
  assert.equal(localTimeZone(40.71, 286), localTimeZone(40.71, -74));
  assert.equal(localTimeZone(91, 0), null);
  assert.equal(localTimeZone(Number.NaN, 0), null);
  const zone = localTimeZone(0, -150);
  assert.ok(zone && Temporal.Instant.from("2026-01-01T00:00:00Z").toZonedDateTimeISO(zone));
});
