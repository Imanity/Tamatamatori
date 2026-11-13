import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DAY, afternoon, dayStart, local, minute, nearestRange, passesOf, seasons } from "../../scripts/lib/alignment-validation.mjs";

// Recorded by scripts/alignment-validation.mjs (online: GSI elevations and DEM,
// the summit middle as seen from each place). Offline, the 找时间 solver is run
// again from the recorded marks; see docs/plan/alignment-validation.md.
const data = JSON.parse(readFileSync("tests/fixtures/alignment-validation.json", "utf8"));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const afternoonPass = (observer, mark, date, around) => passesOf(observer, mark, dayStart(date) + 12 * 3_600_000, dayStart(date) + DAY, 50)
  .reduce((a, b) => (Math.abs(Date.parse(b.instant) - around) < Math.abs(Date.parse(a.instant) - around) ? b : a));

test("实景对照·实拍：照片当天的经过时刻由记录的山顶正中重算一致；时刻差与横向偏离在验收范围内且没有系统偏差", () => {
  assert.equal(data.photos.length, 14);
  for (const photo of data.photos) {
    const shot = minute(photo.date, photo.time);
    const pass = afternoonPass(photo.observer, photo.mark, photo.date, shot);
    assert.equal(pass.instant, photo.pass.instant, `${photo.date} ${photo.label}`);
    assert.ok(Math.abs(pass.ratio - photo.pass.ratio) < 0.001, `${photo.date} ${photo.label}`);
    assert.ok(Math.abs((shot - Date.parse(pass.instant)) / 60_000 - photo.pass.minutes) < 0.01);
  }
  const minutes = data.photos.map((photo) => photo.pass.minutes);
  assert.ok(median(minutes.map(Math.abs)) <= 3, "median time difference over 3 minutes");
  assert.ok(Math.max(...minutes.map(Math.abs)) <= 5);
  assert.ok(Math.abs(minutes.reduce((sum, value) => sum + value, 0) / minutes.length) < 1, "no systematic offset in time");
  // Sideways from the alignment line at the photo minute: the place, not the clock.
  const across = data.photos.map((photo) => photo.line.across);
  assert.ok(median(across) <= 500, "median sideways miss over 500 m");
  // The photo date is within three days of the best day near it.
  for (const photo of data.photos) assert.ok(Math.abs(photo.best.days) <= 3, `${photo.date} ${photo.label}: ${photo.best.days} days`);
});

// Seasons that differ from the MLIT table by more than two days, each explained in the plan document.
const explained = {
  nagaike: "照片 11/06、11/07、02/04 与推算一致；国交省点位可能偏东（照片另有 11/04“長池親水公園東”）",
  ohira: "照片 11/19 山顶与推算一致；国交省日期与照片“大平山長池口登山道 11/14”一致，点位应为登山口",
  hananomiyako: "照片 11/30 与推算一致；国交省给出冬至前后的连续日期，点位不同",
  "azuma/08": "国交省两季不对称（4/13—15 与 9/8），按冬至/夏至对称应为 8 月底",
};

test("实景对照·国交省日期：由记录的山顶正中重算 2026 年各季最佳日一致；未解释的季节与日期表相差不超过 2 天", () => {
  for (const schedule of data.schedules) {
    const { observer, mark } = schedule.eye;
    const passes = passesOf(observer, mark, dayStart("2026-01-01"), dayStart("2027-01-01"), 1)
      .filter((found) => afternoon(found.instant) === (schedule.event === "sunset"));
    const found = seasons(passes).map((season) => ({ ...season, ...nearestRange(schedule.ranges, season.best.slice(0, 10)) }));
    assert.deepEqual(found.map((season) => [season.best, season.days]), schedule.eye.seasons.map((season) => [season.best, season.days]), schedule.place);
    for (const season of found) {
      const key = explained[schedule.place] ? schedule.place : explained[`${schedule.place}/${season.best.slice(5, 7)}`] ? `${schedule.place}/${season.best.slice(5, 7)}` : null;
      if (!key) assert.ok(Math.abs(season.days) <= 2, `${schedule.place} ${season.best}: ${season.days} days`);
    }
  }
  // Leaving out the eye's elevation moves the dates near the mountain by days, but hardly from Kanto.
  const shift = (place) => {
    const schedule = data.schedules.find((item) => item.place === place);
    return Math.max(...schedule.eye.seasons.map((season, index) => Math.abs(season.days - schedule.sea.seasons[index].days)));
  };
  assert.ok(shift("panorama") >= 5 && shift("nijumagari") >= 10);
  assert.ok(shift("nokogiri") <= 1 && shift("bunkyo") <= 1 && shift("osanbashi") <= 1);
});

test("实景对照·公告时刻：晴空塔 11/8 与高尾山 12 月的经过时刻落在公告时刻内；きらら 2/22 当天并未对齐（钻石在旭日丘一带）", () => {
  const at = (place) => data.announcements.find((item) => item.place === place);
  for (const place of ["skytree350", "skytree450"]) {
    const record = at(place);
    const pass = afternoonPass(record.observer, record.mark, record.date, minute(record.date, record.time));
    assert.equal(pass.instant, record.passes[0].instant);
    assert.equal(local(Date.parse(pass.instant)).slice(11, 16), "16:30");
    assert.ok(pass.ratio < 0.5);
  }
  const takao = at("takao");
  assert.equal(takao.passes.length, 12);
  for (const pass of takao.passes) {
    const clock = pass.local.slice(11, 16);
    assert.ok(clock >= "16:00" && clock <= "16:15", pass.local);
    assert.ok(pass.ratio < 0.6, pass.local);
  }
  assert.equal(takao.best.local.slice(0, 10), "2025-12-21");
  const kirara = at("kirara");
  assert.ok(kirara.passes[0].ratio > 2, "the Sun passes three diameters beside the summit at きらら on 2/22");
  assert.equal(kirara.passes[0].local.slice(11, 16), "16:35");
  const asahigaoka = data.photos.find((photo) => photo.date === "2026-02-22");
  assert.equal(asahigaoka.place, "asahigaoka");
  assert.ok(asahigaoka.pass.ratio < 1);
});
