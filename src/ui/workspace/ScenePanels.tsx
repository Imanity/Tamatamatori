import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { frameAspectRatio, fieldOfView } from "../../domain/core/plan";
import type { ShootingPlan } from "../../domain/core/plan";
import { Icon } from "../common/Icon";
import { TerrainScene } from "../preview/TerrainScene";
import type { TerrainInfo } from "../preview/TerrainScene";
import { InfoGroup } from "../common/InfoGroup";
import type { InfoGroupId, InfoNavigation } from "../common/InfoGroup";
import { solarPosition, daylightPhase } from "../../domain/sun-moon/solar";
import { skyAppearanceLabel } from "../../domain/sky/sky-appearance";
import {
  CelestialDiscs,
  CelestialPathLabels,
  CelestialReadout,
  PathToggle,
  useCelestialScene,
} from "../sky/CelestialScene";
import { celestialPlanKey, emptyVisibility } from "../../domain/core/visibility";
import type { RenderedCamera } from "../../render/scene/rendered-camera";
import {
  emptySkyVisibility,
  StarLabels,
  StarReadout,
  useStarScene,
} from "../sky/StarScene";
import { TargetSearchResults } from "../sky/TargetSearch";
import { useOrbits } from "../sky/useOrbits";
import { StationLabels, StationReadout, waitingStations } from "../sky/StationScene";
import { matchingStations } from "../../domain/stations/orbit-data";
import { meteorModule, stationModule } from "../sky/layer-modules";
import { useLazyModule } from "../common/lazy-module";
import { useLightPollution } from "../environment/useLightPollution";
import { useWeather } from "../environment/useWeather";
import { WeatherActions, weatherMessage } from "../environment/WeatherReadout";
import { emptyBuildings, buildingKey } from "../../domain/buildings/buildings";
import { BuildingReadout } from "../preview/BuildingReadout";
import { MeteorLabels, MeteorReadout, meteorFact, useMeteorScene } from "../sky/MeteorScene";
import { CometLabels, CometReadout, useCometScene } from "../sky/CometScene";
import { LunarEclipseReadout, SolarEclipseReadout, eclipseFact, moonInUmbra, useEclipses } from "../sky/EclipseReadout";
import { TideReadout, tideFact } from "../environment/TideScene";
import type { TideFeed } from "../environment/TideScene";
import { AuroraReadout, auroraFact } from "../environment/AuroraScene";
import type { AuroraFeed } from "../environment/AuroraScene";
import { useCometCatalog } from "../sky/useCometCatalog";
import { CameraBar } from "../preview/CameraBar";
import { Timeline } from "./Timeline";
import { layerGroups } from "../common/layers";
import type { LayerGroupId } from "../common/layers";
import type { CompositionState, SolveModule } from "../solve/useComposition";
import type { ShotSaving } from "../solve/SolveLink";
import type { ModuleLoad } from "../common/lazy-module";
import { ModuleStatus } from "../common/ModuleStatus";
import type { TimelineEvent } from "../../domain/time/timeline";
import { usePreviewGestures } from "../preview/usePreviewGestures";
import { FrameGuides } from "../preview/FrameGuides";
import { LightingGroup } from "../environment/LightingGroup";
import { CameraResponseSelect, ConstellationSwitch, GalaxyContrast } from "../sky/SkySettings";

