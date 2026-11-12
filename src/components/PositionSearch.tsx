import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { landmarks } from "../domain/landmarks";
import {
  bodyTrack,
  corridor,
  distanceChoices,
  finishPositions,
  MIN_DISTANCE,
  pointPlan,
  positionProfile,
  restoredLayers,
  triedLayers,
  solvePositions,
} from "../domain/position-alignment";
import type { GroundSampler, GroundTarget, PositionInput, PositionPoint, PositionResult, PositionSlice, TriedLayers } from "../domain/position-alignment";
import { blockedMinutes, mergeCandidates, rangeCandidates } from "../domain/range-alignment";
import type { Candidate } from "../domain/range-alignment";
import { bodyName } from "../domain/sky-targets";
import { FRAME_CENTRE, skyConditionNames } from "../domain/alignment";
import type { AlignmentBody, FramePoint } from "../domain/alignment";
import { compassDirection, localDateTime, normalizeLongitude } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { timelineMode, timelineWindow } from "../domain/timeline";
import type { TimelineEvent } from "../domain/timeline";
import { DEFAULT_TERRAIN_URL, TERRAIN_ZOOM, tilePixel } from "../domain/terrain";
import { occlusionText } from "../domain/visibility";
import type { Occlusion } from "../domain/visibility";
import { NumberField } from "./NumberField";
import { CheckControls, CheckTag } from "./Feasibility";
import type { Feasibility } from "./Feasibility";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;
const terrainUrl = import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
const clock = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(11, 16);
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const percent = (share: number) => `${Math.round(share * 100)}%`;
// Whole metres without a "-0" for ground just below the datum.
const metres = (value: number) => `${Math.round(value) || 0} m`;

export type PlacedTarget = GroundTarget & { id?: string };
/** Ground sampler of a search, with the zoom its tiles were read at (coarser for a wide search). */
export type LoadedSampler = GroundSampler & { zoom?: number };
export type PositionCandidate = Candidate<PositionPoint>;

/** The 找机位 rows of the report: every ten minutes of local time of the listed stretches. */
export function listedPoints(points: readonly PositionPoint[], timeZone: string) {
  return points.filter((point) => clock(point.time, timeZone).endsWith("0"));
}

interface Run {
  id: number;
  key: string;
  phase: "loading" | "solving" | "done" | "error";
  tiles: readonly [number, number];
  progress: number;
  result: PositionResult | null;
  message: string;
  sampler: LoadedSampler | null;
}
/** Fields a try-out changes, kept from before the first one for "返回推算前". */
interface Before {
  latitude: number;
  longitude: number;
  instant: string;
  azimuth: number;
  pitch: number;
  layers: TriedLayers;
}

/** "Same place and minute" for telling which listed point the plan is trying out. */
export const tryingPoint = (plan: Pick<ShootingPlan, "instant" | "latitude" | "longitude">) => (point: Pick<PositionPoint, "time" | "latitude" | "longitude">) =>
  iso(point.time) === plan.instant && Math.abs(point.latitude - plan.latitude) < 1e-6 && Math.abs(point.longitude - plan.longitude) < 1e-6;

/**
 * "推算 · 找机位": a ground target and the timeline's span. The terrain tiles
 * under the alignment lines are read first, then the minutes are solved in
 * slices. The results are stretches of the lines whose sight the terrain does
 * not cut; a try-out puts the target at the chosen place in the frame.
 * Moving along a stretch or moving the framing does not search again; the
 * target, body, distance, span, camera height or refraction do.
 */
