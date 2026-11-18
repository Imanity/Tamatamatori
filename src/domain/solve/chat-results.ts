import { parseShot } from "../shots/shot.ts";
import type { Shot } from "../shots/shot.ts";
import type { ResultItem, Shape } from "./composition.ts";
import type { SolveRequest2 } from "./solve.ts";

/** Internal local-chat protocol; public shot and solve formats stay unchanged. */
export interface ChatShots {
  kind: "shots";
  id: string;
  shots: Shot[];
  total: number;
}
export interface ChatSolve {
  kind: "solve";
  id: string;
  base: Shot;
  request: SolveRequest2;
  shape: Shape;
  items: ResultItem[];
  total: number;
  blocked: number;
  filtered: number;
  missing: number;
  merged: number;
  extraMissed: number;
  sectors: [number, number][];
  rings: { latitude: number; longitude: number; radius: number }[];
  note: string;
}
export type ChatResult = ChatShots | ChatSolve;
export const CHAT_CANDIDATES = 200;
export const CHAT_TRACK_POINTS = 10_000;
export const resultSize = (result: ChatResult) => result.kind === "shots" ? result.shots.length : result.items.length;
export const trackSize = (result: ChatResult) => result.kind === "solve" ? result.items.reduce((count, item) => count + (item.points?.length ?? 0), 0) : 0;

/** Keep complete intervals, never a sampled path masquerading as the full solution. */
export function limitChatResult(result: ChatResult, candidates = CHAT_CANDIDATES, points = CHAT_TRACK_POINTS): ChatResult {
  if (result.kind === "shots") return { ...result, shots: result.shots.slice(0, candidates) };
  let used = 0;
  const items = [];
  for (const item of result.items.slice(0, candidates)) {
    used += item.points?.length ?? 0;
    if (used > points) break;
    items.push(item);
  }
  return { ...result, items };
}

/** Local server owns solve packets; validate the envelope before rendering stored/streamed data. */
export function isChatResult(value: unknown): value is ChatResult {
  const result = value as ChatResult | null;
  if (!result || typeof result.id !== "string" || !Number.isSafeInteger(result.total) || result.total < 0) return false;
  if (result.kind === "shots") return Array.isArray(result.shots) && result.shots.length <= Math.min(CHAT_CANDIDATES, result.total) && result.shots.every(shot => parseShot(shot).ok);
  return result.kind === "solve" && parseShot(result.base).ok && result.request?.format === "tamatamatori.solve" && result.request.version === 2 &&
    !!result.request.camera?.mode && !!result.request.time?.mode && Array.isArray(result.request.filters) &&
    Array.isArray(result.request.targets) && result.request.targets.every(target => !!target && Number.isFinite(target.frame?.x) && Number.isFinite(target.frame?.y)) &&
    ["lines", "points", "windows", "places"].includes(result.shape) && Array.isArray(result.items) && result.items.length <= Math.min(CHAT_CANDIDATES, result.total) &&
    result.items.every(item => !!item && typeof item.key === "string" && Number.isFinite(item.start) && Number.isFinite(item.end) && Number.isFinite(item.best) &&
      item.start <= item.best && item.best <= item.end && Number.isFinite(item.camera?.latitude) && Number.isFinite(item.camera?.longitude) &&
      (item.points === null || (Array.isArray(item.points) && item.points.length > 0 && item.points.every(point =>
        !!point && Number.isFinite(point.time) && point.time >= item.start && point.time <= item.end && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
        Number.isFinite(point.azimuth) && Number.isFinite(point.elevation) && Number.isFinite(point.cameraGround))))) &&
    Array.isArray(result.rings) && Array.isArray(result.sectors) && typeof result.note === "string" && trackSize(result) <= CHAT_TRACK_POINTS;
}
