import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  dragView,
  frameAspectRatio,
  fieldOfView,
  sensors,
  signedAngle,
} from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { Icon } from "./Icon";
import { TerrainScene } from "./TerrainScene";
import { solarPosition, daylightPhase } from "../domain/solar";

const radians = (value: number) => (value * Math.PI) / 180;

export function PreviewPanel({
  plan,
  update,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
}) {
  const [grid, setGrid] = useState(true);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    plan: ShootingPlan;
  } | null>(null);
  const fov = fieldOfView(plan);
  const sun = solarPosition(plan);
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return (
    <div className="preview-content">
      <div className="preview-meta">
        <span>
          {sensors[plan.sensor].label.split(" · ")[0]} <i />{" "}
          {plan.orientation === "portrait" ? "竖幅" : "横幅"} ·{" "}
          {plan.orientation === "portrait"
            ? plan.aspectRatio.split(":").reverse().join(":")
            : plan.aspectRatio}
        </span>
        <button
          className={`icon-button ${grid ? "is-active" : ""}`}
          aria-label="显示构图线"
          aria-pressed={grid}
          title="构图线"
          onClick={() => setGrid(!grid)}
        >
          <Icon name="grid" size={15} />
        </button>
      </div>
      <div className="viewfinder-wrap">
        <div
          className={`viewfinder ${dragging ? "is-dragging" : ""}`}
          role="group"
          aria-label="拍摄预览，拖动调整拍摄视角，也可使用方向键，Shift 加速"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              width: bounds.width,
              height: bounds.height,
              plan: { ...plan },
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (
              !start ||
              start.pointerId !== event.pointerId ||
              !event.currentTarget.hasPointerCapture(event.pointerId)
            )
              return;
            update(
              dragView(
                start.plan,
                event.clientX - start.x,
                event.clientY - start.y,
                start.width,
                start.height,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const step = event.shiftKey ? 5 : 1;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight")
              update({
                azimuth:
                  (plan.azimuth +
                    (event.key === "ArrowRight" ? step : -step) +
                    360) %
                  360,
              });
            else
              update({
                pitch: Math.max(
                  -90,
                  Math.min(
                    90,
                    plan.pitch + (event.key === "ArrowUp" ? step : -step),
                  ),
                ),
              });
          }}
          style={
            {
              aspectRatio: frameAspectRatio(plan),
              "--frame-ratio": frameAspectRatio(plan),
            } as CSSProperties
          }
        >
          <TerrainScene plan={plan} />
          <svg
            viewBox="0 0 600 400"
            preserveAspectRatio="none"
            role="img"
            aria-label={`取景辅助线，水平视场 ${fov.horizontal.toFixed(1)} 度，垂直视场 ${fov.vertical.toFixed(1)} 度。`}
          >
            {grid && (
              <path
                d="M200 0V400M400 0V400M0 133.33H600M0 266.67H600"
                stroke="white"
                opacity="0.4"
                strokeWidth="0.8"
              />
            )}
            <path
              d="M290 200h20m-10-10v20"
              stroke="#fff"
              opacity="0.9"
              strokeWidth="1"
            />
            {directions.map((label, index) => {
              const delta = signedAngle(index * 45 - plan.azimuth);
              if (Math.abs(delta) > fov.horizontal / 2) return null;
              const x =
                300 +
                (300 * Math.tan(radians(delta))) /
                  Math.tan(radians(fov.horizontal / 2));
              return (
                <g key={label}>
                  <path d={`M${x} 0v13`} stroke="white" opacity="0.8" />
                  <text
                    x={Math.max(16, Math.min(584, x))}
                    y="32"
                    textAnchor="middle"
                    fill="white"
                    stroke="#182535"
                    strokeWidth="0.4"
                    paintOrder="stroke"
                    fontSize="15"
                    fontFamily="monospace"
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
          <span className="viewfinder-label">地形模拟 · 拖动调整视角</span>
          <span className="viewfinder-focal">{plan.focalLength} mm</span>
        </div>
      </div>
      <div className="preview-readout">
        <span>
          方位 <strong>{plan.azimuth.toFixed(1)}°</strong>
        </span>
        <span>
          H <strong>{fov.horizontal.toFixed(1)}°</strong>
        </span>
        <span>
          V <strong>{fov.vertical.toFixed(1)}°</strong>
        </span>
        <span>
          俯仰{" "}
          <strong>
            {plan.pitch > 0 ? "+" : ""}
            {plan.pitch}°
          </strong>
        </span>
      </div>
      <p className="preview-lighting" aria-label="预览光照状态">
        {daylightPhase(sun.elevation)} · 太阳几何高度 {sun.elevation > 0 ? "+" : ""}{sun.elevation.toFixed(1)}°
      </p>
      <p className="preview-note">晴空近似 · 不含天气与曝光 · 水面高程按 DEM 近似</p>
      <div className="preview-attribution">
        <a
          href="https://mapterhorn.com/attribution/"
          target="_blank"
          rel="noreferrer"
        >
          © Mapterhorn
        </a>
        <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
          OpenFreeMap
        </a>
        <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">
          © OpenMapTiles
        </a>
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>
      </div>
    </div>
  );
}
