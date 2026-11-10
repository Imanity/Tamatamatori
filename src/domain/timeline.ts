import { Temporal } from "@js-temporal/polyfill";
import { Body, DefineStar, Equator, HelioVector, Horizon, MakeTime, Observer, SearchAltitude } from "astronomy-engine";
import { eciToEcf, ecfToLookAngles, gstime, jday, json2satrec, propagate, shadowFraction, sunPos } from "satellite.js";
import type { ShootingPlan } from "./plan.ts";
import { instantFromLocal } from "./plan.ts";
import { limbAltitude, sunMoonEvents } from "./day-events.ts";
import { sunPosition } from "./ephemeris.ts";
import { activeShowers } from "./meteor-showers.ts";
import { cometScene } from "./comets.ts";
import { cometState } from "./comet-orbit.ts";
import type { CometCatalog } from "./comet-catalog.ts";
import { orbitEpoch, stationCatalog } from "./orbit-data.ts";
import type { OrbitSnapshot } from "./orbit-data.ts";

/**
 * The time slider covers one 24-hour span of local wall-clock time: the
 * calendar day, or, while a night-sky layer is on, noon to noon so a whole
 * night stays on one axis (early morning belongs to the previous night).
 */
export type TimelineMode = "day" | "night";
export const nightLayers = ["stars", "milkyWay", "deepSky", "meteors", "comets"] as const;

export function timelineMode(layers: ShootingPlan["layers"]): TimelineMode {
  return nightLayers.some((key) => layers[key]) ? "night" : "day";
}

export interface TimelineWindow {
  mode: TimelineMode;
  /** Local date the span starts on. */
  date: string;
  startHour: 0 | 12;
  start: string;
  end: string;
}

export function timelineWindow(instant: string, timeZone: string, mode: TimelineMode): TimelineWindow {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
  const startHour = mode === "night" ? 12 : 0;
  const date = mode === "night" && local.hour < 12 ? local.toPlainDate().subtract({ days: 1 }) : local.toPlainDate();
  const origin = date.toPlainDateTime({ hour: startHour });
  const at = (value: Temporal.PlainDateTime) =>
    value.toZonedDateTime(timeZone, { disambiguation: "compatible" }).toInstant().toString();
  return { mode, date: date.toString(), startHour, start: at(origin), end: at(origin.add({ days: 1 })) };
}

const windowOrigin = (window: TimelineWindow) =>
  Temporal.PlainDate.from(window.date).toPlainDateTime({ hour: window.startHour });

/** Wall-clock minutes from the start of the span, 0—1439. */
export function windowMinute(instant: string, window: TimelineWindow, timeZone: string) {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDateTime();
  const minutes = Math.floor(local.since(windowOrigin(window), { largestUnit: "minutes" }).total({ unit: "minutes" }));
  return Math.max(0, Math.min(1439, minutes));
}

/** The instant at a slider minute; rejects wall-clock times skipped or repeated by DST. */
export function instantAtWindowMinute(window: TimelineWindow, minute: number, timeZone: string) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439)
    throw new RangeError("时间滑杆需在 0—1439 分钟之间");
  return instantFromLocal(windowOrigin(window).add({ minutes: minute }).toString(), timeZone);
}

/** Geometric Sun elevation every `step` wall-clock minutes of the span; minute 1440 is its end. */
export function sunElevationAcross(plan: Pick<ShootingPlan, "latitude" | "longitude">, window: TimelineWindow, timeZone: string, step = 10) {
  const origin = windowOrigin(window);
  const samples: { minute: number; elevation: number }[] = [];
  for (let minute = 0; minute <= 1440; minute += step) {
    const instant = origin.add({ minutes: minute }).toZonedDateTime(timeZone, { disambiguation: "compatible" }).toInstant().toString();
    samples.push({ minute, elevation: sunPosition({ latitude: plan.latitude, longitude: plan.longitude, instant }).elevation });
  }
  return samples;
}

export type TimelineEventKind =
  | "dawn" | "sunrise" | "sunset" | "dusk" | "moonrise" | "moonset"
  | "core-rise" | "core-set" | "radiant-rise" | "radiant-set" | "comet-rise" | "comet-set" | "station-pass";

export interface TimelineEvent {
  key: string;
  kind: TimelineEventKind;
  /** Short marker label. */
  label: string;
  instant: string;
  /** What the event means, without its time. */
  detail: string;
}

export interface TimelineEvents {
  events: TimelineEvent[];
  /** Events expected for an enabled layer that do not happen in the span. */
  missing: string[];
}

type EventPlan = Pick<ShootingPlan, "latitude" | "longitude" | "refraction" | "cameraHeight" | "layers">;
const horizonNote = (refraction: ShootingPlan["refraction"]) =>
  `${refraction === "standard" ? "海平面地平（标准折射）" : "几何地平（无折射）"}，不含地形遮挡`;
