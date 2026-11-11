import { useEffect, useRef, useState } from "react";
import { parseCoordinatePair } from "../domain/plan";
import { searchPlaces } from "../preview/geocode";
import type { PlaceResult } from "../preview/geocode";

/** A place shown on the map without changing the shot until "设为机位". */
export interface MapTarget {
  kind: "place" | "device";
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
  bounds?: [number, number, number, number] | null;
  /** Device position accuracy, metres. */
  accuracy?: number;
}

type SearchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; results: PlaceResult[] }
  | { phase: "error"; message: string };

/**
 * Place search over the map. Searches run only on submit (the public service
 * forbids search-as-you-type); "latitude, longitude" is located without a
 * request.
 */
export function MapSearch({ onChoose, onClose }: {
  onChoose: (target: MapTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const submit = () => {
    const text = query.trim();
    if (!text) return;
    const pair = parseCoordinatePair(text);
    if (pair) {
      onChoose({ kind: "place", name: "坐标位置", detail: `${pair.latitude.toFixed(5)}, ${pair.longitude.toFixed(5)}`, ...pair });
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ phase: "loading" });
    searchPlaces(text, controller.signal)
      .then((results) => { if (!controller.signal.aborted) setState({ phase: "ready", results }); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "error", message: reason instanceof Error ? reason.message : "地点搜索失败" });
      });
  };
  return (
    <div
      className="map-search"
      role="search"
      aria-label="地点搜索"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <input
          type="search"
          aria-label="搜索地点"
          placeholder="地名，或“纬度, 经度”"
          maxLength={200}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={!query.trim() || state.phase === "loading"}>搜索</button>
        <button type="button" className="map-search-close" aria-label="关闭地点搜索" onClick={onClose}>×</button>
      </form>
      {state.phase === "loading" && <p className="map-search-status" role="status">正在搜索…</p>}
      {state.phase === "error" && <p className="map-search-status map-search-error" role="status">{state.message}</p>}
      {state.phase === "ready" && !state.results.length && <p className="map-search-status" role="status">没有找到匹配的地点</p>}
      {state.phase === "ready" && state.results.length > 0 && (
        <ul className="map-search-results" aria-label="地点搜索结果">
          {state.results.map((place, index) => (
            <li key={`${place.latitude},${place.longitude},${index}`}>
              <button type="button" onClick={() => onChoose({ kind: "place", ...place })}>
                <strong>{place.name}</strong>
                <small>{place.detail}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="map-search-credit">
        地点数据 ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap 贡献者</a>
        {" "}· Nominatim，按回车或“搜索”才会查询
      </p>
    </div>
  );
}
