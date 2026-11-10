import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "./Icon";
import { useShotLibrary } from "./useShotLibrary";
import {
  parseShotText,
  planFromShot,
  planSignature,
  shareCode,
  shotFromPlan,
  shotJson,
  shotSignature,
  SHOT_NAME_LIMIT,
} from "../domain/shot";
import type { Shot, ShotParse } from "../domain/shot";
import { sensors } from "../domain/plan";
import type { ShootingPlan } from "../domain/plan";
import { landmarkDistance, landmarks } from "../domain/landmarks";
import type { SavedShot } from "../domain/shot-library";

const layerNames: Record<keyof Shot["layers"], string> = {
  buildings: "建筑",
  sun: "太阳",
  sunPath: "太阳轨迹",
  moon: "月亮",
  moonPath: "月亮轨迹",
  stars: "星空",
  constellations: "星座",
  milkyWay: "银河",
  deepSky: "深空天体",
  stations: "空间站",
  meteors: "流星雨",
  meteorDensity: "流星密度",
  comets: "彗星",
};

const coordinates = (p: { latitude: number; longitude: number }) =>
  `${Math.abs(p.latitude).toFixed(3)}°${p.latitude >= 0 ? "N" : "S"} ${Math.abs(p.longitude).toFixed(3)}°${p.longitude >= 0 ? "E" : "W"}`;
/** Nearest registered landmark within 10 km, otherwise coordinates. */
function place(p: { latitude: number; longitude: number }) {
  const nearest = landmarks
    .map((target) => ({ target, distance: landmarkDistance(p, target) }))
    .filter((item) => item.distance <= 10000)
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest ? `${nearest.target.name}附近` : coordinates(p);
}
const localTime = (shot: Shot) =>
  `${shot.time.local.slice(0, 16).replace("T", " ")} · ${shot.time.timeZone}${shot.time.followLocalZone ? "（当地）" : ""}`;
const lens = (shot: Shot) =>
  `${shot.camera.focalLength} mm · ${sensors[shot.camera.sensor].label.split(" · ")[0]} · ${shot.camera.orientation === "portrait" ? "竖幅" : "横幅"} ${shot.camera.aspectRatio}`;
export const suggestShotName = (shot: Shot) =>
  `${place(shot.position).replace(/附近$/, "")} · ${shot.time.local.slice(5, 16).replace("T", " ")}`.slice(0, SHOT_NAME_LIMIT);

async function copyText(text: string, field: HTMLTextAreaElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return "已复制";
  } catch {
    field?.focus();
    field?.select();
    return "无法访问剪贴板，已选中文本，请手动复制";
  }
}

