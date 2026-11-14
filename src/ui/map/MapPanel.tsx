import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Map as MapLibreMap, Marker, GeoJSONSource } from "maplibre-gl";
import type { ShootingPlan } from "../../domain/core/plan";
import { normalizeLongitude, sensorKey } from "../../domain/core/plan";
import type { TideFeed } from "../environment/TideScene";
import type { AuroraFeed } from "../environment/AuroraScene";
import { destination, isMapPosition, mapSelection, nearbyLongitude, viewGeometry } from "../../domain/core/map";
import type { MapMode, MapViewport } from "../../domain/core/map";
import { Icon } from "../common/Icon";
import { MapSearch } from "./MapSearch";
import type { MapTarget } from "./MapSearch";
import type { CompositionState } from "../solve/useComposition";
import { addOverlays, drawnOverlays, updateOverlays, viewSourceId } from "./map-overlays";
import { useMapOverlays } from "./useMapOverlays";
import { MapLegend } from "./MapLegend";

const styleUrl =
  import.meta.env.VITE_MAP_STYLE_URL?.trim() ||
  "https://tiles.openfreemap.org/styles/liberty";
type LoadStatus = {
  phase: "loading" | "ready" | "error" | "unavailable";
  message: string;
};

export function MapPanel({
  plan,
  update,
  viewport,
  tides,
  aurora,
  alignment,
}: {
  plan: ShootingPlan;
  update: (patch: Partial<ShootingPlan>) => void;
  viewport: RefObject<MapViewport>;
  tides?: TideFeed;
  aurora?: AuroraFeed;
  /** 推算: ground targets, result lines and placing a ground target. */
  alignment?: CompositionState | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<MapLibreMap | null>(null);
  const synchronize = useRef<((followPosition?: boolean) => void) | null>(null);
  const [mode, setMode] = useState<MapMode>("browse");
  // What the overlays show: body lines, eclipse, aurora and tides, 推算 results.
  const { lines, eclipse, environment, tideCell, auroraKp, solve, placingTarget, alignmentFeatures, alignmentKind } =
    useMapOverlays(plan, tides, aurora, alignment);
  const solveRef = useRef({ placing: placingTarget, place: solve?.placeTarget, cancel: () => solve?.setPlacing(null) });
  solveRef.current = { placing: placingTarget, place: solve?.placeTarget, cancel: () => solve?.setPlacing(null) };
  const latest = useRef({ plan, update, mode, lines, eclipse, environment, alignmentFeatures, alignmentKind });
  const [searchOpen, setSearchOpen] = useState(false);
  const [target, setTarget] = useState<MapTarget | null>(null);
  const [locating, setLocating] = useState(false);
  const targetMarker = useRef<Marker | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [available, setAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<LoadStatus>({
    phase: "loading",
    message: "正在加载地图与底图…",
  });
  const coverage = isMapPosition(plan);

  useEffect(() => {
    latest.current = { plan, update, mode, lines, eclipse, environment, alignmentFeatures, alignmentKind };
    synchronize.current?.(true);
  }, [plan, update, mode, lines, eclipse, environment, alignmentFeatures, alignmentKind]);
  // A finished search: show its ground target, range and lines once.
  const fittedResult = useRef<unknown>(null);
  const finished = solve?.run?.phase === "done" ? solve.run : null;
  useEffect(() => {
    const map = instance.current;
    if (!map || !finished || fittedResult.current === finished) return;
    fittedResult.current = finished;
    const ground = finished.basis.ground;
    const lines = finished.items.flatMap((item) => item.points ?? []);
    const points = [
      ...(ground ? [ground] : []),
      ...finished.rings.flatMap((ring) => [0, 90, 180, 270].map((bearing) => destination(ring, bearing, ring.radius))),
      ...lines,
      ...finished.items.filter((item) => !item.points).map((item) => item.camera),
    ];
    if (!points.length) return;
    const anchor = points[0].longitude;
    const longitudes = points.map((point) => nearbyLongitude(point.longitude, anchor));
    const latitudes = points.map((point) => point.latitude);
    map.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]], { padding: 48, maxZoom: 14, duration: 600 });
  }, [finished]);

  // A searched place or the device position: shown and flown to; the shot
  // only changes through "设为机位".
  useEffect(() => {
    const map = instance.current, marker = targetMarker.current;
    if (!marker) return;
    const element = marker.getElement();
    if (!target) {
      element.style.display = "none";
      return;
    }
    element.style.display = "";
    element.className = `map-target-marker map-target-${target.kind}`;
    element.setAttribute("aria-label", `${target.name}：纬度 ${target.latitude.toFixed(4)}，经度 ${target.longitude.toFixed(4)}`);
    marker.setLngLat([target.longitude, target.latitude]);
    if (!map) return;
    const bounds = target.bounds;
    // Small extents fit the view; countries and oceans just centre on the point.
    if (bounds && bounds[1] - bounds[0] < 20 && bounds[3] - bounds[2] < 20)
      map.fitBounds([[bounds[2], bounds[0]], [bounds[3], bounds[1]]], { padding: 48, maxZoom: 15, duration: 600 });
    else map.easeTo({ center: [target.longitude, target.latitude], zoom: Math.max(map.getZoom(), 13), duration: 600 });
  }, [target]);

  const locate = () => {
    setNotice("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNotice("此浏览器不支持定位。");
      return;
    }
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setNotice("定位需要通过 HTTPS 访问本页面。");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setSearchOpen(false);
        const { latitude, longitude, accuracy } = position.coords;
        setTarget({
          kind: "device",
          name: "我的位置",
          detail: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}${Number.isFinite(accuracy) ? ` · 精度约 ${Math.round(accuracy)} m` : ""}`,
          latitude,
          longitude,
          accuracy,
        });
      },
      (error) => {
        setLocating(false);
        setNotice(
          error.code === 1 ? "未获得定位权限，可在浏览器设置中允许本站定位。"
            : error.code === 3 ? "定位超时，请稍后重试。"
              : "无法获得当前位置。",
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

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
    const drawn = drawnOverlays();
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
        sensorKey(current),
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
      updateOverlays(map, latest.current, drawn, nextGeometryKey);
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
        const sdk = await import("./sdk");
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
            attributionControl: { compact: true },
            locale: {
              "AttributionControl.ToggleAttribution": "地图版权与来源",
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

        const targetElement = document.createElement("div");
        targetElement.className = "map-target-marker";
        targetElement.style.display = "none";
        targetElement.setAttribute("role", "img");
        targetMarker.current = new sdk.Marker({ element: targetElement, anchor: "center" })
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
          // Placing the 推算 target takes the click before the camera tools.
          if (solveRef.current.placing && solveRef.current.place) {
            solveRef.current.place(event.lngLat.lng, event.lngLat.lat);
            return;
          }
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
            addOverlays(map, latest.current, drawn);
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
        targetMarker.current?.remove();
        targetMarker.current = null;
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
          if (solveRef.current.placing) solveRef.current.cancel();
        }
      }}
    >
      <div
        className="map-engine"
        ref={container}
        aria-label="交互地图，可用方向键浏览、加减键缩放；坐标也可在下方机位条输入"
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
          className={`map-tool-button ${searchOpen ? "is-active" : ""}`}
          aria-label="搜索地点"
          aria-pressed={searchOpen}
          title="搜索地点"
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Icon name="search" size={17} />
        </button>
        <button
          className="map-tool-button"
          aria-label="我的位置"
          title="我的位置（只在本机使用）"
          disabled={locating}
          onClick={locate}
        >
          <Icon name="locate" size={17} />
        </button>
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
      {searchOpen && (
        <MapSearch
          onChoose={(place) => {
            setSearchOpen(false);
            setTarget(place);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      <div className="map-feedback" aria-live="polite">
        {locating && <p className="map-interaction-hint">正在获取当前位置…</p>}
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
            的纬度范围，已保留原始坐标；地图不显示该机位及视场，可继续在下方机位条编辑。
          </p>
        )}
        {notice && <p className="map-coverage-warning">{notice}</p>}
        {placingTarget && (
          <p className="map-interaction-hint" role="status">单击放置推算目标 · Escape 取消</p>
        )}
        {status.phase === "ready" && coverage && !notice && !placingTarget && mode !== "browse" && (
          <p className="map-interaction-hint">
            {mode === "position"
              ? "单击放置一次机位 · Escape 取消"
              : mode === "direction"
                ? "单击目标设置一次朝向 · Escape 取消"
                : ""}
          </p>
        )}
      </div>
      <MapLegend lines={lines} eclipse={eclipse} auroraKp={auroraKp} tideCell={tideCell} alignmentFeatures={alignmentFeatures} />
      {target && (
        <div className="map-target-card" role="group" aria-label={`地图标记：${target.name}`}>
          <span>
            <strong>{target.name}</strong>
            <small>{target.detail}</small>
          </span>
          <button
            type="button"
            className="map-target-apply"
            onClick={() => {
              update({ latitude: target.latitude, longitude: normalizeLongitude(target.longitude) });
              setTarget(null);
            }}
          >
            设为机位
          </button>
          <button type="button" className="map-target-close" aria-label="移除地图标记" onClick={() => setTarget(null)}>×</button>
        </div>
      )}
    </div>
  );
}
