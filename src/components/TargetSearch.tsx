import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import { searchTargets } from "../domain/target-search";
import { skyPointView, skyReference } from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import { bodyPolygons } from "../domain/celestial-projection";
import { celestialPlanKey, occlusionLabels } from "../domain/visibility";
import type { VisibilitySnapshot } from "../domain/visibility";
import { deepSkyView, deepSkyImageCredits, deepSkySourceNote } from "../domain/deep-sky";
import {
  skyAppearance,
  starOpacity,
  STAR_LABEL_ALPHA,
} from "../domain/sky-appearance";

export function TargetSearchResults({
  plan,
  view,
  query,
  skyVisibility,
  visibility,
  update,
}: {
  plan: ShootingPlan;
  view: ShootingPlan;
  query: string;
  skyVisibility: SkyVisibility;
  visibility: VisibilitySnapshot;
  update: (patch: Partial<ShootingPlan>) => void;
}) {
  const result = useMemo(() => {
    try {
      return { targets: searchTargets(plan, query), error: "" };
    } catch {
      return { targets: [], error: "目标位置计算失败，请检查机位与拍摄时刻。" };
    }
  }, [plan.latitude, plan.longitude, plan.instant, plan.refraction, query]);
  const key = celestialPlanKey(plan);
  return (
    <section className="target-search-results" aria-label="目标搜索结果">
      <p className="search-result-count" role="status">
        {result.error ||
          (!result.targets.length
            ? "没有找到匹配目标"
            : `找到 ${result.targets.length} 个目标`)}
      </p>
      {!result.error && !result.targets.length && (
        <p className="info-empty">试试“织女星”“Vega”或“Ori”。</p>
      )}
      {result.targets.map((target) => {
        const deepEntry = target.deep?.entry;
        const structureLabel = deepEntry
          ? deepSkyImageCredits.some(
              (source) => source.catalogId === deepEntry.catalogId,
            )
            ? "影像结构参考"
            : "目录轮廓"
          : null;
        const projected = target.deep
            ? deepSkyView(view, target.deep)
            : skyPointView(view, target),
          bodyView = target.body ? bodyPolygons(view, target.body) : null;
        const state = bodyView?.state ?? projected.state,
          enabled = plan.layers[target.layer],
          below = state === "地平线下";
        const resource = skyVisibility.planKey === key
          ? skyVisibility.deepSkyTargets?.[target.id] ?? skyVisibility.deepSky
          : undefined;
        const occlusion =
          target.deep && resource?.phase === "error"
            ? "error"
            : target.deep && resource?.phase !== "ready"
              ? "waiting"
              : target.body
                ? visibility.planKey === key
                  ? visibility.states[target.body.id]
                  : "waiting"
                : skyVisibility.planKey !== key
                  ? "waiting"
                  : skyVisibility.message
                    ? "error"
                    : skyVisibility.ready
                      ? (skyVisibility.states[target.id] ?? "waiting")
                      : "waiting";
        let status = state === "画面内" ? occlusionLabels[occlusion] : state;
        if (!enabled) status = `图层已关闭 · ${state}`;
        else if (target.deep && state === "画面内") {
          if (resource?.phase === "error")
            status = "深空轮廓加载失败";
          else if (resource?.phase === "loading") status = "正在加载影像";
          else if (occlusion === "clear" || occlusion === "partial") {
            const sky = skyReference(plan);
            if (
              skyAppearance(sky.sunElevation, sky.moon).galaxyStrength <
              STAR_LABEL_ALPHA
            )
              status = "天空较亮 · 轮廓隐藏";
          }
        } else if (
          target.layer === "stars" &&
          state === "画面内" &&
          occlusion === "clear"
        ) {
          const sky = skyReference(plan);
          if (
            starOpacity(target, skyAppearance(sky.sunElevation, sky.moon)) <
            STAR_LABEL_ALPHA
          )
            status = "天空较亮 · 星点隐藏";
        }
        const action = !enabled ? (below ? "开启图层" : "开启并朝向") : "朝向";
        return (
          <div
            className="celestial-row search-target"
            data-search-target={target.id}
            key={target.id}
          >
            <span>
              {target.name}
              <small>
                {target.kind}
                {structureLabel && ` · ${structureLabel}`}
                {deepEntry && deepSkySourceNote(deepEntry.catalogId) && ` · ${deepSkySourceNote(deepEntry.catalogId)}`}
              </small>
            </span>
            <span>{status}</span>
            <span>
              {target.azimuth.toFixed(1)}° / 几何 {target.elevation.toFixed(1)}°
            </span>
            <button
              aria-label={`${action}${target.name}`}
              disabled={enabled && below}
              onClick={() => {
                const layers = { ...plan.layers, [target.layer]: true };
                if (below) {
                  update({ layers });
                  return;
                }
                update({
                  layers,
                  azimuth: target.azimuth,
                  pitch:
                    bodyView?.visualElevation ??
                    (Math.asin(Math.max(-1, Math.min(1, projected.ray[2]))) *
                      180) /
                      Math.PI,
                });
              }}
            >
              {action}
            </button>
          </div>
        );
      })}
    </section>
  );
}
