import { Temporal } from "@js-temporal/polyfill";
import { aspectRatios, initialPlan, sensors } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { weatherModels } from "./weather.ts";
import type { WeatherModel } from "./weather.ts";

/**
 * A shot ("机位") is the external, versioned description of everything that
 * decides the preview picture. Saved shots, the restored session, share codes
 * and hand- or AI-written JSON all go through this one codec.
 */
export const SHOT_FORMAT = "tamatamatori.shot";
export const SHOT_VERSION = 1;
export const SHOT_TEXT_LIMIT = 16 * 1024;
export const SHOT_NAME_LIMIT = 40;
export const SHOT_NOTE_LIMIT = 500;
export const SHARE_PREFIX = "tmt1:";

export const shotLimits = {
  latitude: [-90, 90],
  pitch: [-90, 90],
  heightAboveGround: [0.1, 100],
  focalLength: [8, 1000],
  milkyWayContrast: [25, 200],
  year: [1900, 2100],
} as const;

export const shotLayerKeys = [
  "buildings",
  "sun",
  "sunPath",
  "moon",
  "moonPath",
  "stars",
  "constellations",
  "milkyWay",
  "deepSky",
  "stations",
  "meteors",
  "meteorDensity",
] as const;
type LayerKey = (typeof shotLayerKeys)[number];
// Adding a layer to the plan without listing it here fails to compile.
const allLayersListed: [Exclude<keyof ShootingPlan["layers"], LayerKey>] extends [never] ? true : never = true;
void allLayersListed;

export interface Shot {
  format: typeof SHOT_FORMAT;
  version: typeof SHOT_VERSION;
  name: string;
  note: string;
  position: { latitude: number; longitude: number; heightAboveGround: number };
  view: { azimuth: number; pitch: number };
  camera: {
    focalLength: number;
    sensor: ShootingPlan["sensor"];
    aspectRatio: ShootingPlan["aspectRatio"];
    orientation: ShootingPlan["orientation"];
    response: ShootingPlan["cameraResponse"];
  };
  time: { instant: string; local: string; timeZone: string; refraction: ShootingPlan["refraction"] };
  layers: Record<LayerKey, boolean>;
  sky: { milkyWayContrast: number };
  environment: { lightPollution: boolean; weather: boolean; weatherModel: WeatherModel };
}

export type ShotParse =
  | { ok: true; shot: Shot; plan: ShootingPlan; defaults: string[] }
  | { ok: false; errors: string[] };

// In-range values pass through untouched: the modulo arithmetic would add
// floating-point noise (123.456789 → 123.45678900000001).
const normalizeAngle = (value: number) => (value >= 0 && value < 360 ? value : ((value % 360) + 360) % 360);
const normalizeLongitude = (value: number) =>
  value >= -180 && value < 180 ? value : ((((value + 180) % 360) + 360) % 360) - 180;

/** Canonical IANA id when both Intl and Temporal accept the zone, else null. */
export function validTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return Temporal.Instant.from("2000-01-01T00:00:00Z").toZonedDateTimeISO(zone).timeZoneId;
  } catch {
    return null;
  }
}

export function shotLocalTime(instant: string, timeZone: string) {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: "second" });
}

export function shotFromPlan(plan: ShootingPlan, name = "", note = ""): Shot {
  return {
    format: SHOT_FORMAT,
    version: SHOT_VERSION,
    name,
    note,
    position: {
      latitude: plan.latitude,
      longitude: plan.longitude,
      heightAboveGround: plan.cameraHeight,
    },
    view: { azimuth: plan.azimuth, pitch: plan.pitch },
    camera: {
      focalLength: plan.focalLength,
      sensor: plan.sensor,
      aspectRatio: plan.aspectRatio,
      orientation: plan.orientation,
      response: plan.cameraResponse,
    },
    time: {
      instant: plan.instant,
      local: shotLocalTime(plan.instant, plan.timeZone),
      timeZone: plan.timeZone,
      refraction: plan.refraction,
    },
    layers: Object.fromEntries(shotLayerKeys.map((key) => [key, !!plan.layers[key]])) as Shot["layers"],
    sky: { milkyWayContrast: plan.milkyWayContrast },
    environment: {
      lightPollution: !!plan.lightPollution,
      weather: !!plan.weather,
      weatherModel: plan.weatherModel ?? "best_match",
    },
  };
}

