# Extra Mounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a container workspace bind extra host folders (host path → container path, optional read-only), set in the create/edit form and shown on the observability rail.

**Architecture:** A new optional manifest field `mounts`. Pure container-path rules live in `src/preload/extraMounts.ts` (the only dir both tsconfigs compile) so the form and main share one copy. Main adds host-path checks (exists, realpath not inside userData / another workspace's private folder) and turns mounts into Docker `HostConfig.Mounts` binds. The form gets an env-editor-style row list; the rail gets one row per mount.

**Tech Stack:** Electron main (Node, dockerode), React renderer, vitest.

Spec: `docs/superpowers/specs/2026-11-10-extra-mounts-design.md`. Mockups (Option A + Rail 1): https://claude.ai/code/artifact/dbe2ac44-638f-4df1-a0bc-bf97e1b330d6

## Global Constraints

- Container workspaces only; local and remote ignore/drop `mounts`.
- Reserved container prefixes (equal or under): `/shared`, `/home/fleet/.claude`, `/home/fleet/.claude.json`, `/run/broker`, `/fleet/mcp`, `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`. Also refuse `/` and exactly `/workspace`. `/workspace/<sub>` and `/mnt/...` are allowed.
- Host path refused when its realpath is inside `<userData>` or inside `<fleetRoot>/<otherId>` for any id other than this workspace's.
- Default container path: `/mnt/<basename>`; empty container path saves as that default.
- Docker mounts via `HostConfig.Mounts` `{ Type: 'bind', Source, Target, ReadOnly }`, never `Binds` strings.
- Copy (verbatim):
  - form hint: `Leave the container path empty to use the suggested one. Mounts can't go under /shared, ~/.claude or system folders.`
  - reserved error: `<prefix> is <what>. Use a path outside it, like /mnt/<basename>.` (see Task 1 table)
  - missing at create: `extra mount <hostPath> no longer exists`
- Code comments: terse, only non-obvious why (`.claude/rules/review-conventions.md`).
- SPEC.md updated in the same PR (`.claude/rules/spec-maintenance.md`).
- Gate: run `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json` **separately** (the combined script short-circuits), `npx vitest run`, `npm run build`. No display in the container; UI is eyeballed on host.
- Worktree: `/workspace/wt-extra-mounts`, branch `feat/extra-mounts`. Install deps once with `npm ci --ignore-scripts` in the worktree; never `cd /workspace/claude-fleet`.

---

### Task 1: Shared container-path rules

**Files:**
- Create: `src/preload/extraMounts.ts`
- Create: `src/preload/extraMounts.test.ts`
- Modify: `tsconfig.web.json` (add `"src/preload/extraMounts.ts"` to `include`)

**Interfaces:**
- Produces:
  - `interface ExtraMount { hostPath: string; containerPath: string; readOnly: boolean }`
  - `defaultContainerPath(hostPath: string): string`
  - `normalizeContainerPath(p: string): string`
  - `containerPathError(containerPath: string, hostPath: string): string | null`
  - `duplicateContainerPaths(mounts: Pick<ExtraMount, 'containerPath'>[]): Set<string>`
  - `sanitizeMounts(raw: unknown): ExtraMount[] | undefined` (shape-only; drops malformed entries; `undefined` when none survive)

- [ ] **Step 1: Write the failing tests**

```ts
// src/preload/extraMounts.test.ts
import { describe, expect, it } from 'vitest';
import {
  containerPathError,
  defaultContainerPath,
  duplicateContainerPaths,
  normalizeContainerPath,
  sanitizeMounts
} from './extraMounts';

describe('defaultContainerPath', () => {
  it('uses the basename of a Windows path', () => {
    expect(defaultContainerPath('C:\\Users\\troy\\src\\tofumate')).toBe('/mnt/tofumate');
  });
  it('uses the basename of a POSIX path and ignores a trailing slash', () => {
    expect(defaultContainerPath('/home/troy/data/')).toBe('/mnt/data');
  });
  it('replaces characters outside [A-Za-z0-9._-]', () => {
    expect(defaultContainerPath('D:\\My Stuff')).toBe('/mnt/My-Stuff');
  });
  it('falls back to /mnt/folder for a drive root or empty input', () => {
    expect(defaultContainerPath('C:\\')).toBe('/mnt/folder');
    expect(defaultContainerPath('')).toBe('/mnt/folder');
  });
});

describe('normalizeContainerPath', () => {
  it('collapses slashes and strips a trailing slash', () => {
    expect(normalizeContainerPath('/mnt//data/')).toBe('/mnt/data');
  });
  it('resolves dot segments', () => {
    expect(normalizeContainerPath('/mnt/a/../b')).toBe('/mnt/b');
  });
});

describe('containerPathError', () => {
  const host = 'C:\\Users\\troy\\notes';
  it('accepts /mnt and /workspace subpaths', () => {
    expect(containerPathError('/mnt/notes', host)).toBeNull();
    expect(containerPathError('/workspace/tofumate', host)).toBeNull();
  });
  it('requires an absolute path', () => {
    expect(containerPathError('mnt/notes', host)).toBe('Container path must start with /.');
  });
  it('refuses / and /workspace itself', () => {
    expect(containerPathError('/', host)).toBe("/ can't be replaced. Use a path like /mnt/notes.");
    expect(containerPathError('/workspace/', host)).toBe(
      "/workspace is this workspace's private folder. Mount inside it, like /workspace/notes, or use /mnt/notes."
    );
  });
  it('refuses reserved prefixes with the spec copy', () => {
    expect(containerPathError('/shared/notes', host)).toBe(
      "/shared is the fleet's shared folder. Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/home/fleet/.claude/x', host)).toBe(
      "/home/fleet/.claude is claude's settings folder. Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/etc', host)).toBe(
      '/etc is a system folder. Use a path outside it, like /mnt/notes.'
    );
  });
  it('does not treat a shared name prefix as a match', () => {
    expect(containerPathError('/shared-data', host)).toBeNull();
    expect(containerPathError('/libs', host)).toBeNull();
  });
});

describe('duplicateContainerPaths', () => {
  it('returns normalized paths used more than once', () => {
    expect(
      duplicateContainerPaths([{ containerPath: '/mnt/a' }, { containerPath: '/mnt/a/' }, { containerPath: '/mnt/b' }])
    ).toEqual(new Set(['/mnt/a']));
  });
});

describe('sanitizeMounts', () => {
  it('keeps well-formed entries and coerces readOnly', () => {
    expect(
      sanitizeMounts([
        { hostPath: '/a', containerPath: '/mnt/a', readOnly: true },
        { hostPath: '/b', containerPath: '/mnt/b' },
        { hostPath: '', containerPath: '/mnt/c', readOnly: false },
        { hostPath: '/d' },
        'junk'
      ])
    ).toEqual([
      { hostPath: '/a', containerPath: '/mnt/a', readOnly: true },
      { hostPath: '/b', containerPath: '/mnt/b', readOnly: false }
    ]);
  });
  it('returns undefined for non-arrays and empty results', () => {
    expect(sanitizeMounts(undefined)).toBeUndefined();
    expect(sanitizeMounts([])).toBeUndefined();
    expect(sanitizeMounts({})).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/preload/extraMounts.test.ts`
Expected: FAIL — cannot resolve `./extraMounts`.

- [ ] **Step 3: Implement**

```ts
// src/preload/extraMounts.ts
// Shared by main and renderer (the only dir both tsconfigs compile).

export interface ExtraMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

const RESERVED: ReadonlyArray<readonly [prefix: string, what: string]> = [
  ['/shared', "the fleet's shared folder"],
  ['/home/fleet/.claude.json', "claude's settings file"],
  ['/home/fleet/.claude', "claude's settings folder"],
  ['/run/broker', "the app's session broker folder"],
  ['/fleet/mcp', "the app's MCP socket folder"],
  ['/proc', 'a system folder'],
  ['/sys', 'a system folder'],
  ['/dev', 'a system folder'],
  ['/etc', 'a system folder'],
  ['/usr', 'a system folder'],
  ['/bin', 'a system folder'],
  ['/sbin', 'a system folder'],
  ['/lib64', 'a system folder'],
  ['/lib', 'a system folder']
];

function basename(hostPath: string): string {
  const parts = hostPath.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  // A bare drive ("C:") has no usable name.
  if (/^[A-Za-z]:$/.test(last)) return '';
  return last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function defaultContainerPath(hostPath: string): string {
  return `/mnt/${basename(hostPath) || 'folder'}`;
}

export function normalizeContainerPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

export function containerPathError(containerPath: string, hostPath: string): string | null {
  const suggestion = defaultContainerPath(hostPath);
  const name = suggestion.slice('/mnt/'.length);
  if (!containerPath.startsWith('/')) return 'Container path must start with /.';
  const p = normalizeContainerPath(containerPath);
  if (p === '/') return `/ can't be replaced. Use a path like ${suggestion}.`;
  if (p === '/workspace') {
    return `/workspace is this workspace's private folder. Mount inside it, like /workspace/${name}, or use ${suggestion}.`;
  }
  for (const [prefix, what] of RESERVED) {
    if (under(p, prefix)) return `${prefix} is ${what}. Use a path outside it, like ${suggestion}.`;
  }
  return null;
}

