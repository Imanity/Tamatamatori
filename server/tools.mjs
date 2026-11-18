import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { prepare, validation } from '../scripts/lib/solve-run.mjs';
import { parseShotText } from '../src/domain/shots/shot.ts';
import { checkLibrary } from './shot-store.mjs';
import { LOCAL_TOOLS } from './tool-bridge.mjs';
import { randomUUID } from 'node:crypto';
import { limitChatResult, resultSize } from '../src/domain/solve/chat-results.ts';

const structured = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export async function executeTool({ name, arguments: args = {} }, chat, store, emit, signal) {
  if (!LOCAL_TOOLS.some((tool) => tool.name === name)) throw new Error('未开放的摄影工具');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须为对象');
  if (name === 'current_plan') return structured(chat.plan);
  if (name === 'list_shots' || name === 'get_shot') {
    const library = checkLibrary(await store.read());
    if (name === 'list_shots') return structured(library.shots.slice(0, 200).map(({ id, shot }) => ({ id, name: shot.name, position: shot.position, time: shot.time })));
    const entry = library.shots.find((entry) => entry.id === args.id);
    if (!entry) throw new Error('找不到该机位');
    return structured(entry.shot);
  }
  if (name === 'describe_format') {
    if (args.format !== undefined && !['solve', 'shot'].includes(args.format)) throw new Error('未知格式');
    const file = `${args.format || 'solve'}${args.schema ? '.schema.json' : '-format.md'}`;
    return { content: [{ type: 'text', text: await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8') }] };
  }
  if (name === 'propose') {
    if ((args.shot === undefined) === (args.shots === undefined)) throw new Error('请提供 shot 或 shots，两者选一个');
    const input = args.shots ?? [args.shot];
    if (!Array.isArray(input) || !input.length || input.length > 200) throw new Error('一次可提供 1—200 个独立机位');
    const shots = input.map((shot, index) => {
      const parsed = parseShotText(typeof shot === 'string' ? shot : JSON.stringify(shot));
      if (!parsed.ok) throw new Error(`shots[${index}]：${parsed.errors.join('\n')}`);
      return parsed.shot;
    });
    const result = { kind: 'shots', id: randomUUID(), shots, total: shots.length };
    const shown = emit({ type: 'result', result });
    return structured({ proposed: shots.length, shown: shown?.shown ?? shots.length, applied: false, message: '网页已显示机位卡片，不必重复提出。' });
  }
  if (name === 'validate_request') {
    const shot = parseShotText(args.shot ?? JSON.stringify(chat.plan));
    if (!shot.ok) throw new Error(shot.errors.join('\n'));
    return structured(validation(prepare(args.request, { shotPlan: shot.plan })));
  }
  if (name === 'solve') {
    const parsedShot = parseShotText(args.shot ?? JSON.stringify(chat.plan));
    if (!parsedShot.ok) throw new Error(parsedShot.errors.join('\n'));
    const maxResults = args.maxResults ?? 20;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new Error('maxResults 应为 1—200');
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./solve-worker.mjs', import.meta.url), { workerData: { request: args.request, shot: parsedShot.shot, maxResults, id: randomUUID() } });
      let finished = false;
      const done = (error, value) => {
        if (finished) return; finished = true;
        signal.removeEventListener('abort', stop); void worker.terminate();
        if (error) reject(error); else resolve(value);
      };
      const stop = () => done(new Error('推算已取消'));
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) return stop();
      worker.on('message', (message) => {
        if (message.progress) emit({ type: 'status', text: message.progress });
        else if (message.error) done(new Error(message.error));
        else if (message.result) done(null, message);
      });
      worker.on('error', (error) => done(error));
      worker.on('exit', (code) => { if (!finished) done(new Error(`推算线程提前退出（${code}）`)); });
    });
    const preview = limitChatResult(result.preview);
    const shown = emit({ type: 'result', result: preview });
    return structured({ ...result.result, ui: { shown: shown?.shown ?? resultSize(preview), total: preview.total,
      message: '网页已显示推算结果及区间控件，不必为相同结果再次调用 propose。' } });
  }
}
