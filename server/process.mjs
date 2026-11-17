import { spawn } from 'node:child_process';

export function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  }
}

export function startProcess(command, args, options = {}) {
  return spawn(command, args, { windowsHide: true, detached: process.platform !== 'win32', ...options, shell: false });
}

export function capture(command, args, { timeout = 5000, ...options } = {}) {
  return new Promise((resolve) => {
    const child = startProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { stopProcess(child); resolve({ ok: false, output: '程序响应超时' }); }, timeout);
    const collect = (part) => { output += part; if (output.length > 64000) stopProcess(child); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, output: error.code === 'ENOENT' ? '未找到程序' : error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() }); });
  });
}

/** Auth is inherited only by the official program, never copied into the web UI. */
export const agentCommand = (provider) => provider === 'codex' ? process.env.TMT_CODEX_PATH || 'codex' : process.env.TMT_CLAUDE_PATH || 'claude';

/** Do not attach a child agent to the launching Codex desktop chat or its tools pipe. */
export function agentEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^CODEX_/.test(key) || key === 'CODEX_HOME'));
}
