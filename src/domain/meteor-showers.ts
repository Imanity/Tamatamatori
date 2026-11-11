import { Body, GeoVector, MakeTime, RotateVector, Rotation_EQJ_ECL, Rotation_EQJ_HOR, Vector } from "astronomy-engine";
import type { Observer } from "astronomy-engine";
import data from "../data/meteor-showers.json" with { type: "json" };
import type { ShootingPlan } from "./plan.ts";
import { sensorKey } from "./plan.ts";
import type { Vector3 } from "./ephemeris.ts";
import { add, celestialBodies, degrees, dot, observerContext, scale, unit } from "./ephemeris.ts";
import type { View } from "./celestial-projection.ts";
import { cameraBasis } from "./celestial-projection.ts";
import type { SkyPoint } from "./starfield.ts";

type PlanInput = Pick<ShootingPlan, "latitude" | "longitude" | "instant">;

/**
 * Meteor showers of the IMO 2026 working list (Tables 5 and 6) with activity
 * profile shapes from the NASA MEO list (Moorhead et al. 2019). Dates are
 * converted to J2000 solar longitude, so other years reuse the 2026 values
 * without predicting outbursts.
 */
export const meteorSources = data.sources;
type Raw = (typeof data.showers)[number];

const eclipticRotation = Rotation_EQJ_ECL();
/** Geocentric solar longitude referred to the J2000 equinox, as in the IMO tables. */
export function solarLongitude(date: Date) {
  const v = RotateVector(eclipticRotation, GeoVector(Body.Sun, date, false));
  return (((Math.atan2(v.y, v.x) / degrees) % 360) + 360) % 360;
}
const calendarLongitude = (monthDay: string, endOfDay = false) => {
  const [month, day] = monthDay.split("-").map(Number);
  return solarLongitude(new Date(Date.UTC(2026, month - 1, day + (endOfDay ? 1 : 0))));
};
/** Signed a − b in (−180°, 180°]. */
const delta = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180;
const equatorial = (ra: number, dec: number): Vector3 => [
  Math.cos(dec * degrees) * Math.cos(ra * degrees),
  Math.cos(dec * degrees) * Math.sin(ra * degrees),
  Math.sin(dec * degrees),
];

export interface MeteorShower {
  code: string;
  iau: number | null;
  name: string;
  nameEn: string;
  /** Activity window as J2000 solar longitudes, start of the first day to end of the last. */
  start: number;
  end: number;
  activity: readonly [string, string];
  maximum: string | null;
  maxLongitude: number | null;
  referenceOnly: boolean;
  velocity: number;
  populationIndex: number;
  /** Peak ZHR; null where the working list gives "Var" (variable, not estimated). */
  zhr: number | null;
  profileSource: "meo" | "window" | "constant";
  active: (longitude: number) => boolean;
  radiantAt: (longitude: number) => readonly [number, number];
  zhrAt: (longitude: number) => number | null;
}

