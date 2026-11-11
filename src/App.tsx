import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { initialPlan } from "./domain/plan";
import type { ShootingPlan } from "./domain/plan";
import { Icon } from "./components/Icon";
import type { IconName } from "./components/Icon";
import { PositionBar } from "./components/PositionBar";
import { CameraBar } from "./components/CameraBar";
import { PreviewPanel } from "./components/ScenePanels";
import { MapPanel } from "./components/MapPanel";
import { useTides } from "./components/TideScene";
import { useAurora } from "./components/AuroraScene";
import { About } from "./components/About";
import type { LayerGroupId } from "./components/layers";
import type { MapViewport } from "./domain/map";
import type { InfoGroupId, InfoNavigation } from "./components/InfoGroup";
import { ShotMenu, ShotToast } from "./components/ShotMenu";
import { browserStorage, readSession, writeSession } from "./domain/shot-library";

type PanelId = "map" | "preview";
type MobileTab = "map" | "camera" | "layers";
const panelInfo: Record<
  PanelId,
  { title: string; icon: IconName; tag: string }
> = {
  map: { title: "地图", icon: "map", tag: "交互底图" },
  preview: { title: "拍摄预览", icon: "camera", tag: "地形模拟" },
};
const mobileTabs: { id: MobileTab; title: string; icon: IconName }[] = [
  { id: "map", title: "地图", icon: "map" },
  { id: "camera", title: "相机", icon: "camera" },
  { id: "layers", title: "图层", icon: "layers" },
];
// The map's share of the workspace width, in percent; the preview gets the rest.
const defaultMapShare = 36;
const mapShareRange = { min: 25, max: 70 };
const detailKey = "tamatamatori.showDetails";
// A viewer preference, not part of a shot: unavailable storage just means off.
function readDetails() {
  try {
    return window.localStorage.getItem(detailKey) === "1";
  } catch {
    return false;
  }
}

// Must match the narrow-layout media queries in styles.css.
const narrowQuery = "(max-width: 1099px)";

/** True on narrow screens, where the lens controls move to their own tab. */
function useNarrowLayout() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(narrowQuery).matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.(narrowQuery);
    if (!query) return;
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

