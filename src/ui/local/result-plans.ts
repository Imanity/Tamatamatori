import { classify, tryPatch } from "../../domain/solve/composition";
import { searchBasis } from "../../domain/solve/composition-run";
import { compositionOf } from "../../domain/solve/solve";
import { planFromShot, shotFromPlan } from "../../domain/shots/shot";
import type { ChatSolve } from "../../domain/solve/chat-results";
import type { ResultItem } from "../../domain/solve/composition";

export function resultTimes(item: ResultItem): number[] {
  if (item.points) return item.points.map(point => point.time);
  const minutes = Array.from({ length: Math.max(0, Math.floor(item.end / 60_000) - Math.ceil(item.start / 60_000) + 1) },
    (_, index) => Math.ceil(item.start / 60_000) * 60_000 + index * 60_000);
  return [...new Set([item.start, ...minutes, item.best, item.end])].sort((a, b) => a - b);
}

export function resultShot(result: ChatSolve, item: ResultItem, time = item.best) {
  const plan = planFromShot(result.base), composition = compositionOf(result.request, plan);
  const strategy = classify(composition).strategy;
  if (!strategy) throw new Error("推算结果的条件无法读取");
  return shotFromPlan({ ...plan, ...tryPatch(item, searchBasis(strategy, composition, plan), plan.layers, time) },
    `${result.request.name || "推算结果"} ${result.items.indexOf(item) + 1}`);
}
