import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import { celestialBodies, moonPhaseLabel } from "../domain/ephemeris";
import { bodyPolygons } from "../domain/celestial-projection";
import { celestialPlanKey, occlusionLabels } from "../domain/visibility";
import type { VisibilitySnapshot } from "../domain/visibility";

export function useCelestialScene(plan: ShootingPlan, visibility: VisibilitySnapshot) {
  const result = useMemo(() => {
    try { return { bodies: celestialBodies(plan), error: "" }; }
    catch { return { bodies: null, error: "日月计算失败，请检查机位与拍摄时刻。" }; }
  }, [plan.latitude, plan.longitude, plan.instant]);
  const views = result.bodies ? [result.bodies.sun, result.bodies.moon].map((body) => ({
    body, ...bodyPolygons(plan, body), enabled: plan.layers[body.id],
    occlusion: visibility.planKey === celestialPlanKey(plan) ? visibility.states[body.id] : "waiting" as const,
  })) : [];
  return { ...result, views };
}
type CelestialScene = ReturnType<typeof useCelestialScene>;
const name = (id: "sun" | "moon") => id === "sun" ? "太阳" : "月亮";

export function CelestialDiscs({ scene }: { scene: CelestialScene }) {
  const visible = scene.views.filter((view) => view.enabled && view.state === "画面内" && (view.occlusion === "clear" || view.occlusion === "partial"));
  return <>
    {visible.map(({ body, centre, outline }) => centre && <span key={body.id} className="celestial-label"
      data-celestial-body={body.id}
      style={{ left: `${Math.max(5, Math.min(95, (centre.x + 1) * 50))}%`, top: `calc(${Math.max(7, Math.min(90, (Math.min(...outline.map((p) => p.y)) + 1) * 50))}% - 4px)` }}>
      {name(body.id)}<small>构图辅助</small>
    </span>)}
  </>;
}

export function CelestialReadout({ scene, plan, update }: {
  scene: CelestialScene; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void;
}) {
  if (scene.error) return <p className="celestial-error" role="status">{scene.error}</p>;
  return <div className="celestial-readout" aria-label="日月图层状态">
    {scene.views.map(({ body, enabled, state, visualElevation, occlusion }) => <div key={body.id} className="celestial-row" data-body-status={body.id}>
      <span className="celestial-name">{name(body.id)}</span>
      <span className="celestial-state">{!enabled ? "已关闭" : state === "画面内" ? occlusionLabels[occlusion] : state}</span>
      {enabled && <>
        <span className="celestial-coordinates">{body.azimuth.toFixed(1)}° / 视 {visualElevation.toFixed(2)}°（几何 {body.elevation.toFixed(2)}°）</span>
        {body.id === "moon" && <span>{moonPhaseLabel(body.phaseAngle)} · 亮面 {(body.illuminatedFraction * 100).toFixed(0)}%</span>}
        <button aria-label={`朝向${name(body.id)}`} disabled={state === "地平线下"}
          onClick={() => update({ azimuth: body.azimuth, pitch: visualElevation })}>朝向</button>
      </>}
    </div>)}
    {(plan.layers.sun || plan.layers.moon) && <p className="celestial-limit">遮挡仅按当前 DEM · {plan.refraction === "standard" ? "标准折射为固定大气近似" : "无大气折射"}</p>}
  </div>;
}
