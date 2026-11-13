// The 推算 panel in the right rail. Its state is useComposition.ts; the
// sections are CompositionEditors.tsx and CompositionResults.tsx.
import { templates } from "../../domain/solve/composition";
import type { ShootingPlan } from "../../domain/core/plan";
import type { Occlusion } from "../../domain/core/visibility";
import { useFeasibility } from "./Feasibility";
import { SolveExport } from "./SolveLink";
import type { ShotSaving } from "./SolveLink";
import type { CompositionState } from "./useComposition";
import { ResultsSection } from "./CompositionResults";
import { TargetsSection, RangeSection, FiltersSection } from "./CompositionEditors";

/** Right-rail 推算 panel: templates, targets, search range, filters, search and results. */
export function CompositionPanel({ state, plan, occlusion, saving }: {
  state: CompositionState;
  plan: ShootingPlan;
  saving?: ShotSaving;
  occlusion: { state: string; occlusion: Occlusion } | null;
}) {
  const check = useFeasibility(state.checkTargets, plan.cameraHeight);
  const { solvability } = state;
  return (
    <section className="alignment-panel composition-panel" aria-label="推算">
      <header className="alignment-header">
        <div className="composition-templates" role="group" aria-label="模板">
          <span>模板：</span>
          {templates.map((template) => <button key={template.id} type="button" title={template.hint} onClick={() => state.applyTemplate(template.id)}>{template.name}</button>)}
        </div>
      </header>
      <TargetsSection state={state} />
      <RangeSection state={state} plan={plan} />
      <FiltersSection state={state} />
      <div className="alignment-section composition-search">
        <p className={`composition-solvability ${solvability.strategy ? "" : "is-warning"}`} role="status">{solvability.message}</p>
        <div className="alignment-actions">
          <button type="button" className="composition-search-button" disabled={!solvability.strategy || state.running} onClick={state.search}>{state.run?.phase === "done" && !state.stale ? "重新搜索" : "搜索"}</button>
          {state.running && <button type="button" onClick={state.cancel}>取消</button>}
        </div>
        {state.stale && state.run?.phase === "done" && <p className="alignment-hint is-warning" role="status">条件已改，请重新搜索。</p>}
      </div>
      <ResultsSection state={state} plan={plan} occlusion={occlusion} check={check} />
      <SolveExport state={state} plan={plan} saving={saving} />
    </section>
  );
}
