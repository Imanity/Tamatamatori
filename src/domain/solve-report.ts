import { Temporal } from "@js-temporal/polyfill";
import { skyConditionNames } from "./alignment.ts";
import type { AlignmentBody, AlignmentResult } from "./alignment.ts";
import { compassDirection, localDateTime } from "./plan.ts";
import type { PositionPoint } from "./position-alignment.ts";
import type { RangeCandidate } from "./range-alignment.ts";
import type { SolveKind, SolveRequest } from "./solve.ts";

/**
 * Plain-text wording of a 推算 request and its results, shared by the link
 * preview and "复制结果" (Markdown a person or an AI can read back).
 */
export const solveKindNames: Record<SolveKind, string> = { time: "找时间", position: "找机位", range: "两者都找" };
export const solveBodyNames: Record<AlignmentBody, string> = { sun: "太阳", moon: "月亮" };
/** Rows beyond this are counted, not listed. */
export const REPORT_ROWS = 200;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const coordinate = (latitude: number, longitude: number) => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
const spanName = (days: number) => (days === 365 ? "12 个月" : days === 1096 ? "3 年" : `${days} 天`);
const iso = (time: number) => new Date(time).toISOString();
const local = (instant: string, timeZone: string) => localDateTime(instant, timeZone).replace("T", " ");
const clock = (instant: string, timeZone: string) => localDateTime(instant, timeZone).slice(11, 16);
const day = (instant: string, timeZone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString();
const sightNames = { clear: "通视", blocked: "被 DEM 挡住", unknown: "高程不全" } as const;

export interface SolveRow {
  label: string;
  value: string;
}

/** The request as labelled rows; absent fields say what the app uses instead. */
export function describeSolve(request: SolveRequest): SolveRow[] {
  const rows: SolveRow[] = [{ label: "求解", value: `${solveKindNames[request.kind]} · ${solveBodyNames[request.body]}` }];
  if (request.name) rows.push({ label: "名称", value: request.name });
  if (request.kind === "time" && request.mark) {
    rows.push({ label: "期望位置", value: `方位 ${request.mark.azimuth.toFixed(2)}°（${compassDirection(request.mark.azimuth)}），视高度 ${request.mark.elevation.toFixed(2)}°` });
    const camera = request.camera;
    rows.push({ label: "机位", value: camera
      ? `${coordinate(camera.latitude, camera.longitude)}${camera.heightAboveGround === undefined ? "，离地高度沿用当前" : `，离地 ${camera.heightAboveGround} m`}`
      : "沿用当前机位" });
  }
  if (request.target) {
    const target = request.target;
    rows.push({ label: "地面目标", value: `${target.name} · ${coordinate(target.latitude, target.longitude)} · 顶部高出地面 ${target.height} m` });
    rows.push({ label: "目标来源", value: target.landmark ? `已接入地标（${target.landmark}）` : "来自请求中的坐标，未核实" });
  }
  const date = request.date ?? "当前拍摄日期";
  rows.push({ label: "日期", value: request.kind === "position" ? `${date} 当天（时间轴范围）` : `${date} 起 ${spanName(request.days ?? 0)}` });
  rows.push({ label: "时区", value: request.timeZone ?? "沿用当前时区" });
  const conditions: string[] = [];
  if (request.tolerance !== undefined) conditions.push(`中心偏离 ≤ ${request.tolerance} 个视直径`);
  if (request.share !== undefined) conditions.push(`主体占画面高度 ${percent(request.share)}（目标不足 10 m 时改用最远距离）`);
  if (request.maxDistance !== undefined) conditions.push(`最远 ${request.maxDistance / 1000} km`);
  if (request.phase) conditions.push(`亮面 ${percent(request.phase[0])}—${percent(request.phase[1])}`);
  if (request.sky) conditions.push(`天空：${request.sky.map((sky) => skyConditionNames[sky]).join("、")}`);
  if (conditions.length) rows.push({ label: "条件", value: conditions.join("；") });
  return rows;
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
function table(header: string[], rows: string[][]) {
  const shown = rows.slice(0, REPORT_ROWS);
  return [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...shown.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ...(rows.length > shown.length ? ["", `另有 ${rows.length - shown.length} 条未列出。`] : []),
  ].join("\n");
}

export interface SolveReportInput {
  request: SolveRequest;
  /** `#solve=` link that opens the same request. */
  link: string;
  timeZone: string;
  /** One line on how the numbers were computed (camera height, refraction). */
  basis: string;
  /** Status line, e.g. "12 个月内 9 次". */
  status: string;
  header: string[];
  rows: string[][];
}

/** Markdown: request rows, link, status, results table and the limits that always apply. */
export function solveReport(input: SolveReportInput) {
  return [
    "## Tamatamatori 推算结果",
    "",
    ...describeSolve(input.request).map((row) => `- ${row.label}：${row.value}`),
    `- 推算请求：${input.link}`,
    "",
    input.status,
    "",
    ...(input.rows.length ? [table(input.header, input.rows), ""] : []),
    `时刻按 ${input.timeZone}。${input.basis}`,
    "数值由 Tamatamatori 在浏览器中本地计算，是基于地理与天文数据的构图模拟，不含天气；通视只按 DEM，不含建筑与树木，不代表实景一定可见。",
    "",
  ].join("\n");
}

/** 找时间: one row per alignment. */
export function timeRows(result: AlignmentResult, timeZone: string) {
  const moon = result.alignments.some((found) => found.illuminated !== null);
  const header = ["日期", "时刻", "容差内", "偏离（视直径）", "方位", "视高度", "天空", ...(moon ? ["亮面"] : [])];
  const rows = result.alignments.map((found) => [
    day(found.instant, timeZone),
    clock(found.instant, timeZone),
    `${clock(found.from, timeZone)}–${clock(found.to, timeZone)}`,
    `${(found.separation / found.diameter).toFixed(2)}${found.separation / found.diameter < 0.02 ? "" : `（${found.offset}）`}`,
    `${found.azimuth.toFixed(2)}°`,
    `${found.elevation.toFixed(2)}°`,
    skyConditionNames[found.sky],
    ...(moon ? [found.illuminated === null ? "" : percent(found.illuminated)] : []),
  ]);
  return { header, rows };
}

/** 找机位: the listed minutes (every ten) along the alignment lines. */
export function positionRows(points: readonly PositionPoint[], timeZone: string) {
  const header = ["时刻", "距目标 km", "机位", "目标方向", "天体视高度", "机位地面", "通视"];
  const rows = points.map((point) => [
    local(iso(point.time), timeZone),
    km(point.distance),
    coordinate(point.latitude, point.longitude),
    `${compassDirection(point.azimuth)} ${point.azimuth.toFixed(1)}°`,
    `${point.elevation.toFixed(2)}°`,
    `${Math.round(point.cameraGround) || 0} m`,
    sightNames[point.sight],
  ]);
  return { header, rows };
}

/** 两者都找: one row per candidate, placed at its middle minute. */
export function rangeRows(candidates: readonly RangeCandidate[], timeZone: string) {
  const moon = candidates.some((candidate) => candidate.illuminated !== null);
  const header = ["日期", "时段", "距目标 km", "主体占比", "中点机位", "天空", ...(moon ? ["亮面"] : []), "通视分钟"];
  const rows = candidates.map((candidate) => [
    candidate.day,
    `${clock(iso(candidate.start), timeZone)}–${clock(iso(candidate.end), timeZone)}`,
    candidate.near === candidate.far ? km(candidate.near) : `${km(candidate.near)}—${km(candidate.far)}`,
    candidate.share ? (candidate.share[0] === candidate.share[1] ? percent(candidate.share[0]) : `${percent(candidate.share[0])}—${percent(candidate.share[1])}`) : "—",
    coordinate(candidate.middle.latitude, candidate.middle.longitude),
    skyConditionNames[candidate.sky],
    ...(moon ? [candidate.illuminated === null ? "" : percent(candidate.illuminated)] : []),
    percent(candidate.clear),
  ]);
  return { header, rows };
}