function build(raw: Raw): MeteorShower {
  const start = calendarLongitude(raw.activity[0]), end = calendarLongitude(raw.activity[1], true);
  const maxLongitude = raw.solarLongitude;
  // Order Table 6 points along the activity, which may cross λ = 0.
  const base = start - 30;
  const along = (longitude: number) => (((longitude - base) % 360) + 360) % 360;
  const points = raw.drift
    .map(([date, ra, dec]) => ({ at: along(calendarLongitude(date as string)), ra: ra as number, dec: dec as number }))
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < points.length; i++) points[i].ra = points[i - 1].ra + delta(points[i].ra, points[i - 1].ra);
  const track = (longitude: number): [number, number] => {
    if (points.length === 1) return [points[0].ra, points[0].dec];
    const at = along(longitude);
    const i = Math.max(1, Math.min(points.length - 1, points.findIndex((p) => p.at >= at)));
    const a = points[i - 1], b = points[i], f = (at - a.at) / (b.at - a.at);
    return [a.ra + f * (b.ra - a.ra), a.dec + f * (b.dec - a.dec)];
  };
  // Table 5 is authoritative at maximum; Table 6 supplies the drift.
  const offset = raw.radiant && maxLongitude !== null
    ? [delta(raw.radiant[0], track(maxLongitude)[0]), raw.radiant[1] - track(maxLongitude)[1]]
    : [0, 0];
  const radiantAt = (longitude: number) => {
    const [ra, dec] = track(longitude);
    return [(((ra + offset[0]) % 360) + 360) % 360, Math.max(-90, Math.min(90, dec + offset[1]))] as const;
  };
  const inWindow = (longitude: number) => {
    const offset = along(longitude) - along(start);
    return offset >= 0 && offset <= along(end) - along(start);
  };
  const components = raw.profile;
  let shape: ((longitude: number) => number) | null = null;
  let profileSource: MeteorShower["profileSource"] = "constant";
  if (maxLongitude !== null && components?.length) {
    // MEO shape, moved so its main component peaks at the IMO maximum and scaled to the IMO ZHR.
    const shift = delta(maxLongitude, components[0].solarLongitude);
    const sum = (longitude: number) => components.reduce((total, c) => {
      const d = delta(longitude, c.solarLongitude + shift);
      return total + c.zhr * 10 ** (d < 0 ? c.growth * d : -c.decay * d);
    }, 0);
    const peak = sum(maxLongitude);
    shape = (longitude) => sum(longitude) / peak;
    profileSource = "meo";
  } else if (maxLongitude !== null) {
    // No published shape: one decade lower at the edges of the activity window.
    const rise = 1 / Math.max(0.5, delta(maxLongitude, start)), fall = 1 / Math.max(0.5, delta(end, maxLongitude));
    shape = (longitude) => {
      const d = delta(longitude, maxLongitude);
      return 10 ** (d < 0 ? rise * d : -fall * d);
    };
    profileSource = "window";
  }
  return {
    code: raw.code,
    iau: raw.iau,
    name: raw.name,
    nameEn: raw.nameEn,
    start,
    end,
    activity: raw.activity as [string, string],
    maximum: raw.maximum,
    maxLongitude,
    referenceOnly: raw.referenceOnly,
    velocity: raw.velocity,
    populationIndex: raw.populationIndex,
    zhr: raw.zhr,
    profileSource,
    active: inWindow,
    radiantAt,
    zhrAt: (longitude) => (raw.zhr === null ? null : !inWindow(longitude) ? 0 : raw.zhr * (shape ? shape(longitude) : 1)),
  };
}

let catalog: MeteorShower[] | undefined;
export function meteorShowers() {
  catalog ??= data.showers.map(build);
  return catalog;
}

function horizontalFrame(date: Date, observer: Observer) {
  const rotation = Rotation_EQJ_HOR(date, observer), time = MakeTime(date);
  return (eqj: Vector3): Vector3 => {
    const p = RotateVector(rotation, new Vector(eqj[0], eqj[1], eqj[2], time));
    return unit([-p.y, p.x, p.z]);
  };
}

/** Columns of the J2000 → local east/north/up rotation at one instant. */
type SkyFrame = readonly [Vector3, Vector3, Vector3];
function skyFrame(date: Date, observer: Observer): SkyFrame {
  const horizontal = horizontalFrame(date, observer);
  return [horizontal([1, 0, 0]), horizontal([0, 1, 0]), horizontal([0, 0, 1])];
}
const toSky = (frame: SkyFrame, ray: Vector3): Vector3 => [dot(frame[0], ray), dot(frame[1], ray), dot(frame[2], ray)];
const fromSky = (frame: SkyFrame, sky: Vector3): Vector3 =>
  add(add(scale(frame[0], sky[0]), scale(frame[1], sky[1])), scale(frame[2], sky[2]));

/**
 * Moves horizontal directions seen at `date` to where the same stars stand at
 * the shooting instant, as star alignment does when meteor frames are
 * registered onto the anchor frame.
 */
