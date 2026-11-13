import { Body, HelioVector, ObserverVector } from "astronomy-engine";
import type { ShootingPlan } from "../core/plan.ts";
import { observerContext } from "../core/ephemeris.ts";
import { skyReference } from "../sky/starfield.ts";
import type { SkyPoint } from "../sky/starfield.ts";
import { DARK_SKY_MAGNITUDE, skyAppearance } from "../sky/sky-appearance.ts";
import {
  AU_KM, C_AU_PER_DAY, GM_SUN, cometState, comaDiameterKm, heliocentricMagnitude, magnitudeLaw, propagate,
  tailLengthAu, totalMagnitude,
} from "./comet-orbit.ts";
import type { Vector3 } from "./comet-orbit.ts";
import type { Comet, CometCatalog } from "./comet-catalog.ts";
export type { Comet, CometCatalog } from "./comet-catalog.ts";

/** Comets fainter than this at the shooting instant are not listed or drawn. */
export const COMET_LIST_LIMIT = 12;
/** Radial solar-wind speed that bends the ion tail away from the anti-solar direction. */
export const SOLAR_WIND_KM_S = 400;
/** Radiation pressure over gravity for the dust drawn as the tail axis (syndyne). */
export const DUST_BETA = 0.5;
/** Dust tail length as a share of the empirical tail length; the ion tail takes the full length. */
export const DUST_SHARE = 0.5;
/**
 * Upper bound of the dust tail, au (about 45 million km). Following a single
 * syndyne to half of a very long empirical length reaches dust released
 * months earlier, which bends far from the tail observers report (Hale-Bopp).
 */
export const DUST_MAX_AU = 0.3;
/**
 * The tail fades by three e-folds over its empirical length, so at the end of
 * the length it is about 3.26 magnitudes below its brightness at the head. On
 * the natural dark sky the empirical length is shown in full; each magnitude
 * the sky brightens (twilight, Moon, light pollution) hides a further 1/3.26
 * of it.
 */
export const TAIL_FADE_MAGNITUDES = 3 * 2.5 * Math.LOG10E;
const SAMPLES = 40;
/** Oldest dust followed along the syndyne, days. */
const MAX_DUST_AGE = 365;
const DAY = 86_400_000;
const RAD = Math.PI / 180;

const sub = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a: Vector3, b: Vector3, s: number): Vector3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const norm = (a: Vector3) => Math.hypot(a[0], a[1], a[2]);
const unitOf = (a: Vector3): Vector3 => { const n = norm(a); return [a[0] / n, a[1] / n, a[2] / n]; };
const angleBetween = (a: Vector3, b: Vector3) =>
  Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b))))) / RAD;

export interface TailSample {
  /** Topocentric direction, horizontal frame, without refraction. */
  ray: Vector3;
  /** Half width of the tail across the axis, radians. */
  halfWidth: number;
  /** Position along the empirical length, 0 at the head and 1 at its end. */
  at: number;
}
export interface CometView {
  comet: Comet;
  point: SkyPoint;
  magnitude: number;
  /** Distance from the Sun and from the observer, au. */
  r: number;
  delta: number;
  /** The magnitude law is applied outside the nights it was fitted to. */
  extrapolated: boolean;
  /** Visual coma radius, degrees. */
  comaRadius: number;
  ionAu: number;
  dustAu: number;
  /** Angular distance from the head to the end of each tail on a dark sky, degrees. */
  ionDegrees: number;
  dustDegrees: number;
  ion: TailSample[];
  dust: TailSample[];
}
export interface CometScene {
  key: string;
  /** Catalogue comets whose apparition window contains the instant. */
  inWindow: number;
  views: CometView[];
  /** Sky brightening over the natural dark sky, magnitudes. */
  skyFade: number;
  /** Share of each tail's length above the sky background. */
  visibleShare: number;
}

export const inWindow = (comet: Comet, time: number) =>
  time >= Date.parse(`${comet.window.from}T00:00:00Z`) && time < Date.parse(`${comet.window.to}T00:00:00Z`) + DAY;
const observedSpan = (comet: Comet, time: number) =>
  time >= Date.parse(`${comet.observed.from}T00:00:00Z`) && time < Date.parse(`${comet.observed.to}T00:00:00Z`) + DAY;

/**
 * Point on the syndyne of dust released `age` days before `jd` with zero
 * relative speed; radiation pressure reduces the Sun's attraction by β.
 */
function dustAt(comet: Comet, jd: number, age: number) {
  if (age <= 0) return cometState(comet.orbit, jd).r;
  const release = cometState(comet.orbit, jd - age);
  return propagate(release.r, release.v, age, GM_SUN * (1 - DUST_BETA)).r;
}

