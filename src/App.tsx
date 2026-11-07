import { useCallback, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { initialPlan } from "./domain/plan";
import type { ShootingPlan } from "./domain/plan";
import { Icon } from "./components/Icon";
import type { IconName } from "./components/Icon";
import { Parameters } from "./components/Parameters";
import { PreviewPanel } from "./components/ScenePanels";
import { MapPanel } from "./components/MapPanel";
import { About } from "./components/About";
import { EnvironmentSettings } from "./components/EnvironmentSettings";
import type { MapViewport } from "./domain/map";
import type { InfoGroupId, InfoNavigation } from "./components/InfoGroup";

type PanelId = "map" | "preview" | "parameters";
const defaultPanels: PanelId[] = ["map", "preview", "parameters"];
const defaultUpperHeight = 50;
const panelInfo: Record<
  PanelId,
  { title: string; icon: IconName; tag: string }
> = {
  map: { title: "地图", icon: "map", tag: "交互底图" },
  preview: { title: "拍摄预览", icon: "camera", tag: "地形模拟" },
  parameters: { title: "拍摄参数", icon: "settings", tag: "实时联动" },
};
const slotNames = ["主栏", "右上", "右下"];
const skyLayers = [
  { id: "buildings", name: "建筑", icon: "building" },
  { id: "sun", name: "太阳", icon: "sun" },
  { id: "moon", name: "月亮", icon: "moon" },
  { id: "stars", name: "星空", icon: "stars" },
  { id: "milkyWay", name: "银河", icon: "orbit" },
  { id: "deepSky", name: "深空天体", icon: "orbit" },
  { id: "stations", name: "空间站", icon: "satellite" },
] as const;

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
      aria-label={axis === "x" ? "调整主栏宽度" : "调整右侧面板高度"}
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
  slot,
  children,
  active,
  dragging,
  onDrag,
  onMove,
}: {
  id: PanelId;
  slot: number;
  children: ReactNode;
  active: boolean;
  dragging: PanelId | null;
  onDrag: (id: PanelId | null) => void;
  onMove: (from: PanelId, slot: number) => void;
}) {
  const [over, setOver] = useState(false);
  const info = panelInfo[id];
  return (
    <section
      className={`panel panel-${id} ${over && dragging && dragging !== id ? "drop-target" : ""}`}
      aria-label={info.title}
      data-mobile-active={active}
      data-slot={slot}
      onDragOver={(event) => {
        if (dragging && dragging !== id) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (dragging) onMove(dragging, slot);
        onDrag(null);
      }}
    >
      <header className="panel-header">
        <div className="panel-title">
          <Icon name={info.icon} size={17} />
          <h2>{info.title}</h2>
          <span
            className={`panel-tag ${id === "parameters" ? "tag-live" : ""}`}
          >
            {info.tag}
          </span>
        </div>
        <div className="panel-controls">
          <select
            className="slot-select"
            aria-label={`${info.title}面板位置`}
            title="选择面板位置，也可拖动右侧把手"
            value={slot}
            onChange={(event) => onMove(id, Number(event.target.value))}
          >
            {slotNames.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="drag-grip icon-button"
            draggable
            aria-label={`拖动${info.title}面板以交换位置`}
            title="拖到另一个面板以交换位置"
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", id);
              event.dataTransfer.effectAllowed = "move";
              onDrag(id);
            }}
            onDragEnd={() => {
              onDrag(null);
              setOver(false);
            }}
          >
            <Icon name="grip" size={18} />
          </button>
        </div>
      </header>
      <div className="panel-body">{children}</div>
      {over && dragging && dragging !== id && (
        <div className="drop-overlay">
          <Icon name="layers" size={24} />
          <span>松开以交换面板</span>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [plan, setPlan] = useState<ShootingPlan>(initialPlan);
  const [panels, setPanels] = useState(defaultPanels);
  const [mainWidth, setMainWidth] = useState(65);
  const [upperHeight, setUpperHeight] = useState(defaultUpperHeight);
  const [resizing, setResizing] = useState(false);
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [mobilePanel, setMobilePanel] = useState<PanelId>("map");
  const [layersOpen, setLayersOpen] = useState(false);
  const [infoCollapsed, setInfoCollapsed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoHost, setInfoHost] = useState<HTMLDivElement | null>(null);
  const [infoQuery, setInfoQuery] = useState("");
  const [infoNavigation, setInfoNavigation] = useState<InfoNavigation | null>(
    null,
  );
  const openInfo = (id: InfoGroupId) => {
    setInfoCollapsed(false);
    setInfoOpen(true);
    setLayersOpen(false);
    setInfoQuery("");
    setInfoNavigation((current) => ({
      id,
      request: (current?.request ?? 0) + 1,
    }));
  };
  const [announcement, setAnnouncement] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const mapViewport = useRef<MapViewport>({
    longitude: initialPlan.longitude,
    latitude: initialPlan.latitude,
    zoom: 11,
    bearing: 0,
  });
  const updatePlan = useCallback(
    (patch: Partial<ShootingPlan>) =>
      setPlan((current) => ({ ...current, ...patch })),
    [],
  );
  const toggleLayer = (id: keyof ShootingPlan["layers"]) =>
    setPlan((current) => ({
      ...current,
      layers: {
        ...current.layers,
        [id]: !current.layers[id],
        ...(id === "stars" && current.layers.stars
          ? { constellations: false }
          : {}),
      },
    }));
  const movePanel = (id: PanelId, destination: number) => {
    const next = [...panels];
    const source = next.indexOf(id);
    [next[source], next[destination]] = [next[destination], next[source]];
    setPanels(next);
    setAnnouncement(
      `${panelInfo[id].title}已移动至${slotNames[destination]}，拍摄参数保持不变。`,
    );
  };
  const renderPanel = (slot: number) => {
    const id = panels[slot];
    return (
      <Panel
        id={id}
        slot={slot}
        active={id === mobilePanel}
        dragging={dragging}
        onDrag={setDragging}
        onMove={movePanel}
      >
        {id === "map" ? (
          <MapPanel plan={plan} update={updatePlan} viewport={mapViewport} />
        ) : id === "preview" ? (
          <PreviewPanel
            plan={plan}
            update={updatePlan}
            infoHost={infoHost}
            infoQuery={infoQuery}
            infoNavigation={infoNavigation}
          />
        ) : (
          <Parameters plan={plan} update={updatePlan} />
        )}
      </Panel>
    );
  };
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
        <div className="topbar-divider" />
        <span className="topbar-label">摄影规划</span>
        <div className="topbar-end">
          <span className="prototype-badge">
            <span className="status-dot" /> 工作区原型
          </span>
          <span className="version-label">P3 / 天文构图</span>
          <About />
        </div>
      </header>
      <div className="app-layout">
        <aside
          className={`sidebar ${layersOpen ? "is-open" : ""}`}
          aria-label="图层侧栏"
        >
          <div className="sidebar-intro">
            <h2>
              <Icon name="layers" size={17} /> 图层
            </h2>
            <button
              className="icon-button layer-close"
              aria-label="关闭图层"
              onClick={() => setLayersOpen(false)}
            >
              <Icon name="arrow" size={17} />
            </button>
          </div>
          <div className="layer-list">
            {skyLayers.map(({ id, name, icon }) => (
              <div className="layer-item" key={id}>
                <label className="layer-row layer-toggle">
                  <Icon name={icon} size={19} />
                  <span>{name}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`显示${name}`}
                    checked={plan.layers[id]}
                    onChange={() => toggleLayer(id)}
                  />
                </label>
                <button
                  className="icon-button layer-settings"
                  aria-label={`${name}设置与信息`}
                  title={`${name}设置与信息`}
                  onClick={() => openInfo(id)}
                >
                  <Icon name="settings" size={15} />
                </button>
              </div>
            ))}
          </div>
          <EnvironmentSettings plan={plan} update={updatePlan} />
        </aside>
        <main className="main-content">
          <div className="mobile-toolbar">
            <button
              className={`mobile-layer-button ${layersOpen ? "is-active" : ""}`}
              aria-expanded={layersOpen}
              onClick={() => {
                setLayersOpen(!layersOpen);
                setInfoOpen(false);
              }}
            >
              <Icon name="layers" size={16} /> 图层
            </button>
            <div className="mobile-tabs" role="tablist" aria-label="工作区面板">
              {defaultPanels.map((id) => (
                <button
                  role="tab"
                  aria-selected={mobilePanel === id}
                  key={id}
                  onClick={() => {
                    setMobilePanel(id);
                    setLayersOpen(false);
                    setInfoOpen(false);
                  }}
                >
                  {panelInfo[id].title}
                </button>
              ))}
            </div>
            <button
              className="mobile-layer-button"
              aria-expanded={infoOpen}
              onClick={() => {
                setInfoOpen(!infoOpen);
                setLayersOpen(false);
              }}
            >
              <Icon name="info" size={16} />
              拍摄信息
            </button>
          </div>
          <div
            className={`workgrid ${resizing ? "is-resizing" : ""} ${dragging ? "is-dragging" : ""}`}
            ref={workspaceRef}
            style={
              {
                "--main-track": `${mainWidth}fr`,
                "--secondary-track": `${100 - mainWidth}fr`,
                "--upper-track": `${upperHeight}fr`,
                "--lower-track": `${100 - upperHeight}fr`,
              } as CSSProperties
            }
          >
            {renderPanel(0)}
            <Divider
              axis="x"
              value={mainWidth}
              min={40}
              max={78}
              container={workspaceRef}
              onChange={setMainWidth}
              onResize={setResizing}
            />
            <div className="secondary-column" ref={secondaryRef}>
              {renderPanel(1)}
              <Divider
                axis="y"
                value={upperHeight}
                min={30}
                max={70}
                container={secondaryRef}
                onChange={setUpperHeight}
                onResize={setResizing}
              />
              {renderPanel(2)}
            </div>
          </div>
        </main>
        {infoCollapsed && (
          <button
            className="info-reopen icon-button"
            aria-label="展开拍摄信息"
            onClick={() => setInfoCollapsed(false)}
          >
            <Icon name="info" size={17} />
          </button>
        )}
        <aside
          className={`info-sidebar ${infoCollapsed ? "is-collapsed" : ""} ${infoOpen ? "is-open" : ""}`}
          aria-label="拍摄信息"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setInfoOpen(false);
              setInfoCollapsed(true);
            }
          }}
        >
          <div className="info-search" role="search" aria-label="拍摄目标搜索">
            <div className="info-search-tools">
              <label htmlFor="target-search">搜索目标</label>
              <button
                className="icon-button info-close-desktop"
                aria-label="收起拍摄信息"
                onClick={() => setInfoCollapsed(true)}
              >
                <Icon name="arrow" size={17} />
              </button>
              <button
                className="icon-button info-close-mobile"
                aria-label="关闭拍摄信息"
                onClick={() => setInfoOpen(false)}
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
          <div className="info-body" ref={setInfoHost} />
        </aside>
      </div>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
