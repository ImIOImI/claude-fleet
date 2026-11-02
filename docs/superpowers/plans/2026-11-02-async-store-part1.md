# Async store layer, part 1: `inbox.db` on async Kysely — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the four `inbox.db` stores (`InboxStore`, `NotifyStore`, `AutomationStore`, `ProposalStore`) and every caller onto one **async** store layer written with **Kysely** on its SQLite dialect. SQLite behaviour, schema and file layout stay exactly as they are.

**Architecture:** `InboxStore.open()` still opens `inbox.db` with better-sqlite3 and runs today's `user_version` migrations synchronously. It then wraps the *same* connection in `new Kysely({ dialect: new SqliteDialect({ database }) })`. Every store method becomes `async` and is written with dialect-neutral Kysely queries, so part 3 can add the Postgres dialect without rewriting them. Kysely's SQLite driver serializes all queries on that one connection through a mutex. A transaction holds the mutex until it commits, so no other store call can land inside an open transaction. That restores the atomicity that synchronous better-sqlite3 gave for free. Callers (services, IPC, presence, scheduler, runner, MCP handlers) become async. Where a sync check-then-act used to be atomic, it now claims synchronously before the first `await`.

**Tech Stack:** TypeScript, Electron main (CJS bundle via electron-vite), better-sqlite3 13, **kysely 0.28.x** (new), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §7 *One store layer*, §11 sub-project (a), §12 (a). This is part 1 of sub-project (a). The outline of parts 2–5 is at the end.

## Global Constraints

- **SQLite behaviour is unchanged:** the same `inbox.db` file, the same `MIGRATIONS` SQL, the same `INBOX_SCHEMA_VERSION = 5`, the same `inbox.db.bak-v<old>-<epochMs>` backup before migrating. Every IPC channel name, payload and return shape stays the same. No renderer or preload change.
- **Kysely `^0.28`** is the only new dependency. It has a CJS build, so the CJS main bundle needs no dynamic import. Pin it in `dependencies`.
- **Dialect-neutral queries in store methods.** No `IFNULL` (use `coalesce`), no `char(10)` (build strings in JS), no `INSERT OR IGNORE` (use `.onConflict((oc) => oc.doNothing())`), no `lastInsertRowid` (use `.returning('id')`). Wrap every `COUNT`/`SUM` result in `num()`, because Postgres returns them as strings. Schema DDL may stay SQLite-specific (part 3 adds per-dialect DDL).
- **Inside `db.transaction().execute(async (trx) => …)` use only `trx`, never `this.db`.** The SQLite driver has one connection behind a mutex, so an outer-handle query inside a transaction waits on the mutex the transaction holds, and deadlocks.
- **Check-then-act stays atomic:** any in-memory guard that used to be read and written in one synchronous block (run concurrency, queueing, tick, proposal decisions) is read and written synchronously after the *last* `await` before the action.
- **`state.db` / `db.ts` / `mcpServer.ts`'s read-only SQLite connection are out of scope** (part 2 and part 5).
- **Never `npm install` into `/workspace/claude-fleet/node_modules`** (the shared base checkout). Work in your own worktree with its own `node_modules` (see *Verification environment*).
- **Typecheck both configs separately:** `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`. `npm run typecheck` short-circuits after the node config.
- **CI (`build-app.yml`, the `unit (vitest)` + build + e2e jobs) is the real gate.** The container can't run Electron or show a UI. UI behaviour (tray, toasts, Inbox) gets a host eyeball from Troy after merge.
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **SPEC.md is updated in the same PR** (Task 6): §4 *Stack* gets the `kysely` row, and §7 *Inbox store* gets the async/mutex note.

## Verification environment (do this once, before Task 1)

Unit tests need a better-sqlite3 binary built for **Node's** ABI. The shared base `node_modules` has an Electron-ABI or broken binding, so give the implementation worktree its own:

```bash
WT=/workspace/claude-fleet/.claude/worktrees/<your-impl-worktree>   # created from origin/main
cd "$WT"
npm ci --ignore-scripts                                  # worktree-local node_modules; skips electron + native postinstalls
(cd node_modules/better-sqlite3 && npx --yes prebuild-install)   # Node-ABI prebuilt .node, no compiler needed
printf 'electron-stub' > node_modules/electron/path.txt  # lets `import { app } from 'electron'` load in vitest
npx vitest run src/main/inbox/inboxDb.test.ts            # baseline: expect PASS
npx tsc --noEmit -p tsconfig.node.json 2>&1 | tail -3    # baseline: record the error count (0 expected on a full install)
npx tsc --noEmit -p tsconfig.web.json 2>&1 | tail -3     # baseline: record the error count
```

If `npm ci` or `prebuild-install` is refused (network or permission classifier), don't install into the base checkout. Verify each task with the two `tsc` commands only, note "vitest not runnable in-container; CI gates" in the task's commit body, and let PR CI run the suites. A step's "Expected: PASS" then means "expected in CI".

### Test-conversion rule (used by Tasks 2–5)

Converting a store to async changes every test that touches it. Apply these rules exactly to the files each task lists:

1. Every `it('…', () => {` whose body calls a converted method becomes `it('…', async () => {`. A `setup()` helper that calls a converted method becomes `async function setup(…)`, and its callers `await setup(…)`.
2. Put `await` before every call to a converted store or service method. In a chain, wrap it: `store.list().map(f)` becomes `(await store.list()).map(f)`, and `svc.get(id)?.yaml` becomes `(await svc.get(id))?.yaml`.
3. `expect(() => x.m(…)).toThrow(re)` becomes `await expect(x.m(…)).rejects.toThrow(re)`.
4. `afterEach(() => inbox?.close())` stays as written (vitest awaits the returned promise).
5. A test helper that fires injected timers (`fire`, `advance`) becomes `async` and ends with `await flush()`, where `const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r)); };` is declared at the top of the file. Kysely-on-better-sqlite3 resolves in microtasks, so three macrotask turns drain any timer-started chain. Callers `await fire(…)`.
6. `new NotifyStore(inbox.db)` / `new AutomationStore(inbox.db)` / `new ProposalStore(inbox.db)` become `(inbox.kysely)`.

After converting, run this check and inspect each hit. A bare statement-level store call without `await` is a bug, even if the test still passes:

```bash
/usr/bin/grep -nE "^\s+(store|s|inbox|svc|automations|proposals|notifyStore)\.[a-zA-Z]+\(" <test-file>
```

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/store/kysely.ts` (new) | `sqliteKysely()` wraps a better-sqlite3 connection, `num()` normalizes aggregates. The only file that names the SQLite dialect. |
| `src/main/store/inboxSchema.ts` (new) | Kysely table types for `inbox.db` (`InboxDb`) and the `Selectable` row aliases the stores map from. |
| `src/main/store/kysely.test.ts` (new) | Pins the helpers and the mutex/transaction invariant the whole plan relies on. |
| `src/main/inbox/inboxDb.ts` | `InboxStore`: open/migrate (unchanged), the Kysely handle, async todo methods. |
| `src/main/inbox/notifyStore.ts` | Async notifications repository. |
| `src/main/automations/proposalStore.ts` | Async proposals repository. |
| `src/main/automations/automationStore.ts` | Async automations/runs repository, plus `expectedVersion` on `update`. |
| `src/main/inbox/notifyService.ts` | Async notification effects, with a serialized `tick`. |
| `src/main/inbox/notifyIpc.ts`, `presence.ts`, `inboxService.ts`, `inboxIpc.ts` | Async wiring. |
| `src/main/automations/automationService.ts` | Async orchestration with synchronous run claims. |
| `src/main/automations/proposalService.ts` | Async proposals with a per-proposal decision guard. |
| `src/main/automations/runner.ts`, `loadoutInstaller.ts`, `automationIpc.ts` | Async wiring. |
| `src/main/index.ts` | `await inboxStore?.close()` on quit. |
| `docs/SPEC.md` | §4 Stack row, §7 Inbox store note. |

---

### Task 1: Kysely foundation and the `InboxStore` handle

**Files:**
- Modify: `package.json`, `package-lock.json` (add `kysely`)
- Create: `src/main/store/kysely.ts`
- Create: `src/main/store/inboxSchema.ts`
- Create: `src/main/store/kysely.test.ts`
- Modify: `src/main/inbox/inboxDb.ts` (constructor, `init`, `close`)
- Modify: `src/main/inbox/inboxDb.test.ts` (one new test)
- Modify: `src/main/index.ts:333` (`await` the close)

**Interfaces:**
- Produces: `sqliteKysely<DB>(raw: Database.Database): Kysely<DB>`; `num(v: unknown): number`; `type InboxDb` and the row aliases `TodoRow`, `TodoEventRow`, `NotificationRowSql`, `AutomationRow`, `RunRowSql`, `StepRunRowSql`, `ProposalRow`; `InboxStore.kysely: Kysely<InboxDb>`; `InboxStore.close(): Promise<void>`. `InboxStore.db` (raw better-sqlite3) stays until Task 5 so unconverted stores keep working.

- [ ] **Step 1: Add the dependency**

```bash
npm install --ignore-scripts kysely@^0.28
```
Expected: `package.json` `dependencies` gains `"kysely": "^0.28.x"`. The lockfile updates.

- [ ] **Step 2: Write the failing tests**

`src/main/store/kysely.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { sqliteKysely, num } from './kysely.js';

interface T { t: { v: number } }

function fresh() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
  return { raw, k: sqliteKysely<T>(raw) };
}

describe('num', () => {
  it('normalizes driver aggregate shapes to a number', () => {
    expect(num(3)).toBe(3);
    expect(num('7')).toBe(7);
    expect(num(5n)).toBe(5);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
  });
});

