import { useMemo } from "react";
import type { ShootingPlan } from "../domain/plan";
import { localClockTime, localDateTime } from "../domain/plan";
import { timelineMode, timelineWindow } from "../domain/timeline";
import {
  centralEclipseInSpan, centralPath, compassName, eclipsesInSpan, lunarKindNames, nextCentralEclipse,
  nextLunarEclipse, nextSolarEclipse, pathRelation, solarKindNames,
} from "../domain/eclipses";
import type { Contact, LocalEclipse, LocalLunarEclipse, LocalSolarEclipse } from "../domain/eclipses";
import { Detail } from "./readout";
import type { SkyBody } from "../domain/ephemeris";

type SkyMoon = Extract<SkyBody, { id: "moon" }>;

/**
 * Eclipses for the timeline's span, or the next visible ones after it. Keyed
 * on the span rather than the instant, so dragging the time within a day does
 * not search again.
 */
export function useEclipses(plan: ShootingPlan) {
  const span = timelineWindow(plan.instant, plan.timeZone, timelineMode(plan.layers));
  const { sun, moon } = plan.layers;
  return useMemo(() => {
    if (!sun && !moon) return null;
    try {
      const place = { latitude: plan.latitude, longitude: plan.longitude, refraction: plan.refraction };
      const found = eclipsesInSpan(place, span, { sun, moon });
      const solar = (found.find((entry) => entry.body === "sun") ?? null) as LocalSolarEclipse | null;
      const lunar = (found.find((entry) => entry.body === "moon") ?? null) as LocalLunarEclipse | null;
      const central = sun ? centralEclipseInSpan(span) : null;
      const path = central ? centralPath(central.instant) : null;
      return {
        solar, lunar, central,
        relation: path ? pathRelation(place, path, solar) : null,
        nextSolar: sun && !solar ? nextSolarEclipse(place, span.end) : null,
        nextLunar: moon && !lunar ? nextLunarEclipse(place, span.end) : null,
        nextCentral: sun && !central ? nextCentralEclipse(span.end) : null,
        error: "",
      };
    } catch {
      return { error: "食况计算失败，请检查机位与拍摄时刻。" } as const;
    }
  }, [plan.latitude, plan.longitude, plan.refraction, span.start, span.end, sun, moon]);
}
export type EclipseInfo = ReturnType<typeof useEclipses>;

const percent = (value: number) => `${Math.round(value * 100)}%`;
const time = (contact: Contact, zone: string) => localClockTime(contact.instant, zone).slice(0, 5);
const day = (instant: string, zone: string) => localDateTime(instant, zone).slice(0, 10);

/** Rising or setting during the eclipse, from the contacts' horizon state. */
function horizonNote(eclipse: LocalEclipse) {
  const body = eclipse.body === "sun" ? "日" : "月";
  const relevant = eclipse.contacts.filter((entry) => eclipse.body === "sun" || eclipse.kind === "penumbral" || (entry.id !== "P1" && entry.id !== "P4"));
  const first = relevant[0], last = relevant.at(-1)!;
  if (!first.above && last.above) return `带食${body}出`;
  if (first.above && !last.above) return `带食${body}落`;
  if (!eclipse.peak.above) return `食甚时${eclipse.body === "sun" ? "太阳" : "月亮"}在地平线下`;
  return "全程可见";
}

function Contacts({ eclipse, zone }: { eclipse: LocalEclipse; zone: string }) {
  const shown = eclipse.contacts.filter((entry) => eclipse.body === "sun" || eclipse.kind === "penumbral" || (entry.id !== "P1" && entry.id !== "P4"));
  return <p className="eclipse-times">
    {shown.map((entry) => <span key={entry.id} className={entry.above ? "" : "is-below"} title={entry.above ? undefined : "地平线下，不可见"}>
      {entry.label} {time(entry, zone)}
    </span>)}
    <Detail>{eclipse.contacts.map((entry) => `${entry.label} ${localClockTime(entry.instant, zone)}（${entry.elevation.toFixed(1)}°）`).join(" · ")}</Detail>
  </p>;
}

