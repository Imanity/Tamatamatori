import { useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { bodyRadius } from "../domain/alignment";
import { cameraBasis } from "../domain/celestial-projection";
import type { View } from "../domain/celestial-projection";
import { ndc, spotWords, targetName } from "../domain/composition";
import type { FrameSpot, TargetSpec } from "../domain/composition";
import { frameAspectRatio } from "../domain/plan";
import { bodyKind } from "../domain/sky-targets";
import type { CompositionState } from "./Composition";

/** Frame place (0—1 from the top-left) of a pointer inside the frame. */
function spotAt(element: HTMLElement, event: { clientX: number; clientY: number }): FrameSpot | null {
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
}
const outline = (x: number, y: number, rx: number, ry: number) =>
  `${Array.from({ length: 48 }, (_, index) => {
    const angle = (2 * Math.PI * index) / 48;
    return `${index ? "L" : "M"}${(x + rx * Math.cos(angle)).toFixed(5)},${(y + ry * Math.sin(angle)).toFixed(5)}`;
  }).join(" ")}Z`;

/** A handle that drags a frame place, or nudges it with the arrow keys (1% of the frame, Shift 5%). */
function Handle({ spot, frame, label, title, onMove, onSelect, className = "", vertical = false, children }: {
  spot: FrameSpot;
  frame: RefObject<HTMLDivElement | null>;
  label: string;
  title: string;
  onMove: (spot: FrameSpot) => void;
  onSelect?: () => void;
  className?: string;
  vertical?: boolean;
  children?: React.ReactNode;
}) {
  const drag = useRef<number | null>(null);
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current !== event.pointerId || !frame.current) return;
    const point = spotAt(frame.current, event);
    if (point) onMove(vertical ? { x: spot.x, y: point.y } : point);
  };
  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (!step || (vertical && step[0])) return;
    event.preventDefault();
    event.stopPropagation();
    const size = event.shiftKey ? 0.05 : 0.01;
    onMove({ x: spot.x + step[0] * size, y: spot.y + step[1] * size });
  };
  return (
    <button
      type="button"
      className={`alignment-handle ${className}`}
      style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
      aria-label={label}
      title={title}
      onFocus={onSelect}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        onSelect?.();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = event.pointerId;
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (drag.current !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => (drag.current = null)}
      onLostPointerCapture={() => (drag.current = null)}
      onKeyDown={nudge}
    >
      {children}
    </button>
  );
}

/**
 * The targets' places in the preview frame (构图约束搜索): a body as a dashed
 * circle of its size for the current lens, a ground point as a cross, its
 * foot as a short bar on a dashed line. They show where things should go,
 * whatever the frame shows now; dragging one changes the search conditions.
 */
export function CompositionMarks({ state, view, frame }: { state: CompositionState; view: View; frame: RefObject<HTMLDivElement | null> }) {
  if (!state.active || !state.composition.targets.length) return null;
  const { tx, ty } = cameraBasis(view);
  const aspect = frameAspectRatio(view);
  return (
    <div className="composition-marks" data-composition-marks>
      {state.composition.targets.map((target) => (
        <Mark key={target.id} target={target} state={state} frame={frame} tx={tx} ty={ty} aspect={aspect} />
      ))}
    </div>
  );
}

function Mark({ target, state, frame, tx, ty, aspect }: {
  target: TargetSpec;
  state: CompositionState;
  frame: RefObject<HTMLDivElement | null>;
  tx: number;
  ty: number;
  aspect: number;
}) {
  const at = ndc(target.frame);
  const selected = state.selected === target.id;
  const name = targetName(target);
  const kind = target.kind === "ground" ? "ground" : bodyKind(target.body);
  const size = target.kind === "sky" ? Math.tan((bodyRadius(target.body) * Math.PI) / 180) : 0;
  // The tolerance as a circle: a share of the frame height, the same on screen in both directions.
  const tolerance = 2 * target.tolerance;
  const foot = target.kind === "ground" && target.base !== null ? target.base * 2 - 1 : null;
  return (
    <div className={`alignment-mark composition-mark alignment-mark-${kind} ${selected ? "is-selected" : ""}`}
      data-composition-mark={`${target.id}:${target.frame.x.toFixed(3)},${target.frame.y.toFixed(3)}`}>
      <svg viewBox="-1 -1 2 2" preserveAspectRatio="none" aria-hidden="true">
        {target.kind === "sky" && <path d={outline(at.x, at.y, size / tx, size / ty)} vectorEffect="non-scaling-stroke" />}
        {selected && <path className="composition-tolerance" d={outline(at.x, at.y, tolerance / aspect, tolerance)} vectorEffect="non-scaling-stroke" />}
        {foot !== null && <path className="composition-subject" d={`M${at.x},${at.y} V${foot}`} vectorEffect="non-scaling-stroke" />}
      </svg>
      <Handle spot={target.frame} frame={frame} onSelect={() => state.setSelected(target.id)}
        className={target.kind === "ground" ? "composition-ground-handle" : ""}
        label={`${name}在画面中的位置：${spotWords(target.frame)}。拖动或用方向键微调`}
        title={`拖动或用方向键微调${name}在画面中的位置（Shift 加大步长）`}
        onMove={(spot) => state.moveTarget(target.id, spot)}>
        <span>{name}</span>
      </Handle>
      {target.kind === "ground" && target.base !== null && (
        <Handle spot={{ x: target.frame.x, y: target.base }} frame={frame} vertical onSelect={() => state.setSelected(target.id)}
          className="composition-foot-handle"
          label={`${name}底部在画面中的位置：自上 ${Math.round(target.base * 100)}%。上下拖动或用方向键微调`}
          title="上下拖动底部，决定主体在画面中的大小"
          onMove={(spot) => state.updateTarget(target.id, { base: Math.min(1, Math.max(target.frame.y + 0.02, spot.y)) })}>
          <span>底部</span>
        </Handle>
      )}
    </div>
  );
}
