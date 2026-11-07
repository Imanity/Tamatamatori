import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import { celestialBodies, moonPhaseLabel } from "../domain/ephemeris";
import { bodyPolygons } from "../domain/celestial-projection";
import { celestialPlanKey, skyLabelKey, occlusionText } from "../domain/visibility";
import type { VisibilitySnapshot } from "../domain/visibility";
import type { WeatherSample } from "../domain/weather";
import { cloudOpacity, weatherClouds } from "../domain/weather-appearance";
import { refractDirection } from "../domain/refraction";

export function useCelestialScene(plan: ShootingPlan, visibility: VisibilitySnapshot, renderView?: { azimuth: number; pitch: number }) {
  const result = useMemo(() => {
    try { return { bodies: celestialBodies(plan), error: "" }; }
    catch { return { bodies: null, error: "日月计算失败，请检查机位与拍摄时刻。" }; }
  }, [plan.latitude, plan.longitude, plan.instant]);
  const views = result.bodies ? [result.bodies.sun, result.bodies.moon].map((body) => ({
    body, ...bodyPolygons({ ...plan, ...renderView }, body), enabled: plan.layers[body.id],
    occlusion: visibility.planKey === celestialPlanKey(plan) ? visibility.states[body.id] : "waiting" as const,
    labelOcclusion: visibility.labelKey === skyLabelKey(plan) && !visibility.message
      ? visibility.labelStates?.[body.id] : visibility.planKey === celestialPlanKey(plan) ? visibility.states[body.id] : "waiting",
  })) : [];
  return { ...result, views };
}
type CelestialScene = ReturnType<typeof useCelestialScene>;
const name = (id: "sun" | "moon") => id === "sun" ? "太阳" : "月亮";

export function CelestialDiscs({ scene, weather, plan }: { scene: CelestialScene; weather?: WeatherSample; plan?: ShootingPlan }) {
  const clouds = weather && plan ? weatherClouds(weather, plan) : undefined;
  const visible = scene.views.filter((view) => view.enabled && view.state === "画面内" && (view.labelOcclusion === "clear" || view.labelOcclusion === "partial"));
  const outside = scene.views.filter(view=>view.enabled&&view.indicator);
  // At conjunction keep both names readable instead of drawing overlapping pills.
  const close = outside.length===2 && Math.hypot(outside[0].indicator!.x-outside[1].indicator!.x,
    outside[0].indicator!.y-outside[1].indicator!.y)<0.6;
  const groups = close ? [outside] : outside.map(view=>[view]);
  return <>
    {visible.map(({ body, centre, outline }) => centre && <span key={body.id} className="celestial-label"
      data-celestial-body={body.id}
      style={{ opacity: 1 - cloudOpacity(refractDirection(body.direction, plan?.refraction ?? "none"), clouds), left: `${Math.max(5, Math.min(95, (centre.x + 1) * 50))}%`, top: `calc(${Math.max(7, Math.min(90, (Math.min(...outline.map((p) => p.y)) + 1) * 50))}% - 4px)` }}>
      {name(body.id)}<small>构图辅助</small>
    </span>)}
    <div className="celestial-directions">{groups.map(group=>{
      const x=group.reduce((sum,v)=>sum+v.indicator!.x,0)/group.length;
      const y=group.reduce((sum,v)=>sum+v.indicator!.y,0)/group.length;
      return <div className="celestial-direction-group" key={group.map(v=>v.body.id).join('-')}
        style={{left:`clamp(56px, ${(x+1)*50}%, calc(100% - 56px))`,top:`clamp(max(48px, 11%), ${(y+1)*50}%, calc(100% - 52px))`}}>
        {group.map(({body,indicator})=><span key={body.id} className={`celestial-direction celestial-direction-${body.id}`}
          data-body-direction={body.id} data-behind={indicator!.behind}
          role="img" aria-label={`${name(body.id)}在画面${indicator!.label}${indicator!.behind&&indicator!.label!=="后方"?"（相机后方）":""}，视场外方向参考`}>
          <svg className="celestial-direction-arrow" viewBox="0 0 16 16" aria-hidden="true"
            style={{transform:`rotate(${indicator!.angle}deg)`}}><path d="M2 8h11M8 3l5 5-5 5" /></svg>
          <span>{name(body.id)}{indicator!.behind&&<small>后方</small>}</span>
        </span>)}
      </div>;
    })}</div>
  </>;
}

export function CelestialReadout({ scene, plan, update, bodyId, weather }: {
  scene: CelestialScene; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void; bodyId?: "sun" | "moon"; weather?: WeatherSample;
}) {
  if (scene.error) return <p className="celestial-error" role="status">{scene.error}</p>;
  return <div className="celestial-readout" aria-label="日月图层状态">
    {scene.views.filter(view => !bodyId || view.body.id === bodyId).map(({ body, enabled, state, visualElevation, occlusion }) => <div key={body.id} className="celestial-row" data-body-status={body.id}>
      <span className="celestial-name">{name(body.id)}</span>
      <span className="celestial-state">{!enabled ? "已关闭" : state === "画面内" ? occlusionText(occlusion,plan) : state}</span>
      {enabled && <>
        <span className="celestial-coordinates">{body.azimuth.toFixed(1)}° / 视 {visualElevation.toFixed(2)}°（几何 {body.elevation.toFixed(2)}°）</span>
        {body.id === "moon" && <span>{moonPhaseLabel(body.phaseAngle)} · 亮面 {(body.illuminatedFraction * 100).toFixed(0)}%</span>}
        {weather && <span>云层透过约 {((1 - cloudOpacity(refractDirection(body.direction, plan.refraction), weatherClouds(weather, plan))) * 100).toFixed(0)}% · 显示近似</span>}
        <button aria-label={`朝向${name(body.id)}`} disabled={state === "地平线下"}
          onClick={() => update({ azimuth: body.azimuth, pitch: visualElevation })}>朝向</button>
      </>}
    </div>)}
    {(plan.layers.sun || plan.layers.moon) && <p className="celestial-limit">{plan.layers.buildings?"遮挡按已载 DEM 与有限建筑体块":"遮挡仅按当前 DEM"} · {plan.refraction === "standard" ? "标准折射为固定大气近似" : "无大气折射"}</p>}
  </div>;
}
