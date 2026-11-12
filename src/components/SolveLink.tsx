import { useEffect, useRef, useState } from "react";
import { localDateTime } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { solveLink, solvePlan } from "../domain/solve";
import type { SolveParse, SolveRequest } from "../domain/solve";
import { describeSolve, positionRows, rangeRows, solveReport, timeRows } from "../domain/solve-report";
import { siteBase } from "../domain/site";
import { distinctPoints } from "../domain/position-alignment";
import { shotFromPlan } from "../domain/shot";
import { CALENDAR_LIMIT, calendarText, positionEvents, rangeEvents, solveShotName, timeEvents } from "../domain/solve-calendar";
import type { CalendarEvent } from "../domain/solve-calendar";
import { copyText, suggestShotName } from "./ShotMenu";
import type { AlignmentState } from "./Alignment";

const coordinate = (latitude: number, longitude: number) => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
const local = (plan: ShootingPlan) => `${localDateTime(plan.instant, plan.timeZone).replace("T", " ")}（${plan.timeZone}）`;
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const spanName = (days: number) => (days === 365 ? "12 个月" : days === 1096 ? "3 年" : `${days} 天`);
const site = () => (typeof window === "undefined" ? "" : siteBase(window.location, import.meta.env.BASE_URL));

/** What loading the request changes in the shooting plan, in words. */
export function solveChanges(before: ShootingPlan, after: ShootingPlan) {
  const changes: string[] = [];
  if (before.latitude !== after.latitude || before.longitude !== after.longitude)
    changes.push(`机位：${coordinate(before.latitude, before.longitude)} → ${coordinate(after.latitude, after.longitude)}`);
  if (before.cameraHeight !== after.cameraHeight) changes.push(`离地高度：${before.cameraHeight} m → ${after.cameraHeight} m`);
  if (before.azimuth !== after.azimuth || before.pitch !== after.pitch)
    changes.push(`方向：朝向期望位置（方位 ${after.azimuth.toFixed(2)}°，俯仰 ${after.pitch.toFixed(2)}°）`);
  if (before.timeZone !== after.timeZone || !!before.followLocalZone !== !!after.followLocalZone)
    changes.push(`时区：固定为 ${after.timeZone}${before.followLocalZone ? "（不再随机位）" : ""}`);
  if (before.instant !== after.instant) changes.push(`拍摄时刻：${local(before)} → ${local(after)}`);
  return changes;
}

/**
 * Preview of a `#solve=` link: nothing changes until "载入并推算". Closing
 * either way lets the page drop the hash.
 */
