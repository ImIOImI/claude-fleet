# WSL Claude Freshness Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On wsl-launcher workspace start, detect a newer in-distro claude than the pinned `launcher.claudePath` and toast the user an option to adopt it (issue #336).

**Architecture:** A pure, exec-injected module (`wslClaudeFreshness.ts`, same discipline as `wslProbe.ts`) version-compares the pinned binary against the login shell's `command -v claude` and the well-known install dirs. `local.ts` wraps it with real manifest/exec IO; `ipc.ts` fires it fire-and-forget on the two start paths and broadcasts `local:claude-update-available`; the renderer shows a sticky keyed toast whose two buttons invoke `local:claude-update-decision` (adopt = rewrite `launcher.claudePath`; ignore = persist `launcher.ignoreClaudeVersion`).

**Tech Stack:** Electron main (TypeScript, pure-module + injected-deps pattern), vitest, React renderer, contextBridge preload.

## Global Constraints

- Work in the worktree `/workspace/claude-fleet/.claude/worktrees/wsl-claude-freshness` (branch `worktree-wsl-claude-freshness`). NEVER `cd /workspace/claude-fleet` (the base checkout is on a different branch); run everything from the worktree root.
- Unit tests resolve modules up into the base repo's `node_modules` — no `npm install` in the worktree. Run single files as `npx vitest run src/main/<file>.test.ts`.
- Pure main-process modules must not import `electron` or `node-pty` (vitest-loadable).
- Spec rule: `docs/SPEC.md` must be updated in the same PR (2 new IPC channels, 1 manifest field, 1 user flow) — Task 7.
- Commit messages: conventional prefix, end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No e2e for this feature (needs a real Windows+WSL host). Gate = `npm run typecheck` + unit tests + `npm run build`.

---

### Task 1: Pure freshness module

**Files:**
- Modify: `src/main/claudeResolve.ts:82` (add `export` to `wellKnownCandidates`)
- Create: `src/main/wslClaudeFreshness.ts`
- Test: `src/main/wslClaudeFreshness.test.ts`

**Interfaces:**
- Consumes: `posixQuote` from `./localLauncher.js`; `wellKnownCandidates(homedir, platform)` from `./claudeResolve.js` (exported in this task).
- Produces (used by Tasks 3–6):
  - `interface FreshnessDeps { exec(file: string, args: string[]): Promise<{ stdout: string }> }`
  - `interface ClaudeUpdate { pinned: { path: string; version: string | null }; best: { path: string; version: string } }`
  - `checkWslClaudeFreshness(l: { distro: string; shell: string; home: string; claudePath: string; ignoreClaudeVersion?: string }, deps: FreshnessDeps): Promise<ClaudeUpdate | null>`
  - Helpers: `parseClaudeVersion(out: string): string | null`, `compareVersions(a: string, b: string): number`, `versionBatchScript(paths: string[]): string`, `parseVersionBatch(stdout: string): Map<string, string | null>`

- [ ] **Step 1: Export `wellKnownCandidates`**

In `src/main/claudeResolve.ts` change line 82:

```ts
export function wellKnownCandidates(homedir: string, platform: NodeJS.Platform): string[] {
```

(Only the `export` keyword is added; body unchanged.)

- [ ] **Step 2: Write the failing test**

