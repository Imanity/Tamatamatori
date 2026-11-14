// The sky frame without any catalogue (docs/plan/lazy-loading.md): the instant,
// the transform from J2000 equatorial directions to the observer's horizon
// (precession, nutation, rotation and annual aberration), the Galactic Centre,
// the Sun's altitude for the sky brightness and the Moon. The bright-star
// catalogue (starfield.ts), comets and the readouts build on it.
import {
  AstroTime,
  Body,
  C_AUDAY,
  HelioState,
  RotateVector,
  Rotation_EQJ_HOR,
  Vector,
} from "astronomy-engine";
import type { ShootingPlan } from "../core/plan.ts";
import {
  degrees,
  dot,
  observerContext,
  celestialBodies,
  unit,
} from "../core/ephemeris.ts";
import type { Vector3 } from "../core/ephemeris.ts";
import { refractDirection } from "../core/refraction.ts";
import { projectDirection } from "../core/celestial-projection.ts";
import type { Occlusion } from "../core/visibility.ts";

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
  occlusionUnavailable?: boolean;
  planKey: string;
  ready: boolean;
  view: { azimuth: number; pitch: number } | null;
  states: Record<string, Occlusion>;
  labelKey?: string;
  labelStates?: Record<string, Occlusion>;
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
/** A catalogue star: id, RA (h), Dec (°), distance (pc), space velocity (pc/yr), magnitude, colour index. */
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
const AU_PER_PC = 648000 / Math.PI;
export const equatorial = (ra: number, dec: number): Vector3 => [
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

let cached: ReturnType<typeof computeFrame> | undefined,
  cachedKey = "";
function computeFrame(plan: Input) {
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
  /** A catalogue star at the instant, with proper motion and parallax. */
  const star = ([id, ra, dec, dist, vx, vy, vz, mag, ci]: Row, name?: string) => {
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
    return point(`hyg-${id}`, pos, mag, colour(ci), name);
  };
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
    core,
    horizontal,
    time,
    observer,
    // Sky brightness: a solar eclipse darkens the sky like a lower Sun.
    sunElevation: bodies.sun.skyElevation,
    moon: bodies.moon,
    star,
  };
}
/** The frame at the plan's place and instant (the last one is kept). */
export function skyFrame(plan: Input) {
  const key = [plan.latitude, plan.longitude, plan.instant].join("/");
  if (key !== cachedKey || !cached) {
    cached = computeFrame(plan);
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
