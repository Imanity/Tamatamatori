import type { ReactNode } from "react";
import type { ShootingPlan } from "../domain/plan";
import { weatherModels } from "../domain/weather";
import type { WeatherModel } from "../domain/weather";
import { Icon } from "./Icon";

/**
 * Environment switches inside the "光照与环境" group: light pollution and the
 * weather effect, each followed by its conclusion, then the forecast model and
 * the refraction model.
 */
export function EnvironmentSettings({ plan, update, children, autoSource = null }: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  children: { pollution: ReactNode; weather: ReactNode };
  /** The model "自动匹配" uses at the shooting hour, while weather is on and it is chosen. */
  autoSource?: { phase: "loading" | "ready" | "error"; label: string | null } | null;
}) {
  const autoNote = !autoSource ? ""
    : autoSource.phase === "loading" ? "（识别来源中）"
      : autoSource.phase === "error" ? "（来源未知）"
        : `（${autoSource.label ?? "来源未能确定"}）`;
  return <div className="environment-settings">
    <div className="environment-row">
      <label className="subsetting-toggle layer-toggle">
        <span><Icon name="light" size={15} />光污染</span>
        <input type="checkbox" role="switch" aria-label="当地光污染" checked={!!plan.lightPollution}
          onChange={() => update({ lightPollution: !plan.lightPollution })} />
      </label>
      {children.pollution}
    </div>
    <div className="environment-row">
      <label className="subsetting-toggle layer-toggle">
        <span><Icon name="cloud" size={15} />天气效果</span>
        <input type="checkbox" role="switch" aria-label="天气效果" checked={!!plan.weather}
          onChange={() => update({ weather: !plan.weather })} />
      </label>
      {children.weather}
    </div>
    <div className="environment-selects">
      <label className="environment-model"
        title="自动匹配由 Open-Meteo 按地区选用当地最合适的模型（如日本使用日本气象厅 JMA 模型），该模型不提供的变量（如能见度）取自其他模型；其余为单一全球模型，结果可能明显不同。">
        <span>预测模型</span>
        <select aria-label="天气预测模型" value={plan.weatherModel ?? "best_match"}
          onChange={event => update({ weatherModel: event.target.value as WeatherModel })}>
          {Object.entries(weatherModels).map(([id, name]) =>
            <option key={id} value={id}>{id === "best_match" ? `${name}${autoNote}` : name}</option>)}
        </select>
      </label>
      <label className="environment-model" title="标准折射为固定海平面参考大气；无折射显示几何位置">
        <span>大气折射</span>
        <select aria-label="大气折射模型" value={plan.refraction}
          onChange={event => update({ refraction: event.target.value as ShootingPlan["refraction"] })}>
          <option value="standard">标准折射 · 海平面近似</option>
          <option value="none">无折射 · 几何位置</option>
        </select>
      </label>
    </div>
  </div>;
}