const round = (time: number) => Temporal.Instant.fromEpochMilliseconds(Math.round(time / 1000) * 1000).toString();

/**
 * Rise and set of a fixed J2000 direction in the span, horizon as for the
 * Sun and Moon (sea-level, chosen refraction). A star can rise twice in 24 h.
 */
export function fixedRiseSet(plan: EventPlan, window: TimelineWindow, raHours: number, decDegrees: number) {
  DefineStar(Body.Star8, raHours, decDegrees, 1000);
  const observer = new Observer(plan.latitude, plan.longitude, 0);
  const start = Date.parse(window.start), end = Date.parse(window.end), altitude = limbAltitude(0, plan.refraction);
  const found: { direction: 1 | -1; time: number }[] = [];
  for (const direction of [1, -1] as const) {
    let from = start;
    while (from < end) {
      let event = null;
      try {
        event = SearchAltitude(Body.Star8, observer, direction, MakeTime(new Date(from)), (end - from) / 86_400_000, altitude);
      } catch {
        event = null;
      }
      if (!event) break;
      const time = event.date.getTime();
      if (time >= end) break;
      found.push({ direction, time });
      from = time + 60_000;
    }
  }
  found.sort((a, b) => a.time - b.time);
  // Without a crossing the direction stays on one side of the horizon all span.
  const time = MakeTime(new Date(start)), equator = Equator(Body.Star8, time, observer, true, true);
  const aboveAtStart = Horizon(time, observer, equator.ra, equator.dec).altitude > altitude;
  return Object.assign(found, { aboveAtStart });
}

function raDec(vector: readonly [number, number, number]) {
  const length = Math.hypot(...vector);
  const ra = ((Math.atan2(vector[1], vector[0]) * 12) / Math.PI + 24) % 24;
  return { ra, dec: (Math.asin(vector[2] / length) * 180) / Math.PI };
}

/**
 * Passes of each station above 10°, sunlit, while the Sun is below −6°;
 * minute steps. `covered` is false when no station has usable elements for
 * any minute of the span (published elements are used for 72 hours around
 * their epoch, as for the station markers).
 */
export function visiblePasses(plan: EventPlan, window: TimelineWindow, snapshot: OrbitSnapshot) {
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const sun = new Map<number, number>();
  const sunAt = (time: number) => {
    // Sun elevation every 10 minutes, interpolated in between.
    const a = Math.floor((time - start) / 600_000) * 600_000 + start, b = a + 600_000;
    const value = (at: number) => {
      if (!sun.has(at)) sun.set(at, sunPosition({ latitude: plan.latitude, longitude: plan.longitude, instant: new Date(at).toISOString() }).elevation);
      return sun.get(at)!;
    };
    return value(a) + ((value(b) - value(a)) * (time - a)) / 600_000;
  };
  const observer = { latitude: (plan.latitude * Math.PI) / 180, longitude: (plan.longitude * Math.PI) / 180, height: plan.cameraHeight / 1000 };
  const passes: { station: (typeof stationCatalog)[number]; from: number; to: number; peak: number }[] = [];
  let covered = false;
  for (const station of stationCatalog) {
    const element = snapshot.objects.find((entry) => entry.NORAD_CAT_ID === station.noradId);
    if (!element) continue;
    let epoch: number, satellite;
    try {
      epoch = orbitEpoch(element.EPOCH);
      satellite = json2satrec(element);
    } catch {
      continue;
    }
    let current: { from: number; to: number; peak: number } | null = null;
    for (let time = start; time < end; time += 60_000) {
      let visible = false, elevation = -90;
      if (Math.abs(time - epoch) <= 72 * 3_600_000) {
        const date = new Date(time), state = propagate(satellite, date);
        if (state && state.position && !satellite.error) {
          covered = true;
          elevation = (ecfToLookAngles(observer, eciToEcf(state.position, gstime(date))).elevation * 180) / Math.PI;
          visible = elevation >= 10 && sunAt(time) < -6 && shadowFraction(sunPos(jday(date)).rsun, state.position) < 1;
        }
      }
      if (visible) {
        if (!current) current = { from: time, to: time, peak: elevation };
        current.to = time;
        current.peak = Math.max(current.peak, elevation);
      } else if (current) {
        passes.push({ station, ...current });
        current = null;
      }
    }
    if (current) passes.push({ station, ...current });
  }
  return { passes: passes.sort((a, b) => a.from - b.from), covered };
}

const stationLabel = (noradId: number) => (noradId === 25544 ? "ISS" : "天宫");

/**
 * Events of the enabled layers inside the span. Rise and set use the sea-level
 * horizon and the plan's refraction like the Sun and Moon; the comet uses its
 * direction at the middle of the span.
 */
