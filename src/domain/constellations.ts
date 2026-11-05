import figures from "../data/constellations.json" with { type: "json" };
import support from "../data/constellation-stars.json" with { type: "json" };
import type { ShootingPlan } from "./plan.ts";
import { skyReference } from "./starfield.ts";
import type { Row, SkyPoint } from "./starfield.ts";
import { degrees, dot, unit } from "./ephemeris.ts";
import type { Vector3 } from "./ephemeris.ts";
import { refractDirection } from "./refraction.ts";

export const constellationCount = 88;
export const constellationFigureCount = figures.constellations.length;

/** Great-circle sampling before refraction; never interpolate image pixels. */
export function greatCircleSamples(a: Vector3, b: Vector3) {
  if (
    !a.every(Number.isFinite) ||
    !b.every(Number.isFinite) ||
    Math.hypot(...a) < 1e-12 ||
    Math.hypot(...b) < 1e-12
  )
    throw new RangeError("星座连线需要有效方向");
  a = unit(a);
  b = unit(b);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b)))),
    sine = Math.sin(angle);
  if (angle > Math.PI - 1e-6) throw new RangeError("星座连线不能连接对跖点");
  const count = Math.max(1, Math.ceil(angle / degrees)),
    points: Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count,
      first = angle < 1e-8 ? 1 - t : Math.sin((1 - t) * angle) / sine,
      second = angle < 1e-8 ? t : Math.sin(t * angle) / sine;
    points.push(
      unit([
        a[0] * first + b[0] * second,
        a[1] * first + b[1] * second,
        a[2] * first + b[2] * second,
      ]),
    );
  }
  return points;
}
let cachedKey = "",
  cached: { vertices: Float32Array; anchors: SkyPoint[] } | undefined;
export function constellationScene(plan: ShootingPlan) {
  const key = [
    plan.latitude,
    plan.longitude,
    plan.instant,
    plan.refraction,
  ].join("/");
  if (cached && key === cachedKey) return cached;
  const sky = skyReference(plan),
    points = new Map(sky.points.map((p) => [p.id, p]));
  for (const row of support.stars as Row[]) {
    const p = sky.star(row);
    points.set(p.id, p);
  }
  const vertices: number[] = [],
    anchors: SkyPoint[] = [];
  for (const figure of figures.constellations) {
    for (const path of figure.paths)
      for (let i = 1; i < path.length; i++) {
        const a = points.get(`hyg-${path[i - 1]}`),
          b = points.get(`hyg-${path[i]}`);
        if (!a || !b) throw new Error("星座端点数据缺失");
        const samples = greatCircleSamples(a.direction, b.direction).map(
          (ray) => refractDirection(ray, plan.refraction),
        );
        for (let j = 1; j < samples.length; j++)
          vertices.push(...samples[j - 1], ...samples[j]);
      }
    // Aim at the figure itself. Atlas label positions can sit above the stars
    // and would crop e.g. Orion's feet when used as a photography target.
    const ids = [...new Set(figure.paths.flat())];
    const ray = unit(
      ids.reduce(
        (sum, id) => {
          const p = points.get(`hyg-${id}`)!;
          return [
            sum[0] + p.direction[0],
            sum[1] + p.direction[1],
            sum[2] + p.direction[2],
          ];
        },
        [0, 0, 0] as [number, number, number],
      ),
    );
    anchors.push({
      id: `constellation-${figure.id}`,
      name: figure.name,
      direction: ray,
      azimuth: (Math.atan2(ray[0], ray[1]) / degrees + 360) % 360,
      elevation: Math.asin(ray[2]) / degrees,
      magnitude: 0,
      color: [0.92, 0.82, 0.61],
    });
  }
  cachedKey = key;
  cached = { vertices: new Float32Array(vertices), anchors };
  return cached;
}
