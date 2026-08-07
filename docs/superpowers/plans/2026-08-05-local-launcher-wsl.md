# Local-Workspace Launcher (WSL + Custom Command) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace launcher for local workspaces — native (default), WSL distro + login shell (Windows only, fully probed), or free-form custom command — with transcript observability and fleet-state MCP working across the Windows↔WSL boundary.

**Architecture:** A `launcher` union on the workspace manifest; a pure `localLauncher.ts` that wraps the injected `SpawnPty` factory so `localSessions.ts` is untouched; a pure `wslProbe.ts` for distro/shell/claude discovery behind two new win32-only IPC channels; a second polling chokidar instance in `jsonlWatcher` for `\\wsl.localhost\` roots; the existing Electron-as-node MCP bridge invoked through WSL Windows-interop (`/mnt/c/...` exe path).

**Tech Stack:** Electron main (TS, CommonJS bundle), node-pty, chokidar v5, vitest (pure modules only — no Electron ABI), Playwright e2e, `wsl.exe` CLI.

**Spec:** `docs/superpowers/specs/2026-08-05-local-launcher-wsl-design.md` (issue #253).

## Global Constraints

- Work in the worktree `/workspace/claude-fleet/.claude/worktrees/local-launcher-wsl-spec` (branch `worktree-local-launcher-wsl-spec`). Never `cd` to `/workspace/claude-fleet` itself.
- Pure main-process modules (`localLauncher.ts`, `wslProbe.ts`) must import NOTHING from `electron`, `node-pty`, or `better-sqlite3` — that's what makes them vitest-loadable. Follow the `claudeResolve.ts` injected-deps pattern.
- `launcher.mode: 'wsl'` is valid only when `process.platform === 'win32'`; `mode: 'custom'` is valid on all platforms; absent launcher ⇒ native (no migration).
- `docs/SPEC.md` must be updated in the same PR (repo rule `.claude/rules/spec-maintenance.md`) — Task 10.
- Match the codebase's comment style: dense header comments explaining *why*, issue refs where relevant.
- Run unit tests with `npx vitest run <file>`; the full gate is `npm test`. (If native-module load errors appear under vitest, the environment fix is in memory: copy prebuilt better-sqlite3 + stub electron path.txt — see `~/.claude/.../memory/run-unit-tests-env.md`.)
- Commit after every task (green tests) with a conventional-commit message.

---

### Task 1: `localLauncher.ts` — pure launch translation

**Files:**
- Create: `src/main/localLauncher.ts`
- Test: `src/main/localLauncher.test.ts`

**Interfaces:**
- Consumes: `SpawnPty`, `PtyProc` types from `./localSessions.js` (type-only).
- Produces (used by Tasks 3, 6, 7, 8):
  - `type WorkspaceLauncher = { mode: 'native' } | { mode: 'wsl'; distro: string; shell: string; home: string; claudePath: string } | { mode: 'custom'; command: string }`
  - `posixQuote(s: string): string`
  - `uncToLinuxPath(p: string): { distro: string; path: string } | null`
  - `linuxPathToUnc(distro: string, linuxPath: string): string`
  - `windowsPathToWslPath(p: string): string | null`
  - `wslPidFile(workspaceId: string, sessionId: string): string`
  - `buildWslSpawnEnv(base: NodeJS.ProcessEnv, passKeys: string[]): NodeJS.ProcessEnv`
  - `wrapSpawnForLauncher(launcher: WorkspaceLauncher, inner: SpawnPty, opts: { workspaceId: string; platform: NodeJS.Platform; windowsCwd?: string }): SpawnPty`
  - `wslLocalProjectsDir(distro: string, home: string, workspaceRoot: string, encode: (p: string) => string): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/localLauncher.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/localLauncher.test.ts`
Expected: FAIL — `Cannot find module './localLauncher.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/main/localLauncher.ts
//
// Launcher translation for local (non-container) workspaces (#253): turns the
// per-workspace `launcher` manifest choice into the actual node-pty spawn.
// Implemented as a SpawnPty *wrapper* so localSessions.ts (which composes
// claude's own args and owns the ring buffer) stays byte-identical: the
// session manager thinks it's spawning `claude file+args`; this module
// rewrites that into `wsl.exe -d <distro> -- <shell> -lic '…'` (wsl mode) or
// a platform-shell template invocation (custom mode).
//
// Pure module: no electron / node-pty imports (types from localSessions are
// type-only), so it loads under vitest. Same discipline as claudeResolve.ts.

import type { SpawnPty } from './localSessions.js';

/** Per-workspace launch strategy (manifest `launcher`; absent ⇒ native). */
export type WorkspaceLauncher =
  | { mode: 'native' }
  | {
      mode: 'wsl';
      /** wsl.exe distro name, e.g. 'Ubuntu'. */
      distro: string;
      /** Absolute shell path inside the distro, e.g. '/usr/bin/zsh'. */
      shell: string;
      /** $HOME inside the distro — probed at save time; the transcript
       *  watcher derives the \\wsl.localhost root from it. */
      home: string;
      /** claude path inside the distro — probed at save time. */
      claudePath: string;
    }
  | {
      mode: 'custom';
      /** Command template; `{claude}` → resolved host binary, `{args}` →
       *  fleet's pre-quoted flags (appended if the placeholder is absent). */
      command: string;
    };

/** POSIX single-quote: safe against every metacharacter except NUL. */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** \\wsl.localhost\<distro>\a\b (or legacy \\wsl$\…) → { distro, '/a/b' }. */
export function uncToLinuxPath(p: string): { distro: string; path: string } | null {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(p);
  if (!m) return null;
  const path = (m[2] ?? '').replace(/\\/g, '/');
  return { distro: m[1], path: path || '/' };
}