export function planFromShot(shot: Shot): ShootingPlan {
  // `satisfies Required<…>` makes a new plan field a compile error here, so
  // the format cannot silently stop reproducing the picture.
  const plan = {
    latitude: shot.position.latitude,
    longitude: shot.position.longitude,
    cameraHeight: shot.position.heightAboveGround,
    azimuth: shot.view.azimuth,
    pitch: shot.view.pitch,
    focalLength: shot.camera.focalLength,
    sensor: shot.camera.sensor,
    aspectRatio: shot.camera.aspectRatio,
    orientation: shot.camera.orientation,
    cameraResponse: shot.camera.response,
    instant: shot.time.instant,
    timeZone: shot.time.timeZone,
    refraction: shot.time.refraction,
    layers: { ...shot.layers },
    milkyWayContrast: shot.sky.milkyWayContrast,
    lightPollution: shot.environment.lightPollution,
    weather: shot.environment.weather,
    weatherModel: shot.environment.weatherModel,
  } satisfies Required<ShootingPlan>;
  return plan;
}

/** Everything that affects the picture; name and note are left out. */
export function shotSignature(shot: Shot) {
  const { name: _name, note: _note, ...picture } = shot;
  return JSON.stringify(picture);
}
export const planSignature = (plan: ShootingPlan) => shotSignature(shotFromPlan(plan));

export function shotJson(shot: Shot) {
  return JSON.stringify(shot, null, 2);
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(text: string) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function shareCode(shot: Shot) {
  return SHARE_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(shot)));
}

const fail = (...errors: string[]): ShotParse => ({ ok: false, errors });
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
};

/** Accepts a share code, plain JSON (optionally in a code fence) or a link carrying `#shot=`. */
export function parseShotText(text: string): ShotParse {
  if (text.length > SHOT_TEXT_LIMIT) return fail(`内容超过 ${SHOT_TEXT_LIMIT / 1024} KB，不是有效的机位`);
  let body = text.trim();
  if (!body) return fail("内容为空");
  const fenced = body.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fenced) body = fenced[1].trim();
  const hash = body.match(/#shot=([\s\S]+)$/);
  if (hash) {
    body = hash[1].trim();
    try {
      body = decodeURIComponent(body);
    } catch {
      return fail("链接中的机位编码无效");
    }
  }
  if (body.startsWith("json:")) body = body.slice(5).trim();
  let json = body;
  if (body.startsWith(SHARE_PREFIX)) {
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(body.slice(SHARE_PREFIX.length).replace(/\s+/g, "")));
    } catch {
      return fail("分享码已损坏：无法解码，请确认复制完整");
    }
  } else if (!body.startsWith("{")) {
    return fail(`无法识别：应为以 ${SHARE_PREFIX} 开头的分享码，或以 { 开头的 JSON`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return fail(`JSON 格式错误：${(error as Error).message}`);
  }
  return parseShot(value);
}

const topKeys = ["$schema", "format", "version", "name", "note", "position", "view", "camera", "time", "layers", "sky", "environment"];
const groupKeys: Record<string, readonly string[]> = {
  position: ["latitude", "longitude", "heightAboveGround"],
  view: ["azimuth", "pitch"],
  camera: ["focalLength", "sensor", "aspectRatio", "orientation", "response"],
  time: ["instant", "local", "timeZone", "refraction"],
  layers: shotLayerKeys,
  sky: ["milkyWayContrast"],
  environment: ["lightPollution", "weather", "weatherModel"],
};
// Written only by an unreleased development build (2026-11-09, meteor shooting hours);
// accepted and ignored so locally saved test shots still load.
const retiredKeys: Record<string, readonly string[]> = { sky: ["meteorHours"] };

