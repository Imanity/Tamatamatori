import { Temporal } from "@js-temporal/polyfill";
import { landmarks } from "./landmarks.ts";
import { fixedBodies, isSolveBody } from "./sky-targets.ts";
import { bodyRadius, skyConditions, spanChoices as timeSpans, targetElevationRange, toleranceChoices } from "./alignment.ts";
import type { AlignmentBody, SkyCondition } from "./alignment.ts";
import { MIN_SUBJECT, spanChoices as rangeSpans } from "./range-alignment.ts";
import { distanceChoices } from "./position-alignment.ts";
import { shotLimits, validTimeZone } from "./shot.ts";
import { aspectRatios, customSensorLimits, fieldOfView, initialPlan, instantFromLocal, instantOnDate, localDateTime, sensors } from "./plan.ts";
import { canSkyline, darkSkyChoices, dayChoices, dayLabel, DEFAULT_TOLERANCE, MAX_LINE_DAYS, nearestChoices, TARGET_LIMIT } from "./composition.ts";
import { MIN_DISTANCE } from "./position-alignment.ts";
import type { CameraRange, Composition, FilterSpec, FrameSpot, HeightReference, Lens, TargetSpec, TimeRange } from "./composition.ts";
import type { ShootingPlan } from "./plan.ts";
import { timelineMode, timelineWindow } from "./timeline.ts";

/**
 * A 推算 request ("tamatamatori.solve"): what to search for, written by a
 * person or an AI and opened as a link. It describes the intent; the app
 * solves it locally, and the results it tries out are ordinary shots.
 */
export const SOLVE_FORMAT = "tamatamatori.solve";
export const SOLVE_VERSION = 1;
export const SOLVE_TEXT_LIMIT = 16 * 1024;
export const SOLVE_NAME_LIMIT = 40;
export const solveKinds = ["time", "position", "range"] as const;
export type SolveKind = (typeof solveKinds)[number];
/** The Sun, the Moon, then the fixed bodies (Galactic Centre, named stars, deep-sky targets). */
export const solveBodies: readonly AlignmentBody[] = ["sun", "moon", ...fixedBodies.map((body) => body.id)];
export const timeDays = timeSpans.map((choice) => choice.days);
export const rangeDays = [...rangeSpans];
export const shareLimits = [0.05, 0.5] as const;
export const targetHeightLimits = [0, 1000] as const;
/** Elevations a "sea" (海拔) height may take, metres. */
export const seaHeightLimits = [-500, 9000] as const;
/** Moon phase bounds follow the panel's choices (lit fraction). */
export const phaseChoices = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;
export const landmarkIds = landmarks.map((landmark) => landmark.id);

export interface SolveRequest {
  format: typeof SOLVE_FORMAT;
  version: typeof SOLVE_VERSION;
  name: string;
  kind: SolveKind;
  body: AlignmentBody;
  /** 找时间: apparent direction of the body's centre. */
  mark?: { azimuth: number; elevation: number };
  /** 找时间: where the camera stands; the current camera when absent. */
  camera?: { latitude: number; longitude: number; heightAboveGround?: number };
  /** 找机位 / 两者都找: resolved ground target. */
  target?: { landmark?: string; latitude: number; longitude: number; height: number; name: string };
  /** 找机位 / 两者都找: where the target's top sits in the frame, 0—1 from the top-left; the centre when absent. */
  frame?: { x: number; y: number };
  /** Local date: the day (找机位) or the first day (找时间、两者都找); the current shooting date when absent. */
  date?: string;
  days?: number;
  timeZone?: string;
  tolerance?: number;
  share?: number;
  maxDistance?: number;
  phase?: readonly [number, number];
  sky?: readonly SkyCondition[];
}

export type SolveParse =
  | { ok: true; request: SolveRequest; defaults: string[]; landmark: boolean }
  | { ok: false; errors: string[] };

const fail = (...errors: string[]): SolveParse => ({ ok: false, errors });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
};
const normalizeAngle = (value: number) => (value >= 0 && value < 360 ? value : ((value % 360) + 360) % 360);
const normalizeLongitude = (value: number) => (value >= -180 && value < 180 ? value : ((((value + 180) % 360) + 360) % 360) - 180);

const topKeys = ["$schema", "format", "version", "name", "kind", "body", "mark", "camera", "target", "frame", "date", "days", "timeZone", "tolerance", "share", "maxDistance", "phase", "sky"];
/** Fields each kind accepts besides the common ones. */
const kindKeys: Record<SolveKind, readonly string[]> = {
  time: ["mark", "camera", "date", "days", "timeZone", "tolerance", "phase", "sky"],
  position: ["target", "frame", "date", "timeZone", "maxDistance"],
  range: ["target", "frame", "date", "days", "timeZone", "share", "maxDistance", "phase", "sky"],
};
const common = ["$schema", "format", "version", "name", "kind", "body"];

/** The JSON value in plain JSON (optionally in a code fence) or a link carrying `#solve=`. */
export function extractSolveJson(text: string): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const no = (error: string) => ({ ok: false as const, errors: [error] });
  if (text.length > SOLVE_TEXT_LIMIT) return no(`内容超过 ${SOLVE_TEXT_LIMIT / 1024} KB，不是有效的推算请求`);
  let body = text.trim();
  if (!body) return no("内容为空");
  const fenced = body.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fenced) body = fenced[1].trim();
  const hash = body.match(/#solve=([\s\S]+)$/);
  if (hash) {
    try {
      body = decodeURIComponent(hash[1].trim());
    } catch {
      return no("链接中的推算请求编码无效");
    }
  }
  if (body.startsWith("json:")) body = body.slice(5).trim();
  if (!body.startsWith("{")) return no("无法识别：应为以 { 开头的 JSON，或带 #solve=json: 的链接");
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return no(`JSON 格式错误：${(error as Error).message}`);
  }
}

