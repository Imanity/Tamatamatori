import test from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { dayEvents, localDay, sunElevationByMinute } from "../../src/domain/time/day-events.ts";
import { celestialBodies } from "../../src/domain/core/ephemeris.ts";
import { apparentElevation } from "../../src/domain/core/refraction.ts";
import { instantFromLocal } from "../../src/domain/core/plan.ts";

const rad = Math.PI / 180;
const byId = (events) => Object.fromEntries(events.map((event) => [event.id, event.instant]));
const minutesBetween = (a, b) => Math.abs(Temporal.Instant.from(a).epochMilliseconds - Temporal.Instant.from(b).epochMilliseconds) / 60000;

/**
 * Independent reference: NOAA "General Solar Position Calculations" (fractional
 * year series for declination and equation of time, zenith 90.833° for rise and
 * set). Accurate to about a minute at mid latitudes; iterated on the event time.
 */
function noaa(latitude, longitude, guess, rising, zenith = 90.833) {
  let time = Temporal.Instant.from(guess).epochMilliseconds;
  for (let pass = 0; pass < 3; pass++) {
    const utc = new Date(time), year = utc.getUTCFullYear();
    const startOfYear = Date.UTC(year, 0, 1), days = (Date.UTC(year + 1, 0, 1) - startOfYear) / 86400000;
    const dayOfYear = Math.floor((time - startOfYear) / 86400000) + 1, hour = utc.getUTCHours() + utc.getUTCMinutes() / 60;
    const g = ((2 * Math.PI) / days) * (dayOfYear - 1 + (hour - 12) / 24);
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const cosHa = Math.cos(zenith * rad) / (Math.cos(latitude * rad) * Math.cos(decl)) - Math.tan(latitude * rad) * Math.tan(decl);
    const ha = Math.acos(cosHa) / rad;
    const minutes = 720 - 4 * (longitude + (rising ? ha : -ha)) - eqtime;
    const midnight = Date.UTC(year, utc.getUTCMonth(), utc.getUTCDate());
    // Pick the solution nearest the current estimate (the event may fall on the neighbouring UTC date).
    time = [-1, 0, 1].map((shift) => midnight + shift * 86400000 + minutes * 60000).sort((a, b) => Math.abs(a - time) - Math.abs(b - time))[0];
  }
  return Temporal.Instant.fromEpochMilliseconds(Math.round(time)).toString();
}

const sites = [
  { name: "东京", latitude: 35.6812, longitude: 139.7671, timeZone: "Asia/Tokyo", date: "2026-11-04" },
  { name: "巴黎夏至（夏令时、白夜）", latitude: 48.8566, longitude: 2.3522, timeZone: "Europe/Paris", date: "2026-06-21", whiteNight: true },
  { name: "悉尼夏季", latitude: -33.8688, longitude: 151.2093, timeZone: "Australia/Sydney", date: "2026-12-21" },
  { name: "开普敦冬季", latitude: -33.9249, longitude: 18.4241, timeZone: "Africa/Johannesburg", date: "2026-06-21" },
];

test("日出、日落与天文晨昏同独立 NOAA 算法相差不超过 2 分钟，白夜无天文晨昏", () => {
  for (const site of sites) {
    const noon = instantFromLocal(`${site.date}T12:00`, site.timeZone);
    const events = byId(dayEvents({ ...site, instant: noon, refraction: "standard" }));
    const checks = [
      ["sunrise", "06:00", true, 90.833],
      ["sunset", "18:00", false, 90.833],
      ["dawn", "04:00", true, 108],
      ["dusk", "20:00", false, 108],
    ];
    if (site.whiteNight) {
      // The Sun stays above −18° all night (minimum about −17.7°): no astronomical dawn or dusk.
      assert.equal(events.dawn, null);
      assert.equal(events.dusk, null);
      checks.splice(2);
    }
    for (const [id, guess, rising, zenith] of checks) {
      const reference = noaa(site.latitude, site.longitude, instantFromLocal(`${site.date}T${guess}`, site.timeZone), rising, zenith);
      assert.ok(events[id], `${site.name} ${id}`);
      assert.ok(minutesBetween(events[id], reference) <= 2, `${site.name} ${id}: ${events[id]} vs NOAA ${reference}`);
    }
  }
});

