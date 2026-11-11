import {
  Body, EclipseKind, GeoMoon, GeoVector, KM_PER_AU, MakeTime, NextGlobalSolarEclipse, NextLocalSolarEclipse,
  NextLunarEclipse, Observer, RotateVector, Rotation_EQJ_EQD, SearchGlobalSolarEclipse, SearchLocalSolarEclipse,
  SearchLunarEclipse, Vector, VectorObserver,
} from "astronomy-engine";
import type { AstroTime } from "astronomy-engine";
import type { ShootingPlan } from "./plan.ts";
import { celestialBodies, degrees } from "./ephemeris.ts";
import type { Vector3 } from "./ephemeris.ts";
import { MOON_RADIUS_KM, SUN_RADIUS_KM, earthShadow } from "./eclipse-geometry.ts";
import { apparentElevation } from "./refraction.ts";

type Place = Pick<ShootingPlan, "latitude" | "longitude" | "refraction">;
type Span = { start: string; end: string };

export type SolarKind = "partial" | "annular" | "total";
export type LunarKind = "penumbral" | "partial" | "total";
export type ContactId = "P1" | "U1" | "U2" | "peak" | "U3" | "U4" | "P4";
export interface Contact {
  id: ContactId;
  /** Chinese contact name, e.g. 初亏. */
  label: string;
  instant: string;
  /** Apparent elevation of the body's centre with the plan's refraction, degrees. */
  elevation: number;
  /** Whether any part of the disc is above the sea-level horizon. */
  above: boolean;
}
interface EclipseBase {
  contacts: Contact[];
  peak: Contact;
  /** Some phase of the eclipse happens with the body above the horizon. */
  visible: boolean;
  /** First and last instants with the body up during the eclipse, when visible. */
  visibleFrom?: string;
  visibleTo?: string;
}
export interface LocalSolarEclipse extends EclipseBase {
  body: "sun";
  kind: SolarKind;
  /** Fraction of the solar disc's area covered at peak. */
  obscuration: number;
  /** Fraction of the solar diameter covered at peak (食分). */
  magnitude: number;
}
export interface LocalLunarEclipse extends EclipseBase {
  body: "moon";
  kind: LunarKind;
  /** Umbral magnitude at peak; negative for a penumbral eclipse. */
  magnitude: number;
}
export type LocalEclipse = LocalSolarEclipse | LocalLunarEclipse;

const solarKinds: Record<string, SolarKind> = {
  [EclipseKind.Partial]: "partial", [EclipseKind.Annular]: "annular", [EclipseKind.Total]: "total",
};
const lunarKinds: Record<string, LunarKind> = {
  [EclipseKind.Penumbral]: "penumbral", [EclipseKind.Partial]: "partial", [EclipseKind.Total]: "total",
};
export const solarKindNames: Record<SolarKind, string> = { partial: "日偏食", annular: "日环食", total: "日全食" };
export const lunarKindNames: Record<LunarKind, string> = { penumbral: "半影月食", partial: "月偏食", total: "月全食" };
const contactNames: Record<ContactId, string> = {
  P1: "半影食始", U1: "初亏", U2: "食既", peak: "食甚", U3: "生光", U4: "复圆", P4: "半影食终",
};

const iso = (time: number) => new Date(Math.round(time)).toISOString();
const observerOf = (place: Place) => new Observer(place.latitude, place.longitude, 0);
const LAST_TIME = Date.UTC(2100, 11, 31);

function sky(place: Place, body: "sun" | "moon", time: number) {
  const bodies = celestialBodies({ latitude: place.latitude, longitude: place.longitude, instant: iso(time) });
  const target = bodies[body];
  return {
    bodies,
    elevation: apparentElevation(target.elevation, place.refraction),
    above: apparentElevation(Math.min(90, target.elevation + target.angularRadius), place.refraction) > 0,
  };
}

function contact(place: Place, body: "sun" | "moon", id: ContactId, time: number): Contact {
  const at = sky(place, body, time);
  return { id, label: contactNames[id], instant: iso(time), elevation: at.elevation, above: at.above };
}

