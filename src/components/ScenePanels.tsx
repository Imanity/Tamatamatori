import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  dragView,
  frameAspectRatio,
  fieldOfView,
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
import { CometLabels, CometReadout, useCometScene } from "./CometScene";
import { LunarEclipseReadout, SolarEclipseReadout, eclipseFact, moonInUmbra, useEclipses } from "./EclipseReadout";
import { TideReadout, tideFact } from "./TideScene";
import { OpenMeteoUsage } from "./ApiUsage";
import type { TideFeed } from "./TideScene";
import { AuroraReadout, auroraFact } from "./AuroraScene";
import type { AuroraFeed } from "./AuroraScene";
import { useCometCatalog } from "./useCometCatalog";
import { CameraBar } from "./CameraBar";
import { Timeline } from "./Timeline";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { layerGroups } from "./layers";
import type { LayerGroupId } from "./layers";
import { Detail, pollutionLevel } from "./readout";
import { CompositionPanel } from "./Composition";
import type { CompositionState } from "./Composition";
import { CompositionMarks } from "./CompositionMarks";
import type { ShotSaving } from "./SolveLink";

const radians = (value: number) => (value * Math.PI) / 180;

export function PreviewPanel({
  plan,
  update,
  infoHost,
  infoQuery = "",
  infoNavigation,
  generation = 0,
  onGroundChange,
  showCameraBar = true,
  onToggleLayer,
  tides,
  aurora,
  alignment,
  solveHost,
  shotSaving,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  /** The "推算" mode state (owned by the workspace, shared with the map) and where its panel goes. */
  alignment: CompositionState;
  solveHost?: HTMLElement | null;
  /** "存为机位" from the 推算 panel: saves the current plan under a name and binds it. */
  shotSaving?: ShotSaving;
  infoHost?: HTMLElement | null;
  infoQuery?: string;
  infoNavigation?: InfoNavigation | null;
  /** Changes when a whole plan replaces the current one; resets typed drafts. */
  generation?: number;
  /** DEM elevation under the camera for the position bar below the map. */
  onGroundChange?: (ground: number | null) => void;
  /** Narrow screens show the lens controls in their own tab instead. */
  showCameraBar?: boolean;
  /** Switches a layer from its group heading (with the panel follow-up). */
  onToggleLayer?: (id: LayerGroupId) => void;
  /** Sea level and aurora feeds, shared with the map. */
  tides?: TideFeed;
  aurora?: AuroraFeed;
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
  useEffect(() => {
    onGroundChange?.(terrainInfo.ground);
  }, [terrainInfo.ground, onGroundChange]);
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
    comets: !!plan.layers.comets,
    aurora: !!plan.layers.aurora,
    tides: !!plan.layers.tides,
  }));
  const toggleGroup = (id: InfoGroupId) =>
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
  // A layer switch expands or collapses its group in place; the panel does not scroll.
  useEffect(() => {
    if (!infoNavigation) return;
    if ("sync" in infoNavigation) {
      const layers = latestPlan.current.layers;
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
        comets: !!layers.comets,
      }));
      return;
    }
    const { id, open } = infoNavigation;
    setExpanded((current) => ({ ...current, [id]: open }));
  }, [infoNavigation]);
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
  const group = (id: InfoGroupId, title: string, children: ReactNode) => {
    const layer = layerGroups.find((entry) => entry.id === id);
    return (
      <InfoGroup
        id={id}
        title={title}
        icon={layer?.icon ?? "light"}
        open={!!expanded[id]}
        toggle={() => toggleGroup(id)}
        layer={layer && onToggleLayer ? {
          name: layer.name,
          checked: !!plan.layers[layer.id],
          onToggle: () => onToggleLayer(layer.id),
        } : undefined}
      >
        {children}
      </InfoGroup>
    );
  };
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
  // Touch points on the frame; two of them pinch the focal length.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; focalLength: number } | null>(null);
  const touchSpread = () => {
    const [a, b] = [...touches.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const endPointer = (pointerId: number) => {
    touches.current.delete(pointerId);
    if (pinch.current && touches.current.size < 2) pinch.current = null;
  };
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
  // The try-out's first body (the Sun or the Moon has an occlusion reading).
  const triedBody = alignment.run?.basis.bodies.find((body) => body === "sun" || body === "moon") ?? null;
  const alignedBody = triedBody ? celestialScene.views.find((entry) => entry.body.id === triedBody) : undefined;
  const eclipses = useEclipses(plan);
  const obscuration = celestialScene.bodies?.sun.obscuration ?? 0;
  const moonLight = celestialScene.bodies?.moon.brightness ?? 1;
  const umbral = celestialScene.bodies ? moonInUmbra(celestialScene.bodies.moon) : false;
  const eclipseNote = eclipseFact(obscuration, moonLight, umbral);
  const auroraInputs = useMemo(() => aurora ? { kp: aurora.kp ?? null, outlook: aurora.outlook ?? null } : null, [aurora?.kp, aurora?.outlook]);
  const tideNote = plan.layers.tides && tides ? tideFact(tides, plan.instant) : "";
  const auroraNote = plan.layers.aurora && aurora ? auroraFact(plan, aurora) : "";
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
  const cometFeed = useCometCatalog(!!plan.layers.comets);
  const comets = useCometScene(plan, cometFeed, artificialMcd ?? 0);
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  // The sky note repeats the lighting phase in daylight ("白昼 · 白昼 · …"); keep its remainder.
  const phase = daylightPhase(sun.elevation);
  const skyLabel = starScene.appearance ? skyAppearanceLabel(starScene.appearance) : "";
  const skyNote = skyLabel.startsWith(phase) ? skyLabel.slice(phase.length).replace(/^ · /, "") : skyLabel;
  return (
    <div className="preview-content">
      <div className="preview-meta">
        <div className="preview-facts">
          {plan.layers.deepSky && (
            <span className="camera-response-fact">
              {plan.cameraResponse === "ha-modified"
                ? "天文改机 · Hα 增强示意"
                : "未改机 · 近似参考"}
            </span>
          )}
          {eclipseNote && <span className="eclipse-fact" data-eclipse-fact title={eclipseNote}>{eclipseNote}</span>}
          {auroraNote && <span className="aurora-fact" data-aurora-fact title={auroraNote}>{auroraNote}</span>}
          {tideNote && <span className="tide-fact" data-tide-fact title={tideNote}>{tideNote}</span>}
          {meteorNote && <span className="meteor-fact" data-meteor-fact title={meteorNote}>{meteorNote}</span>}
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
      <div
        className="viewfinder-wrap"
        style={{ "--frame-ratio": frameAspectRatio(plan) } as CSSProperties}
      >
        {/* Data alerts float over the frame so they never resize it. */}
        <div className="preview-alerts">
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
        </div>
        <div
          className={`viewfinder ${dragging ? "is-dragging" : ""}`}
          ref={viewfinder}
          role="group"
          aria-label="拍摄预览，拖动调整拍摄视角，滚轮或双指捏合调整焦距，也可使用方向键，Shift 加速"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (event.pointerType === "touch") {
              touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              if (touches.current.size === 2) {
                // A second finger turns the drag into a pinch for the focal length.
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = null;
                setDragging(false);
                const spread = touchSpread();
                pinch.current =
                  spread > 0
                    ? { distance: spread, focalLength: latestPlan.current.focalLength }
                    : null;
                return;
              }
            }
            if (drag.current || pinch.current) return;
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
            if (touches.current.has(event.pointerId)) {
              touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              const zoom = pinch.current;
              if (zoom && touches.current.size >= 2) {
                const focalLength =
                  Math.round(
                    Math.max(8, Math.min(1000, (zoom.focalLength * touchSpread()) / zoom.distance)) * 10,
                  ) / 10;
                latestPlan.current = { ...latestPlan.current, focalLength };
                update({ focalLength });
                return;
              }
            }
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
            endPointer(event.pointerId);
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => {
            endPointer(event.pointerId);
            drag.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={(event) => {
            endPointer(event.pointerId);
            if (drag.current?.pointerId !== event.pointerId) return;
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
            comets={comets.scene ?? undefined}
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
          <CometLabels plan={plan} comets={comets} visibility={skyVisibility} />
          <StationLabels
            plan={plan}
            weather={weather}
            scene={stations}
            visibility={skyVisibility}
          />
          <CompositionMarks state={alignment} view={view} frame={viewfinder} />
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
      {showCameraBar && <CameraBar key={`camera-${generation}`} plan={plan} update={update} />}
      <Timeline
        key={`time-${generation}`}
        plan={plan}
        update={update}
        comets={plan.layers.comets ? cometFeed.catalog : null}
        orbits={plan.layers.stations ? orbits.snapshot : null}
        forecast={plan.weather ? weatherFeed.forecast ?? null : null}
        tides={plan.layers.tides && tides?.phase === "ready" ? tides.series ?? null : null}
        aurora={plan.layers.aurora && aurora?.phase === "ready" ? auroraInputs : null}
        extraEvents={alignment.events}
      />
      {solveHost && alignment.active &&
        createPortal(
          <CompositionPanel
            state={alignment}
            plan={plan}
            saving={shotSaving}
            occlusion={alignedBody && triedBody && plan.layers[triedBody]
              ? { state: alignedBody.state, occlusion: alignedBody.occlusion }
              : null}
          />,
          solveHost,
        )}
      {infoHost &&
        createPortal(
          <>
            {infoQuery.trim() && (
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
            {/* Groups stay mounted under a search, keeping their switches and expansion. */}
            <div className="info-groups" hidden={!!infoQuery.trim()}>
                {group(
                  "global",
                  "光照与环境",
                  <>
                    <section className="info-section">
                      <p className="preview-lighting" aria-label="预览光照状态">
                        <strong>{phase}</strong>
                        {skyNote && (
                          <span className="sky-appearance" role="status">
                            {" · "}{skyNote}
                          </span>
                        )}
                        <Detail>太阳高度 {sun.elevation.toFixed(1)}°</Detail>
                        {sun.elevation < -6 && celestialScene.bodies && (
                          <span className="preview-moonlight">
                            {celestialScene.bodies.moon.elevation > 0
                              ? `月亮在地平线上，亮面 ${(celestialScene.bodies.moon.illuminatedFraction * 100).toFixed(0)}%`
                              : "月亮在地平线下，无月光"}
                            <Detail>
                              月亮亮面 {(celestialScene.bodies.moon.illuminatedFraction * 100).toFixed(0)}% · 高度{" "}
                              {celestialScene.bodies.moon.elevation.toFixed(1)}°
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
                                        <Detail>{lightPollutionAtlas.year} 天顶人工亮度 ≈ {artificialMcd!.toFixed(3)} mcd/m²</Detail>
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
                    <SolarEclipseReadout info={eclipses} plan={plan} update={update} obscuration={obscuration} />
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
                    <LunarEclipseReadout info={eclipses} plan={plan} update={update} brightness={moonLight} umbral={umbral} />
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
                  <>
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
                    {!plan.layers.deepSky ? (
                      <p className="info-empty">深空天体已关闭</p>
                    ) : (
                      <StarReadout
                        scene={starScene}
                        plan={plan}
                        update={update}
                        section="deepSky"
                      />
                    )}
                  </>,
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
                {group(
                  "comets",
                  "彗星",
                  <CometReadout plan={plan} comets={comets} visibility={skyVisibility} update={update} />,
                )}
                {group("aurora", "极光", aurora ? <AuroraReadout plan={plan} feed={aurora} /> : null)}
                {group("tides", "潮汐", tides ? <TideReadout plan={plan} feed={tides} /> : null)}
            </div>
          </>,
          infoHost,
        )}
    </div>
  );
}