export function usePositionSearch(plan: ShootingPlan, update: UpdatePlan, active: boolean, generation: number, body: AlignmentBody) {
  const [target, setTarget] = useState<PlacedTarget | null>(null);
  const [maxDistance, setMaxDistance] = useState<number>(30_000);
  const [placing, setPlacing] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [before, setBefore] = useState<Before | null>(null);
  // Where the target's top sits in the frame; shared with 两者都找.
  const [frame, setFrame] = useState<FramePoint>(FRAME_CENTRE);
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
  // Stretches whose sight the terrain does not cut; nearly coincident ones once.
  const candidates = useMemo<PositionCandidate[]>(
    () => (result && target ? mergeCandidates(rangeCandidates({ body, target }, result.points, { splitSky: true })).candidates : []),
    [result, body],
  );
  const points = useMemo(() => candidates.flatMap((candidate) => candidate.points).sort((a, b) => a.time - b.time), [candidates]);
  const blocked = result ? blockedMinutes(result.points) : 0;
  const matches = tryingPoint(plan);
  const current = candidates.find((candidate) => candidate.points.some(matches)) ?? null;
  const currentPoint = current?.points.find(matches) ?? null;

  const tryOut = (point: PositionPoint) => {
    const now = latest.current;
    setBefore((kept) => kept ?? {
      latitude: now.latitude, longitude: now.longitude, instant: now.instant,
      azimuth: now.azimuth, pitch: now.pitch, layers: triedLayers(now.layers),
    });
    const patch = pointPlan(now.layers, point, body, { frame, lens: now });
    latest.current = { ...now, ...patch };
    update(patch);
  };
  const restore = () => {
    if (!before) return;
    const now = latest.current;
    update({
      latitude: before.latitude, longitude: before.longitude, instant: before.instant,
      azimuth: before.azimuth, pitch: before.pitch,
      layers: restoredLayers(now.layers, before.layers),
    });
    setBefore(null);
  };

  const events = useMemo<TimelineEvent[]>(() => {
    if (!active) return [];
    const describe = (point: PositionPoint) => `机位距目标 ${km(point.distance)} km，${bodyName(body)}视高度 ${point.elevation.toFixed(2)}°`;
    return candidates.flatMap((candidate) => [
      { key: `position-${candidate.key}-start`, kind: "alignment" as const, label: "对齐始", instant: iso(candidate.start), detail: `可拍时段开始：${describe(candidate.points[0])}` },
      ...(candidate.end !== candidate.start
        ? [{ key: `position-${candidate.key}-end`, kind: "alignment" as const, label: "对齐终", instant: iso(candidate.end), detail: `可拍时段结束：${describe(candidate.points.at(-1)!)}` }]
        : []),
    ]);
  }, [active, candidates, body]);

  return {
    target, setTarget, maxDistance, setMaxDistance, placing, setPlacing,
    placeTarget: (longitude: number, latitude: number) => {
      setTarget({ latitude, longitude: normalizeLongitude(longitude), height: 0, name: "地图上选的点" });
      setPlacing(false);
    },
    frame, setFrame,
    run, result, candidates, points, blocked, current, currentPoint, span, key,
    retry: () => setAttempt((value) => value + 1),
    tryOut, restore, canRestore: !!before, events,
  };
}
export type PositionSearch = ReturnType<typeof usePositionSearch>;

/** Pieces of a stretch drawn by sight: solid where the terrain data is complete, dotted where some is missing. */
function sightPieces(points: readonly PositionPoint[], selected: boolean, features: GeoJSON.Feature[]) {
  let line: PositionPoint[] = [];
  const flush = () => {
    if (line.length >= 2)
      features.push({ type: "Feature", properties: { kind: "line", sight: line.at(-1)!.sight, selected }, geometry: { type: "LineString", coordinates: line.map((p) => [p.longitude, p.latitude]) } });
    else if (line.length === 1)
      features.push({ type: "Feature", properties: { kind: "dot", sight: line[0].sight, selected }, geometry: { type: "Point", coordinates: [line[0].longitude, line[0].latitude] } });
  };
  for (const point of points) {
    const last = line.at(-1);
    if (last && point.sight !== last.sight) {
      // A change of sight starts the next piece at the shared point, so the line stays joined.
      flush();
      line = [{ ...last, sight: point.sight }, point];
    } else line.push(point);
  }
  flush();
}

