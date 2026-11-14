// The 推算 module: the solvers, templates, request reading and writing, the map
// geometry and the panel, preview marks and link dialog. It is read when the
// mode is first entered or a #solve= link is opened (docs/plan/lazy-loading.md);
// the state stays in useComposition.ts, which receives this module.
export { classify, DEFAULT_NEAREST, DEFAULT_TOLERANCE, lensOf, newId, nightSearch, TARGET_LIMIT, templates, tryPatch } from "../../domain/solve/composition";
export { runComposition, searchBasis } from "../../domain/solve/composition-run";
export { highestNear, restoredLayers, travel, triedLayers } from "../../domain/solve/position-alignment";
export { compositionOf, parseSolveText2, requestOf, solvePlan2 } from "../../domain/solve/solve";
export { bodyKind } from "../../domain/sky/sky-targets";
export { runRange } from "./solve-runner";
export { compositionGeometry } from "./composition-geometry";
export { CompositionPanel } from "./Composition";
export { CompositionMarks } from "./CompositionMarks";
export { SolveLinkDialog } from "./SolveLink";
