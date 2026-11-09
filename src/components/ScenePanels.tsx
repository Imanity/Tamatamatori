import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  dragView,
  frameAspectRatio,
  fieldOfView,
  sensors,
  signedAngle,
  zoomFocalLength,
} from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { Icon } from "./Icon";
import { TerrainScene } from "./TerrainScene";
import type { TerrainInfo } from "./TerrainScene";
import { InfoGroup } from "./InfoGroup";
import type { InfoGroupId, InfoNavigation } from "./InfoGroup";
import { solarPosition, daylightPhase } from "../domain/solar";
import { skyAppearanceLabel } from "../domain/sky-appearance";
import {
  CelestialDiscs,
  CelestialPathLabels,
  CelestialReadout,
  PathToggle,
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
import { TargetSearchResults } from "./TargetSearch";
import { useOrbits } from "./useOrbits";
import { StationLabels, StationReadout } from "./StationScene";
import { matchingStations } from "../domain/orbit-data";
import { stationScene } from "../domain/stations";
import { useLightPollution } from "./useLightPollution";
import { lightPollutionAtlas } from "../domain/light-pollution";
import { useWeather } from "./useWeather";
import { WeatherReadout, WeatherActions, weatherMessage } from "./WeatherReadout";
import { emptyBuildings, buildingKey } from "../domain/buildings";
import { BuildingReadout } from "./BuildingReadout";
import { MeteorLabels, MeteorReadout, meteorFact, useMeteorScene } from "./MeteorScene";

const radians = (value: number) => (value * Math.PI) / 180;

export function PreviewPanel({
  plan,
  update,
  infoHost,
  infoQuery = "",
  infoNavigation,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  infoHost?: HTMLElement | null;
  infoQuery?: string;
  infoNavigation?: InfoNavigation | null;
}) {
  const viewfinder = useRef<HTMLDivElement>(null);
  const latestPlan = useRef(plan);
  latestPlan.current = plan;
  const [terrainInfo, setTerrainInfo] = useState<TerrainInfo>({
    ground: null,
    actualHeight: null,
    actualPitch: null,
    adjusted: false,
  });
  // Global information starts open; each layer group starts in step with its
  // layer and then follows the left switches (see App.toggleLayer).
  const [expanded, setExpanded] = useState<
    Partial<Record<InfoGroupId, boolean>>
  >(() => ({
    global: true,
    buildings: plan.layers.buildings,
    sun: plan.layers.sun,
    moon: plan.layers.moon,
    stars: plan.layers.stars,
    milkyWay: plan.layers.milkyWay,
    deepSky: plan.layers.deepSky,
    stations: plan.layers.stations,
    meteors: !!plan.layers.meteors,
  }));
  const toggleGroup = (id: InfoGroupId) =>
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
  // Scroll the information rail itself so the group starts at its top; a
  // hidden rail (closed mobile drawer, collapsed desktop rail) reveals the
  // group as soon as it gains a size.
  const pendingReveal = useRef<InfoGroupId | null>(null);
  const reveal = (host: HTMLElement, id: InfoGroupId) => {
    const group = host.querySelector(`#info-${id}`)?.closest(".info-group");
    if (!group || !host.getClientRects().length) return false;
    const top =
      group.getBoundingClientRect().top -
      host.getBoundingClientRect().top +
      host.scrollTop;
    const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)")
      ?.matches
      ? "auto"
      : "smooth";
    if (typeof host.scrollTo === "function") host.scrollTo({ top, behavior });
    else host.scrollTop = top;
    return true;
  };
  // Expand first; scroll only after the expanded content has been committed,
  // otherwise the rail is still too short to reach the group.
  const [revealing, setRevealing] = useState<InfoGroupId | null>(null);
  useEffect(() => {
    if (!infoNavigation) return;
    if ("sync" in infoNavigation) {
      const layers = latestPlan.current.layers;
      pendingReveal.current = null;
      setRevealing(null);
      setExpanded((current) => ({
        ...current,
        buildings: !!layers.buildings,
        sun: layers.sun,
        moon: layers.moon,
        stars: layers.stars,
        milkyWay: layers.milkyWay,
        deepSky: layers.deepSky,
        stations: layers.stations,
        meteors: !!layers.meteors,
      }));
      return;
    }
    const { id, open } = infoNavigation;
    setExpanded((current) => ({ ...current, [id]: open }));
    if (open) setRevealing(id);
    else {
      // A collapsed group must not be scrolled to later.
      if (pendingReveal.current === id) pendingReveal.current = null;
      setRevealing((current) => (current === id ? null : current));
    }
  }, [infoNavigation]);
  useEffect(() => {
    if (!revealing || !infoHost || !expanded[revealing]) return;
    const frame = requestAnimationFrame(() => {
      pendingReveal.current = reveal(infoHost, revealing) ? null : revealing;
      setRevealing((current) => (current === revealing ? null : current));
    });
    return () => cancelAnimationFrame(frame);
  }, [revealing, infoHost, expanded]);
  useEffect(() => {
    if (!infoHost || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const id = pendingReveal.current;
      if (id && reveal(infoHost, id)) pendingReveal.current = null;
    });
    observer.observe(infoHost);
    return () => observer.disconnect();
  }, [infoHost]);
  useEffect(() => {
    const element = viewfinder.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        !Number.isFinite(event.deltaY) ||
        event.deltaY === 0
      )
        return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      const focalLength = zoomFocalLength(
        latestPlan.current.focalLength,
        event.deltaY * scale,
      );
      latestPlan.current = { ...latestPlan.current, focalLength };
      update({ focalLength });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [update]);
  const group = (id: InfoGroupId, title: string, children: ReactNode) => (
    <InfoGroup
      id={id}
      title={title}
      open={!!expanded[id]}
      toggle={() => toggleGroup(id)}
    >
      {children}
    </InfoGroup>
  );
  const [grid, setGrid] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [visibility, setVisibility] = useState(emptyVisibility);
  const [skyVisibility, setSkyVisibility] = useState(emptySkyVisibility);
  const [camera, setCamera] = useState<RenderedCamera | null>(null);
  const [buildings,setBuildings] = useState(emptyBuildings);
  const [buildingAttempt,setBuildingAttempt] = useState(0);
  const buildingStatus = !plan.layers.buildings ? {...emptyBuildings,key:buildingKey(plan)} : buildings.key===buildingKey(plan)&&buildings.phase!=="off"
    ? buildings : {...emptyBuildings,key:buildingKey(plan),phase:"loading" as const};
  const stationMatches = matchingStations(infoQuery);
  const orbits = useOrbits(!!plan.layers.stations || stationMatches.length > 0);
  const observerAltitude =
    camera?.planKey === celestialPlanKey(plan)
      ? Math.round(camera.altitude * 1000) / 1000
      : undefined;
  const stations = useMemo(
    () => stationScene(plan, orbits.snapshot, observerAltitude),
    [
      plan.latitude,
      plan.longitude,
      plan.instant,
      plan.cameraHeight,
      orbits.snapshot,
      observerAltitude,
    ],
  );
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
  const pollution = useLightPollution(plan);
  const artificialMcd =
    pollution.phase === "ready" ? pollution.sample?.artificialMcd : undefined;
  const weatherFeed = useWeather(plan);
  const weather = weatherFeed.sample ?? undefined;
  const starScene = useStarScene(plan, skyVisibility, artificialMcd, weather, view);
  const meteorScene = useMeteorScene(plan, view, {
    artificialMcd: artificialMcd ?? 0,
    note: !plan.lightPollution ? "光污染未开启，按自然天空"
      : pollution.phase === "ready" ? `已计光污染 ${artificialMcd!.toFixed(2)} mcd/m²`
      : pollution.phase === "loading" ? "光污染读取中，暂按自然天空" : "光污染不可用，按自然天空",
  });
  const meteorNote = meteorFact(meteorScene);
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return (
    <div className="preview-content">
      <div className="preview-meta">
        <div className="preview-facts">
          <span>
            <strong>{plan.focalLength} mm</strong> ·{" "}
            {sensors[plan.sensor].label.split(" · ")[0]} ·{" "}
            {plan.orientation === "portrait" ? "竖幅" : "横幅"}{" "}
            {plan.orientation === "portrait"
              ? plan.aspectRatio.split(":").reverse().join(":")
              : plan.aspectRatio}
          </span>
          <span>
            {plan.cameraResponse === "ha-modified"
              ? "天文改机 · Hα 增强示意"
              : "未改机 · 近似参考"}
          </span>
          {meteorNote && <span className="meteor-fact" data-meteor-fact>{meteorNote}</span>}
          <span className="preview-elevation">
            机位高程{" "}
            {terrainInfo.ground === null
              ? "待更新"
              : `≈ ${terrainInfo.ground.toFixed(1)} m`}{" "}
            · 离地 {plan.cameraHeight} m
          </span>
          {terrainInfo.adjusted && (
            <span className="camera-adjustment" role="status">
              引擎避让 · 实际离地 ≈ {terrainInfo.actualHeight?.toFixed(2)} m ·
              俯仰 {terrainInfo.actualPitch?.toFixed(2)}°
            </span>
          )}
        </div>
        <div className="preview-tools" role="group" aria-label="预览显示设置">
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
      </div>
      {plan.lightPollution &&
        (pollution.phase === "error" || pollution.phase === "unavailable") && (
          <div
            className={`pollution-status pollution-${pollution.phase}`}
            role="status"
          >
            {`光污染未应用 · ${pollution.message}`}
            {pollution.phase === "error" && (
              <button type="button" onClick={pollution.retry}>
                重试光污染
              </button>
            )}
          </div>
        )}
      {["error", "outside", "missing", "stale"].includes(weatherFeed.phase) && (
        <div className="weather-status" role="status">
          天气未应用 · {weatherMessage(weatherFeed)}
          <WeatherActions feed={weatherFeed} update={update} />
        </div>
      )}
      <div className="viewfinder-wrap">
        <div
          className={`viewfinder ${dragging ? "is-dragging" : ""}`}
          ref={viewfinder}
          role="group"
          aria-label="拍摄预览，拖动调整拍摄视角，滚轮调整焦距，也可使用方向键，Shift 加速"
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
            artificialMcd={artificialMcd}
            weather={weather}
            stations={plan.layers.stations ? stations : undefined}
            onVisibilityChange={setVisibility}
            onCameraChange={setCamera}
            onSkyChange={setSkyVisibility}
            onInfoChange={setTerrainInfo}
            onBuildingsChange={setBuildings}
            buildingAttempt={buildingAttempt}
          />
          <CelestialPathLabels scene={celestialScene} plan={plan} />
          <CelestialDiscs scene={celestialScene} weather={weather} plan={plan} />
          <StarLabels scene={starScene} />
          <MeteorLabels plan={plan} scene={meteorScene} visibility={skyVisibility} />
          <StationLabels
            plan={plan}
            weather={weather}
            scene={stations}
            visibility={skyVisibility}
          />
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
        </div>
      </div>
      {infoHost &&
        createPortal(
          <>
            {infoQuery.trim() ? (
              <TargetSearchResults
                plan={plan}
                view={view}
                query={infoQuery}
                additionalCount={stationMatches.length}
                artificialMcd={artificialMcd}
                weather={weather}
                skyVisibility={skyVisibility}
                visibility={visibility}
                update={update}
              />
            ) : (
              <>
                {group(
                  "global",
                  "全局信息",
                  <>
                    <section className="info-section">
                      <h3>取景参数</h3>
                      <div className="preview-readout">
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
                    <section className="info-section">
                      <h3>光照与天空</h3>
                      <p className="preview-lighting" aria-label="预览光照状态">
                        {daylightPhase(sun.elevation)} · 太阳高度{" "}
                        {sun.elevation.toFixed(1)}°
                        {sun.elevation < -6 && celestialScene.bodies && (
                          <span className="preview-moonlight">
                            月亮亮面{" "}
                            {(
                              celestialScene.bodies.moon.illuminatedFraction *
                              100
                            ).toFixed(0)}
                            % · 高度{" "}
                            {celestialScene.bodies.moon.elevation.toFixed(1)}°
                          </span>
                        )}
                      </p>
                      {starScene.appearance && (
                        <p className="sky-appearance" role="status">
                          天空明暗 · {skyAppearanceLabel(starScene.appearance)}
                        </p>
                      )}
                      <div
                        className="pollution-readout"
                        aria-label="当地光污染数据"
                      >
                        <p>
                          {pollution.phase === "off"
                            ? "当地光污染已关闭"
                            : pollution.phase === "ready"
                              ? `${lightPollutionAtlas.year} 天顶人工亮度 ≈ ${artificialMcd!.toFixed(3)} mcd/m²`
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
                      <WeatherReadout feed={weatherFeed} update={update} />
                    </section>
                  </>,
                )}
                {group("buildings","建筑",<BuildingReadout status={buildingStatus} retry={()=>setBuildingAttempt(v=>v+1)}
                  plan={plan} update={update} eyeAltitude={observerAltitude} cameraGround={terrainInfo.ground} />)}
                {group(
                  "sun",
                  "太阳",
                  <>
                    <PathToggle
                      scene={celestialScene}
                      plan={plan}
                      update={update}
                      bodyId="sun"
                    />
                    <CelestialReadout
                      scene={celestialScene}
                      plan={plan}
                      update={update}
                      bodyId="sun"
                      weather={weather}
                    />
                  </>,
                )}
                {group(
                  "moon",
                  "月亮",
                  <>
                    <PathToggle
                      scene={celestialScene}
                      plan={plan}
                      update={update}
                      bodyId="moon"
                    />
                    <CelestialReadout
                      scene={celestialScene}
                      plan={plan}
                      update={update}
                      bodyId="moon"
                      weather={weather}
                    />
                  </>,
                )}
                {group(
                  "stars",
                  "星空",
                  <>
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
                    {!plan.layers.stars ? (
                      <p className="info-empty">星空已关闭</p>
                    ) : (
                      <StarReadout
                        scene={starScene}
                        plan={plan}
                        update={update}
                        section="stars"
                      />
                    )}
                  </>,
                )}
                {group(
                  "milkyWay",
                  "银河",
                  <>
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
                    {!plan.layers.milkyWay ? (
                      <p className="info-empty">银河已关闭</p>
                    ) : (
                      <StarReadout
                        scene={starScene}
                        plan={plan}
                        update={update}
                        section="milkyWay"
                      />
                    )}
                  </>,
                )}
                {group(
                  "deepSky",
                  "深空天体",
                  !plan.layers.deepSky ? (
                    <p className="info-empty">深空天体已关闭</p>
                  ) : (
                    <StarReadout
                      scene={starScene}
                      plan={plan}
                      update={update}
                      section="deepSky"
                    />
                  ),
                )}
                {group(
                  "stations",
                  "空间站",
                  !plan.layers.stations ? (
                    <p className="info-empty">空间站已关闭</p>
                  ) : (
                    <StationReadout
                      plan={plan}
                      scene={stations}
                      visibility={skyVisibility}
                      feed={orbits}
                      query=""
                      update={update}
                    />
                  ),
                )}
                {group(
                  "meteors",
                  "流星雨",
                  <MeteorReadout plan={plan} scene={meteorScene} visibility={skyVisibility} update={update} />,
                )}
              </>
            )}
            {infoQuery.trim() && stationMatches.length > 0 && (
              <StationReadout
                plan={plan}
                scene={stations}
                visibility={skyVisibility}
                feed={orbits}
                query={infoQuery}
                update={update}
              />
            )}
          </>,
          infoHost,
        )}
    </div>
  );
}
