import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  constellationScene,
  constellationCount,
  greatCircleSamples,
} from "../../src/domain/constellations.ts";
import { initialPlan } from "../../src/domain/plan.ts";
import { skyReference, skyPointView } from "../../src/domain/starfield.ts";
import { refractDirection } from "../../src/domain/refraction.ts";
import { direction, dot } from "../../src/domain/ephemeris.ts";
const json = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const catalog = json("../../src/data/bright-stars.json"),
  extra = json("../../src/data/constellation-stars.json"),
  figures = json("../../src/data/constellations.json");
const plan = {
  ...initialPlan,
  instant: "2026-11-08T16:00:00Z",
  refraction: "none",
};
const close = (a, b, t = 1e-6) =>
  assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);

test("固定 88 星座/89 分区及 121 个额外端点完整，来源与许可保留", () => {
  assert.equal(constellationCount, 88);
  assert.equal(figures.constellations.length, 89);
  assert.equal(new Set(figures.constellations.map((f) => f.id)).size, 89);
  assert.equal(extra.stars.length, 121);
  assert.equal(figures.constellations.find(f=>f.id==='Mic').name,'显微镜座');
  assert.equal(figures.constellations.find(f=>f.id==='Tel').name,'望远镜座');
  assert.equal(extra.license, "CC-BY-SA-4.0");
  assert.equal(figures.license, "BSD-3-Clause");
  assert.ok(figures.matchingMaxDegrees < 0.005);
  const ids = new Set([...catalog.stars, ...extra.stars].map((r) => r[0]));
  for (const f of figures.constellations) {
    assert.ok(f.name.includes("座"));
    for (const path of f.paths) {
      assert.ok(path.length >= 2);
      for (const id of path) assert.ok(ids.has(id));
    }
  }
  assert.ok(figures.constellations.find((f) => f.name === "巨蛇座（蛇头）"));
  assert.ok(figures.constellations.find((f) => f.name === "巨蛇座（蛇尾）"));
  assert.equal(Object.keys(catalog.names).length, 90);
  assert.ok(Object.values(catalog.names).includes("参宿五"));
  assert.ok(Object.values(catalog.names).includes("玉衡"));
});

test("连线沿短大圆跨真北，采样不超过一度，非法方向明确失败", () => {
  const a = direction(359, 10),
    b = direction(1, 10),
    samples = greatCircleSamples(a, b);
  samples[0].forEach((v, i) => close(v, a[i]));
  samples.at(-1).forEach((v, i) => close(v, b[i]));
  for (let i = 1; i < samples.length; i++) {
    close(Math.hypot(...samples[i]), 1);
    assert.ok(
      (Math.acos(Math.min(1, dot(samples[i - 1], samples[i]))) * 180) /
        Math.PI <
        1.000001,
    );
  }
  assert.ok(samples.every((p) => p[1] > 0.9));
  assert.throws(() => greatCircleSamples([0, 0, 0], a));
  assert.throws(() => greatCircleSamples([NaN, 1, 0], a));
  assert.throws(() => greatCircleSamples([1, 0, 0], [-1, 0, 0]));
});

test("连线端点与恒星共享自行/时刻/折射，姿态和焦距不改变端点，名称中心可定位", () => {
  for (const instant of [
    "1900-01-01T00:00:00Z",
    "2026-11-08T16:00:00Z",
    "2099-01-01T00:00:00Z",
  ])
    for (const refraction of ["none", "standard"]) {
      const p = { ...plan, instant, refraction },
        scene = constellationScene(p),
        sky = skyReference(p);
      const id = figures.constellations[0].paths[0][0],
        row = [...catalog.stars, ...extra.stars].find((r) => r[0] === id);
      const ray = refractDirection(sky.star(row).direction, refraction);
      ray.forEach((v, i) => close(scene.vertices[i], v));
      assert.ok(scene.vertices.every(Number.isFinite));
      assert.equal(scene.vertices.length % 6, 0);
      assert.equal(
        constellationScene({
          ...p,
          azimuth: 10,
          pitch: 50,
          focalLength: 1000,
          orientation: "portrait",
        }),
        scene,
      );
      assert.equal(scene.anchors.length, 89);
    }
  const scene = constellationScene(plan),
    orion = scene.anchors.find((p) => p.name === "猎户座");
  assert.ok(orion.elevation > 0);
  const view = skyPointView(
    { ...plan, azimuth: orion.azimuth, pitch: orion.elevation },
    orion,
  );
  close(view.pixel.x, 0);
  close(view.pixel.y, 0);
});
