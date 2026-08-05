import { describe, it, expect } from 'vitest';
import {
  posixQuote,
  uncToLinuxPath,
  linuxPathToUnc,
  windowsPathToWslPath,
  wslPidFile,
  buildWslSpawnEnv,
  wrapSpawnForLauncher,
  wslLocalProjectsDir,
  type WorkspaceLauncher
} from './localLauncher.js';
import type { SpawnPty, PtyProc } from './localSessions.js';

const fakeProc: PtyProc = {
  pid: 1, write() {}, resize() {}, kill() {}, onData() {}, onExit() {}
};

/** Capture-spawn: records the transformed spawn call. */
function captureSpawn(): { spawn: SpawnPty; calls: Parameters<SpawnPty>[0][] } {
  const calls: Parameters<SpawnPty>[0][] = [];
  return { calls, spawn: (o) => { calls.push(o); return fakeProc; } };
}

describe('posixQuote', () => {
  it('wraps in single quotes', () => expect(posixQuote('abc')).toBe(`'abc'`));
  it('escapes embedded single quotes', () =>
    expect(posixQuote(`a'b`)).toBe(`'a'\\''b'`));
});

describe('path translation', () => {
  it('uncToLinuxPath handles wsl.localhost', () =>
    expect(uncToLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\troy\\x')).toEqual({
      distro: 'Ubuntu', path: '/home/troy/x'
    }));
  it('uncToLinuxPath handles legacy wsl$', () =>
    expect(uncToLinuxPath('\\\\wsl$\\Debian\\tmp')).toEqual({ distro: 'Debian', path: '/tmp' }));
  it('uncToLinuxPath returns null for non-UNC', () =>
    expect(uncToLinuxPath('C:\\Users\\troy')).toBeNull());
  it('linuxPathToUnc round-trips', () =>
    expect(linuxPathToUnc('Ubuntu', '/home/troy/x')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\troy\\x'));
  it('windowsPathToWslPath maps drive letters', () =>
    expect(windowsPathToWslPath('C:\\Users\\troy\\AppData')).toBe('/mnt/c/Users/troy/AppData'));
  it('windowsPathToWslPath returns null for relative', () =>
    expect(windowsPathToWslPath('foo\\bar')).toBeNull());
});

describe('buildWslSpawnEnv', () => {
  it('sets vars and appends /u flags to WSLENV', () => {
    const env = buildWslSpawnEnv({ PATH: 'x', WSLENV: 'EXISTING/p' }, ['ANTHROPIC_API_KEY']);
    expect(env.WSLENV).toBe('EXISTING/p:ANTHROPIC_API_KEY/u');
  });
  it('creates WSLENV when absent', () => {
    const env = buildWslSpawnEnv({}, ['A', 'B']);
    expect(env.WSLENV).toBe('A/u:B/u');
  });
});

describe('wrapSpawnForLauncher — native', () => {
  it('passes through untouched', () => {
    const { spawn, calls } = captureSpawn();
    const wrapped = wrapSpawnForLauncher({ mode: 'native' }, spawn, {
      workspaceId: 'ws1', platform: 'linux'
    });
    wrapped({ file: '/usr/bin/claude', args: ['--resume', 'u'], cwd: '/repo', cols: 80, rows: 24, env: {} });
    expect(calls[0].file).toBe('/usr/bin/claude');
    expect(calls[0].args).toEqual(['--resume', 'u']);
    expect(calls[0].cwd).toBe('/repo');
  });
});

describe('wrapSpawnForLauncher — wsl', () => {
  const launcher: WorkspaceLauncher = {
    mode: 'wsl', distro: 'Ubuntu', shell: '/usr/bin/zsh',
    home: '/home/troy', claudePath: '/home/troy/.local/bin/claude'
  };
  it('builds the wsl.exe -lic command with pidfile + exec', () => {
    const { spawn, calls } = captureSpawn();
    const wrapped = wrapSpawnForLauncher(launcher, spawn, {
      workspaceId: 'ws1', platform: 'win32', windowsCwd: 'C:\\Users\\troy'
    });
    wrapped({
      file: 'ignored-host-claude', args: ['--mcp-config', '/mnt/c/x/mcp.json', '--session-id', 'u1'],
      cwd: '/home/troy/proj', cols: 80, rows: 24,
      env: { CLAUDE_FLEET_BROKER_SESSION_ID: 'sess1', ANTHROPIC_API_KEY: 'k' }
    });
    const c = calls[0];
    expect(c.file).toBe('wsl.exe');
    expect(c.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--cd', '/home/troy/proj', '--']);
    expect(c.args[5]).toBe('/usr/bin/zsh');
    expect(c.args[6]).toBe('-lic');
    const cmd = c.args[7];
    expect(cmd).toContain(`echo $$ > '/tmp/claude-fleet-ws1-sess1.pid'`);
    expect(cmd).toContain(`exec '/home/troy/.local/bin/claude' '--mcp-config' '/mnt/c/x/mcp.json' '--session-id' 'u1'`);
    // wsl.exe itself runs from a valid WINDOWS cwd — the Linux cwd went via --cd
    expect(c.cwd).toBe('C:\\Users\\troy');
    // env vars claude needs inside the distro are WSLENV-forwarded
    expect(c.env.WSLENV).toContain('ANTHROPIC_API_KEY/u');
    expect(c.env.WSLENV).toContain('CLAUDE_FLEET_BROKER_SESSION_ID/u');
  });
  it('throws off-win32', () => {
    const { spawn } = captureSpawn();
    expect(() =>
      wrapSpawnForLauncher(launcher, spawn, { workspaceId: 'w', platform: 'linux' })
    ).toThrow(/win32/);
  });
  it('throws when windowsCwd is missing', () => {
    const { spawn } = captureSpawn();
    expect(() =>
      wrapSpawnForLauncher(launcher, spawn, { workspaceId: 'w', platform: 'win32' })
    ).toThrow(/windowsCwd/);
  });
});

describe('wrapSpawnForLauncher — custom', () => {
  it('substitutes {claude} and {args} and runs via sh -c on POSIX', () => {
    const { spawn, calls } = captureSpawn();
    const wrapped = wrapSpawnForLauncher(
      { mode: 'custom', command: 'my-wrap {claude} {args}' }, spawn,
      { workspaceId: 'w', platform: 'linux' }
    );
    wrapped({ file: '/usr/bin/claude', args: ['--resume', 'u'], cwd: '/repo', cols: 80, rows: 24, env: {} });
    expect(calls[0].file).toBe('sh');
    expect(calls[0].args).toEqual(['-c', `my-wrap '/usr/bin/claude' '--resume' 'u'`]);
    expect(calls[0].cwd).toBe('/repo');
  });
  it('appends {args} when the template omits it', () => {
    const { spawn, calls } = captureSpawn();
    const wrapped = wrapSpawnForLauncher(
      { mode: 'custom', command: 'claude-via-proxy' }, spawn,
      { workspaceId: 'w', platform: 'linux' }
    );
    wrapped({ file: '/usr/bin/claude', args: ['--resume', 'u'], cwd: '/repo', cols: 80, rows: 24, env: {} });
    expect(calls[0].args).toEqual(['-c', `claude-via-proxy '--resume' 'u'`]);
  });
  it('uses cmd.exe /d /s /c on win32', () => {
    const { spawn, calls } = captureSpawn();
    const wrapped = wrapSpawnForLauncher(
      { mode: 'custom', command: 'wrap.cmd {args}' }, spawn,
      { workspaceId: 'w', platform: 'win32' }
    );
    wrapped({ file: 'C:\\bin\\claude.exe', args: ['--resume', 'u'], cwd: 'C:\\repo', cols: 80, rows: 24, env: {} });
    expect(calls[0].file).toBe('cmd.exe');
    expect(calls[0].args[0]).toBe('/d');
    expect(calls[0].args[1]).toBe('/s');
    expect(calls[0].args[2]).toBe('/c');
  });
});

describe('wslLocalProjectsDir', () => {
  it('builds the UNC transcript dir from distro + home + encoded cwd', () => {
    const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
    expect(wslLocalProjectsDir('Ubuntu', '/home/troy', '/home/troy/proj', encode)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\troy\\.claude\\projects\\-home-troy-proj'
    );
  });
});
