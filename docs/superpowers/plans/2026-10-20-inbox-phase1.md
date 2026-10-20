# Inbox Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-owned inbox of todos that the user and workspaces (via MCP) can post to, with dedupe/reopen, tags, history, an Inbox chip, and a Todos view. Ships as v0.14.0.

**Architecture:** A new authoritative `<userData>/inbox.db` owned by `src/main/inbox/` (pure core + repository + policy + IPC/MCP wiring). It opens in **both** mock and real mode (unlike `state.db`, which is gated on the JSONL watcher). Workspaces reach it through three new tools on the existing per-workspace MCP socket, with the caller identity host-stamped. The renderer reaches it through `window.api.inbox.*` and a `inbox:changed` push. The UI is an Inbox chip in the top strip that swaps the main pane for `InboxView`.

**Tech Stack:** Electron main (better-sqlite3, ulid-style ids via `crypto.randomUUID`-free ULID helper), React renderer, vitest units, Playwright e2e (mock + real launch).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-20-inbox-automations-design.md` §4 (Phase 1 tables exact), §9, §10, §13.
- `inbox.db` is **authoritative**: WAL, `user_version` migrations, **timestamped backup copy before every migration**.
- `source` is required and immutable, host-stamped: `user` / `workspace:<id>` (Phase 1 never produces `automation`).
- Dedupe: unique per `(source_kind, source_id, dedupe_key)`; hit → `seen_count++`, `last_seen_at`, `priority = max`, tags unioned, body replaced by the newer body when given, `seen` event. done **or** dismissed + hit → reopen (`status=open`, `recurred=1`, `closed_at=NULL`, `reopened` event).
- Tags: lowercase, `[a-z0-9._-]{1,40}` after trimming and turning spaces into `-`; at most 10 per item.
- MCP tools never take a caller-identity argument. `post_todo` is gated by the manifest `inbox.canPost` (default true) and `inbox.maxPostsPerHour` (default 60); over-cap → **reject** with `retryAfterMs`.
- `update_todo` only on todos the caller sourced (or `via_workspace` = caller). `list_todos` sees own-sourced + linked (`workspace_id` = caller) + via; everything with `inbox.canReadAll`.
- The manifest `inbox` block must be added to **both** `WorkspaceSpec` **and** the `readWorkspaceManifest` allowlist constructor, and carried through `workspaceMerge.ts`.
- UI uses only existing design tokens; the Inbox chip deselects the workspace chip while open; the rails keep the last workspace.
- MCP contract is pinned in **both** `src/main/mcpServer.test.ts` and `tests/mcp-*.spec.ts`.
- `docs/SPEC.md` is updated in the same PR (§6, §7, §8, §9, MCP section, Open decisions note).
- Version: `package.json` + `package-lock.json` → `0.14.0`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Local verification: `npx vitest run <files>`, `npm run typecheck:node`, `npm run typecheck:web` (run **separately**). E2E runs in CI only (no display in container).

## File map

| File | Responsibility |
|---|---|
| `src/preload/inboxTypes.ts` (new) | Shared inbox types (main type-imports these; renderer imports via preload) |
| `src/main/inbox/inboxCore.ts` (new) | Pure: priorities, tag normalization, input validation |
| `src/main/inbox/inboxDb.ts` (new) | `InboxStore`: open/migrate/backup, post (dedupe), update, get, events, list, counts |
| `src/main/inbox/inboxPolicy.ts` (new) | Pure: post permission, rate limiter, visibility + update rights |
| `src/main/inbox/inboxBroadcast.ts` (new) | Pure: `inbox:changed` fan-out |
| `src/main/inbox/inboxService.ts` (new) | Wires store + policy + manifests: IPC handlers and MCP handlers |
| `src/main/mcpServer.ts` | `InboxHandlers` injection + `post_todo` / `update_todo` / `list_todos` |
| `src/main/index.ts` | Open store (both modes), register service, close on quit |
| `src/main/workspaces.ts`, `src/main/workspaceMerge.ts` | `inbox` manifest block |
| `src/preload/index.ts` | `window.api.inbox` |
| `src/renderer/src/inboxView.ts` (new) | Pure: grouping, filtering, labels |
| `src/renderer/src/components/InboxChip.tsx`, `InboxView.tsx`, `TodoDetail.tsx` (new) | UI |
| `src/renderer/src/components/WorkspaceTabStrip.tsx`, `App.tsx`, `WorkspaceForm.tsx` | Integration |
| `src/renderer/src/styles.css` | Inbox styles |
| `tests/inbox-ui.spec.ts`, `tests/inbox-mcp.spec.ts` (new) | E2E |

---

### Task 1: Shared types + pure core

**Files:**
- Create: `src/preload/inboxTypes.ts`, `src/main/inbox/inboxCore.ts`
- Test: `src/main/inbox/inboxCore.test.ts`

**Interfaces:**
- Produces: types `TodoStatus`, `TodoPriority`, `SourceKind`, `TodoSource`, `Todo`, `TodoEvent`, `TodoFilter`, `UpdateTodoPatch`, `PostTodoInput`, `InboxCounts`, `InboxConfig`; functions `PRIORITIES`, `priorityRank(p)`, `maxPriority(a,b)`, `normalizeTag(raw): string|null`, `normalizeTags(raw: unknown): string[]`, `validatePostInput(raw): PostTodoInput`, class `InboxInputError`.

- [ ] **Step 1: Write `src/preload/inboxTypes.ts`**

```ts
// Inbox types shared by main (type-only import) and the renderer (via preload).
// Pure declarations — no runtime code — so either side can import them.

export type TodoStatus = 'open' | 'done' | 'dismissed';
export type TodoPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SourceKind = 'user' | 'workspace' | 'automation';

/** Who an item (or an event) came from. `id` is null for the user. */
export interface TodoSource {
  kind: SourceKind;
  id: string | null;
}

export interface Todo {
  id: string;
  title: string;
  body: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  source: TodoSource;
  sourceRunId: string | null;
  viaWorkspace: string | null;
  dedupeKey: string | null;
  seenCount: number;
  recurred: boolean;
  workspaceId: string | null;
  sessionId: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  closedAt: number | null;
}

export type TodoEventKind =
  | 'created'
  | 'seen'
  | 'reopened'
  | 'status'
  | 'priority'
  | 'tag_add'
  | 'tag_remove'
  | 'body_append'
  | 'title';

export interface TodoEvent {
  id: number;
  todoId: string;
  ts: number;
  kind: TodoEventKind;
  actor: TodoSource;
  runId: string | null;
  detail: Record<string, unknown> | null;
}

export interface PostTodoInput {
  title: string;
  body?: string;
  priority?: TodoPriority;
  key?: string;
  tags?: string[];
  workspaceLink?: string;
  sessionLink?: string;
}

export interface UpdateTodoPatch {
  status?: TodoStatus;
  priority?: TodoPriority;
  title?: string;
  tagsAdd?: string[];
  tagsRemove?: string[];
  bodyAppend?: string;
}

export interface TodoFilter {
  /** Default 'open'. */
  status?: TodoStatus | 'all';
  /** Every tag listed must be present. */
  tags?: string[];
  /** Restrict to what one workspace may see (own-sourced, linked, or via). */
  visibleTo?: string;
  /** Default 200, max 500. */
  limit?: number;
}

export interface InboxCounts {
  open: number;
  urgent: number;
  high: number;
}

/** Host-private per-workspace inbox permissions (workspace manifest `inbox`). */
export interface InboxConfig {
  /** Default true. */
  canPost?: boolean;
  /** Default 60. */
  maxPostsPerHour?: number;
  /** Default false. */
  canReadAll?: boolean;
}
```

- [ ] **Step 2: Write the failing test `src/main/inbox/inboxCore.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  PRIORITIES,
  priorityRank,
  maxPriority,
  normalizeTag,
  normalizeTags,
  validatePostInput,
  InboxInputError
} from './inboxCore.js';

