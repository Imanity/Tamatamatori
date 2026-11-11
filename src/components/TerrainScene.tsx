import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan";
import { sensorKey } from "../domain/plan";
import { isMapPosition } from "../domain/map";
import {
  DEFAULT_TERRAIN_URL,
  DEFAULT_WATER_URL,
  TERRAIN_SOURCE,
  WATER_SOURCE,
  terrainStyle,
} from "../domain/terrain";
import type { terrainCamera } from "../preview/camera";
import { applyEnvironment, environmentForSky } from "../preview/environment";
import type { CelestialLayer } from "../preview/celestial-layer";
import { celestialBodies } from "../domain/ephemeris";
import { bodyPolygons } from "../domain/celestial-projection";
import { bodyPath, pathView } from "../domain/body-paths";
import type { BodyPath } from "../domain/body-paths";
import { celestialPlanKey } from "../domain/visibility";
import type { VisibilitySnapshot } from "../domain/visibility";
import type { CalibrationSnapshot } from "../preview/calibration";
import type { StarfieldLayer } from "../preview/starfield-layer";
import type { WeatherSample } from "../domain/weather";
import type { SkyVisibility } from "../domain/starfield";
import type { RenderedCamera } from "../preview/rendered-camera";
import { applyTerrainDetail, terrainCoverageRange } from "../preview/terrain-detail";
import type { TerrainPerspective } from "../preview/terrain-perspective";
import type { StationScene } from "../domain/stations";
import type { CometScene } from "../domain/comets";
import type { BuildingLayer } from "../preview/building-layer";
import { emptyBuildings } from "../domain/buildings";
import type { BuildingStatus } from "../domain/buildings";

const calibrationName = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("calibration") : null;
const calibrationEnabled = calibrationName === "fuji" || calibrationName === "skytree";

const terrainUrl =
  import.meta.env.VITE_TERRAIN_TILEJSON_URL?.trim() || DEFAULT_TERRAIN_URL;
const waterUrl =
  import.meta.env.VITE_WATER_TILEJSON_URL?.trim() || DEFAULT_WATER_URL;
interface GroundState {
  key: string;
  phase: "loading" | "ready" | "error";
  height?: number;
  message?: string;
}
interface SceneState {
  phase: "loading" | "ready" | "error";
  message: string;
}

export interface TerrainInfo {
  ground: number | null;
  actualHeight: number | null;
  actualPitch: number | null;
  adjusted: boolean;
}