Create `src/main/wslClaudeFreshness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  checkWslClaudeFreshness,
  compareVersions,
  parseClaudeVersion,
  parseVersionBatch,
  versionBatchScript,
  type FreshnessDeps
} from './wslClaudeFreshness.js';

const LAUNCHER = {
  distro: 'Ubuntu',
  shell: '/usr/bin/zsh',
  home: '/home/troy',
  claudePath: '/home/troy/.local/bin/claude'
};

/** Fake exec: first call is the login-shell `command -v` (args contain '-lic'),
 *  second is the `sh -c` version batch. */
function fakeExec(loginStdout: string, versions: Record<string, string>): FreshnessDeps {
  return {
    exec: async (_file, args) => {
      if (args.includes('-lic')) return { stdout: loginStdout };
      // Batch: answer for every path the script asks about, empty when unknown.
      const script = args[args.length - 1];
      const lines: string[] = [];
      for (const m of script.matchAll(/printf '%s\\t%s\\n' '([^']+)'/g)) {
        const p = m[1];
        lines.push(`${p}\t${versions[p] ?? ''}`);
      }
      return { stdout: lines.join('\n') + '\n' };
    }
  };
}

describe('parseClaudeVersion', () => {
  it('extracts x.y.z from claude --version output', () => {
    expect(parseClaudeVersion('2.1.235 (Claude Code)')).toBe('2.1.235');
  });
  it('returns null for empty/garbage output', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('not found')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('2.1.235', '2.0.76')).toBeGreaterThan(0);
    expect(compareVersions('2.0.76', '2.1.235')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('versionBatchScript / parseVersionBatch', () => {
  it('quotes paths and round-trips path→version lines', () => {
    const script = versionBatchScript(["/opt/a b/claude"]);
    expect(script).toContain("'/opt/a b/claude'");
    const parsed = parseVersionBatch('/usr/bin/claude\t2.0.76 (Claude Code)\n/gone/claude\t\n');
    expect(parsed.get('/usr/bin/claude')).toBe('2.0.76');
    expect(parsed.get('/gone/claude')).toBeNull();
  });
  it('ignores rc chatter lines without a tab or leading slash', () => {
    const parsed = parseVersionBatch('welcome to zsh!\nnot-a-path\tjunk\n/x/claude\t1.0.0\n');
    expect(parsed.size).toBe(1);
    expect(parsed.get('/x/claude')).toBe('1.0.0');
  });
});

describe('checkWslClaudeFreshness', () => {
  it('reports a newer login-shell claude (the #336 case)', async () => {
    const deps = fakeExec('/home/troy/.nvm/versions/node/v22/bin/claude\n', {
      '/home/troy/.local/bin/claude': '2.0.76 (Claude Code)',
      '/home/troy/.nvm/versions/node/v22/bin/claude': '2.1.235 (Claude Code)'
    });
    const r = await checkWslClaudeFreshness(LAUNCHER, deps);
    expect(r).toEqual({
      pinned: { path: '/home/troy/.local/bin/claude', version: '2.0.76' },
      best: { path: '/home/troy/.nvm/versions/node/v22/bin/claude', version: '2.1.235' }
    });
  });

  it('takes the LAST absolute-path line of login-shell output (rc chatter)', async () => {
    const deps = fakeExec('motd banner\n/usr/bin/not-it says hi\n/opt/new/claude\n', {
      '/home/troy/.local/bin/claude': '2.0.76',
      '/opt/new/claude': '3.0.0'
    });
    const r = await checkWslClaudeFreshness(LAUNCHER, deps);
    expect(r?.best.path).toBe('/opt/new/claude');
  });

  it('returns null when the pinned binary is already the newest', async () => {
    const deps = fakeExec('/home/troy/.local/bin/claude\n', {
      '/home/troy/.local/bin/claude': '2.1.235',
      '/usr/local/bin/claude': '2.0.76'
    });
    expect(await checkWslClaudeFreshness(LAUNCHER, deps)).toBeNull();
  });

  it('returns null when nothing else resolves', async () => {
    const deps = fakeExec('', { '/home/troy/.local/bin/claude': '2.0.76' });
    expect(await checkWslClaudeFreshness(LAUNCHER, deps)).toBeNull();
  });

  it('suppresses offers at or below ignoreClaudeVersion, allows newer', async () => {
    const versions = {
      '/home/troy/.local/bin/claude': '2.0.76',
      '/usr/local/bin/claude': '2.1.235'
    };
    expect(
      await checkWslClaudeFreshness(
        { ...LAUNCHER, ignoreClaudeVersion: '2.1.235' },
        fakeExec('', versions)
      )
    ).toBeNull();
    const r = await checkWslClaudeFreshness(
      { ...LAUNCHER, ignoreClaudeVersion: '2.1.100' },
      fakeExec('', versions)
    );
    expect(r?.best.version).toBe('2.1.235');
  });

  it('reports any working candidate when the pinned binary no longer runs', async () => {
    const deps = fakeExec('', { '/usr/local/bin/claude': '2.0.1' });
    const r = await checkWslClaudeFreshness(LAUNCHER, deps);
    expect(r).toEqual({
      pinned: { path: '/home/troy/.local/bin/claude', version: null },
      best: { path: '/usr/local/bin/claude', version: '2.0.1' }
    });
  });

  it('survives a rejecting exec (returns null, never throws)', async () => {
    const deps: FreshnessDeps = { exec: async () => Promise.reject(new Error('wsl gone')) };
    expect(await checkWslClaudeFreshness(LAUNCHER, deps)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/wslClaudeFreshness.test.ts`
Expected: FAIL — `Cannot find module './wslClaudeFreshness.js'` (or equivalent resolve error).

- [ ] **Step 4: Write the implementation**

Create `src/main/wslClaudeFreshness.ts`:

```ts
// Start-time staleness check for wsl-launcher workspaces (#336). The manifest
// pins `launcher.claudePath` at save time and wrapSpawnForLauncher execs it
// unconditionally, so a distro that later gains a newer claude at a different
// path strands the workspace on the old binary invisibly. This module answers
// "did the distro grow a newer claude since?" by version-comparing the pinned
// path against the login shell's `command -v claude` (what the user's own
// terminal runs — the save-time probe never consults it when a well-known dir
// hits) and the well-known install dirs.
//
// Pure module: exec is injected (wsl.exe in production, fakes in vitest).
// Same discipline as wslProbe.ts / claudeResolve.ts.

import { wellKnownCandidates } from './claudeResolve.js';
import { posixQuote } from './localLauncher.js';

export interface FreshnessDeps {
  /** execFile utf8 — in-distro commands via wsl.exe; rejects on non-zero. */
  exec(file: string, args: string[]): Promise<{ stdout: string }>;
}

export interface ClaudeUpdate {
  /** version null ⇒ the pinned binary no longer runs (or prints no version). */
  pinned: { path: string; version: string | null };
  best: { path: string; version: string };
}

/** `claude --version` prints e.g. "2.1.235 (Claude Code)" — take the triple. */
export function parseClaudeVersion(out: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric x.y.z comparison: <0, 0, >0 (lexical order lies past single digits). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** One `sh -c` line per path: `<path>\t<first --version line, empty if broken>`.
 *  A single wsl.exe round-trip versions every candidate. */
export function versionBatchScript(paths: string[]): string {
  return paths
    .map(
      (p) =>
        `v=$(${posixQuote(p)} --version 2>/dev/null | head -n1); ` +
        `printf '%s\\t%s\\n' ${posixQuote(p)} "$v"`
    )
    .join('; ');
}

export function parseVersionBatch(stdout: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(0, tab);
    if (!path.startsWith('/')) continue; // shell/motd chatter guard
    out.set(path, parseClaudeVersion(line.slice(tab + 1)));
  }
  return out;
}

/**
 * Report a strictly-newer in-distro claude than the pinned one, or null.
 * - Candidates: pinned path + login-shell `command -v claude` + well-known dirs.
 * - A pinned binary that no longer runs makes ANY working candidate an offer
 *   (today that workspace fails to spawn with no explanation).
 * - `ignoreClaudeVersion` ("Keep" from a previous toast) suppresses offers at
 *   or below that version.
 * Never throws — probe failures degrade to null (no toast).
 */
export async function checkWslClaudeFreshness(
  l: {
    distro: string;
    shell: string;
    home: string;
    claudePath: string;
    ignoreClaudeVersion?: string;
  },
  deps: FreshnessDeps
): Promise<ClaudeUpdate | null> {
  // What the user's own terminal calls `claude`: login+interactive shell,
  // last absolute-path line wins (rc files may print banners first —
  // same tolerance as claudeResolve.ts's commandV).
  const login = await deps
    .exec('wsl.exe', ['-d', l.distro, '--exec', l.shell, '-lic', 'command -v claude'])
    .catch(() => ({ stdout: '' }));
  let loginPath: string | null = null;
  const loginLines = login.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = loginLines.length - 1; i >= 0; i--) {
    if (loginLines[i].startsWith('/')) {
      loginPath = loginLines[i];
      break;
    }
  }

  const candidates = [
    ...new Set([
      l.claudePath,
      ...(loginPath ? [loginPath] : []),
      ...wellKnownCandidates(l.home, 'linux')
    ])
  ];
  const batch = await deps
    .exec('wsl.exe', ['-d', l.distro, '--exec', 'sh', '-c', versionBatchScript(candidates)])
    .catch(() => ({ stdout: '' }));
  const versions = parseVersionBatch(batch.stdout);

  const pinnedVersion = versions.get(l.claudePath) ?? null;
  let best: { path: string; version: string } | null = null;
  for (const [path, version] of versions) {
    if (path === l.claudePath || version === null) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { path, version };
  }
  if (!best) return null;
  if (pinnedVersion !== null && compareVersions(best.version, pinnedVersion) <= 0) return null;
  if (l.ignoreClaudeVersion && compareVersions(best.version, l.ignoreClaudeVersion) <= 0) {
    return null;
  }
  return { pinned: { path: l.claudePath, version: pinnedVersion }, best };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/wslClaudeFreshness.test.ts`
Expected: PASS (all tests).

