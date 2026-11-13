import { skyConditionNames } from "./alignment.ts";
import { bodyName } from "./sky-targets.ts";
import { compassDirection, localDateTime, sensors } from "./plan.ts";
import type { SolveRequest2 } from "./solve.ts";
import { dayLabel, heightWords, spotWords } from "./composition.ts";
import type { FilterSpec, GroundSpec, ResultItem } from "./composition.ts";

/**
 * Plain-text wording of a 推算 request and its results, shared by the link
 * preview and "复制结果" (Markdown a person or an AI can read back).
 */
/** Rows beyond this are counted, not listed. */
export const REPORT_ROWS = 200;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const coordinate = (latitude: number, longitude: number) => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
const iso = (time: number) => new Date(time).toISOString();
const clock = (instant: string, timeZone: string) => localDateTime(instant, timeZone).slice(11, 16);

export interface SolveRow {
  label: string;
  value: string;
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
  request: SolveRequest2;
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
    ...describeSolve2(input.request).map((row) => `- ${row.label}：${row.value}`),
    `- 推算请求：${input.link}`,
    "",
    input.status,
    "",
    ...(input.rows.length ? [table(input.header, input.rows), ""] : []),
    `时刻按 ${input.timeZone}。${input.basis}`,
    "数值由 Tamatamatori 在浏览器中本地计算，是基于地理与天文数据的构图模拟，不含天气；遮挡只看地形起伏，不含建筑与树木，不代表实景一定可见。",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 版本 2

const sensorWords = (lens: NonNullable<SolveRequest2["lens"]>) =>
  lens.sensor === "custom" && lens.sensorSize ? `${lens.sensorSize.width} × ${lens.sensorSize.height} mm` : sensors[lens.sensor as keyof typeof sensors]?.label ?? lens.sensor;
const toleranceWords = (tolerance: number) => `±${Number((tolerance * 100).toFixed(1))}%`;

/** A version 2 request as labelled rows; absent fields say what the app uses instead. */
export function describeSolve2(request: SolveRequest2): SolveRow[] {
  const rows: SolveRow[] = [];
  if (request.name) rows.push({ label: "名称", value: request.name });
  const lens = request.lens;
  rows.push({ label: "镜头", value: lens ? `${lens.focalLength} mm · ${sensorWords(lens)} · ${lens.aspectRatio} ${lens.orientation === "portrait" ? "竖幅" : "横幅"}` : "沿用当前镜头" });
  request.targets.forEach((target, index) => {
    const words = spotWords(target.frame);
    const place = `${words === "画面中心" ? words : `画面${words}`} · 容差 ${toleranceWords(target.tolerance)}`;
    rows.push({
      label: `目标 ${index + 1}`,
      value: target.type === "body"
        ? `${bodyName(target.body)} · ${place}`
        : `${target.name} · ${coordinate(target.latitude, target.longitude)} · ${heightWords({ ...target, kind: "ground", id: "", base: target.base } as GroundSpec)} · ${place}`
          + `${target.base !== null ? ` · 底部自上 ${percent(target.base)}` : ""} · ${target.landmark ? `已接入地标（${target.landmark}）` : "来自请求中的坐标，未核实"}`,
    });
  });
  const camera = request.camera;
  const eye = camera.heightAboveGround === undefined ? "" : `，离地 ${camera.heightAboveGround} m`;
  rows.push({
    label: "机位",
    value: camera.mode === "free"
      ? (request.targets.some((target) => target.type === "ground") ? `不限，离地面目标最远 ${camera.maxDistance / 1000} km${eye}` : `不限（只有天体时与机位基本无关，按打开者当前机位计算）${eye}`)
      : camera.mode === "near" ? `${coordinate(camera.latitude, camera.longitude)} 周围 ${camera.radius / 1000} km${eye}`
        : `${camera.latitude !== undefined && camera.longitude !== undefined ? `固定于 ${coordinate(camera.latitude, camera.longitude)}` : "固定为当前机位"}${camera.aim ? `，朝向固定（方位 ${camera.aim.azimuth.toFixed(2)}°，俯仰 ${camera.aim.pitch.toFixed(2)}°）` : ""}${eye}`,
  });
  rows.push({ label: "时间", value: request.time.mode === "instant" ? `固定为 ${request.time.instant.replace("T", " ").replace("Z", " UTC")}` : request.time.days === 1 ? `${request.time.date ?? "当前拍摄日期"} 当天` : `${request.time.date ?? "当前拍摄日期"} 起 ${dayLabel(request.time.days)}` });
  rows.push({ label: "时区", value: request.timeZone ?? "沿用当前时区" });
  rows.push({ label: "筛选", value: request.filters.length ? request.filters.map(filterWords).join("；") : "无" });
  return rows;
}
export function filterWords(filter: FilterSpec) {
  return filter.kind === "sky" ? `天空：${filter.sky.map((sky) => skyConditionNames[sky]).join("、")}`
    : filter.kind === "moonDown" ? "月亮在地平线下"
      : filter.kind === "darkSky" ? `星空可见性：天顶不亮于 ${filter.limit} mag/arcsec²（天文夜）`
        : `月亮亮面 ${percent(filter.range[0])}—${percent(filter.range[1])}`;
}

/** Result rows: one per stretch or window, the camera and the gap from the places. */
export function resultRows(items: readonly ResultItem[], timeZone: string) {
  const header = ["日期", "时段", "机位（试看处）", "目标方向与距离", "最大偏差", "天空", "月亮"];
  const rows = items.map((item) => [
    item.day,
    item.start === item.end ? clock(iso(item.start), timeZone) : `${clock(iso(item.start), timeZone)}–${clock(iso(item.end), timeZone)}`,
    coordinate(item.camera.latitude, item.camera.longitude),
    item.bearing === null ? "—" : `${compassDirection(item.bearing)} ${item.near === item.far ? km(item.near!) : `${km(item.near!)}—${km(item.far!)}`} km`,
    `${(item.deviation * 100).toFixed(1)}%`,
    skyConditionNames[item.sky],
    item.moonElevation < 0 ? "地平线下" : `高 ${item.moonElevation.toFixed(0)}° · 亮面 ${percent(item.moonLit)}`,
  ]);
  return { header, rows };
}
