import test from "node:test";
import assert from "node:assert/strict";
import {
  fieldOfView,
  initialPlan,
  instantFromLocal,
  localDateTime,
  normalizeLongitude,
  frameAspectRatio,
  minuteOfDay,
  instantAtMinute,
  dragView,
  instantOnDate,
  localClockTime,
  zoomFocalLength,
} from "../src/domain/plan.ts";

test("日期编辑保留当地秒钟，拒绝越界及夏令时重复或跳过", () => {
  assert.equal(instantOnDate("2026-11-06T10:35:12Z", "Asia/Tokyo", "2026-11-07"), "2026-11-07T10:35:12Z");
  assert.equal(localClockTime("2026-11-06T10:35:12Z", "Asia/Tokyo"), "19:35:12");
  assert.throws(() => instantOnDate("2026-03-07T07:30:00Z", "America/New_York", "2026-03-08"));
  assert.throws(() => instantOnDate("2026-10-31T05:30:00Z", "America/New_York", "2026-11-01"));
  assert.throws(() => instantOnDate(initialPlan.instant, "UTC", "2101-01-01"));
});

test("滚轮焦距按比例变化，支持全范围并拒绝无效增量", () => {
  assert.ok(zoomFocalLength(35, -100) > 35);
  assert.ok(zoomFocalLength(35, 100) < 35);
  assert.equal(zoomFocalLength(35, -1e6), 1000);
  assert.equal(zoomFocalLength(35, 1e6), 8);
  assert.equal(zoomFocalLength(35, NaN), 35);
});

test("全画幅 50 mm 的视场符合公开几何关系，增加焦距缩小视场", () => {
  const fov = fieldOfView({ ...initialPlan, focalLength: 50 });
  assert.ok(Math.abs(fov.horizontal - 39.5977527) < 0.00001);
  assert.ok(Math.abs(fov.vertical - 26.9914666) < 0.00001);
  assert.ok(
    fieldOfView({ ...initialPlan, focalLength: 100 }).horizontal <
      fov.horizontal,
  );
});

test("16:9 在同一传感器内裁切，保留水平视场而缩小垂直视场", () => {
  const base = fieldOfView(initialPlan);
  const crop = fieldOfView({ ...initialPlan, aspectRatio: "16:9" });
  assert.equal(crop.horizontal, base.horizontal);
  assert.equal(crop.width, 36);
  assert.equal(crop.height, 20.25);
  assert.ok(crop.vertical < base.vertical);
  const square = fieldOfView({ ...initialPlan, aspectRatio: "1:1" });
  assert.equal(square.width, 24);
  assert.equal(square.horizontal, square.vertical);
  assert.ok(
    fieldOfView({ ...initialPlan, sensor: "aps-c" }).horizontal <
      base.horizontal,
  );
});

test("无效焦距不能生成有效视场", () => {
  for (const focalLength of [0, -1, Infinity, NaN])
    assert.throws(
      () => fieldOfView({ ...initialPlan, focalLength }),
      RangeError,
    );
});

test("UTC 与亚洲时区在跨日和跨年时保持同一时刻", () => {
  const instant = "2026-12-31T16:30:00Z";
  assert.equal(localDateTime(instant, "Asia/Tokyo"), "2027-01-01T01:30");
  assert.equal(localDateTime(instant, "Asia/Shanghai"), "2027-01-01T00:30");
  assert.equal(instantFromLocal("2027-01-01T01:30", "Asia/Tokyo"), instant);
  assert.equal(localDateTime(instant, "UTC"), "2026-12-31T16:30");
});

test("拒绝夏令时缺失时刻和重复时刻，不静默调整用户输入", () => {
  assert.throws(
    () => instantFromLocal("2026-03-08T02:30", "America/New_York"),
    RangeError,
  );
  assert.throws(
    () => instantFromLocal("2026-11-01T01:30", "America/New_York"),
    RangeError,
  );
  assert.equal(
    instantFromLocal("2026-11-01T03:30", "America/New_York"),
    "2026-11-01T08:30:00Z",
  );
  assert.throws(() => instantFromLocal("not-a-date", "UTC"), RangeError);
  assert.throws(() => instantFromLocal("1800-01-01T00:00", "UTC"), RangeError);
});

test("日期变更线使用一致的经度表示", () => {
  assert.equal(normalizeLongitude(180), -180);
  assert.equal(normalizeLongitude(-180), -180);
  assert.equal(normalizeLongitude(540), -180);
  assert.equal(normalizeLongitude(-181), 179);
});