/** Target, the listed stretches by sight, their start and end times, and every ten minutes of the one tried out. */
export function positionGeometry(search: PositionSearch | null, timeZone: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!search?.target) return { type: "FeatureCollection", features };
  features.push({ type: "Feature", properties: { kind: "target" }, geometry: { type: "Point", coordinates: [search.target.longitude, search.target.latitude] } });
  const label = (point: PositionPoint) =>
    features.push({ type: "Feature", properties: { kind: "label", label: clock(point.time, timeZone) }, geometry: { type: "Point", coordinates: [point.longitude, point.latitude] } });
  for (const candidate of search.candidates) {
    const selected = candidate === search.current;
    sightPieces(candidate.points, selected, features);
    const first = candidate.points[0], last = candidate.points.at(-1)!;
    label(first);
    if (last !== first) label(last);
    if (selected)
      for (const point of candidate.points)
        if (point !== first && point !== last && clock(point.time, timeZone).endsWith("0")) label(point);
  }
  return { type: "FeatureCollection", features };
}

/** Ground target and what to aim at on it; shared by 找机位 and 两者都找. */
export function TargetSection({ search, ground }: { search: PositionSearch; ground: number | null }) {
  const { target } = search;
  // The height used when switching back to "高出地面的点" (a landmark's own height until edited).
  const [raised, setRaised] = useState(50);
  useEffect(() => {
    if (target && target.height > 0) setRaised(target.height);
  }, [target?.height]);
  const top = target && ground !== null ? ground + target.height : null;
  return (
    <div className="alignment-section">
      <h3>拍摄目标</h3>
      <div className="alignment-actions">
        <button type="button" aria-pressed={search.placing} className={search.placing ? "is-active" : ""} onClick={() => search.setPlacing(!search.placing)}>
          {search.placing ? "取消点选" : "在地图上点选"}
        </button>
        <select aria-label="选择地标" value={target?.id ?? ""} onChange={(event) => {
          const landmark = landmarks.find((entry) => entry.id === event.target.value);
          if (landmark) search.setTarget({ id: landmark.id, name: landmark.name, latitude: landmark.latitude, longitude: landmark.longitude, height: landmark.bounds.height });
        }}>
          <option value="">或选择已接入地标…</option>
          {landmarks.map((landmark) => <option key={landmark.id} value={landmark.id}>{landmark.name}</option>)}
        </select>
      </div>
      {search.placing && <p className="alignment-hint" role="status">在地图上单击要拍的地方（山顶、塔等），Esc 取消。</p>}
      {target && <>
        <p className="alignment-target">
          <strong>{target.name}</strong>
          <small>{target.latitude.toFixed(5)}, {target.longitude.toFixed(5)}</small>
        </p>
        <fieldset className="alignment-aim">
          <legend>天体落在哪里</legend>
          <label>
            <input type="radio" name="alignment-aim" checked={target.height === 0}
              onChange={() => search.setTarget({ ...target, height: 0 })} />
            地面上的点（山顶、岩石）
          </label>
          <label>
            <input type="radio" name="alignment-aim" checked={target.height > 0}
              onChange={() => search.setTarget({ ...target, height: raised })} />
            高出地面的点（塔顶、楼顶）
          </label>
          {target.height > 0 && <NumberField label="离地高度" unit="m" min={0.1} max={1000} step={0.1} value={target.height}
            onChange={(height) => search.setTarget({ ...target, height })} />}
        </fieldset>
        <p className="alignment-hint" data-aim-height>
          {top === null
            ? target.height > 0 ? `对准离地 ${target.height} m 处；地面海拔在推算时读取。` : "对准地面；地面海拔在推算时读取。"
            : target.height > 0
              ? `对准点海拔约 ${metres(top)}（地面 ${metres(ground!)} + 离地 ${target.height} m）。`
              : `对准点海拔约 ${metres(top)}（地面）。`}
        </p>
      </>}
    </div>
  );
}

