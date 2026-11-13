import test from "node:test";
import assert from "node:assert/strict";
import { PbfWriter } from "pbf";
import {
  CHECK_LIMIT, CHECK_TILE_LIMIT, checkLabel, checkPlace, checkPoints, fitTargets, indexFeatures, insideRings, projector, rayCrossings, sightHeight,
} from "../../src/domain/solve/feasibility.ts";
import { travel } from "../../src/domain/solve/position-alignment.ts";
import { terrainTile } from "../../src/domain/core/terrain.ts";
import { decodeFeatures, featureTiles } from "../../src/io/feasibility.ts";

const square = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const camera = { latitude: 35.7, longitude: 139.8 };
/** A square outline of `size` metres centred `distance` metres from the camera towards `bearing`. */
function block(distance, bearing, size) {
  const centre = travel(camera, bearing, distance);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([east, north]) => {
    const moved = travel(centre, 90, (east * size) / 2);
    return travel(moved, 0, (north * size) / 2);
  });
  return [corners];
}
const target = (overrides = {}) => ({ key: "a", ...camera, ground: 0, cameraHeight: 1.6, azimuth: 90, elevation: 1, ...overrides });
const flat = () => 0;

test("几何：带洞多边形的内外、射线与轮廓的交点（穿过、截断、起点在内、平行）、含曲率的视线高度", () => {
  const rings = [square(0, 0, 100, 100), square(40, 40, 60, 60)];
  assert.equal(insideRings(rings, { x: 10, y: 10 }), true);
  assert.equal(insideRings(rings, { x: 50, y: 50 }), false, "inside the hole");
  assert.equal(insideRings(rings, { x: 150, y: 50 }), false);
  const box = [square(100, -50, 200, 50)];
  assert.deepEqual(rayCrossings(box, { x: 1, y: 0 }, 2000).map(Math.round), [100, 200]);
  assert.deepEqual(rayCrossings(box, { x: 1, y: 0 }, 150).map(Math.round), [100]);
  assert.deepEqual(rayCrossings(box, { x: 0, y: 1 }, 2000), []);
  assert.deepEqual(rayCrossings([square(-10, -10, 10, 10)], { x: 1, y: 0 }, 2000).map(Math.round), [10], "from inside, only the way out");
  assert.ok(Math.abs(sightHeight(10, 1000, 0) - (10 + 1000 ** 2 / (2 * 6_371_008.8))) < 1e-9);
  assert.ok(Math.abs(sightHeight(10, 1000, 1) - sightHeight(10, 1000, 0) - 1000 * Math.tan(Math.PI / 180)) < 1e-9);
  const project = projector(camera);
  const east = project(travel(camera, 90, 1000));
  assert.ok(Math.abs(east.x - 1000) < 1 && Math.abs(east.y) < 1);
});

test("机位检查：前方高于视线的建筑挡住、略低的不挡；身后、2 km 外与视线下方悬空的部分不计；机位在轮廓内与水面分别报告", () => {
  const sight = (distance) => sightHeight(1.6, distance, 1);
  const enter = 490; // the 20 m square 500 m east starts 10 m earlier
  const check = (buildings, water = [], overrides = {}) => checkPlace(target(overrides), indexFeatures({ water, buildings }), flat);
  const tall = check([{ rings: block(500, 90, 20), height: 30, base: 0 }]);
  assert.equal(tall.blocked.distance, enter);
  assert.ok(Math.abs(tall.blocked.above - (30 - sight(enter))) <= 1);
  assert.equal(check([{ rings: block(500, 90, 20), height: sight(enter) - 0.2, base: 0 }]).blocked, null, "just below the sight line");
  assert.ok(check([{ rings: block(500, 90, 20), height: sight(enter) + 0.2, base: 0 }]).blocked, "just above it");
  assert.equal(check([{ rings: block(500, 270, 20), height: 300, base: 0 }]).blocked, null, "behind the camera");
  assert.equal(check([{ rings: block(2500, 90, 20), height: 300, base: 0 }]).blocked, null, "beyond 2 km");
  assert.equal(check([{ rings: block(500, 90, 20), height: 60, base: 20 }]).blocked, null, "the line passes under a raised part");
  // The nearest of two counts.
  assert.equal(check([{ rings: block(900, 90, 20), height: 100, base: 0 }, { rings: block(300, 90, 20), height: 100, base: 0 }]).blocked.distance, 290);
  const inside = check([{ rings: block(0, 0, 30), height: 50, base: 0 }]);
  assert.deepEqual({ inside: inside.inside, blocked: inside.blocked }, { inside: true, blocked: null }, "the camera's own outline is not an obstruction");
  const lake = { rings: block(0, 0, 400) };
  assert.equal(check([], [lake]).water, true);
  assert.equal(check([], [{ rings: [...block(0, 0, 400), ...block(0, 0, 50)] }]).water, false, "an island in the lake");
  // No ground for the camera: the line cannot be placed.
  const unknown = checkPlace(target({ ground: undefined }), indexFeatures({ water: [], buildings: [{ rings: block(500, 90, 20), height: 300, base: 0 }] }), () => null);
  assert.deepEqual({ unknown: unknown.unknown, blocked: unknown.blocked }, { unknown: true, blocked: null });
  assert.equal(checkLabel(unknown), "机位处地形数据不全，未查遮挡");
  assert.equal(checkLabel(tall), `490 m 处建筑高出视线 ${tall.blocked.above} m`);
  assert.equal(checkLabel({ water: true, inside: false, blocked: null, unknown: false }), "机位在水面 · 2 km 内无建筑遮挡");
  assert.equal(checkLabel({ water: false, inside: false, blocked: { distance: 0, above: 6, height: 20 }, unknown: false }), "紧邻的建筑高出视线 6 m");
});

