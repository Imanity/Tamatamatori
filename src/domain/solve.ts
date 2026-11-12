import { Temporal } from "@js-temporal/polyfill";
import { landmarks } from "./landmarks.ts";
import { fixedBodies, isSolveBody } from "./sky-targets.ts";
import { skyConditions, spanChoices as timeSpans, targetElevationRange, toleranceChoices } from "./alignment.ts";
import type { AlignmentBody, SkyCondition } from "./alignment.ts";
import { spanChoices as rangeSpans } from "./range-alignment.ts";
import { distanceChoices } from "./position-alignment.ts";
import { shotLimits, validTimeZone } from "./shot.ts";
import { instantFromLocal, instantOnDate, localDateTime } from "./plan.ts";
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

/** Accepts plain JSON (optionally in a code fence) or a link carrying `#solve=`. */
export function parseSolveText(text: string): SolveParse {
  if (text.length > SOLVE_TEXT_LIMIT) return fail(`内容超过 ${SOLVE_TEXT_LIMIT / 1024} KB，不是有效的推算请求`);
  let body = text.trim();
  if (!body) return fail("内容为空");
  const fenced = body.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fenced) body = fenced[1].trim();
  const hash = body.match(/#solve=([\s\S]+)$/);
  if (hash) {
    try {
      body = decodeURIComponent(hash[1].trim());
    } catch {
      return fail("链接中的推算请求编码无效");
    }
  }
  if (body.startsWith("json:")) body = body.slice(5).trim();
  if (!body.startsWith("{")) return fail("无法识别：应为以 { 开头的 JSON，或带 #solve=json: 的链接");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return fail(`JSON 格式错误：${(error as Error).message}`);
  }
  return parseSolve(value);
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

/** The request as JSON; `$schema` first when given (an absolute URL of solve.schema.json). */
export function solveJson(request: SolveRequest, schema?: string) {
  const { target, name, ...rest } = request;
  const written: Record<string, unknown> = {
    ...rest,
    ...(name ? { name } : {}),
    // A landmark target is written by its id; the resolved coordinates are not part of the request.
    ...(target ? { target: target.landmark ? { landmark: target.landmark, height: target.height } : { latitude: target.latitude, longitude: target.longitude, height: target.height, name: target.name } } : {}),
  };
  // Fields in the documented order, whatever order the request was built in.
  const ordered = Object.fromEntries(topKeys.slice(1).filter((key) => written[key] !== undefined).map((key) => [key, written[key]]));
  return JSON.stringify(schema ? { $schema: schema, ...ordered } : ordered, null, 2);
}

/**
 * The plan a loaded request opens on. 找时间 moves to its camera (when given)
 * and faces the mark so it is in view; 找机位 moves the shooting instant to its
 * day (the timeline span it searches). A given time zone becomes the plan's
 * fixed zone, so the dates mean what the request says. Everything else stays.
 */
export function solvePlan(request: SolveRequest, plan: ShootingPlan): ShootingPlan {
  const next: ShootingPlan = { ...plan };
  if (request.timeZone) {
    next.timeZone = request.timeZone;
    next.followLocalZone = false;
  }
  if (request.kind === "time") {
    if (request.camera) {
      next.latitude = request.camera.latitude;
      next.longitude = request.camera.longitude;
      if (request.camera.heightAboveGround !== undefined) next.cameraHeight = request.camera.heightAboveGround;
    }
    if (request.mark) {
      next.azimuth = request.mark.azimuth;
      next.pitch = request.mark.elevation;
    }
  }
  if (request.kind === "position" && request.date) {
    // The date is the timeline span's first day: keep the clock time when the
    // span still starts that day, otherwise noon (in both the calendar-day and
    // the noon-to-noon span). A kept time in a daylight-saving gap also goes to noon.
    let instant: string | null = null;
    try {
      instant = instantOnDate(plan.instant, next.timeZone, request.date);
    } catch {
      instant = null;
    }
    if (!instant || timelineWindow(instant, next.timeZone, timelineMode(next.layers)).date !== request.date)
      instant = instantFromLocal(`${request.date}T12:00`, next.timeZone);
    next.instant = instant;
  }
  return next;
}

/** The local date a loaded request starts from: its own, or the shooting date of the plan it opens on. */
export function solveStart(request: SolveRequest, plan: ShootingPlan) {
  return request.date ?? localDateTime(plan.instant, plan.timeZone).slice(0, 10);
}

/** What the 推算 panel holds, as the request "复制推算请求" writes. */
export interface SolveState {
  kind: SolveKind;
  body: AlignmentBody;
  mark: { azimuth: number; elevation: number } | null;
  camera: { latitude: number; longitude: number; heightAboveGround: number };
  target: { id?: string; latitude: number; longitude: number; height: number; name: string } | null;
  date: string;
  days: number;
  timeZone: string;
  tolerance: number;
  share: number;
  maxDistance: number;
  /** Lit fraction bounds. */
  phase: readonly [number, number];
  sky: readonly SkyCondition[];
  /** 找机位 / 两者都找: the target's place in the frame, normalised device coordinates (centre 0, 0; y down); the centre when absent. */
  frame?: { x: number; y: number };
}

/** A frame place in normalised device coordinates (−1…1, y down) as the request writes it (0—1 from the top-left), rounded. */
export const requestFrame = (point: { x: number; y: number }) =>
  ({ x: Math.round(((point.x + 1) / 2) * 1000) / 1000, y: Math.round(((point.y + 1) / 2) * 1000) / 1000 });
/** The request's frame place back in normalised device coordinates; the centre when absent. */
export const frameOfRequest = (frame: SolveRequest["frame"]) => (frame ? { x: frame.x * 2 - 1, y: frame.y * 2 - 1 } : { x: 0, y: 0 });

/** The panel's search as a self-contained request; null until it has a mark or a target. */
export function solveRequestOf(state: SolveState): SolveRequest | null {
  const base = { format: SOLVE_FORMAT, version: SOLVE_VERSION, name: "", kind: state.kind, body: state.body } as const;
  const when = { date: state.date, timeZone: state.timeZone };
  const filters = {
    ...(state.body === "moon" && (state.phase[0] > 0 || state.phase[1] < 1) ? { phase: [state.phase[0], state.phase[1]] as const } : {}),
    ...(state.body !== "sun" && state.sky.length < skyConditions.length ? { sky: skyConditions.filter((item) => state.sky.includes(item)) } : {}),
  };
  if (state.kind === "time") {
    if (!state.mark) return null;
    return { ...base, mark: { ...state.mark }, camera: { ...state.camera }, ...when, days: state.days, tolerance: state.tolerance, ...filters };
  }
  if (!state.target) return null;
  const { id, ...place } = state.target;
  const target = id ? { landmark: id, ...place } : place;
  const framed = requestFrame(state.frame ?? { x: 0, y: 0 });
  const frame = framed.x === 0.5 && framed.y === 0.5 ? {} : { frame: framed };
  if (state.kind === "position") return { ...base, target, ...frame, ...when, maxDistance: state.maxDistance };
  return { ...base, target, ...frame, ...when, days: state.days, share: state.share, maxDistance: state.maxDistance, ...filters };
}

/** `#solve=json:` link: readable and easy for an AI to write (no base64). */
export function solveLink(request: SolveRequest, site: string) {
  return `${site}#solve=json:${encodeURIComponent(JSON.stringify(JSON.parse(solveJson(request))))}`;
}
