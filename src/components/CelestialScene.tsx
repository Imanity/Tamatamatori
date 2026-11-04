import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import { celestialBodies, moonPhaseLabel } from "../domain/ephemeris";
import { bodyPolygons, polygonPath } from "../domain/celestial-projection";

export function useCelestialScene(plan: ShootingPlan) {
  const result = useMemo(() => {
    try { return { bodies: celestialBodies(plan), error: "" }; }
    catch { return { bodies: null, error: "日月计算失败，请检查机位与拍摄时刻。" }; }
  }, [plan.latitude, plan.longitude, plan.instant]);
  const views = result.bodies ? [result.bodies.sun, result.bodies.moon].map((body) => ({
    body, ...bodyPolygons(plan, body), enabled: plan.layers[body.id],
  })) : [];
  return { ...result, views };
}
type CelestialScene = ReturnType<typeof useCelestialScene>;
const name = (id: "sun" | "moon") => id === "sun" ? "太阳" : "月亮";

export function CelestialDiscs({ scene }: { scene: CelestialScene }) {
  const visible = scene.views.filter((view) => view.enabled && view.state === "画面内");
  return <>
    <svg className="celestial-discs" viewBox="-1 -1 2 2" preserveAspectRatio="none"
      role="img" aria-label="日月圆盘构图辅助，地形遮挡未校验">
      {visible.map(({ body, outline, illuminated }) => <g key={body.id} data-celestial-body={body.id} aria-label={`${name(body.id)}圆盘`}>
        <path d={polygonPath(illuminated)} fill={body.id === "sun" ? "#fff2bc" : "#eeeade"} />
        <path d={polygonPath(outline)} fill="none" stroke={body.id === "sun" ? "#f5c966" : "#dededb"}
          strokeWidth="0.6" vectorEffect="non-scaling-stroke" opacity={body.id === "sun" ? 0.9 : 0.5} />
      </g>)}
    </svg>
    {visible.map(({ body, centre, outline }) => centre && <span key={body.id} className="celestial-label"
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
    {scene.views.map(({ body, enabled, state }) => <div key={body.id} className="celestial-row" data-body-status={body.id}>
      <span className="celestial-name">{name(body.id)}</span>
      <span className="celestial-state">{enabled ? state : "已关闭"}</span>
      {enabled && <>
        <span className="celestial-coordinates">{body.azimuth.toFixed(1)}° / {body.elevation > 0 ? "+" : ""}{body.elevation.toFixed(1)}°</span>
        {body.id === "moon" && <span>{moonPhaseLabel(body.phaseAngle)} · 亮面 {(body.illuminatedFraction * 100).toFixed(0)}%</span>}
        <button aria-label={`朝向${name(body.id)}`} disabled={body.elevation + body.angularRadius <= 0}
          onClick={() => update({ azimuth: body.azimuth, pitch: body.elevation })}>朝向</button>
      </>}
    </div>)}
    {(plan.layers.sun || plan.layers.moon) && <p className="celestial-limit">日月为构图辅助 · 地形遮挡未校验</p>}
  </div>;
}
