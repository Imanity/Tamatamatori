import { useRef, useState } from "react";
import { readLibrary } from "../../domain/shots/shot-library";
import type { useShotLibrary } from "./useShotLibrary";

export function LibraryTransfer({ store }: { store: ReturnType<typeof useShotLibrary> }) {
  const file = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const exportLibrary = () => {
    const data = { format: "tamatamatori.library", version: 1, shots: [...store.library.shots, ...store.library.broken.map((entry) => entry.raw)] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "tamatamatori-library.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    <button type="button" disabled={!store.writable} onClick={exportLibrary}>导出机位库</button>
    <button type="button" disabled={!store.writable} onClick={() => file.current?.click()}>导入机位库</button>
    <input ref={file} type="file" accept="application/json,.json" hidden aria-label="机位库文件" onChange={async (event) => {
      const selected = event.target.files?.[0]; event.target.value = "";
      if (!selected) return;
      try {
        if (selected.size > 8_000_000) throw new Error("文件超过 8 MB");
        const value = await selected.text(), parsed = JSON.parse(value);
        if (parsed.format !== "tamatamatori.library" || parsed.version !== 1 || !Array.isArray(parsed.shots)) throw new Error("不是机位库备份");
        const library = readLibrary({ getItem: () => value });
        if (library.phase !== "ready") throw new Error("机位库无法读取");
        const ids = new Set(store.library.shots.map((entry) => entry.id));
        const duplicates = library.shots.filter((entry) => ids.has(entry.id)).length;
        setText(value); setError("");
        setSummary(`${library.shots.length} 个可读机位，其中 ${duplicates} 个已有相同 id，将保留现有条目；${library.broken.length} 个无法读取的条目将保留以便恢复。`);
        dialog.current?.showModal();
      } catch (cause) { setError((cause as Error).message); }
    }} />
    {error && <p role="alert">{error}</p>}
    <dialog ref={dialog} className="shot-dialog" aria-label="导入机位库">
      <header className="about-header"><h2>导入机位库</h2><button type="button" onClick={() => dialog.current?.close()}>关闭</button></header>
      <div className="about-body"><p>{summary}</p><p>导入会合并到当前机位库，不覆盖已有的相同 id。</p>{store.error && <p role="alert">{store.error}</p>}</div>
      <footer className="shot-dialog-footer"><button type="button" disabled={!store.writable} onClick={async () => { if (await store.importLibrary(text)) dialog.current?.close(); }}>合并导入</button></footer>
    </dialog>
  </>;
}
