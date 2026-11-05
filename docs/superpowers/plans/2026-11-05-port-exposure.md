# Declared Port Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only ports an agent declares through the fleet-state `expose_port` MCP tool raise the preview popup. Scanned-only ports stay silent in the Serving rail. Every port appearance is recorded in a `port_exposures` table so missed declarations can be measured.

**Architecture:** A new host-side `PortExposureService` (`src/main/portExposure.ts`) sits between three inputs and the renderer. The inputs are the broker scan's Serving snapshots (already broadcast by `PortForwardManager.onChanged`), `expose_port` declarations (injected into `mcpServer.ts` like the inbox handlers), and the user's open/dismiss actions over IPC. It decides when `ports:detected` fires and writes one row per port appearance through `PortExposureStore`, a Kysely writer that works on both SQLite and Postgres. `PortForwardManager` itself is unchanged; its `onDetected` is wired to a no-op.

**Tech Stack:** Electron main (Node 22, TypeScript), better-sqlite3 + Kysely (SQLite and Postgres dialects), vitest, Playwright (CI only), React renderer.

**Spec:** `docs/superpowers/specs/2026-11-05-port-exposure-design.md` (issue #505).

## Global Constraints

- Ephemeral range: ports **32768–60999** inclusive are never declarable and never recorded or toasted when scanned.
- Declaration wait: **30s** (`DECLARE_WAIT_MS = 30_000`) for a declared port to pass the probe before `outcome = 'not_serving'`.
- `label` is required, trimmed, 1–**80** chars. `reason` is optional, ≤**200** chars.
- Rate limit: **10** `expose_port` calls per minute per workspace. This is separate from the inbox post limit.
- Fallback knob `ports.undeclaredToastAfterSec` lives in `config.json` and defaults to **0** (never). It is hand-edited only, with no UI.
- Retention: `port_exposures` rows whose `ended_at` is older than **90 days** are pruned at startup.
- `outcome` ∈ `opened | dismissed | ignored | not_serving`. `opened_via` ∈ `popup | rail | fallback`. `source` ∈ `declared | scanned | both`.
- State schema goes from SQLite `user_version` 14 to **15**, and the Postgres `state` track gets step **15**. `schemaParity.test.ts` must stay green.
- Remote (fleet-host) workspaces are out of scope: `expose_port` returns an error for them.
- Code comments: terse and necessary only (`/workspace/.claude/rules/review-conventions.md`). No PR or ticket narrative in code.
- Any IPC, data-model or user-flow change also updates `docs/SPEC.md` (Task 7) in the same PR.
- **Test environment (container):** run `npm ci --ignore-scripts` once in this worktree, with the electron stub per the repo's unit-test recipe. Never `cd` into `/workspace/claude-fleet`; this worktree is `/workspace/claude-fleet/.claude/worktrees/port-exposure`. Run typecheck as two separate commands: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`. There is no display, so Playwright specs are written and committed but run in CI.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/main/db.ts` | modify | SQLite `migrate()` step v15 creates `port_exposures` |
| `src/main/store/stateSchema.ts` | modify | Kysely table type `PortExposuresTable` |
| `src/main/store/migrations/statePg.ts` | modify | Postgres step 15 |
| `src/main/store/schemaParity.test.ts` | modify | test title v14 → v15 |
| `src/main/portExposureStore.ts` | create | row types, `ExposureSink` seam, `PortExposureStore` (insert/update/closeDangling/prune/sweep) |
| `src/main/portExposureStore.test.ts` | create | store SQL on both dialects |
| `src/main/portExposure.ts` | create | `PortExposureService`: validation, rate limit, lifecycle, popup decision, fallback timer, local-workspace polling |
| `src/main/portExposure.test.ts` | create | service lifecycle with fake timers + in-memory sink |
| `src/main/localPortProbe.ts` | create | `probeLocalHttp(port)`: host-side HTTP probe for local workspaces |
| `src/main/localPortProbe.test.ts` | create | probe against real loopback servers |
| `src/main/config.ts` | modify | `ports.undeclaredToastAfterSec` parse + `getUndeclaredToastAfterSec()` |
| `src/main/config.test.ts` | modify | knob tests |
| `src/main/mcpServer.ts` | modify | `expose_port` tool, `setPortExposureHandlers`, server `instructions`, `port_exposures` in the `query` snapshot |
| `src/main/mcpServer.test.ts` | modify | tool, instructions and snapshot tests |
| `src/main/ipc.ts` | modify | wire the service: snapshots → service, popups → `ports:detected`, labels on `ports:changed`/`ports:list`, `ports:open` via + local open, `ports:dismiss`, MCP handler, test hooks |
| `src/main/perfIpc.ts` | modify | `ports:dismiss` workspace-arg map entry |
| `src/main/mockPorts.ts` (+ test) | modify | mock port 3000 is "declared" so the popup works under `CLAUDE_FLEET_MOCK=1` |
| `src/main/index.ts` | modify | startup `sweep()` (close dangling rows + prune) |
| `src/preload/index.ts` | modify | `PortDetected`, `PortOpenVia`, `ServingPort.label`, `ports.onDetected/open/dismiss` |
| `src/renderer/src/toasts.ts`, `components/Toast.tsx` | modify | `onClose` hook on ✕ |
| `src/renderer/src/portToast.ts` (+ test) | create | popup copy |
| `src/renderer/src/App.tsx` | modify | popup toast from `PortDetected`; `openPreview(…, via)` |
| `src/renderer/src/components/PortsSection.tsx` | modify | label replaces cmdline in rail rows |
| `tests/mcp-server.spec.ts` | modify | `expose_port` listed, instructions, host-side validation |
| `tests/port-forward.spec.ts` | modify | labeled popup; undeclared port is rail-only until declared |
| `docs/SPEC.md` | modify | non-goals, §6 Ports, Settings, data model, §8, fleet-state tools; remove the §11 Open-decisions entry |

---

### Task 1: `port_exposures` schema + `PortExposureStore`

**Files:**
- Modify: `src/main/db.ts` (end of `migrate()`, after the `< 14` block)
- Modify: `src/main/store/stateSchema.ts`
- Modify: `src/main/store/migrations/statePg.ts`
- Modify: `src/main/store/schemaParity.test.ts:93`
- Create: `src/main/portExposureStore.ts`
- Test: `src/main/portExposureStore.test.ts`

**Interfaces:**
- Produces (exported from `src/main/portExposureStore.ts`):
  - `type ExposureSource = 'declared' | 'scanned' | 'both'`
  - `type ExposureOutcome = 'opened' | 'dismissed' | 'ignored' | 'not_serving'`
  - `type OpenVia = 'popup' | 'rail' | 'fallback'`
  - `interface ExposureRow { id; workspaceId; sessionId: string|null; port: number; cmdline: string|null; label: string|null; reason: string|null; source: ExposureSource; firstScannedAt: number|null; declaredAt: number|null; popupShownAt: number|null; outcome: ExposureOutcome|null; openedVia: OpenVia|null; openCount: number; endedAt: number|null }`
  - `type ExposurePatch = Partial<Omit<ExposureRow, 'id' | 'workspaceId' | 'port'>>`
  - `interface ExposureSink { insert(row: ExposureRow): Promise<void>; update(id: string, patch: ExposurePatch): Promise<void> }`
  - `const PORT_EXPOSURE_RETENTION_MS` (90 days)
  - `class PortExposureStore implements ExposureSink` — `constructor(db: () => Kysely<StateDb>)`, `insert`, `update`, `closeDangling(now?) → Promise<number>`, `prune(olderThanMs?, now?) → Promise<number>`, `sweep(now?) → Promise<void>`

- [ ] **Step 1: Write the failing store test**

Create `src/main/portExposureStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { stateKysely } from './db.js';
import { openTestState } from './store/testStore.js';
import { PortExposureStore, PORT_EXPOSURE_RETENTION_MS, type ExposureRow } from './portExposureStore.js';

const row = (over: Partial<ExposureRow> = {}): ExposureRow => ({
  id: 'R1', workspaceId: 'W1', sessionId: null, port: 5173, cmdline: null, label: null, reason: null,
  source: 'scanned', firstScannedAt: 1000, declaredAt: null, popupShownAt: null, outcome: null,
  openedVia: null, openCount: 0, endedAt: null, ...over
});

const rows = () => stateKysely().selectFrom('port_exposures').selectAll().orderBy('id').execute();

describe('PortExposureStore', () => {
  it('inserts a row and patches it by id', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    await s.insert(row());
    await s.update('R1', { label: 'Vite', declaredAt: 2000, source: 'both', openCount: 2, openedVia: 'rail', outcome: 'opened' });
    expect(await rows()).toEqual([
      expect.objectContaining({
        id: 'R1', workspace_id: 'W1', port: 5173, label: 'Vite', declared_at: 2000, source: 'both',
        open_count: 2, opened_via: 'rail', outcome: 'opened', ended_at: null
      })
    ]);
  });

  it('an empty patch is a no-op', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    await s.insert(row());
    await expect(s.update('R1', {})).resolves.toBeUndefined();
  });

  it('closeDangling ends open rows; never-served → not_serving, served → ignored, set outcomes kept', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    await s.insert(row({ id: 'A', source: 'declared', firstScannedAt: null, declaredAt: 1 }));
    await s.insert(row({ id: 'B' }));
    await s.insert(row({ id: 'C', outcome: 'dismissed' }));
    await s.insert(row({ id: 'D', endedAt: 50, outcome: 'opened' }));
    expect(await s.closeDangling(9000)).toBe(3);
    expect((await rows()).map((r) => [r.id, r.outcome, r.ended_at])).toEqual([
      ['A', 'not_serving', 9000],
      ['B', 'ignored', 9000],
      ['C', 'dismissed', 9000],
      ['D', 'opened', 50]
    ]);
  });

  it('prune deletes rows that ended before the retention window', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    const now = PORT_EXPOSURE_RETENTION_MS + 10_000;
    await s.insert(row({ id: 'old', endedAt: 5_000 }));
    await s.insert(row({ id: 'recent', endedAt: now - 1 }));
    await s.insert(row({ id: 'open' }));
    expect(await s.prune(PORT_EXPOSURE_RETENTION_MS, now)).toBe(1);
    expect((await rows()).map((r) => r.id)).toEqual(['open', 'recent']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/portExposureStore.test.ts`
Expected: FAIL. The module `./portExposureStore.js` is not found.

- [ ] **Step 3: Add the SQLite migration**

In `src/main/db.ts`, after the closing `}` of the `if (... < 14) { ... d.pragma('user_version = 14'); }` block (the last block in `migrate()`), add:

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 15) {
    // One row per port appearance: declared (expose_port) and/or scanned.
    // Read via fleet-state `query` to measure missed declarations.
    d.exec(`
      CREATE TABLE port_exposures (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        session_id       TEXT,
        port             INTEGER NOT NULL,
        cmdline          TEXT,
        label            TEXT,
        reason           TEXT,
        source           TEXT NOT NULL,
        first_scanned_at INTEGER,
        declared_at      INTEGER,
        popup_shown_at   INTEGER,
        outcome          TEXT,
        opened_via       TEXT,
        open_count       INTEGER NOT NULL DEFAULT 0,
        ended_at         INTEGER
      );
      CREATE INDEX idx_port_exposures_workspace ON port_exposures(workspace_id, port);
      CREATE INDEX idx_port_exposures_ended ON port_exposures(ended_at);
    `);
    d.pragma('user_version = 15');
  }