/** Validates a request; reports every problem with its field path. */
export function parseSolve(value: unknown): SolveParse {
  if (!isObject(value)) return fail("顶层应为 JSON 对象");
  const errors: string[] = [], defaults: string[] = [];
  for (const key of Object.keys(value)) if (!topKeys.includes(key)) errors.push(`${key}：未知字段`);
  if (value.format !== SOLVE_FORMAT) errors.push(`format：应为 "${SOLVE_FORMAT}"，收到 ${shown(value.format)}`);
  if (typeof value.version === "number" && Number.isInteger(value.version) && value.version > SOLVE_VERSION)
    return fail(`version：此推算请求来自更新版本的应用（版本 ${value.version}），请刷新页面后再打开`);
  if (value.version !== SOLVE_VERSION) errors.push(`version：应为 ${SOLVE_VERSION}，收到 ${shown(value.version)}`);
  const kind = solveKinds.includes(value.kind as SolveKind) ? (value.kind as SolveKind) : null;
  if (!kind) errors.push(`kind：应为 ${solveKinds.map((item) => `"${item}"`).join(" / ")} 之一，收到 ${shown(value.kind)}`);
  const body = isSolveBody(value.body) ? value.body : null;
  if (!body) errors.push(`body：应为 "sun"、"moon"、"galactic-center"，或亮星（hyg-…）、深空目标（dso-…）的 id，收到 ${shown(value.body)}`);
  if (kind) for (const key of Object.keys(value)) if (topKeys.includes(key) && !common.includes(key) && !kindKeys[kind].includes(key))
    errors.push(`${key}：kind 为 "${kind}" 时不使用该字段`);

  let name = "";
  if (value.name !== undefined) {
    if (typeof value.name !== "string") errors.push(`name：应为文本，收到 ${shown(value.name)}`);
    else if ([...value.name.trim()].length > SOLVE_NAME_LIMIT) errors.push(`name：最多 ${SOLVE_NAME_LIMIT} 字`);
    else name = value.name.trim();
  }
  const number = (source: Record<string, unknown>, path: string, range?: readonly [number, number]) => {
    const item = source[path.split(".").at(-1)!];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      errors.push(`${path}：应为数字，收到 ${shown(item)}`);
      return null;
    }
    if (range && (item < range[0] || item > range[1])) {
      errors.push(`${path}：应在 ${range[0]}～${range[1]} 之间，收到 ${item}`);
      return null;
    }
    return item;
  };
  const object = (key: string, fields: readonly string[]) => {
    const item = value[key];
    if (!isObject(item)) {
      errors.push(`${key}：应为对象，收到 ${shown(item)}`);
      return null;
    }
    for (const field of Object.keys(item)) if (!fields.includes(field)) errors.push(`${key}.${field}：未知字段`);
    return item;
  };
  const request: SolveRequest = { format: SOLVE_FORMAT, version: SOLVE_VERSION, name, kind: kind ?? "time", body: body ?? "sun" };
  let landmark = false;

  if (kind === "time") {
    if (value.mark === undefined) errors.push("mark：找时间需要天体中心的视方位与视高度，例如 { \"azimuth\": 244.6, \"elevation\": 10.7 }");
    else {
      const mark = object("mark", ["azimuth", "elevation"]);
      if (mark) {
        const azimuth = number(mark, "mark.azimuth"), elevation = number(mark, "mark.elevation", targetElevationRange);
        if (azimuth !== null && elevation !== null) request.mark = { azimuth: normalizeAngle(azimuth), elevation };
      }
    }
    if (value.camera === undefined) defaults.push("camera");
    else {
      const camera = object("camera", ["latitude", "longitude", "heightAboveGround"]);
      if (camera) {
        const latitude = number(camera, "camera.latitude", shotLimits.latitude), longitude = number(camera, "camera.longitude");
        const height = camera.heightAboveGround === undefined ? undefined : number(camera, "camera.heightAboveGround", shotLimits.heightAboveGround);
        if (latitude !== null && longitude !== null && height !== null)
          request.camera = { latitude, longitude: normalizeLongitude(longitude), ...(height === undefined ? {} : { heightAboveGround: height }) };
      }
    }
  }
  if (kind === "position" || kind === "range") {
    if (value.target === undefined) errors.push("target：需要地面目标，例如 { \"landmark\": \"tokyo-skytree\" } 或 { \"latitude\": 35.36, \"longitude\": 138.73, \"height\": 0 }");
    else {
      const target = object("target", ["landmark", "latitude", "longitude", "height", "name"]);
      if (target) {
        const height = target.height === undefined ? undefined : number(target, "target.height", targetHeightLimits);
        let label: string | undefined;
        if (target.name !== undefined) {
          if (typeof target.name !== "string" || ![...target.name.trim()].length || [...target.name.trim()].length > SOLVE_NAME_LIMIT)
            errors.push(`target.name：应为 1—${SOLVE_NAME_LIMIT} 字的文本，收到 ${shown(target.name)}`);
          else label = target.name.trim();
        }
        if (target.landmark !== undefined) {
          const found = landmarks.find((entry) => entry.id === target.landmark);
          if (target.latitude !== undefined || target.longitude !== undefined) errors.push("target：landmark 与 latitude/longitude 只能二选一");
          if (!found) errors.push(`target.landmark：未知地标 ${shown(target.landmark)}，可用：${landmarkIds.join("、")}`);
          else if (height !== null) {
            landmark = true;
            request.target = { landmark: found.id, latitude: found.latitude, longitude: found.longitude, height: height ?? found.bounds.height, name: label ?? found.name };
          }
        } else {
          const latitude = number(target, "target.latitude", shotLimits.latitude), longitude = number(target, "target.longitude");
          if (height === undefined) defaults.push("target.height");
          if (latitude !== null && longitude !== null && height !== null)
            request.target = { latitude, longitude: normalizeLongitude(longitude), height: height ?? 0, name: label ?? "链接中的目标" };
        }
      }
    }
  }

  if ((kind === "position" || kind === "range") && value.frame !== undefined) {
    const frame = object("frame", ["x", "y"]);
    if (frame) {
      const x = number(frame, "frame.x", [0, 1]), y = number(frame, "frame.y", [0, 1]);
      if (x !== null && y !== null) request.frame = { x, y };
    }
  }

  if (value.date === undefined) defaults.push("date");
  else {
    try {
      if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new TypeError();
      const date = Temporal.PlainDate.from(value.date);
      if (date.year < shotLimits.year[0] || date.year > shotLimits.year[1]) errors.push(`date：只支持 ${shotLimits.year[0]}—${shotLimits.year[1]} 年`);
      else request.date = date.toString();
    } catch {
      errors.push(`date：应为当地日期，例如 "2026-11-25"，收到 ${shown(value.date)}`);
    }
  }
  const pick = <T extends number>(key: string, options: readonly T[], fallback: T) => {
    const item = value[key];
    if (item === undefined) {
      defaults.push(key);
      return fallback;
    }
    if (!options.includes(item as T)) {
      errors.push(`${key}：应为 ${options.join(" / ")} 之一，收到 ${shown(item)}`);
      return fallback;
    }
    return item as T;
  };
  if (kind === "time") request.days = pick("days", timeDays, 365);
  if (kind === "range") request.days = pick("days", rangeDays, 30);
  if (kind === "time") request.tolerance = pick("tolerance", toleranceChoices, 0.25);
  if (kind === "position" || kind === "range") request.maxDistance = pick("maxDistance", distanceChoices, 30_000);
  if (kind === "range") {
    if (value.share === undefined) {
      defaults.push("share");
      request.share = 0.3;
    } else {
      const share = number(value, "share", shareLimits);
      if (share !== null) request.share = share;
    }
  }
  if (value.timeZone === undefined) defaults.push("timeZone");
  else if (typeof value.timeZone !== "string" || !validTimeZone(value.timeZone))
    errors.push(`timeZone：应为有效的 IANA 时区，例如 "Asia/Tokyo"，收到 ${shown(value.timeZone)}`);
  else request.timeZone = validTimeZone(value.timeZone)!;

  // Moon phase for the Moon; skies for the Moon and fixed bodies (never for the Sun).
  if (value.phase !== undefined && body && kind && kind !== "position" && body !== "moon") errors.push("phase：只用于月亮");
  if (value.sky !== undefined && body && kind && kind !== "position" && body === "sun") errors.push("sky：只用于月亮与固定方向天体");
  if (value.phase !== undefined && body === "moon" && kind !== "position") {
    const phase = value.phase;
    if (!Array.isArray(phase) || phase.length !== 2 || !phase.every((item) => phaseChoices.includes(item)) || phase[0] > phase[1])
      errors.push(`phase：应为 [下限, 上限]，取值 ${phaseChoices.join(" / ")}，下限不大于上限，收到 ${shown(phase)}`);
    else request.phase = [phase[0], phase[1]];
  }
  if (value.sky !== undefined && body && body !== "sun" && kind !== "position") {
    const sky = value.sky;
    if (!Array.isArray(sky) || !sky.length || !sky.every((item) => skyConditions.includes(item)) || new Set(sky).size !== sky.length)
      errors.push(`sky：应为不重复的 ${skyConditions.map((item) => `"${item}"`).join(" / ")} 组成的非空数组，收到 ${shown(sky)}`);
    else request.sky = skyConditions.filter((item) => sky.includes(item));
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, request, defaults, landmark };
}

