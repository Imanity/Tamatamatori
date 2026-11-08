import { useEffect, useMemo, useState } from "react";
import type { ShootingPlan } from "../domain/plan";
import {
  emptySkyVisibility,
  skyPointView,
  skyReference,
} from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import type { SkyPoint } from "../domain/starfield";
import type { WeatherSample } from "../domain/weather";
import { cloudOpacity, weatherClouds } from "../domain/weather-appearance";
import { refractDirection } from "../domain/refraction";
import {
  deepSkyScene,
  deepSkyView,
  deepSkyKinds,
} from "../domain/deep-sky";
import type { DeepSkyTarget } from "../domain/deep-sky";
import { constellationScene } from "../domain/constellations";
import { celestialPlanKey, skyLabelKey, occlusionText } from "../domain/visibility";
import {
  skyAppearance,
  starOpacity,
  STAR_LABEL_ALPHA,
} from "../domain/sky-appearance";

export { emptySkyVisibility };
export function useStarScene(plan: ShootingPlan, visibility: SkyVisibility, artificialMcd?: number, weather?: WeatherSample, renderView?: { azimuth: number; pitch: number }) {
  const result = useMemo(() => {
    if (
      !plan.layers.stars &&
      !plan.layers.milkyWay &&
      !plan.layers.constellations &&
      !plan.layers.deepSky
    )
      return {
        model: null,
        appearance: null,
        figures: [],
        deep: [],
        error: "",
      };
    try {
      const model = skyReference(plan);
      return {
        model,
        appearance: skyAppearance(model.sunElevation, model.moon, artificialMcd),
        figures: plan.layers.constellations
          ? constellationScene(plan).anchors
          : [],
        deep: plan.layers.deepSky ? deepSkyScene(plan).objects : [],
        error: "",
      };
    } catch {
      return {
        model: null,
        appearance: null,
        figures: [],
        deep: [],
        error: "星空计算失败，请检查机位与拍摄时刻。",
      };
    }
  }, [
    plan.latitude,
    plan.longitude,
    plan.instant,
    plan.layers.stars,
    plan.layers.milkyWay,
    plan.layers.constellations,
    plan.layers.deepSky,
    plan.refraction,
    artificialMcd,
  ]);
  const current = visibility.planKey === celestialPlanKey(plan),
    view = { ...plan, ...((current && visibility.ready ? visibility.view : null) ?? renderView) };
  const labelStates = visibility.labelKey === skyLabelKey(plan) && !visibility.message
    ? visibility.labelStates : current && visibility.ready ? visibility.states : undefined;
  const clouds = weather ? weatherClouds(weather, plan) : undefined;
  const points = result.model
    ? [
        ...(plan.layers.stars
          ? result.model.points.filter((p) => !!p.name)
          : []),
        ...(plan.layers.milkyWay ? [result.model.core] : []),
      ]
    : [];
  const project = (point: SkyPoint, reference = false) => {
    const isDeep = point.id.startsWith("dso-");
    const resource = visibility.deepSkyTargets?.[point.id] ?? visibility.deepSky;
    const projected = isDeep
        ? deepSkyView(view, point as DeepSkyTarget)
        : skyPointView(view, point),
      occlusion =
        current &&
        (visibility.message || visibility.occlusionUnavailable ||
          (isDeep && resource?.phase === "error"))
          ? "error"
          : current &&
              visibility.ready &&
              (!isDeep || resource?.phase === "ready")
            ? (visibility.states[point.id] ?? "waiting")
            : "waiting";
    const baseOpacity = reference ? 1 : isDeep ? (result.appearance?.galaxyStrength ?? 0)
      : result.appearance ? starOpacity(point, result.appearance) : 0;
    const opacity = baseOpacity * (1 - cloudOpacity(refractDirection(point.direction, plan.refraction), clouds));
    return {
      point,
      ...projected,
      occlusion,
      resource,
      labelBodyOcclusion: !isDeep || resource?.phase === "ready" ? labelStates?.[point.id] ?? "waiting" : "waiting",
      labelOcclusion: labelStates?.[isDeep ? `${point.id}:label` : point.id] ?? "waiting",
      partialFrame: "partialFrame" in projected && projected.partialFrame,
      opacity,
      cloudHidden: baseOpacity >= STAR_LABEL_ALPHA && opacity < STAR_LABEL_ALPHA,
    };
  };
  return {
    appearance: result.appearance,
    milkyWay: !plan.layers.milkyWay
      ? { phase: "off" as const }
      : current && visibility.milkyWay
        ? visibility.milkyWay
        : { phase: "loading" as const },
    deepSky: !plan.layers.deepSky
      ? { phase: "off" as const }
      : current && visibility.deepSky
        ? visibility.deepSky
        : { phase: "loading" as const },
    error: result.error || (current ? (visibility.message ?? "") : ""),
    targets: points.map((point) => project(point)),
    figures: result.figures.map((point) => project(point, true)),
    deep: result.deep.map((point) => ({
      ...project(point),
      entry: point.entry,
    })),
  };
}
type Scene = ReturnType<typeof useStarScene>;
function useDelayedLoading(phase: string) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    setDelayed(false);
    if (phase !== "loading") return;
    const timer = setTimeout(() => setDelayed(true), 800);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase === "loading" && delayed;
}