```

- [ ] **Step 4: Add the Kysely type**

In `src/main/store/stateSchema.ts`, change the header comment's `v1–v14` to `v1–v15`, then add above `export interface StateDb`:

```ts
export interface PortExposuresTable {
  id: string;
  workspace_id: string;
  session_id: string | null;
  port: number;
  cmdline: string | null;
  label: string | null;
  reason: string | null;
  source: string;
  first_scanned_at: number | null;
  declared_at: number | null;
  popup_shown_at: number | null;
  outcome: string | null;
  opened_via: string | null;
  open_count: Generated<number>;
  ended_at: number | null;
}
```

and add `port_exposures: PortExposuresTable;` as the last member of `StateDb`.

- [ ] **Step 5: Add the Postgres step**

In `src/main/store/migrations/statePg.ts`:
- Change the first comment line to `// Postgres DDL for state.db: the baseline mirrors SQLite user_version 14; later versions are steps.`
- Add above `export const STATE_PG_TRACK`:

```ts
const PORT_EXPOSURES_V15 = `
CREATE TABLE port_exposures (
  id ${T} PRIMARY KEY,
  workspace_id ${T} NOT NULL,
  session_id ${T},
  port BIGINT NOT NULL,
  cmdline ${T},
  label ${T},
  reason ${T},
  source ${T} NOT NULL,
  first_scanned_at BIGINT,
  declared_at BIGINT,
  popup_shown_at BIGINT,
  outcome ${T},
  opened_via ${T},
  open_count BIGINT NOT NULL DEFAULT 0,
  ended_at BIGINT
);
CREATE INDEX idx_port_exposures_workspace ON port_exposures (workspace_id, port);
CREATE INDEX idx_port_exposures_ended ON port_exposures (ended_at);
`;
```

- Change `steps: []` in `STATE_PG_TRACK` to `steps: [{ version: 15, postgres: PORT_EXPOSURES_V15 }]`.

In `src/main/store/schemaParity.test.ts`, rename the test `'state baseline mirrors state.db at user_version 14'` to `'state schema mirrors state.db at user_version 15'`.

- [ ] **Step 6: Write the store**

Create `src/main/portExposureStore.ts`:

```ts
// SQL for port_exposures. The lifecycle that decides what to write lives in portExposure.ts.
import { sql, type Kysely, type Updateable } from 'kysely';
import { num } from './store/kysely.js';
import type { PortExposuresTable, StateDb } from './store/stateSchema.js';

export type ExposureSource = 'declared' | 'scanned' | 'both';
export type ExposureOutcome = 'opened' | 'dismissed' | 'ignored' | 'not_serving';
export type OpenVia = 'popup' | 'rail' | 'fallback';

export interface ExposureRow {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  port: number;
  cmdline: string | null;
  label: string | null;
  reason: string | null;
  source: ExposureSource;
  firstScannedAt: number | null;
  declaredAt: number | null;
  popupShownAt: number | null;
  outcome: ExposureOutcome | null;
  openedVia: OpenVia | null;
  openCount: number;
  endedAt: number | null;
}

export type ExposurePatch = Partial<Omit<ExposureRow, 'id' | 'workspaceId' | 'port'>>;

export interface ExposureSink {
  insert(row: ExposureRow): Promise<void>;
  update(id: string, patch: ExposurePatch): Promise<void>;
}

export const PORT_EXPOSURE_RETENTION_MS = 90 * 86_400_000;

const COLUMN: Record<keyof ExposurePatch, keyof PortExposuresTable> = {
  sessionId: 'session_id',
  cmdline: 'cmdline',
  label: 'label',
  reason: 'reason',
  source: 'source',
  firstScannedAt: 'first_scanned_at',
  declaredAt: 'declared_at',
  popupShownAt: 'popup_shown_at',
  outcome: 'outcome',
  openedVia: 'opened_via',
  openCount: 'open_count',
  endedAt: 'ended_at'
};

export class PortExposureStore implements ExposureSink {
  constructor(private readonly db: () => Kysely<StateDb>) {}

  async insert(r: ExposureRow): Promise<void> {
    await this.db()
      .insertInto('port_exposures')
      .values({
        id: r.id,
        workspace_id: r.workspaceId,
        session_id: r.sessionId,
        port: r.port,
        cmdline: r.cmdline,
        label: r.label,
        reason: r.reason,
        source: r.source,
        first_scanned_at: r.firstScannedAt,
        declared_at: r.declaredAt,
        popup_shown_at: r.popupShownAt,
        outcome: r.outcome,
        opened_via: r.openedVia,
        open_count: r.openCount,
        ended_at: r.endedAt
      })
      .execute();
  }

  async update(id: string, patch: ExposurePatch): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) set[COLUMN[k as keyof ExposurePatch]] = v;
    if (Object.keys(set).length === 0) return;
    await this.db()
      .updateTable('port_exposures')
      .set(set as Updateable<PortExposuresTable>)
      .where('id', '=', id)
      .execute();
  }

  /** Close rows a previous run left open (app quit mid-appearance). */
  async closeDangling(now: number = Date.now()): Promise<number> {
    const r = await this.db()
      .updateTable('port_exposures')
      .set({
        ended_at: now,
        outcome: sql<string>`COALESCE(outcome, CASE WHEN first_scanned_at IS NULL THEN 'not_serving' ELSE 'ignored' END)`
      })
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return num(r.numUpdatedRows);
  }

  async prune(olderThanMs: number = PORT_EXPOSURE_RETENTION_MS, now: number = Date.now()): Promise<number> {
    const r = await this.db().deleteFrom('port_exposures').where('ended_at', '<', now - olderThanMs).executeTakeFirst();
    return num(r.numDeletedRows);
  }

  async sweep(now: number = Date.now()): Promise<void> {
    await this.closeDangling(now);
    await this.prune(PORT_EXPOSURE_RETENTION_MS, now);
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/main/portExposureStore.test.ts src/main/db.test.ts`
Expected: PASS.

If a Postgres test URL is available (`PG_TEST_URL`), also run: `STORE_TEST_DIALECT=postgres npx vitest run -c vitest.pg.config.ts src/main/portExposureStore.test.ts src/main/store/schemaParity.test.ts`. Expected: PASS. Otherwise CI covers it.

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main/db.ts src/main/store/stateSchema.ts src/main/store/migrations/statePg.ts src/main/store/schemaParity.test.ts src/main/portExposureStore.ts src/main/portExposureStore.test.ts
git commit -m "feat(ports): port_exposures table (state v15) and PortExposureStore"
```

---

### Task 2: `PortExposureService`

**Files:**
- Create: `src/main/portExposure.ts`
- Test: `src/main/portExposure.test.ts`

**Interfaces:**
- Consumes: from Task 1, `ExposurePatch`, `ExposureRow`, `ExposureSink`, `OpenVia`. Also `ServingPort` from `./portforward.js` (`{ port, pid, cmdline, sessionId, firstSeenAt }`) and `WorkspaceKind` from `./workspaces.js` (`'container' | 'local' | 'remote'`).
- Produces (exported from `src/main/portExposure.ts`):
  - `EPHEMERAL_MIN = 32768`, `EPHEMERAL_MAX = 60999`, `DECLARE_WAIT_MS = 30_000`, `DECLARE_RATE_PER_MIN = 10`
  - `isEphemeralPort(port: number): boolean`
  - `interface PortPopup { workspaceId: string; port: number; label: string|null; reason: string|null; cmdline: string|null; declared: boolean }`
  - `interface PortExposureDeps { sink; workspace(id) → Promise<{kind, running}|null>; onPopup(p); onLabelsChanged(workspaceId); undeclaredToastAfterSec() → Promise<number>; probeLocal(port) → Promise<boolean>; onWriteError?(err); now?(); localPollMs? }`
  - `class PortExposureService`:
    - `declare(workspaceId, args: Record<string, unknown>) → Promise<{ status: 'shown' | 'waiting' }>`
    - `onSnapshot(workspaceId, ports: ServingPort[]): void`
    - `recordOpen(workspaceId, port, via: OpenVia): void`
    - `recordDismiss(workspaceId, port): void`
    - `labelFor(workspaceId, port): string | null`
    - `isLocalServing(workspaceId, port): boolean`
    - `flush(): Promise<unknown>`
    - `dispose(): void`

- [ ] **Step 1: Write the failing tests**

Create `src/main/portExposure.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECLARE_RATE_PER_MIN,
  DECLARE_WAIT_MS,
  PortExposureService,
  isEphemeralPort,
  type PortExposureDeps,
  type PortPopup
} from './portExposure.js';
import type { ExposurePatch, ExposureRow, ExposureSink } from './portExposureStore.js';
import type { ServingPort } from './portforward.js';

class FakeSink implements ExposureSink {
  rows = new Map<string, ExposureRow>();
  async insert(r: ExposureRow): Promise<void> {
    this.rows.set(r.id, { ...r });
  }
  async update(id: string, p: ExposurePatch): Promise<void> {
    const r = this.rows.get(id);
    if (!r) throw new Error(`update before insert: ${id}`);
    Object.assign(r, p);
  }
  all(): ExposureRow[] {
    return [...this.rows.values()];
  }
}

const WS = 'W-CONTAINER';
const LOCAL = 'W-LOCAL';
const STOPPED = 'W-STOPPED';
const REMOTE = 'W-REMOTE';
const T0 = 1_000_000;

const sp = (port: number, over: Partial<ServingPort> = {}): ServingPort => ({
  port, pid: 1, cmdline: 'node vite', sessionId: 'tab-1', firstSeenAt: 0, ...over
});