// ---------------------------------------------------------------- 版本 2

/**
 * Version 2 (构图约束搜索): targets with their frame places, the lens that
 * frames them, the search range and filters. Version 1 requests are read
 * and converted (`upgradeSolve`), so old links keep opening.
 */
export const SOLVE_VERSION_2 = 2;
export const toleranceLimits = [0.005, 0.2] as const;
export const nearLimits = [500, 30_000] as const;

export interface RequestLens {
  focalLength: number;
  sensor: ShootingPlan["sensor"];
  sensorSize?: { width: number; height: number };
  aspectRatio: ShootingPlan["aspectRatio"];
  orientation: ShootingPlan["orientation"];
}
export type RequestTarget =
  | { type: "ground"; landmark?: string; latitude: number; longitude: number; height: number; reference: HeightReference; name: string; frame: FrameSpot; base: number | null; tolerance: number; skyline?: boolean }
  | { type: "body"; body: AlignmentBody; frame: FrameSpot; tolerance: number };
export type RequestCamera =
  | { mode: "free"; maxDistance: number; minDistance?: number; heightAboveGround?: number }
  | { mode: "near"; latitude: number; longitude: number; radius: number; heightAboveGround?: number }
  | { mode: "fixed"; latitude?: number; longitude?: number; aim?: { azimuth: number; pitch: number }; heightAboveGround?: number };
export type RequestTime = { mode: "range"; date?: string; days: number } | { mode: "instant"; instant: string };

export interface SolveRequest2 {
  format: typeof SOLVE_FORMAT;
  version: typeof SOLVE_VERSION_2;
  name: string;
  lens?: RequestLens;
  targets: RequestTarget[];
  camera: RequestCamera;
  time: RequestTime;
  timeZone?: string;
  filters: FilterSpec[];
}
export type SolveParse2 =
  | { ok: true; request: SolveRequest2; defaults: string[]; landmark: boolean; from: 1 | 2 }
  | { ok: false; errors: string[] };