describe('sqliteKysely', () => {
  it('reads and writes through the wrapped better-sqlite3 connection', async () => {
    const { raw, k } = fresh();
    await k.insertInto('t').values({ v: 1 }).execute();
    expect(raw.prepare('SELECT v FROM t').all()).toEqual([{ v: 1 }]);
    expect(await k.selectFrom('t').select('v').execute()).toEqual([{ v: 1 }]);
    await k.destroy();
  });

  it('serializes a query issued during an open transaction behind that transaction', async () => {
    const { k } = fresh();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const tx = k.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ v: 1 }).execute();
      await gate;
      order.push('tx-end');
    });
    await new Promise((r) => setTimeout(r, 10));
    const outside = k.selectFrom('t').selectAll().execute().then((rows) => { order.push(`outside:${rows.length}`); });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // the outside read waits on the connection mutex
    release();
    await tx;
    await outside;
    expect(order).toEqual(['tx-end', 'outside:1']);
    await k.destroy();
  });

  it('rolls back a transaction that throws', async () => {
    const { k } = fresh();
    await expect(k.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ v: 1 }).execute();
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await k.selectFrom('t').selectAll().execute()).toEqual([]);
    await k.destroy();
  });
});
```

Append to `src/main/inbox/inboxDb.test.ts` (top-level, after the existing `describe` blocks):

```ts
describe('InboxStore.kysely', () => {
  it('exposes a Kysely handle over the same connection, and close() closes it', async () => {
    store = InboxStore.memory();
    const { todo } = store.post(WS, { title: 'via raw' }, 1000);
    const rows = await store.kysely.selectFrom('todos').select(['id', 'title']).execute();
    expect(rows).toEqual([{ id: todo.id, title: 'via raw' }]);
    await store.close();
    await expect(store.kysely.selectFrom('todos').selectAll().execute()).rejects.toThrow();
    store = InboxStore.memory(); // afterEach closes a live store
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/main/store/kysely.test.ts src/main/inbox/inboxDb.test.ts`
Expected: FAIL. `Cannot find module './kysely.js'`, and `store.kysely` is undefined.

- [ ] **Step 4: Implement**

`src/main/store/kysely.ts`:

```ts
// The async store layer's dialect seam (remote-workspaces spec §7 "One store
// layer"). Stores are written once against Kysely; this file is the only place
// that names the SQLite dialect. Part 3 adds the Postgres dialect beside it.
//
// Invariant the stores rely on: Kysely's SQLite driver runs every query on the
// single wrapped connection behind a mutex, and a transaction holds that mutex
// until it commits. So no other store call can interleave inside an open
// transaction — and a query on the OUTER handle from inside a transaction
// callback deadlocks. Inside `transaction().execute(async (trx) => …)`, use trx.
import type Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

export function sqliteKysely<DB>(raw: Database.Database): Kysely<DB> {
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
}

/** COUNT/SUM come back as number (SQLite), bigint, or string (Postgres); NULL sums as 0. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}
```

`src/main/store/inboxSchema.ts`:

```ts
// Kysely table types for inbox.db (#407). Mirrors MIGRATIONS 1–5 in
// inbox/inboxDb.ts exactly; a migration that changes a table changes it here too.
import type { Generated, Selectable } from 'kysely';
import type {
  DowntimeBypass, NotificationKind, NotifyLevel, ProposalKind, ProposalStatus, RuleScopeKind, RunStatus,
  TodoEventKind, TodoPriority, TodoSource, TodoStatus
} from '../../preload/inboxTypes.js';

type SourceKind = TodoSource['kind'];

export interface TodosTable {
  id: string; title: string; body: string | null; status: TodoStatus; priority: TodoPriority;
  source_kind: SourceKind; source_id: string | null; source_run_id: string | null; via_workspace: string | null;
  dedupe_key: string | null; seen_count: Generated<number>; recurred: Generated<number>;
  workspace_id: string | null; session_id: string | null;
  created_at: number; updated_at: number; first_seen_at: number; last_seen_at: number; closed_at: number | null;
}
export interface TagsTable { entity_kind: string; entity_id: string; tag: string }
export interface TodoEventsTable {
  id: Generated<number>; todo_id: string; ts: number; kind: TodoEventKind; actor_kind: SourceKind;
  actor_id: string | null; run_id: string | null; detail: string | null;
}
export interface NotificationsTable {
  id: string; ts: number; kind: NotificationKind; title: string; body: string | null; priority: TodoPriority;
  source_kind: SourceKind; source_id: string | null; todo_id: string | null; workspace_id: string | null;
  dedupe_key: string | null; tags: string | null; delivered: number; held_reason: string | null;
  channel: 'os' | 'in-app' | null; cleared_at: number | null; digested: Generated<number>;
}
export interface NotificationRulesTable {
  id: string; scope_kind: RuleScopeKind; scope_value: string; level: NotifyLevel; snooze_until: number | null;
  created_at: number; updated_at: number;
}
export interface DowntimesTable {
  id: string; name: string; enabled: number; days_mask: number; start_min: number; end_min: number;
  bypass: DowntimeBypass; created_at: number;
}
export interface NotifyStateTable { k: string; v: string }
export interface AutomationsTable {
  id: string; name: string; enabled: number; version: number; definition: string; created_by_kind: SourceKind;
  created_by_id: string | null; origin: string | null; created_at: number; updated_at: number;
  last_scheduled_at: number | null; next_run_at: number | null; next_run_by: string | null;
}
export interface AutomationVersionsTable {
  automation_id: string; version: number; definition: string; created_at: number; created_by_kind: SourceKind; created_by_id: string | null;
}
export interface AutomationStateTable { automation_id: string; state: string }
export interface RunsTable {
  id: string; automation_id: string; version: number; trigger: string; args: string; status: RunStatus;
  started_at: number; ended_at: number | null; error: string | null; reschedule: string | null;
}
export interface StepRunsTable {
  id: Generated<number>; run_id: string; step_id: string; kind: 'prompt' | 'script'; status: RunStatus;
  workspace_id: string | null; broker_session_id: string | null; started_at: number; ended_at: number | null;
  error: string | null; detail: string | null;
}
export interface ProposalsTable {
  id: string; kind: ProposalKind; proposer_kind: SourceKind; proposer_id: string | null; rationale: string | null;
  status: ProposalStatus; items: string; note: string | null; created_at: number; decided_at: number | null;
}

export interface InboxDb {
  todos: TodosTable;
  tags: TagsTable;
  todo_events: TodoEventsTable;
  notifications: NotificationsTable;
  notification_rules: NotificationRulesTable;
  downtimes: DowntimesTable;
  notify_state: NotifyStateTable;
  automations: AutomationsTable;
  automation_versions: AutomationVersionsTable;
  automation_state: AutomationStateTable;
  runs: RunsTable;
  step_runs: StepRunsTable;
  proposals: ProposalsTable;
}

export type TodoRow = Selectable<TodosTable>;
export type TodoEventRow = Selectable<TodoEventsTable>;
export type NotificationRowSql = Selectable<NotificationsTable>;
export type AutomationRow = Selectable<AutomationsTable>;
export type RunRowSql = Selectable<RunsTable>;
export type StepRunRowSql = Selectable<StepRunsTable>;
export type ProposalRow = Selectable<ProposalsTable>;
```

In `src/main/inbox/inboxDb.ts`:

Add imports below the existing ones:
```ts
import type { Kysely } from 'kysely';
import { sqliteKysely } from '../store/kysely.js';
import type { InboxDb } from '../store/inboxSchema.js';
```

Replace the constructor line `private constructor(readonly db: Database.Database) {}` with:
```ts
  /** `db` is the raw connection (removed once every store is on `kysely`, Task 5). */
  private constructor(readonly db: Database.Database, readonly kysely: Kysely<InboxDb>) {}
```

In `init`, replace `return new InboxStore(db);` with:
```ts
    return new InboxStore(db, sqliteKysely<InboxDb>(db));
```

Replace `close()` with:
```ts
  async close(): Promise<void> {
    // destroy() only closes the connection if Kysely ever ran a query, so close the raw handle too.
    await this.kysely.destroy();
    if (this.db.open) this.db.close();
  }
```

In `src/main/index.ts`, in the `before-quit` handler, replace `inboxStore?.close();` with:
```ts
  await inboxStore?.close();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/store/kysely.test.ts src/main/inbox/inboxDb.test.ts`
Expected: PASS (all tests, old and new).
Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no errors beyond the baseline.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/store src/main/inbox/inboxDb.ts src/main/inbox/inboxDb.test.ts src/main/index.ts
git commit -m "feat(store): Kysely SQLite handle over inbox.db (async store layer, part 1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `NotifyStore` and the notification callers go async

**Files:**
- Modify: `src/main/inbox/notifyStore.ts` (full rewrite below)
- Modify: `src/main/inbox/notifyService.ts` (full rewrite below)
- Modify: `src/main/inbox/notifyIpc.ts` (`registerNotifyIpc` rewrite below)
- Modify: `src/main/inbox/presence.ts` (`startPresence` rewrite below)
- Modify: `src/main/inbox/inboxService.ts` (await every store/notification call)
- Modify: `src/main/automations/automationIpc.ts` (two `notify:` wirings)
- Test: `src/main/inbox/notifyStore.test.ts`, `src/main/inbox/notifyService.test.ts` (test-conversion rule, plus a new race test)

**Interfaces:**
- Consumes: `InboxStore.kysely`, `num()`, `InboxDb`, `NotificationRowSql` (Task 1).
- Produces: every `NotifyStore` method returns a `Promise` of its old type. `NotifyService`: `request(input): Promise<NotificationRow>`, `onTodoPosted(…): Promise<NotificationRow | null>`, `onPostRejected(…): Promise<NotificationRow | null>`, `onInputWait(…): Promise<void>`, `tick(): Promise<NotificationRow | null>` (serialized), `quietState(): Promise<QuietState>`, `test(): Promise<NotificationRow>`, `prune(): Promise<number>`, `effectiveFor(…): Promise<EffectiveRule>`. `scopesFor` and `waitingWorkspaces` stay sync. New optional `NotifyDeps.onError?(e: unknown): void`. `startPresence(inbox, notify, approvals: () => number | Promise<number>)`.

- [ ] **Step 1: Convert the tests and add the race test**

Apply the *Test-conversion rule* to `src/main/inbox/notifyStore.test.ts` and `src/main/inbox/notifyService.test.ts`. In `notifyService.test.ts`, `setup()`'s `advance` becomes:

```ts
  const advance = async (ms: number) => {
    t += ms;
    for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn(); }
    await flush();
  };
```

Append to `notifyService.test.ts`:

```ts
describe('tick serialization', () => {
  it('two overlapping ticks when a pause ends send exactly one digest', async () => {
    const { store, svc, delivered } = setup();
    await store.setPause({ until: null, letUrgent: false, setAt: 0 });
    await svc.tick(); // the quiet period begins
    const held = await svc.request({ kind: 'post', title: 'x', priority: 'normal', source: { kind: 'workspace', id: 'W1' } });
    expect(held.heldReason).toBe('pause');
    await store.clearPause();
    const [a, b] = await Promise.all([svc.tick(), svc.tick()]);
    expect([a, b].filter((n) => n?.kind === 'digest')).toHaveLength(1);
    expect(delivered.filter((n) => n.kind === 'digest')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/inbox/notifyStore.test.ts src/main/inbox/notifyService.test.ts`
Expected: FAIL. `new NotifyStore(inbox.kysely)` gets a Kysely handle while the store still calls `.prepare`, so you see `this.db.prepare is not a function`.

- [ ] **Step 3: Rewrite `src/main/inbox/notifyStore.ts`**

```ts
// Notifications repository (#407 Phase 2) over the inbox.db connection: the
// notification log, the user's rules, downtime schedules and small state
// (pause, default level). No policy here — see notifyPolicy.ts. Async on the
// Kysely store layer (store/kysely.ts).
import type { Kysely } from 'kysely';
import type {
  Downtime, NotificationRow, NotifyLevel, NotifyRule, PauseState
} from '../../preload/inboxTypes.js';
import { newId } from './inboxDb.js';
import type { InboxDb, NotificationRowSql } from '../store/inboxSchema.js';

export type NewNotification = Omit<NotificationRow, 'id' | 'clearedAt'>;

const LEVELS = new Set<NotifyLevel>(['all', 'high', 'urgent', 'off']);

function toRow(r: NotificationRowSql): NotificationRow {
  return {
    id: r.id, ts: r.ts, kind: r.kind, title: r.title, body: r.body, priority: r.priority,
    source: { kind: r.source_kind, id: r.source_id }, todoId: r.todo_id, workspaceId: r.workspace_id,
    dedupeKey: r.dedupe_key, tags: r.tags ? (JSON.parse(r.tags) as string[]) : [], delivered: r.delivered === 1,
    heldReason: r.held_reason, channel: r.channel, clearedAt: r.cleared_at
  };
}

function maskOf(days: number[]): number {
  return days.reduce((m, d) => (d >= 0 && d <= 6 ? m | (1 << d) : m), 0);
}
function daysOf(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d));
}

export class NotifyStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  // --- notification log ---------------------------------------------------

  async insert(n: NewNotification): Promise<NotificationRow> {
    const id = newId(n.ts);
    await this.db.insertInto('notifications').values({
      id, ts: n.ts, kind: n.kind, title: n.title, body: n.body, priority: n.priority, source_kind: n.source.kind,
      source_id: n.source.id, todo_id: n.todoId, workspace_id: n.workspaceId, dedupe_key: n.dedupeKey,
      tags: n.tags.length ? JSON.stringify(n.tags) : null, delivered: n.delivered ? 1 : 0,
      held_reason: n.heldReason, channel: n.channel
    }).execute();
    return (await this.get(id))!;
  }

  async setChannel(id: string, channel: 'os' | 'in-app'): Promise<void> {
    await this.db.updateTable('notifications').set({ channel }).where('id', '=', id).execute();
  }

  async get(id: string): Promise<NotificationRow | null> {
    const r = await this.db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRow(r) : null;
  }

  async list(opts: { filter?: 'all' | 'delivered' | 'held'; limit?: number } = {}): Promise<NotificationRow[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), 1000);
    let q = this.db.selectFrom('notifications').selectAll();
    if (opts.filter === 'held') q = q.where('delivered', '=', 0);
    else if (opts.filter === 'delivered') q = q.where('delivered', '=', 1);
    const rows = await q.orderBy('ts', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map(toRow);
  }

  /** Mark every uncleared notification with this dedupe key cleared; returns their ids. */
  async clearByKey(key: string, now: number): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      const ids = (await trx.selectFrom('notifications').select('id')
        .where('dedupe_key', '=', key).where('cleared_at', 'is', null).execute()).map((r) => r.id);
      if (ids.length) {
        await trx.updateTable('notifications').set({ cleared_at: now })
          .where('dedupe_key', '=', key).where('cleared_at', 'is', null).execute();
      }
      return ids;
    });
  }

  /** Held by a pause or downtime since `since`, and not yet summarized in a digest. */
  async heldQuietSince(since: number): Promise<NotificationRow[]> {
    const rows = await this.db.selectFrom('notifications').selectAll()
      .where('delivered', '=', 0).where('digested', '=', 0).where('ts', '>=', since)
      .where((eb) => eb.or([eb('held_reason', '=', 'pause'), eb('held_reason', 'like', 'downtime:%')]))
      .orderBy('ts').execute();
    return rows.map(toRow);
  }

  async markDigested(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.updateTable('notifications').set({ digested: 1 }).where('id', 'in', ids).execute();
  }

  async prune(olderThan: number): Promise<number> {
    const r = await this.db.deleteFrom('notifications').where('ts', '<', olderThan).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  // --- rules ---------------------------------------------------------------

  async rules(): Promise<NotifyRule[]> {
    const rows = await this.db.selectFrom('notification_rules')
      .select(['id', 'scope_kind', 'scope_value', 'level', 'snooze_until'])
      .orderBy('created_at').orderBy('id').execute();
    return rows.map((r) => ({ id: r.id, scopeKind: r.scope_kind, scopeValue: r.scope_value, level: r.level, snoozeUntil: r.snooze_until }));
  }

  /** Upsert by (scopeKind, scopeValue): one rule per scope. */
  async setRule(rule: Omit<NotifyRule, 'id'>, now = Date.now()): Promise<NotifyRule> {
    if (!LEVELS.has(rule.level)) throw new Error(`invalid level ${rule.level}`);
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('notification_rules').select('id')
        .where('scope_kind', '=', rule.scopeKind).where('scope_value', '=', rule.scopeValue).executeTakeFirst();
      if (existing) {
        await trx.updateTable('notification_rules').set({ level: rule.level, snooze_until: rule.snoozeUntil, updated_at: now })
          .where('id', '=', existing.id).execute();
        return { ...rule, id: existing.id };
      }
      const id = newId(now);
      await trx.insertInto('notification_rules').values({
        id, scope_kind: rule.scopeKind, scope_value: rule.scopeValue, level: rule.level, snooze_until: rule.snoozeUntil,
        created_at: now, updated_at: now
      }).execute();
      return { ...rule, id };
    });
  }

  async removeRule(id: string): Promise<void> {
    await this.db.deleteFrom('notification_rules').where('id', '=', id).execute();
  }

  // --- downtimes -----------------------------------------------------------

  async downtimes(): Promise<Downtime[]> {
    const rows = await this.db.selectFrom('downtimes').selectAll().orderBy('created_at').orderBy('id').execute();
    return rows.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled === 1, days: daysOf(d.days_mask), startMin: d.start_min, endMin: d.end_min, bypass: d.bypass }));
  }

  async saveDowntime(d: Omit<Downtime, 'id'> & { id?: string }, now = Date.now()): Promise<Downtime> {
    const clamp = (m: number) => Math.min(Math.max(0, Math.floor(m)), 1439);
    const row = { ...d, startMin: clamp(d.startMin), endMin: clamp(d.endMin), name: d.name.trim().slice(0, 60) || 'Downtime' };
    return this.db.transaction().execute(async (trx) => {
      const found = d.id ? await trx.selectFrom('downtimes').select('id').where('id', '=', d.id).executeTakeFirst() : undefined;
      if (d.id && found) {
        await trx.updateTable('downtimes').set({
          name: row.name, enabled: row.enabled ? 1 : 0, days_mask: maskOf(row.days), start_min: row.startMin, end_min: row.endMin, bypass: row.bypass
        }).where('id', '=', d.id).execute();
        return { ...row, id: d.id, days: daysOf(maskOf(row.days)) };
      }
      const id = newId(now);
      await trx.insertInto('downtimes').values({
        id, name: row.name, enabled: row.enabled ? 1 : 0, days_mask: maskOf(row.days), start_min: row.startMin,
        end_min: row.endMin, bypass: row.bypass, created_at: now
      }).execute();
      return { id, name: row.name, enabled: row.enabled, days: daysOf(maskOf(row.days)), startMin: row.startMin, endMin: row.endMin, bypass: row.bypass };
    });
  }

  async removeDowntime(id: string): Promise<void> {
    await this.db.deleteFrom('downtimes').where('id', '=', id).execute();
  }

  // --- small state ---------------------------------------------------------

  private async getState(k: string): Promise<string | null> {
    const r = await this.db.selectFrom('notify_state').select('v').where('k', '=', k).executeTakeFirst();
    return r?.v ?? null;
  }
  private async setState(k: string, v: string | null): Promise<void> {
    if (v === null) {
      await this.db.deleteFrom('notify_state').where('k', '=', k).execute();
      return;
    }
    await this.db.insertInto('notify_state').values({ k, v })
      .onConflict((oc) => oc.column('k').doUpdateSet({ v: (eb) => eb.ref('excluded.v') })).execute();
  }

  async getPause(): Promise<PauseState | null> {
    const v = await this.getState('pause');
    return v ? (JSON.parse(v) as PauseState) : null;
  }
  async setPause(p: PauseState): Promise<void> {
    await this.setState('pause', JSON.stringify(p));
  }
  async clearPause(): Promise<void> {
    await this.setState('pause', null);
  }

  async getDefaultLevel(): Promise<NotifyLevel> {
    const v = (await this.getState('defaultLevel')) as NotifyLevel | null;
    return v && LEVELS.has(v) ? v : 'all';
  }
  async setDefaultLevel(level: NotifyLevel): Promise<void> {
    if (!LEVELS.has(level)) throw new Error(`invalid level ${level}`);
    await this.setState('defaultLevel', level);
  }

  /** Marker for digest bookkeeping: when the current quiet period began (or null). */
  async getQuietSince(): Promise<number | null> {
    const v = await this.getState('quietSince');
    return v ? Number(v) : null;
  }
  async setQuietSince(ts: number | null): Promise<void> {
    await this.setState('quietSince', ts === null ? null : String(ts));
  }
}
```

- [ ] **Step 4: Rewrite `src/main/inbox/notifyService.ts`**

```ts
// Notification effects (#407 Phase 2) — pure: clock, delivery, timers and the
// user's current view are injected, so the digest and needs-input timing are
// unit-testable. notifyIpc.ts binds it to Electron. Async on the store layer;
// tick() is serialized so two overlapping ticks can't both send a digest.
import type {
  EffectiveRule, NotificationKind, NotificationRow, QuietState, RuleScope, Todo, TodoPriority, TodoSource
} from '../../preload/inboxTypes.js';
import { NotifyStore } from './notifyStore.js';
import { activeDowntime, effectiveRule, nextDowntime, pauseActive, resolve, sourceScopeValue } from './notifyPolicy.js';

export interface NotifyDeps {
  store: NotifyStore;
  now(): number;
  /** Show it (OS notification or in-app toast); returns the channel used. */
  deliver(n: NotificationRow): 'os' | 'in-app';
  name(workspaceId: string): string;
  viewing(): { focused: boolean; workspaceId: string | null; inboxOpen: boolean };
  changed(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** A timer-started notification failed (notifyIpc logs it). */
  onError?(e: unknown): void;
}

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  priority: TodoPriority;
  source: TodoSource;
  todoId?: string | null;
  workspaceId?: string | null;
  dedupeKey?: string | null;
  tags?: string[];
}

export const INPUT_WAIT_DELAY_MS = 20_000;
export const RETENTION_MS = 30 * 86_400_000;
const HOUR = 3_600_000;