function setup(over: Partial<PortExposureDeps> = {}) {
  const sink = new FakeSink();
  const popups: PortPopup[] = [];
  const labels: string[] = [];
  const svc = new PortExposureService({
    sink,
    workspace: async (id) =>
      id === WS ? { kind: 'container', running: true }
      : id === LOCAL ? { kind: 'local', running: true }
      : id === STOPPED ? { kind: 'container', running: false }
      : id === REMOTE ? { kind: 'remote', running: true }
      : null,
    onPopup: (p) => popups.push(p),
    onLabelsChanged: (id) => labels.push(id),
    undeclaredToastAfterSec: async () => 0,
    probeLocal: async () => false,
    localPollMs: 1_000,
    ...over
  });
  return { svc, sink, popups, labels };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isEphemeralPort', () => {
  it('covers 32768–60999 inclusive', () => {
    expect([32767, 32768, 60999, 61000].map(isEphemeralPort)).toEqual([false, true, true, false]);
  });
});

describe('declare validation', () => {
  it.each([
    [{ label: 'x' }, /port must be/],
    [{ port: 0, label: 'x' }, /port must be/],
    [{ port: 3000.5, label: 'x' }, /port must be/],
    [{ port: 45000, label: 'x' }, /ephemeral range/],
    [{ port: 3000 }, /label is required/],
    [{ port: 3000, label: '   ' }, /label is required/],
    [{ port: 3000, label: 'x'.repeat(81) }, /label is required/],
    [{ port: 3000, label: 'x', reason: 'r'.repeat(201) }, /reason must be/]
  ])('rejects %j', async (args, err) => {
    const { svc } = setup();
    await expect(svc.declare(WS, args)).rejects.toThrow(err);
  });

  it('accepts a numeric-string port', async () => {
    const { svc } = setup();
    await expect(svc.declare(WS, { port: '5173', label: 'Vite' })).resolves.toEqual({ status: 'waiting' });
  });

  it('rejects unknown, stopped and remote workspaces', async () => {
    const { svc } = setup();
    await expect(svc.declare('nope', { port: 3000, label: 'x' })).rejects.toThrow(/unknown workspace/);
    await expect(svc.declare(STOPPED, { port: 3000, label: 'x' })).rejects.toThrow(/not running/);
    await expect(svc.declare(REMOTE, { port: 3000, label: 'x' })).rejects.toThrow(/remote/);
  });

  it('rate-limits each workspace to DECLARE_RATE_PER_MIN calls per minute', async () => {
    const { svc } = setup();
    for (let i = 0; i < DECLARE_RATE_PER_MIN; i++) await svc.declare(WS, { port: 3000 + i, label: 'x' });
    await expect(svc.declare(WS, { port: 4000, label: 'x' })).rejects.toThrow(/rate limited/);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(svc.declare(WS, { port: 4000, label: 'x' })).resolves.toEqual({ status: 'waiting' });
  });
});

describe('container lifecycle', () => {
  it('scan first: silent until declared, then one labeled popup', async () => {
    const { svc, sink, popups, labels } = setup();
    svc.onSnapshot(WS, [sp(5173)]);
    expect(popups).toEqual([]);
    expect(await svc.declare(WS, { port: 5173, label: 'Vite dev server', reason: 'UI changes' })).toEqual({ status: 'shown' });
    expect(popups).toEqual([
      { workspaceId: WS, port: 5173, label: 'Vite dev server', reason: 'UI changes', cmdline: 'node vite', declared: true }
    ]);
    expect(labels).toEqual([WS]);
    expect(svc.labelFor(WS, 5173)).toBe('Vite dev server');
    await svc.flush();
    expect(sink.all()).toEqual([
      expect.objectContaining({
        port: 5173, source: 'both', firstScannedAt: T0, declaredAt: T0, popupShownAt: T0, sessionId: 'tab-1', outcome: null
      })
    ]);
  });

  it('declare first: waiting, then the popup fires when the scan admits the port', async () => {
    const { svc, sink, popups } = setup();
    expect(await svc.declare(WS, { port: 3000, label: 'Docs' })).toEqual({ status: 'waiting' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(popups).toEqual([]);
    svc.onSnapshot(WS, [sp(3000)]);
    expect(popups.map((p) => [p.port, p.label, p.declared])).toEqual([[3000, 'Docs', true]]);
    await vi.advanceTimersByTimeAsync(DECLARE_WAIT_MS);
    await svc.flush();
    expect(sink.all()).toEqual([
      expect.objectContaining({ source: 'both', declaredAt: T0, firstScannedAt: T0 + 5_000, endedAt: null })
    ]);
  });

  it('a declared port that never serves ends as not_serving', async () => {
    const { svc, sink, popups } = setup();
    await svc.declare(WS, { port: 3000, label: 'Docs' });
    await vi.advanceTimersByTimeAsync(DECLARE_WAIT_MS);
    await svc.flush();
    expect(popups).toEqual([]);
    expect(sink.all()).toEqual([expect.objectContaining({ outcome: 'not_serving', endedAt: T0 + DECLARE_WAIT_MS })]);
    expect(svc.labelFor(WS, 3000)).toBeNull();
  });

  it('re-declaring a shown port updates the label without a second popup', async () => {
    const { svc, popups } = setup();
    svc.onSnapshot(WS, [sp(5173)]);
    await svc.declare(WS, { port: 5173, label: 'Vite' });
    expect(await svc.declare(WS, { port: 5173, label: 'Storybook' })).toEqual({ status: 'shown' });
    expect(popups).toHaveLength(1);
    expect(svc.labelFor(WS, 5173)).toBe('Storybook');
  });

  it('never records or pops up an ephemeral-range scanned port', async () => {
    const { svc, sink, popups } = setup({ undeclaredToastAfterSec: async () => 1 });
    svc.onSnapshot(WS, [sp(45000)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await svc.flush();
    expect(sink.all()).toEqual([]);
    expect(popups).toEqual([]);
  });

  it('a port that stops listening ends its row; its return opens a new row', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(8080)]);
    svc.onSnapshot(WS, []);
    svc.onSnapshot(WS, [sp(8080)]);
    await svc.flush();
    const rows = sink.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: 'ignored', endedAt: T0 });
    expect(rows[1]).toMatchObject({ outcome: null, endedAt: null });
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it('updates owner attribution in place', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(8080, { sessionId: null })]);
    svc.onSnapshot(WS, [sp(8080, { sessionId: 'tab-2' })]);
    await svc.flush();
    expect(sink.all()).toEqual([expect.objectContaining({ sessionId: 'tab-2', endedAt: null })]);
  });
});

describe('outcomes', () => {
  it('dismiss then open: opened wins; first via and the count are kept', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(5173)]);
    await svc.declare(WS, { port: 5173, label: 'Vite' });
    svc.recordDismiss(WS, 5173);
    svc.recordOpen(WS, 5173, 'rail');
    svc.recordOpen(WS, 5173, 'popup');
    svc.recordDismiss(WS, 5173);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ outcome: 'opened', openedVia: 'rail', openCount: 2 });
  });

  it('an undeclared port opened from the rail is the missed-declaration signal', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(8080)]);
    svc.recordOpen(WS, 8080, 'rail');
    svc.onSnapshot(WS, []);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ source: 'scanned', declaredAt: null, openCount: 1, outcome: 'opened', endedAt: T0 });
  });

  it('ignores opens and dismisses for ports it does not track', async () => {
    const { svc, sink } = setup();
    svc.recordOpen(WS, 1234, 'rail');
    svc.recordDismiss(WS, 1234);
    await svc.flush();
    expect(sink.all()).toEqual([]);
  });
});

