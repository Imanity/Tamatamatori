import { mkdir, readFile, open, rename, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLibrary } from '../src/domain/shots/shot-library.ts';

export class StoreError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function checkLibrary(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.shots) || data.shots.length > 2000)
    throw new StoreError('机位库格式无效（version 1，最多 2000 条）');
  const ids = new Set();
  for (const entry of data.shots) {
    // Preserve unreadable entries for recovery, as the browser library does.
    if (!entry || typeof entry.id !== 'string') continue;
    if (ids.has(entry.id)) throw new StoreError('机位库包含重复 id');
    ids.add(entry.id);
  }
  return readLibrary({ getItem: () => JSON.stringify(data) });
}

export class ShotStore {
  constructor(directory) { this.directory = directory; this.file = join(directory, 'shots.json'); this.queue = Promise.resolve(); }
  async read() {
    let text;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, revision: 0, shots: [] }; throw error; }
    try {
      const value = JSON.parse(text);
      checkLibrary(value);
      if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('revision');
      return value;
    } catch { throw new StoreError('机位库文件无法读取，已停止覆盖。请检查 shots.json 或从 shots.json.bak 恢复。', 409); }
  }
  save(input) {
    const run = this.queue.then(async () => {
      checkLibrary(input);
      const previous = await this.read();
      if (input.revision !== previous.revision) throw new StoreError('机位库已被其他窗口修改，请重新读取后再保存。', 409);
      const next = { version: 1, revision: previous.revision + 1, shots: input.shots };
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        if (previous.revision) await copyFile(this.file, `${this.file}.bak`);
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => {}); }
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** One HTTP server owns the directory; a crash leaves a reclaimable PID lock. */
export async function lockDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'server.lock');
  try {
    const handle = await open(file, 'wx', 0o600);
    await handle.writeFile(String(process.pid)); await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(file, 'utf8'));
    let live = true;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (cause) { if (cause.code === 'ESRCH') live = false; }
    }
    if (live) throw new Error('该数据目录已有本地服务运行；请关闭原服务或选择另一目录。');
    await unlink(file);
    return lockDirectory(directory);
  }
  return async () => { await unlink(file).catch(() => {}); };
}
