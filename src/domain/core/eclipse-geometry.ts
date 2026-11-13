import { Body, GeoMoon, GeoVector, KM_PER_AU } from "astronomy-engine";
import type { AstroTime } from "astronomy-engine";

/** Radii shared with astronomy-engine so local circumstances and drawings agree. */
export const SUN_RADIUS_KM = 695_700;
export const MOON_RADIUS_KM = 1737.4;
/** Earth's mean radius plus the 88 km atmosphere astronomy-engine uses for the shadow. */
export const EARTH_SHADOW_RADIUS_KM = 6371 + 88;

export interface Disc { x: number; y: number; r: number }
export type Loop = { x: number; y: number }[];

/** Fraction of disc `a` covered by disc `b`; radii and centre distance in one unit. */
export function discOverlap(a: number, b: number, distance: number) {
  if (!(a > 0) || !(b > 0) || !(distance >= 0)) throw new RangeError("圆面相交需要正半径与非负距离");
  if (distance >= a + b) return 0;
  if (distance + a <= b) return 1;
  if (distance + b <= a) return (b * b) / (a * a);
  const x = (a * a - b * b + distance * distance) / (2 * distance);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const lens = a * a * Math.acos(Math.max(-1, Math.min(1, x / a))) - x * y +
    b * b * Math.acos(Math.max(-1, Math.min(1, (distance - x) / b))) - (distance - x) * y;
  return Math.max(0, Math.min(1, lens / (Math.PI * a * a)));
}

const SAMPLES = 96;
function arc(disc: Disc, from: number, to: number): Loop {
  const count = Math.max(4, Math.ceil(SAMPLES * Math.abs(to - from) / (2 * Math.PI)));
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = from + (to - from) * index / count;
    return { x: disc.x + disc.r * Math.cos(angle), y: disc.y + disc.r * Math.sin(angle) };
  });
}
const circle = (disc: Disc) => arc(disc, 0, 2 * Math.PI).slice(0, -1);

/** Half-angles at each centre of the chord where two overlapping circles cross. */
function crossing(a: Disc, b: Disc, distance: number) {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return {
    toward: Math.atan2(b.y - a.y, b.x - a.x),
    atA: Math.acos(clamp((a.r * a.r + distance * distance - b.r * b.r) / (2 * a.r * distance))),
    atB: Math.acos(clamp((b.r * b.r + distance * distance - a.r * a.r) / (2 * b.r * distance))),
  };
}

/**
 * Disc `a` minus disc `b` as simple polygons: the whole disc, nothing, a
 * crescent, or a ring cut into two halves along the line of centres so no
 * polygon needs a hole.
 */
export function discDifference(a: Disc, b: Disc): Loop[] {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance >= a.r + b.r) return [circle(a)];
  if (distance + a.r <= b.r) return [];
  if (distance + b.r <= a.r) {
    const toward = distance > 1e-12 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
    return [0, Math.PI].map((turn) => [
      ...arc(a, toward + turn, toward + turn + Math.PI),
      ...arc(b, toward + turn + Math.PI, toward + turn),
    ]);
  }
  const { toward, atA, atB } = crossing(a, b, distance);
  // a's limb away from b, then b's limb inside a back to the start.
  return [[
    ...arc(a, toward + atA, toward + 2 * Math.PI - atA),
    ...arc(b, toward + Math.PI + atB, toward + Math.PI - atB).slice(1, -1),
  ]];
}

/** Disc `a` intersected with disc `b`: nothing, either whole disc, or a lens. */
export function discIntersection(a: Disc, b: Disc): Loop[] {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance >= a.r + b.r) return [];
  if (distance + a.r <= b.r) return [circle(a)];
  if (distance + b.r <= a.r) return [circle(b)];
  const { toward, atA, atB } = crossing(a, b, distance);
  return [[
    ...arc(a, toward - atA, toward + atA),
    ...arc(b, toward + Math.PI - atB, toward + Math.PI + atB).slice(1, -1),
  ]];
}

