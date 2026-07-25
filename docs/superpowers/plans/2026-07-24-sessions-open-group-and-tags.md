# Sessions Pane Open/Recent Grouping + Summary Tags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The left-rail Sessions pane groups live-tab sessions under an `Open · N` header (click = jump to the existing tab), shows each session's leading summary tags in its meta line, and gains Library-style tag filtering + tag-aware search.

**Architecture:** "Open" is derived in the renderer exactly like the existing busy-pulse pipeline: every mounted `TerminalPane` reports its live tab broker ids up to `App.tsx`, which resolves them to Claude session UUIDs via the learned `broker_sessions` mapping (`summaryForBrokerSession`) and passes an open-map to `SessionsPane`. Tags ride the existing `sessions:list` IPC — `db.listSessions()` adds one grouped query over `session_summaries` (no N+1). All list logic (filter/partition/tag counts) is pure functions in `sessionsView.ts`/`busySessions.ts`, unit-tested; the pane renders them.

**Tech Stack:** Electron (main/preload/renderer), React 18 (hooks only, no state lib), better-sqlite3, vitest (pure TS units), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-24-sessions-open-group-and-tags-design.md` (read it first).

## Global Constraints

- Work in the worktree `/workspace/claude-fleet/.claude/worktrees/sessions-open-group-tags` on branch `feat/sessions-open-group-tags`. **Never `cd /workspace/claude-fleet`** (the main checkout is a different branch). All commands below run from the worktree root.
- No new npm dependencies. No new IPC channels (payload shape change to `sessions:list` only).
- Green (`--ok`) means live/active; tags are neutral gray (`.tag` class). Do not invent new colors.
- Reuse existing CSS classes where stated (`.tag`, `.pill`, `.tag-menu`, `.tag-menu-item`, `.tm-count`, `.nofm`, `.library-filter`).
- `docs/SPEC.md` must be updated in the same PR (Task 8) — repo rule `.claude/rules/spec-maintenance.md`.
- Commit after every task (steps say when). Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Test-env bootstrap + tags on `listSessions` rows

**Files:**
- Modify: `src/main/db.ts` (SessionListRow at ~1115, listSessions at ~1146)
- Modify: `src/preload/index.ts` (SessionListItem at ~37)
- Test: `src/main/dbSessionsList.test.ts` (new)

**Interfaces:**
- Consumes: existing `openDb(dir)`, `closeDb()`, `ingestLine(workspaceId, sessionId, jsonLine)`, `listSessions(workspaceId?)` from `./db.js`. `ingestLine` with a `{type:'session-summary', summary, tags:[...]}` line writes a `session_summaries` chapter row (tags as JSON text) — see `src/main/dbSummaries.test.ts` for the pattern.
- Produces: `SessionListRow.tags: string[]` (ordered as the summarizer emitted them; `[]` when no chaptered summary has tags). `SessionListItem.tags: string[]` in the preload type. The `sessions:list` IPC handler (`src/main/ipc.ts:756`) spreads `...r`, so tags flow to the renderer with **no ipc.ts change**.

- [ ] **Step 1: Bootstrap the worktree (one-time)**

```bash
npm install
# Make vitest runnable: node-ABI better-sqlite3 + electron path stub, copied
# from the main checkout where this fix is already applied. (postinstall
# rebuilds natives for Electron's ABI, which plain-node vitest can't load.)
cp /workspace/claude-fleet/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
   node_modules/better-sqlite3/build/Release/better_sqlite3.node
cp /workspace/claude-fleet/node_modules/electron/path.txt node_modules/electron/path.txt
npx vitest run src/main/dbSummaries.test.ts
```
Expected: the dbSummaries suite PASSES. If `better_sqlite3.node` or `path.txt` is missing in the main checkout, stop and report — do not improvise a different native-module fix.

- [ ] **Step 2: Write the failing test**

Create `src/main/dbSessionsList.test.ts`:

```ts
// listSessions() tags enrichment: each row carries the tags of its LATEST
// tagged summary chapter (ordered as emitted), [] when none exists.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, listSessions } from './db.js';

