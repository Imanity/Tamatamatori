import test from "node:test";
import assert from "node:assert/strict";
import { calendarText, foldLine, resultEvents, solveShotName, CALENDAR_LIMIT } from "../../src/domain/solve/solve-calendar.ts";
import { groundDistance, pointPlan, travel } from "../../src/domain/solve/position-alignment.ts";
import { mergeCandidates, rangeCandidates } from "../../src/domain/solve/range-alignment.ts";
import { lineItems, windowItem } from "../../src/domain/solve/composition.ts";
import { initialPlan } from "../../src/domain/core/plan.ts";
import { parseShotText, SHOT_NAME_LIMIT } from "../../src/domain/shots/shot.ts";

const site = "https://imanity.github.io/Tamatamatori/";
const plan = { ...initialPlan, timeZone: "Asia/Tokyo", layers: { ...initialPlan.layers, sun: false } };
const unfold = (text) => text.replace(/\r\n /g, "");
const lines = (text) => unfold(text).split("\r\n");
const octets = (line) => new TextEncoder().encode(line).length;

test("日历：CRLF 换行、75 字节折行不拆字符、文本转义、UTC 时刻、GEO 与一分钟的最短时段", () => {
  const event = {
    uid: "a@tamatamatori", start: Date.parse("2027-02-12T07:22:00Z"), end: Date.parse("2027-02-12T07:22:00Z"),
    summary: "太阳对齐 · 富士; 山顶, 正中", description: `第一行\n第二行 \\ 结束 ${"长".repeat(60)}`,
    location: { latitude: 35.4172, longitude: 138.8729 }, url: `${site}#shot=tmt1:${"A".repeat(120)}`,
  };
  const text = calendarText([event], "Tamatamatori 推算 · 富士", Date.parse("2026-11-12T00:00:00Z"));
  assert.ok(text.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(text), "every line break is CRLF");
  for (const line of text.split("\r\n")) assert.ok(octets(line) <= 75, `${octets(line)} octets: ${line.slice(0, 20)}`);
  const all = lines(text);
  assert.deepEqual(all.slice(0, 6), ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tamatamatori//Solve//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Tamatamatori 推算 · 富士"]);
  assert.ok(all.includes("DTSTAMP:20261112T000000Z"));
  assert.ok(all.includes("DTSTART:20270212T072200Z"));
  assert.ok(all.includes("DTEND:20270212T072300Z"), "a one-minute span at least");
  assert.ok(all.includes("SUMMARY:太阳对齐 · 富士\\; 山顶\\, 正中"));
  assert.ok(all.some((line) => line.startsWith("DESCRIPTION:第一行\\n第二行 \\\\ 结束 长")));
  assert.ok(all.includes("LOCATION:35.417200\\, 138.872900"));
  assert.ok(all.includes("GEO:35.417200;138.872900"));
  assert.ok(all.includes(`URL:${event.url}`));
  assert.equal(all.at(-2), "END:VCALENDAR");
  // Folding never splits a multi-byte character.
  const folded = foldLine(`DESCRIPTION:${"长".repeat(40)}`).split("\r\n");
  assert.ok(folded.length > 1 && folded.slice(1).every((part) => part.startsWith(" ")));
  assert.equal(folded.map((part, index) => (index ? part.slice(1) : part)).join(""), `DESCRIPTION:${"长".repeat(40)}`);
  // At most CALENDAR_LIMIT events.
  const many = calendarText(Array.from({ length: CALENDAR_LIMIT + 3 }, (_, index) => ({ ...event, uid: `${index}` })), "x");
  assert.equal(lines(many).filter((line) => line === "BEGIN:VEVENT").length, CALENDAR_LIMIT);
});

test("日历事件：每个结果一个事件——机位线按段、固定机位按时段；重合的线只一次，链接打开同一试看并按画面位置对准", () => {
  const lens = { focalLength: 200, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
  const ground = { kind: "ground", id: "g", name: "富士山顶正中", latitude: 35.3606, longitude: 138.7274, height: 0, reference: "ground", frame: { x: 0.5, y: 0.6 }, base: null, tolerance: 0.03 };
  // Two branches 30 m apart over the same minutes are one line; a third 5 km away is another.
  const line = (branch, offset) => Array.from({ length: 5 }, (_, index) => ({
    ...travel({ latitude: 35.43, longitude: 138.87 }, 60, index * 100 + offset), time: Date.parse("2026-02-04T07:10:00Z") + index * 60_000,
    distance: 14_000 + index * 100, azimuth: 241.2, elevation: 10.7, cameraGround: 985, residual: 0, sight: "clear", branch, day: "2026-02-04", share: null,
  }));
  const { items } = lineItems([...line(0, 0), ...line(1, 30), ...line(2, 5000)], { body: "sun", filters: [], splitSky: true, share: null });
  assert.equal(items.length, 2);
  const basis = { lens, ground, bodies: ["sun"] };
  const events = resultEvents(items, { plan, body: "sun", place: "富士山顶正中", site, basis, names: "太阳" });
  assert.equal(events.length, 2);
  assert.equal(events[0].summary, "太阳 · 富士山顶正中");
  assert.equal(events[0].start, items[0].start);
  assert.match(events[0].description, /机位沿线随时间移动；最大偏差 0\.0% 画面高\n距地面目标 14\.0—14\.4 km\n天空：白天；月亮/);
  const middle = items[0].points.find((point) => point.time === items[0].best);
  const opened = parseShotText(events[0].url);
  assert.equal(opened.ok, true);
  assert.deepEqual([opened.plan.latitude, opened.plan.longitude, opened.plan.instant], [Math.round(middle.latitude * 1e6) / 1e6, Math.round(middle.longitude * 1e6) / 1e6, "2026-02-04T07:12:00Z"]);
  assert.equal(opened.plan.layers.sun, true, "the body's layer is on, as in a try-out");
  assert.equal(opened.shot.name, "富士山顶正中 · 太阳 02-04 16:12");
  // The top below the centre: the link looks up, on the same bearing (the top straight below the centre).
  assert.deepEqual([opened.plan.azimuth, opened.plan.pitch > middle.elevation], [pointPlan(plan.layers, middle, "sun").azimuth, true]);
  // A still camera: its window, its aim.
  const still = windowItem({ start: Date.parse("2027-02-12T07:22:00Z"), end: Date.parse("2027-02-12T07:23:00Z"), best: Date.parse("2027-02-12T07:22:30Z"), deviation: 0.01 },
    { latitude: 35.4172, longitude: 138.8729 }, { azimuth: 244.6, pitch: 10.7 }, "2027-02-12");
  const [time] = resultEvents([still], { plan, body: "sun", place: "35.417°N 138.873°E", site, basis: { lens, ground: null, bodies: ["sun"] }, names: "太阳" });
  assert.equal(time.start, still.start);
  assert.equal(time.end, still.end);
  assert.match(time.description, /16:22–16:23（Asia\/Tokyo）机位固定；最大偏差 1\.0% 画面高/);
  const shot = parseShotText(time.url);
  assert.deepEqual([shot.plan.instant, shot.plan.azimuth, shot.plan.pitch, shot.plan.layers.sun], ["2027-02-12T07:22:30Z", 244.6, 10.7, true]);
});
test("合并几乎重合的结果：同一天、时段相接且中点不到 300 m 才合并，保留分钟多的", () => {
  const at = (distance) => travel({ latitude: 35.7, longitude: 139.8 }, 240, distance);
  // Minutes step 100 m along the line from `distance`; the middle is the middle minute.
  const candidate = (key, day, start, minutes, distance, clear = 1) => {
    const points = Array.from({ length: minutes }, (_, index) => ({ ...at(distance + index * 100), time: start + index * 60_000 }));
    return { key, day, start, end: start + (minutes - 1) * 60_000, middle: points[Math.floor(minutes / 2)], points, clear };
  };
  const t = Date.parse("2026-11-28T11:26:00Z");
  const { candidates, merged } = mergeCandidates([
    candidate("a", "2026-11-28", t, 1, 19_700),
    candidate("b", "2026-11-28", t, 3, 19_750),
    candidate("c", "2026-11-28", t + 120_000, 1, 19_800), // touches b's last minute
    candidate("d", "2026-11-28", t, 1, 20_700), // 1 km away
    candidate("e", "2026-11-29", t + 86_400_000, 1, 19_700), // another day
    candidate("f", "2026-11-28", t + 600_000, 1, 19_700), // later, not touching
  ]);
  assert.equal(merged, 2);
  assert.deepEqual(candidates.map((item) => item.key), ["b", "d", "f", "e"]);
  assert.ok(groundDistance(at(19_700), at(19_999)) < 300 && groundDistance(at(19_700), at(20_001)) > 300);
  assert.equal(mergeCandidates([candidate("a", "d", t, 1, 19_700), candidate("b", "d", t, 1, 20_001)]).merged, 0);
  // A single minute that repeats the first minute of a long run is the same place, though the middles are far apart.
  const long = candidate("long", "d", t, 30, 14_900);
  assert.ok(groundDistance(long.middle, at(14_900)) > 1000);
  assert.deepEqual(mergeCandidates([long, candidate("once", "d", t, 1, 14_950)]).candidates.map((item) => item.key), ["long"]);
  assert.equal(mergeCandidates([long, candidate("apart", "d", t, 1, 15_500)]).merged, 0);
});

test("试看计划：机位与方向取整到输入框精度，时刻为整秒 UTC，只开启对应天体图层", () => {
  const point = { latitude: 35.4269321234, longitude: 138.8708054321, time: Date.parse("2026-02-04T07:13:00Z"), azimuth: 241.190345, elevation: 10.741949 };
  assert.deepEqual(pointPlan(plan.layers, point, "moon"), {
    latitude: 35.426932, longitude: 138.870805, instant: "2026-02-04T07:13:00Z", azimuth: 241.1903, pitch: 10.7419,
    layers: { ...plan.layers, moon: true },
  });
  const name = solveShotName("名".repeat(50), "sun", "2026-02-04T07:13:00Z", "Asia/Tokyo");
  assert.equal([...name].length, SHOT_NAME_LIMIT);
  assert.equal(solveShotName("長池親水公園", "moon", "2026-02-04T07:13:00Z", "Asia/Tokyo"), "長池親水公園 · 月亮 02-04 16:13");
});
