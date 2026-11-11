import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import {
  instantFromLocal,
  instantOnDate,
  localClockTime,
  localDateTime,
  shiftDate,
  shiftInstant,
} from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { daylightPhase, solarPosition } from "../domain/solar";
import {
  instantAtWindowMinute,
  lightPeriods,
  neighbourEvent,
  sunElevationAcross,
  timelineEvents,
  timelineMode,
  timelineWindow,
  windowMinute,
} from "../domain/timeline";
import type { LightPeriod, TimelineEvent } from "../domain/timeline";

const periodNames: Record<LightPeriod["kind"], string> = { golden: "黄金时刻", blue: "蓝调时刻" };
const periodShort: Record<LightPeriod["kind"], string> = { golden: "黄金", blue: "蓝调" };
import type { CometCatalog } from "../domain/comet-catalog";
import type { OrbitSnapshot } from "../domain/orbit-data";
import type { WeatherForecast } from "../domain/weather";
import { localTimeZone } from "../domain/zone-lookup";
import { zoneCity, zoneOffset } from "../domain/time-zones";
import { TimeZoneField } from "./TimeZoneField";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const timeSteps = [
  { label: "−1时", minutes: -60, name: "提前 1 小时" },
  { label: "−10分", minutes: -10, name: "提前 10 分钟" },
  { label: "−1分", minutes: -1, name: "提前 1 分钟" },
  { label: "+1分", minutes: 1, name: "推后 1 分钟" },
  { label: "+10分", minutes: 10, name: "推后 10 分钟" },
  { label: "+1时", minutes: 60, name: "推后 1 小时" },
];
const dstMessage = "该钟点因夏令时跳过或重复，已保留原时刻，请选择其他时间。";
// Approximate width of one marker label character and the space kept between labels, px.
const LABEL_CHAR = 9.5;
const LABEL_SPACE = 6;

/** Sun elevation band behind the slider: night, the three twilights, low sun and day. */
function bandColor(elevation: number) {
  if (elevation >= 6) return "#ece7cf";
  if (elevation >= 0) return "#e4c58f";
  if (elevation >= -6) return "#bfa8ac";
  if (elevation >= -12) return "#7f8ca6";
  if (elevation >= -18) return "#55627d";
  return "#36415a";
}

/**
 * Shooting time below the preview: local date, clock and display zone in one
 * row, the 24 h slider (calendar day, or noon to noon while a night-sky layer
 * is on) with the enabled layers' events as ticks, nudges and event steps.
 */
