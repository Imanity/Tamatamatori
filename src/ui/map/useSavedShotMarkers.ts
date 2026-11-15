import { useEffect, useRef } from "react";
import type { Marker } from "maplibre-gl";
import type { SavedShot } from "../../domain/shots/shot-library";
import { isMapPosition } from "../../domain/core/map";

/** Adds a marker with the given element to the current map. */
export type MarkerFactory = (element: HTMLElement) => Marker;

/**
 * The saved shots of this browser as map markers (docs/plan/review.md §6): a
 * dot and the name, the active shot stressed. A click calls `onOpen` with the
 * shot id; nothing changes until the card's "应用".
 */
export function useSavedShotMarkers(
  factory: MarkerFactory | null,
  shots: readonly SavedShot[],
  activeId: string | null,
  onOpen: (id: string) => void,
) {
  const markers = useRef(new Map<string, Marker>());
  const open = useRef(onOpen);
  open.current = onOpen;
  // A new map (or none) starts without markers.
  useEffect(
    () => () => {
      for (const marker of markers.current.values()) marker.remove();
      markers.current.clear();
    },
    [factory],
  );
  useEffect(() => {
    if (!factory) return;
    const placed = markers.current;
    const shown = new Set<string>();
    for (const entry of shots) {
      const { latitude, longitude } = entry.shot.position;
      if (!isMapPosition({ latitude, longitude })) continue;
      shown.add(entry.id);
      let marker = placed.get(entry.id);
      if (!marker) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "map-shot-marker";
        element.append(document.createElement("i"), document.createElement("span"));
        element.firstElementChild!.setAttribute("aria-hidden", "true");
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          if (element.dataset.shotId) open.current(element.dataset.shotId);
        });
        marker = factory(element);
        placed.set(entry.id, marker);
      }
      const element = marker.getElement();
      const name = entry.shot.name || "未命名机位";
      const active = entry.id === activeId;
      element.dataset.shotId = entry.id;
      element.classList.toggle("is-active", active);
      element.lastElementChild!.textContent = name;
      element.title = `${name}${active ? "（当前机位）" : ""} · 单击查看`;
      element.setAttribute("aria-label", `已保存机位：${name}${active ? "，当前机位" : ""}`);
      marker.setLngLat([longitude, latitude]);
    }
    for (const [id, marker] of placed)
      if (!shown.has(id)) {
        marker.remove();
        placed.delete(id);
      }
  }, [factory, shots, activeId]);
}
