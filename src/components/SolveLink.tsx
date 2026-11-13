import { useEffect, useRef, useState } from "react";
import { localDateTime } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { solveLink2, solvePlan2 } from "../domain/solve";
import type { SolveParse2, SolveRequest2 } from "../domain/solve";
import { describeSolve2, resultRows, solveReport } from "../domain/solve-report";
import { siteBase } from "../domain/site";
import { shotFromPlan } from "../domain/shot";
import { dayLabel, targetName } from "../domain/composition";
import { CALENDAR_LIMIT, calendarText, resultEvents, solveShotName } from "../domain/solve-calendar";
import { bodyName } from "../domain/sky-targets";
import { copyText, suggestShotName } from "./ShotMenu";
import type { CompositionState } from "./Composition";

const coordinate = (latitude: number, longitude: number) => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
const local = (plan: ShootingPlan) => `${localDateTime(plan.instant, plan.timeZone).replace("T", " ")}（${plan.timeZone}）`;
const site = () => (typeof window === "undefined" ? "" : siteBase(window.location, import.meta.env.BASE_URL));

/** What loading the request changes in the shooting plan, in words. */
export function solveChanges(before: ShootingPlan, after: ShootingPlan) {
  const changes: string[] = [];
  if (before.latitude !== after.latitude || before.longitude !== after.longitude)
    changes.push(`机位：${coordinate(before.latitude, before.longitude)} → ${coordinate(after.latitude, after.longitude)}`);
  if (before.cameraHeight !== after.cameraHeight) changes.push(`离地高度：${before.cameraHeight} m → ${after.cameraHeight} m`);
  if (before.focalLength !== after.focalLength || before.sensor !== after.sensor || before.aspectRatio !== after.aspectRatio || before.orientation !== after.orientation)
    changes.push(`镜头：${after.focalLength} mm · ${after.aspectRatio} ${after.orientation === "portrait" ? "竖幅" : "横幅"}（目标的画面位置按此镜头）`);
  if (before.azimuth !== after.azimuth || before.pitch !== after.pitch)
    changes.push(`方向：固定为请求中的朝向（方位 ${after.azimuth.toFixed(2)}°，俯仰 ${after.pitch.toFixed(2)}°）`);
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
  link: { parse: SolveParse2; serial: number } | null;
  plan: ShootingPlan;
  onLoad: (request: SolveRequest2) => void;
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
  const changes = parse?.ok ? solveChanges(plan, solvePlan2(parse.request, plan)) : [];
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
            <p>链接带来一份推算请求。确认后才会载入并在本机推算，数值不来自链接。{parse.from === 1 && "这是旧版（v1）请求，已按当前镜头转换。"}</p>
            <dl className="shot-summary">
              {describeSolve2(parse.request).map((row) => (
                <div key={row.label} className="solve-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="solve-changes">
              <strong>载入后</strong>
              {changes.length ? <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul> : <p>拍摄计划不变，只载入推算条件。</p>}
              <p>进入推算模式并开始搜索；可在提示条中撤销。</p>
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
function report(state: CompositionState, plan: ShootingPlan, request: SolveRequest2, link: string) {
  const run = state.run;
  if (!run || run.phase !== "done") return null;
  const basis = `机位离地 ${plan.cameraHeight} m，按${plan.refraction === "standard" ? "标准折射" : "无折射"}与海平面地平计算。`;
  const span = run.composition.time.mode === "instant" ? "所选时刻" : `${dayLabel(run.composition.time.days)}内`;
  const hidden = [run.blocked && `另有 ${run.blocked} 分钟视线被地形挡住`, run.filtered && `${run.filtered} ${run.strategy.kind === "line" ? "分钟" : "次"}不满足筛选`].filter(Boolean).join("，");
  const status = run.items.length ? `${span} ${run.items.length} 段${hidden ? `；${hidden}` : ""}。` : run.note || "没有结果。";
  return solveReport({ request, link, timeZone: run.timeZone, basis, status, ...resultRows(run.items, run.timeZone) });
}

/** "存为机位" from the 推算 panel, provided by the workspace. */
export interface ShotSaving {
  save: (name: string) => boolean;
  error: string;
  writable: boolean;
}

/** Where a saved result or a calendar event is named after: the ground target, or the camera's place. */
function placeOf(state: CompositionState, plan: ShootingPlan) {
  const ground = (state.run?.basis.ground ?? null) || state.composition.targets.find((target) => target.kind === "ground");
  if (ground) return targetName(ground);
  return suggestShotName(shotFromPlan(plan)).split(" · ")[0];
}

function calendarEvents(state: CompositionState, plan: ShootingPlan, place: string) {
  const run = state.run;
  if (!run || run.phase !== "done") return null;
  const names = run.basis.bodies.map(bodyName).join("、");
  return resultEvents(run.items, { plan, body: run.basis.bodies[0] ?? "sun", place, site: site(), basis: run.basis, names });
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
export function SolveExport({ state, plan, saving }: { state: CompositionState; plan: ShootingPlan; saving?: ShotSaving }) {
  const [copied, setCopied] = useState("");
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const request = state.request();
  const link = request ? solveLink2(request, site()) : "";
  const markdown = request ? report(state, plan, request, link) : null;
  const place = placeOf(state, plan);
  const trial = !!state.current;
  const ready = state.run?.phase === "done" && state.run.items.length > 0;
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
    const name = solveShotName(place, state.run?.basis.bodies[0] ?? "sun", plan.instant, plan.timeZone);
    if (saving.save(name)) setCopied(`已存为机位「${name}」，可在“机位”中改名`);
    else setCopied(`无法保存机位${saving.error ? `：${saving.error}` : ""}`);
  };
  const exportCalendar = () => {
    const events = calendarEvents(state, plan, place);
    if (!events?.length) return;
    const time = state.run!.composition.time;
    const date = (time.mode === "range" ? time.date : localDateTime(time.instant, plan.timeZone).slice(0, 10)).replace(/-/g, "");
    download(calendarText(events, `Tamatamatori 推算 · ${place}`), `tamatamatori-solve-${date}.ics`);
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
