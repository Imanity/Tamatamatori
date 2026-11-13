import { rangeTrack, rangeCorridor, reachableSectors, solveRangeDay } from "../domain/range-alignment";
import type { RangeInput, RangePoint } from "../domain/range-alignment";
import type { GroundSampler } from "../domain/position-alignment";
import type { ElevationTile } from "../domain/terrain";
import { fixedPlace, isFixedBody } from "../domain/sky-targets";
import type { RangeDay, RangeMessage, RangeReply } from "../preview/range-worker";

/**
 * Runs a range search: the day plan (usable minutes, corridor), the terrain tiles,
 * then the days. A module worker does the heavy parts when the browser has one;
 * otherwise (or if the worker fails to start) the main thread does them day by day.
 */
export async function runRange(input: RangeInput, days: RangeDay[], signal: AbortSignal, hooks: {
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
  hooks.planned(reachableSectors(tracks, input.frames));
  const sampler = await hooks.loadTiles(rangeCorridor(input, tracks));
  for (let index = 0; index < days.length; index++) {
    await yieldNow();
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    hooks.day(index, solveRangeDay(input, days[index], tracks[index], sampler));
  }
  return sampler;
}

