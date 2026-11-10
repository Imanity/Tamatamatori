import { useMemo } from "react";
import { Detail, where } from "./readout";
import { Temporal } from "@js-temporal/polyfill";
import type { ShootingPlan } from "../domain/plan";
import { activeShowers, meteorEstimate, meteorModel, meteorSample } from "../domain/meteor-showers";
import type { ActiveShower } from "../domain/meteor-showers";
import { skyPointView } from "../domain/starfield";
import type { SkyVisibility } from "../domain/starfield";
import { celestialPlanKey, occlusionText, skyLabelKey } from "../domain/visibility";
import type { Occlusion } from "../domain/visibility";
import { apparentElevation } from "../domain/refraction";

type View = ShootingPlan & { azimuth: number; pitch: number };
export interface MeteorPollution {
  /** Light pollution used by the estimate, mcd/m²; 0 for the natural sky. */
  artificialMcd: number;
  note: string;
}

const count = (value: number) => (value >= 10 ? Math.round(value).toString() : value.toFixed(1));
const shortName = (name: string) => name.replace(/流星雨$/, "");
/** Showers contributing at least half a meteor, the rest summed. */
function breakdown(items: { name: string; expected: number }[]) {
  const major = items.filter((item) => item.expected >= 0.5), rest = items.reduce((sum, item) => sum + (item.expected >= 0.5 ? 0 : item.expected), 0);
  return [...major.map((item) => `${shortName(item.name)} ${count(item.expected)}`), ...(rest >= 0.05 ? [`其他 ${count(rest)}`] : [])].join(" · ");
}

const hours = (value: number) => Number(value.toFixed(1));
/** Dark part of the night in the chosen time zone, with the date of each end. */
function darkRange(dark: { from: number; to: number }, timeZone: string) {
  const [from, to] = [dark.from, dark.to].map((ms) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone));
  const clock = (t: Temporal.ZonedDateTime) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  const day = (t: Temporal.ZonedDateTime) => `${t.month}月${t.day}日`;
  const sameDay = Temporal.PlainDate.compare(from.toPlainDate(), to.toPlainDate()) === 0;
  return `${day(from)} ${clock(from)}—${sameDay ? "" : `${day(to)} `}${clock(to)}`;
}

export function useMeteorScene(plan: ShootingPlan, view: View, pollution: MeteorPollution) {
  const on = !!plan.layers.meteors, density = on && !!plan.layers.meteorDensity;
  const actives = useMemo(() => {
    if (!on) return { list: [] as ActiveShower[], error: "" };
    // Strongest first; variable showers (no ZHR) last.
    try { return { list: activeShowers(plan).sort((a, b) => (b.zhr ?? -1) - (a.zhr ?? -1)), error: "" }; }
    catch { return { list: [] as ActiveShower[], error: "流星雨计算失败，请检查机位与拍摄时刻。" }; }
  }, [on, plan.latitude, plan.longitude, plan.instant]);
  const estimate = useMemo(() => {
    if (!density || actives.error) return null;
    try {
      const value = meteorEstimate(view, pollution.artificialMcd);
      return { ...value, thinning: meteorSample(view, pollution.artificialMcd).thinning };
    } catch { return null; }
  }, [density, actives.error, plan.latitude, plan.longitude, plan.instant, view.azimuth, view.pitch,
    plan.focalLength, plan.sensor, plan.aspectRatio, plan.orientation, pollution.artificialMcd]);
  return { on, density, actives: actives.list, error: actives.error, estimate, pollution };
}
type MeteorScene = ReturnType<typeof useMeteorScene>;

function radiantState(plan: ShootingPlan, visibility: SkyVisibility, active: ActiveShower) {
  const planCurrent = visibility.planKey === celestialPlanKey(plan);
  const view = planCurrent && visibility.view ? { ...plan, ...visibility.view } : plan;
  const projected = skyPointView(view, active.point);
  const occlusion: Occlusion = planCurrent && (visibility.message || visibility.occlusionUnavailable) ? "error"
    : planCurrent && visibility.ready ? visibility.states[active.point.id] ?? "waiting" : "waiting";
  const label = visibility.labelKey === skyLabelKey(plan) && !visibility.message ? visibility.labelStates?.[active.point.id] : occlusion;
  return { ...projected, occlusion, label };
}

