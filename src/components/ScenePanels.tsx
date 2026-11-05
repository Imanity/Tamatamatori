import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
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
import {
  CelestialDiscs,
  CelestialReadout,
  useCelestialScene,
} from "./CelestialScene";
import { celestialPlanKey, emptyVisibility } from "../domain/visibility";
import type { RenderedCamera } from "../preview/rendered-camera";
import {
  emptySkyVisibility,
  StarLabels,
  StarReadout,
  useStarScene,
} from "./StarScene";
import starCatalogUrl from "../data/bright-stars.json?url";
import constellationCatalogUrl from "../data/constellations.json?url";
import constellationStarsUrl from "../data/constellation-stars.json?url";
import { TargetSearchResults } from "./TargetSearch";

const radians = (value: number) => (value * Math.PI) / 180;

export function PreviewPanel({
  plan,
  update,
  infoHost,
  infoQuery = "",
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  infoHost?: HTMLElement | null;
  infoQuery?: string;
}) {
  const [grid, setGrid] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [visibility, setVisibility] = useState(emptyVisibility);
  const [skyVisibility, setSkyVisibility] = useState(emptySkyVisibility);
  const [camera, setCamera] = useState<RenderedCamera | null>(null);
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
  const view =
    camera?.planKey === celestialPlanKey(plan)
      ? { ...plan, azimuth: camera.azimuth, pitch: camera.pitch }
      : plan;
  const celestialScene = useCelestialScene(plan, visibility, view);
  const starScene = useStarScene(plan, skyVisibility);
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
          <TerrainScene
            plan={plan}
            onVisibilityChange={setVisibility}
            onCameraChange={setCamera}
            onSkyChange={setSkyVisibility}
          />
          <CelestialDiscs scene={celestialScene} />
          <StarLabels scene={starScene} />
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
              const delta = signedAngle(index * 45 - view.azimuth);
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
      {infoHost &&
        createPortal(
          infoQuery.trim() ? (
            <TargetSearchResults
              plan={plan}
              view={view}
              query={infoQuery}
              skyVisibility={skyVisibility}
              visibility={visibility}
              update={update}
            />
          ) : (
            <>
              <section className="info-section">
                <h3>取景参数</h3>
                <div className="preview-readout">
                  <span>
                    方位 <strong>{view.azimuth.toFixed(1)}°</strong>
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
                      {view.pitch > 0 ? "+" : ""}
                      {view.pitch.toFixed(1)}°
                    </strong>
                  </span>
                </div>
              </section>
              <section className="info-section">
                <h3>光照与天空</h3>
                <p className="preview-lighting" aria-label="预览光照状态">
                  {daylightPhase(sun.elevation)} · 太阳几何高度{" "}
                  {sun.elevation > 0 ? "+" : ""}
                  {sun.elevation.toFixed(1)}°
                  {sun.elevation < -6 && celestialScene.bodies && (
                    <span className="preview-moonlight">
                      月光参考 · 亮面{" "}
                      {(
                        celestialScene.bodies.moon.illuminatedFraction * 100
                      ).toFixed(0)}
                      % · 几何高度{" "}
                      {celestialScene.bodies.moon.elevation > 0 ? "+" : ""}
                      {celestialScene.bodies.moon.elevation.toFixed(1)}°
                    </span>
                  )}
                </p>
              </section>
              <section className="info-section">
                <h3>日月位置</h3>
                <CelestialReadout
                  scene={celestialScene}
                  plan={plan}
                  update={update}
                />
              </section>
              <section className="info-section">
                <h3>星空与星座</h3>
                <StarReadout scene={starScene} plan={plan} update={update} />
                {!plan.layers.stars &&
                  !plan.layers.milkyWay &&
                  !plan.layers.constellations && (
                    <p className="info-empty">
                      在左侧图层中开启星空、银河或星座，查看目标方向。
                    </p>
                  )}
              </section>
              <section className="info-section">
                <h3>预览说明</h3>
                <p className="preview-note">
                  晴空与月光近似 · 不含天气与曝光 · 水面高程按 DEM 近似
                </p>
              </section>
            </>
          ),
          infoHost,
        )}
      <div className="preview-attribution">
        {(plan.layers.stars ||
          plan.layers.milkyWay ||
          plan.layers.constellations) && (
          <a href={starCatalogUrl} download="tamatamatori-bright-stars.json">
            HYG 4.1 · CC BY-SA 4.0 · 目录
          </a>
        )}
        {plan.layers.constellations && (
          <a
            href={constellationCatalogUrl}
            download="tamatamatori-constellations.json"
          >
            d3-celestial · 星座 · BSD-3-Clause
          </a>
        )}
        {plan.layers.constellations && (
          <a
            href={constellationStarsUrl}
            download="tamatamatori-constellation-stars.json"
          >
            HYG 星座端点 · CC BY-SA 4.0
          </a>
        )}
        <a
          href="https://github.com/cosinekitty/astronomy"
          target="_blank"
          rel="noreferrer"
        >
          Astronomy Engine
        </a>
        <a
          href={`${import.meta.env.BASE_URL}third-party-notices.txt`}
          target="_blank"
          rel="noreferrer"
        >
          第三方许可
        </a>
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