/** First and last five-minute samples (plus the ends) with the disc above the horizon. */
function visibleSpan(place: Place, body: "sun" | "moon", from: number, to: number) {
  const times: number[] = [];
  for (let time = from; time < to; time += 300_000) times.push(time);
  times.push(to);
  const up = times.filter((time) => sky(place, body, time).above);
  return up.length ? { visible: true, visibleFrom: iso(up[0]), visibleTo: iso(up.at(-1)!) } : { visible: false };
}

function solarFromInfo(place: Place, info: ReturnType<typeof SearchLocalSolarEclipse>): LocalSolarEclipse {
  const kind = solarKinds[info.kind];
  const ids: [ContactId, AstroTime | undefined][] = [
    ["U1", info.partial_begin.time], ["U2", info.total_begin?.time], ["peak", info.peak.time],
    ["U3", info.total_end?.time], ["U4", info.partial_end.time],
  ];
  const contacts = ids.filter((entry): entry is [ContactId, AstroTime] => !!entry[1])
    .map(([id, time]) => contact(place, "sun", id, time.date.getTime()));
  const peak = contacts.find((entry) => entry.id === "peak")!;
  const { bodies } = sky(place, "sun", Date.parse(peak.instant));
  const separation = Math.acos(Math.max(-1, Math.min(1,
    bodies.sun.direction.reduce((sum, value, index) => sum + value * bodies.moon.direction[index], 0)))) / degrees;
  const magnitude = (bodies.sun.angularRadius + bodies.moon.angularRadius - separation) / (2 * bodies.sun.angularRadius);
  return {
    body: "sun", kind, obscuration: kind === "total" ? 1 : info.obscuration, magnitude,
    contacts, peak,
    ...visibleSpan(place, "sun", info.partial_begin.time.date.getTime(), info.partial_end.time.date.getTime()),
  };
}

function lunarFromInfo(place: Place, info: ReturnType<typeof SearchLunarEclipse>): LocalLunarEclipse {
  const kind = lunarKinds[info.kind], peak = info.peak.date.getTime(), minutes = 60_000;
  const shadow = earthShadow(info.peak);
  const magnitude = (shadow.umbra + MOON_RADIUS_KM - shadow.distance) / (2 * MOON_RADIUS_KM);
  const ids: [ContactId, number][] = [
    ["P1", -info.sd_penum], ["P4", info.sd_penum], ["peak", 0],
    ...(kind !== "penumbral" ? [["U1", -info.sd_partial], ["U4", info.sd_partial]] as [ContactId, number][] : []),
    ...(kind === "total" ? [["U2", -info.sd_total], ["U3", info.sd_total]] as [ContactId, number][] : []),
  ];
  const contacts = ids.map(([id, offset]) => contact(place, "moon", id, peak + offset * minutes))
    .sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant));
  // A penumbral eclipse counts from the penumbra; the others from the umbra.
  const span = kind === "penumbral" ? info.sd_penum : info.sd_partial;
  return {
    body: "moon", kind, magnitude, contacts, peak: contacts.find((entry) => entry.id === "peak")!,
    ...visibleSpan(place, "moon", peak - span * minutes, peak + span * minutes),
  };
}

const lunarRange = (eclipse: LocalLunarEclipse) => {
  const ends = eclipse.contacts.filter((entry) => entry.id === "P1" || entry.id === "P4");
  return [Date.parse(ends[0].instant), Date.parse(ends.at(-1)!.instant)];
};

/** The first lunar eclipse after `after`, visible or not. */
export const lunarEclipseAfter = (place: Place, after: string) => lunarFromInfo(place, SearchLunarEclipse(new Date(after)));

/** Visible solar and lunar eclipses overlapping the span (at most one of each). */
export function eclipsesInSpan(place: Place, span: Span, bodies: { sun: boolean; moon: boolean }) {
  const start = Date.parse(span.start), end = Date.parse(span.end), lead = 6 * 3_600_000;
  const found: LocalEclipse[] = [];
  if (bodies.sun) {
    const solar = solarFromInfo(place, SearchLocalSolarEclipse(new Date(start - lead), observerOf(place)));
    const from = Date.parse(solar.contacts[0].instant), to = Date.parse(solar.contacts.at(-1)!.instant);
    if (solar.visible && from < end && to > start) found.push(solar);
  }
  if (bodies.moon) {
    const lunar = lunarFromInfo(place, SearchLunarEclipse(new Date(start - lead)));
    const [from, to] = lunarRange(lunar);
    if (lunar.visible && from < end && to > start) found.push(lunar);
  }
  return found;
}