function Divider({
  axis,
  value,
  min,
  max,
  container,
  onChange,
  onResize,
}: {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  container: RefObject<HTMLDivElement | null>;
  onChange: (value: number) => void;
  onResize: (value: boolean) => void;
}) {
  const clamp = (number: number) => Math.max(min, Math.min(max, number));
  return (
    <div
      className={`divider divider-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={axis === "x" ? "调整地图与预览宽度" : "调整面板高度"}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)}%`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        onResize(true);
      }}
      onPointerMove={(event) => {
        if (
          !event.currentTarget.hasPointerCapture(event.pointerId) ||
          !container.current
        )
          return;
        const bounds = container.current.getBoundingClientRect();
        const length = axis === "x" ? bounds.width : bounds.height;
        const offset =
          axis === "x"
            ? event.clientX - bounds.left
            : event.clientY - bounds.top;
        onChange(clamp(((offset - 6) / (length - 12)) * 100));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        onResize(false);
      }}
      onPointerCancel={() => onResize(false)}
      onLostPointerCapture={() => onResize(false)}
      onKeyDown={(event) => {
        const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
        if (![decrease, increase, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        onChange(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : clamp(
                  value +
                    (event.key === increase ? 1 : -1) *
                      (event.shiftKey ? 5 : 1),
                ),
        );
      }}
    >
      <span />
    </div>
  );
}

function Panel({
  id,
  children,
  onSwap,
}: {
  id: PanelId;
  children: ReactNode;
  onSwap: () => void;
}) {
  const info = panelInfo[id];
  return (
    <section className={`panel panel-${id}`} aria-label={info.title}>
      <header className="panel-header">
        <div className="panel-title">
          <Icon name={info.icon} size={17} />
          <h2>{info.title}</h2>
          <span className="panel-tag">{info.tag}</span>
        </div>
        <div className="panel-controls">
          <button
            type="button"
            className="icon-button panel-swap"
            aria-label="对调地图与预览位置"
            title="对调地图与预览位置"
            onClick={onSwap}
          >
            <Icon name="swap" size={16} />
          </button>
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export default function App() {
  // The last working state is restored after a reload (see shot-library).
  const [restored] = useState(() => readSession(browserStorage()));
  const [plan, setPlan] = useState<ShootingPlan>(restored?.plan ?? initialPlan);
  const [activeShotId, setActiveShotId] = useState<string | null>(
    restored?.activeId ?? null,
  );
  // Bumped whenever a whole plan replaces the current one, so the parameter
  // inputs drop any half-typed drafts.
  const [planGeneration, setPlanGeneration] = useState(0);
  const [shotNotice, setShotNotice] = useState<{
    text: string;
    undo: { plan: ShootingPlan; activeId: string | null };
  } | null>(null);
  const [previewFirst, setPreviewFirst] = useState(false);
  const [mapShare, setMapShare] = useState(defaultMapShare);
  const [resizing, setResizing] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("map");
  const [infoCollapsed, setInfoCollapsed] = useState(false);
  // DEM elevation under the camera, reported by the preview for the position bar.
  const [ground, setGround] = useState<number | null>(null);
  const narrow = useNarrowLayout();
  const [showDetails, setShowDetails] = useState(readDetails);
  const toggleDetails = () =>
    setShowDetails((current) => {
      try {
        window.localStorage.setItem(detailKey, current ? "0" : "1");
      } catch {
        // Kept for this page only.
      }
      return !current;
    });
  const [infoHost, setInfoHost] = useState<HTMLDivElement | null>(null);
  const [infoQuery, setInfoQuery] = useState("");
  const [infoNavigation, setInfoNavigation] = useState<InfoNavigation | null>(
    null,
  );
  const navigateInfo = (id: InfoGroupId, open: boolean) =>
    setInfoNavigation((current) => ({
      id,
      open,
      request: (current?.request ?? 0) + 1,
    }));
  const [announcement, setAnnouncement] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mapViewport = useRef<MapViewport>({
    longitude: plan.longitude,
    latitude: plan.latitude,
    zoom: 11,
    bearing: 0,
  });
  const updatePlan = useCallback(
    (patch: Partial<ShootingPlan>) =>
      setPlan((current) => ({ ...current, ...patch })),
    [],
  );
  const session = useRef({ plan, activeShotId });
  session.current = { plan, activeShotId };
  useEffect(() => {
    const timer = setTimeout(
      () => writeSession(browserStorage(), plan, activeShotId),
      300,
    );
    return () => clearTimeout(timer);
  }, [plan, activeShotId]);
  useEffect(() => {
    const flush = () =>
      writeSession(
        browserStorage(),
        session.current.plan,
        session.current.activeShotId,
      );
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  const replacePlan = (next: ShootingPlan, id: string | null) => {
    setPlan(next);
    setActiveShotId(id);
    setPlanGeneration((value) => value + 1);
    setInfoQuery("");
    // Information groups follow the new layer switches.
    setInfoNavigation((current) => ({
      sync: true,
      request: (current?.request ?? 0) + 1,
    }));
  };
  const applyShot = (next: ShootingPlan, id: string | null, name: string) => {
    setShotNotice({
      text: `已应用「${name}」`,
      undo: { plan, activeId: activeShotId },
    });
    replacePlan(next, id);
  };
  // Shared by the panel, the timeline and the map.
  const tides = useTides(plan);
  const aurora = useAurora(plan);
  const toggleLayer = (id: LayerGroupId) => {
    // The information group follows its layer: enabling expands and reveals
    // it in place without moving focus or scrolling (the switch sits in the
    // group's heading),
    // disabling collapses it.
    const enabling = !plan.layers[id];
    if (enabling) {
      setInfoCollapsed(false);
      setInfoQuery("");
    }
    navigateInfo(id, enabling);
    setPlan((current) => ({
      ...current,
      layers: {
        ...current.layers,
        [id]: !current.layers[id],
        ...(id === "stars" && current.layers.stars
          ? { constellations: false }
          : {}),
        // A path belongs to its body, like the constellation figures to the stars.
        ...(id === "sun" && current.layers.sun ? { sunPath: false } : {}),
        ...(id === "moon" && current.layers.moon ? { moonPath: false } : {}),
        ...(id === "meteors" && current.layers.meteors ? { meteorDensity: false } : {}),
      },
    }));
  };
  const swapPanels = () => {
    // Only the CSS order changes, so neither the map nor the preview remounts.
    setPreviewFirst((current) => !current);
    setAnnouncement(
      `${previewFirst ? "地图" : "拍摄预览"}已移至左侧，拍摄参数保持不变。`,
    );
  };
  // The divider measures the first column; the map share is stored either way.
  const firstShare = previewFirst ? 100 - mapShare : mapShare;
  const firstRange = previewFirst
    ? { min: 100 - mapShareRange.max, max: 100 - mapShareRange.min }
    : mapShareRange;
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Tamatamatori 首页">
          <span className="brand-mark">
            <Icon name="camera" size={23} />
          </span>
          <span>
            Tamatamatori<small>光影之间，自有方向</small>
          </span>
        </a>
        <div className="topbar-end">
          <ShotMenu
            plan={plan}
            activeId={activeShotId}
            onActiveChange={setActiveShotId}
            onApply={applyShot}
          />
          <About />
        </div>
      </header>
      {shotNotice && (
        <ShotToast
          text={shotNotice.text}
          onUndo={() => {
            replacePlan(shotNotice.undo.plan, shotNotice.undo.activeId);
            setShotNotice(null);
          }}
          onClose={() => setShotNotice(null)}
        />
      )}
      <main
        className={`app-layout ${resizing ? "is-resizing" : ""}`}
        data-mobile-tab={mobileTab}
      >
        <div
          className="workgrid"
          ref={workspaceRef}
          data-order={previewFirst ? "preview-first" : "map-first"}
          style={
            {
              "--first-track": `${firstShare}fr`,
              "--second-track": `${100 - firstShare}fr`,
            } as CSSProperties
          }
        >
          <Panel id="map" onSwap={swapPanels}>
            <div className="map-stack">
              <MapPanel plan={plan} update={updatePlan} viewport={mapViewport} tides={tides} aurora={aurora} />
              <PositionBar
                key={planGeneration}
                plan={plan}
                update={updatePlan}
                ground={ground}
              />
            </div>
          </Panel>
          <Divider
            axis="x"
            value={firstShare}
            min={firstRange.min}
            max={firstRange.max}
            container={workspaceRef}
            onChange={(value) =>
              setMapShare(previewFirst ? 100 - value : value)
            }
            onResize={setResizing}
          />
          <Panel id="preview" onSwap={swapPanels}>
            <PreviewPanel
              plan={plan}
              update={updatePlan}
              infoHost={infoHost}
              infoQuery={infoQuery}
              infoNavigation={infoNavigation}
              generation={planGeneration}
              onGroundChange={setGround}
              showCameraBar={!narrow}
              onToggleLayer={toggleLayer}
              tides={tides}
              aurora={aurora}
            />
          </Panel>
        </div>
        {narrow && (
          <section className="mobile-camera" aria-label="相机与镜头">
            <CameraBar key={planGeneration} plan={plan} update={updatePlan} />
          </section>
        )}
        <div className="mobile-tabs" role="tablist" aria-label="工作区分区">
          {mobileTabs.map(({ id, title, icon }) => (
            <button
              type="button"
              role="tab"
              key={id}
              aria-selected={mobileTab === id}
              onClick={() => setMobileTab(id)}
            >
              <Icon name={icon} size={15} />
              {title}
            </button>
          ))}
        </div>
        {infoCollapsed && (
          <button
            className="info-reopen icon-button"
            aria-label="展开图层与信息"
            onClick={() => setInfoCollapsed(false)}
          >
            <Icon name="info" size={17} />
          </button>
        )}
        <aside
          className={`info-sidebar ${infoCollapsed ? "is-collapsed" : ""}`}
          aria-label="图层与信息"
          onKeyDown={(event) => {
            if (event.key === "Escape") setInfoCollapsed(true);
          }}
        >
          <div className="info-search" role="search" aria-label="拍摄目标搜索">
            <div className="info-search-tools">
              <label htmlFor="target-search">搜索目标</label>
              <label className="detail-toggle layer-toggle">
                <span>详细数值</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="显示详细数值"
                  checked={showDetails}
                  onChange={toggleDetails}
                />
              </label>
              <button
                className="icon-button info-close-desktop"
                aria-label="收起图层与信息"
                onClick={() => setInfoCollapsed(true)}
              >
                <Icon name="arrow" size={17} />
              </button>
            </div>
            <div>
              <input
                id="target-search"
                type="search"
                aria-label="搜索拍摄目标"
                placeholder="日月、星空、深空或空间站"
                maxLength={80}
                value={infoQuery}
                onChange={(event) => setInfoQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && infoQuery) {
                    event.stopPropagation();
                    setInfoQuery("");
                  }
                }}
              />
              {infoQuery && (
                <button
                  aria-label="清除目标搜索"
                  onClick={() => setInfoQuery("")}
                >
                  清除
                </button>
              )}
            </div>
          </div>
          <div
            className={`info-body ${showDetails ? "show-details" : ""}`}
            ref={setInfoHost}
          />
        </aside>
      </main>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
