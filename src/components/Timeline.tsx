import { useEffect, useId, useMemo, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import {
  instantFromLocal,
  instantAtMinute,
  instantOnDate,
  localClockTime,
  localDateTime,
  minuteOfDay,
  shiftDate,
  shiftInstant,
} from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { dayEvents, sunElevationByMinute } from "../domain/day-events";
import { daylightPhase, solarPosition } from "../domain/solar";
import { TimeZoneField } from "./TimeZoneField";

type UpdatePlan = (patch: Partial<ShootingPlan>) => void;

const timeTicks = [
  { label: "00:00", minute: 0 },
  { label: "06:00", minute: 360 },
  { label: "12:00", minute: 720 },
  { label: "18:00", minute: 1080 },
  { label: "23:59", minute: 1439 },
];
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
 * row, the 24 h slider over the day's sun elevation, nudges and day events.
 */
export function Timeline({
  plan,
  update,
}: {
  plan: ShootingPlan;
  update: UpdatePlan;
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
  const day = localDateTime(plan.instant, plan.timeZone).slice(0, 10);
  const { latitude, longitude, timeZone, refraction } = plan;
  // Recomputed only when the local date, place, zone or refraction changes.
  const { events, band } = useMemo(() => {
    try {
      const dayPlan = {
        latitude,
        longitude,
        timeZone,
        refraction,
        instant: Temporal.PlainDate.from(day).toZonedDateTime({ timeZone, plainTime: "12:00" }).toInstant().toString(),
      };
      const samples = sunElevationByMinute(dayPlan);
      const band = `linear-gradient(to right, ${samples
        .map(({ minute, elevation }) => `${bandColor(elevation)} ${((Math.min(minute, 1439) / 1439) * 100).toFixed(2)}%`)
        .join(", ")})`;
      return { events: dayEvents(dayPlan), band };
    } catch {
      return { events: [], band: undefined };
    }
  }, [day, latitude, longitude, timeZone, refraction]);
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
  const clock = (instant: string) => localClockTime(instant, plan.timeZone).slice(0, 5);
  let weekday = "";
  try {
    weekday = weekdays[Temporal.PlainDate.from(date).dayOfWeek - 1];
  } catch {
    weekday = "";
  }
  const describedBy = error ? "time-error" : undefined;
  const step = (item: (typeof timeSteps)[number]) => (
    <button
      key={item.label}
      type="button"
      aria-label={item.name}
      title={item.name}
      onClick={() => attempt(() => shiftInstant(plan.instant, plan.timeZone, item.minutes))}
    >
      {item.label}
    </button>
  );
  return (
    <div className="timeline" role="group" aria-label="拍摄时间">
      <div className="time-row">
        <div className="field date-field">
          <span className="field-label">
            <label htmlFor={dateId}>当地日期</label>
          </span>
          <span className="date-stepper">
            <button type="button" aria-label="前一天" title="前一天" onClick={() => attempt(() => shiftDate(plan.instant, plan.timeZone, -1))}>
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
                  () => instantOnDate(plan.instant, plan.timeZone, event.target.value),
                  "请输入 1900—2100 年内的有效日期，夏令时重复或跳过的时刻需改选。",
                );
              }}
            />
            <button type="button" aria-label="后一天" title="后一天" onClick={() => attempt(() => shiftDate(plan.instant, plan.timeZone, 1))}>
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
              attempt(() => instantFromLocal(`${date}T${event.target.value}`, plan.timeZone));
            }}
          />
        </label>
        <TimeZoneField
          zone={plan.timeZone}
          instant={plan.instant}
          onChange={(timeZone) => update({ timeZone })}
        />
      </div>
      <div className="time-slider-field">
        <span className="time-track">
          <span
            className="time-band"
            aria-hidden="true"
            title="色带为当日太阳高度：深蓝为夜间，蓝紫为天文、航海与民用暮光，金色为低角度日照"
            style={{ background: band }}
          />
          <input
            className="time-slider"
            type="range"
            aria-label="24 小时时间滑杆"
            min={0}
            max={1439}
            step={1}
            value={minuteOfDay(plan.instant, plan.timeZone)}
            aria-valuetext={`${time} ${plan.timeZone}${elevation === null ? "" : ` · ${daylightPhase(elevation)}`}`}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            onChange={(event) =>
              attempt(() => instantAtMinute(plan.instant, plan.timeZone, Number(event.target.value)))
            }
          />
        </span>
        <span className="time-slider-ticks" aria-hidden="true">
          {timeTicks.map(({ label, minute }) => (
            <span key={label} style={{ left: `${(minute / 1439) * 100}%` }}>
              {label}
            </span>
          ))}
        </span>
      </div>
      <div className="time-actions">
        <div className="time-steps" role="group" aria-label="微调拍摄时刻">
          {timeSteps.slice(0, 3).map(step)}
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
          {timeSteps.slice(3).map(step)}
        </div>
        {events.length > 0 && (
          <div
            className="time-events"
            role="group"
            aria-label="跳到当日日月时刻"
            title="晨光、昏影为太阳中心在地平下 18°；日月出没按海平面地平计算，不含地形遮挡。"
          >
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                data-event={event.id}
                className={event.instant === plan.instant ? "is-current" : undefined}
                disabled={!event.instant}
                title={event.instant ? event.definition : `当地日期内没有${event.label}`}
                aria-label={event.instant ? `跳到${event.label} ${clock(event.instant)}` : `当地日期内没有${event.label}`}
                onClick={() => {
                  const instant = event.instant;
                  if (instant) attempt(() => instant);
                }}
              >
                <span>{event.label}</span>
                <strong>{event.instant ? clock(event.instant) : "—"}</strong>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <p className="field-error" id="time-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