describe('priorities', () => {
  it('ranks low < normal < high < urgent', () => {
    expect(PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
    expect(priorityRank('low')).toBeLessThan(priorityRank('urgent'));
  });
  it('maxPriority keeps the more severe', () => {
    expect(maxPriority('normal', 'urgent')).toBe('urgent');
    expect(maxPriority('high', 'low')).toBe('high');
  });
});

describe('normalizeTag', () => {
  it('lowercases, trims, and dashes spaces', () => {
    expect(normalizeTag('  Prod Alerts ')).toBe('prod-alerts');
  });
  it('rejects invalid characters and overlong tags', () => {
    expect(normalizeTag('a/b')).toBeNull();
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('x'.repeat(41))).toBeNull();
  });
  it('normalizeTags dedupes, drops junk and caps at 10', () => {
    expect(normalizeTags(['Ops', 'ops', 'bad/tag', 3])).toEqual(['ops']);
    const many = Array.from({ length: 15 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(10);
    expect(normalizeTags('nope')).toEqual([]);
  });
});

describe('validatePostInput', () => {
  it('accepts a minimal post and defaults priority to normal', () => {
    expect(validatePostInput({ title: '  Disk full ' })).toEqual({ title: 'Disk full', priority: 'normal', tags: [] });
  });
  it('maps snake_case MCP args', () => {
    const v = validatePostInput({
      title: 't', body: 'b', priority: 'urgent', key: 'k1', tags: ['Ops'],
      workspace_link: 'W1', session_link: 'S1'
    });
    expect(v).toEqual({ title: 't', body: 'b', priority: 'urgent', key: 'k1', tags: ['ops'], workspaceLink: 'W1', sessionLink: 'S1' });
  });
  it('rejects a missing or overlong title, bad priority, overlong body/key', () => {
    expect(() => validatePostInput({})).toThrow(InboxInputError);
    expect(() => validatePostInput({ title: 'x'.repeat(201) })).toThrow(/title/);
    expect(() => validatePostInput({ title: 't', priority: 'meh' })).toThrow(/priority/);
    expect(() => validatePostInput({ title: 't', body: 'x'.repeat(20_001) })).toThrow(/body/);
    expect(() => validatePostInput({ title: 't', key: 'x'.repeat(201) })).toThrow(/key/);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL (module not found)**

Run: `npx vitest run src/main/inbox/inboxCore.test.ts`

- [ ] **Step 4: Write `src/main/inbox/inboxCore.ts`**

```ts
// Pure inbox rules (no electron/DB/fs) — priorities, tag normalization and
// post-input validation. Shared by the store, the IPC layer and the MCP tools.
import type { PostTodoInput, TodoPriority } from '../../preload/inboxTypes.js';

export const PRIORITIES: readonly TodoPriority[] = ['low', 'normal', 'high', 'urgent'];

export function priorityRank(p: TodoPriority): number {
  return PRIORITIES.indexOf(p);
}

export function maxPriority(a: TodoPriority, b: TodoPriority): TodoPriority {
  return priorityRank(a) >= priorityRank(b) ? a : b;
}

export function isPriority(v: unknown): v is TodoPriority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
}

const TAG_RE = /^[a-z0-9._-]{1,40}$/;
export const MAX_TAGS = 10;

export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return TAG_RE.test(t) ? t : null;
}

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const t = normalizeTag(r);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/** Thrown for caller-fixable input problems; the message is shown to the caller. */
export class InboxInputError extends Error {}

const LIMITS = { title: 200, body: 20_000, key: 200, link: 100 } as const;

function optString(raw: Record<string, unknown>, names: string[], field: string, max: number): string | undefined {
  for (const n of names) {
    const v = raw[n];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new InboxInputError(`${field} must be a string`);
    if (v.length > max) throw new InboxInputError(`${field} is longer than ${max} characters`);
    return v;
  }
  return undefined;
}

/** Validate a post from the user (camelCase) or the MCP tool (snake_case). */
export function validatePostInput(raw: Record<string, unknown>): PostTodoInput {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) throw new InboxInputError('title is required');
  if (title.length > LIMITS.title) throw new InboxInputError(`title is longer than ${LIMITS.title} characters`);
  const priority = raw.priority === undefined ? 'normal' : raw.priority;
  if (!isPriority(priority)) throw new InboxInputError('priority must be one of low, normal, high, urgent');
  const out: PostTodoInput = { title, priority, tags: normalizeTags(raw.tags) };
  const body = optString(raw, ['body'], 'body', LIMITS.body);
  if (body !== undefined) out.body = body;
  const key = optString(raw, ['key'], 'key', LIMITS.key);
  if (key !== undefined && key.trim()) out.key = key.trim();
  const ws = optString(raw, ['workspaceLink', 'workspace_link'], 'workspace_link', LIMITS.link);
  if (ws) out.workspaceLink = ws;
  const sess = optString(raw, ['sessionLink', 'session_link'], 'session_link', LIMITS.link);
  if (sess) out.sessionLink = sess;
  return out;
}
```

- [ ] **Step 5: Run — expect PASS.** `npx vitest run src/main/inbox/inboxCore.test.ts`

- [ ] **Step 6: Commit** — `git add src/preload/inboxTypes.ts src/main/inbox/inboxCore*.ts && git commit -m "feat(inbox): shared types and pure core (#407)"`

---

### Task 2: `InboxStore` (inbox.db)

**Files:**
- Create: `src/main/inbox/inboxDb.ts`
- Test: `src/main/inbox/inboxDb.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `maxPriority`, `normalizeTags`, `normalizeTag`, `isPriority`.
- Produces: `class InboxStore { static open(dir: string): InboxStore; static memory(): InboxStore; post(source: TodoSource, input: PostTodoInput, now?: number): { todo: Todo; action: 'created'|'updated'|'reopened' }; update(actor: TodoSource, id: string, patch: UpdateTodoPatch, now?: number): Todo; get(id: string): Todo | null; events(id: string): TodoEvent[]; list(filter?: TodoFilter): Todo[]; counts(): InboxCounts; close(): void }`, `INBOX_SCHEMA_VERSION = 1`, `newId(now?)`.

- [ ] **Step 1: Write the failing test `src/main/inbox/inboxDb.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { InboxStore, INBOX_SCHEMA_VERSION } from './inboxDb.js';

const WS = { kind: 'workspace', id: 'W1' } as const;
const USER = { kind: 'user', id: null } as const;
let store: InboxStore;
afterEach(() => store?.close());

describe('InboxStore.post', () => {
  it('creates a todo with defaults and a created event', () => {
    store = InboxStore.memory();
    const { todo, action } = store.post(WS, { title: 'Disk full', tags: ['ops'] }, 1000);
    expect(action).toBe('created');
    expect(todo).toMatchObject({
      title: 'Disk full', status: 'open', priority: 'normal', source: WS, seenCount: 1,
      recurred: false, tags: ['ops'], createdAt: 1000, firstSeenAt: 1000, lastSeenAt: 1000, closedAt: null
    });
    expect(todo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.events(todo.id).map((e) => e.kind)).toEqual(['created']);
  });

  it('dedupes by key per source: bumps seen, keeps max priority, unions tags, replaces body', () => {
    store = InboxStore.memory();
    const a = store.post(WS, { title: '5xx', key: 'k', priority: 'urgent', tags: ['ops'], body: 'one' }, 1000);
    const b = store.post(WS, { title: '5xx again', key: 'k', priority: 'low', tags: ['prod'], body: 'two' }, 2000);
    expect(b.action).toBe('updated');
    expect(b.todo.id).toBe(a.todo.id);
    expect(b.todo).toMatchObject({ seenCount: 2, priority: 'urgent', lastSeenAt: 2000, body: 'two', title: '5xx' });
    expect(b.todo.tags.sort()).toEqual(['ops', 'prod']);
    expect(store.events(a.todo.id).map((e) => e.kind)).toEqual(['created', 'seen']);
  });

  it('the same key from a different source is a different todo', () => {
    store = InboxStore.memory();
    const a = store.post(WS, { title: 'x', key: 'k' });
    const b = store.post({ kind: 'workspace', id: 'W2' }, { title: 'x', key: 'k' });
    expect(b.action).toBe('created');
    expect(b.todo.id).not.toBe(a.todo.id);
  });

  it('reopens a done or dismissed todo when its key recurs', () => {
    store = InboxStore.memory();
    const { todo } = store.post(WS, { title: 'x', key: 'k' }, 1000);
    store.update(USER, todo.id, { status: 'done' }, 1500);
    const r = store.post(WS, { title: 'x', key: 'k' }, 2000);
    expect(r.action).toBe('reopened');
    expect(r.todo).toMatchObject({ status: 'open', recurred: true, closedAt: null, seenCount: 2 });
    store.update(USER, todo.id, { status: 'dismissed' }, 2500);
    expect(store.post(WS, { title: 'x', key: 'k' }, 3000).action).toBe('reopened');
    expect(store.events(todo.id).map((e) => e.kind)).toEqual(['created', 'status', 'reopened', 'status', 'reopened']);
  });

  it('posts without a key never dedupe', () => {
    store = InboxStore.memory();
    store.post(WS, { title: 'x' });
    store.post(WS, { title: 'x' });
    expect(store.list()).toHaveLength(2);
  });
});

describe('InboxStore.update', () => {
  it('applies status, priority, title, tags and body append with events', () => {
    store = InboxStore.memory();
    const { todo } = store.post(WS, { title: 'x', tags: ['a'], body: 'hello' }, 1000);
    const u = store.update(USER, todo.id, {
      status: 'done', priority: 'high', title: 'y', tagsAdd: ['B'], tagsRemove: ['a'], bodyAppend: 'more'
    }, 2000);
    expect(u).toMatchObject({ status: 'done', priority: 'high', title: 'y', tags: ['b'], closedAt: 2000, body: 'hello\n\nmore' });
    expect(store.events(todo.id).map((e) => e.kind)).toEqual(
      ['created', 'status', 'priority', 'title', 'tag_add', 'tag_remove', 'body_append']
    );
    expect(store.update(USER, todo.id, { status: 'open' }, 3000).closedAt).toBeNull();
  });
  it('throws for an unknown id', () => {
    store = InboxStore.memory();
    expect(() => store.update(USER, 'nope', { status: 'done' })).toThrow(/not found/);
  });
});

describe('InboxStore.list / counts', () => {
  it('filters by status, tags and visibility; orders by priority then recency', () => {
    store = InboxStore.memory();
    store.post(WS, { title: 'low', priority: 'low', tags: ['ops'] }, 1);
    store.post(WS, { title: 'urgent', priority: 'urgent' }, 2);
    store.post({ kind: 'workspace', id: 'W2' }, { title: 'other', workspaceLink: 'W1' }, 3);
    store.post({ kind: 'workspace', id: 'W2' }, { title: 'hidden' }, 4);
    const done = store.post(USER, { title: 'done' }, 5).todo;
    store.update(USER, done.id, { status: 'done' });
    expect(store.list().map((t) => t.title)).toEqual(['urgent', 'hidden', 'other', 'low']);
    expect(store.list({ status: 'done' }).map((t) => t.title)).toEqual(['done']);
    expect(store.list({ status: 'all' })).toHaveLength(5);
    expect(store.list({ tags: ['ops'] }).map((t) => t.title)).toEqual(['low']);
    expect(store.list({ visibleTo: 'W1' }).map((t) => t.title).sort()).toEqual(['low', 'other', 'urgent']);
    expect(store.list({ limit: 1 })).toHaveLength(1);
    expect(store.counts()).toEqual({ open: 4, urgent: 1, high: 0 });
  });
});

describe('InboxStore.open', () => {
  it('creates inbox.db with WAL and the schema version', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    store = InboxStore.open(dir);
    store.post(USER, { title: 'persist me' });
    store.close();
    store = InboxStore.open(dir);
    expect(store.list().map((t) => t.title)).toEqual(['persist me']);
    const raw = new Database(path.join(dir, 'inbox.db'), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(INBOX_SCHEMA_VERSION);
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
  });
  it('backs up an existing older database before migrating', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    const old = new Database(path.join(dir, 'inbox.db'));
    old.exec('CREATE TABLE legacy (x)');
    old.close();
    store = InboxStore.open(dir);
    expect(readdirSync(dir).some((f) => /^inbox\.db\.bak-v0-\d+$/.test(f))).toBe(true);
  });
  it('does not back up a brand-new database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    store = InboxStore.open(dir);
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false);
    writeFileSync(path.join(dir, 'unused'), '');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/inbox/inboxDb.test.ts`

- [ ] **Step 3: Write `src/main/inbox/inboxDb.ts`**

```ts
// Authoritative inbox store at <userData>/inbox.db (#407). Unlike state.db this
// is NOT a rebuildable cache — so migrations are versioned and every migration
// of an existing file is preceded by a timestamped backup copy.
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type {
  InboxCounts, PostTodoInput, Todo, TodoEvent, TodoEventKind, TodoFilter, TodoSource, UpdateTodoPatch
} from '../../preload/inboxTypes.js';
import { isPriority, maxPriority, normalizeTag, normalizeTags, MAX_TAGS } from './inboxCore.js';

export const INBOX_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL CHECK (status IN ('open','done','dismissed')),
      priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('user','workspace','automation')),
      source_id TEXT,
      source_run_id TEXT,
      via_workspace TEXT,
      dedupe_key TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      recurred INTEGER NOT NULL DEFAULT 0,
      workspace_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE UNIQUE INDEX todos_dedupe ON todos (source_kind, IFNULL(source_id, ''), dedupe_key)
      WHERE dedupe_key IS NOT NULL;
    CREATE INDEX todos_open ON todos (status, priority, last_seen_at);
    CREATE TABLE tags (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (entity_kind, entity_id, tag)
    );
    CREATE TABLE todo_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      run_id TEXT,
      detail TEXT
    );
    CREATE INDEX todo_events_todo ON todo_events (todo_id, id);
  `
};

// Crockford base32 ULID: 10 chars time + 16 chars randomness.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newId(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[Math.floor(Math.random() * 32)];
  return time + rand;
}

interface TodoRow {
  id: string; title: string; body: string | null; status: Todo['status']; priority: Todo['priority'];
  source_kind: TodoSource['kind']; source_id: string | null; source_run_id: string | null;
  via_workspace: string | null; dedupe_key: string | null; seen_count: number; recurred: number;
  workspace_id: string | null; session_id: string | null; created_at: number; updated_at: number;
  first_seen_at: number; last_seen_at: number; closed_at: number | null;
}

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

export class InboxStore {
  private constructor(readonly db: Database.Database) {}

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
    return new InboxStore(db);
  }

  close(): void {
    this.db.close();
  }

  // --- reads --------------------------------------------------------------

  private tagsFor(id: string): string[] {
    return (this.db
      .prepare(`SELECT tag FROM tags WHERE entity_kind = 'todo' AND entity_id = ? ORDER BY tag`)
      .all(id) as Array<{ tag: string }>).map((r) => r.tag);
  }

  private toTodo(r: TodoRow): Todo {
    return {
      id: r.id, title: r.title, body: r.body, status: r.status, priority: r.priority,
      source: { kind: r.source_kind, id: r.source_id }, sourceRunId: r.source_run_id,
      viaWorkspace: r.via_workspace, dedupeKey: r.dedupe_key, seenCount: r.seen_count,
      recurred: r.recurred === 1, workspaceId: r.workspace_id, sessionId: r.session_id,
      tags: this.tagsFor(r.id), createdAt: r.created_at, updatedAt: r.updated_at,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, closedAt: r.closed_at
    };
  }

  get(id: string): Todo | null {
    const r = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
    return r ? this.toTodo(r) : null;
  }

  events(id: string): TodoEvent[] {
    const rows = this.db.prepare('SELECT * FROM todo_events WHERE todo_id = ? ORDER BY id').all(id) as Array<{
      id: number; todo_id: string; ts: number; kind: TodoEventKind; actor_kind: TodoSource['kind'];
      actor_id: string | null; run_id: string | null; detail: string | null;
    }>;
    return rows.map((e) => ({
      id: e.id, todoId: e.todo_id, ts: e.ts, kind: e.kind, actor: { kind: e.actor_kind, id: e.actor_id },
      runId: e.run_id, detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null
    }));
  }

  list(filter: TodoFilter = {}): Todo[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const status = filter.status ?? 'open';
    if (status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (filter.visibleTo) {
      where.push(`((source_kind = 'workspace' AND source_id = ?) OR workspace_id = ? OR via_workspace = ?)`);
      params.push(filter.visibleTo, filter.visibleTo, filter.visibleTo);
    }
    for (const raw of filter.tags ?? []) {
      const t = normalizeTag(raw);
      if (!t) continue;
      where.push(`EXISTS (SELECT 1 FROM tags g WHERE g.entity_kind = 'todo' AND g.entity_id = todos.id AND g.tag = ?)`);
      params.push(t);
    }
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 200)), 500);
    const sql =
      `SELECT * FROM todos ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
      `ORDER BY ${PRIORITY_ORDER}, last_seen_at DESC, id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as TodoRow[]).map((r) => this.toTodo(r));
  }

  counts(): InboxCounts {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS open,
              SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) AS urgent,
              SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) AS high
         FROM todos WHERE status = 'open'`
    ).get() as { open: number; urgent: number | null; high: number | null };
    return { open: r.open, urgent: r.urgent ?? 0, high: r.high ?? 0 };
  }

  // --- writes -------------------------------------------------------------

  private event(todoId: string, ts: number, kind: TodoEventKind, actor: TodoSource, detail?: Record<string, unknown>): void {
    this.db.prepare(
      'INSERT INTO todo_events (todo_id, ts, kind, actor_kind, actor_id, run_id, detail) VALUES (?, ?, ?, ?, ?, NULL, ?)'
    ).run(todoId, ts, kind, actor.kind, actor.id, detail ? JSON.stringify(detail) : null);
  }

  private addTags(id: string, tags: string[]): string[] {
    const existing = this.tagsFor(id);
    const added: string[] = [];
    for (const t of tags) {
      if (existing.length + added.length >= MAX_TAGS) break;
      if (existing.includes(t) || added.includes(t)) continue;
      this.db.prepare(`INSERT OR IGNORE INTO tags (entity_kind, entity_id, tag) VALUES ('todo', ?, ?)`).run(id, t);
      added.push(t);
    }
    return added;
  }

  post(source: TodoSource, input: PostTodoInput, now = Date.now()): { todo: Todo; action: 'created' | 'updated' | 'reopened' } {
    return this.db.transaction(() => {
      const priority = input.priority ?? 'normal';
      const tags = normalizeTags(input.tags ?? []);
      const existing = input.key
        ? (this.db.prepare(
            `SELECT * FROM todos WHERE source_kind = ? AND IFNULL(source_id, '') = ? AND dedupe_key = ?`
          ).get(source.kind, source.id ?? '', input.key) as TodoRow | undefined)
        : undefined;
      if (!existing) {
        const id = newId(now);
        this.db.prepare(
          `INSERT INTO todos (id, title, body, status, priority, source_kind, source_id, dedupe_key,
             workspace_id, session_id, created_at, updated_at, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, input.title, input.body ?? null, priority, source.kind, source.id, input.key ?? null,
          input.workspaceLink ?? null, input.sessionLink ?? null, now, now, now, now);
        this.addTags(id, tags);
        this.event(id, now, 'created', source, { title: input.title, priority });
        return { todo: this.get(id)!, action: 'created' as const };
      }
      const reopen = existing.status !== 'open';
      this.db.prepare(
        `UPDATE todos SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ?, priority = ?,
           body = COALESCE(?, body), status = 'open',
           recurred = CASE WHEN ? THEN 1 ELSE recurred END,
           closed_at = CASE WHEN ? THEN NULL ELSE closed_at END
         WHERE id = ?`
      ).run(now, now, maxPriority(existing.priority, priority), input.body ?? null, reopen ? 1 : 0, reopen ? 1 : 0, existing.id);
      this.addTags(existing.id, tags);
      this.event(existing.id, now, reopen ? 'reopened' : 'seen', source,
        { priority, ...(input.body !== undefined ? { body: input.body } : {}), ...(reopen ? { from: existing.status } : {}) });
      return { todo: this.get(existing.id)!, action: reopen ? ('reopened' as const) : ('updated' as const) };
    })();
  }

  update(actor: TodoSource, id: string, patch: UpdateTodoPatch, now = Date.now()): Todo {
    return this.db.transaction(() => {
      const cur = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
      if (!cur) throw new Error(`todo ${id} not found`);
      if (patch.status && patch.status !== cur.status) {
        this.db.prepare('UPDATE todos SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
          .run(patch.status, patch.status === 'open' ? null : now, now, id);
        this.event(id, now, 'status', actor, { from: cur.status, to: patch.status });
      }
      if (patch.priority && isPriority(patch.priority) && patch.priority !== cur.priority) {
        this.db.prepare('UPDATE todos SET priority = ?, updated_at = ? WHERE id = ?').run(patch.priority, now, id);
        this.event(id, now, 'priority', actor, { from: cur.priority, to: patch.priority });
      }
      const title = patch.title?.trim();
      if (title && title !== cur.title) {
        this.db.prepare('UPDATE todos SET title = ?, updated_at = ? WHERE id = ?').run(title.slice(0, 200), now, id);
        this.event(id, now, 'title', actor, { from: cur.title, to: title });
      }
      const added = this.addTags(id, normalizeTags(patch.tagsAdd ?? []));
      if (added.length) this.event(id, now, 'tag_add', actor, { tags: added });
      const removed: string[] = [];
      for (const t of normalizeTags(patch.tagsRemove ?? [])) {
        const r = this.db.prepare(`DELETE FROM tags WHERE entity_kind = 'todo' AND entity_id = ? AND tag = ?`).run(id, t);
        if (r.changes) removed.push(t);
      }
      if (removed.length) this.event(id, now, 'tag_remove', actor, { tags: removed });
      if (patch.bodyAppend && patch.bodyAppend.trim()) {
        const text = patch.bodyAppend.slice(0, 20_000);
        this.db.prepare(
          `UPDATE todos SET body = CASE WHEN body IS NULL OR body = '' THEN ? ELSE body || char(10) || char(10) || ? END,
             updated_at = ? WHERE id = ?`
        ).run(text, text, now, id);
        this.event(id, now, 'body_append', actor, { text });
      }
      if (added.length || removed.length) this.db.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(now, id);
      return this.get(id)!;
    })();
  }
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/main/inbox/inboxDb.test.ts`

- [ ] **Step 5: Commit** — `git commit -m "feat(inbox): authoritative inbox.db store with dedupe/reopen (#407)"`

---

### Task 3: Policy (permissions, rate limit, visibility)

**Files:**
- Create: `src/main/inbox/inboxPolicy.ts`
- Test: `src/main/inbox/inboxPolicy.test.ts`

**Interfaces:**
- Consumes: `InboxConfig`, `Todo`.
- Produces: `DEFAULT_MAX_POSTS_PER_HOUR = 60`; `canPost(cfg?: InboxConfig): boolean`; `postLimit(cfg?: InboxConfig): number`; `class PostRateLimiter { take(workspaceId: string, max: number, now?: number): { ok: true } | { ok: false; retryAfterMs: number } }`; `canUpdate(callerId: string, todo: Todo): boolean`; `canSee(callerId: string, todo: Todo, cfg?: InboxConfig): boolean`; `sanitizeInboxConfig(v: unknown): InboxConfig | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { canPost, postLimit, PostRateLimiter, canUpdate, canSee, sanitizeInboxConfig, DEFAULT_MAX_POSTS_PER_HOUR } from './inboxPolicy.js';
import type { Todo } from '../../preload/inboxTypes.js';

const todo = (over: Partial<Todo>): Todo => ({
  id: 'T', title: 't', body: null, status: 'open', priority: 'normal', source: { kind: 'workspace', id: 'W1' },
  sourceRunId: null, viaWorkspace: null, dedupeKey: null, seenCount: 1, recurred: false, workspaceId: null,
  sessionId: null, tags: [], createdAt: 0, updatedAt: 0, firstSeenAt: 0, lastSeenAt: 0, closedAt: null, ...over
});

describe('post permission', () => {
  it('defaults to allowed with a 60/hour cap', () => {
    expect(canPost(undefined)).toBe(true);
    expect(postLimit(undefined)).toBe(DEFAULT_MAX_POSTS_PER_HOUR);
    expect(canPost({ canPost: false })).toBe(false);
    expect(postLimit({ maxPostsPerHour: 5 })).toBe(5);
  });
});

describe('PostRateLimiter', () => {
  it('rejects over the cap within an hour and reports when to retry', () => {
    const rl = new PostRateLimiter();
    expect(rl.take('W', 2, 0)).toEqual({ ok: true });
    expect(rl.take('W', 2, 1000)).toEqual({ ok: true });
    expect(rl.take('W', 2, 2000)).toEqual({ ok: false, retryAfterMs: 3_600_000 - 2000 });
    expect(rl.take('OTHER', 2, 2000)).toEqual({ ok: true });
    expect(rl.take('W', 2, 3_600_001)).toEqual({ ok: true });
  });
});

describe('visibility and update rights', () => {
  it('a workspace may update only what it sourced or did the work for', () => {
    expect(canUpdate('W1', todo({}))).toBe(true);
    expect(canUpdate('W2', todo({}))).toBe(false);
    expect(canUpdate('W2', todo({ viaWorkspace: 'W2' }))).toBe(true);
    expect(canUpdate('W2', todo({ workspaceId: 'W2' }))).toBe(false);
  });
  it('a workspace sees own, linked and via todos; everything with canReadAll', () => {
    expect(canSee('W2', todo({ workspaceId: 'W2' }))).toBe(true);
    expect(canSee('W2', todo({}))).toBe(false);
    expect(canSee('W2', todo({}), { canReadAll: true })).toBe(true);
  });
});

describe('sanitizeInboxConfig', () => {
  it('keeps valid fields, drops junk, returns undefined when empty', () => {
    expect(sanitizeInboxConfig({ canPost: false, maxPostsPerHour: 10, canReadAll: true, x: 1 }))
      .toEqual({ canPost: false, maxPostsPerHour: 10, canReadAll: true });
    expect(sanitizeInboxConfig({ canPost: 'no', maxPostsPerHour: -3 })).toBeUndefined();
    expect(sanitizeInboxConfig({ maxPostsPerHour: 99999 })).toEqual({ maxPostsPerHour: 10000 });
    expect(sanitizeInboxConfig(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/inbox/inboxPolicy.test.ts`

- [ ] **Step 3: Write `src/main/inbox/inboxPolicy.ts`**

```ts
// Pure inbox authorization rules (#407): who may post, how often, and which
// todos a workspace may see or change. The caller id is always host-stamped.
import type { InboxConfig, Todo } from '../../preload/inboxTypes.js';

export const DEFAULT_MAX_POSTS_PER_HOUR = 60;
const HOUR = 3_600_000;
const MAX_CAP = 10_000;

export function canPost(cfg?: InboxConfig): boolean {
  return cfg?.canPost !== false;
}

export function postLimit(cfg?: InboxConfig): number {
  return cfg?.maxPostsPerHour ?? DEFAULT_MAX_POSTS_PER_HOUR;
}

/** Sliding one-hour window per workspace. Updates by dedupe count as posts. */
export class PostRateLimiter {
  private hits = new Map<string, number[]>();

  take(workspaceId: string, max: number, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const recent = (this.hits.get(workspaceId) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= max) {
      this.hits.set(workspaceId, recent);
      return { ok: false, retryAfterMs: HOUR - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(workspaceId, recent);
    return { ok: true };
  }
}

export function canUpdate(callerId: string, t: Todo): boolean {
  return (t.source.kind === 'workspace' && t.source.id === callerId) || t.viaWorkspace === callerId;
}

export function canSee(callerId: string, t: Todo, cfg?: InboxConfig): boolean {
  return cfg?.canReadAll === true || canUpdate(callerId, t) || t.workspaceId === callerId;
}

/** Manifest sanitizer — the manifest reader is an allowlist (see workspaces.ts). */
export function sanitizeInboxConfig(v: unknown): InboxConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: InboxConfig = {};
  if (typeof o.canPost === 'boolean') out.canPost = o.canPost;
  if (typeof o.maxPostsPerHour === 'number' && Number.isFinite(o.maxPostsPerHour) && o.maxPostsPerHour >= 1) {
    out.maxPostsPerHour = Math.min(Math.floor(o.maxPostsPerHour), MAX_CAP);
  }
  if (typeof o.canReadAll === 'boolean') out.canReadAll = o.canReadAll;
  return Object.keys(out).length ? out : undefined;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(inbox): post/visibility policy and rate limiter (#407)"`

---

### Task 4: Manifest `inbox` block

**Files:**
- Modify: `src/main/workspaces.ts` (`WorkspaceSpec`, the `readWorkspaceManifest` allowlist constructor), `src/main/workspaceMerge.ts` (carry `inbox`)
- Test: `src/main/workspaces.test.ts` (append)

**Interfaces:**
- Consumes: `sanitizeInboxConfig`, `InboxConfig`.
- Produces: `WorkspaceSpec.inbox?: InboxConfig`; the listed workspace carries `inbox`.

- [ ] **Step 1: Append a failing round-trip test to `src/main/workspaces.test.ts`.** Follow the existing round-trip test pattern in that file (it writes a manifest, reads it back with `readWorkspaceManifest`). Add:

```ts
it('round-trips the inbox block and sanitizes it (#407)', async () => {
  const id = await seedManifestForTest({ inbox: { canPost: false, maxPostsPerHour: 5, junk: 1 } });
  const m = await readWorkspaceManifest(id);
  expect(m?.inbox).toEqual({ canPost: false, maxPostsPerHour: 5 });
});
```

Use whatever seeding helper the file already uses for the `accessibility` round-trip test (find it with `grep -n "accessibility" src/main/workspaces.test.ts`); name it accordingly instead of `seedManifestForTest`.

- [ ] **Step 2: Run — expect FAIL** (`inbox` undefined).
- [ ] **Step 3: Implement.** In `workspaces.ts` add `import type { InboxConfig } from '../preload/inboxTypes.js';` and `import { sanitizeInboxConfig } from './inbox/inboxPolicy.js';`, add to `WorkspaceSpec` after `accessibility?`:

```ts
  /** Host-private inbox permissions (#407): can post, hourly cap, read-all. */
  inbox?: InboxConfig;
```

and in the allowlist constructor after `accessibility: sanitizeAccessibility(parsed.accessibility),`:

```ts
      inbox: sanitizeInboxConfig(parsed.inbox),
```

In `workspaceMerge.ts` after `accessibility: m?.accessibility,` add `inbox: m?.inbox,`.
- [ ] **Step 4: Run** `npx vitest run src/main/workspaces.test.ts src/main/workspaceMerge.test.ts` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(inbox): host-private inbox block in the workspace manifest (#407)"`

---

### Task 5: Service — IPC + MCP handlers + broadcast

**Files:**
- Create: `src/main/inbox/inboxBroadcast.ts`, `src/main/inbox/inboxService.ts`
- Modify: `src/main/mcpServer.ts`, `src/main/index.ts`
- Test: `src/main/inbox/inboxService.test.ts`, `src/main/mcpServer.test.ts` (append tool-surface assertions)

**Interfaces:**
- Consumes: `InboxStore`, policy, `readWorkspaceManifest`.
- Produces: `broadcastInboxChanged(counts, targets)`; `createInboxService(store, deps: { manifest(id): Promise<{ inbox?: InboxConfig } | null>; notifyChanged(): void; now?: () => number })` returning `{ mcp: InboxHandlers; ipc: { list, get, create, update, counts } }`; `registerInboxIpc(store)` (wires ipcMain + broadcast + `setInboxHandlers`); in `mcpServer.ts`: `interface InboxHandlers { post(callerId, args): Promise<unknown>; update(callerId, args): Promise<unknown>; list(callerId, args): Promise<unknown> }`, `setInboxHandlers(h)`.

- [ ] **Step 1: Write the failing test `src/main/inbox/inboxService.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { InboxStore } from './inboxDb.js';
import { createInboxService } from './inboxService.js';
import type { InboxConfig } from '../../preload/inboxTypes.js';

function setup(manifests: Record<string, { inbox?: InboxConfig }>) {
  const store = InboxStore.memory();
  let changed = 0;
  let t = 1000;
  const svc = createInboxService(store, {
    manifest: async (id) => manifests[id] ?? null,
    notifyChanged: () => { changed++; },
    now: () => t
  });
  return { store, svc, changed: () => changed, tick: (ms: number) => { t += ms; } };
}

describe('inbox MCP handlers', () => {
  it('post_todo creates, dedupes and reports the action; links the caller by default', async () => {
    const { svc, changed } = setup({ W1: {} });
    const a = (await svc.mcp.post('W1', { title: 'disk 91%', key: 'disk', priority: 'high' })) as { id: string; action: string };
    expect(a.action).toBe('created');
    const b = (await svc.mcp.post('W1', { title: 'disk 92%', key: 'disk' })) as { id: string; action: string };
    expect(b).toMatchObject({ id: a.id, action: 'updated' });
    expect(changed()).toBe(2);
    const list = (await svc.mcp.list('W1', {})) as Array<{ id: string; workspaceId: string; seenCount: number }>;
    expect(list[0]).toMatchObject({ id: a.id, workspaceId: 'W1', seenCount: 2 });
  });

  it('rejects unknown callers, disabled posting, and posts over the hourly cap', async () => {
    const { svc } = setup({ OFF: { inbox: { canPost: false } }, CAP: { inbox: { maxPostsPerHour: 2 } } });
    await expect(svc.mcp.post('NOPE', { title: 'x' })).rejects.toThrow(/unknown workspace/);
    await expect(svc.mcp.post('OFF', { title: 'x' })).rejects.toThrow(/not allowed to post/);
    await svc.mcp.post('CAP', { title: '1' });
    await svc.mcp.post('CAP', { title: '2' });
    await expect(svc.mcp.post('CAP', { title: '3' })).rejects.toThrow(/post limit \(2\/hour\).*retryAfterMs=\d+/);
  });

  it('update_todo is limited to the caller’s own todos; list is scoped', async () => {
    const { svc } = setup({ W1: {}, W2: {}, ALL: { inbox: { canReadAll: true } } });
    const { id } = (await svc.mcp.post('W1', { title: 'mine' })) as { id: string };
    await expect(svc.mcp.update('W2', { id, status: 'done' })).rejects.toThrow(/not permitted/);
    const u = (await svc.mcp.update('W1', { id, status: 'done', tags_add: ['ops'] })) as { status: string; tags: string[] };
    expect(u).toMatchObject({ status: 'done', tags: ['ops'] });
    expect(await svc.mcp.list('W2', { status: 'all' })).toEqual([]);
    expect((await svc.mcp.list('ALL', { status: 'all' }) as unknown[]).length).toBe(1);
    await expect(svc.mcp.update('W1', { id: 'missing' })).rejects.toThrow(/not found/);
  });
});

describe('inbox IPC handlers', () => {
  it('create posts as the user; update may change anything; counts reflect open items', async () => {
    const { svc } = setup({ W1: {} });
    const t = await svc.ipc.create({ title: 'From me', priority: 'urgent', tags: ['Health'] });
    expect(t).toMatchObject({ source: { kind: 'user', id: null }, priority: 'urgent', tags: ['health'] });
    const ws = (await svc.mcp.post('W1', { title: 'from ws' })) as { id: string };
    await svc.ipc.update(ws.id, { status: 'dismissed' });
    expect(await svc.ipc.counts()).toEqual({ open: 1, urgent: 1, high: 0 });
    const detail = await svc.ipc.get(t.id);
    expect(detail?.events.map((e) => e.kind)).toEqual(['created']);
    expect(await svc.ipc.get('missing')).toBeNull();
    expect((await svc.ipc.list({ status: 'all' })).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `src/main/inbox/inboxBroadcast.ts`**

```ts
// Resilient `inbox:changed` fan-out — mirrors inputWaitBroadcast.ts. Pure.
import type { BroadcastTarget } from '../mcpStatusBroadcast.js';
import type { InboxCounts } from '../../preload/inboxTypes.js';

export function broadcastInboxChanged(counts: InboxCounts, targets: readonly BroadcastTarget[]): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('inbox:changed', { counts });
    } catch {
      // a window mid-teardown can throw; never let a broadcast break a write
    }
  }
}
```

- [ ] **Step 4: Write `src/main/inbox/inboxService.ts`**

```ts
// Inbox effects shared by the renderer IPC and the workspace MCP tools (#407).
// The MCP caller id is host-stamped by mcpServer (ambient socket identity).
import type { InboxConfig, Todo, TodoEvent, TodoFilter, UpdateTodoPatch, InboxCounts } from '../../preload/inboxTypes.js';
import { InboxStore } from './inboxDb.js';
import { validatePostInput, isPriority, InboxInputError } from './inboxCore.js';
import { canPost, postLimit, PostRateLimiter, canUpdate, canSee } from './inboxPolicy.js';

export interface InboxServiceDeps {
  manifest(id: string): Promise<{ inbox?: InboxConfig } | null>;
  notifyChanged(): void;
  now?: () => number;
  onPostRejected?(workspaceId: string, reason: string): void;
}

const STATUSES = new Set(['open', 'done', 'dismissed']);

function toPatch(a: Record<string, unknown>): UpdateTodoPatch {
  const p: UpdateTodoPatch = {};
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !STATUSES.has(a.status)) throw new InboxInputError('status must be open, done or dismissed');
    p.status = a.status as UpdateTodoPatch['status'];
  }
  if (a.priority !== undefined) {
    if (!isPriority(a.priority)) throw new InboxInputError('priority must be one of low, normal, high, urgent');
    p.priority = a.priority;
  }
  if (typeof a.title === 'string') p.title = a.title;
  const add = a.tags_add ?? a.tagsAdd;
  const rm = a.tags_remove ?? a.tagsRemove;
  if (Array.isArray(add)) p.tagsAdd = add as string[];
  if (Array.isArray(rm)) p.tagsRemove = rm as string[];
  const body = a.body_append ?? a.bodyAppend;
  if (typeof body === 'string') p.bodyAppend = body;
  return p;
}

function toFilter(a: Record<string, unknown>): TodoFilter {
  const f: TodoFilter = {};
  if (typeof a.status === 'string' && (STATUSES.has(a.status) || a.status === 'all')) f.status = a.status as TodoFilter['status'];
  if (Array.isArray(a.tags)) f.tags = a.tags.filter((t): t is string => typeof t === 'string');
  if (typeof a.limit === 'number') f.limit = a.limit;
  return f;
}

export function createInboxService(store: InboxStore, deps: InboxServiceDeps) {
  const limiter = new PostRateLimiter();
  const now = deps.now ?? Date.now;

  async function callerConfig(callerId: string): Promise<InboxConfig | undefined> {
    const m = await deps.manifest(callerId);
    if (!m) throw new Error(`unknown workspace ${callerId}`);
    return m.inbox;
  }

  const mcp = {
    async post(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      const cfg = await callerConfig(callerId);
      if (!canPost(cfg)) {
        deps.onPostRejected?.(callerId, 'posting disabled');
        throw new Error('this workspace is not allowed to post to the inbox (Edit workspace › Inbox & automations)');
      }
      const input = validatePostInput(args);
      const max = postLimit(cfg);
      const gate = limiter.take(callerId, max, now());
      if (!gate.ok) {
        deps.onPostRejected?.(callerId, `post limit ${max}/hour`);
        throw new Error(`post limit (${max}/hour) reached; retryAfterMs=${gate.retryAfterMs}`);
      }
      const { todo, action } = store.post(
        { kind: 'workspace', id: callerId },
        { ...input, workspaceLink: input.workspaceLink ?? callerId },
        now()
      );
      deps.notifyChanged();
      return { id: todo.id, action, status: todo.status, seenCount: todo.seenCount };
    },
    async update(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      await callerConfig(callerId);
      const id = typeof args.id === 'string' ? args.id : '';
      const cur = id ? store.get(id) : null;
      if (!cur) throw new Error(`todo ${id || '(missing id)'} not found`);
      if (!canUpdate(callerId, cur)) throw new Error('not permitted: a workspace can only update todos it posted');
      const todo = store.update({ kind: 'workspace', id: callerId }, id, toPatch(args), now());
      deps.notifyChanged();
      return todo;
    },
    async list(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      const cfg = await callerConfig(callerId);
      const f = toFilter(args);
      const todos = store.list({ ...f, limit: Math.min(f.limit ?? 50, 200), ...(cfg?.canReadAll ? {} : { visibleTo: callerId }) });
      return todos.filter((t) => canSee(callerId, t, cfg));
    }
  };

  const ipc = {
    async list(filter: TodoFilter = {}): Promise<Todo[]> {
      return store.list(filter);
    },
    async get(id: string): Promise<{ todo: Todo; events: TodoEvent[] } | null> {
      const todo = store.get(id);
      return todo ? { todo, events: store.events(id) } : null;
    },
    async create(input: Record<string, unknown>): Promise<Todo> {
      const { todo } = store.post({ kind: 'user', id: null }, validatePostInput(input), now());
      deps.notifyChanged();
      return todo;
    },
    async update(id: string, patch: Record<string, unknown>): Promise<Todo> {
      const todo = store.update({ kind: 'user', id: null }, id, toPatch(patch), now());
      deps.notifyChanged();
      return todo;
    },
    async counts(): Promise<InboxCounts> {
      return store.counts();
    }
  };

  return { mcp, ipc };
}
```

- [ ] **Step 5: Run the service test — expect PASS.** `npx vitest run src/main/inbox/inboxService.test.ts`

- [ ] **Step 6: MCP wiring in `src/main/mcpServer.ts`.** After the `setSessionMappingHandler` block add:

```ts
/** Injected by inboxService (#407): host-mediated inbox writes/reads. callerId is
 *  the accepting listener's workspace id — never taken from the wire. */
export interface InboxHandlers {
  post(callerId: string, args: Record<string, unknown>): Promise<unknown>;
  update(callerId: string, args: Record<string, unknown>): Promise<unknown>;
  list(callerId: string, args: Record<string, unknown>): Promise<unknown>;
}
let inboxHandlers: InboxHandlers | null = null;
export function setInboxHandlers(h: InboxHandlers | null): void {
  inboxHandlers = h;
}
```

and append three tools to `TOOLS` (before `get_config`):

```ts
  {
    name: 'post_todo',
    description:
      'Post a todo to the user\'s inbox (claude-fleet). Use for things the user should act on. ' +
      'Args: title (required, ≤200), body (markdown), priority (low|normal|high|urgent, default normal), ' +
      'key (dedupe key: posting the same key again updates that todo — bumps its seen count — and reopens it if it was closed), ' +
      'tags (array), session_link. Returns {id, action: created|updated|reopened}. Rate-limited per workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, body: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
        session_link: { type: 'string' }
      },
      required: ['title']
    },
    run: (_db, a, ctx) => {
      if (!inboxHandlers) throw new Error('the inbox is unavailable');
      return inboxHandlers.post(ctx.callerId, a);
    }
  },
  {
    name: 'update_todo',
    description:
      'Update a todo THIS workspace posted. Args: id (required), status (open|done|dismissed), priority, ' +
      'tags_add, tags_remove, body_append (appended under the existing body).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'dismissed'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        tags_add: { type: 'array', items: { type: 'string' } },
        tags_remove: { type: 'array', items: { type: 'string' } },
        body_append: { type: 'string' }
      },
      required: ['id']
    },
    run: (_db, a, ctx) => {
      if (!inboxHandlers) throw new Error('the inbox is unavailable');
      return inboxHandlers.update(ctx.callerId, a);
    }
  },
  {
    name: 'list_todos',
    description:
      'List inbox todos this workspace can see (ones it posted or that are linked to it). ' +
      'Args: status (open|done|dismissed|all, default open), tags (all must match), limit (default 50, max 200).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'dismissed', 'all'] },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' }
      }
    },
    run: (_db, a, ctx) => {
      if (!inboxHandlers) throw new Error('the inbox is unavailable');
      return inboxHandlers.list(ctx.callerId, a);
    }
  },