describe('undeclared fallback', () => {
  it('pops up an undeclared port after N seconds when configured', async () => {
    const { svc, popups } = setup({ undeclaredToastAfterSec: async () => 60 });
    svc.onSnapshot(WS, [sp(8080)]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(popups).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(popups).toEqual([{ workspaceId: WS, port: 8080, label: null, reason: null, cmdline: 'node vite', declared: false }]);
  });

  it('a declaration before the deadline replaces the fallback', async () => {
    const { svc, popups } = setup({ undeclaredToastAfterSec: async () => 60 });
    svc.onSnapshot(WS, [sp(8080)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await svc.declare(WS, { port: 8080, label: 'API' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(popups.map((p) => p.declared)).toEqual([true]);
  });

  it('is off at 0', async () => {
    const { svc, popups } = setup();
    svc.onSnapshot(WS, [sp(8080)]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(popups).toEqual([]);
  });
});

describe('local workspaces', () => {
  it('polls the host probe and pops up once the port answers', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { svc, sink, popups } = setup({ probeLocal: probe });
    expect(await svc.declare(LOCAL, { port: 5173, label: 'Vite' })).toEqual({ status: 'waiting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(popups).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(popups.map((p) => [p.workspaceId, p.port])).toEqual([[LOCAL, 5173]]);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(true);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ source: 'declared', firstScannedAt: T0 + 1_000 });
  });

  it('ends after two consecutive failed probes', async () => {
    let up = true;
    const { svc, sink } = setup({ probeLocal: async () => up });
    await svc.declare(LOCAL, { port: 5173, label: 'Vite' });
    await vi.advanceTimersByTimeAsync(0);
    up = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(false);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ outcome: 'ignored', endedAt: T0 + 2_000 });
  });

  it('container snapshots never end a local row', async () => {
    const { svc } = setup({ probeLocal: async () => true });
    await svc.declare(LOCAL, { port: 5173, label: 'Vite' });
    await vi.advanceTimersByTimeAsync(0);
    svc.onSnapshot(LOCAL, []);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(true);
    svc.dispose();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/portExposure.test.ts`
Expected: FAIL. The module `./portExposure.js` is not found.

- [ ] **Step 3: Implement the service**

Create `src/main/portExposure.ts`:

```ts
// Declared port exposure (docs/superpowers/specs/2026-11-05-port-exposure-design.md):
// joins expose_port declarations with the broker scan's Serving snapshots,
// decides when the preview popup shows, and records each port appearance.
import { ulid } from 'ulid';
import type { ServingPort } from './portforward.js';
import type { WorkspaceKind } from './workspaces.js';
import type { ExposurePatch, ExposureRow, ExposureSink, OpenVia } from './portExposureStore.js';

export const EPHEMERAL_MIN = 32768;
export const EPHEMERAL_MAX = 60999;
export const DECLARE_WAIT_MS = 30_000;
export const DECLARE_RATE_PER_MIN = 10;
const MINUTE_MS = 60_000;
const LABEL_MAX = 80;
const REASON_MAX = 200;
const LOCAL_END_AFTER_FAILS = 2;

/** Linux's default ip_local_port_range — what `listen(0)` hands out. */
export function isEphemeralPort(port: number): boolean {
  return port >= EPHEMERAL_MIN && port <= EPHEMERAL_MAX;
}

export interface PortPopup {
  workspaceId: string;
  port: number;
  label: string | null;
  reason: string | null;
  cmdline: string | null;
  /** false: the undeclared fallback fired. */
  declared: boolean;
}

export interface PortExposureDeps {
  sink: ExposureSink;
  workspace(workspaceId: string): Promise<{ kind: WorkspaceKind; running: boolean } | null>;
  onPopup(p: PortPopup): void;
  /** A label changed; re-send this workspace's Serving rows. */
  onLabelsChanged(workspaceId: string): void;
  /** `ports.undeclaredToastAfterSec`; 0 disables the fallback. */
  undeclaredToastAfterSec(): Promise<number>;
  /** Host-side HTTP probe for local workspaces (no broker scan). */
  probeLocal(port: number): Promise<boolean>;
  onWriteError?(err: unknown): void;
  now?(): number;
  localPollMs?: number;
}

type TimerSlot = 'waitTimer' | 'fallbackTimer' | 'pollTimer';

interface Live {
  row: ExposureRow;
  /** Passed the probe: in a Serving snapshot (container) or the host probe (local). */
  serving: boolean;
  local: boolean;
  declaredPopup: boolean;
  waitTimer: NodeJS.Timeout | null;
  fallbackTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  localFails: number;
  /** The insert must land before any update. */
  writes: Promise<void>;
}

const keyOf = (workspaceId: string, port: number): string => `${workspaceId}:${port}`;

function parseDeclare(a: Record<string, unknown>): { port: number; label: string; reason: string | null } {
  const port = typeof a.port === 'string' && /^\d+$/.test(a.port) ? Number(a.port) : a.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer 1–65535');
  }
  if (isEphemeralPort(port)) {
    throw new Error(
      `port ${port} is in the ephemeral range (${EPHEMERAL_MIN}–${EPHEMERAL_MAX}) the OS assigns to throwaway ` +
        `listeners such as test servers; bind the server to a fixed port below ${EPHEMERAL_MIN} and declare that`
    );
  }
  const label = typeof a.label === 'string' ? a.label.trim() : '';
  if (!label || label.length > LABEL_MAX) throw new Error(`label is required (1–${LABEL_MAX} chars)`);
  let reason: string | null = null;
  if (a.reason !== undefined && a.reason !== null) {
    if (typeof a.reason !== 'string' || a.reason.length > REASON_MAX) {
      throw new Error(`reason must be a string of at most ${REASON_MAX} chars`);
    }
    reason = a.reason.trim() || null;
  }
  return { port, label, reason };
}

export class PortExposureService {
  private readonly live = new Map<string, Live>();
  private readonly hits = new Map<string, number[]>();
  private allWrites: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly localPollMs: number;

  constructor(private readonly deps: PortExposureDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.localPollMs = deps.localPollMs ?? 3000;
  }

  async declare(workspaceId: string, args: Record<string, unknown>): Promise<{ status: 'shown' | 'waiting' }> {
    const { port, label, reason } = parseDeclare(args);
    this.takeRate(workspaceId);
    const ws = await this.deps.workspace(workspaceId);
    if (!ws) throw new Error('unknown workspace');
    if (ws.kind === 'remote') throw new Error('expose_port is not supported for remote workspaces yet');
    if (!ws.running) throw new Error('workspace is not running');

    const existing = this.live.get(keyOf(workspaceId, port));
    if (existing) {
      const patch: ExposurePatch = { label, reason };
      if (existing.row.declaredAt === null) {
        patch.declaredAt = this.now();
        patch.source = 'both';
      }
      this.patch(existing, patch);
      this.deps.onLabelsChanged(workspaceId);
      if (!existing.serving) return { status: 'waiting' };
      if (!existing.declaredPopup) this.showPopup(existing, true);
      return { status: 'shown' };
    }

    const l = this.open(workspaceId, port, { source: 'declared', declaredAt: this.now(), label, reason }, ws.kind === 'local');
    this.deps.onLabelsChanged(workspaceId);
    l.waitTimer = setTimeout(() => {
      l.waitTimer = null;
      if (!l.serving && this.isCurrent(l)) this.end(l);
    }, DECLARE_WAIT_MS);
    if (l.local) this.startLocalPoll(l);
    return { status: 'waiting' };
  }

  onSnapshot(workspaceId: string, ports: ServingPort[]): void {
    const present = new Set<number>();
    for (const sp of ports) {
      if (isEphemeralPort(sp.port)) continue;
      present.add(sp.port);
      const l = this.live.get(keyOf(workspaceId, sp.port));
      if (!l) {
        const n = this.open(
          workspaceId,
          sp.port,
          { source: 'scanned', firstScannedAt: this.now(), sessionId: sp.sessionId, cmdline: sp.cmdline },
          false
        );
        n.serving = true;
        void this.scheduleFallback(n);
      } else if (l.local) {
        continue;
      } else if (!l.serving) {
        l.serving = true;
        this.clearTimer(l, 'waitTimer');
        this.patch(l, { source: 'both', firstScannedAt: this.now(), sessionId: sp.sessionId, cmdline: sp.cmdline });
        this.showPopup(l, true);
      } else if (sp.sessionId !== l.row.sessionId || sp.cmdline !== l.row.cmdline) {
        this.patch(l, { sessionId: sp.sessionId, cmdline: sp.cmdline });
      }
    }
    for (const l of [...this.live.values()]) {
      if (l.row.workspaceId === workspaceId && !l.local && l.serving && !present.has(l.row.port)) this.end(l);
    }
  }

  recordOpen(workspaceId: string, port: number, via: OpenVia): void {
    const l = this.live.get(keyOf(workspaceId, port));
    if (!l) return;
    this.patch(l, { openCount: l.row.openCount + 1, openedVia: l.row.openedVia ?? via, outcome: 'opened' });
  }

  recordDismiss(workspaceId: string, port: number): void {
    const l = this.live.get(keyOf(workspaceId, port));
    if (!l || l.row.outcome !== null) return;
    this.patch(l, { outcome: 'dismissed' });
  }

  labelFor(workspaceId: string, port: number): string | null {
    return this.live.get(keyOf(workspaceId, port))?.row.label ?? null;
  }

  isLocalServing(workspaceId: string, port: number): boolean {
    const l = this.live.get(keyOf(workspaceId, port));
    return !!l && l.local && l.serving;
  }

  /** Settles every queued write. */
  flush(): Promise<unknown> {
    return this.allWrites;
  }

  dispose(): void {
    for (const l of this.live.values()) {
      for (const slot of ['waitTimer', 'fallbackTimer', 'pollTimer'] as const) this.clearTimer(l, slot);
    }
    this.live.clear();
  }

  private open(workspaceId: string, port: number, init: Partial<ExposureRow>, local: boolean): Live {
    const row: ExposureRow = {
      id: ulid(),
      workspaceId,
      port,
      sessionId: null,
      cmdline: null,
      label: null,
      reason: null,
      source: 'scanned',
      firstScannedAt: null,
      declaredAt: null,
      popupShownAt: null,
      outcome: null,
      openedVia: null,
      openCount: 0,
      endedAt: null,
      ...init
    };
    const l: Live = {
      row,
      serving: false,
      local,
      declaredPopup: false,
      waitTimer: null,
      fallbackTimer: null,
      pollTimer: null,
      localFails: 0,
      writes: this.deps.sink.insert({ ...row }).catch((e) => this.deps.onWriteError?.(e))
    };
    this.allWrites = Promise.all([this.allWrites, l.writes]);
    this.live.set(keyOf(workspaceId, port), l);
    return l;
  }

  private patch(l: Live, p: ExposurePatch): void {
    Object.assign(l.row, p);
    l.writes = l.writes.then(() => this.deps.sink.update(l.row.id, p)).catch((e) => this.deps.onWriteError?.(e));
    this.allWrites = Promise.all([this.allWrites, l.writes]);
  }

  private showPopup(l: Live, declared: boolean): void {
    if (declared) l.declaredPopup = true;
    this.clearTimer(l, 'fallbackTimer');
    if (l.row.popupShownAt === null) this.patch(l, { popupShownAt: this.now() });
    const { workspaceId, port, label, reason, cmdline } = l.row;
    this.deps.onPopup({ workspaceId, port, label, reason, cmdline, declared });
  }

  private async scheduleFallback(l: Live): Promise<void> {
    const sec = await this.deps.undeclaredToastAfterSec().catch(() => 0);
    if (sec <= 0 || !this.isCurrent(l) || l.row.declaredAt !== null) return;
    l.fallbackTimer = setTimeout(() => {
      l.fallbackTimer = null;
      if (this.isCurrent(l) && l.row.declaredAt === null && l.row.popupShownAt === null) this.showPopup(l, false);
    }, sec * 1000);
  }

  private startLocalPoll(l: Live): void {
    const tick = async (): Promise<void> => {
      l.pollTimer = null;
      const ok = await this.deps.probeLocal(l.row.port).catch(() => false);
      if (!this.isCurrent(l)) return;
      if (ok) {
        l.localFails = 0;
        if (!l.serving) {
          l.serving = true;
          this.clearTimer(l, 'waitTimer');
          this.patch(l, { firstScannedAt: this.now() });
          this.showPopup(l, true);
        }
      } else if (l.serving && ++l.localFails >= LOCAL_END_AFTER_FAILS) {
        this.end(l);
        return;
      }
      l.pollTimer = setTimeout(() => void tick(), this.localPollMs);
    };
    void tick();
  }

  private end(l: Live): void {
    for (const slot of ['waitTimer', 'fallbackTimer', 'pollTimer'] as const) this.clearTimer(l, slot);
    this.live.delete(keyOf(l.row.workspaceId, l.row.port));
    this.patch(l, { endedAt: this.now(), outcome: l.row.outcome ?? (l.serving ? 'ignored' : 'not_serving') });
  }

  private clearTimer(l: Live, slot: TimerSlot): void {
    const t = l[slot];
    if (t) clearTimeout(t);
    l[slot] = null;
  }

  private isCurrent(l: Live): boolean {
    return this.live.get(keyOf(l.row.workspaceId, l.row.port)) === l;
  }

  private takeRate(workspaceId: string): void {
    const now = this.now();
    const recent = (this.hits.get(workspaceId) ?? []).filter((t) => now - t < MINUTE_MS);
    if (recent.length >= DECLARE_RATE_PER_MIN) {
      this.hits.set(workspaceId, recent);
      throw new Error(`rate limited: at most ${DECLARE_RATE_PER_MIN} expose_port calls per minute`);
    }
    recent.push(now);
    this.hits.set(workspaceId, recent);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/portExposure.test.ts`
Expected: PASS (all describe blocks).

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/portExposure.ts src/main/portExposure.test.ts
git commit -m "feat(ports): PortExposureService joins declarations with scan snapshots"
```

---

### Task 3: Fallback knob + host-side local probe

**Files:**
- Modify: `src/main/config.ts`
- Modify: `src/main/config.test.ts`
- Create: `src/main/localPortProbe.ts`
- Test: `src/main/localPortProbe.test.ts`

**Interfaces:**
- Produces:
  - `getUndeclaredToastAfterSec(): Promise<number>` from `src/main/config.ts`. It returns a whole number of seconds ≥ 0, and 0 when the key is absent or invalid.
  - `probeLocalHttp(port: number, timeoutMs?: number): Promise<boolean>` from `src/main/localPortProbe.ts`

- [ ] **Step 1: Write the failing config tests**

In `src/main/config.test.ts`, add `getUndeclaredToastAfterSec,` to the destructured `await import('./config.js')` list. Then append:

```ts
describe('ports.undeclaredToastAfterSec', () => {
  it('defaults to 0 (fallback off)', async () => {
    expect(await getUndeclaredToastAfterSec()).toBe(0);
  });

  it('reads a hand-edited value, floored to whole seconds', async () => {
    await writeFile(configPath(), JSON.stringify({ ports: { undeclaredToastAfterSec: 60.7 } }));
    _resetConfigCacheForTests();
    expect(await getUndeclaredToastAfterSec()).toBe(60);
  });

  it.each([-5, 'soon', null])('treats %j as off', async (v) => {
    await writeFile(configPath(), JSON.stringify({ ports: { undeclaredToastAfterSec: v } }));
    _resetConfigCacheForTests();
    expect(await getUndeclaredToastAfterSec()).toBe(0);
  });

  it('survives saving an unrelated setting', async () => {
    await writeFile(configPath(), JSON.stringify({ ports: { undeclaredToastAfterSec: 30 } }));
    _resetConfigCacheForTests();
    await setAutoReloadLoadouts(false);
    _resetConfigCacheForTests();
    expect(await getUndeclaredToastAfterSec()).toBe(30);
    expect(JSON.parse(await readFile(configPath(), 'utf8')).ports).toEqual({ undeclaredToastAfterSec: 30 });
  });
});
```

- [ ] **Step 2: Write the failing probe tests**

Create `src/main/localPortProbe.test.ts`:

```ts
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeLocalHttp } from './localPortProbe.js';

const open: net.Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close(() => undefined);
});

function listen(server: net.Server): Promise<number> {
  open.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  );
}

describe('probeLocalHttp', () => {
  it('passes for an HTTP server', async () => {
    const port = await listen(http.createServer((_req, res) => res.end('ok')));
    await expect(probeLocalHttp(port)).resolves.toBe(true);
  });

  it('fails for a non-HTTP listener', async () => {
    const port = await listen(net.createServer((s) => s.end('SSH-2.0-nope\r\n')));
    await expect(probeLocalHttp(port)).resolves.toBe(false);
  });

  it('fails for a closed port', async () => {
    const srv = net.createServer();
    const port = await listen(srv);
    await new Promise<void>((r) => srv.close(() => r()));
    open.splice(open.indexOf(srv), 1);
    await expect(probeLocalHttp(port)).resolves.toBe(false);
  });

  it('fails when nothing answers before the timeout', async () => {
    const port = await listen(net.createServer(() => undefined));
    await expect(probeLocalHttp(port, 100)).resolves.toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/main/config.test.ts src/main/localPortProbe.test.ts`
Expected: FAIL. `getUndeclaredToastAfterSec` is not a function, and the module `./localPortProbe.js` is not found.

- [ ] **Step 4: Implement the config knob**

In `src/main/config.ts`:

1. Add to the `AppConfig` interface (after `store?: unknown;`):

```ts
  /** Hand-edited only. Seconds an undeclared scanned port must keep serving
   *  before the fallback preview toast; absent/invalid ⇒ 0 (never). */
  ports?: { undeclaredToastAfterSec?: number };
```

2. Add near `parsePerfOtlp` (module scope):

```ts
function parsePortsConfig(v: unknown): AppConfig['ports'] {
  if (!v || typeof v !== 'object') return undefined;
  const s = (v as Record<string, unknown>).undeclaredToastAfterSec;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 ? { undeclaredToastAfterSec: Math.floor(s) } : undefined;
}
```

3. In `read()`'s `cached = { ... }` allowlist, change the last entry `store: parsed.store` to:

```ts
      store: parsed.store,
      ports: parsePortsConfig(parsed.ports)
```

The allowlist is what `write()` spreads, so leaving `ports` out would erase it from disk on any unrelated save.

4. Add after `getGithubClientIdConfig`:

```ts
export async function getUndeclaredToastAfterSec(): Promise<number> {
  return (await read()).ports?.undeclaredToastAfterSec ?? 0;
}
```

- [ ] **Step 5: Implement the probe**

Create `src/main/localPortProbe.ts`:

```ts
import net from 'node:net';

/** True when 127.0.0.1:<port> answers a minimal GET with an HTTP status line. */
export function probeLocalHttp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => sock.write('GET / HTTP/1.0\r\nHost: localhost\r\n\r\n'));
    sock.once('data', (b) => finish(String(b).startsWith('HTTP/')));
    sock.once('error', () => finish(false));
    sock.once('end', () => finish(false));
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/main/config.test.ts src/main/localPortProbe.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/config.ts src/main/config.test.ts src/main/localPortProbe.ts src/main/localPortProbe.test.ts
git commit -m "feat(ports): undeclaredToastAfterSec knob and host-side local HTTP probe"
```

---

### Task 4: `expose_port` MCP tool, server instructions, `port_exposures` in `query`

**Files:**
- Modify: `src/main/mcpServer.ts`
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Produces (exported from `src/main/mcpServer.ts`):
  - `interface PortExposureHandlers { expose(callerId: string, args: Record<string, unknown>): Promise<unknown> }`
  - `setPortExposureHandlers(h: PortExposureHandlers | null): void`
  - `SERVER_INSTRUCTIONS: string`
  - `initializeResult(): { protocolVersion; capabilities; serverInfo; instructions }`
- Task 5 calls `setPortExposureHandlers({ expose: (callerId, args) => portExposure.declare(callerId, args) })`.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/mcpServer.test.ts`:

```ts
import { initializeResult, setPortExposureHandlers } from './mcpServer.js';

const PORT_EXPOSURES_DDL = `CREATE TABLE port_exposures (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT, port INTEGER NOT NULL, cmdline TEXT,
  label TEXT, reason TEXT, source TEXT NOT NULL, first_scanned_at INTEGER, declared_at INTEGER,
  popup_shown_at INTEGER, outcome TEXT, opened_via TEXT, open_count INTEGER NOT NULL DEFAULT 0, ended_at INTEGER)`;

describe('expose_port (#505)', () => {
  afterEach(() => setPortExposureHandlers(null));

  it('is listed with port and label required', () => {
    expect((tool('expose_port').inputSchema as { required: string[] }).required).toEqual(['port', 'label']);
  });

  it('proxies to the injected handler with the HOST caller id', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    setPortExposureHandlers({
      expose: async (c, a) => {
        calls.push([c, a]);
        return { status: 'waiting' };
      }
    });
    const out = await tool('expose_port').run(null as never, { port: 5173, label: 'Vite', callerId: 'SPOOF' }, ctxA);
    expect(out).toEqual({ status: 'waiting' });
    expect(calls.map(([c]) => c)).toEqual([WS_A]);
  });

  it('fails clearly when not wired', () => {
    expect(() => tool('expose_port').run(null as never, { port: 5173, label: 'Vite' }, ctxA)).toThrow(/port exposure is unavailable/);
  });

  it('the server instructions tell agents to call it', () => {
    expect(initializeResult().instructions).toMatch(/expose_port/);
  });
});

describe('query snapshot exposes port_exposures, workspace-scoped (#505)', () => {
  let fdb: Database.Database;
  let cleanup: () => void;
  beforeEach(() => {
    ({ db: fdb, cleanup } = makeFileDb());
  });
  afterEach(() => {
    fdb.close();
    cleanup();
  });

  it('copies only the allowed workspaces rows', () => {
    fdb.exec(PORT_EXPOSURES_DDL);
    const ins = fdb.prepare(`INSERT INTO port_exposures (id, workspace_id, port, source) VALUES (?, ?, ?, ?)`);
    ins.run('ra', WS_A, 5173, 'declared');
    ins.run('rb', WS_B, 3000, 'scanned');
    const rows = tool('query').run(fdb, { sql: 'SELECT id FROM port_exposures' }, ctxA) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['ra']);
  });

  it('an older state.db without the table yields an empty table', () => {
    const rows = tool('query').run(fdb, { sql: 'SELECT count(*) AS n FROM port_exposures' }, ctxA);
    expect(rows).toEqual([{ n: 0 }]);
  });
});
```

`tool`, `ctxA`, `WS_A`, `WS_B`, `makeFileDb`, `Database`, `beforeEach` and `afterEach` are already in scope in this file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: FAIL. `initializeResult`/`setPortExposureHandlers` are not exported, and `tool expose_port not found`.

- [ ] **Step 3: Add the handler seam**

In `src/main/mcpServer.ts`, after `setSkillHandlers` (around line 173):

```ts
/** Injected by ipc.ts: declared port exposure. callerId is host-assigned. */
export interface PortExposureHandlers {
  expose(callerId: string, args: Record<string, unknown>): Promise<unknown>;
}
let portExposureHandlers: PortExposureHandlers | null = null;
export function setPortExposureHandlers(h: PortExposureHandlers | null): void {
  portExposureHandlers = h;
}
```

- [ ] **Step 4: Add the server instructions**

Next to `SERVER_INFO`:

```ts
export const SERVER_INSTRUCTIONS =
  'When you start a server for the user to view (dev server, docs preview, report), call expose_port with its port and a short label.';

export function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS
  };
}
```

and in `handleMethod`, replace the `case 'initialize': return { ... };` body with `return initializeResult();`.

- [ ] **Step 5: Add the tool**

Add to the `TOOLS` array, directly after the `notify` tool entry:

```ts
  {
    name: 'expose_port',
    description:
      'Show the user a server you started in THIS workspace: raises a preview popup with an Open button. Call it ' +
      'after starting something the user should look at (dev server, docs preview, report); not for test fixtures ' +
      'or internal tools. Args: port (required; the OS ephemeral range 32768–60999 is rejected — bind a fixed port), ' +
      'label (required, ≤80 chars, e.g. "Vite dev server"), reason (≤200 chars). Returns {status: shown|waiting}; ' +
      'waiting means the popup appears once the port answers HTTP (within 30s).',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number' }, label: { type: 'string' }, reason: { type: 'string' } },
      required: ['port', 'label']
    },
    run: (_db, a, ctx) => {
      if (!portExposureHandlers) throw new Error('port exposure is unavailable');
      return portExposureHandlers.expose(ctx.callerId, a);
    }
  },
```

Do **not** add `expose_port` to `STATE_DB_TOOLS`. It must work on the Postgres store.

- [ ] **Step 6: Add the snapshot table**

In `buildSnapshot`, after the `perf_events` `try { … } catch { … }` block and still inside the outer `try`, add:

```ts
      try {
        mem.prepare(
          `CREATE TABLE port_exposures AS SELECT * FROM ${alias}.port_exposures WHERE ${scope}`
        ).run(...params);
      } catch (e) {
        // Pre-v15 DB: an empty, correctly-shaped table instead of an error.
        if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
        mem.exec(
          `CREATE TABLE port_exposures (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT, ` +
            `port INTEGER NOT NULL, cmdline TEXT, label TEXT, reason TEXT, source TEXT NOT NULL, ` +
            `first_scanned_at INTEGER, declared_at INTEGER, popup_shown_at INTEGER, outcome TEXT, ` +
            `opened_via TEXT, open_count INTEGER NOT NULL DEFAULT 0, ended_at INTEGER)`
        );
      }
```

In the `query` tool's description, change `'broker_sessions, session_summaries, session_tags, usage_events, perf_events — pre-filtered to the rows you may '` to `'broker_sessions, session_summaries, session_tags, usage_events, perf_events, port_exposures — pre-filtered to the rows you may '`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): expose_port tool, server instructions, port_exposures in query"
```

---

### Task 5: Main-process wiring

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/perfIpc.ts:61`
- Modify: `src/main/mockPorts.ts`
- Test: `src/main/mockPorts.test.ts`
- Modify: `src/main/index.ts`
- Test (e2e, CI): `tests/mcp-server.spec.ts`

**Interfaces:**
- Consumes: from Task 2, `PortExposureService` and `PortPopup`. From Task 1, `PortExposureStore` and `OpenVia`. From Task 3, `getUndeclaredToastAfterSec` and `probeLocalHttp`. From Task 4, `setPortExposureHandlers`.
- Produces the IPC contract Task 6 consumes:
  - `ports:detected` payload is a `PortPopup`: `{ workspaceId, port, label, reason, cmdline, declared }`
  - `ports:changed` / `ports:list` port objects carry `label: string | null`
  - `ports:open(workspaceId, port, via?)` with `via ∈ 'popup' | 'rail' | 'fallback'` (default `'rail'`)
  - `ports:dismiss(workspaceId, port)` → `void`
  - Test hooks: `__test:emitDetectedPort(popup: PortPopup)` and `__test:declarePort(workspaceId, port, label)`

- [ ] **Step 1: Write the failing mockPorts test**

Append to `src/main/mockPorts.test.ts`, inside `describe('MockServingPorts', …)`:

```ts
  it('declares its labeled fake (port 3000) after emitting it', () => {
    vi.useFakeTimers();
    const declared: Array<[string, number, string]> = [];
    const mock = new MockServingPorts(() => undefined, () => 0, undefined, (id, port, label) => declared.push([id, port, label]));
    mock.reconcile(['ws1']);
    vi.advanceTimersByTime(25_000);
    expect(declared).toEqual([['ws1', 3000, 'Vite dev server']]);
    mock.dispose();
    vi.useRealTimers();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/mockPorts.test.ts`
Expected: FAIL. `declared` is `[]`, and the 4th constructor argument is a type error under tsc.

- [ ] **Step 3: Implement the mock declare**

In `src/main/mockPorts.ts`:
- Extend the `FAKES` element type with `label?: string`. Add `label: 'Vite dev server'` to the port-3000 entry.
- Add a 4th constructor parameter after `resolveSessionId`:

```ts
    /** Mock stand-in for an agent's expose_port call on labeled fakes. */
    private readonly onDeclare?: (workspaceId: string, port: number, label: string) => void
```

- In `add()`, directly after **both** `this.emit(id);` calls (the sync path and inside the async `.then`), add:

```ts
      if (f.label) this.onDeclare?.(id, f.port, f.label);
```

Run: `npx vitest run src/main/mockPorts.test.ts` → PASS.

- [ ] **Step 4: Wire the service in `ipc.ts`**

1. Imports. Add `stateKysely,` to the `./db.js` import list, `getUndeclaredToastAfterSec,` to the `./config.js` import list and `setPortExposureHandlers,` to the `./mcpServer.js` import list. Then add:

```ts
import { PortExposureService, type PortPopup } from './portExposure.js';
import { PortExposureStore, type OpenVia } from './portExposureStore.js';
import { probeLocalHttp } from './localPortProbe.js';
```

2. Replace the whole `broadcastPortDetected` function with:

```ts
/** Tell every window to show the preview popup for a port. */
function broadcastPortDetected(p: PortPopup): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('ports:detected', p);
    } catch {
      /* frame disposed mid-send */
    }
  }
}
```

3. Replace the whole `broadcastPortsChanged` function with:

```ts
// Last Serving snapshot per workspace, re-sent when a declaration adds a label.
const lastServing = new Map<string, ServingPort[]>();

function labeled(workspaceId: string, ports: ServingPort[]): Array<ServingPort & { label: string | null }> {
  return ports.map((p) => ({ ...p, label: portExposure.labelFor(workspaceId, p.port) }));
}

function sendPortsChanged(workspaceId: string, ports: ServingPort[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('ports:changed', { workspaceId, ports: labeled(workspaceId, ports) });
    } catch {
      /* frame disposed mid-send */
    }
  }
}

/** A workspace's Serving snapshot changed: feed exposure tracking, then the rail. */
function broadcastPortsChanged(workspaceId: string, ports: ServingPort[]): void {
  if (ports.length > 0) lastServing.set(workspaceId, ports);
  else lastServing.delete(workspaceId);
  portExposure.onSnapshot(workspaceId, ports);
  sendPortsChanged(workspaceId, ports);
}
```

4. Directly above `const portForward: PortForwardManager | null = MOCK_MODE`, add:

```ts
const portExposure = new PortExposureService({
  // Mock mode opens no state.db.
  sink: MOCK_MODE ? { insert: async () => undefined, update: async () => undefined } : new PortExposureStore(stateKysely),
  workspace: async (id) => {
    const w = (await listAllWorkspaces()).find((x) => x.id === id);
    return w ? { kind: w.kind, running: w.state === 'running' } : null;
  },
  onPopup: broadcastPortDetected,
  onLabelsChanged: (id) => sendPortsChanged(id, lastServing.get(id) ?? []),
  undeclaredToastAfterSec: getUndeclaredToastAfterSec,
  probeLocal: (port) => probeLocalHttp(port),
  onWriteError: (err) => logError({ source: 'main', level: 'warn', type: 'port-exposure-write', message: String(err) })
});
```

5. In the `new PortForwardManager({ … })` call, replace `onDetected: broadcastPortDetected,` with:

```ts
      // Popups come from portExposure (declared ports), not raw detection.
      onDetected: () => undefined,
```

6. Replace the `mockPorts` construction's argument list with:

```ts
  ? new MockServingPorts(
      broadcastPortsChanged,
      undefined,
      async (workspaceId) => {
        const inv = await sessions.readInventory(workspaceId);
        return inv.sessions[0]?.id ?? null;
      },
      (workspaceId, port, label) => void portExposure.declare(workspaceId, { port, label }).catch(() => undefined)
    )
```

7. Replace the `ports:open` handler with:

```ts
  ipcMain.handle(
    'ports:open',
    async (_e, workspaceId: string, containerPort: number, via?: OpenVia): Promise<{ hostPort: number | null }> => {
      const v: OpenVia = via === 'popup' || via === 'fallback' ? via : 'rail';
      if (!portForward) {
        // Mock mode: no real broker; a deterministic stub host port.
        portExposure.recordOpen(workspaceId, containerPort, v);
        return { hostPort: 65000 };
      }
      if (portExposure.isLocalServing(workspaceId, containerPort)) {
        if (!(await probeLocalHttp(containerPort))) return { hostPort: null };
        portExposure.recordOpen(workspaceId, containerPort, v);
        void shell.openExternal(`http://localhost:${containerPort}`);
        return { hostPort: containerPort };
      }
      // The toast is sticky, so the server may be long gone by click time.
      if (!(await portForward.verifyPort(workspaceId, containerPort))) {
        return { hostPort: null };
      }
      const { hostPort } = await portForward.openPort(workspaceId, containerPort);
      portExposure.recordOpen(workspaceId, containerPort, v);
      void shell.openExternal(`http://127.0.0.1:${hostPort}`);
      return { hostPort };
    }
  );

  ipcMain.handle('ports:dismiss', (_e, workspaceId: string, port: number) => {
    portExposure.recordDismiss(workspaceId, port);
  });
```

8. Replace the `ports:list` handler with:

```ts
  ipcMain.handle('ports:list', () =>
    ((portForward ?? mockPorts)?.snapshot() ?? []).map(({ workspaceId, ports }) => ({
      workspaceId,
      ports: labeled(workspaceId, ports)
    }))
  );
```

9. In `registerIpc`, directly after the `setSkillHandlers({ … });` call, add:

```ts
  setPortExposureHandlers({ expose: (callerId, args) => portExposure.declare(callerId, args) });
```

10. In the `CLAUDE_FLEET_E2E` test-only block, replace the `__test:emitDetectedPort` handler with:

```ts
    ipcMain.handle('__test:emitDetectedPort', (_e, popup: PortPopup) => {
      broadcastPortDetected(popup);
    });
    ipcMain.handle('__test:declarePort', (_e, workspaceId: string, port: number, label: string) =>
      portExposure.declare(workspaceId, { port, label })
    );
```

- [ ] **Step 5: Map the new channel for perf spans**

In `src/main/perfIpc.ts`, add `'ports:dismiss': W0,` after `'ports:kill': W0,`.

- [ ] **Step 6: Startup sweep**

In `src/main/index.ts`, add `import { PortExposureStore } from './portExposureStore.js';`. Directly after the `initPerf( … );` call inside `if (jsonlWatcher) {`, add:

```ts
    void new PortExposureStore(stateKysely)
      .sweep()
      .catch((err: unknown) => console.warn('[ports] exposure sweep failed:', err));
```

- [ ] **Step 7: MCP e2e (runs in CI)**

In `tests/mcp-server.spec.ts`, directly after the `expect(names).toEqual(expect.arrayContaining([ … ]))` assertion that follows `tools/list`, add:

```ts
    // expose_port: listed, advertised in the server instructions, validated host-side.
    expect(names).toContain('expose_port');
    expect((init.result as { instructions?: string }).instructions ?? '').toContain('expose_port');
    const eph = (await client.call('tools/call', { name: 'expose_port', arguments: { port: 45000, label: 'x' } }))
      .result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(eph.isError).toBe(true);
    expect(eph.content?.[0]?.text ?? '').toContain('ephemeral range');
    const stopped = (await client.call('tools/call', { name: 'expose_port', arguments: { port: 5173, label: 'Vite' } }))
      .result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(stopped.isError).toBe(true);
    expect(stopped.content?.[0]?.text ?? '').toMatch(/not running|unknown workspace/);
```

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

Run: `npx vitest run src/main/mockPorts.test.ts src/main/portforward.test.ts src/main/mcpServer.test.ts src/main/ipcWorkspaceIdGuard.test.ts src/main/perfIpc.test.ts`
Expected: PASS.

The renderer still uses the old `onDetected(workspaceId, port)` signature until Task 6. `tsconfig.web.json` stays green because preload types it. The `ports:detected` runtime payload is out of step only between commits.

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc.ts src/main/perfIpc.ts src/main/mockPorts.ts src/main/mockPorts.test.ts src/main/index.ts tests/mcp-server.spec.ts
git commit -m "feat(ports): route Serving snapshots and expose_port through PortExposureService"
```

---

### Task 6: Preload + renderer popup, rail label, port e2e

**Files:**
- Modify: `src/preload/index.ts` (around lines 138–152 and 772–805)
- Modify: `src/renderer/src/toasts.ts`
- Modify: `src/renderer/src/components/Toast.tsx`
- Create: `src/renderer/src/portToast.ts`
- Test: `src/renderer/src/portToast.test.ts`
- Modify: `src/renderer/src/App.tsx` (`openPreview` ~590; detection effect ~636–669)
- Modify: `src/renderer/src/components/PortsSection.tsx`
- Test (e2e, CI): `tests/port-forward.spec.ts`

**Interfaces:**
- Consumes: the Task 5 IPC contract.
- Produces (from `src/preload/index.ts`): `PortDetected`, `PortOpenVia`, `ServingPort.label?: string | null`; `window.api.ports.onDetected((p: PortDetected) => void)`, `open(workspaceId, port, via?)`, `dismiss(workspaceId, port)`. From `src/renderer/src/portToast.ts`: `portPopupCopy(p: PortDetected, workspaceName: string): { eyebrow: string; message: string }`.

- [ ] **Step 1: Write the failing copy test**

Create `src/renderer/src/portToast.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { portPopupCopy } from './portToast';

const base = { workspaceId: 'W', port: 5173, label: null, reason: null, cmdline: null, declared: true };

describe('portPopupCopy', () => {
  it('declared: names the workspace, label and port, with the reason when given', () => {
    expect(portPopupCopy({ ...base, label: 'Vite dev server', reason: 'new header' }, 'Work')).toEqual({
      eyebrow: 'Preview',
      message: 'Work wants to show you Vite dev server on :5173 — new header'
    });
    expect(portPopupCopy({ ...base, label: 'Vite dev server' }, 'Work').message).toBe(
      'Work wants to show you Vite dev server on :5173'
    );
  });

  it('undeclared fallback: tagged, with the command when known', () => {
    expect(portPopupCopy({ ...base, declared: false, cmdline: 'node server.js' }, 'Work')).toEqual({
      eyebrow: 'Preview · undeclared',
      message: 'Server on port 5173 in Work (node server.js)'
    });
    expect(portPopupCopy({ ...base, declared: false }, 'Work').message).toBe('Server on port 5173 in Work');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/portToast.test.ts`
Expected: FAIL. The module `./portToast` is not found.

- [ ] **Step 3: Preload types and API**

In `src/preload/index.ts`:

1. Add to `ServingPort` (after `sessionId`):

```ts
  /** expose_port label when the port was declared. */
  label?: string | null;
```

2. Add after the `ServingPort` interface:

```ts
/** Preview popup cue: a declared port began serving, or the undeclared fallback fired. */
export interface PortDetected {
  workspaceId: string;
  port: number;
  label: string | null;
  reason: string | null;
  cmdline: string | null;
  declared: boolean;
}

export type PortOpenVia = 'popup' | 'rail' | 'fallback';
```

3. In `ports: { … }`, replace `onDetected` and `open` and add `dismiss`:

```ts
    /** Subscribe to preview popup cues. Returns an unsubscribe function. */
    onDetected: (cb: (p: PortDetected) => void): (() => void) => {
      const channel = 'ports:detected';
      const handler = (_e: IpcRendererEvent, payload: PortDetected): void => cb(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Open the preview in the system browser; null when nothing answers on the
     *  port anymore. `via` is recorded for exposure tracking. */
    open: (workspaceId: string, containerPort: number, via: PortOpenVia = 'rail'): Promise<{ hostPort: number | null }> =>
      ipcRenderer.invoke('ports:open', workspaceId, containerPort, via),
    /** The user closed a preview popup with ✕. */
    dismiss: (workspaceId: string, port: number): Promise<void> =>
      ipcRenderer.invoke('ports:dismiss', workspaceId, port),
```

- [ ] **Step 4: Toast close hook**

In `src/renderer/src/toasts.ts`, add to `Toast` after `secondaryAction`:

```ts
  /** Runs when the user closes the toast with ✕ (not when an action dismisses it). */
  onClose?: () => void;
```

In `src/renderer/src/components/Toast.tsx`, change the dismiss button's handler to:

```tsx
        <button
          className="toast-dismiss"
          aria-label="Dismiss"
          onClick={() => {
            toast.onClose?.();
            onDismiss(toast.id);
          }}
        >
```

- [ ] **Step 5: Popup copy**

Create `src/renderer/src/portToast.ts`:

```ts
import type { PortDetected } from '../../preload';

export function portPopupCopy(p: PortDetected, workspaceName: string): { eyebrow: string; message: string } {
  if (p.declared) {
    const why = p.reason ? ` — ${p.reason}` : '';
    return { eyebrow: 'Preview', message: `${workspaceName} wants to show you ${p.label ?? 'a server'} on :${p.port}${why}` };
  }
  const cmd = p.cmdline ? ` (${p.cmdline})` : '';
  return { eyebrow: 'Preview · undeclared', message: `Server on port ${p.port} in ${workspaceName}${cmd}` };
}
```

Run: `npx vitest run src/renderer/src/portToast.test.ts` → PASS.

- [ ] **Step 6: App.tsx**

1. Add imports: `import { portPopupCopy } from './portToast';` and add `PortOpenVia` to the existing type import from `'../../preload'` (or add `import type { PortOpenVia } from '../../preload';`).

2. Replace the `openPreview` declaration line and its `.open(...)` call so it reads:

```tsx
  const openPreview = useCallback((workspaceId: string, port: number, via: PortOpenVia = 'rail') => {
    const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
    void window.api.ports
      .open(workspaceId, port, via)
```

Leave the rest of the body unchanged.

3. Replace the whole dev-server detection `useEffect` (the one calling `window.api.ports.onDetected`) with:

```tsx
  // Preview popup: a declared port began serving (or the undeclared fallback
  // fired). Sticky — the toast or the rail are the only ways to reach the
  // preview (bridge IPs aren't routable from the host on Windows). Keyed per
  // workspace+port so a re-fire replaces rather than stacks.
  useEffect(() => {
    return window.api.ports.onDetected((p) => {
      const name = workspacesRef.current.find((w) => w.id === p.workspaceId)?.name ?? 'workspace';
      const { eyebrow, message } = portPopupCopy(p, name);
      const id = ++toastIdRef.current;
      dispatchToast({
        type: 'push',
        toast: makeToast(id, {
          kind: 'info',
          eyebrow,
          key: `port:${p.workspaceId}:${p.port}`,
          message,
          placement: 'global',
          sticky: true,
          dismissible: true,
          onClose: () => void window.api.ports.dismiss(p.workspaceId, p.port),
          action: {
            label: 'Open preview',
            onClick: () => {
              dispatchToast({ type: 'dismiss', id });
              openPreview(p.workspaceId, p.port, p.declared ? 'popup' : 'fallback');
            }
          }
        })
      });
    });
  }, [openPreview]);
```

- [ ] **Step 7: Rail label**

In `src/renderer/src/components/PortsSection.tsx`, replace the `{row.cmdline && ( … )}` block in `PortRow` with:

```tsx
      {row.label ? (
        <span className="obs-port-cmd" title={row.cmdline ?? row.label}>
          {row.label}
        </span>
      ) : (
        row.cmdline && (
          <span className="obs-port-cmd" title={row.cmdline}>
            {row.cmdline}
          </span>
        )
      )}
```

- [ ] **Step 8: Port e2e (runs in CI)**

Replace the body of `tests/port-forward.spec.ts` with:

```ts
import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

const WS = '01MOCKALPHA000000000000000'; // seeded mock workspace (src/main/mock.ts)

test('a declared port surfaces a labeled preview toast; ports:open returns a host port', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    await callTestIpc(app, '__test:emitDetectedPort', [
      { workspaceId: WS, port: 3000, label: 'Vite dev server', reason: null, cmdline: null, declared: true }
    ]);
    const toast = window.locator('.toast-stack', { hasText: 'Vite dev server' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(':3000');
    const openBtn = toast.locator('button.toast-action', { hasText: 'Open preview' });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // Call the bridged function; reassigning it does not work through contextBridge (tests/_helpers.ts).
    const res = await window.evaluate(() => window.api.ports.open('01MOCKALPHA000000000000000', 3000));
    expect(res.hostPort).toBe(65000);
  } finally {
    await app.close();
  }
});

test('an undeclared serving port stays rail-only until an agent declares it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [{ port: 5173, pid: 1, cmdline: 'node vite', sessionId: null, firstSeenAt: Date.now() }]
    ]);
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const row = window.locator('.obs-port-row', { hasText: ':5173' });
    await expect(row).toBeVisible();
    await expect(window.locator('.toast-stack', { hasText: '5173' })).toHaveCount(0);

    await callTestIpc(app, '__test:declarePort', [WS, 5173, 'Docs preview']);
    await expect(window.locator('.toast-stack', { hasText: 'Docs preview' })).toBeVisible();
    await expect(row).toContainText('Docs preview');
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no errors.

Run: `npx vitest run src/renderer src/main/portExposure.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/preload/index.ts src/renderer/src/toasts.ts src/renderer/src/components/Toast.tsx src/renderer/src/portToast.ts src/renderer/src/portToast.test.ts src/renderer/src/App.tsx src/renderer/src/components/PortsSection.tsx tests/port-forward.spec.ts
git commit -m "feat(ports): labeled preview popup for declared ports; rail shows labels"
```

---

### Task 7: SPEC.md

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Non-goals.** Replace the bullet starting `- **Not a general port manager (v1).**` with:

```markdown
- **Not a general port manager.** Preview opens the system browser for ports an agent declares (`expose_port`) or the broker scan finds — no arbitrary `host:port` dialing, no LAN exposure, no in-app preview tab.
```

- [ ] **Step 2: §6 Ports.** Make these edits:
  - In the `ServingPort` shape sentence, add `, label: string | null` after `sessionId: string | null`. Then append this sentence to that paragraph:

```markdown
`label` is the `expose_port` label when declared — added by main from `PortExposureService`, not part of the broker snapshot.
```
  - Replace the whole `- \`ports:detected\`` bullet with:

```markdown
- `ports:detected` (main → renderer event) — `{ workspaceId, port, label, reason, cmdline, declared }`. Fired by `PortExposureService` (`src/main/portExposure.ts`), **not** by raw detection: when a port declared via the fleet-state `expose_port` tool passes the HTTP probe (`declared: true`), or when the undeclared fallback fires (`declared: false`; only when `ports.undeclaredToastAfterSec` > 0, §*Settings*). Ports the scan finds but nobody declared appear only in the Serving rail. The renderer shows a sticky toast — *"<workspace> wants to show you <label> on :<port> — <reason>"*, or for the fallback *"Server on port N in <workspace> (<cmdline>)"* with eyebrow `Preview · undeclared` — with an **Open preview** button, keyed `port:<workspaceId>:<port>` so a re-fire replaces rather than stacks. Closing it with ✕ calls `ports:dismiss`.
```

  - Replace the whole `- \`ports:open(workspaceId, containerPort)\`` bullet with:

```markdown
- `ports:open(workspaceId, containerPort, via?)` → `{ hostPort: number | null }` — `via` (`'popup' | 'rail' | 'fallback'`; anything else ⇒ `'rail'`) is recorded on the port's `port_exposures` row on every successful open. For a **local** workspace's declared port (no broker; `PortExposureService.isLocalServing`) main re-probes `127.0.0.1:<port>` from the host and opens `http://localhost:<port>` directly — no forward. Otherwise it first re-probes the container port (the toast is sticky; the server may be gone by click time) and returns `{ hostPort: null }` when nothing answers, which the renderer surfaces as an error toast instead of opening a dead tab; then creates (or reuses) a `PortForward` for `containerPort`: a loopback `net.Server` bound to `127.0.0.1:0` (ephemeral host port). Each inbound browser connection gets a fresh broker channel via `DIAL`, then traffic flows through the existing `INPUT`/`OUTPUT` relay. Calls `shell.openExternal('http://127.0.0.1:<hostPort>')` and returns `hostPort`. In `MOCK_MODE` (no broker) the handler returns a stub host port without dialing.
- `ports:dismiss(workspaceId, port)` (invoke) — the user closed a preview toast with ✕; records outcome `dismissed` unless the row already has one. The port stays in the rail.
```

  - After the `**\`PortForwardManager\`**` paragraph, add:

```markdown
**`PortExposureService`** (`src/main/portExposure.ts`) — joins `expose_port` declarations with the Serving snapshots (`ports:changed` feeds `onSnapshot`; `PortForwardManager.onDetected` is unused). Rules: ports in the kernel ephemeral range **32768–60999** (what `listen(0)` hands out — test fixtures) are rejected by `expose_port` and never recorded or toasted when scanned; a declaration for a port not yet serving waits **30s** for it to pass the probe, then closes as `not_serving`; `expose_port` is limited to **10 calls/min per workspace**; re-declaring a shown port updates its label without a second popup. **Local** workspaces have no scan: a declared port is probed host-side (`localPortProbe.ts`, `GET / HTTP/1.0` to `127.0.0.1`) every 3s; it pops up on the first pass and ends after two consecutive failures. Each port appearance (first scan-pass or declaration, whichever is first, until it stops listening) is one `port_exposures` row (§7) written through `PortExposureStore`; at startup `sweep()` closes rows a previous run left open (`not_serving` if never probed, else `ignored`) and prunes rows that ended more than 90 days ago.
```

- [ ] **Step 3: Settings.** In the `config.json` shape sentence, add `, ports?: { undeclaredToastAfterSec?: number }` before the closing `}`. Then append this bullet to the settings list:

```markdown
- **ports.undeclaredToastAfterSec** — hand-edited only (no setter channel, not in the Settings UI). Seconds an undeclared, non-ephemeral scanned port must keep serving before the fallback preview toast fires (`declared: false`). Absent, non-numeric or negative ⇒ `0` = never; fractions floor. Tune it from the `port_exposures` missed-declaration rate (§7).
```

- [ ] **Step 4: §7 Data model.** Directly after `CREATE INDEX idx_usage_events_workspace_ts ON usage_events(workspace_id, ts);` (inside the same SQL block), add:

```sql

-- v15: one row per port appearance — declared via expose_port and/or found by
-- the broker scan (PortExposureService). source: declared | scanned | both.
-- outcome: opened | dismissed | ignored | not_serving (NULL while open).
-- opened_via: popup | rail | fallback (first open). Ephemeral-range scanned
-- ports are never recorded. Rows ended > 90 days ago are pruned at startup.
CREATE TABLE port_exposures (
  id               TEXT PRIMARY KEY,   -- ULID
  workspace_id     TEXT NOT NULL,
  session_id       TEXT,               -- owning broker session id, when attributed
  port             INTEGER NOT NULL,
  cmdline          TEXT,
  label            TEXT,
  reason           TEXT,
  source           TEXT NOT NULL,
  first_scanned_at INTEGER,            -- first probe pass (scan, or host probe for local)
  declared_at      INTEGER,
  popup_shown_at   INTEGER,
  outcome          TEXT,
  opened_via       TEXT,
  open_count       INTEGER NOT NULL DEFAULT 0,
  ended_at         INTEGER
);
CREATE INDEX idx_port_exposures_workspace ON port_exposures(workspace_id, port);
CREATE INDEX idx_port_exposures_ended ON port_exposures(ended_at);
-- Missed declarations (scanned, never declared, opened anyway):
--   SELECT count(*) FROM port_exposures WHERE declared_at IS NULL AND open_count > 0;
```

In the **Postgres store** bullet `- **Schema:** a baseline equal to the final SQLite schema (\`store/migrations/statePg.ts\`, state v14).`, replace `state v14)` with `baseline = state v14; v15 \`port_exposures\` is step 15)`.

- [ ] **Step 5: §8 Dev-server preview.** Replace step 1's sentence `Only ports that answer \`HTTP/…\` enter the Serving snapshot and fire \`ports:detected {workspaceId, port}\`` with `Only ports that answer \`HTTP/…\` enter the Serving snapshot`. Then replace step 2 with:

```markdown
2. The agent that started the server calls the fleet-state `expose_port({ port, label, reason? })` tool (the server's MCP `instructions` tell it to). When the declared port is in the Serving snapshot, `PortExposureService` fires `ports:detected` and the renderer shows a sticky labeled toast with **Open preview** (keyed per workspace+port). Undeclared ports appear only in the Serving rail section (see §5 *Observability pane*) unless `ports.undeclaredToastAfterSec` enables the fallback toast.
```

- [ ] **Step 6: §11 fleet-state tool surface.** In the `query(…)` bullet, change `Tables available: \`events\`, \`sessions\`, \`broker_sessions\`, \`session_summaries\`, \`session_tags\`, \`usage_events\`, \`perf_events\`` to end with `, \`perf_events\`, \`port_exposures\`` and append to the bullet: ` On pre-v15 DBs the snapshot creates an empty \`port_exposures\` shell.` Then add after the `query` bullet:

```markdown
- `expose_port({ port, label, reason? })` → `{ status: 'shown' | 'waiting' }` — host-mediated (not a state.db read; works on the Postgres store). Raises the preview popup for a server the caller started (§6 *Ports*, `PortExposureService`). Errors: port outside 1–65535 or in 32768–60999, missing/oversized label (≤80) or reason (≤200), unknown/stopped/remote workspace, more than 10 calls/min. The server's `initialize` result carries `instructions` telling agents to call it after starting a server for the user to view.
```

- [ ] **Step 7: §11 Open decisions.** Delete the whole `### Declared port exposure (#505)` subsection (heading + paragraph).

- [ ] **Step 8: Verify and commit**

Run: `grep -n "Declared port exposure (#505)" docs/SPEC.md`
Expected: no output.

```bash
git add docs/SPEC.md
git commit -m "docs(spec): declared port exposure (expose_port, port_exposures, PortExposureService)"
```

---

## Final verification

- [ ] `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`: both clean.
- [ ] `npx vitest run`: full unit suite green. Any pre-existing environment failures must be the same ones as on `origin/main`.
- [ ] Open the PR. Its body says the Playwright specs (`tests/mcp-server.spec.ts`, `tests/port-forward.spec.ts`) and the Postgres suite run in CI only, and that a host eyeball is still owed: run a vitest suite with HTTP fixtures → no toasts; have an agent start Vite and call `expose_port` → one labeled popup; `query` `SELECT * FROM port_exposures` shows the rows.
