import { useEffect, useRef, useState } from "react";
import { CHECK_LIMIT, CHECK_RADIUS, CHECK_TILE_LIMIT, CHECK_ZOOM, checkLabel, checkPlace, checkPoints, fitTargets, indexFeatures } from "../../domain/solve/feasibility";
import type { CheckTarget, PlaceCheck } from "../../domain/solve/feasibility";
import { DEFAULT_TERRAIN_URL, DEFAULT_WATER_URL, terrainTile } from "../../domain/core/terrain";

const terrainUrl = import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
const featureUrl = import.meta.env.VITE_WATER_TILEJSON_URL?.trim() || DEFAULT_WATER_URL;
const tileOf = (point: { latitude: number; longitude: number }) => {
  const tile = terrainTile(point, CHECK_ZOOM);
  return `${tile.x}/${tile.y}`;
};

interface CheckRun {
  basis: string;
  phase: "loading" | "done" | "error";
  progress: readonly [number, number];
  results: Map<string, PlaceCheck>;
  checked: number;
  total: number;
  tiles: number;
  fetched: number;
  message: string;
}

/**
 * "检查机位", run on request for the listed camera places. The results belong
 * to those places and the camera height: when either changes they are no longer shown.
 */
export function useFeasibility(targets: readonly CheckTarget[], cameraHeight: number) {
  const basis = `${cameraHeight}/${targets.map((target) => target.key).join("|")}`;
  const [run, setRun] = useState<CheckRun | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const current = run?.basis === basis ? run : null;
  const start = async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const { targets: chosen } = fitTargets(targets, tileOf);
    const points = chosen.flatMap(checkPoints);
    const set = (patch: Partial<CheckRun>) => setRun((state) => (state && state.basis === basis && controller.current === abort ? { ...state, ...patch } : state));
    setRun({ basis, phase: "loading", progress: [0, 0], results: new Map(), checked: chosen.length, total: targets.length, tiles: 0, fetched: 0, message: "" });
    try {
      const [elevation, loader] = await Promise.all([import("../../io/elevation"), import("../../io/feasibility")]);
      const sampler = await elevation.elevationTiles(points, terrainUrl, abort.signal);
      const loaded = await loader.loadFeatures(points, featureUrl, abort.signal, (done, total) => set({ progress: [done, total] }));
      if (abort.signal.aborted) return;
      const index = indexFeatures(loaded.features);
      set({ phase: "done", results: new Map(chosen.map((target) => [target.key, checkPlace(target, index, sampler)])), tiles: loaded.tiles, fetched: loaded.fetched });
    } catch (error) {
      if (abort.signal.aborted) return;
      set({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const result = (key: string) => (current?.phase === "done" ? current.results.get(key) ?? null : null);
  return { available: targets.length > 0, run: current, start, result };
}
export type Feasibility = ReturnType<typeof useFeasibility>;

const problem = (check: PlaceCheck) => check.water || check.inside || !!check.blocked;

/** The tag under a result row once it has been checked. */
export function CheckTag({ check }: { check: PlaceCheck | null }) {
  if (!check) return null;
  return <small className={`feasibility-tag ${problem(check) ? "is-problem" : check.unknown ? "is-unknown" : "is-clear"}`}>{checkLabel(check)}</small>;
}

/** The button, progress and summary; `single` shows the one result (找时间's camera) inline. */
export function CheckControls({ check, single }: { check: Feasibility; single?: string }) {
  const run = check.run;
  if (!check.available) return null;
  const results = run?.phase === "done" ? [...run.results.values()] : [];
  const count = (test: (item: PlaceCheck) => boolean) => results.filter(test).length;
  const one = single ? check.result(single) : null;
  return (
    <div className="feasibility" aria-label="检查机位">
      <div className="alignment-actions">
        <button type="button" disabled={run?.phase === "loading"} onClick={check.start}
          title={`读取 OpenFreeMap 的水体与建筑轮廓（OpenStreetMap 贡献者），只查机位本身与视线前 ${CHECK_RADIUS / 1000} km；建筑高度可能由层数推算，资料不一定完整，不含树木、桥梁与可达性。`}>
          {run?.phase === "loading" ? `检查中 ${run.progress[0]}/${run.progress[1] || "…"}` : run?.phase === "done" ? "重新检查机位" : run?.phase === "error" ? "重试检查" : "检查机位（水面、建筑）"}
        </button>
      </div>
      {run?.phase === "error" && <p className="field-error" role="status">检查失败：{run.message}</p>}
      {run?.phase === "done" && (one
        ? <p className="feasibility-summary" role="status">当前机位：<CheckTag check={one} /></p>
        : <p className="feasibility-summary" role="status">
          检查了 {run.checked}/{run.total} 个机位：水面 {count((item) => item.water)}、建筑轮廓内 {count((item) => item.inside)}、
          {CHECK_RADIUS / 1000} km 内被建筑挡住 {count((item) => !!item.blocked)}、未发现问题 {count((item) => !problem(item) && !item.unknown)}
          {count((item) => item.unknown) > 0 && `、地形数据不全 ${count((item) => item.unknown)}`}。读取 {run.tiles} 块矢量瓦片（新下载 {run.fetched} 块）。
          {run.checked < run.total && ` 只检查了前 ${run.checked} 个（单次最多 ${CHECK_LIMIT} 个机位、${CHECK_TILE_LIMIT} 块瓦片）。`}
        </p>)}
    </div>
  );
}
