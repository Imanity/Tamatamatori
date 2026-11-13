// Turning and zooming the preview by hand: drag to turn, pinch or the wheel to
// change the focal length, arrow keys to turn (Shift for 5°).
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { dragView, zoomFocalLength } from "../../domain/core/plan";
import type { ShootingPlan } from "../../domain/core/plan";

/** `latestPlan` is the panel's ref to the newest plan; the wheel and pinch update it ahead of React. */
export function usePreviewGestures(
  plan: ShootingPlan,
  update: (patch: Partial<ShootingPlan>) => void,
  latestPlan: { current: ShootingPlan },
  viewfinder: RefObject<HTMLDivElement | null>,
) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const element = viewfinder.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        !Number.isFinite(event.deltaY) ||
        event.deltaY === 0
      )
        return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      const focalLength = zoomFocalLength(
        latestPlan.current.focalLength,
        event.deltaY * scale,
      );
      latestPlan.current = { ...latestPlan.current, focalLength };
      update({ focalLength });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [update]);
  // Touch points on the frame; two of them pinch the focal length.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; focalLength: number } | null>(null);
  const touchSpread = () => {
    const [a, b] = [...touches.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const endPointer = (pointerId: number) => {
    touches.current.delete(pointerId);
    if (pinch.current && touches.current.size < 2) pinch.current = null;
  };
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    plan: ShootingPlan;
  } | null>(null);
  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (event.pointerType === "touch") {
        touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.current.size === 2) {
          // A second finger turns the drag into a pinch for the focal length.
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = null;
          setDragging(false);
          const spread = touchSpread();
          pinch.current =
            spread > 0
              ? { distance: spread, focalLength: latestPlan.current.focalLength }
              : null;
          return;
        }
      }
      if (drag.current || pinch.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width: bounds.width,
        height: bounds.height,
        plan: { ...plan },
      };
      setDragging(true);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (touches.current.has(event.pointerId)) {
        touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const zoom = pinch.current;
        if (zoom && touches.current.size >= 2) {
          const focalLength =
            Math.round(
              Math.max(8, Math.min(1000, (zoom.focalLength * touchSpread()) / zoom.distance)) * 10,
            ) / 10;
          latestPlan.current = { ...latestPlan.current, focalLength };
          update({ focalLength });
          return;
        }
      }
      const start = drag.current;
      if (
        !start ||
        start.pointerId !== event.pointerId ||
        !event.currentTarget.hasPointerCapture(event.pointerId)
      )
        return;
      update(
        dragView(
          start.plan,
          event.clientX - start.x,
          event.clientY - start.y,
          start.width,
          start.height,
        ),
      );
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      endPointer(event.pointerId);
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
      endPointer(event.pointerId);
      drag.current = null;
      setDragging(false);
    },
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
      endPointer(event.pointerId);
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      const step = event.shiftKey ? 5 : 1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        update({
          azimuth:
            (plan.azimuth +
              (event.key === "ArrowRight" ? step : -step) +
              360) %
            360,
        });
      else
        update({
          pitch: Math.max(
            -90,
            Math.min(
              90,
              plan.pitch + (event.key === "ArrowUp" ? step : -step),
            ),
          ),
        });
    },
  };
  return { dragging, handlers };
}
