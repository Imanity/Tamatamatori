import { useMemo } from "react";
import { Detail, where } from "../common/readout";
import type { ShootingPlan } from "../../domain/core/plan";
import { COMET_LIST_LIMIT, cometScene, visibleTailDegrees } from "../../domain/comets/comets";
import type { CometScene as Scene, CometView } from "../../domain/comets/comets";
import { catalogFreshness } from "../../domain/comets/comet-catalog";
import type { CometFeed } from "./useCometCatalog";
import { skyPointView } from "../../domain/sky/starfield";
import type { SkyVisibility } from "../../domain/sky/starfield";
import { celestialPlanKey, occlusionText, skyLabelKey } from "../../domain/core/visibility";
import type { Occlusion } from "../../domain/core/visibility";
import { apparentElevation } from "../../domain/core/refraction";

export function useCometScene(plan: ShootingPlan, feed: CometFeed, artificialMcd: number) {
  const on = !!plan.layers.comets, catalog = feed.catalog;
  const result = useMemo(() => {
    if (!on || !catalog) return { scene: null as Scene | null, error: "" };
    try { return { scene: cometScene(plan, catalog, artificialMcd), error: "" }; }
    catch { return { scene: null as Scene | null, error: "彗星计算失败，请检查机位与拍摄时刻。" }; }
  }, [on, catalog, plan.latitude, plan.longitude, plan.instant, artificialMcd]);
  return { on, feed, ...result };
}
type CometState = ReturnType<typeof useCometScene>;

function headState(plan: ShootingPlan, visibility: SkyVisibility, view: CometView) {
  const planCurrent = visibility.planKey === celestialPlanKey(plan);
  const camera = planCurrent && visibility.view ? { ...plan, ...visibility.view } : plan;
  const projected = skyPointView(camera, view.point);
  const occlusion: Occlusion = planCurrent && (visibility.message || visibility.occlusionUnavailable) ? "error"
    : planCurrent && visibility.ready ? visibility.states[view.point.id] ?? "waiting" : "waiting";
  const label = visibility.labelKey === skyLabelKey(plan) && !visibility.message ? visibility.labelStates?.[view.point.id] : occlusion;
  return { ...projected, occlusion, label };
}

/** Designation without the discoverer in parentheses, which the name already carries. */
const designation = (view: CometView) => view.comet.designation.replace(/\s*\([^)]*\)$/, "");
const magnitudeText = (view: CometView) => `${view.magnitude.toFixed(1)} 等${view.extrapolated ? "（外推）" : ""}`;
const degreesText = (value: number) => (value >= 10 ? `${Math.round(value)}°` : value >= 1 ? `${value.toFixed(1)}°` : `${Math.round(value * 60)}′`);

/**
 * Comet names beside the heads; hidden behind terrain like other sky labels.
 * Views come brightest first, so a fainter comet next to a labelled one stays
 * unnamed in the preview and is still listed in the information group.
 */
export function CometLabels({ plan, comets, visibility }: { plan: ShootingPlan; comets: CometState; visibility: SkyVisibility }) {
  if (!comets.on || !comets.scene) return null;
  const placed: { x: number; y: number }[] = [];
  return comets.scene.views.map((view) => {
    const state = headState(plan, visibility, view);
    if (state.state !== "画面内" || state.label !== "clear" || !state.pixel) return null;
    const { x, y } = state.pixel;
    if (placed.some((other) => Math.abs(other.x - x) < 0.14 && Math.abs(other.y - y) < 0.08)) return null;
    placed.push({ x, y });
    return (
      <span key={view.comet.key} className="sky-label comet-label" data-comet-label={view.comet.id}
        style={{ left: `${(state.pixel.x + 1) * 50}%`, top: `calc(${(state.pixel.y + 1) * 50}% - 12px)` }}>
        {view.comet.name}<small>{view.magnitude.toFixed(1)} 等</small>
      </span>
    );
  });
}

/** Brightness in words for photographers; the magnitude itself stays beside it. */
function brightness(magnitude: number) {
  if (magnitude <= 4) return "较亮，暗夜或可肉眼看到";
  if (magnitude <= 7) return "需双筒或长曝光";
  return "较暗，需长焦长曝光";
}

