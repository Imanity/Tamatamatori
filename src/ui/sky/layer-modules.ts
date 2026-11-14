// Layer modules read when their layer is first turned on (docs/plan/lazy-loading.md):
// the meteor shower catalogue and model, and the station positions and passes
// with SGP4 (satellite.js).
import { lazyModule } from "../common/lazy-module";

export type MeteorModule = typeof import("../../domain/sky/meteor-showers");
export const meteorModule = lazyModule<MeteorModule>(() => import("../../domain/sky/meteor-showers"));

export type StationModule = typeof import("./station-module");
export const stationModule = lazyModule<StationModule>(() => import("./station-module"));
