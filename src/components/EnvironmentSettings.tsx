import type { ShootingPlan } from "../domain/plan";
import { weatherModels } from "../domain/weather";
import type { WeatherModel } from "../domain/weather";
import { Icon } from "./Icon";

export function EnvironmentSettings({ plan, update }: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
}) {
  return <details className="sidebar-group environment-settings" open>
    <summary><Icon name="cloud" size={17} />环境</summary>
    <label className="layer-row layer-toggle">
      <Icon name="light" size={19} /><span>光污染</span>
      <input type="checkbox" role="switch" aria-label="当地光污染" checked={!!plan.lightPollution}
        onChange={() => update({ lightPollution: !plan.lightPollution })} />
    </label>
    <label className="layer-row layer-toggle">
      <Icon name="cloud" size={19} /><span>天气效果</span>
      <input type="checkbox" role="switch" aria-label="天气效果" checked={!!plan.weather}
        onChange={() => update({ weather: !plan.weather })} />
    </label>
    <label className="environment-model">
      <span>预测模型</span>
      <select aria-label="天气预测模型" value={plan.weatherModel ?? "best_match"}
        onChange={event => update({ weatherModel: event.target.value as WeatherModel })}>
        {Object.entries(weatherModels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  </details>;
}
