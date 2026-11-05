import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import {
  emptySkyVisibility,
  primarySkyNames,
  skyPointView,
  skyReference,
  starCount,
} from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import { celestialPlanKey, occlusionLabels } from "../domain/visibility";

export { emptySkyVisibility };
export function useStarScene(plan: ShootingPlan, visibility: SkyVisibility) {
  const result = useMemo(() => {
    if (!plan.layers.stars && !plan.layers.milkyWay)
      return { model: null, error: "" };
    try {
      return { model: skyReference(plan), error: "" };
    } catch {
      return { model: null, error: "星空计算失败，请检查机位与拍摄时刻。" };
    }
  }, [
    plan.latitude,
    plan.longitude,
    plan.instant,
    plan.layers.stars,
    plan.layers.milkyWay,
  ]);
  const current = visibility.planKey === celestialPlanKey(plan),
    view = current && visibility.view ? { ...plan, ...visibility.view } : plan;
  const points = result.model
    ? [
        ...(plan.layers.stars
          ? result.model.points.filter((p) =>
              primarySkyNames.includes(p.name ?? ""),
            )
          : []),
        ...(plan.layers.milkyWay ? [result.model.core] : []),
      ]
    : [];
  return {
    error: result.error || (current ? (visibility.message ?? "") : ""),
    targets: points.map((point) => {
      const projected = skyPointView(view, point),
        occlusion =
          current && visibility.message
            ? "error"
            : current && visibility.ready
              ? (visibility.states[point.id] ?? "waiting")
              : "waiting";
      return { point, ...projected, occlusion };
    }),
  };
}
type Scene = ReturnType<typeof useStarScene>;
export function StarLabels({ scene }: { scene: Scene }) {
  const placed: { x: number; y: number }[] = [];
  return (
    <>
      {scene.targets.map(({ point, pixel, state, occlusion }) => {
        if (
          !pixel ||
          state !== "画面内" ||
          occlusion !== "clear" ||
          placed.some(
            (p) =>
              Math.abs(p.x - pixel.x) < 0.18 && Math.abs(p.y - pixel.y) < 0.1,
          )
        )
          return null;
        placed.push(pixel);
        return (
          <span
            className={`sky-label ${point.id === "galactic-center" ? "sky-core-label" : ""}`}
            key={point.id}
            data-sky-label={point.name}
            style={{
              left: `clamp(30px, ${(pixel.x + 1) * 50}%, calc(100% - 30px))`,
              top: `clamp(22px, calc(${(pixel.y + 1) * 50}% - 12px), calc(100% - 20px))`,
            }}
          >
            {point.name}
            {point.id === "galactic-center" && <small>方向参考</small>}
          </span>
        );
      })}
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
  if (!plan.layers.stars && !plan.layers.milkyWay) return null;
  const core = scene.targets.find((t) => t.point.id === "galactic-center");
  return (
    <div className="sky-readout" aria-label="星空与银河状态">
      {scene.error && (
        <p role="status" className="celestial-error">
          {scene.error}
        </p>
      )}
      {plan.layers.stars && (
        <p>星空 · {starCount} 颗亮星及金星、木星 · 星点为定位符号</p>
      )}
      {plan.layers.milkyWay && (
        <p>
          银河轮廓示意 · 银心
          {core?.state === "画面内"
            ? occlusionLabels[core.occlusion]
            : (core?.state ?? "计算中")}
        </p>
      )}
      <details>
        <summary>星空目标与朝向</summary>
        {scene.targets.map(({ point, state, occlusion }) => (
          <div
            className="celestial-row"
            key={point.id}
            data-sky-status={point.name}
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
      <p className="sky-limit">
        按当前 DEM 遮挡 · 不代表真实亮度、白昼可见性或实拍银河
      </p>
    </div>
  );
}