export function SolarEclipseReadout({ info, plan, update, obscuration }: {
  info: EclipseInfo; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void; obscuration: number;
}) {
  if (!info || !plan.layers.sun) return null;
  if (info.error) return <p className="eclipse-readout celestial-error" role="status">{info.error}</p>;
  const zone = plan.timeZone, solar = info.solar;
  return <div className="eclipse-readout" data-eclipse="sun" aria-label="日食">
    {obscuration > 0 && <p className="eclipse-now">
      {obscuration >= 1 ? "日全食中 · 日面完全被月亮遮住" : `食中 · 日面遮挡 ${percent(obscuration)}`}
    </p>}
    {solar ? <>
      <p className="eclipse-summary">
        <strong>本时段{solarKindNames[solar.kind]}</strong> · {horizonNote(solar)}
        <span>食分 {solar.magnitude.toFixed(2)}，遮挡 {percent(solar.obscuration)}</span>
        <button type="button" aria-label="跳到日食食甚" onClick={() => update({ instant: solar.peak.instant })}>跳到食甚</button>
      </p>
      <Contacts eclipse={solar} zone={zone} />
    </> : info.nextSolar ? <p className="eclipse-next">
      下次本地可见：{day(info.nextSolar.peak.instant, zone)} {solarKindNames[info.nextSolar.kind]}，遮挡 {percent(info.nextSolar.obscuration)}
      <button type="button" aria-label="跳到下次日食食甚" onClick={() => update({ instant: info.nextSolar!.peak.instant })}>跳到食甚</button>
    </p> : <p className="eclipse-next">2100 年前本地没有可见日食</p>}
    {info.central && info.relation && <p className="eclipse-path" data-eclipse-path>
      {info.relation.inside
        ? `机位在${info.central.kind === "total" ? "全食" : "环食"}带内`
        : `离${info.central.kind === "total" ? "全食" : "环食"}带约 ${Math.round(info.relation.distance)} km（${compassName(info.relation.bearing)}）`}
      <span>食带见地图</span>
    </p>}
    {!info.central && info.nextCentral && <p className="eclipse-next">
      下次{info.nextCentral.kind === "total" ? "日全食" : "日环食"}（全球）：{day(info.nextCentral.instant, zone)}
      <button type="button" aria-label="跳到下次全食或环食" onClick={() => update({ instant: info.nextCentral!.instant })}>跳到</button>
      <Detail>食甚点 {info.nextCentral.latitude.toFixed(1)}°, {info.nextCentral.longitude.toFixed(1)}°</Detail>
    </p>}
    {(solar || obscuration > 0) && <p className="eclipse-safety">直视或拍摄日面须使用合格的减光滤镜，全食阶段除外。</p>}
  </div>;
}

export function LunarEclipseReadout({ info, plan, update, brightness, umbral }: {
  info: EclipseInfo; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void; brightness: number; umbral: boolean;
}) {
  if (!info || !plan.layers.moon) return null;
  if (info.error) return <p className="eclipse-readout celestial-error" role="status">{info.error}</p>;
  const zone = plan.timeZone, lunar = info.lunar;
  return <div className="eclipse-readout" data-eclipse="moon" aria-label="月食">
    {brightness < 1 && <p className="eclipse-now">
      {umbral ? brightness <= 0.002 ? "月全食中 · 月面在本影内" : "月偏食中 · 部分月面在本影内" : "半影食中 · 月面略暗"}
    </p>}
    {lunar ? <>
      <p className="eclipse-summary">
        <strong>本时段{lunarKindNames[lunar.kind]}</strong> · {horizonNote(lunar)}
        {lunar.kind !== "penumbral" ? <span>本影食分 {lunar.magnitude.toFixed(2)}</span> : <span>亮度变化轻微</span>}
        <button type="button" aria-label="跳到月食食甚" onClick={() => update({ instant: lunar.peak.instant })}>跳到食甚</button>
      </p>
      <Contacts eclipse={lunar} zone={zone} />
    </> : info.nextLunar ? <p className="eclipse-next">
      下次可见月食：{day(info.nextLunar.peak.instant, zone)} {lunarKindNames[info.nextLunar.kind]}
      <button type="button" aria-label="跳到下次月食食甚" onClick={() => update({ instant: info.nextLunar!.peak.instant })}>跳到食甚</button>
    </p> : <p className="eclipse-next">2100 年前本地没有可见的月偏食或月全食</p>}
  </div>;
}

/** Whether part of the Moon's disc is inside Earth's umbra now. */
export function moonInUmbra(moon: SkyMoon) {
  if (!moon.shadow) return false;
  const cosine = moon.direction.reduce((sum, value, index) => sum + value * moon.shadow!.direction[index], 0);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI < moon.shadow.umbra + moon.angularRadius;
}

/** One line for the preview facts: the eclipse at the shooting instant. */
export function eclipseFact(obscuration: number, brightness: number, umbral: boolean) {
  if (obscuration >= 1) return "日全食 · 天空按暮光近似";
  if (obscuration > 0) return `日食 · 遮挡 ${percent(obscuration)}`;
  if (brightness < 1) return umbral ? "月食 · 地影色为示意" : "半影月食";
  return "";
}
