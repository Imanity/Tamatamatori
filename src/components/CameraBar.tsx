import { aspectRatios, customSensorLimits, focalPresets, focalSlider, sensorSize, sensors } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { NumberField } from "./NumberField";

/**
 * Lens and frame below the preview: focal length with a logarithmic slider
 * whose preset marks are clickable, then sensor, aspect ratio and orientation.
 */
export function CameraBar({
  plan,
  update,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
}) {
  return (
    <div className="camera-bar" role="group" aria-label="相机与镜头">
      <NumberField
        className="focal-field"
        label="焦距"
        value={plan.focalLength}
        min={8}
        max={1000}
        step={0.1}
        unit="mm"
        onChange={(focalLength) => update({ focalLength })}
      />
      <div className="focal-scale">
        <input
          className="focal-slider"
          aria-label="焦距滑块"
          type="range"
          min={0}
          max={focalSlider.max}
          step={1}
          value={focalSlider.toPosition(plan.focalLength)}
          aria-valuetext={`${plan.focalLength} mm`}
          onChange={(event) =>
            update({ focalLength: focalSlider.fromPosition(Number(event.target.value)) })
          }
        />
        <div className="focal-presets" role="group" aria-label="常用焦距">
          {focalPresets.map((focalLength) => (
            <button
              key={focalLength}
              type="button"
              className={plan.focalLength === focalLength ? "is-active" : ""}
              aria-pressed={plan.focalLength === focalLength}
              style={{ left: `${(focalSlider.toPosition(focalLength) / focalSlider.max) * 100}%` }}
              onClick={() => update({ focalLength })}
            >
              {focalLength}
              <span className="sr-only"> mm</span>
            </button>
          ))}
        </div>
      </div>
      <div className="camera-format">
        <select
          aria-label="传感器"
          title="传感器"
          value={plan.sensor}
          onChange={(event) => {
            const sensor = event.target.value as ShootingPlan["sensor"];
            // A new custom sensor starts from the current size.
            update(sensor === "custom"
              ? { sensor, customSensor: plan.customSensor ?? { ...sensorSize(plan) } }
              : { sensor });
          }}
        >
          {Object.entries(sensors).map(([key, sensor]) => (
            <option key={key} value={key} title={sensor.label}>
              {sensor.label.split(" · ")[0]}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
        {plan.sensor === "custom" && (
          <span className="custom-sensor" role="group" aria-label="自定义传感器尺寸">
            {(["width", "height"] as const).map((side) => (
              <NumberField
                key={side}
                className="sensor-field"
                label={side === "width" ? "传感器宽" : "传感器高"}
                value={sensorSize(plan)[side]}
                min={customSensorLimits[0]}
                max={customSensorLimits[1]}
                step={0.1}
                unit="mm"
                onChange={(value) => update({ customSensor: { ...sensorSize(plan), [side]: value } })}
              />
            ))}
          </span>
        )}
        <select
          aria-label="画幅比例"
          title="画幅比例"
          value={plan.aspectRatio}
          onChange={(event) =>
            update({
              aspectRatio: event.target.value as ShootingPlan["aspectRatio"],
            })
          }
        >
          {Object.keys(aspectRatios).map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio}
            </option>
          ))}
        </select>
        <select
          aria-label="拍摄画幅方向"
          title="画幅方向"
          value={plan.orientation}
          onChange={(event) =>
            update({
              orientation: event.target.value as ShootingPlan["orientation"],
            })
          }
        >
          <option value="landscape">横幅</option>
          <option value="portrait">竖幅</option>
        </select>
      </div>
    </div>
  );
}