/** "Centre", or percentages from the frame's top-left. */
export function frameWords(frame: FramePoint) {
  const x = (frame.x + 1) / 2, y = (frame.y + 1) / 2;
  return Math.abs(frame.x) < 0.01 && Math.abs(frame.y) < 0.01 ? "画面中心" : `自左 ${percent(x)}、自上 ${percent(y)}`;
}
const framePresets: [string, FramePoint][] = [["居中", FRAME_CENTRE], ["上三分线", { x: 0, y: -1 / 3 }], ["下三分线", { x: 0, y: 1 / 3 }]];

/** Where the target (and the body on it) sits in the frame; shared by 找机位 and 两者都找. */
export function FramingSection({ frame, onFrame, name, overflow = false }: { frame: FramePoint; onFrame: (frame: FramePoint) => void; name: string; overflow?: boolean }) {
  return (
    <div className="alignment-section alignment-framing">
      <h3>画面位置</h3>
      <p className="alignment-hint">拖动预览里的虚线圈，决定目标和{name}在画面中的位置；试看时相机方向随之对准，不影响推算结果。</p>
      <p className="alignment-frame-place" role="status">目标在{frameWords(frame)}</p>
      <div className="alignment-actions" role="group" aria-label="画面位置预设">
        {framePresets.map(([label, preset]) => (
          <button key={label} type="button" aria-pressed={Math.abs(frame.x - preset.x) < 0.005 && Math.abs(frame.y - preset.y) < 0.005}
            onClick={() => onFrame(preset)}>{label}</button>
        ))}
      </div>
      {overflow && <p className="alignment-hint is-warning">主体下部超出画面：把目标往上移，或减小主体占画面的高度。</p>}
    </div>
  );
}

export function ProfileChart({ profile }: { profile: NonNullable<ReturnType<typeof positionProfile>> }) {
  const samples = profile.profile;
  const heights = samples.flatMap((sample) => (sample.ground === null ? [sample.sight] : [sample.sight, sample.ground]));
  const low = Math.min(...heights), high = Math.max(...heights), range = Math.max(1, high - low);
  const x = (distance: number) => 6 + (distance / profile.length) * 248;
  const y = (height: number) => 92 - ((height - low) / range) * 80;
  const ground = samples.filter((sample) => sample.ground !== null);
  const area = `M${x(ground[0]?.distance ?? 0)},96 ${ground.map((sample) => `L${x(sample.distance).toFixed(1)},${y(sample.ground!).toFixed(1)}`).join(" ")} L${x(ground.at(-1)?.distance ?? 0)},96Z`;
  const sight = samples.map((sample, index) => `${index ? "L" : "M"}${x(sample.distance).toFixed(1)},${y(sample.sight).toFixed(1)}`).join(" ");
  const blocked = samples.filter((sample) => sample.ground !== null && sample.ground > sample.sight + 0.5 && sample.distance >= 20 && profile.length - sample.distance >= 50);
  const state = profile.sight === "blocked" ? `在距机位 ${km(profile.blockedAt ?? 0)} km 处被地形挡住` : profile.sight === "clear" ? "未被地形挡住" : "经过缺少地形数据的地方";
  return (
    <figure className="position-profile">
      <svg viewBox="0 0 260 100" role="img" aria-label={`从机位到目标的地形剖面，全长 ${km(profile.length)} km：视线${state}`}>
        <path className="profile-ground" d={area} />
        <path className="profile-sight" d={sight} />
        {blocked.map((sample) => <circle key={sample.distance} className="profile-blocked" cx={x(sample.distance)} cy={y(sample.ground!)} r="1.6" />)}
        <circle className="profile-end" cx={x(0)} cy={y(samples[0].sight)} r="2.4" />
        <circle className="profile-end" cx={x(profile.length)} cy={y(samples.at(-1)!.sight)} r="2.4" />
      </svg>
      <figcaption>机位 → 目标 · {km(profile.length)} km · 视线{state}（只看地形，不含建筑与树木）</figcaption>
    </figure>
  );
}

