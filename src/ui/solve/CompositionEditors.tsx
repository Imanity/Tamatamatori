// The 推算 conditions: targets (ground points and bodies with their place in
// the frame), search range and filters.
import { useState } from "react";
import { darkSkyChoices, dayChoices, dayLabel, canSkyline, DEFAULT_NEAREST, distanceChoices, filterNames, heightWords, MAX_LINE_DAYS, nearChoices, nearestChoices, nearestLabel, spotWords, TARGET_LIMIT, targetName, toleranceChoices } from "../../domain/solve/composition";
import type { CameraRange, FilterSpec, FrameSpot, GroundSpec, SkySpec } from "../../domain/solve/composition";
import { skyConditionNames, skyConditions } from "../../domain/solve/alignment";
import type { AlignmentBody, SkyCondition } from "../../domain/solve/alignment";
import { SKYLINE_DROP, SKYLINE_RADIUS } from "../../domain/solve/position-alignment";
import { bodyKind, bodyName, fixedBodies, isFixedBody, sizeWord } from "../../domain/sky/sky-targets";
import { localDateTime } from "../../domain/core/plan";
import type { ShootingPlan } from "../../domain/core/plan";
import { landmarks } from "../../domain/buildings/landmarks";
import { NumberField } from "../common/NumberField";
import { percent } from "./composition-format";
import type { CompositionState } from "./useComposition";