let dir: string;
const WS = '01WS';
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });
const summaryLine = (summary: string, tags?: string[]) =>
  JSON.stringify({ type: 'session-summary', summary, tags, model: 'haiku' });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-sesslist-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('listSessions tags', () => {
  it('returns [] for a session with no summary', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'hello'));
    const rows = listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual([]);
  });

  it('returns the latest tagged chapter tags, in emitted order', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    ingestLine(WS, 'ses-a', summaryLine('chapter one', ['broker', 'reconnect']));
    ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    ingestLine(WS, 'ses-a', summaryLine('chapter two', ['mcp', 'bridge']));
    const rows = listSessions();
    expect(rows[0].tags).toEqual(['mcp', 'bridge']);
  });

  it('skips untagged later chapters (latest TAGGED chapter wins)', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    ingestLine(WS, 'ses-a', summaryLine('tagged', ['ci']));
    ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    ingestLine(WS, 'ses-a', summaryLine('untagged later chapter'));
    const rows = listSessions();
    expect(rows[0].tags).toEqual(['ci']);
  });

  it('scopes by workspace and tags the right rows', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'x'));
    ingestLine(WS, 'ses-a', summaryLine('s', ['alpha']));
    ingestLine('01WS2', 'ses-b', userLine('u2', 'y'));
    const rows = listSessions(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('ses-a');
    expect(rows[0].tags).toEqual(['alpha']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/dbSessionsList.test.ts`
Expected: FAIL — `tags` is `undefined` on rows (property doesn't exist yet).

- [ ] **Step 4: Implement**

In `src/main/db.ts`, add to `SessionListRow` (after `usd: number;`, ~line 1127):

```ts
  /** Tags from the latest tagged summary chapter, in emitted (relevance)
   *  order; [] until the Phase-2 summarizer has produced one. */
  tags: string[];
```

In `listSessions()`, after the `costRows` block (~line 1184), add a third grouped query (keeps the no-N+1 property; `MAX(id)` = latest chapter, and SQLite's bare-column-with-MAX rule returns `tags` from that row):

```ts
  const tagRows = (
    workspaceId
      ? d
          .prepare(`
            SELECT session_id, tags, MAX(id) AS latest
            FROM session_summaries
            WHERE tags IS NOT NULL AND workspace_id = ?
            GROUP BY session_id
          `)
          .all(workspaceId)
      : d
          .prepare(`
            SELECT session_id, tags, MAX(id) AS latest
            FROM session_summaries
            WHERE tags IS NOT NULL
            GROUP BY session_id
          `)
          .all()
  ) as Array<{ session_id: string; tags: string }>;

  const tagsById = new Map<string, string[]>();
  for (const r of tagRows) {
    try {
      const parsed: unknown = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        tagsById.set(r.session_id, parsed.filter((t): t is string => typeof t === 'string'));
      }
    } catch {
      /* malformed tags JSON — treat as untagged */
    }
  }
```

And in the returned map (~line 1199), add to the object literal:

```ts
      tags: tagsById.get(s.id) ?? [],
```

In `src/preload/index.ts`, add to `SessionListItem` (after `usd: number;`):

```ts
  /** Latest summary-chapter tags, relevance-ordered; [] when unsummarized. */
  tags: string[];
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/main/dbSessionsList.test.ts && npx vitest run src/main/dbSummaries.test.ts && npm run typecheck`
Expected: both suites PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/db.ts src/preload/index.ts src/main/dbSessionsList.test.ts
git commit -m "feat(db): sessions:list rows carry latest summary-chapter tags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure list helpers — filter, partition, tag counts

**Files:**
- Modify: `src/renderer/src/sessionsView.ts`
- Test: `src/renderer/src/sessionsView.test.ts` (exists — append a new describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 6's SessionsPane):
  - `filterSessions<T extends SessionFilterable>(items: readonly T[], query: string, activeTags: readonly string[]): T[]`
  - `partitionByOpen<T extends { id: string }>(items: readonly T[], openIds: ReadonlySet<string>): { open: T[]; recent: T[] }`
  - `tagCounts(items: ReadonlyArray<{ tags: string[] }>): Array<[string, number]>`
  - `interface SessionFilterable { workspaceName: string; tags: string[]; userSetName: string | null; aiTitle: string | null; firstUserMessage: string | null }`

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/sessionsView.test.ts`:

```ts
import { filterSessions, partitionByOpen, tagCounts } from './sessionsView';

const sess = (over: Partial<{
  id: string; workspaceId: string; workspaceName: string; tags: string[];
  userSetName: string | null; aiTitle: string | null; firstUserMessage: string | null;
}> = {}) => ({
  id: 'id-1', workspaceId: 'ws-1', workspaceName: 'alpha', tags: [],
  userSetName: null, aiTitle: null, firstUserMessage: 'hello world',
  ...over
});

describe('filterSessions', () => {
  it('empty query + no tags returns everything', () => {
    const items = [sess({ id: 'a' }), sess({ id: 'b' })];
    expect(filterSessions(items, '', [])).toEqual(items);
  });
  it('matches title precedence field (userSetName > aiTitle > firstUserMessage)', () => {
    const items = [
      sess({ id: 'a', userSetName: 'Broker fix' }),
      sess({ id: 'b', aiTitle: 'MCP hang' }),
      sess({ id: 'c', firstUserMessage: 'loadout publish' })
    ];
    expect(filterSessions(items, 'broker', []).map((s) => s.id)).toEqual(['a']);
    expect(filterSessions(items, 'mcp', []).map((s) => s.id)).toEqual(['b']);
    expect(filterSessions(items, 'publish', []).map((s) => s.id)).toEqual(['c']);
  });
  it('matches workspace name and tag text via plain substring', () => {
    const items = [
      sess({ id: 'a', workspaceName: 'devops' }),
      sess({ id: 'b', tags: ['reconnect', 'broker'] })
    ];
    expect(filterSessions(items, 'devop', []).map((s) => s.id)).toEqual(['a']);
    expect(filterSessions(items, 'reconn', []).map((s) => s.id)).toEqual(['b']);
  });
  it('activeTags require an exact tag, OR across tags, AND with the query', () => {
    const items = [
      sess({ id: 'a', tags: ['mcp'], firstUserMessage: 'one' }),
      sess({ id: 'b', tags: ['ci'], firstUserMessage: 'two' }),
      sess({ id: 'c', tags: ['mcp', 'ci'], firstUserMessage: 'three' })
    ];
    expect(filterSessions(items, '', ['mcp']).map((s) => s.id)).toEqual(['a', 'c']);
    expect(filterSessions(items, '', ['mcp', 'ci']).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(filterSessions(items, 'three', ['mcp']).map((s) => s.id)).toEqual(['c']);
  });
});

describe('partitionByOpen', () => {
  it('splits preserving input order in both groups', () => {
    const items = [sess({ id: 'a' }), sess({ id: 'b' }), sess({ id: 'c' })];
    const { open, recent } = partitionByOpen(items, new Set(['c', 'a']));
    expect(open.map((s) => s.id)).toEqual(['a', 'c']);
    expect(recent.map((s) => s.id)).toEqual(['b']);
  });
  it('empty open set puts everything in recent', () => {
    const { open, recent } = partitionByOpen([sess({ id: 'a' })], new Set());
    expect(open).toEqual([]);
    expect(recent.map((s) => s.id)).toEqual(['a']);
  });
});

describe('tagCounts', () => {
  it('counts across sessions, sorted by count desc then alphabetically', () => {
    const items = [
      { tags: ['mcp', 'ci'] },
      { tags: ['mcp'] },
      { tags: ['broker'] }
    ];
    expect(tagCounts(items)).toEqual([['mcp', 2], ['broker', 1], ['ci', 1]]);
  });
  it('empty input gives empty output', () => {
    expect(tagCounts([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: FAIL — `filterSessions` etc. are not exported.

- [ ] **Step 3: Implement**

Append to `src/renderer/src/sessionsView.ts`:

```ts
/** The fields the pane's text search + tag filter read. Matches the
 *  SessionListItem subset so the helpers stay IPC-shape-agnostic. */
export interface SessionFilterable {
  workspaceName: string;
  tags: string[];
  userSetName: string | null;
  aiTitle: string | null;
  firstUserMessage: string | null;
}

/** Text query (case-insensitive substring over display title + workspace
 *  name + all tag text) AND tag filter (OR across activeTags, exact tag
 *  membership — LibraryPane semantics). Empty query/tags = pass. */
export function filterSessions<T extends SessionFilterable>(
  items: readonly T[],
  query: string,
  activeTags: readonly string[]
): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((s) => {
    if (activeTags.length > 0 && !activeTags.some((t) => s.tags.includes(t))) return false;
    if (!q) return true;
    const title = s.userSetName || s.aiTitle || s.firstUserMessage || '';
    return (
      title.toLowerCase().includes(q) ||
      s.workspaceName.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** Split into open (id ∈ openIds) and recent, preserving input order —
 *  the caller feeds last-active-descending rows, both groups keep it. */
export function partitionByOpen<T extends { id: string }>(
  items: readonly T[],
  openIds: ReadonlySet<string>
): { open: T[]; recent: T[] } {
  const open: T[] = [];
  const recent: T[] = [];
  for (const s of items) (openIds.has(s.id) ? open : recent).push(s);
  return { open, recent };
}

/** Distinct tags with session counts for the Tags ▾ menu, most-used first,
 *  alphabetical within a count. */
export function tagCounts(items: ReadonlyArray<{ tags: string[] }>): Array<[string, number]> {
  const c = new Map<string, number>();
  for (const s of items) for (const t of s.tags) c.set(t, (c.get(t) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: PASS (existing `sessionsForScope` tests included).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts
git commit -m "feat(sessions): pure filter/partition/tag-count helpers for the pane

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `openSessionMap` — broker→claude resolution for live tabs

**Files:**
- Modify: `src/renderer/src/busySessions.ts`
- Test: `src/renderer/src/busySessions.test.ts` (append)

**Interfaces:**
- Consumes: same mapping shape `busyClaudeIdSet` uses: `Map<workspaceId, Map<brokerSessionId, claudeSessionId>>`.
- Produces (used by Task 5's App wiring):
  - `interface OpenTabRef { workspaceId: string; brokerSessionId: string }`
  - `openSessionMap(liveBrokerByWorkspace: Record<string, string[]>, mappings: Map<string, Map<string, string>>): Map<string, OpenTabRef>` — key is the claude session UUID.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/busySessions.test.ts`:

```ts
import { openSessionMap } from './busySessions';

describe('openSessionMap', () => {
  it('maps live broker ids to claude UUIDs with their tab ref', () => {
    const mappings = new Map([['ws1', new Map([['b1', 'claude-1'], ['b2', 'claude-2']])]]);
    const out = openSessionMap({ ws1: ['b1', 'b2'] }, mappings);
    expect(out.get('claude-1')).toEqual({ workspaceId: 'ws1', brokerSessionId: 'b1' });
    expect(out.get('claude-2')).toEqual({ workspaceId: 'ws1', brokerSessionId: 'b2' });
    expect(out.size).toBe(2);
  });
  it('skips broker ids with no learned mapping', () => {
    const mappings = new Map([['ws1', new Map([['b1', 'claude-1']])]]);
    const out = openSessionMap({ ws1: ['b1', 'b-unmapped'] }, mappings);
    expect(out.size).toBe(1);
  });
  it('skips workspaces with no mapping table at all', () => {
    expect(openSessionMap({ ws9: ['b1'] }, new Map()).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/busySessions.test.ts`
Expected: FAIL — `openSessionMap` not exported.

- [ ] **Step 3: Implement**

Append to `src/renderer/src/busySessions.ts`:

```ts
/** A live terminal tab, addressed for jump-to-tab. */
export interface OpenTabRef {
  workspaceId: string;
  brokerSessionId: string;
}

/**
 * Resolve live tab *broker* ids to a claude-UUID-keyed open map, the same
 * translation busyClaudeIdSet does but keeping the (workspace, tab) address
 * so the Sessions list can jump to the tab. Unmapped broker ids are skipped
 * (they resolve once observability learns the mapping and the caller
 * re-resolves).
 */
export function openSessionMap(
  liveBrokerByWorkspace: Record<string, string[]>,
  mappings: Map<string, Map<string, string>>
): Map<string, OpenTabRef> {
  const out = new Map<string, OpenTabRef>();
  for (const [workspaceId, brokerIds] of Object.entries(liveBrokerByWorkspace)) {
    const map = mappings.get(workspaceId);
    if (!map) continue;
    for (const brokerSessionId of brokerIds) {
      const claudeId = map.get(brokerSessionId);
      if (claudeId) out.set(claudeId, { workspaceId, brokerSessionId });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/busySessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/busySessions.ts src/renderer/src/busySessions.test.ts
git commit -m "feat(sessions): openSessionMap resolves live tabs to claude UUIDs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: TerminalPane — report live tabs, consume activate requests

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx` (Props at 47–130; state at 255–307; resumeRequest effect at ~526 as the pattern)

No unit test (React component; the renderer test setup is pure-TS only). Deliverable is typecheck-clean prop plumbing that Task 5 wires; behavior is covered by the pure helpers (Tasks 2–3) and manual verification (Task 8).

**Interfaces:**
- Consumes: existing `sessions: Session[]`, `endedIds: Set<string>`, `setActiveId`, `loaded`.
- Produces (App consumes in Task 5):
  - Prop `onLiveIdsChange?: (workspaceId: string, brokerSessionIds: string[]) => void` — fired with the ids of tabs whose PTY is not ended; `[]` on unmount.
  - Props `activateRequest?: { brokerSessionId: string; token: number } | null` and `onActivateConsumed?: () => void` — token-guarded tab activation, mirroring `resumeRequest`/`onResumeConsumed`.

- [ ] **Step 1: Add the props**

In `interface Props` (after `onBusyIdsChange` at ~line 120):

```ts
  /** Live tab report for the Sessions list's Open group: the broker session
   *  ids of tabs whose PTY has not ended. Emitted on every tab-list or
   *  lifecycle change, and [] when this pane unmounts. */
  onLiveIdsChange?: (workspaceId: string, brokerSessionIds: string[]) => void;
```

After `onResumeConsumed?: () => void;` (~line 130):

```ts
  /** Activate an existing tab (Sessions-list jump-to-tab). Token-guarded
   *  like resumeRequest so the same tab can be jumped to repeatedly. */
  activateRequest?: { brokerSessionId: string; token: number } | null;
  onActivateConsumed?: () => void;
```

Destructure all three in the component parameter list (next to `onBusyIdsChange`, `resumeRequest`, `onResumeConsumed` at ~lines 237–239): `onLiveIdsChange,` `activateRequest,` `onActivateConsumed,`.

- [ ] **Step 2: Emit live ids**

After the `handleLifecycle` function (~line 307), add:

```ts
  // Report live tabs (Sessions-list Open group). A tab is live unless its
  // PTY has ended; endedIds is exactly that set. Cleared on unmount so a
  // stopped workspace's tabs leave the Open group immediately.
  useEffect(() => {
    if (!loaded) return;
    onLiveIdsChange?.(
      workspaceId,
      sessions.filter((s) => !endedIds.has(s.id)).map((s) => s.id)
    );
  }, [loaded, workspaceId, sessions, endedIds, onLiveIdsChange]);
  useEffect(() => {
    return () => onLiveIdsChange?.(workspaceId, []);
  }, [workspaceId, onLiveIdsChange]);
```

- [ ] **Step 3: Consume activate requests**

Directly after the existing `resumeRequest` effect (ends ~line 538), add:

```ts
  // Jump-to-tab from the Sessions list: activate an existing tab instead of
  // opening a duplicate resume tab. Same token dance as resumeRequest.
  const lastActivateToken = useRef(0);
  useEffect(() => {
    if (!loaded || !activateRequest) return;
    if (lastActivateToken.current === activateRequest.token) return;
    lastActivateToken.current = activateRequest.token;
    if (sessions.some((s) => s.id === activateRequest.brokerSessionId)) {
      setActiveId(activateRequest.brokerSessionId);
    }
    onActivateConsumed?.();
  }, [loaded, activateRequest, sessions, onActivateConsumed]);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TerminalPane.tsx
git commit -m "feat(terminal): report live tab ids; consume jump-to-tab activate requests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: App wiring — open map + jump-aware resume

**Files:**
- Modify: `src/renderer/src/App.tsx` (busy state at ~241; resume handler at ~306–337; resolve effect at ~683–726; TerminalPane props at ~1104–1112; SessionsPane props at ~1040–1046)

**Interfaces:**
- Consumes: `openSessionMap`, `OpenTabRef` from `./busySessions` (Task 3); TerminalPane props from Task 4.
- Produces: `openSessions: Map<string, OpenTabRef>` passed to `SessionsPane` as prop `openSessions` (Task 6 consumes); `activateRequest`/`onActivateConsumed` passed to each TerminalPane.

- [ ] **Step 1: Live-id state next to the busy state (~line 249, after `handleBusyIds`)**

```ts
  // Per-workspace LIVE broker session ids (tabs whose PTY hasn't ended),
  // bubbled up from each TerminalPane. Resolved with the busy set below into
  // the claude-UUID-keyed open map for the Sessions list's Open group.
  const [liveBrokerByWorkspace, setLiveBrokerByWorkspace] = useState<Record<string, string[]>>({});
  const handleLiveIds = useCallback((workspaceId: string, ids: string[]) => {
    setLiveBrokerByWorkspace((prev) => {
      const prevIds = prev[workspaceId] ?? [];
      if (prevIds.length === ids.length && prevIds.every((id) => ids.includes(id))) return prev;
      return { ...prev, [workspaceId]: ids };
    });
  }, []);
  const [openSessions, setOpenSessions] = useState<Map<string, OpenTabRef>>(new Map());
  const openSessionsRef = useRef(openSessions);
  useEffect(() => { openSessionsRef.current = openSessions; }, [openSessions]);
```

Import at the top (line ~18): `import { busyClaudeIdSet, openSessionMap, type OpenTabRef } from './busySessions';`

- [ ] **Step 2: Extend the resolve effect (683–726) to cover live ids**

Replace the `busyBrokerKey` serialization and the effect body so the mapping resolution covers the union of busy + live broker ids and computes both outputs. The full replacement (existing lines 683–726):

```ts
  const brokerResolveKey = JSON.stringify(
    [busyBrokerByWorkspace, liveBrokerByWorkspace].map((rec) =>
      Object.entries(rec)
        .filter(([, ids]) => ids.length > 0)
        .map(([ws, ids]) => [ws, [...ids].sort()] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    )
  );
  useEffect(() => {
    if (!apiReady) {
      setBusySessionIds(new Set());
      setOpenSessions(new Map());
      return;
    }
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      // One mapping fetch pass over the union of busy + live broker ids.
      const wanted = new Map<string, Set<string>>();
      for (const rec of [busyBrokerByWorkspace, liveBrokerByWorkspace]) {
        for (const [wsId, ids] of Object.entries(rec)) {
          if (ids.length === 0) continue;
          const set = wanted.get(wsId) ?? new Set<string>();
          for (const id of ids) set.add(id);
          wanted.set(wsId, set);
        }
      }
      const mappings = new Map<string, Map<string, string>>();
      await Promise.all(
        [...wanted.entries()].map(async ([wsId, ids]) => {
          const m = new Map<string, string>();
          await Promise.all(
            [...ids].map(async (brokerId) => {
              try {
                const sum = await window.api.observability.summaryForBrokerSession(wsId, brokerId);
                if (sum?.sessionId) m.set(brokerId, sum.sessionId);
              } catch {
                /* mapping not learned yet — resolves on a later pass */
              }
            })
          );
          mappings.set(wsId, m);
        })
      );
      if (cancelled) return;
      const nextBusy = busyClaudeIdSet(busyBrokerByWorkspace, mappings);
      setBusySessionIds((prev) =>
        prev.size === nextBusy.size && [...prev].every((id) => nextBusy.has(id)) ? prev : nextBusy
      );
      const nextOpen = openSessionMap(liveBrokerByWorkspace, mappings);
      setOpenSessions((prev) => {
        if (prev.size === nextOpen.size) {
          let same = true;
          for (const [k, v] of nextOpen) {
            const p = prev.get(k);
            if (!p || p.workspaceId !== v.workspaceId || p.brokerSessionId !== v.brokerSessionId) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return nextOpen;
      });
    };
    void resolve();
    const unsubscribe = window.api.observability.onSummary(() => void resolve());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, brokerResolveKey]); // eslint-disable-line react-hooks/exhaustive-deps
```

Keep the comment block above the original effect, updated to mention it now also feeds the Open group.

- [ ] **Step 3: Jump-aware resume + activate request (in/after handleResumeSession, ~306)**

Add state next to `resumeRequest` (~line 311):

```ts
  const [activateRequest, setActivateRequest] = useState<{
    workspaceId: string;
    brokerSessionId: string;
    token: number;
  } | null>(null);
  const activateTokenRef = useRef(0);
```

At the top of `handleResumeSession`'s try block (before the `window.api.sessions.resume` call at ~line 316):

```ts
        // Already open as a live tab somewhere? Jump to it instead of
        // spawning a duplicate `claude --resume` tab.
        const openTab = openSessionsRef.current.get(item.id);
        if (openTab) {
          setSelectedId(openTab.workspaceId);
          setActivateRequest({ ...openTab, token: ++activateTokenRef.current });
          return;
        }
```

- [ ] **Step 4: Pass the props down**

TerminalPane render site (~lines 1104–1112), alongside `onBusyIdsChange={handleBusyIds}` / `resumeRequest=…`:

```tsx
                  onLiveIdsChange={handleLiveIds}
                  activateRequest={
                    activateRequest?.workspaceId === w.id ? activateRequest : null
                  }
                  onActivateConsumed={() => setActivateRequest(null)}
```

SessionsPane render site (~line 1040–1046), alongside `busySessionIds`:

```tsx
                openSessions={openSessions}
```

- [ ] **Step 5: Typecheck + unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: clean / all pass. (SessionsPane doesn't accept `openSessions` yet — if typecheck fails on that one prop, add the prop to SessionsPane's Props interface now as `openSessions?: Map<string, { workspaceId: string; brokerSessionId: string }>;` with body usage landing in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/SessionsPane.tsx
git commit -m "feat(app): resolve live tabs to an open-session map; jump-aware resume

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: SessionsPane UI — Open/Recent groups, tags, filter row, FLIP

**Files:**
- Modify: `src/renderer/src/components/SessionsPane.tsx`
- Modify: `src/renderer/src/styles.css` (sessions-pane block, ~469–620)

**Interfaces:**
- Consumes: `filterSessions`, `partitionByOpen`, `tagCounts` (Task 2); prop `openSessions` (Task 5); existing CSS classes `.tag .pill .tag-menu .tag-menu-item .tm-count .nofm .library-filter`.
- Produces: the shipped UI. No new exports.

- [ ] **Step 1: Imports, props, state**

In `SessionsPane.tsx`, extend the `sessionsView` import: `import { sessionsForScope, filterSessions, partitionByOpen, tagCounts } from '../sessionsView';` and add `useLayoutEffect` to the React import.

Props (if not already added in Task 5 Step 5):

```ts
  /** claude UUID → live tab ref; drives the Open group. Rows in this map
   *  render under "Open · N" and resume() jumps to the tab (App decides). */
  openSessions?: Map<string, { workspaceId: string; brokerSessionId: string }>;
```

State (next to `query`):

```ts
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState(false);
  const toggleTag = (t: string): void =>
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
```

- [ ] **Step 2: Replace the ad-hoc filter with the helpers**

Replace the existing `const q = query.trim()… const filtered = …` block (currently ~lines 143–150, right after `scoped`/`allSessionsCount`) with:

```ts
  const q = query.trim().toLowerCase();
  const filtered = filterSessions(scoped, query, activeTags);
  const { open: openRows, recent: recentRows } = partitionByOpen(
    filtered,
    new Set(openSessions?.keys() ?? [])
  );
  const allTags = tagCounts(scoped);
```

(`q` stays for the empty-state copy branch that distinguishes "No matches" from "No sessions yet" — extend that condition to `q || activeTags.length > 0`.)

- [ ] **Step 3: Filter row in the header**

After the `<input className="sessions-search" …/>` element, inside the header div:

```tsx
        {allTags.length > 0 && (
          <div className="library-filter sessions-tagfilter">
            <button
              className="tag-dd"
              onClick={() => setTagMenu((o) => !o)}
              aria-expanded={tagMenu}
            >
              Tags ▾
            </button>
            {activeTags.map((t) => (
              <button key={t} className="pill" onClick={() => toggleTag(t)} title="Remove filter">
                {t} ✕
              </button>
            ))}
            <span className="nofm">
              {filtered.length} of {scoped.length}
            </span>
            {tagMenu && (
              <div className="tag-menu" onMouseLeave={() => setTagMenu(false)}>
                {allTags.map(([t, n]) => (
                  <label key={t} className="tag-menu-item">
                    <input
                      type="checkbox"
                      checked={activeTags.includes(t)}
                      onChange={() => toggleTag(t)}
                    />
                    <span>{t}</span>
                    <span className="tm-count">{n}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 4: Grouped list + row tags + FLIP**

Extract the current `filtered.map((s) => …)` row JSX into a local `renderRow = (s: SessionListItem): JSX.Element` function (verbatim body, plus the two changes below), then replace the single `<ul className="sessions-list">…</ul>` with:

```tsx
          <ul className="sessions-list">
            {openRows.length > 0 && (
              <li className="session-group-label" aria-hidden="true">
                <span className="session-group-dot" /> Open · {openRows.length}
                <span className="session-group-line" />
              </li>
            )}
            {openRows.map(renderRow)}
            {openRows.length > 0 && recentRows.length > 0 && (
              <li className="session-group-label recent" aria-hidden="true">
                Recent<span className="session-group-line" />
              </li>
            )}
            {recentRows.map(renderRow)}
          </ul>
```

Row changes inside `renderRow`:

1. `const isOpen = openSessions?.has(s.id) ?? false;` — extend the `<li>` className: `` className={`session-row${busy ? ' busy' : ''}${isOpen ? ' open' : ''}`} `` and add the FLIP ref + key attributes: `ref={rowRef(s.id)} data-sid={s.id}`.
2. Tags in the meta line — insert between the `session-row-time` span and the `session-row-cost` span:

```tsx
                      {s.tags.length > 0 && (
                        <span className="session-row-tags">
                          {s.tags.slice(0, 2).map((t) => (
                            <button
                              key={t}
                              className={`tag session-row-tag${activeTags.includes(t) ? ' on' : ''}`}
                              title={`Filter by "${t}"`}
                              onClick={() => toggleTag(t)}
                            >
                              {t}
                            </button>
                          ))}
                        </span>
                      )}
```

3. The title button's tooltip reflects the jump: `title={isOpen ? `Go to open tab — "${displayTitle(s)}"` : `Resume "${displayTitle(s)}"`}` (click handler stays `onResume(s)`; App routes it).

FLIP hook, placed with the other hooks in the component body:

```tsx
  // FLIP: rows animate to their new slot when they move between the Open and
  // Recent groups (or reorder). Positions are captured after every render;
  // deltas against the previous render animate via the Web Animations API.
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const rowRef = (id: string) => (el: HTMLLIElement | null): void => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };
  const prevRects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, el] of rowEls.current) {
      const rect = el.getBoundingClientRect();
      const prev = prevRects.current.get(id);
      if (prev) {
        const dy = prev.top - rect.top;
        if (dy !== 0) {
          el.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' }
          );
        }
      }
      next.set(id, rect);
    }
    prevRects.current = next;
  });
```

- [ ] **Step 5: Styles**

In `styles.css`, in the sessions-pane block (after `.session-row:hover` rule, ~line 512 of the worktree file — search for `/* ----- sessions pane (#3)`), add:

```css
/* Open group (live terminal tab somewhere in the fleet): green edge + tint,
   group headers split the list. Green = live, matching the busy dot. */
.session-row.open {
  border-left: 2px solid var(--ok);
  border-radius: 3px var(--r-md) var(--r-md) 3px;
  background: color-mix(in oklch, var(--ok), transparent 93%);
}
.session-row.open:hover { border-color: var(--rule); border-left-color: var(--ok); }
.session-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-2);
}
.session-group-label.recent { margin-top: 6px; }
.session-group-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.session-group-line { flex: 1; height: 1px; background: var(--rule-soft); }

/* Meta-line tags: house .tag chips (Library vocabulary) in the slack space
   between time and cost; they shrink/clip first when the line is tight. */
.session-row-tags { display: inline-flex; gap: 4px; min-width: 0; overflow: hidden; }
.session-row-tag { cursor: pointer; }
.session-row-tag:hover { color: var(--ink); border-color: var(--ink-3); }
.session-row-tag.on { color: var(--ok); border-color: var(--ok); }

/* Tag filter row reuses .library-filter spacing inside the stacked header. */
.sessions-header .sessions-tagfilter { margin: 0; }
```

- [ ] **Step 6: Typecheck, unit suite, build**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/SessionsPane.tsx src/renderer/src/styles.css
git commit -m "feat(sessions): Open/Recent grouping, summary tags, tag filter + FLIP motion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: e2e — tags flow through sessions:list; no Open group without live tabs

**Files:**
- Modify: `tests/sessions-list.spec.ts`

**Interfaces:**
- Consumes: the spec's existing seeding pattern (workspace manifest + JSONL transcript on disk, real app launch, `window.api.sessions.list()` wrappers). The JSONL watcher ingests `{"type":"session-summary",…}` lines — including `tags` — so tags can be seeded through the transcript file itself.
- Produces: regression coverage for the IPC payload shape + the pane's no-live-tabs rendering.

- [ ] **Step 1: Extend the spec**

In `tests/sessions-list.spec.ts`: (a) add `tags: string[]` to the local `SessionListItem` interface; (b) append a `session-summary` line to the seeded transcript JSONL (same write that seeds the user line):

```ts
JSON.stringify({ type: 'session-summary', summary: 'Seeded for the tags e2e.', tags: ['e2e-tag', 'seeded'] })
```

(c) add assertions to the main test after the existing list assertions:

```ts
  // Tags from the summary chapter ride the sessions:list payload (#spec:
  // sessions-open-group-and-tags). Order preserved from the summarizer.
  expect(rows[0].tags).toEqual(['e2e-tag', 'seeded']);

  // With no live terminal tab mapped to this session, the pane shows no
  // Open group — every row is plain "Recent" (no group headers at all
  // when the Open group is empty).
  await expect(window.locator('.session-group-label')).toHaveCount(0);
  await expect(window.locator('.session-row.open')).toHaveCount(0);
```

If the spec's page never opens the left-rail Sessions section, expand it first the same way other assertions in this spec reach the pane (follow the file's existing locator usage; if it asserts via IPC only, add the locator assertions after clicking the rail's Sessions section header `text=Sessions`).

- [ ] **Step 2: Run the spec**

Run: `npm run build && npx playwright test tests/sessions-list.spec.ts`
Expected: PASS. (Playwright needs a display — WSLg/Xvfb; if the environment has none, run `xvfb-run -a npx playwright test tests/sessions-list.spec.ts`.)

- [ ] **Step 3: Commit**

```bash
git add tests/sessions-list.spec.ts
git commit -m "test(e2e): sessions:list tags payload + empty Open group rendering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: SPEC.md + full gate + manual verification

**Files:**
- Modify: `docs/SPEC.md` (sessions-pane description — find it with `grep -n "Sessions" docs/SPEC.md`; the `sessions:list` row in the IPC channel table — `grep -n "sessions:list" docs/SPEC.md`)

- [ ] **Step 1: Update SPEC.md**

Three edits, written in the spec's dense present-tense style (no changelog prose):

1. **Sessions pane section** — describe: the list is grouped `Open · N` / `Recent`; a session is open iff a mounted workspace's terminal tab with a live (non-ended) PTY maps to it via `broker_sessions`; openness is renderer-derived (TerminalPane `onLiveIdsChange` → App resolves through `summaryForBrokerSession`, same trust model as the busy pulse; self-heals on observability pushes). Clicking an open row selects the workspace and activates the existing tab (`activateRequest`, token-guarded like `resumeRequest`) instead of opening a duplicate resume tab. Rows FLIP-animate between groups. Each row shows up to 2 tags from its latest tagged summary chapter using the Library `.tag` style; a `Tags ▾` checkbox menu (counts, multi-select OR) + green `.pill` active filters + `N of M` count sit under the search field; the text search also matches tag text. Non-goals: no persistent open state, no `#` search grammar, no main-process open derivation.
2. **IPC table, `sessions:list`** — note the row payload now includes `tags: string[]` (latest tagged summary chapter, relevance-ordered, `[]` when unsummarized).
3. **Renderer data-flow subsection** (where `onBusyIdsChange`/`resumeRequest` are described, if present) — add `onLiveIdsChange` and `activateRequest` alongside them.

- [ ] **Step 2: Full gate**

Run: `npm test`
Expected: unit suite passes → build succeeds → playwright suite passes. Fix anything that fails before proceeding (and say so in the report if something was flaky-retried).

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): sessions pane Open/Recent grouping, jump-to-tab, summary tags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Manual verification note**

Automated coverage cannot exercise a real live tab → Open-group → jump-to-tab loop (needs a running container with a learned broker mapping). Flag for a manual pass in the real app (the session driving this work IS a claude-fleet workspace — the reviewer can check the left rail directly): open two sessions in a workspace, confirm both rows sit under `Open · 2`, close one tab and watch the row slide to Recent, click the other row from a different selected workspace and confirm it jumps to the right workspace + tab, and confirm tag chips + `Tags ▾` filtering once the summarizer has tagged something.