```

- [ ] **Step 7: Append to `src/main/mcpServer.test.ts`** (follow the file's existing `callTool` test setup, which opens a temp state.db with `startMcpServer`/the test DB helper — find it with `grep -n "callTool(" src/main/mcpServer.test.ts | head -3` and reuse that helper):

```ts
describe('inbox tools (#407)', () => {
  it('lists post_todo / update_todo / list_todos and proxies to the injected handlers with the host caller id', async () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['post_todo', 'update_todo', 'list_todos']));
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    setInboxHandlers({
      post: async (c, a) => { calls.push(['post', c, a]); return { id: 'T1', action: 'created' }; },
      update: async (c, a) => { calls.push(['update', c, a]); return {}; },
      list: async (c, a) => { calls.push(['list', c, a]); return []; }
    });
    try {
      const res = (await callTool({ name: 'post_todo', arguments: { title: 'x' } }, WS_A)) as { content: Array<{ text: string }> };
      expect(JSON.parse(res.content[0].text)).toEqual({ id: 'T1', action: 'created' });
      expect(calls[0]).toEqual(['post', WS_A, { title: 'x' }]);
    } finally {
      setInboxHandlers(null);
    }
    const off = (await callTool({ name: 'list_todos', arguments: {} }, WS_A)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(off.isError).toBe(true);
    expect(off.content[0].text).toMatch(/inbox is unavailable/);
  });
});
```

Import `setInboxHandlers` and `TOOLS` at the top of the test file if not already imported. `WS_A` is the file's existing workspace-id constant.

- [ ] **Step 8: Wire `registerInboxIpc` and startup.** Add to `inboxService.ts`:

```ts
import { BrowserWindow, ipcMain } from 'electron';
import { readWorkspaceManifest } from '../workspaces.js';
import { setInboxHandlers } from '../mcpServer.js';
import { broadcastInboxChanged } from './inboxBroadcast.js';
import { logError } from '../errorLog.js';

