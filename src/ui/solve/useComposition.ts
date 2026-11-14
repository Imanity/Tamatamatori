// The 推算 state shared by the map, the preview marks, the timeline and the
// panel: conditions, search runs and try-outs. The solvers, the panel and the
// map geometry are the 推算 module (solve-module.ts), read when the mode is
// first entered (docs/plan/lazy-loading.md); until then the state is null.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CameraRange, Composition, FilterSpec, FrameSpot, GroundSpec, ResultItem, SearchBasis, Shape, SkySpec, Strategy, TargetSpec, TimeRange } from "../../domain/solve/composition";
import type { AlignmentBody } from "../../domain/solve/alignment";
import type { LoadedSampler } from "../../domain/solve/composition-run";
import type { TriedLayers } from "../../domain/solve/position-alignment";
import { localDateTime, normalizeLongitude } from "../../domain/core/plan";
import type { ShootingPlan } from "../../domain/core/plan";
import { DEFAULT_TERRAIN_URL } from "../../domain/core/terrain";
import type { TimelineEvent } from "../../domain/time/timeline";
import type { SolveRequest2 } from "../../domain/solve/solve";
import type { CheckTarget } from "../../domain/solve/feasibility";
import { lazyModule } from "../common/lazy-module";
import { MINUTE, iso, km } from "./composition-format";

/** The 推算 module, read on first use. */
export type SolveModule = typeof import("./solve-module");
export const solveModule = lazyModule<SolveModule>(() => import("./solve-module"));

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;
const terrainUrl = import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
/** “移到附近最高点” looks this far around the point, metres. */
const SNAP_RADIUS = 500;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
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
const initialComposition = (plan: ShootingPlan, solve: SolveModule): Composition => ({
  targets: [],
  camera: { mode: "free", maxDistance: 30_000, minDistance: solve.DEFAULT_NEAREST },
  time: { mode: "range", date: localDateTime(plan.instant, plan.timeZone).slice(0, 10), days: 30 },
  filters: [],
});
/** Everything a result depends on: when it differs from the run's, the results are stale. */
function searchKey(composition: Composition, plan: ShootingPlan, lensOf: SolveModule["lensOf"]) {
  const pairCamera = composition.camera.mode !== "fixed" && composition.targets.every((target) => target.kind === "sky") ? [plan.latitude, plan.longitude] : [];
  return JSON.stringify([composition, lensOf(plan), plan.timeZone, plan.cameraHeight, plan.refraction, pairCamera, terrainUrl]);
}
/**
 * State of the 推算 panel (构图约束搜索): the targets and where they go in the
 * frame, the search range and filters, an explicit search and its results,
 * and the try-out. Results belong to the search that made them; editing the
 * conditions marks them stale until the next search. Null until `solve`, the
 * 推算 module, has been read.
 */
export function useComposition(plan: ShootingPlan, update: UpdatePlan, active: boolean, generation: number, solve: SolveModule | null) {
  // Null until the mode is first entered (or a request is loaded).
  const [stored, setComposition] = useState<Composition | null>(null);
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
  /** Opens a request (from a link) on the plan it was loaded into, then searches once the conditions are in. */
  const [loaded, setLoaded] = useState(0);
  const afterLoad = useRef(() => {});

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
  // The conditions start from the shooting date when the mode is first entered.
  useEffect(() => {
    if (solve && active && !stored) setComposition(initialComposition(latest.current, solve));
  }, [solve, active]);
  useEffect(() => {
    if (loaded) afterLoad.current();
  }, [loaded]);

  const done = run?.phase === "done" ? run : null;
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

  if (!solve) return null;
  const { classify, DEFAULT_TOLERANCE, lensOf, newId, nightSearch, TARGET_LIMIT, templates, tryPatch, runComposition, searchBasis, highestNear, restoredLayers, travel, triedLayers, compositionOf, requestOf, runRange } = solve;
  const composition = stored ?? initialComposition(plan, solve);
  const change = (next: (current: Composition) => Composition) => setComposition((current) => next(current ?? initialComposition(latest.current, solve)));
  /** Moves a ground point to the highest terrain within SNAP_RADIUS; returns what happened, for the button. */
  const snapToHighest = async (id: string): Promise<{ text: string; at: string } | null> => {
    const target = composition.targets.find((entry): entry is GroundSpec => entry.id === id && entry.kind === "ground");
    if (!target) return null;
    const at = (point: { latitude: number; longitude: number }) => `${point.latitude}/${point.longitude}`;
    const note = (text: string, point: { latitude: number; longitude: number } = target) => ({ text, at: at(point) });
    try {
      const elevation = await import("../../io/elevation");
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
  const key = searchKey(composition, plan, lensOf);
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
    const now = latest.current, snapshot = composition;
    const basis = searchBasis(strategy, snapshot, now);
    setRun({
      id, key: searchKey(snapshot, now, lensOf), phase: "running", stage: "准备中…", shape: solvability.shape, strategy, basis, composition: snapshot, timeZone: now.timeZone, night: nightSearch(snapshot, strategy),
      items: [], blocked: 0, filtered: 0, merged: 0, extraMissed: 0, missing: 0, sectors: [], rings: [], sampler: null, note: "", message: "", worker: false,
    });
    try {
      // The search itself (src/domain/solve/composition-run.ts), with the browser's terrain and light pollution and the worker.
      const outcome = await runComposition(strategy, snapshot, now, {
        terrain: async (points, signal, progress) => (await import("../../io/elevation")).elevationTiles(points, terrainUrl, signal, progress),
        lightPollution: async (place, signal) => (await import("../../io/light-pollution")).sampleLightPollution(place, signal),
        solveDays: runRange,
        report: (patch) => set(id, patch),
      }, abort.signal);
      if (outcome) set(id, { phase: "done", ...outcome });
    } catch (error) {
      if (abort.signal.aborted) return;
      set(id, { phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const cancel = () => {
    controller.current?.abort();
    setRun((state) => (state && state.phase === "running" ? { ...state, phase: "error", message: "已取消" } : state));
  };

  // ------------------------------------------------------------ 试看
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

  const load = (request: SolveRequest2, opened: ShootingPlan) => {
    controller.current?.abort();
    setComposition(compositionOf(request, opened));
    setRun(null);
    setSelected(null);
    setEditing(null);
    setPlacing(null);
    setLoaded((value) => value + 1);
  };
  afterLoad.current = () => {
    if (active && solvability.strategy) void search();
  };
  const request = (): SolveRequest2 | null => {
    if (!composition.targets.length) return null;
    const now = latest.current;
    return requestOf(composition, lensOf(now), { timeZone: now.timeZone, cameraHeight: now.cameraHeight });
  };

  return {
    module: solve, active, composition, setComposition, solvability, selected, setSelected, editing, setEditing, placing, setPlacing,
    updateTarget, removeTarget, addSky, setGroundPlace, moveTarget, applyTemplate, snapToHighest,
    setCamera: (camera: CameraRange) => change((state) => ({ ...state, camera })),
    setTime: (time: TimeRange) => change((state) => ({ ...state, time })),
    setFilters: (filters: FilterSpec[]) => change((state) => ({ ...state, filters })),
    run, stale, running, search, cancel, items, current, tryOut, restore, canRestore: !!before, events, checkTargets, load, request,
    placeTarget: (longitude: number, latitude: number) => setGroundPlace({ latitude, longitude: normalizeLongitude(longitude), name: "地图上选的点" }),
  };
}
export type CompositionState = NonNullable<ReturnType<typeof useComposition>>;
