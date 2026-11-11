import { Temporal } from "@js-temporal/polyfill";
import type { WeatherModel } from "./weather.ts";

export const sensors = {
  "full-frame": { label: "全画幅", width: 36, height: 24 },
  "aps-c": { label: "APS-C · 23.5 × 15.6", width: 23.5, height: 15.6 },
  "micro-four-thirds": { label: "M4/3 · 17.3 × 13", width: 17.3, height: 13 },
} as const;

export const aspectRatios = { "3:2": 3 / 2, "16:9": 16 / 9, "1:1": 1 } as const;

/** Sensor width and height in millimetres. */
export interface SensorSize {
  width: number;
  height: number;
}
/** A preset sensor or "custom", whose size is `ShootingPlan.customSensor`. */
export type SensorId = keyof typeof sensors | "custom";
export const customSensorLimits = [1, 100] as const;

export interface ShootingPlan {
  latitude: number;
  longitude: number;
  azimuth: number;
  pitch: number;
  cameraHeight: number;
  focalLength: number;
  sensor: SensorId;
  /** Width and height for the "custom" sensor; null when no custom size is set. */
  customSensor?: SensorSize | null;
  aspectRatio: keyof typeof aspectRatios;
  orientation: "landscape" | "portrait";
  instant: string;
  timeZone: string;
  /**
   * The display zone follows the camera position ("当地时区"); `timeZone`
   * still holds the resolved zone. Absent (old sessions and shots) means fixed.
   */
  followLocalZone?: boolean;
  layers: {
    buildings?: boolean;
    sun: boolean;
    /** Sun path around the shooting instant; requires the Sun layer. */
    sunPath?: boolean;
    moon: boolean;
    /** Moon path around the shooting instant; requires the Moon layer. */
    moonPath?: boolean;
    stars: boolean;
    milkyWay: boolean;
    constellations: boolean;
    deepSky: boolean;
    stations: boolean;
    /** Active meteor shower radiants on the shooting date. */
    meteors?: boolean;
    /** Illustrative meteors and the estimate for the night of the shooting instant; requires `meteors`. */
    meteorDensity?: boolean;
    /** Comets of the catalogue brighter than the list limit at the shooting instant. */
    comets?: boolean;
    /** Sea level near the camera (Open-Meteo Marine). */
    tides?: boolean;
    /** Aurora chances from NOAA SWPC forecasts. */
    aurora?: boolean;
  };
  refraction: "standard" | "none";
  milkyWayContrast: number;
  cameraResponse: "stock" | "ha-modified";
  lightPollution?: boolean;
  weather?: boolean;
  weatherModel?: WeatherModel;
}

export const initialPlan: ShootingPlan = {
  latitude: 35.4172,
  longitude: 138.8729,
  azimuth: 247,
  pitch: 4,
  cameraHeight: 1.6,
  focalLength: 35,
  sensor: "full-frame",
  customSensor: null,
  aspectRatio: "3:2",
  orientation: "landscape",
  instant: "2026-11-04T08:00:00Z",
  timeZone: "Asia/Tokyo",
  followLocalZone: true,
  layers: {
    buildings: false,
    sun: true,
    sunPath: false,
    moon: true,
    moonPath: false,
    stars: false,
    milkyWay: false,
    constellations: false,
    deepSky: false,
    stations: false,
    meteors: false,
    meteorDensity: false,
    comets: false,
    tides: false,
    aurora: false,
  },
  refraction: "standard",
  milkyWayContrast: 100,
  cameraResponse: "stock",
  lightPollution: false,
  weather: false,
};

export function normalizeLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/** The sensor in millimetres; a custom sensor without a size falls back to full frame. */
export function sensorSize(plan: Pick<ShootingPlan, "sensor" | "customSensor">): SensorSize {
  if (plan.sensor === "custom") return plan.customSensor ?? sensors["full-frame"];
  return sensors[plan.sensor];
}

/** Identifies the sensor for cache keys, including a custom size. */
export function sensorKey(plan: Pick<ShootingPlan, "sensor" | "customSensor">) {
  const size = sensorSize(plan);
  return plan.sensor === "custom" ? `custom:${size.width}x${size.height}` : plan.sensor;
}

export function fieldOfView(
  plan: Pick<
    ShootingPlan,
    "focalLength" | "sensor" | "aspectRatio" | "orientation"
  > & Partial<Pick<ShootingPlan, "customSensor">>,
) {
  if (!Number.isFinite(plan.focalLength) || plan.focalLength <= 0) {
    throw new RangeError("焦距必须大于 0");
  }
  const sensor = sensorSize(plan);
  const ratio = aspectRatios[plan.aspectRatio];
  const croppedWidth = Math.min(sensor.width, sensor.height * ratio);
  const croppedHeight = Math.min(sensor.height, sensor.width / ratio);
  const width = plan.orientation === "portrait" ? croppedHeight : croppedWidth;
  const height = plan.orientation === "portrait" ? croppedWidth : croppedHeight;
  const toAngle = (size: number) =>
    (2 * Math.atan(size / (2 * plan.focalLength)) * 180) / Math.PI;
  return {
    horizontal: toAngle(width),
    vertical: toAngle(height),
    width,
    height,
  };
}

