import type { ClipboardEvent } from "react";
import { cameraHeightSlider, compassDirection, normalizeLongitude, parseCoordinatePair } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { NumberField } from "./NumberField";

/**
 * Camera position below the map: coordinates, shooting direction, the ground
 * elevation read by the preview and the camera height above ground. Pasting
 * "latitude, longitude" into either coordinate fills both.
 */
export function PositionBar({
  plan,
  update,
  ground,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  /** DEM elevation under the camera, or null while the preview waits for it. */
  ground: number | null;
}) {
  const pasteCoordinates = (event: ClipboardEvent<HTMLInputElement>) => {
    const pair = parseCoordinatePair(event.clipboardData.getData("text"));
    if (!pair) return;
    event.preventDefault();
    update(pair);
  };
  const pasteHint = "可粘贴“纬度, 经度”一次填入两项";
  return (
    <div className="position-bar" role="group" aria-label="机位">
      <div className="position-coordinates">
        <NumberField
          label="纬度"
          value={plan.latitude}
          min={-90}
          max={90}
          step={0.0001}
          unit="°"
          title={pasteHint}
          onPaste={pasteCoordinates}
          onChange={(latitude) => update({ latitude })}
        />
        <NumberField
          label="经度"
          value={plan.longitude}
          min={-180}
          max={180}
          step={0.0001}
          unit="°"
          title={pasteHint}
          onPaste={pasteCoordinates}
          onChange={(longitude) =>
            update({
              longitude:
                longitude === 180 ? normalizeLongitude(longitude) : longitude,
            })
          }
        />
      </div>
      <div className="position-view" role="group" aria-label="拍摄方向">
        <NumberField
          label="方位角"
          value={plan.azimuth}
          min={0}
          max={359.9}
          step={0.1}
          unit="°"
          title="以真北为 0°，顺时针递增；也可拖动地图上的方向把手或预览画面"
          onChange={(azimuth) => update({ azimuth })}
        />
        <span className="view-compass">{compassDirection(plan.azimuth)}</span>
        <NumberField
          label="俯仰角"
          value={plan.pitch}
          min={-90}
          max={90}
          step={0.1}
          unit="°"
          title="水平为 0°，向上为正；也可上下拖动预览画面"
          onChange={(pitch) => update({ pitch })}
        />
      </div>
      <div className="position-height">
        <p className="ground-elevation" aria-live="polite">
          <span className="field-label">地面高程</span>
          <strong>
            {ground === null ? "待更新" : `≈ ${ground.toFixed(1)} m`}
          </strong>
        </p>
        <NumberField
          label="离地高度"
          value={plan.cameraHeight}
          min={0.1}
          max={100}
          step={0.1}
          unit="m"
          onChange={(cameraHeight) => update({ cameraHeight })}
        />
        <span className="height-scale">
          <input
            className="height-slider"
            aria-label="离地高度滑块"
            type="range"
            min={0}
            max={cameraHeightSlider.max}
            step={1}
            value={cameraHeightSlider.toPosition(plan.cameraHeight)}
            aria-valuetext={`${plan.cameraHeight} m`}
            onChange={(event) =>
              update({ cameraHeight: cameraHeightSlider.fromPosition(Number(event.target.value)) })
            }
            onKeyDown={(event) => {
              const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key] as 1 | -1 | undefined;
              if (!direction) return;
              event.preventDefault();
              update({ cameraHeight: cameraHeightSlider.step(plan.cameraHeight, direction) });
            }}
          />
          <span className="height-ticks" aria-hidden="true">
            {["0.1", "1", "10", "100 m"].map((label, index) => (
              <span key={label} style={{ left: `${(index / 3) * 100}%` }}>
                {label}
              </span>
            ))}
          </span>
        </span>
      </div>
    </div>
  );
}