export function StarLabels({ scene }: { scene: Scene }) {
  const galaxyLoading = useDelayedLoading(scene.milkyWay.phase);
  const deepLoading = useDelayedLoading(scene.deepSky.phase);
  const placed: { x: number; y: number }[] = [];
  const placedFigures: { x: number; y: number }[] = [];
  return (
    <>
      <div className="sky-feedback-stack">
        {(galaxyLoading ||
          scene.milkyWay.phase === "error") && (
          <p className="sky-texture-feedback" role="status">
            {scene.milkyWay.phase === "error"
              ? scene.milkyWay.message
              : "正在加载银河细节…"}
          </p>
        )}
        {(deepLoading ||
          scene.deepSky.phase === "error") && (
          <p className="deep-sky-feedback" role="status">
            {scene.deepSky.phase === "error"
              ? scene.deepSky.message
              : "正在加载深空轮廓…"}
          </p>
        )}
      </div>
      {[...scene.targets, ...scene.figures, ...scene.deep].map(
        ({ point, pixel, state, labelOcclusion, labelBodyOcclusion, opacity }) => {
          const figure = point.id.startsWith("constellation-"),
            occupied = figure ? placedFigures : placed;
          if (
            !pixel ||
            state !== "画面内" ||
            labelOcclusion !== "clear" ||
            (labelBodyOcclusion !== "clear" && labelBodyOcclusion !== "partial") ||
            Math.abs(pixel.x) > 1 ||
            Math.abs(pixel.y) > 1 ||
            opacity < STAR_LABEL_ALPHA ||
            occupied.some(
              (p) =>
                Math.abs(p.x - pixel.x) < 0.18 && Math.abs(p.y - pixel.y) < 0.1,
            )
          )
            return null;
          occupied.push(pixel);
          return (
            <span
              className={`sky-label ${point.id === "galactic-center" ? "sky-core-label" : ""} ${figure ? "constellation-label" : ""}`}
              key={point.id}
              data-sky-label={point.name}
              data-dso-label={
                point.id.startsWith("dso-") ? point.name : undefined
              }
              data-constellation-label={figure ? point.name : undefined}
              style={{
                opacity: Math.min(1, opacity / 0.35),
                left: `clamp(50px, ${(pixel.x + 1) * 50}%, calc(100% - 50px))`,
                top: `clamp(22px, calc(${(pixel.y + 1) * 50}% + ${figure ? 18 : -12}px), calc(100% - 20px))`,
              }}
            >
              {point.name}
              {point.id === "galactic-center" && <small>方向参考</small>}
            </span>
          );
        },
      )}
    </>
  );
}
export function StarReadout({
  scene,
  plan,
  update,
  section,
}: {
  scene: Scene;
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  section?: "stars" | "milkyWay" | "deepSky";
}) {
  const stars = !section || section === "stars";
  const galaxy = !section || section === "milkyWay";
  const deep = !section || section === "deepSky";
  if (
    !plan.layers.stars &&
    !plan.layers.milkyWay &&
    !plan.layers.constellations &&
    !plan.layers.deepSky
  )
    return null;
  return (
    <div className="sky-readout" aria-label="星空与银河状态">
      {scene.error && (
        <p role="status" className="celestial-error">
          {scene.error}
        </p>
      )}
      {deep && plan.layers.deepSky && (
        <>
          <details open>
            <summary>深空目标与朝向</summary>
            {scene.deep.map(
              ({ point, entry, state, occlusion, partialFrame, opacity, cloudHidden, resource }) => (
                <div
                  className="celestial-row"
                  key={point.id}
                  data-dso-status={point.name}
                >
                  <span>
                    {point.name}
                    <small>
                      {entry.aliases[0]} · {deepSkyKinds[entry.model]}
                    </small>
                  </span>
                  <span>
                    {state === "画面内"
                      ? resource?.phase === "error" ? "深空轮廓加载失败"
                        : resource?.phase === "loading" ? "正在加载影像"
                        : occlusion === "clear" && opacity < STAR_LABEL_ALPHA
                        ? cloudHidden ? "云层遮蔽" : "天空较亮 · 轮廓隐藏"
                        : `${partialFrame ? "部分入画 · " : ""}${occlusionText(occlusion,plan)}`
                      : state}
                  </span>
                  <span>
                    {point.azimuth.toFixed(1)}° / 几何{" "}
                    {point.elevation.toFixed(1)}° · 目录 {entry.majorArcmin}′ ×{" "}
                    {entry.minorArcmin}′
                  </span>
                  <button
                    aria-label={`朝向${point.name}`}
                    disabled={state === "地平线下"}
                    onClick={() => {
                      const ray = skyPointView(plan, point).ray;
                      update({
                        azimuth: point.azimuth,
                        pitch:
                          (Math.asin(Math.max(-1, Math.min(1, ray[2]))) * 180) /
                          Math.PI,
                      });
                    }}
                  >
                    朝向
                  </button>
                </div>
              ),
            )}
          </details>
        </>
      )}
      {scene.targets.some(t => t.point.id === "galactic-center" ? galaxy : stars) && (
        <details>
          <summary>星空目标与朝向</summary>
          {scene.targets.filter(t => t.point.id === "galactic-center" ? galaxy : stars).map(({ point, state, occlusion, opacity, cloudHidden }) => (
            <div
              className="celestial-row"
              key={point.id}
              data-sky-status={point.name}
              data-sky-opacity={opacity.toFixed(3)}
            >
              <span>{point.name}</span>
              <span>
                {state !== "画面内"
                  ? state
                  : occlusion !== "clear"
                    ? occlusionText(occlusion,plan)
                    : opacity < STAR_LABEL_ALPHA
                      ? cloudHidden ? "云层遮蔽" : "天空较亮 · 星点隐藏"
                      : occlusionText(occlusion,plan)}
              </span>
              <span>
                {point.azimuth.toFixed(1)}° / 几何 {point.elevation.toFixed(1)}°
              </span>
              <button
                aria-label={`朝向${point.name}`}
                disabled={state === "地平线下"}
                onClick={() => {
                  const ray = skyPointView(plan, point).ray;
                  update({
                    azimuth: point.azimuth,
                    pitch:
                      (Math.asin(Math.max(-1, Math.min(1, ray[2]))) * 180) /
                      Math.PI,
                  });
                }}
              >
                朝向
              </button>
            </div>
          ))}
        </details>
      )}
      {stars && plan.layers.constellations && (
        <details>
          <summary>星座名称与朝向</summary>
          {scene.figures.map(({ point, state, occlusion }) => (
            <div
              className="celestial-row"
              key={point.id}
              data-constellation-status={point.name}
            >
              <span>{point.name}</span>
              <span>
                {state === "画面内" ? occlusionText(occlusion,plan) : state}
              </span>
              <span>
                {point.azimuth.toFixed(1)}° / 几何 {point.elevation.toFixed(1)}°
              </span>
              <button
                aria-label={`朝向${point.name}`}
                disabled={state === "地平线下"}
                onClick={() => {
                  const ray = skyPointView(plan, point).ray;
                  update({
                    azimuth: point.azimuth,
                    pitch: (Math.asin(ray[2]) * 180) / Math.PI,
                  });
                }}
              >
                朝向
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
