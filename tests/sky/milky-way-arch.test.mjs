// The Milky Way arch against a 0.01° sampling of the galactic equator (docs/plan/review.md §6).
import test from "node:test";
import assert from "node:assert/strict";
import { RotateVector, Rotation_GAL_EQJ, Vector } from "astronomy-engine";
import { milkyWayArch, ARCH_MIN_ELEVATION } from "../../src/domain/sky/milky-way-arch.ts";
import { skyFrame } from "../../src/domain/sky/sky-frame.ts";
import { refractDirection } from "../../src/domain/core/refraction.ts";
import { initialPlan, signedAngle } from "../../src/domain/core/plan.ts";

const degrees = Math.PI / 180;
/** The galactic equator (b = 0) as the Milky Way mesh transforms it, every 0.01°. */
function sampled(plan) {
  const sky = skyFrame(plan), rotation = Rotation_GAL_EQJ();
  const points = [];
  for (let step = 0; step < 36000; step++) {
    const l = (step / 100) * degrees;
    const p = RotateVector(rotation, new Vector(Math.cos(l), Math.sin(l), 0, sky.time));
    const ray = refractDirection(sky.horizontal([p.x, p.y, p.z]), plan.refraction);
    points.push({
      azimuth: ((Math.atan2(ray[0], ray[1]) / degrees) + 360) % 360,
      elevation: Math.asin(Math.max(-1, Math.min(1, ray[2]))) / degrees,
    });
  }
  return points;
}

const cases = [
  { name: "富士山 夏夜", latitude: 35.4172, longitude: 138.8729, instant: "2026-08-12T13:30:00Z" },
  { name: "富士山 冬夜", latitude: 35.4172, longitude: 138.8729, instant: "2026-01-15T12:00:00Z" },
  { name: "智利 银心过天顶", latitude: -24.6, longitude: -70.4, instant: "2026-06-20T04:00:00Z" },
  { name: "挪威", latitude: 69.6, longitude: 18.9, instant: "2026-11-20T20:00:00Z" },
  { name: "西澳 无折射", latitude: -31.9, longitude: 115.9, instant: "2026-04-10T17:00:00Z", refraction: "none" },
];

test("银拱最高点与逐点采样银道一致：方位、高度差不超过 0.05°，两端相隔 180°", () => {
  for (const item of cases) {
    const plan = { ...initialPlan, refraction: "standard", ...item };
    const arch = milkyWayArch(plan);
    const points = sampled(plan);
    const top = points.reduce((best, p) => (p.elevation > best.elevation ? p : best));
    assert.ok(Math.abs(arch.apex.elevation - top.elevation) <= 0.05, `${item.name}: ${arch.apex.elevation} vs ${top.elevation}`);
    if (top.elevation < 89) assert.ok(Math.abs(signedAngle(arch.apex.azimuth - top.azimuth)) <= 0.05, `${item.name}: ${arch.apex.azimuth} vs ${top.azimuth}`);
    assert.equal(arch.center.azimuth, arch.apex.azimuth);
    assert.equal(arch.center.pitch, arch.apex.elevation / 2);
    assert.ok(Math.abs(signedAngle(arch.ends[1] - arch.ends[0]) - 180) < 1e-9 || Math.abs(signedAngle(arch.ends[1] - arch.ends[0]) + 180) < 1e-9);
    assert.equal(arch.flat, arch.apex.elevation < ARCH_MIN_ELEVATION);
  }
});

test("不计折射时银拱两端就是银道与地平线的交点", () => {
  const plan = { ...initialPlan, refraction: "none", latitude: 35.4172, longitude: 138.8729, instant: "2026-08-12T13:30:00Z" };
  const arch = milkyWayArch(plan), points = sampled(plan);
  const crossings = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.sign(a.elevation) !== Math.sign(b.elevation)) crossings.push(a.azimuth);
  }
  assert.equal(crossings.length, 2);
  for (const end of arch.ends)
    assert.ok(crossings.some((azimuth) => Math.abs(signedAngle(azimuth - end)) <= 0.05), `${end} vs ${crossings}`);
});

test("银极接近天顶时银河贴近地平线，不提供银拱朝向", () => {
  // The north galactic pole (Dec +27.13°) culminates overhead at latitude 27.13° N.
  let lowest = null;
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    const instant = new Date(Date.parse("2026-03-21T00:00:00Z") + minute * 60_000).toISOString();
    const arch = milkyWayArch({ ...initialPlan, latitude: 27.13, longitude: 0, instant, refraction: "standard" });
    if (!lowest || arch.apex.elevation < lowest.apex.elevation) lowest = arch;
  }
  assert.ok(lowest.apex.elevation < 2, `${lowest.apex.elevation}`);
  assert.equal(lowest.flat, true);
});