export function Timeline({
  plan,
  update,
  comets = null,
  orbits = null,
  forecast = null,
}: {
  plan: ShootingPlan;
  update: UpdatePlan;
  comets?: CometCatalog | null;
  orbits?: OrbitSnapshot | null;
  /** Weather forecast while the weather effect is on; drawn as hourly cloud cover. */
  forecast?: WeatherForecast | null;
}) {
  const dateId = useId();
  const [date, setDate] = useState(
    localDateTime(plan.instant, plan.timeZone).slice(0, 10),
  );
  const [time, setTime] = useState(localClockTime(plan.instant, plan.timeZone));
  const [error, setError] = useState("");
  useEffect(() => {
    setDate(localDateTime(plan.instant, plan.timeZone).slice(0, 10));
    setTime(localClockTime(plan.instant, plan.timeZone));
    setError("");
  }, [plan.instant, plan.timeZone]);
  const { latitude, longitude, timeZone, refraction, cameraHeight, layers } = plan;

  // "Local time zone": the display zone follows the position. The instant is
  // kept, so the local clock changes; say so once.
  const localZone = useMemo(() => localTimeZone(latitude, longitude), [latitude, longitude]);
  const [zoneNotice, setZoneNotice] = useState("");
  // Track width decides which marker labels fit; dots always remain.
  const markerRow = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(480);
  useEffect(() => {
    const element = markerRow.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setTrackWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const followed = useRef(timeZone);
  useEffect(() => {
    if (!plan.followLocalZone || !localZone || localZone === timeZone) return;
    update({ timeZone: localZone });
    if (followed.current !== localZone)
      setZoneNotice(`时区随机位改为${zoneCity(localZone)}（${zoneOffset(localZone, plan.instant)}），拍摄时刻不变`);
    followed.current = localZone;
  }, [plan.followLocalZone, localZone, timeZone]);
  useEffect(() => {
    if (!zoneNotice) return;
    const timer = setTimeout(() => setZoneNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [zoneNotice]);

  const mode = timelineMode(layers);
  const axis = timelineWindow(plan.instant, timeZone, mode);
  const layerKey = JSON.stringify(layers);
  // Recomputed only when the axis, place, refraction, layers or feeds change.
  const band = useMemo(() => {
    try {
      const samples = sunElevationAcross({ latitude, longitude }, axis, timeZone);
      return `linear-gradient(to right, ${samples
        .map(({ minute, elevation }) => `${bandColor(elevation)} ${((Math.min(minute, 1439) / 1439) * 100).toFixed(2)}%`)
        .join(", ")})`;
    } catch {
      return undefined;
    }
  }, [axis.start, axis.mode, latitude, longitude, timeZone]);
  const { events, missing } = useMemo(() => {
    try {
      return timelineEvents({ latitude, longitude, refraction, cameraHeight, layers }, axis, { comets, orbits });
    } catch {
      return { events: [] as TimelineEvent[], missing: [] as string[] };
    }
  }, [axis.start, axis.mode, latitude, longitude, refraction, cameraHeight, layerKey, comets, orbits]);
  // Golden and blue hour belong to the Sun layer, like its rise and set.
  const periods = useMemo(() => {
    if (!layers.sun) return [] as LightPeriod[];
    try {
      return lightPeriods({ latitude, longitude }, axis);
    } catch {
      return [] as LightPeriod[];
    }
  }, [axis.start, axis.mode, latitude, longitude, layers.sun]);
  const allMissing = layers.sun && !periods.length ? [...missing, "黄金时刻与蓝调时刻"] : missing;
  const clouds = useMemo(() => {
    if (!forecast) return null;
    const start = Date.parse(axis.start), end = Date.parse(axis.end);
    const stops: string[] = [];
    let covered = false;
    for (const hour of forecast.hours) {
      if (hour.time < start - 3_600_000 || hour.time > end) continue;
      const from = Math.max(0, windowMinute(new Date(Math.max(hour.time, start)).toISOString(), axis, timeZone) / 1439);
      const to = Math.min(1, from + 60 / 1439);
      const cover = hour.cloud;
      const color = cover === null ? "transparent" : `rgba(92, 104, 118, ${(0.08 + 0.72 * (cover / 100)).toFixed(3)})`;
      if (cover !== null) covered = true;
      stops.push(`${color} ${(from * 100).toFixed(2)}%`, `${color} ${(to * 100).toFixed(2)}%`);
    }
    return covered ? `linear-gradient(to right, transparent 0%, ${stops.join(", ")}, transparent 100%)` : null;
  }, [forecast, axis.start, axis.mode, timeZone]);

  const elevation = useMemo(() => {
    try {
      return solarPosition({ latitude, longitude, instant: plan.instant }).elevation;
    } catch {
      return null;
    }
  }, [latitude, longitude, plan.instant]);
  const attempt = (next: () => string, message = dstMessage) => {
    try {
      update({ instant: next() });
      setError("");
    } catch (reason) {
      setError(reason instanceof RangeError && /1900/.test(reason.message) ? "请保持在 1900—2100 年内。" : message);
    }
  };
  const clock = (instant: string) => localClockTime(instant, timeZone).slice(0, 5);
  let weekday = "";
  try {
    weekday = weekdays[Temporal.PlainDate.from(date).dayOfWeek - 1];
  } catch {
    weekday = "";
  }
  const describedBy = error ? "time-error" : undefined;
  const minute = windowMinute(plan.instant, axis, timeZone);
  const position = (instant: string) => windowMinute(instant, axis, timeZone) / 1439;
  // Hour ticks; the night axis names the date its midnight starts.
  const nextDate = Temporal.PlainDate.from(axis.date).add({ days: 1 });
  const ticks = mode === "night"
    ? [
        { label: "12:00", minute: 0 },
        { label: "18:00", minute: 360 },
        { label: `${nextDate.month}/${nextDate.day}`, minute: 720, strong: true },
        { label: "06:00", minute: 1080 },
        { label: "11:59", minute: 1439 },
      ]
    : [
        { label: "00:00", minute: 0 },
        { label: "06:00", minute: 360 },
        { label: "12:00", minute: 720 },
        { label: "18:00", minute: 1080 },
        { label: "23:59", minute: 1439 },
      ];
  let last: { x: number; width: number } | null = null;
  const markers = events.map((event) => {
    const at = position(event.instant), x = at * trackWidth, width = [...event.label].length * LABEL_CHAR;
    const labelled = !last || x - last.x >= (last.width + width) / 2 + LABEL_SPACE;
    if (labelled) last = { x, width };
    return { event, at, labelled };
  });
  const previous = neighbourEvent(events, plan.instant, -1), next = neighbourEvent(events, plan.instant, 1);
  const describe = (event: TimelineEvent) => `${event.label} ${clock(event.instant)}`;
  const stepButton = (item: (typeof timeSteps)[number]) => (
    <button
      key={item.label}
      type="button"
      aria-label={item.name}
      title={item.name}
      onClick={() => attempt(() => shiftInstant(plan.instant, timeZone, item.minutes))}
    >
      {item.label}
    </button>
  );
  const localDate = localDateTime(plan.instant, timeZone).slice(5, 10).replace("-", "/");
  return (
    <div className="timeline" role="group" aria-label="拍摄时间" data-mode={mode}>
      <div className="time-row">
        <div className="field date-field">
          <span className="field-label">
            <label htmlFor={dateId}>当地日期</label>
          </span>
          <span className="date-stepper">
            <button type="button" aria-label="前一天" title="前一天" onClick={() => attempt(() => shiftDate(plan.instant, timeZone, -1))}>
              ‹
            </button>
            <input
              id={dateId}
              type="date"
              aria-label="当地日期"
              min="1900-01-01"
              max="2100-12-31"
              value={date}
              aria-invalid={!!error}
              aria-describedby={describedBy}
              onChange={(event) => {
                setDate(event.target.value);
                attempt(
                  () => instantOnDate(plan.instant, timeZone, event.target.value),
                  "请输入 1900—2100 年内的有效日期，夏令时重复或跳过的时刻需改选。",
                );
              }}
            />
            <button type="button" aria-label="后一天" title="后一天" onClick={() => attempt(() => shiftDate(plan.instant, timeZone, 1))}>
              ›
            </button>
          </span>
          <small className="weekday">{weekday}</small>
        </div>
        <label className="field clock-field" htmlFor="shooting-clock">
          <span className="field-label">当地时间</span>
          <input
            id="shooting-clock"
            type="time"
            step="1"
            aria-label="当地时间"
            value={time}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            onChange={(event) => {
              setTime(event.target.value);
              attempt(() => instantFromLocal(`${date}T${event.target.value}`, timeZone));
            }}
          />
        </label>
        <TimeZoneField
          zone={timeZone}
          instant={plan.instant}
          follow={!!plan.followLocalZone}
          localZone={localZone}
          onChange={(zone) => update({ timeZone: zone, followLocalZone: false })}
          onFollow={() => {
            if (!localZone) return;
            followed.current = localZone;
            update({ timeZone: localZone, followLocalZone: true });
          }}
        />
      </div>
      <div className="time-slider-field">
        <div className="time-markers" role="group" aria-label="时间轴事件" ref={markerRow}>
          {markers.map(({ event, at, labelled }) => (
            <button
              key={event.key}
              type="button"
              data-event={event.kind}
              className={`time-marker ${labelled ? "" : "is-dot"} ${event.instant === plan.instant ? "is-current" : ""}`}
              style={{ left: `${at * 100}%` }}
              aria-label={`跳到${describe(event)}`}
              title={`${describe(event)} · ${event.detail}`}
              onClick={() => attempt(() => event.instant)}
            >
              {labelled && <span>{event.label}</span>}
            </button>
          ))}
        </div>
        {periods.length > 0 && (
          <div className="light-periods" role="group" aria-label="黄金时刻与蓝调时刻">
            {periods.map((period) => {
              const from = position(period.from), to = Date.parse(period.to) >= Date.parse(axis.end) ? 1 : position(period.to);
              const range = `${clock(period.from)}–${clock(period.to)}`;
              return (
                <button
                  key={`${period.kind}-${period.from}`}
                  type="button"
                  className={`light-period light-period-${period.kind}`}
                  data-period={period.kind}
                  style={{ left: `${from * 100}%`, width: `${Math.max(0.4, (to - from) * 100)}%` }}
                  aria-label={`跳到${periodNames[period.kind]}开始 ${range}`}
                  title={`${periodNames[period.kind]} ${range}：太阳中心几何高度 ${period.kind === "golden" ? "−4°—6°" : "−6°—−4°"}，不含地形与天气`}
                  onClick={() => attempt(() => period.from)}
                >
                  {(to - from) * trackWidth >= 30 && <span>{periodShort[period.kind]}</span>}
                </button>
              );
            })}
          </div>
        )}
        <span className="time-track">
          <span
            className="time-band"
            aria-hidden="true"
            title="色带为太阳高度：深蓝为夜间，蓝紫为天文、航海与民用暮光，金色为低角度日照"
            style={{ background: band }}
          />
          <input
            className="time-slider"
            type="range"
            aria-label={mode === "night" ? "夜间时间滑杆（中午到次日中午）" : "24 小时时间滑杆"}
            min={0}
            max={1439}
            step={1}
            value={minute}
            aria-valuetext={`${mode === "night" ? `${localDate} ` : ""}${time} ${timeZone}${elevation === null ? "" : ` · ${daylightPhase(elevation)}`}`}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            onChange={(event) =>
              attempt(() => instantAtWindowMinute(axis, Number(event.target.value), timeZone))
            }
          />
        </span>
        {clouds && (
          <span className="cloud-strip" aria-hidden="true" title="逐小时总云量（Open-Meteo 预报），越深云越多" style={{ background: clouds }} />
        )}
        <span className="time-slider-ticks" aria-hidden="true">
          {ticks.map(({ label, minute: at, strong }) => (
            <span key={label} className={strong ? "is-date" : undefined} style={{ left: `${(at / 1439) * 100}%` }}>
              {label}
            </span>
          ))}
        </span>
      </div>
      {allMissing.length > 0 && (
        <p className="time-missing">本时段无：{allMissing.join("、")}</p>
      )}
      <div className="time-actions" role="group" aria-label="调整拍摄时刻">
        <button
          type="button"
          className="time-event-step"
          disabled={!previous}
          aria-label={previous ? `跳到上一事件：${describe(previous)}` : "没有上一事件"}
          title={previous ? `上一事件：${describe(previous)}` : "本时段没有更早的事件"}
          onClick={() => previous && attempt(() => previous.instant)}
        >
          ‹ 上一事件
        </button>
        <div className="time-steps" role="group" aria-label="微调拍摄时刻">
          {timeSteps.slice(0, 3).map(stepButton)}
          <button
            type="button"
            className="time-now"
            title="设为此刻（精确到分钟）"
            onClick={() =>
              attempt(() => Temporal.Now.instant().round({ smallestUnit: "minute", roundingMode: "floor" }).toString())
            }
          >
            现在
          </button>
          {timeSteps.slice(3).map(stepButton)}
        </div>
        <button
          type="button"
          className="time-event-step"
          disabled={!next}
          aria-label={next ? `跳到下一事件：${describe(next)}` : "没有下一事件"}
          title={next ? `下一事件：${describe(next)}` : "本时段没有更晚的事件"}
          onClick={() => next && attempt(() => next.instant)}
        >
          下一事件 ›
        </button>
      </div>
      {zoneNotice && (
        <p className="time-zone-notice" role="status">
          {zoneNotice}
        </p>
      )}
      {error && (
        <p className="field-error" id="time-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
