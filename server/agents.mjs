import { fileURLToPath } from 'node:url';
import { startProcess, stopProcess, capture, agentCommand, agentEnvironment } from './process.mjs';
import { LOCAL_TOOLS } from './tool-bridge.mjs';

const bridge = fileURLToPath(new URL('./tool-bridge.mjs', import.meta.url));
const instructions = `你是 Tamatamatori 摄影规划助手，用中文回答。先用摄影工具读取当前计划、格式、校验条件和推算，数值以工具为准，不估算天体方位、时间或机位。坐标未经核实时明确说明。可以读取当前计划和用户指定的机位，不能直接写文件或运行命令。单个独立机位用 propose.shot，多机位用 propose.shots 一次提供；区间用 solve。solve 自动显示完整区间、代表机位和地图入口，不再用 propose 重复相同结果，不把一段区间当作一个确定时刻。只要工具提供了结果就简要解释，由用户选择应用或保存。条件不足时直接提问。推算不保证天气、树木、建筑与道路可达性。`;

export async function agentStatus(provider) {
  const command = agentCommand(provider);
  const version = await capture(command, ['--version']);
  if (!version.ok) return { id: provider, available: false, message: version.output };
  const auth = await capture(command, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--text']);
  const apiEnvironment = provider === 'codex' ? !!process.env.OPENAI_API_KEY : !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { id: provider, available: true, loggedIn: auth.ok || apiEnvironment, version: version.output.split('\n')[0],
    message: apiEnvironment ? '检测到 API 环境变量；调用可能按 API 计费' : auth.ok ? '官方程序已登录；用量以其账号与配置为准' : '请先在终端完成官方程序登录' };
}

export async function runAgent({ provider, session, message, cwd, url, token, signal, emit }) {
  if (signal.aborted) throw new Error('已停止');
  const mcp = { command: process.execPath, args: ['--experimental-strip-types', bridge],
    env: { TMT_LOCAL_URL: url, TMT_TOOL_TOKEN: token, TMT_CHAT_ID: session.id } };
  if (provider === 'codex') return runCodex({ session, message, cwd, mcp, signal, emit });
  if (provider === 'claude') return runClaude({ session, message, cwd, mcp, signal, emit });
  throw new Error('未知 Agent');
}

function lines(child, onMessage, reject) {
  let buffer = '';
  child.stdout.setEncoding('utf8'); // A multibyte character can span OS pipe chunks.
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 4_000_000) { reject(new Error('Agent 消息过大')); stopProcess(child); return; }
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch (error) { reject(new Error(`Agent 协议错误：${error.message}`)); }
    }
  });
}