export function skyAlignment(plan: PlanInput, date: Date) {
  const { date: anchor, observer } = observerContext(plan);
  const from = skyFrame(date, observer), to = skyFrame(anchor, observer);
  return (ray: Vector3) => fromSky(to, toSky(from, ray));
}

/** Inward normals of the four frame edges; a direction is in frame when every dot product is >= 0. */
function frameEdges(view: View): Vector3[] {
  const { forward, right, up, tx, ty } = cameraBasis(view);
  return [
    add(scale(forward, tx), scale(right, -1)), add(scale(forward, tx), right),
    add(scale(forward, ty), scale(up, -1)), add(scale(forward, ty), up),
  ];
}
const inside = (edges: Vector3[], ray: Vector3) => edges.every((edge) => dot(edge, ray) >= 0);

/**
 * Part of the short great-circle arc a -> b on the inner side of every plane
 * through the eye, as parameters s of the chord (1 - s)a + sb. Plane tests are
 * linear along the chord, so the cut is exact; null when nothing remains.
 */
function clipArc(a: Vector3, b: Vector3, planes: Vector3[]) {
  let from = 0, to = 1;
  for (const plane of planes) {
    const da = dot(plane, a), db = dot(plane, b);
    if (da < 0 && db < 0) return null;
    if (da < 0) from = Math.max(from, da / (da - db));
    else if (db < 0) to = Math.min(to, da / (da - db));
  }
  return from < to ? ([from, to] as const) : null;
}
const chordPoint = (a: Vector3, b: Vector3, s: number) => unit(add(scale(a, 1 - s), scale(b, s)));

export interface ActiveShower {
  shower: MeteorShower;
  longitude: number;
  radiant: readonly [number, number];
  zhr: number | null;
  /** Days from maximum (negative before), from solar longitude. */
  daysFromMaximum: number | null;
  point: SkyPoint;
}

/** Showers whose IMO activity window contains the shooting instant, with the radiant for that instant. */
export function activeShowers(plan: PlanInput): ActiveShower[] {
  const { date, observer } = observerContext(plan);
  const longitude = solarLongitude(date), horizontal = horizontalFrame(date, observer);
  return meteorShowers()
    .filter((shower) => shower.active(longitude))
    .map((shower) => {
      const radiant = shower.radiantAt(longitude), ray = horizontal(equatorial(...radiant));
      return {
        shower, longitude, radiant,
        zhr: shower.zhrAt(longitude),
        daysFromMaximum: shower.maxLongitude === null ? null : delta(longitude, shower.maxLongitude) / 0.9856,
        point: {
          id: `meteor-${shower.code}`, name: `${shower.name}辐射点`,
          azimuth: (((Math.atan2(ray[0], ray[1]) / degrees) % 360) + 360) % 360,
          elevation: Math.asin(Math.max(-1, Math.min(1, ray[2]))) / degrees,
          direction: ray, magnitude: 0, color: [0.62, 1, 0.78] as const,
        },
      };
    });
}

// Photometric model. ZHR → flux follows Koschack & Rendtel (1990), as used by
// the NASA MEO; moonlight follows Krisciunas & Schaefer (1991). Camera
// detection is an assumption of this application, not a calibrated sensor.
export const meteorModel = {
  layerHeightKm: 100,
  extinction: 0.2,
  /** Faintest meteor magnitude a wide fast lens records under a dark natural sky (assumption). */
  cameraLimit: 2,
  naturalMcd: 0.174,
  sunLimit: -18,
  stepMinutes: 10,
  maxStreaks: 1500,
} as const;
const EARTH_RADIUS = 6371, NL_TO_MCD = 3.1831e-3;
const airmassKS = (sinElevation: number) => 1 / Math.sqrt(1 - 0.96 * (1 - sinElevation ** 2));
const airmassKY = (elevation: number) => {
  const zenith = 90 - elevation;
  return 1 / (Math.cos(zenith * degrees) + 0.50572 * (96.07995 - zenith) ** -1.6364);
};

