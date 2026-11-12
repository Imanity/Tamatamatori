import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Temporal } from "@js-temporal/polyfill";
import {
  blockedMinutes,
  filterCandidates,
  MIN_SUBJECT,
  mergeCandidates,
  rangeCandidates,
  rangeDays,
  rangeDistances,
  solveRangeDay,
  rangeTrack,
  rangeCorridor,
  reachableSectors,
  spanChoices,
} from "../domain/range-alignment";
import type { RangeCandidate, RangeInput, RangePoint } from "../domain/range-alignment";
import { distanceChoices, pointPlan, positionProfile, restoredLayers, travel, triedLayers } from "../domain/position-alignment";
import type { TriedLayers } from "../domain/position-alignment";
import { bodyKind, bodyName, fixedPlace, isFixedBody } from "../domain/sky-targets";
import { bodyRadius } from "../domain/alignment";
import type { FramePoint } from "../domain/alignment";
import { SkyChoices } from "./Alignment";
import type { GroundSampler } from "../domain/position-alignment";
import { skyConditionNames, skyConditions } from "../domain/alignment";
import type { AlignmentBody, SkyCondition } from "../domain/alignment";
import { compassDirection, fieldOfView, frameAspectRatio, localDateTime, sensorKey } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { DEFAULT_TERRAIN_URL } from "../domain/terrain";
import type { ElevationTile } from "../domain/terrain";
import type { TimelineEvent } from "../domain/timeline";
import { occlusionText } from "../domain/visibility";
import type { Occlusion } from "../domain/visibility";
import { CoarseNote, FramingSection, frameWords, ProfileChart, TargetSection, tryingPoint } from "./PositionSearch";
import type { PositionSearch } from "./PositionSearch";
import { CheckControls, CheckTag } from "./Feasibility";
import type { Feasibility } from "./Feasibility";
import type { RangeDay, RangeMessage, RangeReply } from "../preview/range-worker";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;
const terrainUrl = import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
const clock = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(11, 16);
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const percent = (share: number) => `${Math.round(share * 100)}%`;
const degrees = Math.PI / 180;
const EARTH = 6_371_008.8;
const percentChoices = [0, 10, 25, 50, 75, 90, 100];

interface Run {
  id: number;
  key: string;
  phase: "planning" | "loading" | "solving" | "done" | "error";
  tiles: readonly [number, number];
  days: readonly [number, number];
  points: RangePoint[];
  sectors: [number, number][];
  input: RangeInput;
  near: number;
  far: number;
  message: string;
  sampler: GroundSampler | null;
  /** Whether the days were solved in the worker (shown in the details, checked in the browser). */
  worker: boolean;
}
interface Before {
  latitude: number;
  longitude: number;
  instant: string;
  azimuth: number;
  pitch: number;
  layers: TriedLayers;
}

const lensOf = (plan: ShootingPlan) => ({ focalLength: plan.focalLength, sensor: plan.sensor, customSensor: plan.customSensor, aspectRatio: plan.aspectRatio, orientation: plan.orientation });

/**
 * Runs a range search: the day plan (usable minutes, corridor), the terrain tiles,
 * then the days. A module worker does the heavy parts when the browser has one;
 * otherwise (or if the worker fails to start) the main thread does them day by day.
 */
