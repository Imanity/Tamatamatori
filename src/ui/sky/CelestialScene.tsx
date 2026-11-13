import { useEffect, useMemo, useRef, useState } from "react";
import { Detail, where } from "../common/readout";
import type { ShootingPlan } from "../../domain/core/plan";
import { frameAspectRatio } from "../../domain/core/plan";
import { bodyPath, pathView, PATH_SEARCH_HOURS } from "../../domain/sun-moon/body-paths";
import type { PathPass } from "../../domain/sun-moon/body-paths";
import { celestialBodies, moonPhaseLabel } from "../../domain/core/ephemeris";
import { bodyPolygons } from "../../domain/core/celestial-projection";
import { celestialPlanKey, skyLabelKey, occlusionText } from "../../domain/core/visibility";
import type { VisibilitySnapshot } from "../../domain/core/visibility";
import type { WeatherSample } from "../../domain/environment/weather";
import { cloudOpacity, weatherClouds } from "../../domain/environment/weather-appearance";
import { refractDirection } from "../../domain/core/refraction";

export function useCelestialScene(plan: ShootingPlan, visibility: VisibilitySnapshot, renderView?: { azimuth: number; pitch: number }) {
  const result = useMemo(() => {
    try { return { bodies: celestialBodies(plan), error: "" }; }
    catch { return { bodies: null, error: "日月计算失败，请检查机位与拍摄时刻。" }; }
  }, [plan.latitude, plan.longitude, plan.instant]);
  const sunPath = plan.layers.sun && !!plan.layers.sunPath, moonPath = plan.layers.moon && !!plan.layers.moonPath;
  const sources = useMemo(() => {
    try { return (["sun", "moon"] as const).filter((id) => (id === "sun" ? sunPath : moonPath)).map((id) => bodyPath(plan, id)); }
    catch { return []; }
  }, [plan.latitude, plan.longitude, plan.instant, plan.timeZone, plan.refraction, sunPath, moonPath]);
  const paths = sources.map((path) => pathView({ ...plan, ...renderView }, path));
  const views = result.bodies ? [result.bodies.sun, result.bodies.moon].map((body) => ({
    body, ...bodyPolygons({ ...plan, ...renderView }, body), enabled: plan.layers[body.id],
    occlusion: visibility.planKey === celestialPlanKey(plan) ? visibility.states[body.id] : "waiting" as const,
    labelOcclusion: visibility.labelKey === skyLabelKey(plan) && !visibility.message
      ? visibility.labelStates?.[body.id] : visibility.planKey === celestialPlanKey(plan) ? visibility.states[body.id] : "waiting",
  })) : [];
  return { ...result, views, paths };
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
  // Near conjunction (an eclipse) the two disc names would print on top of each other; keep one.
  const together = visible.length === 2 && visible.every((view) => view.centre) &&
    Math.hypot(visible[0].centre!.x - visible[1].centre!.x, visible[0].centre!.y - visible[1].centre!.y) < 0.12;
  const labelled = together ? visible.filter((view) => view.body.id === "sun") : visible;
  return <>
    {labelled.map(({ body, centre, outline }) => centre && <span key={body.id} className="celestial-label"
      data-celestial-body={body.id}
      style={{ opacity: 1 - cloudOpacity(refractDirection(body.direction, plan?.refraction ?? "none"), clouds), left: `${Math.max(5, Math.min(95, (centre.x + 1) * 50))}%`, top: `calc(${Math.max(7, Math.min(90, (Math.min(...visible.flatMap((view) => together ? view.outline : []).concat(outline).map((p) => p.y)) + 1) * 50))}% - 4px)` }}>
      {together ? "太阳 · 月亮" : name(body.id)}<small>构图辅助</small>
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

/**
 * Whole-hour times along the paths. Labels sit beside the line, the Sun's to
 * the left of its travel and the Moon's to the right, so the two stay apart
 * near conjunction. They mark directions and do not test terrain occlusion;
 * the line itself is dashed where terrain hides it.
 */
export function CelestialPathLabels({ scene, plan }: { scene: CelestialScene; plan: ShootingPlan }) {
  const aspect = frameAspectRatio(plan);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pixel = (x: number, y: number) => ({ x: (x + 1) / 2 * size.width, y: (y + 1) / 2 * size.height });
  // The disc name ends 4 px above the disc and is about 30 × 21 CSS px; an hour label (about 24 × 9) there would hide it.
  const names = scene.views.filter((view) => view.enabled && view.state === "画面内" && view.outline.length)
    .map((view) => pixel(view.centre?.x ?? 0, Math.min(...view.outline.map((p) => p.y))));
  return <div className="path-labels" aria-hidden="true" ref={host}>{scene.paths.flatMap((path) => path.markers.map((marker) => {
    let nx = 0, ny = path.id === "sun" ? -1 : 1;
    if (marker.tangent) {
      // Normalised device units to proportional pixels: the frame is `aspect` wide per unit height.
      const tx = marker.tangent.x * aspect, ty = marker.tangent.y, length = Math.hypot(tx, ty);
      if (length > 1e-9) [nx, ny] = path.id === "sun" ? [ty / length, -tx / length] : [-ty / length, tx / length];
    }
    const at = pixel(marker.point.x, marker.point.y), label = { x: at.x + nx * 20, y: at.y + ny * 10 };
    if (size.width && names.some((name) => Math.abs(label.x - name.x) < 28 && label.y > name.y - 30 && label.y < name.y + 1)) return [];
    return <span key={`${path.id}-${marker.time}`} className={`path-label path-label-${path.id}`}
      data-path-marker={`${path.id}-${marker.label}`} data-path-day={marker.day}
      style={{ left: `${(marker.point.x + 1) * 50}%`, top: `${(marker.point.y + 1) * 50}%`,
        transform: `translate(calc(-50% + ${(nx * 20).toFixed(1)}px), calc(-50% + ${(ny * 10).toFixed(1)}px))` }}>
      {marker.label}{marker.day !== 0 && <small>{marker.day > 0 ? "+1" : "−1"}</small>}
    </span>;
  }))}</div>;
}

const passNames: Record<PathPass, string> = { current: "本次出没", next: "下一次出没", previous: "上一次出没", long: "不落，显示 24 小时" };

/** Path switch for a body's information group; the path belongs to its body layer. */
export function PathToggle({ scene, plan, update, bodyId }: {
  scene: CelestialScene; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void; bodyId: "sun" | "moon";
}) {
  const key = bodyId === "sun" ? "sunPath" : "moonPath";
  const available = plan.layers[bodyId], on = available && !!plan.layers[key];
  const view = scene.paths.find((path) => path.id === bodyId);
  return <>
    <label className="subsetting-toggle layer-toggle">
      <span>运行轨迹</span>
      <input type="checkbox" role="switch" aria-label={`显示${name(bodyId)}运行轨迹`} checked={on} disabled={!available}
        onChange={() => update({ layers: { ...plan.layers, [key]: !on } })} />
    </label>
    {on && !scene.error && <p className="path-status" data-path-status={bodyId}>
      {!view ? "轨迹计算失败" : !view.pass ? `前后 ${PATH_SEARCH_HOURS} 小时均在地平线下`
        : `${passNames[view.pass]} · ${view.state === "画面内" ? "经过画面" : "在视场外"}`}
    </p>}
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
        <span className="celestial-coordinates">{where(body.azimuth, visualElevation)}<Detail>{body.azimuth.toFixed(1)}° / 视 {visualElevation.toFixed(2)}°（几何 {body.elevation.toFixed(2)}°）</Detail></span>
        {body.id === "moon" && <span>{moonPhaseLabel(body.phaseAngle)} · 亮面 {(body.illuminatedFraction * 100).toFixed(0)}%</span>}
        {weather && <span>云层透过约 {((1 - cloudOpacity(refractDirection(body.direction, plan.refraction), weatherClouds(weather, plan))) * 100).toFixed(0)}%</span>}
        <button aria-label={`朝向${name(body.id)}`} disabled={state === "地平线下"}
          onClick={() => update({ azimuth: body.azimuth, pitch: visualElevation })}>朝向</button>
      </>}
    </div>)}
  </div>;
}
