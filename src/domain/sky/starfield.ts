// The bright-star catalogue (HYG, data/bright-stars.json) with Venus and
// Jupiter, on the sky frame of sky-frame.ts. Read with the star layers or the
// target search (docs/plan/lazy-loading.md); the frame, the point types and
// skyPointView are re-exported here for the modules that need the stars too.
import {
  Equator,
  Horizon,
  Illumination,
  Body,
  RotateVector,
  Rotation_GAL_EQJ,
  Vector,
} from "astronomy-engine";
import catalog from "../../data/bright-stars.json" with { type: "json" };
import type { ShootingPlan } from "../core/plan.ts";
import { degrees, direction } from "../core/ephemeris.ts";
import { refractDirection } from "../core/refraction.ts";
import { skyFrame } from "./sky-frame.ts";
import type { Row, SkyPoint } from "./sky-frame.ts";

export { emptySkyVisibility, skyFrame, skyPointView } from "./sky-frame.ts";
export type { Row, SkyPoint, SkyVisibility } from "./sky-frame.ts";

export const primarySkyNames = ["北极星", "牛郎星", "织女星", "金星", "木星"];
export const starCount = catalog.stars.length;
type Input = Pick<ShootingPlan, "latitude" | "longitude" | "instant">;
const names: Record<string, string> = catalog.names;

let cached: ReturnType<typeof computeSky> | undefined,
  cachedKey = "";
function computeSky(plan: Input) {
  const frame = skyFrame(plan),
    { time, observer } = frame;
  const star = (row: Row) => frame.star(row, names[`hyg-${row[0]}`]);
  const points = (catalog.stars as Row[]).map(star);
  for (const [body, id, name, color] of [
    [Body.Venus, "venus", "金星", [1, 0.96, 0.86]],
    [Body.Jupiter, "jupiter", "木星", [1, 0.87, 0.69]],
  ] as const) {
    const eq = Equator(body, time, observer, true, true),
      hor = Horizon(time, observer, eq.ra, eq.dec);
    points.push({
      id,
      name,
      color,
      magnitude: Illumination(body, time).mag,
      azimuth: hor.azimuth,
      elevation: hor.altitude,
      direction: direction(hor.azimuth, hor.altitude),
    });
  }
  return {
    points,
    core: frame.core,
    horizontal: frame.horizontal,
    time,
    sunElevation: frame.sunElevation,
    moon: frame.moon,
    star,
  };
}
export function skyReference(plan: Input) {
  const key = [plan.latitude, plan.longitude, plan.instant].join("/");
  if (key !== cachedKey || !cached) {
    cached = computeSky(plan);
    cachedKey = key;
  }
  return cached;
}

export const skyPointSize = (point: SkyPoint) =>
  point.id === "galactic-center"
    ? 8
    : Math.max(1.2, Math.min(6, 4.8 - 0.65 * (point.magnitude + 1.5)));

let bandKey = "",
  bandCache: { vertices: Float32Array; indices: Uint16Array } | undefined;
export function milkyWayMesh(plan: ShootingPlan) {
  const key = [
    plan.latitude,
    plan.longitude,
    plan.instant,
    plan.refraction,
  ].join("/");
  if (key === bandKey && bandCache) return bandCache;
  const sky = skyFrame(plan),
    rotation = Rotation_GAL_EQJ();
  const vertices: number[] = [],
    indices: number[] = [];
  for (let l = 0; l <= 360; l++)
    for (let b = -24; b <= 24; b++) {
      const latitude = b * degrees,
        longitude = l * degrees;
      const p = RotateVector(
        rotation,
        new Vector(
          Math.cos(latitude) * Math.cos(longitude),
          Math.cos(latitude) * Math.sin(longitude),
          Math.sin(latitude),
          sky.time,
        ),
      );
      const ray = refractDirection(
        sky.horizontal([p.x, p.y, p.z]),
        plan.refraction,
      );
      vertices.push(...ray, longitude, latitude);
    }
  for (let l = 0; l < 360; l++)
    for (let b = 0; b < 48; b++) {
      const a = l * 49 + b,
        c = a + 49;
      indices.push(a, c, a + 1, a + 1, c, c + 1);
    }
  bandKey = key;
  bandCache = {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
  };
  return bandCache;
}
