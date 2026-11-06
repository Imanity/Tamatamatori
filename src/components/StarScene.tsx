import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import {
  emptySkyVisibility,
  skyPointView,
  skyReference,
  starCount,
} from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import type { SkyPoint } from "../domain/starfield";
import {
  deepSkyScene,
  deepSkyView,
  deepSkyCount,
  deepSkyKinds,
  deepSkyResponseLabel,
  deepSkyImageSource,
  deepSkySourceNote,
} from "../domain/deep-sky";
import type { DeepSkyTarget } from "../domain/deep-sky";
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
        appearance: skyAppearance(model.sunElevation, model.moon),
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
  const project = (point: SkyPoint, reference = false) => {
    const isDeep = point.id.startsWith("dso-");
    const resource = visibility.deepSkyTargets?.[point.id] ?? visibility.deepSky;
    const projected = isDeep
        ? deepSkyView(view, point as DeepSkyTarget)
        : skyPointView(view, point),
      occlusion =
        current &&
        (visibility.message ||
          (isDeep && resource?.phase === "error"))
          ? "error"
          : current &&
              visibility.ready &&
              (!isDeep || resource?.phase === "ready")
            ? (visibility.states[point.id] ?? "waiting")
            : "waiting";
    return {
      point,
      ...projected,
      occlusion,
      resource,
      labelOcclusion: isDeep
        ? current && visibility.ready
          ? (visibility.states[`${point.id}:label`] ?? "waiting")
          : "waiting"
        : occlusion,
      partialFrame: "partialFrame" in projected && projected.partialFrame,
      opacity: reference
        ? 1
        : isDeep
          ? (result.appearance?.galaxyStrength ?? 0)
          : result.appearance
            ? starOpacity(point, result.appearance)
            : 0,
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
export function StarLabels({ scene }: { scene: Scene }) {
  const placed: { x: number; y: number }[] = [];
  const placedFigures: { x: number; y: number }[] = [];
  return (
    <>
      <div className="sky-feedback-stack">
        {(scene.milkyWay.phase === "loading" ||
          scene.milkyWay.phase === "error") && (
          <p className="sky-texture-feedback" role="status">
            {scene.milkyWay.phase === "error"
              ? scene.milkyWay.message
              : "正在加载银河细节…"}
          </p>
        )}
        {(scene.deepSky.phase === "loading" ||
          scene.deepSky.phase === "error") && (
          <p className="deep-sky-feedback" role="status">
            {scene.deepSky.phase === "error"
              ? scene.deepSky.message
              : "正在加载深空轮廓…"}
          </p>
        )}
      </div>
      {[...scene.targets, ...scene.figures, ...scene.deep].map(
        ({ point, pixel, state, labelOcclusion, occlusion, opacity }) => {
          const figure = point.id.startsWith("constellation-"),
            occupied = figure ? placedFigures : placed;
          if (
            !pixel ||
            state !== "画面内" ||
            labelOcclusion !== "clear" ||
            (occlusion !== "clear" && occlusion !== "partial") ||
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
}: {
  scene: Scene;
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
}) {
  if (
    !plan.layers.stars &&
    !plan.layers.milkyWay &&
    !plan.layers.constellations &&
    !plan.layers.deepSky
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
          银河细节 · 对比度 {plan.milkyWayContrast ?? 100}% · 全景衍生 · 银心
          {core?.state === "画面内"
            ? occlusionLabels[core.occlusion]
            : (core?.state ?? "计算中")}
        </p>
      )}
      {plan.layers.constellations && (
        <p>星座参考 · {constellationCount} 座 · 名称与连线仅作定位</p>
      )}
      {plan.layers.deepSky && (
        <>
          <p>
            深空轮廓 · {deepSkyCount} 个目标 ·{" "}
            {deepSkyResponseLabel(plan.cameraResponse)}
          </p>
            <p>源图色彩与红光增强示意 · 非实测 Hα、器材色彩或曝光预测</p>
          <p>
              {deepSkyCount} 个目标使用影像结构参考；未作具体相机定标。
          </p>
          <details open>
            <summary>深空目标与朝向</summary>
            {scene.deep.map(
              ({ point, entry, state, occlusion, partialFrame, opacity, resource }) => (
                <div
                  className="celestial-row"
                  key={point.id}
                  data-dso-status={point.name}
                >
                  <span>
                    {point.name}
                    <small>
                      {entry.aliases[0]} · {deepSkyKinds[entry.model]}
                      {" · "}
                      {deepSkyImageSource(entry.catalogId)
                        ? "影像结构参考"
                        : "目录轮廓"}
                      {deepSkySourceNote(entry.catalogId) && ` · ${deepSkySourceNote(entry.catalogId)}`}
                    </small>
                  </span>
                  <span>
                    {state === "画面内"
                      ? resource?.phase === "error" ? "深空轮廓加载失败"
                        : resource?.phase === "loading" ? "正在加载影像"
                        : occlusion === "clear" && opacity < STAR_LABEL_ALPHA
                        ? "天空较亮 · 轮廓隐藏"
                        : `${partialFrame ? "部分入画 · " : ""}${occlusionLabels[occlusion]}`
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
          <p className="sky-limit">
            遮挡按画面内发光轮廓；影像覆盖有限，照片星点仅作外观参考。外轮廓可包含周边云气，目录尺寸为参考。
          </p>
        </>
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
