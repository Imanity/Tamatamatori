import test from "node:test";
import assert from "node:assert/strict";
import { calendarText, foldLine, positionEvents, rangeEvents, solveShotName, timeEvents, CALENDAR_LIMIT } from "../src/domain/solve-calendar.ts";
import { distinctPoints, groundDistance, pointPlan, travel } from "../src/domain/position-alignment.ts";
import { mergeCandidates } from "../src/domain/range-alignment.ts";
import { initialPlan } from "../src/domain/plan.ts";
import { parseShotText, SHOT_NAME_LIMIT } from "../src/domain/shot.ts";

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

test("日历事件：找时间按容差时段、找机位按对齐线（重合的线一次）、两者都找按候选；链接打开同一个试看计划", () => {
  const context = { plan, body: "sun", place: "富士山", site };
  const found = { instant: "2027-02-12T07:22:30Z", from: "2027-02-12T07:22:00Z", to: "2027-02-12T07:23:00Z", separation: 0.08, diameter: 0.54, offset: "偏左下",
    azimuth: 244.6, elevation: 10.7, illuminated: null, phaseAngle: null, sunElevation: 10.7, sky: "day" };
  const [time] = timeEvents([found], context);
  assert.equal(time.start, Date.parse(found.from));
  assert.equal(time.end, Date.parse(found.to));
  assert.equal(time.summary, "太阳对齐 · 富士山");
  assert.match(time.description, /16:22（Asia\/Tokyo）太阳中心偏离期望位置 0\.15 个视直径（偏左下）[\s\S]*天空：白天[\s\S]*打开机位：https:/);
  const opened = parseShotText(time.url);
  assert.equal(opened.ok, true);
  assert.equal(opened.plan.instant, "2027-02-12T07:22:30Z");
  assert.equal(opened.plan.layers.sun, true, "the body's layer is on, as in a try-out");
  assert.equal(opened.shot.name, "富士山 · 太阳 02-12 16:22");
  // Two branches 30 m apart over the same minutes are one line.
  const line = (branch, offset) => Array.from({ length: 5 }, (_, index) => ({
    ...travel({ latitude: 35.43, longitude: 138.87 }, 60, index * 100 + offset), time: Date.parse("2026-02-04T07:10:00Z") + index * 60_000,
    distance: 14_000 + index * 100, azimuth: 241.2, elevation: 10.7, cameraGround: 985, residual: 0, sight: "clear", branch,
  }));
  const segments = positionEvents([...line(0, 0), ...line(1, 30), ...line(2, 5000)], { ...context, place: "富士山顶正中" });
  assert.equal(segments.length, 2);
  const middle = line(0, 0)[2];
  const segmentShot = parseShotText(segments[0].url);
  assert.deepEqual({ latitude: segmentShot.plan.latitude, longitude: segmentShot.plan.longitude, instant: segmentShot.plan.instant },
    { ...(({ latitude, longitude, instant }) => ({ latitude, longitude, instant }))(pointPlan(plan.layers, middle, "sun")) });
  assert.equal(segments[0].location.latitude, middle.latitude);
  assert.match(segments[0].description, /距目标 14\.0—14\.4 km；通视 100%/);
  const candidate = { key: "a", day: "2026-11-25", points: line(0, 0).map((point) => ({ ...point, day: "2026-11-25", share: 0.3 })), middle: { ...middle, day: "2026-11-25", share: 0.3 },
    start: line(0, 0)[0].time, end: line(0, 0)[4].time, near: 14_000, far: 14_400, share: [0.28, 0.31], sky: "blue", illuminated: 0.99, clear: 1 };
  const [range] = rangeEvents([candidate], { ...context, body: "moon", place: "晴空塔" });
  assert.equal(range.summary, "月亮 · 晴空塔");
  assert.match(range.description, /主体占画面 28%—31%[\s\S]*天空：蓝调，亮面 99%/);
  assert.equal(parseShotText(range.url).plan.layers.moon, true);
});

test("合并几乎重合的结果：同一天、时段相接且中点不到 300 m 才合并，保留分钟多的；同一分钟不到 200 m 的解只列一个且优先通视", () => {
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
  const point = (distance, sight, time = t) => ({ ...at(distance), time, sight, id: `${distance}/${sight}` });
  const listed = distinctPoints([point(24_500, "blocked"), point(24_550, "clear"), point(25_100, "clear"), point(25_150, "clear"), point(27_000, "unknown"), point(24_500, "clear", t + 600_000)]);
  assert.deepEqual(listed.map((item) => item.id), ["24550/clear", "25100/clear", "27000/unknown", "24500/clear"]);
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
