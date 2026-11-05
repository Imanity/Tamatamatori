import { useEffect, useId, useState } from "react";
import type { CSSProperties } from "react";
import {
  aspectRatios,
  instantFromLocal,
  instantAtMinute,
  localDateTime,
  minuteOfDay,
  normalizeLongitude,
  sensors,
} from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { Icon } from "./Icon";

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

function TimeField({
  plan,
  update,
}: {
  plan: ShootingPlan;
  update: UpdatePlan;
}) {
  const [draft, setDraft] = useState(
    localDateTime(plan.instant, plan.timeZone),
  );
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(localDateTime(plan.instant, plan.timeZone));
    setError("");
  }, [plan.instant, plan.timeZone]);
  return (
    <>
      <label className="field">
        <span className="field-label">当地日期与时间</span>
        <input
          type="datetime-local"
          value={draft}
          min="1900-01-01T00:00"
          max="2100-12-31T23:59"
          aria-invalid={!!error}
          aria-describedby={error ? "time-error" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            try {
              update({
                instant: instantFromLocal(event.target.value, plan.timeZone),
              });
              setError("");
            } catch {
              setError(
                "请输入 1900—2100 年内的有效时间；夏令时重复或跳过的时刻需改选。",
              );
            }
          }}
        />
        {error && (
          <span className="field-error" id="time-error">
            {error}
          </span>
        )}
      </label>
      <label className="field time-slider-field">
        <span className="field-label time-slider-label">
          当日 24 小时{" "}
          <output>
            {localDateTime(plan.instant, plan.timeZone).slice(11)}
          </output>
        </span>
        <input
          className="time-slider"
          type="range"
          aria-label="24 小时时间滑杆"
          min={0}
          max={1439}
          step={1}
          value={minuteOfDay(plan.instant, plan.timeZone)}
          style={
            {
              "--time-progress": `${(minuteOfDay(plan.instant, plan.timeZone) / 1439) * 100}%`,
            } as CSSProperties
          }
          aria-valuetext={`${localDateTime(plan.instant, plan.timeZone).slice(11)} ${plan.timeZone}`}
          aria-invalid={!!error}
          aria-describedby={
            error ? "time-error time-slider-help" : "time-slider-help"
          }
          onChange={(event) => {
            try {
              update({
                instant: instantAtMinute(
                  plan.instant,
                  plan.timeZone,
                  Number(event.target.value),
                ),
              });
              setError("");
            } catch {
              setError(
                "该钟点因夏令时跳过或重复，已保留原时刻，请选择其他时间。",
              );
            }
          }}
        />
        <span className="time-slider-ticks" aria-hidden="true">
          {timeTicks.map(({ label, minute }) => (
            <span key={label} style={{ left: `${(minute / 1439) * 100}%` }}>
              {label}
            </span>
          ))}
        </span>
      </label>
      <p className="field-hint" id="time-slider-help">
        按当前日期与时区，以一分钟为步长调整钟点。
      </p>
      <label className="field">
        <span className="field-label">显示时区</span>
        <select
          value={plan.timeZone}
          onChange={(event) => update({ timeZone: event.target.value })}
        >
          <option value="Asia/Tokyo">东京 · Asia/Tokyo</option>
          <option value="Asia/Shanghai">上海 · Asia/Shanghai</option>
          <option value="UTC">UTC · 协调世界时</option>
          <option value="America/New_York">纽约 · America/New_York</option>
          <option value="Europe/London">伦敦 · Europe/London</option>
        </select>
      </label>
      <p className="field-hint">
        切换时区保留同一时刻；改变机位不会改变拍摄时间。
      </p>
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
        <p className="field-hint">
          标准折射使用固定参考大气，不含实测气象；近地平线结果仅供构图参考。
        </p>
      </fieldset>
      <fieldset>
        <legend>
          <span className="section-number">02</span> 相机与镜头
        </legend>
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
            <option value="stock">未改机 · 普通相机</option>
            <option value="ha-modified">天文改机 · Hα 增强</option>
          </select>
        </label>
        <p className="field-hint">
          改机模式增强星云 Hα 红光分量，用于构图外观对比。
        </p>
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
        <p className="field-hint">
          方位角以真北为 0°，顺时针递增；俯仰角向上为正。预览相机以 DEM
          高程加离地高度定位。
        </p>
      </fieldset>
      <div className="parameter-note">
        <Icon name="info" size={16} />
        <span>
          天空与地表明暗随时间变化，仅为晴空近似，不含天气与曝光。水面高程按 DEM
          近似。
        </span>
      </div>
    </div>
  );
}