export function createNotifyService(deps: NotifyDeps) {
  const { store } = deps;
  const lastRejection = new Map<string, number>();
  const waitTimers = new Map<string, unknown>();
  const waiting = new Map<string, number>();
  let ticking: Promise<unknown> = Promise.resolve();

  async function request(input: NotifyInput): Promise<NotificationRow> {
    const now = deps.now();
    const tags = input.tags ?? [];
    const [rules, defaultLevel, pause, downtimes] = await Promise.all([store.rules(), store.getDefaultLevel(), store.getPause(), store.downtimes()]);
    const res = resolve(
      { kind: input.kind, priority: input.priority, source: input.source, dedupeKey: input.dedupeKey ?? null, tags },
      { rules, defaultLevel, pause, downtimes, now }
    );
    const row = await store.insert({
      ts: now, kind: input.kind, title: input.title, body: input.body ?? null, priority: input.priority,
      source: input.source, todoId: input.todoId ?? null, workspaceId: input.workspaceId ?? null,
      dedupeKey: input.dedupeKey ?? null, tags, delivered: res.deliver,
      heldReason: res.deliver ? null : res.heldReason, channel: null
    });
    if (res.deliver) {
      const channel = deps.deliver(row);
      await store.setChannel(row.id, channel);
      row.channel = channel;
    }
    deps.changed();
    return row;
  }

  function sourceName(s: TodoSource): string {
    if (s.kind === 'user') return 'You';
    if (s.kind === 'workspace' && s.id) return deps.name(s.id);
    return 'automation';
  }

  async function tickOnce(): Promise<NotificationRow | null> {
    const now = deps.now();
    const pause = await store.getPause();
    if (pause && !pauseActive(pause, now)) await store.clearPause();
    const livePause = pauseActive(pause, now) ? pause : null;
    const dt = activeDowntime(await store.downtimes(), now);
    const quiet = !!livePause || !!dt;
    const since = await store.getQuietSince();
    if (quiet && since === null) {
      await store.setQuietSince(Math.min(livePause?.setAt ?? now, dt?.start ?? now));
      return null;
    }
    if (!quiet && since !== null) {
      await store.setQuietSince(null);
      const held = await store.heldQuietSince(since);
      if (!held.length) {
        deps.changed();
        return null;
      }
      await store.markDigested(held.map((n) => n.id));
      const inputs = held.filter((n) => n.kind === 'input-wait' && n.clearedAt === null).length;
      const todos = held.filter((n) => n.kind === 'todo').length;
      const urgent = held.filter((n) => n.priority === 'urgent').length;
      const other = held.length - inputs - todos;
      const parts = [
        inputs ? `${inputs} needs input` : null,
        todos ? `${todos} todo${todos > 1 ? 's' : ''}${urgent ? '' : ' (none urgent)'}` : null,
        other ? `${other} other` : null
      ].filter(Boolean);
      return request({
        kind: 'digest', title: `Notifications resumed: ${held.length} held`, body: parts.join(' · '),
        priority: urgent ? 'urgent' : 'normal', source: { kind: 'user', id: null }
      });
    }
    return null;
  }

  return {
    request,

    /** A todo was posted/updated; notify when the poster asked, or when it arrives urgent. */
    async onTodoPosted(todo: Todo, action: 'created' | 'updated' | 'reopened', notifyRequested: boolean): Promise<NotificationRow | null> {
      const urgentArrival = todo.priority === 'urgent' && action !== 'updated';
      if (!notifyRequested && !urgentArrival) return null;
      return request({
        kind: 'todo',
        title: todo.priority === 'urgent' ? `Urgent · ${todo.title}` : todo.title,
        body: [sourceName(todo.source), todo.seenCount > 1 ? `seen ${todo.seenCount}×` : null, action === 'reopened' ? 'reopened' : null]
          .filter(Boolean).join(' · '),
        priority: todo.priority, source: todo.source, todoId: todo.id, workspaceId: todo.workspaceId,
        dedupeKey: todo.dedupeKey, tags: todo.tags
      });
    },

    /** A workspace's post was refused. Tell the user once per workspace per hour. */
    async onPostRejected(workspaceId: string, reason: string): Promise<NotificationRow | null> {
      const now = deps.now();
      const last = lastRejection.get(workspaceId);
      if (last !== undefined && now - last < HOUR) return null;
      lastRejection.set(workspaceId, now); // claimed before the first await
      const name = deps.name(workspaceId);
      const disabled = reason === 'posting disabled';
      return request({
        kind: 'post-rejected',
        title: disabled ? `${name} tried to post, but posting is off` : `${name} hit its post limit`,
        body: disabled ? 'Turn it on in Edit workspace › Inbox & automations.' : `${reason}. Further posts are rejected until the hour rolls over.`,
        priority: 'normal', source: { kind: 'workspace', id: workspaceId }, workspaceId
      });
    },

    /** The workspace's set of sessions waiting on AskUserQuestion changed. */
    async onInputWait(workspaceId: string, waitingIds: string[]): Promise<void> {
      const key = `input-wait:${workspaceId}`;
      if (waitingIds.length === 0) {
        waiting.delete(workspaceId);
        const t = waitTimers.get(workspaceId);
        if (t !== undefined) deps.clearTimer(t);
        waitTimers.delete(workspaceId);
        if ((await store.clearByKey(key, deps.now())).length) deps.changed();
        return;
      }
      if (waiting.has(workspaceId)) return; // already waiting: one notification per episode
      waiting.set(workspaceId, deps.now());
      waitTimers.set(workspaceId, deps.setTimer(() => {
        waitTimers.delete(workspaceId);
        if (!waiting.has(workspaceId)) return;
        const v = deps.viewing();
        if (v.focused && !v.inboxOpen && v.workspaceId === workspaceId) return;
        request({
          kind: 'input-wait', title: `${deps.name(workspaceId)} needs your input`,
          body: 'A session is waiting on a question.', priority: 'high',
          source: { kind: 'workspace', id: workspaceId }, workspaceId, dedupeKey: key
        }).catch((e) => deps.onError?.(e));
      }, INPUT_WAIT_DELAY_MS));
    },

    /** Workspaces currently waiting on input (for the "needs you" count). */
    waitingWorkspaces(): string[] {
      return [...waiting.keys()];
    },

    /** Periodic: expire pauses, track quiet periods, send one digest when quiet ends. Serialized. */
    tick(): Promise<NotificationRow | null> {
      const run = ticking.then(tickOnce, tickOnce);
      ticking = run.catch(() => undefined);
      return run;
    },

    async quietState(): Promise<QuietState> {
      const now = deps.now();
      const [pause, ds, since] = await Promise.all([store.getPause(), store.downtimes(), store.getQuietSince()]);
      const dt = activeDowntime(ds, now);
      return {
        pause: pauseActive(pause, now) ? pause : null,
        activeDowntime: dt?.downtime ?? null,
        nextDowntime: nextDowntime(ds, now),
        heldSinceQuiet: since === null ? 0 : (await store.heldQuietSince(since)).length
      };
    },

    test(): Promise<NotificationRow> {
      return request({
        kind: 'test', title: 'Test notification', body: 'This is how claude-fleet notifications reach you.',
        priority: 'normal', source: { kind: 'user', id: null }
      });
    },

    prune(): Promise<number> {
      return store.prune(deps.now() - RETENTION_MS);
    },

    /** Rule scopes the 🔔 popover offers for an item (no global — that lives in Settings). */
    scopesFor(item: { source: TodoSource; dedupeKey: string | null; tags: string[] }): RuleScope[] {
      const src = sourceScopeValue(item.source);
      return [
        ...(item.dedupeKey ? [{ scopeKind: 'key' as const, scopeValue: `${src}:${item.dedupeKey}`, label: 'This item' }] : []),
        { scopeKind: 'source' as const, scopeValue: src, label: sourceName(item.source) },
        ...item.tags.slice(0, 1).map((t) => ({ scopeKind: 'tag' as const, scopeValue: t, label: `#${t}` }))
      ];
    },

    async effectiveFor(item: { kind?: NotificationKind; priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }): Promise<EffectiveRule> {
      const [rules, level] = await Promise.all([store.rules(), store.getDefaultLevel()]);
      return effectiveRule(
        { kind: item.kind ?? 'todo', priority: item.priority, source: item.source, dedupeKey: item.dedupeKey, tags: item.tags },
        rules, level, deps.now()
      );
    }
  };
}

