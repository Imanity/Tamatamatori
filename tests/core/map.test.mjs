import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialPlan, fieldOfView } from "../../src/domain/plan.ts";
import {
  MAX_MAP_LATITUDE,
  destination,
  initialBearing,
  isMapPosition,
  mapSelection,
  nearbyLongitude,
  viewGeometry,
  viewRadiusMeters,
} from "../../src/domain/map.ts";

const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} differs from ${expected}`,
  );

test("赤道与本初子午线上的四个方向符合真北顺时针约定", () => {
  const origin = { latitude: 0, longitude: 0 };
  for (const [latitude, longitude, expected] of [
    [1, 0, 0],
    [0, 1, 90],
    [-1, 0, 180],
    [0, -1, 270],
  ]) {
    close(initialBearing(origin, { latitude, longitude }), expected);
  }
});

test("地图定向采用独立 PROJ 椭球局部方位，并保留长焦所需的小数精度",()=>{
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/geodetic-reference.json',import.meta.url),'utf8')).mapSurfaceBearing;
  const expected=(Math.atan2(fixture.enu[0],fixture.enu[1])*180/Math.PI+360)%360;
  const actual=initialBearing(fixture.eye,fixture.target);
  close(actual,expected,1e-9);
  assert.ok(Math.abs(actual*10-Math.round(actual*10))>1e-3,'direction must not be truncated to 0.1 degree');
  close(mapSelection({...initialPlan,...fixture.eye},fixture.target,'direction').azimuth,expected,1e-9);
});

test("日期变更线两侧的邻近点使用短弧方向", () => {
  close(
    initialBearing(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    ),
    90,
  );
  close(
    initialBearing(
      { latitude: 0, longitude: -179.9 },
      { latitude: 0, longitude: 179.9 },
    ),
    270,
  );
  close(nearbyLongitude(-179.9, 179.9), 180.1);
  close(nearbyLongitude(179.9, -179.9), -180.1);
});

test("同点、对跖点、极点与无效输入不会产生虚假的朝向", () => {
  const origin = { latitude: 0, longitude: 0 };
  for (const target of [
    origin,
    { latitude: 0, longitude: 180 },
    { latitude: NaN, longitude: 1 },
  ]) {
    assert.equal(initialBearing(origin, target), null);
  }
  assert.equal(initialBearing({ latitude: 90, longitude: 0 }, origin), null);
});

test("示意目的点保持椭球局部方向，并正确跨日期变更线", () => {
  const origin = { latitude: 0, longitude: 179.99 };
  const target = destination(origin, 90, 10_000);
  close(target.latitude, 0);
  close(target.longitude, -179.9200679636);
  close(initialBearing(origin, target), 90);
  for (const azimuth of [0, 45, 137, 247, 359]) {
    close(
      initialBearing(initialPlan, destination(initialPlan, azimuth, 1500)),
      azimuth,
    );
  }
});

test("地图选点只更新机位，方向模式只更新方位角，不改变时间和镜头", () => {
  const point = { latitude: 40, longitude: 540 };
  const positionPatch = mapSelection(initialPlan, point, "position");
  assert.deepEqual(positionPatch, { latitude: 40, longitude: -180 });
  const positionPlan = { ...initialPlan, ...positionPatch };
  assert.equal(positionPlan.instant, initialPlan.instant);
  assert.equal(positionPlan.timeZone, initialPlan.timeZone);
  assert.equal(positionPlan.azimuth, initialPlan.azimuth);
  assert.equal(positionPlan.focalLength, initialPlan.focalLength);
  const directionPatch = mapSelection(
    initialPlan,
    destination(initialPlan, 90, 1000),
    "direction",
  );
  close(directionPatch.azimuth, 90);
  const directed = { ...initialPlan, ...directionPatch };
  assert.equal(directed.latitude, initialPlan.latitude);
  assert.equal(directed.longitude, initialPlan.longitude);
  assert.equal(directed.instant, initialPlan.instant);
  assert.equal(mapSelection(initialPlan, initialPlan, "direction"), null);
});

test("默认浏览模式的地图点击不会修改任何拍摄参数", () => {
  assert.equal(
    mapSelection(initialPlan, { latitude: 40, longitude: 140 }, "browse"),
    null,
  );
  assert.equal(mapSelection(initialPlan, initialPlan, "browse"), null);
});

test("日期变更线附近的扇形闭合，且不横跨整张地图", () => {
  const plan = { ...initialPlan, latitude: 0, longitude: 179.999, azimuth: 90 };
  const data = viewGeometry(plan, 10);
  assert.equal(data.features.length, 2);
  const polygon = data.features.find(
    (feature) => feature.geometry.type === "Polygon",
  ).geometry.coordinates[0];
  assert.deepEqual(polygon[0], polygon.at(-1));
  const longitudes = polygon.map((point) => point[0]);
  assert.ok(Math.max(...longitudes) - Math.min(...longitudes) < 1);
  assert.ok(Math.max(...longitudes) > 180);
  for (const point of polygon) assert.ok(point.every(Number.isFinite));
});

test("视场扇形角度随焦距收窄，而缩放只改变示意半径", () => {
  const span = (plan) => {
    const arc = viewGeometry(plan, 12).features[0].geometry.coordinates[0];
    const edgeBearing = (point) =>
      initialBearing(plan, { longitude: point[0], latitude: point[1] });
    const start = edgeBearing(arc[1]);
    const end = edgeBearing(arc.at(-2));
    return (start - end + 360) % 360;
  };
  const wide = { ...initialPlan, azimuth: 90, focalLength: 24 };
  const tele = { ...wide, focalLength: 85 };
  close(span(wide), fieldOfView(wide).horizontal);
  assert.ok(span(tele) < span(wide));
  assert.ok(
    viewRadiusMeters(initialPlan, 13) < viewRadiusMeters(initialPlan, 12),
  );
});

test("覆盖外机位被保留，不产生截断到边界的标记或扇形", () => {
  for (const latitude of [-90, -86, 86, 90]) {
    const polar = { ...initialPlan, latitude };
    assert.equal(isMapPosition(polar), false);
    assert.deepEqual(viewGeometry(polar, 10).features, []);
    assert.equal(mapSelection(polar, initialPlan, "direction"), null);
    assert.equal(polar.latitude, latitude);
  }
  assert.equal(
    mapSelection(initialPlan, { latitude: 90, longitude: 0 }, "position"),
    null,
  );
  for (const latitude of [
    MAX_MAP_LATITUDE - 0.0001,
    -MAX_MAP_LATITUDE + 0.0001,
  ]) {
    const data = viewGeometry({ ...initialPlan, latitude, azimuth: 0 }, 2);
    for (const feature of data.features) {
      const points =
        feature.geometry.type === "Polygon"
          ? feature.geometry.coordinates.flat()
          : feature.geometry.coordinates;
      assert.ok(
        points.every((point) => Math.abs(point[1]) <= MAX_MAP_LATITUDE),
      );
    }
  }
});
