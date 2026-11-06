import type { ShootingPlan } from "../domain/plan";
import type { StationScene } from "../domain/stations";
import type { SkyVisibility } from "../domain/starfield";
import type { OrbitFeed } from "./useOrbits";
import { skyPointView } from "../domain/starfield";
import { celestialPlanKey, occlusionLabels } from "../domain/visibility";
import { apparentElevation } from "../domain/refraction";
import { matchingStations } from "../domain/orbit-data";

const utc = (instant: string | null) => instant
  ? `${new Date(instant.endsWith("Z") ? instant : `${instant}Z`).toISOString().slice(0, 19).replace("T", " ")} UTC`
  : "未记录";

function stationView(plan: ShootingPlan, scene: StationScene, visibility: SkyVisibility, point: StationScene["points"][number]) {
  const planCurrent = visibility.planKey === celestialPlanKey(plan);
  const current = planCurrent && visibility.orbitKey === scene.key;
  const view = current && visibility.view ? { ...plan, ...visibility.view } : plan;
  const projected = skyPointView(view, point);
  const occlusion = planCurrent && visibility.message ? "error" : current && visibility.ready
    ? visibility.states[point.id] ?? "waiting" : "waiting";
  return { ...projected, occlusion };
}

export function StationLabels({ plan, scene, visibility }: { plan: ShootingPlan; scene: StationScene; visibility: SkyVisibility }) {
  if (!plan.layers.stations) return null;
  return scene.points.map((point) => {
    const view = stationView(plan, scene, visibility, point);
    if (view.state !== "画面内" || view.occlusion !== "clear" || !view.pixel) return null;
    return (
      <span key={point.id} className="sky-label station-label" data-station-label={point.noradId}
        style={{ left: `${(view.pixel.x + 1) * 50}%`, top: `${(view.pixel.y + 1) * 50}%` }}>
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
        {feed.phase === "loading" && <p>正在检查已发布轨道快照…</p>}
        {feed.error && <p className="sky-limit">{feed.error}{source && " · 使用本地有效快照"}</p>}
        {source?.error && <p className="sky-limit">{source.error}</p>}
        {source?.status === "seed" && <p className="sky-limit">随版本附带快照 · 上游检查时间未记录</p>}
        {sourceOld && <p className="sky-limit">上游超过 6 小时未成功检查，请核对更新状态</p>}
        <p>上游成功检查 {utc(source?.fetchedAt ?? null)}</p>
        {source?.status === "error" && <p>上游最近尝试 {utc(source.attemptedAt)}</p>}
        <p>网页成功检查 {utc(feed.checkedAt)}</p>
      </div>
      <div className="station-actions">
        <button type="button" disabled={!feed.canRefresh || feed.phase === "loading"} onClick={feed.refresh}>检查已发布快照</button>
        <button type="button" onClick={() => update({ instant: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() })}>使用当前时刻</button>
      </div>
      <p className="station-instant">拍摄参考 {utc(plan.instant)}</p>
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
        const state = projected?.state === "画面内" ? occlusionLabels[projected.occlusion] : projected?.state;
        const action = point && point.elevation > 0 ? (plan.layers.stations ? "朝向" : "开启并朝向") : "开启图层";
        return (
          <div className="station-row" data-station-status={row.id} key={row.id}>
            <strong>{row.name}</strong>
            <p>{row.message}</p>
            {row.epoch && <p>轨道历元 {utc(row.epoch)}</p>}
            {point && <>
              <p>{!plan.layers.stations && "图层已关闭 · "}{state}</p>
              <p>方位 {point.azimuth.toFixed(1)}° · 几何高度 {point.elevation.toFixed(1)}° · 距离 {point.rangeKm.toFixed(0)} km</p>
              <p>{point.shadow > 0.99 ? "地影中" : point.shadow > 0.01 ? "地球半影中" : "太阳照明中"} · 日照与可拍摄性分别判断</p>
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
      <p className="sky-limit">标记与轨迹点为构图辅助，范围 ±3 分钟、间隔 10 秒。变轨后需等待新轨道解，拍摄前重新检查。上游计划每 3 小时检查，最短请求间隔 2 小时，网页检查不会触发上游下载。</p>
    </section>
  );
}