/** Radiant names; hidden behind terrain like other sky labels. */
export function MeteorLabels({ plan, scene, visibility }: { plan: ShootingPlan; scene: MeteorScene; visibility: SkyVisibility }) {
  if (!scene.on) return null;
  return scene.actives.map((active) => {
    const state = radiantState(plan, visibility, active);
    if (state.state !== "画面内" || state.label !== "clear" || !state.pixel) return null;
    return (
      <span key={active.shower.code} className="sky-label meteor-label" data-meteor-label={active.shower.code}
        style={{ left: `${(state.pixel.x + 1) * 50}%`, top: `calc(${(state.pixel.y + 1) * 50}% - 12px)` }}>
        {shortName(active.shower.name)}<small>辐射点</small>
      </span>
    );
  });
}

export function meteorFact(scene: MeteorScene) {
  if (!scene.density || !scene.estimate) return null;
  return scene.estimate.dark
    ? `流星示意 · 整晚暗夜 ${hours(scene.estimate.darkHours)} 小时 · 画面内约 ${count(scene.estimate.expected)} 颗`
    : "流星示意 · 当晚无暗夜";
}

export function MeteorReadout({ plan, scene, visibility, update }: {
  plan: ShootingPlan; scene: MeteorScene; visibility: SkyVisibility; update: (patch: Partial<ShootingPlan>) => void;
}) {
  const estimate = scene.estimate;
  const estimable = scene.actives.some((active) => active.zhr !== null && active.zhr > 0);
  return (
    <div className="meteor-readout" aria-label="流星雨信息">
      <label className="subsetting-toggle layer-toggle">
        <span>预估密度</span>
        <input type="checkbox" role="switch" aria-label="显示流星雨预估密度" checked={scene.density} disabled={!scene.on}
          onChange={() => update({ layers: { ...plan.layers, meteorDensity: !scene.density } })} />
      </label>
      {scene.density && (
        <div className="meteor-estimate" data-meteor-estimate role="status">
          {!estimable ? <p>拍摄日期没有可估算的流星雨</p>
            : !estimate ? <p>流星密度估算失败</p>
            : !estimate.dark ? <p>拍摄时刻所在的夜晚太阳始终高于 −18°，不计流星</p>
            : <>
              <p><strong>整晚画面内约 {count(estimate.expected)} 颗</strong></p>
              <p data-meteor-night>暗夜 {darkRange(estimate.dark, plan.timeZone)} · {hours(estimate.darkHours)} 小时</p>
              {estimate.byShower.length > 0 && <p>{breakdown(estimate.byShower)}</p>}
              <p className="meteor-basis info-detail">
                亮于约 +{meteorModel.cameraLimit} 等 · 固定机位整晚连拍，按拍摄时刻星空对齐叠加 · 已计月光 · {scene.pollution.note}
                {estimate.thinning < 1 ? ` · 示意轨迹按 ${Math.round(estimate.thinning * 100)}% 抽样` : ""}
              </p>
            </>}
        </div>
      )}
      {!scene.on && <p className="info-empty">流星雨已关闭</p>}
      {scene.error && <p className="celestial-error" role="status">{scene.error}</p>}
      {scene.on && !scene.error && !scene.actives.length && <p className="info-empty">拍摄日期没有工作表中的流星雨处于活动期</p>}
      {scene.actives.map((active) => {
        const state = radiantState(plan, visibility, active);
        const elevation = apparentElevation(active.point.elevation, plan.refraction);
        const days = active.daysFromMaximum;
        return (
          <div key={active.shower.code} className="celestial-row meteor-row" data-meteor-status={active.shower.code}>
            <span className="celestial-name">{shortName(active.shower.name)} <small>{active.shower.code}</small></span>
            <span className="celestial-state">{state.state === "画面内" ? occlusionText(state.occlusion, plan) : state.state}</span>
            <span className="celestial-coordinates">辐射点 {where(active.point.azimuth, elevation)}<Detail>辐射点 {active.point.azimuth.toFixed(1)}° / 视 {elevation.toFixed(1)}°</Detail></span>
            <span>
              {active.zhr === null ? "ZHR 不定，不估算"
                : `ZHR 约 ${count(active.zhr)}${active.shower.zhr !== null && days !== null ? `（峰值 ${active.shower.zhr}，${Math.abs(days) < 0.5 ? "极大前后" : days < 0 ? `极大前 ${Math.round(-days)} 天` : `极大后 ${Math.round(days)} 天`}）` : ""}`}
              <Detail>{" · "}{active.shower.velocity}{" "}km/s</Detail>
            </span>
            <button aria-label={`朝向${active.shower.name}辐射点`} disabled={state.state === "地平线下"}
              onClick={() => update({ azimuth: active.point.azimuth, pitch: elevation })}>朝向</button>
          </div>
        );
      })}
    </div>
  );
}