export function linuxPathToUnc(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`;
}

/** C:\a\b → /mnt/c/a/b (default WSL automount); null for non-drive paths. */
export function windowsPathToWslPath(p: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** In-distro pidfile written by the -lic bootstrap (`echo $$ > …; exec claude`).
 *  Lives in the distro's /tmp so it vanishes with the WSL VM — stale-file
 *  signals are harmless no-ops. Ids are path-safe (assertValidWorkspaceId). */
export function wslPidFile(workspaceId: string, sessionId: string): string {
  return `/tmp/claude-fleet-${workspaceId}-${sessionId}.pid`;
}

/** Forward `passKeys` across the wsl.exe boundary: WSLENV names the vars
 *  (`/u` = Win→WSL only); the values ride the normal Windows env. */
export function buildWslSpawnEnv(
  base: NodeJS.ProcessEnv,
  passKeys: string[]
): NodeJS.ProcessEnv {
  if (passKeys.length === 0) return { ...base };
  const wslenv = [base.WSLENV, ...passKeys.map((k) => `${k}/u`)].filter(Boolean).join(':');
  return { ...base, WSLENV: wslenv };
}

/** Env vars fleet sets that claude must see inside the distro. Workspace env
 *  keys are appended at wrap time. TERM rides along so the TUI renders. */
const BASE_WSL_PASS_KEYS = ['CLAUDE_FLEET_BROKER_SESSION_ID', 'TERM'];

/**
 * Wrap a SpawnPty so the launcher decides what actually gets spawned.
 * - native: passthrough.
 * - wsl (win32 only): `wsl.exe -d <distro> --cd <cwd> -- <shell> -lic
 *   'echo $$ > <pidfile>; exec <claudePath> <args…>'`. The pty's own cwd must
 *   be a valid WINDOWS dir (`opts.windowsCwd`) — the Linux cwd goes via --cd.
 *   The inner spawn's `file` (host claude) is ignored; the manifest-cached
 *   in-distro claudePath is used instead.
 * - custom: `{claude}`/`{args}` substitution, run via the platform shell from
 *   the original (host) cwd.
 */
export function wrapSpawnForLauncher(
  launcher: WorkspaceLauncher,
  inner: SpawnPty,
  opts: { workspaceId: string; platform: NodeJS.Platform; windowsCwd?: string }
): SpawnPty {
  if (launcher.mode === 'native') return inner;

  if (launcher.mode === 'wsl') {
    if (opts.platform !== 'win32') {
      throw new Error(`launcher mode 'wsl' is only valid on win32 (got ${opts.platform})`);
    }
    return (spawnOpts) => {
      const sessionId = spawnOpts.env.CLAUDE_FLEET_BROKER_SESSION_ID ?? 'unknown';
      const pidFile = wslPidFile(opts.workspaceId, sessionId);
      const cmd =
        `echo $$ > ${posixQuote(pidFile)}; ` +
        `exec ${[launcher.claudePath, ...spawnOpts.args].map(posixQuote).join(' ')}`;
      // Forward workspace env keys + fleet's own vars across the boundary.
      const passKeys = [
        ...BASE_WSL_PASS_KEYS,
        ...Object.keys(spawnOpts.env).filter(
          (k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')
        )
      ];
      return inner({
        ...spawnOpts,
        file: 'wsl.exe',
        args: ['-d', launcher.distro, '--cd', spawnOpts.cwd, '--', launcher.shell, '-lic', cmd],
        cwd: opts.windowsCwd ?? spawnOpts.cwd,
        env: buildWslSpawnEnv(spawnOpts.env, [...new Set(passKeys)])
      });
    };
  }

  // custom
  return (spawnOpts) => {
    const quotedArgs = spawnOpts.args.map(posixQuote).join(' ');
    let cmd = launcher.command;
    cmd = cmd.replace(/\{claude\}/g, posixQuote(spawnOpts.file));
    cmd = cmd.includes('{args}') ? cmd.replace(/\{args\}/g, quotedArgs) : `${cmd} ${quotedArgs}`;
    const shell: { file: string; args: string[] } =
      opts.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/d', '/s', '/c', cmd] }
        : { file: 'sh', args: ['-c', cmd] };
    return inner({ ...spawnOpts, file: shell.file, args: shell.args });
  };
}

/** \\wsl.localhost transcript dir for a wsl-launcher workspace: the in-distro
 *  ~/.claude/projects/<encoded-cwd>, viewed over the 9P share. `encode` is
 *  paths.ts's encodeClaudeProjectDir, injected to keep this module pure. */
export function wslLocalProjectsDir(
  distro: string,
  home: string,
  workspaceRoot: string,
  encode: (p: string) => string
): string {
  return linuxPathToUnc(distro, `${home}/.claude/projects/${encode(workspaceRoot)}`);
}
```

Note for the win32 custom-mode test: `posixQuote` on `C:\bin\claude.exe` produces `'C:\bin\claude.exe'` — cmd.exe treats single quotes literally, which is fine for the passthrough test; users writing win32 templates control their own quoting (documented in the form's help text, Task 8).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/localLauncher.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/main/localLauncher.ts src/main/localLauncher.test.ts
git commit -m "feat: localLauncher — pure launch translation for native/wsl/custom (#253)"
```

---

### Task 2: `wslProbe.ts` — distro/shell/claude discovery

**Files:**
- Create: `src/main/wslProbe.ts`
- Test: `src/main/wslProbe.test.ts`

**Interfaces:**
- Consumes: `resolveClaudeBin`, `ResolveDeps` from `./claudeResolve.js`.
- Produces (used by Task 7):
  - `interface WslDistroList { distros: string[]; defaultDistro: string | null }`
  - `interface WslDistroProbe { shells: string[]; loginShell: string; home: string; claudePath: string | null; interopEnabled: boolean }`
  - `decodeWsl(buf: Buffer): string` — UTF-16LE decode + strip NULs/CR
  - `parseDistroList(verboseOut: string): WslDistroList`
  - `listWslDistros(deps: ProbeDeps): Promise<WslDistroList>`
  - `probeWslDistro(distro: string, deps: ProbeDeps): Promise<WslDistroProbe>`
  - `type ProbeDeps = { execBuf(file: string, args: string[]): Promise<{ stdout: Buffer }> ; exec(file: string, args: string[]): Promise<{ stdout: string }> }`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/wslProbe.test.ts
import { describe, it, expect } from 'vitest';
import { decodeWsl, parseDistroList, listWslDistros, probeWslDistro, type ProbeDeps } from './wslProbe.js';

/** Encode a string the way wsl.exe emits it (UTF-16LE). */
const u16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

const VERBOSE_LIST = [
  '  NAME            STATE           VERSION',
  '* Ubuntu          Running         2',
  '  Debian          Stopped         2',
  '  docker-desktop  Running         2',
  ''
].join('\r\n');

describe('decodeWsl', () => {
  it('decodes UTF-16LE and strips CR', () => {
    expect(decodeWsl(u16('Ubuntu\r\nDebian\r\n'))).toBe('Ubuntu\nDebian\n');
  });
});

describe('parseDistroList', () => {
  it('extracts names, default, and filters utility distros', () => {
    expect(parseDistroList(decodeWsl(u16(VERBOSE_LIST)))).toEqual({
      distros: ['Ubuntu', 'Debian'],
      defaultDistro: 'Ubuntu'
    });
  });
  it('returns empty on garbage', () => {
    expect(parseDistroList('wsl: not installed')).toEqual({ distros: [], defaultDistro: null });
  });
});

describe('listWslDistros', () => {
  it('returns empty when wsl.exe fails', async () => {
    const deps: ProbeDeps = {
      execBuf: async () => { throw new Error('ENOENT'); },
      exec: async () => { throw new Error('ENOENT'); }
    };
    expect(await listWslDistros(deps)).toEqual({ distros: [], defaultDistro: null });
  });
});

describe('probeWslDistro', () => {
  // Fake exec keyed on the in-distro shell command (last arg).
  const deps = (answers: Record<string, string>): ProbeDeps => ({
    execBuf: async () => ({ stdout: Buffer.alloc(0) }),
    exec: async (_file, args) => {
      const script = args[args.length - 1];
      for (const [needle, out] of Object.entries(answers)) {
        if (script.includes(needle)) return { stdout: out };
      }
      throw new Error(`no fake for: ${script}`);
    }
  });

  it('collects loginShell/home/shells/interop and resolves claude', async () => {
    const p = await probeWslDistro('Ubuntu', deps({
      'getent passwd': '/usr/bin/zsh\n',
      'echo "$HOME"': '/home/troy\n',
      '/etc/shells': '/bin/bash\n/usr/bin/zsh\n',
      WSLInterop: 'yes\n',
      'command -v claude': '/home/troy/.local/bin/claude\n'
    }));
    expect(p.loginShell).toBe('/usr/bin/zsh');
    expect(p.home).toBe('/home/troy');
    expect(p.shells).toEqual(['/bin/bash', '/usr/bin/zsh']);
    expect(p.interopEnabled).toBe(true);
    expect(p.claudePath).toBe('/home/troy/.local/bin/claude');
  });

  it('claudePath null when not found; interop false on probe failure', async () => {
    const p = await probeWslDistro('Ubuntu', deps({
      'getent passwd': '/bin/bash\n',
      'echo "$HOME"': '/home/x\n',
      '/etc/shells': '/bin/bash\n',
      WSLInterop: '',            // empty stdout ⇒ not detected
      'command -v claude': ''    // not found
    }));
    expect(p.claudePath).toBeNull();
    expect(p.interopEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/wslProbe.test.ts`
Expected: FAIL — `Cannot find module './wslProbe.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/main/wslProbe.ts
//
// WSL discovery for the local-workspace launcher (#253): enumerate installed
// distros and probe one for its login shell, $HOME, /etc/shells, Windows
// interop, and an in-distro claude install.
//
// Two exec flavors are injected: `execBuf` for wsl.exe's OWN output
// (`--list --verbose`), which is UTF-16LE, and `exec` (utf8) for commands run
// INSIDE a distro (`wsl.exe -d <d> -- sh -c …`), whose output comes from the
// Linux side and is plain UTF-8. Pure module — vitest-loadable.

import { resolveClaudeBin } from './claudeResolve.js';

export interface ProbeDeps {
  /** execFile with { encoding: 'buffer' } — for wsl.exe's UTF-16 output. */
  execBuf(file: string, args: string[]): Promise<{ stdout: Buffer }>;
  /** execFile utf8 — for in-distro commands. */
  exec(file: string, args: string[]): Promise<{ stdout: string }>;
}

export interface WslDistroList {
  distros: string[];
  defaultDistro: string | null;
}

export interface WslDistroProbe {
  shells: string[];
  loginShell: string;
  home: string;
  claudePath: string | null;
  interopEnabled: boolean;
}

/** Distros that exist to serve other products, not to host a dev shell. */
const UTILITY_DISTROS = /^(docker-desktop|rancher-desktop|podman-machine)/i;

export function decodeWsl(buf: Buffer): string {
  return buf.toString('utf16le').replace(/\r/g, '').replace(/\u0000/g, '');
}

/** Parse `wsl.exe --list --verbose`: header row, then `[*] NAME STATE VERSION`. */
export function parseDistroList(verboseOut: string): WslDistroList {
  const distros: string[] = [];
  let defaultDistro: string | null = null;
  for (const line of verboseOut.split('\n')) {
    const m = /^(\*?)\s*(\S+)\s+(Running|Stopped|Installing)\s+\d+\s*$/.exec(line.trim());
    if (!m) continue;
    const name = m[2];
    if (UTILITY_DISTROS.test(name)) continue;
    distros.push(name);
    if (m[1] === '*') defaultDistro = name;
  }
  return { distros, defaultDistro };
}

export async function listWslDistros(deps: ProbeDeps): Promise<WslDistroList> {
  try {
    const { stdout } = await deps.execBuf('wsl.exe', ['--list', '--verbose']);
    return parseDistroList(decodeWsl(stdout));
  } catch {
    return { distros: [], defaultDistro: null }; // WSL absent ⇒ feature hidden
  }
}

/** Run a POSIX one-liner inside the distro; '' on any failure. */
async function inDistro(deps: ProbeDeps, distro: string, script: string): Promise<string> {
  try {
    const { stdout } = await deps.exec('wsl.exe', ['-d', distro, '--', 'sh', '-c', script]);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function probeWslDistro(distro: string, deps: ProbeDeps): Promise<WslDistroProbe> {
  const [loginShellRaw, home, shellsRaw, interopRaw] = await Promise.all([
    inDistro(deps, distro, 'getent passwd "$(id -un)" | cut -d: -f7'),
    inDistro(deps, distro, 'echo "$HOME"'),
    inDistro(deps, distro, 'while read -r s; do [ -x "$s" ] && echo "$s"; done < /etc/shells'),
    // Canonical interop check: the binfmt registration only exists when
    // wsl.conf [interop] is enabled. Prints 'yes' iff present.
    inDistro(deps, distro, 'test -f /proc/sys/fs/binfmt_misc/WSLInterop && echo yes')
  ]);
  const loginShell = loginShellRaw || '/bin/bash';
  const shells = shellsRaw.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('/'));

  // Reuse the exact host resolution chain, but with every probe routed
  // through `wsl.exe -d <distro> --`. No env override — CLAUDE_FLEET_LOCAL_
  // CLAUDE_BIN means the HOST binary and must not leak in here.
  const claudePath = await resolveClaudeBin({
    env: { SHELL: loginShell },
    homedir: home,
    platform: 'linux',
    execFile: (file, args) =>
      deps.exec('wsl.exe', ['-d', distro, '--', file, ...args]),
    isExecutableFile: async (p) =>
      (await inDistro(deps, distro, `test -x ${JSON.stringify(p)} && echo yes`)) === 'yes'
  });

  return { shells, loginShell, home, claudePath, interopEnabled: interopRaw === 'yes' };
}
```

Check `claudeResolve.ts`'s `ResolveDeps.execFile` signature before writing: it is `(file: string, args: string[]) => Promise<{ stdout: string }>` — the adapter above matches. Note `resolveClaudeBin`'s POSIX branch runs `sh -c 'command -v claude'` — through the adapter that becomes `wsl.exe -d <d> -- sh -c 'command -v claude'`, which is exactly right.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/wslProbe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/wslProbe.ts src/main/wslProbe.test.ts
git commit -m "feat: wslProbe — distro list + shell/home/claude/interop probing (#253)"
```

---

### Task 3: manifest `launcher` field

**Files:**
- Modify: `src/main/workspaces.ts` (add import, type wiring, sanitizer, parse + spec field)
- Test: `src/main/workspacesLauncher.test.ts`

**Interfaces:**
- Consumes: `WorkspaceLauncher` from `./localLauncher.js` (type + runtime sanitizer needs the shape only).
- Produces: `sanitizeLauncher(l: unknown, platform: NodeJS.Platform): WorkspaceLauncher | undefined` exported from `workspaces.ts`; `WorkspaceSpec.launcher?: WorkspaceLauncher`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/workspacesLauncher.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeLauncher } from './workspaces.js';

describe('sanitizeLauncher', () => {
  it('passes a well-formed wsl launcher on win32', () => {
    const l = { mode: 'wsl', distro: 'Ubuntu', shell: '/usr/bin/zsh', home: '/home/t', claudePath: '/home/t/.local/bin/claude' };
    expect(sanitizeLauncher(l, 'win32')).toEqual(l);
  });
  it('rejects wsl off win32', () => {
    const l = { mode: 'wsl', distro: 'U', shell: '/bin/sh', home: '/h', claudePath: '/c' };
    expect(sanitizeLauncher(l, 'linux')).toBeUndefined();
  });
  it('rejects wsl with missing fields', () => {
    expect(sanitizeLauncher({ mode: 'wsl', distro: 'U' }, 'win32')).toBeUndefined();
  });
  it('passes custom on any platform', () => {
    expect(sanitizeLauncher({ mode: 'custom', command: 'x {args}' }, 'linux'))
      .toEqual({ mode: 'custom', command: 'x {args}' });
  });
  it('rejects custom with empty command', () => {
    expect(sanitizeLauncher({ mode: 'custom', command: '  ' }, 'linux')).toBeUndefined();
  });
  it('normalizes native / drops junk', () => {
    expect(sanitizeLauncher({ mode: 'native' }, 'linux')).toEqual({ mode: 'native' });
    expect(sanitizeLauncher('zsh', 'linux')).toBeUndefined();
    expect(sanitizeLauncher(undefined, 'linux')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/workspacesLauncher.test.ts`
Expected: FAIL — `sanitizeLauncher` is not exported

- [ ] **Step 3: Implement in `workspaces.ts`**

Add the import at the top (after the paths import):

```ts
import type { WorkspaceLauncher } from './localLauncher.js';
```

Add to `WorkspaceSpec` (after the `endpointId` field):

```ts
  /** Local workspaces only (#253): how `claude` is invoked. Absent ⇒ native
   *  direct spawn. 'wsl' is win32-only (validated by sanitizeLauncher). */
  launcher?: WorkspaceLauncher;
```

Add the sanitizer (next to `sanitizeControl`), exported for tests and the IPC layer:

```ts
/** Strict-allowlist launcher validation (#253). 'wsl' additionally requires
 *  win32 — a hand-edited manifest can't activate WSL mode elsewhere. */
export function sanitizeLauncher(
  l: unknown,
  platform: NodeJS.Platform = process.platform
): WorkspaceLauncher | undefined {
  if (!l || typeof l !== 'object') return undefined;
  const o = l as Record<string, unknown>;
  if (o.mode === 'native') return { mode: 'native' };
  if (o.mode === 'custom') {
    return typeof o.command === 'string' && o.command.trim()
      ? { mode: 'custom', command: o.command }
      : undefined;
  }
  if (o.mode === 'wsl') {
    if (platform !== 'win32') return undefined;
    const { distro, shell, home, claudePath } = o as Record<string, unknown>;
    if ([distro, shell, home, claudePath].every((v) => typeof v === 'string' && v)) {
      return {
        mode: 'wsl',
        distro: distro as string,
        shell: shell as string,
        home: home as string,
        claudePath: claudePath as string
      };
    }
  }
  return undefined;
}
```

Wire it into `readWorkspaceManifest`'s return object (after `endpointId`):

```ts
      launcher: sanitizeLauncher(parsed.launcher),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/workspacesLauncher.test.ts`
Expected: PASS. Also run `npm run typecheck` — `workspaces.ts` importing a type from `localLauncher.ts` must not break the node tsconfig.

- [ ] **Step 5: Commit**

```bash
git add src/main/workspaces.ts src/main/workspacesLauncher.test.ts
git commit -m "feat: launcher field on the workspace manifest, strict-validated (#253)"
```

---

### Task 4: jsonlWatcher — polled roots for `\\wsl.localhost`

**Files:**
- Modify: `src/main/jsonlWatcher.ts`
- Test: `src/main/jsonlWatcher.polled.test.ts`

**Interfaces:**
- Produces: `registerPolledLocalDir(id: string, dir: string): void` on `JsonlWatcher` (used by Task 7); `unregisterLocalWorkspace` and `stop()` cover polled dirs too.

The 9P share delivers no inotify events, so polled dirs live in a **second** chokidar instance with `usePolling: true`; native dirs keep event-driven watching. Both feed the same `enqueue()` pipeline.

- [ ] **Step 1: Write the failing test**

Model it on the existing `src/main/jsonlWatcher.localdir.test.ts` — read that file first and copy its setup (tmp dir, db mocking if present, watcher lifecycle). The new test (adjust imports/setup to exactly match what `jsonlWatcher.localdir.test.ts` does — e.g. any `vi.mock('./db.js', …)` block must be copied verbatim):

```ts
// src/main/jsonlWatcher.polled.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// …same mocks/imports as jsonlWatcher.localdir.test.ts…
import { JsonlWatcher } from './jsonlWatcher.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

describe('polled local dirs', () => {
  let root: string;
  let watcher: JsonlWatcher;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cf-polled-'));
    watcher = new JsonlWatcher();
    await watcher.start([]);
  });
  afterEach(async () => {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('ingests transcripts from a dir registered as polled', async () => {
    const dir = join(root, 'projects', '-home-troy-proj');
    mkdirSync(dir, { recursive: true });
    watcher.registerPolledLocalDir('ws-polled', dir);
    const ingested = new Promise<{ workspaceId: string; sessionId: string }>((res) =>
      watcher.on('ingest', res)
    );
    writeFileSync(join(dir, `${SESSION}.jsonl`), '{"type":"user","uuid":"u1"}\n');
    const e = await ingested;
    expect(e.workspaceId).toBe('ws-polled');
    expect(e.sessionId).toBe(SESSION);
  });

  it('unregisterLocalWorkspace also removes polled dirs', async () => {
    const dir = join(root, 'p2');
    mkdirSync(dir, { recursive: true });
    watcher.registerPolledLocalDir('ws-polled', dir);
    watcher.unregisterLocalWorkspace('ws-polled');
    // registering again must be a fresh add (no dedup leak)
    watcher.registerPolledLocalDir('ws-polled', dir);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/jsonlWatcher.polled.test.ts`
Expected: FAIL — `registerPolledLocalDir is not a function`

- [ ] **Step 3: Implement**

In `JsonlWatcher`:

1. Add fields next to `watcher`:

```ts
  // Second chokidar instance for dirs where inotify can't reach — the
  // \\wsl.localhost 9P share delivers no change events (#253). Created
  // lazily on the first polled registration; same handlers as `watcher`.
  private pollWatcher: FSWatcher | null = null;
  private readonly polledDirs = new Set<string>();
```

2. Extract the handler wiring in `start()` into a private method so both instances share it:

```ts
  private wireHandlers(w: FSWatcher): void {
    w.on('add', (p) => this.enqueue(p))
      .on('change', (p) => this.enqueue(p))
      .on('unlink', (p) => {
        this.files.delete(p);
        this.chains.delete(p);
      })
      .on('error', (err) => console.error('[jsonlWatcher] error:', err));
  }
```

and call `this.wireHandlers(this.watcher)` in `start()` in place of the inline chain.

3. Add the public API (below `registerLocalWorkspace`). Bookkeeping is synchronous (guards double-registration and lets unregister work while chokidar is still loading); only the chokidar `add` is deferred behind a **memoized** creation promise — two rapid registrations must not create two poll watchers:

```ts
  private pollWatcherPromise: Promise<FSWatcher | null> | null = null;

  /** Register a transcript dir that needs POLLING (no inotify — e.g. a
   *  \\wsl.localhost share for a wsl-launcher workspace, #253). */
  registerPolledLocalDir(id: string, dir: string): void {
    if (!this.watcher) return; // same started-gate as registerLocalWorkspace
    if (this.hostDirs.has(dir)) return;
    this.hostDirs.set(dir, id);
    this.watchedDirs.add(dir);
    this.polledDirs.add(dir);
    try { mkdirSync(dir, { recursive: true }); } catch { /* see registerWorkspace */ }
    void this.ensurePollWatcher().then((w) => {
      // Skip if stopped or unregistered while chokidar was loading.
      if (w && this.polledDirs.has(dir)) w.add(dir);
    });
  }

  private ensurePollWatcher(): Promise<FSWatcher | null> {
    if (!this.pollWatcherPromise) {
      // Lazy import mirrors start(); chokidar is ESM-only under our CJS bundle.
      this.pollWatcherPromise = import('chokidar').then((chokidar) => {
        if (!this.watcher) return null; // stopped while loading
        this.pollWatcher = chokidar.watch([], {
          depth: 2,
          ignoreInitial: false,
          persistent: true,
          usePolling: true,
          interval: 1500,
          binaryInterval: 3000
        });
        this.wireHandlers(this.pollWatcher);
        return this.pollWatcher;
      });
    }
    return this.pollWatcherPromise;
  }
```

4. In `unregisterLocalWorkspace`, unwatch from the right instance (replacing the unconditional `this.watcher.unwatch(dir)` inside the loop). Deleting from `polledDirs` first means a dir unregistered mid-load is never added — the `then` in step 3 re-checks membership — so the deferred unwatch is safe:

```ts
      if (this.polledDirs.delete(dir)) {
        void this.pollWatcherPromise?.then((w) => w?.unwatch(dir));
      } else {
        this.watcher.unwatch(dir);
      }
```

5. In `stop()`, also close the poll watcher:

```ts
    await this.pollWatcher?.close();
    this.pollWatcher = null;
    this.pollWatcherPromise = null;
    this.polledDirs.clear();
```

- [ ] **Step 4: Run the new test + all existing watcher tests**

Run: `npx vitest run src/main/jsonlWatcher.polled.test.ts src/main/jsonlWatcher.test.ts src/main/jsonlWatcher.localdir.test.ts src/main/jsonlWatcher.newSession.test.ts src/main/jsonlWatcher.subagent.test.ts src/main/jsonlWatcherMirror.test.ts`
Expected: ALL PASS (no regression in the event-driven path)

- [ ] **Step 5: Commit**

```bash
git add src/main/jsonlWatcher.ts src/main/jsonlWatcher.polled.test.ts
git commit -m "feat: jsonlWatcher polled roots for \\\\wsl.localhost transcript dirs (#253)"
```

---

### Task 5: MCP bridge entry for WSL (interop)

**Files:**
- Modify: `src/main/mcpLocalBridge.ts`
- Test: `src/main/mcpLocalBridge.test.ts` (create if absent; check for an existing one first and extend it instead)

**Interfaces:**
- Consumes: `windowsPathToWslPath` from `./localLauncher.js`.
- Produces (used by Task 6): `wslMcpServerEntry(electronBin: string, bridgePath: string, socketPath: string): { type: string; command: string; args: string[]; env: Record<string, string> } | null` — null when `electronBin` isn't a translatable drive path.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/mcpLocalBridge.test.ts (new describe block if the file exists)
import { describe, it, expect } from 'vitest';
import { wslMcpServerEntry, localMcpServerEntry } from './mcpLocalBridge.js';

describe('wslMcpServerEntry', () => {
  it('translates the exe to /mnt/c and keeps Windows paths in args/env', () => {
    const e = wslMcpServerEntry(
      'C:\\Users\\troy\\AppData\\Local\\Programs\\claude-fleet\\claude-fleet.exe',
      'C:\\ud\\mcp\\local-bridge.cjs',
      'C:\\ud\\mcp\\ws1\\mcp.sock'
    );
    expect(e).toEqual({
      type: 'stdio',
      command: '/mnt/c/Users/troy/AppData/Local/Programs/claude-fleet/claude-fleet.exe',
      args: ['C:\\ud\\mcp\\local-bridge.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: 'C:\\ud\\mcp\\ws1\\mcp.sock' }
    });
  });
  it('returns null for a non-drive exe path', () => {
    expect(wslMcpServerEntry('\\\\server\\share\\x.exe', 'C:\\b.cjs', 'C:\\s.sock')).toBeNull();
  });
});

describe('localMcpServerEntry', () => {
  it('is unchanged', () => {
    expect(localMcpServerEntry('/e', '/b.cjs', '/s.sock').command).toBe('/e');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/mcpLocalBridge.test.ts`
Expected: FAIL — `wslMcpServerEntry` not exported

- [ ] **Step 3: Implement** (append to `mcpLocalBridge.ts`)

```ts
import { windowsPathToWslPath } from './localLauncher.js';

/**
 * The `mcpServers` entry for a WSL-launcher workspace (#253). claude runs
 * INSIDE the distro, but WSL Windows-interop lets it exec the app's own exe
 * directly (binfmt_misc), with stdio piped across the boundary — so the same
 * Electron-as-node bridge works with only the *command* path translated to
 * its /mnt/c form. `args`/env stay Windows paths: the bridge runs as a
 * Windows process and dials the same per-workspace listener as native local
 * (caller identity — which listener accepted — is untouched). Plain env vars
 * flow into interop-launched Windows processes, so ELECTRON_RUN_AS_NODE and
 * the socket path ride through unchanged. Null when the exe isn't on a
 * drive letter (no automount form) — caller then skips MCP wiring.
 */
export function wslMcpServerEntry(
  electronBin: string,
  bridgePath: string,
  socketPath: string
): { type: string; command: string; args: string[]; env: Record<string, string> } | null {
  const command = windowsPathToWslPath(electronBin);
  if (!command) return null;
  return {
    type: 'stdio',
    command,
    args: [bridgePath],
    env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: socketPath }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/mcpLocalBridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpLocalBridge.ts src/main/mcpLocalBridge.test.ts
git commit -m "feat: interop MCP server entry for wsl-launcher workspaces (#253)"
```

---

### Task 6: `local.ts` — launcher-aware backend

**Files:**
- Modify: `src/main/local.ts`

No new unit test file — every branch added here delegates to the pure modules tested in Tasks 1/5; this task is integration glue verified by typecheck + the e2e suite (Task 9). Keep the diff tight.

**Interfaces:**
- Consumes: `wrapSpawnForLauncher`, `wslPidFile`, `windowsPathToWslPath`, `posixQuote`, `type WorkspaceLauncher` (Task 1); `wslMcpServerEntry` (Task 5); `m.launcher` (Task 3).
- Produces: `pauseWorkspace` works for wsl-launcher workspaces; `listLiveWorkspaces` reports `'paused'`; everything else keeps its signature.

- [ ] **Step 1: Add imports and the paused set**

```ts
import { homedir } from 'node:os'; // already imported
import {
  wrapSpawnForLauncher,
  wslPidFile,
  windowsPathToWslPath,
  type WorkspaceLauncher
} from './localLauncher.js';
import { wslMcpServerEntry } from './mcpLocalBridge.js'; // extend the existing import
```

Next to `const started = new Set<string>()`:

```ts
// wsl-launcher workspaces CAN pause (kill -STOP inside the distro, #253);
// native/custom local ones still can't. In-memory like `started`.
const paused = new Set<string>();
```

Update the module header comment: the "Pause is not supported" paragraph becomes "Pause is not supported for *native/custom* local workspaces … wsl-launcher workspaces pause via `kill -STOP` on the in-distro pid (see pauseWorkspace)."

- [ ] **Step 2: Helper to signal every session pidfile of a workspace**

Add below `resolveClaude()`:

```ts
/** Best-effort signal to every live in-distro claude of a wsl workspace via
 *  its session pidfiles (written by the -lic bootstrap; see localLauncher). */
async function signalWslSessions(
  launcher: Extract<WorkspaceLauncher, { mode: 'wsl' }>,
  workspaceId: string,
  signal: 'STOP' | 'CONT' | 'TERM'
): Promise<void> {
  const glob = wslPidFile(workspaceId, '*');
  const script = `for f in ${glob}; do [ -f "$f" ] && kill -${signal} "$(cat "$f")" 2>/dev/null; done; true`;
  await execFileAsync('wsl.exe', ['-d', launcher.distro, '--', 'sh', '-c', script]).catch(() => {});
}
```

(`wslPidFile(workspaceId, '*')` produces `/tmp/claude-fleet-<id>-*.pid`; the shell expands the glob. Ids are `[a-zA-Z0-9_-]+` so no quoting hazard.)

- [ ] **Step 3: attachPty — launcher plumbing**

In `attachPty`, after `const m = await readWorkspaceManifest(id)`:

```ts
  const launcher: WorkspaceLauncher = m.launcher ?? { mode: 'native' };
```

Replace the claude-resolution block so wsl mode uses the manifest cache:

```ts
  // wsl mode uses the save-time-probed in-distro path (manifest cache) — the
  // host resolver is wrong there. wrapSpawnForLauncher substitutes it; the
  // host `file` below is ignored for wsl. If the cache went stale (distro
  // reinstalled), the shell prints exec's error into the pty; re-saving the
  // workspace re-probes.
  const claudeBin =
    launcher.mode === 'wsl' ? launcher.claudePath : await resolveClaude();
  if (!claudeBin) throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
```

MCP config path: `ensureMcpConfig` gains the launcher param (Step 5) and the flag value is translated for wsl:

```ts
  const mcpConfigPath = await ensureMcpConfig(id, launcher);
  // claude reads --mcp-config INSIDE the distro for wsl mode.
  const mcpConfigArg =
    mcpConfigPath && launcher.mode === 'wsl'
      ? (windowsPathToWslPath(mcpConfigPath) ?? undefined)
      : mcpConfigPath;
```

Then in the `attachLocalSession({...})` call: `mcpConfigPath: mcpConfigArg`, and replace `spawn: defaultSpawn` with:

```ts
    spawn: wrapSpawnForLauncher(launcher, defaultSpawn, {
      workspaceId: id,
      platform: process.platform,
      // wsl.exe needs a valid WINDOWS cwd; the Linux cwd goes via --cd.
      windowsCwd: homedir()
    })
```

Also, when attaching un-pauses (it does: `started.add(id)`), add `paused.delete(id)` beside it.

- [ ] **Step 4: pause / start / stop / list**

```ts
export async function pauseWorkspace(containerId: string): Promise<void> {
  const m = await readWorkspaceManifest(containerId);
  if (m?.launcher?.mode === 'wsl') {
    await signalWslSessions(m.launcher, containerId, 'STOP');
    if (started.has(containerId)) paused.add(containerId);
    return;
  }
  throw new Error('pause is not supported for local workspaces');
}
```

In `startWorkspace`, after `started.add(id)`:

```ts
  if (paused.delete(id) && m.launcher?.mode === 'wsl') {
    await signalWslSessions(m.launcher, id, 'CONT');
  }
```

In `stopWorkspace` (make it async-read the manifest first):

```ts
export async function stopWorkspace(containerId: string): Promise<void> {
  const m = await readWorkspaceManifest(containerId);
  killWorkspaceSessions(containerId);
  // conpty teardown isn't guaranteed to reap the Linux-side process (#253).
  if (m?.launcher?.mode === 'wsl') {
    await signalWslSessions(m.launcher, containerId, 'TERM');
  }
  started.delete(containerId);
  paused.delete(containerId);
}
```

In `listLiveWorkspaces`, the state line becomes:

```ts
    const state: WorkspaceState = paused.has(m.id)
      ? 'paused'
      : started.has(m.id)
        ? 'running'
        : 'stopped';
```

and the containerId surrogate: `containerId: state === 'stopped' ? undefined : m.id`.

Mirror `removeWorkspace`: add `paused.delete(id)`.

- [ ] **Step 5: ensureMcpConfig launcher variant**

```ts
async function ensureMcpConfig(
  id: string,
  launcher: WorkspaceLauncher
): Promise<string | undefined> {
  const userData = app.getPath('userData');
  const socketPath = mcpWorkspaceSocketPath(userData, id);
  if (!(await stat(socketPath).catch(() => null))) return undefined;
  const bridgePath = await ensureLocalBridgeScript(mcpSocketDir(userData));
  const entry =
    launcher.mode === 'wsl'
      ? wslMcpServerEntry(process.execPath, bridgePath, socketPath)
      : localMcpServerEntry(process.execPath, bridgePath, socketPath);
  // wsl + untranslatable exe path (or interop off, which surfaces as the
  // bridge failing) ⇒ skip wiring; the session works without fleet tools.
  if (!entry) return undefined;
  const config = { mcpServers: { 'claude-fleet-state': entry } };
  const configPath = join(workspaceStateDir(id), 'mcp-config.json');
  await mkdir(workspaceStateDir(id), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: clean. Then `npx vitest run src/main` — all existing unit tests still pass (local.ts isn't vitest-loaded, but its imports changed pure modules).

- [ ] **Step 7: Commit**

```bash
git add src/main/local.ts
git commit -m "feat: launcher-aware local backend — wsl spawn, pause, interop MCP (#253)"
```

---

### Task 7: IPC + preload — probe channels, create/edit plumbing, watcher root

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/index.ts` (startup watcher registration, line ~174)
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces for the renderer (Task 8):
  - `window.api.local.listWslDistros(): Promise<{ distros: string[]; defaultDistro: string | null }>`
  - `window.api.local.probeWslDistro(distro: string): Promise<{ shells: string[]; loginShell: string; home: string; claudePath: string | null; interopEnabled: boolean }>`
  - `window.api.app.platform(): Promise<NodeJS.Platform>`
  - `workspace:create` / `workspace:writeManifest` accept a `launcher` field (sanitized server-side).

- [ ] **Step 1: Production ProbeDeps + handlers in `ipc.ts`**

Imports:

```ts
import { listWslDistros, probeWslDistro, type ProbeDeps } from './wslProbe.js';
import { sanitizeLauncher } from './workspaces.js'; // extend existing import
import { wslLocalProjectsDir, uncToLinuxPath } from './localLauncher.js';
import { encodeClaudeProjectDir } from './paths.js'; // extend existing import
```

Near the other helper consts (ipc.ts already has an `execFile`-style util or imports `node:child_process` — if not, add `const execFileAsync = promisify(execFile)` with the imports the file already uses elsewhere):

```ts
const wslProbeDeps: ProbeDeps = {
  execBuf: async (file, args) => {
    const { stdout } = await execFileAsync(file, args, { encoding: 'buffer' as const });
    return { stdout: stdout as unknown as Buffer };
  },
  exec: (file, args) => execFileAsync(file, args)
};
```

Handlers (place near the `fs:` group; both hard-gate on platform):

```ts
  ipcMain.handle('local:listWslDistros', () => {
    if (process.platform !== 'win32') return { distros: [], defaultDistro: null };
    return listWslDistros(wslProbeDeps);
  });
  ipcMain.handle('local:probeWslDistro', (_e, distro: string) => {
    if (process.platform !== 'win32') throw new Error('WSL probing is Windows-only');
    if (typeof distro !== 'string' || !/^[\w.-]+$/.test(distro)) {
      throw new Error('invalid distro name');
    }
    return probeWslDistro(distro, wslProbeDeps);
  });
```

- [ ] **Step 2: `workspace:create` — accept + validate launcher**

In the `workspace:create` handler (ipc.ts:716):

1. After `const kind = …`, sanitize:

```ts
      const launcher = kind === 'local' ? sanitizeLauncher(input.launcher) : undefined;
```

(Add `launcher?: unknown` to the `WorkspaceCreatePayload` type — find it via `grep -n "WorkspaceCreatePayload" src/main/ipc.ts` and add the field where `workspaceRoot` is declared.)

2. The local working-dir validation branches on launcher: the existing `fs.isDirectory(root)` check is wrong for a Linux path. Replace the `if (kind === 'local') { … }` block body with:

```ts
        const root = input.workspaceRoot?.trim();
        if (!root) {
          throw new Error('Pick a working directory for the local workspace.');
        }
        if (launcher?.mode === 'wsl') {
          // Accept a \\wsl.localhost UNC paste and normalize it to Linux form.
          const unc = uncToLinuxPath(root);
          const linuxRoot = unc ? unc.path : root;
          if (!linuxRoot.startsWith('/')) {
            throw new Error(`WSL working directory must be a Linux path: ${root}`);
          }
          const ok = await execFileAsync('wsl.exe', [
            '-d', launcher.distro, '--', 'test', '-d', linuxRoot
          ]).then(() => true, () => false);
          if (!ok) throw new Error(`Directory does not exist in ${launcher.distro}: ${linuxRoot}`);
          input.workspaceRoot = linuxRoot;
        } else if (!(await fs.isDirectory(root))) {
          throw new Error(`Working directory does not exist: ${root}`);
        }
```

3. Thread `launcher` into the written spec: add `launcher,` to the `const spec: WorkspaceSpec = { … }` literal (after `endpointId`).

4. Watcher registration — replace the existing local branch:

```ts
      if (spec.kind === 'local' && spec.workspaceRoot) {
        if (spec.launcher?.mode === 'wsl') {
          jsonlWatcher?.registerPolledLocalDir(
            input.id,
            wslLocalProjectsDir(
              spec.launcher.distro, spec.launcher.home, spec.workspaceRoot, encodeClaudeProjectDir
            )
          );
        } else {
          jsonlWatcher?.registerLocalWorkspace(input.id, spec.workspaceRoot);
        }
      }
```

- [ ] **Step 3: `workspace:writeManifest` — same sanitize**

Find the handler (ipc.ts:921). Where it builds the spec to persist, pass the incoming launcher through `sanitizeLauncher(...)` the same way (read the handler body first; it validates field-by-field — add `launcher: sanitizeLauncher((spec as { launcher?: unknown }).launcher),`).

- [ ] **Step 4: startup registration in `index.ts`**

At `src/main/index.ts:174` the startup loop registers local roots. Apply the same wsl/native branch as Step 2.4 (import `wslLocalProjectsDir` from `./localLauncher.js` and `encodeClaudeProjectDir` from `./paths.js`).

- [ ] **Step 5: preload**

In `src/preload/index.ts`, add to the `app` group:

```ts
    platform: (): Promise<NodeJS.Platform> => Promise.resolve(process.platform),
```

(preload has full Node access; no IPC round-trip needed). And a new top-level group after `workspace`:

```ts
  local: {
    /** Installed WSL distros (win32; empty elsewhere) — populates the launcher picker (#253). */
    listWslDistros: (): Promise<{ distros: string[]; defaultDistro: string | null }> =>
      ipcRenderer.invoke('local:listWslDistros'),
    /** Probe one distro for shells/login shell/$HOME/claude/interop (#253). */
    probeWslDistro: (
      distro: string
    ): Promise<{
      shells: string[];
      loginShell: string;
      home: string;
      claudePath: string | null;
      interopEnabled: boolean;
    }> => ipcRenderer.invoke('local:probeWslDistro', distro)
  },
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npx vitest run src/main`
Expected: clean / pass.

```bash
git add src/main/ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "feat: wsl probe IPC + launcher plumbing through create/edit/watcher (#253)"
```

---

### Task 8: Renderer — "Run claude in" UI

**Files:**
- Modify: `src/renderer/src/components/WorkspaceForm.tsx`
- Modify: `src/renderer/src/App.tsx` (submit → create/writeManifest payload; `WorkspaceSummary` type)
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx` (Pause menu gate)

- [ ] **Step 1: Types + state in WorkspaceForm**

Add to `WorkspaceFormSubmit` (after `workspaceRoot`):

```ts
  /** Local workspaces only (#253): how claude is invoked. undefined ⇒ native. */
  launcher?:
    | { mode: 'native' }
    | { mode: 'wsl'; distro: string; shell: string; home: string; claudePath: string }
    | { mode: 'custom'; command: string };
```

Component state (near the `workspaceRoot` state, WorkspaceForm.tsx:202):

```ts
  const initialLauncher = initial?.launcher;
  const [launcherMode, setLauncherMode] = useState<'native' | 'wsl' | 'custom'>(
    initialLauncher?.mode ?? 'native'
  );
  const [platform, setPlatform] = useState<string>('');
  const [wslDistros, setWslDistros] = useState<{ distros: string[]; defaultDistro: string | null }>({ distros: [], defaultDistro: null });
  const [wslDistro, setWslDistro] = useState<string>(
    initialLauncher?.mode === 'wsl' ? initialLauncher.distro : ''
  );
  const [wslProbe, setWslProbe] = useState<
    | { state: 'idle' }
    | { state: 'probing' }
    | { state: 'done'; shells: string[]; loginShell: string; home: string; claudePath: string | null; interopEnabled: boolean }
    | { state: 'error'; message: string }
  >({ state: 'idle' });
  const [wslShell, setWslShell] = useState<string>(
    initialLauncher?.mode === 'wsl' ? initialLauncher.shell : ''
  );
  const [customCommand, setCustomCommand] = useState<string>(
    initialLauncher?.mode === 'custom' ? initialLauncher.command : ''
  );
```

Effects (near the other `useEffect`s):

```ts
  useEffect(() => {
    void window.api.app.platform().then(setPlatform);
  }, []);
  // Load distros once when local kind is active on Windows.
  useEffect(() => {
    if (kind !== 'local' || platform !== 'win32') return;
    void window.api.local.listWslDistros().then(setWslDistros);
  }, [kind, platform]);
  // Probe on distro change.
  useEffect(() => {
    if (launcherMode !== 'wsl' || !wslDistro) return;
    setWslProbe({ state: 'probing' });
    window.api.local.probeWslDistro(wslDistro).then(
      (p) => {
        setWslProbe({ state: 'done', ...p });
        setWslShell((s) => (s && p.shells.includes(s) ? s : p.loginShell));
      },
      (err: Error) => setWslProbe({ state: 'error', message: err.message })
    );
  }, [launcherMode, wslDistro]);
```

- [ ] **Step 2: Render the section**

Inside the existing `{kind === 'local' && (…)}` block (WorkspaceForm.tsx:474), ABOVE the Working-directory row, add:

```tsx
        <div className="form-row" aria-label="Run claude in">
          <label>Run claude in</label>
          <div className="kind-radios" role="radiogroup">
            <label className={`kind-radio ${launcherMode === 'native' ? 'active' : ''}`}>
              <input
                type="radio"
                name="launcher-mode"
                value="native"
                checked={launcherMode === 'native'}
                onChange={() => setLauncherMode('native')}
                disabled={busy}
              />
              This computer
              <span className="kind-help">spawn claude directly</span>
            </label>
            {platform === 'win32' && wslDistros.distros.length > 0 && (
              <label className={`kind-radio ${launcherMode === 'wsl' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="launcher-mode"
                  value="wsl"
                  checked={launcherMode === 'wsl'}
                  onChange={() => {
                    setLauncherMode('wsl');
                    if (!wslDistro) setWslDistro(wslDistros.defaultDistro ?? wslDistros.distros[0]);
                  }}
                  disabled={busy}
                />
                WSL
                <span className="kind-help">inside a WSL distro, via your login shell</span>
              </label>
            )}
            <label className={`kind-radio ${launcherMode === 'custom' ? 'active' : ''}`}>
              <input
                type="radio"
                name="launcher-mode"
                value="custom"
                checked={launcherMode === 'custom'}
                onChange={() => setLauncherMode('custom')}
                disabled={busy}
              />
              Custom command
              <span className="kind-help">advanced: your own wrapper</span>
            </label>
          </div>
        </div>

        {launcherMode === 'wsl' && (
          <div className="form-row">
            <label>WSL distro</label>
            <select
              aria-label="WSL distro"
              value={wslDistro}
              onChange={(e) => setWslDistro(e.target.value)}
              disabled={busy}
            >
              {wslDistros.distros.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <label>Shell</label>
            <select
              aria-label="WSL shell"
              value={wslShell}
              onChange={(e) => setWslShell(e.target.value)}
              disabled={busy || wslProbe.state !== 'done'}
            >
              {(wslProbe.state === 'done' ? wslProbe.shells : wslShell ? [wslShell] : []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {wslProbe.state === 'probing' && <p className="field-hint">Probing {wslDistro}…</p>}
            {wslProbe.state === 'error' && <p className="field-error">Probe failed: {wslProbe.message}</p>}
            {wslProbe.state === 'done' && wslProbe.claudePath && (
              <p className="field-hint">✓ claude found at <code>{wslProbe.claudePath}</code></p>
            )}
            {wslProbe.state === 'done' && !wslProbe.claudePath && (
              <p className="field-error">
                claude not found in {wslDistro} — install it there or pick another distro.
              </p>
            )}
            {wslProbe.state === 'done' && !wslProbe.interopEnabled && (
              <p className="field-hint">
                Windows interop is disabled in this distro — fleet tools (claude-fleet-state MCP)
                will be unavailable in its sessions.
              </p>
            )}
          </div>
        )}

        {launcherMode === 'custom' && (
          <div className="form-row">
            <label>Launch command</label>
            <input
              aria-label="Custom launch command"
              value={customCommand}
              placeholder="my-wrapper {claude} {args}"
              onChange={(e) => setCustomCommand(e.target.value)}
              disabled={busy}
            />
            <p className="field-hint">
              Runs via your platform shell. <code>{'{claude}'}</code> = resolved claude binary,{' '}
              <code>{'{args}'}</code> = fleet flags (appended if omitted — resume and fleet tools
              depend on them). If your command moves claude off this host, session history/cost
              tracking may not see its transcripts. You own quoting.
            </p>
          </div>
        )}
```

Also update the Working-directory `placeholder` and Browse button for wsl mode: placeholder `/home/you/projects/your-repo`; on Browse click when `launcherMode === 'wsl'`, call `window.api.dialog.pickDirectory(`\\\\wsl.localhost\\${wslDistro}\\`)` and post-process the picked value: if it parses as UNC (starts with `\\wsl`), strip to the Linux path in the field (string transform in the component: `picked.replace(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i, '').replace(/\\/g, '/') || '/'`).

- [ ] **Step 3: Validation + submit**

In the validate section (WorkspaceForm.tsx:283 area) add:

```ts
    if (kind === 'local' && launcherMode === 'wsl') {
      if (!wslDistro) { setStatus('Pick a WSL distro.'); return; }
      if (wslProbe.state !== 'done' || !wslProbe.claudePath) {
        setStatus('WSL probe must succeed (claude found in the distro) before saving.');
        return;
      }
    }
    if (kind === 'local' && launcherMode === 'custom' && !customCommand.trim()) {
      setStatus('Enter a launch command.');
      return;
    }
```

In the submit object (WorkspaceForm.tsx:370 area), after `workspaceRoot`:

```ts
      launcher:
        kind !== 'local' || launcherMode === 'native'
          ? undefined
          : launcherMode === 'custom'
            ? { mode: 'custom' as const, command: customCommand.trim() }
            : {
                mode: 'wsl' as const,
                distro: wslDistro,
                shell: wslShell,
                home: wslProbe.state === 'done' ? wslProbe.home : '',
                claudePath: wslProbe.state === 'done' ? (wslProbe.claudePath ?? '') : ''
              },
```

- [ ] **Step 4: App.tsx plumbing**

- `grep -n "workspaceRoot" src/renderer/src/App.tsx` — every place the form submit is turned into a `workspace:create` payload or `writeManifest` spec, add `launcher: values.launcher` alongside `workspaceRoot`.
- Add `launcher` to the `WorkspaceSummary` type in App.tsx (same union as the form type), sourced from the manifest in `workspace:list` — check `grep -n "WorkspaceSummary" src/renderer/src/App.tsx` and the main-side list assembly; the manifest spread in `local.ts:listLiveWorkspaces` (`...m`) already carries `launcher`, so the renderer type just needs the field.
- Edit-mode prefill: where the edit modal builds `initial` from a workspace, include `launcher`.

- [ ] **Step 5: Pause menu gate in WorkspaceTabStrip.tsx**

At the running-state menu block (WorkspaceTabStrip.tsx:408), Pause currently renders for every running workspace while the local backend throws. Gate it:

```tsx
            {menuWorkspace.state === 'running' && (
              <>
                {(menuWorkspace.kind !== 'local' || menuWorkspace.launcher?.mode === 'wsl') && (
                  <button role="menuitem" onClick={() => doAction('pause', menuWorkspace)}>
                    <IconPause />
                    <span>Pause</span>
                  </button>
                )}
                …
```

(Confirm the prop type used for `menuWorkspace` — extend it with `launcher` if it's narrower than `WorkspaceSummary`.)

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npm run build`
Expected: clean. Manual smoke on Linux: `CLAUDE_FLEET_MOCK=1 npm run dev` — local kind shows "This computer" + "Custom command" only (no WSL radio), custom field appears/validates.

```bash
git add src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/App.tsx src/renderer/src/components/WorkspaceTabStrip.tsx
git commit -m "feat(ui): Run-claude-in launcher section — WSL distro/shell picker + custom command (#253)"
```

---

### Task 9: e2e specs + Windows CI WSL lane

**Files:**
- Create: `tests/wsl-local.spec.ts`
- Modify: `tests/local-backend.spec.ts` (Linux-side assertion: WSL radio absent, custom present)
- Modify: `.github/workflows/build-app.yml` (`e2e-windows` job)

- [ ] **Step 1: Read the harness conventions**

Read `tests/_helpers.ts` and `tests/local-backend.spec.ts` fully. Reuse their app-launch fixture (`CLAUDE_FLEET_ROOT` temp dir, `_electron.launch`, any `test.skip` gating helpers). The new spec must follow the same launch/teardown shape exactly.

- [ ] **Step 2: Write `tests/wsl-local.spec.ts`**

Structure (fill in with the harness's real helper names after Step 1 — the assertions and flow below are the contract):

```ts
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
// …same app-launch helpers as local-backend.spec.ts…

function wslAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('wsl.exe', ['--list', '--quiet'], { encoding: 'utf16le' });
    return out.replace(/\u0000/g, '').trim().length > 0;
  } catch {
    return false;
  }
}

test.describe('wsl local workspaces', () => {
  test.skip(!wslAvailable(), 'requires Windows with a WSL distro installed');

  test('create → probe → attach → transcript ingested → pause/resume', async () => {
    // 1. Seed a fake claude into the distro (idempotent):
    //    wsl.exe -d <distro> -- sh -c 'mkdir -p ~/.local/bin && cat > ~/.local/bin/claude <<\EOF … EOF && chmod +x ~/.local/bin/claude'
    //    The fake prints "FAKE-CLAUDE-READY", then writes
    //    ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl with one valid user line,
    //    then `exec cat` (stays alive, echoes stdin like the broker tests).
    // 2. Launch the app (harness), open New workspace, kind=Local.
    // 3. Expect the "WSL" radio; select it; expect the distro dropdown to
    //    contain the CI distro; expect "✓ claude found" hint.
    // 4. Working dir: type /tmp/cf-e2e (pre-created via wsl.exe mkdir -p).
    // 5. Create → terminal pane shows FAKE-CLAUDE-READY (proves the spawn ran
    //    INSIDE the distro through the login shell).
    // 6. Poll the sessions/history UI (or the observability pane) until the
    //    fake transcript's session appears — proves the polled UNC watcher
    //    ingests. Allow ~10s (1.5s poll interval + share latency).
    // 7. Workspace chip menu → Pause; then assert inside the distro:
    //    wsl.exe -- sh -c 'grep -c " T " /proc/$(cat /tmp/claude-fleet-*-*.pid)/stat' → State T (stopped)
    //    (read /proc/<pid>/stat field 3 == 'T'). Resume → state back to S/R.
  });
});
```

Write the fake-claude heredoc concretely in the spec file:

```ts
const FAKE_CLAUDE = `#!/bin/sh
echo FAKE-CLAUDE-READY
SID=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--session-id" ] || [ "$1" = "--resume" ]; then SID="$2"; shift; fi
  shift
done
[ -n "$SID" ] || SID=$(cat /proc/sys/kernel/random/uuid)
DIR="$HOME/.claude/projects/$(pwd | sed 's/[^a-zA-Z0-9]/-/g')"
mkdir -p "$DIR"
printf '{"type":"user","uuid":"%s-u1","sessionId":"%s","message":{"role":"user","content":"hi"}}\\n' "$SID" "$SID" > "$DIR/$SID.jsonl"
exec cat
`;
```

(Compare the JSONL line against what `db.ingestLine` accepts — read one line of a real transcript fixture in `tests/fixtures/` and match its shape; adjust the printf if the ingest schema needs more fields.)

- [ ] **Step 3: Linux-side assertion**

In `tests/local-backend.spec.ts`, inside an existing form-opening test (or a new one following its pattern):

```ts
    // Launcher section: WSL is Windows-only; custom command is everywhere (#253).
    await expect(page.getByLabel('Run claude in')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'WSL' })).toHaveCount(0);
    await page.getByRole('radio', { name: 'Custom command' }).check();
    await expect(page.getByLabel('Custom launch command')).toBeVisible();
```

- [ ] **Step 4: CI — install WSL on the Windows e2e job**

In `.github/workflows/build-app.yml`, `e2e-windows` job, add before the Playwright step:

```yaml
      # WSL distro for the wsl-local e2e specs (#253). setup-wsl handles the
      # no-reboot install; Alpine is the fastest distro. WSL2 needs the nested
      # virtualization now present on windows-2022+ hosted runners; the action
      # falls back cleanly and the specs skip if no distro ends up installed.
      - name: Set up WSL
        uses: Vampire/setup-wsl@v5
        continue-on-error: true   # WSL flakiness must not fail unrelated e2e
        with:
          distribution: Alpine
          wsl-version: 2
```

(Pin to the current major of `Vampire/setup-wsl` — check its README for the latest tag when implementing. Alpine's `sh` covers every probe one-liner; `getent` exists via musl.)

- [ ] **Step 5: Run what's runnable here (Linux)**

Run: `npm run build && npx playwright test tests/local-backend.spec.ts`
Expected: PASS including the new launcher-section assertions. `tests/wsl-local.spec.ts` reports "skipped".

- [ ] **Step 6: Commit**

```bash
git add tests/wsl-local.spec.ts tests/local-backend.spec.ts .github/workflows/build-app.yml
git commit -m "test: wsl-local e2e (real distro on Windows CI) + linux launcher-UI assertions (#253)"
```

---

### Task 10: SPEC.md + docs

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Edit the four sections (edit in place, present tense, no changelog prose)**

1. **§6 IPC surface** — add to the workspace/local group:
   - `local:listWslDistros → { distros, defaultDistro }` (win32; empty list elsewhere)
   - `local:probeWslDistro(distro) → { shells, loginShell, home, claudePath, interopEnabled }` (win32-only, rejects elsewhere)
   - Note `workspace:create` / `workspace:writeManifest` accept `launcher` (sanitized via strict allowlist; `wsl` refused off-win32).
2. **§7.3 Local backend** — add a *Launcher* paragraph: the three modes and their spawn shapes (copy the `wsl.exe -d <distro> --cd <cwd> -- <shell> -lic 'echo $$ > pidfile; exec claude …'` line); WSLENV env forwarding; the Windows-cwd/`--cd` split; save-time probe caching (`home`, `claudePath`) and the re-save-to-re-probe rule; pause = `kill -STOP` on the in-distro pidfile (wsl mode only — native/custom still unsupported); stop additionally TERMs via pidfile; MCP via interop (`/mnt/c` exe path, same per-workspace socket, identity unchanged, skipped when interop is off); transcripts watched over `\\wsl.localhost` with a second polling chokidar instance; custom mode = platform-shell template with `{claude}`/`{args}`, host-side transcript assumption.
3. **Data model** (§7 manifest description) — the `launcher` field union.
4. **§9 Security model** — one paragraph: `custom` executes a user-supplied command on the host with the user's own privileges (same trust the local backend already grants); wsl workspaces inherit the existing local-workspace caveat (identity not unspoofable, committee control still refused).

- [ ] **Step 2: Final gate**

Run: `npm test` (unit → build → playwright)
Expected: green (wsl spec skipped on Linux).

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): local-workspace launcher — IPC, data model, wsl mechanics, security note (#253)"
```

---

## Self-review checklist (run after all tasks)

- Spec coverage: manifest union ✓ (T3), probe UX ✓ (T2/T7/T8), spawn/env/pidfile ✓ (T1/T6), pause/stop ✓ (T6/T8), polled watcher ✓ (T4/T7), interop MCP ✓ (T5/T6), win32 gating ✓ (T3/T7/T8), custom everywhere ✓ (T1/T3/T8), UNC↔Linux working dir ✓ (T1/T7/T8), e2e + CI ✓ (T9), SPEC ✓ (T10).
- The one deliberate deviation from the spec doc: no separate `paths.ts` helper — `wslLocalProjectsDir` lives in `localLauncher.ts` (pure, injectable `encode`) so it's vitest-loadable without Electron.