/** Direction-only terms of the rate model. */
function geometry(direction: Vector3) {
  const sinE = direction[2], cosE = Math.sqrt(Math.max(0, 1 - sinE * sinE)), elevation = Math.asin(sinE) / degrees;
  const r = EARTH_RADIUS, h = meteorModel.layerHeightKm, k = meteorModel.extinction;
  const distance = Math.sqrt((r + h) ** 2 - (r * cosE) ** 2) - r * sinE;
  const cosPsi = Math.sqrt(1 - ((r * cosE) / (r + h)) ** 2);
  const xks = airmassKS(sinE);
  return {
    direction, distance,
    area: (distance * distance) / cosPsi,
    /** Magnitudes lost to distance (relative to 100 km) and to extinction (relative to the zenith). */
    loss: 5 * Math.log10(distance / 100) + k * (airmassKY(elevation) - 1),
    natural: meteorModel.naturalMcd * xks * 10 ** (-0.4 * k * (xks - 1)),
    scatter: 1 - 10 ** (-0.4 * k * xks),
  };
}
type Geometry = ReturnType<typeof geometry>;

interface Step {
  /** Start of the ten-minute UTC grid step, ms. */
  start: number;
  /** Hours of this step inside the shooting duration. */
  hours: number;
  moon: { direction: Vector3; strength: number } | null;
  showers: { shower: MeteorShower; radiant: Vector3; flux: number; logR: number }[];
  /** Sky orientation at the middle of the step; meteors of the step are drawn against it. */
  sky: SkyFrame;
}

/** Moon illuminance outside the atmosphere times its own extinction (Krisciunas & Schaefer 1991, eq. 20, 21). */
function moonStrength(moon: { direction: Vector3; illuminatedFraction: number }) {
  // Phase angle from the illuminated fraction (0° = full Moon).
  const phase = Math.acos(Math.max(-1, Math.min(1, 2 * moon.illuminatedFraction - 1))) / degrees;
  const illuminance = 10 ** (-0.4 * (3.84 + 0.026 * phase + 4e-9 * phase ** 4));
  return illuminance * 10 ** (-0.4 * meteorModel.extinction * airmassKS(moon.direction[2]));
}

/** Moonlit sky brightness in mcd/m² (Krisciunas & Schaefer 1991, eq. 15–21). */
function moonlight(moon: NonNullable<Step["moon"]>, geo: Geometry) {
  const rho = Math.acos(Math.max(-1, Math.min(1, dot(moon.direction, geo.direction)))) / degrees;
  const scattering = 10 ** 5.36 * (1.06 + Math.cos(rho * degrees) ** 2) + 10 ** (6.15 - rho / 40);
  return scattering * moon.strength * geo.scatter * NL_TO_MCD;
}

/**
 * Faintest apparent meteor magnitude the camera records against a sky of this
 * brightness. Background-limited detection: the threshold flux grows with the
 * square root of the sky, 1.25 magnitudes per tenfold brightness.
 */
export const cameraLimitFor = (skyMcd: number) => meteorModel.cameraLimit - 1.25 * Math.log10(skyMcd / meteorModel.naturalMcd);
function cameraLimit(step: Step, geo: Geometry, artificialMcd: number) {
  return cameraLimitFor(geo.natural + artificialMcd + (step.moon ? moonlight(step.moon, geo) : 0));
}

/** Sky brightness in mcd/m² in a direction: natural sky, uniform light pollution and moonlight. */
export function skyBrightness(direction: Vector3, moon: { direction: Vector3; illuminatedFraction: number } | null, artificialMcd = 0) {
  const geo = geometry(direction);
  const lit = moon && moon.direction[2] > 0 ? moonlight({ direction: moon.direction, strength: moonStrength(moon) }, geo) : 0;
  return geo.natural + artificialMcd + lit;
}

/** Expected camera meteors per steradian per hour, for one shower at one step. */
function rate(entry: Step["showers"][number], geo: Geometry, limit: number) {
  if (geo.direction[2] <= 0) return 0;
  return entry.flux * Math.exp((limit - geo.loss - 6.5) * entry.logR) * geo.area;
}

