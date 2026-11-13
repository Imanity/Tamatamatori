import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
export { Map, Marker, NavigationControl, ScaleControl } from "maplibre-gl";
