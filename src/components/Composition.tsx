import { useEffect, useMemo, useRef, useState } from "react";

import { Temporal } from "@js-temporal/polyfill";
import {
  classify,
  conditionsAt,
  darkSkyChoices,
  dayChoices,
  dayLabel,
  canSkyline,
  DEFAULT_NEAREST,
  DEFAULT_TOLERANCE,
  daySpans,
  distanceChoices,
  extraGap,
  placeItem,
  filterResult,
  filterNames,
  groundAim,
  groundTarget,
  groupByDay,
  heightWords,
  lensOf,
  lineItems,
  MAX_LINE_DAYS,
  ndc,
  nearChoices,
  nearestChoices,
  nearestLabel,
  newId,
  nightSearch,
  shootingDay,
  prefilterOf,
  scanPair,
  spotWords,
  TARGET_LIMIT,
  targetName,
  templates,
  toleranceChoices,
  toleranceDiameters,
  tryPatch,
  windowItem,
  windowMark,
} from "../domain/composition";
import type {
  CameraRange,
  Composition,
  FilterSpec,
  FrameSpot,
  GroundSpec,
  Lens,
  ResultItem,
  SearchBasis,
  Shape,
  SkySpec,
  Strategy,
  TargetSpec,
  TimeRange,
} from "../domain/composition";
import { aimAt, finishAlignment, scanAlignment, skyConditionNames, skyConditions } from "../domain/alignment";
import type { AlignmentBody, AlignmentInput, AlignmentScan, SkyCondition } from "../domain/alignment";
import { blockedMinutes, baseDistances, rangeDays } from "../domain/range-alignment";
import type { RangeInput, RangePoint } from "../domain/range-alignment";
import { clearSpot, refinePlace, sightPoints, solveGroundPair } from "../domain/ground-pair";
import type { GroundPairInput } from "../domain/ground-pair";
import { groundDistance, highestNear, lineOfSight, MIN_DISTANCE, positionProfile, restoredLayers, SKYLINE_DROP, SKYLINE_RADIUS, skyAt, toRay, topSeen, travel, triedLayers } from "../domain/position-alignment";
import type { GroundSampler, GroundTarget, TriedLayers } from "../domain/position-alignment";
import { bodyKind, bodyName, fixedBodies, isFixedBody, sizeWord } from "../domain/sky-targets";
import { compassDirection, fieldOfView, localDateTime, normalizeLongitude } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { DEFAULT_TERRAIN_URL, TERRAIN_ZOOM, tilePixel } from "../domain/terrain";
import type { TimelineEvent } from "../domain/timeline";
import { landmarks } from "../domain/landmarks";
import { compositionOf, requestOf } from "../domain/solve";
import type { SolveRequest2 } from "../domain/solve";
import { occlusionText } from "../domain/visibility";
import type { Occlusion } from "../domain/visibility";
import type { CheckTarget } from "../domain/feasibility";
import { NumberField } from "./NumberField";
import { CheckControls, CheckTag, useFeasibility } from "./Feasibility";
import { SolveExport } from "./SolveLink";
import type { ShotSaving } from "./SolveLink";
import { runRange } from "./solve-runner";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;
const terrainUrl = import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
/** “移到附近最高点” looks this far around the point, metres. */
const SNAP_RADIUS = 500;
const DAY = 86_400_000, MINUTE = 60_000, SLICE = 30 * DAY;
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
const clock = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(11, 16);
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export type LoadedSampler = GroundSampler & { zoom?: number };

/** "11/13 周五", with the year when it is not `year` (a search crossing into another year). */
function dayWords(day: string, year?: number) {
  const date = Temporal.PlainDate.from(day);
  return `${year !== undefined && date.year !== year ? `${date.year}/` : ""}${date.month}/${date.day} ${weekdays[date.dayOfWeek - 1]}`;
}
const localDay = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(0, 10);