test("检查范围：每个机位读取机位与视线 2 km 内的瓦片；最多 60 个机位、40 块瓦片，按列表顺序截断", () => {
  const points = checkPoints(target());
  assert.equal(points.length, 9);
  assert.ok(Math.abs(points.at(-1).longitude - travel(camera, 90, 2000).longitude) < 1e-12);
  const tileOf = (point) => { const tile = terrainTile(point, 14); return `${tile.x}/${tile.y}`; };
  const same = Array.from({ length: CHECK_LIMIT + 10 }, (_, index) => target({ key: `${index}` }));
  assert.equal(fitTargets(same, tileOf).targets.length, CHECK_LIMIT);
  // Places 5 km apart each need their own tiles.
  const spread = Array.from({ length: 30 }, (_, index) => target({ key: `${index}`, ...travel(camera, 0, index * 5000) }));
  const fitted = fitTargets(spread, tileOf);
  assert.ok(fitted.targets.length < spread.length && fitted.tiles <= CHECK_TILE_LIMIT);
  assert.deepEqual(fitted.targets.map((item) => item.key), spread.slice(0, fitted.targets.length).map((item) => item.key));
  assert.equal(featureTiles(points).size, new Set(points.map(tileOf)).size);
});

// A hand-written z14 vector tile: one water square and one building with render heights.
function encodeTile() {
  const command = (id, count) => (id & 7) | (count << 3);
  const zigzag = (value) => (value << 1) ^ (value >> 31);
  const squareGeometry = (x, y, size) => [command(1, 1), zigzag(x), zigzag(y), command(2, 3), zigzag(size), 0, 0, zigzag(size), zigzag(-size), 0, command(7, 1)];
  const writer = new PbfWriter();
  const layer = (name, features, keys, values) => writer.writeMessage(3, (_, pbf) => {
    pbf.writeVarintField(15, 2);
    pbf.writeStringField(1, name);
    for (const feature of features) pbf.writeMessage(2, (__, out) => {
      if (feature.tags.length) out.writePackedVarint(2, feature.tags);
      out.writeVarintField(3, 3);
      out.writePackedVarint(4, feature.geometry);
    });
    for (const key of keys) pbf.writeStringField(3, key);
    for (const value of values) pbf.writeMessage(4, (___, out) => out.writeDoubleField(3, value));
    pbf.writeVarintField(5, 4096);
  });
  layer("water", [{ tags: [], geometry: squareGeometry(0, 0, 2048) }], [], []);
  layer("building", [{ tags: [0, 0, 1, 1], geometry: squareGeometry(2048, 2048, 100) }], ["render_height", "render_min_height"], [45, 0]);
  return writer.finish();
}

test("矢量瓦片解码：水体面与带高度的建筑轮廓换算为经纬度", () => {
  const tile = { z: 14, ...(({ x, y }) => ({ x, y }))(terrainTile(camera, 14)) };
  const features = decodeFeatures(encodeTile(), tile);
  assert.equal(features.water.length, 1);
  assert.equal(features.buildings.length, 1);
  const n = 2 ** 14;
  const corner = features.water[0].rings[0][0];
  assert.ok(Math.abs(corner.longitude - ((tile.x / n) * 360 - 180)) < 1e-9, "tile origin is the north-west corner");
  assert.ok(Math.abs(corner.latitude - Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / n))) * 180 / Math.PI) < 1e-9);
  assert.deepEqual({ height: features.buildings[0].height, base: features.buildings[0].base }, { height: 45, base: 0 });
  // The water square covers the tile's north-west quarter.
  const index = indexFeatures(features);
  const inQuarter = { latitude: (corner.latitude + features.water[0].rings[0][2].latitude) / 2, longitude: (corner.longitude + features.water[0].rings[0][2].longitude) / 2 };
  assert.equal(checkPlace(target({ ...inQuarter }), index, flat).water, true);
});
