import { useEffect, useId, useMemo, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import {
  aspectRatios,
  cameraHeightSlider,
  instantFromLocal,
  instantAtMinute,
  instantOnDate,
  localClockTime,
  localDateTime,
  minuteOfDay,
  normalizeLongitude,
  sensors,
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

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(String(value));
    setError("");
  }, [value]);
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className={`number-wrap ${error ? "has-error" : ""}`}>
        <input
          id={id}
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const number = Number(text);
            if (
              text.trim() === "" ||
              !Number.isFinite(number) ||
              number < min ||
              number > max
            ) {
              setError(`请输入 ${min} 至 ${max}${unit ? ` ${unit}` : ""}`);
            } else {
              setError("");
              onChange(number);
            }
          }}
        />
        {unit && <span className="input-unit">{unit}</span>}
      </span>
      {error && (
        <span className="field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}

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

function TimeField({
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
  return (
    <>
      <div className="time-row">
        <div className="field date-field">
          <span className="field-label">
            <label htmlFor={dateId}>当地日期</label>
            <small>{weekday}</small>
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
      <div className="time-steps" role="group" aria-label="微调拍摄时刻">
        {timeSteps.slice(0, 3).map((step) => (
          <button
            key={step.label}
            type="button"
            aria-label={step.name}
            title={step.name}
            onClick={() => attempt(() => shiftInstant(plan.instant, plan.timeZone, step.minutes))}
          >
            {step.label}
          </button>
        ))}
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
        {timeSteps.slice(3).map((step) => (
          <button
            key={step.label}
            type="button"
            aria-label={step.name}
            title={step.name}
            onClick={() => attempt(() => shiftInstant(plan.instant, plan.timeZone, step.minutes))}
          >
            {step.label}
          </button>
        ))}
      </div>
      {events.length > 0 && (
        <div className="time-events" role="group" aria-label="跳到当日日月时刻">
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
      {error && (
        <p className="field-error" id="time-error" role="status">
          {error}
        </p>
      )}
      <p className="field-hint">
        晨光、昏影为太阳中心在地平下 18°；日月出没按海平面地平计算，不含地形遮挡。
      </p>
      <div className="field-pair time-options">
        <TimeZoneField
          zone={plan.timeZone}
          instant={plan.instant}
          onChange={(timeZone) => update({ timeZone })}
        />
        <label className="field">
          <span className="field-label">大气折射</span>
          <select
            aria-label="大气折射模型"
            value={plan.refraction}
            onChange={(event) =>
              update({
                refraction: event.target.value as ShootingPlan["refraction"],
              })
            }
          >
            <option value="standard">标准折射 · 海平面近似</option>
            <option value="none">无折射 · 几何位置</option>
          </select>
        </label>
      </div>
    </>
  );
}

export function Parameters({
  plan,
  update,
}: {
  plan: ShootingPlan;
  update: UpdatePlan;
}) {
  return (
    <div className="parameters-scroll">
      <fieldset>
        <legend>
          <span className="section-number">01</span> 拍摄时间
        </legend>
        <TimeField plan={plan} update={update} />
      </fieldset>
      <fieldset>
        <legend>
          <span className="section-number">02</span> 相机与镜头
        </legend>
        <NumberField
          label="焦距"
          value={plan.focalLength}
          min={8}
          max={1000}
          step={0.1}
          unit="mm"
          onChange={(focalLength) => update({ focalLength })}
        />
        <input
          className="focal-slider"
          aria-label="焦距滑块"
          type="range"
          min={8}
          max={1000}
          step={0.1}
          value={plan.focalLength}
          onChange={(event) =>
            update({ focalLength: Number(event.target.value) })
          }
        />
        <div className="focal-presets" aria-label="常用焦距">
          {[8, 24, 35, 50, 85, 200, 600, 1000].map((focalLength) => (
            <button
              key={focalLength}
              className={plan.focalLength === focalLength ? "is-active" : ""}
              aria-pressed={plan.focalLength === focalLength}
              onClick={() => update({ focalLength })}
            >
              {focalLength}
              <span> mm</span>
            </button>
          ))}
        </div>
        <div className="field-pair">
          <label className="field">
            <span className="field-label">传感器</span>
            <select
              aria-label="传感器"
              value={plan.sensor}
              onChange={(event) =>
                update({ sensor: event.target.value as ShootingPlan["sensor"] })
              }
            >
              {Object.entries(sensors).map(([key, sensor]) => (
                <option key={key} value={key}>
                  {sensor.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">画幅比例</span>
            <select
              aria-label="画幅比例"
              value={plan.aspectRatio}
              onChange={(event) =>
                update({
                  aspectRatio: event.target
                    .value as ShootingPlan["aspectRatio"],
                })
              }
            >
              {Object.keys(aspectRatios).map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field-label">画幅方向</span>
          <select
            aria-label="拍摄画幅方向"
            value={plan.orientation}
            onChange={(event) =>
              update({
                orientation: event.target.value as ShootingPlan["orientation"],
              })
            }
          >
            <option value="landscape">横幅</option>
            <option value="portrait">竖幅</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">深空相机响应</span>
          <select
            aria-label="深空相机响应"
            value={plan.cameraResponse}
            onChange={(event) =>
              update({
                cameraResponse: event.target
                  .value as ShootingPlan["cameraResponse"],
              })
            }
          >
            <option value="stock">未改机 · 近似参考</option>
            <option value="ha-modified">天文改机 · Hα 增强示意</option>
          </select>
        </label>
        <p className="field-hint">
          未改机仍保留红色，改机额外增强红光。两模式沿用处理后的源图，非同机型实拍对比。
        </p>
      </fieldset>
      <fieldset>
        <legend>
          <span className="section-number">03</span> 机位与视角
        </legend>
        <div className="field-pair">
          <NumberField
            label="纬度"
            value={plan.latitude}
            min={-90}
            max={90}
            step={0.0001}
            unit="°"
            onChange={(latitude) => update({ latitude })}
          />
          <NumberField
            label="经度"
            value={plan.longitude}
            min={-180}
            max={180}
            step={0.0001}
            unit="°"
            onChange={(longitude) =>
              update({
                longitude:
                  longitude === 180 ? normalizeLongitude(longitude) : longitude,
              })
            }
          />
          <NumberField
            label="方位角"
            value={plan.azimuth}
            min={0}
            max={359.9}
            step={0.1}
            unit="°"
            onChange={(azimuth) => update({ azimuth })}
          />
          <NumberField
            label="俯仰角"
            value={plan.pitch}
            min={-90}
            max={90}
            step={0.1}
            unit="°"
            onChange={(pitch) => update({ pitch })}
          />
        </div>
        <NumberField
          label="相机离地高度"
          value={plan.cameraHeight}
          min={0.1}
          max={100}
          step={0.1}
          unit="m"
          onChange={(cameraHeight) => update({ cameraHeight })}
        />
        <input
          className="height-slider"
          aria-label="相机离地高度滑块"
          type="range"
          min={0}
          max={cameraHeightSlider.max}
          step={1}
          value={cameraHeightSlider.toPosition(plan.cameraHeight)}
          aria-valuetext={`${plan.cameraHeight} m`}
          onChange={(event) =>
            update({ cameraHeight: cameraHeightSlider.fromPosition(Number(event.target.value)) })
          }
          onKeyDown={(event) => {
            const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key] as 1 | -1 | undefined;
            if (!direction) return;
            event.preventDefault();
            update({ cameraHeight: cameraHeightSlider.step(plan.cameraHeight, direction) });
          }}
        />
        <span className="height-ticks" aria-hidden="true">
          {["0.1", "1", "10", "100 m"].map((label, index) => (
            <span key={label} style={{ left: `${(index / 3) * 100}%` }}>
              {label}
            </span>
          ))}
        </span>
        <p className="field-hint">
          方位角以真北为 0°，顺时针递增；俯仰角向上为正。预览相机以 DEM
          高程加离地高度定位。
        </p>
      </fieldset>
    </div>
  );
}
