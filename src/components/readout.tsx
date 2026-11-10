import type { ReactNode } from "react";
import { compassDirection } from "../domain/plan";

/** Spoken direction and height, e.g. "西南 · 高 37°", the conclusion before exact numbers. */
export function where(azimuth: number, elevation: number) {
  return `${compassDirection(azimuth)} · 高 ${Math.round(elevation)}°`;
}

/** Exact values and model notes: shown only while "显示详细数值" is on. */
export function Detail({ children }: { children: ReactNode }) {
  return <small className="info-detail">{children}</small>;
}

// Natural zenith sky brightness of the light-pollution atlas, mcd/m².
const NATURAL_MCD = 0.174;

/** Qualitative level from the artificial-to-natural zenith brightness ratio of the 2015 atlas. */
export function pollutionLevel(artificialMcd: number) {
  const ratio = artificialMcd / NATURAL_MCD;
  if (ratio < 0.08) return "几乎无光污染";
  if (ratio < 0.35) return "轻微光污染";
  if (ratio < 1) return "中等光污染，银河对比度降低";
  if (ratio < 3) return "较重光污染，银河难以呈现";
  return "严重光污染，只剩亮星";
}

/** Total cloud cover (0—1) in words. */
export function cloudLevel(cover: number) {
  if (cover < 0.2) return "晴朗";
  if (cover < 0.5) return "少云";
  if (cover < 0.8) return "多云";
  return "阴天";
}