export function duplicateContainerPaths(mounts: Pick<ExtraMount, 'containerPath'>[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const m of mounts) {
    const p = normalizeContainerPath(m.containerPath);
    if (seen.has(p)) dupes.add(p);
    seen.add(p);
  }
  return dupes;
}

export function sanitizeMounts(raw: unknown): ExtraMount[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ExtraMount[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const { hostPath, containerPath, readOnly } = m as Record<string, unknown>;
    if (typeof hostPath !== 'string' || !hostPath) continue;
    if (typeof containerPath !== 'string' || !containerPath) continue;
    out.push({ hostPath, containerPath, readOnly: readOnly === true });
  }
  return out.length ? out : undefined;
}
```

Note: `/home/fleet/.claude.json` is listed before `/home/fleet/.claude` so its own message wins; `under()` already keeps them distinct (`.claude.json` is not under `.claude/`). `/lib64` before `/lib` for the same reason.

- [ ] **Step 4: Add to web tsconfig**

In `tsconfig.web.json`, append `"src/preload/extraMounts.ts"` to the `include` array (after `"src/preload/federation.ts"`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/preload/extraMounts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/preload/extraMounts.ts src/preload/extraMounts.test.ts tsconfig.web.json
git commit -m "feat(mounts): shared container-path rules for extra mounts"
```

---

### Task 2: Manifest field + read sanitize

**Files:**
- Modify: `src/main/workspaces.ts` (`WorkspaceSpec` ~line 184; `readWorkspaceManifest` return object ~line 361)
- Modify: `src/preload/index.ts` (the renderer-facing workspace type near `resources?: WorkspaceResources;` ~line 212)
- Modify: `src/renderer/src/App.tsx` (`WorkspaceSummary` ~line 149)
- Test: `src/main/workspacesManifestRead.test.ts`

**Interfaces:**
- Consumes: `ExtraMount`, `sanitizeMounts` from Task 1.
- Produces: `WorkspaceSpec.mounts?: ExtraMount[]`, `WorkspaceSummary.mounts?: ExtraMount[]`, same field on the preload workspace type.

- [ ] **Step 1: Write the failing test**

Open `src/main/workspacesManifestRead.test.ts`, follow its existing setup (it writes a `workspace.json` into a temp state dir and calls `readWorkspaceManifest`). Add:

```ts
it('keeps well-formed mounts on a container manifest', async () => {
  const id = await writeRawManifest({ ...baseManifest(), kind: 'container', mounts: [
    { hostPath: '/data', containerPath: '/mnt/data', readOnly: true },
    { hostPath: 7 }
  ] });
  expect((await readWorkspaceManifest(id))?.mounts).toEqual([
    { hostPath: '/data', containerPath: '/mnt/data', readOnly: true }
  ]);
});

it('drops mounts on a local manifest', async () => {
  const id = await writeRawManifest({ ...baseManifest(), kind: 'local', mounts: [
    { hostPath: '/data', containerPath: '/mnt/data', readOnly: false }
  ] });
  expect((await readWorkspaceManifest(id))?.mounts).toBeUndefined();
});
```