/** A note when a wide search read the terrain one level coarser than usual. */
export function CoarseNote({ sampler, latitude }: { sampler: LoadedSampler | null | undefined; latitude: number }) {
  if (!sampler?.zoom || sampler.zoom >= TERRAIN_ZOOM) return null;
  return <p className="alignment-hint">范围较大，地形按较粗一级读取（像元约 {Math.round(tilePixel(sampler.zoom, latitude))} m）。</p>;
}

/** One listed stretch (找机位) or candidate (两者都找): when, where and how to try it. */
export function stretchFacts(candidate: Candidate<PositionPoint>, body: AlignmentBody) {
  const first = candidate.points[0], last = candidate.points.at(-1)!;
  const elevation = first === last ? `${first.elevation.toFixed(1)}°` : `${first.elevation.toFixed(1)}° → ${last.elevation.toFixed(1)}°`;
  return {
    where: `目标在${compassDirection(candidate.middle.azimuth)} · 距 ${candidate.near === candidate.far ? km(candidate.near) : `${km(candidate.near)}—${km(candidate.far)}`} km · ${bodyName(body)}高 ${elevation}`,
    sky: `${skyConditionNames[candidate.sky]}${candidate.illuminated !== null ? ` · 亮面 ${percent(candidate.illuminated)}` : ""}${candidate.clear < 1 ? " · 部分地形数据不全" : ""}`,
  };
}