/** Validates a decoded shot; reports every problem with its field path. */
export function parseShot(value: unknown): ShotParse {
  if (!isObject(value)) return fail("顶层应为 JSON 对象");
  const errors: string[] = [], defaults: string[] = [];
  for (const key of Object.keys(value)) if (!topKeys.includes(key)) errors.push(`${key}：未知字段`);
  if (value.format !== SHOT_FORMAT) errors.push(`format：应为 "${SHOT_FORMAT}"，收到 ${shown(value.format)}`);
  if (typeof value.version === "number" && Number.isInteger(value.version) && value.version > SHOT_VERSION)
    return fail(`version：此机位来自更新版本的应用（版本 ${value.version}），请刷新页面后再导入`);
  if (value.version !== SHOT_VERSION) errors.push(`version：应为 ${SHOT_VERSION}，收到 ${shown(value.version)}`);

  const group = (key: string, required: boolean) => {
    const item = value[key];
    if (item === undefined) {
      if (required) errors.push(`${key}：缺少该字段`);
      return {} as Record<string, unknown>;
    }
    if (!isObject(item)) {
      errors.push(`${key}：应为对象，收到 ${shown(item)}`);
      return {} as Record<string, unknown>;
    }
    for (const field of Object.keys(item))
      if (!groupKeys[key].includes(field) && !retiredKeys[key]?.includes(field)) errors.push(`${key}.${field}：未知字段`);
    return item;
  };
  function number(source: Record<string, unknown>, path: string, fallback: number | undefined, range?: readonly [number, number], normalize?: (value: number) => number) {
    const item = source[path.split(".")[1]];
    if (item === undefined) {
      if (fallback === undefined) errors.push(`${path}：缺少该字段`);
      else defaults.push(path);
      return fallback ?? 0;
    }
    if (typeof item !== "number" || !Number.isFinite(item)) {
      errors.push(`${path}：应为数字，收到 ${shown(item)}`);
      return fallback ?? 0;
    }
    if (range && (item < range[0] || item > range[1])) {
      errors.push(`${path}：应在 ${range[0]}～${range[1]} 之间，收到 ${item}`);
      return fallback ?? 0;
    }
    return normalize ? normalize(item) : item;
  }
  function choice<T extends string>(source: Record<string, unknown>, path: string, options: readonly T[], fallback: T) {
    const item = source[path.split(".")[1]];
    if (item === undefined) {
      defaults.push(path);
      return fallback;
    }
    if (typeof item !== "string" || !options.includes(item as T)) {
      errors.push(`${path}：应为 ${options.map((option) => `"${option}"`).join(" / ")} 之一，收到 ${shown(item)}`);
      return fallback;
    }
    return item as T;
  }
  function flag(source: Record<string, unknown>, path: string, fallback: boolean) {
    const item = source[path.split(".")[1]];
    if (item === undefined) {
      defaults.push(path);
      return fallback;
    }
    if (typeof item !== "boolean") {
      errors.push(`${path}：应为 true 或 false，收到 ${shown(item)}`);
      return fallback;
    }
    return item;
  }
  function text(source: Record<string, unknown>, key: "name" | "note", limit: number) {
    const item = source[key];
    if (item === undefined) return "";
    if (typeof item !== "string") {
      errors.push(`${key}：应为文本，收到 ${shown(item)}`);
      return "";
    }
    const trimmed = item.trim();
    if ([...trimmed].length > limit) errors.push(`${key}：最多 ${limit} 字`);
    return trimmed;
  }

  const name = text(value, "name", SHOT_NAME_LIMIT), note = text(value, "note", SHOT_NOTE_LIMIT);
  const position = group("position", true);
  const latitude = number(position, "position.latitude", undefined, shotLimits.latitude);
  const longitude = number(position, "position.longitude", undefined, undefined, normalizeLongitude);
  const heightAboveGround = number(position, "position.heightAboveGround", initialPlan.cameraHeight, shotLimits.heightAboveGround);
  const view = group("view", true);
  const azimuth = number(view, "view.azimuth", undefined, undefined, normalizeAngle);
  const pitch = number(view, "view.pitch", initialPlan.pitch, shotLimits.pitch);
  const camera = group("camera", false);
  const focalLength = number(camera, "camera.focalLength", initialPlan.focalLength, shotLimits.focalLength);
  const sensor = choice(camera, "camera.sensor", Object.keys(sensors) as ShootingPlan["sensor"][], initialPlan.sensor);
  const aspectRatio = choice(camera, "camera.aspectRatio", Object.keys(aspectRatios) as ShootingPlan["aspectRatio"][], initialPlan.aspectRatio);
  const orientation = choice(camera, "camera.orientation", ["landscape", "portrait"] as const, initialPlan.orientation);
  const response = choice(camera, "camera.response", ["stock", "ha-modified"] as const, initialPlan.cameraResponse);

  const time = group("time", true);
  const refraction = choice(time, "time.refraction", ["standard", "none"] as const, initialPlan.refraction);
  let timeZone = "UTC";
  if (time.timeZone === undefined) {
    if (time.local !== undefined) errors.push("time.timeZone：使用 time.local 时必须给出 IANA 时区，例如 \"Asia/Tokyo\"");
    else if (time.instant !== undefined) defaults.push("time.timeZone");
  } else if (typeof time.timeZone !== "string" || !validTimeZone(time.timeZone)) {
    errors.push(`time.timeZone：应为有效的 IANA 时区，例如 "Asia/Tokyo"，收到 ${shown(time.timeZone)}`);
  } else timeZone = validTimeZone(time.timeZone)!;
  const inYears = (year: number) => year >= shotLimits.year[0] && year <= shotLimits.year[1];
  let instant: string | undefined, fromLocal: string | undefined, local: Temporal.PlainDateTime | undefined;
  if (time.instant !== undefined) {
    try {
      if (typeof time.instant !== "string") throw new TypeError();
      instant = Temporal.Instant.from(time.instant).toString();
      if (!inYears(Temporal.Instant.from(instant).toZonedDateTimeISO("UTC").year)) {
        errors.push(`time.instant：只支持 ${shotLimits.year[0]}—${shotLimits.year[1]} 年`);
        instant = undefined;
      }
    } catch {
      errors.push(`time.instant：应为带 Z 或时差的 ISO 时刻，例如 "2026-12-14T17:30:00Z"，收到 ${shown(time.instant)}`);
    }
  }
  if (time.local !== undefined && time.timeZone !== undefined) {
    try {
      if (typeof time.local !== "string" || /[zZ]$/.test(time.local)) throw new TypeError();
      local = Temporal.PlainDateTime.from(time.local);
    } catch {
      errors.push(`time.local：应为当地日期时间，例如 "2026-12-15T02:30"，收到 ${shown(time.local)}`);
    }
    if (local && !inYears(local.year)) errors.push(`time.local：只支持 ${shotLimits.year[0]}—${shotLimits.year[1]} 年`);
    else if (local && validTimeZone(String(time.timeZone))) {
      try {
        fromLocal = local.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant().toString();
      } catch {
        errors.push(`time.local：${time.local} 在 ${timeZone} 因夏令时切换不存在或出现两次，请改用 time.instant`);
      }
    }
  } else if (time.local !== undefined && typeof time.local !== "string") {
    errors.push(`time.local：应为文本，收到 ${shown(time.local)}`);
  }
  if (instant && fromLocal && local) {
    // Both given: the instant decides; the local time must describe it to the
    // precision it was written with (minutes or seconds).
    const described = shotLocalTime(instant, timeZone), given = local.toString({ smallestUnit: "second" });
    const digits = String(time.local).length > 16 ? 19 : 16;
    if (described.slice(0, digits) !== given.slice(0, digits))
      errors.push(`time.local：与 time.instant 不一致（${instant} 在 ${timeZone} 为 ${described}）`);
  }
  if (time.instant === undefined && time.local === undefined && isObject(value.time))
    errors.push("time：需要 instant（UTC 时刻），或 local 加 timeZone");
  const resolvedInstant = instant ?? fromLocal ?? initialPlan.instant;

  const layers = group("layers", false);
  const layerValues = Object.fromEntries(
    shotLayerKeys.map((key) => [key, flag(layers, `layers.${key}`, !!initialPlan.layers[key])]),
  ) as Shot["layers"];
  if (layerValues.constellations && !layerValues.stars) errors.push("layers.constellations：需要同时开启 layers.stars");
  if (layerValues.sunPath && !layerValues.sun) errors.push("layers.sunPath：需要同时开启 layers.sun");
  if (layerValues.moonPath && !layerValues.moon) errors.push("layers.moonPath：需要同时开启 layers.moon");
  if (layerValues.meteorDensity && !layerValues.meteors) errors.push("layers.meteorDensity：需要同时开启 layers.meteors");
  const sky = group("sky", false);
  const milkyWayContrast = number(sky, "sky.milkyWayContrast", initialPlan.milkyWayContrast, shotLimits.milkyWayContrast);
  const environment = group("environment", false);
  const lightPollution = flag(environment, "environment.lightPollution", !!initialPlan.lightPollution);
  const weather = flag(environment, "environment.weather", !!initialPlan.weather);
  const weatherModel = choice(environment, "environment.weatherModel", Object.keys(weatherModels) as WeatherModel[], "best_match");

  if (errors.length) return { ok: false, errors };
  const shot: Shot = {
    format: SHOT_FORMAT,
    version: SHOT_VERSION,
    name,
    note,
    position: { latitude, longitude, heightAboveGround },
    view: { azimuth, pitch },
    camera: { focalLength, sensor, aspectRatio, orientation, response },
    time: { instant: resolvedInstant, local: shotLocalTime(resolvedInstant, timeZone), timeZone, refraction },
    layers: layerValues,
    sky: { milkyWayContrast },
    environment: { lightPollution, weather, weatherModel },
  };
  return { ok: true, shot, plan: planFromShot(shot), defaults };
}