const noEvents: TimelineEvent[] = [];

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
  solveActive = false,
  solveLoad,
  solveHost,
  shotSaving,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  /**
   * The "推算" mode state (owned by the workspace, shared with the map; null
   * until its module is read), whether the mode is on, the module's read and
   * where its panel goes.
   */
  alignment: CompositionState | null;
  solveActive?: boolean;
  solveLoad?: ModuleLoad<SolveModule>;
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
  const { dragging, handlers: gestureHandlers } = usePreviewGestures(plan, update, latestPlan, viewfinder);
  const [visibility, setVisibility] = useState(emptyVisibility);
  const [skyVisibility, setSkyVisibility] = useState(emptySkyVisibility);
  const [camera, setCamera] = useState<RenderedCamera | null>(null);
  const [buildings,setBuildings] = useState(emptyBuildings);
  const [buildingAttempt,setBuildingAttempt] = useState(0);
  const buildingStatus = !plan.layers.buildings ? {...emptyBuildings,key:buildingKey(plan)} : buildings.key===buildingKey(plan)&&buildings.phase!=="off"
    ? buildings : {...emptyBuildings,key:buildingKey(plan),phase:"loading" as const};
  const stationMatches = matchingStations(infoQuery);
  const orbits = useOrbits(!!plan.layers.stations || stationMatches.length > 0);
  // SGP4 and the meteor model are read when their layer is first turned on (docs/plan/lazy-loading.md).
  const stationLoad = useLazyModule(stationModule, !!plan.layers.stations || stationMatches.length > 0);
  const meteorLoad = useLazyModule(meteorModule, !!plan.layers.meteors);
  const observerAltitude =
    camera?.planKey === celestialPlanKey(plan)
      ? Math.round(camera.altitude * 1000) / 1000
      : undefined;
  const stations = useMemo(
    () => (stationLoad.module ? stationLoad.module.stationScene(plan, orbits.snapshot, observerAltitude) : waitingStations),
    [
      plan.latitude,
      plan.longitude,
      plan.instant,
      plan.cameraHeight,
      orbits.snapshot,
      observerAltitude,
      stationLoad.module,
    ],
  );
  const fov = fieldOfView(plan);
  const sun = solarPosition(plan);
  const view =
    camera?.planKey === celestialPlanKey(plan)
      ? { ...plan, azimuth: camera.azimuth, pitch: camera.pitch }
      : plan;
  const celestialScene = useCelestialScene(plan, visibility, view);
  // The try-out's first body (the Sun or the Moon has an occlusion reading).
  const triedBody = alignment?.run?.basis.bodies.find((body) => body === "sun" || body === "moon") ?? null;
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
  }, meteorLoad);
  const meteorNote = meteorFact(meteorScene);
  const cometFeed = useCometCatalog(!!plan.layers.comets);
  const comets = useCometScene(plan, cometFeed, artificialMcd ?? 0);
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
          {...gestureHandlers}
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
          {alignment && <alignment.module.CompositionMarks state={alignment} view={view} frame={viewfinder} />}
          <FrameGuides grid={grid} azimuth={view.azimuth} fov={fov} />
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
        extraEvents={alignment?.events ?? noEvents}
        showers={meteorLoad.module?.activeShowers ?? null}
        passes={stationLoad.module?.visiblePasses ?? null}
      />
      {solveHost && solveActive &&
        createPortal(
          alignment ? (
            <alignment.module.CompositionPanel
              state={alignment}
              plan={plan}
              saving={shotSaving}
              occlusion={alignedBody && triedBody && plan.layers[triedBody]
                ? { state: alignedBody.state, occlusion: alignedBody.occlusion }
                : null}
            />
          ) : (
            <section className="alignment-panel" aria-label="推算">
              {solveLoad && <ModuleStatus load={solveLoad} name="推算模块" />}
            </section>
          ),
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
                load={stationLoad}
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
                  <LightingGroup
                    plan={plan}
                    update={update}
                    phase={phase}
                    skyNote={skyNote}
                    sunElevation={sun.elevation}
                    moon={celestialScene.bodies?.moon ?? null}
                    pollution={pollution}
                    weatherFeed={weatherFeed}
                    view={view}
                    fov={fov}
                  />,
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
                    <ConstellationSwitch plan={plan} update={update} />
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
                    <GalaxyContrast plan={plan} update={update} />
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
                    <CameraResponseSelect plan={plan} update={update} />
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
                load={stationLoad}
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