const stepLength = meteorModel.stepMinutes * 60_000, DAY = 86_400_000;

/**
 * The night the shooting instant belongs to: local mean solar noon (from the
 * site's longitude, not the chosen time zone) to the next noon. A time after
 * midnight stays with the evening before it.
 */
export function meteorNight(plan: Pick<ShootingPlan, "longitude" | "instant">) {
  const offset = (plan.longitude / 15) * 3_600_000;
  const from = Math.floor((Date.parse(plan.instant) + offset - DAY / 2) / DAY) * DAY + DAY / 2 - offset;
  return { from, to: from + DAY };
}

const gridCache = new Map<string, Omit<Step, "hours"> | null>();
/**
 * One step of the fixed ten-minute UTC grid, evaluated at its middle; null in
 * twilight or daylight. A fixed grid keeps steps (and the illustration seeded
 * from them) unchanged while the shooting time moves.
 */
function gridStep(plan: PlanInput, observer: Observer, start: number) {
  const key = `${plan.latitude}/${plan.longitude}/${start}`;
  if (gridCache.has(key)) return gridCache.get(key)!;
  if (gridCache.size >= 3000) gridCache.clear();
  const at = new Date(start + stepLength / 2);
  const bodies = celestialBodies({ ...plan, instant: at.toISOString() });
  let value: Omit<Step, "hours"> | null = null;
  if (bodies.sun.elevation < meteorModel.sunLimit) {
    const longitude = solarLongitude(at), horizontal = horizontalFrame(at, observer), sky = skyFrame(at, observer);
    const moon: Step["moon"] = bodies.moon.elevation > 0 ? { direction: bodies.moon.direction, strength: moonStrength(bodies.moon) } : null;
    const showers = meteorShowers().flatMap((shower) => {
      const zhr = shower.zhrAt(longitude);
      if (!zhr) return [];
      const radiant = horizontal(equatorial(...shower.radiantAt(longitude)));
      if (radiant[2] <= 0) return [];
      const r = shower.populationIndex;
      // Flux of meteoroids brighter than +6.5 through a horizontal km², per hour.
      const flux = (zhr * (13.1 * r - 16.5) * (r - 1.3) ** 0.748) / 37200 * radiant[2];
      return [{ shower, radiant, flux, logR: Math.log(r) }];
    });
    value = { start, moon, showers, sky };
  }
  gridCache.set(key, value);
  return value;
}

/** Dark grid steps of the night, weighted by their overlap with it. */
function steps(plan: PlanInput) {
  const { observer } = observerContext(plan);
  const { from, to } = meteorNight(plan), result: Step[] = [];
  for (let start = Math.floor(from / stepLength) * stepLength; start < to; start += stepLength) {
    const hours = (Math.min(to, start + stepLength) - Math.max(from, start)) / 3_600_000;
    const step = hours > 0 ? gridStep(plan, observer, start) : null;
    if (step) result.push({ ...step, hours });
  }
  return result;
}

export interface MeteorEstimate {
  /** The night of the shooting instant, UTC ms (see `meteorNight`). */
  night: { from: number; to: number };
  /** Start of the first and end of the last dark step counted, UTC ms; null when the night has none. */
  dark: { from: number; to: number } | null;
  darkHours: number;
  expected: number;
  byShower: { code: string; name: string; expected: number }[];
}

/**
 * Expected meteors in the stack of the whole night (terrain not considered).
 * The camera stays fixed and shoots through every dark hour of the night;
 * each meteor frame is aligned to the stars of the shooting instant: a meteor
 * counts when it flew inside the fixed frame and still lands in the frame
 * above the horizon after alignment.
 */
