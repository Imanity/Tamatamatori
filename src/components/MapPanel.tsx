import { bodyKind } from "../domain/sky-targets";
import type { SolveBodyId } from "../domain/sky-targets";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Map as MapLibreMap, Marker, GeoJSONSource } from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan";
import { normalizeLongitude, sensorKey } from "../domain/plan";
import { bodyLines, lineLabels } from "../domain/body-lines";
import type { BodyLine } from "../domain/body-lines";
import { timelineMode, timelineWindow } from "../domain/timeline";
import { centralEclipseInSpan, centralPath, umbraFootprint, unwrap } from "../domain/eclipses";
import type { CentralPath } from "../domain/eclipses";
import { auroraLines, kpAt, ovationApplies, ovationCells } from "../domain/aurora";
import type { TideFeed } from "./TideScene";
import type { AuroraFeed } from "./AuroraScene";
import {
  destination,
  isMapPosition,
  mapSelection,
  nearbyLongitude,
  viewGeometry,
  viewRadiusMeters,
} from "../domain/map";
import type { MapMode, MapViewport } from "../domain/map";
import { Icon } from "./Icon";
import { MapSearch } from "./MapSearch";
import type { MapTarget } from "./MapSearch";
import { compositionGeometry } from "./Composition";
import type { CompositionState } from "./Composition";

const styleUrl =
  import.meta.env.VITE_MAP_STYLE_URL?.trim() ||
  "https://tiles.openfreemap.org/styles/liberty";
const viewSourceId = "tamatamatori-view";
const linesSourceId = "tamatamatori-body-lines";
const labelSourceId = "tamatamatori-line-labels";
const eclipseSourceId = "tamatamatori-eclipse";
const environmentSourceId = "tamatamatori-environment";
const alignmentSourceId = "tamatamatori-alignment";
const emptyFeatures: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
type EclipseMap = { kind: CentralPath["kind"]; path: CentralPath; footprint: [number, number][] | null } | null;

/** Central eclipse band (both edges), its centre line and the umbra at the shooting instant. */
function eclipseGeometry(eclipse: EclipseMap): GeoJSON.FeatureCollection {
  if (!eclipse) return { type: "FeatureCollection", features: [] };
  const features: GeoJSON.Feature[] = [];
  const side = (index: 0 | 1) => eclipse.path.samples.map((sample) => sample.edges[index]).filter((point): point is [number, number] => !!point);
  const ring = unwrap([...side(0), ...side(1).reverse()]);
  if (ring.length >= 4) features.push({ type: "Feature", properties: { kind: "band" }, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } });
  const centre = unwrap(eclipse.path.samples.map((sample) => sample.centre));
  if (centre.length >= 2) features.push({ type: "Feature", properties: { kind: "centre" }, geometry: { type: "LineString", coordinates: centre } });
  if (eclipse.footprint) {
    const outline = unwrap(eclipse.footprint);
    features.push({ type: "Feature", properties: { kind: "umbra" }, geometry: { type: "Polygon", coordinates: [[...outline, outline[0]]] } });
  }
  return { type: "FeatureCollection", features };
}
const bodyNames = { sun: "太阳", moon: "月亮", core: "银心" } as const;
const bodyColors = { sun: "#e0892c", moon: "#5f7fc4", core: "#8b5fc4" } as const;
/** Alignment lines: the Sun and the Moon as their azimuth lines; fixed bodies by kind. */
const alignmentColor = (body: string) => {
  const kind = bodyKind(body as SolveBodyId);
  return kind === "sun" || kind === "moon" || kind === "core" ? bodyColors[kind] : kind === "deepSky" ? "#a0568a" : "#3f7f8f";
};

