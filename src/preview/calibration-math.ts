import type { ShootingPlan } from "../domain/plan.ts";
import { projectDirection } from "../domain/celestial-projection.ts";
import { ellipsoidalRay } from "../domain/geodesy.ts";

type Point = { longitude: number; latitude: number; altitude: number };
const radians = Math.PI / 180;
// Match the spherical Mercator renderer; the spherical comparison below is
// deliberately a model comparison, not an ellipsoidal surveying reference.
const radius = 6371008.8;
export function mercatorXY(point: { longitude: number; latitude: number }) {
  return [(point.longitude + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + point.latitude * radians / 2)) / Math.PI) / 2];
}
export function mercatorMeter(latitude: number) { return 1 / (2 * Math.PI * radius * Math.cos(latitude * radians)); }

export function referenceRay(eye: Point, target: Point, spherical = false, scaleLatitude = eye.latitude): [number, number, number] {
  if (!spherical) {
    const a = mercatorXY(eye), b = mercatorXY(target), scale = mercatorMeter(scaleLatitude);
    // Use the nearest world copy, including the antimeridian.
    const dx = b[0] - a[0];
    return [(dx - Math.round(dx)) / scale, (a[1] - b[1]) / scale, target.altitude - eye.altitude];
  }
  const a = eye.latitude * radians, b = target.latitude * radians, d = (target.longitude - eye.longitude) * radians;
  const r = radius + target.altitude;
  return [r * Math.cos(b) * Math.sin(d), r * (Math.sin(b) * Math.cos(a) - Math.cos(b) * Math.sin(a) * Math.cos(d)),
    r * (Math.sin(b) * Math.sin(a) + Math.cos(b) * Math.cos(a) * Math.cos(d)) - radius - eye.altitude];
}
export function rayAngles(ray: [number, number, number]) {
  return { azimuth: (Math.atan2(ray[0], ray[1]) / radians + 360) % 360, pitch: Math.atan2(ray[2], Math.hypot(ray[0], ray[1])) / radians };
}
export function referencePixel(plan: ShootingPlan, ground: number, target: Point, width: number, height: number, spherical = false, scaleLatitude = plan.latitude) {
  const ray = referenceRay({ ...plan, altitude: ground + plan.cameraHeight }, target, spherical, scaleLatitude);
  const point = projectDirection(plan, ray);
  return point ? { x: (point.x + 1) * width / 2, y: (point.y + 1) * height / 2 } : null;
}

/** Conditional model comparison: the caller must disclose the height assumption. */
export function compareEarthModels(plan: ShootingPlan, eye: Point, target: Point, width: number, height: number, scaleLatitude = eye.latitude) {
  const ellipsoid = ellipsoidalRay(
    { ...eye, ellipsoidalHeight: eye.altitude }, { ...target, ellipsoidalHeight: target.altitude });
  const rays = {
    mercator: referenceRay(eye, target, false, scaleLatitude),
    sphere: referenceRay(eye, target, true),
    ellipsoid,
    // Hold the ellipsoidal horizontal components fixed to isolate the change
    // in Up from curvature. This control is not another geographic projection.
    tangentControl: [ellipsoid[0], ellipsoid[1], target.altitude - eye.altitude] as [number, number, number],
  };
  const model = (ray: [number, number, number]) => {
    const point = projectDirection(plan, ray);
    return { ray, ...rayAngles(ray), distance: Math.hypot(...ray),
      pixel: point ? { x: (point.x + 1) * width / 2, y: (point.y + 1) * height / 2 } : null };
  };
  return {
    verticalDrop: target.altitude - eye.altitude - ellipsoid[2],
    mercator: model(rays.mercator), sphere: model(rays.sphere),
    ellipsoid: model(rays.ellipsoid), tangentControl: model(rays.tangentControl),
  };
}

export function matrixPixel(matrix: ArrayLike<number>, target: Point, worldSize: number, width: number, height: number) {
  const p = mercatorXY(target), vector = [p[0] * worldSize, p[1] * worldSize, target.altitude, 1];
  const clip = [0, 1, 2, 3].map((r) => vector.reduce((sum, value, c) => sum + value * matrix[c * 4 + r], 0));
  if (clip[3] <= 0) return null;
  return { x: (clip[0] / clip[3] + 1) * width / 2, y: (1 - clip[1] / clip[3]) * height / 2 };
}
