import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan";
import { isMapPosition } from "../domain/map";
import {
  DEFAULT_TERRAIN_URL,
  DEFAULT_WATER_URL,
  TERRAIN_SOURCE,
  WATER_SOURCE,
  terrainStyle,
} from "../domain/terrain";
import type { terrainCamera } from "../preview/camera";
import { solarPosition } from "../domain/solar";
import { applyEnvironment, environmentForSun } from "../preview/environment";

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

export function TerrainScene({ plan }: { plan: ShootingPlan }) {
  const container = useRef<HTMLDivElement>(null);
  const synchronize = useRef<(() => void) | null>(null);
  const key = `${plan.longitude}/${plan.latitude}`;
  const covered = isMapPosition(plan);
  const [attempt, setAttempt] = useState(0);
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
  const latest = useRef({ plan, ground, key });

  useEffect(() => {
    latest.current = { plan, ground, key };
    synchronize.current?.();
  }, [plan, ground, key]);

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
    let createCamera: typeof terrainCamera | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let styleReady = false;
    let failed = false;
    let lastPose = "";
    let lastEnvironment = "";
    let currentPoseKey = "";
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
        !container.current ||
        container.current.clientWidth <= 0 ||
        container.current.clientHeight <= 0
      )
        return;
      const current = latest.current;
      if (
        current.ground.key !== current.key ||
        current.ground.phase !== "ready" ||
        current.ground.height === undefined
      )
        return;
      try {
        const environmentKey = `${current.key}/${current.plan.instant}`;
        if (environmentKey !== lastEnvironment) {
          applyEnvironment(map, environmentForSun(solarPosition(current.plan)));
          lastEnvironment = environmentKey;
        }
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
          current.plan.sensor,
          current.plan.aspectRatio,
          current.plan.orientation,
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
          setApplied((previous) =>
            previous?.key === current.key &&
            previous.ground === height &&
            previous.altitude === pose.altitude
              ? previous
              : { key: current.key, ground: height, altitude: pose.altitude },
          );
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
        const [sdk, cameraModule] = await Promise.all([
          import("../map/sdk"),
          import("../preview/camera"),
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
          styleReady = true;
          schedule();
        });
        map.on("sourcedata", () => schedule());
        map.on("render", () => schedule());
        map.on("idle", () => {
          schedule();
          markReady();
        });
        map.on("dataloading", () => {
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
          if (bounds.width <= 0 || bounds.height <= 0) {
            clearTimeout(timeout);
            timeout = undefined;
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
  return (
    <div
      className="terrain-scene"
      aria-label="真实 DEM 山体与静态水体预览，水面高程按 DEM 近似"
    >
      <div className="terrain-canvas" ref={container} data-ready={!!visible} />
      {message && (
        <div
          className={`terrain-feedback ${visible ? "terrain-feedback-partial" : ""} ${error ? "terrain-feedback-error" : ""}`}
          role="status"
        >
          <span>{message}</span>
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
      {visible && applied && (
        <span className="terrain-height">
          机位高程 ≈ {applied.ground.toFixed(1)} m · 离地 {plan.cameraHeight} m
        </span>
      )}
    </div>
  );
}
