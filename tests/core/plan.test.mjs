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
  shiftInstant,
  shiftDate,
  cameraHeightSlider,
  focalSlider,
  parseCoordinatePair,
} from "../../src/domain/core/plan.ts";

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

test("时间微调按绝对分钟跨午夜与夏令时，前后一天保留当地钟点并拒绝不存在的钟点", () => {
  assert.equal(shiftInstant("2026-11-04T14:55:00Z", "Asia/Tokyo", 10), "2026-11-04T15:05:00Z");
  assert.equal(localDateTime(shiftInstant("2026-11-04T14:55:00Z", "Asia/Tokyo", 10), "Asia/Tokyo"), "2026-11-05T00:05");
  // 01:30 EST + 1 h crosses the spring-forward gap to 03:30 EDT.
  assert.equal(localDateTime(shiftInstant(instantFromLocal("2026-03-08T01:30", "America/New_York"), "America/New_York", 60), "America/New_York"), "2026-03-08T03:30");
  assert.throws(() => shiftInstant("2100-12-31T23:30:00Z", "UTC", 60), /1900—2100/);
  assert.throws(() => shiftInstant("2026-11-04T00:00:00Z", "UTC", 0.5), RangeError);
  assert.equal(shiftDate("2026-11-04T08:00:12Z", "Asia/Tokyo", -1), "2026-11-03T08:00:12Z");
  assert.equal(localDateTime(shiftDate(instantFromLocal("2026-10-31T23:30", "Europe/Paris"), "Europe/Paris", 1), "Europe/Paris"), "2026-11-01T23:30");
  assert.throws(() => shiftDate(instantFromLocal("2026-03-07T02:30", "America/New_York"), "America/New_York", 1), RangeError);
});

test("离地高度滑条按对数映射 0.1—100 m，10 m 以下精确到 0.1 m，键盘每步至少改变一个单位", () => {
  const { toPosition, fromPosition, max } = cameraHeightSlider;
  assert.equal(toPosition(0.1), 0);
  assert.equal(toPosition(1), 200);
  assert.equal(toPosition(10), 400);
  assert.equal(toPosition(100), max);
  for (const height of [0.1, 0.5, 1.6, 5, 10, 30, 100]) assert.equal(fromPosition(toPosition(height)), height, `${height}`);
  let previous = 0;
  for (let position = 0; position <= max; position += 1) {
    const height = fromPosition(position);
    assert.ok(height >= previous, `monotonic at ${position}`);
    assert.ok(height < 10 ? Math.abs(height * 10 - Math.round(height * 10)) < 1e-9 : Number.isInteger(height), `${height}`);
    previous = height;
  }
  assert.equal(fromPosition(max + 1), 100);
  assert.equal(fromPosition(-1), 0.1);
  // Arrow keys move by one unit even where one slider position is smaller than the unit.
  assert.equal(cameraHeightSlider.step(1.5, 1), 1.6);
  assert.equal(cameraHeightSlider.step(1.5, -1), 1.4);
  assert.equal(cameraHeightSlider.step(9.9, 1), 10);
  assert.equal(cameraHeightSlider.step(10, -1), 9.9);
  assert.equal(cameraHeightSlider.step(50, 1), 51);
  assert.equal(cameraHeightSlider.step(100, 1), 100);
  assert.equal(cameraHeightSlider.step(0.1, -1), 0.1);
});

test("焦距滑杆按对数刻度覆盖 8—1000 mm，端点与常用焦距精确、单调且其他焦距误差小于一格", () => {
  const { toPosition, fromPosition, max } = focalSlider;
  assert.equal(fromPosition(0), 8);
  assert.equal(fromPosition(max), 1000);
  assert.equal(toPosition(8), 0);
  assert.equal(toPosition(1000), max);
  assert.equal(fromPosition(-5), 8);
  assert.equal(fromPosition(max + 5), 1000);
  // 8—100 mm keeps about half of the travel instead of 9 % on a linear scale.
  assert.ok(toPosition(100) > 0.5 * max && toPosition(100) < 0.53 * max);
  for (const focal of [8, 24, 35, 50, 85, 200, 600, 1000])
    assert.equal(fromPosition(toPosition(focal)), focal, `${focal}`);
  // Other focal lengths come back within one slider step (about 0.5 %).
  for (const focal of [10, 18, 70, 135, 300, 800])
    assert.ok(Math.abs(fromPosition(toPosition(focal)) / focal - 1) < 0.005, `${focal}`);
  let previous = 0;
  for (let position = 0; position <= max; position += 1) {
    const focal = fromPosition(position);
    assert.ok(focal >= previous, `monotonic at ${position}`);
    assert.ok(Math.abs(focal * 10 - Math.round(focal * 10)) < 1e-9, `${focal}`);
    previous = focal;
  }
});

test("粘贴“纬度, 经度”可识别逗号、中文逗号与空格，越界或格式不符时不处理", () => {
  assert.deepEqual(parseCoordinatePair("35.4172, 138.8729"), { latitude: 35.4172, longitude: 138.8729 });
  assert.deepEqual(parseCoordinatePair(" -33.8568，151.2153 "), { latitude: -33.8568, longitude: 151.2153 });
  assert.deepEqual(parseCoordinatePair("51.5 -0.12"), { latitude: 51.5, longitude: -0.12 });
  assert.deepEqual(parseCoordinatePair("10,180"), { latitude: 10, longitude: -180 });
  for (const text of ["35.4172", "91, 0", "0, 181", "35°N 138°E", "a, b", "1, 2, 3", ""])
    assert.equal(parseCoordinatePair(text), null, text);
});

test("自定义传感器按毫米尺寸计算视场与画幅裁切，缺尺寸时回落全画幅，缓存键随尺寸变化", async () => {
  const { sensorSize, sensorKey } = await import("../../src/domain/core/plan.ts");
  // 44 × 33 mm medium format, 3:2 crop keeps the width: 44 × 29.33 mm.
  const medium = { ...initialPlan, focalLength: 50, sensor: "custom", customSensor: { width: 44, height: 33 } };
  const fov = fieldOfView(medium);
  assert.ok(Math.abs(fov.width - 44) < 1e-9 && Math.abs(fov.height - 44 / 1.5) < 1e-9);
  assert.ok(Math.abs(fov.horizontal - (2 * Math.atan(44 / 100) * 180) / Math.PI) < 1e-9);
  assert.deepEqual(sensorSize({ sensor: "custom", customSensor: null }), sensorSize({ sensor: "full-frame" }));
  assert.equal(sensorKey({ sensor: "aps-c" }), "aps-c");
  assert.notEqual(sensorKey(medium), sensorKey({ ...medium, customSensor: { width: 44, height: 32.9 } }));
});