let cachedKey = "", cached: CometScene | undefined, cachedCatalog: CometCatalog | undefined;
/** Comets brighter than the list limit at the instant, with their tails as sky directions. */
export function cometScene(plan: Pick<ShootingPlan, "latitude" | "longitude" | "instant">, catalog: CometCatalog, artificialMcd = 0): CometScene {
  const key = [plan.latitude, plan.longitude, plan.instant, artificialMcd, catalog.fetchedAt, catalog.comets.length].join("/");
  if (cached && key === cachedKey && catalog === cachedCatalog) return cached;
  const sky = skyReference(plan), { observer } = observerContext(plan), time = sky.time;
  const appearance = skyAppearance(sky.sunElevation, sky.moon, artificialMcd);
  const skyFade = Math.max(0, DARK_SKY_MAGNITUDE - appearance.displayMagnitude);
  const earth = HelioVector(Body.Earth, time), site = ObserverVector(time, observer, false);
  const origin: Vector3 = [earth.x + site.x, earth.y + site.y, earth.z + site.z];
  const jd = 2451545 + time.tt, instant = Date.parse(plan.instant);
  const solarWind = (SOLAR_WIND_KM_S * 86_400) / AU_KM;
  const toRay = (heliocentric: Vector3) => sky.horizontal(sub(heliocentric, origin));
  const views: CometView[] = [];
  let windowCount = 0;
  for (const comet of catalog.comets) {
    if (!inWindow(comet, instant)) continue;
    windowCount++;
    let lightTime = 0, state = cometState(comet.orbit, jd), toComet = sub(state.r, origin);
    for (let k = 0; k < 3; k++) {
      lightTime = norm(toComet) / C_AU_PER_DAY;
      state = cometState(comet.orbit, jd - lightTime);
      toComet = sub(state.r, origin);
    }
    const emitted = jd - lightTime, r = norm(state.r), delta = norm(toComet);
    const law = magnitudeLaw(comet.photometry, comet.orbit.tp, emitted);
    const magnitude = totalMagnitude(law, r, delta);
    if (!(magnitude <= COMET_LIST_LIMIT)) continue;
    const helio = heliocentricMagnitude(law, r);
    const length = tailLengthAu(helio, r), comaAu = comaDiameterKm(helio, r) / 2 / AU_KM;
    const head = toRay(state.r);
    const ray: SkyPoint = {
      id: `comet-${comet.key.replace(/[^\w]+/g, "-")}`, name: comet.name, magnitude, color: [0.82, 1, 0.88], direction: head,
      azimuth: (Math.atan2(head[0], head[1]) / RAD + 360) % 360, elevation: Math.asin(Math.max(-1, Math.min(1, head[2]))) / RAD,
    };
    // Ion tail: straight along the solar wind as seen from the moving comet.
    const ionAxis = unitOf(sub([state.r[0] / r * solarWind, state.r[1] / r * solarWind, state.r[2] / r * solarWind], state.v));
    const ion: TailSample[] = [];
    for (let k = 0; k <= SAMPLES; k++) {
      const at = k / SAMPLES, point = addScaled(state.r, ionAxis, at * length);
      ion.push({ ray: toRay(point), halfWidth: (0.4 * comaAu + 0.035 * at * length) / norm(sub(point, origin)), at });
    }
    // Dust tail: the β syndyne, cut where it reaches its share of the length.
    const dustLength = Math.min(DUST_SHARE * length, DUST_MAX_AU);
    const reach = (age: number) => norm(sub(dustAt(comet, emitted, age), state.r));
    let low = 0, high = 1;
    while (reach(high) < dustLength && high < MAX_DUST_AGE) { low = high; high = Math.min(MAX_DUST_AGE, high * 2); }
    if (reach(high) >= dustLength)
      for (let k = 0; k < 40; k++) { const mid = (low + high) / 2; if (reach(mid) < dustLength) low = mid; else high = mid; }
    const dust: TailSample[] = [];
    for (let k = 0; k <= SAMPLES; k++) {
      // Distance grows roughly with the square of the age, so ages are spaced by their square root.
      const point = dustAt(comet, emitted, high * Math.sqrt(k / SAMPLES));
      const at = dustLength > 0 ? Math.min(1, norm(sub(point, state.r)) / dustLength) : 0;
      dust.push({ ray: toRay(point), halfWidth: (0.6 * comaAu + 0.12 * at * dustLength) / norm(sub(point, origin)), at });
    }
    views.push({
      comet, point: ray, magnitude, r, delta,
      extrapolated: !observedSpan(comet, instant) || comet.fit[emitted < comet.orbit.tp ? "pre" : "post"].source !== "cobs",
      comaRadius: Math.atan(comaAu / delta) / RAD,
      ionAu: length, dustAu: dustLength,
      ionDegrees: angleBetween(head, ion[SAMPLES].ray), dustDegrees: angleBetween(head, dust[SAMPLES].ray),
      ion, dust,
    });
  }
  views.sort((a, b) => a.magnitude - b.magnitude);
  cached = { key, inWindow: windowCount, views, skyFade, visibleShare: Math.max(0, 1 - skyFade / TAIL_FADE_MAGNITUDES) };
  cachedKey = key;
  cachedCatalog = catalog;
  return cached;
}

/** Angular distance from the head to where a tail fades into the sky, degrees. */
export function visibleTailDegrees(samples: TailSample[], visibleShare: number) {
  if (visibleShare <= 0 || samples.length < 2) return 0;
  const end = samples.findIndex((sample) => sample.at >= visibleShare);
  const last = samples[end < 0 ? samples.length - 1 : end];
  return angleBetween(samples[0].ray, last.ray);
}
