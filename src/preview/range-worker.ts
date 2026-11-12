import { rangeCorridor, rangeTrack, reachableSectors, solveRangeDay } from "../domain/range-alignment.ts";
import type { RangeInput, RangePoint } from "../domain/range-alignment.ts";
import type { SkySample } from "../domain/position-alignment.ts";
import { tileSampler } from "../domain/terrain.ts";
import type { ElevationTile } from "../domain/terrain.ts";

export interface RangeDay {
  day: string;
  start: number;
  end: number;
}
/**
 * "两者都找" in two steps: `plan` finds each day's usable minutes and the DEM
 * corridor; once the main thread has loaded those tiles, `solve` (with the
 * tiles, structured-cloned once) solves day by day.
 */
export type RangeMessage =
  | { type: "plan"; id: number; input: RangeInput; days: RangeDay[] }
  | { type: "solve"; id: number; tiles: [string, ElevationTile][]; bounds?: number[] };
export type RangeReply =
  | { id: number; type: "planned"; corridor: { latitude: number; longitude: number }[]; sectors: [number, number][]; minutes: number }
  | { id: number; type: "day"; index: number; points: RangePoint[] }
  | { id: number; type: "done" }
  | { id: number; type: "error"; message: string };

/** The worker's job, free of worker globals so it runs in tests and on the main thread alike. */
export function rangeWorker(post: (reply: RangeReply) => void) {
  let planned: { id: number; input: RangeInput; days: RangeDay[]; tracks: SkySample[][] } | null = null;
  return (message: RangeMessage) => {
    try {
      if (message.type === "plan") {
        const tracks = message.days.map((day) => rangeTrack(message.input, day));
        planned = { ...message, tracks };
        post({ id: message.id, type: "planned", corridor: rangeCorridor(message.input, tracks), sectors: reachableSectors(tracks),
          minutes: tracks.reduce((sum, track) => sum + track.length, 0) });
        return;
      }
      if (!planned || planned.id !== message.id) throw new Error("推算计划缺失，请重试");
      const { input, days, tracks } = planned;
      const sampler = tileSampler(new Map(message.tiles), message.bounds);
      days.forEach((day, index) => post({ id: message.id, type: "day", index, points: solveRangeDay(input, day, tracks[index], sampler) }));
      post({ id: message.id, type: "done" });
    } catch (error) {
      post({ id: message.id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
}