/**
 * Earth's shadow at the Moon (astronomy-engine's formulation): the shadow
 * axis point level with the Moon, its distance from the Moon's centre and the
 * umbra/penumbra radii there, all in kilometres; vectors are geocentric J2000.
 */
export function earthShadow(time: AstroTime) {
  const sun = GeoVector(Body.Sun, time, true), moon = GeoMoon(time);
  const axis = [-sun.x, -sun.y, -sun.z] as const, target = [moon.x, moon.y, moon.z] as const;
  const u = (axis[0] * target[0] + axis[1] * target[1] + axis[2] * target[2]) /
    (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
  const centre = [u * axis[0] * KM_PER_AU, u * axis[1] * KM_PER_AU, u * axis[2] * KM_PER_AU] as const;
  const moonKm = [target[0] * KM_PER_AU, target[1] * KM_PER_AU, target[2] * KM_PER_AU] as const;
  return {
    centre,
    moon: moonKm,
    distance: Math.hypot(centre[0] - moonKm[0], centre[1] - moonKm[1], centre[2] - moonKm[2]),
    umbra: SUN_RADIUS_KM - (1 + u) * (SUN_RADIUS_KM - EARTH_SHADOW_RADIUS_KM),
    penumbra: -SUN_RADIUS_KM + (1 + u) * (SUN_RADIUS_KM + EARTH_SHADOW_RADIUS_KM),
  };
}

/**
 * Display share of normal moonlight during a lunar eclipse: the part of the
 * disc outside the umbra, dimmed across the penumbra. A display weight, not
 * photometry; the umbral glow depends on Earth's atmosphere and is not
 * predicted.
 */
export function lunarLight(distance: number, umbra: number, penumbra: number) {
  if (distance >= penumbra + MOON_RADIUS_KM) return 1;
  const covered = distance >= umbra + MOON_RADIUS_KM ? 0 : discOverlap(MOON_RADIUS_KM, umbra, distance);
  const penumbral = Math.max(0, Math.min(1, (distance - umbra) / (penumbra - umbra)));
  return Math.max(0.002, (1 - covered) * (0.3 + 0.7 * penumbral));
}

/**
 * Approximate horizontal illuminance (log10 lux) against the Sun's centre
 * elevation: a monotone display table for twilight and daylight, not a
 * photometric model.
 */
const daylight = [
  [-18, -3], [-12, -2], [-6, 0.5], [-3, 1.6], [0, 2.7], [5, 3.8], [10, 4.2], [20, 4.6], [30, 4.8], [60, 5], [90, 5.05],
] as const;
export function daylightLog(elevation: number) {
  if (elevation <= daylight[0][0]) return daylight[0][1];
  for (let index = 1; index < daylight.length; index++) {
    const [h1, l1] = daylight[index], [h0, l0] = daylight[index - 1];
    if (elevation <= h1) return l0 + (l1 - l0) * (elevation - h0) / (h1 - h0);
  }
  return daylight.at(-1)![1];
}
function daylightElevation(log: number) {
  if (log <= daylight[0][1]) return daylight[0][0];
  for (let index = 1; index < daylight.length; index++) {
    const [h1, l1] = daylight[index], [h0, l0] = daylight[index - 1];
    if (log <= l1) return h0 + (h1 - h0) * (log - l0) / (l1 - l0);
  }
  return daylight.at(-1)![0];
}

/** Sky brightness during totality, taken as the end of civil twilight. */
export const TOTALITY_ELEVATION = -6;
/**
 * Elevation whose daylight matches the eclipsed Sun: illuminance falls with
 * the uncovered share of the disc but not below the totality floor. Without
 * an eclipse the elevation is returned unchanged.
 */
export function eclipseSkyElevation(elevation: number, obscuration: number) {
  if (!(obscuration > 0)) return elevation;
  const full = 10 ** daylightLog(elevation);
  const floor = Math.min(full, 10 ** daylightLog(TOTALITY_ELEVATION));
  const lit = Math.max(full * (1 - Math.min(1, obscuration)), floor);
  return Math.min(elevation, daylightElevation(Math.log10(lit)));
}