export function ShotMenu({
  plan,
  activeId,
  onActiveChange,
  onApply,
}: {
  plan: ShootingPlan;
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  onApply: (plan: ShootingPlan, id: string | null, name: string) => void;
}) {
  const shots = useShotLibrary();
  const { library } = shots;
  const writable = library.phase === "ready";
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [sharing, setSharing] = useState<Shot | null>(null);
  const [importing, setImporting] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const active = library.shots.find((entry) => entry.id === activeId) ?? null;
  useEffect(() => {
    // The bound shot was deleted here or in another tab.
    if (activeId && writable && !active) onActiveChange(null);
  }, [activeId, active, writable]);
  const signature = useMemo(() => planSignature(plan), [plan]);
  const modified = !!active && shotSignature(active.shot) !== signature;
  const label = active?.shot.name ?? "未保存的机位";

  const reset = () => {
    setSaving(false);
    setExpanded(null);
    setRenaming(null);
    setNotice(null);
    shots.clearError();
  };
  const close = (focus = true) => {
    setOpen(false);
    reset();
    if (focus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const current = (name = active?.shot.name ?? "") => shotFromPlan(plan, name || suggestShotName(shotFromPlan(plan)), active?.shot.note ?? "");
  const save = (event: FormEvent) => {
    event.preventDefault();
    const shot = shotFromPlan(plan, draft.trim() || suggestShotName(shotFromPlan(plan)));
    const entry = shots.saveNew(shot);
    if (!entry) return;
    onActiveChange(entry.id);
    setSaving(false);
    setNotice({ text: `已保存「${shot.name}」` });
  };
  const saveChanges = () => {
    if (active && shots.update(active.id, current())) setNotice({ text: `已更新「${active.shot.name}」` });
  };
  const apply = (entry: SavedShot) => {
    onApply(planFromShot(entry.shot), entry.id, entry.shot.name);
    close();
  };
  const remove = (entry: SavedShot) => {
    const removed = shots.remove(entry.id);
    if (!removed) return;
    const wasActive = entry.id === activeId;
    if (wasActive) onActiveChange(null);
    setExpanded(null);
    setNotice({
      text: `已删除「${entry.shot.name}」`,
      undo: () => {
        if (shots.restore(removed.entry, removed.index) && wasActive) onActiveChange(entry.id);
        setNotice(null);
      },
    });
  };
  const rename = (event: FormEvent<HTMLFormElement>, entry: SavedShot) => {
    event.preventDefault();
    const name = (event.currentTarget.elements.namedItem("name") as HTMLInputElement).value.trim();
    if (name && shots.rename(entry.id, name.slice(0, SHOT_NAME_LIMIT))) {
      setRenaming(null);
      setExpanded(null);
    }
  };
  const share = (shot: Shot) => {
    setSharing(shot);
    close(false);
  };
  const imported = (parsed: Extract<ShotParse, { ok: true }>, name: string, keep: boolean) => {
    const shot = { ...parsed.shot, name: name.trim().slice(0, SHOT_NAME_LIMIT) || suggestShotName(parsed.shot) };
    if (keep) {
      const entry = shots.saveNew(shot);
      if (!entry) return false;
      onApply(planFromShot(shot), entry.id, shot.name);
    } else onApply(planFromShot(shot), null, shot.name);
    return true;
  };

  return (
    <div
      className="shot-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={`shot-button ${open ? "is-open" : ""}`}
        aria-expanded={open}
        aria-controls="shot-panel"
        aria-label={`机位：${label}${modified ? "（已修改）" : ""}`}
        title="保存、切换与分享机位"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="bookmark" size={15} />
        <span className="shot-button-label">{label}</span>
        {modified && <span className="shot-modified" aria-hidden="true" />}
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="shot-panel" id="shot-panel" role="dialog" aria-label="机位" tabIndex={-1} ref={panel}>
          <section className="shot-current" aria-label="当前机位">
            <span className="eyebrow">当前</span>
            <strong>{label}</strong>
            <small>{!active ? "当前画面尚未保存为机位" : modified ? "已修改，尚未保存" : "已保存"}</small>
            {saving ? (
              <form className="shot-name-form" onSubmit={save}>
                <input
                  aria-label="机位名称"
                  value={draft}
                  maxLength={SHOT_NAME_LIMIT}
                  autoFocus
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="shot-primary">保存</button>
                <button type="button" onClick={() => setSaving(false)}>取消</button>
              </form>
            ) : (
              <div className="shot-actions">
                {modified && (
                  <button type="button" className="shot-primary" disabled={!writable} onClick={saveChanges}>
                    保存修改
                  </button>
                )}
                <button
                  type="button"
                  className={active ? "" : "shot-primary"}
                  disabled={!writable}
                  onClick={() => {
                    setDraft(suggestShotName(shotFromPlan(plan)));
                    setNotice(null);
                    setSaving(true);
                  }}
                >
                  {active ? "另存为新机位" : "保存为机位"}
                </button>
                <button type="button" onClick={() => share(current())}>
                  分享
                </button>
              </div>
            )}
          </section>
          {library.phase === "unavailable" && (
            <p className="shot-warning">此浏览器无法使用本地存储，机位不能保存；仍可通过分享码导入与分享。</p>
          )}
          {library.phase === "corrupt" && (
            <p className="shot-warning">
              本地机位数据无法读取，为避免覆盖已暂停保存。
              <button type="button" onClick={() => window.confirm("清空本地保存的全部机位？此操作无法撤销。") && shots.reset()}>
                清空本地机位
              </button>
            </p>
          )}
          {shots.error && <p className="shot-warning" role="alert">{shots.error}</p>}
          {notice && (
            <p className="shot-notice" role="status">
              {notice.text}
              {notice.undo && <button type="button" onClick={notice.undo}>撤销</button>}
            </p>
          )}
          <section className="shot-saved" aria-labelledby="shot-saved-title">
            <h3 id="shot-saved-title">
              已保存的机位 <small>{library.shots.length}</small>
            </h3>
            {library.shots.length ? (
              <ul className="shot-list">
                {library.shots.map((entry) => {
                  const isCurrent = entry.id === activeId, more = expanded === entry.id;
                  return (
                    <li key={entry.id} className={`shot-item ${isCurrent ? "is-current" : ""}`} data-shot-id={entry.id}>
                      <div className="shot-item-main">
                        <button type="button" className="shot-apply" onClick={() => apply(entry)}>
                          <strong>
                            {entry.shot.name}
                            {isCurrent && <em>当前</em>}
                          </strong>
                          <small>{place(entry.shot.position)} · {localTime(entry.shot)}</small>
                          <small>{lens(entry.shot)}</small>
                        </button>
                        <button
                          type="button"
                          className="shot-more"
                          aria-expanded={more}
                          aria-label={`${entry.shot.name}的操作`}
                          onClick={() => {
                            setExpanded(more ? null : entry.id);
                            setRenaming(null);
                          }}
                        >
                          ···
                        </button>
                      </div>
                      {more &&
                        (renaming === entry.id ? (
                          <form className="shot-name-form" onSubmit={(event) => rename(event, entry)}>
                            <input name="name" aria-label="新名称" defaultValue={entry.shot.name} maxLength={SHOT_NAME_LIMIT} autoFocus />
                            <button type="submit" className="shot-primary">确定</button>
                            <button type="button" onClick={() => setRenaming(null)}>取消</button>
                          </form>
                        ) : (
                          <div className="shot-item-actions">
                            <button type="button" disabled={!writable} onClick={() => setRenaming(entry.id)}>重命名</button>
                            <button type="button" onClick={() => share(entry.shot)}>分享</button>
                            <button type="button" className="shot-danger" disabled={!writable} onClick={() => remove(entry)}>删除</button>
                          </div>
                        ))}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="shot-empty">还没有保存的机位。保存后可随时切回同样的位置、方向、镜头、时间与图层。</p>
            )}
            {library.broken.map((entry) => (
              <p className="shot-warning" key={entry.id}>
                1 个机位无法读取（{entry.reason}）
                <button type="button" onClick={() => shots.removeBroken(entry.id)}>删除</button>
              </p>
            ))}
          </section>
          <footer className="shot-footer">
            <button
              type="button"
              onClick={() => {
                setImporting(true);
                close(false);
              }}
            >
              导入机位
            </button>
            <small>机位只保存在此浏览器</small>
          </footer>
        </div>
      )}
      <ImportDialog open={importing} canSave={writable} onClose={() => setImporting(false)} onImport={imported} />
      <ShareDialog shot={sharing} onClose={() => setSharing(null)} />
    </div>
  );
}

function ShotSummary({ shot }: { shot: Shot }) {
  const enabled = (Object.keys(layerNames) as (keyof Shot["layers"])[]).filter((key) => shot.layers[key]);
  return (
    <dl className="shot-summary">
      <dt>地点</dt>
      <dd>{place(shot.position)} · 离地 {shot.position.heightAboveGround} m</dd>
      <dt>时间</dt>
      <dd>{localTime(shot)}</dd>
      <dt>方向</dt>
      <dd>方位 {shot.view.azimuth.toFixed(1)}° · 俯仰 {shot.view.pitch.toFixed(1)}°</dd>
      <dt>镜头</dt>
      <dd>{lens(shot)}</dd>
      <dt>图层</dt>
      <dd>{enabled.length ? enabled.map((key) => layerNames[key]).join("、") : "全部关闭"}</dd>
    </dl>
  );
}

function ImportDialog({
  open,
  canSave,
  onClose,
  onImport,
}: {
  open: boolean;
  canSave: boolean;
  onClose: () => void;
  onImport: (parsed: Extract<ShotParse, { ok: true }>, name: string, keep: boolean) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), errors = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [copied, setCopied] = useState("");
  const parsed = useMemo(() => (text.trim() ? parseShotText(text) : null), [text]);
  useEffect(() => {
    if (open) {
      setText("");
      setCopied("");
      if (!dialog.current?.open) dialog.current?.showModal();
    } else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (parsed?.ok) setName(parsed.shot.name || suggestShotName(parsed.shot));
  }, [parsed]);
  const run = (keep: boolean) => {
    if (parsed?.ok && onImport(parsed, name, keep)) dialog.current?.close();
  };
  return (
    <dialog ref={dialog} className="shot-dialog" aria-labelledby="shot-import-title" onClose={onClose}>
      <header className="about-header">
        <div>
          <span className="eyebrow">机位</span>
          <h2 id="shot-import-title">导入机位</h2>
        </div>
        <button className="reset-button" type="button" onClick={() => dialog.current?.close()}>
          关闭
        </button>
      </header>
      <div className="about-body shot-dialog-body">
        <label className="field">
          <span className="field-label">粘贴分享码</span>
          <textarea
            aria-label="分享码或机位 JSON"
            value={text}
            rows={5}
            spellCheck={false}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {parsed && !parsed.ok && (
          <div className="shot-errors" role="alert">
            <p>无法导入，共 {parsed.errors.length} 处问题：</p>
            <ul>
              {parsed.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
            <textarea ref={errors} className="shot-copy-source" readOnly value={parsed.errors.join("\n")} aria-hidden="true" tabIndex={-1} />
            <button type="button" onClick={async () => setCopied(await copyText(parsed.errors.join("\n"), errors.current))}>
              复制问题列表
            </button>
            <span role="status">{copied}</span>
          </div>
        )}
        {parsed?.ok && (
          <div className="shot-preview">
            <ShotSummary shot={parsed.shot} />
            {parsed.defaults.length > 0 && (
              <details className="shot-defaults">
                <summary>{parsed.defaults.length} 项未提供，已用默认值</summary>
                {parsed.defaults.join("、")}
              </details>
            )}
            <label className="field">
              <span className="field-label">名称</span>
              <input aria-label="导入机位名称" value={name} maxLength={SHOT_NAME_LIMIT} onChange={(event) => setName(event.target.value)} />
            </label>
          </div>
        )}
      </div>
      <footer className="shot-dialog-footer">
        <button type="button" disabled={!parsed?.ok} onClick={() => run(false)}>
          仅应用
        </button>
        <button type="button" className="shot-primary" disabled={!parsed?.ok || !canSave} onClick={() => run(true)}>
          保存并应用
        </button>
      </footer>
    </dialog>
  );
}

function ShareDialog({ shot, onClose }: { shot: Shot | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), codeField = useRef<HTMLTextAreaElement>(null), jsonField = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState("");
  const code = useMemo(() => (shot ? shareCode(shot) : ""), [shot]);
  const json = useMemo(() => (shot ? shotJson(shot) : ""), [shot]);
  useEffect(() => {
    setCopied("");
    if (shot && !dialog.current?.open) dialog.current?.showModal();
    else if (!shot && dialog.current?.open) dialog.current.close();
  }, [shot]);
  return (
    <dialog ref={dialog} className="shot-dialog" aria-labelledby="shot-share-title" onClose={onClose}>
      <header className="about-header">
        <div>
          <span className="eyebrow">机位</span>
          <h2 id="shot-share-title">分享「{shot?.name}」</h2>
        </div>
        <button className="reset-button" type="button" autoFocus onClick={() => dialog.current?.close()}>
          关闭
        </button>
      </header>
      <div className="about-body shot-dialog-body">
        <p>把分享码发给对方，对方在“机位 → 导入机位”中粘贴即可得到同样的设置。</p>
        <label className="field">
          <span className="field-label">分享码</span>
          <textarea ref={codeField} aria-label="分享码" readOnly value={code} rows={4} spellCheck={false} />
        </label>
        <div className="shot-copy-row">
          <button type="button" className="shot-primary" onClick={async () => setCopied(await copyText(code, codeField.current))}>
            复制分享码
          </button>
          <span role="status">{copied}</span>
        </div>
        <details className="shot-json">
          <summary>JSON 格式</summary>
          <textarea ref={jsonField} aria-label="机位 JSON" readOnly value={json} rows={12} spellCheck={false} />
          <button type="button" onClick={async () => setCopied(await copyText(json, jsonField.current))}>
            复制 JSON
          </button>
        </details>
      </div>
    </dialog>
  );
}

/** Confirmation after applying a shot, with one-step undo. Pauses while hovered or focused. */
export function ShotToast({ text, onUndo, onClose }: { text: string; onUndo?: () => void; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => closeRef.current(), 12000);
    return () => clearTimeout(timer);
  }, [paused, text]);
  return (
    <div
      className="shot-toast"
      role="status"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{text}</span>
      {onUndo && (
        <button type="button" onClick={onUndo}>
          撤销
        </button>
      )}
      <button type="button" aria-label="关闭提示" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
