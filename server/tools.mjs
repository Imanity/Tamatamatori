import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { prepare, validation } from '../scripts/lib/solve-run.mjs';
import { parseShotText } from '../src/domain/shots/shot.ts';
import { checkLibrary } from './shot-store.mjs';
import { LOCAL_TOOLS } from './tool-bridge.mjs';

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
    const parsed = parseShotText(typeof args.shot === 'string' ? args.shot : JSON.stringify(args.shot));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    emit({ type: 'proposal', shot: parsed.shot });
    return structured({ proposed: true, name: parsed.shot.name, applied: false });
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
      const worker = new Worker(new URL('./solve-worker.mjs', import.meta.url), { workerData: { request: args.request, shot: parsedShot.shot, maxResults } });
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
        else if (message.result) done(null, message.result);
      });
      worker.on('error', (error) => done(error));
      worker.on('exit', (code) => { if (!finished) done(new Error(`推算线程提前退出（${code}）`)); });
    });
    for (const item of result.results) {
      const parsed = parseShotText(item.link);
      if (parsed.ok) emit({ type: 'proposal', shot: parsed.shot });
    }
    return structured(result);
  }
}
