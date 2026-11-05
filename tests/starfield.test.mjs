import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  skyReference,
  skyPointView,
  skyPointSize,
  milkyWayMesh,
  starCount,
  primarySkyNames,
} from "../src/domain/starfield.ts";
import { initialPlan, signedAngle } from "../src/domain/plan.ts";
import { direction, dot } from "../src/domain/ephemeris.ts";
import { photoCameraMatrix } from "../src/preview/terrain-perspective-math.ts";
const catalog = JSON.parse(
  readFileSync(
    new URL("../src/data/bright-stars.json", import.meta.url),
    "utf8",
  ),
);
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/starfield-reference.json", import.meta.url),
    "utf8",
  ),
);
const close = (a, b, t = 1e-7) =>
  assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);
const plan = {
  ...initialPlan,
  instant: "2026-07-01T13:00:00Z",
  refraction: "none",
  layers: { sun: true, moon: true, stars: true, milkyWay: true },
};
const angle = (a, b) =>
  (Math.atan2(
    Math.hypot(
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ),
    dot(a, b),
  ) *
    180) /
  Math.PI;

test("固定亮星子集保留许可、来源和真实数值，不含太阳或重复记录", () => {
  assert.equal(starCount, 925);
  assert.equal(catalog.license, "CC-BY-SA-4.0");
  assert.equal(
    catalog.sourceSha256,
    "d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd",
  );
  assert.equal(new Set(catalog.stars.map((r) => r[0])).size, starCount);
  assert.ok(Object.keys(catalog.names).length >= 87);
  for (const r of catalog.stars) {
    assert.ok(
      r[0] > 0 &&
        r[1] >= 0 &&
        r[1] < 24 &&
        Math.abs(r[2]) <= 90 &&
        r[3] > 0 &&
        r[7] <= 4.5,
    );
    assert.ok(r.slice(0, 8).every(Number.isFinite));
  }
  const names = skyReference(plan).points.map((p) => p.name);
  for (const name of primarySkyNames) assert.ok(names.includes(name));
});

test("恒星、银心及银河坐标对照独立 ERFA：南北半球、J2000 至 2099，方向误差小于 0.02°", () => {
  let maximum = 0;
  for (const ref of fixture.records) {
    const sky = skyReference(ref);
    const ray =
      ref.id === "galactic-center"
        ? sky.core.direction
        : ref.id.startsWith("galactic-")
          ? (() => {
              const mesh = milkyWayMesh({ ...plan, ...ref }),
                i = (Number(ref.id.split("-")[1]) * 49 + 24) * 5;
              return Array.from(mesh.vertices.slice(i, i + 3));
            })()
          : sky.points.find((p) => p.id === ref.id).direction;
    const error = angle(ray, direction(ref.azimuth, ref.elevation));
    maximum = Math.max(maximum, error);
    assert.ok(error < 0.02, `${ref.id}: ${error}°`);
  }
  console.info(
    `ERFA ${fixture.records.length} directions: max ${maximum.toFixed(6)}°`,
  );
});

test("金星与木星测站几何方向对照 JPL Horizons，误差小于 0.05°", () => {
  for (const ref of fixture.planets) {
    const point = skyReference(ref).points.find((p) => p.id === ref.id);
    close(signedAngle(point.azimuth - ref.azimuth), 0, 0.05);
    close(point.elevation, ref.elevation, 0.05);
  }
});

test("同一 UTC 保持位置；日期变更线、极点和时间范围边界有效", () => {
  const a = skyReference(plan);
  assert.equal(
    skyReference({ ...plan, azimuth: 123, focalLength: 1000, timeZone: "UTC" }),
    a,
  );
  const equivalent = skyReference({
    ...plan,
    instant: "2026-07-01T22:00:00+09:00",
  });
  close(angle(a.core.direction, equivalent.core.direction), 0);
  const east = skyReference({ ...plan, longitude: 180 }),
    west = skyReference({ ...plan, longitude: -180 });
  close(angle(east.core.direction, west.core.direction), 0);
  for (const latitude of [-90, 90])
    for (const p of skyReference({ ...plan, latitude }).points)
      assert.ok(p.direction.every(Number.isFinite));
  for (const instant of ["1900-01-01T00:00:00Z", "2100-12-31T23:59:59Z"])
    assert.ok(
      skyReference({ ...plan, instant }).core.direction.every(Number.isFinite),
    );
  assert.throws(() => skyReference({ ...plan, latitude: NaN }));
  assert.throws(() => skyReference({ ...plan, instant: "2026-07-01T22:00" }));
  assert.throws(() =>
    skyReference({ ...plan, instant: "2101-01-01T12:00:00Z" }),
  );
});

test("星点沿用摄影矩阵、折射与地平线判定，焦距和横竖幅不改变天体方向", () => {
  const point = skyReference(plan).points.find((p) => p.name === "北极星");
  for (const orientation of ["landscape", "portrait"])
    for (const focalLength of [8, 35, 1000]) {
      const p = {
          ...plan,
          azimuth: point.azimuth,
          pitch: point.elevation,
          orientation,
          focalLength,
        },
        view = skyPointView(p, point);
      close(view.pixel.x, 0);
      close(view.pixel.y, 0);
      assert.equal(view.state, "画面内");
      const m = photoCameraMatrix(p),
        v = view.ray,
        q = [0, 1, 2, 3].map(
          (i) => m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2],
        );
      close(q[0] / q[3], view.pixel.x, 3e-6);
      close(-q[1] / q[3], view.pixel.y, 3e-6);
      close(q[2] / q[3], 1);
      assert.equal(
        skyPointView(
          { ...p, azimuth: (p.azimuth + 180) % 360, pitch: -p.pitch },
          point,
        ).state,
        "视场外",
      );
    }
  const low = {
    ...point,
    azimuth: 0,
    elevation: -0.1,
    direction: direction(0, -0.1),
  };
  assert.equal(
    skyPointView({ ...plan, azimuth: 0, pitch: 0 }, low).state,
    "地平线下",
  );
  assert.equal(
    skyPointView({ ...plan, azimuth: 0, pitch: 0, refraction: "standard" }, low)
      .state,
    "画面内",
  );
  for (const p of skyReference(plan).points)
    assert.ok(skyPointSize(p) >= 1.2 && skyPointSize(p) <= 6);
});

test("银河网格有界、闭合、单位方向有限，姿态变化复用，折射变化更新", () => {
  const mesh = milkyWayMesh(plan);
  assert.equal(mesh.vertices.length, 17689 * 5);
  assert.equal(mesh.indices.length, 103680);
  assert.equal(
    milkyWayMesh({ ...plan, azimuth: 1, pitch: 80, focalLength: 1000 }),
    mesh,
  );
  for (let i = 0; i < mesh.vertices.length; i += 5)
    close(Math.hypot(...mesh.vertices.slice(i, i + 3)), 1, 1e-6);
  for (let b = 0; b < 49; b++)
    for (let i = 0; i < 3; i++)
      close(
        mesh.vertices[b * 5 + i],
        mesh.vertices[(360 * 49 + b) * 5 + i],
        1e-6,
      );
  assert.ok(mesh.indices.every((i) => i < 17689));
  assert.ok(mesh.vertices.every(Number.isFinite));
  assert.notEqual(milkyWayMesh({ ...plan, refraction: "standard" }), mesh);
});
