import {
  AstroTime,
  Body,
  C_AUDAY,
  Equator,
  HelioState,
  Horizon,
  Illumination,
  RotateVector,
  Rotation_EQJ_HOR,
  Rotation_GAL_EQJ,
  Vector,
} from "astronomy-engine";
import catalog from "../data/bright-stars.json" with { type: "json" };
import type { ShootingPlan } from "./plan.ts";
import {
  degrees,
  direction,
  dot,
  observerContext,
  celestialBodies,
  unit,
} from "./ephemeris.ts";
import type { Vector3 } from "./ephemeris.ts";
import { refractDirection } from "./refraction.ts";
import { projectDirection } from "./celestial-projection.ts";
import type { Occlusion } from "./visibility.ts";

export const primarySkyNames = ["北极星", "牛郎星", "织女星", "金星", "木星"];
export const starCount = catalog.stars.length;
export interface SkyPoint {
  id: string;
  name?: string;
  azimuth: number;
  elevation: number;
  direction: Vector3;
  magnitude: number;
  color: readonly [number, number, number];
}
export interface SkyVisibility {
  planKey: string;
  ready: boolean;
  view: { azimuth: number; pitch: number } | null;
  states: Record<string, Occlusion>;
  message?: string;
  orbitKey?: string;
  milkyWay?: { phase: "off" | "loading" | "ready" | "error"; message?: string };
  deepSky?: { phase: "off" | "loading" | "ready" | "error"; message?: string };
  deepSkyTargets?: Record<string, { phase: "off" | "loading" | "ready" | "error"; message?: string }>;
}
export const emptySkyVisibility: SkyVisibility = {
  planKey: "",
  ready: false,
  view: null,
  states: {},
};
export type Row = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number | null,
];
type Input = Pick<ShootingPlan, "latitude" | "longitude" | "instant">;
const names: Record<string, string> = catalog.names;
const AU_PER_PC = 648000 / Math.PI;
const equatorial = (ra: number, dec: number): Vector3 => [
  Math.cos(dec * degrees) * Math.cos(ra * 15 * degrees),
  Math.cos(dec * degrees) * Math.sin(ra * 15 * degrees),
  Math.sin(dec * degrees),
];
const apply = (m: number[], v: Vector3): Vector3 =>
  [0, 1, 2].map(
    (i) => m[i] * v[0] + m[i + 3] * v[1] + m[i + 6] * v[2],
  ) as unknown as Vector3;
const aberrate = (v: Vector3, beta: Vector3): Vector3 =>
  unit(v.map((x, i) => x + beta[i] - dot(v, beta) * x) as unknown as Vector3);
const colour = (ci: number | null): SkyPoint["color"] =>
  ci !== null && ci < 0
    ? [0.8, 0.88, 1]
    : ci !== null && ci > 0.9
      ? [1, 0.8, 0.62]
      : [1, 0.96, 0.88];

let cached: ReturnType<typeof computeSky> | undefined,
  cachedKey = "";
function computeSky(plan: Input) {
  const { date, observer } = observerContext(plan),
    time = new AstroTime(date);
  const rotation = Rotation_EQJ_HOR(time, observer),
    earth = HelioState(Body.Earth, time);
  const beta: Vector3 = [
    earth.vx / C_AUDAY,
    earth.vy / C_AUDAY,
    earth.vz / C_AUDAY,
  ];
  const matrix = [
    new Vector(1, 0, 0, time),
    new Vector(0, 1, 0, time),
    new Vector(0, 0, 1, time),
  ].flatMap((v) => {
    const p = RotateVector(rotation, v);
    return [-p.y, p.x, p.z];
  });
  const horizontal = (eqj: Vector3) => unit(apply(matrix, aberrate(eqj, beta)));
  const point = (
    id: string,
    eqj: Vector3,
    magnitude: number,
    color: SkyPoint["color"],
    name?: string,
  ): SkyPoint => {
    const ray = horizontal(eqj);
    return {
      id,
      name,
      magnitude,
      color,
      direction: ray,
      azimuth: (Math.atan2(ray[0], ray[1]) / degrees + 360) % 360,
      elevation: Math.asin(Math.max(-1, Math.min(1, ray[2]))) / degrees,
    };
  };
  const star = ([id, ra, dec, dist, vx, vy, vz, mag, ci]: Row) => {
    const initial = equatorial(ra, dec),
      years = time.ut / 365.25;
    const pos = unit(
      initial.map(
        (x, i) =>
          x * dist +
          [vx, vy, vz][i] * years -
          [earth.x, earth.y, earth.z][i] / AU_PER_PC,
      ) as unknown as Vector3,
    );
    return point(`hyg-${id}`, pos, mag, colour(ci), names[`hyg-${id}`]);
  };
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
  // Gordon et al. (2022), ICRF3 axes, position epoch 2015.0. Fixed reference.
  const core = point(
    "galactic-center",
    equatorial(17 + 45 / 60 + 40.034047 / 3600, -29 - 28.21601 / 3600),
    0,
    [1, 0.77, 0.8],
    "银心",
  );
  const bodies = celestialBodies(plan);
  return {
    points,
    core,
    horizontal,
    time,
    sunElevation: bodies.sun.elevation,
    moon: bodies.moon,
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

export function skyPointView(plan: ShootingPlan, point: SkyPoint) {
  const ray = refractDirection(point.direction, plan.refraction),
    pixel = projectDirection(plan, ray);
  const state =
    ray[2] <= 0
      ? "地平线下"
      : !pixel || Math.abs(pixel.x) > 1 || Math.abs(pixel.y) > 1
        ? "视场外"
        : "画面内";
  return { ray, pixel, state };
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
  const sky = skyReference(plan),
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