export function frameAspectRatio(
  plan: Pick<ShootingPlan, "aspectRatio" | "orientation">,
) {
  const ratio = aspectRatios[plan.aspectRatio];
  return plan.orientation === "portrait" ? 1 / ratio : ratio;
}

export function minuteOfDay(instant: string, timeZone: string) {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
  return local.hour * 60 + local.minute;
}

export function instantAtMinute(
  instant: string,
  timeZone: string,
  minute: number,
) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439)
    throw new RangeError("时间滑杆需在 0—1439 分钟之间");
  const date = Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
  const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return instantFromLocal(`${date}T${time}`, timeZone);
}

export function dragView(
  plan: ShootingPlan,
  dx: number,
  dy: number,
  width: number,
  height: number,
) {
  const fov = fieldOfView(plan);
  if (
    width <= 0 ||
    height <= 0 ||
    ![dx, dy, width, height].every(Number.isFinite)
  )
    return { azimuth: plan.azimuth, pitch: plan.pitch };
  const delta = (pixels: number, extent: number, angle: number) =>
    (Math.atan(((2 * pixels) / extent) * Math.tan((angle * Math.PI) / 360)) *
      180) /
    Math.PI;
  const azimuth =
    (((plan.azimuth - delta(dx, width, fov.horizontal)) % 360) + 360) % 360;
  return {
    azimuth,
    pitch: Math.max(
      -90,
      Math.min(90, plan.pitch + delta(dy, height, fov.vertical)),
    ),
  };
}

export function localDateTime(instant: string, timeZone: string) {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

export function instantOnDate(instant: string, timeZone: string, date: string) {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
  return instantFromLocal(`${Temporal.PlainDate.from(date)}T${local.toPlainTime()}`, timeZone);
}

export function localClockTime(instant: string, timeZone: string) {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainTime().toString({ smallestUnit: "second" });
}

export function zoomFocalLength(focalLength: number, delta: number) {
  if (!Number.isFinite(delta)) return focalLength;
  return Math.round(Math.max(8, Math.min(1000, focalLength * Math.exp(-delta * 0.002))) * 10) / 10;
}

export function instantFromLocal(local: string, timeZone: string) {
  const date = Temporal.PlainDateTime.from(local);
  if (date.year < 1900 || date.year > 2100)
    throw new RangeError("本原型支持 1900—2100 年");
  return date
    .toZonedDateTime(timeZone, { disambiguation: "reject" })
    .toInstant()
    .toString();
}

/** Move the shooting instant by whole minutes; crosses local midnight and DST freely. */
export function shiftInstant(instant: string, timeZone: string, minutes: number) {
  if (!Number.isInteger(minutes)) throw new RangeError("时间偏移需为整数分钟");
  const next = Temporal.Instant.from(instant).add({ minutes });
  const year = next.toZonedDateTimeISO(timeZone).year;
  if (year < 1900 || year > 2100) throw new RangeError("本原型支持 1900—2100 年");
  return next.toString();
}

/** Same local clock time on the neighbouring local date; rejects DST-skipped or repeated times. */
export function shiftDate(instant: string, timeZone: string, days: number) {
  const date = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().add({ days });
  return instantOnDate(instant, timeZone, date.toString());
}

const roundHeight = (value: number) =>
  Math.max(0.1, Math.min(100, value < 10 ? Math.round(value * 10) / 10 : Math.round(value)));

/** Camera height slider: logarithmic 0.1–100 m, 0.1 m below 10 m and whole metres above. */
export const cameraHeightSlider = {
  max: 600,
  toPosition: (height: number) => Math.round((Math.log10(Math.max(0.1, Math.min(100, height)) / 0.1) * 600) / 3),
  fromPosition: (position: number) => roundHeight(0.1 * 10 ** ((Math.max(0, Math.min(600, position)) * 3) / 600)),
  /** Arrow keys: one unit per press, since one slider position can be smaller than the rounding unit. */
  step(current: number, direction: 1 | -1) {
    const unit = current < 10 || (current === 10 && direction < 0) ? 0.1 : 1;
    return roundHeight(current + direction * unit);
  },
};

export const focalPresets = [8, 24, 35, 50, 85, 200, 600, 1000];

const focalPosition = (focalLength: number) =>
  Math.round((Math.log(Math.max(8, Math.min(1000, focalLength)) / 8) / Math.log(125)) * 1000);

/**
 * Focal length slider on a logarithmic scale, so 8—100 mm keeps as much travel
 * as 100—1000 mm. Position 0—1000 maps to 8—1000 mm, rounded to 0.1 mm; the
 * position of a common focal length gives exactly that focal length.
 */
export const focalSlider = {
  max: 1000,
  toPosition: focalPosition,
  fromPosition(position: number) {
    const clamped = Math.max(0, Math.min(1000, Math.round(position)));
    const preset = focalPresets.find((focal) => focalPosition(focal) === clamped);
    return preset ?? Math.round(8 * 125 ** (clamped / 1000) * 10) / 10;
  },
};

/**
 * Reads "latitude, longitude" pasted as one piece of text (comma, Chinese
 * comma or whitespace between two decimal degrees). Returns null otherwise.
 */
export function parseCoordinatePair(text: string) {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude: longitude === 180 ? normalizeLongitude(longitude) : longitude };
}

export function signedAngle(angle: number) {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

export function compassDirection(azimuth: number) {
  return ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][
    Math.round(azimuth / 45) % 8
  ];
}
