import { useEffect, useState } from "react";
import type { ShootingPlan } from "../../domain/core/plan";
import { compassDirection, localDateTime } from "../../domain/core/plan";
import { sunPosition } from "../../domain/core/ephemeris";
import { auroraView, kpAt, kpLabel, ovationApplies, ovationAt } from "../../domain/environment/aurora";
import type { AuroraView, KpBlock, KpKind, Ovation } from "../../domain/environment/aurora";
import { loadKp, loadOvation } from "../../io/aurora";
import { Detail } from "../common/readout";

export interface AuroraFeed {
  phase: "off" | "loading" | "ready" | "error";
  kp?: KpBlock[];
  outlook?: KpBlock[];
  ovation?: Ovation | null;
  ovationPhase: "off" | "loading" | "ready" | "error";
  message?: string;
  retry: () => void;
}

/** Kp products while the layer is on; the OVATION nowcast only for instants within three hours of now. */
export function useAurora(plan: ShootingPlan): AuroraFeed {
  const enabled = !!plan.layers.aurora;
  const nearNow = Math.abs(Date.parse(plan.instant) - Date.now()) < 3 * 3_600_000;
  const [state, setState] = useState<{ phase: AuroraFeed["phase"]; kp?: KpBlock[]; outlook?: KpBlock[]; message?: string }>({ phase: "off" });
  const [ovation, setOvation] = useState<{ phase: AuroraFeed["ovationPhase"]; value?: Ovation }>({ phase: "off" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    // A refresh keeps showing the previous answer until the new one arrives.
    setState((previous) => previous.kp ? previous : { ...previous, phase: "loading" });
    const timeout = setTimeout(() => controller.abort(), 20_000);
    void loadKp(controller.signal)
      .then(({ kp, outlook }) => { if (!disposed) setState({ phase: "ready", kp, outlook }); })
      .catch((cause: unknown) => {
        if (!disposed) setState({ phase: "error", message: cause instanceof Error && cause.name !== "AbortError" ? cause.message : "极光预报读取超时" });
      })
      .finally(() => clearTimeout(timeout));
    // Kp forecasts are reissued every few hours; refresh while the page stays open.
    const refresh = setInterval(() => setAttempt((value) => value + 1), 30 * 60_000);
    return () => { disposed = true; clearTimeout(timeout); clearInterval(refresh); controller.abort(); };
  }, [enabled, attempt]);
  useEffect(() => {
    if (!enabled || !nearNow) return;
    const controller = new AbortController();
    let disposed = false;
    setOvation((previous) => previous.value ? previous : { ...previous, phase: "loading" });
    void loadOvation(controller.signal)
      .then((value) => { if (!disposed) setOvation({ phase: "ready", value }); })
      .catch(() => { if (!disposed) setOvation({ phase: "error" }); });
    const refresh = setInterval(() => setAttempt((value) => value + 1), 5 * 60_000);
    return () => { disposed = true; clearInterval(refresh); controller.abort(); };
  }, [enabled, nearNow, attempt]);
  if (!enabled) return { phase: "off", ovationPhase: "off", retry: () => setAttempt((value) => value + 1) };
  return {
    ...state, ovation: nearNow ? ovation.value ?? null : null, ovationPhase: nearNow ? ovation.phase : "off",
    retry: () => setAttempt((value) => value + 1),
  };
}

const kindNames: Record<KpKind, string> = { observed: "观测", estimated: "估计", predicted: "预报", outlook: "27 天展望" };

/** The verdict for the shooting instant, or why there is none. */
export function auroraVerdict(plan: ShootingPlan, feed: AuroraFeed) {
  if (feed.phase !== "ready") return null;
  const time = Date.parse(plan.instant), block = kpAt(time, feed.kp ?? null, feed.outlook ?? null);
  if (!block) return { block: null, view: null, nowcast: null } as const;
  const point = { latitude: plan.latitude, longitude: plan.longitude };
  const view = auroraView(point, plan.instant, block.kp);
  const nowcast = feed.ovation && ovationApplies(feed.ovation, time) ? { chance: ovationAt(feed.ovation, point), ovation: feed.ovation } : null;
  return { block, view, nowcast } as const;
}

function viewText(view: AuroraView) {
  const direction = compassDirection(view.bearing);
  if (view.kind === "overhead") return "可能出现在头顶";
  if (view.kind === "low") return `可能低悬${direction}方天空，顶部约 ${Math.round(view.top)}°`;
  if (view.kind === "horizon") return `可能贴近${direction}方地平线（顶部约 ${Math.round(view.top)}°），相机长曝光更易拍到`;
  return "难以看到";
}

/** A few words for the preview facts while the aurora could be seen. */
export function auroraFact(plan: ShootingPlan, feed: AuroraFeed) {
  const verdict = auroraVerdict(plan, feed);
  if (!verdict?.view || verdict.view.kind === "none") return "";
  if (sunPosition(plan).elevation >= -12) return "";
  return `极光 Kp ${kpLabel(verdict.view.kp)} · ${verdict.view.kind === "overhead" ? "可能在头顶" : `${compassDirection(verdict.view.bearing)}方低空`}`;
}

export function AuroraReadout({ plan, feed }: { plan: ShootingPlan; feed: AuroraFeed }) {
  if (!plan.layers.aurora) return <p className="info-empty">极光已关闭</p>;
  if (feed.phase === "loading" || feed.phase === "off") return <p className="aurora-status" role="status">正在读取极光预报…</p>;
  if (feed.phase === "error") return <p className="aurora-status" role="status">{feed.message}<button type="button" onClick={feed.retry}>重试极光预报</button></p>;
  const verdict = auroraVerdict(plan, feed)!;
  if (!verdict.view) return <p className="aurora-status" role="status">超出预报时效：Kp 预报约 3 天，展望 27 天</p>;
  const { block, view, nowcast } = verdict, sun = sunPosition(plan).elevation;
  const issued = (time: number) => localDateTime(new Date(time).toISOString(), plan.timeZone).slice(11, 16);
  return <div className="aurora-readout" aria-label="极光">
    <p className="aurora-source">
      {nowcast ? `OVATION 临近预报（${issued(nowcast.ovation.observed)} 观测）` : block.kind === "outlook" ? "27 天展望（每日最大 Kp，仅供参考）" : `Kp ${kindNames[block.kind]}（3 小时一档）`}
    </p>
    <p className="aurora-verdict">
      <strong>Kp {kpLabel(view.kp)}</strong>{block.kind === "outlook" ? "（当日最大）" : ""} · {viewText(view)}
    </p>
    {nowcast && <p>头顶出现极光的概率约 {nowcast.chance}%</p>}
    <p className="aurora-need">
      {view.neededKp === 0 ? "本地常年处在极光带附近" : view.neededKp === null ? "本地即使 Kp 9 也难以看到" : `本地需 Kp ≥ ${kpLabel(view.neededKp)}`}
    </p>
    {sun >= -6 ? <p className="aurora-dark">天太亮，看不到极光</p> : sun >= -12 ? <p className="aurora-dark">天色偏亮，只有强极光可见</p> : null}
    <Detail>
      地磁纬度 {view.magneticLatitude.toFixed(1)}°（IGRF-14 偏心偶极）· 磁地方时 {view.mlt.toFixed(1)} 时 · 极光带赤道侧边界约地磁纬度 {view.boundary.toFixed(1)}°（Carbary 2005）· 可见按 200 km 高的极光顶部高出地平线 5° 计 · NOAA SWPC
    </Detail>
  </div>;
}