/** Register `inbox:*` IPC and the MCP handlers. Called once from index.ts. */
export function registerInboxIpc(store: InboxStore): void {
  const svc = createInboxService(store, {
    manifest: (id) => readWorkspaceManifest(id),
    notifyChanged: () => broadcastInboxChanged(store.counts(), BrowserWindow.getAllWindows()),
    onPostRejected: (workspaceId, reason) =>
      logError({ source: 'main', type: 'inbox-post-rejected', level: 'warn', message: reason, workspaceId })
  });
  setInboxHandlers(svc.mcp);
  ipcMain.handle('inbox:list', (_e, filter?: TodoFilter) => svc.ipc.list(filter ?? {}));
  ipcMain.handle('inbox:get', (_e, id: string) => svc.ipc.get(id));
  ipcMain.handle('inbox:create', (_e, input: Record<string, unknown>) => svc.ipc.create(input ?? {}));
  ipcMain.handle('inbox:update', (_e, id: string, patch: Record<string, unknown>) => svc.ipc.update(id, patch ?? {}));
  ipcMain.handle('inbox:counts', () => svc.ipc.counts());
}
```

Keep `createInboxService` free of electron so its test stays pure: put the electron-importing `registerInboxIpc` in a separate file `src/main/inbox/inboxIpc.ts` (with the imports above plus `import { createInboxService } from './inboxService.js'; import type { InboxStore } from './inboxDb.js'; import type { TodoFilter } from '../../preload/inboxTypes.js';`).

In `src/main/index.ts`: import `{ InboxStore }` from `./inbox/inboxDb.js` and `{ registerInboxIpc }` from `./inbox/inboxIpc.js`; declare `let inboxStore: InboxStore | null = null;` at module scope; after `await ensureBuiltinLoadouts()…` add

```ts
  // Authoritative inbox (#407) — opens in mock AND real mode (state.db is a
  // droppable cache gated on the JSONL watcher; the inbox is neither).
  try {
    inboxStore = InboxStore.open(app.getPath('userData'));
  } catch (e) {
    logError({ source: 'main', type: 'inbox-open-failed', level: 'error', message: String(e) });
  }
