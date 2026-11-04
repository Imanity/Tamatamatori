import { Temporal } from "@js-temporal/polyfill";

export const sensors = {
  "full-frame": { label: "全画幅", width: 36, height: 24 },
  "aps-c": { label: "APS-C · 23.5 × 15.6", width: 23.5, height: 15.6 },
  "micro-four-thirds": { label: "M4/3 · 17.3 × 13", width: 17.3, height: 13 },
} as const;

export const aspectRatios = { "3:2": 3 / 2, "16:9": 16 / 9, "1:1": 1 } as const;

export interface ShootingPlan {
  latitude: number;
  longitude: number;
  azimuth: number;
  pitch: number;
  cameraHeight: number;
  focalLength: number;
  sensor: keyof typeof sensors;
  aspectRatio: keyof typeof aspectRatios;
  orientation: "landscape" | "portrait";
  instant: string;
  timeZone: string;
  layers: { sun: boolean; moon: boolean };
  refraction: "standard" | "none";
}

export const initialPlan: ShootingPlan = {
  latitude: 35.4172,
  longitude: 138.8729,
  azimuth: 247,
  pitch: 4,
  cameraHeight: 1.6,
  focalLength: 35,
  sensor: "full-frame",
  aspectRatio: "3:2",
  orientation: "landscape",
  instant: "2026-11-04T08:00:00Z",
  timeZone: "Asia/Tokyo",
  layers: { sun: true, moon: true },
  refraction: "standard",
};

export function normalizeLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

export function fieldOfView(
  plan: Pick<
    ShootingPlan,
    "focalLength" | "sensor" | "aspectRatio" | "orientation"
  >,
) {
  if (!Number.isFinite(plan.focalLength) || plan.focalLength <= 0) {
    throw new RangeError("焦距必须大于 0");
  }
  const sensor = sensors[plan.sensor];
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

export function instantFromLocal(local: string, timeZone: string) {
  const date = Temporal.PlainDateTime.from(local);
  if (date.year < 1900 || date.year > 2100)
    throw new RangeError("本原型支持 1900—2100 年");
  return date
    .toZonedDateTime(timeZone, { disambiguation: "reject" })
    .toInstant()
    .toString();
}

export function signedAngle(angle: number) {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

export function compassDirection(azimuth: number) {
  return ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][
    Math.round(azimuth / 45) % 8
  ];
}