const topKeys2 = ["$schema", "format", "version", "name", "lens", "targets", "camera", "time", "timeZone", "filters"];
const roundTo = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Validates a version 2 request; every problem with its field path. */
export function parseSolve2(value: Record<string, unknown>): SolveParse2 {
  const errors: string[] = [], defaults: string[] = [];
  for (const key of Object.keys(value)) if (!topKeys2.includes(key)) errors.push(`${key}：未知字段`);
  if (value.format !== SOLVE_FORMAT) errors.push(`format：应为 "${SOLVE_FORMAT}"，收到 ${shown(value.format)}`);
  let name = "";
  if (value.name !== undefined) {
    if (typeof value.name !== "string") errors.push(`name：应为文本，收到 ${shown(value.name)}`);
    else if ([...value.name.trim()].length > SOLVE_NAME_LIMIT) errors.push(`name：最多 ${SOLVE_NAME_LIMIT} 字`);
    else name = value.name.trim();
  }
  const number = (source: Record<string, unknown>, key: string, path: string, range?: readonly [number, number]) => {
    const item = source[key];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      errors.push(`${path}：应为数字，收到 ${shown(item)}`);
      return null;
    }
    if (range && (item < range[0] || item > range[1])) {
      errors.push(`${path}：应在 ${range[0]}～${range[1]} 之间，收到 ${item}`);
      return null;
    }
    return item;
  };
  const object = (item: unknown, path: string, fields: readonly string[]) => {
    if (!isObject(item)) {
      errors.push(`${path}：应为对象，收到 ${shown(item)}`);
      return null;
    }
    for (const field of Object.keys(item)) if (!fields.includes(field)) errors.push(`${path}.${field}：未知字段`);
    return item;
  };
  const spot = (item: unknown, path: string): FrameSpot | null => {
    if (item === undefined) return { x: 0.5, y: 0.5 };
    const frame = object(item, path, ["x", "y"]);
    if (!frame) return null;
    const x = number(frame, "x", `${path}.x`, [0, 1]), y = number(frame, "y", `${path}.y`, [0, 1]);
    return x === null || y === null ? null : { x, y };
  };
  const tolerance = (source: Record<string, unknown>, path: string) =>
    source.tolerance === undefined ? DEFAULT_TOLERANCE : number(source, "tolerance", `${path}.tolerance`, toleranceLimits);
  let landmark = false;

  let lens: RequestLens | undefined;
  if (value.lens === undefined) defaults.push("lens");
  else {
    const item = object(value.lens, "lens", ["focalLength", "sensor", "sensorSize", "aspectRatio", "orientation"]);
    if (item) {
      const focalLength = number(item, "focalLength", "lens.focalLength", shotLimits.focalLength);
      const sensorIds = [...Object.keys(sensors), "custom"];
      const sensor = item.sensor === undefined ? initialPlan.sensor : sensorIds.includes(item.sensor as string) ? item.sensor as ShootingPlan["sensor"] : null;
      if (sensor === null) errors.push(`lens.sensor：应为 ${sensorIds.map((id) => `"${id}"`).join(" / ")} 之一，收到 ${shown(item.sensor)}`);
      let sensorSize: RequestLens["sensorSize"];
      if (item.sensorSize !== undefined) {
        const size = object(item.sensorSize, "lens.sensorSize", ["width", "height"]);
        if (sensor !== "custom") errors.push(`lens.sensorSize：只在 lens.sensor 为 "custom" 时使用`);
        else if (size) {
          const width = number(size, "width", "lens.sensorSize.width", customSensorLimits), height = number(size, "height", "lens.sensorSize.height", customSensorLimits);
          if (width !== null && height !== null) sensorSize = { width, height };
        }
      } else if (sensor === "custom") errors.push(`lens.sensorSize：自定义传感器需要宽和高，例如 { "width": 43.8, "height": 32.9 }`);
      const ratios = Object.keys(aspectRatios);
      const aspectRatio = item.aspectRatio === undefined ? initialPlan.aspectRatio : ratios.includes(item.aspectRatio as string) ? item.aspectRatio as ShootingPlan["aspectRatio"] : null;
      if (aspectRatio === null) errors.push(`lens.aspectRatio：应为 ${ratios.map((id) => `"${id}"`).join(" / ")} 之一，收到 ${shown(item.aspectRatio)}`);
      const orientation = item.orientation === undefined ? initialPlan.orientation : item.orientation === "landscape" || item.orientation === "portrait" ? item.orientation : null;
      if (orientation === null) errors.push(`lens.orientation：应为 "landscape" / "portrait" 之一，收到 ${shown(item.orientation)}`);
      if (focalLength !== null && sensor && aspectRatio && orientation)
        lens = { focalLength, sensor, ...(sensorSize ? { sensorSize } : {}), aspectRatio, orientation };
    }
  }

  const targets: RequestTarget[] = [];
  if (!Array.isArray(value.targets) || !value.targets.length) errors.push(`targets：需要 1—${TARGET_LIMIT} 个目标组成的数组，收到 ${shown(value.targets)}`);
  else if (value.targets.length > TARGET_LIMIT) errors.push(`targets：目前最多 ${TARGET_LIMIT} 个目标，收到 ${value.targets.length} 个`);
  else value.targets.forEach((entry, index) => {
    const path = `targets[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${path}：应为对象，收到 ${shown(entry)}`);
      return;
    }
    if (entry.type === "body") {
      const item = object(entry, path, ["type", "body", "frame", "tolerance"]);
      if (!item) return;
      const body = isSolveBody(item.body) ? item.body : null;
      if (!body) errors.push(`${path}.body：应为 "sun"、"moon"、"galactic-center"，或亮星（hyg-…）、深空目标（dso-…）的 id，收到 ${shown(item.body)}`);
      const frame = spot(item.frame, `${path}.frame`), allowed = tolerance(item, path);
      if (body && frame && allowed !== null) targets.push({ type: "body", body, frame, tolerance: allowed });
      return;
    }
    if (entry.type !== "ground") {
      errors.push(`${path}.type：应为 "ground" 或 "body"，收到 ${shown(entry.type)}`);
      return;
    }
    const item = object(entry, path, ["type", "landmark", "latitude", "longitude", "height", "reference", "name", "frame", "base", "tolerance", "skyline"]);
    if (!item) return;
    const reference = item.reference === undefined ? "ground" : item.reference === "ground" || item.reference === "sea" ? item.reference : null;
    if (reference === null) errors.push(`${path}.reference：应为 "ground"（距地表）或 "sea"（海拔），收到 ${shown(item.reference)}`);
    const height = item.height === undefined ? undefined : number(item, "height", `${path}.height`, reference === "sea" ? seaHeightLimits : targetHeightLimits);
    let label: string | undefined;
    if (item.name !== undefined) {
      if (typeof item.name !== "string" || ![...item.name.trim()].length || [...item.name.trim()].length > SOLVE_NAME_LIMIT)
        errors.push(`${path}.name：应为 1—${SOLVE_NAME_LIMIT} 字的文本，收到 ${shown(item.name)}`);
      else label = item.name.trim();
    }
    const frame = spot(item.frame, `${path}.frame`), allowed = tolerance(item, path);
    let base: number | null = null, baseOk = true;
    if (item.base !== undefined && item.base !== null) {
      const foot = number(item, "base", `${path}.base`, [0, 1]);
      if (foot === null) baseOk = false;
      else if (frame && foot <= frame.y) {
        errors.push(`${path}.base：底部应在 frame.y 下方（更大），收到 ${foot}`);
        baseOk = false;
      } else base = foot;
    }
    let place: { landmark?: string; latitude: number; longitude: number; height: number; name: string } | null = null;
    if (item.landmark !== undefined) {
      const found = landmarks.find((entry) => entry.id === item.landmark);
      if (item.latitude !== undefined || item.longitude !== undefined) errors.push(`${path}：landmark 与 latitude/longitude 只能二选一`);
      if (!found) errors.push(`${path}.landmark：未知地标 ${shown(item.landmark)}，可用：${landmarkIds.join("、")}`);
      else if (height !== null) {
        landmark = true;
        place = { landmark: found.id, latitude: found.latitude, longitude: found.longitude, height: height ?? (reference === "sea" ? 0 : found.bounds.height), name: label ?? found.name };
      }
    } else {
      const latitude = number(item, "latitude", `${path}.latitude`, shotLimits.latitude), longitude = number(item, "longitude", `${path}.longitude`);
      if (height === undefined) defaults.push(`${path}.height`);
      if (latitude !== null && longitude !== null && height !== null)
        place = { latitude, longitude: normalizeLongitude(longitude), height: height ?? 0, name: label ?? "链接中的目标" };
    }
    let skyline = false, skylineOk = true;
    if (item.skyline !== undefined) {
      if (typeof item.skyline !== "boolean") {
        errors.push(`${path}.skyline：应为 true 或 false，收到 ${shown(item.skyline)}`);
        skylineOk = false;
      } else if (item.skyline && place && reference && !canSkyline({ reference, height: place.height })) {
        errors.push(`${path}.skyline：只用于距地表不到 ${MIN_SUBJECT} m 的点（山顶），不用于塔、楼或海拔高度`);
        skylineOk = false;
      } else skyline = item.skyline;
    }
    if (place && reference && frame && allowed !== null && baseOk && skylineOk)
      targets.push({ type: "ground", ...place, reference, frame, base, tolerance: allowed, ...(skyline ? { skyline } : {}) });
  });

  let camera: RequestCamera = { mode: "free", maxDistance: 30_000 };
  if (value.camera === undefined) defaults.push("camera");
  else if (isObject(value.camera)) {
    const mode = value.camera.mode;
    const path = "camera";
    const height = (item: Record<string, unknown>) => (item.heightAboveGround === undefined ? undefined : number(item, "heightAboveGround", "camera.heightAboveGround", shotLimits.heightAboveGround));
    if (mode === "free") {
      const item = object(value.camera, path, ["mode", "maxDistance", "minDistance", "heightAboveGround"]);
      if (item) {
        const maxDistance = item.maxDistance === undefined ? 30_000 : (distanceChoices as readonly number[]).includes(item.maxDistance as number) ? item.maxDistance as number : null;
        if (maxDistance === null) errors.push(`camera.maxDistance：应为 ${distanceChoices.join(" / ")} 之一，收到 ${shown(item.maxDistance)}`);
        let minDistance = item.minDistance === undefined ? undefined : (nearestChoices as readonly number[]).includes(item.minDistance as number) ? item.minDistance as number : null;
        if (minDistance === null) errors.push(`camera.minDistance：应为 ${nearestChoices.join(" / ")} 之一，收到 ${shown(item.minDistance)}`);
        else if (minDistance !== undefined && maxDistance !== null && minDistance >= maxDistance) {
          errors.push(`camera.minDistance：应小于 maxDistance（${maxDistance}），收到 ${minDistance}`);
          minDistance = null;
        }
        const eye = height(item);
        if (maxDistance !== null && minDistance !== null && eye !== null)
          camera = { mode, maxDistance, ...(minDistance === undefined ? {} : { minDistance }), ...(eye === undefined ? {} : { heightAboveGround: eye }) };
      }
    } else if (mode === "near") {
      const item = object(value.camera, path, ["mode", "latitude", "longitude", "radius", "heightAboveGround"]);
      if (item) {
        const latitude = number(item, "latitude", "camera.latitude", shotLimits.latitude), longitude = number(item, "longitude", "camera.longitude");
        const radius = number(item, "radius", "camera.radius", nearLimits), eye = height(item);
        if (latitude !== null && longitude !== null && radius !== null && eye !== null)
          camera = { mode, latitude, longitude: normalizeLongitude(longitude), radius, ...(eye === undefined ? {} : { heightAboveGround: eye }) };
      }
    } else if (mode === "fixed") {
      const item = object(value.camera, path, ["mode", "latitude", "longitude", "aim", "heightAboveGround"]);
      if (item) {
        const given = item.latitude !== undefined || item.longitude !== undefined;
        const latitude = given ? number(item, "latitude", "camera.latitude", shotLimits.latitude) : undefined;
        const longitude = given ? number(item, "longitude", "camera.longitude") : undefined;
        let aim: { azimuth: number; pitch: number } | undefined | null;
        if (item.aim !== undefined) {
          const direction = object(item.aim, "camera.aim", ["azimuth", "pitch"]);
          const azimuth = direction ? number(direction, "azimuth", "camera.aim.azimuth") : null, pitch = direction ? number(direction, "pitch", "camera.aim.pitch", shotLimits.pitch) : null;
          aim = azimuth === null || pitch === null ? null : { azimuth: normalizeAngle(azimuth), pitch };
        }
        const eye = height(item);
        if (latitude !== null && longitude !== null && aim !== null && eye !== null)
          camera = { mode, ...(given ? { latitude: latitude!, longitude: normalizeLongitude(longitude!) } : {}), ...(aim ? { aim } : {}), ...(eye === undefined ? {} : { heightAboveGround: eye }) };
      }
    } else errors.push(`camera.mode：应为 "free" / "near" / "fixed" 之一，收到 ${shown(mode)}`);
  } else errors.push(`camera：应为对象，收到 ${shown(value.camera)}`);

  let time: RequestTime = { mode: "range", days: 30 };
  if (value.time === undefined) defaults.push("time");
  else if (isObject(value.time) && value.time.mode === "instant") {
    const item = object(value.time, "time", ["mode", "instant"]);
    if (item) {
      const instant = typeof item.instant === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(item.instant) && Number.isFinite(Date.parse(item.instant)) ? item.instant : null;
      if (!instant) errors.push(`time.instant：应为 UTC 时刻，例如 "2026-11-25T08:10:00Z"，收到 ${shown(item.instant)}`);
      else time = { mode: "instant", instant: new Date(Date.parse(instant)).toISOString().replace(".000Z", "Z") };
    }
  } else if (isObject(value.time) && (value.time.mode === "range" || value.time.mode === undefined)) {
    const item = object(value.time, "time", ["mode", "date", "days"]);
    if (item) {
      let date: string | undefined;
      if (item.date === undefined) defaults.push("time.date");
      else {
        try {
          if (typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) throw new TypeError();
          const parsed = Temporal.PlainDate.from(item.date);
          if (parsed.year < shotLimits.year[0] || parsed.year > shotLimits.year[1]) errors.push(`time.date：只支持 ${shotLimits.year[0]}—${shotLimits.year[1]} 年`);
          else date = parsed.toString();
        } catch {
          errors.push(`time.date：应为当地日期，例如 "2026-11-25"，收到 ${shown(item.date)}`);
        }
      }
      const days = item.days === undefined ? 30 : (dayChoices as readonly number[]).includes(item.days as number) ? item.days as number : null;
      if (days === null) errors.push(`time.days：应为 ${dayChoices.join(" / ")} 之一，收到 ${shown(item.days)}`);
      if (days !== null) time = { mode: "range", ...(date ? { date } : {}), days };
    }
  } else errors.push(`time.mode：应为 "range" / "instant" 之一，收到 ${shown(isObject(value.time) ? value.time.mode : value.time)}`);
  if (time.mode === "range" && time.days > MAX_LINE_DAYS && camera.mode !== "fixed")
    errors.push(`time.days：机位不固定时最多 ${MAX_LINE_DAYS} 天；${dayLabel(time.days)}只用于固定机位`);

  let timeZone: string | undefined;
  if (value.timeZone === undefined) defaults.push("timeZone");
  else if (typeof value.timeZone !== "string" || !validTimeZone(value.timeZone))
    errors.push(`timeZone：应为有效的 IANA 时区，例如 "Asia/Tokyo"，收到 ${shown(value.timeZone)}`);
  else timeZone = validTimeZone(value.timeZone)!;

  const filters: FilterSpec[] = [];
  if (value.filters !== undefined) {
    if (!Array.isArray(value.filters)) errors.push(`filters：应为数组，收到 ${shown(value.filters)}`);
    else value.filters.forEach((entry, index) => {
      const path = `filters[${index}]`;
      if (!isObject(entry)) return void errors.push(`${path}：应为对象，收到 ${shown(entry)}`);
      if (entry.type === "sky") {
        const item = object(entry, path, ["type", "sky"]);
        const sky = item?.sky;
        if (!Array.isArray(sky) || !sky.length || !sky.every((one) => skyConditions.includes(one)) || new Set(sky).size !== sky.length)
          errors.push(`${path}.sky：应为不重复的 ${skyConditions.map((one) => `"${one}"`).join(" / ")} 组成的非空数组，收到 ${shown(sky)}`);
        else filters.push({ kind: "sky", sky: skyConditions.filter((one) => sky.includes(one)) });
      } else if (entry.type === "moonDown") {
        if (object(entry, path, ["type"])) filters.push({ kind: "moonDown" });
      } else if (entry.type === "moonLit") {
        const item = object(entry, path, ["type", "range"]);
        const range = item?.range;
        if (!Array.isArray(range) || range.length !== 2 || !range.every((one) => phaseChoices.includes(one)) || range[0] > range[1])
          errors.push(`${path}.range：应为 [下限, 上限]，取值 ${phaseChoices.join(" / ")}，下限不大于上限，收到 ${shown(range)}`);
        else filters.push({ kind: "moonLit", range: [range[0], range[1]] });
      } else if (entry.type === "darkSky") {
        const item = object(entry, path, ["type", "limit"]);
        const limits: readonly number[] = darkSkyChoices.map((choice) => choice.limit);
        if (item && !limits.includes(item.limit as number)) errors.push(`${path}.limit：天顶天空亮度上限（mag/arcsec²），取值 ${limits.join(" / ")}，收到 ${shown(item.limit)}`);
        else if (item) filters.push({ kind: "darkSky", limit: item.limit as number });
      } else errors.push(`${path}.type：应为 "sky" / "moonDown" / "moonLit" / "darkSky" 之一，收到 ${shown(entry.type)}`);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, request: { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, name, ...(lens ? { lens } : {}), targets, camera, time, ...(timeZone ? { timeZone } : {}), filters }, defaults, landmark, from: 2 };
}

/**
 * A version 1 request in version 2 terms. The lens is the opener's (v1 had
 * none): 找时间's tolerance in diameters becomes a share of that frame's height.
 */
export function upgradeSolve(request: SolveRequest, lens: Lens): SolveRequest2 {
  const filters: FilterSpec[] = [];
  if (request.sky) filters.push({ kind: "sky", sky: [...request.sky] });
  if (request.phase) filters.push({ kind: "moonLit", range: [request.phase[0], request.phase[1]] });
  const base = { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, name: request.name, ...(request.timeZone ? { timeZone: request.timeZone } : {}), filters } as const;
  if (request.kind === "time") {
    const diameters = request.tolerance ?? 0.25;
    const tolerance = Math.max(toleranceLimits[0], Math.min(toleranceLimits[1], roundTo((diameters * 2 * bodyRadius(request.body)) / fieldOfView(lens).vertical, 4)));
    return {
      ...base,
      targets: [{ type: "body", body: request.body, frame: { x: 0.5, y: 0.5 }, tolerance }],
      camera: {
        mode: "fixed",
        ...(request.camera ? { latitude: request.camera.latitude, longitude: request.camera.longitude } : {}),
        ...(request.mark ? { aim: { azimuth: request.mark.azimuth, pitch: request.mark.elevation } } : {}),
        ...(request.camera?.heightAboveGround !== undefined ? { heightAboveGround: request.camera.heightAboveGround } : {}),
      },
      time: { mode: "range", ...(request.date ? { date: request.date } : {}), days: request.days ?? 365 },
    };
  }
  const target = request.target!;
  const frame = request.frame ?? { x: 0.5, y: 0.5 };
  const sized = request.kind === "range" && target.height >= MIN_SUBJECT;
  return {
    ...base,
    targets: [
      { type: "ground", ...(target.landmark ? { landmark: target.landmark } : {}), latitude: target.latitude, longitude: target.longitude, height: target.height, reference: "ground", name: target.name,
        frame, base: sized ? roundTo(Math.min(1, frame.y + (request.share ?? 0.3)), 3) : null, tolerance: DEFAULT_TOLERANCE },
      { type: "body", body: request.body, frame, tolerance: DEFAULT_TOLERANCE },
    ],
    camera: { mode: "free", maxDistance: request.maxDistance ?? 30_000 },
    time: { mode: "range", ...(request.date ? { date: request.date } : {}), days: request.kind === "position" ? 1 : request.days ?? 30 },
  };
}

/** Reads a request object of either version; version 1 is converted with the opener's lens. */
export function parseAnySolve(value: unknown, lens: Lens): SolveParse2 {
  if (!isObject(value)) return fail2("顶层应为 JSON 对象");
  if (typeof value.version === "number" && Number.isInteger(value.version) && value.version > SOLVE_VERSION_2)
    return fail2(`version：此推算请求来自更新版本的应用（版本 ${value.version}），请刷新页面后再打开`);
  if (value.version === SOLVE_VERSION_2) return parseSolve2(value);
  const old = parseSolve(value);
  if (!old.ok) return old;
  return { ok: true, request: upgradeSolve(old.request, lens), defaults: old.defaults, landmark: old.landmark, from: 1 };
}
const fail2 = (...errors: string[]): SolveParse2 => ({ ok: false, errors });

/** Plain JSON (optionally fenced) or a link carrying `#solve=`, of either version. */
export function parseSolveText2(text: string, lens: Lens): SolveParse2 {
  const extracted = extractSolveJson(text);
  if (!extracted.ok) return fail2(...extracted.errors);
  return parseAnySolve(extracted.value, lens);
}

/** The panel's search as a version 2 request. */
export function requestOf(composition: Composition, lens: Lens, extra: { name?: string; timeZone?: string; cameraHeight?: number } = {}): SolveRequest2 {
  const targets: RequestTarget[] = composition.targets.map((target) => target.kind === "sky"
    ? { type: "body", body: target.body, frame: { ...target.frame }, tolerance: target.tolerance }
    : { type: "ground", ...(target.landmark ? { landmark: target.landmark } : {}), latitude: target.latitude, longitude: target.longitude, height: target.height, reference: target.reference, name: target.name, frame: { ...target.frame }, base: target.base, tolerance: target.tolerance, ...(target.skyline && canSkyline(target) ? { skyline: true } : {}) });
  const height = extra.cameraHeight === undefined ? {} : { heightAboveGround: extra.cameraHeight };
  const camera: RequestCamera = composition.camera.mode === "free" ? { mode: "free", maxDistance: composition.camera.maxDistance, minDistance: composition.camera.minDistance, ...height }
    : composition.camera.mode === "near" ? { mode: "near", latitude: composition.camera.latitude, longitude: composition.camera.longitude, radius: composition.camera.radius, ...height }
      : { mode: "fixed", latitude: composition.camera.latitude, longitude: composition.camera.longitude, ...(composition.camera.aim ? { aim: { ...composition.camera.aim } } : {}), ...height };
  const sensorSize = lens.sensor === "custom" && lens.customSensor ? { sensorSize: { ...lens.customSensor } } : {};
  return {
    format: SOLVE_FORMAT, version: SOLVE_VERSION_2, name: extra.name ?? "",
    lens: { focalLength: lens.focalLength, sensor: lens.sensor, ...sensorSize, aspectRatio: lens.aspectRatio, orientation: lens.orientation },
    targets, camera, time: { ...composition.time } as RequestTime,
    ...(extra.timeZone ? { timeZone: extra.timeZone } : {}),
    filters: composition.filters.map((filter): FilterSpec => (filter.kind === "sky" ? { kind: "sky", sky: [...filter.sky] } : filter.kind === "moonLit" ? { kind: "moonLit", range: [...filter.range] as [number, number] } : { ...filter })),
  };
}

/** The request's search in panel terms, completed from the plan it opens on (current camera, shooting date). */
export function compositionOf(request: SolveRequest2, plan: ShootingPlan): Composition {
  let id = 0;
  const targets: TargetSpec[] = request.targets.map((target) => target.type === "body"
    ? { kind: "sky", id: `link${++id}`, body: target.body, frame: { ...target.frame }, tolerance: target.tolerance }
    : { kind: "ground", id: `link${++id}`, name: target.name, ...(target.landmark ? { landmark: target.landmark } : {}), latitude: target.latitude, longitude: target.longitude, height: target.height, reference: target.reference, frame: { ...target.frame }, base: target.base, tolerance: target.tolerance, ...(target.skyline ? { skyline: true } : {}) });
  const camera: CameraRange = request.camera.mode === "free" ? { mode: "free", maxDistance: request.camera.maxDistance, minDistance: request.camera.minDistance ?? MIN_DISTANCE }
    : request.camera.mode === "near" ? { mode: "near", latitude: request.camera.latitude, longitude: request.camera.longitude, radius: request.camera.radius }
      : { mode: "fixed", latitude: request.camera.latitude ?? plan.latitude, longitude: request.camera.longitude ?? plan.longitude, aim: request.camera.aim ? { ...request.camera.aim } : null };
  const time: TimeRange = request.time.mode === "instant" ? { mode: "instant", instant: request.time.instant }
    : { mode: "range", date: request.time.date ?? localDateTime(plan.instant, plan.timeZone).slice(0, 10), days: request.time.days };
  return { targets, camera, time, filters: request.filters.map((filter) => ({ ...filter })) as FilterSpec[] };
}

/**
 * The plan a loaded version 2 request opens on: its lens, a fixed camera
 * and its aim, the camera height, a fixed instant or a one-day range's date
 * (the timeline then shows that day), and a given time zone (fixed).
 */
export function solvePlan2(request: SolveRequest2, plan: ShootingPlan): ShootingPlan {
  const next: ShootingPlan = { ...plan };
  if (request.timeZone) {
    next.timeZone = request.timeZone;
    next.followLocalZone = false;
  }
  if (request.lens) {
    next.focalLength = request.lens.focalLength;
    next.sensor = request.lens.sensor;
    next.customSensor = request.lens.sensorSize ? { ...request.lens.sensorSize } : next.sensor === "custom" ? next.customSensor : null;
    next.aspectRatio = request.lens.aspectRatio;
    next.orientation = request.lens.orientation;
  }
  const camera = request.camera;
  if (camera.heightAboveGround !== undefined) next.cameraHeight = camera.heightAboveGround;
  if (camera.mode === "fixed") {
    if (camera.latitude !== undefined && camera.longitude !== undefined) {
      next.latitude = camera.latitude;
      next.longitude = camera.longitude;
    }
    if (camera.aim) {
      next.azimuth = camera.aim.azimuth;
      next.pitch = camera.aim.pitch;
    }
  }
  if (request.time.mode === "instant") next.instant = request.time.instant;
  else if (request.time.days === 1 && request.time.date) {
    const date = request.time.date;
    // Keep the clock time when the timeline still starts that day, otherwise noon (as version 1's 找机位).
    let instant: string | null = null;
    try {
      instant = instantOnDate(plan.instant, next.timeZone, date);
    } catch {
      instant = null;
    }
    if (!instant || timelineWindow(instant, next.timeZone, timelineMode(next.layers)).date !== date)
      instant = instantFromLocal(`${date}T12:00`, next.timeZone);
    next.instant = instant;
  }
  return next;
}

/** A version 2 request as JSON in the documented order; `$schema` first when given. */
export function solveJson2(request: SolveRequest2, schema?: string) {
  const { name, ...rest } = request;
  const written: Record<string, unknown> = {
    ...rest,
    ...(name ? { name } : {}),
    // A landmark target is written by its id; the resolved coordinates are not part of the request.
    targets: request.targets.map((target) => {
      if (target.type === "body") return { type: "body", body: target.body, frame: target.frame, tolerance: target.tolerance };
      const place = target.landmark ? { landmark: target.landmark } : { latitude: target.latitude, longitude: target.longitude, name: target.name };
      return { type: "ground", ...place, height: target.height, reference: target.reference, frame: target.frame, ...(target.base !== null ? { base: target.base } : {}), tolerance: target.tolerance, ...(target.skyline ? { skyline: true } : {}) };
    }),
    filters: request.filters.map((filter) => (filter.kind === "sky" ? { type: "sky", sky: filter.sky } : filter.kind === "moonLit" ? { type: "moonLit", range: filter.range } : filter.kind === "darkSky" ? { type: "darkSky", limit: filter.limit } : { type: "moonDown" })),
  };
  const ordered = Object.fromEntries(topKeys2.slice(1).filter((key) => written[key] !== undefined).map((key) => [key, written[key]]));
  return JSON.stringify(schema ? { $schema: schema, ...ordered } : ordered, null, 2);
}
/** `#solve=json:` link of a version 2 request. */
export function solveLink2(request: SolveRequest2, site: string) {
  return `${site}#solve=json:${encodeURIComponent(JSON.stringify(JSON.parse(solveJson2(request))))}`;
}