/** The next solar eclipse with some phase above the horizon after `after`. */
export function nextSolarEclipse(place: Place, after: string): LocalSolarEclipse | null {
  const observer = observerOf(place);
  let info = SearchLocalSolarEclipse(new Date(after), observer);
  for (let count = 0; count < 40 && info.peak.time.date.getTime() < LAST_TIME; count++) {
    const eclipse = solarFromInfo(place, info);
    if (eclipse.visible) return eclipse;
    info = NextLocalSolarEclipse(info.peak.time, observer);
  }
  return null;
}

/** The next partial or total lunar eclipse with the Moon up during the umbral phase. */
export function nextLunarEclipse(place: Place, after: string): LocalLunarEclipse | null {
  let info = SearchLunarEclipse(new Date(after));
  for (let count = 0; count < 40 && info.peak.date.getTime() < LAST_TIME; count++) {
    if (info.kind !== EclipseKind.Penumbral) {
      const eclipse = lunarFromInfo(place, info);
      if (eclipse.visible) return eclipse;
    }
    info = NextLunarEclipse(info.peak);
  }
  return null;
}

export interface CentralEclipse {
  kind: "total" | "annular";
  /** Greatest eclipse. */
  instant: string;
  latitude: number;
  longitude: number;
}
/** The next total or annular solar eclipse anywhere on Earth. */
export function nextCentralEclipse(after: string): CentralEclipse | null {
  let info = SearchGlobalSolarEclipse(new Date(after));
  for (let count = 0; count < 20 && info.peak.date.getTime() < LAST_TIME; count++) {
    if (info.kind === EclipseKind.Total || info.kind === EclipseKind.Annular)
      return {
        kind: info.kind === EclipseKind.Total ? "total" : "annular", instant: iso(info.peak.date.getTime()),
        latitude: info.latitude!, longitude: info.longitude!,
      };
    info = NextGlobalSolarEclipse(info.peak);
  }
  return null;
}

/* ---- Central path ------------------------------------------------------------------------ */

const EARTH_A = 6378.1366, EARTH_FLATTENING = 0.996647180302104, OMEGA = 7.292115e-5;
const sub = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vector3) => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a: Vector3): Vector3 => { const length = norm(a); return [a[0] / length, a[1] / length, a[2] / length]; };
const combine = (a: Vector3, x: number, b: Vector3, y: number, c: Vector3, z: number): Vector3 =>
  [a[0] * x + b[0] * y + c[0] * z, a[1] * x + b[1] * y + c[1] * z, a[2] * x + b[2] * y + c[2] * z];

/**
 * Besselian-style frame at one instant, in the equator of date (km): k points
 * from the Moon to the Sun along the shadow axis, i lies in the equator.
 */
function shadowFrame(time: AstroTime) {
  const rotation = Rotation_EQJ_EQD(time);
  const toKm = (vector: Vector): Vector3 => {
    const turned = RotateVector(rotation, vector);
    return [turned.x * KM_PER_AU, turned.y * KM_PER_AU, turned.z * KM_PER_AU];
  };
  const sun = toKm(GeoVector(Body.Sun, time, true)), moon = toKm(GeoMoon(time));
  const k = unit3(sub(sun, moon)), i = unit3(cross([0, 0, 1], k)), j = cross(k, i);
  const sin = (SUN_RADIUS_KM - MOON_RADIUS_KM) / norm(sub(sun, moon));
  const z = dot3(moon, k);
  return { time, i, j, k, x: dot3(moon, i), y: dot3(moon, j), tan: sin / Math.sqrt(1 - sin * sin), vertex: z - MOON_RADIUS_KM / sin };
}
type Frame = ReturnType<typeof shadowFrame>;
/** Signed umbral radius at height ζ: positive inside a total shadow, negative for the annular antumbra. */
const umbralRadius = (frame: Frame, zeta: number) => (zeta - frame.vertex) * frame.tan;

