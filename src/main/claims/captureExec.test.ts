import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
const { runCapture, spawnCaptureProcess, killLocalCaptures, resolveCaptureTarget } = await import('./captureExec.js');

describe('runCapture', () => {
  it('container: cds into the session cwd and runs quoted claude args via execScript', async () => {
    const execScript = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'container', workspaceId: 'w1', cwd: '/workspace/app' }, ['-p', "it's"], 300_000,
      { execScript, containerMcpConfig: () => '{"mcpServers":{}}' } as never);
    // NOTE: the brief's expected script used double-quote embedding
    // (`'it'"'"'s'`) for the escaped apostrophe, but the real `posixQuote` in
    // localLauncher.ts uses backslash-escaping (`'it'\''s'`) — verified by
    // reading the helper. Fixed the expectation to match real behavior rather
    // than weakening it.
    expect(execScript).toHaveBeenCalledWith('w1', expect.objectContaining({
      automationId: 'knowledge-capture', timeoutMs: 300_000,
      // The fleet-state-only inline --mcp-config pairs with the fork's
      // --strict-mcp-config, so no other server in ~/.claude.json loads.
      script: `cd '/workspace/app' && exec claude '-p' 'it'\\''s' '--mcp-config' '{"mcpServers":{}}'`
    }));
  });

  it('wsl: runs claude through wsl.exe --exec with the in-distro cwd, forwarding WSLENV + --mcp-config', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    const launcher = { mode: 'wsl', distro: 'Ubuntu', shell: '/bin/bash', home: '/home/t', claudePath: '/home/t/.local/bin/claude', interop: true } as never;
    await runCapture({ kind: 'local', workspaceId: 'w2', launcher, workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\t\\repo' }, ['-p', 'x'], 1000,
      {
        spawnFile,
        buildEnv: async () => ({ ANTHROPIC_API_KEY: 'sk-x', PATH: '/usr/bin' }),
        // Per-workspace keys (not matching ANTHROPIC_/CLAUDE_) must still cross
        // the WSL boundary, exactly like a real session's passEnvKeys.
        workspaceEnvKeys: async () => ['MY_WORKSPACE_TOKEN'],
        ensureMcpConfig: async () => 'C:\\Users\\t\\mcp.json',
        resolveClaude: async () => 'claude'
      } as never);
    const [file, args, opts] = spawnFile.mock.calls[0] as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }];
    expect(file).toBe('wsl.exe');
    expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/home/t/repo', '--exec', '/bin/bash']);
    // --mcp-config is appended to the claude invocation, translated into the
    // in-distro /mnt/<drive> form (claude reads it INSIDE the distro).
    // In-distro backstop: killing wsl.exe on the host doesn't reach the Linux
    // process, so coreutils timeout (5s past the host timer, then SIGKILL) does.
    expect(args[7]).toBe(`exec timeout -k 10 6 '/home/t/.local/bin/claude' '-p' 'x' '--mcp-config' '/mnt/c/Users/t/mcp.json'`);
    // wsl.exe itself needs a valid WINDOWS cwd (the Linux cwd rides --cd),
    // same as wrapSpawnForLauncher's windowsCwd — not process.cwd().
    expect(opts.cwd).toBe(homedir());
    // Auth/endpoint vars (ANTHROPIC_*) and per-workspace keys must actually
    // cross the wsl.exe boundary via WSLENV, or the forked claude can't
    // authenticate like the workspace's real sessions do.
    expect(opts.env.WSLENV).toContain('ANTHROPIC_API_KEY/u');
    expect(opts.env.WSLENV).toContain('MY_WORKSPACE_TOKEN/u');
  });

  it('native: spawns the resolved claude binary in the workspace root with --mcp-config appended', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'local', workspaceId: 'w3', launcher: { mode: 'native' }, workspaceRoot: '/repo' }, ['-p', 'x'], 1000,
      {
        spawnFile,
        buildEnv: async () => ({ A: '1' }),
        workspaceEnvKeys: async () => [],
        ensureMcpConfig: async () => '/home/t/.config/fleet/mcp/w3/mcp.json',
        resolveClaude: async () => '/usr/bin/claude'
      } as never);
    expect(spawnFile).toHaveBeenCalledWith(
      '/usr/bin/claude',
      ['-p', 'x', '--mcp-config', '/home/t/.config/fleet/mcp/w3/mcp.json'],
      expect.objectContaining({ cwd: '/repo', timeoutMs: 1000 })
    );
  });

  it('native: appends --settings with the retention file when provided (#483 §5a)', async () => {
    const retentionSettings = vi.fn(async (_id: string, _l: unknown) => '/state/w5/claude-retention.settings.json');
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'local', workspaceId: 'w5', launcher: { mode: 'native' }, workspaceRoot: '/repo' }, ['-p', 'x'], 1000,
      {
        spawnFile,
        buildEnv: async () => ({}),
        workspaceEnvKeys: async () => [],
        ensureMcpConfig: async () => undefined,
        resolveClaude: async () => '/usr/bin/claude',
        retentionSettings
      } as never);
    // The launcher decides whose ~/.claude/settings.json the only-raise check reads.
    expect(retentionSettings).toHaveBeenCalledWith('w5', { mode: 'native' });
    expect(spawnFile).toHaveBeenCalledWith('/usr/bin/claude', ['-p', 'x', '--settings', '/state/w5/claude-retention.settings.json'], expect.anything());
  });

  it('native: omits --mcp-config when ensureMcpConfig has nothing to offer yet', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'local', workspaceId: 'w4', launcher: { mode: 'native' }, workspaceRoot: '/repo' }, ['-p', 'x'], 1000,
      {
        spawnFile,
        buildEnv: async () => ({ A: '1' }),
        workspaceEnvKeys: async () => [],
        ensureMcpConfig: async () => undefined,
        resolveClaude: async () => '/usr/bin/claude'
      } as never);
    expect(spawnFile).toHaveBeenCalledWith('/usr/bin/claude', ['-p', 'x'], expect.objectContaining({ cwd: '/repo', timeoutMs: 1000 }));
  });

  it('native: degradation when retentionSettings rejects — still spawns, args contain no --settings', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'local', workspaceId: 'w6', launcher: { mode: 'native' }, workspaceRoot: '/repo' }, ['-p', 'x'], 1000,
      {
        spawnFile,
        buildEnv: async () => ({}),
        workspaceEnvKeys: async () => [],
        ensureMcpConfig: async () => '/etc/mcp.json',
        resolveClaude: async () => '/usr/bin/claude',
        retentionSettings: async () => { throw new Error('retention write failed'); }
      } as never);
    // Should still spawn despite the retention failure, with --mcp-config but no --settings
    expect(spawnFile).toHaveBeenCalledWith(
      '/usr/bin/claude',
      ['-p', 'x', '--mcp-config', '/etc/mcp.json'],
      expect.objectContaining({ cwd: '/repo', timeoutMs: 1000 })
    );
  });

  it('wsl: appends --settings with the WSL-translated path when retentionSettings succeeds (#483 §5a)', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    const launcher = { mode: 'wsl', distro: 'Ubuntu', shell: '/bin/bash', home: '/home/t', claudePath: '/home/t/.local/bin/claude', interop: true } as never;
    await runCapture({ kind: 'local', workspaceId: 'w7', launcher, workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\t\\repo' }, ['-p', 'x'], 1000,
      {
        spawnFile,
        buildEnv: async () => ({ ANTHROPIC_API_KEY: 'sk-x' }),
        workspaceEnvKeys: async () => [],
        ensureMcpConfig: async () => 'C:\\Users\\t\\mcp.json',
        resolveClaude: async () => 'claude',
        retentionSettings: async () => 'C:\\state\\w7\\claude-retention.settings.json'
      } as never);
    const [file, args] = spawnFile.mock.calls[0] as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }];
    expect(file).toBe('wsl.exe');
    // args[7] should be the full exec command with --settings appended and WSL-translated path
    expect(args[7]).toContain("'--settings'");
    expect(args[7]).toContain("'/mnt/c/state/w7/claude-retention.settings.json'");
  });
});

