// The 推算 results: rows grouped by day, try-out, sight profile and the place list.
import { useMemo, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { dayLabel, daySpans, groundTarget, groupByDay } from "../../domain/solve/composition";
import type { ResultItem } from "../../domain/solve/composition";
import { skyConditionNames } from "../../domain/solve/alignment";
import type { LoadedSampler } from "../../domain/solve/composition-run";
import { positionProfile } from "../../domain/solve/position-alignment";
import { compassDirection } from "../../domain/core/plan";
import type { ShootingPlan } from "../../domain/core/plan";
import { TERRAIN_ZOOM, tilePixel } from "../../domain/core/terrain";
import { occlusionText } from "../../domain/core/visibility";
import type { Occlusion } from "../../domain/core/visibility";
import { CheckControls, CheckTag, useFeasibility } from "./Feasibility";
import { MINUTE, clock, km, percent, dayWords } from "./composition-format";
import type { CompositionState } from "./useComposition";

/** Wind and terrain notes shared by results: a coarser terrain read for a wide search. */
function CoarseNote({ sampler, latitude }: { sampler: LoadedSampler | null | undefined; latitude: number }) {
  if (!sampler?.zoom || sampler.zoom >= TERRAIN_ZOOM) return null;
  return <p className="alignment-hint">范围较大，地形按约 {Math.round(tilePixel(sampler.zoom, latitude))} m 像元读取。</p>;
}
function ProfileChart({ profile }: { profile: NonNullable<ReturnType<typeof positionProfile>> }) {
  const samples = profile.profile;
  const heights = samples.flatMap((sample) => (sample.ground === null ? [sample.sight] : [sample.sight, sample.ground]));
  const low = Math.min(...heights), high = Math.max(...heights), range = Math.max(1, high - low);
  const x = (distance: number) => 6 + (distance / profile.length) * 248;
  const y = (height: number) => 92 - ((height - low) / range) * 80;
  const ground = samples.filter((sample) => sample.ground !== null);
  const area = `M${x(ground[0]?.distance ?? 0)},96 ${ground.map((sample) => `L${x(sample.distance).toFixed(1)},${y(sample.ground!).toFixed(1)}`).join(" ")} L${x(ground.at(-1)?.distance ?? 0)},96Z`;
  const sight = samples.map((sample, index) => `${index ? "L" : "M"}${x(sample.distance).toFixed(1)},${y(sample.sight).toFixed(1)}`).join(" ");
  const blocked = samples.filter((sample) => sample.ground !== null && sample.ground > sample.sight + 0.5 && sample.distance >= 20 && profile.length - sample.distance >= 50);
  const state = profile.sight === "blocked" ? `在距机位 ${km(profile.blockedAt ?? 0)} km 处被地形挡住` : profile.sight === "clear" ? "未被地形挡住" : "经过缺少地形数据的地方";
  return (
    <figure className="position-profile">
      <svg viewBox="0 0 260 100" role="img" aria-label={`从机位到地面目标的地形剖面，全长 ${km(profile.length)} km：视线${state}`}>
        <path className="profile-ground" d={area} />
        <path className="profile-sight" d={sight} />
        {blocked.map((sample) => <circle key={sample.distance} className="profile-blocked" cx={x(sample.distance)} cy={y(sample.ground!)} r="1.6" />)}
        <circle className="profile-end" cx={x(0)} cy={y(samples[0].sight)} r="2.4" />
        <circle className="profile-end" cx={x(profile.length)} cy={y(samples.at(-1)!.sight)} r="2.4" />
      </svg>
      <figcaption>机位 → 地面目标 · {km(profile.length)} km · 视线{state}（只看地形，不含建筑与树木）</figcaption>
    </figure>
  );
}
/** One result row: when, where and how far from the places; the Moon's state unless it is a target. */
function itemFacts(item: ResultItem, timeZone: string, moonTarget: boolean) {
  const span = item.start === item.end || item.end - item.start < MINUTE ? clock(item.best, timeZone) : `${clock(item.start, timeZone)}–${clock(item.end, timeZone)}`;
  const where = item.bearing !== null && item.near !== null
    ? `目标在${compassDirection(item.bearing)} · 距 ${item.near === item.far ? km(item.near) : `${km(item.near)}—${km(item.far!)}`} km`
    : `机位 ${item.camera.latitude.toFixed(4)}, ${item.camera.longitude.toFixed(4)}`;
  const moon = moonTarget ? `亮面 ${percent(item.moonLit)}` : item.moonElevation < 0 ? "月亮在地平线下" : `月亮高 ${item.moonElevation.toFixed(0)}° · 亮面 ${percent(item.moonLit)}`;
  const top = item.points?.find((point) => point.time === item.best)?.top;
  return {
    span,
    where: `${where}${item.share ? ` · 主体 ${percent(item.share[0])}—${percent(item.share[1])}` : ""}${top && top.offset > 30 ? ` · 对准的山顶离设定点 ${km(top.offset)} km` : ""}`,
    sky: `${skyConditionNames[item.sky]} · ${moon}${item.deviation >= 0.001 ? ` · 偏差 ${(item.deviation * 100).toFixed(1)}%` : ""}${item.clear < 1 ? " · 部分地形数据不全" : ""}`,
  };
}
export function ResultsSection({ state, plan, occlusion, check }: {
  state: CompositionState;
  plan: ShootingPlan;
  occlusion: { state: string; occlusion: Occlusion } | null;
  check: ReturnType<typeof useFeasibility>;
}) {
  const { run, current } = state;
  // Camera places for two ground points are listed on their own, not by day.
  const places = run?.phase === "done" && run.shape === "places";
  const groups = useMemo(() => groupByDay(run?.phase === "done" && run.shape !== "places" ? run.items : []), [run]);
  const single = groups.length === 1;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ground = run?.basis.ground ?? null;
  const currentPoint = current?.points?.find((point) => point.time === Date.parse(plan.instant)) ?? null;
  const profile = useMemo(() => {
    if (!ground || !run?.sampler || !current?.points) return null;
    try {
      return positionProfile({ target: groundTarget(ground), cameraHeight: plan.cameraHeight }, plan, run.sampler);
    } catch {
      return null;
    }
  }, [ground, run?.sampler, current, plan.latitude, plan.longitude, plan.cameraHeight]);
  if (!run) return null;
  const done = run.phase === "done";
  const minutes = new Set(run.items.flatMap((item) => (item.points ? item.points.map((point) => point.time) : [item.best]))).size;
  const hidden = [
    run.blocked > 0 && (run.shape === "places" ? `${run.blocked} 个机位视线被地形挡住` : `另有 ${run.blocked} 分钟视线被地形挡住`),
    run.extraMissed > 0 && `${run.extraMissed} ${run.strategy.kind === "line" ? "分钟" : run.shape === "places" ? "个机位" : "次"}其他目标不在位置`,
    run.filtered > 0 && `${run.filtered} ${run.strategy.kind === "line" ? "分钟" : "次"}不满足筛选`,
    run.missing > 0 && `${run.missing} ${run.strategy.kind === "line" ? "分钟" : "次"}缺少光污染数据`,
    run.merged > 0 && `${run.merged} 段几乎重合的已合并`,
  ].filter(Boolean).join("，");
  const label = run.composition.time.mode === "instant" ? "所选时刻" : dayLabel(run.composition.time.days) === "当天" ? "当天" : `${dayLabel(run.composition.time.days)}内`;
  const slider = current ? (current.points
    ? { values: current.points.map((point) => point.time), index: current.points.findIndex((point) => point.time === Date.parse(plan.instant)) }
    : { values: Array.from({ length: Math.floor((current.end - current.start) / MINUTE) + 1 }, (_, index) => Math.ceil(current.start / MINUTE) * MINUTE + index * MINUTE).filter((time) => time <= current.end), index: -1 }) : null;
  if (slider && !current?.points) slider.index = slider.values.indexOf(Date.parse(plan.instant));
  const moonTarget = run.basis.bodies.includes("moon");
  const facts = (item: ResultItem) => itemFacts(item, run.timeZone, moonTarget);
  const firstYear = groups.length ? Temporal.PlainDate.from(groups[0].day).year : undefined;
  const words = (day: string) => dayWords(day, firstYear);
  return (
    <div className="alignment-section alignment-results" aria-label="推算结果">
      <h3>结果</h3>
      {run.phase === "running" && <p className="alignment-status" role="status">{run.stage}</p>}
      {run.phase === "error" && <p className="alignment-status is-error" role="status">{run.message === "已取消" ? "已取消。" : `搜索失败：${run.message}`}</p>}
      {done && (run.items.length
        ? <p className="alignment-status" role="status">{places ? `${run.items.length} 个机位` : `${label} ${groups.length} 天、${run.items.length} 段，共 ${minutes} 分钟`}{hidden && `；${hidden}`}</p>
        : <p className="alignment-status is-empty" role="status">{run.note || "没有结果。"}{hidden && `（${hidden}）`}</p>)}
      {done && run.items.length > 0 && run.note && <p className="alignment-hint is-warning">{run.note}</p>}
      {done && ground && <CoarseNote sampler={run.sampler} latitude={ground.latitude} />}
      {done && run.items.length > 0 && <CheckControls check={check} />}
      {current?.place && <p className="alignment-current" role="status">
        正在试看机位 {run.items.indexOf(current) + 1}
        {` · 距“${run.strategy.kind === "grounds" ? run.strategy.first.name : ""}” ${km(current.place.first.distance)} km、距“${run.strategy.kind === "grounds" ? run.strategy.second.name : ""}” ${km(current.place.second.distance)} km`}
      </p>}
      {current && !current.place && <>
        <p className="alignment-current" role="status">
          正在试看 {words(current.day)} {clock(Date.parse(plan.instant), plan.timeZone)}
          {currentPoint && ` · 距地面目标 ${km(currentPoint.distance)} km（目标在${compassDirection(currentPoint.azimuth)}）`}
          {occlusion && ` · ${occlusion.state === "画面内" ? occlusionText(occlusion.occlusion, plan) : occlusion.state}`}
        </p>
        {slider && slider.values.length > 1 && <label className="field alignment-scrub">
          <span className="field-label">在这段内移动（{current.points ? "机位与时刻一起" : "时刻"}）</span>
          <input type="range" min={0} max={slider.values.length - 1} step={1} value={Math.max(0, slider.index)} aria-label="在这段内移动"
            aria-valuetext={clock(slider.values[Math.max(0, slider.index)], plan.timeZone)}
            onChange={(event) => state.tryOut(current, slider.values[Number(event.target.value)])} />
        </label>}
        {profile && <ProfileChart profile={profile} />}
      </>}
      {(current || state.canRestore) && <div className="alignment-actions">
        <button type="button" disabled={!state.canRestore} onClick={state.restore}>返回推算前</button>
      </div>}
      {places && run.items.length > 0 && <ol className="position-list composition-places">
        {run.items.map((item, index) => {
          const facts = item.place!;
          const pair = run.strategy.kind === "grounds" ? run.strategy : null;
          const size = facts.reach.longest >= 4_999 ? "容差内范围超过 5 km" : `容差内约 ${Math.round(facts.reach.shortest * 2)}×${Math.round(facts.reach.longest * 2)} m`;
          return (
            <li key={item.key} className={item === current ? "is-current" : undefined} data-candidate={item.key}>
              <span className="alignment-when">
                <strong>机位 {index + 1}</strong>
                <small>{`“${pair?.first.name}”在${compassDirection(facts.first.azimuth)} ${km(facts.first.distance)} km · “${pair?.second.name}”在${compassDirection(facts.second.azimuth)} ${km(facts.second.distance)} km`}</small>
                <small>{`${size}${facts.moved >= 1 ? ` · 正中的视线被地形挡住，已移 ${Math.round(facts.moved)} m` : ""}${item.deviation >= 0.001 ? ` · 偏差 ${(item.deviation * 100).toFixed(1)}%` : ""}${facts.unknown ? " · 部分地形数据不全" : ""}`}</small>
                <CheckTag check={check.result(item.key)} />
              </span>
              <button type="button" aria-label={`试看 机位 ${index + 1}`} aria-pressed={item === current} onClick={() => state.tryOut(item)}>试看</button>
            </li>
          );
        })}
      </ol>}
      {groups.length > 0 && <ol className="composition-days">
        {groups.map((group) => {
          const expanded = single || open.has(group.day);
          const near = group.items.flatMap((item) => (item.near === null ? [] : [item.near])), far = group.items.flatMap((item) => (item.far === null ? [] : [item.far]));
          const skies = [...new Set(group.items.map((item) => skyConditionNames[item.sky]))].join("、");
          const moonDown = group.items.every((item) => item.moonElevation < 0);
          const best = group.items.reduce((pick, item) => (item.deviation < pick.deviation ? item : pick), group.items[0]);
          const isCurrent = group.items.includes(current!);
          return (
            <li key={group.day} className={isCurrent ? "is-current" : undefined} data-day={group.day}>
              <div className="composition-day">
                <button type="button" className="composition-day-name" aria-expanded={expanded} disabled={single}
                  onClick={() => setOpen((set) => { const next = new Set(set); if (next.has(group.day)) next.delete(group.day); else next.add(group.day); return next; })}>
                  <strong>{words(group.day)}{run.night ? "夜" : ""} {daySpans(group.items).map((span) => `${clock(span.start, run.timeZone)}–${clock(span.end, run.timeZone)}`).join("、")}</strong>
                  <small>{group.items.length} 段{near.length ? ` · 距 ${km(Math.min(...near))}—${km(Math.max(...far))} km` : ""} · {skies}{moonTarget ? "" : ` · ${moonDown ? "月亮在地平线下" : "月亮在天上"}`}</small>
                </button>
                <button type="button" aria-label={`试看 ${words(group.day)}`} aria-pressed={isCurrent} onClick={() => state.tryOut(best)}>试看</button>
              </div>
              {expanded && <ol className="position-list">
                {group.items.map((item) => {
                  const line = facts(item);
                  return (
                    <li key={item.key} className={item === current ? "is-current" : undefined} data-candidate={item.key}>
                      <span className="alignment-when">
                        <strong>{line.span}</strong>
                        <small>{line.where}</small>
                        <CheckTag check={check.result(item.key)} />
                      </span>
                      <span className="alignment-facts">{line.sky}</span>
                      <button type="button" aria-label={`试看 ${words(item.day)} ${line.span}`} aria-pressed={item === current} onClick={() => state.tryOut(item)}>试看</button>
                    </li>
                  );
                })}
              </ol>}
            </li>
          );
        })}
      </ol>}
      {done && <p className="alignment-note"
        title={`机位眼睛高度为地面加离地 ${plan.cameraHeight} m，天体按${plan.refraction === "standard" ? "标准折射" : "无折射"}与海平面地平计算${run.worker ? "；在后台线程计算" : ""}。`}>
        遮挡只看地形，不含建筑、树木与天气。
      </p>}
    </div>
  );
}
