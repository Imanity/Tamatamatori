// The "光照与环境" group: lighting phase and moonlight, the light pollution and
// weather settings with their readouts, and the framing values.
import type { ShootingPlan } from "../../domain/core/plan";
import { Detail, pollutionLevel } from "../common/readout";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { WeatherReadout } from "./WeatherReadout";
import { OpenMeteoUsage } from "./ApiUsage";
import type { useLightPollution } from "./useLightPollution";
import type { useWeather } from "./useWeather";

export function LightingGroup({ plan, update, phase, skyNote, sunElevation, moon, pollution, weatherFeed, view, fov }: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  phase: string;
  skyNote: string;
  sunElevation: number;
  moon: { elevation: number; illuminatedFraction: number } | null;
  pollution: ReturnType<typeof useLightPollution>;
  weatherFeed: ReturnType<typeof useWeather>;
  view: { azimuth: number; pitch: number };
  fov: { horizontal: number; vertical: number };
}) {
  const artificialMcd = pollution.phase === "ready" ? pollution.sample?.artificialMcd : undefined;
  return (
    <>
      <section className="info-section">
        <p className="preview-lighting" aria-label="预览光照状态">
          <strong>{phase}</strong>
          {skyNote && (
            <span className="sky-appearance" role="status">
              {" · "}{skyNote}
            </span>
          )}
          <Detail>太阳高度 {sunElevation.toFixed(1)}°</Detail>
          {sunElevation < -6 && moon && (
            <span className="preview-moonlight">
              {moon.elevation > 0
                ? `月亮在地平线上，亮面 ${(moon.illuminatedFraction * 100).toFixed(0)}%`
                : "月亮在地平线下，无月光"}
              <Detail>
                月亮亮面 {(moon.illuminatedFraction * 100).toFixed(0)}% · 高度{" "}
                {moon.elevation.toFixed(1)}°
              </Detail>
            </span>
          )}
        </p>
      </section>
      <section className="info-section environment-section">
        <EnvironmentSettings plan={plan} update={update} autoSource={weatherFeed.autoSource}>
          {{
            pollution: (
              <div className="pollution-readout" aria-label="当地光污染数据">
                <p>
                  {pollution.phase === "off"
                    ? "当地光污染已关闭"
                    : pollution.phase === "ready"
                      ? <>
                          {pollutionLevel(artificialMcd!)}
                          <Detail>{pollution.year} 天顶人工亮度 ≈ {artificialMcd!.toFixed(3)} mcd/m²</Detail>
                        </>
                      : pollution.phase === "loading"
                        ? "正在读取当地光污染，效果待应用"
                        : pollution.message}
                </p>
                {pollution.phase === "error" && (
                  <button type="button" onClick={pollution.retry}>
                    重试光污染数据
                  </button>
                )}
              </div>
            ),
            weather: <WeatherReadout feed={weatherFeed} update={update} />,
          }}
        </EnvironmentSettings>
        <OpenMeteoUsage active={!!plan.weather || !!plan.layers.tides} />
      </section>
      <section className="info-section info-detail-section">
        <h3>取景参数</h3>
        <div className="preview-readout info-detail">
          <span>
            方位 <strong>{view.azimuth.toFixed(1)}°</strong>
          </span>
          <span>
            俯仰 <strong>{view.pitch.toFixed(1)}°</strong>
          </span>
          <span>
            水平视场 <strong>{fov.horizontal.toFixed(1)}°</strong>
          </span>
          <span>
            垂直视场 <strong>{fov.vertical.toFixed(1)}°</strong>
          </span>
        </div>
      </section>
    </>
  );
}