export function timelineEvents(
  plan: EventPlan,
  window: TimelineWindow,
  inputs: { comets?: CometCatalog | null; orbits?: OrbitSnapshot | null } = {},
): TimelineEvents {
  const events: TimelineEvent[] = [], missing: string[] = [];
  const start = Temporal.Instant.from(window.start), end = Temporal.Instant.from(window.end);
  const night = nightLayers.some((key) => plan.layers[key]);
  const horizon = horizonNote(plan.refraction);
  const allSpan = (found: { aboveAtStart: boolean }) => `（全程在地平线${found.aboveAtStart ? "上" : "下"}）`;
  if (plan.layers.sun || plan.layers.moon || night) {
    for (const event of sunMoonEvents(plan, start, end)) {
      const layerOn = event.id.startsWith("sun") ? plan.layers.sun
        : event.id.startsWith("moon") ? plan.layers.moon : night;
      if (!layerOn) continue;
      if (event.instant) events.push({ key: event.id, kind: event.id, label: event.label, instant: event.instant, detail: event.definition });
      else missing.push(event.label);
    }
  }
  const pairs = (found: readonly { direction: 1 | -1; time: number }[], key: string, names: [string, string], detail: (rise: boolean) => string) => {
    for (const { direction, time } of found) {
      const rise = direction === 1;
      events.push({
        key: `${key}-${rise ? "rise" : "set"}-${time}`,
        kind: `${key}-${rise ? "rise" : "set"}` as TimelineEventKind,
        label: rise ? names[0] : names[1],
        instant: round(time),
        detail: detail(rise),
      });
    }
    return found.length > 0;
  };
  if (plan.layers.milkyWay) {
    const found = fixedRiseSet(plan, window, 17 + 45 / 60 + 40.034047 / 3600, -29 - 28.21601 / 3600);
    if (!pairs(found, "core", ["银心升", "银心落"], (rise) => `银心${rise ? "升起" : "落下"}：${horizon}`)) missing.push(`银心升落${allSpan(found)}`);
  }
  const middle = new Date((Date.parse(window.start) + Date.parse(window.end)) / 2).toISOString();
  if (plan.layers.meteors) {
    const strongest = activeShowers({ latitude: plan.latitude, longitude: plan.longitude, instant: middle })
      .filter((shower) => shower.zhr !== null)
      .sort((a, b) => b.zhr! - a.zhr!)[0];
    if (!strongest) missing.push("活动流星雨");
    else {
      const found = fixedRiseSet(plan, window, strongest.radiant[0] / 15, strongest.radiant[1]);
      if (!pairs(found, "radiant", ["辐射点升", "辐射点落"], (rise) => `${strongest.shower.name}辐射点${rise ? "升起" : "落下"}：${horizon}`))
        missing.push(`${strongest.shower.name}辐射点升落${allSpan(found)}`);
    }
  }
  if (plan.layers.comets && inputs.comets) {
    const brightest = cometScene({ latitude: plan.latitude, longitude: plan.longitude, instant: middle }, inputs.comets).views[0];
    if (!brightest) missing.push("列表彗星");
    else {
      const time = MakeTime(new Date(middle)), earth = HelioVector(Body.Earth, time);
      const comet = cometState(brightest.comet.orbit, 2451545 + time.tt).r;
      const { ra, dec } = raDec([comet[0] - earth.x, comet[1] - earth.y, comet[2] - earth.z]);
      const found = fixedRiseSet(plan, window, ra, dec);
      if (!pairs(found, "comet", ["彗星升", "彗星落"], (rise) => `${brightest.comet.name}${rise ? "升起" : "落下"}（按时段中点位置近似）：${horizon}`))
        missing.push(`${brightest.comet.name}升落${allSpan(found)}`);
    }
  }
  if (plan.layers.stations && inputs.orbits) {
    const { passes, covered } = visiblePasses(plan, window, inputs.orbits);
    if (!covered) missing.push("空间站过境（轨道数据不覆盖本时段）");
    else if (!passes.length) missing.push("空间站可见过境");
    for (const pass of passes)
      events.push({
        key: `pass-${pass.station.noradId}-${pass.from}`,
        kind: "station-pass",
        label: stationLabel(pass.station.noradId),
        instant: round(pass.from),
        detail: `${pass.station.name}可见过境，约 ${Math.round((pass.to - pass.from) / 60_000) + 1} 分钟，最高 ${Math.round(pass.peak)}°（高于 10°、受照且太阳低于 −6°）`,
      });
  }
  events.sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant) || a.key.localeCompare(b.key));
  return { events, missing };
}

/** The nearest event strictly before or after the instant (one second of tolerance). */
export function neighbourEvent(events: TimelineEvent[], instant: string, direction: 1 | -1) {
  const time = Date.parse(instant);
  const candidates = events.filter((event) => direction * (Date.parse(event.instant) - time) > 1000);
  return direction === 1 ? candidates[0] ?? null : candidates.at(-1) ?? null;
}
