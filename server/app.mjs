import { createServer } from 'node:http';
import { readFile, mkdir, readdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ShotStore, StoreError } from './shot-store.mjs';
import { parseShotText } from '../src/domain/shots/shot.ts';
import { runAgent, agentStatus } from './agents.mjs';
import { executeTool } from './tools.mjs';
import { CHAT_CANDIDATES, CHAT_TRACK_POINTS, isChatResult, limitChatResult, resultSize, trackSize } from '../src/domain/solve/chat-results.ts';

const uuid = /^[a-f0-9-]{36}$/;
const cleanError = (error) => String(error.message || error).replace(/sk-[\w-]+/g, '[密钥]').slice(0, 1000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
async function body(request) {
  let bytes = 0; const chunks = [];
  for await (const part of request) { bytes += part.length; if (bytes > 8_000_000) throw new StoreError('请求过大', 413); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StoreError('JSON 无法读取'); }
}

export function createLocalApp({ dataDir, distDir, agent = runAgent, status = agentStatus, tool = executeTool, turnTimeout = 300_000 }) {
  const store = new ShotStore(dataDir);
  const token = randomBytes(32).toString('hex');
  const running = new Map();
  const inFlight = new Set();
  const chatDirectory = join(dataDir, 'chats');
  let metadataQueue = Promise.resolve();
  const persist = (chat) => {
    const task = metadataQueue.then(async () => {
      await mkdir(chatDirectory, { recursive: true });
      const file = join(chatDirectory, `${chat.id}.json`), temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(chat), { mode: 0o600 }); await rename(temporary, file);
    });
    metadataQueue = task.catch(() => {}); return task;
  };
  const loadChat = async (id) => {
    if (!uuid.test(id)) throw new StoreError('无效聊天 id');
    try { return JSON.parse(await readFile(join(chatDirectory, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new StoreError('聊天不存在', 404); throw error; }
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const origin = `http://${request.headers.host}`;
    const host = `127.0.0.1:${server.address()?.port}`;
    const cookieName = `tmt_local_${server.address()?.port}=`;
    if (![host, `localhost:${server.address()?.port}`].includes(request.headers.host)) return json(response, { error: 'Host 不匹配' }, 403);
    const pathname = new URL(request.url, origin).pathname;
    const secretMatches = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
    const cookie = request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(cookieName))?.slice(cookieName.length);
    const agentToken = request.headers.authorization?.replace(/^Bearer /, '');
    const internal = pathname === '/api/tools' && typeof agentToken === 'string' && [...running.values()].some((active) => active.token === agentToken);
    try {
      if (!pathname.startsWith('/api/')) {
        if (request.method !== 'GET') return json(response, { error: 'Method not allowed' }, 405);
        const file = resolve(distDir, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(resolve(distDir) + sep)) throw new StoreError('无效路径', 403);
        const content = await readFile(file);
        if (pathname === '/' || pathname === '/index.html') response.setHeader('Set-Cookie', `${cookieName}${token}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return response.end(content);
      }
      if (!internal && !secretMatches(cookie)) throw new StoreError('请从本地服务首页打开应用', 401);
      if (!internal && request.headers.origin && request.headers.origin !== origin) throw new StoreError('不接受外部网页请求', 403);
      if (!internal && request.method !== 'GET' && request.headers.origin !== origin) throw new StoreError('缺少同源请求信息', 403);
      if (pathname === '/api/shots') {
        if (request.method === 'GET') return json(response, await store.read());
        if (request.method === 'PUT') return json(response, await store.save(await body(request)));
      }
      if (pathname === '/api/capabilities' && request.method === 'GET') return json(response, { local: true, storage: 'file', chat: true });
      if (pathname === '/api/agents' && request.method === 'GET') return json(response, await Promise.all(['codex', 'claude'].map(status)));
      if (pathname === '/api/chats' && request.method === 'GET') {
        const files = await readdir(chatDirectory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        const chats = await Promise.all(files.filter((file) => /^[a-f0-9-]{36}\.json$/.test(file)).map(async (file) => {
          const chat = await loadChat(file.slice(0, -5));
          return { id: chat.id, provider: chat.provider, title: chat.title, updatedAt: chat.updatedAt };
        }));
        return json(response, chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
      if (/^\/api\/chats\/[^/]+$/.test(pathname) && request.method === 'GET') return json(response, await loadChat(pathname.split('/').at(-1)));
      if (pathname === '/api/stop' && request.method === 'POST') {
        const { id } = await body(request); running.get(id)?.controller.abort(); return json(response, { stopped: true });
      }
      if (pathname === '/api/tools' && request.method === 'POST') {
        if (!internal) throw new StoreError('仅供本机 Agent 工具使用', 403);
        const input = await body(request), active = running.get(input.chatId);
        if (!active || active.token !== agentToken) throw new StoreError('聊天未运行或工具会话不匹配', 409);
        if (++active.calls > 40) { active.controller.abort(); throw new StoreError('本轮工具调用过多，已停止'); }
        const controller = new AbortController();
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        const signal = AbortSignal.any([active.controller.signal, controller.signal]);
        try { return json(response, await tool(input, active.chat, store, active.emit, signal)); }
        catch (error) { return json(response, { isError: true, content: [{ type: 'text', text: cleanError(error) }] }); }
      }
      if (pathname === '/api/chat' && request.method === 'POST') {
        const input = await body(request);
        if (!['codex', 'claude'].includes(input.provider) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000)
          throw new StoreError('请选择 Agent，并输入不超过 20000 字的消息');
        const parsed = parseShotText(JSON.stringify(input.plan));
        if (!parsed.ok) throw new StoreError(`当前计划无效：${parsed.errors[0]}`);
        const chat = input.id ? await loadChat(input.id) : { id: randomUUID(), provider: input.provider, title: input.message.slice(0, 50), messages: [] };
        if (chat.provider !== input.provider) throw new StoreError('切换 Agent 请新建对话');
        if (running.has(chat.id)) throw new StoreError('上一轮尚未完成', 409);
        if (running.size >= 2) throw new StoreError('同时最多运行两个对话', 429);
        chat.plan = parsed.shot; chat.updatedAt = new Date().toISOString();
        chat.messages.push({ role: 'user', text: input.message });
        const assistant = { role: 'assistant', text: '', proposals: [], results: [] };
        chat.messages.push(assistant);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const emit = (event) => {
          if (event.type === 'delta') {
            if (assistant.text.length > 200000) { controller.abort(); return; }
            assistant.text += event.text;
          }
          if (event.type === 'proposal') {
            if (assistant.proposals.length >= 40) {
              if (!response.destroyed) response.write(`data: ${JSON.stringify({ type: 'status', text: '旧格式机位卡片最多 40 个，请改用分组结果或缩小范围。' })}\n\n`);
              return;
            }
            assistant.proposals.push(event.shot);
          }
          if (event.type === 'result') {
            if (!isChatResult(event.result)) throw new Error('聊天结果格式无效');
            const used = assistant.results.reduce((count, result) => count + resultSize(result), 0);
            const points = assistant.results.reduce((count, result) => count + trackSize(result), 0);
            const result = limitChatResult(event.result, Math.max(0, CHAT_CANDIDATES - used), Math.max(0, CHAT_TRACK_POINTS - points));
            assistant.results.push(result);
            if (!response.destroyed) response.write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
            return { shown: resultSize(result), total: result.total };
          }
          if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const controller = new AbortController();
        let complete;
        const settled = new Promise((resolve) => { complete = resolve; });
        inFlight.add(settled);
        const toolToken = randomBytes(32).toString('hex');
        running.set(chat.id, { controller, chat, emit, calls: 0, token: toolToken });
        emit({ type: 'session', id: chat.id });
        const timer = setTimeout(() => controller.abort(), turnTimeout);
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
        try {
          await persist(chat);
          const cwd = join(dataDir, 'agent-workspace'); await mkdir(cwd, { recursive: true });
          await agent({ provider: chat.provider, session: chat, message: input.message, cwd,
            url: `http://${host}`, token: toolToken, signal: controller.signal, emit });
          emit({ type: 'done' });
        } catch (error) {
          assistant.error = controller.signal.aborted ? '已停止' : cleanError(error);
          emit({ type: 'error', text: assistant.error });
        } finally {
          clearTimeout(timer); clearInterval(heartbeat);
          chat.updatedAt = new Date().toISOString();
          try { await persist(chat); } catch { emit({ type: 'error', text: '聊天记录写盘失败，请保留当前页面内容' }); }
          running.delete(chat.id);
          response.end();
          complete(); inFlight.delete(settled);
        }
        return;
      }
      throw new StoreError('接口不存在', 404);
    } catch (error) {
      if (!response.headersSent) json(response, { error: cleanError(error) }, error.status || (error.code === 'ENOENT' ? 404 : 500));
      else response.end();
    }
  });
  server.on('close', () => { for (const active of running.values()) active.controller.abort(); });
  return { server, store, stop: async () => {
    for (const active of running.values()) active.controller.abort();
    await Promise.all([...inFlight]); await metadataQueue; await store.queue;
  } };
}
