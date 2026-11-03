import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Map as MapLibreMap, Marker, GeoJSONSource } from "maplibre-gl";
import { compassDirection, fieldOfView } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import {
  isMapPosition,
  mapSelection,
  nearbyLongitude,
  viewGeometry,
} from "../domain/map";
import type { MapMode, MapViewport } from "../domain/map";
import { Icon } from "./Icon";

const styleUrl =
  import.meta.env.VITE_MAP_STYLE_URL?.trim() ||
  "https://tiles.openfreemap.org/styles/liberty";
const viewSourceId = "tamatamatori-view";
type LoadStatus = {
  phase: "loading" | "ready" | "error" | "unavailable";
  message: string;
};

export function MapPanel({
  plan,
  update,
  viewport,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  viewport: RefObject<MapViewport>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<MapLibreMap | null>(null);
  const synchronize = useRef<((followPosition?: boolean) => void) | null>(null);
  const [mode, setMode] = useState<MapMode>("browse");
  const latest = useRef({ plan, update, mode });
  const [attempt, setAttempt] = useState(0);
  const [available, setAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<LoadStatus>({
    phase: "loading",
    message: "正在加载地图与底图…",
  });
  const coverage = isMapPosition(plan);
  const fov = fieldOfView(plan);

  useEffect(() => {
    latest.current = { plan, update, mode };
    synchronize.current?.(true);
  }, [plan, update, mode]);

  useEffect(() => {
    if (!coverage) setMode("browse");
  }, [coverage]);

  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | undefined;
    let camera: Marker | undefined;
    let direction: Marker | undefined;
    let observer: ResizeObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    let frame = 0;
    let followRequested = false;
    let activeDrag: "camera" | "direction" | null = null;
    let geometryKey = "";
    let geometry = viewGeometry(latest.current.plan, viewport.current.zoom);
    let previousPosition = {
      longitude: latest.current.plan.longitude,
      latitude: latest.current.plan.latitude,
    };
    setAvailable(false);
    setStatus({ phase: "loading", message: "正在加载地图与底图…" });

    const reportFailure = (message: string) => {
      if (disposed) return;
      failed = true;
      setStatus({ phase: "error", message });
    };

    const draw = (followPosition = false) => {
      if (
        disposed ||
        !map ||
        !camera ||
        !direction ||
        !map.getSource(viewSourceId)
      )
        return;
      const current = latest.current.plan;
      const source = map.getSource(viewSourceId) as GeoJSONSource;
      const valid = isMapPosition(current);
      const changed =
        previousPosition &&
        (current.longitude !== previousPosition.longitude ||
          current.latitude !== previousPosition.latitude);
      previousPosition = {
        longitude: current.longitude,
        latitude: current.latitude,
      };
      camera.getElement().style.display = valid ? "" : "none";
      const nextGeometryKey = [
        current.latitude,
        current.longitude,
        current.azimuth,
        current.focalLength,
        current.sensor,
        current.aspectRatio,
        current.orientation,
        map.getZoom(),
      ].join("/");
      if (nextGeometryKey !== geometryKey) {
        geometry = viewGeometry(current, map.getZoom());
        geometryKey = nextGeometryKey;
        source.setData(geometry);
      }
      direction.getElement().style.display = geometry.features.length
        ? ""
        : "none";
      if (!valid) return;
      const longitude = nearbyLongitude(current.longitude, map.getCenter().lng);
      if (activeDrag !== "camera")
        camera.setLngLat([longitude, current.latitude]);
      camera
        .getElement()
        .setAttribute(
          "aria-label",
          `当前机位：纬度 ${current.latitude.toFixed(4)}，经度 ${current.longitude.toFixed(4)}。可拖动修改，也可在参数区输入。`,
        );
      const line = geometry.features.find(
        (feature) => feature.geometry.type === "LineString",
      );
      if (line?.geometry.type === "LineString" && activeDrag !== "direction") {
        const end = line.geometry.coordinates[1];
        direction
          .setLngLat([nearbyLongitude(end[0], map.getCenter().lng), end[1]])
          .setRotation(current.azimuth);
      }
      if (
        followPosition &&
        !activeDrag &&
        changed &&
        !map.getBounds().contains([longitude, current.latitude])
      ) {
        map.easeTo({ center: [longitude, current.latitude], duration: 450 });
      }
    };

    const scheduleDraw = (followPosition = false) => {
      if (disposed) return;
      followRequested ||= followPosition;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const follow = followRequested;
        followRequested = false;
        draw(follow);
      });
    };

    void (async () => {
      try {
        const sdk = await import("../map/sdk");
        if (disposed || !container.current) return;
        try {
          map = new sdk.Map({
            container: container.current,
            style: styleUrl,
            center: [viewport.current.longitude, viewport.current.latitude],
            zoom: viewport.current.zoom,
            bearing: viewport.current.bearing,
            maxZoom: 19,
            maxPitch: 0,
            dragRotate: true,
            touchPitch: false,
            pitchWithRotate: false,
            attributionControl: { compact: false },
            locale: {
              "Map.Title": "摄影机位地图",
              "NavigationControl.ZoomIn": "放大地图",
              "NavigationControl.ZoomOut": "缩小地图",
              "NavigationControl.ResetBearing": "恢复地图朝北",
              "ScaleControl.Meters": "米",
              "ScaleControl.Kilometers": "千米",
            },
          });
        } catch {
          setStatus({
            phase: "unavailable",
            message:
              "地图无法启动，请检查浏览器是否支持并启用 WebGL 2。拍摄参数仍可编辑。",
          });
          return;
        }
        instance.current = map;
        map.addControl(
          new sdk.NavigationControl({ showCompass: true }),
          "top-right",
        );
        map.addControl(
          new sdk.ScaleControl({ unit: "metric", maxWidth: 80 }),
          "bottom-left",
        );

        const markerElement = document.createElement("div");
        markerElement.className = "camera-position-marker";
        markerElement.style.display = "none";
        markerElement.setAttribute("role", "img");
        markerElement.title = "拖动修改机位；也可在参数区输入坐标";
        camera = new sdk.Marker({
          element: markerElement,
          draggable: true,
          anchor: "center",
        })
          .setLngLat([0, 0])
          .addTo(map);

        const headingElement = document.createElement("div");
        headingElement.className = "camera-direction-marker";
        headingElement.style.display = "none";
        headingElement.title = "拖动修改拍摄方向；也可在参数区输入方位角";
        headingElement.setAttribute("role", "img");
        headingElement.setAttribute(
          "aria-label",
          "拍摄方向把手，可拖动；也可在参数区输入方位角",
        );
        headingElement.textContent = "▲";
        direction = new sdk.Marker({
          element: headingElement,
          draggable: true,
          anchor: "center",
          rotationAlignment: "map",
        })
          .setLngLat([0, 0])
          .addTo(map);

        const choose = (
          longitude: number,
          latitude: number,
          interactionMode: MapMode,
        ) => {
          const patch = mapSelection(
            latest.current.plan,
            { longitude, latitude },
            interactionMode,
          );
          if (patch) {
            setNotice("");
            latest.current = {
              ...latest.current,
              plan: { ...latest.current.plan, ...patch },
            };
            latest.current.update(patch);
            scheduleDraw();
            return true;
          } else {
            setNotice(
              "这个点无法确定有效朝向或超出底图范围，请选择其他点或在参数区输入。",
            );
            scheduleDraw();
            return false;
          }
        };
        camera.on("dragstart", () => {
          activeDrag = "camera";
        });
        camera.on("drag", () => {
          const point = camera!.getLngLat();
          choose(point.lng, point.lat, "position");
        });
        camera.on("dragend", () => {
          const point = camera!.getLngLat();
          choose(point.lng, point.lat, "position");
          activeDrag = null;
          scheduleDraw();
        });
        direction.on("dragstart", () => {
          activeDrag = "direction";
        });
        direction.on("drag", () => {
          const point = direction!.getLngLat();
          choose(point.lng, point.lat, "direction");
        });
        direction.on("dragend", () => {
          const point = direction!.getLngLat();
          choose(point.lng, point.lat, "direction");
          activeDrag = null;
          scheduleDraw();
        });
        map.on("click", (event) => {
          if (
            (event.originalEvent.target as Element | null)?.closest(
              ".maplibregl-marker",
            )
          )
            return;
          if (latest.current.mode === "browse") return;
          if (choose(event.lngLat.lng, event.lngLat.lat, latest.current.mode)) {
            latest.current.mode = "browse";
            setMode("browse");
          }
        });
        map.on("move", () => scheduleDraw());
        map.on("zoom", () => scheduleDraw());
        map.on("rotate", () => scheduleDraw());
        map.on("moveend", () => {
          const center = map!.getCenter();
          viewport.current = {
            longitude: center.lng,
            latitude: center.lat,
            zoom: map!.getZoom(),
            bearing: map!.getBearing(),
          };
          scheduleDraw();
        });
        map.on("error", () =>
          reportFailure(
            "底图、字体或瓦片加载失败。检查网络后可重试，拍摄参数已保留。",
          ),
        );
        map.on("webglcontextlost", () =>
          reportFailure("地图图形环境已中断，可重试恢复；拍摄参数已保留。"),
        );
        map.on("style.load", () => {
          if (disposed || !map) return;
          try {
            map.addSource(viewSourceId, {
              type: "geojson",
              data: viewGeometry(latest.current.plan, map.getZoom()),
            });
            map.addLayer({
              id: "tamatamatori-field",
              type: "fill",
              source: viewSourceId,
              filter: ["==", ["get", "kind"], "field"],
              paint: {
                "fill-color": "#34715a",
                "fill-opacity": 0.2,
                "fill-outline-color": "#34715a",
              },
            });
            map.addLayer({
              id: "tamatamatori-direction",
              type: "line",
              source: viewSourceId,
              filter: ["==", ["get", "kind"], "direction"],
              paint: {
                "line-color": "#326d51",
                "line-width": 2,
                "line-dasharray": [3, 2],
              },
            });
            scheduleDraw(true);
          } catch {
            reportFailure("地图叠加未能建立，可重试；拍摄参数已保留。");
          }
        });
        map.on("idle", () => {
          clearTimeout(timeout);
          if (!disposed && !failed)
            setStatus({ phase: "ready", message: "底图已加载" });
        });
        timeout = setTimeout(
          () =>
            reportFailure("地图加载超时，检查网络后可重试；拍摄参数仍可编辑。"),
          20_000,
        );
        synchronize.current = scheduleDraw;
        observer = new ResizeObserver((entries) => {
          if (disposed || !map) return;
          const bounds = entries[0]?.contentRect;
          if (bounds && bounds.width > 0 && bounds.height > 0) {
            map.resize();
            scheduleDraw();
          }
        });
        observer.observe(container.current);
        setAvailable(true);
      } catch {
        reportFailure("地图模块未能加载，请检查网络后重试。拍摄参数仍可编辑。");
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      synchronize.current = null;
      if (map) {
        const center = map.getCenter();
        viewport.current = {
          longitude: center.lng,
          latitude: center.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
        };
        camera?.remove();
        direction?.remove();
        map.remove();
      }
      instance.current = null;
    };
  }, [attempt, viewport]);

  return (
    <div
      className="real-map"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          latest.current.mode = "browse";
          setMode("browse");
          setNotice("");
        }
      }}
    >
      <div
        className="map-engine"
        ref={container}
        aria-label="交互地图，可用方向键浏览、加减键缩放；机位和朝向也可在参数区输入"
      />
      <div className="map-toolbar">
        <div className="map-mode-group" aria-label="地图点击操作">
          <button
            aria-pressed={mode === "position"}
            onClick={() => {
              setMode((current) =>
                current === "position" ? "browse" : "position",
              );
              setNotice("");
            }}
          >
            放置机位
          </button>
          <button
            aria-pressed={mode === "direction"}
            disabled={!coverage}
            onClick={() => {
              setMode((current) =>
                current === "direction" ? "browse" : "direction",
              );
              setNotice("");
            }}
          >
            定朝向
          </button>
        </div>
        <button
          className="map-tool-button"
          aria-label="回到机位"
          title="回到机位"
          disabled={!available || !coverage}
          onClick={() =>
            instance.current?.easeTo({
              center: [plan.longitude, plan.latitude],
              duration: 450,
            })
          }
        >
          <Icon name="pin" size={17} />
        </button>
        <button
          className="map-tool-button"
          aria-label="全球视图"
          title="全球视图"
          disabled={!available}
          onClick={() =>
            instance.current?.easeTo({
              center: [0, 20],
              zoom: 1,
              duration: 800,
            })
          }
        >
          <Icon name="map" size={17} />
        </button>
      </div>
      <div className="map-feedback" aria-live="polite">
        {status.phase !== "ready" && (
          <div className={`map-status map-status-${status.phase}`}>
            <span>{status.message}</span>
            {(status.phase === "error" || status.phase === "unavailable") && (
              <button
                onClick={() => {
                  setNotice("");
                  setAttempt((value) => value + 1);
                }}
              >
                重试地图
              </button>
            )}
          </div>
        )}
        {!coverage && (
          <p className="map-coverage-warning">
            当前机位超出底图 ±85.05°
            的纬度范围，已保留原始坐标；地图不显示该机位及视场，可继续在参数区编辑。
          </p>
        )}
        {notice && <p className="map-coverage-warning">{notice}</p>}
        {status.phase === "ready" && coverage && !notice && (
          <p className="map-interaction-hint">
            {mode === "position"
              ? "单击放置一次机位 · Escape 取消"
              : mode === "direction"
                ? "单击目标设置一次朝向 · Escape 取消"
                : "拖动浏览，右键拖动旋转 · 放置机位需先点击上方按钮"}
          </p>
        )}
      </div>
      <div className="real-map-summary">
        <div className="map-coordinate">
          <Icon name="pin" size={14} />
          <span>
            {Math.abs(plan.latitude).toFixed(4)}°
            {plan.latitude >= 0 ? "N" : "S"} &nbsp;{" "}
            {Math.abs(plan.longitude).toFixed(4)}°
            {plan.longitude >= 0 ? "E" : "W"}
          </span>
          <span className="map-source-label">
            {status.phase === "ready" ? "底图已加载" : "底图待就绪"}
          </span>
        </div>
        <div className="map-values">
          <span>
            方向 <strong>{plan.azimuth.toFixed(1)}°</strong>{" "}
            <small>{compassDirection(plan.azimuth)}</small>
          </span>
          <span>
            水平视场 <strong>{fov.horizontal.toFixed(1)}°</strong>
          </span>
          <span>
            焦距 <strong>{plan.focalLength}</strong> mm
          </span>
        </div>
      </div>
      <p className="map-footer-note">
        扇形表示水平视场角；长度随缩放变化，不代表拍摄距离或地形可视范围。
      </p>
    </div>
  );
}
