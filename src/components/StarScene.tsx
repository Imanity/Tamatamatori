import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import {
  emptySkyVisibility,
  skyPointView,
  skyReference,
  starCount,
} from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import {
  constellationScene,
  constellationCount,
} from "../domain/constellations";
import { celestialPlanKey, occlusionLabels } from "../domain/visibility";
import {
  skyAppearance,
  skyAppearanceLabel,
  starOpacity,
  STAR_LABEL_ALPHA,
} from "../domain/sky-appearance";

export { emptySkyVisibility };
export function useStarScene(plan: ShootingPlan, visibility: SkyVisibility) {
  const result = useMemo(() => {
    if (
      !plan.layers.stars &&
      !plan.layers.milkyWay &&
      !plan.layers.constellations
    )
      return { model: null, appearance: null, figures: [], error: "" };
    try {
      const model = skyReference(plan);
      return {
        model,
        appearance: skyAppearance(model.sunElevation, model.moon),
        figures: plan.layers.constellations
          ? constellationScene(plan).anchors
          : [],
        error: "",
      };
    } catch {
      return {
        model: null,
        appearance: null,
        figures: [],
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
    plan.refraction,
  ]);
  const current = visibility.planKey === celestialPlanKey(plan),
    view = current && visibility.view ? { ...plan, ...visibility.view } : plan;
  const points = result.model
    ? [
        ...(plan.layers.stars
          ? result.model.points.filter((p) => !!p.name)
          : []),
        ...(plan.layers.milkyWay ? [result.model.core] : []),
      ]
    : [];
  const project = (point: (typeof points)[number], reference = false) => {
    const projected = skyPointView(view, point),
      occlusion =
        current && visibility.message
          ? "error"
          : current && visibility.ready
            ? (visibility.states[point.id] ?? "waiting")
            : "waiting";
    return {
      point,
      ...projected,
      occlusion,
      opacity: reference
        ? 1
        : result.appearance
          ? starOpacity(point, result.appearance)
          : 0,
    };
  };
  return {
    appearance: result.appearance,
    error: result.error || (current ? (visibility.message ?? "") : ""),
    targets: points.map((point) => project(point)),
    figures: result.figures.map((point) => project(point, true)),
  };
}
type Scene = ReturnType<typeof useStarScene>;
export function StarLabels({ scene }: { scene: Scene }) {
  const placed: { x: number; y: number }[] = [];
  const placedFigures: { x: number; y: number }[] = [];
  return (
    <>
      {[...scene.targets, ...scene.figures].map(
        ({ point, pixel, state, occlusion, opacity }) => {
          const figure = point.id.startsWith("constellation-"),
            occupied = figure ? placedFigures : placed;
          if (
            !pixel ||
            state !== "画面内" ||
            occlusion !== "clear" ||
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
}: {
  scene: Scene;
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
}) {
  if (
    !plan.layers.stars &&
    !plan.layers.milkyWay &&
    !plan.layers.constellations
  )
    return null;
  const core = scene.targets.find((t) => t.point.id === "galactic-center");
  return (
    <div className="sky-readout" aria-label="星空与银河状态">
      {scene.error && (
        <p role="status" className="celestial-error">
          {scene.error}
        </p>
      )}
      {plan.layers.stars && (
        <p>星空 · 亮星目录 {starCount} 颗及金星、木星 · 星点为定位符号</p>
      )}
      {scene.appearance && (
        <p className="sky-appearance" role="status">
          明暗近似 · {skyAppearanceLabel(scene.appearance)}
        </p>
      )}
      {plan.layers.milkyWay && (
        <p>
          银河轮廓示意 · 银心
          {core?.state === "画面内"
            ? occlusionLabels[core.occlusion]
            : (core?.state ?? "计算中")}
        </p>
      )}
      {plan.layers.constellations && (
        <p>星座参考 · {constellationCount} 座 · 名称与连线仅作定位</p>
      )}
      {scene.targets.length > 0 && (
        <details>
          <summary>星空目标与朝向</summary>
          {scene.targets.map(({ point, state, occlusion, opacity }) => (
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
                    ? occlusionLabels[occlusion]
                    : opacity < STAR_LABEL_ALPHA
                      ? "天空较亮 · 星点隐藏"
                      : occlusionLabels[occlusion]}
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
      {plan.layers.constellations && (
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
                {state === "画面内" ? occlusionLabels[occlusion] : state}
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
      <p className="sky-limit">
        按当前 DEM 遮挡 · 银心环仅作定位 · 不含天气、曝光与光污染
      </p>
    </div>
  );
}
