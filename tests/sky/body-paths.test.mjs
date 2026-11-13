import test from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { bodyPath, pathView, PATH_SEARCH_HOURS } from "../../src/domain/body-paths.ts";
import { celestialBodies } from "../../src/domain/ephemeris.ts";
import { refractDirection } from "../../src/domain/refraction.ts";
import { instantFromLocal } from "../../src/domain/plan.ts";
import { strokeRun } from "../../src/preview/celestial-layer.ts";

const rad = Math.PI / 180;
const fuji = { latitude: 35.4172, longitude: 138.8729, timeZone: "Asia/Tokyo", refraction: "standard" };
const at = (local, site = fuji) => ({ ...site, instant: instantFromLocal(local, site.timeZone) });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lens = { focalLength: 24, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape" };
const apparent = (plan, id, time) =>
  refractDirection(celestialBodies({ ...plan, instant: new Date(time).toISOString() })[id].direction, plan.refraction);

test("轨迹经过拍摄时刻的日月圆面中心，与圆面共用星历、观察者和折射", () => {
  for (const refraction of ["standard", "none"]) {
    for (const [id, local] of [["sun", "2026-11-04T12:00"], ["moon", "2026-11-05T02:30"], ["sun", "2026-11-04T16:30:30"]]) {
      const plan = { ...at(local), refraction };
      const path = bodyPath(plan, id);
      assert.equal(path.pass, "current", `${id} ${local} is above the horizon`);
      const index = path.times.indexOf(Date.parse(plan.instant));
      assert.ok(index > 0, "the shooting instant is a vertex");
      const expected = refractDirection(celestialBodies(plan)[id].direction, refraction);
      path.points[index].forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-12));
    }
  }
});

test("显示本次出没；在地平线下时取前后最近的一次，整点标注按当地时区且不重复", () => {
  const sunset = Date.parse(instantFromLocal("2026-11-04T16:47", "Asia/Tokyo"));
  const cases = [
    ["2026-11-04T12:00", "current", "07:00", "16:00", 0],
    ["2026-11-04T05:30", "next", "07:00", "16:00", 0],
    ["2026-11-04T18:00", "previous", "07:00", "16:00", 0],
    // Sunset 16:47 is about 7.1 h before 23:50, sunrise 06:04 about 6.2 h after.
    ["2026-11-04T23:50", "next", "07:00", "16:00", 1],
  ];
  for (const [local, pass, first, last, day] of cases) {
    const path = bodyPath(at(local), "sun");
    assert.equal(path.pass, pass, local);
    assert.deepEqual([path.markers[0].label, path.markers.at(-1).label], [first, last], local);
    assert.ok(path.markers.every((marker) => marker.day === day), local);
    // Bracketing samples sit just below the horizon so clipping finds both crossings.
    assert.ok(path.points[0][2] <= 0 && path.points.at(-1)[2] <= 0, local);
    assert.ok(path.points.slice(1, -1).every((point) => point[2] > 0), local);
    assert.equal(new Set(path.markers.map((marker) => marker.label)).size, path.markers.length);
    for (const marker of path.markers) {
      const wall = Temporal.Instant.fromEpochMilliseconds(marker.time).toZonedDateTimeISO("Asia/Tokyo");
      assert.equal(`${String(wall.hour).padStart(2, "0")}:00`, marker.label);
      assert.equal(wall.minute, 0);
      assert.ok(marker.direction[2] > 0);
    }
    assert.ok(Math.abs(path.times.at(-1) - sunset) < 24 * 3600_000 + 10 * 60_000);
  }
  // A moon pass across midnight keeps one continuous arc and dates the next-day hours.
  const moon = bodyPath(at("2026-11-04T21:00"), "moon");
  assert.equal(moon.pass, "next");
  assert.ok(moon.markers.length > 6 && moon.markers.every((marker) => marker.day === 1));
  // Half-hour offsets: whole local hours fall at 15 minutes past the UTC hour.
  const kathmandu = bodyPath({ latitude: 27.7172, longitude: 85.324, timeZone: "Asia/Kathmandu", refraction: "standard", instant: "2026-11-04T06:00:00Z" }, "sun");
  assert.ok(kathmandu.markers.length >= 8);
  assert.ok(kathmandu.markers.every((marker) => new Date(marker.time).getUTCMinutes() === 15));
});

