import test from "node:test";
import assert from "node:assert/strict";
import { Body, Equator, Horizon, Observer } from "astronomy-engine";
import { bodyTrack, corridor, findPositions, positionProfile, skyAt, skyField } from "../../src/domain/solve/position-alignment.ts";
import { ecefGeodetic, ellipsoidalRay, geodeticEcef } from "../../src/domain/core/geodesy.ts";
import { direction } from "../../src/domain/core/ephemeris.ts";
import { apparentElevation } from "../../src/domain/core/refraction.ts";
import { destination } from "../../src/domain/core/map.ts";

const rad = Math.PI / 180;
const R = 6_371_008.8;
const skytree = { latitude: 35.71004508243534, longitude: 139.81071889400482, height: 634 };
const day = (date) => Date.parse(`${date}T00:00:00+09:00`);
const base = (body, date, extra = {}) => ({ body, target: skytree, start: day(date), end: day(date) + 86_400_000, refraction: "standard", cameraHeight: 1.6, maxDistance: 30_000, ...extra });
const flat = () => 0;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b)))) / rad;
// The body straight from astronomy-engine for an observer on the ellipsoid, as the preview draws it.
function apparent(body, time, latitude, longitude) {
  const observer = new Observer(latitude, longitude, 0), date = new Date(time);
  const equator = Equator(body === "sun" ? Body.Sun : Body.Moon, date, observer, true, true);
  const horizon = Horizon(date, observer, equator.ra, equator.dec);
  return { azimuth: horizon.azimuth, elevation: apparentElevation(horizon.altitude, "standard") };
}
function haversine(a, b) {
  const dphi = (b.latitude - a.latitude) * rad, dlambda = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

test("找机位：合成平地上每个机位看目标顶部的方向与天体视方向一致，距离随高度升高单调减小，与独立逐 50 m 扫描的交点一致", () => {
  for (const [body, date] of [["moon", "2026-11-25"], ["sun", "2026-11-26"]]) {
    const input = base(body, date);
    const result = findPositions(input, flat);
    assert.equal(result.reason, null);
    assert.ok(result.points.length > 300, `${body}: ${result.points.length}`);
    for (const point of result.points) {
      const ray = ellipsoidalRay({ latitude: point.latitude, longitude: point.longitude, ellipsoidalHeight: 1.6 }, { ...skytree, ellipsoidalHeight: 634 });
      const sky = apparent(body, point.time, point.latitude, point.longitude);
      assert.ok(angle(ray, direction(sky.azimuth, sky.elevation)) < 0.005, `${body} ${new Date(point.time).toISOString()}`);
      assert.ok(point.sight === "clear");
    }
    const byElevation = [...result.points].sort((a, b) => a.elevation - b.elevation);
    // Morning and evening share elevations; on flat ground the distance follows the elevation alone.
    for (let index = 1; index < byElevation.length; index++)
      assert.ok(byElevation[index].distance < byElevation[index - 1].distance + 2, "higher body, closer camera");
    // Independent scan: every 30 minutes, walk the ellipsoidal line from the target every 50 m.
    const track = bodyTrack(input);
    for (const sample of track.filter((_, index) => index % 30 === 0)) {
      let previous = null, crossing = null;
      for (let distance = 200; distance <= 30_000; distance += 50) {
        const eye = destination(skytree, sample.azimuth + 180, distance);
        const ray = ellipsoidalRay({ ...eye, ellipsoidalHeight: 1.6 }, { ...skytree, ellipsoidalHeight: 634 });
        const value = Math.asin(ray[2] / Math.hypot(...ray)) / rad - apparent(body, sample.time, eye.latitude, eye.longitude).elevation;
        if (previous !== null && Math.sign(value) !== Math.sign(previous)) { crossing = distance - 25; break; }
        previous = value;
      }
      const found = result.points.filter((point) => point.time === sample.time);
      if (crossing === null) assert.equal(found.length, 0, new Date(sample.time).toISOString());
      else {
        assert.equal(found.length, 1, new Date(sample.time).toISOString());
        assert.ok(Math.abs(found[0].distance - crossing) < 100, `${found[0].distance} vs ${crossing}`);
      }
    }
  }
});

test("找机位：环形山脊挡在中间时，被挡与通视和独立的球面剖面检查一致；剖面给出遮挡位置", () => {
  // A 300 m ring 5.0–5.3 km around the tower, flat elsewhere.
  const ring = (latitude, longitude) => {
    const distance = haversine(skytree, { latitude, longitude });
    return distance >= 5000 && distance <= 5300 ? 300 : 0;
  };
  const input = base("moon", "2026-11-25");
  const result = findPositions(input, ring);
  let blocked = 0, clear = 0;
  for (const point of result.points) {
    if (point.distance >= 4900 && point.distance <= 5400) continue;
    // Spherical chord over the ground: straight height minus the drop x(D−x)/2R.
    const D = point.distance, eye = ring(point.latitude, point.longitude) + 1.6;
    let expected = "clear";
    for (let x = 20; x <= D - 50; x += 10) {
      const height = eye + (634 - eye) * (x / D) - (x * (D - x)) / (2 * R);
      const fromTarget = D - x;
      if (fromTarget >= 5000 && fromTarget <= 5300 && 300 > height + 2) { expected = "blocked"; break; }
    }
    // Skip cases within 2 m of the ridge top, where the two models may differ.
    const margin = (() => {
      const x = D - 5150;
      return x > 0 ? Math.abs(eye + (634 - eye) * (x / D) - (x * (D - x)) / (2 * R) - 300) : Infinity;
    })();
    if (margin < 4) continue;
    assert.equal(point.sight, expected, `${(D / 1000).toFixed(2)} km`);
    if (point.sight === "blocked") {
      blocked++;
      assert.ok(Math.abs(point.blockedAt - (D - 5300)) < 120, `blocked at ${point.blockedAt} for ${D}`);
    } else clear++;
  }
  assert.ok(blocked > 20 && clear > 20, `${blocked} blocked, ${clear} clear`);
  assert.equal(result.blocked, result.points.filter((point) => point.sight === "blocked").length);
  const far = result.points.find((point) => point.sight === "blocked");
  const profile = positionProfile({ target: skytree, cameraHeight: 1.6 }, far, ring);
  assert.equal(profile.sight, "blocked");
  assert.ok(profile.profile.some((sample) => sample.ground === 300 && sample.ground > sample.sight));
});

test("找机位：无解原因与无高程区域", () => {
  const night = findPositions(base("sun", "2026-11-25", { start: day("2026-11-25") + 20 * 3_600_000, end: day("2026-11-26") }), flat);
  assert.equal(night.reason, "below");
  // A ground-level target 1.6 m below the eye: only negative angles, the noon Sun is far above.
  const low = findPositions(base("sun", "2026-11-25", { target: { ...skytree, height: 0 }, start: day("2026-11-25") + 10 * 3_600_000, end: day("2026-11-25") + 14 * 3_600_000, maxDistance: 10_000 }), flat);
  assert.equal(low.reason, "out-of-range");
  assert.ok(low.angles.max < 0 && low.sky.min > 20);
  assert.equal(findPositions(base("moon", "2026-11-25"), () => null).reason, "no-ground");
  // No DEM west of 139.7°E: the minutes whose lines reach there are counted, and no point lies there.
  const partial = findPositions(base("sun", "2026-11-26"), (latitude, longitude) => (longitude < 139.7 ? null : 0));
  assert.ok(partial.gaps > 0);
  assert.ok(partial.points.every((point) => point.longitude >= 139.7));
  // The corridor covers the target and the lines to the farthest distance.
  const input = base("sun", "2026-11-26");
  const points = corridor(input, bodyTrack(input));
  assert.ok(points.some((point) => haversine(skytree, point) > 29_000));
});

test("经纬高与地心坐标互逆；一次星历的天球位置换到 30 km 外的地平与直接计算一致", () => {
  for (const point of [{ latitude: 35.7, longitude: 139.8, ellipsoidalHeight: 634 }, { latitude: -33.86, longitude: 151.21, ellipsoidalHeight: -20 }, { latitude: 69.6, longitude: 18.9, ellipsoidalHeight: 3000 }]) {
    const back = ecefGeodetic(geodeticEcef(point));
    assert.ok(Math.abs(back.latitude - point.latitude) < 1e-9 && Math.abs(back.longitude - point.longitude) < 1e-9 && Math.abs(back.ellipsoidalHeight - point.ellipsoidalHeight) < 1e-4);
  }
  const time = Date.parse("2026-11-25T08:00:00Z");
  for (const body of ["sun", "moon"]) {
    const field = skyField(body, time, skytree, "standard");
    for (const bearing of [0, 90, 200]) {
      const at = destination(skytree, bearing, 30_000);
      const fast = field(at.latitude, at.longitude), exact = skyAt(body, time, at.latitude, at.longitude, "standard");
      assert.ok(angle(direction(fast.azimuth, fast.elevation), direction(exact.azimuth, exact.elevation)) < 1e-5, body);
    }
  }
});
