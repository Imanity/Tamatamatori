import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { landmarks } from "../domain/landmarks";
import {
  bodyTrack,
  corridor,
  distanceChoices,
  finishPositions,
  MIN_DISTANCE,
  positionProfile,
  solvePositions,
} from "../domain/position-alignment";
import type { GroundSampler, GroundTarget, PositionInput, PositionPoint, PositionResult, PositionSlice } from "../domain/position-alignment";
import type { AlignmentBody } from "../domain/alignment";
import { compassDirection, localDateTime, normalizeLongitude } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { timelineMode, timelineWindow } from "../domain/timeline";
import type { TimelineEvent } from "../domain/timeline";
import { DEFAULT_TERRAIN_URL } from "../domain/terrain";
import { occlusionText } from "../domain/visibility";
import type { Occlusion } from "../domain/visibility";
import { NumberField } from "./NumberField";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;
const terrainUrl = import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
const names: Record<AlignmentBody, string> = { sun: "太阳", moon: "月亮" };
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
const clock = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(11, 16);
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const sightNames = { clear: "通视", blocked: "被 DEM 挡住", unknown: "高程不全" } as const;
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
// Whole metres without a "-0" for ground just below the datum.
const metres = (value: number) => `${Math.round(value) || 0} m`;

export type PlacedTarget = GroundTarget & { id?: string };

interface Run {
  id: number;
  key: string;
  phase: "loading" | "solving" | "done" | "error";
  tiles: readonly [number, number];
  progress: number;
  result: PositionResult | null;
  message: string;
  sampler: GroundSampler | null;
}
/** Fields a try-out changes, kept from before the first one for "返回推算前". */
interface Before {
  latitude: number;
  longitude: number;
  instant: string;
  azimuth: number;
  pitch: number;
  sun: boolean;
  moon: boolean;
}

/**
 * "推算 · 找机位": a ground target and the timeline's span. The DEM tiles under
 * the alignment lines are read first, then the minutes are solved in slices.
 * Moving the camera along the line (try-out or the slider) does not search
 * again; the target, body, distance, span, camera height or refraction do.
 */
