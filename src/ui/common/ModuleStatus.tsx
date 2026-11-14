import type { ModuleLoad } from "./lazy-module";

/** Where a part read on first use is still loading, or failed and can be tried again. */
export function ModuleStatus({ load, name }: { load: ModuleLoad<unknown>; name: string }) {
  if (load.phase === "failed")
    return (
      <p className="module-status is-error" role="alert">
        {name}读取失败：{load.message || "未知原因"}
        <button type="button" onClick={load.retry}>重试</button>
      </p>
    );
  return <p className="module-status" role="status">{name}读取中…</p>;
}
