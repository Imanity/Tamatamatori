import { useState } from "react";
import { resultSize } from "../../domain/solve/chat-results";
import type { ChatResult, ChatSolve } from "../../domain/solve/chat-results";
import type { ResultItem } from "../../domain/solve/composition";
import type { Shot } from "../../domain/shots/shot";
import { resultShot, resultTimes } from "./result-plans";

export interface ResultActions {
  onApply: (shot: Shot) => void;
  onSave: (shot: Shot) => Promise<boolean>;
  onSaveMany?: (shots: Shot[]) => Promise<boolean>;
  onOpen?: (result: ChatSolve) => void;
}
function ShotFacts({ shot }: { shot: Shot }) {
  return <p>{shot.time.local} · {shot.time.timeZone} · {shot.camera.focalLength} mm<br />
    {shot.position.latitude.toFixed(5)}, {shot.position.longitude.toFixed(5)} · 方位 {shot.view.azimuth.toFixed(1)}°</p>;
}
function Interval({ result, item, actions, save, busy }: {
  result: ChatSolve; item: ResultItem; actions: ResultActions; save: (shots: Shot[]) => Promise<void>; busy: boolean;
}) {
  const times = resultTimes(item);
  const [index, setIndex] = useState(Math.max(0, times.indexOf(item.best)));
  const shot = resultShot(result, item, times[index]);
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: result.base.time.timeZone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const when = (time: number) => formatter.format(new Date(time));
  return <div className="local-proposal local-interval">
    <strong>{shot.name}</strong>
    <p>{item.place ? "与时刻无关的机位" : `${when(item.start)} — ${when(item.end)}（${result.base.time.timeZone}）`}
      {item.near !== null && <> · 距目标 {(item.near / 1000).toFixed(2)}—{(item.far! / 1000).toFixed(2)} km</>}
      {item.place && <> · 容差内约 {Math.round(item.place.reach.shortest * 2)}×{Math.round(item.place.reach.longest * 2)} m</>}
    </p>
    {!item.place && times.length > 1 && <label className="local-interval-slider">{item.points ? "在区间内选择机位与时刻" : "在区间内选择时刻"}
      <input type="range" aria-label={`${shot.name}区间选点`} min={0} max={times.length - 1} step={1} value={index}
        aria-valuetext={when(times[index])} onChange={event => setIndex(Number(event.target.value))} />
    </label>}
    <ShotFacts shot={shot} />
    <p>位置与可达性请在地图核实。</p>
    <button type="button" onClick={() => actions.onApply(shot)}>应用所选机位</button>
    <button type="button" disabled={busy} onClick={() => void save([shot])}>保存所选机位</button>
  </div>;
}

export function ChatResults({ result, ...actions }: { result: ChatResult } & ResultActions) {
  const [page, setPage] = useState(0), [selected, setSelected] = useState<Set<number>>(() => new Set(result.kind === "shots" ? result.shots.map((_, index) => index) : []));
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const shown = resultSize(result), size = 10;
  const save = async (shots: Shot[]) => {
    setBusy(true); setStatus("");
    try {
      const ok = shots.length === 1 ? await actions.onSave(shots[0]) : await actions.onSaveMany?.(shots);
      setStatus(ok ? `已保存 ${shots.length} 个机位` : "保存失败，请在机位菜单查看原因后重试");
    } catch (error) { setStatus(`保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  };
  return <section className="local-results" aria-label={result.kind === "shots" ? "独立机位结果" : "推算区间结果"}>
    <h3>{result.kind === "shots" ? "独立机位" : result.shape === "places" ? "机位与容差范围" : "推算结果"} · {shown} / {result.total}</h3>
    {shown < result.total && <p role="status" className="local-results-truncated">共 {result.total} 个结果，本轮显示 {shown} 个。若要查看更多，请让助手缩小搜索范围或增加展示数量。</p>}
    {result.kind === "solve" && <>
      {result.note && <p>{result.note}</p>}
      {result.blocked > 0 && <p>另有 {result.blocked} 个机位或分钟视线被地形挡住。</p>}
      {actions.onOpen && shown > 0 && <button type="button" onClick={() => actions.onOpen?.(result)}>在地图与时间轴查看</button>}
    </>}
    {result.kind === "shots" && shown > 1 && actions.onSaveMany && <div className="local-result-actions">
      <button type="button" onClick={() => setSelected(new Set(result.shots.map((_, index) => index)))}>全选</button>
      <button type="button" onClick={() => setSelected(new Set())}>取消全选</button>
      <button type="button" disabled={busy || !selected.size} onClick={() => void save(result.shots.filter((_, index) => selected.has(index)))}>保存所选（{selected.size}）</button>
    </div>}
    {result.kind === "shots" ? result.shots.slice(page * size, (page + 1) * size).map((shot, offset) => {
      const index = page * size + offset;
      return <div className="local-proposal" key={index}>
        <strong>{shot.name || "候选机位"}</strong>
        {shown > 1 && actions.onSaveMany && <label><input type="checkbox" aria-label={`选择${shot.name || `机位 ${index + 1}`}`} checked={selected.has(index)} onChange={event => setSelected(current => {
          const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next;
        })} />保存时包含此机位</label>}
        <ShotFacts shot={shot} /><p>位置与可达性请在地图核实。</p>
        <button type="button" onClick={() => actions.onApply(shot)}>应用试看</button>
        <button type="button" disabled={busy} onClick={() => void save([shot])}>保存机位</button>
      </div>;
    }) : result.items.slice(page * size, (page + 1) * size).map(item => <Interval key={item.key} result={result} item={item} actions={actions} save={save} busy={busy} />)}
    {shown > size && <nav aria-label="聊天结果分页"><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
      <span>{page + 1} / {Math.ceil(shown / size)}</span><button type="button" disabled={(page + 1) * size >= shown} onClick={() => setPage(page + 1)}>下一页</button></nav>}
    {status && <p role="status">{status}</p>}
  </section>;
}
