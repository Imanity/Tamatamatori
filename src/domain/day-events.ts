import { Temporal } from "@js-temporal/polyfill";
import { Body, Observer, Refraction, SearchAltitude } from "astronomy-engine";
import type { ShootingPlan } from "./plan.ts";
import { celestialBodies, sunPosition } from "./ephemeris.ts";

type DayInput = Pick<ShootingPlan, "latitude" | "longitude" | "instant" | "timeZone" | "refraction">;

export type DayEventId = "dawn" | "sunrise" | "sunset" | "dusk" | "moonrise" | "moonset";
export interface DayEvent {
  id: DayEventId;
  label: string;
  /** Rounded to the second; null when the event does not happen on this local date. */
  instant: string | null;
  definition: string;
}

// Mean apparent radii for the first pass; the second pass uses the radius at the found time.
const meanRadius = { [Body.Sun]: 0.2666, [Body.Moon]: 0.2591 } as Record<Body, number>;

/**
 * Geometric centre altitude at which the upper limb sits on the sea-level
 * horizon in the preview: e + R(e) + radius = 0 with the preview's own
 * refraction (astronomy-engine "normal"), not the almanac's fixed 34′.
 */
function limbAltitude(radius: number, refraction: ShootingPlan["refraction"]) {
  if (refraction === "none") return -radius;
  let altitude = -radius - 0.5;
  for (let pass = 0; pass < 6; pass++) altitude = -radius - Math.max(0, Refraction("normal", altitude));
  return altitude;
}

/** The local calendar day containing the instant, as UTC instants (23–25 h around DST changes). */
export function localDay(instant: string, timeZone: string) {
  const date = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate();
  const start = date.toZonedDateTime({ timeZone });
  const end = date.add({ days: 1 }).toZonedDateTime({ timeZone });
  return { date, start: start.toInstant(), end: end.toInstant() };
}

const definitions: readonly {
  id: DayEventId;
  label: string;
  body: Body.Sun | Body.Moon;
  direction: 1 | -1;
  twilight?: number;
}[] = [
  { id: "dawn", label: "晨光", body: Body.Sun, direction: 1, twilight: -18 },
  { id: "sunrise", label: "日出", body: Body.Sun, direction: 1 },
  { id: "sunset", label: "日落", body: Body.Sun, direction: -1 },
  { id: "dusk", label: "昏影", body: Body.Sun, direction: -1, twilight: -18 },
  { id: "moonrise", label: "月出", body: Body.Moon, direction: 1 },
  { id: "moonset", label: "月落", body: Body.Moon, direction: -1 },
];

function describe(id: DayEventId, refraction: ShootingPlan["refraction"]) {
  if (id === "dawn") return "天文晨光始：太阳中心升至地平下 18°";
  if (id === "dusk") return "天文昏影终：太阳中心降至地平下 18°";
  const body = id.startsWith("sun") ? "太阳" : "月亮";
  const motion = id.endsWith("rise") ? "升至" : "降至";
  const horizon = refraction === "standard" ? "海平面地平（标准折射）" : "几何地平（无折射）";
  return `${body}上缘${motion}${horizon}，不含地形遮挡`;
}

/**
 * Sun and Moon events on the local date of the shooting instant, for an
 * observer at the reference ellipsoid (the same observer as the rendered sky).
 * Rise and set use the plan's refraction mode and the body's radius at the
 * event, so the jump lands where the preview shows the upper limb on the
 * sea-level horizon; terrain and the observer's horizon dip are ignored.
 */
export function dayEvents(plan: DayInput): DayEvent[] {
  const { start, end } = localDay(plan.instant, plan.timeZone);
  const observer = new Observer(plan.latitude, plan.longitude, 0);
  const from = new Date(start.epochMilliseconds);
  const days = (end.epochMilliseconds - start.epochMilliseconds) / 86400000;
  return definitions.map(({ id, label, body, direction, twilight }) => {
    let found = null;
    try {
      if (twilight !== undefined) found = SearchAltitude(body, observer, direction, from, days, twilight);
      else {
        found = SearchAltitude(body, observer, direction, from, days, limbAltitude(meanRadius[body], plan.refraction));
        if (found) {
          const bodies = celestialBodies({ latitude: plan.latitude, longitude: plan.longitude, instant: found.date.toISOString() });
          const radius = (body === Body.Sun ? bodies.sun : bodies.moon).angularRadius;
          found = SearchAltitude(body, observer, direction, from, days, limbAltitude(radius, plan.refraction)) ?? found;
        }
      }
    } catch {
      found = null;
    }
    const time = found ? Math.round(found.date.getTime() / 1000) * 1000 : NaN;
    const instant =
      Number.isFinite(time) && time >= start.epochMilliseconds && time < end.epochMilliseconds
        ? Temporal.Instant.fromEpochMilliseconds(time).toString()
        : null;
    return { id, label, instant, definition: describe(id, plan.refraction) };
  });
}

/**
 * Geometric Sun elevation at wall-clock minutes of the local date, for the
 * daylight band behind the time slider. Minute 1440 is the next local midnight.
 */
export function sunElevationByMinute(plan: Omit<DayInput, "refraction">, step = 10) {
  const { date } = localDay(plan.instant, plan.timeZone);
  const samples: { minute: number; elevation: number }[] = [];
  for (let minute = 0; minute <= 1440; minute += step) {
    const local = date.toPlainDateTime().add({ minutes: minute });
    const instant = local.toZonedDateTime(plan.timeZone, { disambiguation: "compatible" }).toInstant().toString();
    samples.push({ minute, elevation: sunPosition({ latitude: plan.latitude, longitude: plan.longitude, instant }).elevation });
  }
  return samples;
}