test("横幅与竖幅交换有效宽高和视场，方形画幅保持不变", () => {
  for (const aspectRatio of ["3:2", "16:9", "1:1"]) {
    const landscape = { ...initialPlan, aspectRatio, orientation: "landscape" };
    const portrait = { ...landscape, orientation: "portrait" };
    const wide = fieldOfView(landscape),
      tall = fieldOfView(portrait);
    assert.equal(tall.width, wide.height);
    assert.equal(tall.height, wide.width);
    assert.equal(tall.horizontal, wide.vertical);
    assert.equal(tall.vertical, wide.horizontal);
    assert.equal(frameAspectRatio(portrait), 1 / frameAspectRatio(landscape));
  }
  const square = fieldOfView({
    ...initialPlan,
    aspectRatio: "1:1",
    orientation: "portrait",
  });
  assert.equal(square.horizontal, square.vertical);
});

test("8—1000 mm 焦距均生成有效视场，长焦视场更窄", () => {
  const wide = fieldOfView({ ...initialPlan, focalLength: 8 });
  const tele = fieldOfView({ ...initialPlan, focalLength: 1000 });
  assert.ok(wide.horizontal > 100 && wide.horizontal < 180);
  assert.ok(tele.horizontal > 2 && tele.horizontal < 2.1);
  assert.ok(tele.vertical > 1 && tele.vertical < wide.vertical);
});

test("预览拖动跨真北时归一方位角，俯仰限制于正负 90 度", () => {
  const plan = { ...initialPlan, azimuth: 1, pitch: 89 };
  const dragged = dragView(plan, 300, 500, 600, 400);
  assert.ok(dragged.azimuth > 300 && dragged.azimuth < 360);
  assert.equal(dragged.pitch, 90);
  assert.equal(dragView({ ...plan, pitch: -89 }, 0, -500, 600, 400).pitch, -90);
  assert.deepEqual(dragView(plan, 20, 20, 0, 0), { azimuth: 1, pitch: 89 });
  assert.equal(plan.latitude, initialPlan.latitude);
});

test("同样的预览拖动在长焦下精细移动，横竖幅正确改变拖动比例", () => {
  const base = { ...initialPlan, azimuth: 180, pitch: 0 };
  const wide = dragView({ ...base, focalLength: 8 }, 100, 0, 600, 400);
  const tele = dragView({ ...base, focalLength: 1000 }, 100, 0, 600, 400);
  assert.ok(Math.abs(tele.azimuth - 180) < Math.abs(wide.azimuth - 180));
  const portrait = dragView(
    { ...base, orientation: "portrait" },
    100,
    0,
    600,
    400,
  );
  const landscape = dragView(base, 100, 0, 600, 400);
  assert.ok(
    Math.abs(portrait.azimuth - 180) < Math.abs(landscape.azimuth - 180),
  );
});

test("时间滑杆使用当地日期，跨 UTC 日期与年界仍保持当地同一天", () => {
  const instant = "2026-12-31T16:30:00Z";
  assert.equal(minuteOfDay(instant, "Asia/Tokyo"), 90);
  assert.equal(
    instantAtMinute(instant, "Asia/Tokyo", 0),
    "2026-12-31T15:00:00Z",
  );
  assert.equal(
    instantAtMinute(instant, "Asia/Tokyo", 1439),
    "2027-01-01T14:59:00Z",
  );
  assert.equal(
    localDateTime(instantAtMinute(instant, "Asia/Tokyo", 720), "Asia/Tokyo"),
    "2027-01-01T12:00",
  );
  for (const minute of [-1, 1440, 1.5, NaN])
    assert.throws(() => instantAtMinute(instant, "UTC", minute), RangeError);
});

test("时间滑杆拒绝夏令时跳过和重复的钟点，其他钟点可以正常设定", () => {
  assert.throws(
    () => instantAtMinute("2026-03-08T12:00:00Z", "America/New_York", 150),
    RangeError,
  );
  assert.throws(
    () => instantAtMinute("2026-11-01T12:00:00Z", "America/New_York", 90),
    RangeError,
  );
  assert.equal(
    instantAtMinute("2026-11-01T12:00:00Z", "America/New_York", 210),
    "2026-11-01T08:30:00Z",
  );
});
