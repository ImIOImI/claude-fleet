import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
const { runCapture } = await import('./captureExec.js');

describe('runCapture', () => {
  it('container: cds into the session cwd and runs quoted claude args via execScript', async () => {
    const execScript = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'container', workspaceId: 'w1', cwd: '/workspace/app' }, ['-p', "it's"], 300_000, { execScript } as never);
    // NOTE: the brief's expected script used double-quote embedding
    // (`'it'"'"'s'`) for the escaped apostrophe, but the real `posixQuote` in
    // localLauncher.ts uses backslash-escaping (`'it'\''s'`) — verified by
    // reading the helper. Fixed the expectation to match real behavior rather
    // than weakening it.
    expect(execScript).toHaveBeenCalledWith('w1', expect.objectContaining({
      automationId: 'knowledge-capture', timeoutMs: 300_000,
      script: `cd '/workspace/app' && exec claude '-p' 'it'\\''s'`
    }));
  });
  it('wsl: runs claude through wsl.exe --exec with the in-distro cwd', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    const launcher = { mode: 'wsl', distro: 'Ubuntu', shell: '/bin/bash', home: '/home/t', claudePath: '/home/t/.local/bin/claude', interop: true } as never;
    await runCapture({ kind: 'local', workspaceId: 'w2', launcher, workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\t\\repo' }, ['-p', 'x'], 1000,
      { spawnFile, buildEnv: async () => ({}), ensureMcpConfig: async () => undefined, resolveClaude: async () => 'claude' } as never);
    const [file, args] = spawnFile.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('wsl.exe');
    expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/home/t/repo', '--exec', '/bin/bash']);
    expect(args[7]).toBe(`exec '/home/t/.local/bin/claude' '-p' 'x'`);
  });
  it('native: spawns the resolved claude binary in the workspace root', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'local', workspaceId: 'w3', launcher: { mode: 'native' }, workspaceRoot: '/repo' }, ['-p', 'x'], 1000,
      { spawnFile, buildEnv: async () => ({ A: '1' }), ensureMcpConfig: async () => undefined, resolveClaude: async () => '/usr/bin/claude' } as never);
    expect(spawnFile).toHaveBeenCalledWith('/usr/bin/claude', ['-p', 'x'], expect.objectContaining({ cwd: '/repo', timeoutMs: 1000 }));
  });
});
