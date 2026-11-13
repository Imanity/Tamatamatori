import { useEffect, useMemo, useState } from "react";
import type { ShootingPlan } from "../../domain/core/plan";
import { localClockTime, localDateTime } from "../../domain/core/plan";
import { timelineMode, timelineWindow } from "../../domain/time/timeline";
import { NoSeaError, TIDE_FAR_KM, TIDE_TTL, TideRangeError, tideCovers, tideExtremes, tideHeight, tideKey, tideNow } from "../../domain/environment/tides";
import type { TideSeries } from "../../domain/environment/tides";
import { loadTides } from "../../io/tides";
import { Detail } from "../common/readout";

export interface TideFeed {
  phase: "off" | "loading" | "ready" | "error" | "range" | "nosea";
  series?: TideSeries;
  message?: string;
  span: { start: string; end: string };
  retry: () => void;
}

/** Sea level for the timeline's span while the tide layer is on. */
export function useTides(plan: ShootingPlan): TideFeed {
  const enabled = !!plan.layers.tides;
  const span = timelineWindow(plan.instant, plan.timeZone, timelineMode(plan.layers));
  const point = { latitude: plan.latitude, longitude: plan.longitude };
  const key = tideKey(point, span);
  const [state, setState] = useState<{ key: string; phase: TideFeed["phase"]; series?: TideSeries; message?: string }>({ key: "", phase: "off" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    setState((previous) => ({ key, phase: "loading", series: previous.key === key ? previous.series : undefined }));
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const timer = setTimeout(() => {
      void loadTides(point, span, controller.signal)
        .then((series) => { if (!disposed) setState({ key, phase: "ready", series }); })
        .catch((cause: unknown) => {
          if (disposed) return;
          if (cause instanceof TideRangeError) setState({ key, phase: "range", message: cause.message });
          else if (cause instanceof NoSeaError) setState({ key, phase: "nosea", message: cause.message });
          else setState({ key, phase: "error", message: cause instanceof Error && cause.name !== "AbortError" ? cause.message : "潮位数据读取超时" });
        })
        .finally(() => clearTimeout(timeout));
    }, 300);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [enabled, key, attempt]);
  // Model runs update daily; refresh an old answer when the panel is used again.
  const stale = state.phase === "ready" && !!state.series && Date.now() - state.series.fetchedAt >= TIDE_TTL;
  useEffect(() => { if (enabled && stale) setAttempt((value) => value + 1); }, [enabled, stale]);
  const current = enabled && state.key === key ? state : { phase: enabled ? "loading" as const : "off" as const };
  return { ...current, span, retry: () => setAttempt((value) => value + 1) };
}

/** The tide at the shooting instant in a few words, for the preview facts. */
export function tideFact(feed: TideFeed, instant: string) {
  if (feed.phase !== "ready" || !feed.series) return "";
  const now = tideNow(feed.series, instant);
  return now ? `潮位 ${tideHeight(now.height)} · ${now.rising ? "涨潮" : "落潮"}` : "";
}

function TideChart({ series, span, instant, zone }: { series: TideSeries; span: { start: string; end: string }; instant: string; zone: string }) {
  const from = Date.parse(span.start), to = Date.parse(span.end);
  const points = useMemo(() => {
    const list: { time: number; height: number | null }[] = [];
    for (let index = 0; index < series.heights.length; index++) {
      const time = series.start + index * 3_600_000;
      if (time >= from - 3_600_000 && time <= to + 3_600_000) list.push({ time, height: series.heights[index] });
    }
    return list;
  }, [series, from, to]);
  const values = points.map((point) => point.height).filter((height): height is number => height !== null);
  if (values.length < 2) return null;
  const low = Math.min(...values, 0), high = Math.max(...values, 0), range = Math.max(0.2, high - low);
  const x = (time: number) => ((time - from) / (to - from)) * 100;
  const y = (height: number) => 4 + (1 - (height - low) / range) * 52;
  let path = "", pen = false;
  for (const point of points) {
    if (point.height === null) { pen = false; continue; }
    path += `${pen ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.height).toFixed(2)}`;
    pen = true;
  }
  const extremes = tideExtremes(series, from, to), at = x(Date.parse(instant));
  return <svg className="tide-chart" viewBox="0 0 100 60" preserveAspectRatio="none" role="img"
    aria-label={`时间轴时段内的潮位：${extremes.map((entry) => `${entry.kind === "high" ? "高潮" : "低潮"} ${localClockTime(new Date(entry.time).toISOString(), zone).slice(0, 5)} ${tideHeight(entry.height)}`).join("，") || "无高低潮"}`}>
    <line className="tide-msl" x1="0" x2="100" y1={y(0)} y2={y(0)} />
    <path className="tide-curve" d={path} vectorEffect="non-scaling-stroke" />
    {extremes.map((entry) => <circle key={entry.time} className={`tide-extreme tide-${entry.kind}`} cx={x(entry.time)} cy={y(entry.height)} r="1.6" />)}
    {at >= 0 && at <= 100 && <line className="tide-now-line" x1={at} x2={at} y1="0" y2="60" vectorEffect="non-scaling-stroke" />}
  </svg>;
}

export function TideReadout({ plan, feed }: { plan: ShootingPlan; feed: TideFeed }) {
  if (!plan.layers.tides) return <p className="info-empty">潮汐已关闭</p>;
  if (feed.phase === "loading" || feed.phase === "off") return <p className="tide-status" role="status">正在读取潮位…</p>;
  if (feed.phase === "error") return <p className="tide-status" role="status">{feed.message}<button type="button" onClick={feed.retry}>重试潮位</button></p>;
  if (feed.phase === "range" || feed.phase === "nosea") return <p className="tide-status" role="status">{feed.message}</p>;
  const series = feed.series!, zone = plan.timeZone, now = tideNow(series, plan.instant);
  const when = (time: number) => {
    const instant = new Date(time).toISOString();
    const sameDay = localDateTime(instant, zone).slice(0, 10) === localDateTime(plan.instant, zone).slice(0, 10);
    return `${sameDay ? "" : `${localDateTime(instant, zone).slice(5, 10).replace("-", "/")} `}${localClockTime(instant, zone).slice(0, 5)}`;
  };
  const covered = tideCovers(series, Date.parse(feed.span.start), Date.parse(feed.span.end));
  return <div className="tide-readout" aria-label="潮汐">
    {now ? <>
      <p className="tide-now"><strong>{tideHeight(now.height)}</strong> · {now.rising ? "涨潮中" : "落潮中"}</p>
      <p className="tide-next">
        {[now.nextHigh, now.nextLow].filter((entry) => !!entry).sort((a, b) => a!.time - b!.time).map((entry) =>
          <span key={entry!.kind}>下次{entry!.kind === "high" ? "高潮" : "低潮"} {when(entry!.time)} {tideHeight(entry!.height)}</span>)}
      </p>
    </> : <p className="tide-status" role="status">拍摄时刻超出潮位预报（约 10 天内）</p>}
    <TideChart series={series} span={feed.span} instant={plan.instant} zone={zone} />
    <p className="tide-note">高低潮时刻常与验潮站预报差半小时以上，近岸以当地潮汐表为准</p>
    {!covered && now && <p className="tide-note">时段内部分时间没有潮位预报</p>}
    <p className="tide-note">
      潮位格点距机位约 {series.cell.distance < 1 ? "1" : Math.round(series.cell.distance)} km{series.cell.distance > TIDE_FAR_KM ? "，与机位岸边可能差异较大" : ""}
      <Detail>格点 {series.cell.latitude.toFixed(3)}°, {series.cell.longitude.toFixed(3)}° · 相对全球平均海平面，不是海图基准面；含天文潮、气压与海面高度变化；约 8 km 网格，海湾与河口可能不准，不可用于航行 · Copernicus Marine SMOC（经 Open-Meteo）</Detail>
    </p>
  </div>;
}