/** 太阳 / 月亮 / 银心, or a named star or deep-sky target from the list. */
function BodyPicker({ body, onChange, name }: { body: AlignmentBody; onChange: (body: AlignmentBody) => void; name: string }) {
  const choice = body === "sun" || body === "moon" || body === "galactic-center" ? body : "fixed";
  const stars = fixedBodies.filter((item) => item.kind === "star"), deepSky = fixedBodies.filter((item) => item.kind === "deepSky");
  return (
    <div className="composition-body">
      <div className="alignment-bodies" role="radiogroup" aria-label="天体">
        {([["sun", "太阳"], ["moon", "月亮"], ["galactic-center", "银心"], ["fixed", "恒星与深空"]] as const).map(([value, label]) => (
          <label key={value}>
            <input type="radio" name={name} value={value} checked={choice === value} onChange={() => onChange(value === "fixed" ? deepSky.find((item) => item.id === "dso-ngc0224")?.id ?? stars[0].id : value)} />
            {label}
          </label>
        ))}
      </div>
      {choice === "fixed" && <label className="field">
        <span className="field-label">恒星或深空目标</span>
        <select aria-label="恒星或深空目标" value={body} onChange={(event) => onChange(event.target.value as AlignmentBody)}>
          <optgroup label="深空目标">{deepSky.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
          <optgroup label="亮星">{stars.map((item) => <option key={item.id} value={item.id}>{item.name}{item.magnitude !== null ? ` · ${item.magnitude.toFixed(1)} 等` : ""}</option>)}</optgroup>
        </select>
      </label>}
      {isFixedBody(body) && <p className="alignment-hint" title={`${bodyName(body)}方向相对恒星固定，标记按${sizeWord(body)}画出。`}>只在太阳低于 −6° 时搜索。</p>}
    </div>
  );
}
/** Frame place as two numbers (percent from the left and the top), for exact values; dragging is the usual way. */
function SpotFields({ spot, onChange, label }: { spot: FrameSpot; onChange: (spot: FrameSpot) => void; label: string }) {
  return (
    <div className="alignment-fields" role="group" aria-label={`${label}在画面中的位置`}>
      <NumberField label="自左" unit="%" min={0} max={100} step={1} value={Math.round(spot.x * 1000) / 10} onChange={(x) => onChange({ ...spot, x: x / 100 })} />
      <NumberField label="自上" unit="%" min={0} max={100} step={1} value={Math.round(spot.y * 1000) / 10} onChange={(y) => onChange({ ...spot, y: y / 100 })} />
    </div>
  );
}
function ToleranceField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const choices = (toleranceChoices as readonly number[]).includes(value) ? toleranceChoices : [...toleranceChoices, value].sort((a, b) => a - b);
  return (
    <label className="field">
      <span className="field-label">容差（画面高度）</span>
      <select aria-label="容差" value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {choices.map((choice) => <option key={choice} value={choice}>±{Number((choice * 100).toFixed(1))}%</option>)}
      </select>
    </label>
  );
}
function GroundEditor({ state, target }: { state: CompositionState; target: GroundSpec }) {
  const sized = target.reference === "ground" && target.height >= 10;
  return (
    <div className="composition-editor">
      <div className="alignment-actions">
        <button type="button" aria-pressed={state.placing === target.id} className={state.placing === target.id ? "is-active" : ""}
          onClick={() => state.setPlacing(state.placing === target.id ? null : target.id)}>{state.placing === target.id ? "取消点选" : "在地图上重新点选"}</button>
        <select aria-label="改用已接入地标" value={target.landmark ?? ""} onChange={(event) => {
          const landmark = landmarks.find((entry) => entry.id === event.target.value);
          if (landmark) state.setGroundPlace({ latitude: landmark.latitude, longitude: landmark.longitude, name: landmark.name, landmark: landmark.id, height: landmark.bounds.height }, target.id);
        }}>
          <option value="">或改用已接入地标…</option>
          {landmarks.map((landmark) => <option key={landmark.id} value={landmark.id}>{landmark.name}</option>)}
        </select>
      </div>
      <p className="alignment-hint">{target.latitude.toFixed(5)}, {target.longitude.toFixed(5)}</p>
      <fieldset className="alignment-aim">
        <legend>高度</legend>
        <label>
          <input type="radio" name={`reference-${target.id}`} checked={target.reference === "ground"} onChange={() => state.updateTarget(target.id, { reference: "ground", height: 0 })} />
          距地表（山顶填 0，塔顶、楼顶填其高度）
        </label>
        <label>
          <input type="radio" name={`reference-${target.id}`} checked={target.reference === "sea"} onChange={() => state.updateTarget(target.id, { reference: "sea", height: 3776, base: null })} />
          海拔
        </label>
        <NumberField label={target.reference === "sea" ? "海拔" : "距地表"} unit="m" min={target.reference === "sea" ? -500 : 0} max={target.reference === "sea" ? 9000 : 1000} step={1} value={target.height}
          onChange={(height) => state.updateTarget(target.id, { height, ...(target.reference === "ground" && height < 10 ? { base: null } : {}) })} />
      </fieldset>
      {target.reference === "sea" && <p className="alignment-hint" title="与应用的地形高程用同一套数值">海拔基准未核定。</p>}
      <label className="composition-check">
        <input type="checkbox" disabled={!sized} checked={target.base !== null}
          onChange={(event) => state.updateTarget(target.id, { base: event.target.checked ? Math.min(0.97, target.frame.y + 0.3) : null })} />
        设定底部在画面中的位置（定主体大小）
      </label>
      {!sized && <p className="alignment-hint">只用于距地表 10 m 以上的点。</p>}
      {canSkyline(target) && <label className="composition-check"
        title={`照片里的“山顶”随机位方向而变（从东北看富士山，剑峰被更高的火口缘挡住）：从每个机位看 ${SKYLINE_RADIUS} m 内的地形轮廓，取比最高处低不到 ${SKYLINE_DROP} m 的平台的中点对准`}>
        <input type="checkbox" checked={!!target.skyline} onChange={(event) => state.updateTarget(target.id, { skyline: event.target.checked })} />
        对准看得见的山顶（轮廓平台的中点）
      </label>}
      <SnapButton state={state} target={target} />
      {target.base !== null && <p className="alignment-hint" title="在预览中拖动底部短横调整">底部自上 {percent(target.base)}，主体约 {percent(target.base - target.frame.y)}。</p>}
      <SpotFields spot={target.frame} label={target.name} onChange={(frame) => state.moveTarget(target.id, frame)} />
      <ToleranceField value={target.tolerance} onChange={(tolerance) => state.updateTarget(target.id, { tolerance })} />
    </div>
  );
}
/** “移到附近最高点”: reads the terrain within 500 m and moves the point to its highest place. */
function SnapButton({ state, target }: { state: CompositionState; target: GroundSpec }) {
  // The note belongs to where the point was left: it disappears once the point moves elsewhere.
  const [note, setNote] = useState<{ text: string; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const here = `${target.latitude}/${target.longitude}`;
  return (
    <div className="alignment-actions composition-snap">
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true);
        setNote(await state.snapToHighest(target.id));
        setBusy(false);
      }}>{busy ? "读取地形中…" : "移到附近最高点"}</button>
      {note && note.at === here && <small className="alignment-hint" role="status">{note.text}</small>}
    </div>
  );
}
function SkyEditor({ state, target }: { state: CompositionState; target: SkySpec }) {
  return (
    <div className="composition-editor">
      <BodyPicker body={target.body} name={`body-${target.id}`} onChange={(body) => state.updateTarget(target.id, { body })} />
      <SpotFields spot={target.frame} label={bodyName(target.body)} onChange={(frame) => state.moveTarget(target.id, frame)} />
      <ToleranceField value={target.tolerance} onChange={(tolerance) => state.updateTarget(target.id, { tolerance })} />
    </div>
  );
}
export function TargetsSection({ state }: { state: CompositionState }) {
  const { targets } = state.composition;
  const full = targets.length >= TARGET_LIMIT;
  return (
    <div className="alignment-section composition-targets">
      <h3>目标 <small>{targets.length}/{TARGET_LIMIT}</small></h3>
      {targets.length > 0 && <ol className="composition-target-list">
        {targets.map((target) => (
          <li key={target.id} className={state.selected === target.id ? "is-selected" : undefined} data-target={target.id}>
            <div className="composition-target-row">
              <span className={`composition-swatch composition-swatch-${target.kind === "ground" ? "ground" : bodyKind(target.body)}`} aria-hidden="true" />
              <button type="button" className="composition-target-name" aria-expanded={state.editing === target.id}
                onClick={() => { state.setSelected(target.id); state.setEditing(state.editing === target.id ? null : target.id); }}>
                <strong>{targetName(target)}</strong>
                <small>{target.kind === "ground" ? heightWords(target) : "天体"} · {spotWords(target.frame)} · ±{Number((target.tolerance * 100).toFixed(1))}%{target.kind === "ground" && target.base !== null ? ` · 主体约 ${percent(target.base - target.frame.y)}` : ""}</small>
              </button>
              <button type="button" className="composition-remove" aria-label={`删除目标 ${targetName(target)}`} onClick={() => state.removeTarget(target.id)}>×</button>
            </div>
            {state.editing === target.id && (target.kind === "ground" ? <GroundEditor state={state} target={target} /> : <SkyEditor state={state} target={target} />)}
          </li>
        ))}
      </ol>}
      {state.placing === "new" && <div className="composition-pending" role="status">
        <p>在地图上单击要拍的地方（山顶、塔等），Esc 取消；或选已接入地标：</p>
        <div className="alignment-actions">
          <select aria-label="选择地标" value="" onChange={(event) => {
            const landmark = landmarks.find((entry) => entry.id === event.target.value);
            if (landmark) state.setGroundPlace({ latitude: landmark.latitude, longitude: landmark.longitude, name: landmark.name, landmark: landmark.id, height: landmark.bounds.height }, "new");
          }}>
            <option value="">选择已接入地标…</option>
            {landmarks.map((landmark) => <option key={landmark.id} value={landmark.id}>{landmark.name}</option>)}
          </select>
          <button type="button" onClick={() => state.setPlacing(null)}>取消</button>
        </div>
      </div>}
      <div className="alignment-actions">
        <button type="button" disabled={full || state.placing === "new"} onClick={() => state.setPlacing("new")}>+ 地面点</button>
        <button type="button" disabled={full} onClick={() => state.addSky()}>+ 天体</button>
      </div>
      {!targets.length && <p className="alignment-hint">加一个地面点和一个天体，或两个天体，再在预览中拖动标记。</p>}
    </div>
  );
}
export function RangeSection({ state, plan }: { state: CompositionState; plan: ShootingPlan }) {
  const { camera, time } = state.composition;
  const here = { latitude: plan.latitude, longitude: plan.longitude };
  const at = (point: { latitude: number; longitude: number }) => `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
  const moved = camera.mode !== "free" && (Math.abs(camera.latitude - plan.latitude) > 1e-6 || Math.abs(camera.longitude - plan.longitude) > 1e-6);
  const aimMoved = camera.mode === "fixed" && camera.aim && (Math.abs(camera.aim.azimuth - plan.azimuth) > 1e-4 || Math.abs(camera.aim.pitch - plan.pitch) > 1e-4);
  const fixedCamera = camera.mode === "fixed";
  return (
    <div className="alignment-section alignment-conditions composition-range">
      <h3>搜索范围</h3>
      <label className="field">
        <span className="field-label">机位</span>
        <select aria-label="机位范围" value={camera.mode} onChange={(event) => {
          const mode = event.target.value as CameraRange["mode"];
          state.setCamera(mode === "free" ? { mode, maxDistance: 30_000, minDistance: DEFAULT_NEAREST } : mode === "near" ? { mode, ...here, radius: 3_000 } : { mode, ...here, aim: null });
          if (mode !== "fixed" && time.mode === "range" && time.days > MAX_LINE_DAYS) state.setTime({ ...time, days: MAX_LINE_DAYS });
        }}>
          <option value="free">不限（以地面目标为中心）</option>
          <option value="near">当前机位周围</option>
          <option value="fixed">固定为当前机位</option>
        </select>
      </label>
      {camera.mode === "free" && <div className="alignment-fields">
        <label className="field">
          <span className="field-label">离地面目标最近</span>
          <select aria-label="机位最近距离" value={camera.minDistance} onChange={(event) => state.setCamera({ ...camera, minDistance: Number(event.target.value) })}
            title="排除贴近地面目标的机位（如站在山顶上）">
            {nearestChoices.filter((value) => value < camera.maxDistance).map((value) => <option key={value} value={value}>{nearestLabel(value)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">最远</span>
          <select aria-label="机位最远距离" value={camera.maxDistance} onChange={(event) => state.setCamera({ ...camera, maxDistance: Number(event.target.value) })}>
            {distanceChoices.filter((value) => value > camera.minDistance).map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label>
      </div>}
      {camera.mode === "near" && <>
        <label className="field">
          <span className="field-label">半径</span>
          <select aria-label="机位范围半径" value={camera.radius} onChange={(event) => state.setCamera({ ...camera, radius: Number(event.target.value) })}>
            {nearChoices.map((value) => <option key={value} value={value}>{value / 1000} km</option>)}
          </select>
        </label>
        <p className="alignment-hint">中心 {at(camera)}{moved && <button type="button" onClick={() => state.setCamera({ ...camera, ...here })}>改用当前机位</button>}</p>
      </>}
      {camera.mode === "fixed" && <>
        <p className="alignment-hint">机位 {at(camera)}{moved && <button type="button" onClick={() => state.setCamera({ ...camera, ...here })}>改用当前机位</button>}</p>
        <label className="composition-check">
          <input type="checkbox" checked={!!camera.aim} onChange={(event) => state.setCamera({ ...camera, aim: event.target.checked ? { azimuth: plan.azimuth, pitch: plan.pitch } : null })} />
          同时固定当前朝向{camera.aim ? `（方位 ${camera.aim.azimuth.toFixed(1)}°，俯仰 ${camera.aim.pitch.toFixed(1)}°）` : ""}
        </label>
        {aimMoved && <p className="alignment-hint">当前方向已改变<button type="button" onClick={() => state.setCamera({ ...camera, aim: { azimuth: plan.azimuth, pitch: plan.pitch } })}>改用当前方向</button></p>}
      </>}
      <label className="field">
        <span className="field-label">时间</span>
        <select aria-label="时间范围" value={time.mode} onChange={(event) => state.setTime(event.target.value === "instant"
          ? { mode: "instant", instant: plan.instant }
          : { mode: "range", date: localDateTime(plan.instant, plan.timeZone).slice(0, 10), days: 30 })}>
          <option value="range">日期范围</option>
          <option value="instant">固定为当前时刻</option>
        </select>
      </label>
      {time.mode === "range" ? <div className="alignment-fields">
        <label className="field">
          <span className="field-label">起始日期</span>
          <input type="date" aria-label="起始日期" min="1900-01-01" max="2100-12-31" value={time.date}
            onChange={(event) => event.target.value && state.setTime({ ...time, date: event.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">跨度</span>
          <select aria-label="跨度" value={time.days} onChange={(event) => state.setTime({ ...time, days: Number(event.target.value) })}>
            {dayChoices.filter((days) => fixedCamera || days <= MAX_LINE_DAYS).map((days) => <option key={days} value={days}>{dayLabel(days)}</option>)}
          </select>
        </label>
      </div> : <p className="alignment-hint">
        {localDateTime(time.instant, plan.timeZone).replace("T", " ").slice(0, 16)}（{plan.timeZone}）
        {time.instant !== plan.instant && <button type="button" onClick={() => state.setTime({ mode: "instant", instant: plan.instant })}>改用当前时刻</button>}
      </p>}
    </div>
  );
}
const percentChoices = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
export function FiltersSection({ state }: { state: CompositionState }) {
  const { filters } = state.composition;
  const replace = (index: number, filter: FilterSpec) => state.setFilters(filters.map((item, at) => (at === index ? filter : item)));
  const missing = (["sky", "moonDown", "moonLit", "darkSky"] as const).filter((kind) => !filters.some((filter) => filter.kind === kind));
  return (
    <div className="alignment-section composition-filters">
      <h3>筛选</h3>
      {filters.map((filter, index) => (
        <div key={filter.kind} className="composition-filter" data-filter={filter.kind}>
          {filter.kind === "sky" && <fieldset className="alignment-sky">
            <legend>天空条件</legend>
            {skyConditions.map((item) => (
              <label key={item}>
                <input type="checkbox" aria-label={`天空条件：${skyConditionNames[item]}`} checked={filter.sky.includes(item)}
                  onChange={() => {
                    const next = filter.sky.includes(item) ? filter.sky.filter((other) => other !== item) : skyConditions.filter((other) => other === item || filter.sky.includes(other));
                    if (next.length) replace(index, { kind: "sky", sky: next as SkyCondition[] });
                  }} />
                {skyConditionNames[item]}
              </label>
            ))}
          </fieldset>}
          {filter.kind === "moonDown" && <span>月亮在地平线下</span>}
          {filter.kind === "darkSky" && <label className="field">
            <span className="field-label">星空可见性</span>
            <select aria-label="星空可见性" value={filter.limit} onChange={(event) => replace(index, { kind: "darkSky", limit: Number(event.target.value) })}
              title="天顶天空亮度不亮于所选值（mag/arcsec²）：按自然天光、机位的光污染（World Atlas 2015）与月光合成，只在天文夜（太阳低于 −18°）判断。">
              {darkSkyChoices.map((choice) => <option key={choice.limit} value={choice.limit}>{choice.label} · {choice.limit}</option>)}
            </select>
          </label>}
          {filter.kind === "moonLit" && <div className="field alignment-phase" role="group" aria-label="月亮亮面范围">
            <span className="field-label">月亮亮面</span>
            <span>
              <select aria-label="亮面下限" value={filter.range[0]} onChange={(event) => replace(index, { kind: "moonLit", range: [Number(event.target.value), Math.max(Number(event.target.value), filter.range[1])] })}>
                {percentChoices.map((value) => <option key={value} value={value}>{percent(value)}</option>)}
              </select>
              —
              <select aria-label="亮面上限" value={filter.range[1]} onChange={(event) => replace(index, { kind: "moonLit", range: [Math.min(Number(event.target.value), filter.range[0]), Number(event.target.value)] })}>
                {percentChoices.map((value) => <option key={value} value={value}>{percent(value)}</option>)}
              </select>
            </span>
          </div>}
          <button type="button" className="composition-remove" aria-label={`删除筛选 ${filterNames[filter.kind]}`} onClick={() => state.setFilters(filters.filter((_, at) => at !== index))}>×</button>
        </div>
      ))}
      {missing.length > 0 && <select aria-label="添加筛选" value="" onChange={(event) => {
        const kind = event.target.value as FilterSpec["kind"];
        state.setFilters([...filters, kind === "sky" ? { kind, sky: ["twilight", "night"] } : kind === "moonDown" ? { kind } : kind === "darkSky" ? { kind, limit: 21.3 } : { kind, range: [0, 0.5] }]);
      }}>
        <option value="">+ 添加筛选…</option>
        {missing.map((kind) => <option key={kind} value={kind}>{filterNames[kind]}</option>)}
      </select>}
    </div>
  );
}