/** The sunward ground point with fundamental-plane coordinates (ξ, η) on the reference ellipsoid. */
function ground(frame: Frame, xi: number, eta: number) {
  const flat = (v: Vector3): Vector3 => [v[0], v[1], v[2] / EARTH_FLATTENING];
  const u = flat(combine(frame.i, xi, frame.j, eta, [0, 0, 0], 0)), w = flat(frame.k);
  const ww = dot3(w, w), uw = dot3(u, w), discriminant = uw * uw - ww * (dot3(u, u) - EARTH_A * EARTH_A);
  if (discriminant < 0) return null;
  const zeta = (-uw + Math.sqrt(discriminant)) / ww;
  return { zeta, point: combine(frame.i, xi, frame.j, eta, frame.k, zeta) };
}

function geographic(point: Vector3, time: AstroTime): [number, number] {
  const place = VectorObserver(new Vector(point[0] / KM_PER_AU, point[1] / KM_PER_AU, point[2] / KM_PER_AU, time), true);
  return [place.longitude, place.latitude];
}

/** Earth rotation of an equator-of-date point by `seconds`. */
const spin = (point: Vector3, seconds: number): Vector3 => {
  const angle = OMEGA * seconds, c = Math.cos(angle), s = Math.sin(angle);
  return [point[0] * c - point[1] * s, point[0] * s + point[1] * c, point[2]];
};

/**
 * Edge of the path at one instant on side ±1: the ground point whose closest
 * approach to the shadow axis happens now at exactly the umbral radius, i.e.
 * its offset from the axis is perpendicular to its motion relative to the
 * shadow.
 */
function limit(frames: [Frame, Frame, Frame], side: 1 | -1, start: Vector3, startZeta: number) {
  const [before, now, after] = frames;
  let point = start, zeta = startZeta;
  for (let iteration = 0; iteration < 6; iteration++) {
    const offset = (frame: Frame, seconds: number) => {
      const moved = spin(point, seconds);
      return [frame.x - dot3(moved, frame.i), frame.y - dot3(moved, frame.j)];
    };
    const a = offset(before, -1), b = offset(after, 1);
    const vx = (b[0] - a[0]) / 2, vy = (b[1] - a[1]) / 2, speed = Math.hypot(vx, vy);
    if (!(speed > 0)) return null;
    const radius = Math.abs(umbralRadius(now, zeta));
    const hit = ground(now, now.x + side * -vy / speed * radius, now.y + side * vx / speed * radius);
    if (!hit) return null;
    point = hit.point; zeta = hit.zeta;
  }
  return point;
}

export interface PathSample {
  instant: string;
  kind: "total" | "annular";
  centre: [number, number];
  /** The two edges, [longitude, latitude]; missing where the edge is off the Earth. */
  edges: [[number, number] | null, [number, number] | null];
}
export interface CentralPath {
  kind: "total" | "annular" | "hybrid";
  peak: string;
  samples: PathSample[];
}

const PATH_STEP_S = 30;
const pathCache = new Map<string, CentralPath>();

/** Central point and both edges of the path at one instant; null once the axis misses the Earth. */
export function pathSample(time: number): PathSample | null {
  const at = (offset: number) => shadowFrame(MakeTime(new Date(time + offset * 1000)));
  const frames: [Frame, Frame, Frame] = [at(-1), at(0), at(1)];
  const now = frames[1], centre = ground(now, now.x, now.y);
  if (!centre) return null;
  const kind = umbralRadius(now, centre.zeta) > 0 ? "total" as const : "annular" as const;
  const edges = ([1, -1] as const).map((side) => {
    const point = limit(frames, side, centre.point, centre.zeta);
    return point ? geographic(point, now.time) : null;
  }) as PathSample["edges"];
  return { instant: iso(time), kind, centre: geographic(centre.point, now.time), edges };
}

/**
 * Central line and edges of a total or annular eclipse, every 30 s from the
 * instant the shadow axis first meets the Earth to the instant it leaves.
 * Lunar limb profile is not modelled (NASA quotes 1—3 km on the edges).
 */