export function usePositionSearch(plan: ShootingPlan, update: UpdatePlan, active: boolean, generation: number, body: AlignmentBody) {
  const [target, setTarget] = useState<PlacedTarget | null>(null);
  const [maxDistance, setMaxDistance] = useState<number>(30_000);
  const [placing, setPlacing] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [before, setBefore] = useState<Before | null>(null);
  const latest = useRef(plan);
  latest.current = plan;
  const token = useRef(0);
  const span = timelineWindow(plan.instant, plan.timeZone, timelineMode(plan.layers));
  const key = target
    ? [body, target.latitude, target.longitude, target.height, maxDistance, span.start, span.end, plan.cameraHeight, plan.refraction, terrainUrl, attempt].join("/")
    : "";

  useEffect(() => {
    if (!active) {
      setPlacing(false);
      setBefore(null);
    }
  }, [active]);
  useEffect(() => setBefore(null), [generation]);
  useEffect(() => {
    if (!placing) return;
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setPlacing(false);
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [placing]);

  useEffect(() => {
    if (!active || !target) return;
    if (run?.key === key && run.phase === "done") return;
    const controller = new AbortController();
    const id = ++token.current;
    const input: PositionInput = {
      body, target, start: Date.parse(span.start), end: Date.parse(span.end),
      refraction: plan.refraction, cameraHeight: plan.cameraHeight, maxDistance,
    };
    const set = (patch: Partial<Run>) => setRun((state) => (state && state.id === id ? { ...state, ...patch } : state));
    const timer = setTimeout(async () => {
      setRun({ id, key, phase: "loading", tiles: [0, 0], progress: 0, result: null, message: "", sampler: null });
      try {
        const track = bodyTrack(input);
        const elevation = await import("../preview/elevation");
        const sampler = await elevation.elevationTiles(corridor(input, track), terrainUrl, controller.signal, (done, total) => set({ tiles: [done, total] }));
        if (controller.signal.aborted) return;
        set({ phase: "solving", sampler });
        const slices: PositionSlice[] = [];
        for (let index = 0; index < track.length; index += 60) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (controller.signal.aborted) return;
          slices.push(solvePositions(input, track.slice(index, index + 60), sampler));
          set({ progress: Math.min(1, (index + 60) / track.length) });
        }
        set({ phase: "done", progress: 1, result: finishPositions(track, slices, sampler(target.latitude, target.longitude)) });
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

  const result = run?.key === key && run.phase === "done" ? run.result : null;
  const points = result?.points ?? [];
  const current = points.find((point) => iso(point.time) === plan.instant &&
    Math.abs(point.latitude - plan.latitude) < 1e-6 && Math.abs(point.longitude - plan.longitude) < 1e-6) ?? null;

  const tryOut = (point: PositionPoint) => {
    const now = latest.current;
    setBefore((kept) => kept ?? {
      latitude: now.latitude, longitude: now.longitude, instant: now.instant,
      azimuth: now.azimuth, pitch: now.pitch, sun: now.layers.sun, moon: now.layers.moon,
    });
    // Rounded for the input fields: 1e-6° is about 0.1 m, 1e-4° under 1 cm at 5 km.
    const patch = {
      latitude: round(point.latitude, 6), longitude: round(point.longitude, 6), instant: iso(point.time),
      azimuth: round(point.azimuth, 4), pitch: round(point.elevation, 4), layers: { ...now.layers, [body]: true },
    };
    latest.current = { ...now, ...patch };
    update(patch);
  };
  const restore = () => {
    if (!before) return;
    const now = latest.current;
    update({
      latitude: before.latitude, longitude: before.longitude, instant: before.instant,
      azimuth: before.azimuth, pitch: before.pitch,
      layers: {
        ...now.layers, sun: before.sun, moon: before.moon,
        sunPath: before.sun && !!now.layers.sunPath, moonPath: before.moon && !!now.layers.moonPath,
      },
    });
    setBefore(null);
  };

  const events = useMemo<TimelineEvent[]>(() => {
    if (!active || !result) return [];
    const found: TimelineEvent[] = [];
    const branches = new Map<number, PositionPoint[]>();
    for (const point of result.points) branches.set(point.branch, [...(branches.get(point.branch) ?? []), point]);
    for (const [branch, run] of branches) {
      const first = run[0], last = run.at(-1)!;
      const describe = (point: PositionPoint) => `机位距目标 ${km(point.distance)} km，${names[body]}视高度 ${point.elevation.toFixed(2)}°`;
      found.push({ key: `position-${branch}-start`, kind: "alignment", label: "对齐始", instant: iso(first.time), detail: `对齐线开始：${describe(first)}` });
      if (last !== first) found.push({ key: `position-${branch}-end`, kind: "alignment", label: "对齐终", instant: iso(last.time), detail: `对齐线结束：${describe(last)}` });
    }
    return found;
  }, [active, result, body]);

  return {
    target, setTarget, maxDistance, setMaxDistance, placing, setPlacing,
    placeTarget: (longitude: number, latitude: number) => {
      setTarget({ latitude, longitude: normalizeLongitude(longitude), height: 0, name: "地图上的目标" });
      setPlacing(false);
    },
    run, result, points, current, span, key,
    retry: () => setAttempt((value) => value + 1),
    tryOut, restore, canRestore: !!before, events,
  };
}
export type PositionSearch = ReturnType<typeof usePositionSearch>;

/** Target, alignment line by sight and every-10-minute labels for the map. */
export function positionGeometry(search: PositionSearch | null, timeZone: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!search?.target) return { type: "FeatureCollection", features };
  features.push({ type: "Feature", properties: { kind: "target" }, geometry: { type: "Point", coordinates: [search.target.longitude, search.target.latitude] } });
  const branches = new Map<number, PositionPoint[]>();
  for (const point of search.points) branches.set(point.branch, [...(branches.get(point.branch) ?? []), point]);
  for (const run of branches.values()) {
    let line: PositionPoint[] = [];
    const flush = () => {
      if (line.length >= 2)
        features.push({ type: "Feature", properties: { kind: "line", sight: line.at(-1)!.sight }, geometry: { type: "LineString", coordinates: line.map((p) => [p.longitude, p.latitude]) } });
      else if (line.length === 1)
        features.push({ type: "Feature", properties: { kind: "dot", sight: line[0].sight }, geometry: { type: "Point", coordinates: [line[0].longitude, line[0].latitude] } });
    };
    for (const point of run) {
      const last = line.at(-1);
      if (last && (point.time - last.time > 60_000 || point.sight !== last.sight)) {
        // A change of sight starts the next piece at the shared point, so the line stays joined.
        const joined = point.time - last.time <= 60_000;
        flush();
        line = joined ? [last, point] : [point];
        if (joined) line[0] = { ...last, sight: point.sight };
      } else line.push(point);
    }
    flush();
    for (const point of run) {
      const label = clock(point.time, timeZone);
      if (label.endsWith("0"))
        features.push({ type: "Feature", properties: { kind: "label", label }, geometry: { type: "Point", coordinates: [point.longitude, point.latitude] } });
    }
  }
  return { type: "FeatureCollection", features };
}

function ProfileChart({ profile }: { profile: NonNullable<ReturnType<typeof positionProfile>> }) {
  const samples = profile.profile;
  const heights = samples.flatMap((sample) => (sample.ground === null ? [sample.sight] : [sample.sight, sample.ground]));
  const low = Math.min(...heights), high = Math.max(...heights), range = Math.max(1, high - low);
  const x = (distance: number) => 6 + (distance / profile.length) * 248;
  const y = (height: number) => 92 - ((height - low) / range) * 80;
  const ground = samples.filter((sample) => sample.ground !== null);
  const area = `M${x(ground[0]?.distance ?? 0)},96 ${ground.map((sample) => `L${x(sample.distance).toFixed(1)},${y(sample.ground!).toFixed(1)}`).join(" ")} L${x(ground.at(-1)?.distance ?? 0)},96Z`;
  const sight = samples.map((sample, index) => `${index ? "L" : "M"}${x(sample.distance).toFixed(1)},${y(sample.sight).toFixed(1)}`).join(" ");
  const blocked = samples.filter((sample) => sample.ground !== null && sample.ground > sample.sight + 0.5 && sample.distance >= 20 && profile.length - sample.distance >= 50);
  return (
    <figure className="position-profile">
      <svg viewBox="0 0 260 100" role="img"
        aria-label={`从机位到目标顶部的剖面，全长 ${km(profile.length)} km：${profile.sight === "blocked" ? `距机位 ${km(profile.blockedAt ?? 0)} km 处被地形挡住` : profile.sight === "clear" ? "按 DEM 通视" : "部分高程缺失"}`}>
        <path className="profile-ground" d={area} />
        <path className="profile-sight" d={sight} />
        {blocked.map((sample) => <circle key={sample.distance} className="profile-blocked" cx={x(sample.distance)} cy={y(sample.ground!)} r="1.6" />)}
        <circle className="profile-end" cx={x(0)} cy={y(samples[0].sight)} r="2.4" />
        <circle className="profile-end" cx={x(profile.length)} cy={y(samples.at(-1)!.sight)} r="2.4" />
      </svg>
      <figcaption>机位 → 目标顶部 · {km(profile.length)} km · 视线{profile.sight === "blocked" ? `在 ${km(profile.blockedAt ?? 0)} km 处被挡` : profile.sight === "clear" ? "未被 DEM 挡住" : "经过无高程区域"}（地面按 DEM，不含建筑与树木）</figcaption>
    </figure>
  );
}

/** The "找机位" part of the 推算 panel. */
export function PositionPanel({ search, plan, body, occlusion }: {
  search: PositionSearch;
  plan: ShootingPlan;
  body: AlignmentBody;
  occlusion: { state: string; occlusion: Occlusion } | null;
}) {
  const { target, run, result, points, current } = search;
  const name = names[body];
  const profile = useMemo(() => {
    if (!target || !run?.sampler) return null;
    try {
      return positionProfile({ target, cameraHeight: plan.cameraHeight }, plan, run.sampler);
    } catch {
      return null;
    }
  }, [target, run?.sampler, plan.latitude, plan.longitude, plan.cameraHeight]);
  const index = current ? points.indexOf(current) : -1;
  const listed = points.filter((point) => clock(point.time, plan.timeZone).endsWith("0"));
  let summary: ReactNode = null;
  if (!target) summary = <p className="alignment-hint">先在地图上放置目标，或选择已接入地标。</p>;
  else if (!run || run.key !== search.key || run.phase === "loading")
    summary = <p className="alignment-status" role="status">读取高程{run && run.key === search.key && run.tiles[1] ? ` ${run.tiles[0]}/${run.tiles[1]} 块` : "中"}…</p>;
  else if (run.phase === "solving") summary = <p className="alignment-status" role="status">推算中 · {Math.round(run.progress * 100)}%</p>;
  else if (run.phase === "error")
    summary = <div className="alignment-status is-error" role="status">
      <p>推算失败：{run.message}</p>
      <button type="button" onClick={search.retry}>重试</button>
    </div>;
  else if (result) {
    if (points.length) {
      const near = Math.min(...points.map((point) => point.distance)), far = Math.max(...points.map((point) => point.distance));
      summary = <p className="alignment-status" role="status">
        对齐线 {result.minutes} 分钟 · 距目标 {km(near)}—{km(far)} km
        {result.blocked > 0 && `；${result.blocked} 分钟被 DEM 挡住`}
        {result.unknown > 0 && `；${result.unknown} 分钟高程不全`}
      </p>;
    } else
      summary = <p className="alignment-status is-empty" role="status">
        {result.reason === "no-ground" ? "目标处没有高程数据，无法推算。"
          : result.reason === "below" ? `时段内${name}都在地平线下（按海平面地平）。`
            : `在 ${km(MIN_DISTANCE)}—${km(search.maxDistance)} km 内，目标顶部的仰角为 ${result.angles?.min.toFixed(1)}°—${result.angles?.max.toFixed(1)}°，${name}视高度为 ${result.sky?.min.toFixed(1)}°—${result.sky?.max.toFixed(1)}°，两者没有交点。`}
      </p>;
  }
  const describe = (point: PositionPoint) =>
    `${clock(point.time, plan.timeZone)} · 距目标 ${km(point.distance)} km（目标在${compassDirection(point.azimuth)}）`;
  return (
    <>
      <div className="alignment-section">
        <h3>地面目标</h3>
        <div className="alignment-actions">
          <button type="button" aria-pressed={search.placing} className={search.placing ? "is-active" : ""} onClick={() => search.setPlacing(!search.placing)}>
            {search.placing ? "取消放置" : "在地图上放置目标"}
          </button>
          <select aria-label="选择地标" value={target?.id ?? ""} onChange={(event) => {
            const landmark = landmarks.find((entry) => entry.id === event.target.value);
            if (landmark) search.setTarget({ id: landmark.id, name: landmark.name, latitude: landmark.latitude, longitude: landmark.longitude, height: landmark.bounds.height });
          }}>
            <option value="">选择已接入地标…</option>
            {landmarks.map((landmark) => <option key={landmark.id} value={landmark.id}>{landmark.name}</option>)}
          </select>
        </div>
        {search.placing && <p className="alignment-hint" role="status">在地图上单击放置目标，Esc 取消。</p>}
        {target && <>
          <p className="alignment-target">
            <strong>{target.name}</strong>
            <small>{target.latitude.toFixed(5)}, {target.longitude.toFixed(5)}
              {result?.targetGround != null && ` · 地面 ≈ ${result.targetGround.toFixed(1)} m（DEM）`}</small>
          </p>
          <NumberField label="目标高出地面" unit="m" min={0} max={1000} step={0.1} value={target.height}
            onChange={(height) => search.setTarget({ ...target, height })} />
        </>}
      </div>
      <div className="alignment-section alignment-conditions">
        <h3>条件</h3>
        <p className="alignment-hint">
          时段为时间轴当前范围：{localDateTime(search.span.start, plan.timeZone).replace("T", " ")} 起 24 小时（{plan.timeZone}）。换日期用时间轴的前一天、后一天。
        </p>
        <label className="field">
          <span className="field-label">最远距离</span>
          <select aria-label="机位最远距离" value={search.maxDistance} onChange={(event) => search.setMaxDistance(Number(event.target.value))}>
            {distanceChoices.map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label>
      </div>
      <div className="alignment-section alignment-results" aria-label="推算结果">
        <h3>结果</h3>
        {summary}
        {points.length > 0 && <>
          <label className="field alignment-scrub">
            <span className="field-label">沿对齐线（机位与时刻一起移动）</span>
            <input type="range" min={0} max={points.length - 1} step={1} value={Math.max(0, index)}
              aria-label="沿对齐线移动机位与时刻"
              aria-valuetext={describe(points[Math.max(0, index)])}
              onChange={(event) => search.tryOut(points[Number(event.target.value)])} />
            <small>{current ? describe(current) : "拖动滑杆把机位放到对齐线上"}</small>
          </label>
          <div className="alignment-actions">
            <button type="button" disabled={!search.canRestore} onClick={search.restore}>返回推算前</button>
          </div>
          {current && <p className="alignment-current" role="status">
            正在试看 {describe(current)} · {sightNames[current.sight]}
            {occlusion && ` · ${name}${occlusion.state === "画面内" ? occlusionText(occlusion.occlusion, plan) : occlusion.state}`}
          </p>}
          {profile && <ProfileChart profile={profile} />}
          <ol className="position-list">
            {listed.map((point) => (
              <li key={`${point.time}-${point.branch}`} className={point === current ? "is-current" : undefined} data-position={iso(point.time)}>
                <span className="alignment-when">
                  <strong>{clock(point.time, plan.timeZone)} · {km(point.distance)} km</strong>
                  <small>目标在{compassDirection(point.azimuth)} · {name}高 {point.elevation.toFixed(1)}° · 机位地面 {metres(point.cameraGround)}</small>
                </span>
                <span className={`alignment-facts sight-${point.sight}`}>{sightNames[point.sight]}</span>
                <button type="button" aria-label={`试看 ${clock(point.time, plan.timeZone)} 距目标 ${km(point.distance)} km`}
                  aria-pressed={point === current} onClick={() => search.tryOut(point)}>试看</button>
              </li>
            ))}
          </ol>
        </>}
        <p className="alignment-note">
          机位在目标的反方位线上，眼点为 DEM 地面加离地高度 {plan.cameraHeight} m；按{plan.refraction === "standard" ? "标准折射" : "无折射"}与海平面地平计算{name}位置，地形视线为椭球几何直线。
          通视只检查机位到目标之间的 DEM 地面，不含建筑、树木与目标后方地形；高程基准未核定，不代表实景一定可见。
        </p>
      </div>
    </>
  );
}