export type NotifyService = ReturnType<typeof createNotifyService>;
```

(The old file imported `scopesFor` from `notifyPolicy.js` but never used it. The import is dropped here.)

- [ ] **Step 5: Rewrite `registerNotifyIpc` in `src/main/inbox/notifyIpc.ts`**

Replace the whole `registerNotifyIpc` function (from `export function registerNotifyIpc` to the end of the file) with:

```ts
export function registerNotifyIpc(inbox: InboxStore): NotifyService {
  const store = new NotifyStore(inbox.kysely);
  const names = new Map<string, string>();
  const refreshNames = () =>
    listWorkspaceManifests()
      .then((ms) => { for (const m of ms) names.set(m.id, m.name); })
      .catch(() => {});
  void refreshNames();
  const viewing = { workspaceId: null as string | null, inboxOpen: false };
  const live: Notification[] = [];
  const warn = (type: string) => (e: unknown) => logError({ source: 'main', type, level: 'warn', message: String(e) });

  const svc = createNotifyService({
    store,
    now: Date.now,
    name: (id) => names.get(id) ?? 'a workspace',
    viewing: () => ({ focused: BrowserWindow.getAllWindows().some((w) => w.isFocused()), ...viewing }),
    changed: () => {
      void svc.quietState().then((q) => send('notifications:changed', q), warn('notify-changed'));
      emitInboxChanged();
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    onError: warn('notify-timer'),
    deliver: (n: NotificationRow) => {
      const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
      if (focused || !Notification.isSupported()) {
        send('notifications:toast', n);
        return 'in-app';
      }
      const os = new Notification({ title: n.title, body: n.body ?? '', silent: n.priority === 'low' });
      os.on('click', () => {
        focusMain();
        send('notifications:open', { notificationId: n.id, todoId: n.todoId, workspaceId: n.workspaceId, kind: n.kind });
      });
      os.on('close', () => {
        const i = live.indexOf(os);
        if (i >= 0) live.splice(i, 1);
      });
      live.push(os); // keep a reference so the click handler survives GC
      if (live.length > 20) live.shift();
      os.show();
      if (n.priority === 'urgent') inboxEvents.emit('attention');
      return 'os';
    }
  });

  setInputWaitObserver((workspaceId, ids) => {
    if (!names.has(workspaceId)) void refreshNames();
    svc.onInputWait(workspaceId, ids).catch(warn('notify-input-wait'));
    emitInboxChanged();
  });

  const tick = setInterval(() => { svc.tick().catch(warn('notify-tick')); }, 30_000);
  tick.unref?.();
  svc.prune().catch(warn('notify-prune'));
  const daily = setInterval(() => { svc.prune().catch(() => { /* next day */ }); }, 86_400_000);
  daily.unref?.();

  const settings = async () => {
    const [defaultLevel, q, downtimes, rules] = await Promise.all([store.getDefaultLevel(), svc.quietState(), store.downtimes(), store.rules()]);
    return { defaultLevel, pause: q.pause, downtimes, rules };
  };
  const after = async <T>(v: T | Promise<T>): Promise<T> => {
    const r = await v;
    await svc.tick();
    send('notifications:changed', await svc.quietState());
    return r;
  };

  ipcMain.handle('notifications:list', (_e, filter?: 'all' | 'delivered' | 'held', limit?: number) => store.list({ filter, limit }));
  ipcMain.handle('notifications:settings', () => settings());
  ipcMain.handle('notifications:quietState', () => svc.quietState());
  ipcMain.handle('notifications:scopesFor', (_e, item: { source: TodoSource; dedupeKey: string | null; tags: string[] }) => svc.scopesFor(item));
  ipcMain.handle('notifications:effective', (_e, item: { priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }) => svc.effectiveFor(item));
  ipcMain.handle('notifications:effectiveMany', async (_e, items: Array<{ id: string; priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }>) =>
    Object.fromEntries(await Promise.all((items ?? []).map(async (i) => [i.id, await svc.effectiveFor(i)] as const))));
  ipcMain.handle('notifications:setRule', (_e, r: { scopeKind: RuleScopeKind; scopeValue: string; level: NotifyLevel; snoozeUntil?: number | null }) => {
    if (!SCOPES.has(r?.scopeKind) || typeof r.scopeValue !== 'string' || !LEVELS.has(r.level)) throw new Error('invalid rule');
    return after(store.setRule({ scopeKind: r.scopeKind, scopeValue: r.scopeValue, level: r.level, snoozeUntil: r.snoozeUntil ?? null }));
  });
  ipcMain.handle('notifications:removeRule', (_e, id: string) => after(store.removeRule(id)));
  ipcMain.handle('notifications:setDefaultLevel', (_e, level: NotifyLevel) => {
    if (!LEVELS.has(level)) throw new Error('invalid level');
    return after(store.setDefaultLevel(level));
  });
  ipcMain.handle('notifications:pause', async (_e, p: { until: number | null; letUrgent: boolean }) => {
    const pause: PauseState = { until: typeof p?.until === 'number' ? p.until : null, letUrgent: p?.letUrgent === true, setAt: Date.now() };
    await store.setPause(pause);
    return after(pause);
  });
  ipcMain.handle('notifications:resume', async () => {
    await store.clearPause();
    return after(null);
  });
  ipcMain.handle('notifications:saveDowntime', (_e, d: Omit<Downtime, 'id'> & { id?: string }) => {
    if (!d || !Array.isArray(d.days) || typeof d.startMin !== 'number' || typeof d.endMin !== 'number') throw new Error('invalid downtime');
    const bypass = d.bypass === 'urgent' || d.bypass === 'urgent+input' ? d.bypass : 'none';
    return after(store.saveDowntime({ ...d, bypass, enabled: d.enabled !== false, name: String(d.name ?? '') }));
  });
  ipcMain.handle('notifications:removeDowntime', (_e, id: string) => after(store.removeDowntime(id)));
  ipcMain.handle('notifications:test', () => svc.test());
  ipcMain.handle('notifications:setViewing', (_e, v: { workspaceId: string | null; inboxOpen: boolean }) => {
    viewing.workspaceId = typeof v?.workspaceId === 'string' ? v.workspaceId : null;
    viewing.inboxOpen = v?.inboxOpen === true;
  });
  ipcMain.handle('notifications:permission', () => ({ supported: Notification.isSupported() }));

  return svc;
}
```

- [ ] **Step 6: Rewrite `startPresence` in `src/main/inbox/presence.ts`**

Replace the whole `startPresence` function with the version below. `update()` is async with a sequence guard, so an older, slower update can't overwrite a newer one. `inbox.counts()` and `approvals()` are awaited. They're still synchronous until Tasks 3 and 5, and `await` on a plain value is fine.

```ts
export function startPresence(
  inbox: InboxStore, notify: NotifyService, approvals: () => number | Promise<number> = () => 0
): { hasTray: () => boolean; stop: () => void } {
  const notifyStore = new NotifyStore(inbox.kysely);
  let tray: Tray | null = null;
  try {
    tray = new Tray(trayImage('tray-none-16', 'tray-none-32'));
    tray.setToolTip(PRODUCT);
    tray.on('click', () => { showWindow(); });
  } catch (e) {
    logError({ source: 'main', type: 'tray-create-failed', level: 'warn', message: String(e) });
    tray = null;
  }
  let lastKey = '';
  let seq = 0;

  const sendOpenInbox = () => {
    const w = showWindow();
    w?.webContents.send('presence:openInbox');
  };
  const fail = (e: unknown) => logError({ source: 'main', type: 'presence-update', level: 'warn', message: String(e) });
  /** Tray menu actions write through the store, re-tick, then refresh everything. */
  const act = (fn: () => Promise<unknown>) => () => { void fn().then(() => notify.tick()).then(emit, fail); };

  const update = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const [counts, waitingApprovals, q] = await Promise.all([inbox.counts(), approvals(), notify.quietState()]);
      if (mine !== seq) return; // a newer update is in flight
      const n = needsYou(counts.urgent, notify.waitingWorkspaces().length, waitingApprovals);
      const quietText = q.pause ? (q.pause.until === null ? 'notifications paused' : `paused until ${new Date(q.pause.until).toTimeString().slice(0, 5)}`) : q.activeDowntime ? `${q.activeDowntime.name} downtime` : null;
      const key = JSON.stringify([n, counts, quietText]);
      if (key === lastKey) return;
      lastKey = key;
      const win = mainWindow();
      if (process.platform === 'win32' && win && !win.isDestroyed()) {
        const asset = overlayAsset(n);
        win.setOverlayIcon(asset ? image(asset) : null, overlayDescription(n));
      }
      if (process.platform === 'darwin' || process.platform === 'linux') {
        app.setBadgeCount(n.count);
        if (process.platform === 'darwin') app.dock?.setBadge(dockBadge(n));
      }
      if (tray) {
        tray.setImage(trayImage(trayAsset(n, 16), trayAsset(n, 32)));
        tray.setToolTip(tooltip(PRODUCT, n, counts, quietText));
        const paused = !!q.pause;
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: tooltip(PRODUCT, n, counts, quietText), enabled: false },
          { type: 'separator' },
          { label: 'Open Automations', click: sendOpenInbox },
          { label: `Open ${PRODUCT}`, click: () => { showWindow(); } },
          { type: 'separator' },
          ...(paused
            ? [{ label: 'Resume notifications', click: act(() => notifyStore.clearPause()) }]
            : [
                { label: 'Pause notifications for 1 hour', click: act(() => notifyStore.setPause({ until: Date.now() + 3_600_000, letUrgent: true, setAt: Date.now() })) },
                { label: 'Pause until tomorrow 08:00', click: act(() => {
                  const d = new Date();
                  const until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0).getTime();
                  return notifyStore.setPause({ until, letUrgent: true, setAt: Date.now() });
                }) }
              ]),
          { type: 'separator' },
          { label: `Quit ${PRODUCT}`, click: () => { markQuitting(); app.quit(); } }
        ]));
      }
    } catch (e) {
      fail(e);
    }
  };
  const runUpdate = () => { void update(); };
  // Tray pause/resume go through the store directly, so tell the renderers too.
  const emit = async (): Promise<void> => {
    const q = await notify.quietState();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('notifications:changed', q);
    }
    await update();
  };

  const attention = () => {
    const w = mainWindow();
    if (!w || w.isDestroyed() || w.isFocused()) return;
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else {
      w.flashFrame(true);
      w.once('focus', () => w.flashFrame(false));
    }
  };

  inboxEvents.on('changed', runUpdate);
  inboxEvents.on('attention', attention);
  const timer = setInterval(runUpdate, 60_000); // pauses/downtimes expire on their own
  timer.unref?.();
  runUpdate();

  return {
    hasTray: () => tray !== null,
    stop: () => {
      clearInterval(timer);
      inboxEvents.off('changed', runUpdate);
      inboxEvents.off('attention', attention);
      tray?.destroy();
      tray = null;
    }
  };
}
```

- [ ] **Step 7: Await store and notification calls in `src/main/inbox/inboxService.ts`**

Make these exact replacements. `store` is still synchronous until Task 5; awaiting it now means this file changes only once.

| Old | New |
|---|---|
| `const { todo, action } = store.post(` (all three: `mcp.post`, `ipc.create`, `host.todoFromAutomation`) | `const { todo, action } = await store.post(` |
| `deps.notifications?.onTodoPosted(todo, action, args.notify === true);` (both) | `await deps.notifications?.onTodoPosted(todo, action, args.notify === true);` |
| `const t = store.get(todoId);` | `const t = await store.get(todoId);` |
| `const n = deps.notifications.request({` | `const n = await deps.notifications.request({` |
| `deps.notifications.request({` (in `notifyFromAutomation`) | `await deps.notifications.request({` |
| `const cur = id ? store.get(id) : null;` | `const cur = id ? await store.get(id) : null;` |
| `const todo = store.update({ kind: 'workspace', id: callerId }, id, toPatch(args), now());` | `const todo = await store.update({ kind: 'workspace', id: callerId }, id, toPatch(args), now());` |
| `const todos = store.list({ ...f,` | `const todos = await store.list({ ...f,` |
| `const todo = store.get(id);` (in `ipc.get`) | `const todo = await store.get(id);` |
| `return todo ? { todo, events: store.events(id) } : null;` | `return todo ? { todo, events: await store.events(id) } : null;` |
| `const todo = store.update({ kind: 'user', id: null }, id, toPatch(patch), now());` | `const todo = await store.update({ kind: 'user', id: null }, id, toPatch(patch), now());` |

In `src/main/inbox/inboxIpc.ts`, the `onPostRejected` handler: replace `notifications?.onPostRejected(workspaceId, reason);` with
```ts
      void notifications?.onPostRejected(workspaceId, reason).catch((e) =>
        logError({ source: 'main', type: 'notify-post-rejected', level: 'warn', message: String(e) }));
```

- [ ] **Step 8: Fix the two `notify:` wirings in `src/main/automations/automationIpc.ts`**

Both occurrences (`createAutomationService` and `createProposalService` deps). Replace
```ts
    notify: notify ? (n) => notify.request(n) : undefined,
```
with
```ts
    notify: notify ? (n) => { void notify.request(n).catch((e) => logError({ source: 'main', type: 'notify-request', level: 'warn', message: String(e) })); } : undefined,
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run src/main/inbox/`
Expected: PASS, including the new tick-serialization test.
Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
git add src/main/inbox src/main/automations/automationIpc.ts
git commit -m "feat(store): NotifyStore + notification service async on Kysely; serialized tick

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ProposalStore` and the proposal service go async

**Files:**
- Modify: `src/main/automations/proposalStore.ts` (full rewrite below)
- Modify: `src/main/automations/proposalService.ts` (full rewrite below)
- Modify: `src/main/automations/automationIpc.ts` (`new ProposalStore`, `automations:discuss`, `proposals:refine`)
- Test: `src/main/automations/proposalService.test.ts` (test-conversion rule, plus a new race test)

**Interfaces:**
- Consumes: `InboxStore.kysely`, `ProposalRow` (Task 1).
- Produces: `ProposalStore` methods return Promises. `ProposalService`: `mcp.*` (already async), `list(): Promise<Proposal[]>`, `pendingCount(): Promise<number>`, `yamlOf(…): Promise<string | null>`, `approve(…): Promise<Proposal>`, `reject(…): Promise<Proposal>`, `revert(…): Promise<Proposal>`. A second concurrent decision on the same proposal rejects with `this proposal is already being decided`.

- [ ] **Step 1: Convert the tests and add the race test**

Apply the *Test-conversion rule* to `src/main/automations/proposalService.test.ts` (`new ProposalStore(inbox.kysely)`; `AutomationStore` stays on `inbox.db` until Task 4). Append:

```ts
describe('decision guard', () => {
  it('two concurrent approvals of one proposal apply it once', async () => {
    const { svc, automations } = setup();
    await svc.mcp.propose('W2', { definition: YAML() });
    const p = (await svc.list())[0];
    const results = await Promise.allSettled([svc.approve(p.id), svc.approve(p.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already being decided|already approved/);
    expect((await automations.list()).filter((a) => a.name === 'log-watch')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/automations/proposalService.test.ts`
Expected: FAIL with `this.db.prepare is not a function` (the store still expects better-sqlite3).

- [ ] **Step 3: Rewrite `src/main/automations/proposalStore.ts`**

```ts
// Proposals repository (#407 Phase 5) over the inbox.db connection. Never
// pruned: proposals and decisions are the audit trail. Async on Kysely.
import { sql, type Kysely } from 'kysely';
import type { Proposal, ProposalItem } from '../../preload/inboxTypes.js';
import { newId } from '../inbox/inboxDb.js';
import type { InboxDb, ProposalRow } from '../store/inboxSchema.js';

function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id, kind: r.kind, proposer: { kind: r.proposer_kind, id: r.proposer_id }, rationale: r.rationale, status: r.status,
    items: JSON.parse(r.items) as ProposalItem[], note: r.note, createdAt: r.created_at, decidedAt: r.decided_at
  };
}

export class ProposalStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  async create(p: Omit<Proposal, 'id' | 'decidedAt' | 'note'>, now = Date.now()): Promise<Proposal> {
    const id = newId(now);
    await this.db.insertInto('proposals').values({
      id, kind: p.kind, proposer_kind: p.proposer.kind, proposer_id: p.proposer.id, rationale: p.rationale, status: p.status,
      items: JSON.stringify(p.items), created_at: now, decided_at: p.status === 'pending' ? null : now
    }).execute();
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Proposal | null> {
    const r = await this.db.selectFrom('proposals').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toProposal(r) : null;
  }

  async list(limit = 100): Promise<Proposal[]> {
    const rows = await this.db.selectFrom('proposals').selectAll()
      .orderBy(sql`CASE status WHEN 'pending' THEN 0 ELSE 1 END`).orderBy('created_at', 'desc').limit(limit).execute();
    return rows.map(toProposal);
  }

  async pending(): Promise<Proposal[]> {
    const rows = await this.db.selectFrom('proposals').selectAll().where('status', '=', 'pending').orderBy('created_at').execute();
    return rows.map(toProposal);
  }

  async save(p: Proposal): Promise<void> {
    await this.db.updateTable('proposals')
      .set({ status: p.status, items: JSON.stringify(p.items), note: p.note, decided_at: p.decidedAt })
      .where('id', '=', p.id).execute();
  }
}
```

- [ ] **Step 4: Rewrite `src/main/automations/proposalService.ts`**

`deps.automations.*` calls are awaited now. `AutomationStore` is still sync until Task 4, and awaiting a plain value is fine. The `deciding` set is claimed synchronously at the top of `approve`/`reject`/`revert`.

```ts
// Proposals (#407 Phase 5): workspaces propose new automations or changes;
// the user approves. Trusted workspaces auto-apply only low-risk items (see
// classify.ts); every auto-applied item stays visible with Revert. Pure.
// Async on the store layer; one decision per proposal at a time (`deciding`).
import type { AutomationDef, Proposal, ProposalItem, ProposalStatus, TodoSource } from '../../preload/inboxTypes.js';
import type { NotifyInput } from '../inbox/notifyService.js';
import type { AutomationStore } from './automationStore.js';
import type { ProposalStore } from './proposalStore.js';
import { classifyChange, riskFlags } from './classify.js';
import { definitionToYaml, parseDefinitionText, validateDefinition } from './definition.js';

export interface ProposalDeps {
  /** Shells this computer offers for host steps (#407); validation checks `shell` against them. */
  hostShells?(): string[] | undefined;
  proposals: ProposalStore;
  automations: AutomationStore;
  now(): number;
  resolveWorkspace(idOrName: string): string | null;
  workspaceName(id: string): string;
  /** Trusted for low-risk edits: manifest inbox.trusted, container workspaces only. */
  trusted(workspaceId: string): Promise<boolean>;
  notify?: (n: NotifyInput) => unknown;
  changed(): void;
}

const MAX_BATCH = 20;

function statusOf(items: ProposalItem[]): ProposalStatus {
  if (items.some((i) => i.decision === 'pending')) return 'pending';
  if (items.every((i) => i.decision === 'declined')) return 'rejected';
  if (items.every((i) => i.decision === 'auto-applied' || i.decision === 'reverted')) return 'auto-approved';
  if (items.every((i) => i.decision === 'accepted' || i.decision === 'auto-applied' || i.decision === 'reverted')) return 'approved';
  return 'partial';
}

export function createProposalService(deps: ProposalDeps) {
  const ctx = { workspace: (v: string) => deps.resolveWorkspace(v), get hostShells() { return deps.hostShells?.(); } };
  /** Proposal ids with a decision in progress (approve/reject/revert). Claimed before the first await. */
  const deciding = new Set<string>();

  async function decide<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (deciding.has(id)) throw new Error('this proposal is already being decided');
    deciding.add(id);
    try {
      return await fn();
    } finally {
      deciding.delete(id);
    }
  }

  function parseDef(raw: unknown, where: string): AutomationDef {
    const parsed = typeof raw === 'string' ? parseDefinitionText(raw) : { ok: true as const, value: raw };
    if (!parsed.ok) throw new Error(`${where}: ${parsed.errors.join('; ')}`);
    const v = validateDefinition(parsed.value, ctx);
    if (!v.ok) throw new Error(`${where}: ${v.errors.join('; ')}`);
    return v.value;
  }

  function item(before: { id: string; version: number; definition: AutomationDef } | null, after: AutomationDef): ProposalItem {
    const c = classifyChange(before?.definition ?? null, after, deps.workspaceName);
    return {
      automationId: before?.id ?? null, name: after.name, baseVersion: before?.version ?? null,
      before: before?.definition ?? null, after, lowRisk: c.lowRisk, reasons: c.reasons,
      flags: riskFlags(after, deps.workspaceName), decision: 'pending'
    };
  }

  async function apply(it: ProposalItem, by: TodoSource): Promise<void> {
    const now = deps.now();
    if (!it.automationId) {
      const a = await deps.automations.create(it.after, by, now);
      it.automationId = a.id;
      return;
    }
    const cur = await deps.automations.get(it.automationId);
    if (!cur) throw new Error(`${it.name} no longer exists`);
    if (cur.version !== it.baseVersion) throw new Error(`${it.name} changed since this was proposed (now v${cur.version}); ask for a fresh proposal`);
    await deps.automations.update(cur.id, it.after, by, now);
  }

  /** Mark older pending proposals from the same workspace for the same automations as superseded. */
  async function supersede(proposer: string, names: Set<string>): Promise<void> {
    for (const p of await deps.proposals.pending()) {
      if (p.proposer.id !== proposer) continue;
      if (!p.items.some((i) => names.has(i.name) || (i.automationId && names.has(i.automationId)))) continue;
      p.status = 'superseded';
      p.decidedAt = deps.now();
      await deps.proposals.save(p);
    }
  }

  async function record(callerId: string, kind: Proposal['kind'], items: ProposalItem[], rationale: unknown): Promise<Proposal> {
    const by: TodoSource = { kind: 'workspace', id: callerId };
    await supersede(callerId, new Set(items.flatMap((i) => [i.name, ...(i.automationId ? [i.automationId] : [])])));
    const trusted = await deps.trusted(callerId);
    const auto: string[] = [];
    if (trusted) {
      for (const it of items) {
        if (!it.lowRisk || !it.automationId) continue;
        try {
          await apply(it, by);
          it.decision = 'auto-applied';
          auto.push(it.name);
        } catch {
          // leave it pending for the user
        }
      }
    }
    const p = await deps.proposals.create({
      kind, proposer: by, rationale: typeof rationale === 'string' && rationale.trim() ? rationale.trim().slice(0, 2000) : null,
      status: statusOf(items), items, createdAt: deps.now()
    }, deps.now());
    const who = deps.workspaceName(callerId);
    const waiting = items.filter((i) => i.decision === 'pending');
    if (waiting.length) {
      deps.notify?.({
        kind: 'proposal', title: kind === 'new' ? `${who} proposes a new automation: ${items[0].name}` : `${who} proposes ${waiting.length === 1 ? `a change to ${waiting[0].name}` : `${waiting.length} automation changes`}`,
        body: waiting.flatMap((i) => i.reasons).slice(0, 3).join(' · ') || null, priority: 'normal',
        source: by, workspaceId: callerId, dedupeKey: `proposal:${p.id}`
      });
    } else if (auto.length) {
      deps.notify?.({ kind: 'proposal', title: `Auto-applied from ${who}: ${auto.join(', ')}`, body: 'Low-risk edits from a trusted workspace. Revert from Activity.', priority: 'low', source: by, workspaceId: callerId });
    }
    deps.changed();
    return p;
  }

  function summary(p: Proposal) {
    return {
      id: p.id, status: p.status, note: p.note,
      items: p.items.map((i) => ({ name: i.name, automationId: i.automationId, decision: i.decision, lowRisk: i.lowRisk, reasons: i.reasons }))
    };
  }

  return {
    mcp: {
      async propose(callerId: string, args: Record<string, unknown>) {
        const def = parseDef(args.definition, 'definition');
        if (await deps.automations.byName(def.name)) throw new Error(`an automation named "${def.name}" already exists; propose a change to it instead`);
        return summary(await record(callerId, 'new', [item(null, def)], args.rationale));
      },
      async proposeChange(callerId: string, args: Record<string, unknown>) {
        const raw = Array.isArray(args.batch) ? (args.batch as Array<Record<string, unknown>>) : [{ id: args.id, definition: args.definition }];
        if (raw.length === 0 || raw.length > MAX_BATCH) throw new Error(`a change proposal needs 1–${MAX_BATCH} items`);
        const items: ProposalItem[] = [];
        for (const [i, r] of raw.entries()) {
          const where = raw.length > 1 ? `batch[${i}]` : 'definition';
          const key = typeof r.id === 'string' ? r.id : '';
          const cur = (await deps.automations.get(key)) ?? (await deps.automations.byName(key));
          if (!cur) throw new Error(`${where}: automation ${key || '(missing id)'} not found`);
          items.push(item({ id: cur.id, version: cur.version, definition: cur.definition }, parseDef(r.definition, where)));
        }
        return summary(await record(callerId, raw.length > 1 ? 'batch' : 'change', items, args.rationale));
      },
      async get(callerId: string, args: Record<string, unknown>) {
        const p = typeof args.id === 'string' ? await deps.proposals.get(args.id) : null;
        if (!p || p.proposer.id !== callerId) throw new Error('proposal not found');
        return summary(p);
      }
    },

    list(): Promise<Proposal[]> {
      return deps.proposals.list();
    },
    async pendingCount(): Promise<number> {
      return (await deps.proposals.pending()).reduce((n, p) => n + p.items.filter((i) => i.decision === 'pending').length, 0);
    },
    async yamlOf(id: string, index: number): Promise<string | null> {
      const it = (await deps.proposals.get(id))?.items[index];
      return it ? definitionToYaml(it.after) : null;
    },

    /** Approve pending items (all, or the listed indexes; the rest are declined). editedYaml replaces a single item's definition first. */
    approve(id: string, opts: { accept?: number[]; editedYaml?: string; editedIndex?: number } = {}): Promise<Proposal> {
      return decide(id, async () => {
        const p = await deps.proposals.get(id);
        if (!p) throw new Error('proposal not found');
        if (p.status !== 'pending') throw new Error(`this proposal is already ${p.status}`);
        if (opts.editedYaml !== undefined) {
          const idx = opts.editedIndex ?? 0;
          const it = p.items[idx];
          if (!it) throw new Error('no such item');
          it.after = parseDef(opts.editedYaml, 'edited definition');
          it.name = it.after.name;
          it.flags = riskFlags(it.after, deps.workspaceName);
        }
        const accept = new Set(opts.accept ?? p.items.map((_, i) => i));
        const by = p.proposer;
        const errors: string[] = [];
        for (const [i, it] of p.items.entries()) {
          if (it.decision !== 'pending') continue;
          if (!accept.has(i)) { it.decision = 'declined'; continue; }
          try {
            await apply(it, by);
            it.decision = 'accepted';
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
        if (errors.length) {
          await deps.proposals.save(p);
          deps.changed();
          throw new Error(errors.join('\n'));
        }
        p.status = statusOf(p.items);
        p.decidedAt = deps.now();
        await deps.proposals.save(p);
        deps.changed();
        return p;
      });
    },

    reject(id: string, note: string | null): Promise<Proposal> {
      return decide(id, async () => {
        const p = await deps.proposals.get(id);
        if (!p) throw new Error('proposal not found');
        if (p.status !== 'pending') throw new Error(`this proposal is already ${p.status}`);
        for (const it of p.items) if (it.decision === 'pending') it.decision = 'declined';
        p.status = statusOf(p.items);
        p.note = note?.trim() ? note.trim().slice(0, 2000) : null;
        p.decidedAt = deps.now();
        await deps.proposals.save(p);
        deps.changed();
        return p;
      });
    },

    /** Restore the definition an applied change replaced (as a new version, by the user). */
    revert(id: string, index: number): Promise<Proposal> {
      return decide(id, async () => {
        const p = await deps.proposals.get(id);
        const it = p?.items[index];
        if (!p || !it) throw new Error('no such item');
        if ((it.decision !== 'auto-applied' && it.decision !== 'accepted') || !it.before || !it.automationId) throw new Error('only an applied change can be reverted');
        const cur = await deps.automations.get(it.automationId);
        if (!cur) throw new Error(`${it.name} no longer exists`);
        await deps.automations.update(cur.id, it.before, { kind: 'user', id: null }, deps.now());
        it.decision = 'reverted';
        await deps.proposals.save(p);
        deps.changed();
        return p;
      });
    }
  };
}

export type ProposalService = ReturnType<typeof createProposalService>;
```

- [ ] **Step 5: Wire it in `src/main/automations/automationIpc.ts`**

- Replace `proposals: new ProposalStore(inbox.db),` with `proposals: new ProposalStore(inbox.kysely),`.
- In `automations:discuss`, replace `const p = proposals.list().find((x) => x.id === proposalId);` with `const p = (await proposals.list()).find((x) => x.id === proposalId);`.
- Replace the `proposals:refine` handler with:

```ts
  ipcMain.handle('proposals:refine', async (_e, id: string, index: number, text: string) => {
    const d = need(text, 'the changes');
    const p = (await proposals.list()).find((x) => x.id === id);
    const it = p?.items[index ?? 0];
    if (!p || !it) throw new Error('proposal not found');
    if (p.status !== 'pending') throw new Error(`this proposal is already ${p.status}`);
    return toRole((ctx) => refinePrompt(definitionToYaml(it.after), d, !it.automationId, ctx));
  });
```

`withNames(() => proposals.list())` and `withNames(() => proposals.approve(…))` already return the promise. Task 4 widens `withNames`' signature. `index.ts`'s `() => auto?.proposals.pendingCount() ?? 0` now returns `Promise<number> | 0`, which matches `startPresence`'s `() => number | Promise<number>` from Task 2, so leave it unchanged.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/main/automations/proposalService.test.ts`
Expected: PASS, including the decision-guard test.
Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/automations/proposalStore.ts src/main/automations/proposalService.ts src/main/automations/proposalService.test.ts src/main/automations/automationIpc.ts
git commit -m "feat(store): ProposalStore + proposal service async on Kysely; per-proposal decision guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `AutomationStore` and the automation engine go async

**Files:**
- Modify: `src/main/automations/automationStore.ts` (full rewrite below)
- Modify: `src/main/automations/automationService.ts` (full rewrite below)
- Modify: `src/main/automations/runner.ts` (awaits, listed below)
- Modify: `src/main/automations/loadoutInstaller.ts` (`createLoadoutInstaller` rewrite below)
- Modify: `src/main/automations/proposalService.ts` (`apply` passes `expectedVersion`)
- Modify: `src/main/automations/automationIpc.ts` (store handle, `withNames`, hooks, recover/tick/events, `toRole`, `askChange`)
- Test: `automationStore.test.ts`, `automationService.test.ts`, `runner.test.ts`, `loadoutInstaller.test.ts`, `proposalService.test.ts` (`new AutomationStore(inbox.kysely)`) in `src/main/automations/`. Apply the test-conversion rule and add the new tests below.

**Interfaces:**
- Consumes: `InboxStore.kysely`, `AutomationRow`, `RunRowSql`, `StepRunRowSql`, `num` (Task 1).
- Produces: every `AutomationStore` method returns a Promise of its old type. `startStep` resolves to the step id (`number`). New `update(id, def, by, now?, expectedVersion?: number)` rejects with `automation <id> changed (now v<n>)` when the stored version differs. `AutomationService`: `list`, `get`, `create`, `update`, `setEnabled`, `remove`, `run`, `tick`, `onEvent`, `recover`, and `mcp.*` all return Promises. `attribution`, `cancelPending`, `validate` and `settle` keep their signatures. `RunnerDeps.requestNext?(…): unknown | Promise<unknown>`. `LoadoutInstaller.preview/install/uninstall` return Promises.

- [ ] **Step 1: Convert the tests and add the regression tests**

Apply the *Test-conversion rule* to the five test files above (the `fire` helper in `automationService.test.ts` becomes async with `await flush()`). Then append to `automationService.test.ts`:

```ts
describe('concurrent starts (async store)', () => {
  it('two concurrent manual runs: one runs, one is skipped', async () => {
    let release!: () => void;
    const { svc } = setup({ postGate: new Promise<void>((r) => { release = r; }) });
    const a = await svc.create(YAML(), USER);
    const [r1, r2] = await Promise.all([svc.run(a.id, { kind: 'manual', by: USER }), svc.run(a.id, { kind: 'manual', by: USER })]);
    expect([r1.status, r2.status].sort()).toEqual(['running', 'skipped']);
    release();
    await svc.settle();
  });
  it('three concurrent runs with concurrency: queue → one running, one queued, one skipped; the queued one runs after', async () => {
    let release!: () => void;
    const { svc } = setup({ postGate: new Promise<void>((r) => { release = r; }) });
    const q = await svc.create(YAML() + 'concurrency: queue\n', USER);
    const rs = await Promise.all([0, 1, 2].map(() => svc.run(q.id, { kind: 'manual', by: USER })));
    expect(rs.map((r) => r.status).sort()).toEqual(['queued', 'running', 'skipped']);
    release();
    await svc.settle();
    expect((await svc.get(q.id))?.runs.map((r) => r.status).sort()).toEqual(['skipped', 'succeeded', 'succeeded']);
  });
});
```

Append to `automationStore.test.ts` (inside the file's top-level scope; reuse its `inbox`/`USER`/definition fixtures, or the `def` literal below if none exists):

```ts
describe('optimistic version check', () => {
  it('update with a stale expectedVersion rejects and writes nothing', async () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.kysely);
    const def = { name: 'a', triggers: [{ manual: {} }], steps: [{ id: 's', prompt: { workspace: 'W1', mode: 'live', message: 'hi' } }] } as never;
    const a = await s.create(def, { kind: 'user', id: null }, 1);
    await s.update(a.id, def, { kind: 'user', id: null }, 2, 1);
    await expect(s.update(a.id, def, { kind: 'user', id: null }, 3, 1)).rejects.toThrow(/changed \(now v2\)/);
    expect((await s.get(a.id))?.version).toBe(2);
  });
});
```

Run before implementing: `npx vitest run src/main/automations/automationService.test.ts -t "concurrent starts"`.
Expected: on the current sync code it PASSES once `await` is added: these tests pin today's atomic behaviour. They must still pass after Step 3. A naive async port without claims fails the first one with `['running', 'running']`.

- [ ] **Step 2: Run the converted suite to verify it fails**

Run: `npx vitest run src/main/automations/`
Expected: FAIL with `this.db.prepare is not a function` (the tests now hand `inbox.kysely` to the sync store).

- [ ] **Step 3: Rewrite `src/main/automations/automationStore.ts`**

```ts
// Automations repository (#407 Phase 3) over the inbox.db connection:
// definitions + version history, tags, per-automation state, runs, step runs.
// Async on Kysely; multi-statement writes are transactions (use trx inside).
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  AutomationDef, ParamValue, RunRow, RunStatus, StepRunRow, TodoSource
} from '../../preload/inboxTypes.js';
import { newId } from '../inbox/inboxDb.js';
import { normalizeTags } from '../inbox/inboxCore.js';
import { num } from '../store/kysely.js';
import type { AutomationRow, InboxDb, RunRowSql } from '../store/inboxSchema.js';

type Q = Kysely<InboxDb> | Transaction<InboxDb>;

export interface AutomationRecord {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  definition: AutomationDef;
  createdBy: TodoSource;
  origin: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  lastScheduledAt: number | null;
  /** A next fire chosen by a run (#437); replaces the cron until it fires. */
  nextRunAt: number | null;
  /** The run that chose it. */
  nextRunBy: string | null;
}

function toRecord(r: AutomationRow): AutomationRecord {
  return {
    id: r.id, name: r.name, enabled: r.enabled === 1, version: r.version, definition: JSON.parse(r.definition) as AutomationDef,
    createdBy: { kind: r.created_by_kind, id: r.created_by_id }, origin: r.origin ? (JSON.parse(r.origin) as Record<string, unknown>) : null,
    createdAt: r.created_at, updatedAt: r.updated_at, lastScheduledAt: r.last_scheduled_at,
    nextRunAt: r.next_run_at, nextRunBy: r.next_run_by
  };
}

export class AutomationStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  // --- definitions ---------------------------------------------------------

  async list(): Promise<AutomationRecord[]> {
    return (await this.db.selectFrom('automations').selectAll().orderBy('name').execute()).map(toRecord);
  }

  private async getWith(q: Q, id: string): Promise<AutomationRecord | null> {
    const r = await q.selectFrom('automations').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRecord(r) : null;
  }
  get(id: string): Promise<AutomationRecord | null> {
    return this.getWith(this.db, id);
  }

  private async byNameWith(q: Q, name: string): Promise<AutomationRecord | null> {
    const r = await q.selectFrom('automations').selectAll().where('name', '=', name).executeTakeFirst();
    return r ? toRecord(r) : null;
  }
  byName(name: string): Promise<AutomationRecord | null> {
    return this.byNameWith(this.db, name);
  }

  create(def: AutomationDef, by: TodoSource, now = Date.now(), enabled = true, origin: Record<string, unknown> | null = null): Promise<AutomationRecord> {
    const id = newId(now);
    return this.db.transaction().execute(async (trx) => {
      if (await this.byNameWith(trx, def.name)) throw new Error(`an automation named "${def.name}" already exists`);
      await trx.insertInto('automations').values({
        id, name: def.name, enabled: enabled ? 1 : 0, version: 1, definition: JSON.stringify(def), created_by_kind: by.kind,
        created_by_id: by.id, origin: origin ? JSON.stringify(origin) : null, created_at: now, updated_at: now, last_scheduled_at: now
      }).execute();
      await trx.insertInto('automation_versions').values({
        automation_id: id, version: 1, definition: JSON.stringify(def), created_at: now, created_by_kind: by.kind, created_by_id: by.id
      }).execute();
      await this.setTags(trx, id, def.tags ?? []);
      return (await this.getWith(trx, id))!;
    });
  }

  /** A new version of the definition. Renames are allowed when the new name is free.
   *  expectedVersion: reject if the stored version moved (proposal apply / revert). */
  update(id: string, def: AutomationDef, by: TodoSource, now = Date.now(), expectedVersion?: number): Promise<AutomationRecord> {
    return this.db.transaction().execute(async (trx) => {
      const cur = await this.getWith(trx, id);
      if (!cur) throw new Error(`automation ${id} not found`);
      if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new Error(`automation ${id} changed (now v${cur.version})`);
      const clash = await this.byNameWith(trx, def.name);
      if (clash && clash.id !== id) throw new Error(`an automation named "${def.name}" already exists`);
      const version = cur.version + 1;
      // A new version drops any next fire a run of the old one chose (#437).
      await trx.updateTable('automations')
        .set({ name: def.name, version, definition: JSON.stringify(def), updated_at: now, next_run_at: null, next_run_by: null })
        .where('id', '=', id).execute();
      await trx.insertInto('automation_versions').values({
        automation_id: id, version, definition: JSON.stringify(def), created_at: now, created_by_kind: by.kind, created_by_id: by.id
      }).execute();
      await this.setTags(trx, id, def.tags ?? []);
      return (await this.getWith(trx, id))!;
    });
  }

  async setEnabled(id: string, enabled: boolean, now = Date.now()): Promise<void> {
    // Re-enabling restarts the schedule clock so a long-disabled automation doesn't fire a stale catch-up.
    // Either way a run-chosen next fire (#437) is dropped.
    await this.db.updateTable('automations')
      .set((eb) => ({
        enabled: enabled ? 1 : 0, updated_at: now, next_run_at: null, next_run_by: null,
        last_scheduled_at: enabled ? now : eb.ref('last_scheduled_at')
      }))
      .where('id', '=', id).execute();
  }

  /** Loadout provenance (#407 Phase 8). */
  async setOrigin(id: string, origin: Record<string, unknown> | null): Promise<void> {
    await this.db.updateTable('automations').set({ origin: origin ? JSON.stringify(origin) : null }).where('id', '=', id).execute();
  }

  async setLastScheduled(id: string, ts: number): Promise<void> {
    await this.db.updateTable('automations').set({ last_scheduled_at: ts }).where('id', '=', id).execute();
  }

  /** A run-chosen next fire (#437); null clears it. */
  async setNextRun(id: string, at: number | null, byRun: string | null = null): Promise<void> {
    await this.db.updateTable('automations').set({ next_run_at: at, next_run_by: at === null ? null : byRun }).where('id', '=', id).execute();
  }

  /** Script state (#407 Phase 7): the last `{"state": …}` a script printed. */
  async getState(id: string): Promise<unknown> {
    const row = await this.db.selectFrom('automation_state').select('state').where('automation_id', '=', id).executeTakeFirst();
    if (!row) return null;
    try { return JSON.parse(row.state); } catch { return null; }
  }

  async setState(id: string, state: unknown): Promise<void> {
    await this.db.insertInto('automation_state').values({ automation_id: id, state: JSON.stringify(state ?? null) })
      .onConflict((oc) => oc.column('automation_id').doUpdateSet({ state: (eb) => eb.ref('excluded.state') })).execute();
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('automations').where('id', '=', id).execute();
      await trx.deleteFrom('tags').where('entity_kind', '=', 'automation').where('entity_id', '=', id).execute();
      await trx.deleteFrom('automation_state').where('automation_id', '=', id).execute();
      // versions + runs are kept: run history outlives the automation (spec §7, uninstall keeps history).
    });
  }

  async versions(id: string): Promise<Array<{ version: number; definition: AutomationDef; createdAt: number; createdBy: TodoSource }>> {
    const rows = await this.db.selectFrom('automation_versions').selectAll().where('automation_id', '=', id).orderBy('version', 'desc').execute();
    return rows.map((v) => ({ version: v.version, definition: JSON.parse(v.definition) as AutomationDef, createdAt: v.created_at, createdBy: { kind: v.created_by_kind, id: v.created_by_id } }));
  }

  async tags(id: string): Promise<string[]> {
    const rows = await this.db.selectFrom('tags').select('tag').where('entity_kind', '=', 'automation').where('entity_id', '=', id).orderBy('tag').execute();
    return rows.map((r) => r.tag);
  }

  private async setTags(q: Q, id: string, raw: string[]): Promise<void> {
    await q.deleteFrom('tags').where('entity_kind', '=', 'automation').where('entity_id', '=', id).execute();
    for (const t of normalizeTags(raw)) {
      await q.insertInto('tags').values({ entity_kind: 'automation', entity_id: id, tag: t }).onConflict((oc) => oc.doNothing()).execute();
    }
  }

  // --- runs ----------------------------------------------------------------

  private async toRun(q: Q, r: RunRowSql): Promise<RunRow> {
    return {
      id: r.id, automationId: r.automation_id, version: r.version,
      trigger: JSON.parse(r.trigger) as RunRow['trigger'], args: JSON.parse(r.args) as Record<string, ParamValue>,
      status: r.status, startedAt: r.started_at, endedAt: r.ended_at, error: r.error, steps: await this.stepsWith(q, r.id),
      ...(r.reschedule ? { reschedule: JSON.parse(r.reschedule) as NonNullable<RunRow['reschedule']> } : {})
    };
  }

  private async stepsWith(q: Q, runId: string): Promise<StepRunRow[]> {
    const rows = await q.selectFrom('step_runs').selectAll().where('run_id', '=', runId).orderBy('id').execute();
    return rows.map((s) => ({
      id: s.id, runId: s.run_id, stepId: s.step_id, kind: s.kind, status: s.status, workspaceId: s.workspace_id,
      brokerSessionId: s.broker_session_id, startedAt: s.started_at, endedAt: s.ended_at, error: s.error,
      detail: s.detail ? (JSON.parse(s.detail) as Record<string, unknown>) : null
    }));
  }
  steps(runId: string): Promise<StepRunRow[]> {
    return this.stepsWith(this.db, runId);
  }

  async startRun(a: AutomationRecord, trigger: RunRow['trigger'], args: Record<string, ParamValue>, status: RunStatus, now = Date.now(), error: string | null = null): Promise<RunRow> {
    const id = newId(now);
    await this.db.insertInto('runs').values({
      id, automation_id: a.id, version: a.version, trigger: JSON.stringify(trigger), args: JSON.stringify(args), status,
      started_at: now, ended_at: status === 'running' || status === 'queued' ? null : now, error
    }).execute();
    return (await this.getRun(id))!;
  }

  async setRunStatus(id: string, status: RunStatus, now = Date.now(), error: string | null = null): Promise<void> {
    const ended = status === 'running' || status === 'queued' ? null : now;
    await this.db.updateTable('runs').set({ status, ended_at: ended, error }).where('id', '=', id).execute();
  }

  /** What a run asked for as its next fire and what it was given (#437). */
  async setRunReschedule(id: string, r: NonNullable<RunRow['reschedule']>): Promise<void> {
    await this.db.updateTable('runs').set({ reschedule: JSON.stringify(r) }).where('id', '=', id).execute();
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = await this.db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toRun(this.db, r) : null;
  }

  async runs(automationId: string, limit = 50): Promise<RunRow[]> {
    const rows = await this.db.selectFrom('runs').selectAll().where('automation_id', '=', automationId)
      .orderBy('started_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return Promise.all(rows.map((r) => this.toRun(this.db, r)));
  }

  private async runsWith(q: Q, status: RunStatus): Promise<RunRow[]> {
    const rows = await q.selectFrom('runs').selectAll().where('status', '=', status).orderBy('started_at').orderBy('id').execute();
    const out: RunRow[] = [];
    for (const r of rows) out.push(await this.toRun(q, r));
    return out;
  }
  runsWithStatus(status: RunStatus): Promise<RunRow[]> {
    return this.runsWith(this.db, status);
  }

  async weekStats(automationId: string, now = Date.now()): Promise<{ runs: number; nothingToDo: number; failed: number }> {
    const r = await this.db.selectFrom('runs')
      .select([
        (eb) => eb.fn.countAll().as('runs'),
        sql<number | null>`SUM(CASE WHEN status = 'nothing-to-do' THEN 1 ELSE 0 END)`.as('ntd'),
        sql<number | null>`SUM(CASE WHEN status IN ('failed','timed-out','interrupted') THEN 1 ELSE 0 END)`.as('failed')
      ])
      .where('automation_id', '=', automationId).where('started_at', '>=', now - 7 * 86_400_000)
      .where('status', 'not in', ['skipped', 'queued'])
      .executeTakeFirstOrThrow();
    return { runs: num(r.runs), nothingToDo: num(r.ntd), failed: num(r.failed) };
  }

  async startStep(runId: string, stepId: string, kind: 'prompt' | 'script', workspaceId: string | null, now = Date.now()): Promise<number> {
    const r = await this.db.insertInto('step_runs')
      .values({ run_id: runId, step_id: stepId, kind, status: 'running', workspace_id: workspaceId, started_at: now })
      .returning('id').executeTakeFirstOrThrow();
    return r.id;
  }

  async finishStep(id: number, status: RunStatus, patch: { error?: string | null; brokerSessionId?: string | null; detail?: Record<string, unknown> } = {}, now = Date.now()): Promise<void> {
    const detail = patch.detail ? JSON.stringify(patch.detail) : null;
    await this.db.updateTable('step_runs').set({
      status, ended_at: now, error: patch.error ?? null,
      broker_session_id: sql<string | null>`coalesce(${patch.brokerSessionId ?? null}, broker_session_id)`,
      detail: sql<string | null>`coalesce(${detail}, detail)`
    }).where('id', '=', id).execute();
  }

  /** Startup: anything still `running` was cut off by a quit/crash. */
  markInterrupted(now = Date.now()): Promise<RunRow[]> {
    return this.db.transaction().execute(async (trx) => {
      const cut = await this.runsWith(trx, 'running');
      await trx.updateTable('runs').set({ status: 'interrupted', ended_at: now, error: 'the app quit mid-run' }).where('status', '=', 'running').execute();
      await trx.updateTable('step_runs').set({ status: 'interrupted', ended_at: now }).where('status', '=', 'running').execute();
      await trx.updateTable('runs').set({ status: 'cancelled', ended_at: now, error: 'the app quit before it started' }).where('status', '=', 'queued').execute();
      return cut;
    });
  }

  pruneRuns(olderThan: number): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('step_runs')
        .where('run_id', 'in', trx.selectFrom('runs').select('id').where('started_at', '<', olderThan)).execute();
      const r = await trx.deleteFrom('runs').where('started_at', '<', olderThan).executeTakeFirst();
      return Number(r.numDeletedRows);
    });
  }
}
```

(`markInterrupted` now reads the cut runs inside the transaction instead of before it. The result is the same and the read and the update are now atomic.)

- [ ] **Step 4: Rewrite `src/main/automations/automationService.ts`**

Today's concurrency guarantees came from synchronous code. They're kept with two in-memory claims, both taken before any `await`:
- `claimed`: automation ids with a run starting, running, or finishing. Taken in `start()` before `startRun`, released at the end of `execute()`, or handed on to a promoted queued run.
- `queued`: the one pending queued run per automation, held as its insert promise, so the finishing run promotes it without a racing DB scan. `markInterrupted` cancels leftover queued rows at startup, so in-memory is authoritative.

```ts
// Automations service (#407 Phase 3): CRUD from YAML, run orchestration
// (concurrency, rate cap, queueing), the scheduler tick, failure notifications,
// restart recovery, the active-run registry used for todo attribution, and the
// MCP handlers. Pure: Electron/backends are injected (automationIpc.ts).
// Async on the store layer. Concurrency decisions read and write the in-memory
// claims (`claimed`, `queued`) synchronously after the last await, so two
// concurrent starts can't both run (the guarantee the sync store gave for free).
import type { Automation, AutomationDef, EventName, ParamValue, RunRow, RunTriggerKind, TodoSource } from '../../preload/inboxTypes.js';
import type { NotifyInput } from '../inbox/notifyService.js';
import { AutomationStore, type AutomationRecord } from './automationStore.js';
import { definitionToYaml, parseDefinitionText, parseDuration, stepWorkspaces, validateArgs, validateDefinition, type Validation } from './definition.js';
import { executeRun, type RunnerDeps, type RunOutcome } from './runner.js';
import { dueSchedule, nextFireAt } from './scheduler.js';
import { describeCron } from './cron.js';
import { applyFloor, parseNextRequest } from './reschedule.js';

export interface AutomationDeps extends Omit<RunnerDeps, 'store'> {
  /** Shells this computer offers for host steps (#407); validation checks `shell` against them. */
  hostShells?(): string[] | undefined;
  store: AutomationStore;
  /** Resolve a workspace id or name to an id. */
  resolveWorkspace(idOrName: string): string | null;
  notify?: (n: NotifyInput) => unknown;
  changed(): void;
  /** Injected for tests; default setTimeout/clearTimeout (event debounce). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** A timer-started run failed to record (automationIpc logs it). */
  onError?(e: unknown): void;
}

export interface FleetEvent {
  on: EventName;
  workspaceId?: string;
  todo?: { id: string; title: string; tags: string[]; source: TodoSource };
}

const DEFAULT_DEBOUNCE_MS = 120_000;
/** After a run ends, ignore events from the workspaces it prompted for this long (loop guard). */
const SELF_GUARD_MS = 120_000;

const RATE_MS = 60_000;
const RUN_RETENTION_MS = 90 * 86_400_000;

export interface RunRequest {
  kind: RunTriggerKind;
  by?: TodoSource;
  cron?: string;
  args?: Record<string, unknown>;
  /** Args came from a workspace (MCP), so prompts quote them as data. */
  callerSupplied?: boolean;
  /** Coerce string args (the Run-now form). */
  coerce?: boolean;
  event?: RunRow['trigger']['event'];
}

export function createAutomationService(deps: AutomationDeps) {
  const { store } = deps;
  /** runId → automation + the workspaces its steps target (attribution). */
  const active = new Map<string, { automationId: string; workspaces: Set<string>; next?: { at: number; by: string } }>();
  /** Automation ids with a run starting, running or finishing. */
  const claimed = new Set<string>();
  /** Automation id → its one queued run (the insert's promise). */
  const queued = new Map<string, Promise<RunRow>>();
  const lastStart = new Map<string, number>();
  const inFlight = new Set<Promise<unknown>>();
  const lastEnded = new Map<string, number>();
  const pending = new Map<string, { timer: unknown; event: NonNullable<RunRow['trigger']['event']> }>();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const ctx = { workspace: (v: string) => deps.resolveWorkspace(v), get hostShells() { return deps.hostShells?.(); } };

  function track(p: Promise<unknown>): void {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  async function view(a: AutomationRecord): Promise<Automation> {
    const now = deps.now();
    const [tags, lastRuns, weekStats] = await Promise.all([store.tags(a.id), store.runs(a.id, 1), store.weekStats(a.id, now)]);
    return {
      id: a.id, name: a.name, description: a.definition.description ?? null, enabled: a.enabled, version: a.version,
      definition: a.definition, tags, createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt,
      lastScheduledAt: a.lastScheduledAt, nextFireAt: nextFireAt(a, now), lastRun: lastRuns[0] ?? null,
      nextSetByRun: a.enabled && a.nextRunAt !== null ? a.nextRunBy : null,
      weekStats,
      origin: a.origin && typeof a.origin.loadoutId === 'string'
        ? { loadoutId: a.origin.loadoutId, version: typeof a.origin.version === 'string' ? a.origin.version : null, workspaceId: String(a.origin.workspaceId ?? ''), edited: a.version > Number(a.origin.installedVersion ?? a.version) }
        : null,
      triggerSummaries: a.definition.triggers.map((t) => {
        if ('schedule' in t) return `${describeCron(t.schedule.cron)}${t.schedule.tz ? ` (${t.schedule.tz})` : ''}`;
        if ('manual' in t) {
          return t.manual.allowFrom?.length ? `by hand · also ${t.manual.allowFrom.map((w) => deps.workspaceName(w)).join(', ')}` : 'by hand';
        }
        const e = t.event;
        const ws = e.workspace ? deps.workspaceName(e.workspace) : null;
        const what = e.on === 'session.idle' ? `when ${ws ?? 'any workspace'} goes idle`
          : e.on === 'workspace.started' ? `when ${ws ?? 'a workspace'} starts`
          : `when a todo${e.tag ? ` tagged #${e.tag}` : ''} arrives${ws ? ` from ${ws}` : ''}`;
        return `${what} · debounce ${e.debounce ?? '2m'}`;
      })
    };
  }

  function parse(text: string): Validation<AutomationDef> {
    const p = parseDefinitionText(text);
    if (!p.ok) return p;
    return validateDefinition(p.value, ctx);
  }

  function failed(a: AutomationRecord, run: RunRow, outcome: RunOutcome): void {
    deps.notify?.({
      kind: 'run-failed',
      title: `${a.name} ${outcome.status === 'timed-out' ? 'timed out' : outcome.status === 'interrupted' ? 'was interrupted' : 'failed'}`,
      body: outcome.error ?? undefined, priority: 'high',
      source: { kind: 'automation', id: a.id }, dedupeKey: `run-failed:${a.id}`, tags: a.definition.tags ?? []
    });
    void run;
  }

  /** A live run asks to fire next at a time (#437); the last request wins, applied when the run ends. */
  async function requestNext(runId: string, raw: unknown, by: string): Promise<{ requestedAt: number; min: string }> {
    const r = active.get(runId);
    if (!r) throw new Error('that run has ended');
    const a = await store.get(r.automationId);
    const min = a?.definition.reschedule?.min;
    if (!a || !min) throw new Error(`${a?.name ?? 'this automation'} can't set its next run: add reschedule: { min: 30m } to its definition`);
    const p = parseNextRequest(raw, deps.now());
    if (!p.ok) throw new Error(p.error);
    if (active.get(runId) !== r) throw new Error('that run has ended'); // it ended during the await
    r.next = { at: p.at, by };
    return { requestedAt: p.at, min };
  }

  /** At run end: apply the last request if the run went well and the automation is unchanged. */
  async function settleNext(a: AutomationRecord, run: RunRow, outcome: RunOutcome, next: { at: number; by: string } | undefined): Promise<void> {
    if (!next) return;
    const now = deps.now();
    const cur = await store.get(a.id);
    const floorMs = parseDuration(cur?.definition.reschedule?.min);
    const ok = outcome.status === 'succeeded' || outcome.status === 'nothing-to-do';
    const unchanged = cur !== null && cur.enabled && cur.version === a.version && floorMs !== null;
    if (!ok || !unchanged) {
      await store.setRunReschedule(run.id, { requestedAt: next.at, appliedAt: null, clamped: false, by: next.by, reason: ok ? 'the automation was changed or disabled during the run' : `the run ${outcome.status === 'timed-out' ? 'timed out' : 'failed'}` });
      return;
    }
    const applied = applyFloor(next.at, now, floorMs);
    await store.setNextRun(a.id, applied.at, run.id);
    await store.setRunReschedule(run.id, { requestedAt: next.at, appliedAt: applied.at, clamped: applied.clamped, by: next.by });
  }

  /** Runs one run to completion. The caller holds claimed[a.id]; it is released here or handed to a promoted queued run. */
  async function execute(a: AutomationRecord, run: RunRow, callerSupplied: boolean): Promise<void> {
    active.set(run.id, { automationId: a.id, workspaces: new Set(stepWorkspaces(a.definition)) });
    deps.changed();
    let outcome: RunOutcome;
    try {
      outcome = await executeRun({ ...deps, requestNext } as RunnerDeps, a, run, { callerSupplied });
    } catch (e) {
      outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    const next = active.get(run.id)?.next;
    active.delete(run.id);
    lastEnded.set(a.id, deps.now());
    let handedOn = false;
    try {
      await store.setRunStatus(run.id, outcome.status, deps.now(), outcome.error);
      await settleNext(a, run, outcome, next);
      if (outcome.status === 'failed' || outcome.status === 'timed-out') failed(a, run, outcome);
      deps.changed();
      // A queued run waits for this one.
      const waiting = queued.get(a.id);
      if (waiting) {
        queued.delete(a.id);
        const q = await waiting;
        const cur = await store.get(a.id);
        if (cur) {
          await store.setRunStatus(q.id, 'running', deps.now());
          const promoted = (await store.getRun(q.id))!;
          handedOn = true;
          track(execute(cur, promoted, q.trigger.by?.kind === 'workspace'));
        }
      }
    } finally {
      if (!handedOn) claimed.delete(a.id);
    }
  }

  async function start(id: string, req: RunRequest): Promise<RunRow> {
    const a = await store.get(id);
    if (!a) throw new Error(`automation ${id} not found`);
    const args = validateArgs(a.definition.params, req.args, req.coerce);
    if (!args.ok) throw new Error(`invalid arguments: ${args.errors.join('; ')}`);
    const trigger = { kind: req.kind, ...(req.by ? { by: req.by } : {}), ...(req.cron ? { cron: req.cron } : {}), ...(req.event ? { event: req.event } : {}) };
    const now = deps.now();
    // --- synchronous from here to each store call: read + claim atomically ---
    const running = claimed.has(id);
    const userManual = req.kind === 'manual' && req.by?.kind === 'user';
    const last = lastStart.get(id);
    if (!userManual && last !== undefined && now - last < RATE_MS && !running) {
      return store.startRun(a, trigger, args.value, 'skipped', now, 'rate limit: at most one run per minute');
    }
    if (running) {
      if (a.definition.concurrency === 'queue' && !queued.has(id)) {
        const p = store.startRun(a, trigger, args.value, 'queued', now);
        queued.set(id, p);
        p.catch(() => { if (queued.get(id) === p) queued.delete(id); });
        return p;
      }
      return store.startRun(a, trigger, args.value, 'skipped', now, 'a run was already in progress');
    }
    claimed.add(id);
    lastStart.set(id, now);
    let run: RunRow;
    try {
      run = await store.startRun(a, trigger, args.value, 'running', now);
    } catch (e) {
      claimed.delete(id);
      throw e;
    }
    track(execute(a, run, req.callerSupplied === true));
    return run;
  }

  /** Record a run that failed before starting (bad args, missing automation) and notify. */
  async function failedStart(a: AutomationRecord, trigger: RunRow['trigger'], message: string): Promise<RunRow> {
    const run = await store.startRun(a, trigger, {}, 'failed', deps.now(), message);
    failed(a, run, { status: 'failed', error: message });
    return run;
  }

  return {
    async list(): Promise<Automation[]> {
      return Promise.all((await store.list()).map(view));
    },
    async get(id: string): Promise<{ automation: Automation; runs: RunRow[]; yaml: string; versions: number[] } | null> {
      const a = await store.get(id);
      if (!a) return null;
      const [automation, runs, versions] = await Promise.all([view(a), store.runs(id, 30), store.versions(id)]);
      return { automation, runs, yaml: definitionToYaml(a.definition), versions: versions.map((v) => v.version) };
    },
    validate(text: string): { ok: boolean; errors: string[] } {
      const r = parse(text);
      return r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors };
    },
    async create(text: string, by: TodoSource): Promise<Automation> {
      const r = parse(text);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const a = await store.create(r.value, by, deps.now());
      deps.changed();
      return view(a);
    },
    async update(id: string, text: string, by: TodoSource): Promise<Automation> {
      const r = parse(text);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const a = await store.update(id, r.value, by, deps.now());
      deps.changed();
      return view(a);
    },
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      await store.setEnabled(id, enabled, deps.now());
      deps.changed();
    },
    async remove(id: string): Promise<void> {
      await store.remove(id);
      deps.changed();
    },
    run: start,

    /** Periodic: start whatever schedule is due (one catch-up for missed slots). */
    async tick(): Promise<RunRow[]> {
      const now = deps.now();
      const started: RunRow[] = [];
      for (const a of await store.list()) {
        const due = dueSchedule(a, now);
        if (!due) continue;
        await store.setLastScheduled(a.id, now);
        if (due.kind === 'rescheduled') await store.setNextRun(a.id, null);
        try {
          started.push(await start(a.id, { kind: due.kind, ...(due.cron ? { cron: due.cron } : {}), args: due.args }));
        } catch (e) {
          started.push(await failedStart(a, { kind: due.kind, ...(due.cron ? { cron: due.cron } : {}) }, (e as Error).message));
        }
      }
      if (started.length) deps.changed();
      return started;
    },

    /** A fleet event (#407 Phase 4): start matching event-triggered automations after their debounce. */
    async onEvent(e: FleetEvent): Promise<string[]> {
      const all = await store.list();
      // --- synchronous from here: the pending map is read and written without awaits ---
      const now = deps.now();
      const matched: string[] = [];
      for (const a of all) {
        if (!a.enabled) continue;
        const trig = a.definition.triggers.find((t) =>
          'event' in t && t.event.on === e.on &&
          (!t.event.workspace || t.event.workspace === (e.workspaceId ?? e.todo?.source.id)) &&
          (!t.event.tag || (e.todo?.tags ?? []).includes(t.event.tag)));
        if (!trig || !('event' in trig)) continue;
        // Loop guard: never react to your own output, or to the workspaces you just prompted.
        if (e.todo?.source.kind === 'automation' && e.todo.source.id === a.id) continue;
        const targets = new Set(stepWorkspaces(a.definition));
        const ws = e.workspaceId ?? (e.todo?.source.kind === 'workspace' ? e.todo.source.id ?? undefined : undefined);
        if (ws && targets.has(ws)) {
          const ended = lastEnded.get(a.id);
          if (claimed.has(a.id) || (ended !== undefined && now - ended < SELF_GUARD_MS)) continue;
        }
        matched.push(a.id);
        const p = pending.get(a.id);
        if (p) {
          p.event.count += 1;
          continue;
        }
        const event = { on: e.on, ...(ws ? { workspaceId: ws } : {}), ...(e.todo ? { todoId: e.todo.id, todoTitle: e.todo.title } : {}), count: 1 };
        const ms = parseDuration(trig.event.debounce) ?? DEFAULT_DEBOUNCE_MS;
        pending.set(a.id, {
          event,
          timer: setTimer(() => {
            const fired = pending.get(a.id);
            pending.delete(a.id);
            if (!fired) return;
            const p = (async () => {
              try {
                await start(a.id, { kind: 'event', event: fired.event });
              } catch (err) {
                const cur = await store.get(a.id);
                if (cur) await failedStart(cur, { kind: 'event', event: fired.event }, (err as Error).message);
              }
              deps.changed();
            })().catch((err) => deps.onError?.(err));
            track(p);
          }, ms)
        });
      }
      return matched;
    },

    /** Cancel pending debounced event runs (quit / tests). */
    cancelPending(): void {
      for (const p of pending.values()) clearTimer(p.timer);
      pending.clear();
    },

    /** Startup: runs cut off by a quit become `interrupted` (one notification). */
    async recover(): Promise<RunRow[]> {
      const cut = await store.markInterrupted(deps.now());
      if (cut.length) {
        const names = [...new Set(await Promise.all(cut.map(async (r) => (await store.get(r.automationId))?.name ?? 'an automation')))];
        deps.notify?.({
          kind: 'run-failed', title: cut.length === 1 ? `${names[0]} was interrupted` : `${cut.length} automation runs were interrupted`,
          body: `The app quit mid-run (${names.join(', ')}). They are not retried automatically.`, priority: 'normal',
          source: { kind: 'user', id: null }
        });
      }
      await store.pruneRuns(deps.now() - RUN_RETENTION_MS);
      return cut;
    },

    /** Attribution: a post that names run_id belongs to the automation only if the run is live and targets the caller. */
    attribution(runId: string, callerId: string): { automationId: string } | null {
      const r = active.get(runId);
      return r && r.workspaces.has(callerId) ? { automationId: r.automationId } : null;
    },

    /** Wait for in-flight runs (tests / quit). */
    async settle(): Promise<void> {
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    mcp: {
      /** Automations a workspace may see: ones it can run, or whose steps prompt it. */
      async list(callerId: string, privileged = false): Promise<Array<Pick<Automation, 'id' | 'name' | 'description' | 'enabled' | 'nextFireAt'> & { canRun: boolean; params: AutomationDef['params'] }>> {
        return (await store.list())
          .filter((a) => privileged || canRun(a, callerId) || stepWorkspaces(a.definition).includes(callerId))
          .map((a) => ({ id: a.id, name: a.name, description: a.definition.description ?? null, enabled: a.enabled, nextFireAt: nextFireAt(a, deps.now()), canRun: privileged || canRun(a, callerId), params: a.definition.params ?? [] }));
      },
      /** One automation's YAML + recent runs, for workspaces that may see it (all for the automations workspace). */
      async get(callerId: string, args: Record<string, unknown>, privileged = false) {
        const key = typeof args.id === 'string' ? args.id : '';
        const a = (await store.get(key)) ?? (await store.byName(key));
        if (!a || !(privileged || visible(a, callerId))) throw new Error(`automation ${key || '(missing id)'} not found`);
        return { ...(await view(a)), yaml: definitionToYaml(a.definition), runs: await store.runs(a.id, 10) };
      },
      /** Recent runs across the automations a workspace may see, optionally filtered. */
      async listRuns(callerId: string, args: Record<string, unknown>, privileged = false) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100);
        const key = typeof args.automation === 'string' ? args.automation : null;
        const status = typeof args.status === 'string' ? args.status : null;
        const since = typeof args.since === 'number' ? args.since : 0;
        const pool = (await store.list()).filter((a) => (privileged || visible(a, callerId)) && (!key || a.id === key || a.name === key));
        const perAutomation = await Promise.all(pool.map(async (a) => (await store.runs(a.id, 100)).map((r) => ({ ...r, automation: a.name }))));
        return perAutomation.flat()
          .filter((r) => (!status || r.status === status) && r.startedAt >= since)
          .sort((x, y) => y.startedAt - x.startedAt)
          .slice(0, limit);
      },
      /** schedule_next (#437): a workspace a live run prompted picks that automation's next fire. */
      async scheduleNext(callerId: string, args: Record<string, unknown>): Promise<{ requestedAt: string; note: string }> {
        const runId = typeof args.run_id === 'string' ? args.run_id : '';
        const r = active.get(runId);
        if (!r || !r.workspaces.has(callerId)) throw new Error('not permitted: run_id must be a live run of an automation that prompted this workspace');
        const raw = { ...(args.in !== undefined ? { in: args.in } : {}), ...(args.at !== undefined ? { at: args.at } : {}) };
        const res = await requestNext(runId, raw, deps.workspaceName(callerId));
        return {
          requestedAt: new Date(res.requestedAt).toISOString(),
          note: `applied when the run ends successfully, never sooner than ${res.min} after it ends; a later request in this run replaces it`
        };
      },
      async run(callerId: string, args: Record<string, unknown>, privileged = false): Promise<{ runId: string; status: string }> {
        const id = typeof args.id === 'string' ? args.id : '';
        const a = (await store.get(id)) ?? (await store.byName(id));
        if (!a) throw new Error(`automation ${id || '(missing id)'} not found`);
        if (!privileged && !canRun(a, callerId)) throw new Error(`not permitted: ${a.name} doesn't list this workspace in manual.allowFrom`);
        if (!a.enabled) throw new Error(`${a.name} is disabled`);
        const r = await start(a.id, { kind: 'manual', by: { kind: 'workspace', id: callerId }, args: (args.args as Record<string, unknown>) ?? {}, callerSupplied: true });
        return { runId: r.id, status: r.status };
      }
    }
  };

  function visible(a: AutomationRecord, callerId: string): boolean {
    return canRun(a, callerId) || stepWorkspaces(a.definition).includes(callerId);
  }

  function canRun(a: AutomationRecord, callerId: string): boolean {
    return a.definition.triggers.some((t) => 'manual' in t && (t.manual.allowFrom ?? []).includes(callerId));
  }
}

export type AutomationService = ReturnType<typeof createAutomationService>;
export type { ParamValue };
```

- [ ] **Step 5: Await the store in `src/main/automations/runner.ts`**

Make these exact replacements:

| Old | New |
|---|---|
| `requestNext?(runId: string, raw: unknown, by: string): unknown;` | `requestNext?(runId: string, raw: unknown, by: string): unknown \| Promise<unknown>;` |
| `runId: run.id, automationName: a.name, args: run.args as Record<string, ParamValue>, state: deps.store.getState(a.id),` | `runId: run.id, automationName: a.name, args: run.args as Record<string, ParamValue>, state: await deps.store.getState(a.id),` |
| `if (out.state !== undefined) deps.store.setState(a.id, out.state);` | `if (out.state !== undefined) await deps.store.setState(a.id, out.state);` |
| `try { deps.requestNext?.(run.id, out.next, step.id); }` | `try { await deps.requestNext?.(run.id, out.next, step.id); }` |
| every `deps.store.finishStep(` (6 sites) | `await deps.store.finishStep(` |
| `const stepRow = deps.store.startStep(run.id, step.id, 'script', where, deps.now());` | `const stepRow = await deps.store.startStep(run.id, step.id, 'script', where, deps.now());` |
| `const stepId = deps.store.startStep(run.id, step.id, 'prompt', p.workspace, deps.now());` | `const stepId = await deps.store.startStep(run.id, step.id, 'prompt', p.workspace, deps.now());` |

The `if (!(e instanceof HandledStepError)) deps.store.finishStep(…)` line becomes `if (!(e instanceof HandledStepError)) await deps.store.finishStep(…)`. All these sites are already inside `async` functions.

- [ ] **Step 6: Rewrite `createLoadoutInstaller` in `src/main/automations/loadoutInstaller.ts`**

Replace the function body (from `export function createLoadoutInstaller` through its `return { preview, install, uninstall };`) with:

```ts
export function createLoadoutInstaller(deps: { store: AutomationStore; now(): number; workspaceName(id: string): string }) {
  const { store } = deps;
  const installedFrom = async (loadoutId: string, targetId: string) =>
    (await store.list()).filter((a) => { const o = originOf(a); return o?.loadoutId === loadoutId && o.workspaceId === targetId; });

  async function preview(prepared: PreparedAutomation[], loadoutId: string, targetId: string, allowHost = false): Promise<LoadoutAutomationPreview[]> {
    const existing = await installedFrom(loadoutId, targetId);
    const firstInstall = existing.length === 0;
    return prepared.map((p) => {
      const cur = existing.find((a) => originOf(a)!.folder === p.folder);
      const flags = p.definition ? riskFlags(p.definition, deps.workspaceName) : [];
      if (!p.ok || !p.definition) {
        return { folder: p.folder, name: p.name, status: 'invalid', defaultOn: false, blocked: p.errors[0] ?? 'invalid', hostStep: false, missingSecrets: [], flags, errors: p.errors };
      }
      let status: LoadoutAutomationStatus = 'new';
      if (cur) {
        const o = originOf(cur)!;
        status = cur.version > o.installedVersion ? 'kept-edited' : JSON.stringify(cur.definition) === JSON.stringify({ ...p.definition, name: cur.name }) ? 'unchanged' : 'update';
      }
      const blocked = p.hostStep && !allowHost ? 'runs a script on your computer: allow that for this loadout to install it'
        : p.missingSecrets.length ? `add the secret${p.missingSecrets.length > 1 ? 's' : ''} ${p.missingSecrets.join(', ')} to turn it on` : null;
      const defaultOn = status === 'new' ? firstInstall && !blocked : cur ? cur.enabled : false;
      return { folder: p.folder, name: cur?.name ?? p.name, status, defaultOn, blocked, hostStep: p.hostStep, missingSecrets: p.missingSecrets, flags, errors: [] };
    });
  }

  async function install(prepared: PreparedAutomation[], opts: InstallOpts): Promise<InstallSummary> {
    const rows = await preview(prepared, opts.loadoutId, opts.targetId, opts.allowHost === true);
    const enable = opts.enable ? new Set(opts.enable) : new Set(rows.filter((r) => r.defaultOn).map((r) => r.folder));
    const out: InstallSummary = { ids: [], created: [], updated: [], kept: [], skipped: [] };
    const existing = await installedFrom(opts.loadoutId, opts.targetId);
    const taken = new Set((await store.list()).map((a) => a.name));
    for (const [i, p] of prepared.entries()) {
      const row = rows[i];
      const cur = existing.find((a) => originOf(a)!.folder === p.folder);
      if (cur) out.ids.push(cur.id);
      if (row.status === 'invalid' || !p.definition) { out.skipped.push({ name: p.name, reason: row.blocked ?? 'invalid' }); continue; }
      if (p.hostStep && opts.allowHost !== true) { out.skipped.push({ name: p.name, reason: row.blocked! }); continue; }
      const origin = (version: number): LoadoutOrigin => ({ loadoutId: opts.loadoutId, version: opts.version, workspaceId: opts.targetId, folder: p.folder, installedVersion: version });
      if (cur) {
        if (row.status === 'kept-edited') { out.kept.push(cur.name); continue; }
        if (row.status === 'update') {
          const def: AutomationDef = { ...p.definition, name: cur.name };
          const next = await store.update(cur.id, def, USER, deps.now());
          await store.setOrigin(cur.id, { ...origin(next.version) });
          out.updated.push(cur.name);
        } else {
          await store.setOrigin(cur.id, { ...origin(cur.version) });
        }
        continue;
      }
      const name = copyName(p.definition.name, opts.targetName, (n) => taken.has(n));
      const on = enable.has(p.folder) && !row.blocked;
      const a = await store.create({ ...p.definition, name }, USER, deps.now(), on, { ...origin(1) });
      taken.add(a.name);
      out.ids.push(a.id);
      out.created.push(a.name);
    }
    return out;
  }

  async function uninstall(loadoutId: string, targetId: string): Promise<string[]> {
    const gone = await installedFrom(loadoutId, targetId);
    for (const a of gone) await store.remove(a.id);
    return gone.map((a) => a.name);
  }

  return { preview, install, uninstall };
}
```

- [ ] **Step 7: Pass `expectedVersion` from proposals**

In `src/main/automations/proposalService.ts` `apply()`, replace
```ts
    await deps.automations.update(cur.id, it.after, by, now);
```
with
```ts
    await deps.automations.update(cur.id, it.after, by, now, it.baseVersion ?? undefined);
```

- [ ] **Step 8: Wire `src/main/automations/automationIpc.ts`**

Make these exact edits:

1. `const store = new AutomationStore(inbox.db);` → `const store = new AutomationStore(inbox.kysely);`
2. Add `onError: (e) => logError({ source: 'main', type: 'automation-event-run', level: 'warn', message: String(e) }),` to the `createAutomationService({ … })` deps (next to `changed:`).
3. In the `install` hook, replace
   ```ts
      const r = installer.install(prepared, {
   ```
   with `const r = await installer.install(prepared, {`, and replace
   ```ts
      return { ...r, names: r.ids.map((id) => store.get(id)?.name).filter((n): n is string => !!n) };
   ```
   with
   ```ts
      const named = await Promise.all(r.ids.map(async (id) => (await store.get(id))?.name));
      return { ...r, names: named.filter((n): n is string => !!n) };
   ```
4. `uninstall` hook: `if (installer.uninstall(loadoutId, workspaceId).length)` → `if ((await installer.uninstall(loadoutId, workspaceId)).length)`.
5. Replace the recover `try { svc.recover(); } catch …` block and the tick interval with:
   ```ts
  svc.recover().catch((e) => logError({ source: 'main', type: 'automation-recover', level: 'warn', message: String(e) }));
  const tick = setInterval(() => {
    void refresh()
      .then(() => svc.tick())
      .catch((e) => logError({ source: 'main', type: 'automation-tick', level: 'warn', message: String(e) }));
  }, 30_000);
  tick.unref?.();
   ```
6. Event observers:
   ```ts
  setFleetEventObserver((e) => { svc.onEvent(e).catch((err) => logError({ source: 'main', type: 'automation-event', level: 'warn', message: String(err) })); });
  inboxEvents.on('todo', (t: Todo) => {
    svc.onEvent({ on: 'todo.created', workspaceId: t.source.kind === 'workspace' ? t.source.id ?? undefined : undefined, todo: { id: t.id, title: t.title, tags: t.tags, source: t.source } })
      .catch((err) => logError({ source: 'main', type: 'automation-event', level: 'warn', message: String(err) }));
  });
   ```
7. `withNames`: replace
   ```ts
  const withNames = async <T>(fn: () => T): Promise<T> => { await Promise.all([refresh(), refreshShells()]); return fn(); };
   ```
   with
   ```ts
  const withNames = async <T>(fn: () => T | Promise<T>): Promise<T> => { await Promise.all([refresh(), refreshShells()]); return await fn(); };
   ```
8. In `toRole`, replace `automations: store.list().map((a) => a.name),` with `automations: (await store.list()).map((a) => a.name),`.
9. Replace the `automations:askChange` handler with:
   ```ts
  ipcMain.handle('automations:askChange', async (_e, id: string, text: string) => {
    const d = need(text, 'the change');
    const a = await store.get(id);
    if (!a) throw new Error('automation not found');
    return toRole((ctx) => changePrompt(a.name, definitionToYaml(a.definition), d, ctx));
  });
   ```

The `setAutomationHandlers` lambdas already `return svc.mcp.*(…)` from `async` functions, so they need no change.

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run src/main/automations/`
Expected: PASS, including `concurrent starts (async store)` and `optimistic version check`.
Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
git add src/main/automations
git commit -m "feat(store): AutomationStore + automation engine async on Kysely; synchronous run claims

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `InboxStore` todo methods go async; drop the raw handle

**Files:**
- Modify: `src/main/inbox/inboxDb.ts` (`InboxStore` class below the migrations, full rewrite)
- Modify: `src/main/inbox/inboxIpc.ts` (`notifyChanged`)
- Modify: `src/main/automations/automationIpc.ts` (proposal `changed:` broadcast)
- Test: `src/main/inbox/inboxDb.test.ts`, `src/main/inbox/inboxService.test.ts` (test-conversion rule, plus a new race test)

**Interfaces:**
- Consumes: `TodoRow`, `TodoEventRow`, `InboxDb`, `num` (Task 1).
- Produces: `InboxStore.get/events/list/counts/post/update` return Promises of their old types. `InboxStore.db` (raw) is removed, and `kysely` is the only handle. `open()`/`memory()` stay synchronous.

- [ ] **Step 1: Convert the tests and add the race test**

Apply the *Test-conversion rule* to `inboxDb.test.ts` and `inboxService.test.ts`. In `inboxDb.test.ts`, the Task 1 test's line `const { todo } = store.post(WS, { title: 'via raw' }, 1000);` becomes `const { todo } = await store.post(WS, { title: 'via raw' }, 1000);`. (No test reads `store.db`. The migration/backup tests already open their own `new Database(file)`.) Append:

```ts
describe('InboxStore.post concurrency', () => {
  it('two concurrent posts with the same key make one todo (created + updated)', async () => {
    store = InboxStore.memory();
    const [a, b] = await Promise.all([
      store.post(WS, { title: 'x', key: 'k' }, 1000),
      store.post(WS, { title: 'x', key: 'k' }, 1001)
    ]);
    expect([a.action, b.action].sort()).toEqual(['created', 'updated']);
    expect(a.todo.id).toBe(b.todo.id);
    expect(await store.list({ status: 'all' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/inbox/inboxDb.test.ts src/main/inbox/inboxService.test.ts`
Expected: FAIL only in the tests converted to `.rejects` (for example `update … not found` at `inboxDb.test.ts:80`). The sync store throws before `expect` gets a promise. The other converted tests already pass, because `await` on a plain value is allowed. The new concurrency test also passes on sync code: it pins today's behaviour, and Step 3 must keep it green.

- [ ] **Step 3: Rewrite the `InboxStore` class in `src/main/inbox/inboxDb.ts`**

Keep the file header, `INBOX_SCHEMA_VERSION`, `MIGRATIONS` and `newId` exactly as they are. Replace the imports and everything from `interface TodoRow {` to the end of the file:

Imports (top of file):
```ts
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  InboxCounts, PostTodoInput, Todo, TodoEvent, TodoFilter, TodoSource, UpdateTodoPatch
} from '../../preload/inboxTypes.js';
import { isPriority, maxPriority, normalizeTag, normalizeTags, MAX_TAGS } from './inboxCore.js';
import { num, sqliteKysely } from '../store/kysely.js';
import type { InboxDb, TodoRow } from '../store/inboxSchema.js';
```

Class (replacing `interface TodoRow` through the end of the file):
```ts
type Q = Kysely<InboxDb> | Transaction<InboxDb>;

const PRIORITY_ORDER = sql<number>`CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

export class InboxStore {
  private constructor(private readonly raw: Database.Database, readonly kysely: Kysely<InboxDb>) {}

  static open(dir: string): InboxStore {
    const file = path.join(dir, 'inbox.db');
    const existed = existsSync(file);
    if (existed) {
      const probe = new Database(file);
      const v = probe.pragma('user_version', { simple: true }) as number;
      probe.close();
      if (v < INBOX_SCHEMA_VERSION) copyFileSync(file, `${file}.bak-v${v}-${Date.now()}`);
    }
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    return InboxStore.init(db);
  }

  static memory(): InboxStore {
    return InboxStore.init(new Database(':memory:'));
  }

  private static init(db: Database.Database): InboxStore {
    db.pragma('foreign_keys = ON');
    const current = db.pragma('user_version', { simple: true }) as number;
    for (let v = current + 1; v <= INBOX_SCHEMA_VERSION; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        db.pragma(`user_version = ${v}`);
      })();
    }
    return new InboxStore(db, sqliteKysely<InboxDb>(db));
  }

  async close(): Promise<void> {
    // destroy() only closes the connection if Kysely ever ran a query, so close the raw handle too.
    await this.kysely.destroy();
    if (this.raw.open) this.raw.close();
  }

  // --- reads --------------------------------------------------------------

  private async tagsFor(q: Q, id: string): Promise<string[]> {
    const rows = await q.selectFrom('tags').select('tag').where('entity_kind', '=', 'todo').where('entity_id', '=', id).orderBy('tag').execute();
    return rows.map((r) => r.tag);
  }

  private async toTodo(q: Q, r: TodoRow): Promise<Todo> {
    return {
      id: r.id, title: r.title, body: r.body, status: r.status, priority: r.priority,
      source: { kind: r.source_kind, id: r.source_id }, sourceRunId: r.source_run_id,
      viaWorkspace: r.via_workspace, dedupeKey: r.dedupe_key, seenCount: r.seen_count,
      recurred: r.recurred === 1, workspaceId: r.workspace_id, sessionId: r.session_id,
      tags: await this.tagsFor(q, r.id), createdAt: r.created_at, updatedAt: r.updated_at,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, closedAt: r.closed_at
    };
  }

  private async getWith(q: Q, id: string): Promise<Todo | null> {
    const r = await q.selectFrom('todos').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toTodo(q, r) : null;
  }

  get(id: string): Promise<Todo | null> {
    return this.getWith(this.kysely, id);
  }

  async events(id: string): Promise<TodoEvent[]> {
    const rows = await this.kysely.selectFrom('todo_events').selectAll().where('todo_id', '=', id).orderBy('id').execute();
    return rows.map((e) => ({
      id: e.id, todoId: e.todo_id, ts: e.ts, kind: e.kind, actor: { kind: e.actor_kind, id: e.actor_id },
      runId: e.run_id, detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null
    }));
  }

  async list(filter: TodoFilter = {}): Promise<Todo[]> {
    const status = filter.status ?? 'open';
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 200)), 500);
    let q = this.kysely.selectFrom('todos').selectAll();
    if (status !== 'all') q = q.where('status', '=', status);
    const v = filter.visibleTo;
    if (v) {
      q = q.where((eb) => eb.or([
        eb.and([eb('source_kind', '=', 'workspace'), eb('source_id', '=', v)]),
        eb('workspace_id', '=', v),
        eb('via_workspace', '=', v)
      ]));
    }
    for (const raw of filter.tags ?? []) {
      const t = normalizeTag(raw);
      if (!t) continue;
      q = q.where((eb) => eb.exists(
        eb.selectFrom('tags as g').select('g.tag')
          .where('g.entity_kind', '=', 'todo').whereRef('g.entity_id', '=', 'todos.id').where('g.tag', '=', t)
      ));
    }
    const rows = await q.orderBy(PRIORITY_ORDER).orderBy('last_seen_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return Promise.all(rows.map((r) => this.toTodo(this.kysely, r)));
  }

  async counts(): Promise<InboxCounts> {
    const r = await this.kysely.selectFrom('todos')
      .select([
        (eb) => eb.fn.countAll().as('open'),
        sql<number | null>`SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END)`.as('urgent'),
        sql<number | null>`SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END)`.as('high')
      ])
      .where('status', '=', 'open').executeTakeFirstOrThrow();
    const a = await this.kysely.selectFrom('proposals').select((eb) => eb.fn.countAll().as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow();
    return { open: num(r.open), urgent: num(r.urgent), high: num(r.high), approvals: num(a.n) };
  }

  // --- writes -------------------------------------------------------------

  private async event(q: Q, todoId: string, ts: number, kind: TodoEvent['kind'], actor: TodoSource, detail?: Record<string, unknown>): Promise<void> {
    await q.insertInto('todo_events').values({
      todo_id: todoId, ts, kind, actor_kind: actor.kind, actor_id: actor.id, run_id: null, detail: detail ? JSON.stringify(detail) : null
    }).execute();
  }

  private async addTags(q: Q, id: string, tags: string[]): Promise<string[]> {
    const existing = await this.tagsFor(q, id);
    const added: string[] = [];
    for (const t of tags) {
      if (existing.length + added.length >= MAX_TAGS) break;
      if (existing.includes(t) || added.includes(t)) continue;
      await q.insertInto('tags').values({ entity_kind: 'todo', entity_id: id, tag: t }).onConflict((oc) => oc.doNothing()).execute();
      added.push(t);
    }
    return added;
  }

  post(source: TodoSource, input: PostTodoInput, now = Date.now()): Promise<{ todo: Todo; action: 'created' | 'updated' | 'reopened' }> {
    return this.kysely.transaction().execute(async (trx) => {
      const priority = input.priority ?? 'normal';
      const tags = normalizeTags(input.tags ?? []);
      const existing = input.key
        ? await trx.selectFrom('todos').selectAll()
            .where('source_kind', '=', source.kind)
            .where(sql<string>`coalesce(source_id, '')`, '=', source.id ?? '')
            .where('dedupe_key', '=', input.key)
            .executeTakeFirst()
        : undefined;
      if (!existing) {
        const id = newId(now);
        await trx.insertInto('todos').values({
          id, title: input.title, body: input.body ?? null, status: 'open', priority, source_kind: source.kind, source_id: source.id,
          dedupe_key: input.key ?? null, workspace_id: input.workspaceLink ?? null, session_id: input.sessionLink ?? null,
          via_workspace: input.viaWorkspace ?? null, source_run_id: input.sourceRunId ?? null,
          created_at: now, updated_at: now, first_seen_at: now, last_seen_at: now
        }).execute();
        await this.addTags(trx, id, tags);
        await this.event(trx, id, now, 'created', source, { title: input.title, priority });
        return { todo: (await this.getWith(trx, id))!, action: 'created' as const };
      }
      const reopen = existing.status !== 'open';
      // Same effect as the old single UPDATE: computed from the row read in this transaction.
      await trx.updateTable('todos').set((eb) => ({
        seen_count: eb('seen_count', '+', 1), last_seen_at: now, updated_at: now,
        priority: maxPriority(existing.priority, priority),
        body: input.body ?? existing.body, status: 'open',
        recurred: reopen ? 1 : existing.recurred,
        closed_at: reopen ? null : existing.closed_at
      })).where('id', '=', existing.id).execute();
      await this.addTags(trx, existing.id, tags);
      await this.event(trx, existing.id, now, reopen ? 'reopened' : 'seen', source,
        { priority, ...(input.body !== undefined ? { body: input.body } : {}), ...(reopen ? { from: existing.status } : {}) });
      return { todo: (await this.getWith(trx, existing.id))!, action: reopen ? ('reopened' as const) : ('updated' as const) };
    });
  }

  update(actor: TodoSource, id: string, patch: UpdateTodoPatch, now = Date.now()): Promise<Todo> {
    return this.kysely.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('todos').selectAll().where('id', '=', id).executeTakeFirst();
      if (!cur) throw new Error(`todo ${id} not found`);
      if (patch.status && patch.status !== cur.status) {
        await trx.updateTable('todos').set({ status: patch.status, closed_at: patch.status === 'open' ? null : now, updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'status', actor, { from: cur.status, to: patch.status });
      }
      if (patch.priority && isPriority(patch.priority) && patch.priority !== cur.priority) {
        await trx.updateTable('todos').set({ priority: patch.priority, updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'priority', actor, { from: cur.priority, to: patch.priority });
      }
      const title = patch.title?.trim();
      if (title && title !== cur.title) {
        await trx.updateTable('todos').set({ title: title.slice(0, 200), updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'title', actor, { from: cur.title, to: title });
      }
      const added = await this.addTags(trx, id, normalizeTags(patch.tagsAdd ?? []));
      if (added.length) await this.event(trx, id, now, 'tag_add', actor, { tags: added });
      const removed: string[] = [];
      for (const t of normalizeTags(patch.tagsRemove ?? [])) {
        const r = await trx.deleteFrom('tags').where('entity_kind', '=', 'todo').where('entity_id', '=', id).where('tag', '=', t).executeTakeFirst();
        if (Number(r.numDeletedRows)) removed.push(t);
      }
      if (removed.length) await this.event(trx, id, now, 'tag_remove', actor, { tags: removed });
      if (patch.bodyAppend && patch.bodyAppend.trim()) {
        const text = patch.bodyAppend.slice(0, 20_000);
        // body was not touched earlier in this transaction, so cur.body is current.
        const body = cur.body === null || cur.body === '' ? text : `${cur.body}\n\n${text}`;
        await trx.updateTable('todos').set({ body, updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'body_append', actor, { text });
      }
      if (added.length || removed.length) await trx.updateTable('todos').set({ updated_at: now }).where('id', '=', id).execute();
      return (await this.getWith(trx, id))!;
    });
  }
}
```

(`TodoEventKind` was imported only for the old `event()` signature. `TodoEvent['kind']` replaces it.)

- [ ] **Step 4: Fix the two broadcast sites**

In `src/main/inbox/inboxIpc.ts`, replace the `notifyChanged` entry with:
```ts
    notifyChanged: () => {
      void store.counts()
        .then((c) => broadcastInboxChanged(c, BrowserWindow.getAllWindows()))
        .catch((e) => logError({ source: 'main', type: 'inbox-broadcast', level: 'warn', message: String(e) }));
      emitInboxChanged();
    },
```

In `src/main/automations/automationIpc.ts`, in the proposals `changed:` dep, replace
```ts
      broadcastInboxChanged(inbox.counts(), BrowserWindow.getAllWindows());
```
with
```ts
      void inbox.counts()
        .then((c) => broadcastInboxChanged(c, BrowserWindow.getAllWindows()))
        .catch((e) => logError({ source: 'main', type: 'inbox-broadcast', level: 'warn', message: String(e) }));
```

- [ ] **Step 5: Confirm the raw handle is gone everywhere**

Run: `/usr/bin/grep -rnE "inbox(Store)?\.db\b|store\.db\b" src/main --include=*.ts`
Expected: no output.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/main/inbox/ src/main/automations/ src/main/store/`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/inbox src/main/automations/automationIpc.ts
git commit -m "feat(store): InboxStore async on Kysely; inbox.db fully on the async store layer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SPEC.md, full verification, PR

**Files:**
- Modify: `docs/SPEC.md` §4 *Stack* (table), §7 *Inbox store*

**Interfaces:** none (docs and gate).

- [ ] **Step 1: Update §4 *Stack***

Directly after the `| Local DB | `better-sqlite3` | … |` row, insert:

```markdown
| Store layer | `kysely` | Typed async query builder over the local DBs (remote-workspaces spec §7 *One store layer*). The `inbox.db` stores (`InboxStore`, `NotifyStore`, `AutomationStore`, `ProposalStore`) are written once against Kysely and run on its `SqliteDialect` over the same better-sqlite3 connection; every store method is async. `state.db` moves next; Postgres is a second dialect of the same queries. |
```

- [ ] **Step 2: Update §7 *Inbox store***

At the end of the first paragraph of `### Inbox store (\`inbox.db\`, #407)` (after `…(\`InboxStore.open\`, \`src/main/inbox/inboxDb.ts\`).`), append:

```markdown
Migrations still run synchronously on the raw connection at open; the stores then use one async **Kysely** handle over that connection (`InboxStore.kysely`, `src/main/store/kysely.ts`). Kysely's SQLite driver serializes every query behind a single-connection mutex and a transaction holds it until commit, so multi-statement writes (`post`, `update`, automation create/update, `markInterrupted`, rule/downtime upserts) stay atomic against every other store call. Code inside a transaction uses the transaction handle only. In-memory concurrency guards that used to be implicit in synchronous code are explicit: automation runs claim their automation id before the first `await` (one running + at most one queued per automation), `tick()` in the notification service is serialized, proposal decisions take a per-proposal guard, and `AutomationStore.update` accepts an `expectedVersion` (proposal apply rejects a stale base).
```

- [ ] **Step 3: Full verification**

Run each, separately:
```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx vitest run src/main/store src/main/inbox src/main/automations
npx vitest run            # whole unit suite; db.ts/state.db tests must be unchanged from the baseline
/usr/bin/grep -rnE "IFNULL|char\(10\)|INSERT OR IGNORE|lastInsertRowid" src/main/inbox src/main/automations src/main/store --include=*.ts | /usr/bin/grep -v "MIGRATIONS\|CREATE "
```
Expected: no new type errors in either config. The inbox, automations and store suites PASS. The full suite matches the baseline. The last grep prints only lines inside the `MIGRATIONS` DDL (the `todos_dedupe` index's `IFNULL`), with no store method.

If vitest can't run in-container (see *Verification environment*), record that in the PR body and rely on CI.

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): Kysely store layer for inbox.db (async store, part 1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --repo ImIOImI/claude-fleet --title "feat(store): inbox.db on an async Kysely store layer (async store part 1)" --body "$(cat <<'EOF'
Part 1 of remote-workspaces sub-project (a) (plan: docs/superpowers/plans/2026-11-02-async-store-part1.md).

- InboxStore / NotifyStore / AutomationStore / ProposalStore are async, written with Kysely on its SQLite dialect over the existing inbox.db connection. Same schema, same migrations, same backups.
- Callers (notify/inbox services, IPC, presence, scheduler tick, runner, loadout installer, MCP handlers) are async.
- Atomicity the sync store gave for free is explicit now: transactions on a mutexed single connection, synchronous run claims, serialized notification tick, per-proposal decision guard, expectedVersion on automation update.
- SPEC §4 Stack + §7 Inbox store updated.

Gate: typecheck (node + web) + unit + build + e2e in CI. No UI change; Troy to eyeball Inbox, tray pause/resume, automations run/queue on the host.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage (part 1's share of §7/§11(a)/§12(a)):** async store interface ✔ (Tasks 2–5), Kysely ✔ (Task 1), SQLite unchanged ✔ (Global Constraints, Task 5 grep), §4 Stack + §7 Inbox store SPEC ✔ (Task 6). Postgres, pgvector, the managed container, the password provider, the `store` setting, §6/§8/§11 SPEC and `state.db` are deliberately in parts 2–5 below.
- **Type consistency:** `InboxStore.kysely` is used by every store constructor from Task 2 on. `startStep(): Promise<number>` is consumed by `runner.ts`'s `finishStep(stepRow…)`. `AutomationStore.update(…, expectedVersion?)` is used by `proposalService.apply`. `NotifyService.request(): Promise<NotificationRow>` is used by `inboxService` (awaited) and `automationIpc` (`void … .catch`). `startPresence(…, approvals: () => number | Promise<number>)` matches `index.ts`'s `() => auto?.proposals.pendingCount() ?? 0`.

---

## Remaining plans for sub-project (a) (each is written in full when it's reached)

Each one ships on its own with SQLite behaviour unchanged, and carries its own SPEC.md edits in the same PR.

**Part 2: `state.db` (`db.ts`) on the async store layer.** *Depends on part 1.*
- Goal: the JSONL→SQLite cache's ~60 exported functions become async Kysely queries over the same `state.db` connection: ingest, sessions, summaries, cost, plan usage, usage anchors, broker mapping, errors, embeddings writes.
- Files: `src/main/db.ts` (split into `src/main/state/{ingest,sessions,summaries,cost,broker,embeddingsStore,errors}.ts` behind a `StateStore` class), `src/main/store/stateSchema.ts`, `syncCache.ts` (becomes an async cache with in-flight de-dupe), and callers `jsonlWatcher.ts` (a per-file ordered ingest queue, so line order and dedup are preserved), `ipc.ts`, `local.ts`, `docker.ts`, `index.ts`, `transcriptIndex.ts`, `planUsage.ts`, `errorLog.ts` (the error sink stays fire-and-forget and never throws).
- Needs a **perf gate**: ingest throughput and `summaryFor*` p95 against the perf-telemetry baseline (memory: perf saga resolved on v0.13.16). Precompile the hot-path queries (`CompiledQuery`) if Kysely's builder cost shows up.
- `mcpServer.ts`'s read-only better-sqlite3 connection and `buildSnapshot` stay exactly as they are (the SQLite MCP path).
- Probably two PRs: 2a ingest/write path, 2b read path and caches.

**Part 3: Postgres dialect, per-dialect migrations, dual-dialect tests, pgvector.** *Depends on parts 1 and 2.*
- Goal: the same stores run on `pg`.
- Add `pg` and `src/main/store/postgres.ts` (`PostgresDialect`; parse int8 as `Number`).
- One migration list, `{ version, sqlite, postgres }` per step, in `src/main/store/migrations/{inbox,state}.ts`, with versions kept in a `schema_version` table on Postgres. Postgres starts from a **baseline** equal to today's final SQLite schemas, not a replay of every SQLite step.
- Store test-suites run under `describe.each(storeDialects())`. CI adds a `pgvector/pgvector:pg17` service container and an env-gated `PG_TEST_URL`.
- `searchEmbeddings(query, scope, limit)` interface: SQLite keeps brute-force over `vectors.ts`; Postgres uses a `vector(384)` column, `<=>` cosine distance and an HNSW index. `transcriptIndex.ts` is ported to it.
- SPEC §7 *JSONL→SQLite cache* / *Inbox store*: dialect-neutral schema, per-dialect migrations, pgvector.

**Part 4: The app-managed local Postgres and the store choice.** *Depends on part 3.*
- Goal: users can pick Postgres in Settings.
- `config.json` `store`: `{ kind: 'sqlite' }` (default) | `{ kind: 'postgres', managed: true }` | `{ kind: 'postgres', managed: false, connectionString | env: 'DATABASE_URL' | fields + password: { kind: 'static' | 'env' | 'aws-rds-iam' } }` (PR #452). Lives in `src/main/config.ts`.
- `src/main/store/passwordProvider.ts`: called per new pool connection; `aws-rds-iam` uses `@aws-sdk/rds-signer`.
- `src/main/store/managedPostgres.ts` on `docker.ts`: a pinned pgvector image, a labelled container, a named volume, a loopback-only random host port, and a generated password stored as the connection string in the vault's app bag. Start/health/stop sit in startup ordering.
- The Docker-down degraded state: history and inbox are unavailable, with a banner that reuses the `unreachable` pattern from #380.
- Settings → *Storage* UI with a restart-to-apply switch, plus a one-shot copy of `inbox.db` into Postgres on first switch. `state.db` is re-ingested from JSONL.
- SPEC §4, §6 *Settings*, §8 *Startup*.

**Part 5: MCP `query` (and typed read tools) isolation on Postgres.** *Depends on part 4.*
- Goal: the read-only MCP server works on Postgres with structural isolation.
- One read-only role per MCP caller workspace, plus an `_raw` sibling that also gets `raw_jsonl`.
- RLS on `events`/`sessions`/`broker_sessions` via `query_scope (role, workspace_id)`, rewritten whenever grants change.
- Each call runs as `BEGIN READ ONLY; SET LOCAL ROLE …; SET LOCAL statement_timeout …`. The existing single-statement, row-cap and result-cap guards stay.
- The typed tools (`list_sessions`, `list_events`, …) move off the raw SQLite connection onto a `ReadSource` with SQLite (snapshot / read-only connection, unchanged) and Postgres (role-scoped) implementations.
- Files: `src/main/mcpServer.ts`, a new `src/main/store/mcpIsolation.ts`, the `mcpServer.test.ts` + `tests/mcp-*.spec.ts` contract tests (memory: update all of them when tools change).
- SPEC §11 *In-container SQLite access via MCP*, §9.