Use the file's existing helpers for writing a raw manifest and building a base object; if they're named differently, rename `writeRawManifest`/`baseManifest` in these two tests to match.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/main/workspacesManifestRead.test.ts`
Expected: FAIL — `mounts` is `undefined` in the first test.

- [ ] **Step 3: Implement**

`src/main/workspaces.ts`:

```ts
import { sanitizeMounts, type ExtraMount } from '../preload/extraMounts.js';
```

In `WorkspaceSpec`, after `resources?: WorkspaceResources;`:

```ts
  /** kind 'container' only: extra host folders bound into the container. */
  mounts?: ExtraMount[];
```

In `readWorkspaceManifest`'s returned object, after `resources: parsed.resources,`:

```ts
      mounts: kind === 'container' ? sanitizeMounts((parsed as { mounts?: unknown }).mounts) : undefined,
```

`src/preload/index.ts`: `import type { ExtraMount } from './extraMounts';` and add `mounts?: ExtraMount[];` after `resources?: WorkspaceResources;` in the workspace type. Re-export: `export type { ExtraMount } from './extraMounts';`.

`src/renderer/src/App.tsx` `WorkspaceSummary`: add `mounts?: ExtraMount[];` after `resources?`, importing `import type { ExtraMount } from '../../preload/extraMounts';`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/workspacesManifestRead.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the list path carries the field**

Run: `grep -n "\.\.\.m\b\|\.\.\.manifest\|\.\.\.spec" src/main/ipc.ts | head`
`workspace:list` merges manifests into `Workspace` rows; confirm it spreads the manifest (so `mounts` flows to the renderer with no extra code). If it builds rows field-by-field instead, add `mounts: m.mounts` next to `resources`.

- [ ] **Step 6: Commit**

```bash
git add src/main/workspaces.ts src/preload/index.ts src/renderer/src/App.tsx src/main/workspacesManifestRead.test.ts
git commit -m "feat(mounts): mounts manifest field, sanitized on read"
```

---

### Task 3: Host-path validation + Docker mount assembly (main)

**Files:**
- Create: `src/main/extraMountsHost.ts`
- Create: `src/main/extraMountsHost.test.ts`

**Interfaces:**
- Consumes: `ExtraMount`, `containerPathError`, `duplicateContainerPaths`, `normalizeContainerPath`, `defaultContainerPath` (Task 1).
- Produces:
  - `validateExtraMounts(mounts: ExtraMount[] | undefined, ctx: MountCtx): Promise<ExtraMount[] | undefined>` — throws `Error` naming the row; returns normalized mounts (container path normalized, empty → default).
  - `interface MountCtx { ownId: string; userData: string; fleetRoot: string }`
  - `toDockerMounts(mounts: ExtraMount[] | undefined): Promise<Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }>>` — throws `extra mount <hostPath> no longer exists` when a source is gone.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/extraMountsHost.test.ts
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { toDockerMounts, validateExtraMounts, type MountCtx } from './extraMountsHost';

const OWN = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = '01JBBBBBBBBBBBBBBBBBBBBBBB';
let root: string;
let ctx: MountCtx;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mounts-'));
  const userData = join(root, 'userData');
  const fleetRoot = join(root, 'fleet');
  data = join(root, 'data');
  await mkdir(join(userData, 'state'), { recursive: true });
  await mkdir(join(fleetRoot, OWN), { recursive: true });
  await mkdir(join(fleetRoot, OTHER), { recursive: true });
  await mkdir(data);
  ctx = { ownId: OWN, userData, fleetRoot };
});

describe('validateExtraMounts', () => {
  it('returns undefined for no mounts', async () => {
    expect(await validateExtraMounts(undefined, ctx)).toBeUndefined();
    expect(await validateExtraMounts([], ctx)).toBeUndefined();
  });

  it('normalizes the container path and fills the default', async () => {
    expect(
      await validateExtraMounts(
        [
          { hostPath: data, containerPath: '/mnt//d/', readOnly: true },
          { hostPath: data, containerPath: '', readOnly: false }
        ],
        ctx
      )
    ).toEqual([
      { hostPath: data, containerPath: '/mnt/d', readOnly: true },
      { hostPath: data, containerPath: '/mnt/data', readOnly: false }
    ]);
  });

  it('rejects a missing host folder', async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(root, 'nope'), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow(`Mount 1: ${join(root, 'nope')} doesn't exist or isn't a folder.`);
  });

  it('rejects a file', async () => {
    const f = join(root, 'f.txt');
    await writeFile(f, '');
    await expect(validateExtraMounts([{ hostPath: f, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      "doesn't exist or isn't a folder"
    );
  });

  it('rejects userData and a symlink into it', async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.userData, 'state'), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: that folder holds the app's private data and can't be mounted.");
    const link = join(root, 'sneaky');
    await symlink(ctx.userData, link);
    await expect(
      validateExtraMounts([{ hostPath: link, containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("app's private data");
  });

  it("rejects another workspace's private folder but allows its own", async () => {
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, OTHER), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: that folder is another workspace's private folder.");
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, OWN), containerPath: '/mnt/x', readOnly: false }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('allows the fleet shared folder and the fleet root siblings that are not workspace ids', async () => {
    await mkdir(join(ctx.fleetRoot, 'shared'));
    await expect(
      validateExtraMounts([{ hostPath: join(ctx.fleetRoot, 'shared'), containerPath: '/mnt/s', readOnly: true }], ctx)
    ).resolves.toHaveLength(1);
  });

  it('rejects reserved container paths with the shared copy', async () => {
    await expect(
      validateExtraMounts([{ hostPath: data, containerPath: '/shared/x', readOnly: false }], ctx)
    ).rejects.toThrow("Mount 1: /shared is the fleet's shared folder. Use a path outside it, like /mnt/data.");
  });

  it('rejects duplicate container paths', async () => {
    await expect(
      validateExtraMounts(
        [
          { hostPath: data, containerPath: '/mnt/a', readOnly: false },
          { hostPath: data, containerPath: '/mnt/a/', readOnly: false }
        ],
        ctx
      )
    ).rejects.toThrow('Mount 2: /mnt/a is already used by another mount.');
  });
});

describe('toDockerMounts', () => {
  it('builds bind mounts', async () => {
    expect(await toDockerMounts([{ hostPath: data, containerPath: '/mnt/data', readOnly: true }])).toEqual([
      { Type: 'bind', Source: data, Target: '/mnt/data', ReadOnly: true }
    ]);
  });
  it('fails clearly when a source disappeared', async () => {
    const gone = join(root, 'gone');
    await expect(toDockerMounts([{ hostPath: gone, containerPath: '/mnt/g', readOnly: false }])).rejects.toThrow(
      `extra mount ${gone} no longer exists`
    );
  });
  it('returns [] for none', async () => {
    expect(await toDockerMounts(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/main/extraMountsHost.test.ts`