export function CometReadout({ plan, comets, visibility, update }: {
  plan: ShootingPlan; comets: CometState; visibility: SkyVisibility; update: (patch: Partial<ShootingPlan>) => void;
}) {
  const scene = comets.scene, { catalog, phase, error, retry } = comets.feed;
  const fresh = catalog ? catalogFreshness(catalog) : null;
  return (
    <div className="comet-readout" aria-label="彗星信息">
      {!comets.on && <p className="info-empty">彗星已关闭</p>}
      {comets.on && !catalog && phase !== "error" && <p className="info-empty" role="status">彗星目录读取中…</p>}
      {comets.on && phase === "error" && (
        <p className="celestial-error" role="status" data-comet-feed="error">
          {catalog ? `彗星目录刷新失败，沿用 ${fresh!.updated} 的目录 · ${error}` : `彗星目录读取失败 · ${error}`}
          <button type="button" onClick={retry}>重试</button>
        </p>
      )}
      {comets.on && fresh?.paused && (
        <p className="comet-catalog-note" role="status" data-comet-feed="paused">目录自动更新已暂停，沿用 {fresh.updated} 的目录；新发现或新近变亮的彗星可能缺失。</p>
      )}
      {comets.on && fresh && !fresh.paused && fresh.stale && (
        <p className="comet-catalog-note" role="status" data-comet-feed="stale">目录已 {fresh.days} 天未更新，新发现或新近变亮的彗星可能缺失。</p>
      )}
      {comets.error && <p className="celestial-error" role="status">{comets.error}</p>}
      {scene && !scene.inWindow && (
        <p className="info-empty">拍摄时刻没有收录的彗星处于回归期</p>
      )}
      {scene && scene.inWindow > 0 && !scene.views.length && (
        <p className="info-empty">处于回归期的 {scene.inWindow} 颗彗星此时都暗于 {COMET_LIST_LIMIT} 等</p>
      )}
      {scene && scene.views.length > 0 && scene.visibleShare < 1 && (
        <p className="comet-sky" data-comet-sky>
          {scene.visibleShare <= 0 ? "天空过亮，彗尾不显示" : `天空比暗夜亮约 ${scene.skyFade.toFixed(1)} 等，彗尾约显示前 ${Math.round(scene.visibleShare * 100)}%`}
        </p>
      )}
      {scene?.views.map((view) => {
        const state = headState(plan, visibility, view);
        const elevation = apparentElevation(view.point.elevation, plan.refraction);
        const ion = visibleTailDegrees(view.ion, scene.visibleShare), dust = visibleTailDegrees(view.dust, scene.visibleShare);
        const dimmed = scene.visibleShare < 1;
        return (
          <div key={view.comet.key} className="celestial-row comet-row" data-comet-status={view.comet.id}>
            <span className="celestial-name">{view.comet.name} <small>{designation(view)}</small></span>
            <span className="celestial-state">{state.state === "画面内" ? occlusionText(state.occlusion, plan) : state.state}</span>
            <span className="celestial-coordinates">{where(view.point.azimuth, elevation)} · {magnitudeText(view)}（{brightness(view.magnitude)}）<Detail>{view.point.azimuth.toFixed(1)}° / 视 {elevation.toFixed(1)}°</Detail></span>
            <span data-comet-tail>
              {scene.visibleShare <= 0
                ? `彗尾不显示 · 暗夜离子尾 ${degreesText(view.ionDegrees)} / 尘埃尾 ${degreesText(view.dustDegrees)}`
                : <>
                  离子尾 {degreesText(dimmed ? ion : view.ionDegrees)} · 尘埃尾 {degreesText(dimmed ? dust : view.dustDegrees)}
                  {dimmed && ` · 暗夜 ${degreesText(view.ionDegrees)} / ${degreesText(view.dustDegrees)}`}
                </>}
            </span>
            <span className="comet-distance info-detail">
              距日 {view.r.toFixed(2)} au · 距地 {view.delta.toFixed(2)} au · 彗发约 {degreesText(view.comaRadius * 2)}
            </span>
            <button aria-label={`朝向${view.comet.name}`} disabled={state.state === "地平线下"}
              onClick={() => update({ azimuth: view.point.azimuth, pitch: elevation })}>朝向</button>
          </div>
        );
      })}
      {comets.on && fresh && (
        <p className="comet-basis info-detail">
          彗尾为暗夜长曝光口径的经验长度，按实际几何投影；亮度参数拟合自 COBS 目视观测，实际亮度常有 1 等以上出入。收录 1990 年起亮于 10 等的回归，目录更新于 <span data-comet-updated>{fresh.updated}</span>，每 3 小时自动检查新彗星。
        </p>
      )}
    </div>
  );
}