test("极夜整段在地平线下时不绘制，极昼不落时只画 24 小时一圈", () => {
  const tromso = { latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo", refraction: "standard" };
  const night = bodyPath({ ...tromso, instant: "2026-12-15T11:00:00Z" }, "sun");
  assert.equal(night.pass, null);
  assert.deepEqual([night.points.length, night.markers.length], [0, 0]);
  const view = pathView({ ...tromso, ...lens, azimuth: 180, pitch: 0 }, night);
  assert.equal(view.state, "地平线下");
  assert.equal(PATH_SEARCH_HOURS, 36);

  const day = bodyPath({ ...tromso, instant: "2026-06-21T11:00:00Z" }, "sun");
  assert.equal(day.pass, "long");
  assert.equal(day.times.at(-1) - day.times[0], 24 * 3600_000);
  assert.ok(day.times[0] <= Date.parse("2026-06-21T11:00:00Z") && Date.parse("2026-06-21T11:00:00Z") <= day.times.at(-1));
  assert.equal(day.markers.length, 24);
  assert.equal(new Set(day.markers.map((marker) => marker.label)).size, 24);
});

test("5 分钟采样的连线与真实视位置偏差小于 0.005°", () => {
  const sites = [
    { ...at("2026-11-04T12:00"), id: "sun" },
    { ...at("2026-11-05T02:30"), id: "moon" },
    { latitude: -33.8688, longitude: 151.2093, timeZone: "Australia/Sydney", refraction: "standard", instant: "2026-12-21T02:00:00Z", id: "sun" },
    { latitude: 64.1466, longitude: -21.9426, timeZone: "Atlantic/Reykjavik", refraction: "none", instant: "2026-06-21T13:00:00Z", id: "moon" },
  ];
  let worst = 0;
  for (const site of sites) {
    const path = bodyPath(site, site.id);
    assert.ok(path.points.length > 20, site.timeZone);
    for (let index = 1; index + 2 < path.points.length; index += 7) {
      const a = path.points[index], b = path.points[index + 1];
      const middle = apparent(site, site.id, (path.times[index] + path.times[index + 1]) / 2);
      // Straight on screen means on the great circle through a and b.
      const normal = cross(a, b), length = Math.hypot(...normal);
      worst = Math.max(worst, Math.asin(Math.abs(dot(middle, normal)) / length) / rad);
    }
  }
  assert.ok(worst < 0.005, `chord error ${worst}°`);
});

test("投影在地平线和画框外扩边界处裁切，标注只取画面内，背对时为视场外", () => {
  const plan = at("2026-11-04T12:00");
  const path = bodyPath(plan, "sun");
  const sun = celestialBodies(plan).sun;
  const facing = pathView({ ...plan, ...lens, azimuth: sun.azimuth, pitch: sun.elevation }, path);
  assert.equal(facing.state, "画面内");
  assert.ok(facing.markers.length >= 2);
  for (const marker of facing.markers) {
    assert.ok(Math.abs(marker.point.x) <= 1 && Math.abs(marker.point.y) <= 1);
    assert.ok(marker.tangent && Math.hypot(marker.tangent.x, marker.tangent.y) > 0);
  }
  for (const run of facing.runs)
    for (const point of run) assert.ok(Math.abs(point.x) <= 1.1 + 1e-9 && Math.abs(point.y) <= 1.1 + 1e-9);
  // Looking north and down: the arc lies behind the camera and must not reach the GPU.
  const away = pathView({ ...plan, ...lens, azimuth: (sun.azimuth + 180) % 360, pitch: -10 }, path);
  assert.equal(away.state, "视场外");
  assert.deepEqual([away.runs.length, away.markers.length], [0, 0]);
  // A wide lens aimed low at the rise point: the run starts on the horizon, never below.
  const morning = at("2026-11-04T05:30"), rise = bodyPath(morning, "sun");
  const low = pathView({ ...morning, focalLength: 14, sensor: "full-frame", aspectRatio: "3:2", orientation: "landscape", azimuth: 110, pitch: 5 }, rise);
  assert.equal(low.state, "画面内");
  // With no roll the apparent horizon is the screen line y = tan(pitch) / tan(vertical half-angle).
  assert.ok(Math.abs(low.runs[0][0].y - Math.tan(5 * rad) / (12 / 14)) < 1e-9, "the run starts at the horizon crossing");
  assert.ok(low.runs.flat().every((point) => point.y <= Math.tan(5 * rad) / (12 / 14) + 1e-9), "nothing below the horizon");
});

test("线条按设备像素扩成等宽三角带，相邻线段共用斜接边，距离单调递增", () => {
  const out = [];
  strokeRun([{ x: -0.5, y: 0 }, { x: 0, y: 0 }, { x: 0.5, y: 0.5 }], 400, 200, 2, out);
  assert.equal(out.length, 2 * 6 * 3);
  const vertices = Array.from({ length: out.length / 3 }, (_, i) => out.slice(i * 3, i * 3 + 3));
  // Straight first segment: offsets are ±2 px vertically, i.e. ±0.02 in NDC on a 200 px tall buffer.
  assert.ok(Math.abs(Math.abs(vertices[0][1]) - 0.02) < 1e-12);
  // Segment 1 ends where segment 2 starts (shared miter vertices, no overlap).
  assert.deepEqual(vertices[2], vertices[6]);
  assert.deepEqual(vertices[4], vertices[7]);
  // The joint is mitred: both sides sit on the bisector, further out than the half width.
  assert.ok(Math.hypot((vertices[2][0] - 0) * 200, vertices[2][1] * 100) > 2);
  const distances = vertices.map((vertex) => vertex[2]);
  assert.equal(distances[0], 0);
  assert.equal(Math.max(...distances), 100 + Math.hypot(100, 50));
  // Duplicate points are skipped; a single point draws nothing.
  const none = [];
  strokeRun([{ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 }], 400, 200, 2, none);
  assert.equal(none.length, 0);
});
