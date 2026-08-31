# Docker Degraded Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app stays fully usable for local workspaces when the Docker daemon is down; container workspaces show honestly as `unreachable` and recover automatically.

**Architecture:** A new pure module `workspaceMerge.ts` owns the backend-merge logic (extracted from `ipc.ts`) plus a daemon-connect-error predicate and an in-memory last-known-state map. The renderer replaces the full-screen `DockerDisconnected` gate with a banner, dims unreachable-warm chips in the strip, and badges unreachable-cold rows in Saved. No IPC channel or MCP tool changes.

**Tech Stack:** Electron main (TypeScript, vitest), React renderer, Playwright e2e in mock mode.

**Spec:** `docs/superpowers/specs/2026-08-31-docker-degraded-mode-design.md` — read it first.

## Global Constraints

- Branch: `feat/docker-degraded-mode`, worktree `/workspace/claude-fleet/.claude/worktrees/docker-degraded-mode`. Run everything from the worktree root. NEVER `cd /workspace/claude-fleet` (that's the main checkout on another branch); never `npm install` (worktrees resolve to the base checkout's node_modules, which is pre-provisioned — better-sqlite3 prebuilt + electron `path.txt` stub are already in place).
- Only **daemon-connect errors** (`ECONNREFUSED`, `ENOENT`, `ENOTFOUND`, `EPIPE`, `ECONNRESET` codes) trigger degraded mode. Any other docker error must still reject loudly.
- New `WorkspaceState` value is exactly `'unreachable'`; the new optional field is exactly `lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted'`.
- A workspace appears in exactly one place: strip (warm) or Saved (cold) — invariant #21. Warm now includes unreachable-with-warm-lastKnownState.
- `docs/SPEC.md` is updated in the same PR (Task 7) — the spec-maintenance rule.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- UI cannot be visually verified in this container — gate with `npm run typecheck`, unit tests, `npm run build`, and say so in the PR body.

---

### Task 1: `workspaceMerge.ts` — pure merge logic + state model (TDD)

**Files:**
- Modify: `src/main/workspaces.ts:24` (state union) and the `Workspace` interface (~line 264)
- Create: `src/main/workspaceMerge.ts`
- Test: `src/main/workspaceMerge.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `WorkspaceSpec`, `WorkspaceState`, `WorkspaceMirror` types from `./workspaces.js` (type-only imports — keeps the module electron-free for vitest).
- Produces (Task 2 depends on these exact signatures):
  ```ts
  export function isDaemonConnectError(err: unknown): boolean
  export interface MergeOptions {
    dockerResult: PromiseSettledResult<Workspace[]>;
    localLive: Workspace[];
    manifests: WorkspaceSpec[];
    /** Mutated in place: repopulated from merged container states on docker
     *  success; read for synthesis on daemon-connect failure. */
    lastKnown: Map<string, WorkspaceState>;
    privateDir: (id: string) => Promise<string>;
    factoryMirror: WorkspaceMirror;
  }
  export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]>
  ```

- [ ] **Step 1: Extend the state model**

In `src/main/workspaces.ts`:

```ts
export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted' | 'unreachable';
```

and in `export interface Workspace extends WorkspaceSpec { … }` add below `status?: string;`:

```ts
  /** Docker daemon down (#380): the state this workspace last had while the
   *  daemon was reachable. Present only on state:'unreachable' rows. */
  lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted';
```

Also extend the mirrored literal union at `src/preload/index.ts:62` (`workspaceState:`) with `| 'unreachable'`.

- [ ] **Step 2: Write the failing tests**

Create `src/main/workspaceMerge.test.ts`. Read `src/main/ipc.ts:310-376` first (`fetchAllWorkspaces`) — the fulfilled-path expectations below mirror what that code does today (manifest fields overlay live entries; manifests with no live entry become `deleted`; container `workspaceRoot` always comes from `privateDir`).

```ts
import { describe, expect, it } from 'vitest';
import { isDaemonConnectError, mergeWorkspaces } from './workspaceMerge.js';
import type { Workspace, WorkspaceSpec, WorkspaceState } from './workspaces.js';

const MIRROR = { default: 'off' } as never; // shape only matters to passthrough

function spec(id: string, kind: 'container' | 'local'): WorkspaceSpec {
  return {
    id, name: `ws-${id}`, labels: [], workspaceRoot: `/root/${id}`, workspaceSubdir: '',
    kind, authMode: 'oauth', env: { plain: {}, secretKeys: [] }
  } as WorkspaceSpec;
}
function live(id: string, kind: 'container' | 'local', state: WorkspaceState): Workspace {
  return { ...spec(id, kind), state, containerId: `c-${id}`, status: 'Up' } as Workspace;
}
const privateDir = async (id: string): Promise<string> => `/fleet/${id}`;
const down = (): PromiseSettledResult<Workspace[]> => ({
  status: 'rejected',
  reason: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
});
const up = (ws: Workspace[]): PromiseSettledResult<Workspace[]> => ({ status: 'fulfilled', value: ws });

