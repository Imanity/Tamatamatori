import { createInterface } from 'node:readline';
import { TOOLS } from '../scripts/mcp.mjs';

export const LOCAL_TOOLS = [
  ...TOOLS,
  { name: 'current_plan', description: '读取本次聊天附带的当前拍摄计划快照。', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_shots', description: '列出本机保存的机位摘要，不修改机位。', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_shot', description: '按 id 读取已保存的一个机位。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'propose', description: '提供一个机位（机位 JSON 对象或 #shot 链接），在网页显示候选卡片。不会自动修改计划或保存。', inputSchema: { type: 'object', properties: { shot: { anyOf: [{ type: 'object' }, { type: 'string' }] } }, required: ['shot'] } },
];

if (process.env.TMT_CHAT_ID) {
  const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const controllers = new Map();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async (line) => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.method === 'notifications/cancelled') { controllers.get(value.params?.requestId)?.abort(); return; }
    if (value.id === undefined) return;
    try {
      if (value.method === 'initialize') write({ id: value.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'tamatamatori-local', version: '0.1.0' } } });
      else if (value.method === 'ping') write({ id: value.id, result: {} });
      else if (value.method === 'tools/list') write({ id: value.id, result: { tools: LOCAL_TOOLS } });
      else if (value.method === 'tools/call') {
        const controller = new AbortController(); controllers.set(value.id, controller);
        try {
          const response = await fetch(`${process.env.TMT_LOCAL_URL}/api/tools`, { method: 'POST', signal: controller.signal,
            headers: { Authorization: `Bearer ${process.env.TMT_TOOL_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: process.env.TMT_CHAT_ID, ...value.params }) });
          const result = await response.json();
          write({ id: value.id, result: response.ok ? result : { isError: true, content: [{ type: 'text', text: result.error || '工具失败' }] } });
        } finally { controllers.delete(value.id); }
      } else write({ id: value.id, error: { code: -32601, message: 'Unknown method' } });
    } catch (error) { write({ id: value.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
  });
  input.on('close', () => { for (const controller of controllers.values()) controller.abort(); });
}
