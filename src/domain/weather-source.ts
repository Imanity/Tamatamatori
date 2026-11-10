/**
 * Which model Open-Meteo's "best_match" uses. The API does not say, and its
 * choice changes with place and lead time (Tokyo: JMA for about three days,
 * then ECMWF), so the hourly cloud cover of best_match is compared with the
 * candidate models fetched in the same request. Only cloud cover is compared:
 * it is what drives the preview; other variables (e.g. visibility) may come
 * from yet another model.
 */
export const bestMatchCandidates = [
  { id: "jma_seamless", label: "日本气象厅 JMA" },
  { id: "kma_seamless", label: "韩国气象厅 KMA" },
  { id: "ukmo_seamless", label: "英国气象局 UKMO" },
  { id: "meteofrance_seamless", label: "法国气象局 Météo-France" },
  { id: "meteoswiss_icon_seamless", label: "瑞士气象局 MeteoSwiss" },
  { id: "italia_meteo_arpae_icon_2i", label: "意大利 ItaliaMeteo" },
  { id: "icon_seamless", label: "德国气象局 DWD ICON" },
  { id: "gfs_seamless", label: "美国 NOAA GFS" },
  { id: "gem_seamless", label: "加拿大环境部 GEM" },
  { id: "cma_grapes_global", label: "中国气象局 CMA" },
  { id: "bom_access_global", label: "澳大利亚气象局 BOM" },
  // The Nordic and Dutch "seamless" models fall back to ECMWF outside their
  // domains, so ECMWF comes before them: an exact tie with ECMWF means ECMWF.
  { id: "ecmwf_ifs", label: "欧洲中期天气预报中心 ECMWF" },
  { id: "metno_seamless", label: "挪威气象局 MET Norway" },
  { id: "knmi_seamless", label: "荷兰皇家气象研究所 KNMI" },
  { id: "dmi_seamless", label: "丹麦气象局 DMI" },
] as const;

/** Hourly total cloud cover (%) of best_match and each candidate, aligned in time. */
export interface BestMatchSeries {
  times: number[];
  bestMatch: (number | null)[];
  candidates: Record<string, (number | null)[]>;
}

export function parseBestMatchSeries(value: unknown): BestMatchSeries {
  const hourly = (value as { hourly?: Record<string, unknown> } | null)?.hourly;
  const times = hourly?.time, bestMatch = hourly?.cloud_cover_best_match;
  const valid = (series: unknown): series is (number | null)[] =>
    Array.isArray(series) && Array.isArray(times) && series.length === times.length &&
    series.every((entry) => entry === null || (typeof entry === "number" && Number.isFinite(entry)));
  if (!Array.isArray(times) || !times.every((time) => Number.isSafeInteger(time)) || !valid(bestMatch))
    throw new Error("自动匹配来源数据格式无效");
  const candidates: Record<string, (number | null)[]> = {};
  for (const { id } of bestMatchCandidates) {
    const series = hourly![`cloud_cover_${id}`];
    if (valid(series)) candidates[id] = series;
  }
  return { times: (times as number[]).map((time) => time * 1000), bestMatch, candidates };
}

// A source needs at least this many consecutive matching hours around the
// shooting hour; shorter agreements are coincidences (clear or overcast hours).
const MIN_RUN = 3;
const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.5;

/**
 * The candidate whose cloud cover matches best_match for the longest run of
 * hours around the shooting instant, ties broken by agreement over the whole
 * series and then by the order above. Null when nothing matches long enough.
 */
export function bestMatchSource(series: BestMatchSeries, instant: string) {
  const time = Date.parse(instant), { times, bestMatch } = series;
  if (!Number.isFinite(time) || !times.length || time < times[0] || time > times.at(-1)!) return null;
  const index = Math.round((time - times[0]) / 3_600_000);
  let best: { id: string; label: string; run: number; total: number } | null = null;
  // Earlier candidates win exact ties (the list order).
  for (const { id, label } of bestMatchCandidates) {
    const values = series.candidates[id];
    if (!values || !same(bestMatch[index], values[index])) continue;
    let from = index, to = index;
    while (from > 0 && same(bestMatch[from - 1], values[from - 1])) from--;
    while (to < times.length - 1 && same(bestMatch[to + 1], values[to + 1])) to++;
    const run = to - from + 1;
    if (run < MIN_RUN) continue;
    const total = values.filter((value, hour) => same(bestMatch[hour], value)).length;
    if (!best || run > best.run || (run === best.run && total > best.total)) best = { id, label, run, total };
  }
  return best ? { id: best.id, label: best.label } : null;
}
