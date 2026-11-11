import { Temporal } from "@js-temporal/polyfill";
import { Body, Equator, Horizon, KM_PER_AU, MakeTime, MoonPhase, Observer, ObserverVector, RotateVector, Rotation_EQJ_HOR, Vector } from "astronomy-engine";
import { discOverlap, earthShadow, eclipseSkyElevation, lunarLight } from "./eclipse-geometry.ts";
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

/** Topocentric geometric position without refraction; discs and paths share it. */
export function topocentric(body: Body.Sun | Body.Moon, date: Date, observer: Observer) {
  const equator = Equator(body, date, observer, true, true);
  return { equator, horizon: Horizon(date, observer, equator.ra, equator.dec) };
}

function position(body: Body.Sun | Body.Moon, ctx: ReturnType<typeof observerContext>) {
  const { equator, horizon } = topocentric(body, ctx.date, ctx.observer);
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

export interface EarthShadowView {
  /** Topocentric direction of the shadow axis level with the Moon. */
  direction: Vector3;
  /** Angular radii seen by the observer, degrees. */
  umbra: number;
  penumbra: number;
}

/**
 * Earth's shadow as seen on the Moon near full Moon. The offset between the
 * shadow axis and the Moon's centre is taken from one geometric pipeline and
 * applied to the Moon's drawn direction, so the two stay registered.
 */
function moonShadow(ctx: ReturnType<typeof observerContext>, moonDirection: Vector3) {
  const time = MakeTime(ctx.date), shadow = earthShadow(time);
  const site = ObserverVector(time, ctx.observer, false), rotation = Rotation_EQJ_HOR(time, ctx.observer);
  const horizontal = (point: readonly number[]): Vector3 => {
    const local = RotateVector(rotation, new Vector(point[0] / KM_PER_AU - site.x, point[1] / KM_PER_AU - site.y, point[2] / KM_PER_AU - site.z, time));
    // Horizontal axes: x north, y west, z zenith; ours are east, north, up.
    return [-local.y * KM_PER_AU, local.x * KM_PER_AU, local.z * KM_PER_AU];
  };
  const axis = horizontal(shadow.centre), moon = horizontal(shadow.moon), range = Math.hypot(...axis);
  const view: EarthShadowView = {
    direction: unit(add(moonDirection, add(unit(axis), scale(unit(moon), -1)))),
    umbra: Math.asin(Math.min(1, shadow.umbra / range)) / degrees,
    penumbra: Math.asin(Math.min(1, shadow.penumbra / range)) / degrees,
  };
  return { view, light: lunarLight(shadow.distance, shadow.umbra, shadow.penumbra) };
}

export function celestialBodies(plan: PositionInput) {
  const ctx = observerContext(plan);
  const sunPlace = position(Body.Sun, ctx);
  const moon = position(Body.Moon, ctx);
  // Share of the Sun's disc the Moon covers for this observer.
  const separation = Math.acos(Math.max(-1, Math.min(1, dot(sunPlace.direction, moon.direction)))) / degrees;
  const obscuration = discOverlap(sunPlace.angularRadius, moon.angularRadius, separation);
  const sun = { id: "sun" as const, ...sunPlace, obscuration, skyElevation: eclipseSkyElevation(sunPlace.elevation, obscuration) };
  const lightDirection = unit(add(scale(sun.direction, sun.distanceKm), scale(moon.direction, -moon.distanceKm)));
  const illuminatedFraction = Math.max(0, Math.min(1, (1 - dot(lightDirection, moon.direction)) / 2));
  const phaseAngle = MoonPhase(ctx.date);
  // Lunar eclipses happen within a few degrees of full Moon.
  const eclipse = Math.abs(phaseAngle - 180) < 20 ? moonShadow(ctx, moon.direction) : null;
  return {
    sun,
    moon: {
      id: "moon" as const, ...moon, lightDirection, illuminatedFraction, phaseAngle,
      /** Earth's shadow near full Moon; undefined otherwise. */
      shadow: eclipse?.view,
      /** Share of normal moonlight left by a lunar eclipse (1 without one). */
      brightness: eclipse?.light ?? 1,
    },
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