async function runRange(input: RangeInput, days: RangeDay[], signal: AbortSignal, hooks: {
  loadTiles: (points: { latitude: number; longitude: number }[]) => Promise<GroundSampler & { tiles?: ReadonlyMap<string, ElevationTile>; bounds?: number[] }>;
  planned: (sectors: [number, number][]) => void;
  day: (index: number, points: RangePoint[]) => void;
  usingWorker: (worker: boolean) => void;
}) {
  const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));
  let worker: Worker | null = null;
  if (typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("../preview/range.worker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
  }
  if (worker) {
    const active = worker;
    const replies: RangeReply[] = [];
    let wake: (() => void) | null = null;
    let failure: string | null = null;
    active.onmessage = (event: MessageEvent<RangeReply>) => { replies.push(event.data); wake?.(); };
    active.onerror = (event) => { failure = event.message || "推算线程无法启动"; wake?.(); };
    signal.addEventListener("abort", () => { active.terminate(); wake?.(); }, { once: true });
    const next = async () => {
      while (!replies.length) {
        if (failure !== null) throw new Error(failure);
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
      const reply = replies.shift()!;
      if (reply.type === "error") throw new Error(reply.message);
      return reply;
    };
    try {
      active.postMessage({ type: "plan", id: 1, input, days, fixed: isFixedBody(input.body) ? fixedPlace(input.body) : null } satisfies RangeMessage);
      const plan = await next();
      if (plan.type !== "planned") throw new Error("推算线程回复异常");
      hooks.usingWorker(true);
      hooks.planned(plan.sectors);
      const sampler = await hooks.loadTiles(plan.corridor);
      if (sampler.tiles) {
        active.postMessage({ type: "solve", id: 1, tiles: [...sampler.tiles], bounds: sampler.bounds } satisfies RangeMessage);
        for (let reply = await next(); reply.type !== "done"; reply = await next())
          if (reply.type === "day") hooks.day(reply.index, reply.points);
        return sampler;
      }
      // A sampler without raw tiles (a test double) cannot travel to the worker.
      active.terminate();
      hooks.usingWorker(false);
      for (let index = 0; index < days.length; index++) {
        await yieldNow();
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        hooks.day(index, solveRangeDay(input, days[index], rangeTrack(input, days[index]), sampler));
      }
      return sampler;
    } finally {
      active.terminate();
    }
  }
  hooks.usingWorker(false);
  const tracks = [];
  for (let index = 0; index < days.length; index++) {
    if (index % 15 === 0) await yieldNow();
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    tracks.push(rangeTrack(input, days[index]));
  }
  hooks.planned(reachableSectors(tracks));
  const sampler = await hooks.loadTiles(rangeCorridor(input, tracks));
  for (let index = 0; index < days.length; index++) {
    await yieldNow();
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    hooks.day(index, solveRangeDay(input, days[index], tracks[index], sampler));
  }
  return sampler;
}

/**
 * "推算 · 两者都找": the ground target of "找机位" over a range of dates, with
 * the subject's size in the frame fixing the distances. Candidates are runs of
 * minutes on one day; a try-out moves the camera, instant and direction.
 */
export function useRangeSearch(plan: ShootingPlan, update: UpdatePlan, active: boolean, generation: number, body: AlignmentBody, position: PositionSearch) {
  const [share, setShare] = useState(0.3);
  const [span, setSpan] = useState<number>(30);
  const [start, setStart] = useState("");
  const [maxDistance, setMaxDistance] = useState<number>(30_000);
  const [phase, setPhase] = useState<readonly [number, number]>([0, 100]);
  const [sky, setSky] = useState<readonly SkyCondition[]>(skyConditions);
  const [run, setRun] = useState<Run | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [before, setBefore] = useState<Before | null>(null);
  const latest = useRef(plan);
  latest.current = plan;
  const token = useRef(0);
  const target = position.target;
  const sized = !!target && target.height >= MIN_SUBJECT;
  const key = target && start
    ? [body, target.latitude, target.longitude, target.height, sized ? share : "-", span, start, sized ? "-" : maxDistance, plan.focalLength, sensorKey(plan),
      plan.aspectRatio, plan.orientation, plan.cameraHeight, plan.refraction, plan.timeZone, terrainUrl, attempt].join("/")
    : "";

  useEffect(() => {
    if (active && !start) setStart(localDateTime(plan.instant, plan.timeZone).slice(0, 10));
    if (!active) setBefore(null);
  }, [active]);
  useEffect(() => setBefore(null), [generation]);

  useEffect(() => {
    if (!active || !key || !target) return;
    if (run?.key === key && run.phase === "done") return;
    const controller = new AbortController();
    const id = ++token.current;
    const set = (patch: Partial<Run> | ((state: Run) => Partial<Run>)) =>
      setRun((state) => (state && state.id === id ? { ...state, ...(typeof patch === "function" ? patch(state) : patch) } : state));
    const timer = setTimeout(async () => {
      const lens = lensOf(latest.current);
      const distances = rangeDistances(target, sized ? share : null, lens, sized ? 30_000 : maxDistance);
      const input: RangeInput = {
        body, target, refraction: latest.current.refraction, cameraHeight: latest.current.cameraHeight, lens,
        share: distances.share, minDistance: distances.minDistance, maxDistance: distances.maxDistance,
      };
      let days: RangeDay[];
      try {
        days = rangeDays(start, span, latest.current.timeZone);
      } catch {
        setRun({ id, key, phase: "error", tiles: [0, 0], days: [0, 0], points: [], sectors: [], input, near: distances.near, far: distances.far, message: "起始日期无效", sampler: null, worker: false });
        return;
      }
      setRun({ id, key, phase: "planning", tiles: [0, 0], days: [0, days.length], points: [], sectors: [], input, near: distances.near, far: distances.far, message: "", sampler: null, worker: false });
      const collected: RangePoint[] = [];
      try {
        const elevation = await import("../preview/elevation");
        const sampler = await runRange(input, days, controller.signal, {
          usingWorker: (worker) => set({ worker }),
          planned: (sectors) => set({ sectors, phase: "loading" }),
          loadTiles: async (points) => {
            const loaded = await elevation.elevationTiles(points, terrainUrl, controller.signal, (done, total) => set({ tiles: [done, total] }));
            set({ phase: "solving" });
            return loaded;
          },
          day: (index, points) => {
            collected.push(...points);
            set({ days: [index + 1, days.length] });
          },
        });
        if (controller.signal.aborted) return;
        set({ phase: "done", points: collected, sampler });
      } catch (error) {
        if (controller.signal.aborted) return;
        set({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, key]);

  const done = run?.key === key && run.phase === "done" ? run : null;
  // Separate roots on the same sight line are one place: merged before listing.
  const merging = useMemo(() => (done ? mergeCandidates(rangeCandidates(done.input, done.points)) : { candidates: [], merged: 0 }), [done]);
  const all = merging.candidates;
  const moon = body === "moon";
  // Phase for the Moon; skies for the Moon and fixed bodies (which are only solved in a dark sky).
  const { kept, filtered } = useMemo(() => filterCandidates(all, {
    ...(moon && (phase[0] > 0 || phase[1] < 100) ? { phase: [phase[0] / 100, phase[1] / 100] as const } : {}),
    ...(body !== "sun" && sky.length < skyConditions.length ? { sky } : {}),
  }, body), [all, moon, body, phase, sky]);
  const matches = tryingPoint(plan);
  const blocked = done ? blockedMinutes(done.points) : 0;
  const current = kept.find((candidate) => candidate.points.some(matches)) ?? null;
  const currentPoint = current?.points.find(matches) ?? null;

  const tryOut = (point: RangePoint) => {
    const now = latest.current;
    setBefore((kept) => kept ?? {
      latitude: now.latitude, longitude: now.longitude, instant: now.instant,
      azimuth: now.azimuth, pitch: now.pitch, layers: triedLayers(now.layers),
    });
    const patch = pointPlan(now.layers, point, body, { frame: position.frame, lens: now });
    latest.current = { ...now, ...patch };
    update(patch);
  };
  const restore = () => {
    if (!before) return;
    const now = latest.current;
    update({
      latitude: before.latitude, longitude: before.longitude, instant: before.instant, azimuth: before.azimuth, pitch: before.pitch,
      layers: restoredLayers(now.layers, before.layers),
    });
    setBefore(null);
  };

  const events = useMemo<TimelineEvent[]>(() => (active ? kept.flatMap((candidate) => {
    const describe = (point: RangePoint) => `机位距目标 ${km(point.distance)} km，${bodyName(body)}视高度 ${point.elevation.toFixed(2)}°${point.share === null ? "" : `，主体占画面 ${percent(point.share)}`}`;
    return [
      { key: `range-${candidate.key}-start`, kind: "alignment" as const, label: "对齐始", instant: iso(candidate.start), detail: `候选开始：${describe(candidate.points[0])}` },
      ...(candidate.end !== candidate.start ? [{ key: `range-${candidate.key}-end`, kind: "alignment" as const, label: "对齐终", instant: iso(candidate.end), detail: `候选结束：${describe(candidate.points.at(-1)!)}` }] : []),
    ];
  }) : []), [active, kept, body]);

  return {
    share, setShare, span, setSpan, start, setStart, maxDistance, setMaxDistance, phase, setPhase, sky, setSky,
    sized, run, key, done, all, kept, filtered, merged: merging.merged, blocked, current, currentPoint,
    retry: () => setAttempt((value) => value + 1), tryOut, restore, canRestore: !!before, events,
  };
}
export type RangeSearch = ReturnType<typeof useRangeSearch>;

const circle = (centre: { latitude: number; longitude: number }, radius: number) =>
  Array.from({ length: 73 }, (_, index) => {
    const point = travel(centre, (index * 5) % 360, radius);
    return [point.longitude, point.latitude];
  });

/** Target, band rings, reachable sectors and candidate segments (light to dark by date) for the map. */
export function rangeGeometry(search: RangeSearch | null, target: PositionSearch["target"], timeZone: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!search || !target) return { type: "FeatureCollection", features };
  features.push({ type: "Feature", properties: { kind: "target" }, geometry: { type: "Point", coordinates: [target.longitude, target.latitude] } });
  const run = search.run?.key === search.key ? search.run : null;
  if (!run) return { type: "FeatureCollection", features };
  for (const radius of search.sized ? [run.near, run.far] : [run.far])
    features.push({ type: "Feature", properties: { kind: "ring" }, geometry: { type: "LineString", coordinates: circle(target, radius) } });
  for (const [from, to] of run.sectors) {
    const steps = Math.max(2, Math.ceil(to - from));
    const arc = (radius: number) => Array.from({ length: steps + 1 }, (_, index) => {
      const point = travel(target, from + ((to - from) * index) / steps, radius);
      return [point.longitude, point.latitude];
    });
    const outer = arc(run.input.maxDistance), inner = arc(run.input.minDistance).reverse();
    features.push({ type: "Feature", properties: { kind: "sector" }, geometry: { type: "Polygon", coordinates: [[...outer, ...inner, outer[0]]] } });
  }
  const list = search.kept;
  list.forEach((candidate, index) => {
    const order = list.length > 1 ? index / (list.length - 1) : 0;
    const selected = candidate === search.current;
    const coordinates = candidate.points.map((point) => [point.longitude, point.latitude]);
    features.push(coordinates.length > 1
      ? { type: "Feature", properties: { kind: "segment", order, selected }, geometry: { type: "LineString", coordinates } }
      : { type: "Feature", properties: { kind: "segment-dot", order, selected }, geometry: { type: "Point", coordinates: coordinates[0] } });
    const day = Temporal.PlainDate.from(candidate.day);
    features.push({ type: "Feature", properties: { kind: "label", label: `${day.month}/${day.day} ${clock(candidate.middle.time, timeZone)}` },
      geometry: { type: "Point", coordinates: [candidate.middle.longitude, candidate.middle.latitude] } });
  });
  return { type: "FeatureCollection", features };
}

/** Frame, the body at its true size on the target's top at the chosen place, and the subject down to its share. */
function CompositionSketch({ plan, share, body, frame }: { plan: ShootingPlan; share: number; body: AlignmentBody; frame: FramePoint }) {
  const height = 100, width = height * frameAspectRatio(plan);
  const fov = fieldOfView(plan);
  const radius = Math.max(0.8, (height / 2) * (Math.tan(bodyRadius(body) * degrees) / Math.tan((fov.vertical / 2) * degrees)));
  const x = ((frame.x + 1) / 2) * width, y = ((frame.y + 1) / 2) * height;
  const bar = Math.max(0, Math.min(height - y, share * height));
  return (
    <svg className="composition-sketch" viewBox={`0 0 ${width.toFixed(1)} ${height}`} role="img"
      aria-label={`构图草图：目标顶部在${frameWords(frame)}，${bodyName(body)}按真实大小落在顶部，主体向下占画面高度 ${percent(share)}`}>
      <rect className="sketch-frame" x="0.5" y="0.5" width={width - 1} height={height - 1} />
      <path className="sketch-grid" d={`M${width / 3} 0V${height}M${(2 * width) / 3} 0V${height}M0 ${height / 3}H${width}M0 ${(2 * height) / 3}H${width}`} />
      <rect className="sketch-subject" x={x - 2} y={y} width="4" height={bar} />
      <circle className={`sketch-body sketch-${bodyKind(body)}`} cx={x} cy={y} r={radius} />
    </svg>
  );
}

function dateOf(time: number, timeZone: string) {
  const local = Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone);
  return { month: `${local.year} 年 ${local.month} 月`, day: `${local.month}/${local.day} ${weekdays[local.dayOfWeek - 1]}` };
}

/** The "两者都找" part of the 推算 panel. */
export function RangePanel({ search, position, plan, body, occlusion, check, onFrame }: {
  search: RangeSearch;
  position: PositionSearch;
  plan: ShootingPlan;
  check?: Feasibility;
  body: AlignmentBody;
  occlusion: { state: string; occlusion: Occlusion } | null;
  onFrame: (frame: FramePoint) => void;
}) {
  const { run, done, kept, current, currentPoint } = search;
  const name = bodyName(body);
  const target = position.target;
  const lens = lensOf(plan);
  const preview = target && search.sized ? rangeDistances(target, search.share, lens, 30_000) : null;
  // Body elevation needed at the band's edges, for a camera at the target's ground level.
  const needed = (distance: number) => target ? (Math.atan((target.height - plan.cameraHeight) / distance) - distance / (2 * EARTH)) / degrees : 0;
  const profile = useMemo(() => {
    if (!target || !run?.sampler || !currentPoint) return null;
    try {
      return positionProfile({ target, cameraHeight: plan.cameraHeight }, currentPoint, run.sampler);
    } catch {
      return null;
    }
  }, [target, run?.sampler, currentPoint, plan.cameraHeight]);
  const ground = target && run?.sampler ? run.sampler(target.latitude, target.longitude) : null;
  const spanLabel = (days: number) => (days === 365 ? "12 个月" : `${days} 天`);
  let summary: ReactNode = null;
  if (!target) summary = <p className="alignment-hint">先在地图上点选目标，或选择已接入地标。</p>;
  else if (!run || run.key !== search.key || run.phase === "planning") summary = <p className="alignment-status" role="status">规划中…</p>;
  else if (run.phase === "loading") summary = <p className="alignment-status" role="status">读取地形{run.tiles[1] ? ` ${run.tiles[0]}/${run.tiles[1]} 块` : "中"}…</p>;
  else if (run.phase === "solving") summary = <p className="alignment-status" role="status">推算中 · {run.days[0]}/{run.days[1]} 天</p>;
  else if (run.phase === "error")
    summary = <div className="alignment-status is-error" role="status">
      <p>推算失败：{run.message}</p>
      <button type="button" onClick={search.retry}>重试</button>
    </div>;
  else if (done) {
    const total = search.filtered.phase + search.filtered.sky;
    const reasons = [search.filtered.phase && `月相 ${search.filtered.phase}`, search.filtered.sky && `天空条件 ${search.filtered.sky}`].filter(Boolean).join("、");
    const hidden = search.blocked > 0 ? `；另有 ${search.blocked} 分钟视线被地形挡住，未列出` : "";
    summary = kept.length
      ? <p className="alignment-status" role="status">{spanLabel(search.span)}内 {kept.length} 个候选{total > 0 && `；另有 ${total} 个被筛掉（${reasons}）`}{search.merged > 0 && `；${search.merged} 个几乎重合的已合并`}{hidden}</p>
      : <p className="alignment-status is-empty" role="status">
        {!done.sectors.length ? `${spanLabel(search.span)}内${name}达不到所需的高度。`
          : total > 0 ? `有 ${total} 个候选，但都不满足所选条件（${reasons}）。`
            : search.blocked > 0 ? `有 ${search.blocked} 分钟${name}正好落在目标上，但视线都被地形挡住。可以换日期、调整主体大小或提高离地高度。`
              : `${spanLabel(search.span)}内在 ${km(done.near)}—${km(done.far)} km 没有${search.sized ? "主体大小合适的" : ""}解。`}
      </p>;
  }
  const months = new Map<string, RangeCandidate[]>();
  for (const candidate of kept) {
    const month = dateOf(candidate.start, plan.timeZone).month;
    months.set(month, [...(months.get(month) ?? []), candidate]);
  }
  const index = current && currentPoint ? current.points.indexOf(currentPoint) : -1;
  const describe = (point: RangePoint) => `${clock(point.time, plan.timeZone)} · 距目标 ${km(point.distance)} km${point.share === null ? "" : ` · 主体 ${percent(point.share)}`}`;
  return (
    <>
      <TargetSection search={position} ground={ground} />
      <FramingSection frame={position.frame} onFrame={onFrame} name={name}
        overflow={!!target && search.sized && position.frame.y + 2 * search.share > 1.001} />
      <div className="alignment-section alignment-conditions">
        <h3>构图与日期</h3>
        {target && search.sized && preview ? <>
          <label className="field alignment-scrub">
            <span className="field-label">主体占画面高度 {percent(search.share)}</span>
            <input type="range" min={5} max={50} step={1} value={Math.round(search.share * 100)} aria-label="主体占画面高度"
              aria-valuetext={percent(search.share)} onChange={(event) => search.setShare(Number(event.target.value) / 100)} />
          </label>
          <CompositionSketch plan={plan} share={search.share} body={body} frame={position.frame} />
          <p className="alignment-hint">
            {`${plan.focalLength} mm 下主体视高度约 ${preview.angle?.toFixed(2)}°，距目标约 ${km(preview.near)}—${km(preview.far)} km（占比 ±20%），`
              + `所需${name}视高度约 ${needed(preview.far).toFixed(1)}°—${needed(preview.near).toFixed(1)}°。`
              + (preview.far >= 30_000 ? "超过 30 km 的部分不推算。" : "")}
          </p>
        </> : target ? <label className="field">
          <span className="field-label">最远距离（目标不足 {MIN_SUBJECT} m，按距离推算）</span>
          <select aria-label="机位最远距离" value={search.maxDistance} onChange={(event) => search.setMaxDistance(Number(event.target.value))}>
            {distanceChoices.map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label> : null}
        <label className="field">
          <span className="field-label">起始日期</span>
          <input type="date" aria-label="两者都找起始日期" min="1900-01-01" max="2100-12-31" value={search.start}
            onChange={(event) => event.target.value && search.setStart(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">跨度</span>
          <select aria-label="两者都找跨度" value={search.span} onChange={(event) => search.setSpan(Number(event.target.value))}>
            {spanChoices.map((days) => <option key={days} value={days}>{spanLabel(days)}</option>)}
          </select>
        </label>
        {body === "moon" && <>
          <div className="field alignment-phase" role="group" aria-label="候选月相（亮面比例）">
            <span className="field-label">月相（亮面）</span>
            <span>
              <select aria-label="候选亮面下限" value={search.phase[0]} onChange={(event) => search.setPhase([Number(event.target.value), Math.max(Number(event.target.value), search.phase[1])])}>
                {percentChoices.map((value) => <option key={value} value={value}>{value}%</option>)}
              </select>
              —
              <select aria-label="候选亮面上限" value={search.phase[1]} onChange={(event) => search.setPhase([Math.min(Number(event.target.value), search.phase[0]), Number(event.target.value)])}>
                {percentChoices.map((value) => <option key={value} value={value}>{value}%</option>)}
              </select>
            </span>
          </div>
        </>}
        {body !== "sun" && <SkyChoices body={body} sky={search.sky} onChange={search.setSky} label="候选天空条件" />}
      </div>
      <div className="alignment-section alignment-results" aria-label="推算结果">
        <h3>候选</h3>
        {summary}
        {target && <CoarseNote sampler={run?.key === search.key ? run.sampler : null} latitude={target.latitude} />}
        {check && kept.length > 0 && <CheckControls check={check} />}
        {current && currentPoint && <>
          <p className="alignment-current" role="status">
            正在试看 {dateOf(currentPoint.time, plan.timeZone).day} {describe(currentPoint)} · 目标在{compassDirection(currentPoint.azimuth)}
            {occlusion && ` · ${name}${occlusion.state === "画面内" ? occlusionText(occlusion.occlusion, plan) : occlusion.state}`}
          </p>
          {current.points.length > 1 && <label className="field alignment-scrub">
            <span className="field-label">在该候选内移动（机位与时刻一起）</span>
            <input type="range" min={0} max={current.points.length - 1} step={1} value={Math.max(0, index)} aria-label="在候选内移动机位与时刻"
              aria-valuetext={describe(current.points[Math.max(0, index)])} onChange={(event) => search.tryOut(current.points[Number(event.target.value)])} />
          </label>}
          {profile && <ProfileChart profile={profile} />}
        </>}
        {(current || search.canRestore) && <div className="alignment-actions">
          <button type="button" disabled={!search.canRestore} onClick={search.restore}>返回推算前</button>
        </div>}
        {[...months].map(([month, items]) => (
          <section key={month} className="alignment-month" aria-label={month}>
            <h4>{month}</h4>
            <ol>
              {items.map((candidate) => {
                const day = dateOf(candidate.start, plan.timeZone).day;
                return (
                  <li key={candidate.key} className={candidate === current ? "is-current" : undefined} data-candidate={candidate.key}>
                    <span className="alignment-when">
                      <strong>{day} {clock(candidate.start, plan.timeZone)}–{clock(candidate.end, plan.timeZone)}</strong>
                      <small>距目标 {km(candidate.near)}—{km(candidate.far)} km · 目标在{compassDirection(candidate.middle.azimuth)}{candidate.share && ` · 主体 ${percent(candidate.share[0])}—${percent(candidate.share[1])}`}</small>
                      <CheckTag check={check?.result(candidate.key) ?? null} />
                    </span>
                    <span className="alignment-facts">
                      {skyConditionNames[candidate.sky]}{candidate.illuminated !== null && ` · 亮面 ${Math.round(candidate.illuminated * 100)}%`}
                      {candidate.clear < 1 && " · 部分地形数据不全"}
                    </span>
                    <button type="button" aria-label={`试看 ${day} ${clock(candidate.middle.time, plan.timeZone)}`} aria-pressed={candidate === current}
                      onClick={() => search.tryOut(candidate.middle)}>试看</button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
        <p className="alignment-note">
          每天按所选时区 0—24 时逐分钟推算，机位在距目标 {run ? `${km(run.input.minDistance)}—${km(run.input.maxDistance)}` : "—"} km 内搜索，主体大小按实际地形重算后保留 ±20%。
          {run?.worker ? " 在后台线程计算。" : ""} 视线被地形挡住的分钟不列出；遮挡只看地形，不含建筑、树木与天气。试看时目标按“画面位置”摆放，焦距不变。
        </p>
      </div>
    </>
  );
}
