// Workspace layout pieces: the map and preview panels, the divider between
// them, and the narrow-layout switch.
import { useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Icon } from "../common/Icon";
import type { IconName } from "../common/Icon";

type PanelId = "map" | "preview";
const panelInfo: Record<
  PanelId,
  { title: string; icon: IconName; tag: string }
> = {
  map: { title: "地图", icon: "map", tag: "交互底图" },
  preview: { title: "拍摄预览", icon: "camera", tag: "地形模拟" },
};
// Must match the narrow-layout media queries (max-width: 1099px) in src/styles/.
const narrowQuery = "(max-width: 1099px)";
/** True on narrow screens, where the lens controls move to their own tab. */
export function useNarrowLayout() {
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
export function Divider({
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
export function Panel({
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
