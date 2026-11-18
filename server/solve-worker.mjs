import { parentPort, workerData } from 'node:worker_threads';
import { prepare, search, resultObject } from '../scripts/lib/solve-run.mjs';
import { parseShotText } from '../src/domain/shots/shot.ts';
import { shotFromPlan } from '../src/domain/shots/shot.ts';
import { limitChatResult } from '../src/domain/solve/chat-results.ts';
try {
  const parsed = parseShotText(JSON.stringify(workerData.shot));
  if (!parsed.ok) throw new Error('当前计划无法读取');
  const prepared = prepare(workerData.request, { shotPlan: parsed.plan });
  if (prepared.status !== 'ready') throw new Error(prepared.errors?.join('\n') || prepared.solvable.message);
  const searched = await search(prepared, { report: (value) => { if (value.stage) parentPort.postMessage({ progress: value.stage }); } });
  if (searched.status !== 'done') throw new Error(searched.message || '推算未完成');
  const { sampler, worker, ...outcome } = searched.outcome;
  const preview = limitChatResult({ ...outcome, kind: 'solve', id: workerData.id,
    base: shotFromPlan(prepared.plan, '推算基础计划'), request: prepared.request, shape: prepared.solvable.shape,
    total: outcome.items.length, items: outcome.items.slice(0, workerData.maxResults ?? 20) });
  parentPort.postMessage({ result: resultObject(prepared, searched, { maxResults: workerData.maxResults ?? 20 }), preview });
} catch (error) { parentPort.postMessage({ error: error.message }); }
