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
} from "../../src/domain/time/timeline.ts";
import { dayEvents, limbAltitude } from "../../src/domain/time/day-events.ts";
import { localTimeZone } from "../../src/domain/time/zone-lookup.ts";
import { stationPosition } from "../../src/domain/stations/stations.ts";
import { sunPosition } from "../../src/domain/core/ephemeris.ts";
import { initialPlan } from "../../src/domain/core/plan.ts";

// A fixed snapshot: CI refreshes public/orbits/stations.json before the tests, which would move these passes.
const orbits = JSON.parse(readFileSync(new URL("../fixtures/stations-timeline.json", import.meta.url), "utf8"));
const comets = JSON.parse(readFileSync(new URL("../../public/comets/catalog.json", import.meta.url), "utf8"));
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

test("黄金时刻（−4°—6°）与蓝调时刻（−6°—−4°）的起止与独立逐分钟采样相差不超过 1 分钟", async () => {
  const { lightPeriods } = await import("../../src/domain/time/timeline.ts");
  const { sunPosition } = await import("../../src/domain/core/ephemeris.ts");
  for (const [latitude, longitude, zone, instant, mode] of [
    [35.4172, 138.8729, "Asia/Tokyo", "2026-11-04T08:00:00Z", "day"],
    [35.4172, 138.8729, "Asia/Tokyo", "2026-11-04T08:00:00Z", "night"],
    [64.14, -21.9, "Atlantic/Reykjavik", "2026-06-21T12:00:00Z", "day"],
  ]) {
    const window = timelineWindow(instant, zone, mode);
    const periods = lightPeriods({ latitude, longitude }, window);
    // Reference: classify every minute by the Sun's elevation.
    const start = Date.parse(window.start), end = Date.parse(window.end), reference = [];
    let current = null;
    for (let time = start; time < end; time += 60_000) {
      const elevation = sunPosition({ latitude, longitude, instant: new Date(time).toISOString() }).elevation;
      const kind = elevation >= -4 && elevation < 6 ? "golden" : elevation >= -6 && elevation < -4 ? "blue" : null;
      if (kind !== current?.kind) {
        if (current?.kind) reference.push(current);
        current = { kind, from: time, to: time };
      }
      current.to = time + 60_000;
    }
    if (current?.kind) reference.push(current);
    assert.deepEqual(periods.map((period) => period.kind), reference.map((period) => period.kind), `${zone} ${mode}`);
    periods.forEach((period, index) => {
      assert.ok(Math.abs(Date.parse(period.from) - reference[index].from) <= 60_000, `${zone} ${period.kind} start`);
      assert.ok(Math.abs(Date.parse(period.to) - reference[index].to) <= 60_000, `${zone} ${period.kind} end`);
    });
  }
  // Reykjavik at midsummer: the Sun never drops below −4°, so no blue hour at all.
  const midsummer = lightPeriods({ latitude: 64.14, longitude: -21.9 }, timelineWindow("2026-06-21T12:00:00Z", "Atlantic/Reykjavik", "day"));
  assert.ok(midsummer.length > 0 && midsummer.every((period) => period.kind === "golden"));
  assert.deepEqual(lightPeriods({ latitude: 78.22, longitude: 15.65 }, timelineWindow("2026-12-15T11:00:00Z", "Arctic/Longyearbyen", "day")), []);
});

test("地图方位线：日月与银心此刻方位来自同一星历，出没方位来自时间轴同一时段，并随图层开关", async () => {
  const { bodyLines } = await import("../../src/domain/sun-moon/body-lines.ts");
  const { celestialBodies } = await import("../../src/domain/core/ephemeris.ts");
  const { fixedHorizontal, galacticCentre } = await import("../../src/domain/time/timeline.ts");
  const layers = { ...noLayers, sun: true, moon: true, milkyWay: true };
  const subject = { latitude: 35.4172, longitude: 138.8729, instant: "2026-11-04T08:00:00Z", timeZone: "Asia/Tokyo", refraction: "standard", layers };
  const lines = bodyLines(subject);
  const bodies = celestialBodies(subject);
  const now = (body) => lines.find((line) => line.body === body && line.kind === "now");
  assert.equal(now("sun").azimuth, bodies.sun.azimuth);
  assert.equal(now("sun").above, false, "17:00 JST, the Sun has set");
  assert.equal(now("moon").azimuth, bodies.moon.azimuth);
  assert.ok(Math.abs(now("core").azimuth - fixedHorizontal(subject, galacticCentre.ra, galacticCentre.dec, subject.instant).azimuth) < 1e-9);
  // A night layer is on: the span is noon to noon, so this sunset and the next sunrise are both drawn.
  const window = timelineWindow(subject.instant, "Asia/Tokyo", "night");
  for (const line of lines.filter((line) => line.kind !== "now")) {
    assert.ok(Date.parse(line.instant) >= Date.parse(window.start) && Date.parse(line.instant) < Date.parse(window.end), `${line.body} ${line.kind}`);
    if (line.body !== "core") assert.ok(Math.abs(line.azimuth - celestialBodies({ ...subject, instant: line.instant })[line.body].azimuth) < 1e-9);
  }
  assert.deepEqual([...new Set(lines.filter((line) => line.body === "sun").map((line) => line.kind))].sort(), ["now", "rise", "set"]);
  assert.deepEqual(bodyLines({ ...subject, layers: { ...noLayers } }), []);
  assert.deepEqual([...new Set(bodyLines({ ...subject, layers: { ...noLayers, moon: true } }).map((line) => line.body))], ["moon"]);
});