describe('resolveCaptureTarget', () => {
  const manifests: Record<string, unknown> = {
    c1: { id: 'c1', kind: 'container', workspaceSubdir: 'app' },
    c2: { id: 'c2', kind: 'container', workspaceSubdir: '' },
    l1: { id: 'l1', kind: 'local', workspaceRoot: '/repo' }
  };
  const deps = (running: Set<string>) => ({
    readManifest: async (id: string) => (manifests[id] ?? null) as never,
    containerRunning: vi.fn(async (id: string) => running.has(id))
  });
  it('skips a container that is not running (no fork, no daily-cap slot) and resolves running/local ones', async () => {
    const d = deps(new Set(['c2']));
    expect(await resolveCaptureTarget('c1', d)).toBeNull();
    expect(await resolveCaptureTarget('c2', d)).toEqual({ kind: 'container', workspaceId: 'c2', cwd: '/workspace' });
    expect(await resolveCaptureTarget('l1', d)).toEqual({ kind: 'local', workspaceId: 'l1', launcher: { mode: 'native' }, workspaceRoot: '/repo' });
    expect(await resolveCaptureTarget('gone', d)).toBeNull();
    expect(d.containerRunning).not.toHaveBeenCalledWith('l1');
  });
  it('treats a failed container-state lookup (daemon down) as not running', async () => {
    expect(await resolveCaptureTarget('c1', { ...deps(new Set()), containerRunning: async () => { throw new Error('daemon down'); } })).toBeNull();
  });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (f: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return f();
};

describe.skipIf(process.platform === 'win32')('local fork processes (spawnCaptureProcess)', () => {
  // A stand-in fork that ignores SIGTERM and leaves a grandchild behind: an
  // execFile timeout (SIGTERM to the direct child only) would leak both.
  const stubborn = (pidFile: string) => ['-c', `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`];

  it('kills the whole tree with SIGKILL on timeout and reports timedOut', async () => {
    const pidFile = `${tmpdir()}/capture-tree-${process.pid}-${Date.now()}`;
    const t0 = Date.now();
    const out = await spawnCaptureProcess('/bin/sh', stubborn(pidFile), { cwd: tmpdir(), env: process.env, timeoutMs: 300 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  });

  it('killLocalCaptures kills in-flight forks (scheduler stop / app quit)', async () => {
    const pidFile = `${tmpdir()}/capture-quit-${process.pid}-${Date.now()}`;
    const p = spawnCaptureProcess('/bin/sh', stubborn(pidFile), { cwd: tmpdir(), env: process.env, timeoutMs: 60_000 });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    expect(killLocalCaptures()).toBe(1);
    const out = await p;
    expect(out.timedOut).toBe(false);
    expect(out.exitCode).not.toBe(0);
    expect(await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true);
    expect(killLocalCaptures()).toBe(0);
  });

  it('collects stdout and the exit code of a normal run', async () => {
    expect(await spawnCaptureProcess('/bin/sh', ['-c', 'echo hi; exit 3'], { cwd: tmpdir(), env: process.env, timeoutMs: 5000 }))
      .toEqual({ exitCode: 3, stdout: 'hi\n', stderr: '', timedOut: false });
  });
});
