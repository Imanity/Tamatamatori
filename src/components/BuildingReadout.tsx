import { useMemo } from "react";
import type { BuildingStatus } from "../domain/buildings";
import { BUILDING_FAR_MIN_HEIGHT, BUILDING_NEAR_RADIUS, BUILDING_RADIUS } from "../domain/buildings";
import { landmarksInRange, LANDMARK_RADIUS } from "../domain/landmarks";
import type { LandmarkDefinition } from "../domain/landmarks";
import { ellipsoidalRay } from "../domain/geodesy";
import type { ShootingPlan } from "../domain/plan";

const stages = { tiles: "读取 OSM 建筑", landmarks: "加载地标精模", geometry: "生成建筑体块" } as const;
const reasons = {
  budget: "未加载：附近建筑过多，超出绘制上限",
  failed: "未加载：模型读取失败，可重新读取",
  unconfirmed: "未加载：与地图建筑的对应未确认，显示粗模",
} as const;
const km = (metres: number) => `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
export function BuildingReadout({ status, retry, plan, update, eyeAltitude, cameraGround }: {
  status: BuildingStatus; retry: () => void; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void;
  eyeAltitude?: number; cameraGround: number | null;
}) {
  const phase = status.phase, enabled = phase !== "off";
  const nearby = useMemo(() => landmarksInRange(plan), [plan.longitude, plan.latitude]);
  const progress = phase === "loading" ? status.progress : undefined;
  const omitted = status.candidates !== undefined ? Math.max(0, status.candidates - status.polygons) : 0;
  const coverage = status.coverage ?? BUILDING_RADIUS;
  const aim = (target: LandmarkDefinition, ground?: number) => {
    const base = ground ?? cameraGround ?? 0;
    const eye = { longitude: plan.longitude, latitude: plan.latitude, ellipsoidalHeight: eyeAltitude ?? (cameraGround ?? base) + plan.cameraHeight };
    const [east, north, up] = ellipsoidalRay(eye, { longitude: target.longitude, latitude: target.latitude, ellipsoidalHeight: base + target.bounds.height / 2 });
    const round = (value: number) => Math.round(value * 100) / 100;
    update({
      azimuth: round(((Math.atan2(east, north) * 180) / Math.PI + 360) % 360),
      pitch: round((Math.atan2(up, Math.hypot(east, north)) * 180) / Math.PI),
    });
  };
  return <div className="building-readout" aria-label="建筑数据状态" data-building-phase={phase}>
    <p role="status" className="building-phase">
      {phase === "off" ? "建筑已关闭" : phase === "loading" ? `正在加载建筑${progress ? ` · ${stages[progress.stage]} ${Math.round(progress.done / Math.max(1, progress.total) * 100)}%` : "…"}` :
        phase === "error" ? `建筑未应用 · ${status.message}` : phase === "empty" ? "附近没有可用的建筑数据" : "建筑已加载"}
    </p>
    {phase === "loading" && <progress className="building-progress" aria-label="建筑加载进度"
      max={progress?.total || 1} value={progress ? progress.done : undefined} />}
    {phase === "error" && <p>建筑遮挡未知，地形预览继续显示。</p>}
    {enabled && phase !== "loading" && <button type="button" onClick={retry}>重新读取建筑</button>}

    {(phase === "ready" || phase === "empty") && <section className="building-section" aria-label="加载范围">
      <h3>加载范围</h3>
      <p>OSM 粗模：约 {km(coverage)} 内{coverage < BUILDING_RADIUS ? "（已达瓦片数量上限）" : ""}，{BUILDING_NEAR_RADIUS / 1000} km 外只显示 {BUILDING_FAR_MIN_HEIGHT} m 以上的建筑</p>
      <p>地标精模：约 {LANDMARK_RADIUS / 1000} km 内</p>
      {omitted > 0 && <p role="status">此处建筑较密，已省略 {omitted.toLocaleString()} 个较小或较远的建筑。</p>}
    </section>}

    {enabled && <section className="building-section" aria-label="地标精模">
      <h3>地标精模{status.landmarks && nearby.length > 0 && ` · 已加载 ${status.landmarks.filter(item => item.phase === "applied").length} / ${nearby.length}`}</h3>
      {!nearby.length ? <p>{LANDMARK_RADIUS / 1000} km 内暂无已接入的地标精模。</p> : <>
        {nearby.map(({ target, distance }) => {
          const item = phase === "ready" || phase === "empty" ? status.landmarks?.find(entry => entry.id === target.id) : undefined;
          const state = phase === "loading" ? "加载中" : phase === "error" ? "未加载" : !item ? "未加载" :
            item.phase === "applied" ? `已加载${target.validation.visual === "pending" ? " · 画面待验证" : ""}` : reasons[item.reason ?? "failed"];
          return <div className="building-landmark" key={target.id} data-landmark-id={target.id} data-landmark-phase={item?.phase ?? phase}>
            <span><strong>{target.name}</strong><small>{km(distance)} · {state}</small></span>
            <button type="button" aria-label={`朝向${target.name}`} onClick={() => aim(target, item?.ground)}>朝向</button>
          </div>;
        })}
        <p className="building-note">精模为无纹理外观，位置与朝向为近似。</p>
      </>}
    </section>}

    {enabled && <p className="building-note">建筑来自 OpenStreetMap，部分地区缺失，高度可能为估算，屋顶简化为平顶。</p>}
  </div>;
}