export function runCodex({ session, message, cwd, mcp, signal, emit, spawn = startProcess }) {
  return new Promise((resolve, reject) => {
    const names = LOCAL_TOOLS.map(tool => tool.name);
    const approvals = names.map(name => `${name}={approval_mode="approve"}`).join(',');
    const connection = `{tamatamatori={command=${JSON.stringify(mcp.command)},args=${JSON.stringify(mcp.args)},env_vars=["TMT_LOCAL_URL","TMT_TOOL_TOKEN","TMT_CHAT_ID"],required=true,enabled_tools=${JSON.stringify(names)},tools={${approvals}},tool_timeout_sec=240}}`;
    const child = spawn(agentCommand('codex'), ['app-server', '-c', `mcp_servers=${connection}`, '-c', 'plugins={}',
      '-c', 'default_permissions="tamatamatori"',
      '-c', 'permissions.tamatamatori={filesystem={":root"="read","~/.codex"="deny","~/.claude"="deny","~/.ssh"="deny"},network={enabled=false}}',
      '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false',
      '-c', 'features.code_mode=false', '-c', 'features.js_repl=false', '-c', 'features.hooks=false', '-c', 'features.codex_hooks=false',
      '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false', '-c', 'features.apps=false', '-c', 'features.collab=false', '-c', 'web_search="disabled"'],
    { cwd, env: { ...agentEnvironment(), ...mcp.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let sequence = 0, ended = false, activeTurn;
    const pending = new Map();
    const send = (method, params) => {
      const id = ++sequence;
      return new Promise((yes, no) => { pending.set(id, { yes, no }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
    };
    const fail = (error) => { if (ended) return; ended = true; reject(error); stopProcess(child); };
    const cancel = () => {
      if (activeTurn) void send('turn/interrupt', { threadId: session.nativeId, turnId: activeTurn }).catch(() => {});
      fail(new Error('已停止'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', (error) => fail(new Error(`Codex 无法启动：${error.message}`)));
    child.stderr.on('data', () => {}); // Never forward native logs or credentials to the browser.
    child.stdin.on('error', (error) => { if (!ended) fail(error); });
    child.on('close', () => {
      signal.removeEventListener('abort', cancel);
      for (const request of pending.values()) request.no(new Error('Codex 进程已退出'));
      pending.clear();
      if (!ended) fail(new Error('Codex 在完成回复前退出，请检查版本、登录和工具配置'));
    });
    lines(child, (event) => {
      if (event.id !== undefined && !event.method) {
        const request = pending.get(event.id); pending.delete(event.id);
        if (event.error) request?.no(new Error(event.error.message)); else request?.yes(event.result);
        return;
      }
      if (event.id !== undefined && event.method) {
        // This photography session does not grant generic shell/filesystem access.
        const result = event.method === 'item/tool/requestUserInput' ? { answers: {} } : { decision: 'decline' };
        child.stdin.write(JSON.stringify({ id: event.id, result }) + '\n');
        emit({ type: 'status', text: 'Agent 请求了未开放的操作；请在聊天中补充条件。' });
        return;
      }
      const params = event.params ?? {};
      if (event.method === 'item/agentMessage/delta') emit({ type: 'delta', text: params.delta ?? '' });
      if (event.method === 'item/started' && params.item?.type === 'mcpToolCall') emit({ type: 'status', text: `正在调用 ${params.item.tool ?? '摄影工具'}` });
      if (event.method === 'turn/started') activeTurn = params.turn?.id;
      if (event.method === 'turn/completed' && !ended) {
        ended = true; signal.removeEventListener('abort', cancel);
        if (params.turn?.status === 'failed') reject(new Error(params.turn.error?.message || 'Codex 回复失败'));
        else if (params.turn?.status === 'interrupted') reject(new Error('已停止'));
        else resolve();
        child.stdin.end(); stopProcess(child);
      }
      if (event.method === 'error' && !params.willRetry) fail(new Error(params.error?.message || 'Codex 出错'));
    }, fail);
    void (async () => {
      await send('initialize', { clientInfo: { name: 'tamatamatori', title: 'Tamatamatori', version: '0.1.0' }, capabilities: {} });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const common = { cwd, approvalPolicy: 'never' };
      const result = session.nativeId
        ? await send('thread/resume', { threadId: session.nativeId, ...common })
        : await send('thread/start', { ...common, developerInstructions: instructions });
      session.nativeId = result.thread.id;
      const turn = await send('turn/start', { threadId: session.nativeId, input: [{ type: 'text', text: message }] });
      activeTurn = turn.turn.id;
    })().catch(fail);
  });
}

export function runClaude({ session, message, cwd, mcp, signal, emit, spawn = startProcess }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { tamatamatori: mcp } }),
      '--allowedTools', 'mcp__tamatamatori__*', '--permission-mode', 'dontAsk', '--max-turns', '16',
      '--append-system-prompt', instructions];
    if (session.nativeId) args.push('--resume', session.nativeId);
    const child = spawn(agentCommand('claude'), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let ended = false;
    const finish = (error) => {
      if (ended) return; ended = true; signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
      stopProcess(child);
    };
    const cancel = () => finish(new Error('已停止'));
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', (error) => finish(new Error(`Claude Code 无法启动：${error.message}`)));
    child.stderr.on('data', () => {});
    child.stdin.on('error', (error) => { if (!ended) finish(error); });
    child.on('close', () => { if (!ended) finish(new Error('Claude Code 在完成回复前退出；需要支持 --restricted 的官方 CLI（2.1.248+）及有效登录')); });
    lines(child, (event) => {
      if (event.session_id) session.nativeId = event.session_id;
      if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') emit({ type: 'delta', text: event.event.delta.text });
      if (event.type === 'assistant') for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') emit({ type: 'status', text: `正在调用 ${block.name}` });
      }
      if (event.type === 'result') {
        if (event.is_error) finish(new Error(event.result || event.errors?.join('\n') || 'Claude Code 回复失败'));
        else finish();
      }
    }, finish);
    child.stdin.end(message);
  });
}
