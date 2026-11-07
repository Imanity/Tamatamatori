import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import { searchTargets } from "../domain/target-search";
import { skyPointView, skyReference } from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import { bodyPolygons } from "../domain/celestial-projection";
import { celestialPlanKey, occlusionText } from "../domain/visibility";
import type { VisibilitySnapshot } from "../domain/visibility";
import type { WeatherSample } from "../domain/weather";
import { cloudOpacity, weatherClouds } from "../domain/weather-appearance";
import { refractDirection } from "../domain/refraction";
import { deepSkyView, deepSkyImageSource, deepSkySourceNote } from "../domain/deep-sky";
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
  additionalCount = 0,
  artificialMcd,
  weather,
}: {
  plan: ShootingPlan;
  view: ShootingPlan;
  query: string;
  skyVisibility: SkyVisibility;
  visibility: VisibilitySnapshot;
  update: (patch: Partial<ShootingPlan>) => void;
  additionalCount?: number;
  artificialMcd?: number;
  weather?: WeatherSample;
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
          (!(result.targets.length + additionalCount)
            ? "没有找到匹配目标"
            : `找到 ${result.targets.length + additionalCount} 个目标`)}
      </p>
      {!result.error && !result.targets.length && !additionalCount && (
        <p className="info-empty">试试“织女星”“Vega”或“Ori”。</p>
      )}
      {result.targets.map((target) => {
        const deepEntry = target.deep?.entry;
        const structureLabel = deepEntry
          ? deepSkyImageSource(deepEntry.catalogId)
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
                  : skyVisibility.message || skyVisibility.occlusionUnavailable
                    ? "error"
                    : skyVisibility.ready
                      ? (skyVisibility.states[target.id] ?? "waiting")
                      : "waiting";
        let status = state === "画面内" ? occlusionText(occlusion,plan) : state;
        if (!enabled) status = `图层已关闭 · ${state}`;
        else if (target.deep && state === "画面内") {
          if (resource?.phase === "error")
            status = "深空轮廓加载失败";
          else if (resource?.phase === "loading") status = "正在加载影像";
          else if (occlusion === "clear" || occlusion === "partial") {
            const sky = skyReference(plan);
            if (
              skyAppearance(sky.sunElevation, sky.moon, artificialMcd).galaxyStrength <
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
            starOpacity(target, skyAppearance(sky.sunElevation, sky.moon, artificialMcd)) <
            STAR_LABEL_ALPHA
          )
            status = "天空较亮 · 星点隐藏";
        }
        if (enabled && state === "画面内" && (occlusion === "clear" || occlusion === "partial") && weather) {
          const sky = skyReference(plan), appearance = skyAppearance(sky.sunElevation, sky.moon, artificialMcd);
          const baseOpacity = target.body || target.layer === "constellations" ? 1
            : target.deep ? appearance.galaxyStrength : starOpacity(target, appearance);
          const transmission = 1 - cloudOpacity(refractDirection(target.direction, plan.refraction), weatherClouds(weather, plan));
          if (baseOpacity >= STAR_LABEL_ALPHA && baseOpacity * transmission < STAR_LABEL_ALPHA)
            status = "云层遮蔽 · 显示近似";
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
                if (target.layer === "constellations") layers.stars = true;
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