/** Body azimuth lines from the camera, as long as the view cone at this zoom. */
function lineGeometry(plan: ShootingPlan, lines: BodyLine[], zoom: number): GeoJSON.FeatureCollection {
  const radius = viewRadiusMeters(plan, zoom);
  if (radius < 1 || !isMapPosition(plan)) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: lines.map((line) => {
      const end = destination(plan, line.azimuth, radius * (line.kind === "now" ? 1.4 : 1.15));
      return {
        type: "Feature",
        properties: { body: line.body, kind: line.kind, above: line.above },
        geometry: { type: "LineString", coordinates: [[plan.longitude, plan.latitude], [nearbyLongitude(end.longitude, plan.longitude), end.latitude]] },
      };
    }),
  };
}
/** The text anchor that puts a label outside the end of a line pointing `angle` (degrees clockwise from screen up). */
function outward(angle: number) {
  const anchors = ["bottom", "bottom-left", "left", "top-left", "top", "top-right", "right", "bottom-right"] as const;
  return anchors[Math.round((((angle % 360) + 360) % 360) / 45) % 8];
}
/** Names at the ends of the body lines (rises and sets with their times) and of the shooting direction. */
function labelGeometry(plan: ShootingPlan, lines: BodyLine[], zoom: number, bearing: number): GeoJSON.FeatureCollection {
  const radius = viewRadiusMeters(plan, zoom);
  if (radius < 1 || !isMapPosition(plan)) return { type: "FeatureCollection", features: [] };
  const point = (azimuth: number, distance: number, properties: { text: string; color: string; offset: number }): GeoJSON.Feature => {
    const end = destination(plan, azimuth, distance);
    return {
      type: "Feature",
      properties: { ...properties, anchor: outward(azimuth - bearing) },
      geometry: { type: "Point", coordinates: [nearbyLongitude(end.longitude, plan.longitude), end.latitude] },
    };
  };
  return {
    type: "FeatureCollection",
    features: [
      ...lineLabels(lines, plan.timeZone).map((label) =>
        point(label.azimuth, radius * (label.ring === "now" ? 1.4 : 1.15), { text: label.text, color: label.body ? bodyColors[label.body] : "#2f3b30", offset: 0.4 })),
      // Clear of the direction handle at the end of that line.
      point(plan.azimuth, radius, { text: "拍摄方向", color: "#326d51", offset: 1.4 }),
    ],
  };
}
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
  alignment?: CompositionState;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<MapLibreMap | null>(null);
  const synchronize = useRef<((followPosition?: boolean) => void) | null>(null);
  const [mode, setMode] = useState<MapMode>("browse");
  const layers = plan.layers;
  // Sun, Moon and Milky Way core directions for the shooting instant and their
  // rises and sets in the timeline's span; each follows its layer.
  const lines = useMemo(() => {
    try {
      return bodyLines(plan);
    } catch {
      return [] as BodyLine[];
    }
  }, [plan.latitude, plan.longitude, plan.instant, plan.timeZone, plan.refraction, layers.sun, layers.moon, layers.milkyWay, timelineMode(layers)]);
  // A total or annular eclipse in the timeline's span: its band, and the umbra at the shooting instant.
  const span = timelineWindow(plan.instant, plan.timeZone, timelineMode(layers));
  const central = useMemo(() => {
    if (!layers.sun) return null;
    try {
      const found = centralEclipseInSpan(span);
      return found ? centralPath(found.instant) : null;
    } catch {
      return null;
    }
  }, [span.start, span.end, layers.sun]);
  const eclipse: EclipseMap = useMemo(() => {
    if (!central) return null;
    try {
      return { kind: central.kind, path: central, footprint: umbraFootprint(plan.instant) };
    } catch {
      return { kind: central.kind, path: central, footprint: null };
    }
  }, [central, plan.instant]);
  // The sea cell used for tides; the auroral oval edge and view line for the
  // shooting instant's Kp, and the OVATION nowcast when it applies.
  const tideCell = layers.tides && tides?.phase === "ready" ? tides.series?.cell ?? null : null;
  const auroraKp = layers.aurora && aurora?.phase === "ready"
    ? kpAt(Date.parse(plan.instant), aurora.kp ?? null, aurora.outlook ?? null)?.kp ?? null : null;
  const nowcast = layers.aurora && aurora?.ovation && ovationApplies(aurora.ovation, Date.parse(plan.instant)) ? aurora.ovation : null;
  const environment = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    try {
      if (nowcast)
        for (const cell of ovationCells(nowcast))
          features.push({ type: "Feature", properties: { kind: "aurora-cell", band: cell.band }, geometry: { type: "Polygon", coordinates: [cell.ring] } });
      if (auroraKp !== null)
        for (const line of auroraLines(plan.instant, auroraKp))
          features.push({ type: "Feature", properties: { kind: `aurora-${line.kind}` }, geometry: { type: "LineString", coordinates: line.coordinates } });
    } catch { /* The panel reports aurora failures. */ }
    if (tideCell) features.push({ type: "Feature", properties: { kind: "tide-cell" }, geometry: { type: "Point", coordinates: [tideCell.longitude, tideCell.latitude] } });
    return { type: "FeatureCollection", features };
  }, [tideCell?.latitude, tideCell?.longitude, auroraKp, nowcast, auroraKp === null ? "" : plan.instant]);
  // 推算: ground targets placed by a click, and the results drawn as lines.
  const solve = alignment?.active ? alignment : null;
  const placingTarget = !!solve?.placing;
  const alignmentFeatures = useMemo(
    () => (solve ? compositionGeometry(solve, plan.timeZone) : emptyFeatures),
    [solve, solve?.composition.targets, solve?.run, solve?.current, plan.timeZone],
  );
  const alignmentBody = solve?.run?.basis.bodies[0] ?? solve?.composition.targets.find((target) => target.kind === "sky")?.body ?? "sun";
  const solveRef = useRef({ placing: placingTarget, place: solve?.placeTarget, cancel: () => solve?.setPlacing(null) });
  solveRef.current = { placing: placingTarget, place: solve?.placeTarget, cancel: () => solve?.setPlacing(null) };
  const latest = useRef({ plan, update, mode, lines, eclipse, environment, alignmentFeatures, alignmentBody });
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
    latest.current = { plan, update, mode, lines, eclipse, environment, alignmentFeatures, alignmentBody };
    synchronize.current?.(true);
  }, [plan, update, mode, lines, eclipse, environment, alignmentFeatures, alignmentBody]);
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
    let linesKey = "";
    let labelsKey = "";
    let drawnEclipse: EclipseMap | undefined;
    let drawnEnvironment: GeoJSON.FeatureCollection | undefined;
    let drawnAlignment: GeoJSON.FeatureCollection | undefined;
    let drawnBody = "";
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
      const lineSource = map.getSource(linesSourceId) as GeoJSONSource | undefined;
      const nextLinesKey = `${nextGeometryKey}/${JSON.stringify(latest.current.lines)}`;
      if (lineSource && nextLinesKey !== linesKey) {
        lineSource.setData(lineGeometry(current, latest.current.lines, map.getZoom()));
        linesKey = nextLinesKey;
      }
      // Labels turn with the map so they stay outside the line ends.
      const labelSource = map.getSource(labelSourceId) as GeoJSONSource | undefined;
      const nextLabelsKey = `${nextLinesKey}/${current.timeZone}/${Math.round(map.getBearing() / 15)}`;
      if (labelSource && nextLabelsKey !== labelsKey) {
        labelSource.setData(labelGeometry(current, latest.current.lines, map.getZoom(), map.getBearing()));
        labelsKey = nextLabelsKey;
      }
      const eclipseSource = map.getSource(eclipseSourceId) as GeoJSONSource | undefined;
      if (eclipseSource && latest.current.eclipse !== drawnEclipse) {
        eclipseSource.setData(eclipseGeometry(latest.current.eclipse));
        drawnEclipse = latest.current.eclipse;
      }
      const environmentSource = map.getSource(environmentSourceId) as GeoJSONSource | undefined;
      if (environmentSource && latest.current.environment !== drawnEnvironment) {
        environmentSource.setData(latest.current.environment);
        drawnEnvironment = latest.current.environment;
      }
      const alignmentSource = map.getSource(alignmentSourceId) as GeoJSONSource | undefined;
      if (alignmentSource && latest.current.alignmentFeatures !== drawnAlignment) {
        alignmentSource.setData(latest.current.alignmentFeatures);
        drawnAlignment = latest.current.alignmentFeatures;
      }
      if (alignmentSource && latest.current.alignmentBody !== drawnBody) {
        drawnBody = latest.current.alignmentBody;
        const color = alignmentColor(drawnBody);
        for (const id of ["tamatamatori-alignment-clear", "tamatamatori-alignment-blocked", "tamatamatori-alignment-dot", "tamatamatori-alignment-sector"])
          map.setPaintProperty(id, id.endsWith("dot") ? "circle-color" : id.endsWith("sector") ? "fill-color" : "line-color", color);
      }
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
            // Aurora nowcast, oval edge and view line; the tide cell.
            map.addSource(environmentSourceId, { type: "geojson", data: latest.current.environment });
            drawnEnvironment = latest.current.environment;
            map.addLayer({
              id: "tamatamatori-aurora-cells", type: "fill", source: environmentSourceId,
              filter: ["==", ["get", "kind"], "aurora-cell"],
              paint: { "fill-color": "#2f9e62", "fill-opacity": ["match", ["get", "band"], 3, 0.5, 2, 0.32, 0.16] },
            });
            map.addLayer({
              id: "tamatamatori-aurora-edge", type: "line", source: environmentSourceId,
              filter: ["==", ["get", "kind"], "aurora-edge"],
              paint: { "line-color": "#1f8a52", "line-width": 1.8, "line-opacity": 0.85 },
            });
            map.addLayer({
              id: "tamatamatori-aurora-view", type: "line", source: environmentSourceId,
              filter: ["==", ["get", "kind"], "aurora-view"],
              paint: { "line-color": "#1f8a52", "line-width": 1.4, "line-opacity": 0.75, "line-dasharray": [4, 3] },
            });
            map.addLayer({
              id: "tamatamatori-tide-cell", type: "circle", source: environmentSourceId,
              filter: ["==", ["get", "kind"], "tide-cell"],
              paint: { "circle-radius": 6, "circle-color": "#2f6fae", "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
            });
            // Eclipse band under everything else drawn for the shot.
            map.addSource(eclipseSourceId, { type: "geojson", data: eclipseGeometry(latest.current.eclipse) });
            drawnEclipse = latest.current.eclipse;
            map.addLayer({
              id: "tamatamatori-eclipse-band", type: "fill", source: eclipseSourceId,
              filter: ["==", ["get", "kind"], "band"],
              paint: { "fill-color": "#4a3566", "fill-opacity": 0.16 },
            });
            map.addLayer({
              id: "tamatamatori-eclipse-edge", type: "line", source: eclipseSourceId,
              filter: ["==", ["get", "kind"], "band"],
              paint: { "line-color": "#5b3f80", "line-width": 1.2, "line-opacity": 0.8 },
            });
            map.addLayer({
              id: "tamatamatori-eclipse-centre", type: "line", source: eclipseSourceId,
              filter: ["==", ["get", "kind"], "centre"],
              paint: { "line-color": "#5b3f80", "line-width": 1, "line-opacity": 0.7, "line-dasharray": [3, 3] },
            });
            map.addLayer({
              id: "tamatamatori-eclipse-umbra", type: "fill", source: eclipseSourceId,
              filter: ["==", ["get", "kind"], "umbra"],
              paint: { "fill-color": "#26173a", "fill-opacity": 0.45, "fill-outline-color": "#26173a" },
            });
            // Body azimuth lines under the view cone's direction line.
            map.addSource(linesSourceId, { type: "geojson", data: lineGeometry(latest.current.plan, latest.current.lines, map.getZoom()) });
            const lineColor = ["match", ["get", "body"], "sun", bodyColors.sun, "moon", bodyColors.moon, bodyColors.core] as unknown as string;
            map.addLayer({
              id: "tamatamatori-body-riseset",
              type: "line",
              source: linesSourceId,
              filter: ["!=", ["get", "kind"], "now"],
              paint: { "line-color": lineColor, "line-width": 1.5, "line-opacity": 0.65, "line-dasharray": [4, 2] },
            });
            map.addLayer({
              id: "tamatamatori-body-below",
              type: "line",
              source: linesSourceId,
              filter: ["all", ["==", ["get", "kind"], "now"], ["!", ["get", "above"]]],
              paint: { "line-color": lineColor, "line-width": 2.5, "line-opacity": 0.6, "line-dasharray": [1, 1.5] },
            });
            map.addLayer({
              id: "tamatamatori-body-now",
              type: "line",
              source: linesSourceId,
              filter: ["all", ["==", ["get", "kind"], "now"], ["get", "above"]],
              paint: { "line-color": lineColor, "line-width": 3, "line-opacity": 0.9 },
            });
            // 推算 · 找机位: the stretches of line where the body sits on the target (sight not cut by the terrain).
            map.addSource(alignmentSourceId, { type: "geojson", data: latest.current.alignmentFeatures });
            drawnAlignment = latest.current.alignmentFeatures;
            drawnBody = latest.current.alignmentBody;
            const lineColor_ = alignmentColor(drawnBody);
            map.addLayer({
              id: "tamatamatori-alignment-sector", type: "fill", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "sector"],
              paint: { "fill-color": lineColor_, "fill-opacity": 0.1 },
            });
            // Two ground points: the ground around each camera place where the second point stays within tolerance.
            map.addLayer({
              id: "tamatamatori-alignment-area", type: "fill", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "area"],
              paint: { "fill-color": "#b4372b", "fill-opacity": ["case", ["get", "selected"], 0.3, 0.16], "fill-outline-color": "#b4372b" },
            });
            map.addLayer({
              id: "tamatamatori-alignment-ring", type: "line", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "ring"],
              paint: { "line-color": "#2f3b30", "line-width": 1.2, "line-opacity": 0.6, "line-dasharray": [3, 3] },
            });
            map.addLayer({
              id: "tamatamatori-alignment-segment", type: "line", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "segment"],
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": ["interpolate", ["linear"], ["get", "order"], 0, "#e7b46a", 1, "#7a2e12"],
                "line-width": ["case", ["get", "selected"], 6, 3.5],
                "line-opacity": 0.9,
              },
            });
            map.addLayer({
              id: "tamatamatori-alignment-segment-dot", type: "circle", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "segment-dot"],
              paint: { "circle-radius": ["case", ["get", "selected"], 5, 3.5], "circle-color": ["interpolate", ["linear"], ["get", "order"], 0, "#e7b46a", 1, "#7a2e12"] },
            });
            map.addLayer({
              id: "tamatamatori-alignment-casing", type: "line", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "line"],
              layout: { "line-cap": "round", "line-join": "round" },
              paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 8.5, 6], "line-opacity": 0.8 },
            });
            map.addLayer({
              id: "tamatamatori-alignment-clear", type: "line", source: alignmentSourceId,
              filter: ["all", ["==", ["get", "kind"], "line"], ["==", ["get", "sight"], "clear"]],
              layout: { "line-cap": "round", "line-join": "round" },
              paint: { "line-color": lineColor_, "line-width": ["case", ["get", "selected"], 5.5, 3.5] },
            });
            map.addLayer({
              id: "tamatamatori-alignment-blocked", type: "line", source: alignmentSourceId,
              filter: ["all", ["==", ["get", "kind"], "line"], ["!=", ["get", "sight"], "clear"]],
              // Only "terrain data missing somewhere" is listed besides a clear sight: dotted.
              paint: { "line-color": lineColor_, "line-width": ["case", ["get", "selected"], 4.5, 3], "line-opacity": 0.55, "line-dasharray": [0.6, 1.4] },
            });
            map.addLayer({
              id: "tamatamatori-alignment-dot", type: "circle", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "dot"],
              paint: { "circle-radius": ["case", ["get", "selected"], 5, 3.5], "circle-color": lineColor_, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 },
            });
            map.addLayer({
              id: "tamatamatori-alignment-labels", type: "symbol", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "label"],
              layout: {
                "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11,
                "text-offset": [0, -1.1], "text-allow-overlap": false, "symbol-sort-key": 1,
              },
              paint: { "text-color": "#2f3b30", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
            });
            map.addLayer({
              id: "tamatamatori-alignment-target", type: "circle", source: alignmentSourceId,
              filter: ["==", ["get", "kind"], "target"],
              paint: { "circle-radius": 7, "circle-color": "#b4372b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 },
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
            // What each line from the camera is: on top, ahead of the base map's labels.
            map.addSource(labelSourceId, { type: "geojson", data: labelGeometry(latest.current.plan, latest.current.lines, map.getZoom(), map.getBearing()) });
            map.addLayer({
              id: "tamatamatori-line-labels", type: "symbol", source: labelSourceId,
              layout: {
                "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 12,
                "text-anchor": ["get", "anchor"], "text-radial-offset": ["get", "offset"],
                "text-allow-overlap": true,
              },
              paint: { "text-color": ["get", "color"], "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
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
      {(lines.length > 0 || eclipse || auroraKp !== null || tideCell || alignmentFeatures.features.length > 0) && (
        <div className="map-legend" aria-label="方位线图例">
          {(["sun", "moon", "core"] as const).filter((body) => lines.some((line) => line.body === body)).map((body) => (
            <span key={body}><i style={{ background: bodyColors[body] }} />{bodyNames[body]}</span>
          ))}
          {lines.length > 0 && <span className="map-legend-note" title="粗实线：拍摄时刻方位；点线：拍摄时刻在地平线下；细虚线：时间轴时段内的出没方位。只表示方向，不表示距离与遮挡。">粗线此刻 · 细线出没</span>}
          {eclipse && <span data-eclipse-legend title="中心食带：两侧界线之间可见全食或环食，虚线为中心线，深色为拍摄时刻的本影位置。不含月面边缘地形（界线约有 1—3 km 出入）。">
            <i className="map-legend-band" />{eclipse.kind === "total" ? "全食带" : eclipse.kind === "annular" ? "环食带" : "全环食带"}
          </span>}
          {auroraKp !== null && <span data-aurora-legend title="实线：拍摄时刻 Kp 下极光带的赤道侧边界（Carbary 2005，偏心偶极地磁坐标）；虚线：200 km 高的极光顶部高出地平线 5° 的可见线。绿色块为 OVATION 临近预报的极光概率。均为近似。">
            <i className="map-legend-aurora" />极光带 · 虚线可见
          </span>}
          {tideCell && <span data-tide-legend title="潮位所用的海洋格点（约 8 km）"><i className="map-legend-tide" />潮位格点</span>}
          {alignmentFeatures.features.length > 0 && (alignmentFeatures.features.some((feature) => feature.properties?.kind === "area")
            ? <span data-alignment-legend title="红点为地面目标，虚线圈为机位范围。“机位 N”处两个地面点各在设定的画面位置（与时间无关），淡红色范围内第二个点不超出容差；遮挡只看地形，不含建筑、树木与天气。">
              <i className="map-legend-target" />目标 · 机位与容差内范围
            </span>
            : <span data-alignment-legend title="红点为地面目标，虚线圈为机位范围，淡色扇形为所选日期内机位可能所在的方位。线上每个机位，在标注的时刻看到各目标落在设定的画面位置；颜色由浅到深按日期先后，加粗的是正在试看的一段，另标每 10 分钟。视线被地形挡住的分钟不画；遮挡只看地形，不含建筑、树木与天气。">
              <i className="map-legend-target" />目标 · 线上各点在标注时刻对齐
            </span>
          )}
        </div>
      )}
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
