import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { Temporal } from "@js-temporal/polyfill";
import {
  finishAlignment,
  frameDirection,
  markOutline,
  scanAlignment,
  skyConditionNames,
  skyConditions,
  bodyRadius,
  spanChoices,
  targetElevationRange,
  toleranceChoices,
} from "../domain/alignment";
import type { AlignmentBody, AlignmentInput, AlignmentResult, AlignmentScan, SkyCondition } from "../domain/alignment";
import { localDateTime } from "../domain/plan";
import { bodyKind, bodyName, bodyLayer, fixedBodies, isFixedBody, sizeWord } from "../domain/sky-targets";
import { restoredLayers, triedLayers } from "../domain/position-alignment";
import type { TriedLayers } from "../domain/position-alignment";
import type { ShootingPlan } from "../domain/plan";
import { solveRequestOf, solveStart } from "../domain/solve";
import type { SolveRequest } from "../domain/solve";
import type { View } from "../domain/celestial-projection";
import { occlusionText } from "../domain/visibility";
import type { Occlusion } from "../domain/visibility";
import type { TimelineEvent } from "../domain/timeline";
import { NumberField } from "./NumberField";
import { PositionPanel, usePositionSearch } from "./PositionSearch";
import { RangePanel, useRangeSearch } from "./RangeSearch";
import { SolveExport } from "./SolveLink";
import { CheckControls, checkTargets, useFeasibility } from "./Feasibility";
import type { ShotSaving } from "./SolveLink";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;
const DAY = 86_400_000;
const SLICE = 30 * DAY;
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export interface AlignmentSettings {
  body: AlignmentBody;
  /** Apparent direction of the mark; null until placed. */
  target: { azimuth: number; elevation: number } | null;
  /** First local date of the search, in the plan's time zone. */
  start: string;
  days: number;
  tolerance: number;
  /** Moon only: lit percentage range. */
  phase: readonly [number, number];
  /** Moon only. */
  sky: readonly SkyCondition[];
}

// The search belongs to a camera: moving it, raising it or changing the
// refraction model makes listed instants stale (the mark no longer means the
// same spot against the scenery).
type Basis = Pick<ShootingPlan, "latitude" | "longitude" | "cameraHeight" | "refraction">;
const basisKey = (plan: Basis) => `${plan.latitude}/${plan.longitude}/${plan.cameraHeight}/${plan.refraction}`;

interface Run {
  settings: AlignmentSettings;
  basis: string;
  phase: "running" | "done" | "error";
  progress: number;
  result: AlignmentResult | null;
  message: string;
  from: number;
  to: number;
}

/** Fields a try-out changes, kept from before the first one for "返回推算前". */
interface Before {
  instant: string;
  layers: TriedLayers;
}

function clampTarget(target: { azimuth: number; elevation: number }) {
  return {
    azimuth: round(((target.azimuth % 360) + 360) % 360, 3),
    elevation: round(Math.max(targetElevationRange[0], Math.min(targetElevationRange[1], target.elevation)), 3),
  };
}

/**
 * State of the "推算 · 找时间" mode: the mark, the search conditions, the
 * sliced search and the try-out. The camera, direction and lens stay the
 * user's; a try-out only sets the instant and turns the body's layer on.
 */