/** The "找机位" part of the 推算 panel. */
export function PositionPanel({ search, plan, body, occlusion, check, onFrame }: {
  search: PositionSearch;
  plan: ShootingPlan;
  check?: Feasibility;
  body: AlignmentBody;
  occlusion: { state: string; occlusion: Occlusion } | null;
  onFrame: (frame: FramePoint) => void;
}) {
  const { target, run, result, candidates, current, currentPoint } = search;
  const name = bodyName(body);
  const profile = useMemo(() => {
    if (!target || !run?.sampler) return null;
    try {
      return positionProfile({ target, cameraHeight: plan.cameraHeight }, plan, run.sampler);
    } catch {
      return null;
    }
  }, [target, run?.sampler, plan.latitude, plan.longitude, plan.cameraHeight]);
  const span = (start: number, end: number) => (start === end ? clock(start, plan.timeZone) : `${clock(start, plan.timeZone)}–${clock(end, plan.timeZone)}`);
  let summary: ReactNode = null;
  if (!target) summary = <p className="alignment-hint">先在地图上点选目标，或选择已接入地标。</p>;
  else if (!run || run.key !== search.key || run.phase === "loading")
    summary = <p className="alignment-status" role="status">读取地形{run && run.key === search.key && run.tiles[1] ? ` ${run.tiles[0]}/${run.tiles[1]} 块` : "中"}…</p>;
  else if (run.phase === "solving") summary = <p className="alignment-status" role="status">推算中 · {Math.round(run.progress * 100)}%</p>;
  else if (run.phase === "error")
    summary = <div className="alignment-status is-error" role="status">
      <p>推算失败：{run.message}</p>
      <button type="button" onClick={search.retry}>重试</button>
    </div>;
  else if (result) {
    const hidden = search.blocked > 0 ? `；另有 ${search.blocked} 分钟视线被地形挡住，未列出` : "";
    if (candidates.length) {
      const minutes = new Set(search.points.map((point) => point.time)).size;
      summary = <p className="alignment-status" role="status">
        {candidates.length} 段可拍时段，共 {minutes} 分钟{hidden}
      </p>;
    } else if (search.blocked > 0)
      summary = <p className="alignment-status is-empty" role="status">
        有 {search.blocked} 分钟{name}正好落在目标上，但视线都被地形挡住。可以换一天、加大最远距离或提高离地高度。
      </p>;
    else
      summary = <p className="alignment-status is-empty" role="status">
        {result.reason === "no-ground" ? "目标处没有地形数据，无法推算。"
          : result.reason === "below" ? `这段时间${name}都在地平线下（按海平面地平）。`
            : `在 ${km(MIN_DISTANCE)}—${km(search.maxDistance)} km 内，看目标的仰角为 ${result.angles?.min.toFixed(1)}°—${result.angles?.max.toFixed(1)}°，${name}的高度为 ${result.sky?.min.toFixed(1)}°—${result.sky?.max.toFixed(1)}°，两者对不上。`}
      </p>;
  }
  const index = current && currentPoint ? current.points.indexOf(currentPoint) : -1;
  const describe = (point: PositionPoint) =>
    `${clock(point.time, plan.timeZone)} · 距目标 ${km(point.distance)} km（目标在${compassDirection(point.azimuth)}）`;
  return (
    <>
      <TargetSection search={search} ground={result?.targetGround ?? null} />
      <FramingSection frame={search.frame} onFrame={onFrame} name={name} />
      <div className="alignment-section alignment-conditions">
        <h3>条件</h3>
        <p className="alignment-hint">
          日期为时间轴当前范围：{localDateTime(search.span.start, plan.timeZone).replace("T", " ")} 起 24 小时（{plan.timeZone}）。换日期用时间轴的前一天、后一天。
        </p>
        <label className="field">
          <span className="field-label">最远距离</span>
          <select aria-label="机位最远距离" value={search.maxDistance} onChange={(event) => search.setMaxDistance(Number(event.target.value))}>
            {distanceChoices.map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label>
      </div>
      <div className="alignment-section alignment-results" aria-label="推算结果">
        <h3>可拍时段</h3>
        {summary}
        {target && <CoarseNote sampler={run?.key === search.key ? run.sampler : null} latitude={target.latitude} />}
        {check && candidates.length > 0 && <CheckControls check={check} />}
        {current && currentPoint && <>
          <p className="alignment-current" role="status">
            正在试看 {describe(currentPoint)}
            {occlusion && ` · ${name}${occlusion.state === "画面内" ? occlusionText(occlusion.occlusion, plan) : occlusion.state}`}
          </p>
          {current.points.length > 1 && <label className="field alignment-scrub">
            <span className="field-label">在这段内移动（机位与时刻一起）</span>
            <input type="range" min={0} max={current.points.length - 1} step={1} value={Math.max(0, index)}
              aria-label="在这段内移动机位与时刻"
              aria-valuetext={describe(current.points[Math.max(0, index)])}
              onChange={(event) => search.tryOut(current.points[Number(event.target.value)])} />
          </label>}
          {profile && <ProfileChart profile={profile} />}
        </>}
        {(current || search.canRestore) && <div className="alignment-actions">
          <button type="button" disabled={!search.canRestore} onClick={search.restore}>返回推算前</button>
        </div>}
        {candidates.length > 0 && <ol className="position-list">
          {candidates.map((candidate) => {
            const facts = stretchFacts(candidate, body);
            return (
              <li key={candidate.key} className={candidate === current ? "is-current" : undefined} data-candidate={candidate.key}>
                <span className="alignment-when">
                  <strong>{span(candidate.start, candidate.end)}</strong>
                  <small>{facts.where}</small>
                  <CheckTag check={check?.result(candidate.key) ?? null} />
                </span>
                <span className="alignment-facts">{facts.sky}</span>
                <button type="button" aria-label={`试看 ${span(candidate.start, candidate.end)}`}
                  aria-pressed={candidate === current} onClick={() => search.tryOut(candidate.middle)}>试看</button>
              </li>
            );
          })}
        </ol>}
        <p className="alignment-note">
          地图上每段线上的机位，在标注的时刻看到{name}正好落在目标上；“试看”跳到一段的中间。机位的眼睛高度为地面加离地 {plan.cameraHeight} m，
          {name}位置按{plan.refraction === "standard" ? "标准折射" : "无折射"}与海平面地平计算。遮挡只看机位与目标之间的地形，不含建筑、树木；地形高程的基准未核定，不代表实景一定可见。
        </p>
      </div>
    </>
  );
}