```

after `registerIpc({ jsonlWatcher, peerStatusWatcher });` add `if (inboxStore) registerInboxIpc(inboxStore);`, and in `before-quit` add `inboxStore?.close();`.

- [ ] **Step 9: Run** `npx vitest run src/main/inbox src/main/mcpServer.test.ts` and `npm run typecheck:node` — PASS / clean.
- [ ] **Step 10: Commit** — `git commit -m "feat(inbox): IPC + post_todo/update_todo/list_todos MCP tools (#407)"`

---

### Task 6: Preload API

**Files:** Modify `src/preload/index.ts`.

**Interfaces:** Produces `window.api.inbox.{ list(filter?), get(id), create(input), update(id, patch), counts(), onChanged(cb) }` and re-exports the inbox types.

- [ ] **Step 1:** Add near the top: `export type * from './inboxTypes';` (and `import type { Todo, TodoEvent, TodoFilter, InboxCounts, PostTodoInput, UpdateTodoPatch } from './inboxTypes';`). Add to `api` (after `committee`):

```ts
  inbox: {
    list: (filter?: TodoFilter): Promise<Todo[]> => ipcRenderer.invoke('inbox:list', filter),
    get: (id: string): Promise<{ todo: Todo; events: TodoEvent[] } | null> => ipcRenderer.invoke('inbox:get', id),
    create: (input: PostTodoInput): Promise<Todo> => ipcRenderer.invoke('inbox:create', input),
    update: (id: string, patch: UpdateTodoPatch): Promise<Todo> => ipcRenderer.invoke('inbox:update', id, patch),
    counts: (): Promise<InboxCounts> => ipcRenderer.invoke('inbox:counts'),
    onChanged: (cb: (counts: InboxCounts) => void): (() => void) => {
      const channel = 'inbox:changed';
      const handler = (_e: IpcRendererEvent, payload: { counts: InboxCounts }): void => cb(payload.counts);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  },
```

(If `export type *` is rejected by the TS version, use explicit `export type { Todo, … } from './inboxTypes';`.)

- [ ] **Step 2:** `npm run typecheck:node && npm run typecheck:web` (separately) — clean.
- [ ] **Step 3: Commit** — `git commit -m "feat(inbox): preload window.api.inbox (#407)"`

---

### Task 7: Renderer pure helpers

**Files:** Create `src/renderer/src/inboxView.ts`; Test `src/renderer/src/inboxView.test.ts`.

**Interfaces:** Produces `groupByPriority(todos): Array<{ priority; label; todos }>`, `matchesSearch(todo, q): boolean`, `sourceLabel(source, names: Record<string,string>): string`, `chipSubline(counts): string`, `chipDot(counts): 'urgent' | 'open' | 'none'`, `relativeAgo(ms, now?): string`, `eventLabel(e, names): string`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { groupByPriority, matchesSearch, sourceLabel, chipSubline, chipDot, relativeAgo, eventLabel } from './inboxView';
import type { Todo, TodoEvent } from '../../preload/inboxTypes';

const t = (over: Partial<Todo>): Todo => ({
  id: 'T', title: 'Disk full', body: 'on build-01', status: 'open', priority: 'normal', source: { kind: 'user', id: null },
  sourceRunId: null, viaWorkspace: null, dedupeKey: null, seenCount: 1, recurred: false, workspaceId: null,
  sessionId: null, tags: ['ops'], createdAt: 0, updatedAt: 0, firstSeenAt: 0, lastSeenAt: 0, closedAt: null, ...over
});

describe('inboxView helpers', () => {
  it('groups by priority in severity order and omits empty groups', () => {
    const g = groupByPriority([t({ id: 'a', priority: 'low' }), t({ id: 'b', priority: 'urgent' }), t({ id: 'c', priority: 'low' })]);
    expect(g.map((x) => [x.label, x.todos.length])).toEqual([['Urgent', 1], ['Low', 2]]);
  });
  it('searches title, body and tags case-insensitively', () => {
    expect(matchesSearch(t({}), 'DISK')).toBe(true);
    expect(matchesSearch(t({}), 'build-01')).toBe(true);
    expect(matchesSearch(t({}), 'ops')).toBe(true);
    expect(matchesSearch(t({}), 'nothing')).toBe(false);
    expect(matchesSearch(t({}), '  ')).toBe(true);
  });
  it('labels sources', () => {
    expect(sourceLabel({ kind: 'user', id: null }, {})).toBe('You');
    expect(sourceLabel({ kind: 'workspace', id: 'W1' }, { W1: 'ops-oncall' })).toBe('ops-oncall');
    expect(sourceLabel({ kind: 'workspace', id: 'W9' }, {})).toBe('deleted workspace');
    expect(sourceLabel({ kind: 'automation', id: 'A1' }, {})).toBe('automation');
  });
  it('builds the chip sub-line and dot', () => {
    expect(chipSubline({ open: 0, urgent: 0, high: 0 })).toBe('nothing open');
    expect(chipSubline({ open: 7, urgent: 1, high: 2 })).toBe('7 open · 1 urgent');
    expect(chipSubline({ open: 3, urgent: 0, high: 1 })).toBe('3 open');
    expect(chipDot({ open: 7, urgent: 1, high: 0 })).toBe('urgent');
    expect(chipDot({ open: 2, urgent: 0, high: 0 })).toBe('open');
    expect(chipDot({ open: 0, urgent: 0, high: 0 })).toBe('none');
  });
  it('formats relative time', () => {
    expect(relativeAgo(1000, 1000 + 30_000)).toBe('just now');
    expect(relativeAgo(0, 5 * 60_000)).toBe('5m ago');
    expect(relativeAgo(0, 3 * 3_600_000)).toBe('3h ago');
    expect(relativeAgo(0, 2 * 86_400_000)).toBe('2d ago');
  });
  it('describes history events', () => {
    const e = (kind: TodoEvent['kind'], detail: Record<string, unknown> | null, actor = { kind: 'user' as const, id: null }): TodoEvent =>
      ({ id: 1, todoId: 'T', ts: 0, kind, actor, runId: null, detail });
    expect(eventLabel(e('created', null), {})).toBe('Created by You');
    expect(eventLabel(e('seen', null, { kind: 'workspace', id: 'W1' } as never), { W1: 'ops' })).toBe('Seen again by ops');
    expect(eventLabel(e('reopened', { from: 'done' }), {})).toBe('Reopened: it recurred after being marked done');
    expect(eventLabel(e('status', { to: 'done' }), {})).toBe('You marked it done');
    expect(eventLabel(e('tag_add', { tags: ['a', 'b'] }), {})).toBe('You added tags a, b');
    expect(eventLabel(e('priority', { to: 'high' }), {})).toBe('You set priority to high');
  });
});
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/renderer/src/inboxView.test.ts`
- [ ] **Step 3: Implement `src/renderer/src/inboxView.ts`**

```ts
// Pure helpers for the Inbox view (#407) — grouping, search, and labels.
import type { InboxCounts, Todo, TodoEvent, TodoPriority, TodoSource } from '../../preload/inboxTypes';

const GROUPS: Array<[TodoPriority, string]> = [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];

export function groupByPriority(todos: Todo[]): Array<{ priority: TodoPriority; label: string; todos: Todo[] }> {
  return GROUPS.map(([priority, label]) => ({ priority, label, todos: todos.filter((t) => t.priority === priority) }))
    .filter((g) => g.todos.length > 0);
}

export function matchesSearch(t: Todo, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [t.title, t.body ?? '', ...t.tags].some((s) => s.toLowerCase().includes(needle));
}

export function sourceLabel(s: TodoSource, names: Record<string, string>): string {
  if (s.kind === 'user') return 'You';
  if (s.kind === 'workspace') return (s.id && names[s.id]) || 'deleted workspace';
  return 'automation';
}

export function chipSubline(c: InboxCounts): string {
  if (c.open === 0) return 'nothing open';
  return c.urgent > 0 ? `${c.open} open · ${c.urgent} urgent` : `${c.open} open`;
}

export function chipDot(c: InboxCounts): 'urgent' | 'open' | 'none' {
  if (c.urgent > 0) return 'urgent';
  return c.open > 0 ? 'open' : 'none';
}

export function relativeAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function eventLabel(e: TodoEvent, names: Record<string, string>): string {
  const who = sourceLabel(e.actor, names);
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'created': return `Created by ${who}`;
    case 'seen': return `Seen again by ${who}`;
    case 'reopened': return `Reopened: it recurred after being marked ${String(d.from ?? 'closed')}`;
    case 'status': return `${who} marked it ${String(d.to)}`;
    case 'priority': return `${who} set priority to ${String(d.to)}`;
    case 'title': return `${who} renamed it`;
    case 'tag_add': return `${who} added tag${(d.tags as string[]).length > 1 ? 's' : ''} ${(d.tags as string[]).join(', ')}`;
    case 'tag_remove': return `${who} removed tag${(d.tags as string[]).length > 1 ? 's' : ''} ${(d.tags as string[]).join(', ')}`;
    case 'body_append': return `${who} added detail`;
  }
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(inbox): renderer view helpers (#407)"`

---

### Task 8: Inbox UI (chip, view, detail) + App integration + styles

**Files:**
- Create: `src/renderer/src/components/InboxChip.tsx`, `InboxView.tsx`, `TodoDetail.tsx`
- Modify: `WorkspaceTabStrip.tsx` (new `inboxChip?: React.ReactNode` prop rendered just before the `add-workspace` button), `App.tsx`, `styles.css`

**Interfaces:**
- Consumes: `window.api.inbox`, Task 7 helpers, `WorkspaceSummary`.
- Produces: DOM contract used by e2e: `.inbox-chip` (`.ws-chip-group`), `.inbox-chip .ws-chip-sub`; `.inbox-view`; status tabs role `tab` named `Open · N` / `Done` / `Dismissed` / `All`; inputs labelled `New todo title`, `New todo priority`; button `Add todo`; search `Search todos`; `.todo-group.g-<priority>` with text `<Label> · N`; `.todo-row` (button-like, `aria-selected`); row tags `.tag`; `.ib-detail` with `.ib-detail-title`, buttons `Mark done`, `Dismiss`, `Reopen`; select `Priority`; input `Add tag`; history `.ib-hist li`; empty state `.ib-empty`.

- [ ] **Step 1: `InboxChip.tsx`**

```tsx
// The Inbox chip in the top strip (#407): a compact chip in the workspace-chip
// language. Dot = state (red urgent / grey open / none); sub-line = counts.
import type { InboxCounts } from '../../../preload';
import { chipDot, chipSubline } from '../inboxView';

interface Props {
  counts: InboxCounts;
  active: boolean;
  onOpen: () => void;
}

export function InboxChip({ counts, active, onOpen }: Props) {
  const dot = chipDot(counts);
  return (
    <div className={`ws-chip-group inbox-chip${active ? ' active' : ''}`}>
      <button className="ws-chip" onClick={onOpen} title="Inbox" aria-pressed={active}>
        <span className={`inbox-dot ${dot}`} aria-hidden="true" />
        <span className="ws-chip-text">
          <span className="name">Inbox</span>
          <span className="ws-chip-sub">{chipSubline(counts)}</span>
        </span>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: `TodoDetail.tsx`**

```tsx
// Detail pane for the selected todo (#407): actions, key facts, tags, body, history.
import { useEffect, useState } from 'react';
import type { Todo, TodoEvent, TodoPriority } from '../../../preload';
import { eventLabel, relativeAgo, sourceLabel } from '../inboxView';

interface Props {
  todoId: string;
  names: Record<string, string>;
  version: number;
  onJump: (workspaceId: string) => void;
}

export function TodoDetail({ todoId, names, version, onJump }: Props) {
  const [data, setData] = useState<{ todo: Todo; events: TodoEvent[] } | null>(null);
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    let live = true;
    void window.api.inbox.get(todoId).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [todoId, version]);

  if (!data) return <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Loading…</p></aside>;
  const { todo, events } = data;
  const update = (patch: Parameters<typeof window.api.inbox.update>[1]) => void window.api.inbox.update(todo.id, patch);

  return (
    <aside className="ib-detail" aria-label="Todo details">
      <div className="ib-detail-head">
        <div className="ib-detail-chips">
          <span className={`prio prio-${todo.priority}`}>{todo.priority}</span>
          <span className="state-chip">{todo.status}{todo.recurred ? ' · recurred' : ''}</span>
        </div>
        <h3 className="ib-detail-title">{todo.title}</h3>
        <div className="ib-detail-actions">
          {todo.status === 'open' ? (
            <>
              <button className="btn btn-sm primary" aria-label="Mark done" onClick={() => update({ status: 'done' })}>✓ Done</button>
              <button className="btn btn-sm" onClick={() => update({ status: 'dismissed' })}>Dismiss</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => update({ status: 'open' })}>Reopen</button>
          )}
          <span className="ib-spacer" />
          <select
            className="ib-select"
            aria-label="Priority"
            value={todo.priority}
            onChange={(e) => update({ priority: e.target.value as TodoPriority })}
          >
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <dl className="ib-kv">
        <dt>Source</dt>
        <dd>{sourceLabel(todo.source, names)}</dd>
        {todo.dedupeKey && (<><dt>Key</dt><dd><code>{todo.dedupeKey}</code></dd></>)}
        <dt>Seen</dt>
        <dd>
          <span className="mono">{todo.seenCount}×</span>
          <span className="ib-dim"> · first {relativeAgo(todo.firstSeenAt)} · last {relativeAgo(todo.lastSeenAt)}</span>
        </dd>
        {todo.workspaceId && names[todo.workspaceId] && (
          <>
            <dt>Linked</dt>
            <dd><button className="ib-link" onClick={() => onJump(todo.workspaceId!)}>{names[todo.workspaceId]} ↗</button></dd>
          </>
        )}
        <dt>Tags</dt>
        <dd className="ib-tags">
          {todo.tags.map((t) => (
            <button key={t} className="tag" title={`Remove ${t}`} onClick={() => update({ tagsRemove: [t] })}>{t} ✕</button>
          ))}
          <input
            className="ib-tag-input"
            aria-label="Add tag"
            placeholder="+ tag"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagDraft.trim()) {
                update({ tagsAdd: [tagDraft] });
                setTagDraft('');
              }
            }}
          />
        </dd>
      </dl>
      {todo.body && <div className="ib-body"><pre className="ib-pre">{todo.body}</pre></div>}
      <div className="ib-hist-title">History</div>
      <ol className="ib-hist">
        {[...events].reverse().map((e) => (
          <li key={e.id}>
            <span className={`h-dot${e.kind === 'reopened' ? ' reopen' : ''}`} />
            <span className="h-what">{eventLabel(e, names)}</span>
            <span className="h-when">{relativeAgo(e.ts)}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
```

- [ ] **Step 3: `InboxView.tsx`**

```tsx
// Inbox main-pane view (#407). Phase 1: the Todos tab — status tabs, search,
// tag filter, an add row, a priority-grouped list and a detail pane.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Todo, TodoPriority, TodoStatus } from '../../../preload';
import { groupByPriority, matchesSearch, relativeAgo, sourceLabel } from '../inboxView';
import { TodoDetail } from './TodoDetail';

interface Props {
  names: Record<string, string>;
  openCount: number;
  onJump: (workspaceId: string) => void;
}

const TABS: Array<[TodoStatus | 'all', string]> = [['open', 'Open'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']];

export function InboxView({ names, openCount, onJump }: Props) {
  const [status, setStatus] = useState<TodoStatus | 'all'>('open');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('normal');

  const reload = useCallback(() => {
    void window.api.inbox.list({ status }).then(setTodos);
    setVersion((v) => v + 1);
  }, [status]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => window.api.inbox.onChanged(() => reload()), [reload]);

  const visible = useMemo(
    () => todos.filter((t) => matchesSearch(t, search) && (!tag || t.tags.includes(tag))),
    [todos, search, tag]
  );
  const groups = groupByPriority(visible);

  const add = async () => {
    if (!title.trim()) return;
    await window.api.inbox.create({ title, priority });
    setTitle('');
    setPriority('normal');
  };

  return (
    <div className="inbox-view">
      <div className="session-tab-strip ib-tabs" role="tablist" aria-label="Inbox sections">
        <div role="tab" aria-selected="true" className="session-tab active">
          <span className="session-tab-name">Todos</span>
          <span className="ib-count">{openCount}</span>
        </div>
      </div>
      <div className="ib-split">
        <section className="ib-listcol">
          <div className="ib-toolbar">
            <div className="obs-scope-toggle ib-scope" role="tablist" aria-label="Todo status">
              {TABS.map(([s, label]) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={status === s}
                  className={`obs-scope-btn ${status === s ? 'active' : ''}`}
                  onClick={() => { setStatus(s); setSelected(null); }}
                >
                  {s === 'open' ? `${label} · ${openCount}` : label}
                </button>
              ))}
            </div>
            <div className="ib-add">
              <input
                className="sessions-search"
                aria-label="New todo title"
                placeholder="Add a todo…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
              />
              <select className="ib-select" aria-label="New todo priority" value={priority} onChange={(e) => setPriority(e.target.value as TodoPriority)}>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
              <button className="btn btn-sm primary" onClick={() => void add()} disabled={!title.trim()}>Add todo</button>
            </div>
            <div className="ib-filters">
              <input className="sessions-search" type="search" aria-label="Search todos" placeholder="Search todos…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {tag && <button className="pill" onClick={() => setTag(null)} title="Remove filter">#{tag} ✕</button>}
              <span className="nofm">{visible.length} of {todos.length}</span>
            </div>
          </div>
          {visible.length === 0 ? (
            <div className="ib-empty">{todos.length === 0 && status === 'open' ? 'Nothing open. Workspaces and you can post todos here.' : 'No todos match.'}</div>
          ) : (
            <ul className="todo-list">
              {groups.map((g) => (
                <li key={g.priority} className="todo-group-wrap">
                  <div className={`session-group-label todo-group g-${g.priority}`}>{g.label} · {g.todos.length}<span className="session-group-line" /></div>
                  <ul className="todo-sublist">
                    {g.todos.map((t) => (
                      <li
                        key={t.id}
                        className={`todo-row p-${t.priority}${selected === t.id ? ' sel' : ''}`}
                        aria-selected={selected === t.id}
                        tabIndex={0}
                        onClick={() => setSelected(t.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setSelected(t.id); }}
                      >
                        <button
                          className="todo-check"
                          aria-label={t.status === 'open' ? `Mark "${t.title}" done` : `Reopen "${t.title}"`}
                          onClick={(e) => { e.stopPropagation(); void window.api.inbox.update(t.id, { status: t.status === 'open' ? 'done' : 'open' }); }}
                        />
                        <div className="todo-main">
                          <div className="todo-title">{t.title}</div>
                          <div className="todo-meta">
                            <span className="src">{sourceLabel(t.source, names)}</span>
                            <span className="todo-time">{relativeAgo(t.lastSeenAt)}</span>
                            {t.seenCount > 1 && <span className="todo-seen">seen {t.seenCount}×</span>}
                            {t.recurred && <span className="todo-flag">recurred</span>}
                            {t.tags.map((x) => (
                              <button key={x} className="tag" onClick={(e) => { e.stopPropagation(); setTag(x); }}>{x}</button>
                            ))}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
        {selected ? (
          <TodoDetail todoId={selected} names={names} version={version} onJump={onJump} />
        ) : (
          <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Select a todo to see its details.</p></aside>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `WorkspaceTabStrip.tsx`** — add `inboxChip?: React.ReactNode;` to `Props` (with a doc comment), destructure it, and render `{inboxChip}` immediately before the `<button className="btn add-workspace"`. Add `import type { ReactNode } from 'react';` and type the prop as `ReactNode`.

- [ ] **Step 5: `App.tsx`** —
  1. imports: `InboxChip`, `InboxView`, `type InboxCounts` from preload.
  2. state: `const [inboxOpen, setInboxOpen] = useState(false); const [inboxCounts, setInboxCounts] = useState<InboxCounts>({ open: 0, urgent: 0, high: 0 });`
  3. effect: `useEffect(() => { void window.api.inbox.counts().then(setInboxCounts); return window.api.inbox.onChanged(setInboxCounts); }, []);`
  4. `const workspaceNames = useMemo(() => Object.fromEntries(workspaces.map((w) => [w.id, w.name])), [workspaces]);`
  5. `WorkspaceTabStrip`: `selectedId={inboxOpen ? null : selectedId}`, `onSelect={(id) => { setInboxOpen(false); setSelectedId(id); }}`, `inboxChip={<InboxChip counts={inboxCounts} active={inboxOpen} onOpen={() => setInboxOpen(true)} />}`.
  6. In `main-body`: wrap the existing empty-state ternary as `{inboxOpen ? (<InboxView names={workspaceNames} openCount={inboxCounts.open} onJump={(id) => { setInboxOpen(false); setSelectedId(id); }} />) : liveCount === 0 ? …existing… }`.
  7. `TerminalPane`: `visible={!inboxOpen && selectedId === w.id}`.

- [ ] **Step 6: `styles.css`** — append an `/* ----- inbox (#407) ----- */` section. Copy these rule blocks verbatim from the mock source `docs/superpowers/specs/assets/2026-10-20-inbox-automations/src/build-page.mjs` (`pageCss` string): `.inbox-chip`, `.inbox-view`, `.ib-tabs …`, `.ib-count`, `.ib-split`, `.ib-listcol`, `.ib-toolbar`, `.ib-scope`, `.ib-filters`, `.todo-list`, `.todo-group…`, `.todo-row…`, `.todo-check`, `.todo-main`, `.todo-title`, `.todo-meta`, `.todo-time`, `.todo-seen`, `.todo-flag`, `.src`, `.ib-detail…`, `.prio…`, `.state-chip`, `.ib-detail-title`, `.ib-detail-actions`, `.ib-select`, `.ib-kv…`, `.ib-tags`, `.ib-link`, `.ib-body`, `.ib-pre`, `.ib-hist-title`, `.ib-hist…`, `.h-dot…`, `.h-when`, `.ib-spacer`. Then add the Phase 1 specifics:

```css
.inbox-chip { min-width: 0; max-width: none; }
.inbox-chip .ws-chip { border: none; }
.inbox-chip.active { border-color: var(--ink-2); }
.inbox-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: transparent; box-shadow: inset 0 0 0 1px var(--rule-strong); }
.inbox-dot.open { background: var(--ink-3); box-shadow: none; }
.inbox-dot.urgent { background: var(--danger); box-shadow: none; }
.ib-add { display: flex; gap: 6px; align-items: center; }
.ib-add .sessions-search { flex: 1; }
.ib-filters .sessions-search { flex: 1; }
.todo-sublist { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.todo-row { cursor: pointer; }
.todo-row:focus-visible { outline: 1px solid var(--ok); outline-offset: -1px; }
.todo-meta .tag { cursor: pointer; }
.ib-empty { padding: 28px 16px; text-align: center; color: var(--ink-2); font-size: 12.5px; }
.ib-dim { color: var(--ink-2); }
.ib-tag-input { width: 80px; background: transparent; border: 1px dashed var(--rule-strong); border-radius: var(--r-sm); color: var(--ink-1); font: 10px var(--font-mono); padding: 2px 6px; }
.ib-tags .tag { cursor: pointer; }
button.ib-link { background: none; border: none; padding: 0; font: inherit; }
.prio-high { color: var(--warn); background: color-mix(in oklch, var(--warn), transparent 88%); border: 1px solid color-mix(in oklch, var(--warn), transparent 60%); }
.prio-normal, .prio-low { color: var(--ink-1); background: var(--bg-3); border: 1px solid var(--rule); }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 7:** `npm run typecheck:web` — clean. `npx vitest run src/renderer` — PASS.
- [ ] **Step 8: Commit** — `git commit -m "feat(inbox): Inbox chip + Todos view (#407)"`

---

### Task 9: Edit workspace › Inbox & automations

**Files:** Modify `src/renderer/src/components/WorkspaceForm.tsx`, `src/renderer/src/App.tsx` (handleEditSave + `WorkspaceSummary.inbox`).

**Interfaces:** `WorkspaceFormSubmit.inbox?: InboxConfig` (undefined when defaults); form labels `Can post todos and notifications`, `Posts per hour`.

- [ ] **Step 1:** In `App.tsx` add `inbox?: InboxConfig;` to `WorkspaceSummary` (import the type from preload) and `inbox: submit.inbox,` in `handleEditSave`'s `writeManifest` payload (next to `accessibility`).
- [ ] **Step 2:** In `WorkspaceForm.tsx`: state `const [canPostTodos, setCanPostTodos] = useState(initial?.inbox?.canPost !== false); const [postsPerHour, setPostsPerHour] = useState(String(initial?.inbox?.maxPostsPerHour ?? 60)); const [inboxOpen, setInboxOpen] = useState(initial?.inbox !== undefined);`. In `buildPayload`, compute:

```ts
    const pph = Math.floor(Number(postsPerHour));
    const inboxCfg: InboxConfig = {
      ...(canPostTodos ? {} : { canPost: false }),
      ...(Number.isFinite(pph) && pph >= 1 && pph !== 60 ? { maxPostsPerHour: Math.min(pph, 10000) } : {}),
      ...(initial?.inbox?.canReadAll ? { canReadAll: true } : {})
    };
    const inbox = mode === 'edit' && Object.keys(inboxCfg).length ? inboxCfg : undefined;
```

and return `inbox` in the payload (add `inbox?: InboxConfig` to `WorkspaceFormSubmit`). Render, right after the Committee access `</details>` (edit mode only):

```tsx
      {mode === 'edit' && (
        <details className="form-disclosure" open={inboxOpen} onToggle={(e) => setInboxOpen((e.target as HTMLDetailsElement).open)}>
          <summary>
            Inbox &amp; automations{' '}
            <span className="form-hint">{canPostTodos ? `can post · ${postsPerHour || 60}/hour` : 'posting off'}</span>
          </summary>
          <label className="committee-reachable-row">
            <input type="checkbox" checked={canPostTodos} onChange={(e) => setCanPostTodos(e.target.checked)} disabled={busy} />
            <span>Can post todos and notifications</span>
          </label>
          <div className="form-row ib-rate">
            <label htmlFor="ws-inbox-rate">Posts per hour</label>
            <input id="ws-inbox-rate" type="number" min={1} max={10000} value={postsPerHour}
              onChange={(e) => setPostsPerHour(e.target.value)} disabled={busy || !canPostTodos} />
          </div>
          <p className="form-hint">Over the limit, posts are rejected and the workspace is told when it can post again.</p>
        </details>
      )}
```

Add `.ib-rate { flex-direction: row; align-items: center; gap: 10px; margin: 0 0 6px 24px; } .ib-rate label { margin: 0; } .ib-rate input { width: 80px; }` to `styles.css`.
- [ ] **Step 3:** `npm run typecheck:web` clean; `npx vitest run src/renderer` PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(inbox): per-workspace inbox permissions in Edit workspace (#407)"`

---

### Task 10: E2E tests

**Files:** Create `tests/inbox-ui.spec.ts`, `tests/inbox-mcp.spec.ts`.

- [ ] **Step 1: `tests/inbox-ui.spec.ts` (mock mode)**

```ts
// Inbox (#407) end-to-end, mock backend: chip → view → add → triage → close,
// plus workspace-chip deselection and tag filtering. Real inbox.db in the temp userData.
import { test, expect, type Page } from '@playwright/test';
import { launch, callTestIpc } from './_helpers.js';

const chip = (w: Page) => w.locator('.inbox-chip');

test('Inbox: add, tag, prioritise, mark done (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await expect(chip(window)).toContainText('Inbox');
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('nothing open');
    await chip(window).locator('.ws-chip').click();
    const view = window.locator('.inbox-view');
    await expect(view).toBeVisible();
    await expect(view.locator('.ib-empty')).toContainText('Nothing open');

    await view.getByLabel('New todo title').fill('Rotate the WebEx token');
    await view.getByLabel('New todo priority').selectOption('urgent');
    await view.getByRole('button', { name: 'Add todo' }).click();
    const row = view.locator('.todo-row', { hasText: 'Rotate the WebEx token' });
    await expect(row).toBeVisible();
    await expect(view.locator('.todo-group.g-urgent')).toContainText('Urgent · 1');
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('1 open · 1 urgent');

    await row.click();
    const detail = view.locator('.ib-detail');
    await expect(detail.locator('.ib-detail-title')).toHaveText('Rotate the WebEx token');
    await detail.getByLabel('Add tag').fill('WebEx');
    await detail.getByLabel('Add tag').press('Enter');
    await expect(row.locator('.tag', { hasText: 'webex' })).toBeVisible();
    await detail.getByLabel('Priority').selectOption('high');
    await expect(view.locator('.todo-group.g-high')).toContainText('High · 1');
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('1 open');

    await detail.getByRole('button', { name: 'Mark done' }).click();
    await expect(row).toBeHidden();
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('nothing open');
    await view.getByRole('tab', { name: 'Done' }).click();
    await view.locator('.todo-row', { hasText: 'Rotate the WebEx token' }).click();
    await expect(view.locator('.ib-hist li')).toHaveCount(4); // created, tag, priority, done
    await expect(view.locator('.ib-hist li').first()).toContainText('You marked it done');

    const all = await callTestIpc<Array<{ title: string; status: string }>>(app, 'inbox:list', [{ status: 'all' }]);
    expect(all).toEqual([expect.objectContaining({ title: 'Rotate the WebEx token', status: 'done' })]);
  } finally {
    await app.close();
  }
});

test('Inbox: search and tag filter; workspace chip deselects while open (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await callTestIpc(app, 'inbox:create', [{ title: 'Disk 91% on build-01', priority: 'high', tags: ['ops'] }]);
    await callTestIpc(app, 'inbox:create', [{ title: 'Drink water', priority: 'low', tags: ['health'] }]);
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('alpha');
    await window.getByRole('button', { name: 'Create & start' }).click();
    const ws = window.locator('.ws-chip-group', { hasText: 'alpha' });
    await expect(ws).toHaveClass(/active/);

    await chip(window).locator('.ws-chip').click();
    await expect(chip(window)).toHaveClass(/active/);
    await expect(ws).not.toHaveClass(/active/);
    const view = window.locator('.inbox-view');
    await expect(view.locator('.todo-row')).toHaveCount(2);
    await view.getByLabel('Search todos').fill('build-01');
    await expect(view.locator('.todo-row')).toHaveCount(1);
    await view.getByLabel('Search todos').fill('');
    await view.locator('.todo-row', { hasText: 'Drink water' }).locator('.tag', { hasText: 'health' }).click();
    await expect(view.locator('.todo-row')).toHaveCount(1);
    await view.locator('.pill', { hasText: '#health' }).click();
    await expect(view.locator('.todo-row')).toHaveCount(2);

    await ws.locator('.ws-chip').click();
    await expect(view).toBeHidden();
    await expect(ws).toHaveClass(/active/);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: `tests/inbox-mcp.spec.ts` (real launch — DB + MCP server start)** — seed manifests exactly like `tests/mcp-server.spec.ts` does (copy its `seedManifest` helper):

```ts
// Inbox MCP tools (#407) end-to-end on the real app: workspaces post / dedupe /
// reopen / update / list over their own MCP socket; permissions and the hourly
// cap are enforced host-side; the result shows up in the Inbox UI.
import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, connectMcp, callTestIpc, type RpcClient } from './_helpers.js';

function text(res: { result?: unknown }): { isError?: boolean; value: unknown; raw: string } {
  const r = res.result as { isError?: boolean; content?: Array<{ text?: string }> };
  const raw = r?.content?.[0]?.text ?? '';
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* error text */ }
  return { isError: r?.isError, value, raw };
}

test('Inbox MCP: post, dedupe, reopen, scope, permissions, cap (#407)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-inbox-mcp-'));
  const A = '01INBOXTESTWS00000000000WA', B = '01INBOXTESTWS00000000000WB', C = '01INBOXTESTWS00000000000WC';
  const seed = (id: string, name: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(path.join(userDataDir, 'state', id), { recursive: true });
    writeFileSync(path.join(userDataDir, 'state', id, 'workspace.json'), JSON.stringify({
      id, name, labels: [], workspaceRoot: '/tmp/fleet-inbox', workspaceSubdir: '', kind: 'container',
      image: 'mock', authMode: 'oauth', env: { plain: {}, secretKeys: [] }, createdAt: Date.now(), lastUsedAt: Date.now(), ...extra
    }));
  };
  seed(A, 'inbox-a');
  seed(B, 'inbox-b', { inbox: { canPost: false } });
  seed(C, 'inbox-c', { inbox: { maxPostsPerHour: 2 } });

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  const clients: RpcClient[] = [];
  const call = (c: RpcClient, name: string, args: Record<string, unknown>) =>
    c.call('tools/call', { name, arguments: args }).then(text);
  try {
    const a = await connectMcp(A, userDataDir); clients.push(a);
    const b = await connectMcp(B, userDataDir); clients.push(b);
    const c = await connectMcp(C, userDataDir); clients.push(c);
    for (const cl of clients) await cl.call('initialize', { protocolVersion: '2024-11-05' });

    const tools = await a.call('tools/list');
    const names = (tools.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['post_todo', 'update_todo', 'list_todos']));

    const p1 = await call(a, 'post_todo', { title: 'disk 91% on build-01', priority: 'high', key: 'disk:build-01', tags: ['ops'] });
    expect(p1.value).toMatchObject({ action: 'created' });
    const id = (p1.value as { id: string }).id;
    const p2 = await call(a, 'post_todo', { title: 'disk 93% on build-01', priority: 'urgent', key: 'disk:build-01' });
    expect(p2.value).toMatchObject({ id, action: 'updated', seenCount: 2 });
    const det = await callTestIpc<{ todo: { priority: string; seenCount: number } }>(app, 'inbox:get', [id]);
    expect(det.todo).toMatchObject({ priority: 'urgent', seenCount: 2 });

    expect((await call(a, 'update_todo', { id, status: 'done' })).value).toMatchObject({ status: 'done' });
    expect((await call(a, 'post_todo', { title: 'disk 95%', key: 'disk:build-01' })).value).toMatchObject({ id, action: 'reopened' });

    const listA = (await call(a, 'list_todos', {})).value as Array<{ id: string }>;
    expect(listA.map((t) => t.id)).toEqual([id]);
    expect((await call(b, 'list_todos', { status: 'all' })).value).toEqual([]);

    const denied = await call(b, 'post_todo', { title: 'nope' });
    expect(denied.isError).toBe(true);
    expect(denied.raw).toMatch(/not allowed to post/);
    const foreign = await call(b, 'update_todo', { id, status: 'done' });
    expect(foreign.isError).toBe(true);
    expect(foreign.raw).toMatch(/not permitted/);

    await call(c, 'post_todo', { title: 'c1' });
    await call(c, 'post_todo', { title: 'c2' });
    const capped = await call(c, 'post_todo', { title: 'c3' });
    expect(capped.isError).toBe(true);
    expect(capped.raw).toMatch(/post limit \(2\/hour\).*retryAfterMs=\d+/);

    await window.locator('.inbox-chip .ws-chip').click();
    const row = window.locator('.todo-row', { hasText: 'disk 91% on build-01' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('inbox-a');
    await expect(row).toContainText('seen 3×');
    await expect(row).toContainText('recurred');
    await expect(window.locator('.inbox-chip .ws-chip-sub')).toHaveText('3 open · 1 urgent');
  } finally {
    for (const cl of clients) cl.close?.();
    await app.close();
  }
});
```

Check `RpcClient` in `tests/_helpers.ts` for its close method name and adjust the `finally` (`grep -n "class RpcClient" -A30 tests/_helpers.ts`).

- [ ] **Step 3:** These run in CI only. Commit — `git commit -m "test(inbox): e2e for the Inbox UI and MCP tools (#407)"`

---

### Task 11: SPEC.md, version, PR

**Files:** `docs/SPEC.md`, `package.json`, `package-lock.json`, `docs/superpowers/plans/2026-10-20-overnight-decisions.md`.

- [ ] **Step 1: SPEC.md** — edit in place:
  - §6 IPC: add an `### Inbox (#407)` subsection listing `inbox:list(filter)`, `inbox:get(id)` → `{todo, events}|null`, `inbox:create(input)` (source `user`), `inbox:update(id, patch)`, `inbox:counts()`, push `inbox:changed {counts}`.
  - §7 Data model: add `### Inbox store (inbox.db)` with the Phase 1 schema (copy the SQL from the design spec §4), the authoritative-not-cache note, WAL + `user_version` + pre-migration backup, dedupe/reopen semantics; and the manifest `inbox?: { canPost?, maxPostsPerHour?, canReadAll? }` (both type and allowlist constructor, carried through `workspaceMerge`).
  - §8 User flows: `### Inbox` (Inbox chip after the workspace chips, main-pane takeover, workspace chip deselects, Todos tab behaviours).
  - §9 Security: MCP gains host-mediated inbox writes (`post_todo`, `update_todo`), caller identity ambient, per-workspace permission + hourly cap (reject), visibility rules; local-workspace caveat.
  - MCP section (§11 *In-container SQLite access via MCP*): add the three tools with their gates.
  - Open decisions entry: add "Phase 1 (inbox core) shipped in v0.14.0; remaining phases below." at its top.
- [ ] **Step 2: Version** — `npm version 0.14.0 --no-git-tag-version` (updates both package files).
- [ ] **Step 3: Full local gate** — `npx vitest run` (expect only the pre-existing `mcpLocalBridge.run.test.ts` reconnect flake to fail, if it does), `npm run typecheck:node`, `npm run typecheck:web`, `npm run build`.
- [ ] **Step 4: Commit, push, open PR** titled `feat: inbox core (Phase 1, #407) — v0.14.0`, body listing what ships, the e2e specs, and the decision-log link. Wait for CI; fix failures; merge (squash) when green.