Also run the untouched-behavior guard: `npx vitest run src/main/claudeResolve.test.ts` (the export-only change must not break it).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/wslClaudeFreshness.ts src/main/wslClaudeFreshness.test.ts src/main/claudeResolve.ts
git commit -m "feat: pure freshness check for wsl-pinned claude (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Manifest field + decision helper

**Files:**
- Modify: `src/main/localLauncher.ts` (wsl variant of `WorkspaceLauncher`; new `applyClaudeUpdateDecision`)
- Modify: `src/main/workspaces.ts:225-241` (`sanitizeLauncher` wsl branch)
- Test: `src/main/localLauncher.test.ts`, `src/main/workspacesLauncher.test.ts`

**Interfaces:**
- Consumes: `WorkspaceLauncher` (existing).
- Produces (used by Task 4):
  - wsl launcher gains `ignoreClaudeVersion?: string`
  - `type ClaudeUpdateDecision = { action: 'adopt'; path: string } | { action: 'ignore'; version: string }`
  - `applyClaudeUpdateDecision(launcher: WorkspaceLauncher, decision: ClaudeUpdateDecision): WorkspaceLauncher` (throws on non-wsl launcher)

- [ ] **Step 1: Write the failing tests**

Append to `src/main/localLauncher.test.ts` (match its existing import style):

```ts
describe('applyClaudeUpdateDecision', () => {
  const wsl = {
    mode: 'wsl' as const,
    distro: 'Ubuntu',
    shell: '/bin/bash',
    home: '/home/u',
    claudePath: '/home/u/.local/bin/claude',
    ignoreClaudeVersion: '2.1.0'
  };

  it('adopt rewrites claudePath and clears ignoreClaudeVersion', () => {
    const out = applyClaudeUpdateDecision(wsl, { action: 'adopt', path: '/opt/claude' });
    expect(out).toEqual({
      mode: 'wsl',
      distro: 'Ubuntu',
      shell: '/bin/bash',
      home: '/home/u',
      claudePath: '/opt/claude'
    });
  });

  it('ignore persists the version and keeps claudePath', () => {
    const out = applyClaudeUpdateDecision(wsl, { action: 'ignore', version: '2.2.0' });
    expect(out).toEqual({ ...wsl, ignoreClaudeVersion: '2.2.0' });
  });

  it('throws for non-wsl launchers', () => {
    expect(() =>
      applyClaudeUpdateDecision({ mode: 'native' }, { action: 'ignore', version: '1.0.0' })
    ).toThrow(/wsl/);
  });
});
```