export function meteorEstimate(plan: PlanInput & View, artificialMcd = 0): MeteorEstimate {
  const all = steps(plan), basis = cameraBasis(plan), edges = frameEdges(plan);
  const { date, observer } = observerContext(plan);
  const anchor = skyFrame(date, observer);
  const nx = 20, ny = 14, cells: { sky: Vector3; weight: number }[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const x = basis.tx * (-1 + (2 * i + 1) / nx), y = basis.ty * (-1 + (2 * j + 1) / ny);
      const ray = unit(add(basis.forward, add(scale(basis.right, x), scale(basis.up, y))));
      if (ray[2] <= 0) continue;
      cells.push({ sky: toSky(anchor, ray), weight: ((2 * basis.tx) / nx) * ((2 * basis.ty) / ny) / (1 + x * x + y * y) ** 1.5 });
    }
  const totals = new Map<MeteorShower, number>();
  for (const step of all)
    for (const cell of cells) {
      // Where this part of the anchor sky stood while the step was exposed.
      const ray = fromSky(step.sky, cell.sky);
      if (ray[2] <= 0 || !inside(edges, ray)) continue;
      const geo = geometry(ray), limit = cameraLimit(step, geo, artificialMcd);
      for (const entry of step.showers)
        totals.set(entry.shower, (totals.get(entry.shower) ?? 0) + rate(entry, geo, limit) * cell.weight * step.hours);
    }
  const byShower = [...totals].map(([shower, expected]) => ({ code: shower.code, name: shower.name, expected }))
    .sort((a, b) => b.expected - a.expected);
  const night = meteorNight(plan);
  return {
    night,
    dark: all.length
      ? { from: Math.max(night.from, all[0].start), to: Math.min(night.to, all[all.length - 1].start + stepLength) }
      : null,
    darkHours: all.reduce((sum, step) => sum + step.hours, 0),
    expected: byShower.reduce((sum, item) => sum + item.expected, 0),
    byShower,
  };
}

// Deterministic generator so the same plan always shows the same illustration.
function random(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(next: () => number, mean: number) {
  if (mean <= 0) return 0;
  if (mean > 30) {
    const g = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * g));
  }
  let count = -1, product = 1;
  const limit = Math.exp(-mean);
  do {
    count++;
    product *= next();
  } while (product > limit);
  return count;
}

interface Streak {
  code: string;
  time: number;
  /** Horizontal directions of the step; the meteor appears at `start` and moves away from the radiant to `end`. */
  start: Vector3;
  end: Vector3;
  magnitude: number;
}
export interface MeteorStreak {
  code: string;
  time: number;
  /**
   * Recorded part of the streak, aligned to the shooting instant: horizontal
   * directions, moving away from the radiant from `start` to `end`.
   */
  start: Vector3;
  end: Vector3;
  /** Fractions of the whole streak length at `start` and `end`; [0, 1] when nothing was cut. */
  along: readonly [number, number];
  magnitude: number;
}

const streakCache = new Map<string, Streak[]>();
/** All illustrative meteors of one grid step and shower, independent of the shooting window. */
function stepStreaks(plan: PlanInput, step: Step, entry: Step["showers"][number], artificialMcd: number) {
  const key = `${plan.latitude}|${plan.longitude}|${step.start}|${entry.shower.code}|${artificialMcd}`;
  const cached = streakCache.get(key);
  if (cached) return cached;
  if (streakCache.size >= 3000) streakCache.clear();
  const next = random(key), streaks: Streak[] = [];
  // Upper bound of the rate over the sky: the Moon only removes meteors.
  let peak = 0;
  for (let e = 0.5; e < 90; e += 1) {
    const geo = geometry([0, Math.cos(e * degrees), Math.sin(e * degrees)]);
    peak = Math.max(peak, rate(entry, geo, cameraLimit({ ...step, moon: null }, geo, artificialMcd)));
  }
  peak *= 1.02;
  const candidates = poisson(next, (peak * 2 * Math.PI * stepLength) / 3_600_000);
  for (let c = 0; c < candidates; c++) {
    // Every candidate draws the same random numbers, accepted or not, so the sequence is stable.
    const z = next(), azimuth = 2 * Math.PI * next(), test = next(), u = next(), length0 = next(), at = next();
    const horizontal = Math.sqrt(1 - z * z);
    const direction: Vector3 = [horizontal * Math.sin(azimuth), horizontal * Math.cos(azimuth), z];
    const geo = geometry(direction), limit = cameraLimit(step, geo, artificialMcd);
    if (test * peak >= rate(entry, geo, limit)) continue;
    const cosD = dot(direction, entry.radiant), d = Math.acos(Math.max(-1, Math.min(1, cosD)));
    if (d < 0.5 * degrees) continue;
    // Tangent at the meteor along the great circle from the radiant, pointing away from it.
    const away = unit(add(scale(direction, cosD), scale(entry.radiant, -1)));
    const magnitude = limit + Math.log(Math.max(1e-9, u)) / entry.logR;
    const path = 10 + 25 * length0 + 4 * Math.max(0, 1 - magnitude);
    const length = Math.min(40 * degrees, (path * Math.sin(d)) / geo.distance);
    streaks.push({
      code: entry.shower.code,
      time: step.start + at * stepLength,
      start: direction,
      end: unit(add(scale(direction, Math.cos(length)), scale(away, Math.sin(length)))),
      magnitude,
    });
  }
  streakCache.set(key, streaks);
  return streaks;
}

