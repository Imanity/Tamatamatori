import type { ShootingPlan } from "../domain/plan";
import { where } from "./readout";
import type { StationScene } from "../domain/stations";
import type { SkyVisibility } from "../domain/starfield";
import type { OrbitFeed } from "./useOrbits";
import { skyPointView } from "../domain/starfield";
import { celestialPlanKey, skyLabelKey, occlusionText } from "../domain/visibility";
import { apparentElevation } from "../domain/refraction";
import { matchingStations } from "../domain/orbit-data";
import type { WeatherSample } from "../domain/weather";
import { cloudOpacity, weatherClouds } from "../domain/weather-appearance";
import { refractDirection } from "../domain/refraction";

const utc = (instant: string | null) => instant
  ? `${new Date(instant.endsWith("Z") ? instant : `${instant}Z`).toISOString().slice(0, 19).replace("T", " ")} UTC`
  : "未记录";

function stationView(plan: ShootingPlan, scene: StationScene, visibility: SkyVisibility, point: StationScene["points"][number]) {
  const planCurrent = visibility.planKey === celestialPlanKey(plan);
  const current = planCurrent && visibility.orbitKey === scene.key;
  const view = current && visibility.view ? { ...plan, ...visibility.view } : plan;
  const projected = skyPointView(view, point);
  const occlusion = planCurrent && (visibility.message || visibility.occlusionUnavailable) ? "error" : current && visibility.ready
    ? visibility.states[point.id] ?? "waiting" : "waiting";
  return { ...projected, occlusion };
}

export function StationLabels({ plan, scene, visibility, weather }: { plan: ShootingPlan; scene: StationScene; visibility: SkyVisibility; weather?: WeatherSample }) {
  if (!plan.layers.stations) return null;
  return scene.points.map((point) => {
    const view = stationView(plan, scene, visibility, point);
    const labelOcclusion = visibility.labelKey === skyLabelKey(plan) && visibility.orbitKey === scene.key && !visibility.message
      ? visibility.labelStates?.[point.id] : view.occlusion;
    if (view.state !== "画面内" || labelOcclusion !== "clear" || !view.pixel) return null;
    const opacity = 1 - cloudOpacity(refractDirection(point.direction, plan.refraction), weather ? weatherClouds(weather, plan) : undefined);
    if (opacity < 0.05) return null;
    return (
      <span key={point.id} className="sky-label station-label" data-station-label={point.noradId}
        style={{ opacity, left: `${(view.pixel.x + 1) * 50}%`, top: `${(view.pixel.y + 1) * 50}%` }}>
        {point.name}<small>位置参考</small>
      </span>
    );
  });
}

export function StationReadout({ plan, scene, visibility, feed, query, update }: {
  plan: ShootingPlan; scene: StationScene; visibility: SkyVisibility; feed: OrbitFeed;
  query: string; update: (patch: Partial<ShootingPlan>) => void;
}) {
  const matches = matchingStations(query);
  if (!plan.layers.stations && !matches.length) return null;
  const rows = query.trim() ? scene.rows.filter((row) => matches.some((match) => match.id === row.id)) : scene.rows;
  const source = feed.snapshot;
  const sourceOld = source?.fetchedAt && feed.clock - Date.parse(source.fetchedAt) > 6 * 3_600_000;
  return (
    <section className="info-section station-readout" aria-label="空间站与轨道数据">
      <h3>空间站与轨道</h3>
      <div className="station-feed-status" role="status">
        {feed.phase === "loading" && <p>正在检查轨道数据…</p>}
        {feed.error && <p className="station-warning">{feed.error}{source && "，暂用已保存的轨道数据"}</p>}
        {source?.error && <p className="station-warning">{source.error}</p>}
        {source?.status === "seed" && <p>使用网页附带的轨道数据</p>}
        {sourceOld && <p className="station-warning">轨道数据超过 6 小时未更新</p>}
        {source?.fetchedAt && <p>轨道数据更新于 {utc(source.fetchedAt)}</p>}
      </div>
      <div className="station-actions">
        <button type="button" disabled={!feed.canRefresh || feed.phase === "loading"} onClick={feed.refresh}>检查轨道更新</button>
        <button type="button" onClick={() => update({ instant: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() })}>使用当前时刻</button>
      </div>
      <p className="station-instant">拍摄时刻 {utc(plan.instant)}</p>
      <div className="station-actions" aria-label="空间站时间微调">
        {[-10, -1, 1, 10].map((seconds) => (
          <button key={seconds} type="button" onClick={() => update({ instant: new Date(Date.parse(plan.instant) + seconds * 1000).toISOString() })}>
            {seconds > 0 ? "+" : "−"}{Math.abs(seconds)} 秒
          </button>
        ))}
      </div>
      {rows.map((row) => {
        const point = row.point;
        const projected = point ? stationView(plan, scene, visibility, point) : null;
        const state = projected?.state === "画面内" ? occlusionText(projected.occlusion,plan) : projected?.state;
        const action = point && point.elevation > 0 ? (plan.layers.stations ? "朝向" : "开启并朝向") : "开启图层";
        return (
          <div className="station-row" data-station-status={row.id} key={row.id}>
            <strong>{row.name}</strong>
            {row.message && <p className="station-warning">{row.message}</p>}
            {point && <>
              <p>{!plan.layers.stations && "图层已关闭 · "}{state}</p>
              <p>{where(point.azimuth, point.elevation)}</p>
              <p className="info-detail">方位 {point.azimuth.toFixed(1)}° · 几何高度 {point.elevation.toFixed(1)}° · 距离 {point.rangeKm.toFixed(0)} km</p>
              <p>{point.shadow > 0.99 ? "地影中" : point.shadow > 0.01 ? "地球半影中" : "太阳照明中"}</p>
            </>}
            <button type="button" aria-label={`${action}${row.name}`}
              disabled={!!plan.layers.stations && (!point || point.elevation <= 0)}
              onClick={() => update(point && point.elevation > 0 ? {
                layers: { ...plan.layers, stations: true }, azimuth: point.azimuth,
                pitch: apparentElevation(point.elevation, plan.refraction),
              } : { layers: { ...plan.layers, stations: true } })}>
              {action}
            </button>
          </div>
        );
      })}
    </section>
  );
}