(Import `applyClaudeUpdateDecision` alongside the file's existing `./localLauncher.js` imports, and `describe/expect/it` if the file scopes them per-block.)

Append to `src/main/workspacesLauncher.test.ts` (inside/alongside its existing wsl sanitize cases, reusing its existing valid-wsl fixture shape):

```ts
it('round-trips ignoreClaudeVersion on a wsl launcher', () => {
  const l = sanitizeLauncher(
    {
      mode: 'wsl',
      distro: 'Ubuntu',
      shell: '/bin/bash',
      home: '/home/u',
      claudePath: '/home/u/.local/bin/claude',
      ignoreClaudeVersion: '2.1.235'
    },
    'win32'
  );
  expect(l).toMatchObject({ mode: 'wsl', ignoreClaudeVersion: '2.1.235' });
});

it('drops a non-string/empty ignoreClaudeVersion', () => {
  const base = {
    mode: 'wsl',
    distro: 'Ubuntu',
    shell: '/bin/bash',
    home: '/home/u',
    claudePath: '/home/u/.local/bin/claude'
  };
  expect(sanitizeLauncher({ ...base, ignoreClaudeVersion: 7 }, 'win32')).not.toHaveProperty(
    'ignoreClaudeVersion'
  );
  expect(sanitizeLauncher({ ...base, ignoreClaudeVersion: '' }, 'win32')).not.toHaveProperty(
    'ignoreClaudeVersion'
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/localLauncher.test.ts src/main/workspacesLauncher.test.ts`
Expected: FAIL — `applyClaudeUpdateDecision` not exported; `ignoreClaudeVersion` stripped by sanitize.

- [ ] **Step 3: Implement**

In `src/main/localLauncher.ts`, wsl variant of `WorkspaceLauncher` (after the `interopEnabled?: boolean;` member), add:

```ts
      /** "Keep" from the newer-claude toast (#336): suppress update offers at
       *  or below this version. Cleared when the user adopts a new path. */
      ignoreClaudeVersion?: string;
```

Below `wrapSpawnForLauncher` (or near `posixQuote`, either is fine — keep the file's grouping), add:

```ts
/** The two buttons on the newer-claude toast (#336). */
export type ClaudeUpdateDecision =
  | { action: 'adopt'; path: string }
  | { action: 'ignore'; version: string };

/** Fold a toast decision into the launcher. Pure — the caller persists the
 *  returned launcher via writeWorkspaceManifest. */
export function applyClaudeUpdateDecision(
  launcher: WorkspaceLauncher,
  decision: ClaudeUpdateDecision
): WorkspaceLauncher {
  if (launcher.mode !== 'wsl') {
    throw new Error(`claude-update decisions only apply to wsl launchers (got ${launcher.mode})`);
  }
  if (decision.action === 'adopt') {
    const { ignoreClaudeVersion: _cleared, ...rest } = launcher;
    return { ...rest, claudePath: decision.path };
  }
  return { ...launcher, ignoreClaudeVersion: decision.version };
}
```

In `src/main/workspaces.ts` `sanitizeLauncher` wsl branch, destructure the new field and round-trip it (mirror the `interopEnabled` treatment):

```ts
    const { distro, shell, home, claudePath, interopEnabled, ignoreClaudeVersion } =
      o as Record<string, unknown>;
    if ([distro, shell, home, claudePath].every((v) => typeof v === 'string' && v)) {
      return {
        mode: 'wsl',
        distro: distro as string,
        shell: shell as string,
        home: home as string,
        claudePath: claudePath as string,
        // Only a real boolean round-trips (#259). Missing or garbage stays
        // undefined = "not probed" = still wire MCP, which is what every
        // manifest written before this field existed must keep doing.
        ...(typeof interopEnabled === 'boolean' ? { interopEnabled } : {}),
        // "Keep" persistence for the newer-claude toast (#336).
        ...(typeof ignoreClaudeVersion === 'string' && ignoreClaudeVersion
          ? { ignoreClaudeVersion }
          : {})
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/localLauncher.test.ts src/main/workspacesLauncher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/localLauncher.ts src/main/localLauncher.test.ts src/main/workspaces.ts src/main/workspacesLauncher.test.ts
git commit -m "feat: ignoreClaudeVersion manifest field + decision helper (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: local.ts backend wrapper

**Files:**
- Modify: `src/main/local.ts` (new exported function; imports)

**Interfaces:**
- Consumes: `checkWslClaudeFreshness`, `ClaudeUpdate` (Task 1); `readWorkspaceManifest`, `execFileAsync` (already imported/defined in `local.ts`).
- Produces (used by Task 4): `checkClaudeFreshness(id: string): Promise<(ClaudeUpdate & { distro: string }) | null>`

- [ ] **Step 1: Implement (thin IO wrapper — no unit test; the logic under it is tested in Task 1, and this file needs node-pty)**

Add to `src/main/local.ts` (near `startWorkspace`, which is around line 422):

```ts
/**
 * Start-time staleness check for a wsl-launcher workspace (#336): did the
 * distro grow a claude newer than the manifest-pinned one? Null for non-wsl
 * workspaces and on any probe failure — callers treat null as "no cue".
 */
export async function checkClaudeFreshness(
  id: string
): Promise<(ClaudeUpdate & { distro: string }) | null> {
  const m = await readWorkspaceManifest(id);
  if (!m || m.kind !== 'local' || m.launcher?.mode !== 'wsl') return null;
  const update = await checkWslClaudeFreshness(m.launcher, {
    exec: (file, args) => execFileAsync(file, args)
  });
  return update ? { ...update, distro: m.launcher.distro } : null;
}
```

Add the import at the top with the other `./` imports:

```ts
import { checkWslClaudeFreshness, type ClaudeUpdate } from './wslClaudeFreshness.js';
```

Note: `execFileAsync` in `local.ts` returns `{ stdout, stderr }` with string stdout — structurally satisfies `FreshnessDeps['exec']`. If its type is `Buffer`-flavored, wrap: `exec: async (f, a) => { const { stdout } = await execFileAsync(f, a); return { stdout: String(stdout) }; }`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (0 errors).

- [ ] **Step 3: Commit**

```bash
git add src/main/local.ts
git commit -m "feat: local backend claude-freshness wrapper (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: IPC wiring (broadcast + decision handle)

**Files:**
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: `realLocal.checkClaudeFreshness` (Task 3 — `import * as realLocal from './local.js'` already exists at `ipc.ts:42`); `applyClaudeUpdateDecision`, `ClaudeUpdateDecision` (Task 2); `readWorkspaceManifest`, `writeWorkspaceManifest` (already imported); `BrowserWindow` (already imported for `broadcastPortDetected`).
- Produces (used by Task 5):
  - main → renderer event `local:claude-update-available`, payload `{ workspaceId: string; distro: string; pinned: { path: string; version: string | null }; best: { path: string; version: string } }`
  - `ipcMain.handle('local:claude-update-decision', (workspaceId: string, decision: ClaudeUpdateDecision) => Promise<void>)`

- [ ] **Step 1: Implement**

Add the import (extend the existing `./localLauncher.js` import if one exists, else add):

```ts
import { applyClaudeUpdateDecision, type ClaudeUpdateDecision } from './localLauncher.js';
```

Next to `broadcastPortDetected` (`ipc.ts:171`), add:

```ts
/** Fire-and-forget newer-claude check on wsl-workspace start (#336). Runs in
 *  the background (~1-2s of wsl.exe probing) and never delays the start path;
 *  a hit fans out to every window as a toast cue. */
function scheduleClaudeFreshnessCheck(workspaceId: string): void {
  void realLocal
    .checkClaudeFreshness(workspaceId)
    .then((update) => {
      if (!update) return;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send('local:claude-update-available', { workspaceId, ...update });
        } catch {
          /* frame disposed mid-send */
        }
      }
    })
    .catch(() => {});
}
```

In the `sessions:resume` handler (`ipc.ts:~1061`), after `invalidateWorkspaceList();` add:

```ts
      scheduleClaudeFreshnessCheck(workspaceId);
```

In the `workspace:start` handler (`ipc.ts:~1075`), after `await touchWorkspaceUsed(id);` add:

```ts
    scheduleClaudeFreshnessCheck(id);
```

(Both self-guard: `checkClaudeFreshness` returns null for anything that isn't a wsl-launcher local workspace, so container workspaces and mock mode are no-ops.)

Near the other `workspace:*`/`local` handles (after `workspace:getManifest` is fine), add:

```ts
  /** Fold a newer-claude toast decision into the workspace manifest (#336).
   *  adopt: repin launcher.claudePath (new sessions only — live PTYs keep
   *  their running binary). ignore: persist ignoreClaudeVersion so the toast
   *  only returns for something strictly newer. */
  ipcMain.handle(
    'local:claude-update-decision',
    async (_e, workspaceId: string, decision: ClaudeUpdateDecision): Promise<void> => {
      const m = await readWorkspaceManifest(workspaceId);
      if (!m || m.launcher?.mode !== 'wsl') {
        throw new Error(`${workspaceId} is not a wsl-launcher workspace`);
      }
      await writeWorkspaceManifest({
        ...m,
        launcher: applyClaudeUpdateDecision(m.launcher, decision)
      });
    }
  );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat: broadcast newer-claude cue on wsl start + decision handle (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Preload API

**Files:**
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: the two channels from Task 4.
- Produces (used by Task 6): `window.api.claudeUpdate.onAvailable(cb): () => void` and `window.api.claudeUpdate.decide(workspaceId, decision): Promise<void>` (renderer types flow from `export type FleetApi = typeof api` at `preload/index.ts:722` — no separate d.ts edit).

- [ ] **Step 1: Implement**

In the `api` object (a sibling of the `ports:` group around line 549), add:

```ts
  // Newer-claude cue for wsl-launcher workspaces (#336).
  claudeUpdate: {
    /** Subscribe to "a newer in-distro claude exists" cues (start-time check).
     *  Returns an unsubscribe function. */
    onAvailable: (
      cb: (update: {
        workspaceId: string;
        distro: string;
        pinned: { path: string; version: string | null };
        best: { path: string; version: string };
      }) => void
    ): (() => void) => {
      const channel = 'local:claude-update-available';
      const handler = (
        _e: IpcRendererEvent,
        payload: {
          workspaceId: string;
          distro: string;
          pinned: { path: string; version: string | null };
          best: { path: string; version: string };
        }
      ): void => cb(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Persist a toast decision: adopt repins launcher.claudePath (new
     *  sessions only), ignore suppresses re-offers up to that version. */
    decide: (
      workspaceId: string,
      decision: { action: 'adopt'; path: string } | { action: 'ignore'; version: string }
    ): Promise<void> => ipcRenderer.invoke('local:claude-update-decision', workspaceId, decision)
  },
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat: preload api.claudeUpdate (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Renderer toast (secondary action + subscription)

**Files:**
- Modify: `src/renderer/src/toasts.ts` (add `secondaryAction`)
- Modify: `src/renderer/src/components/Toast.tsx` (render it)
- Modify: `src/renderer/src/App.tsx` (subscribe + toast)
- Test: `src/renderer/src/toasts.test.ts`

**Interfaces:**
- Consumes: `window.api.claudeUpdate` (Task 5); existing `makeToast`, `dispatchToast`, `toastIdRef`, `workspacesRef` in App.tsx.
- Produces: `Toast.secondaryAction?: ToastAction` (available to future toasts).

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/toasts.test.ts` (match its existing import style):

```ts
it('makeToast carries secondaryAction through', () => {
  const noop = (): void => {};
  const t = makeToast(1, {
    kind: 'info',
    message: 'm',
    placement: 'global',
    sticky: true,
    dismissible: true,
    action: { label: 'A', onClick: noop },
    secondaryAction: { label: 'B', onClick: noop }
  });
  expect(t.secondaryAction?.label).toBe('B');
});
```

- [ ] **Step 2: Verify the gap (typecheck, not vitest)**

Vitest strips types, and `makeToast` spreads its input — so the new test PASSES at runtime even before the implementation. The red signal here is the type layer:

Run: `npm run typecheck`
Expected: FAIL — excess-property error on `secondaryAction` in `toasts.test.ts`.

- [ ] **Step 3: Implement**

`src/renderer/src/toasts.ts` — in the `Toast` interface, after the `action?: ToastAction;` member:

```ts
  /** Optional second inline action, e.g. the "Keep" next to "Use newer" on
   *  the newer-claude toast (#336). Rendered after `action`. */
  secondaryAction?: ToastAction;
```

`src/renderer/src/components/Toast.tsx` — after the `{toast.action && (...)}` block (ends line ~41):

```tsx
      {toast.secondaryAction && (
        <button className="toast-action" onClick={toast.secondaryAction.onClick}>
          {toast.secondaryAction.label}
        </button>
      )}
```

`src/renderer/src/App.tsx` — new effect directly after the `ports.onDetected` effect (ends around line 515), same style:

```tsx
  // Newer-claude cue (#336): a wsl-launcher workspace started and its distro
  // has a claude newer than the manifest-pinned one. Sticky + keyed per
  // workspace (a re-start replaces the toast instead of stacking). "Use newer"
  // repins the manifest — new sessions only; "Keep" suppresses re-offers up
  // to that version. Plain ✕ just snoozes until the next start.
  useEffect(() => {
    return window.api.claudeUpdate.onAvailable(({ workspaceId, distro, pinned, best }) => {
      const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
      const pinnedLabel = pinned.version
        ? `pinned to ${pinned.version}`
        : 'pinned to a binary that no longer runs';
      const id = ++toastIdRef.current;
      dispatchToast({
        type: 'push',
        toast: makeToast(id, {
          kind: 'info',
          eyebrow: 'Claude update',
          key: `claude-update:${workspaceId}`,
          message: `Claude Code ${best.version} found in ${distro} — ${name} is ${pinnedLabel}. Applies to new sessions.`,
          placement: 'global',
          sticky: true,
          dismissible: true,
          action: {
            label: 'Use newer',
            onClick: () => {
              dispatchToast({ type: 'dismiss', id });
              void window.api.claudeUpdate
                .decide(workspaceId, { action: 'adopt', path: best.path })
                .catch(() => {
                  pushToast(`Couldn't update ${name}'s claude path.`, 'Claude update', 6000, 'error');
                });
            }
          },
          secondaryAction: {
            label: 'Keep',
            onClick: () => {
              dispatchToast({ type: 'dismiss', id });
              void window.api.claudeUpdate
                .decide(workspaceId, { action: 'ignore', version: best.version })
                .catch(() => {});
            }
          }
        })
      });
    });
    // dispatchToast/pushToast are stable (useReducer/useCallback []).
  }, []);
```

(If the surrounding effects list `pushToast` in deps or use an eslint-disable, match that file's existing convention — the `ports.onDetected` effect is the template.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/renderer/src/toasts.test.ts && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/toasts.ts src/renderer/src/toasts.test.ts src/renderer/src/components/Toast.tsx src/renderer/src/App.tsx
git commit -m "feat: newer-claude toast with Use newer / Keep actions (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: SPEC.md + design-doc alignment

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/superpowers/specs/2026-08-19-wsl-claude-freshness-design.md`

- [ ] **Step 1: Update SPEC.md**

Three edits:

1. **IPC surface** — near the `ports:detected` entry (`docs/SPEC.md:260`), add:

```markdown
- `local:claude-update-available` (main → renderer event) — `{ workspaceId, distro, pinned: { path, version|null }, best: { path, version } }`. Fired (fire-and-forget, never blocking the start path) after `workspace:start` / `sessions:resume` brings up a **wsl-launcher** workspace whose distro has a claude strictly newer than the manifest-pinned `launcher.claudePath` (`wslClaudeFreshness.ts`: version-compares the pinned path, the login shell's `command -v claude`, and the well-known install dirs in one wsl.exe batch; a pinned binary that no longer runs makes any working candidate an offer). The renderer shows a sticky toast keyed `claude-update:<workspaceId>` with **Use newer** / **Keep** actions; plain ✕ snoozes until the next start.
- `local:claude-update-decision` (invoke) — `(workspaceId, { action: 'adopt', path } | { action: 'ignore', version })`. adopt repins `launcher.claudePath` (new sessions only; live PTYs keep their running binary) and clears `ignoreClaudeVersion`; ignore persists `launcher.ignoreClaudeVersion` so the toast only returns for something strictly newer.
```

2. **Data model** — extend the `launcher` line in the manifest field list (`docs/SPEC.md:397`) with: `wsl launchers may carry ignoreClaudeVersion (the "Keep" suppression from the newer-claude toast, #336).`

3. **Launcher section** (`docs/SPEC.md:489` area) — add one sentence to the wsl-mode description: `Because claudePath is pinned at save time, workspace start fires a background freshness check that offers strictly-newer in-distro claudes via toast (#336) — see the IPC surface entries above.`

- [ ] **Step 2: Align the design doc**

In `docs/superpowers/specs/2026-08-19-wsl-claude-freshness-design.md`, replace the `### Adopt` and `### Keep` sections' channel naming with the single implemented channel:

Replace:
```markdown
### Adopt — `ipcMain.handle('local:adopt-claude', (workspaceId, path))`

Rewrites `launcher.claudePath` via `writeWorkspaceManifest` and clears
`ignoreClaudeVersion`. Existing PTYs keep their running process.

### Keep

Persists `launcher.ignoreClaudeVersion = best.version`. The toast reappears
only when something strictly newer than the ignored version shows up.
```

With:
```markdown
### Decisions — `ipcMain.handle('local:claude-update-decision', (workspaceId, decision))`

One channel for both toast buttons:
- `{ action: 'adopt', path }` rewrites `launcher.claudePath` via
  `writeWorkspaceManifest` and clears `ignoreClaudeVersion`. Existing PTYs
  keep their running process.
- `{ action: 'ignore', version }` persists `launcher.ignoreClaudeVersion`;
  the toast reappears only for something strictly newer.
```

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-08-19-wsl-claude-freshness-design.md
git commit -m "docs: SPEC entries for the newer-claude cue + decision channel (#336)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full gate + PR

- [ ] **Step 1: Full unit suite**

Run: `npm run test:unit`
Expected: PASS (pre-existing flaky exception: `control.test.ts` can fail to LOAD under parallel vitest — issue #324; a re-run of just that file passing is acceptable and must be noted in the PR).

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin worktree-wsl-claude-freshness
gh pr create -R imioimi/claude-fleet --title "Offer a newer in-distro claude on wsl-workspace start" --body "$(cat <<'EOF'
Closes #336.

wsl-launcher workspaces pin `launcher.claudePath` at save time and exec it unconditionally, so a distro that gains a newer claude at a different path strands the workspace on the old binary invisibly (observed: host at 2.1.235, workspace stuck on 2.0.76).

- `wslClaudeFreshness.ts` (pure, exec-injected): version-compares the pinned path vs the login shell's `command -v claude` + well-known dirs in one wsl.exe batch; strictly-newer (or pinned-broken) → cue.
- Fired fire-and-forget from `workspace:start` / `sessions:resume`; broadcast as `local:claude-update-available`.
- Sticky keyed toast: **Use newer** repins `launcher.claudePath` (new sessions only), **Keep** persists `launcher.ignoreClaudeVersion` (re-offers only for strictly newer). ✕ snoozes until next start.
- New manifest field `ignoreClaudeVersion` round-trips through `sanitizeLauncher`; toasts gain an optional `secondaryAction`.
- SPEC.md updated (2 IPC channels, manifest field, user flow).

Verified with typecheck + unit tests + build; no UI verification possible in this container (no display) — Troy: start your local-wsl workspace and check the toast, both buttons, and that a new session runs the adopted binary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.
