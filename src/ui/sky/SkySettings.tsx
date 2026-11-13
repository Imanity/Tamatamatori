// Settings under the 星空, 银河 and 深空天体 group headings.
import type { ShootingPlan } from "../../domain/core/plan";

type Props = { plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void };

/** Constellation names and lines, under the stars. */
export function ConstellationSwitch({ plan, update }: Props) {
  return (
    <label className="subsetting-toggle layer-toggle">
      <span>星座名称与连线</span>
      <input
        type="checkbox"
        role="switch"
        aria-label="显示星座名称与连线"
        checked={plan.layers.constellations}
        disabled={!plan.layers.stars}
        onChange={() =>
          update({
            layers: {
              ...plan.layers,
              constellations: !plan.layers.constellations,
            },
          })
        }
      />
    </label>
  );
}

/** Milky Way display contrast. */
export function GalaxyContrast({ plan, update }: Props) {
  return (
    <div
      className="galaxy-contrast"
      role="group"
      aria-label="银河显示对比度"
    >
      <div className="galaxy-contrast-heading">
        <label htmlFor="galaxy-contrast">对比度</label>
        <output htmlFor="galaxy-contrast">
          {plan.milkyWayContrast}%
        </output>
      </div>
      <input
        id="galaxy-contrast"
        type="range"
        min="25"
        max="200"
        step="5"
        aria-label="银河对比度"
        disabled={!plan.layers.milkyWay}
        aria-valuetext={`${plan.milkyWayContrast}%`}
        value={plan.milkyWayContrast}
        onChange={(event) =>
          update({
            milkyWayContrast: Number(event.target.value),
          })
        }
      />
      <button
        className="contrast-reset"
        type="button"
        aria-label="重置银河对比度"
        disabled={plan.milkyWayContrast === 100}
        onClick={() => update({ milkyWayContrast: 100 })}
      >
        重置
      </button>
    </div>
  );
}

/** The deep-sky camera response: stock or Hα-modified. */
export function CameraResponseSelect({ plan, update }: Props) {
  return (
    <label
      className="subsetting-select"
      title="未改机仍保留红色，改机额外增强红光。两模式沿用处理后的源图，非同机型实拍对比。"
    >
      <span>相机响应</span>
      <select
        aria-label="深空相机响应"
        value={plan.cameraResponse}
        onChange={(event) =>
          update({
            cameraResponse: event.target
              .value as ShootingPlan["cameraResponse"],
          })
        }
      >
        <option value="stock">未改机 · 近似参考</option>
        <option value="ha-modified">天文改机 · Hα 增强示意</option>
      </select>
    </label>
  );
}
