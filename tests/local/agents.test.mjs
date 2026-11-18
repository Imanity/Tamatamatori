import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCodex, runClaude } from '../../server/agents.mjs';

function processDouble(receive, capture) {
  return (command, args, options) => {
    capture({ command, args, options });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1); child.exitCode = null;
    // Exercise pipe boundaries inside Chinese UTF-8 characters as well as JSON tokens.
    const send = (event) => { for (const byte of Buffer.from(JSON.stringify(event) + '\n')) child.stdout.write(Buffer.from([byte])); };
    child.stdin.on('data', (data) => receive(data.toString(), send));
    child.stdin.on('finish', () => receive(null, send));
    return child;
  };
}

test('Codex 适配：初始化、原生 thread、流式文本与恢复参数；不拼接 shell', async () => {
  const session = { id: 'chat' }, events = [], requests = [], invocations = [];
  const spawn = processDouble((line, send) => {
    if (!line) return;
    const request = JSON.parse(line); requests.push(request);
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'thread/start' || request.method === 'thread/resume') send({ id: request.id, result: { thread: { id: 'native-thread' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn' } } });
      send({ method: 'item/agentMessage/delta', params: { delta: '候选' } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  }, (value) => invocations.push(value));
  const options = { session, message: '含 $(命令) 的摄影需求', cwd: process.cwd(), mcp: { command: 'node', args: [] }, signal: new AbortController().signal, emit: (event) => events.push(event), spawn };
  await runCodex(options); await runCodex(options);
  assert.equal(session.nativeId, 'native-thread'); assert.equal(events[0].text, '候选');
  assert.ok(requests.some((request) => request.method === 'thread/resume'));
  assert.ok(invocations.every((value) => !value.args.includes(options.message)));
  assert.ok(invocations[0].args.includes('default_permissions="tamatamatori"'));
  assert.ok(invocations[0].args.includes('features.plugins=false'));
  const mcp = invocations[0].args.find(value => value.startsWith('mcp_servers='));
  assert.match(mcp,/current_plan=\{approval_mode="approve"\}/);
  assert.match(mcp,/enabled_tools=\[/);
  assert.doesNotMatch(mcp,/shell|filesystem/);
});

test('Claude 适配：结构化文本、工具进度、session 恢复与 CLI 工具约束', async () => {
  const events = [], invocations = [], session = { id: 'chat', nativeId: 'claude-session' };
  const spawn = processDouble((line, send) => {
    if (line !== null) return;
    send({ type: 'stream_event', session_id: 'claude-session', event: { delta: { type: 'text_delta', text: '回复' } } });
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__tamatamatori__solve' }] } });
    send({ type: 'result', is_error: false });
  }, (value) => invocations.push(value));
  await runClaude({ session, message: '查找', cwd: process.cwd(), mcp: {}, signal: new AbortController().signal, emit: (event) => events.push(event), spawn });
  assert.equal(events[0].text, '回复'); assert.match(events[1].text, /solve/);
  assert.ok(invocations[0].args.includes('--restricted')); assert.ok(invocations[0].args.includes('--resume'));
  assert.equal(invocations[0].args[invocations[0].args.indexOf('--tools') + 1], '');
});
