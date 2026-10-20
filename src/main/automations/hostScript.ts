// Run a script step's text on the host (#407 Phase 7, `runIn: host`) or, in
// mock mode, as a stand-in for a container. A clean env (a few OS basics +
// the step's env), its own scratch cwd, a timeout that kills the whole tree,
// and capped stdout/stderr.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { ScriptShell } from '../../preload/inboxTypes.js';

export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_STREAM = 1_000_000;
const BASE_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'LANG', 'ComSpec', 'PATHEXT', 'SystemDrive', 'APPDATA', 'LOCALAPPDATA'];

export function shellCommand(shell: ScriptShell, script: string, envKeys: string[]): { cmd: string; args: string[]; extraEnv: Record<string, string> } {
  if (shell === 'bash' || shell === 'sh') return { cmd: shell, args: ['-c', script], extraEnv: {} };
  if (shell === 'pwsh') return { cmd: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', script], extraEnv: {} };
  // wsl.exe needs --exec (never '--'); env crosses interop only when named in WSLENV.
  return { cmd: 'wsl.exe', args: ['-d', shell.slice(4), '--exec', 'bash', '-c', script], extraEnv: { WSLENV: envKeys.join(':') } };
}

export function cleanEnv(stepEnv: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_KEYS) if (base[k] !== undefined) env[k] = base[k] as string;
  return { ...env, ...stepEnv };
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

export function runScript(opts: { shell: ScriptShell; script: string; env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<ScriptResult> {
  mkdirSync(opts.cwd, { recursive: true });
  const { cmd, args, extraEnv } = shellCommand(opts.shell, opts.script, Object.keys(opts.env));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: cleanEnv({ ...opts.env, ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true
    });
    const done = (r: ScriptResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_STREAM) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_STREAM) stderr += d.toString('utf8'); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      done({ exitCode: 127, stdout, stderr: e.code === 'ENOENT' ? `${cmd} isn't installed or isn't on PATH` : String(e.message), timedOut: false });
    });
    child.on('close', (code, signal) => done({ exitCode: code ?? (signal ? 137 : -1), stdout, stderr, timedOut }));
  });
}