interface Run {
  id: number;
  key: string;
  phase: "running" | "done" | "error";
  stage: string;
  shape: Shape;
  strategy: Strategy;
  basis: SearchBasis;
  composition: Composition;
  timeZone: string;
  /** A night search: days run from noon to noon and are named after their evening. */
  night: boolean;
  items: ResultItem[];
  blocked: number;
  filtered: number;
  merged: number;
  /** Minutes (or passes) where the pair aligned but another target was not at its place. */
  extraMissed: number;
  /** Minutes (or passes) without light pollution data for 星空可见性. */
  missing: number;
  sectors: [number, number][];
  rings: { latitude: number; longitude: number; radius: number }[];
  sampler: LoadedSampler | null;
  /** Why nothing was found, or a warning about the search (a hidden ground point). */
  note: string;
  message: string;
  worker: boolean;
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

const initialComposition = (plan: ShootingPlan): Composition => ({
  targets: [],
  camera: { mode: "free", maxDistance: 30_000, minDistance: DEFAULT_NEAREST },
  time: { mode: "range", date: localDateTime(plan.instant, plan.timeZone).slice(0, 10), days: 30 },
  filters: [],
});

/** Everything a result depends on: when it differs from the run's, the results are stale. */
function searchKey(composition: Composition, plan: ShootingPlan) {
  const pairCamera = composition.camera.mode !== "fixed" && composition.targets.every((target) => target.kind === "sky") ? [plan.latitude, plan.longitude] : [];
  return JSON.stringify([composition, lensOf(plan), plan.timeZone, plan.cameraHeight, plan.refraction, pairCamera, terrainUrl]);
}

function linePoints(day: string, start: number, end: number) {
  return { day, start, end };
}

/**
 * State of the 推算 panel (构图约束搜索): the targets and where they go in the
 * frame, the search range and filters, an explicit search and its results,
 * and the try-out. Results belong to the search that made them; editing the
 * conditions marks them stale until the next search.
 */
export function useComposition(plan: ShootingPlan, update: UpdatePlan, active: boolean, generation: number) {
  const [composition, setComposition] = useState<Composition>(() => initialComposition(plan));
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // A ground target waiting for a map click: an existing one, or "new".
  const [placing, setPlacing] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [before, setBefore] = useState<Before | null>(null);
  const latest = useRef(plan);
  latest.current = plan;
  const token = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!active) {
      setPlacing(null);
      setBefore(null);
    }
  }, [active]);
  useEffect(() => setBefore(null), [generation]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!placing) return;
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setPlacing(null);
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [placing]);

  const change = (next: (current: Composition) => Composition) => setComposition((current) => next(current));
  /** Moves a ground point to the highest terrain within SNAP_RADIUS; returns what happened, for the button. */
  const snapToHighest = async (id: string): Promise<{ text: string; at: string } | null> => {
    const target = composition.targets.find((entry): entry is GroundSpec => entry.id === id && entry.kind === "ground");
    if (!target) return null;
    const at = (point: { latitude: number; longitude: number }) => `${point.latitude}/${point.longitude}`;
    const note = (text: string, point: { latitude: number; longitude: number } = target) => ({ text, at: at(point) });
    try {
      const elevation = await import("../preview/elevation");
      const ring = [0, 45, 90, 135, 180, 225, 270, 315].map((bearing) => travel(target, bearing, SNAP_RADIUS));
      const sampler = await elevation.elevationTiles([target, ...ring], terrainUrl, new AbortController().signal);
      const found = highestNear(target, SNAP_RADIUS, sampler);
      if (!found) return note("这里没有地形数据。");
      if (found.offset < 1) return note(`已在 ${SNAP_RADIUS} m 内的最高处（${Math.round(found.ground)} m）。`);
      updateTarget(id, { latitude: found.latitude, longitude: found.longitude, landmark: undefined, ...(target.reference === "sea" ? { height: Math.round(found.ground) } : {}) });
      return note(`已移动 ${Math.round(found.offset)} m，到地形高程 ${Math.round(found.ground)} m 处。`, found);
    } catch (error) {
      return note(`读取地形失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const updateTarget = (id: string, patch: Partial<GroundSpec> | Partial<SkySpec>) =>
    change((current) => ({ ...current, targets: current.targets.map((target) => (target.id === id ? { ...target, ...patch } as TargetSpec : target)) }));
  const removeTarget = (id: string) => {
    change((current) => ({ ...current, targets: current.targets.filter((target) => target.id !== id) }));
    if (selected === id) setSelected(null);
    if (editing === id) setEditing(null);
  };
  // A new body starts on the ground point (the usual "on the top"); a further one beside the others.
  const defaultSkyFrame = (current: Composition): FrameSpot => {
    const ground = current.targets.find((target) => target.kind === "ground");
    const skies = current.targets.filter((target) => target.kind === "sky").length;
    if (ground && !skies) return { ...ground.frame };
    if (!current.targets.length) return { x: 0.5, y: 0.5 };
    return [{ x: 0.62, y: 0.4 }, { x: 0.38, y: 0.35 }, { x: 0.66, y: 0.22 }][Math.min(2, skies)];
  };
  const addSky = (body: AlignmentBody = "moon") => {
    const id = newId();
    change((current) => current.targets.length >= TARGET_LIMIT ? current
      : { ...current, targets: [...current.targets, { kind: "sky", id, body, frame: defaultSkyFrame(current), tolerance: DEFAULT_TOLERANCE }] });
    setSelected(id);
    setEditing(id);
  };
  /** A ground target from a map click or a landmark: a new one, or the one being placed again. */
  const setGroundPlace = (place: { latitude: number; longitude: number; name: string; landmark?: string; height?: number }, id = placing ?? "new") => {
    if (id === "new") {
      const newTarget: GroundSpec = {
        kind: "ground", id: newId(), name: place.name, ...(place.landmark ? { landmark: place.landmark } : {}),
        latitude: place.latitude, longitude: place.longitude, height: place.height ?? 0, reference: "ground",
        frame: { x: 0.5, y: 2 / 3 }, base: null, tolerance: DEFAULT_TOLERANCE,
      };
      change((current) => {
        if (current.targets.length >= TARGET_LIMIT) return current;
        const sky = current.targets.find((target) => target.kind === "sky");
        const grounds = current.targets.some((target) => target.kind === "ground");
        // The first ground point under a body already placed; a second one lower left.
        const frame = grounds ? { x: 0.3, y: 0.78 } : sky ? { ...sky.frame } : newTarget.frame;
        return { ...current, targets: [...current.targets, { ...newTarget, frame }] };
      });
      setSelected(newTarget.id);
      setEditing(newTarget.id);
    } else {
      updateTarget(id, { name: place.name, landmark: place.landmark, latitude: place.latitude, longitude: place.longitude, ...(place.height !== undefined ? { height: place.height, reference: "ground" as const } : {}) });
    }
    setPlacing(null);
  };
  const applyTemplate = (id: string) => {
    const template = templates.find((entry) => entry.id === id);
    if (!template) return;
    const next = template.build(latest.current, localDateTime(latest.current.instant, latest.current.timeZone).slice(0, 10));
    setComposition(next);
    setSelected(null);
    setEditing(null);
    setPlacing(null);
  };

  const solvability = classify(composition);
  const key = searchKey(composition, plan);
  const stale = !!run && run.key !== key;
  const running = run?.phase === "running";

  const set = (id: number, patch: Partial<Run>) => setRun((state) => (state && state.id === id ? { ...state, ...patch } : state));

  const search = async () => {
    const strategy = solvability.strategy;
    if (!strategy || !solvability.shape) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const id = ++token.current;
    const now = latest.current, lens = lensOf(now), snapshot = composition;
    const bodies = snapshot.targets.filter((target): target is SkySpec => target.kind === "sky").map((target) => target.body);
    const basis: SearchBasis = {
      lens, ground: strategy.kind === "pair" ? null : strategy.kind === "grounds" ? strategy.first : strategy.ground, bodies,
      ...(strategy.kind === "pair" ? { follow: { body: strategy.first.body, frame: strategy.first.frame, refraction: now.refraction } } : {}),
    };
    setRun({
      id, key: searchKey(snapshot, now), phase: "running", stage: "准备中…", shape: solvability.shape, strategy, basis, composition: snapshot, timeZone: now.timeZone, night: nightSearch(snapshot, strategy),
      items: [], blocked: 0, filtered: 0, merged: 0, extraMissed: 0, missing: 0, sectors: [], rings: [], sampler: null, note: "", message: "", worker: false,
    });
    try {
      if (strategy.kind === "line") await searchLine(id, strategy, snapshot, now, lens, abort.signal);
      else if (strategy.kind === "window") await searchWindow(id, strategy, snapshot, now, lens, abort.signal);
      else if (strategy.kind === "grounds") await searchGrounds(id, strategy, snapshot, now, lens, abort.signal);
      else await searchPair(id, strategy, snapshot, now, lens, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return;
      set(id, { phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const cancel = () => {
    controller.current?.abort();
    setRun((state) => (state && state.phase === "running" ? { ...state, phase: "error", message: "已取消" } : state));
  };

  const range = (time: TimeRange, timeZone: string, night: boolean) => {
    if (time.mode === "instant") {
      const start = Math.floor(Date.parse(time.instant) / MINUTE) * MINUTE;
      return { from: start, to: start + 1, days: [linePoints(shootingDay(start, timeZone, night), start, start + 1)] };
    }
    const days = rangeDays(time.date, time.days, timeZone, night ? "noon" : "midnight");
    return { from: days[0].start, to: days.at(-1)!.end, days };
  };

  /** The cameras' light pollution for 星空可见性, read per ~1 km cell; null where the atlas has none. */
  async function pollutionAt(id: number, places: readonly { latitude: number; longitude: number }[], signal: AbortSignal) {
    const cell = (place: { latitude: number; longitude: number }) => `${Math.round(place.latitude * 100)}/${Math.round(place.longitude * 100)}`;
    const cells = new Map<string, { latitude: number; longitude: number }>();
    for (const place of places) cells.set(cell(place), place);
    const loader = await import("../preview/light-pollution");
    const values = new Map<string, number | null>();
    let done = 0;
    for (const [key, place] of cells) {
      try {
        values.set(key, (await loader.sampleLightPollution(place, signal))?.artificialMcd ?? null);
      } catch (error) {
        if (signal.aborted) throw error;
        values.set(key, null);
      }
      if (++done % 25 === 0) set(id, { stage: `读取光污染 ${done}/${cells.size}…` });
    }
    return (place: { latitude: number; longitude: number }) => values.get(cell(place)) ?? null;
  }
  const darkSky = (snapshot: Composition) => snapshot.filters.some((filter) => filter.kind === "darkSky");

  /** Two ground points: camera places over the range (the grid on the main thread), then the sight lines. */
  async function searchGrounds(id: number, strategy: Extract<Strategy, { kind: "grounds" }>, snapshot: Composition, now: ShootingPlan, lens: Lens, signal: AbortSignal) {
    const { first, second } = strategy;
    const camera = snapshot.camera;
    const center = camera.mode === "near" ? { latitude: camera.latitude, longitude: camera.longitude } : { latitude: first.latitude, longitude: first.longitude };
    const minDistance = camera.mode === "free" ? Math.max(MIN_DISTANCE, camera.minDistance) : 0;
    const maxDistance = camera.mode === "free" ? camera.maxDistance : camera.mode === "near" ? camera.radius : 30_000;
    const rings: Run["rings"] = [{ ...center, radius: maxDistance }, ...(minDistance > MIN_DISTANCE ? [{ ...center, radius: minDistance }] : [])];
    const input: GroundPairInput = {
      first: groundTarget(first), firstFrame: ndc(first.frame), second: groundTarget(second), secondFrame: ndc(second.frame),
      tolerance: second.tolerance, lens, cameraHeight: now.cameraHeight, center, minDistance, maxDistance,
    };
    const skylineRing = (target: GroundSpec) => (target.skyline && canSkyline(target) ? [0, 90, 180, 270].map((bearing) => travel(target, bearing, SKYLINE_RADIUS)) : []);
    // The terrain over the whole range, and around each ground point.
    const area = [center, ...Array.from({ length: 24 }, (_, index) => [0.25, 0.5, 0.75, 1].map((share) => travel(center, index * 15, maxDistance * share))).flat()];
    const grounds = [first, second, ...strategy.extras.filter((extra): extra is GroundSpec => extra.kind === "ground")];
    set(id, { rings, stage: "读取地形中…" });
    const elevation = await import("../preview/elevation");
    const sampler = await elevation.elevationTiles([...area, ...grounds.flatMap((ground) => [ground, ...skylineRing(ground)])], terrainUrl, signal,
      (done, total) => set(id, { stage: `读取地形 ${done}/${total} 块…` }));
    if (signal.aborted) return;
    set(id, { stage: "推算中…" });
    await yieldNow();
    const solved = solveGroundPair(input, sampler);
    if (signal.aborted) return;
    // The sight lines of each place, with the terrain all along them.
    let blocked = 0, extraMissed = 0;
    const items: ResultItem[] = [];
    let lines: LoadedSampler | null = null;
    if (solved.places.length) {
      set(id, { stage: "检查视线…" });
      lines = await elevation.elevationTiles([...solved.places.flatMap((place) => sightPoints(place)), ...grounds.flatMap((ground) => [ground, ...skylineRing(ground)])], terrainUrl, signal,
        (done, total) => set(id, { stage: `读取视线上的地形 ${done}/${total} 块…` }));
      if (signal.aborted) return;
      const instant = Date.parse(now.instant);
      for (const coarse of solved.places) {
        // Settled again on the sight lines' finer terrain.
        const refined = refinePlace(input, coarse, lines);
        if (!refined) continue;
        // The exact place, or the clear spot within its tolerance that lands the second point nearest.
        const clear = clearSpot(input, refined, lines);
        if (!clear) { blocked++; continue; }
        const { place, sight, moved } = clear;
        const other = strategy.extras.length ? extraGap(strategy.extras, { latitude: place.latitude, longitude: place.longitude, ground: place.ground }, instant, place.aim,
          { lens, refraction: now.refraction, cameraHeight: now.cameraHeight, sampler: lines }) : 0;
        if (other === null) { extraMissed++; continue; }
        const item = placeItem(place, instant, sight.first === "unknown" || sight.second === "unknown", moved);
        items.push(other > item.deviation ? { ...item, deviation: other } : item);
      }
    }
    const note = items.length ? ""
      : blocked ? `有 ${blocked} 个机位能让两点落在设定位置，但视线被地形挡住。`
        : extraMissed ? `有 ${extraMissed} 个机位能让两点落在设定位置，但其他地面点不在设定位置。`
          : `所选范围内没有机位能让“${second.name}”落在设定位置（容差 ±${percent(second.tolerance)}）。`;
    set(id, { phase: "done", items, blocked, extraMissed, sampler: lines ?? sampler, rings, note });
  }

  async function searchLine(id: number, strategy: Extract<Strategy, { kind: "line" }>, snapshot: Composition, now: ShootingPlan, lens: Lens, signal: AbortSignal) {
    const { ground, sky } = strategy;
    const target: GroundTarget = groundTarget(ground);
    // A skyline target needs the terrain all around its point.
    const around = target.skyline ? [0, 45, 90, 135, 180, 225, 270, 315].map((bearing) => travel(target, bearing, target.skyline!)) : [];
    const frames = { lens, target: ndc(ground.frame), body: ndc(sky.frame) };
    let minDistance = MIN_DISTANCE, maxDistance = snapshot.camera.mode === "free" ? snapshot.camera.maxDistance : 30_000;
    const rings: Run["rings"] = [];
    let centre: { latitude: number; longitude: number; radius: number } | null = null;
    if (snapshot.camera.mode === "near") {
      const distance = groundDistance(target, snapshot.camera);
      if (distance - snapshot.camera.radius > 30_000) throw new Error("机位范围离地面目标超过 30 km：请换一处，或改用“不限”。");
      minDistance = Math.max(MIN_DISTANCE, distance - snapshot.camera.radius);
      maxDistance = Math.min(30_000, distance + snapshot.camera.radius);
      centre = { latitude: snapshot.camera.latitude, longitude: snapshot.camera.longitude, radius: snapshot.camera.radius };
      rings.push(centre);
    } else {
      minDistance = Math.max(MIN_DISTANCE, snapshot.camera.mode === "free" ? snapshot.camera.minDistance : MIN_DISTANCE);
      rings.push({ latitude: target.latitude, longitude: target.longitude, radius: maxDistance });
      if (minDistance > MIN_DISTANCE) rings.push({ latitude: target.latitude, longitude: target.longitude, radius: minDistance });
    }
    let base: RangeInput["base"];
    let share: number | null = null;
    if (ground.base !== null) {
      const band = baseDistances(target, frames.target.y, ground.base * 2 - 1, lens, maxDistance);
      if (!band) throw new Error("底部位置只用于距地表至少 10 m 的点。");
      minDistance = Math.max(minDistance, band.minDistance);
      maxDistance = Math.min(maxDistance, band.maxDistance);
      base = { y: ground.base * 2 - 1, tolerance: ground.tolerance };
      share = ground.base - ground.frame.y;
    }
    if (minDistance >= maxDistance) {
      set(id, { phase: "done", rings, note: "按设定的主体大小，机位应在所选范围之外：请放宽范围，或调整底部位置。" });
      return;
    }
    const span = range(snapshot.time, now.timeZone, nightSearch(snapshot, strategy));
    const prefilter = prefilterOf(snapshot.filters, sky, strategy.extras, lens);
    const extraGrounds = strategy.extras.filter((extra): extra is GroundSpec => extra.kind === "ground");
    const input: RangeInput = {
      body: sky.body, target, refraction: now.refraction, cameraHeight: now.cameraHeight, lens,
      share: null, minDistance, maxDistance, frames, ...(base ? { base } : {}), ...(prefilter ? { prefilter } : {}),
    };
    const collected: RangePoint[] = [];
    const elevation = await import("../preview/elevation");
    // The target's own ground first: the altitude pre-filter then allows cameras far below a summit.
    set(id, { stage: "读取地形中…" });
    const near = await elevation.elevationTiles([target, ...around], terrainUrl, signal);
    if (signal.aborted) return;
    // For a skyline target, its highest point bounds what any camera can see.
    const own = target.skyline ? highestNear(target, target.skyline, near)?.ground ?? null : near(target.latitude, target.longitude);
    if (own !== null) input.targetGround = own;
    let sectors: [number, number][] = [];
    const sampler = await runRange(input, span.days, signal, {
      usingWorker: (worker) => set(id, { worker }),
      planned: (found) => {
        sectors = found;
        set(id, { sectors: found, stage: "读取地形中…" });
      },
      loadTiles: async (points) => {
        // Further ground points need their own ground too.
        const loaded = await elevation.elevationTiles([...points, ...around, ...extraGrounds], terrainUrl, signal, (done, total) => set(id, { stage: `读取地形 ${done}/${total} 块…` }));
        set(id, { stage: "推算中…" });
        return loaded;
      },
      day: (index, points) => {
        collected.push(...points);
        set(id, { stage: `推算中 ${index + 1}/${span.days.length} 天…` });
      },
    });
    if (signal.aborted) return;
    const inRange = centre ? collected.filter((point) => groundDistance(point, centre) <= centre.radius) : collected;
    const blocked = blockedMinutes(inRange);
    // Further targets: each unblocked minute, the camera aimed at the ground point's place.
    let extraMissed = 0;
    const points = strategy.extras.length ? inRange.flatMap((point) => {
      if (point.sight === "blocked") return [point];
      const gap = extraGap(strategy.extras, { latitude: point.latitude, longitude: point.longitude, ground: point.cameraGround }, point.time, aimAt(lens, point, frames.target),
        { lens, refraction: now.refraction, cameraHeight: now.cameraHeight, sampler });
      if (gap === null) {
        extraMissed++;
        return [];
      }
      return [{ ...point, gap }];
    }) : inRange;
    let artificial: ((place: { latitude: number; longitude: number }) => number | null) | undefined;
    if (darkSky(snapshot)) {
      set(id, { stage: "读取光污染…" });
      const night = points.filter((point) => point.sight !== "blocked" && skyAt("sun", point.time, point.latitude, point.longitude, "none").elevation < -17.5);
      artificial = await pollutionAt(id, night, signal);
      if (signal.aborted) return;
    }
    const listed = lineItems(points, { body: sky.body, filters: snapshot.filters, splitSky: span.days.length === 1, share, artificial });
    const note = listed.items.length ? ""
      : extraMissed > 0 && !(listed.filtered + listed.missing) ? `有 ${extraMissed} 分钟${bodyName(sky.body)}与“${ground.name}”对齐，但其他目标都不在设定位置。`
        : blocked > 0 && !(listed.filtered + listed.missing) ? `有 ${blocked} 分钟几何上对齐，但视线都被地形挡住。可以换日期、放宽机位范围或提高离地高度。`
          : listed.filtered + listed.missing > 0 ? `有 ${listed.filtered + listed.missing} 分钟对齐，但都不满足筛选条件${listed.missing ? `（其中 ${listed.missing} 分钟缺少光污染数据）` : ""}。`
            : !sectors.length ? `这段时间${bodyName(sky.body)}达不到所需的高度。`
              : "所选范围内没有解。";
    set(id, { phase: "done", items: listed.items, blocked, filtered: listed.filtered, missing: listed.missing, merged: listed.merged, extraMissed, sampler, rings, note });
  }

  async function searchWindow(id: number, strategy: Extract<Strategy, { kind: "window" }>, snapshot: Composition, now: ShootingPlan, lens: Lens, signal: AbortSignal) {
    if (snapshot.camera.mode !== "fixed") throw new Error("时刻搜索需要固定机位");
    const camera = { latitude: snapshot.camera.latitude, longitude: snapshot.camera.longitude };
    let aim = snapshot.camera.aim;
    let note = "", sampler: LoadedSampler | null = null;
    const grounds = [strategy.ground, ...strategy.extras].filter((target): target is GroundSpec => !!target && target.kind === "ground");
    if (grounds.length) {
      // The terrain along the sight line to each ground point.
      const line = grounds.flatMap((target) => {
        const length = groundDistance(camera, target);
        if (length > 120_000) throw new Error(`固定机位离“${target.name}”超过 120 km。`);
        const steps = Math.max(2, Math.ceil(length / 400));
        return Array.from({ length: steps + 1 }, (_, index) => ({
          latitude: camera.latitude + ((target.latitude - camera.latitude) * index) / steps,
          longitude: normalizeLongitude(camera.longitude + ((target.longitude - camera.longitude) * index) / steps),
        }));
      });
      const around = grounds.flatMap((target) => (target.skyline && canSkyline(target) ? [0, 90, 180, 270].map((bearing) => travel(target, bearing, SKYLINE_RADIUS)) : []));
      set(id, { stage: "读取地形中…" });
      const elevation = await import("../preview/elevation");
      sampler = await elevation.elevationTiles([...line, ...around], terrainUrl, signal, (done, total) => set(id, { stage: `读取地形 ${done}/${total} 块…` }));
    }
    if (strategy.ground && sampler) {
      const ground = strategy.ground;
      const target: GroundTarget = groundTarget(ground);
      const cameraGround = sampler(camera.latitude, camera.longitude);
      const eye = cameraGround === null ? null : { ...camera, ellipsoidalHeight: cameraGround + now.cameraHeight };
      const top = eye && topSeen(target, eye, sampler);
      if (!eye || !top) throw new Error("机位或地面目标处没有地形数据。");
      aim = groundAim(ground, lens, toRay(eye, top));
      const sight = lineOfSight(eye, top, sampler);
      if (sight.sight === "blocked") note = `从这个机位看，“${ground.name}”在距机位 ${km(sight.blockedAt ?? 0)} km 处被地形挡住。`;
    }
    if (!aim) throw new Error("缺少朝向");
    const sky = strategy.sky;
    const mark = windowMark(sky, lens, aim);
    const input: AlignmentInput = { latitude: camera.latitude, longitude: camera.longitude, refraction: now.refraction, target: { body: sky.body, ...mark }, tolerance: toleranceDiameters(sky, lens) };
    const night = nightSearch(snapshot, strategy);
    const span = range(snapshot.time, now.timeZone, night);
    const scans: AlignmentScan[] = [];
    for (let cursor = span.from; cursor < span.to; cursor += SLICE) {
      await yieldNow();
      if (signal.aborted) return;
      scans.push(scanAlignment(input, cursor, Math.min(span.to, cursor + SLICE)));
      set(id, { stage: `推算中 ${Math.round((Math.min(1, (cursor + SLICE - span.from) / (span.to - span.from))) * 100)}%…` });
    }
    const result = finishAlignment(input, scans, span.from, span.to);
    const vertical = fieldOfView(lens).vertical;
    const artificial = darkSky(snapshot) ? (await pollutionAt(id, [camera], signal))(camera) : undefined;
    let filtered = 0, missing = 0, extraMissed = 0;
    const cameraGround = sampler?.(camera.latitude, camera.longitude) ?? null;
    const items = result.alignments.flatMap((found) => {
      const best = Date.parse(found.instant);
      const verdict = filterResult(snapshot.filters, conditionsAt(best, camera.latitude, camera.longitude), artificial);
      if (verdict !== "pass") {
        if (verdict === "fail") filtered++;
        else missing++;
        return [];
      }
      const other = strategy.extras.length ? extraGap(strategy.extras, { ...camera, ground: cameraGround }, best, aim!, { lens, refraction: now.refraction, cameraHeight: now.cameraHeight, sampler }) : 0;
      if (other === null) {
        extraMissed++;
        return [];
      }
      return [windowItem({ start: Date.parse(found.from), end: Date.parse(found.to), best, deviation: Math.max(found.separation / vertical, other) }, camera, aim!, shootingDay(best, now.timeZone, night))];
    });
    if (!items.length) {
      const name = bodyName(sky.body);
      note = [note, result.reason === "too-high" ? `${name}达不到画面位置对应的高度（${mark.elevation.toFixed(1)}°）。`
        : result.reason === "too-low" ? `${name}始终高于画面位置对应的高度（${mark.elevation.toFixed(1)}°）。`
          : extraMissed ? `有 ${extraMissed} 次${name}经过画面位置，但其他目标都不在设定位置。`
            : filtered || missing || result.reason === "filtered" ? `有 ${filtered + missing + result.filtered.phase + result.filtered.sky} 次对齐，但都不满足筛选条件${isFixedBody(sky.body) ? "或天色不够暗（太阳须低于 −6°）" : ""}${missing ? `（其中 ${missing} 次缺少光污染数据）` : ""}。`
              : `${name}没有经过画面位置（容差 ±${percent(sky.tolerance)}）。`].filter(Boolean).join(" ");
    }
    set(id, { phase: "done", items, filtered, missing, extraMissed, sampler, note });
  }

  async function searchPair(id: number, strategy: Extract<Strategy, { kind: "pair" }>, snapshot: Composition, now: ShootingPlan, lens: Lens, signal: AbortSignal) {
    const camera = snapshot.camera.mode === "free" ? { latitude: now.latitude, longitude: now.longitude } : { latitude: snapshot.camera.latitude, longitude: snapshot.camera.longitude };
    const night = nightSearch(snapshot, strategy);
    const span = range(snapshot.time, now.timeZone, night);
    const extras = strategy.extras.filter((extra): extra is SkySpec => extra.kind === "sky");
    const input = { first: strategy.first, second: strategy.second, extras, lens, ...camera, refraction: now.refraction };
    const windows = [];
    for (let cursor = span.from; cursor < span.to; cursor += SLICE) {
      await yieldNow();
      if (signal.aborted) return;
      windows.push(...scanPair(input, cursor, Math.min(span.to, cursor + SLICE)));
      set(id, { stage: `推算中 ${Math.round((Math.min(1, (cursor + SLICE - span.from) / (span.to - span.from))) * 100)}%…` });
    }
    const artificial = darkSky(snapshot) ? (await pollutionAt(id, [camera], signal))(camera) : undefined;
    let filtered = 0, missing = 0;
    const items = windows.flatMap((window) => {
      const verdict = filterResult(snapshot.filters, conditionsAt(window.best, camera.latitude, camera.longitude), artificial);
      if (verdict !== "pass") {
        if (verdict === "fail") filtered++;
        else missing++;
        return [];
      }
      const aim = aimAt(lens, skyAt(strategy.first.body, window.best, camera.latitude, camera.longitude, now.refraction), ndc(strategy.first.frame));
      return [windowItem(window, camera, aim, shootingDay(window.best, now.timeZone, night))];
    });
    const note = items.length ? "" : filtered + missing ? `有 ${filtered + missing} 次到达相对位置，但都不满足筛选条件${missing ? `（其中 ${missing} 次缺少光污染数据）` : ""}。`
      : `${strategy.extras.length ? "这些天体" : `${bodyName(strategy.first.body)}与${bodyName(strategy.second.body)}`}在所选日期内没有到达设定的相对位置。`;
    set(id, { phase: "done", items, filtered, missing, note });
  }

  // ------------------------------------------------------------ 试看
  const done = run?.phase === "done" ? run : null;
  const items = done?.items ?? [];
  const time = Date.parse(plan.instant);
  const sameCamera = (camera: { latitude: number; longitude: number }) => Math.abs(camera.latitude - plan.latitude) < 1e-6 && Math.abs(camera.longitude - plan.longitude) < 1e-6;
  const current = items.find((item) => (item.points
    ? item.points.some((point) => point.time === time && sameCamera(point))
    : item.place ? sameCamera(item.camera)
      : sameCamera(item.camera) && time >= Math.floor(item.start / MINUTE) * MINUTE && time <= item.end)) ?? null;

  const tryOut = (item: ResultItem, at = item.best) => {
    if (!done) return;
    const now = latest.current;
    setBefore((kept) => kept ?? {
      latitude: now.latitude, longitude: now.longitude, instant: now.instant,
      azimuth: now.azimuth, pitch: now.pitch, layers: triedLayers(now.layers),
    });
    const patch = tryPatch(item, done.basis, now.layers, at);
    latest.current = { ...now, ...patch };
    update(patch);
  };
  const restore = () => {
    if (!before) return;
    const now = latest.current;
    update({
      latitude: before.latitude, longitude: before.longitude, instant: before.instant,
      azimuth: before.azimuth, pitch: before.pitch, layers: restoredLayers(now.layers, before.layers),
    });
    setBefore(null);
  };
  /** Moving a target's mark during a try-out turns the camera so the result stays framed. */
  const moveTarget = (id: string, frame: FrameSpot) => {
    const spot = { x: clamp01(frame.x), y: clamp01(frame.y) };
    updateTarget(id, { frame: spot });
  };

  const events = useMemo<TimelineEvent[]>(() => (active && done ? done.items.flatMap((item) => {
    if (item.place) return [];
    const where = item.near !== null ? `，机位距地面目标 ${km(item.near)}—${km(item.far!)} km` : "";
    return item.start === item.end || item.end - item.start < MINUTE
      ? [{ key: `result-${item.key}`, kind: "alignment" as const, label: "对齐", instant: iso(item.best), detail: `结果${where}` }]
      : [
        { key: `result-${item.key}-start`, kind: "alignment" as const, label: "对齐始", instant: iso(item.start), detail: `结果开始${where}` },
        { key: `result-${item.key}-end`, kind: "alignment" as const, label: "对齐终", instant: iso(item.end), detail: `结果结束${where}` },
      ];
  }) : []), [active, done]);

  /** Camera places to check for water and buildings: each row's try-out camera. */
  const checkTargets: CheckTarget[] = items.map((item) => {
    const point = item.points?.find((entry) => entry.time === item.best);
    return {
      key: item.key, latitude: item.camera.latitude, longitude: item.camera.longitude, ...(point ? { ground: point.cameraGround } : {}),
      cameraHeight: plan.cameraHeight,
      azimuth: point ? point.azimuth : item.aim?.azimuth ?? plan.azimuth,
      elevation: point ? point.elevation : item.aim?.pitch ?? plan.pitch,
    };
  });

  /** Opens a request (from a link) on the plan it was loaded into, then searches once the conditions are in. */
  const [loaded, setLoaded] = useState(0);
  const load = (request: SolveRequest2, opened: ShootingPlan) => {
    controller.current?.abort();
    setComposition(compositionOf(request, opened));
    setRun(null);
    setSelected(null);
    setEditing(null);
    setPlacing(null);
    setLoaded((value) => value + 1);
  };
  useEffect(() => {
    if (loaded && active && solvability.strategy) void search();
  }, [loaded]);
  const request = (): SolveRequest2 | null => {
    if (!composition.targets.length) return null;
    const now = latest.current;
    return requestOf(composition, lensOf(now), { timeZone: now.timeZone, cameraHeight: now.cameraHeight });
  };

  return {
    active, composition, setComposition, solvability, selected, setSelected, editing, setEditing, placing, setPlacing,
    updateTarget, removeTarget, addSky, setGroundPlace, moveTarget, applyTemplate, snapToHighest,
    setCamera: (camera: CameraRange) => change((state) => ({ ...state, camera })),
    setTime: (time: TimeRange) => change((state) => ({ ...state, time })),
    setFilters: (filters: FilterSpec[]) => change((state) => ({ ...state, filters })),
    run, stale, running, search, cancel, items, current, tryOut, restore, canRestore: !!before, events, checkTargets, load, request,
    placeTarget: (longitude: number, latitude: number) => setGroundPlace({ latitude, longitude: normalizeLongitude(longitude), name: "地图上选的点" }),
  };
}
export type CompositionState = ReturnType<typeof useComposition>;

// ---------------------------------------------------------------- 地图

const circle = (centre: { latitude: number; longitude: number }, radius: number) =>
  Array.from({ length: 73 }, (_, index) => {
    const point = travel(centre, (index * 5) % 360, radius);
    return [point.longitude, point.latitude];
  });

/** Ground targets, the search range, sectors and result lines (light to dark by date) for the map. */
export function compositionGeometry(state: CompositionState | null, timeZone: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!state?.active) return { type: "FeatureCollection", features };
  for (const target of state.composition.targets)
    if (target.kind === "ground")
      features.push({ type: "Feature", properties: { kind: "target" }, geometry: { type: "Point", coordinates: [target.longitude, target.latitude] } });
  const run = state.run;
  if (!run || run.phase === "error") return { type: "FeatureCollection", features };
  for (const ring of run.rings) features.push({ type: "Feature", properties: { kind: "ring" }, geometry: { type: "LineString", coordinates: circle(ring, ring.radius) } });
  const ground = run.basis.ground;
  if (ground && run.strategy.kind === "line")
    for (const [from, to] of run.sectors) {
      const steps = Math.max(2, Math.ceil(to - from));
      const outer = run.rings[0]?.radius ?? 30_000;
      const arc = (radius: number) => Array.from({ length: steps + 1 }, (_, index) => {
        const point = travel(ground, from + ((to - from) * index) / steps, radius);
        return [point.longitude, point.latitude];
      });
      const far = arc(run.composition.camera.mode === "near" ? 30_000 : outer), near = arc(MIN_DISTANCE).reverse();
      features.push({ type: "Feature", properties: { kind: "sector" }, geometry: { type: "Polygon", coordinates: [[...far, ...near, far[0]]] } });
    }
  run.items.filter((item) => item.place).forEach((item, index) => {
    const selected = item === state.current;
    const outline = item.place!.area.map((point) => [point.longitude, point.latitude]);
    if (outline.length > 2) features.push({ type: "Feature", properties: { kind: "area", selected }, geometry: { type: "Polygon", coordinates: [[...outline, outline[0]]] } });
    const at = [item.camera.longitude, item.camera.latitude];
    features.push({ type: "Feature", properties: { kind: "dot", selected }, geometry: { type: "Point", coordinates: at } });
    features.push({ type: "Feature", properties: { kind: "label", label: `机位 ${index + 1}` }, geometry: { type: "Point", coordinates: at } });
  });
  const lines = run.items.filter((item) => item.points);
  const single = run.composition.time.mode === "instant" || (run.composition.time.mode === "range" && run.composition.time.days === 1);
  lines.forEach((item, index) => {
    const order = lines.length > 1 ? index / (lines.length - 1) : 0;
    const selected = item === state.current;
    const points = item.points!;
    const coordinates = points.map((point) => [point.longitude, point.latitude]);
    features.push(coordinates.length > 1
      ? { type: "Feature", properties: { kind: "segment", order, selected }, geometry: { type: "LineString", coordinates } }
      : { type: "Feature", properties: { kind: "segment-dot", order, selected }, geometry: { type: "Point", coordinates: coordinates[0] } });
    const label = (point: (typeof points)[number], text: string) =>
      features.push({ type: "Feature", properties: { kind: "label", label: text }, geometry: { type: "Point", coordinates: [point.longitude, point.latitude] } });
    if (selected) {
      const first = points[0], last = points.at(-1)!;
      label(first, clock(first.time, timeZone));
      if (last !== first) label(last, clock(last.time, timeZone));
      for (const point of points) if (point !== first && point !== last && clock(point.time, timeZone).endsWith("0")) label(point, clock(point.time, timeZone));
    } else if (single) {
      label(points[0], clock(points[0].time, timeZone));
      if (points.length > 1) label(points.at(-1)!, clock(points.at(-1)!.time, timeZone));
    } else {
      const middle = points[Math.floor(points.length / 2)];
      label(middle, `${dayWords(localDay(middle.time, timeZone)).split(" ")[0]} ${clock(middle.time, timeZone)}`);
    }
  });
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------- 面板

/** Wind and terrain notes shared by results: a coarser terrain read for a wide search. */
function CoarseNote({ sampler, latitude }: { sampler: LoadedSampler | null | undefined; latitude: number }) {
  if (!sampler?.zoom || sampler.zoom >= TERRAIN_ZOOM) return null;
  return <p className="alignment-hint">范围较大，地形按约 {Math.round(tilePixel(sampler.zoom, latitude))} m 像元读取。</p>;
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
  const state = profile.sight === "blocked" ? `在距机位 ${km(profile.blockedAt ?? 0)} km 处被地形挡住` : profile.sight === "clear" ? "未被地形挡住" : "经过缺少地形数据的地方";
  return (
    <figure className="position-profile">
      <svg viewBox="0 0 260 100" role="img" aria-label={`从机位到地面目标的地形剖面，全长 ${km(profile.length)} km：视线${state}`}>
        <path className="profile-ground" d={area} />
        <path className="profile-sight" d={sight} />
        {blocked.map((sample) => <circle key={sample.distance} className="profile-blocked" cx={x(sample.distance)} cy={y(sample.ground!)} r="1.6" />)}
        <circle className="profile-end" cx={x(0)} cy={y(samples[0].sight)} r="2.4" />
        <circle className="profile-end" cx={x(profile.length)} cy={y(samples.at(-1)!.sight)} r="2.4" />
      </svg>
      <figcaption>机位 → 地面目标 · {km(profile.length)} km · 视线{state}（只看地形，不含建筑与树木）</figcaption>
    </figure>
  );
}

/** 太阳 / 月亮 / 银心, or a named star or deep-sky target from the list. */
function BodyPicker({ body, onChange, name }: { body: AlignmentBody; onChange: (body: AlignmentBody) => void; name: string }) {
  const choice = body === "sun" || body === "moon" || body === "galactic-center" ? body : "fixed";
  const stars = fixedBodies.filter((item) => item.kind === "star"), deepSky = fixedBodies.filter((item) => item.kind === "deepSky");
  return (
    <div className="composition-body">
      <div className="alignment-bodies" role="radiogroup" aria-label="天体">
        {([["sun", "太阳"], ["moon", "月亮"], ["galactic-center", "银心"], ["fixed", "恒星与深空"]] as const).map(([value, label]) => (
          <label key={value}>
            <input type="radio" name={name} value={value} checked={choice === value} onChange={() => onChange(value === "fixed" ? deepSky.find((item) => item.id === "dso-ngc0224")?.id ?? stars[0].id : value)} />
            {label}
          </label>
        ))}
      </div>
      {choice === "fixed" && <label className="field">
        <span className="field-label">恒星或深空目标</span>
        <select aria-label="恒星或深空目标" value={body} onChange={(event) => onChange(event.target.value as AlignmentBody)}>
          <optgroup label="深空目标">{deepSky.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
          <optgroup label="亮星">{stars.map((item) => <option key={item.id} value={item.id}>{item.name}{item.magnitude !== null ? ` · ${item.magnitude.toFixed(1)} 等` : ""}</option>)}</optgroup>
        </select>
      </label>}
      {isFixedBody(body) && <p className="alignment-hint" title={`${bodyName(body)}方向相对恒星固定，标记按${sizeWord(body)}画出。`}>只在太阳低于 −6° 时搜索。</p>}
    </div>
  );
}

/** Frame place as two numbers (percent from the left and the top), for exact values; dragging is the usual way. */
function SpotFields({ spot, onChange, label }: { spot: FrameSpot; onChange: (spot: FrameSpot) => void; label: string }) {
  return (
    <div className="alignment-fields" role="group" aria-label={`${label}在画面中的位置`}>
      <NumberField label="自左" unit="%" min={0} max={100} step={1} value={Math.round(spot.x * 1000) / 10} onChange={(x) => onChange({ ...spot, x: x / 100 })} />
      <NumberField label="自上" unit="%" min={0} max={100} step={1} value={Math.round(spot.y * 1000) / 10} onChange={(y) => onChange({ ...spot, y: y / 100 })} />
    </div>
  );
}

function ToleranceField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const choices = (toleranceChoices as readonly number[]).includes(value) ? toleranceChoices : [...toleranceChoices, value].sort((a, b) => a - b);
  return (
    <label className="field">
      <span className="field-label">容差（画面高度）</span>
      <select aria-label="容差" value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {choices.map((choice) => <option key={choice} value={choice}>±{Number((choice * 100).toFixed(1))}%</option>)}
      </select>
    </label>
  );
}

function GroundEditor({ state, target }: { state: CompositionState; target: GroundSpec }) {
  const sized = target.reference === "ground" && target.height >= 10;
  return (
    <div className="composition-editor">
      <div className="alignment-actions">
        <button type="button" aria-pressed={state.placing === target.id} className={state.placing === target.id ? "is-active" : ""}
          onClick={() => state.setPlacing(state.placing === target.id ? null : target.id)}>{state.placing === target.id ? "取消点选" : "在地图上重新点选"}</button>
        <select aria-label="改用已接入地标" value={target.landmark ?? ""} onChange={(event) => {
          const landmark = landmarks.find((entry) => entry.id === event.target.value);
          if (landmark) state.setGroundPlace({ latitude: landmark.latitude, longitude: landmark.longitude, name: landmark.name, landmark: landmark.id, height: landmark.bounds.height }, target.id);
        }}>
          <option value="">或改用已接入地标…</option>
          {landmarks.map((landmark) => <option key={landmark.id} value={landmark.id}>{landmark.name}</option>)}
        </select>
      </div>
      <p className="alignment-hint">{target.latitude.toFixed(5)}, {target.longitude.toFixed(5)}</p>
      <fieldset className="alignment-aim">
        <legend>高度</legend>
        <label>
          <input type="radio" name={`reference-${target.id}`} checked={target.reference === "ground"} onChange={() => state.updateTarget(target.id, { reference: "ground", height: 0 })} />
          距地表（山顶填 0，塔顶、楼顶填其高度）
        </label>
        <label>
          <input type="radio" name={`reference-${target.id}`} checked={target.reference === "sea"} onChange={() => state.updateTarget(target.id, { reference: "sea", height: 3776, base: null })} />
          海拔
        </label>
        <NumberField label={target.reference === "sea" ? "海拔" : "距地表"} unit="m" min={target.reference === "sea" ? -500 : 0} max={target.reference === "sea" ? 9000 : 1000} step={1} value={target.height}
          onChange={(height) => state.updateTarget(target.id, { height, ...(target.reference === "ground" && height < 10 ? { base: null } : {}) })} />
      </fieldset>
      {target.reference === "sea" && <p className="alignment-hint" title="与应用的地形高程用同一套数值">海拔基准未核定。</p>}
      <label className="composition-check">
        <input type="checkbox" disabled={!sized} checked={target.base !== null}
          onChange={(event) => state.updateTarget(target.id, { base: event.target.checked ? Math.min(0.97, target.frame.y + 0.3) : null })} />
        设定底部在画面中的位置（定主体大小）
      </label>
      {!sized && <p className="alignment-hint">只用于距地表 10 m 以上的点。</p>}
      {canSkyline(target) && <label className="composition-check"
        title={`照片里的“山顶”随机位方向而变（从东北看富士山，剑峰被更高的火口缘挡住）：从每个机位看 ${SKYLINE_RADIUS} m 内的地形轮廓，取比最高处低不到 ${SKYLINE_DROP} m 的平台的中点对准`}>
        <input type="checkbox" checked={!!target.skyline} onChange={(event) => state.updateTarget(target.id, { skyline: event.target.checked })} />
        对准看得见的山顶（轮廓平台的中点）
      </label>}
      <SnapButton state={state} target={target} />
      {target.base !== null && <p className="alignment-hint" title="在预览中拖动底部短横调整">底部自上 {percent(target.base)}，主体约 {percent(target.base - target.frame.y)}。</p>}
      <SpotFields spot={target.frame} label={target.name} onChange={(frame) => state.moveTarget(target.id, frame)} />
      <ToleranceField value={target.tolerance} onChange={(tolerance) => state.updateTarget(target.id, { tolerance })} />
    </div>
  );
}

/** “移到附近最高点”: reads the terrain within 500 m and moves the point to its highest place. */
function SnapButton({ state, target }: { state: CompositionState; target: GroundSpec }) {
  // The note belongs to where the point was left: it disappears once the point moves elsewhere.
  const [note, setNote] = useState<{ text: string; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const here = `${target.latitude}/${target.longitude}`;
  return (
    <div className="alignment-actions composition-snap">
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true);
        setNote(await state.snapToHighest(target.id));
        setBusy(false);
      }}>{busy ? "读取地形中…" : "移到附近最高点"}</button>
      {note && note.at === here && <small className="alignment-hint" role="status">{note.text}</small>}
    </div>
  );
}

function SkyEditor({ state, target }: { state: CompositionState; target: SkySpec }) {
  return (
    <div className="composition-editor">
      <BodyPicker body={target.body} name={`body-${target.id}`} onChange={(body) => state.updateTarget(target.id, { body })} />
      <SpotFields spot={target.frame} label={bodyName(target.body)} onChange={(frame) => state.moveTarget(target.id, frame)} />
      <ToleranceField value={target.tolerance} onChange={(tolerance) => state.updateTarget(target.id, { tolerance })} />
    </div>
  );
}

function TargetsSection({ state }: { state: CompositionState }) {
  const { targets } = state.composition;
  const full = targets.length >= TARGET_LIMIT;
  return (
    <div className="alignment-section composition-targets">
      <h3>目标 <small>{targets.length}/{TARGET_LIMIT}</small></h3>
      {targets.length > 0 && <ol className="composition-target-list">
        {targets.map((target) => (
          <li key={target.id} className={state.selected === target.id ? "is-selected" : undefined} data-target={target.id}>
            <div className="composition-target-row">
              <span className={`composition-swatch composition-swatch-${target.kind === "ground" ? "ground" : bodyKind(target.body)}`} aria-hidden="true" />
              <button type="button" className="composition-target-name" aria-expanded={state.editing === target.id}
                onClick={() => { state.setSelected(target.id); state.setEditing(state.editing === target.id ? null : target.id); }}>
                <strong>{targetName(target)}</strong>
                <small>{target.kind === "ground" ? heightWords(target) : "天体"} · {spotWords(target.frame)} · ±{Number((target.tolerance * 100).toFixed(1))}%{target.kind === "ground" && target.base !== null ? ` · 主体约 ${percent(target.base - target.frame.y)}` : ""}</small>
              </button>
              <button type="button" className="composition-remove" aria-label={`删除目标 ${targetName(target)}`} onClick={() => state.removeTarget(target.id)}>×</button>
            </div>
            {state.editing === target.id && (target.kind === "ground" ? <GroundEditor state={state} target={target} /> : <SkyEditor state={state} target={target} />)}
          </li>
        ))}
      </ol>}
      {state.placing === "new" && <div className="composition-pending" role="status">
        <p>在地图上单击要拍的地方（山顶、塔等），Esc 取消；或选已接入地标：</p>
        <div className="alignment-actions">
          <select aria-label="选择地标" value="" onChange={(event) => {
            const landmark = landmarks.find((entry) => entry.id === event.target.value);
            if (landmark) state.setGroundPlace({ latitude: landmark.latitude, longitude: landmark.longitude, name: landmark.name, landmark: landmark.id, height: landmark.bounds.height }, "new");
          }}>
            <option value="">选择已接入地标…</option>
            {landmarks.map((landmark) => <option key={landmark.id} value={landmark.id}>{landmark.name}</option>)}
          </select>
          <button type="button" onClick={() => state.setPlacing(null)}>取消</button>
        </div>
      </div>}
      <div className="alignment-actions">
        <button type="button" disabled={full || state.placing === "new"} onClick={() => state.setPlacing("new")}>+ 地面点</button>
        <button type="button" disabled={full} onClick={() => state.addSky()}>+ 天体</button>
      </div>
      {!targets.length && <p className="alignment-hint">加一个地面点和一个天体，或两个天体，再在预览中拖动标记。</p>}
    </div>
  );
}

function RangeSection({ state, plan }: { state: CompositionState; plan: ShootingPlan }) {
  const { camera, time } = state.composition;
  const here = { latitude: plan.latitude, longitude: plan.longitude };
  const at = (point: { latitude: number; longitude: number }) => `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
  const moved = camera.mode !== "free" && (Math.abs(camera.latitude - plan.latitude) > 1e-6 || Math.abs(camera.longitude - plan.longitude) > 1e-6);
  const aimMoved = camera.mode === "fixed" && camera.aim && (Math.abs(camera.aim.azimuth - plan.azimuth) > 1e-4 || Math.abs(camera.aim.pitch - plan.pitch) > 1e-4);
  const fixedCamera = camera.mode === "fixed";
  return (
    <div className="alignment-section alignment-conditions composition-range">
      <h3>搜索范围</h3>
      <label className="field">
        <span className="field-label">机位</span>
        <select aria-label="机位范围" value={camera.mode} onChange={(event) => {
          const mode = event.target.value as CameraRange["mode"];
          state.setCamera(mode === "free" ? { mode, maxDistance: 30_000, minDistance: DEFAULT_NEAREST } : mode === "near" ? { mode, ...here, radius: 3_000 } : { mode, ...here, aim: null });
          if (mode !== "fixed" && time.mode === "range" && time.days > MAX_LINE_DAYS) state.setTime({ ...time, days: MAX_LINE_DAYS });
        }}>
          <option value="free">不限（以地面目标为中心）</option>
          <option value="near">当前机位周围</option>
          <option value="fixed">固定为当前机位</option>
        </select>
      </label>
      {camera.mode === "free" && <div className="alignment-fields">
        <label className="field">
          <span className="field-label">离地面目标最近</span>
          <select aria-label="机位最近距离" value={camera.minDistance} onChange={(event) => state.setCamera({ ...camera, minDistance: Number(event.target.value) })}
            title="排除贴近地面目标的机位（如站在山顶上）">
            {nearestChoices.filter((value) => value < camera.maxDistance).map((value) => <option key={value} value={value}>{nearestLabel(value)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">最远</span>
          <select aria-label="机位最远距离" value={camera.maxDistance} onChange={(event) => state.setCamera({ ...camera, maxDistance: Number(event.target.value) })}>
            {distanceChoices.filter((value) => value > camera.minDistance).map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label>
      </div>}
      {camera.mode === "near" && <>
        <label className="field">
          <span className="field-label">半径</span>
          <select aria-label="机位范围半径" value={camera.radius} onChange={(event) => state.setCamera({ ...camera, radius: Number(event.target.value) })}>
            {nearChoices.map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label>
        <p className="alignment-hint">中心 {at(camera)}{moved && <button type="button" onClick={() => state.setCamera({ ...camera, ...here })}>改用当前机位</button>}</p>
      </>}
      {camera.mode === "fixed" && <>
        <p className="alignment-hint">机位 {at(camera)}{moved && <button type="button" onClick={() => state.setCamera({ ...camera, ...here })}>改用当前机位</button>}</p>
        <label className="composition-check">
          <input type="checkbox" checked={!!camera.aim} onChange={(event) => state.setCamera({ ...camera, aim: event.target.checked ? { azimuth: plan.azimuth, pitch: plan.pitch } : null })} />
          同时固定当前朝向{camera.aim ? `（方位 ${camera.aim.azimuth.toFixed(1)}°，俯仰 ${camera.aim.pitch.toFixed(1)}°）` : ""}
        </label>
        {aimMoved && <p className="alignment-hint">当前方向已改变<button type="button" onClick={() => state.setCamera({ ...camera, aim: { azimuth: plan.azimuth, pitch: plan.pitch } })}>改用当前方向</button></p>}
      </>}
      <label className="field">
        <span className="field-label">时间</span>
        <select aria-label="时间范围" value={time.mode} onChange={(event) => state.setTime(event.target.value === "instant"
          ? { mode: "instant", instant: plan.instant }
          : { mode: "range", date: localDateTime(plan.instant, plan.timeZone).slice(0, 10), days: 30 })}>
          <option value="range">日期范围</option>
          <option value="instant">固定为当前时刻</option>
        </select>
      </label>
      {time.mode === "range" ? <div className="alignment-fields">
        <label className="field">
          <span className="field-label">起始日期</span>
          <input type="date" aria-label="起始日期" min="1900-01-01" max="2100-12-31" value={time.date}
            onChange={(event) => event.target.value && state.setTime({ ...time, date: event.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">跨度</span>
          <select aria-label="跨度" value={time.days} onChange={(event) => state.setTime({ ...time, days: Number(event.target.value) })}>
            {dayChoices.filter((days) => fixedCamera || days <= MAX_LINE_DAYS).map((days) => <option key={days} value={days}>{dayLabel(days)}</option>)}
          </select>
        </label>
      </div> : <p className="alignment-hint">
        {localDateTime(time.instant, plan.timeZone).replace("T", " ").slice(0, 16)}（{plan.timeZone}）
        {time.instant !== plan.instant && <button type="button" onClick={() => state.setTime({ mode: "instant", instant: plan.instant })}>改用当前时刻</button>}
      </p>}
    </div>
  );
}

const percentChoices = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

function FiltersSection({ state }: { state: CompositionState }) {
  const { filters } = state.composition;
  const replace = (index: number, filter: FilterSpec) => state.setFilters(filters.map((item, at) => (at === index ? filter : item)));
  const missing = (["sky", "moonDown", "moonLit", "darkSky"] as const).filter((kind) => !filters.some((filter) => filter.kind === kind));
  return (
    <div className="alignment-section composition-filters">
      <h3>筛选</h3>
      {filters.map((filter, index) => (
        <div key={filter.kind} className="composition-filter" data-filter={filter.kind}>
          {filter.kind === "sky" && <fieldset className="alignment-sky">
            <legend>天空条件</legend>
            {skyConditions.map((item) => (
              <label key={item}>
                <input type="checkbox" aria-label={`天空条件：${skyConditionNames[item]}`} checked={filter.sky.includes(item)}
                  onChange={() => {
                    const next = filter.sky.includes(item) ? filter.sky.filter((other) => other !== item) : skyConditions.filter((other) => other === item || filter.sky.includes(other));
                    if (next.length) replace(index, { kind: "sky", sky: next as SkyCondition[] });
                  }} />
                {skyConditionNames[item]}
              </label>
            ))}
          </fieldset>}
          {filter.kind === "moonDown" && <span>月亮在地平线下</span>}
          {filter.kind === "darkSky" && <label className="field">
            <span className="field-label">星空可见性</span>
            <select aria-label="星空可见性" value={filter.limit} onChange={(event) => replace(index, { kind: "darkSky", limit: Number(event.target.value) })}
              title="天顶天空亮度不亮于所选值（mag/arcsec²）：按自然天光、机位的光污染（World Atlas 2015）与月光合成，只在天文夜（太阳低于 −18°）判断。">
              {darkSkyChoices.map((choice) => <option key={choice.limit} value={choice.limit}>{choice.label} · {choice.limit}</option>)}
            </select>
          </label>}
          {filter.kind === "moonLit" && <div className="field alignment-phase" role="group" aria-label="月亮亮面范围">
            <span className="field-label">月亮亮面</span>
            <span>
              <select aria-label="亮面下限" value={filter.range[0]} onChange={(event) => replace(index, { kind: "moonLit", range: [Number(event.target.value), Math.max(Number(event.target.value), filter.range[1])] })}>
                {percentChoices.map((value) => <option key={value} value={value}>{percent(value)}</option>)}
              </select>
              —
              <select aria-label="亮面上限" value={filter.range[1]} onChange={(event) => replace(index, { kind: "moonLit", range: [Math.min(Number(event.target.value), filter.range[0]), Number(event.target.value)] })}>
                {percentChoices.map((value) => <option key={value} value={value}>{percent(value)}</option>)}
              </select>
            </span>
          </div>}
          <button type="button" className="composition-remove" aria-label={`删除筛选 ${filterNames[filter.kind]}`} onClick={() => state.setFilters(filters.filter((_, at) => at !== index))}>×</button>
        </div>
      ))}
      {missing.length > 0 && <select aria-label="添加筛选" value="" onChange={(event) => {
        const kind = event.target.value as FilterSpec["kind"];
        state.setFilters([...filters, kind === "sky" ? { kind, sky: ["twilight", "night"] } : kind === "moonDown" ? { kind } : kind === "darkSky" ? { kind, limit: 21.3 } : { kind, range: [0, 0.5] }]);
      }}>
        <option value="">+ 添加筛选…</option>
        {missing.map((kind) => <option key={kind} value={kind}>{filterNames[kind]}</option>)}
      </select>}
    </div>
  );
}

/** One result row: when, where and how far from the places; the Moon's state unless it is a target. */
function itemFacts(item: ResultItem, timeZone: string, moonTarget: boolean) {
  const span = item.start === item.end || item.end - item.start < MINUTE ? clock(item.best, timeZone) : `${clock(item.start, timeZone)}–${clock(item.end, timeZone)}`;
  const where = item.bearing !== null && item.near !== null
    ? `目标在${compassDirection(item.bearing)} · 距 ${item.near === item.far ? km(item.near) : `${km(item.near)}—${km(item.far!)}`} km`
    : `机位 ${item.camera.latitude.toFixed(4)}, ${item.camera.longitude.toFixed(4)}`;
  const moon = moonTarget ? `亮面 ${percent(item.moonLit)}` : item.moonElevation < 0 ? "月亮在地平线下" : `月亮高 ${item.moonElevation.toFixed(0)}° · 亮面 ${percent(item.moonLit)}`;
  const top = item.points?.find((point) => point.time === item.best)?.top;
  return {
    span,
    where: `${where}${item.share ? ` · 主体 ${percent(item.share[0])}—${percent(item.share[1])}` : ""}${top && top.offset > 30 ? ` · 对准的山顶离设定点 ${km(top.offset)} km` : ""}`,
    sky: `${skyConditionNames[item.sky]} · ${moon}${item.deviation >= 0.001 ? ` · 偏差 ${(item.deviation * 100).toFixed(1)}%` : ""}${item.clear < 1 ? " · 部分地形数据不全" : ""}`,
  };
}

function ResultsSection({ state, plan, occlusion, check }: {
  state: CompositionState;
  plan: ShootingPlan;
  occlusion: { state: string; occlusion: Occlusion } | null;
  check: ReturnType<typeof useFeasibility>;
}) {
  const { run, current } = state;
  // Camera places for two ground points are listed on their own, not by day.
  const places = run?.phase === "done" && run.shape === "places";
  const groups = useMemo(() => groupByDay(run?.phase === "done" && run.shape !== "places" ? run.items : []), [run]);
  const single = groups.length === 1;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ground = run?.basis.ground ?? null;
  const currentPoint = current?.points?.find((point) => point.time === Date.parse(plan.instant)) ?? null;
  const profile = useMemo(() => {
    if (!ground || !run?.sampler || !current?.points) return null;
    try {
      return positionProfile({ target: groundTarget(ground), cameraHeight: plan.cameraHeight }, plan, run.sampler);
    } catch {
      return null;
    }
  }, [ground, run?.sampler, current, plan.latitude, plan.longitude, plan.cameraHeight]);
  if (!run) return null;
  const done = run.phase === "done";
  const minutes = new Set(run.items.flatMap((item) => (item.points ? item.points.map((point) => point.time) : [item.best]))).size;
  const hidden = [
    run.blocked > 0 && (run.shape === "places" ? `${run.blocked} 个机位视线被地形挡住` : `另有 ${run.blocked} 分钟视线被地形挡住`),
    run.extraMissed > 0 && `${run.extraMissed} ${run.strategy.kind === "line" ? "分钟" : run.shape === "places" ? "个机位" : "次"}其他目标不在位置`,
    run.filtered > 0 && `${run.filtered} ${run.strategy.kind === "line" ? "分钟" : "次"}不满足筛选`,
    run.missing > 0 && `${run.missing} ${run.strategy.kind === "line" ? "分钟" : "次"}缺少光污染数据`,
    run.merged > 0 && `${run.merged} 段几乎重合的已合并`,
  ].filter(Boolean).join("，");
  const label = run.composition.time.mode === "instant" ? "所选时刻" : dayLabel(run.composition.time.days) === "当天" ? "当天" : `${dayLabel(run.composition.time.days)}内`;
  const slider = current ? (current.points
    ? { values: current.points.map((point) => point.time), index: current.points.findIndex((point) => point.time === Date.parse(plan.instant)) }
    : { values: Array.from({ length: Math.floor((current.end - current.start) / MINUTE) + 1 }, (_, index) => Math.ceil(current.start / MINUTE) * MINUTE + index * MINUTE).filter((time) => time <= current.end), index: -1 }) : null;
  if (slider && !current?.points) slider.index = slider.values.indexOf(Date.parse(plan.instant));
  const moonTarget = run.basis.bodies.includes("moon");
  const facts = (item: ResultItem) => itemFacts(item, run.timeZone, moonTarget);
  const firstYear = groups.length ? Temporal.PlainDate.from(groups[0].day).year : undefined;
  const words = (day: string) => dayWords(day, firstYear);
  return (
    <div className="alignment-section alignment-results" aria-label="推算结果">
      <h3>结果</h3>
      {run.phase === "running" && <p className="alignment-status" role="status">{run.stage}</p>}
      {run.phase === "error" && <p className="alignment-status is-error" role="status">{run.message === "已取消" ? "已取消。" : `搜索失败：${run.message}`}</p>}
      {done && (run.items.length
        ? <p className="alignment-status" role="status">{places ? `${run.items.length} 个机位` : `${label} ${groups.length} 天、${run.items.length} 段，共 ${minutes} 分钟`}{hidden && `；${hidden}`}</p>
        : <p className="alignment-status is-empty" role="status">{run.note || "没有结果。"}{hidden && `（${hidden}）`}</p>)}
      {done && run.items.length > 0 && run.note && <p className="alignment-hint is-warning">{run.note}</p>}
      {done && ground && <CoarseNote sampler={run.sampler} latitude={ground.latitude} />}
      {done && run.items.length > 0 && <CheckControls check={check} />}
      {current?.place && <p className="alignment-current" role="status">
        正在试看机位 {run.items.indexOf(current) + 1}
        {` · 距“${run.strategy.kind === "grounds" ? run.strategy.first.name : ""}” ${km(current.place.first.distance)} km、距“${run.strategy.kind === "grounds" ? run.strategy.second.name : ""}” ${km(current.place.second.distance)} km`}
      </p>}
      {current && !current.place && <>
        <p className="alignment-current" role="status">
          正在试看 {words(current.day)} {clock(Date.parse(plan.instant), plan.timeZone)}
          {currentPoint && ` · 距地面目标 ${km(currentPoint.distance)} km（目标在${compassDirection(currentPoint.azimuth)}）`}
          {occlusion && ` · ${occlusion.state === "画面内" ? occlusionText(occlusion.occlusion, plan) : occlusion.state}`}
        </p>
        {slider && slider.values.length > 1 && <label className="field alignment-scrub">
          <span className="field-label">在这段内移动（{current.points ? "机位与时刻一起" : "时刻"}）</span>
          <input type="range" min={0} max={slider.values.length - 1} step={1} value={Math.max(0, slider.index)} aria-label="在这段内移动"
            aria-valuetext={clock(slider.values[Math.max(0, slider.index)], plan.timeZone)}
            onChange={(event) => state.tryOut(current, slider.values[Number(event.target.value)])} />
        </label>}
        {profile && <ProfileChart profile={profile} />}
      </>}
      {(current || state.canRestore) && <div className="alignment-actions">
        <button type="button" disabled={!state.canRestore} onClick={state.restore}>返回推算前</button>
      </div>}
      {places && run.items.length > 0 && <ol className="position-list composition-places">
        {run.items.map((item, index) => {
          const facts = item.place!;
          const pair = run.strategy.kind === "grounds" ? run.strategy : null;
          const size = facts.reach.longest >= 4_999 ? "容差内范围超过 5 km" : `容差内约 ${Math.round(facts.reach.shortest * 2)}×${Math.round(facts.reach.longest * 2)} m`;
          return (
            <li key={item.key} className={item === current ? "is-current" : undefined} data-candidate={item.key}>
              <span className="alignment-when">
                <strong>机位 {index + 1}</strong>
                <small>{`“${pair?.first.name}”在${compassDirection(facts.first.azimuth)} ${km(facts.first.distance)} km · “${pair?.second.name}”在${compassDirection(facts.second.azimuth)} ${km(facts.second.distance)} km`}</small>
                <small>{`${size}${facts.moved >= 1 ? ` · 正中的视线被地形挡住，已移 ${Math.round(facts.moved)} m` : ""}${item.deviation >= 0.001 ? ` · 偏差 ${(item.deviation * 100).toFixed(1)}%` : ""}${facts.unknown ? " · 部分地形数据不全" : ""}`}</small>
                <CheckTag check={check.result(item.key)} />
              </span>
              <button type="button" aria-label={`试看 机位 ${index + 1}`} aria-pressed={item === current} onClick={() => state.tryOut(item)}>试看</button>
            </li>
          );
        })}
      </ol>}
      {groups.length > 0 && <ol className="composition-days">
        {groups.map((group) => {
          const expanded = single || open.has(group.day);
          const near = group.items.flatMap((item) => (item.near === null ? [] : [item.near])), far = group.items.flatMap((item) => (item.far === null ? [] : [item.far]));
          const skies = [...new Set(group.items.map((item) => skyConditionNames[item.sky]))].join("、");
          const moonDown = group.items.every((item) => item.moonElevation < 0);
          const best = group.items.reduce((pick, item) => (item.deviation < pick.deviation ? item : pick), group.items[0]);
          const isCurrent = group.items.includes(current!);
          return (
            <li key={group.day} className={isCurrent ? "is-current" : undefined} data-day={group.day}>
              <div className="composition-day">
                <button type="button" className="composition-day-name" aria-expanded={expanded} disabled={single}
                  onClick={() => setOpen((set) => { const next = new Set(set); if (next.has(group.day)) next.delete(group.day); else next.add(group.day); return next; })}>
                  <strong>{words(group.day)}{run.night ? "夜" : ""} {daySpans(group.items).map((span) => `${clock(span.start, run.timeZone)}–${clock(span.end, run.timeZone)}`).join("、")}</strong>
                  <small>{group.items.length} 段{near.length ? ` · 距 ${km(Math.min(...near))}—${km(Math.max(...far))} km` : ""} · {skies}{moonTarget ? "" : ` · ${moonDown ? "月亮在地平线下" : "月亮在天上"}`}</small>
                </button>
                <button type="button" aria-label={`试看 ${words(group.day)}`} aria-pressed={isCurrent} onClick={() => state.tryOut(best)}>试看</button>
              </div>
              {expanded && <ol className="position-list">
                {group.items.map((item) => {
                  const line = facts(item);
                  return (
                    <li key={item.key} className={item === current ? "is-current" : undefined} data-candidate={item.key}>
                      <span className="alignment-when">
                        <strong>{line.span}</strong>
                        <small>{line.where}</small>
                        <CheckTag check={check.result(item.key)} />
                      </span>
                      <span className="alignment-facts">{line.sky}</span>
                      <button type="button" aria-label={`试看 ${words(item.day)} ${line.span}`} aria-pressed={item === current} onClick={() => state.tryOut(item)}>试看</button>
                    </li>
                  );
                })}
              </ol>}
            </li>
          );
        })}
      </ol>}
      {done && <p className="alignment-note"
        title={`机位眼睛高度为地面加离地 ${plan.cameraHeight} m，天体按${plan.refraction === "standard" ? "标准折射" : "无折射"}与海平面地平计算${run.worker ? "；在后台线程计算" : ""}。`}>
        遮挡只看地形，不含建筑、树木与天气。
      </p>}
    </div>
  );
}

/** Right-rail 推算 panel: templates, targets, search range, filters, search and results. */
export function CompositionPanel({ state, plan, occlusion, saving }: {
  state: CompositionState;
  plan: ShootingPlan;
  saving?: ShotSaving;
  occlusion: { state: string; occlusion: Occlusion } | null;
}) {
  const check = useFeasibility(state.checkTargets, plan.cameraHeight);
  const { solvability } = state;
  return (
    <section className="alignment-panel composition-panel" aria-label="推算">
      <header className="alignment-header">
        <div className="composition-templates" role="group" aria-label="模板">
          <span>模板：</span>
          {templates.map((template) => <button key={template.id} type="button" title={template.hint} onClick={() => state.applyTemplate(template.id)}>{template.name}</button>)}
        </div>
      </header>
      <TargetsSection state={state} />
      <RangeSection state={state} plan={plan} />
      <FiltersSection state={state} />
      <div className="alignment-section composition-search">
        <p className={`composition-solvability ${solvability.strategy ? "" : "is-warning"}`} role="status">{solvability.message}</p>
        <div className="alignment-actions">
          <button type="button" className="composition-search-button" disabled={!solvability.strategy || state.running} onClick={state.search}>{state.run?.phase === "done" && !state.stale ? "重新搜索" : "搜索"}</button>
          {state.running && <button type="button" onClick={state.cancel}>取消</button>}
        </div>
        {state.stale && state.run?.phase === "done" && <p className="alignment-hint is-warning" role="status">条件已改，请重新搜索。</p>}
      </div>
      <ResultsSection state={state} plan={plan} occlusion={occlusion} check={check} />
      <SolveExport state={state} plan={plan} saving={saving} />
    </section>
  );
}