export function useAlignment(plan: ShootingPlan, update: UpdatePlan, active: boolean, generation: number) {
  const [settings, setSettings] = useState<AlignmentSettings>({
    body: "sun",
    target: null,
    start: "",
    days: 365,
    tolerance: 0.25,
    phase: [0, 100],
    sky: skyConditions,
  });
  // "找时间" keeps the camera; "找机位" keeps a ground target and the timeline's span.
  const [kind, setKind] = useState<"time" | "position" | "range">("time");
  const position = usePositionSearch(plan, update, active && kind === "position", generation, settings.body);
  // "两者都找" shares the ground target (and its map placement) with "找机位".
  const range = useRangeSearch(plan, update, active && kind === "range", generation, settings.body, position);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [before, setBefore] = useState<Before | null>(null);
  const latest = useRef(plan);
  latest.current = plan;
  const token = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (active && !settings.start)
      setSettings((current) => ({ ...current, start: localDateTime(plan.instant, plan.timeZone).slice(0, 10) }));
    if (!active) {
      setPlacing(false);
      setPlaceError("");
      setBefore(null);
    }
  }, [active]);
  // A whole new plan (an applied shot) is not a try-out to return from.
  useEffect(() => setBefore(null), [generation]);
  useEffect(() => {
    if (!placing) return;
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPlacing(false);
      setPlaceError("");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [placing]);
  useEffect(() => () => {
    token.current++;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const compute = (next: AlignmentSettings) => {
    const id = ++token.current;
    if (timer.current) clearTimeout(timer.current);
    const current = latest.current;
    const base = { settings: next, basis: basisKey(current), progress: 0, result: null, message: "" };
    let from: number, to: number;
    try {
      const date = Temporal.PlainDate.from(next.start);
      from = date.toZonedDateTime({ timeZone: current.timeZone }).epochMilliseconds;
      to = date.add({ days: next.days }).toZonedDateTime({ timeZone: current.timeZone }).epochMilliseconds;
    } catch {
      setRun({ ...base, phase: "error", message: "起始日期无效", from: 0, to: 0 });
      return;
    }
    if (from < Date.UTC(1900, 0, 1) || to > Date.UTC(2101, 0, 1)) {
      setRun({ ...base, phase: "error", message: "请把时间范围保持在 1900—2100 年内", from, to });
      return;
    }
    const target = next.target!;
    const moon = next.body === "moon", dark = moon || isFixedBody(next.body);
    const input: AlignmentInput = {
      latitude: current.latitude,
      longitude: current.longitude,
      refraction: current.refraction,
      target: { body: next.body, ...target },
      tolerance: next.tolerance,
      ...(moon && (next.phase[0] > 0 || next.phase[1] < 100) ? { phase: [next.phase[0] / 100, next.phase[1] / 100] as const } : {}),
      ...(dark && next.sky.length < skyConditions.length ? { sky: next.sky } : {}),
    };
    setRun({ ...base, phase: "running", from, to });
    const scans: AlignmentScan[] = [];
    let cursor = from;
    // Thirty days per slice keep each step to a few milliseconds.
    const step = () => {
      timer.current = null;
      if (id !== token.current) return;
      try {
        const until = Math.min(to, cursor + SLICE);
        scans.push(scanAlignment(input, cursor, until));
        cursor = until;
        if (cursor < to) {
          setRun((state) => (state && id === token.current ? { ...state, progress: (cursor - from) / (to - from) } : state));
          timer.current = setTimeout(step, 0);
          return;
        }
        const result = finishAlignment(input, scans, from, to);
        setRun((state) => (state && id === token.current ? { ...state, phase: "done", progress: 1, result } : state));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRun((state) => (state && id === token.current ? { ...state, phase: "error", message } : state));
      }
    };
    timer.current = setTimeout(step, 0);
  };

  // Changing the mark or a condition searches again shortly after the last change.
  useEffect(() => {
    if (!active || kind !== "time" || !settings.target || !settings.start) return;
    if (run && run.settings === settings && run.basis === basisKey(latest.current) && run.phase !== "error") return;
    const delay = setTimeout(() => compute(settings), 250);
    return () => clearTimeout(delay);
  }, [active, kind, settings]);
  useEffect(() => {
    if (kind !== "time") setPlacing(false);
  }, [kind]);

  const change = (patch: Partial<AlignmentSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const setTarget = (target: { azimuth: number; elevation: number }) => change({ target: clampTarget(target) });
  const place = (target: { azimuth: number; elevation: number }) => {
    if (target.elevation < targetElevationRange[0]) {
      setPlaceError("期望位置需在海平面地平以上（视高度不低于 −0.25°），请点画面中更高的位置");
      return;
    }
    setPlaceError("");
    setPlacing(false);
    setTarget(target);
  };
  const stale = !!run && run.phase === "done" && run.basis !== basisKey(plan);
  const pending = !!run && run.settings !== settings;
  const result = run?.phase === "done" && !stale && !pending ? run.result : null;

  const tryOut = (instant: string) => {
    const current = latest.current;
    setBefore((kept) => kept ?? { instant: current.instant, layers: triedLayers(current.layers) });
    update({ instant, layers: { ...current.layers, [bodyLayer(settings.body)]: true } });
  };
  const restore = () => {
    if (!before) return;
    const current = latest.current;
    update({ instant: before.instant, layers: restoredLayers(current.layers, before.layers) });
    setBefore(null);
  };

  const timeEvents = useMemo<TimelineEvent[]>(() => (active && kind === "time" && result ? result.alignments.map((found) => ({
    key: `alignment-${found.instant}`,
    kind: "alignment" as const,
    label: "对齐",
    instant: found.instant,
    detail: `${bodyName(settings.body)}中心距期望位置 ${round(found.separation / found.diameter)} 个${sizeWord(settings.body)}（容差内 ${clockOf(found.from, plan.timeZone)}–${clockOf(found.to, plan.timeZone)}）`,
  })) : []), [active, kind, result, plan.timeZone, settings.body]);

  /** Opens a request (from a link): its kind, body, mark or target and conditions; `opened` is the plan it applies to. */
  const load = (request: SolveRequest, opened: ShootingPlan) => {
    const start = solveStart(request, opened);
    const phase = request.phase ? [Math.round(request.phase[0] * 100), Math.round(request.phase[1] * 100)] as const : [0, 100] as const;
    const sky = request.sky ?? skyConditions;
    setKind(request.kind);
    setPlacing(false);
    setPlaceError("");
    position.setPlacing(false);
    if (request.kind === "time" && request.mark) {
      setSettings((current) => ({ ...current, body: request.body, target: clampTarget(request.mark!), start, days: request.days ?? current.days, tolerance: request.tolerance ?? current.tolerance, phase, sky }));
      return;
    }
    setSettings((current) => ({ ...current, body: request.body }));
    if (!request.target) return;
    const { landmark, ...target } = request.target;
    position.setTarget(landmark ? { ...target, id: landmark } : target);
    if (request.kind === "position") position.setMaxDistance(request.maxDistance ?? 30_000);
    if (request.kind === "range") {
      range.setShare(request.share ?? 0.3);
      range.setSpan(request.days ?? 30);
      range.setStart(start);
      range.setMaxDistance(request.maxDistance ?? 30_000);
      range.setPhase(phase);
      range.setSky(sky);
    }
  };
  /** The current search as a request ("复制推算请求"); null until it has a mark or a target. */
  const request = () => {
    const current = latest.current;
    const today = localDateTime(current.instant, current.timeZone).slice(0, 10);
    const fraction = (value: readonly [number, number]) => [value[0] / 100, value[1] / 100] as const;
    return solveRequestOf({
      kind, body: settings.body, mark: settings.target,
      camera: { latitude: current.latitude, longitude: current.longitude, heightAboveGround: current.cameraHeight },
      target: position.target ? { ...position.target, name: position.target.name ?? "地面目标" } : null,
      date: kind === "time" ? settings.start || today : kind === "range" ? range.start || today : position.span.date,
      days: kind === "time" ? settings.days : range.span,
      timeZone: current.timeZone,
      tolerance: settings.tolerance,
      share: range.share,
      maxDistance: kind === "position" ? position.maxDistance : range.maxDistance,
      phase: fraction(kind === "time" ? settings.phase : range.phase),
      sky: kind === "time" ? settings.sky : range.sky,
    });
  };

  return {
    active, kind, setKind, position, range, settings, change, setTarget, place, placing, setPlacing, placeError, setPlaceError,
    run, stale, pending, result, recompute: () => settings.target && compute(settings),
    tryOut, restore, canRestore: !!before, load, request,
    events: kind === "time" ? timeEvents : kind === "position" ? position.events : range.events,
  };
}
export type AlignmentState = ReturnType<typeof useAlignment>;

const clockOf = (instant: string, timeZone: string) => localDateTime(instant, timeZone).slice(11, 16);
function dateOf(instant: string, timeZone: string) {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
  return { month: `${local.year} 年 ${local.month} 月`, day: `${local.month}/${local.day} ${weekdays[local.dayOfWeek - 1]}` };
}

/** Normalised device coordinates of a pointer inside the frame. */
function framePoint(element: HTMLElement, event: { clientX: number; clientY: number }) {
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    y: ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
  };
}

/** Places the mark where the frame was clicked; true when the click was used. */
export function placeFromPointer(alignment: AlignmentState, view: View, element: HTMLElement, event: { clientX: number; clientY: number }) {
  if (!alignment.active || alignment.kind !== "time" || !alignment.placing) return false;
  const point = framePoint(element, event);
  if (point) alignment.place(frameDirection(view, point.x, point.y));
  return true;
}

/**
 * The dashed circle on the frame: the body's mean size at the mark. Its
 * handle drags the mark or nudges it with the arrow keys (0.05°, Shift 0.5°).
 */
export function AlignmentMark({ alignment, view, frame }: { alignment: AlignmentState; view: View; frame: RefObject<HTMLDivElement | null> }) {
  const drag = useRef<number | null>(null);
  const { settings } = alignment;
  if (!alignment.active || alignment.kind !== "time" || !settings.target) return null;
  const target = { body: settings.body, ...settings.target };
  const outline = markOutline(view, target);
  if (!outline) return null;
  const centre = {
    x: outline.reduce((sum, point) => sum + point.x, 0) / outline.length,
    y: outline.reduce((sum, point) => sum + point.y, 0) / outline.length,
  };
  if (Math.abs(centre.x) > 1.02 || Math.abs(centre.y) > 1.02) return null;
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current !== event.pointerId || !frame.current) return;
    const point = framePoint(frame.current, event);
    if (point) alignment.setTarget(frameDirection(view, point.x, point.y));
  };
  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const size = event.shiftKey ? 0.5 : 0.05;
    alignment.setTarget({ azimuth: settings.target!.azimuth + step[0] * size, elevation: settings.target!.elevation + step[1] * size });
  };
  const path = `${outline.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(5)},${point.y.toFixed(5)}`).join(" ")}Z`;
  return (
    <div className={`alignment-mark alignment-mark-${bodyKind(settings.body)}`} data-alignment-mark={settings.body}>
      <svg viewBox="-1 -1 2 2" preserveAspectRatio="none" aria-hidden="true">
        <path d={path} vectorEffect="non-scaling-stroke" />
      </svg>
      <button
        type="button"
        className="alignment-handle"
        style={{ left: `${(centre.x + 1) * 50}%`, top: `${(centre.y + 1) * 50}%` }}
        aria-label={`${bodyName(settings.body)}期望位置：方位 ${settings.target.azimuth.toFixed(2)}°，视高度 ${settings.target.elevation.toFixed(2)}°。拖动或用方向键微调`}
        title="拖动或用方向键微调期望位置（Shift 加大步长）"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = event.pointerId;
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (drag.current !== event.pointerId) return;
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => (drag.current = null)}
        onLostPointerCapture={() => (drag.current = null)}
        onKeyDown={nudge}
      >
        <span>{bodyName(settings.body)}期望位置</span>
      </button>
    </div>
  );
}

const percentChoices = [0, 10, 25, 50, 75, 90, 100];

/** Right-rail panel of the mode: what to find, conditions and the listed instants. */
export function AlignmentPanel({ alignment, plan, view, update, occlusion, saving }: {
  alignment: AlignmentState;
  plan: ShootingPlan;
  view: View;
  update: UpdatePlan;
  saving?: ShotSaving;
  /** The body's state in the current preview, for the try-out in view. */
  occlusion: { state: string; occlusion: Occlusion } | null;
}) {
  const { settings, change, run, result } = alignment;
  // "检查机位" belongs to the panel: it is asked for, and lasts while the listed results do.
  const check = useFeasibility(alignment, plan);
  const name = bodyName(settings.body);
  const target = settings.target;
  const outline = target ? markOutline(view, { body: settings.body, ...target }) : null;
  const inFrame = !!outline && outline.some((point) => Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1);
  const span = spanChoices.find((choice) => choice.days === settings.days)?.label ?? `${settings.days} 天`;
  const list = result?.alignments ?? [];
  const current = list.find((found) => found.instant === plan.instant);
  const time = Date.parse(plan.instant);
  const previous = [...list].reverse().find((found) => Date.parse(found.instant) < time - 1000);
  const next = list.find((found) => Date.parse(found.instant) > time + 1000);
  const filteredText = (filtered: AlignmentResult["filtered"]) =>
    [filtered.phase && `月相 ${filtered.phase}`, filtered.sky && `天空条件 ${filtered.sky}`].filter(Boolean).join("、");
  let summary: ReactNode = null;
  if (!target) summary = <p className="alignment-hint">先在预览中放置{name}的期望位置，放下后自动推算。</p>;
  else if (!run || alignment.pending || run.phase === "running")
    summary = <p className="alignment-status" role="status">推算中 · {Math.round((alignment.pending ? 0 : run?.progress ?? 0) * 100)}%</p>;
  else if (run.phase === "error") summary = <p className="alignment-status is-error" role="status">推算失败：{run.message}</p>;
  else if (alignment.stale)
    summary = <div className="alignment-status is-stale" role="status">
      <p>机位、离地高度或大气折射已改变，原结果已过期。</p>
      <button type="button" onClick={alignment.recompute}>重新推算</button>
    </div>;
  else if (result) {
    const total = result.filtered.phase + result.filtered.sky;
    if (result.alignments.length)
      summary = <p className="alignment-status" role="status">
        {span}内 {result.alignments.length} 次{total > 0 && `；另有 ${total} 次被筛掉（${filteredText(result.filtered)}）`}
      </p>;
    else {
      const nearest = result.nearest;
      summary = <div className="alignment-status is-empty" role="status">
        <p>{result.reason === "filtered" ? `有 ${total} 次对齐，但都不满足所选条件（${filteredText(result.filtered)}）。`
          : result.reason === "too-high" ? `${span}内${name}最高只到约 ${result.reach.max.toFixed(1)}°，达不到期望高度 ${target.elevation.toFixed(1)}°。`
            : result.reason === "too-low" ? `${span}内${name}始终高于约 ${result.reach.min.toFixed(1)}°，降不到期望高度 ${target.elevation.toFixed(1)}°。`
              : `${span}内${name}没有落在容差内的一次。`}</p>
        {nearest && result.reason !== "filtered" && <p className="alignment-nearest">
          最接近：{dateOf(nearest.instant, plan.timeZone).day} {clockOf(nearest.instant, plan.timeZone)}，
          偏 {round(nearest.separation / nearest.diameter)} 个{sizeWord(settings.body)} · {nearest.offset}
          <button type="button" onClick={() => alignment.tryOut(nearest.instant)}>试看</button>
        </p>}
      </div>;
    }
  }
  const months = new Map<string, typeof list>();
  for (const found of list) {
    const key = dateOf(found.instant, plan.timeZone).month;
    months.set(key, [...(months.get(key) ?? []), found]);
  }
  return (
    <section className="alignment-panel" aria-label="推算">
      <header className="alignment-header">
        <div className="alignment-kinds" role="group" aria-label="求解对象">
          {(["time", "position", "range"] as const).map((kind) => (
            <button key={kind} type="button" aria-pressed={alignment.kind === kind} onClick={() => alignment.setKind(kind)}>
              {kind === "time" ? "找时间" : kind === "position" ? "找机位" : "两者都找"}
            </button>
          ))}
        </div>
        {alignment.kind === "time"
          ? <p>机位、方向与镜头保持不变，求{name}落到画面中期望位置的时刻。只按星历与海平面地平计算，不含天气。</p>
          : alignment.kind === "position"
            ? <p>地面目标与日期已定，求在哪里拍能让{name}落在目标顶部。只按星历、DEM 与海平面地平计算，不含天气。</p>
            : <p>地面目标与主体在画面中的大小已定，在一段日期内求哪天、在哪里拍能让{name}落在目标顶部。只按星历、DEM 与海平面地平计算，不含天气。</p>}
      </header>
      <div className="alignment-section">
        <BodyPicker body={settings.body} onChange={(body) => change({ body })} />
      </div>
      {alignment.kind === "position" ? (
        <PositionPanel search={alignment.position} plan={plan} body={settings.body} occlusion={occlusion} check={check} />
      ) : alignment.kind === "range" ? (
        <RangePanel search={alignment.range} position={alignment.position} plan={plan} body={settings.body} occlusion={occlusion} check={check} />
      ) : <>
      <div className="alignment-section">
        <h3>期望位置</h3>
        <div className="alignment-actions">
          <button type="button" aria-pressed={alignment.placing} className={alignment.placing ? "is-active" : ""}
            onClick={() => { alignment.setPlacing(!alignment.placing); alignment.setPlaceError(""); }}>
            {alignment.placing ? "取消放置" : "在预览中放置"}
          </button>
          <button type="button" onClick={() => alignment.setTarget({ azimuth: view.azimuth, elevation: view.pitch })}>放在画面中心</button>
        </div>
        {alignment.placing && <p className="alignment-hint" role="status">点击预览放下{name}的期望位置，Esc 取消。</p>}
        {alignment.placeError && <p className="field-error" role="status">{alignment.placeError}</p>}
        <div className="alignment-fields">
          {/* Before a mark exists the fields start from the frame centre. */}
          <NumberField label="方位" unit="°" min={0} max={359.999} step={0.01} value={round(target?.azimuth ?? view.azimuth)}
            onChange={(azimuth) => alignment.setTarget({ azimuth, elevation: target?.elevation ?? view.pitch })} />
          <NumberField label="视高度" unit="°" min={targetElevationRange[0]} max={targetElevationRange[1]} step={0.01}
            value={round(target?.elevation ?? view.pitch)}
            onChange={(elevation) => alignment.setTarget({ azimuth: target?.azimuth ?? view.azimuth, elevation })} />
        </div>
        {target && !inFrame && <p className="alignment-hint">
          期望位置在画面外。
          <button type="button" onClick={() => update({ azimuth: target.azimuth, pitch: target.elevation })}>朝向期望位置</button>
        </p>}
      </div>
      <div className="alignment-section alignment-conditions">
        <h3>条件</h3>
        <label className="field">
          <span className="field-label">起始日期</span>
          <input type="date" aria-label="推算起始日期" min="1900-01-01" max="2100-12-31" value={settings.start}
            onChange={(event) => event.target.value && change({ start: event.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">跨度</span>
          <select aria-label="推算跨度" value={settings.days} onChange={(event) => change({ days: Number(event.target.value) })}>
            {spanChoices.map((choice) => <option key={choice.days} value={choice.days}>{choice.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">容差</span>
          <select aria-label="对齐容差" value={settings.tolerance} onChange={(event) => change({ tolerance: Number(event.target.value) })}>
            {toleranceChoices.map((value) => <option key={value} value={value}>中心偏离 ≤ {value} 个{sizeWord(settings.body)}{isFixedBody(settings.body) ? `（${round(value * 2 * bodyRadius(settings.body))}°）` : ""}</option>)}
          </select>
        </label>
        {settings.body === "moon" && <>
          <div className="field alignment-phase" role="group" aria-label="月相（亮面比例）">
            <span className="field-label">月相（亮面）</span>
            <span>
              <select aria-label="亮面下限" value={settings.phase[0]}
                onChange={(event) => change({ phase: [Number(event.target.value), Math.max(Number(event.target.value), settings.phase[1])] })}>
                {percentChoices.map((value) => <option key={value} value={value}>{value}%</option>)}
              </select>
              —
              <select aria-label="亮面上限" value={settings.phase[1]}
                onChange={(event) => change({ phase: [Math.min(Number(event.target.value), settings.phase[0]), Number(event.target.value)] })}>
                {percentChoices.map((value) => <option key={value} value={value}>{value}%</option>)}
              </select>
            </span>
          </div>
        </>}
        {settings.body !== "sun" && <SkyChoices body={settings.body} sky={settings.sky} onChange={(sky) => change({ sky })} />}
      </div>
      <div className="alignment-section alignment-results" aria-label="推算结果">
        <h3>结果</h3>
        {summary}
        <CheckControls check={check} single={checkTargets(alignment, plan)[0]?.key} />
        {(list.length > 0 || alignment.canRestore) && <div className="alignment-actions">
          <button type="button" disabled={!previous} onClick={() => previous && alignment.tryOut(previous.instant)}>‹ 上一个</button>
          <button type="button" disabled={!next} onClick={() => next && alignment.tryOut(next.instant)}>下一个 ›</button>
          <button type="button" disabled={!alignment.canRestore} onClick={alignment.restore}>返回推算前</button>
        </div>}
        {current && occlusion && <p className="alignment-current" role="status">
          正在试看 {dateOf(current.instant, plan.timeZone).day} {clockOf(current.instant, plan.timeZone)} ·
          {" "}{occlusion.state === "画面内" ? occlusionText(occlusion.occlusion, plan) : occlusion.state}
        </p>}
        {[...months].map(([month, items]) => (
          <section key={month} className="alignment-month" aria-label={month}>
            <h4>{month}</h4>
            <ol>
              {items.map((found) => {
                const day = dateOf(found.instant, plan.timeZone);
                const ratio = found.separation / found.diameter;
                return (
                  <li key={found.instant} className={found === current ? "is-current" : undefined} data-alignment={found.instant}>
                    <span className="alignment-when">
                      <strong>{day.day} {clockOf(found.instant, plan.timeZone)}</strong>
                      <small>容差内 {clockOf(found.from, plan.timeZone)}–{clockOf(found.to, plan.timeZone)}</small>
                    </span>
                    <span className="alignment-facts">
                      {ratio < 0.02 ? "几乎居中" : `偏 ${round(ratio)} 个${sizeWord(settings.body)} · ${found.offset}`}
                      {" · "}{skyConditionNames[found.sky]}
                      {found.illuminated !== null && ` · 亮面 ${Math.round(found.illuminated * 100)}%`}
                    </span>
                    <button type="button" aria-label={`试看 ${day.day} ${clockOf(found.instant, plan.timeZone)}`}
                      aria-pressed={found === current} onClick={() => alignment.tryOut(found.instant)}>试看</button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
        <p className="alignment-note">
          时刻按所选时区（{plan.timeZone}）。期望位置是天空中的一个方向，按{plan.refraction === "standard" ? "标准折射" : "无折射"}换算；
          试看只改拍摄时刻并开启{name}图层，遮挡按当前 DEM，不代表实景一定可见。
        </p>
      </div>
      </>}
      <SolveExport alignment={alignment} plan={plan} saving={saving} />
    </section>
  );
}

/** 太阳 / 月亮 / 银心, or a named star or deep-sky target from the list. */
export function BodyPicker({ body, onChange }: { body: AlignmentBody; onChange: (body: AlignmentBody) => void }) {
  const choice = body === "sun" || body === "moon" || body === "galactic-center" ? body : "fixed";
  const stars = fixedBodies.filter((item) => item.kind === "star"), deepSky = fixedBodies.filter((item) => item.kind === "deepSky");
  return (
    <div className="alignment-section">
      <div className="alignment-bodies" role="radiogroup" aria-label="天体">
        {([["sun", "太阳"], ["moon", "月亮"], ["galactic-center", "银心"], ["fixed", "恒星与深空"]] as const).map(([value, label]) => (
          <label key={value}>
            <input type="radio" name="alignment-body" value={value} checked={choice === value}
              onChange={() => onChange(value === "fixed" ? stars[0].id : value)} />
            {label}
          </label>
        ))}
      </div>
      {choice === "fixed" && <label className="field">
        <span className="field-label">恒星或深空目标</span>
        <select aria-label="恒星或深空目标" value={body} onChange={(event) => onChange(event.target.value as AlignmentBody)}>
          <optgroup label="亮星">{stars.map((item) => <option key={item.id} value={item.id}>{item.name}{item.magnitude !== null ? ` · ${item.magnitude.toFixed(1)} 等` : ""}</option>)}</optgroup>
          <optgroup label="深空目标">{deepSky.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
        </select>
      </label>}
      {isFixedBody(body) && <p className="alignment-hint">
        {bodyName(body)}在星空中方向固定，期望位置按直径 {round(2 * bodyRadius(body))}° 的标记画出；只在太阳低于 −6° 时推算，试看时开启{bodyLayer(body) === "milkyWay" ? "银河" : bodyLayer(body) === "deepSky" ? "深空" : "星空"}图层。
      </p>}
    </div>
  );
}

/** The skies a result may fall in: all five for the Moon, twilight and night for a fixed body (the Sun at least 6° down). */
export function SkyChoices({ body, sky, onChange, label = "天空条件" }: { body: AlignmentBody; sky: readonly SkyCondition[]; onChange: (sky: SkyCondition[]) => void; label?: string }) {
  const choices = isFixedBody(body) ? skyConditions.filter((item) => item === "twilight" || item === "night") : skyConditions;
  return (
    <fieldset className="alignment-sky">
      <legend>{label}</legend>
      {choices.map((item) => (
        <label key={item}>
          <input type="checkbox" aria-label={`${label}：${skyConditionNames[item]}`} checked={sky.includes(item)}
            onChange={() => onChange(sky.includes(item) ? sky.filter((other) => other !== item) : skyConditions.filter((other) => other === item || sky.includes(other)))} />
          {skyConditionNames[item]}
        </label>
      ))}
    </fieldset>
  );
}
