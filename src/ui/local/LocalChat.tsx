import { useEffect, useRef, useState } from "react";
import type { ShootingPlan } from "../../domain/core/plan";
import { parseShot, shotFromPlan } from "../../domain/shots/shot";
import type { Shot } from "../../domain/shots/shot";
import { localJson } from "../../io/local-client";
import "./local-chat.css";

type Agent = { id: string; available: boolean; loggedIn?: boolean; version?: string; message: string };
type Message = { role: string; text: string; proposals?: Shot[]; error?: string };
type Chat = { id: string; provider: string; title: string; messages?: Message[] };

export default function LocalChat({ plan, onApply, onSave }: {
  plan: ShootingPlan; onApply: (shot: Shot) => void; onSave: (shot: Shot) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), messagesEnd = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]), [chats, setChats] = useState<Chat[]>([]);
  const [id, setId] = useState("");
  const [provider, setProvider] = useState("codex");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState(""), [error, setError] = useState("");
  const [status, setStatus] = useState(""), [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const refresh = async () => {
    try { const [nextAgents, nextChats] = await Promise.all([localJson<Agent[]>("/api/agents"), localJson<Chat[]>("/api/chats")]); setAgents(nextAgents); setChats(nextChats); }
    catch (cause) { setError((cause as Error).message); }
  };
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: "nearest" }); }, [messages, status]);
  const available = agents.find((entry) => entry.id === provider);
  const send = async () => {
    if (!draft.trim() || running) return;
    const text = draft; setDraft(""); setError(""); setStatus("正在启动 Agent…"); setRunning(true);
    setMessages((current) => [...current, { role: "user", text }, { role: "assistant", text: "", proposals: [] }]);
    const abort = new AbortController(); controller.current = abort;
    const updateLast = (update: (value: Message) => Message) => setMessages((current) => current.map((value, index) => index === current.length - 1 ? update(value) : value));
    try {
      const response = await fetch("/api/chat", { method: "POST", credentials: "same-origin", signal: abort.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, id: id || undefined, message: text, plan: shotFromPlan(plan, "当前计划") }) });
      if (!response.ok) throw new Error((await response.json()).error || "本地聊天无法启动");
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let buffer = "", finished = false;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let boundary; (boundary = buffer.indexOf("\n\n")) >= 0;) {
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "session") setId(event.id);
          if (event.type === "delta") { setStatus(""); updateLast((value) => ({ ...value, text: value.text + event.text })); }
          if (event.type === "status") setStatus(event.text);
          if (event.type === "proposal") {
            const parsed = parseShot(event.shot);
            if (parsed.ok) updateLast((value) => ({ ...value, proposals: [...(value.proposals ?? []), parsed.shot] }));
          }
          if (event.type === "done") finished = true;
          if (event.type === "error") { finished = true; setError(event.text); }
        }
      }
      if (!finished) throw new Error("连接中断，回复可能不完整；可以继续此对话。");
    } catch (cause) { setError(abort.signal.aborted ? "已停止" : (cause as Error).message); }
    finally { controller.current = null; setRunning(false); setStatus(""); void refresh(); }
  };
  return <>
    <button type="button" className="solve-button" onClick={() => { dialog.current?.showModal(); void refresh(); }}>对话</button>
    <dialog ref={dialog} className="local-chat" aria-labelledby="local-chat-title">
      <header className="about-header"><h2 id="local-chat-title">摄影助手</h2><button type="button" onClick={() => dialog.current?.close()}>关闭</button></header>
      <div className="local-chat-toolbar">
        <label>Agent <select aria-label="聊天 Agent" disabled={running} value={provider} onChange={(event) => { setProvider(event.target.value); setId(""); setMessages([]); }}><option value="codex">Codex（ChatGPT）</option><option value="claude">Claude Code</option></select></label>
        <select aria-label="本地对话记录" value={id} disabled={running} onChange={async (event) => {
          const next = event.target.value; setId(next); setError("");
          if (!next) { setMessages([]); return; }
          try { const chat = await localJson<Chat>(`/api/chats/${next}`); setProvider(chat.provider); setMessages(chat.messages ?? []); }
          catch (cause) { setError((cause as Error).message); }
        }}><option value="">新对话</option>{chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select>
        <button type="button" disabled={running} onClick={() => { setId(""); setMessages([]); setError(""); }}>新对话</button>
      </div>
      <p className="local-chat-note">{available ? `${available.version || ""} · ${available.message}` : "正在检查本机 Agent…"} <button type="button" disabled={running} onClick={() => void refresh()}>重新检查</button></p>
      <p className="local-chat-note">对话与必要机位会发送给所选 Agent 的模型服务。用量按其登录方式计算；发送会消耗相应额度。</p>
      <div className="local-chat-messages" aria-live="polite">
        {!messages.length && <p>描述想拍的构图，例如“找接下来一个月月亮落在晴空塔尖的机位”。当前镜头和机位会作为参考。</p>}
        {messages.map((message, index) => <article key={index} className={`local-message ${message.role}`}><strong>{message.role === "user" ? "你" : "助手"}</strong><p>{message.text}</p>
          {message.error && <p role="alert">{message.error}</p>}
          {message.proposals?.map((shot, number) => <div className="local-proposal" key={number}><strong>{shot.name || "候选机位"}</strong><p>{shot.time.local} · {shot.camera.focalLength} mm<br />{shot.position.latitude.toFixed(5)}, {shot.position.longitude.toFixed(5)}</p>
            <p>位置与可达性请在地图核实。</p>
            <button type="button" onClick={() => { onApply(shot); dialog.current?.close(); }}>应用试看</button>
            <button type="button" disabled={saving} onClick={async () => { setSaving(true); try { if (await onSave(shot)) setStatus("机位已保存"); else setError("保存失败，请在机位菜单查看原因并重试"); } finally { setSaving(false); } }}>保存机位</button>
          </div>)}
        </article>)}<div ref={messagesEnd} />
      </div>
      {status && <p role="status" className="local-chat-note">{status}</p>}
      {error && <p role="alert" className="local-chat-error">{error}</p>}
      <form className="local-chat-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea aria-label="摄影需求" value={draft} maxLength={20000} disabled={running} onChange={(event) => setDraft(event.target.value)} placeholder="描述构图、日期和地点…" />
        {running ? <button type="button" onClick={() => { if (id) void localJson("/api/stop", { method: "POST", body: JSON.stringify({ id }) }).catch(() => {}); controller.current?.abort(); }}>停止</button>
          : <button type="submit" disabled={!draft.trim() || !available?.available || !available.loggedIn}>发送</button>}
      </form>
    </dialog>
  </>;
}
