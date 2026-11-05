import { Temporal } from "@js-temporal/polyfill";
import { Body, Equator, Horizon, KM_PER_AU, MoonPhase, Observer } from "astronomy-engine";
import type { ShootingPlan } from "./plan.ts";

type PositionInput = Pick<ShootingPlan, "latitude" | "longitude" | "instant">;
export type Vector3 = readonly [number, number, number];
export const dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const scale = (a: Vector3, amount: number): Vector3 => [a[0] * amount, a[1] * amount, a[2] * amount];
export const add = (a: Vector3, b: Vector3): Vector3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const unit = (a: Vector3): Vector3 => scale(a, 1 / Math.hypot(...a));
export const degrees = Math.PI / 180;

export function direction(azimuth: number, elevation: number): Vector3 {
  const az = azimuth * degrees, el = elevation * degrees;
  return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
}

export function observerContext(plan: PositionInput) {
  if (!Number.isFinite(plan.latitude) || Math.abs(plan.latitude) > 90 ||
    !Number.isFinite(plan.longitude) || Math.abs(plan.longitude) > 180)
    throw new RangeError("日月位置需要有效的经纬度");
  const timestamp = Temporal.Instant.from(plan.instant).epochMilliseconds;
  if (timestamp < Date.UTC(1900, 0, 1) - 14 * 3600000 || timestamp >= Date.UTC(2101, 0, 1) + 12 * 3600000)
    throw new RangeError("日月模型支持 1900—2100 年的当地日期");
  // Reference ellipsoid height, not the DEM's unverified vertical datum.
  return { date: new Date(timestamp), observer: new Observer(plan.latitude, plan.longitude, 0) };
}

function position(body: Body.Sun | Body.Moon, ctx: ReturnType<typeof observerContext>) {
  const equator = Equator(body, ctx.date, ctx.observer, true, true);
  const horizon = Horizon(ctx.date, ctx.observer, equator.ra, equator.dec);
  const distanceKm = equator.dist * KM_PER_AU;
  const radiusKm = body === Body.Sun ? 695700 : 1737.4;
  return {
    azimuth: horizon.azimuth,
    elevation: horizon.altitude,
    distanceKm,
    angularRadius: Math.asin(radiusKm / distanceKm) / degrees,
    direction: direction(horizon.azimuth, horizon.altitude),
  };
}

export function sunPosition(plan: PositionInput) {
  const sun = position(Body.Sun, observerContext(plan));
  return { azimuth: sun.azimuth, elevation: sun.elevation };
}

export function celestialBodies(plan: PositionInput) {
  const ctx = observerContext(plan);
  const sun = { id: "sun" as const, ...position(Body.Sun, ctx) };
  const moon = position(Body.Moon, ctx);
  const lightDirection = unit(add(scale(sun.direction, sun.distanceKm), scale(moon.direction, -moon.distanceKm)));
  const illuminatedFraction = Math.max(0, Math.min(1, (1 - dot(lightDirection, moon.direction)) / 2));
  return {
    sun,
    moon: { id: "moon" as const, ...moon, lightDirection, illuminatedFraction, phaseAngle: MoonPhase(ctx.date) },
  };
}

export type SkyBody = ReturnType<typeof celestialBodies>["sun" | "moon"];

export function moonPhaseLabel(phase: number) {
  if (phase < 5 || phase >= 355) return "新月附近";
  if (phase < 85) return "盈月牙";
  if (phase < 95) return "上弦附近";
  if (phase < 175) return "盈凸月";
  if (phase < 185) return "满月附近";
  if (phase < 265) return "亏凸月";
  if (phase < 275) return "下弦附近";
  return "残月";
}
