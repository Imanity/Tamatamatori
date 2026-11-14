import { lazyModule } from "../common/lazy-module";

/** The star catalogues (star-catalogs.ts), read on first use. */
export type StarCatalogs = typeof import("./star-catalogs");
export const starCatalogs = lazyModule<StarCatalogs>(() => import("./star-catalogs"));