describe('isDaemonConnectError', () => {
  it('matches daemon-connect codes', () => {
    for (const code of ['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EPIPE', 'ECONNRESET']) {
      expect(isDaemonConnectError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });
  it('rejects everything else', () => {
    expect(isDaemonConnectError(new Error('boom'))).toBe(false);
    expect(isDaemonConnectError(Object.assign(new Error('x'), { code: 'EAUTH' }))).toBe(false);
    expect(isDaemonConnectError(undefined)).toBe(false);
    expect(isDaemonConnectError({ code: 404 })).toBe(false);
  });
});

describe('mergeWorkspaces', () => {
  it('daemon up: merges live + manifests and repopulates lastKnown', async () => {
    const lastKnown = new Map<string, WorkspaceState>([['stale-id', 'running']]);
    const out = await mergeWorkspaces({
      dockerResult: up([live('a', 'container', 'running')]),
      localLive: [live('l', 'local', 'running')],
      manifests: [spec('a', 'container'), spec('b', 'container'), spec('l', 'local')],
      lastKnown, privateDir, factoryMirror: MIRROR
    });
    const byId = new Map(out.map((w) => [w.id, w]));
    expect(byId.get('a')?.state).toBe('running');
    expect(byId.get('a')?.workspaceRoot).toBe('/fleet/a'); // container root is canonical
    expect(byId.get('b')?.state).toBe('deleted');          // manifest with no live entry
    expect(byId.get('l')?.state).toBe('running');
    expect(byId.get('l')?.workspaceRoot).toBe('/root/l');  // local keeps manifest root
    // map repopulated from merged container states, stale ids dropped
    expect(lastKnown.get('a')).toBe('running');
    expect(lastKnown.get('b')).toBe('deleted');
    expect(lastKnown.has('stale-id')).toBe(false);
    expect(lastKnown.has('l')).toBe(false);                // container-kind only
  });

  it('daemon down: container manifests become unreachable with lastKnownState', async () => {
    const lastKnown = new Map<string, WorkspaceState>([['a', 'running'], ['p', 'paused']]);
    const out = await mergeWorkspaces({
      dockerResult: down(),
      localLive: [live('l', 'local', 'running')],
      manifests: [spec('a', 'container'), spec('p', 'container'), spec('l', 'local')],
      lastKnown, privateDir, factoryMirror: MIRROR
    });
    const byId = new Map(out.map((w) => [w.id, w]));
    expect(byId.get('a')).toMatchObject({ state: 'unreachable', lastKnownState: 'running' });
    expect(byId.get('a')?.containerId).toBeUndefined();
    expect(byId.get('p')).toMatchObject({ state: 'unreachable', lastKnownState: 'paused' });
    expect(byId.get('l')?.state).toBe('running');          // local unaffected
    expect(lastKnown.get('a')).toBe('running');            // map NOT clobbered while down
  });

  it('daemon down: deleted stays deleted; unknown ids get no lastKnownState', async () => {
    const lastKnown = new Map<string, WorkspaceState>([['gone', 'deleted']]);
    const out = await mergeWorkspaces({
      dockerResult: down(), localLive: [],
      manifests: [spec('gone', 'container'), spec('mystery', 'container')],
      lastKnown, privateDir, factoryMirror: MIRROR
    });
    const byId = new Map(out.map((w) => [w.id, w]));
    expect(byId.get('gone')?.state).toBe('deleted');
    expect(byId.get('gone')?.lastKnownState).toBeUndefined();
    expect(byId.get('mystery')).toMatchObject({ state: 'unreachable' });
    expect(byId.get('mystery')?.lastKnownState).toBeUndefined();
  });

  it('non-connect docker errors rethrow', async () => {
    const boom = new Error('label filter exploded');
    await expect(
      mergeWorkspaces({
        dockerResult: { status: 'rejected', reason: boom }, localLive: [],
        manifests: [], lastKnown: new Map(), privateDir, factoryMirror: MIRROR
      })
    ).rejects.toBe(boom);
  });

  it('recovery: an up-merge after a down-merge restores real states', async () => {
    const lastKnown = new Map<string, WorkspaceState>();
    const args = { localLive: [], manifests: [spec('a', 'container')], lastKnown, privateDir, factoryMirror: MIRROR };
    await mergeWorkspaces({ ...args, dockerResult: up([live('a', 'container', 'running')]) });
    const during = await mergeWorkspaces({ ...args, dockerResult: down() });
    expect(during[0]).toMatchObject({ state: 'unreachable', lastKnownState: 'running' });
    const after = await mergeWorkspaces({ ...args, dockerResult: up([live('a', 'container', 'paused')]) });
    expect(after[0].state).toBe('paused');
    expect(after[0].lastKnownState).toBeUndefined();
    expect(lastKnown.get('a')).toBe('paused');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/workspaceMerge.test.ts`
Expected: FAIL — `Cannot find module './workspaceMerge.js'`.

- [ ] **Step 4: Implement `src/main/workspaceMerge.ts`**

Move the merge body out of `ipc.ts:310-376` (`fetchAllWorkspaces`) into the new module, preserving its field-overlay behavior verbatim, then add the degraded path. Complete implementation:

```ts
// Backend-merge for workspace:list, extracted from ipc.ts so the docker-
// degraded-mode logic (#380) is unit-testable without electron. Live entries
// win for state/status; manifests provide the user-facing fields. When the
// docker backend is unreachable (daemon-connect error ONLY), container
// manifests are synthesized as state:'unreachable' from the last-known-state
// map instead of falling through to a false 'deleted'.
import type { Workspace, WorkspaceSpec, WorkspaceState } from './workspaces.js';

// Shape-only import: FACTORY_MIRROR's type. Use whatever type ipc.ts's
// `mirror` field carries (see WorkspaceSpec['mirror']).
type Mirror = NonNullable<WorkspaceSpec['mirror']>;

const DAEMON_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EPIPE', 'ECONNRESET']);

/** True only for "the daemon socket isn't there / hung up" errors. Anything
 *  else (API errors, label filter bugs) must keep rejecting loudly. */
export function isDaemonConnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && DAEMON_CONNECT_CODES.has(code);
}

export interface MergeOptions {
  dockerResult: PromiseSettledResult<Workspace[]>;
  localLive: Workspace[];
  manifests: WorkspaceSpec[];
  lastKnown: Map<string, WorkspaceState>;
  privateDir: (id: string) => Promise<string>;
  factoryMirror: Mirror;
}

export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]> {
  const { dockerResult, localLive, manifests, lastKnown, privateDir, factoryMirror } = opts;
  const dockerDown = dockerResult.status === 'rejected';
  if (dockerDown && !isDaemonConnectError(dockerResult.reason)) throw dockerResult.reason;
  const dockerLive = dockerResult.status === 'fulfilled' ? dockerResult.value : [];

  // ── identical to the previous ipc.ts merge ──────────────────────────────
  const liveById = new Map<string, Workspace>();
  for (const w of [...dockerLive, ...localLive]) if (!liveById.has(w.id)) liveById.set(w.id, w);
  const manifestById = new Map(manifests.map((m) => [m.id, m]));
  const result: Workspace[] = [];

  for (const w of liveById.values()) {
    const m = manifestById.get(w.id);
    result.push({
      ...w,
      name: m?.name ?? w.name,
      description: m?.description,
      labels: m?.labels ?? w.labels,
      color: m?.color,
      workspaceRoot: w.kind === 'local' ? m?.workspaceRoot ?? w.workspaceRoot : await privateDir(w.id),
      workspaceSubdir: w.workspaceSubdir || m?.workspaceSubdir || '',
      authMode: m?.authMode ?? w.authMode,
      endpointId: m?.endpointId,
      env: m?.env ?? w.env,
      resources: m?.resources,
      mirror: m?.mirror ?? factoryMirror,
      installedLoadouts: m?.installedLoadouts ?? [],
      control: m?.control,
      accessibility: m?.accessibility,
      createdAt: m?.createdAt ?? w.createdAt,
      lastUsedAt: m?.lastUsedAt ?? w.lastUsedAt
    });
    manifestById.delete(w.id);
  }

  for (const m of manifestById.values()) {
    const root = m.kind === 'local' ? m.workspaceRoot : await privateDir(m.id);
    if (dockerDown && m.kind !== 'local') {
      // Degraded synthesis (#380). Honest-state rule: a last-known 'deleted'
      // stays 'deleted' (the last successful listing proved the container
      // gone; an outage doesn't un-prove it).
      const lk = lastKnown.get(m.id);
      result.push({
        ...m,
        workspaceRoot: root,
        state: lk === 'deleted' ? 'deleted' : 'unreachable',
        ...(lk !== undefined && lk !== 'deleted' && lk !== 'unreachable'
          ? { lastKnownState: lk as Workspace['lastKnownState'] }
          : {})
      });
    } else {
      result.push({ ...m, workspaceRoot: root, state: 'deleted' });
    }
  }

  // Refresh the last-known map only from a successful docker listing — a
  // down-merge must not overwrite the states it needs for synthesis.
  if (!dockerDown) {
    lastKnown.clear();
    for (const w of result) if (w.kind !== 'local') lastKnown.set(w.id, w.state);
  }
  return result;
}
```

Note the comment style: constraints only, matching the codebase. Copy the exact overlay comments from `ipc.ts` (the "Manifest is authoritative…" and "#16" workspaceRoot ones) onto the corresponding lines so the knowledge moves with the code.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/workspaceMerge.test.ts`
Expected: PASS (all 7).

- [ ] **Step 6: Amend the design spec's predicate location**

In `docs/superpowers/specs/2026-08-31-docker-degraded-mode-design.md`, change `a \`isDaemonConnectError\` predicate in \`docker.ts\`` to `a \`isDaemonConnectError\` predicate in \`workspaceMerge.ts\`` (the module is electron-free and unit-tested there).

- [ ] **Step 7: Commit**

```bash
git add src/main/workspaces.ts src/preload/index.ts src/main/workspaceMerge.ts src/main/workspaceMerge.test.ts docs/superpowers/specs/2026-08-31-docker-degraded-mode-design.md
git commit -m "feat: workspaceMerge module — 'unreachable' state + daemon-down synthesis (#380)"
```

---

### Task 2: Wire `ipc.ts` — allSettled fetch, e2e hook, committee error variants

**Files:**
- Modify: `src/main/ipc.ts` (`fetchAllWorkspaces` ~line 310, `workspace:ping` handler ~line 856, `committeePause`/`committeeUnpause` ~lines 405-435, `__test:` handler block ~line 2200)

**Interfaces:**
- Consumes: `mergeWorkspaces`, `isDaemonConnectError` from `./workspaceMerge.js` (Task 1 signatures).
- Produces: `workspace:list` rows may now carry `state:'unreachable'` + `lastKnownState`; `workspace:ping` returns false while `__test:setDockerDown(true)` is active; committee errors distinguish outage from deletion. Task 6's e2e depends on the handler name `__test:setDockerDown` exactly.

- [ ] **Step 1: Replace the fetch body**

Read `src/main/ipc.ts:305-395` first. Replace `fetchAllWorkspaces` with a thin wrapper (keep the existing doc comment, minus the merge details that moved):

```ts
// Last-known container states for daemon-down synthesis (#380). In-memory
// only, by design: after an app restart while the daemon is down we cannot
// distinguish running from stopped, so everything unreachable lands cold.
const lastKnownStates = new Map<string, Workspace['state']>();

// e2e-only (mock mode): forces the docker half down without touching the
// mock backend, which serves BOTH backends in mock mode.
let e2eDockerDown = false;

async function fetchAllWorkspaces(): Promise<Workspace[]> {
  const dockerPromise: Promise<Workspace[]> = e2eDockerDown
    ? Promise.reject(Object.assign(new Error('docker daemon down (e2e)'), { code: 'ECONNREFUSED' }))
    : dockerBackend.listLiveWorkspaces();
  const [dockerResult, localLive, manifests] = await Promise.all([
    dockerPromise.then(
      (value): PromiseSettledResult<Workspace[]> => ({ status: 'fulfilled', value }),
      (reason): PromiseSettledResult<Workspace[]> => ({ status: 'rejected', reason })
    ),
    // In mock mode both backends are the same module; when e2e forces the
    // docker half down, container-kind mocks must not sneak back in as live
    // through the local half.
    localBackend.listLiveWorkspaces().then((ws) => (e2eDockerDown ? ws.filter((w) => w.kind === 'local') : ws)),
    listWorkspaceManifests()
  ]);
  return mergeWorkspaces({
    dockerResult, localLive, manifests,
    lastKnown: lastKnownStates,
    privateDir: fleetPrivateDir,
    factoryMirror: FACTORY_MIRROR
  });
}
```

Add the imports (`mergeWorkspaces` from `./workspaceMerge.js`). Delete the now-moved merge body. Keep the `ttlCache` wiring and `listAllWorkspaces`/`invalidateWorkspaceList` exactly as they are.

- [ ] **Step 2: Ping honors the e2e flag**

At ~line 856:

```ts
ipcMain.handle('workspace:ping', () => (e2eDockerDown ? false : dockerBackend.ping()));
```

- [ ] **Step 3: Register the e2e hook**

Next to the existing `__test:setServingPorts` handler (~line 2200), with the same env gating that handler uses:

```ts
ipcMain.handle('__test:setDockerDown', (_e, downFlag: boolean) => {
  e2eDockerDown = downFlag === true;
  invalidateWorkspaceList();
});
```

- [ ] **Step 4: Committee error variants**

In `committeePause` (~line 405), after `const target = …find(…)`, before the `!target?.containerId` check:

```ts
  if (target?.state === 'unreachable') {
    throw new Error(`Docker daemon unreachable — target ${targetId} cannot be paused until it's back`);
  }
```

In `committeeUnpause` (~line 425), after `const kind = await resolveKind(targetId);`:

```ts
  if (kind !== 'local') {
    const t = (await listAllWorkspaces()).find((w) => w.id === targetId);
    if (t?.state === 'unreachable') {
      throw new Error(`Docker daemon unreachable — target ${targetId} cannot be unpaused until it's back`);
    }
  }
```

- [ ] **Step 5: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run src/main`
Expected: both clean. If `typecheck` flags other literal state unions missing `'unreachable'`, extend them the same way (search: `grep -rn "'running' | 'paused' | 'stopped' | 'deleted'" src`).

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat: degrade workspace:list when the docker daemon is down (#380)"
```

---

### Task 3: Renderer core — warm rule, banner, gate removal, unreachable card

**Files:**
- Create: `src/renderer/src/fleetTemperature.ts`
- Test: `src/renderer/src/fleetTemperature.test.ts`
- Modify: `src/renderer/src/App.tsx` (union ~line 81, `refresh` ~line 628, warm effect ~line 705, gate ~line 1316, `DockerDisconnected` ~line 1511), `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `WorkspaceSummary.state` may be `'unreachable'`, plus `lastKnownState` (Task 2 delivers the rows).
- Produces (Tasks 4-5 depend on): `isWarm(w)`, `isCold(w)` from `./fleetTemperature` with signature `(w: { state: WorkspaceState; lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted' } | undefined) => boolean`; App export `WorkspaceState` including `'unreachable'`; CSS classes `.daemon-banner`, `.ws-state.unreachable`.

- [ ] **Step 1: Extend renderer types**

In `App.tsx`: find the exported `WorkspaceState` type (WorkspaceTabStrip imports it from `'../App'`) and add `| 'unreachable'`. In `WorkspaceSummary` (line 81) add:

```ts
  /** Present on state:'unreachable' rows — the state before the daemon died. */
  lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted';
```

- [ ] **Step 2: Write the failing temperature tests**

`src/renderer/src/fleetTemperature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isWarm, isCold } from './fleetTemperature';

const w = (state: string, lastKnownState?: string) =>
  ({ state, lastKnownState }) as Parameters<typeof isWarm>[0];

describe('fleet temperature', () => {
  it('warm: running, paused, unreachable-was-warm', () => {
    expect(isWarm(w('running'))).toBe(true);
    expect(isWarm(w('paused'))).toBe(true);
    expect(isWarm(w('unreachable', 'running'))).toBe(true);
    expect(isWarm(w('unreachable', 'paused'))).toBe(true);
  });
  it('cold: stopped, deleted, unreachable-cold/unknown', () => {
    expect(isWarm(w('stopped'))).toBe(false);
    expect(isWarm(w('unreachable', 'stopped'))).toBe(false);
    expect(isWarm(w('unreachable'))).toBe(false);
    expect(isWarm(undefined)).toBe(false);
    expect(isCold(w('stopped'))).toBe(true);
    expect(isCold(w('deleted'))).toBe(true);
    expect(isCold(w('unreachable'))).toBe(true);
    expect(isCold(w('unreachable', 'running'))).toBe(false); // in the strip, not Saved
    expect(isCold(w('running'))).toBe(false);
  });
});
```

Run: `npx vitest run src/renderer/src/fleetTemperature.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `fleetTemperature.ts`**

```ts
// Warm = shown as a strip chip; cold = lives in the Saved modal (#21: a
// workspace appears in exactly one place). Daemon-down (#380) extends warm
// to unreachable workspaces whose last-known state was warm, so chips don't
// vanish on a daemon flap. No App import — structural param avoids a cycle.
interface TemperatureInput {
  state: 'running' | 'paused' | 'stopped' | 'deleted' | 'unreachable';
  lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted';
}

export function isWarm(w: TemperatureInput | undefined): boolean {
  if (!w) return false;
  if (w.state === 'running' || w.state === 'paused') return true;
  return w.state === 'unreachable' && (w.lastKnownState === 'running' || w.lastKnownState === 'paused');
}

export function isCold(w: TemperatureInput | undefined): boolean {
  if (!w) return false;
  return w.state === 'stopped' || w.state === 'deleted' || (w.state === 'unreachable' && !isWarm(w));
}
```

Run: `npx vitest run src/renderer/src/fleetTemperature.test.ts` — Expected: PASS.

- [ ] **Step 4: App.tsx — refresh, warm effect, gate, banner, card**

1. `refresh()` (line 628): remove the early return so the list always loads; the ping result only feeds `backendReady`:

```ts
  const refresh = async () => {
    if (!window.api) return;
    const ok = await window.api.workspace.backendReady();
    setBackendReady(ok);
    const list = applyIdOrder((await window.api.workspace.list()) as WorkspaceSummary[], wsOrderRef.current);
    setWorkspaces(list);
    workspacesRef.current = list;
  };
```

2. Warm effect (line 705): replace the inline `warm` closure with `isWarm` from `./fleetTemperature` (same semantics for pending-select and auto-rescue — unreachable-warm counts as warm, so selection does NOT get yanked on a flap).

3. Gate (line 1316): delete the `backendReady === false ? <DockerDisconnected onRetry={refresh} /> :` branch and the whole `DockerDisconnected` component (lines ~1511-1533). Empty fleet + daemon down now falls through to `FirstRun` naturally.

4. Banner: immediately after `<WorkspaceTabStrip …/>` (line 1268) add:

```tsx
      {backendReady === false && (
        <div className="daemon-banner" role="status">
          <span className="dot" aria-hidden="true" />
          Docker daemon unreachable — container workspaces are shown from last-known state and
          can&apos;t be started or attached until it&apos;s back.
        </div>
      )}
```

5. Unreachable main-pane card: in the `main-body` branch chain (line 1316 region), insert BEFORE the `!selected || !selected.containerId` branch:

```tsx
            ) : selected?.state === 'unreachable' ? (
              <div className="empty">
                <div className="icon-card error">!</div>
                <h2>Docker daemon unreachable</h2>
                <p>
                  {selected.name} will reattach automatically when Docker is back.
                </p>
              </div>
```

(`TerminalPane` mounting is untouched: its filter is `running|paused` + `containerId`, and unreachable rows have neither.)

- [ ] **Step 5: Banner CSS**

In `styles.css`, near the existing `.daemon-status` block (~line 360), reusing its `daemonPulse` keyframes:

```css
/* Daemon-down banner (#380): non-blocking replacement for the old
   full-screen gate — local workspaces stay fully usable underneath. */
.daemon-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  font-size: 12px;
  color: #f0b8b3;
  background: #2b1d1c;
  border-bottom: 1px solid #4a2a27;
}
.daemon-banner .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--red, #e5534b);
  animation: daemonPulse 1.4s ease-in-out infinite;
}
```

(Check `styles.css` for existing color custom-properties and use them where they exist — match the file's conventions.)

- [ ] **Step 6: Verify**

Run: `npx vitest run src/renderer && npm run typecheck`
Expected: PASS / clean. (Typecheck will fail if Task 4's strip still references the removed component — it doesn't; only App renders it.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/fleetTemperature.ts src/renderer/src/fleetTemperature.test.ts src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "feat: daemon-down banner replaces the full-screen gate (#380)"
```

---

### Task 4: Strip — unreachable chips

**Files:**
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx` (warm filter ~line 132, chip render ~lines 161-240), `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `isWarm` from `../fleetTemperature`; `WorkspaceSummary.lastKnownState`.
- Produces: chips with `ws-chip-group unreachable` class; no ⋮ menu on unreachable chips.

- [ ] **Step 1: Warm filter**

Line 132, replace:

```ts
  const live = workspaces.filter((w) => w.state === 'running' || w.state === 'paused');
```

with:

```ts
  // Warm now includes unreachable-was-warm (#380): a daemon flap must not
  // make chips vanish mid-session.
  const live = workspaces.filter(isWarm);
```

importing `isWarm` from `'../fleetTemperature'`.

- [ ] **Step 2: Chip rendering**

In the `live.map((w) => { … })` body: add `const unreachable = w.state === 'unreachable';`. Then:

- add `unreachable` to the chip-group className: `` className={`ws-chip-group ${…} ${unreachable ? 'unreachable' : ''}`} ``
- secondary line: where the chip renders its activity text (`active 2m ago` / `working…` — follow `busy`/`waiting` usage from line ~163), render instead, when `unreachable`:

```tsx
  {unreachable
    ? `unreachable${w.lastKnownState ? ` · was ${w.lastKnownState}` : ''}`
    : /* existing activity/working text */}
```

- status dot: give the dot element an `unreachable` class when set (the CSS below turns it red + pulsing).
- ⋮ menu: locate the per-chip menu trigger (`toggleMenu`) and skip rendering it when `unreachable` (start/pause/stop all need the daemon; an inert chip shows no menu).
- `doAction` guard (defense in depth), first line: `if (w.state === 'unreachable') return;`

- [ ] **Step 3: Chip CSS**

In `styles.css` next to the existing `.ws-chip-group` rules:

```css
/* Unreachable chips (#380): visibly inert, but still present + selectable. */
.ws-chip-group.unreachable { opacity: 0.55; }
.ws-chip-group.unreachable .ws-chip { border-style: dashed; }
.ws-chip-group.unreachable .status-dot,
.ws-chip-group.unreachable .dot.unreachable {
  background: var(--red, #e5534b);
  animation: daemonPulse 1.4s ease-in-out infinite;
}
```

Adjust the selectors to the actual chip/dot class names in the file (read the existing `.ws-chip*` rules first — match, don't invent).

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npx vitest run src/renderer`
Expected: clean.

```bash
git add src/renderer/src/components/WorkspaceTabStrip.tsx src/renderer/src/styles.css
git commit -m "feat: dimmed inert chips for unreachable-warm workspaces (#380)"
```

---

### Task 5: Saved modal + create form gating

**Files:**
- Modify: `src/renderer/src/components/WorkspaceModal.tsx` (saved filter ~line 97, props), `src/renderer/src/components/WorkspaceForm.tsx` (kind picker ~lines 236 + 570-590, submit), `src/renderer/src/App.tsx` (modal callsite), `src/renderer/src/styles.css` (badge)

**Interfaces:**
- Consumes: `isCold` from `../fleetTemperature`; `backendReady` state in App.
- Produces: `WorkspaceModal` prop `dockerUp: boolean`; `WorkspaceForm` prop `dockerUp?: boolean` (default `true`).

- [ ] **Step 1: Saved filter + badge**

`WorkspaceModal.tsx` line 97:

```ts
  const saved = useMemo(() => workspaces.filter(isCold), [workspaces]);
```

(`isCold` keeps unreachable-warm chips out of Saved — invariant #21.) The state badge already renders `` className={`ws-state ${w.state}`} `` with the state text, so `unreachable` appears automatically. Add its colors in `styles.css` next to the existing `.ws-state.*` rules:

```css
.ws-state.unreachable { background: #3a2523; color: #e8a09a; border: 1px solid #543230; }
```

(Match the property set of the existing `.ws-state.stopped` rule — read it first.)

- [ ] **Step 2: Thread `dockerUp`**

- `WorkspaceModal` props: add `dockerUp: boolean;` and pass it to BOTH `WorkspaceForm` usages (the expanded Saved row and the New tab).
- App callsite: `dockerUp={backendReady !== false}`.

- [ ] **Step 3: Gate `WorkspaceForm`**

- Props: `dockerUp?: boolean` (treat `undefined` as up — other callsites don't change).
- Kind default (line 236): `useState<WorkspaceKind>(initial?.kind ?? (dockerUp === false ? 'local' : 'container'))`.
- Container radio (line ~575): `disabled={busy || dockerUp === false}`; when disabled for that reason, render a hint next to the `Container` label:

```tsx
  {dockerUp === false && <span className="kind-hint">needs Docker — daemon unreachable</span>}
```

with CSS `.kind-hint { font-size: 11px; color: var(--ink-2, #8b93a7); margin-left: 6px; }` (reuse an existing muted-text class if one fits).
- Submit gating: where the submit button computes `disabled`, add `|| (kind === 'container' && dockerUp === false)`, and set `title="Docker daemon unreachable"` when that clause is the reason. This covers both New (create container) and Saved-row edit (resume container) since both render `WorkspaceForm`.

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npx vitest run src/renderer`
Expected: clean.

```bash
git add src/renderer/src/components/WorkspaceModal.tsx src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "feat: Saved 'unreachable' badge + docker-gated create/resume (#380)"
```

---

### Task 6: E2E — daemon-down flow in mock mode

**Files:**
- Create: `tests/docker-down.spec.ts`
- Read first: `tests/_helpers.ts` (launch pattern), `grep -rn "__test:setServingPorts" tests/` (how specs invoke `__test:` handles), `tests/create-flow.spec.ts` (create-modal driving)

**Interfaces:**
- Consumes: `__test:setDockerDown` (Task 2), `.daemon-banner`, `.ws-chip-group.unreachable`, `.ws-state.unreachable`, disabled Container radio (Tasks 3-5).

- [ ] **Step 1: Write the spec**

Structure (adapt selectors/launch boilerplate from the files above — copy their patterns exactly; the assertions below are the contract):

```ts
// Daemon-down degraded mode (#380), driven through __test:setDockerDown so
// the mock backend itself stays untouched (it serves both backends in mock
// mode; the hook rejects only the docker half of the merge).
test('daemon down: banner, inert chip, gated create, local still works', async () => {
  // 1. Baseline: at least one container-kind workspace is warm (create one
  //    via the modal if the mock fleet doesn't seed one), no banner.
  await expect(page.locator('.daemon-banner')).toHaveCount(0);

  // 2. Flip the daemon down.
  await invokeTestHandle(app, '__test:setDockerDown', true);

  // 3. Within one poll cycle (5s + 1s TTL): banner visible, the container
  //    chip is dimmed + labeled, still present and selectable.
  await expect(page.locator('.daemon-banner')).toBeVisible({ timeout: 10_000 });
  const chip = page.locator('.ws-chip-group.unreachable');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('unreachable · was running');
  await chip.click();
  await expect(page.locator('.main-body')).toContainText('will reattach automatically');

  // 4. Create modal: Container radio disabled with hint; local create works.
  //    (Open modal, assert the radio's disabled state, create a local
  //    workspace per create-flow.spec.ts's local path, assert its chip.)

  // 5. Recovery: flip back up; banner drops, chip un-dims.
  await invokeTestHandle(app, '__test:setDockerDown', false);
  await expect(page.locator('.daemon-banner')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.ws-chip-group.unreachable')).toHaveCount(0);
});
```

Local-workspace creation in mock mode: if the mock backend rejects local `createWorkspace` for a reason unrelated to this feature, reduce step 4's second half to "local radio remains enabled" and note why in a comment — do NOT weaken the banner/chip/recovery assertions.

- [ ] **Step 2: Run it**

Run: `npm run build && npx playwright test tests/docker-down.spec.ts`
Expected: PASS. (This container has no display — if Playwright cannot launch (missing X server), run `npm run typecheck` + `npx vitest run src` instead, mark the spec as CI-verified in the task report, and say so in the PR body. Do not delete the spec.)

- [ ] **Step 3: Commit**

```bash
git add tests/docker-down.spec.ts
git commit -m "test: e2e daemon-down degraded-mode flow (#380)"
```

---

### Task 7: SPEC.md + PR

**Files:**
- Modify: `docs/SPEC.md` (§5 strip paragraph ~line 166, §6/`workspace:list` bullet ~line 196, §8 startup flow step 3 ~line 824, backend-dispatch paragraph ~line 481)

- [ ] **Step 1: SPEC edits (edit in place, no changelog prose)**

1. `workspace:list` bullet (~line 196) — after the existing merge/TTL description, append:

> When the Docker daemon is unreachable (daemon-connect errors only — `isDaemonConnectError` in `workspaceMerge.ts`; any other docker error still rejects), the merge degrades instead of failing: container-kind manifests are synthesized as `state: 'unreachable'` with `lastKnownState` (`running|paused|stopped|deleted`) from an in-memory map refreshed on every successful merge (never persisted — an app started mid-outage shows all container workspaces cold). A last-known `'deleted'` stays `'deleted'`. Local workspaces are unaffected. `WorkspaceState` is `running | paused | stopped | deleted | unreachable`.

2. §5 strip paragraph (~line 166) — amend the warm-fleet sentence:

> **The strip is the "warm" fleet: `running` + `paused`, plus `unreachable` workspaces whose `lastKnownState` was warm (#380)** — chips don't vanish on a daemon flap; they render dimmed/inert (no ⋮ menu, secondary line `unreachable · was running`) and selecting one shows an inert main-pane card. `stopped` + `deleted` + cold-`unreachable` are the "cold" fleet in the Saved list (`unreachable` badge, Resume/Recreate disabled while the daemon is down). The warm/cold rule lives in `fleetTemperature.ts` (`isWarm`/`isCold`).

3. §8 startup flow step 3 (~line 824) — replace the gate sentence:

> 3. Renderer mounts; on first render it calls `workspace:ping`. A false result no longer blocks the app: a slim banner ("Docker daemon unreachable — container workspaces are shown from last-known state…") renders under the strip, container workspaces show per the degraded merge above, local workspaces are fully usable (including creation — the create form's Container option is disabled with a hint while the daemon is down, and the form defaults to Local). Recovery is poll-driven; the first successful listing restores real states and drops the banner.

4. Backend-dispatch paragraph (~line 481) — one sentence at the end:

> Committee `pause`/`unpause` on an `unreachable` target throw a distinct "Docker daemon unreachable" error so callers can tell outage from deletion.

- [ ] **Step 2: Full gate**

Run: `npm run typecheck && npx vitest run src && npm run build`
Expected: all clean. Playwright only if a display is available (see Task 6).

- [ ] **Step 3: Commit + PR**

```bash
git add docs/SPEC.md
git commit -m "docs: SPEC — docker degraded mode (#380)"
git push -u origin feat/docker-degraded-mode
gh pr create --head feat/docker-degraded-mode --title "feat: docker degraded mode — app stays usable when the daemon is down (#380)" --body "$(cat <<'EOF'
Closes #380. Spec: docs/superpowers/specs/2026-08-31-docker-degraded-mode-design.md

- 'unreachable' WorkspaceState + lastKnownState, synthesized by the new workspaceMerge.ts when the docker backend fails with a daemon-connect error (anything else still rejects)
- Full-screen DockerDisconnected gate deleted → slim banner; warm chips stay (dimmed/inert), cold ones get an 'unreachable' badge in Saved instead of a false 'deleted'
- Container create/resume gated while down; local workspaces work end-to-end; recovery is poll-driven
- Committee pause/unpause errors distinguish outage from deletion
- SPEC §5/§6/§8 updated same-PR

Verified with typecheck + unit + build in-container; e2e spec tests/docker-down.spec.ts runs in CI. UI needs a host eyeball (no display in the dev container).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