export function centralPath(peak: string): CentralPath {
  const cached = pathCache.get(peak);
  if (cached) return cached;
  const origin = Date.parse(peak), samples: PathSample[] = [];
  const sample = pathSample;
  for (let step = 0; ; step--) {
    const found = sample(origin + step * PATH_STEP_S * 1000);
    if (!found || step < -720) break;
    samples.unshift(found);
  }
  for (let step = 1; ; step++) {
    const found = sample(origin + step * PATH_STEP_S * 1000);
    if (!found || step > 720) break;
    samples.push(found);
  }
  const kinds = new Set(samples.map((entry) => entry.kind));
  const path: CentralPath = { kind: kinds.size > 1 ? "hybrid" : samples[0]?.kind ?? "total", peak, samples };
  if (pathCache.size > 8) pathCache.clear();
  pathCache.set(peak, path);
  return path;
}

/** The umbra (or antumbra) on the ground at an instant, or null when it misses the Earth. */
export function umbraFootprint(instant: string): [number, number][] | null {
  const frame = shadowFrame(MakeTime(new Date(instant)));
  const centre = ground(frame, frame.x, frame.y);
  if (!centre) return null;
  const outline: [number, number][] = [];
  for (let index = 0; index < 48; index++) {
    const angle = 2 * Math.PI * index / 48;
    let zeta = centre.zeta, hit: ReturnType<typeof ground> = null;
    for (let iteration = 0; iteration < 4; iteration++) {
      const radius = Math.abs(umbralRadius(frame, zeta));
      hit = ground(frame, frame.x + radius * Math.cos(angle), frame.y + radius * Math.sin(angle));
      if (!hit) break;
      zeta = hit.zeta;
    }
    if (hit) outline.push(geographic(hit.point, frame.time));
  }
  return outline.length >= 3 ? outline : null;
}

/** Central eclipses whose greatest eclipse falls inside the span. */
export function centralEclipseInSpan(span: Span): CentralEclipse | null {
  const next = nextCentralEclipse(span.start);
  return next && Date.parse(next.instant) < Date.parse(span.end) ? next : null;
}

/* ---- Distance from the observer to the path ---------------------------------------------- */

const EARTH_MEAN_KM = 6371;
const radians = (value: number) => value * Math.PI / 180;
export function greatCircle(from: { latitude: number; longitude: number }, to: [number, number]) {
  const [lon, lat] = to, phi1 = radians(from.latitude), phi2 = radians(lat), dl = radians(lon - from.longitude);
  const a = Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dl / 2) ** 2;
  const distance = 2 * EARTH_MEAN_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  const bearing = (Math.atan2(Math.sin(dl) * Math.cos(phi2),
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
  return { distance, bearing };
}
const compass = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
export const compassName = (bearing: number) => compass[Math.round(bearing / 45) % 8];

/** Unwraps longitudes so consecutive points never jump across the antimeridian. */
export function unwrap(points: [number, number][]) {
  const out: [number, number][] = [];
  for (const [lon, lat] of points) {
    const last = out.at(-1);
    let value = lon;
    if (last) while (value - last[0] > 180) value -= 360;
    if (last) while (value - last[0] < -180) value += 360;
    out.push([value, lat]);
  }
  return out;
}

/**
 * Where the observer stands relative to the path: inside (from the local
 * circumstances), or the nearest edge point with distance and bearing.
 */
export function pathRelation(place: Place, path: CentralPath, local: LocalSolarEclipse | null) {
  if (local && (local.kind === "total" || local.kind === "annular")) return { inside: true as const };
  let best: { distance: number; bearing: number } | null = null;
  for (const side of [0, 1] as const) {
    const edge = unwrap(path.samples.map((entry) => entry.edges[side]).filter((point): point is [number, number] => !!point));
    for (let index = 0; index + 1 < edge.length; index++)
      for (let part = 0; part < 8; part++) {
        const t = part / 8, point: [number, number] = [
          edge[index][0] + (edge[index + 1][0] - edge[index][0]) * t, edge[index][1] + (edge[index + 1][1] - edge[index][1]) * t,
        ];
        const found = greatCircle(place, point);
        if (!best || found.distance < best.distance) best = found;
      }
  }
  return best ? { inside: false as const, ...best } : null;
}