let sampleCache: { key: string; value: { streaks: MeteorStreak[]; thinning: number } } | undefined;
/**
 * Illustrative meteors of the whole night's stack, drawn from the same rate
 * model with fixed seeds per grid step. The camera stays fixed: a streak keeps
 * the part recorded inside the frame while it flew, that part is aligned to
 * the stars of the shooting instant and cut to the frame above the horizon,
 * so every streak points back to the radiant shown for the shooting instant.
 * Moving the shooting time within the night keeps the same meteors and only
 * turns the alignment; the count scatters around the estimate.
 */
export function meteorSample(plan: PlanInput & View, artificialMcd = 0) {
  const key = [plan.latitude, plan.longitude, plan.instant, artificialMcd,
    plan.azimuth, plan.pitch, plan.focalLength, sensorKey(plan), plan.aspectRatio, plan.orientation].join("/");
  if (sampleCache?.key === key) return sampleCache.value;
  const { from, to } = meteorNight(plan);
  const { date, observer } = observerContext(plan);
  const anchor = skyFrame(date, observer), edges = frameEdges(plan), visible = [...edges, [0, 0, 1] as Vector3];
  const angle = (a: Vector3, b: Vector3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  const streaks: MeteorStreak[] = [];
  for (const step of steps(plan))
    for (const entry of step.showers)
      for (const streak of stepStreaks(plan, step, entry, artificialMcd)) {
        if (streak.time < from || streak.time >= to) continue;
        // Recorded by the fixed camera while the meteor flew.
        const recorded = clipArc(streak.start, streak.end, edges);
        if (!recorded) continue;
        const align = (ray: Vector3) => fromSky(anchor, toSky(step.sky, ray));
        const a = align(chordPoint(streak.start, streak.end, recorded[0]));
        const b = align(chordPoint(streak.start, streak.end, recorded[1]));
        // Pasted onto the anchor frame: only what lands in the frame above the horizon shows.
        const shown = clipArc(a, b, visible);
        if (!shown) continue;
        const start = chordPoint(a, b, shown[0]), end = chordPoint(a, b, shown[1]);
        const origin = align(streak.start), total = angle(streak.start, streak.end);
        streaks.push({
          code: streak.code, time: streak.time, start, end, magnitude: streak.magnitude,
          along: [angle(origin, start) / total, angle(origin, end) / total],
        });
      }
  let thinning = 1;
  if (streaks.length > meteorModel.maxStreaks) {
    // Keep a fixed subset, chosen per meteor so it survives small changes; the estimate is unaffected.
    thinning = meteorModel.maxStreaks / streaks.length;
    const kept = streaks.filter((streak) => random(`${streak.code}|${streak.time}`)() < thinning);
    streaks.length = 0;
    streaks.push(...kept);
  }
  const value = { streaks, thinning };
  sampleCache = { key, value };
  return value;
}