export function SolveLinkDialog({ link, plan, onLoad, onClose }: {
  link: { parse: SolveParse; serial: number } | null;
  plan: ShootingPlan;
  onLoad: (request: SolveRequest) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), errors = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    setCopied("");
    if (link && !dialog.current?.open) dialog.current?.showModal();
    else if (!link && dialog.current?.open) dialog.current.close();
  }, [link?.serial]);
  const parse = link?.parse ?? null;
  const changes = parse?.ok ? solveChanges(plan, solvePlan(parse.request, plan)) : [];
  return (
    <dialog ref={dialog} className="shot-dialog solve-dialog" aria-labelledby="solve-link-title" onClose={onClose}>
      <header className="about-header">
        <div>
          <span className="eyebrow">推算</span>
          <h2 id="solve-link-title">打开推算请求</h2>
        </div>
        <button className="reset-button" type="button" onClick={() => dialog.current?.close()}>
          关闭
        </button>
      </header>
      <div className="about-body shot-dialog-body">
        {parse && !parse.ok && (
          <div className="shot-errors" role="alert">
            <p>链接中的推算请求无法读取，共 {parse.errors.length} 处问题：</p>
            <ul>
              {parse.errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
            <textarea ref={errors} className="shot-copy-source" readOnly value={parse.errors.join("\n")} aria-hidden="true" tabIndex={-1} />
            <button type="button" onClick={async () => setCopied(await copyText(parse.errors.join("\n"), errors.current))}>
              复制问题列表
            </button>
            <span role="status">{copied}</span>
          </div>
        )}
        {parse?.ok && (
          <div className="shot-preview">
            <p>链接带来一份推算请求。确认后才会载入并在本机推算，数值不来自链接。</p>
            <dl className="shot-summary">
              {describeSolve(parse.request).map((row) => (
                <div key={row.label} className="solve-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="solve-changes">
              <strong>载入后</strong>
              {changes.length ? <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul> : <p>拍摄计划不变，只载入推算条件。</p>}
              <p>进入推算模式并开始计算；可在提示条中撤销。</p>
            </div>
          </div>
        )}
      </div>
      <footer className="shot-dialog-footer">
        <button type="button" onClick={() => dialog.current?.close()}>取消</button>
        <button type="button" className="shot-primary" disabled={!parse?.ok} onClick={() => {
          if (!parse?.ok) return;
          onLoad(parse.request);
          dialog.current?.close();
        }}>
          载入并推算
        </button>
      </footer>
    </dialog>
  );
}

/** The current search's results as Markdown, or null while there are none to copy. */
function report(alignment: AlignmentState, plan: ShootingPlan, request: SolveRequest, link: string) {
  const basis = `机位离地 ${plan.cameraHeight} m，按${plan.refraction === "standard" ? "标准折射" : "无折射"}与海平面地平计算。`;
  const common = { request, link, timeZone: plan.timeZone, basis };
  if (alignment.kind === "time") {
    const result = alignment.result;
    if (!result) return null;
    const total = result.filtered.phase + result.filtered.sky;
    const status = result.alignments.length
      ? `${spanName(alignment.settings.days)}内 ${result.alignments.length} 次${total ? `；另有 ${total} 次不满足所选月相或天空条件` : ""}。`
      : "没有落在容差内的一次。";
    return solveReport({ ...common, status, ...timeRows(result, plan.timeZone) });
  }
  if (alignment.kind === "position") {
    const { result, points } = alignment.position;
    if (!result) return null;
    const listed = distinctPoints(points.filter((point) => localDateTime(new Date(point.time).toISOString(), plan.timeZone).endsWith("0")));
    const status = points.length
      ? `对齐线 ${result.minutes} 分钟 · 距目标 ${km(Math.min(...points.map((point) => point.distance)))}—${km(Math.max(...points.map((point) => point.distance)))} km；下表每 10 分钟一行。`
      : "时段内没有解。";
    return solveReport({ ...common, status, ...positionRows(listed, plan.timeZone) });
  }
  const range = alignment.range;
  if (!range.done) return null;
  const total = range.filtered.phase + range.filtered.sky;
  const status = range.kept.length
    ? `${spanName(range.span)}内 ${range.kept.length} 个候选${total ? `；另有 ${total} 个不满足所选月相或天空条件` : ""}。`
    : `${spanName(range.span)}内没有解。`;
  return solveReport({ ...common, status, ...rangeRows(range.kept, plan.timeZone) });
}

/** "存为机位" from the 推算 panel, provided by the workspace. */
export interface ShotSaving {
  save: (name: string) => boolean;
  error: string;
  writable: boolean;
}

/** Where a saved result or a calendar event is named after: the target, or the camera's place for 找时间. */
function placeOf(alignment: AlignmentState, plan: ShootingPlan) {
  if (alignment.kind !== "time" && alignment.position.target?.name) return alignment.position.target.name;
  return suggestShotName(shotFromPlan(plan)).split(" · ")[0];
}

/** Whether the plan is the try-out of a listed result (the instant and, away from 找时间, the camera match). */
function trying(alignment: AlignmentState, plan: ShootingPlan) {
  if (alignment.kind === "time") return !!alignment.result?.alignments.some((found) => found.instant === plan.instant);
  if (alignment.kind === "position") return !!alignment.position.current;
  return !!alignment.range.currentPoint;
}

function calendarEvents(alignment: AlignmentState, plan: ShootingPlan, place: string): CalendarEvent[] | null {
  const context = { plan, body: alignment.settings.body, place, site: site() };
  if (alignment.kind === "time") return alignment.result ? timeEvents(alignment.result.alignments, context) : null;
  if (alignment.kind === "position") return alignment.position.result ? positionEvents(alignment.position.points, context) : null;
  return alignment.range.done ? rangeEvents(alignment.range.kept, context) : null;
}

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "存为机位" and "导出日历" for results; "复制推算请求" (a `#solve=` link) and "复制结果" (Markdown) for the search. */
export function SolveExport({ alignment, plan, saving }: { alignment: AlignmentState; plan: ShootingPlan; saving?: ShotSaving }) {
  const [copied, setCopied] = useState("");
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const request = alignment.request();
  const link = request ? solveLink(request, site()) : "";
  const markdown = request ? report(alignment, plan, request, link) : null;
  const place = placeOf(alignment, plan);
  const trial = trying(alignment, plan);
  const ready = alignment.kind === "time" ? !!alignment.result : alignment.kind === "position" ? !!alignment.position.result : !!alignment.range.done;
  useEffect(() => setCopied(""), [link, markdown]);
  useEffect(() => {
    if (saving?.error) setCopied(`无法保存机位：${saving.error}`);
  }, [saving?.error]);
  const copy = async (value: string, done: string) => {
    setText(value);
    // The fallback selects this field before React renders the new text.
    if (field.current) field.current.value = value;
    const status = await copyText(value, field.current);
    setCopied(status === "已复制" ? done : status);
  };
  const save = () => {
    if (!saving) return;
    const name = solveShotName(place, alignment.settings.body, plan.instant, plan.timeZone);
    if (saving.save(name)) setCopied(`已存为机位「${name}」，可在“机位”中改名`);
    else setCopied(`无法保存机位${saving.error ? `：${saving.error}` : ""}`);
  };
  const exportCalendar = () => {
    const events = calendarEvents(alignment, plan, place);
    if (!events?.length) return;
    const date = (request?.date ?? localDateTime(plan.instant, plan.timeZone).slice(0, 10)).replace(/-/g, "");
    download(calendarText(events, `Tamatamatori 推算 · ${place}`), `tamatamatori-${alignment.kind}-${date}.ics`);
    setCopied(events.length > CALENDAR_LIMIT ? `已导出前 ${CALENDAR_LIMIT} 个事件（共 ${events.length} 个）` : `已导出 ${events.length} 个事件`);
  };
  return (
    <div className="alignment-section alignment-export">
      <h3>保存与导出</h3>
      <div className="alignment-actions">
        <button type="button" disabled={!saving?.writable || !trial} onClick={save}
          title={!trial ? "先试看一个结果" : !saving?.writable ? "本机存储不可用" : "把正在试看的结果存为机位"}>存为机位</button>
        <button type="button" disabled={!ready} onClick={exportCalendar}>导出日历</button>
        <button type="button" disabled={!request} onClick={() => copy(link, "已复制推算请求链接")}>复制推算请求</button>
        <button type="button" disabled={!markdown} onClick={() => markdown && copy(markdown, "已复制结果（Markdown）")}>复制结果</button>
      </div>
      <span className="alignment-copied" role="status">{copied}</span>
      <textarea ref={field} className="shot-copy-source" readOnly value={text} aria-hidden="true" tabIndex={-1} />
      <p className="alignment-hint">
        {trial ? "存为机位保存正在试看的结果。" : "试看一个结果后可存为机位。"}
        日历（.ics）每个结果一个事件，附打开机位的链接。推算请求是一个链接，打开后先预览、确认才会在对方本机推算；结果为 Markdown 表格，可贴给人或 AI 阅读。
      </p>
    </div>
  );
}