test("跳转时刻与预览中的日月一致：上缘在所选折射模式下位于海平面地平，晨昏为太阳中心 −18°", () => {
  for (const site of sites) {
    for (const refraction of ["standard", "none"]) {
      const instant = instantFromLocal(`${site.date}T12:00`, site.timeZone);
      for (const event of dayEvents({ ...site, instant, refraction })) {
        if (!event.instant) continue;
        const bodies = celestialBodies({ latitude: site.latitude, longitude: site.longitude, instant: event.instant });
        if (event.id === "dawn" || event.id === "dusk") {
          // Rounded to the second: the Sun moves well under 0.01° per second.
          assert.ok(Math.abs(bodies.sun.elevation + 18) < 0.01, `${site.name} ${event.id} ${bodies.sun.elevation}`);
          continue;
        }
        const body = event.id.startsWith("sun") ? bodies.sun : bodies.moon;
        const limb = apparentElevation(body.elevation, refraction) + body.angularRadius;
        // Solved with the preview's refraction and the radius at the event; rounding to the second leaves < 0.005°.
        assert.ok(Math.abs(limb) < 0.005, `${site.name} ${refraction} ${event.id} limb ${limb}`);
        assert.match(event.definition, refraction === "standard" ? /标准折射/ : /无折射/);
        assert.match(event.definition, /不含地形遮挡/);
      }
    }
  }
});

test("事件只取所选当地日期：极夜与极昼无日出日落，夏令时切换日为 23 小时", () => {
  const tromso = { latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo", refraction: "standard" };
  const winter = byId(dayEvents({ ...tromso, instant: "2026-12-15T11:00:00Z" }));
  assert.equal(winter.sunrise, null);
  assert.equal(winter.sunset, null);
  assert.ok(winter.dawn && winter.dusk, "astronomical twilight still happens at noon in polar night");
  const summer = byId(dayEvents({ ...tromso, instant: "2026-06-21T11:00:00Z" }));
  for (const id of ["dawn", "sunrise", "sunset", "dusk"]) assert.equal(summer[id], null, id);

  const newYork = { latitude: 40.7128, longitude: -74.006, timeZone: "America/New_York", refraction: "standard" };
  const day = localDay("2026-03-08T16:00:00Z", newYork.timeZone);
  assert.equal(day.date.toString(), "2026-03-08");
  assert.equal((day.end.epochMilliseconds - day.start.epochMilliseconds) / 3600000, 23);
  for (const [id, instant] of Object.entries(byId(dayEvents({ ...newYork, instant: "2026-03-08T16:00:00Z" })))) {
    if (!instant) continue;
    const local = Temporal.Instant.from(instant).toZonedDateTimeISO(newYork.timeZone).toPlainDate().toString();
    assert.equal(local, "2026-03-08", `${id} stays on the local date`);
    assert.equal(Temporal.Instant.from(instant).epochMilliseconds % 1000, 0, `${id} rounded to the second`);
  }
});

test("滑杆色带按当地钟点采样太阳高度：午夜低、正午高，覆盖 00:00—24:00", () => {
  const samples = sunElevationByMinute({ latitude: 35.6812, longitude: 139.7671, timeZone: "Asia/Tokyo", instant: "2026-11-04T03:00:00Z" });
  assert.equal(samples.length, 145);
  assert.equal(samples[0].minute, 0);
  assert.equal(samples.at(-1).minute, 1440);
  const noon = samples.find((sample) => sample.minute === 690); // 11:30, near Tokyo solar noon in November
  assert.ok(noon.elevation > 35 && samples[0].elevation < -50, `${noon.elevation} ${samples[0].elevation}`);
  // A DST day still maps every wall-clock sample; skipped minutes resolve forward.
  const dst = sunElevationByMinute({ latitude: 40.7128, longitude: -74.006, timeZone: "America/New_York", instant: "2026-03-08T16:00:00Z" });
  assert.equal(dst.length, 145);
  assert.ok(dst.every((sample) => Number.isFinite(sample.elevation)));
});