Expected: FAIL — cannot resolve `./extraMountsHost`.

- [ ] **Step 3: Implement**

```ts
// src/main/extraMountsHost.ts
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  containerPathError,
  defaultContainerPath,
  duplicateContainerPaths,
  normalizeContainerPath,
  type ExtraMount
} from '../preload/extraMounts.js';

export interface MountCtx {
  ownId: string;
  userData: string;
  fleetRoot: string;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

async function realDir(p: string): Promise<string | null> {
  try {
    const real = await realpath(p);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function realOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

export async function validateExtraMounts(
  mounts: ExtraMount[] | undefined,
  ctx: MountCtx
): Promise<ExtraMount[] | undefined> {
  if (!mounts?.length) return undefined;
  const userData = await realOrSelf(ctx.userData);
  const fleetRoot = await realOrSelf(ctx.fleetRoot);
  const out: ExtraMount[] = [];
  for (const [i, m] of mounts.entries()) {
    const label = `Mount ${i + 1}`;
    const real = await realDir(m.hostPath);
    if (!real) throw new Error(`${label}: ${m.hostPath} doesn't exist or isn't a folder.`);
    if (inside(real, userData) || inside(userData, real)) {
      throw new Error(`${label}: that folder holds the app's private data and can't be mounted.`);
    }
    if (inside(real, fleetRoot)) {
      const first = relative(fleetRoot, real).split(sep)[0] ?? '';
      if (ULID_RE.test(first) && first !== ctx.ownId) {
        throw new Error(`${label}: that folder is another workspace's private folder.`);
      }
    } else if (inside(fleetRoot, real)) {
      // Mounting an ancestor of the fleet root would expose every workspace's private folder.
      throw new Error(`${label}: that folder contains other workspaces' private folders.`);
    }
    const containerPath = normalizeContainerPath(m.containerPath.trim() || defaultContainerPath(m.hostPath));
    const err = containerPathError(containerPath, m.hostPath);
    if (err) throw new Error(`${label}: ${err}`);
    out.push({ hostPath: m.hostPath, containerPath, readOnly: m.readOnly === true });
  }
  const dupes = duplicateContainerPaths(out);
  if (dupes.size) {
    const seen = new Set<string>();
    for (const [i, m] of out.entries()) {
      if (seen.has(m.containerPath)) throw new Error(`Mount ${i + 1}: ${m.containerPath} is already used by another mount.`);
      seen.add(m.containerPath);
    }
  }
  return out;
}

export async function toDockerMounts(
  mounts: ExtraMount[] | undefined
): Promise<Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }>> {
  const out: Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }> = [];
  for (const m of mounts ?? []) {
    if (!(await realDir(m.hostPath))) throw new Error(`extra mount ${m.hostPath} no longer exists`);
    out.push({ Type: 'bind', Source: m.hostPath, Target: m.containerPath, ReadOnly: m.readOnly });
  }
  return out;
}
```

The "ancestor of userData / fleet root" checks (`inside(userData, real)`, `inside(fleetRoot, real)`) go beyond the spec's wording but are required by its intent: mounting `C:\Users\troy` would otherwise expose AppData and `~/fleet`. Add these two tests to the `validateExtraMounts` block:

```ts
  it('rejects an ancestor of userData', async () => {
    await expect(validateExtraMounts([{ hostPath: root, containerPath: '/mnt/x', readOnly: false }], ctx)).rejects.toThrow(
      "app's private data"
    );
  });
```

(`root` contains both userData and the fleet root; the userData check fires first.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/extraMountsHost.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/extraMountsHost.ts src/main/extraMountsHost.test.ts
git commit -m "feat(mounts): host-path validation and docker bind assembly"
```

---

### Task 4: Wire mounts through create, writeManifest, docker create, and recreate

**Files:**
- Modify: `src/main/docker.ts` (`CreateWorkspaceInput` ~line 124; `createWorkspaceInner` `hostCfg` ~line 658)
- Modify: `src/main/ipc.ts` (`WorkspaceCreatePayload` ~line 485; `workspace:create` ~line 1258; `workspace:writeManifest` ~line 1535)
- Modify: `src/renderer/src/workspaceLifecycle.ts` (`applyContainerEdit` create payload ~line 70)
- Modify: `src/renderer/src/App.tsx` (both `window.api.workspace.create({...})` calls ~1178 and ~1287, `writeManifest` ~1320, clone ~1386)
- Test: `src/renderer/src/workspaceLifecycle.test.ts`

**Interfaces:**
- Consumes: `validateExtraMounts`, `toDockerMounts`, `MountCtx` (Task 3); `WorkspaceSpec.mounts` (Task 2); `WorkspaceFormSubmit.mounts` (added in Task 5 — add the field to the type here as `mounts?: ExtraMount[]` in `src/renderer/src/components/WorkspaceForm.tsx` `WorkspaceFormSubmit`, after `resources?`, so this task compiles).
- Produces: `CreateWorkspaceInput.mounts?: ExtraMount[]`; `WorkspaceCreatePayload.mounts?: unknown`.

- [ ] **Step 1: Write the failing test**