export function TerrainScene({ plan, stations, comets, onVisibilityChange, onCameraChange, onSkyChange, onInfoChange, artificialMcd, weather, onBuildingsChange, buildingAttempt=0 }: { plan: ShootingPlan; stations?: StationScene; comets?: CometScene; onVisibilityChange?: (snapshot: VisibilitySnapshot) => void; onCameraChange?: (camera: RenderedCamera | null) => void; onSkyChange?: (snapshot:SkyVisibility)=>void; onInfoChange?: (info: TerrainInfo) => void; artificialMcd?: number; weather?: WeatherSample; onBuildingsChange?: (status:BuildingStatus)=>void; buildingAttempt?:number }) {
  const container = useRef<HTMLDivElement>(null);
  const synchronize = useRef<(() => void) | null>(null);
  const key = `${plan.longitude}/${plan.latitude}`;
  const covered = isMapPosition(plan);
  const [attempt, setAttempt] = useState(0);
  const [loadingDelayed, setLoadingDelayed] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationSnapshot | null>(null);
  const [camera, setCamera] = useState<RenderedCamera | null>(null);
  const [ground, setGround] = useState<GroundState>({ key, phase: "loading" });
  const [scene, setScene] = useState<SceneState>({
    phase: "loading",
    message: "正在加载地形与水体…",
  });
  const [applied, setApplied] = useState<{
    key: string;
    ground: number;
    altitude: number;
  } | null>(null);
  const latest = useRef({ plan, stations, comets, ground, key, onVisibilityChange, onCameraChange, onSkyChange, artificialMcd, weather, onBuildingsChange, buildingAttempt });

  useEffect(() => {
    latest.current = { plan, stations, comets, ground, key, onVisibilityChange, onCameraChange, onSkyChange, artificialMcd, weather, onBuildingsChange, buildingAttempt };
    synchronize.current?.();
  }, [plan, stations, comets, ground, key, onVisibilityChange, onCameraChange, onSkyChange, artificialMcd, weather, onBuildingsChange, buildingAttempt]);

  useEffect(() => {
    // Unavailable ground has no render/query callback; keep its status explicit
    // even when the user changes time or lens after a loading failure.
    if (!covered || (ground.key === key && ground.phase === "error") || scene.phase === "error") {
      onVisibilityChange?.({ planKey: celestialPlanKey(plan), states: { sun: "error", moon: "error" } });
      onSkyChange?.({planKey:celestialPlanKey(plan),ready:false,view:null,states:{},message:'地形不可用，无法评估星空遮挡。'});
    }
  }, [covered, ground, key, scene.phase, plan, onVisibilityChange, onSkyChange]);

  useEffect(() => {
    const controller = new AbortController();
    setGround({ key, phase: "loading" });
    if (!covered) {
      setGround({
        key,
        phase: "error",
        message: "当前机位超出地形约 ±85.05° 的覆盖范围。",
      });
      return () => controller.abort();
    }
    const timer = setTimeout(() => {
      void import("../preview/elevation")
        .then((module) =>
          module.groundElevation(
            { longitude: plan.longitude, latitude: plan.latitude },
            terrainUrl,
            controller.signal,
          ),
        )
        .then((result) => {
          if (!controller.signal.aborted)
            setGround({ key, phase: "ready", height: result.height });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setGround({
              key,
              phase: "error",
              message:
                error instanceof Error && error.name !== "AbortError"
                  ? `机位高程不可用：${error.message}`
                  : "机位高程请求超时，请重试。",
            });
        });
    }, 120);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [plan.longitude, plan.latitude, covered, key, attempt]);

  useEffect(() => {
    if (!covered || !container.current) return;
    let disposed = false;
    let map: MapLibreMap | undefined;
    let celestialLayer: CelestialLayer | undefined;
    let starfield: StarfieldLayer | undefined;
    let perspective: TerrainPerspective | undefined;
    let buildings: BuildingLayer | undefined;
    let buildingState: BuildingStatus = emptyBuildings;
    let sourceRevision = 0;
    let lastCelestialFrame = "";
    let pathCache: { key: string; paths: BodyPath[] } = { key: "", paths: [] };
    let createCamera: typeof terrainCamera | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let styleReady = false;
    let failed = false;
    let lastPose = "";
    let lastSize = "";
    let lastEnvironment = "";
    let buildingEnvironment: ReturnType<typeof environmentForSky> | undefined;
    let buildingSun: number[] = [0,0,1];
    let lastDetail = 0;
    let lastCoverageRange = -1;
    let currentPoseKey = "";
    let currentPoseGround: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setApplied(null);
    setScene({ phase: "loading", message: "正在加载地形与水体…" });

    const hasSize = () =>
      !!container.current &&
      container.current.clientWidth > 0 &&
      container.current.clientHeight > 0;
    const fail = (message: string) => {
      if (disposed) return;
      failed = true;
      clearTimeout(timeout);
      timeout = undefined;
      setScene({ phase: "error", message });
      setCalibration(null);
      setCamera(null);
      latest.current.onCameraChange?.(null);
      celestialLayer?.setScene({ key: `failed/${sourceRevision++}`, planKey: celestialPlanKey(latest.current.plan), ready: false, bodies: [] });
      starfield?.invalidate();
      latest.current.onSkyChange?.({planKey:celestialPlanKey(latest.current.plan),ready:false,view:null,states:{},message});
      latest.current.onVisibilityChange?.({ planKey: celestialPlanKey(latest.current.plan), states: { sun: "error", moon: "error" }, message });
    };
    const watchLoading = () => {
      if (!timeout && !disposed && !failed && hasSize())
        timeout = setTimeout(() => {
          timeout = undefined;
          if (!hasSize()) return;
          fail(
            !styleReady
              ? "预览渲染样式初始化超时，请重试。"
              : currentPoseKey !== latest.current.key
                ? "拍摄相机初始化超时，请重试。"
                : "地形预览加载超时，请检查网络后重试。",
          );
        }, 25000);
    };
    const markReady = () => {
      if (
        disposed ||
        failed ||
        !map ||
        !createCamera ||
        !styleReady ||
        currentPoseKey !== latest.current.key
      )
        return;
      if (
        map.areTilesLoaded() &&
        map.isSourceLoaded(TERRAIN_SOURCE) &&
        map.isSourceLoaded(WATER_SOURCE)
      ) {
        clearTimeout(timeout);
        timeout = undefined;
        setScene((current) =>
          current.phase === "ready"
            ? current
            : { phase: "ready", message: "地形与水体已加载" },
        );
      }
    };
    const applyCamera = () => {
      if (
        disposed ||
        failed ||
        !map ||
        !createCamera ||
        !styleReady ||
        !container.current
      )
        return;
      const current = latest.current;
      buildings?.setVisible(hasSize()&&current.ground.key===current.key&&current.ground.phase==="ready");
      try {
        const weatherKey = current.weather ? JSON.stringify(current.weather) : "";
        const environmentKey = `${current.key}/${current.plan.instant}/${current.artificialMcd ?? 0}/${weatherKey}`;
        if (environmentKey !== lastEnvironment) {
          const { sun, moon } = celestialBodies(current.plan);
          buildingEnvironment=environmentForSky(sun, moon, current.artificialMcd, current.weather);
          buildingSun=[...sun.direction];
          applyEnvironment(map, buildingEnvironment);
          lastEnvironment = environmentKey;
        }
        if(buildingEnvironment)buildings?.setScene(current.plan,buildingEnvironment,buildingSun,current.weather?.visibility,current.buildingAttempt);
        if(!hasSize())return;
        const size = `${container.current.clientWidth}/${container.current.clientHeight}`;
        if (size !== lastSize) {
          lastSize = size;
          map.resize();
        }
        const detailHeight = container.current.clientHeight;
        const coverageRange=terrainCoverageRange(current.plan);
        if (detailHeight !== lastDetail||coverageRange!==lastCoverageRange) {
          applyTerrainDetail(map, detailHeight,coverageRange);
          lastDetail = detailHeight;
          lastCoverageRange = coverageRange;
          sourceRevision++;
          celestialLayer?.invalidate();
        }
        if(current.ground.key!==current.key||current.ground.phase!=="ready"||current.ground.height===undefined)return;
        const rendered = map.queryTerrainElevation([
          current.plan.longitude,
          current.plan.latitude,
        ]);
        // This API returns 0 for missing DEM too. Only a nonzero surface value,
        // or zero confirmed by our independent sample, can replace the sample.
        const height =
          rendered !== null &&
          Number.isFinite(rendered) &&
          (rendered !== 0 || Math.abs(current.ground.height) < 0.01)
            ? rendered
            : current.ground.height;
        const pose = createCamera(current.plan, height);
        const poseKey = [
          current.key,
          height,
          current.plan.cameraHeight,
          current.plan.azimuth,
          current.plan.pitch,
          current.plan.focalLength,
          sensorKey(current.plan),
          current.plan.aspectRatio,
          current.plan.orientation,
          !!current.plan.layers.buildings,
          container.current.clientWidth,
          container.current.clientHeight,
        ].join("/");
        if (poseKey !== lastPose) {
          lastPose = poseKey;
          map.setVerticalFieldOfView(pose.verticalFov);
          const options = map.calculateCameraOptionsFromTo(
            pose.eye,
            pose.altitude,
            pose.target,
            pose.targetAltitude,
          );
          map.jumpTo({
            ...options,
            bearing: pose.bearing,
            pitch: pose.pitch,
            roll: 0,
          });
          currentPoseKey = current.key;
          currentPoseGround = height;
          setApplied((previous) =>
            previous?.key === current.key &&
            previous.ground === height &&
            previous.altitude === pose.altitude
              ? previous
              : { key: current.key, ground: height, altitude: pose.altitude },
          );
        }
        perspective?.setView(current.plan);
        starfield?.setContrast(current.plan.milkyWayContrast);
        starfield?.setCameraResponse(current.plan.cameraResponse);
        const planKey = celestialPlanKey(current.plan);
        const buildingReady = !current.plan.layers.buildings || (buildingState.key===current.key && (buildingState.phase==="ready" || buildingState.phase==="empty"));
        const ready = buildingReady && map.areTilesLoaded() && map.isSourceLoaded(TERRAIN_SOURCE) && map.isSourceLoaded(WATER_SOURCE);
        const renderView = { azimuth: (map.getBearing() % 360 + 360) % 360, pitch: map.getPitch() - 90 };
        // Whole local hours depend on the time zone, which the plan key leaves out.
        const pathIds = (["sun", "moon"] as const).filter((id) => current.plan.layers[id] && current.plan.layers[`${id}Path`]);
        const pathKey = pathIds.length ? `${pathIds.join("+")}/${current.plan.timeZone}` : "";
        const frameKey = `${poseKey}/${planKey}/${sourceRevision}/${ready}/${renderView.azimuth}/${renderView.pitch}/${current.stations?.key ?? ""}/${current.comets?.key ?? ""}/${current.artificialMcd ?? 0}/${weatherKey}/${pathKey}`;
        if (celestialLayer && frameKey !== lastCelestialFrame) {
          lastCelestialFrame = frameKey;
          // The Moon cuts the Sun's disc during a solar eclipse even with the Moon layer off.
          const sky = celestialBodies(current.plan);
          const bodies = Object.values(sky)
            .filter((body) => current.plan.layers[body.id])
            .map((body) => ({ id: body.id, ...bodyPolygons({ ...current.plan, ...renderView }, body, sky.moon) }))
            .filter((body) => body.state === "画面内");
          const pathSource = `${pathKey}/${current.plan.latitude}/${current.plan.longitude}/${current.plan.instant}/${current.plan.refraction}`;
          if (pathCache.key !== pathSource) pathCache = { key: pathSource, paths: pathIds.map((id) => bodyPath(current.plan, id)) };
          const paths = pathCache.paths.map((path) => {
            const view = pathView({ ...current.plan, ...renderView }, path);
            return { id: path.id, runs: view.runs, markers: view.markers.map((marker) => marker.point) };
          });
          celestialLayer.setScene({ key: frameKey, planKey, ready, bodies, paths, plan: current.plan, weather: current.weather, artificialMcd: current.artificialMcd });
          starfield?.setScene({key:frameKey,planKey,ready,plan:current.plan,stations:current.stations,comets:current.comets,artificialMcd:current.artificialMcd,view:renderView});
        }
        markReady();
      } catch {
        fail("无法更新拍摄预览，请检查机位、时间、镜头和大于 0 的离地高度。");
      }
    };
    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyCamera();
      });
    };

    void (async () => {
      try {
        const [sdk, cameraModule, celestialModule, perspectiveModule, starfieldModule, buildingModule] = await Promise.all([
          import("../map/sdk"),
          import("../preview/camera"),
          import("../preview/celestial-layer"),
          import("../preview/terrain-perspective"),
          import("../preview/starfield-layer"),
          import("../preview/building-layer"),
        ]);
        createCamera = cameraModule.terrainCamera;
        if (disposed || !container.current) return;
        try {
          map = new sdk.Map({
            ...cameraModule.terrainRenderOptions,
            container: container.current,
            style: terrainStyle(terrainUrl, waterUrl),
            center: [
              latest.current.plan.longitude,
              latest.current.plan.latitude,
            ],
            zoom: 12,
            maxPitch: 180,
            centerClampedToGround: false,
            interactive: false,
            attributionControl: false,
            maxTileCacheSize: 64,
            maxTileCacheZoomLevels: 2,
            maxCanvasSize: [2048, 2048],
            pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
            locale: { "Map.Title": "山体与水体摄影预览" },
          });
        } catch {
          fail("三维预览无法启动，请检查浏览器 WebGL 2 支持。");
          return;
        }
        map.on("style.load", () => {
          if (disposed || !map) return;
          perspective = new perspectiveModule.TerrainPerspective(fail);
          try { map.addLayer(perspective); }
          catch { fail("地形坐标桥接无法启动，请重新安装依赖后重试。"); return; }
          buildings = new buildingModule.BuildingLayer((status)=>{
            if(disposed)return;
            // Progress within one load only refreshes the readout.
            const progressOnly=status.phase==="loading"&&buildingState.phase==="loading"&&status.key===buildingState.key;
            buildingState=status;
            if(progressOnly){latest.current.onBuildingsChange?.(status);return;}
            sourceRevision++;
            celestialLayer?.invalidate(true);starfield?.invalidate(true);
            latest.current.onBuildingsChange?.(status);schedule();
          },waterUrl,terrainUrl);
          try { map.addLayer(buildings); }
          catch { fail("建筑图层无法启动，请重试预览。");return; }
          starfield = new starfieldModule.StarfieldLayer((snapshot)=>{
            if(disposed)return;
            const unavailable=!!latest.current.plan.layers.buildings&&buildingState.phase==="error";
            latest.current.onSkyChange?.(unavailable?{...snapshot,ready:false,occlusionUnavailable:true,labelStates:{}}:snapshot);
            if(snapshot.message)fail(snapshot.message);
          });
          try { map.addLayer(starfield); }
          catch { fail('星空与银河图层无法启动，请重试预览。');return; }
          celestialLayer = new celestialModule.CelestialLayer((snapshot) => {
            if (disposed) return;
            const unavailable=!!latest.current.plan.layers.buildings&&buildingState.phase==="error";
            latest.current.onVisibilityChange?.(unavailable?{...snapshot,states:{sun:"error",moon:"error"},labelStates:{}}:snapshot);
            if (snapshot.message) fail(snapshot.message);
          }, (rendered) => {
            if (disposed) return;
            setCamera(rendered);
            latest.current.onCameraChange?.(rendered);
          });
          try { map.addLayer(celestialLayer); }
          catch { fail("日月深度图层无法启动，请重试预览。"); return; }
          celestialLayer.setVisible(hasSize());
          if (calibrationEnabled) void import("../preview/calibration").then(({ calibrationLayer, skytreeCalibrationTarget }) => {
            if (disposed || !map) return;
            map.addLayer(calibrationLayer(map, () => ({ plan: latest.current.plan,
              ground: currentPoseKey === latest.current.key && latest.current.ground.key === latest.current.key && latest.current.ground.phase === "ready"
                ? currentPoseGround : null }), terrainUrl,
            (snapshot) => { if (!disposed) setCalibration(snapshot); },
            (point,width,height) => perspective?.projectProbe(point,width,height) ?? null,
            calibrationName === "skytree" ? skytreeCalibrationTarget : undefined));
          });
          styleReady = true;
          schedule();
        });
        map.on("sourcedata", () => { if (!disposed && !failed) { sourceRevision++; celestialLayer?.invalidate(); starfield?.invalidate(); schedule(); } });
        map.on("render", () => schedule());
        map.on("idle", () => {
          schedule();
          markReady();
        });
        map.on("dataloading", () => {
          // A cached/sky-only view may finish without another sourcedata event.
          // Re-evaluate readiness even when its pose and visible tiles are unchanged.
          if (!disposed && !failed) { sourceRevision++; schedule(); }
          if (!disposed && !failed) celestialLayer?.invalidate();
          if (!disposed && !failed) starfield?.invalidate();
          if (!disposed && !failed) watchLoading();
          if (!disposed && !failed)
            setScene((current) =>
              current.phase === "loading"
                ? current
                : { phase: "loading", message: "视野内地形与水体正在细化…" },
            );
        });
        map.on("error", (event) =>
          fail(
            "sourceId" in event && event.sourceId === WATER_SOURCE
              ? "水体或地表数据加载失败，画面可能缺少水岸信息。"
              : "地形数据加载失败，画面可能存在缺失，请重试。",
          ),
        );
        map.on("webglcontextlost", () => fail("预览图形环境已中断，请重试。"));
        observer = new ResizeObserver((entries) => {
          const bounds = entries[0]?.contentRect;
          if (disposed || !map || !bounds) return;
          // A hidden host invalidates queries even if its restored dimensions
          // match the previous pose. Issue a fresh frame on every size event.
          sourceRevision++;
          celestialLayer?.setVisible(bounds.width > 0 && bounds.height > 0);
          buildings?.setVisible(bounds.width > 0 && bounds.height > 0 && latest.current.ground.key===latest.current.key && latest.current.ground.phase==="ready");
          if (bounds.width <= 0 || bounds.height <= 0) {
            clearTimeout(timeout);
            timeout = undefined;
            celestialLayer?.invalidate();
            starfield?.invalidate();
            latest.current.onVisibilityChange?.({ planKey: "", states: { sun: "waiting", moon: "waiting" } });
            return;
          }
          map.resize();
          watchLoading();
          schedule();
        });
        observer.observe(container.current);
        synchronize.current = schedule;
        watchLoading();
      } catch {
        fail("预览模块未能加载，请检查网络后重试。");
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      synchronize.current = null;
      map?.remove();
    };
  }, [attempt, covered]);

  const currentGround = ground.key === key && ground.phase === "ready";
  const visible = applied?.key === key && currentGround;
  const currentCamera = visible && camera?.planKey === celestialPlanKey(plan) ? camera : null;
  const adjusted = currentCamera && applied && (Math.abs(currentCamera.altitude - applied.altitude) > 0.02 || Math.abs(currentCamera.pitch - plan.pitch) > 1e-4);
  const message = !covered
    ? "当前机位超出地形约 ±85.05° 的覆盖范围。"
    : ground.key === key && ground.phase === "error"
      ? ground.message
      : !currentGround
        ? "正在读取机位高程…"
        : scene.phase === "error"
          ? scene.message
          : !visible
            ? "正在建立拍摄视角…"
            : scene.phase === "loading"
              ? scene.message
              : "";
  const error =
    scene.phase === "error" || (ground.key === key && ground.phase === "error");
  const retained = !!applied && covered && !error;
  const waiting = !!message && !error && covered;
  useEffect(() => {
    setLoadingDelayed(false);
    if (!waiting) return;
    const timer = setTimeout(() => setLoadingDelayed(true), 800);
    return () => clearTimeout(timer);
  }, [waiting, key, attempt]);
  const groundHeight = visible && applied ? applied.ground : null;
  const actualHeight = currentCamera && applied ? currentCamera.altitude - applied.ground : null;
  const actualPitch = currentCamera?.pitch ?? null;
  useEffect(() => {
    onInfoChange?.({ ground: groundHeight, actualHeight, actualPitch, adjusted: !!adjusted });
  }, [groundHeight, actualHeight, actualPitch, adjusted, onInfoChange]);
  return (
    <div
      className="terrain-scene"
      aria-label="真实 DEM 山体与静态水体预览，水面高程按 DEM 近似"
    >
      <div className="terrain-canvas" ref={container} data-ready={!!visible} data-rendered={retained} data-celestial-renderer="webgl-depth" data-terrain-projection="wgs84-enu" />
      {calibrationEnabled && calibration && visible && <>
        {Object.entries(calibration.pixels).filter(([name]) => name !== "matrixDem" && name !== "actualDem").map(([name, pixel]) => pixel &&
          pixel.x >= 0 && pixel.y >= 0 && pixel.x <= calibration.width && pixel.y <= calibration.height &&
          <span key={name} className={`calibration-marker calibration-${name}`} data-calibration-marker={name}
            style={{ left: pixel.x, top: pixel.y }} title={name}>{name === "sdkDem" ? "○" : "+"}</span>)}
        <details className="camera-calibration" open onPointerDown={(event) => event.stopPropagation()}>
          <summary>开发校准 · 参考点与实际眼点</summary>
          <span>紫圈旧平面参考 · 绿十字椭球参考 · 白圈实际顶点程序</span>
          <p>地形、水体与日月按机位 ENU 绘制；同源高程作为参考曲面，未核定垂直基准，不验证实景精度。</p>
          {calibration.curvature.gpuResidual !== null && <p data-gpu-residual>GPU − 独立椭球参考：{calibration.curvature.gpuResidual.toFixed(5)} CSS px</p>}
          {calibration.curvature.dem?.ellipsoid.pixel && calibration.curvature.dem.mercator.pixel && <p data-curvature-summary>
            椭球 − 平面：Δx {(calibration.curvature.dem.ellipsoid.pixel.x - calibration.curvature.dem.mercator.pixel.x).toFixed(2)} px，
            Δy {(calibration.curvature.dem.ellipsoid.pixel.y - calibration.curvature.dem.mercator.pixel.y).toFixed(2)} px；
            垂直曲率分量 {calibration.curvature.dem.verticalDrop.toFixed(2)} m（修正前模型差，向右/下为正）。
          </p>}
          <pre data-camera-calibration data-focal={calibration.plan.focalLength} data-height={calibration.plan.cameraHeight}
            data-ready={calibration.ready}>{JSON.stringify(calibration, null, 2)}</pre>
        </details>
      </>}
      {message && (error || !covered || loadingDelayed) && (
        <div
          className={`terrain-feedback ${retained ? "terrain-feedback-partial" : ""} ${error ? "terrain-feedback-error" : ""}`}
          role="status"
        >
          <span>{message}{retained && !visible ? " · 暂留上一机位画面" : ""}</span>
          {error && covered && (
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setAttempt((value) => value + 1);
              }}
            >
              重试预览
            </button>
          )}
        </div>
      )}
    </div>
  );
}
