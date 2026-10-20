import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanEnv, runScript, shellCommand } from './hostScript.js';

const posix = process.platform !== 'win32';
const dir = () => path.join(mkdtempSync(path.join(tmpdir(), 'fleet-script-')), 'scratch');

describe('shellCommand / cleanEnv', () => {
  it('builds per-shell argv; wsl names the env keys in WSLENV', () => {
    expect(shellCommand('bash', 'echo hi', [])).toEqual({ cmd: 'bash', args: ['-c', 'echo hi'], extraEnv: {} });
    expect(shellCommand('pwsh', 'Get-Date', []).args).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Get-Date']);
    expect(shellCommand('wsl:Ubuntu', 'ls', ['FLEET_ARGS', 'TOKEN'])).toEqual({ cmd: 'wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'bash', '-c', 'ls'], extraEnv: { WSLENV: 'FLEET_ARGS:TOKEN' } });
  });
  it('drops everything from the parent env but OS basics', () => {
    expect(cleanEnv({ A: '1' }, { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk', GH_TOKEN: 'g' })).toEqual({ PATH: '/bin', HOME: '/h', A: '1' });
  });
});

describe.runIf(posix)('runScript (posix)', () => {
  it('runs in its scratch dir with only the given env and captures both streams and the exit code', async () => {
    const cwd = dir();
    process.env.SHOULD_NOT_LEAK = 'x';
    const r = await runScript({ shell: 'bash', script: 'pwd; echo "${ARG_ROOM}-${SHOULD_NOT_LEAK:-clean}"; echo oops >&2; echo s > f.txt; exit 10', env: { ARG_ROOM: 'ops' }, cwd, timeoutMs: 10_000 });
    delete process.env.SHOULD_NOT_LEAK;
    expect(r).toMatchObject({ exitCode: 10, timedOut: false, stderr: 'oops\n' });
    expect(r.stdout).toBe(`${cwd}\nops-clean\n`);
    expect(readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('s\n');
  });
  it('kills the whole tree on timeout', async () => {
    const t0 = Date.now();
    const r = await runScript({ shell: 'sh', script: 'sleep 30 & sleep 30; echo never', env: {}, cwd: dir(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it('reports a missing shell instead of throwing', async () => {
    const r = await runScript({ shell: 'pwsh', script: 'x', env: { PATH: '/nonexistent' }, cwd: dir(), timeoutMs: 5_000 });
    expect(r.exitCode).toBe(127);
  });
});
