import test from "node:test";
import assert from "node:assert/strict";
import { MercatorCoordinate } from "maplibre-gl";
import { initialPlan, fieldOfView } from "../src/domain/plan.ts";
import {
  decodeTerrarium,
  sampleElevationTile,
  terrainTile,
  terrainStyle,
  TERRAIN_SOURCE,
  WATER_SOURCE,
} from "../src/domain/terrain.ts";
import { terrainCamera } from "../src/preview/camera.ts";

const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} differs from ${expected}`,
  );
function rgba(height, alpha = 255) {
  const encoded = height + 32768;
  return [
    Math.floor(encoded / 256),
    Math.floor(encoded) % 256,
    Math.round((encoded % 1) * 256),
    alpha,
  ];
}

test("Terrarium 解码区分有效海平面、负高程与缺失像素", () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(131, 232, 0), 1000);
  assert.equal(decodeTerrarium(127, 255, 128), -0.5);
  assert.throws(() => decodeTerrarium(128, 0, 0, 0), RangeError);
  assert.throws(() => decodeTerrarium(0, 0, 0), RangeError);
});

test("双线性高程采样正确处理像素中心、边缘和透明数据", () => {
  const tile = {
    width: 2,
    height: 2,
    pixels: new Uint8ClampedArray(
      [1000, 1100, 1200, 1300].flatMap((height) => rgba(height)),
    ),
  };
  assert.equal(sampleElevationTile(tile, 0.5, 0.5), 1150);
  assert.equal(sampleElevationTile(tile, 0.25, 0.25), 1000);
  assert.equal(sampleElevationTile(tile, 1, 1), 1300);
  tile.pixels[3] = 0;
  assert.throws(() => sampleElevationTile(tile, 0.5, 0.5), RangeError);
  assert.throws(() => sampleElevationTile(tile, -0.1, 0), RangeError);
});

test("高程瓦片坐标在赤道、日期变更线和覆盖边界内有效", () => {
  assert.deepEqual(terrainTile({ longitude: 0, latitude: 0 }, 1), {
    z: 1,
    x: 1,
    y: 1,
    u: 0,
    v: 0,
  });
  assert.equal(terrainTile({ longitude: 180, latitude: 0 }, 1).x, 0);
  for (const latitude of [-85.05, 85.05]) {
    const tile = terrainTile({ longitude: 179.999, latitude });
    assert.ok(tile.x >= 0 && tile.x < 4096 && tile.y >= 0 && tile.y < 4096);
    assert.ok(tile.u >= 0 && tile.u < 1 && tile.v >= 0 && tile.v < 1);
  }
  assert.throws(() => terrainTile({ longitude: 0, latitude: 90 }), RangeError);
});

test("摄影相机固定在机位与 DEM 加离地高度处，观察向量长度为 20 米", () => {
  const pose = terrainCamera(initialPlan, 980);
  assert.equal(pose.eye.lng, initialPlan.longitude);
  assert.equal(pose.eye.lat, initialPlan.latitude);
  assert.equal(pose.altitude, 981.6);
  const eye = MercatorCoordinate.fromLngLat(pose.eye, pose.altitude);
  const target = MercatorCoordinate.fromLngLat(
    pose.target,
    pose.targetAltitude,
  );
  const scale = eye.meterInMercatorCoordinateUnits();
  close(
    Math.hypot(target.x - eye.x, target.y - eye.y, target.z - eye.z) / scale,
    20,
    0.0001,
  );
  assert.equal(pose.verticalFov, fieldOfView(initialPlan).vertical);
  assert.equal(pose.pitch, 94);
});

test("相机支持水平、仰视和俯视，俯仰角转换与实际向量一致", () => {
  for (const pitch of [-90, -45, 0, 4, 80, 90]) {
    const plan = { ...initialPlan, pitch };
    const pose = terrainCamera(plan, 980);
    const eye = MercatorCoordinate.fromLngLat(pose.eye, pose.altitude);
    const target = MercatorCoordinate.fromLngLat(
      pose.target,
      pose.targetAltitude,
    );
    close(
      (Math.atan2(
        target.z - eye.z,
        Math.hypot(target.x - eye.x, target.y - eye.y),
      ) *
        180) /
        Math.PI,
      pitch,
      0.0001,
    );
    assert.equal(pose.pitch, 90 + pitch);
    assert.equal(pose.bearing, initialPlan.azimuth);
  }
});

test("长焦、竖幅和负高程不改变机位，相机拒绝无效高度", () => {
  const base = terrainCamera({ ...initialPlan, focalLength: 1000 }, -430);
  const portrait = terrainCamera(
    { ...initialPlan, focalLength: 1000, orientation: "portrait" },
    -430,
  );
  assert.equal(base.altitude, -428.4);
  assert.deepEqual(base.eye, portrait.eye);
  assert.ok(portrait.verticalFov > base.verticalFov);
  assert.throws(
    () => terrainCamera({ ...initialPlan, cameraHeight: 0 }, 980),
    RangeError,
  );
  assert.throws(() => terrainCamera(initialPlan, NaN), RangeError);
});

test("渲染样式启用真实地形与实际水体面，不包含标签或建筑", () => {
  const style = terrainStyle();
  assert.equal(style.terrain.source, TERRAIN_SOURCE);
  assert.equal(style.terrain.exaggeration, 1);
  assert.equal(style.sources[TERRAIN_SOURCE].encoding, "terrarium");
  assert.equal(style.sources[TERRAIN_SOURCE].maxzoom, 12);
  assert.equal(
    style.layers.find((layer) => layer.id === "preview-water")["source-layer"],
    "water",
  );
  assert.equal(
    style.layers.find((layer) => layer.id === "preview-water").source,
    WATER_SOURCE,
  );
  assert.equal(
    style.layers.filter(
      (layer) => layer.type === "symbol" || layer.type === "fill-extrusion",
    ).length,
    0,
  );
});