In `src/renderer/src/workspaceLifecycle.test.ts`, inside `describe('applyContainerEdit')`, add (reuse the file's existing fake `api` builder; the name below matches the pattern at line ~52, adjust if different):

```ts
it('passes mounts and endpointId through to create', async () => {
  const api = makeApi({
    manifest: {
      ...baseManifest,
      authMode: 'endpoint',
      endpointId: 'ep-1',
      mounts: [{ hostPath: '/data', containerPath: '/mnt/data', readOnly: true }]
    }
  });
  await applyContainerEdit(api, { id: 'ws-1', containerId: 'c-1' });
  expect(api.create).toHaveBeenCalledWith(
    expect.objectContaining({
      endpointId: 'ep-1',
      mounts: [{ hostPath: '/data', containerPath: '/mnt/data', readOnly: true }]
    })
  );
});
```

Add `mounts?: ExtraMount[]` and `endpointId?: string` to the local `WorkspaceManifest` type in `workspaceLifecycle.ts` if it doesn't already carry them.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/renderer/src/workspaceLifecycle.test.ts`
Expected: FAIL — `mounts` (and `endpointId`) missing from the create call.

- [ ] **Step 3: Implement `applyContainerEdit`**

In the `api.create({...})` object, after `resources: spec.resources,` add:

```ts
    endpointId: spec.endpointId,
    mounts: spec.mounts,
```

(`endpointId` was already missing here, so a Restart on an endpoint workspace hit the "Pick a model endpoint" guard; this fixes it in passing.)

- [ ] **Step 4: Run test**

Run: `npx vitest run src/renderer/src/workspaceLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: docker.ts**

`CreateWorkspaceInput`, after `resources?: WorkspaceResources;`:

```ts
  /** Extra host folders; already validated by the IPC layer. */
  mounts?: ExtraMount[];
```

Import: `import type { ExtraMount } from '../preload/extraMounts.js';` and `import { toDockerMounts } from './extraMountsHost.js';`.

In `createWorkspaceInner`, change the `hostCfg` literal to include `Mounts`:

```ts
  const hostCfg: Docker.HostConfig = {
    Binds: binds,
    // Mounts, not Binds strings: Windows drive letters make host:ctr:ro ambiguous,
    // and Binds silently creates a missing host dir as root.
    Mounts: await toDockerMounts(spec.mounts),
    AutoRemove: false,
```

- [ ] **Step 6: ipc.ts**

Imports: `import { validateExtraMounts } from './extraMountsHost.js';` and `import { sanitizeMounts } from '../preload/extraMounts.js';`. Confirm `getFleetRoot` is importable from `./config.js` (it is used by `fleetPrivateDir`); import it.

`WorkspaceCreatePayload`, after `resources?`:

```ts
  /** kind 'container' only; validated server-side. */
  mounts?: unknown;
```

Add one helper near the top of the handler-registration function (next to other local helpers):

```ts
  const mountsFor = async (kind: WorkspaceKind, id: string, raw: unknown) =>
    kind === 'container'
      ? validateExtraMounts(sanitizeMounts(raw), {
          ownId: id,
          userData: app.getPath('userData'),
          fleetRoot: await getFleetRoot()
        })
      : undefined;
```

`workspace:create`: after the endpoint guard (`if (input.authMode === 'endpoint' && !input.endpointId) ...`), add:

```ts
      const mounts = await mountsFor(kind, input.id, input.mounts);
```

Pass `mounts` into `backendForKind(kind).createWorkspace({...})` (after `resources: input.resources,`) and into the `spec` literal (after `resources: input.resources,`).

`workspace:writeManifest`: after the `workspaceRoot` block, before `writeWorkspaceManifest`:

```ts
      const mounts = await mountsFor(spec.kind, spec.id, (spec as { mounts?: unknown }).mounts);
```

and add `mounts,` to the object passed to `writeWorkspaceManifest` (after `launcher: incomingLauncher,`). This is authoritative: an edit that removes all mounts writes `undefined`, clearing them.

- [ ] **Step 7: App.tsx call sites**

In both `window.api.workspace.create({...})` calls (create + recreate-from-saved), add after `resources: submit.resources,`:

```ts
      mounts: submit.mounts,
```

In the `writeManifest({...})` call in the edit handler (~line 1334), add `mounts: submit.mounts,` after `resources: submit.resources,`. In the clone builder (~line 1386), add `mounts: source.mounts,` after `resources: source.resources,`.

In `src/renderer/src/components/formInitial.ts` `workspaceToFormInitial`, add `mounts: w.mounts,` after `resources: w.resources,`.

- [ ] **Step 8: Typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx vitest run src/main src/renderer/src/workspaceLifecycle.test.ts src/renderer/src/components/formInitial.test.ts`
Expected: both typechecks clean; tests PASS. If `formInitial.test.ts` snapshots the full object, add `mounts: undefined` / the fixture's mounts to its expectation.

- [ ] **Step 9: Commit**

```bash
git add src/main/docker.ts src/main/ipc.ts src/renderer/src/workspaceLifecycle.ts src/renderer/src/workspaceLifecycle.test.ts src/renderer/src/App.tsx src/renderer/src/components/formInitial.ts src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/components/formInitial.test.ts
git commit -m "feat(mounts): validate and apply extra mounts on create, edit, and recreate"
```

---

### Task 5: Form — Extra mounts section + restart-banner detection

**Files:**
- Create: `src/renderer/src/components/mountRows.ts`
- Create: `src/renderer/src/components/mountRows.test.ts`
- Modify: `src/renderer/src/components/WorkspaceForm.tsx` (state ~line 263; submit ~line 523/592; JSX between Env vars `</details>` and Resource caps ~line 1246)
- Modify: `src/renderer/src/components/EditWorkspaceModal.tsx` (`containerLevelChanged` ~line 120)
- Modify: `src/renderer/src/styles.css` (after `.env-row-remove:hover` ~line 2680)
- Test: `src/renderer/src/components/editWorkspaceModal.test.ts` if one exists for `containerLevelChanged` (`grep -rln containerLevelChanged src/renderer/src`); otherwise add the cases to `mountRows.test.ts` importing from `./EditWorkspaceModal`.

**Interfaces:**
- Consumes: `ExtraMount`, `containerPathError`, `defaultContainerPath`, `duplicateContainerPaths`, `normalizeContainerPath` (Task 1).
- Produces:
  - `interface MountRow { hostPath: string; containerPath: string; readOnly: boolean }`
  - `rowsFromMounts(m?: ExtraMount[]): MountRow[]`
  - `mountsFromRows(rows: MountRow[]): ExtraMount[] | undefined`
  - `mountRowErrors(rows: MountRow[]): (string | null)[]`
  - `mountsSummary(m?: ExtraMount[]): string`
  - `hostPlaceholder(platform: string): string`
  - `mountsEqual(a?: ExtraMount[], b?: ExtraMount[]): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/components/mountRows.test.ts
import { describe, expect, it } from 'vitest';
import {
  hostPlaceholder,
  mountRowErrors,
  mountsEqual,
  mountsFromRows,
  mountsSummary,
  rowsFromMounts
} from './mountRows';

describe('mountsFromRows', () => {
  it('drops rows without a host path and fills the default container path', () => {
    expect(
      mountsFromRows([
        { hostPath: '  ', containerPath: '/mnt/x', readOnly: false },
        { hostPath: 'C:\\data\\play-cards', containerPath: '', readOnly: true },
        { hostPath: '/srv/a', containerPath: '/mnt/a/', readOnly: false }
      ])
    ).toEqual([
      { hostPath: 'C:\\data\\play-cards', containerPath: '/mnt/play-cards', readOnly: true },
      { hostPath: '/srv/a', containerPath: '/mnt/a', readOnly: false }
    ]);
  });
  it('returns undefined when nothing survives', () => {
    expect(mountsFromRows([])).toBeUndefined();
  });
});

describe('mountRowErrors', () => {
  it('flags reserved and duplicate paths per row, skipping blank rows', () => {
    expect(
      mountRowErrors([
        { hostPath: 'C:\\notes', containerPath: '/shared/notes', readOnly: false },
        { hostPath: '/a', containerPath: '/mnt/a', readOnly: false },
        { hostPath: '/b', containerPath: '/mnt/a', readOnly: false },
        { hostPath: '', containerPath: '', readOnly: false }
      ])
    ).toEqual([
      "/shared is the fleet's shared folder. Use a path outside it, like /mnt/notes.",
      null,
      '/mnt/a is already used by another mount.',
      null
    ]);
  });
  it('checks the default path when the container path is empty', () => {
    expect(mountRowErrors([{ hostPath: '/x/etc', containerPath: '', readOnly: false }])).toEqual([null]);
  });
});

describe('mountsSummary', () => {
  it('describes counts', () => {
    expect(mountsSummary(undefined)).toBe('(none)');
    expect(mountsSummary([{ hostPath: '/a', containerPath: '/mnt/a', readOnly: false }])).toBe('1 folder');
    expect(
      mountsSummary([
        { hostPath: '/a', containerPath: '/mnt/a', readOnly: true },
        { hostPath: '/b', containerPath: '/mnt/b', readOnly: false }
      ])
    ).toBe('2 folders · 1 read-only');
  });
});

describe('hostPlaceholder', () => {
  it('is platform-specific', () => {
    expect(hostPlaceholder('win32')).toBe('C:\\path\\to\\folder');
    expect(hostPlaceholder('linux')).toBe('/home/you/folder');
  });
});

describe('rowsFromMounts / mountsEqual', () => {
  it('round-trips and compares by value', () => {
    const m = [{ hostPath: '/a', containerPath: '/mnt/a', readOnly: true }];
    expect(mountsFromRows(rowsFromMounts(m))).toEqual(m);
    expect(mountsEqual(m, [{ ...m[0] }])).toBe(true);
    expect(mountsEqual(m, undefined)).toBe(false);
    expect(mountsEqual(undefined, [])).toBe(true);
  });
});
```

Add to the same file (or the existing `containerLevelChanged` test file):

```ts
import { containerLevelChanged } from './EditWorkspaceModal';
// Build `before`/`after` from that file's existing fixtures; if none, use minimal casts:
it('treats a mounts change as container-level', () => {
  const before = { authMode: 'oauth', image: 'img', env: { plain: {}, secretKeys: [] }, mounts: undefined } as never;
  const after = { authMode: 'oauth', image: 'img', plainEnv: {}, secretKeys: [], secrets: {},
    mounts: [{ hostPath: '/a', containerPath: '/mnt/a', readOnly: false }] } as never;
  expect(containerLevelChanged(before, after)).toBe(true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/renderer/src/components/mountRows.test.ts`
Expected: FAIL — cannot resolve `./mountRows`.

- [ ] **Step 3: Implement `mountRows.ts`**

```ts
// src/renderer/src/components/mountRows.ts
import {
  containerPathError,
  defaultContainerPath,
  normalizeContainerPath,
  type ExtraMount
} from '../../../preload/extraMounts';

export interface MountRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export const rowsFromMounts = (m?: ExtraMount[]): MountRow[] => (m ?? []).map((x) => ({ ...x }));

const effectivePath = (r: MountRow) => normalizeContainerPath(r.containerPath.trim() || defaultContainerPath(r.hostPath));

export function mountsFromRows(rows: MountRow[]): ExtraMount[] | undefined {
  const out = rows
    .filter((r) => r.hostPath.trim())
    .map((r) => ({ hostPath: r.hostPath.trim(), containerPath: effectivePath(r), readOnly: r.readOnly }));
  return out.length ? out : undefined;
}

export function mountRowErrors(rows: MountRow[]): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!r.hostPath.trim()) return null;
    const raw = r.containerPath.trim() || defaultContainerPath(r.hostPath);
    const err = containerPathError(raw, r.hostPath);
    if (err) return err;
    const p = normalizeContainerPath(raw);
    if (seen.has(p)) return `${p} is already used by another mount.`;
    seen.add(p);
    return null;
  });
}

export function mountsSummary(m?: ExtraMount[]): string {
  if (!m?.length) return '(none)';
  const ro = m.filter((x) => x.readOnly).length;
  return `${m.length} folder${m.length === 1 ? '' : 's'}${ro ? ` · ${ro} read-only` : ''}`;
}

export const hostPlaceholder = (platform: string) => (platform === 'win32' ? 'C:\\path\\to\\folder' : '/home/you/folder');

export function mountsEqual(a?: ExtraMount[], b?: ExtraMount[]): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return (
    x.length === y.length &&
    x.every((m, i) => m.hostPath === y[i].hostPath && m.containerPath === y[i].containerPath && m.readOnly === y[i].readOnly)
  );
}
```

- [ ] **Step 4: `containerLevelChanged`**

In `EditWorkspaceModal.tsx`, import `mountsEqual` from `./mountRows` and add before the final `return false`:

```ts
  if (!mountsEqual(before.mounts, after.mounts)) return true;
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/renderer/src/components/mountRows.test.ts`
Expected: PASS.

- [ ] **Step 6: Form state + submit**

In `WorkspaceForm.tsx` imports: `import { hostPlaceholder, mountRowErrors, mountsFromRows, mountsSummary, rowsFromMounts, type MountRow } from './mountRows';` and `import { defaultContainerPath } from '../../../preload/extraMounts';`.

State, after `const [resourcesOpen, setResourcesOpen] = useState(false);`:

```tsx
  const [mountRows, setMountRows] = useState<MountRow[]>(() => rowsFromMounts(initial?.mounts));
  const [mountsOpen, setMountsOpen] = useState(false);
  const mountErrors = mountRowErrors(mountRows);
  const updateMountRow = (i: number, patch: Partial<MountRow>) =>
    setMountRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
```

Find the platform source the form already uses for win32-specific UI (`grep -n "win32\|platform" src/renderer/src/components/WorkspaceForm.tsx`) and bind `const platform = <that value>;`. If none, use `window.api.app.platform` if it exists in preload (`grep -n platform src/preload/index.ts`); otherwise fall back to `navigator.userAgent.includes('Windows') ? 'win32' : 'other'`.

Submit validation: where the form blocks submit on other invalid fields (look for the early `return` guarded by `nameOk`), add:

```tsx
    if (kind === 'container' && mountErrors.some(Boolean)) {
      setMountsOpen(true);
      return;
    }
```

Payload (next to `resources,` ~line 592):

```tsx
      mounts: kind === 'container' ? mountsFromRows(mountRows) : undefined,
```

- [ ] **Step 7: Form JSX**

Insert between the Env vars `</details>` and `{kind === 'container' && (<details ... Resource caps`:

```tsx
      {kind === 'container' && (
        <details
          className="form-disclosure"
          open={mountsOpen}
          onToggle={(e) => setMountsOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Extra mounts{' '}
            <span className="form-hint">{mountsSummary(mountsFromRows(mountRows))}</span>
          </summary>
          <div className="env-editor">
            {mountRows.length > 0 && (
              <div className="mount-colhead" aria-hidden="true">
                <span>Host folder</span>
                <span>In the container</span>
              </div>
            )}
            {mountRows.map((row, i) => (
              <div className="mount-row" key={i}>
                <input
                  aria-label={`Host folder ${i + 1}`}
                  value={row.hostPath}
                  onChange={(e) => updateMountRow(i, { hostPath: e.target.value })}
                  placeholder={hostPlaceholder(platform)}
                  spellCheck={false}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn mount-browse"
                  onClick={async () => {
                    const picked = await window.api.dialog.pickDirectory(row.hostPath || undefined);
                    if (picked) updateMountRow(i, { hostPath: picked });
                  }}
                  disabled={busy}
                >
                  Browse…
                </button>
                <span className="mount-arrow" aria-hidden="true">→</span>
                <input
                  aria-label={`Container path ${i + 1}`}
                  className={mountErrors[i] ? 'invalid' : undefined}
                  value={row.containerPath}
                  onChange={(e) => updateMountRow(i, { containerPath: e.target.value })}
                  placeholder={row.hostPath.trim() ? defaultContainerPath(row.hostPath) : '/mnt/folder'}
                  spellCheck={false}
                  disabled={busy}
                />
                <label className="env-secret-toggle">
                  <input
                    type="checkbox"
                    checked={row.readOnly}
                    onChange={(e) => updateMountRow(i, { readOnly: e.target.checked })}
                    disabled={busy}
                  />
                  <span>read-only</span>
                </label>
                <button
                  type="button"
                  className="env-row-remove"
                  aria-label={`Remove mount ${i + 1}`}
                  onClick={() => setMountRows((rows) => rows.filter((_, j) => j !== i))}
                  disabled={busy}
                >
                  ×
                </button>
                {mountErrors[i] && (
                  <div className="mount-row-note" role="alert">{mountErrors[i]}</div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn"
              onClick={() => setMountRows((rows) => [...rows, { hostPath: '', containerPath: '', readOnly: false }])}
              disabled={busy}
            >
              + Add mount
            </button>
            <p className="form-hint mount-hint">
              Leave the container path empty to use the suggested one. Mounts can&apos;t go under /shared, ~/.claude or system folders.
            </p>
          </div>
        </details>
      )}
```

- [ ] **Step 8: CSS**

Append after `.env-row-remove:hover { ... }` in `styles.css`:

```css
.mount-colhead,
.mount-row {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) auto 14px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
}
.mount-colhead {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.mount-colhead span:nth-child(1) { grid-column: 1 / 3; }
.mount-colhead span:nth-child(2) { grid-column: 4 / -1; }
.mount-row input:not([type='checkbox']) {
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  min-width: 0;
}
.mount-row input::placeholder { color: var(--ink-3); }
.mount-row input.invalid { border-color: color-mix(in oklch, var(--danger) 60%, var(--rule)); }
.mount-row .mount-browse { padding: 4px 10px; }
.mount-arrow { color: var(--ink-3); text-align: center; font-size: 12px; }
.mount-row-note { grid-column: 4 / -1; margin-top: -2px; font-size: 11px; color: var(--danger); }
.env-editor > .btn { align-self: flex-start; }
.mount-hint { margin: 2px 0 0; font-size: 11px; color: var(--ink-2); }
```

Check first: `grep -n "\.env-editor > \.btn\|\.env-editor \.btn" src/renderer/src/styles.css`. If the env editor's "+ Add env var" button already renders full-width today and that's intended, drop the `.env-editor > .btn` line so this PR doesn't restyle Env vars.

- [ ] **Step 9: Typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run src/renderer`
Expected: clean; PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/components/mountRows.ts src/renderer/src/components/mountRows.test.ts src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/components/EditWorkspaceModal.tsx src/renderer/src/styles.css
git commit -m "feat(mounts): Extra mounts section in the workspace form"
```

---

### Task 6: Observability rail rows

**Files:**
- Modify: `src/renderer/src/observabilityWorkspace.ts` (add `mountRowTitle`)
- Modify: `src/renderer/src/observabilityWorkspace.test.ts` (create if absent)
- Modify: `src/renderer/src/components/ObservabilityPane.tsx` (`WorkspaceBlock`, after the `shared` button ~line 527)
- Modify: `src/renderer/src/styles.css` (after `button.obs-ws-row:hover .obs-ws-icon` ~line 1188)

**Interfaces:**
- Consumes: `WorkspaceSummary.mounts` (Task 2).
- Produces: `mountRowTitle(m: ExtraMount): string`.

- [ ] **Step 1: Failing test**

```ts
// in src/renderer/src/observabilityWorkspace.test.ts
import { mountRowTitle } from './observabilityWorkspace';

describe('mountRowTitle', () => {
  it('names the host folder and read-only state', () => {
    expect(mountRowTitle({ hostPath: 'D:\\datasets\\nfl', containerPath: '/mnt/nfl', readOnly: true })).toBe(
      'Open D:\\datasets\\nfl (read-only)'
    );
    expect(mountRowTitle({ hostPath: '/srv/a', containerPath: '/mnt/a', readOnly: false })).toBe('Open /srv/a');
  });
});
```

(Add `import { describe, expect, it } from 'vitest';` if creating the file.)

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run src/renderer/src/observabilityWorkspace.test.ts`

- [ ] **Step 3: Implement helper**

```ts
// src/renderer/src/observabilityWorkspace.ts
import type { ExtraMount } from '../../preload/extraMounts';

export const mountRowTitle = (m: ExtraMount): string => `Open ${m.hostPath}${m.readOnly ? ' (read-only)' : ''}`;
```

- [ ] **Step 4: Rail JSX**

In `WorkspaceBlock`, import `mountRowTitle` alongside the existing `observabilityWorkspace` imports, and insert after the `{sharedDir && (...)}` block:

```tsx
        {workspace.kind === 'container' &&
          workspace.mounts?.map((m) => (
            <button
              key={m.containerPath}
              type="button"
              className="obs-ws-row obs-ws-action"
              onClick={() => openPath(m.hostPath)}
              title={mountRowTitle(m)}
            >
              <span className="obs-ws-key">mount</span>
              <span className="obs-ws-val mono">{m.containerPath}</span>
              <span className="obs-ws-icon" aria-hidden="true">
                {m.readOnly && <span className="obs-ws-ro">ro</span>}
                <FolderIcon />
              </span>
            </button>
          ))}
```

If `WorkspaceBlock`'s `workspace` prop type lacks `kind`/`mounts`, it is `WorkspaceSummary` from `App.tsx` (already extended in Task 2); if it's a narrower local type, add `kind?: string; mounts?: ExtraMount[]`.

- [ ] **Step 5: CSS**

```css
.obs-ws-icon { gap: 6px; }
.obs-ws-ro {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--info);
  border: 1px solid color-mix(in oklch, var(--info) 40%, var(--rule));
  border-radius: 3px;
  padding: 0 4px;
  line-height: 15px;
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/renderer/src/observabilityWorkspace.test.ts && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/observabilityWorkspace.ts src/renderer/src/observabilityWorkspace.test.ts src/renderer/src/components/ObservabilityPane.tsx src/renderer/src/styles.css
git commit -m "feat(mounts): list extra mounts on the observability rail"
```

---

### Task 7: SPEC.md + full gate

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Update SPEC.md in place** (current-state prose, no history)

1. `WorkspaceSpec` code block (~line 509): after `resources?: ...;` add
   `  mounts?: { hostPath: string; containerPath: string; readOnly: boolean }[]; // container only: extra host folders (HostConfig.Mounts binds); dropped on other kinds at read`
2. §*Docker container shape* Binds bullet (~line 653): append a sentence: "Extra mounts (`manifest.mounts`) are added as `HostConfig.Mounts` `{Type:'bind', Source, Target, ReadOnly}` entries, not `Binds` strings (Windows drive letters make `host:ctr:ro` ambiguous; `Binds` silently creates a missing host dir as root). A missing source fails the create with `extra mount <hostPath> no longer exists`."
3. `workspace:create` / `workspace:writeManifest` (~lines 233 and the create entry): note both validate `mounts` for container kind via `validateExtraMounts` (exists + directory; realpath not inside or an ancestor of `<userData>`; not inside another workspace's `<fleetRoot>/<id>` nor an ancestor of the fleet root; container path normalized, empty → `/mnt/<basename>`, reserved prefixes refused; unique). Add `mounts` to writeManifest's container-level field list (env, image, authMode, resources, mounts).
4. Form flow (~line 1495, after the Env vars disclosure): an **Extra mounts** disclosure for container kind — rows of host folder + Browse… → container path + read-only + ×; placeholders `C:\path\to\folder`/`/home/you/folder` → `/mnt/folder`, and `/mnt/<basename>` once a host path is set; inline errors from the shared rules in `src/preload/extraMounts.ts`; a mounts change counts as container-level for the restart-to-apply banner (`containerLevelChanged`).
5. Observability rail Workspace block (~line 210): after the private/shared rows, one `mount` row per extra mount (container path, `ro` tag when read-only), click reveals the host folder via `fs:openPath`.
6. §9 security: add a bullet — "**Extra mounts are user-chosen host folders, bounded.** A container workspace may bind extra host folders, but `validateExtraMounts` refuses (after realpath) anything inside or containing `<userData>` and any other workspace's private folder or an ancestor of the fleet root, so the host-private zone and sibling private folders stay unreachable."

- [ ] **Step 2: Full gate**

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx vitest run
npm run build
```

Expected: all clean/PASS. If `npm run build` is environment-blocked (known @xterm addon issue in this container), record that in the PR body; do not claim it passed.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): extra mounts for container workspaces"
```

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/extra-mounts
gh pr create --title "Extra mounts for container workspaces" --body "<factual body: what changed, where; test plan incl. host eyeball of form + rail on Windows; mockup link; Rendered Markdown blob links for the new spec/plan .md files; attribution footer>"
```