test("地图方位线标签：此刻线标天体名（地平线下注明），出没线标所选时区的时刻；同一圈 12° 内的标签合并", async () => {
  const { bodyLines, lineLabels } = await import("../../src/domain/sun-moon/body-lines.ts");
  const line = (body, kind, azimuth, instant = "2026-11-04T07:40:00Z", above = true) => ({ body, kind, azimuth, above, instant });
  const labels = lineLabels([
    line("sun", "now", 200),
    line("moon", "now", 80, undefined, false),
    line("moon", "rise", 75, "2026-11-04T09:12:30Z"),
    line("sun", "set", 245),
    line("sun", "rise", 110, "2026-11-04T21:05:00Z"),
    line("core", "rise", 118, "2026-11-05T00:41:00Z"),
    line("core", "set", 355, "2026-11-04T12:00:00Z"),
    line("moon", "set", 4, "2026-11-04T23:59:00Z"),
  ], "Asia/Tokyo");
  assert.deepEqual(labels, [
    { ring: "now", azimuth: 200, text: "太阳", body: "sun" },
    { ring: "now", azimuth: 80, text: "月亮 · 地平线下", body: "moon" },
    { ring: "event", azimuth: 75, text: "月出 18:12", body: "moon" },
    { ring: "event", azimuth: 245, text: "日落 16:40", body: "sun" },
    { ring: "event", azimuth: 110, text: "日出 06:05 · 银心升起 09:41", body: null },
    { ring: "event", azimuth: 355, text: "银心落下 21:00 · 月落 08:59", body: null },
  ]);
  // The time follows the chosen zone.
  assert.equal(lineLabels([line("sun", "set", 245)], "UTC")[0].text, "日落 07:40");
  // Real lines: each one is named once.
  const subject = { latitude: 35.4172, longitude: 138.8729, instant: "2026-11-04T08:00:00Z", timeZone: "Asia/Tokyo", refraction: "standard", layers: { ...noLayers, sun: true, moon: true, milkyWay: true } };
  const lines = bodyLines(subject);
  const named = lineLabels(lines, subject.timeZone).flatMap((label) => label.text.split(" · ").filter((part) => part !== "地平线下"));
  assert.equal(named.length, lines.length);
  assert.ok(named.includes("太阳") && named.includes("月亮") && named.includes("银心"), named.join());
});

test("时间轴的食：日食接触随太阳图层，月食接触随月亮图层；偏食月食不标半影始末，地平线下的接触写明不可见", async () => {
  const { timelineEvents: events, timelineWindow: span } = await import("../../src/domain/time/timeline.ts");
  const layers = { ...initialPlan.layers, sun: true, moon: true };
  const luxor = { latitude: 25.687, longitude: 32.64, refraction: "standard", cameraHeight: 1.6, layers };
  const day = span("2027-08-02T10:00:00Z", "UTC", "day");
  const solar = events(luxor, day).events.filter((event) => event.kind === "solar-eclipse");
  assert.deepEqual(solar.map((event) => event.label), ["初亏", "食既", "食甚", "生光", "复圆"]);
  assert.match(solar[2].detail, /^日全食食甚：太阳视高度 82°/);
  assert.deepEqual(events({ ...luxor, layers: { ...layers, sun: false } }, day).events.filter((event) => event.kind === "solar-eclipse"), []);
  const tokyo = { latitude: 35.68, longitude: 139.77, refraction: "standard", cameraHeight: 1.6, layers };
  const night = span("2028-07-06T18:00:00Z", "Asia/Tokyo", "night");
  const lunar = events(tokyo, night).events.filter((event) => event.kind === "lunar-eclipse");
  assert.deepEqual(lunar.map((event) => event.label), ["初亏", "食甚", "复圆"]);
  assert.match(lunar.at(-1).detail, /^月偏食复圆：月亮视高度 1°/);
  assert.deepEqual(events({ ...tokyo, layers: { ...layers, moon: false } }, night).events.filter((event) => event.kind === "lunar-eclipse"), []);
  // A penumbral eclipse marks only its penumbral contacts and peak.
  const penumbral = events({ ...tokyo, latitude: 40.7, longitude: -74 }, span("2027-02-20T23:00:00Z", "America/New_York", "night"))
    .events.filter((event) => event.kind === "lunar-eclipse");
  assert.deepEqual(penumbral.map((event) => event.label), ["半影始", "食甚", "半影终"]);
});
