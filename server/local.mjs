import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLocalApp } from './app.mjs';
import { lockDirectory } from './shot-store.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('用法：npm run local -- [--port 8787] [--data-dir 绝对或相对路径]\n默认仅监听 127.0.0.1；机位保存在用户数据目录。');
  process.exit(0);
}
for (let index = 0; index < args.length; index += 2) {
  if (!['--port', '--data-dir'].includes(args[index]) || !args[index + 1]) throw new Error('参数无效；使用 --help 查看用法');
}
const option = (key, fallback) => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : fallback; };
const port = Number(option('--port', '8787'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 应为 1—65535');
const defaultData = process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'Tamatamatori')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'tamatamatori');
const dataDir = resolve(option('--data-dir', defaultData));
const distDir = fileURLToPath(new URL('../dist-local/', import.meta.url));
const release = await lockDirectory(dataDir);
const app = createLocalApp({ dataDir, distDir });
app.server.once('error', async (error) => { await release(); console.error(error.message); process.exitCode = 1; });
app.server.listen(port, '127.0.0.1', () => {
  console.log(`Tamatamatori 本地版：http://127.0.0.1:${port}/\n机位目录：${dataDir}\n按 Ctrl+C 关闭。Agent 登录请使用官方终端程序。`);
});
let closing = false;
async function close() {
  if (closing) return; closing = true; await app.stop();
  app.server.close(); app.server.closeAllConnections();
  await release();
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
