import { Refraction } from "astronomy-engine";
import type { Vector3 } from "./ephemeris.ts";
import { degrees, direction } from "./ephemeris.ts";

export type RefractionMode = "standard" | "none";

export function apparentElevation(elevation: number, mode: RefractionMode = "none") {
  if (!Number.isFinite(elevation) || Math.abs(elevation) > 90)
    throw new RangeError("折射需要 −90° 至 +90° 的几何高度");
  if (mode === "none") return elevation;
  return Math.min(90, elevation + Math.max(0, Refraction("normal", elevation)));
}

export function refractDirection(ray: Vector3, mode: RefractionMode = "none"): Vector3 {
  if (mode === "none") return ray;
  const elevation = Math.asin(Math.max(-1, Math.min(1, ray[2] / Math.hypot(...ray)))) / degrees;
  const azimuth = Math.atan2(ray[0], ray[1]) / degrees;
  return direction(azimuth, apparentElevation(elevation, mode));
}
