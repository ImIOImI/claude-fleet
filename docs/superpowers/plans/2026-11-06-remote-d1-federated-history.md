# Remote workspaces (d1): federated history reads and `query` isolation on the host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop's Sessions list and Observability rail show a remote workspace's history next to local history, with origin badges and an "unavailable" note per unreachable host. The host's fleet-state MCP serves `query`, isolated by role and row-level security.

**Architecture:** The host gains two `read`-tier RPC channels, `history:sessions` (a keyset page) and `history:summary`, served by a `HistoryReader` that the holder builds on its own state store. The reader always scopes to the hosted workspace. A `FederatedReader` in main fans these out to every bookmarked host. It skips hosts that c2's cached liveness already marks down, bounds each call at 3 s, validates and caps every reply, and reports failed hosts under `unavailable`. The local `sessions:list` path is unchanged. The renderer merges local rows with remote pages through one pure module (`src/preload/federation.ts`), shared with main, that gives every row an `origin`. The host pushes a data-free `observability:summary` hint after ingest. A main-side relay turns that hint into an RPC read and the existing renderer push. On the host, the holder opens the MCP read source with `PgQueryIsolation` (part 4a) as a login `fleet-host bootstrap` pre-provisions (D71), so `query` joins `HOST_MCP_TOOLS`. The app role stays `NOCREATEROLE`.

**Tech Stack:** TypeScript (NodeNext for `src/host`), Node 22, Electron main + React renderer, `pg` + Kysely, vitest on SQLite and PG 16 (`scripts/pg-test-server.sh`, `vitest.pg.config.ts`).

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §1, §6, §7 (*Reads federate*, *Remote data is live-only*, *MCP `query` isolation on Postgres*), §8 (*Degraded state*), §9, §11 item (d), §12 (d). `docs/SPEC.md` §6 *Sessions*, *Observability*, *Remote*; §7 *Remote host* (*Host MCP*, *Routes*, *Bootstrap and migrate*); §9 (*MCP `query` on Postgres*, *The GitHub token reaches a remote host only with consent*); §11 *Remote host: what remains*. Plans: async-store part 4a (`ReadSource`, D40–D44), remote c2 (`RemoteClient`, `remote:*`), c3 (the `ReadSource` gaps that (d) must close), c3b (`HOST_MCP_TOOLS`, `startHolder`).

**Sibling plan:** (d2) `2026-11-06-remote-d2-federated-search.md` covers `search_transcripts` on the host, the host embedder and federated search. It builds on Task 1 and Task 6–8 here.

## Global Constraints

Every task implicitly includes these.

- **Spec, verbatim:**
  - "A `FederatedReader` in main fans each read out to the local store plus every connected `RemoteClient`, applies a per-source timeout (3 s), and merges the results." (§7)
  - "Merging is by the field the channel already sorts on (`last_active_at`, priority then recency, `nextFireAt`). Each row carries `origin: 'local' | <remoteWorkspaceId>`." (§7)
  - "A source that times out or errors is dropped from that result, and the response lists it under `unavailable`." (§7)
  - "Actions are not federated. Each one is an RPC to the host that owns the row." (§7)
  - "**Remote data is live-only (decided, A).** … Nothing remote is persisted locally, apart from the bookmark manifest and a cached avatar per login." (§7)
  - "federated views show local data plus a "1 source unavailable" note. Nothing remote is shown stale, because remote data is live-only." (§8)
  - "Each MCP caller gets its own **read-only role** … **Row-level security** on `events`, `sessions` and `broker_sessions` limits rows to the caller's allowed scope … Each `query` runs in a `READ ONLY` transaction under `SET LOCAL ROLE`, with `statement_timeout`. The existing guards still apply: single statement, row cap, result cap." (§7)
  - "Vault contents, local transcripts of non-published workspaces, `config.json` and local inbox rows never leave the desktop." (§9)
- **Local paths stay as they are.** `sessions:list`, `db.ts listSessions`, and the SQLite and Postgres read SQL are unchanged. A desktop with no remote bookmark makes no new network call and does no new work beyond one in-memory lookup per summary call.
- **Host scope comes from the host.** Every history read uses the `host_meta` workspace id. Arguments carry only a cursor, a limit and a session id, and none of them can widen the scope.
- **Untrusted host replies:** validate every field, cap every string and array, and drop rows that fail. A malformed envelope marks the source `unavailable` with reason `protocol`. Remote text renders only as React text nodes, never as Markdown or HTML.
- **c1–c3b seams unchanged:** `dispatchRpc` (extended with one error class), `RpcChannel`, `EventHub.publish` with `EVENT_CHANNELS`, `startHolder` (extended), `RemoteClient` (one optional `rpc` argument), `RemoteBackend` (two read accessors).
- **Repo rules:**
  - Comments are terse and necessary (`/workspace/.claude/rules/review-conventions.md`).
  - SPEC.md is updated in this PR (Task 10).
  - Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Environment:**
  - Work in your own worktree: `W=/workspace/claude-fleet/.claude/worktrees/<name>`. Use `git -C "$W"`. Never `cd /workspace/claude-fleet`. Never stage `.superpowers/`.
  - Set up dependencies with `npm ci --ignore-scripts --no-audit --no-fund` in the worktree, then `printf 'electron-stub' > node_modules/electron/path.txt`.
  - Typecheck the three configs separately: `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, `npx tsc -p tsconfig.host.json`.
  - For Postgres tests, run `scripts/pg-test-server.sh start`, export the `PG_TEST_URL` it prints, then run `npx vitest run -c vitest.pg.config.ts <file>`.
  - Secret hygiene: never run `bash -x`/`set -x`, `env` or `printenv`.
  - There is no display in the container. Gate UI tasks with typecheck, unit tests and `npm run build`, and say so in the PR. Troy eyeballs the UI on his host.

## Decisions

D1–D52 (async-store parts 2–4b) still bind. (d) adds D53–D71. D53–D63, D69–D70 and D71 are recorded in SPEC.md by Task 10 here. D64–D68 are recorded by (d2).

- **D53: (d) ships in two PRs.**
  - **(d1), this plan:** history federation (Sessions and Observability) and `query` on the host.
  - **(d2):** search. It needs an embedder and an indexer on the host, an image change with its own review.
  - Each part ships on its own. (d1) gives one merged history view. (d2) adds the merged search view.
- **D54: Federation runs over host RPC, never over a database connection.**
  - New channels on `POST /rpc/<channel>`, all at tier `read`: `history:sessions` and `history:summary` (d1); `history:search` (d2). A desktop can read on a host only what `read` there allows, and each host's existing per-route check enforces it.
  - **Scope is the host's.** The channels are served by a `HistoryReader` that the holder builds with its `host_meta` workspace id (`historyRead.ts`). Every query has `workspace_id = <hosted>` in its own SQL. Arguments are parsed strictly: a cursor `{lastActiveAt: safe integer ≥ 0, id: [A-Za-z0-9_.:-]{1,128}}`, a limit of 1–200, a session id of the same charset. None of them is an identifier the SQL interpolates.
  - **Not the holder:** with no `db:`, or before the holder's stores open, the channels answer 503 `history unavailable` (new `RpcUnavailableError`). A standby already answers 503 `standby` before dispatch.
  - **Caps:** the existing ones (request body ≤ 64 KiB, 8 RPCs in flight per identity, desktop reply cap 2 MB). A page holds at most 200 sessions. `history:summary` is the desktop's `WorkspaceSummary`, whose arrays are already bounded on the host (top tools 5, recent calls and series by the summary query); the desktop re-caps them (D59).
  - **Rejected, a direct Postgres connection from the desktop:** it would need per-person database roles on the host, bypass the tier model, and put DB credentials on every desktop.
- **D55: Origin identity on rows** (closes c3's "no origin identity" gap).
  - Every federated row carries `origin: 'local' | <remote workspace id>`. A row's identity is `(origin, workspaceId, id)`.
  - **Can a session appear twice?** Not before (e). The desktop stores no remote rows, and a host ingests only its own projects under its own workspace id. (e) publishes a desktop's sessions to a host under the publisher's source workspace id, so the same `(workspaceId, id)` can then come from `local` and a host.
  - **Dedup rule, built now:** rows are deduplicated on `(workspaceId, id)`. Local wins, then origins in byte order.
  - **Until (e):** the desktop drops any remote row whose `workspaceId` isn't that bookmark's id, and the host returns only hosted-workspace rows. (e) widens both to the published partitions.
- **D56: Tie-safe keyset cursors, merged across sources** (closes c3's "no stable cursor" gap).
  - **Per source:** the order is exactly `db.ts listSessions`, `COALESCE(last_active_at, 0) DESC, id`. On the host, `id` compares `COLLATE "C"` (byte order) in both the `ORDER BY` and the keyset predicate, so ties at a page edge are neither skipped nor repeated. The cursor is the last row's `{lastActiveAt, id}`. A page asks for `limit + 1` rows, so `next` is null exactly when the source is exhausted.
  - **Across sources:** `mergeSessionPages` sorts every loaded row by `(key, origin)`. Each source's rows are a prefix of its own order.
    - An incomplete source keeps a horizon, `more: {origin, after}`. "Load more from <host>" fetches that source's next page (`appendSessionPage`).
    - A push-triggered refresh replaces a source's rows with its fresh first page (`replaceSessionPage`), which drops that source's extra pages. That is acceptable for live-only data.
  - **Local stays a full list** from the unchanged `sessions:list`. So the merged list is exact above every remote horizon, and below one it shows local rows plus a "load more" row.
  - **Validated** in a scratch worktree on origin/main `1044353`, removed afterwards:
    - `mergeSessionPages`/`appendSessionPage`/`replaceSessionPage`: two sources (37 and 23 rows, heavy ties, NULLs) paged 5 at a time by keyset end equal to a one-shot merge, with no duplicates.
    - `sessionsPage` on PG 16: 25 hosted sessions with ties and NULL `last_active_at`, paged 4 at a time, equal the one-shot page. A second workspace's rows in the same schema never appear, even with a cursor built from one of them. `eventCount`/`usd` come from `session_costs`. Malformed requests throw `HistoryArgError`.
    - `tsc -p tsconfig.node.json` is clean.
- **D57: Merge semantics, timeouts and liveness.**
  - **Sort:** sessions by `(lastActiveAt DESC NULLS as 0, id, origin)`. Observability isn't merged: a summary belongs to one workspace, so a remote id is routed to its host (D58).
  - **Per-source timeout: 3 s** (spec). The desktop passes it to `RemoteClient.rpc`, which aborts the fetch, and also races it, so a stalled token read can't hang either.
  - **Liveness:** c2's cached probe state (`RemoteBackend` watches, 15 s `/healthz` + `/whoami`) gates every call. `unreachable` or not-yet-probed (`null`) answers `unavailable` (`unreachable` / `checking`) at once, with no network call. A down host therefore costs nothing per read.
  - **Errors to reasons:** `RemoteError.kind` maps to `unreachable`, `unauthorized`, `forbidden`, `standby`, `not-signed-in`, `protocol`; a race timeout maps to `timeout`; a validation failure maps to `protocol`. The UI shows one line: "N source(s) unavailable: <names>".
  - **In-flight dedupe:** identical concurrent calls (same host, channel and args) share one request. Nothing is cached after it settles (D62).
- **D58: Observability is routed, and pushed by hint.**
  - `observability:summaryForWorkspace(id)` and `observability:summaryForBrokerSession(id, tab)` route a remote id to `history:summary`. A known-remote check is an in-memory lookup in `RemoteBackend`, with no disk read. The host has no tab mapping, so a remote tab gets the workspace's latest session. That is the same fallback the local channel uses when a mapping is unknown.
  - **Push:** after an ingest chunk commits, the holder publishes `observability:summary` with payload `{workspaceId}` only, debounced 2 s (trailing). The channel is already allowlisted, and the hint carries no data, so tier checks stay on the RPC.
  - A main-side `SummaryRelay` holds one `/events` subscription per remote bookmark (`RemoteClient.subscribe`, which already reconnects with backoff). On a hint it fetches `history:summary`, debounced 2 s per host, and sends the existing renderer `observability:summary` push.
  - A failed fetch sends nothing, so the rail keeps its last value until App's 30 s safety poll, which goes through the same routed channel.
  - **Socket budget:** the relay adds one `/events` socket per bookmark per desktop. It counts toward the host's 8 `/attach` + `/events` sockets per identity.
- **D59: Security.**
  - **What crosses the network:** to each host, under the user's own bearer, only that host's own cursors and limits, session ids the host itself returned, and (d2) a query vector, which goes only to hosts in the chosen search scope (D67). No local row, id or text is sent.
  - **Validation** (`federation/remoteRows.ts`):
    - Ids match `[A-Za-z0-9_.:-]{1,128}`. Timestamps and counts are safe integers ≥ 0. `usd` and series values are finite.
    - Strings pass `oneLine` (controls and `\p{Cf}` stripped) with caps: title fields 500, model 128, tool name 64, tool input 2000, tags 64 each and at most 20.
    - Arrays are capped: 200 sessions, 20 top tools, 50 recent calls, 200 series points.
    - A bad row is dropped. A bad envelope or cursor throws and marks the source unavailable (`protocol`).
  - **Rendering:** remote rows render through the existing row components as text. The cloud glyph and `title` attributes show the host name from the bookmark, not from the reply.
  - **Tiers:** every history channel is `read`, so any granted person can read history, as with `/attach` `HISTORY`. The desktop greys out actions but enforces nothing (D63).
- **D60: `query` isolation on the host reuses `PgQueryIsolation` unchanged.**
  - The holder opens its MCP read source with `openPgMcpReadSource(stores.poolConfig.schema, stores.poolConfig, …)` on the fenced state handle. Provisioning (`ensureIsolation`) and each call's `mcp_grants` rewrite are fenced writes, so only the holder provisions. The caller is the hosted workspace id, and its scope is `{hosted}`. `query` joins `HOST_MCP_TOOLS` (14 tools).
  - **Roles and logins: superseded by D71.** The app role stays `NOCREATEROLE`; the CREATEROLE grant and the minted SCRAM caller logins described here before D71 were not built.
  - **What it protects, honestly:**
    - Until the container split, sessions share fleet-host's uid and pod identity, so a session can mint an IAM token as the app role. That role owns the tables, so it bypasses RLS.
    - Until (e), the host holds only its own workspace's rows, so RLS has nothing else to hide yet.
    - It becomes a boundary with the split (sessions get the read-only `llm-bot` role) and matters once (e) adds partitions.
- **D71: Host `query` runs as a bootstrap-provisioned IAM login; the app role stays `NOCREATEROLE`** (decided by Troy, 2026-11-06; supersedes D60's role parts). `fleet-host bootstrap` (admin credentials) pre-provisions the isolation roles `<schema>_mcp_reader` and `<schema>_mcp_raw`, and one query login `<app>_query` (`db.queryUser`, default `<db.user>_query`): `LOGIN NOINHERIT CONNECTION LIMIT 4`, no password, `rds_iam` when that role exists, never a member of the app role, plus its `_raw` sibling and the edges `provision()` makes. Bootstrap revokes any other membership of those roles, and the app role gets no ADMIN on them. `PgQueryIsolation`'s `preprovisioned` mode skips the CREATEROLE check and all role DDL, signs in by an RDS IAM token for that login, and still rewrites `mcp_grants` (`{hosted}`) on every call. Each call first checks that the login reaches no role beyond its own four and `rds_iam`; otherwise `query` answers unavailable. A missing role or a refused login also answers unavailable, and the other 13 tools work. Non-IAM hosts get no `query`. All host `query` calls share the one login, so they run one at a time, and past the queue (8) answer busy. Host checklist: re-run bootstrap, and the infra grant `rds-db:connect` on `fleet_agent_query`.
- **D61: Performance.** Lessons from #384/#391: no added work on hot local paths, no polling where a push exists, and bounded work per event.
  - `sessions:list` and local summaries are untouched. The remote check is a `Map` lookup.
  - Remote reads run only when a bookmark exists. The Sessions pane refreshes remote pages:
    - on mount;
    - on a remote summary push for that origin (throttled 5 s per origin);
    - on the 60 s timer;
    - on the manual refresh.
  - Local pushes never trigger a remote fetch.
  - Replies are capped at 200 rows and 2 MB, and parsed once.
  - The renderer merge is memoised on its inputs and returns the local array untouched when no remote rows exist.
  - New IPC channels are spanned by the generic `perfIpc` wrapper. `sessions:listRemote` takes no workspace argument, so it is not in `CHANNEL_CONTEXT`.
- **D62: Live-only is kept.** No remote row, summary or hit is written to disk or cached past its in-flight request. A host that goes down drops out of the next read, with the unavailable note. The relay sends nothing for it.
- **D63: Remote rows' actions.**
  - Rename and Delete are hidden on remote rows. They are local-DB actions, and write RPCs to a host are out of scope here (spec §7 *Actions are not federated*).
  - Resume shows only when the bookmark's tier is `session`. `sessions:resume` returns `{ containerId: <remote id> }` for a remote id without starting anything. The tab then attaches with `--resume`, which c2's `/attach` `CREATE` already supports and the host tier-checks.
- **D69: Host summary hint lives in the holder** (`trailingHint`, 2 s). `HostIngest` gains `onIngested(sessionId)`, called after a chunk's transaction commits, never inside it.
- **D70: The HNSW deferral (D44) stays deferred.** The host corpus is still one workspace until (e). (d2) re-measures.

## File structure

| File | Responsibility |
|---|---|
| `src/preload/federation.ts` (new) | Origin, keyset cursor, `mergeSessionPages`/`appendSessionPage`/`replaceSessionPage`/`pagesOf`, `UnavailableSource`, `RemoteSessionsResult`. Pure; imported by main, host and renderer. |
| `src/host/historyRead.ts` (new) | `parseSessionsReq`, `parseSessionId`, `sessionsPage` (keyset SQL), `historyReader(k, workspaceId)`. |
| `src/host/historyRpc.ts` (new) | `historyRpcChannels(reader)`: `history:sessions`, `history:summary`. |
| `src/host/rpc.ts` | `RpcUnavailableError` → 503. |
| `src/host/holder.ts` | `Holder.history`; summary hint; MCP read source with isolation. |
| `src/host/hostIngest.ts` | `onIngested` option. |
| `src/host/hostMcp.ts` | `query` in `HOST_MCP_TOOLS`. |
| `src/host/bootstrap.ts` | Pre-provisions the isolation roles and the `<app>_query` login (D71). |
| `src/host/main.ts` | Registers the history channels against the live holder. |
| `src/main/remoteClient.ts` | `rpc(channel, args, { timeoutMs })`. |
| `src/main/remote.ts` | `RemoteBackend.sources()`, `isRemote(id)`. |
| `src/main/federation/remoteRows.ts` (new) | Validators: `parseSessionsPage`, `parseSummary`. |
| `src/main/federation/federatedReader.ts` (new) | Fan-out, liveness gate, 3 s bound, dedupe, `unavailable`. |
| `src/main/federation/summaryRelay.ts` (new) | `/events` hint → RPC → renderer push. |
| `src/main/federation/federationIpc.ts` (new) | `sessions:listRemote`. |
| `src/main/ipc.ts` | Wiring; observability routing; remote `sessions:resume`. |
| `src/preload/index.ts` | `sessions.listRemote`; `SessionListItem.origin`. |
| `src/renderer/src/sessionsView.ts` | `withRemote`, `isRemoteRow`. |
| `src/renderer/src/components/CloudGlyph.tsx` (new) | The cloud glyph, moved out of `WorkspaceTabStrip.tsx`. |
| `src/renderer/src/components/SessionsPane.tsx` | Remote pages, badges, unavailable note, load more, actions. |
| `docs/SPEC.md` | §6, §7, §9, §11 (Task 10). |

---

### Task 1: The federation module (origin, cursors, merge)

**Files:**
- Create: `src/preload/federation.ts`
- Test: `src/preload/federation.test.ts`
- Modify: `tsconfig.web.json` (include the new file)

**Interfaces:**
- Produces:
  - `LOCAL_ORIGIN = 'local'`.
  - `SessionKey { lastActiveAt: number | null; id: string }` and `SessionCursor { lastActiveAt: number; id: string }`.
  - `compareBytes`, `compareSessionKey`, `cursorOf`.
  - `SourcePage<T> { origin; rows: T[]; next: SessionCursor | null }`, `WithOrigin<T>`, and `MergedSessions<T> { rows: WithOrigin<T>[]; more: { origin; after: SessionCursor }[] }`.
  - `mergeSessionPages`, `pagesOf`, `appendSessionPage`, `replaceSessionPage`.
  - `UnavailableReason`, `UnavailableSource { origin; name; reason }`, `RemoteSessionsResult<T> { pages: SourcePage<T>[]; unavailable: UnavailableSource[] }`.

- [ ] **Step 1: Write the failing test** — `src/preload/federation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { appendSessionPage, replaceSessionPage, compareSessionKey, cursorOf, mergeSessionPages, type SessionCursor, type SourcePage } from './federation';

type R = { id: string; workspaceId: string; lastActiveAt: number | null };
const row = (id: string, la: number | null, ws = 'W'): R => ({ id, workspaceId: ws, lastActiveAt: la });

/** A source that pages its sorted rows by keyset, as the host does. */
function pager(origin: string, all: R[]) {
  const sorted = [...all].sort(compareSessionKey);
  return (after: SessionCursor | null, limit: number): SourcePage<R> => {
    const rest = after ? sorted.filter((r) => compareSessionKey(r, { lastActiveAt: after.lastActiveAt, id: after.id }) > 0) : sorted;
    const rows = rest.slice(0, limit);
    return { origin, rows, next: rest.length > limit ? cursorOf(rows[rows.length - 1]) : null };
  };
}

describe('mergeSessionPages', () => {
  it('pages through ties without skips or repeats and ends equal to a one-shot merge', () => {
    const a = Array.from({ length: 37 }, (_, i) => row(`a${String(i).padStart(2, '0')}`, 1000 - (i % 4), 'A'));
    const b = Array.from({ length: 23 }, (_, i) => row(`b${String(i).padStart(2, '0')}`, i % 3 === 0 ? null : 1000 - (i % 5), 'B'));
    const pa = pager('HA', a), pb = pager('HB', b);
    let m = mergeSessionPages([pa(null, 5), pb(null, 5)]);
    let guard = 0;
    while (m.more.length && guard++ < 100) {
      const next = m.more[0];
      m = appendSessionPage(m, (next.origin === 'HA' ? pa : pb)(next.after, 5));
    }
    expect(m.more).toEqual([]);
    const ids = m.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(60);
    const full = mergeSessionPages([pa(null, 1000), pb(null, 1000)]);
    expect(ids).toEqual(full.rows.map((r) => r.id));
  });

  it('drops a duplicate (workspaceId, id), keeping the local row', () => {
    const m = mergeSessionPages([
      { origin: 'H1', rows: [row('s', 5, 'W1')], next: null },
      { origin: 'local', rows: [row('s', 5, 'W1')], next: null },
    ]);
    expect(m.rows).toEqual([{ ...row('s', 5, 'W1'), origin: 'local' }]);
  });

  it('a row above every horizon is final; NULL lastActiveAt sorts as 0', () => {
    const m = mergeSessionPages([
      { origin: 'local', rows: [row('l1', 9), row('l2', null)], next: null },
      { origin: 'H', rows: [row('h1', 7)], next: { lastActiveAt: 7, id: 'h1' } },
    ]);
    expect(m.rows.map((r) => r.id)).toEqual(['l1', 'h1', 'l2']);
    expect(m.more).toEqual([{ origin: 'H', after: { lastActiveAt: 7, id: 'h1' } }]);
  });

  it('replaceSessionPage swaps one source and keeps the others', () => {
    const m = mergeSessionPages([
      { origin: 'local', rows: [row('l1', 9)], next: null },
      { origin: 'H', rows: [row('h1', 7), row('h2', 6)], next: { lastActiveAt: 6, id: 'h2' } },
    ]);
    const r = replaceSessionPage(m, { origin: 'H', rows: [row('h3', 10)], next: null });
    expect(r.rows.map((x) => `${x.origin}:${x.id}`)).toEqual(['H:h3', 'local:l1']);
    expect(r.more).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/preload/federation.test.ts`
Expected: FAIL — `Failed to resolve import "./federation"`.

- [ ] **Step 3: Implement** `src/preload/federation.ts`:

```ts
// Federated reads (remote-workspaces (d)): origin identity, keyset cursors and
// the cross-source merge. Pure; main, the host and the renderer import it.

export const LOCAL_ORIGIN = 'local';
export type Origin = string;

/** listSessions' order: COALESCE(last_active_at, 0) DESC, then id in byte order. */
export interface SessionKey { lastActiveAt: number | null; id: string }
export interface SessionCursor { lastActiveAt: number; id: string }

export function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSessionKey(a: SessionKey, b: SessionKey): number {
  return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || compareBytes(a.id, b.id);
}

export function cursorOf(k: SessionKey): SessionCursor {
  return { lastActiveAt: k.lastActiveAt ?? 0, id: k.id };
}

/** One source's newest-first page. `next` null: the source has nothing older. */
export interface SourcePage<T> { origin: Origin; rows: T[]; next: SessionCursor | null }

export type WithOrigin<T> = T & { origin: Origin };

export interface MergedSessions<T> {
  rows: WithOrigin<T>[];
  /** Per incomplete source: rows at or after this key are not loaded yet. */
  more: { origin: Origin; after: SessionCursor }[];
}

export type UnavailableReason =
  | 'unreachable' | 'checking' | 'timeout' | 'unauthorized' | 'forbidden' | 'standby' | 'not-signed-in' | 'protocol' | 'model';

export interface UnavailableSource { origin: Origin; name: string; reason: UnavailableReason }

export interface RemoteSessionsResult<T> { pages: SourcePage<T>[]; unavailable: UnavailableSource[] }

/** Merges pages from different sources. Each source's rows must be a prefix of
 *  that source's order; a row whose (workspaceId, id) another origin already
 *  holds is dropped, local first, then origins in byte order. */
export function mergeSessionPages<T extends SessionKey & { workspaceId: string }>(pages: SourcePage<T>[]): MergedSessions<T> {
  const ordered = [...pages].sort((a, b) =>
    a.origin === LOCAL_ORIGIN ? -1 : b.origin === LOCAL_ORIGIN ? 1 : compareBytes(a.origin, b.origin));
  const seen = new Set<string>();
  const rows: WithOrigin<T>[] = [];
  for (const p of ordered) {
    for (const r of p.rows) {
      const key = `${r.workspaceId}\u0000${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...r, origin: p.origin });
    }
  }
  rows.sort((a, b) => compareSessionKey(a, b) || compareBytes(a.origin, b.origin));
  const more = ordered.filter((p) => p.next !== null).map((p) => ({ origin: p.origin, after: p.next as SessionCursor }));
  return { rows, more };
}

/** The per-source pages a merged list was built from. */
export function pagesOf<T extends SessionKey & { workspaceId: string }>(m: MergedSessions<T>): SourcePage<T>[] {
  const by = new Map<Origin, SourcePage<T>>();
  const page = (o: Origin): SourcePage<T> => {
    let p = by.get(o);
    if (!p) by.set(o, (p = { origin: o, rows: [], next: null }));
    return p;
  };
  for (const r of m.rows) {
    const { origin, ...row } = r;
    page(origin).rows.push(row as unknown as T);
  }
  for (const x of m.more) page(x.origin).next = x.after;
  return [...by.values()];
}

/** Adds a source's next page (fetched with that source's `more.after`). */
export function appendSessionPage<T extends SessionKey & { workspaceId: string }>(cur: MergedSessions<T>, page: SourcePage<T>): MergedSessions<T> {
  const pages = pagesOf(cur);
  const prev = pages.find((p) => p.origin === page.origin);
  const rest = pages.filter((p) => p.origin !== page.origin);
  return mergeSessionPages([...rest, { origin: page.origin, rows: [...(prev?.rows ?? []), ...page.rows], next: page.next }]);
}

/** Replaces everything loaded from one source with its fresh first page. */
export function replaceSessionPage<T extends SessionKey & { workspaceId: string }>(cur: MergedSessions<T>, page: SourcePage<T>): MergedSessions<T> {
  return mergeSessionPages([...pagesOf(cur).filter((p) => p.origin !== page.origin), page]);
}
```

In `tsconfig.web.json`, add `"src/preload/federation.ts"` to `include` after `"src/preload/captureSettings.ts"`.

- [ ] **Step 4: Run the tests and both typechecks**

Run: `npx vitest run src/preload/federation.test.ts && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 4 passed; both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/preload/federation.ts src/preload/federation.test.ts tsconfig.web.json
git -C "$W" commit -m "feat(federation): origin-tagged keyset merge across sources (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Host history reads, scoped to the hosted workspace

**Files:**
- Create: `src/host/historyRead.ts`
- Test: `src/host/historyRead.pg.test.ts`
- Modify: `vitest.pg.config.ts` (add the test file), `src/host/importGraph.test.ts` (allow `preload/federation.ts`)

**Interfaces:**
- Consumes:
  - `SessionCursor` (Task 1).
  - `listSessionCostsQuery`, `HEADLESS_BROKER_PREFIX`, `summaryForWorkspace`, `summaryForSession` and `type WorkspaceSummary` from `src/main/db.ts`.
  - `costFor` from `src/main/pricing.ts`; `readTransaction` from `src/main/store/kysely.ts`.
- Produces:
  - `SESSIONS_PAGE_MAX = 200`, `class HistoryArgError`.
  - `parseSessionsReq(v: unknown): SessionsPageReq`, `parseSessionId(v: unknown): string | null`.
  - `RemoteSessionRow` (the `SessionListRow` fields), `SessionsPage { rows: RemoteSessionRow[]; next: SessionCursor | null }`.
  - `sessionsPage(k, workspaceId, req): Promise<SessionsPage>`.
  - `HistoryReader { workspaceId; sessions(req): Promise<SessionsPage>; summary(sessionId: string | null): Promise<WorkspaceSummary | null> }`.
  - `historyReader(k: () => Kysely<StateDb>, workspaceId): HistoryReader`.

- [ ] **Step 1: Write the failing test** — `src/host/historyRead.pg.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { STATE_PG_TRACK } from '../main/store/migrations/statePg.js';
import type { StateDb } from '../main/store/stateSchema.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HistoryArgError, parseSessionId, parseSessionsReq, sessionsPage, type SessionsPageReq } from './historyRead.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';

describe('parseSessionsReq / parseSessionId', () => {
  it('refuses malformed requests', () => {
    expect(() => parseSessionsReq({ limit: 0 })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ limit: 201 })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq([])).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: { lastActiveAt: 1.5, id: 'x' } })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: { lastActiveAt: 1, id: "x' OR 1=1" } })).toThrow(HistoryArgError);
    expect(parseSessionsReq({})).toEqual({ after: null, limit: 200 });
    expect(parseSessionId(undefined)).toBeNull();
    expect(() => parseSessionId('a b')).toThrow(HistoryArgError);
  });
});

describe.skipIf(!isPg)('sessionsPage', () => {
  let t: TestPg | null = null;
  afterEach(async () => { await t?.drop(); t = null; });

  async function rig(): Promise<Kysely<StateDb>> {
    t = await testPgSchema();
    const k = postgresKysely<StateDb>(t.pool);
    await migratePostgres(k, t.schema, STATE_PG_TRACK);
    const rows = [];
    for (let i = 0; i < 25; i++) rows.push({ id: `s-${String(i).padStart(2, '0')}`, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: i % 4 === 0 ? null : 1000 - (i % 3), ai_title: null, first_user_message: `m${i}`, user_set_name: null });
    for (let i = 0; i < 10; i++) rows.push({ id: `o-${i}`, workspace_id: OTHER, cwd: null, started_at: 1, last_active_at: 5000, ai_title: null, first_user_message: 'secret', user_set_name: null });
    await k.insertInto('sessions').values(rows).execute();
    await k.insertInto('session_costs').values({ session_id: 's-01', workspace_id: HOSTED, model: 'claude-opus-4-1', service_tier: '', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, event_count: 3 }).execute();
    return k;
  }

  it('pages tie-safe, newest first, and never leaves the hosted workspace', async () => {
    const k = await rig();
    const seen: string[] = [];
    let after: SessionsPageReq['after'] = null;
    for (let i = 0; i < 20; i++) {
      const p = await sessionsPage(k, HOSTED, { after, limit: 4 });
      seen.push(...p.rows.map((r) => r.id));
      expect(p.rows.every((r) => r.workspaceId === HOSTED)).toBe(true);
      if (!p.next) break;
      after = p.next;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    const one = await sessionsPage(k, HOSTED, { after: null, limit: 200 });
    expect(seen).toEqual(one.rows.map((r) => r.id));
    expect(one.next).toBeNull();
    expect(one.rows.find((r) => r.id === 's-01')?.eventCount).toBe(3);
    expect(one.rows.find((r) => r.id === 's-01')!.usd).toBeGreaterThan(0);
    const forged = await sessionsPage(k, HOSTED, parseSessionsReq({ after: { lastActiveAt: 9999, id: 'o-0' }, limit: 200 }));
    expect(forged.rows.every((r) => r.workspaceId === HOSTED)).toBe(true);
    await k.destroy();
  });
});
```

Add `'src/host/historyRead.pg.test.ts',` to `vitest.pg.config.ts` `include`, in alphabetical position before `'src/host/hostAutomations.pg.test.ts'`. The `parseSessionsReq` block also runs under the default config.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts`
Expected: FAIL — `Failed to resolve import "./historyRead.js"`.

- [ ] **Step 3: Implement** `src/host/historyRead.ts`:

```ts
// Store-backed reads the desktop federates (remote-workspaces (d)): every
// query is limited to the hosted workspace, whatever the caller sends.
import { sql, type Kysely } from 'kysely';
import { HEADLESS_BROKER_PREFIX, listSessionCostsQuery, summaryForSession, summaryForWorkspace, type WorkspaceSummary } from '../main/db.js';
import { costFor } from '../main/pricing.js';
import { readTransaction } from '../main/store/kysely.js';
import type { StateDb } from '../main/store/stateSchema.js';
import type { SessionCursor } from '../preload/federation.js';

export const SESSIONS_PAGE_MAX = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface RemoteSessionRow {
  id: string;
  workspaceId: string;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  tags: string[];
  headless: boolean;
}

export interface SessionsPageReq { after: SessionCursor | null; limit: number }
export interface SessionsPage { rows: RemoteSessionRow[]; next: SessionCursor | null }

export class HistoryArgError extends Error {}

const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function parseSessionsReq(v: unknown): SessionsPageReq {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HistoryArgError('expected {after, limit}');
  const o = v as { after?: unknown; limit?: unknown };
  const limit = o.limit === undefined ? SESSIONS_PAGE_MAX : o.limit;
  if (!int(limit) || limit < 1 || limit > SESSIONS_PAGE_MAX) throw new HistoryArgError(`limit must be 1-${SESSIONS_PAGE_MAX}`);
  if (o.after === undefined || o.after === null) return { after: null, limit };
  const a = o.after as { lastActiveAt?: unknown; id?: unknown };
  if (!a || typeof a !== 'object' || !int(a.lastActiveAt) || a.lastActiveAt < 0 || typeof a.id !== 'string' || !ID_RE.test(a.id)) {
    throw new HistoryArgError('after must be {lastActiveAt: integer >= 0, id}');
  }
  return { after: { lastActiveAt: a.lastActiveAt, id: a.id }, limit };
}

export function parseSessionId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new HistoryArgError('sessionId must be a session id');
  return v;
}

/** One newest-first keyset page of `workspaceId`'s sessions, ordered as db.ts
 *  listSessions: COALESCE(last_active_at, 0) DESC, id in byte order. */
export async function sessionsPage(k: Kysely<StateDb>, workspaceId: string, req: SessionsPageReq): Promise<SessionsPage> {
  return readTransaction(k, async (trx) => {
    const la = sql<number>`COALESCE(last_active_at, 0)`;
    const after = req.after
      ? sql`AND (${la} < ${req.after.lastActiveAt} OR (${la} = ${req.after.lastActiveAt} AND id COLLATE "C" > ${req.after.id}))`
      : sql``;
    const sess = (await sql<{
      id: string; workspace_id: string; ai_title: string | null; first_user_message: string | null; user_set_name: string | null;
      started_at: number | null; last_active_at: number | null; headless: boolean;
    }>`
      SELECT id, workspace_id, ai_title, first_user_message, user_set_name, started_at, last_active_at,
             EXISTS (SELECT 1 FROM broker_sessions b WHERE b.claude_session_id = sessions.id
                     AND b.broker_session_id LIKE ${`${HEADLESS_BROKER_PREFIX}%`}) AS headless
      FROM sessions WHERE workspace_id = ${workspaceId} ${after}
      ORDER BY ${la} DESC, id COLLATE "C" ASC
      LIMIT ${req.limit + 1}`.execute(trx)).rows;
    const page = sess.slice(0, req.limit);
    const ids = page.map((s) => s.id);
    const agg = new Map<string, { usd: number; eventCount: number }>();
    const tags = new Map<string, string[]>();
    if (ids.length) {
      const costs = await listSessionCostsQuery(trx, workspaceId).where('session_id', 'in', ids)
        .orderBy('session_id').orderBy('model').orderBy('service_tier').execute();
      for (const c of costs) {
        const a = agg.get(c.session_id) ?? { usd: 0, eventCount: 0 };
        a.eventCount += Number(c.event_count);
        a.usd += costFor(c.model, c.service_tier, {
          inputTokens: Number(c.input_tokens), outputTokens: Number(c.output_tokens),
          cacheReadInputTokens: Number(c.cache_read_input_tokens), cacheCreationInputTokens: Number(c.cache_creation_input_tokens),
        });
        agg.set(c.session_id, a);
      }
      const tagRows = (await sql<{ session_id: string; tags: string }>`
        SELECT DISTINCT ON (session_id) session_id, tags FROM session_summaries
        WHERE workspace_id = ${workspaceId} AND session_id IN (${sql.join(ids)}) AND tags IS NOT NULL
        ORDER BY session_id, id DESC`.execute(trx)).rows;
      for (const r of tagRows) {
        try {
          const p: unknown = JSON.parse(r.tags);
          if (Array.isArray(p)) tags.set(r.session_id, p.filter((t): t is string => typeof t === 'string'));
        } catch { /* malformed tags: untagged */ }
      }
    }
    const rows = page.map((s) => ({
      id: s.id, workspaceId: s.workspace_id, aiTitle: s.ai_title, firstUserMessage: s.first_user_message,
      userSetName: s.user_set_name, startedAt: s.started_at === null ? null : Number(s.started_at),
      lastActiveAt: s.last_active_at === null ? null : Number(s.last_active_at),
      eventCount: agg.get(s.id)?.eventCount ?? 0, usd: agg.get(s.id)?.usd ?? 0,
      tags: tags.get(s.id) ?? [], headless: Boolean(s.headless),
    }));
    const last = rows[rows.length - 1];
    return { rows, next: sess.length > req.limit && last ? { lastActiveAt: last.lastActiveAt ?? 0, id: last.id } : null };
  });
}

export interface HistoryReader {
  workspaceId: string;
  sessions(req: SessionsPageReq): Promise<SessionsPage>;
  /** null: the workspace's latest session. A session outside the workspace answers null. */
  summary(sessionId: string | null): Promise<WorkspaceSummary | null>;
}

export function historyReader(k: () => Kysely<StateDb>, workspaceId: string): HistoryReader {
  return {
    workspaceId,
    sessions: (req) => sessionsPage(k(), workspaceId, req),
    async summary(sessionId) {
      if (sessionId === null) return summaryForWorkspace(workspaceId);
      const row = await k().selectFrom('sessions').select('workspace_id').where('id', '=', sessionId).executeTakeFirst();
      return row?.workspace_id === workspaceId ? summaryForSession(sessionId) : null;
    },
  };
}
```

In `src/host/importGraph.test.ts`, add `preload\/federation` to the `/^preload\/(inboxTypes|captureSettings)\.ts$/` alternation, making it `/^preload\/(inboxTypes|captureSettings|federation)\.ts$/`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/historyRead.pg.test.ts src/host/importGraph.test.ts && npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts && npx tsc -p tsconfig.host.json`
Expected: SQLite run: the parse block passes and the PG block is skipped. PG run: 2 passed. Host typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/historyRead.ts src/host/historyRead.pg.test.ts vitest.pg.config.ts src/host/importGraph.test.ts
git -C "$W" commit -m "feat(host): keyset history reads scoped to the hosted workspace (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `history:*` RPC channels on the host

**Files:**
- Create: `src/host/historyRpc.ts`
- Modify: `src/host/rpc.ts`, `src/host/holder.ts`, `src/host/main.ts`
- Test: `src/host/historyRpc.test.ts`, `src/host/rpc.test.ts`

**Interfaces:**
- Consumes: `HistoryReader`, `parseSessionsReq`, `parseSessionId`, `HistoryArgError` (Task 2).
- Produces:
  - `class RpcUnavailableError`; `dispatchRpc` answers it 503.
  - `historyRpcChannels(reader: () => HistoryReader | null): Map<string, RpcChannel>`.
  - `Holder.history: HistoryReader`.

- [ ] **Step 1: Write the failing tests.**

`src/host/historyRpc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { dispatchRpc } from './rpc.js';
import { historyRpcChannels } from './historyRpc.js';
import type { HistoryReader } from './historyRead.js';
import type { Principal } from './attachHub.js';

const caller = { tier: 'read', identity: { provider: 'github', kind: 'user', login: 'amy', id: 1 } } as unknown as Principal;
const reader = (): HistoryReader => ({
  workspaceId: 'W',
  sessions: vi.fn(async (req) => ({ rows: [], next: null, req })) as unknown as HistoryReader['sessions'],
  summary: vi.fn(async () => null),
});

describe('history RPC', () => {
  it('passes a parsed request and the session id through', async () => {
    const r = reader();
    const reg = historyRpcChannels(() => r);
    const res = await dispatchRpc(reg, 'history:sessions', { args: [{ after: { lastActiveAt: 5, id: 'a' }, limit: 10 }] }, caller);
    expect(res.status).toBe(200);
    expect(r.sessions).toHaveBeenCalledWith({ after: { lastActiveAt: 5, id: 'a' }, limit: 10 });
    expect((await dispatchRpc(reg, 'history:summary', { args: [] }, caller)).status).toBe(200);
    expect(r.summary).toHaveBeenCalledWith(null);
  });

  it('400s a bad argument and 503s without a holder', async () => {
    const reg = historyRpcChannels(() => reader());
    expect((await dispatchRpc(reg, 'history:sessions', { args: [{ limit: 0 }] }, caller)).status).toBe(400);
    expect((await dispatchRpc(reg, 'history:summary', { args: ['a b'] }, caller)).status).toBe(400);
    const none = historyRpcChannels(() => null);
    expect(await dispatchRpc(none, 'history:sessions', { args: [{}] }, caller)).toEqual({ status: 503, body: { ok: false, error: 'history unavailable' } });
  });

  it('every channel needs read', () => {
    for (const ch of historyRpcChannels(() => null).values()) expect(ch.tier).toBe('read');
  });
});
```

In `src/host/rpc.test.ts`, add:

```ts
it('maps RpcUnavailableError to 503 with its message', async () => {
  const reg = new Map([['x:y', { tier: 'read' as const, handle: async () => { throw new RpcUnavailableError('history unavailable'); } }]]);
  expect(await dispatchRpc(reg, 'x:y', { args: [] }, readCaller)).toEqual({ status: 503, body: { ok: false, error: 'history unavailable' } });
});
```

Use the `read`-tier principal that file already builds for its other tests as `readCaller`, and import `RpcUnavailableError` from `./rpc.js`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/historyRpc.test.ts src/host/rpc.test.ts`
Expected: FAIL — `historyRpc.js` is missing and `RpcUnavailableError` isn't exported.

- [ ] **Step 3: Implement.**

In `src/host/rpc.ts`, add the class after `RpcForbiddenError`:

```ts
export class RpcUnavailableError extends Error {}
```

In `dispatchRpc`'s `catch`, before the `log?.log('error', …)` line, add:

```ts
    if (err instanceof RpcUnavailableError) return { status: 503, body: { ok: false, error: err.message } };
```

Create `src/host/historyRpc.ts`:

```ts
// history:* RPC (remote-workspaces (d)): the desktop's federated reads.
// The reader is the holder's; it scopes every query to the hosted workspace.
import { HistoryArgError, parseSessionId, parseSessionsReq, type HistoryReader } from './historyRead.js';
import { RpcArgError, RpcUnavailableError, type RpcChannel } from './rpc.js';

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HistoryArgError) throw new RpcArgError(err.message);
    throw err;
  }
}

export function historyRpcChannels(reader: () => HistoryReader | null): Map<string, RpcChannel> {
  const need = (): HistoryReader => {
    const r = reader();
    if (!r) throw new RpcUnavailableError('history unavailable');
    return r;
  };
  return new Map<string, RpcChannel>([
    ['history:sessions', { tier: 'read', handle: ([req]) => guarded(() => need().sessions(parseSessionsReq(req ?? {}))) }],
    ['history:summary', { tier: 'read', handle: ([id]) => guarded(() => need().summary(parseSessionId(id))) }],
  ]);
}
```

In `src/host/holder.ts`:
- Import `historyReader, type HistoryReader` from `./historyRead.js`.
- Add `history: HistoryReader;` to `Holder`.
- In the returned object, add `history: historyReader(stateKysely, o.workspaceId),`.

In `src/host/main.ts`:
- Import `historyRpcChannels` from `./historyRpc.js` and `type Holder` from `./holder.js` (if not already imported).
- Next to `let holderP`, declare `let holderNow: Holder | null = null;`.
- Replace `rpc: brokerRpcChannels(ops, hub.owners, env.port),` with:

```ts
    rpc: new Map([...brokerRpcChannels(ops, hub.owners, env.port), ...historyRpcChannels(() => holderNow?.history ?? null)]),
```

- On the `startHolder({...}).catch(...)` chain, append `.then((h) => (holderNow = h))`, so `holderP` still resolves to `Holder | null`.
- In `shutdown`, set `holderNow = null;` right after `server.halt(1001, 'host shutting down');`.

- [ ] **Step 4: Run the host suites**

Run: `npx vitest run src/host/ && npx tsc -p tsconfig.host.json`
Expected: all pass (the PG-only blocks are skipped); clean typecheck.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/historyRpc.ts src/host/historyRpc.test.ts src/host/rpc.ts src/host/rpc.test.ts src/host/holder.ts src/host/main.ts
git -C "$W" commit -m "feat(host): history:sessions and history:summary RPC at read tier (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Summary hint after ingest

**Files:**
- Modify: `src/host/hostIngest.ts`, `src/host/holder.ts`
- Test: `src/host/hostIngest.test.ts`, `src/host/holderHint.test.ts` (new)

**Interfaces:**
- Produces:
  - `HostIngestOptions.onIngested?: (sessionId: string) => void`, called after a chunk's transaction commits.
  - `trailingHint(fn: () => void, ms: number, schedule?): { bump(): void; stop(): void }`, exported from `holder.ts`.
  - `SUMMARY_HINT_MS = 2_000`.

- [ ] **Step 1: Write the failing tests.**

In `src/host/hostIngest.test.ts`:
- Widen `make`'s option type to `Partial<Pick<HostIngestOptions, 'ingest' | 'maxReadBytes' | 'maxLineBytes' | 'maxChunkBytes' | 'onIngested'>>`.
- Add this case inside the `describe.skipIf(!isPg)('HostIngest', …)` block:

```ts
  it('calls onIngested after a chunk commits, never for a scan with nothing new', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a'));
    const seen: string[] = [];
    const h = make({ onIngested: (id) => seen.push(id) });
    await h.start();
    await h.scan();
    expect(seen).toEqual([S1]);
    expect(await events()).toBe(1);
    await h.scan();
    expect(seen).toEqual([S1]);
  });
```

`src/host/holderHint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { trailingHint } from './holder.js';

describe('trailingHint', () => {
  it('fires once per quiet window and not after stop', () => {
    const timers: Array<() => void> = [];
    let fired = 0;
    const h = trailingHint(() => fired++, 2_000, (fn) => { timers.push(fn); return () => undefined; });
    h.bump(); h.bump(); h.bump();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    expect(fired).toBe(1);
    h.bump();
    h.stop();
    timers.shift()?.();
    expect(fired).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/holderHint.test.ts && npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts`
Expected: FAIL — `trailingHint` isn't exported; `onIngested` is never called.

- [ ] **Step 3: Implement.**

In `src/host/hostIngest.ts`:
- Add to `HostIngestOptions`:

```ts
  /** After a chunk's transaction commits. */
  onIngested?: (sessionId: string) => void;
```

- In `flush`, immediately after the `await this.ingest(…)` call inside `if (lines.length) { … }`, add:

```ts
        this.o.onIngested?.(sessionId);
```

In `src/host/holder.ts`, add:

```ts
export const SUMMARY_HINT_MS = 2_000;

/** Calls `fn` once, `ms` after the first bump of a quiet period. */
export function trailingHint(
  fn: () => void, ms: number,
  schedule: (fn: () => void, ms: number) => () => void = (f, d) => { const t = setTimeout(f, d); t.unref?.(); return () => clearTimeout(t); },
): { bump(): void; stop(): void } {
  let cancel: (() => void) | null = null;
  let stopped = false;
  return {
    bump() {
      if (stopped || cancel) return;
      cancel = schedule(() => { cancel = null; if (!stopped) fn(); }, ms);
    },
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
```

In `startHolder`:
- Before `new HostIngest(…)`, add:

```ts
  const hint = trailingHint(() => o.events.publish('observability:summary', { workspaceId: o.workspaceId }), SUMMARY_HINT_MS);
```

- Pass `onIngested: () => hint.bump()` to `HostIngest`.
- In `stopAll`, call `hint.stop();` right after `await ingest.stop();`.

- [ ] **Step 4: Run the host suites**

Run: `npx vitest run src/host/ && npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts && npx tsc -p tsconfig.host.json`
Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/hostIngest.ts src/host/hostIngest.test.ts src/host/holder.ts src/host/holderHint.test.ts
git -C "$W" commit -m "feat(host): data-free observability:summary hint after ingest (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `query` on the host MCP (role + RLS)

> Superseded by D71 where it conflicts: the CREATEROLE steps below were not built.

**Files:**
- Modify: `src/host/bootstrap.ts`, `src/host/holder.ts`, `src/host/hostMcp.ts`
- Test: `src/host/bootstrap.pg.test.ts`, `src/host/hostMcp.test.ts`, `src/host/hostQuery.pg.test.ts` (new; add it to `vitest.pg.config.ts`)

**Interfaces:**
- Consumes: `openPgMcpReadSource(schema, base, log)` (`src/main/store/pgReadSource.ts`) and `PgStores.poolConfig`.
- Produces:
  - `HOST_MCP_TOOLS` gains `'query'` (14).
  - The bootstrap app role is `CREATEROLE` on PG ≥ 16.

- [ ] **Step 1: Write the failing tests.**

In `src/host/bootstrap.pg.test.ts` (the test PG is 16):
- In the first test's expected `state(n)`, change `rolcreaterole: false` to `rolcreaterole: true`.
- In the drift test, change the expected step text to `` `altered role ${n.app} to LOGIN NOCREATEDB CREATEROLE` ``.
- Add:

```ts
it('removes CREATEDB but keeps CREATEROLE on PG 16', async () => {
  const n = names();
  await bootstrap(target(n), superAdmin(), quiet);
  await su(async (c) => c.query(`ALTER ROLE ${id(n.app)} CREATEDB NOCREATEROLE`), n.db);
  expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([`altered role ${n.app} to LOGIN NOCREATEDB CREATEROLE`]);
  expect((await state(n)).role).toEqual({ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: true });
});
```

In `src/host/hostMcp.test.ts`, add:

```ts
it('serves query and still refuses search_transcripts', () => {
  expect(HOST_MCP_TOOLS.has('query')).toBe(true);
  expect(HOST_MCP_TOOLS.has('search_transcripts')).toBe(false);
  expect(HOST_MCP_TOOLS.size).toBe(14);
});
```

`src/host/hostQuery.pg.test.ts`. It runs `query` through the host MCP on a schema whose store role has `CREATEROLE` (`testPgAppSchema`), with another workspace's rows present:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDbPostgres, closeDb, stateKysely } from '../main/db.js';
import { migratePgStores } from '../main/store/pgStores.js';
import { openPgMcpReadSource } from '../main/store/pgReadSource.js';
import { isPg, testPgAppSchema, type TestPgApp } from '../main/store/testStore.js';
import { startHostMcp, type HostMcp } from './hostMcp.js';
import { createLogger } from './log.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';

async function call(sock: string, line: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    c.on('error', reject);
    c.write(JSON.stringify(line) + '\n');
  });
}

describe.skipIf(!isPg)('host MCP query', () => {
  let t: TestPgApp | null = null;
  let mcp: HostMcp | null = null;
  afterEach(async () => { await mcp?.close(); mcp = null; await closeDb(); await t?.drop(); t = null; });

  it('sees only the hosted workspace, under RLS', async () => {
    t = await testPgAppSchema();
    await migratePgStores(t.appPool, { state: true });
    await openDbPostgres(t.appPool, { migrate: false });
    await stateKysely().insertInto('sessions').values([
      { id: 'h1', workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'mine', user_set_name: null },
      { id: 'o1', workspace_id: OTHER, cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'theirs', user_set_name: null },
    ]).execute();
    const rs = await openPgMcpReadSource(t.schema, t.appConfig, () => undefined);
    expect(rs.queryFlavor).toBe('postgres');
    const socketPath = join(mkdtempSync(join(tmpdir(), 'hq-')), 'mcp', 'mcp.sock');
    mcp = await startHostMcp({ socketPath, socketGroup: null, workspaceId: HOSTED, readSource: rs, log: createLogger(() => undefined) });
    const res = await call(socketPath, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query', arguments: { sql: 'SELECT id FROM sessions ORDER BY id' } } });
    expect(JSON.parse(res.result.content[0].text)).toEqual([{ id: 'h1' }]);
  });
});
```

Add `'src/host/hostQuery.pg.test.ts',` to `vitest.pg.config.ts`. If `openDbPostgres`'s second argument has a different shape in this tree, use the form `openPgStores` passes (`src/main/store/pgStores.ts:57`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/hostMcp.test.ts && npx vitest run -c vitest.pg.config.ts src/host/bootstrap.pg.test.ts src/host/hostQuery.pg.test.ts`
Expected: FAIL. `query` isn't served (`Unknown tool`), the tool count is 13, and bootstrap still sets `NOCREATEROLE`.

- [ ] **Step 3: Implement.**

`src/host/bootstrap.ts`, in `targetSteps`:
- Before `steps`, add:

```ts
  const pg16 = async (): Promise<boolean> => Number((await one<{ v: string }>(c, 'SHOW server_version_num'))?.v ?? 0) >= 160000;
```

- In the login-role step:
  - `what` becomes `` `login role ${t.user}` `` (unchanged).
  - `check()`'s last line becomes `return !!r && r.login && !r.createdb && r.createrole === (await pg16());`.
  - `apply()` uses the attribute:

```ts
      async apply() {
        const cr = (await pg16()) ? 'CREATEROLE' : 'NOCREATEROLE';
        if (await role()) {
          await admin.need(t.user, 'alter it');
          await c.query(`ALTER ROLE ${id(t.user)} LOGIN NOCREATEDB ${cr}`);
          return `altered role ${t.user} to LOGIN NOCREATEDB ${cr}`;
        }
        const pw = t.appPassword ? await t.appPassword() : null;
        if (pw) o.onSecret?.(pw);
        await c.query(`CREATE ROLE ${id(t.user)} LOGIN ${cr}${pw ? ` PASSWORD ${pg.escapeLiteral(scramVerifier(pw))}` : ''}`);
        return `created role ${t.user} (LOGIN, ${pw ? 'password set' : 'no password'})`;
      }
```

`src/host/hostMcp.ts`: add `'query'` to `HOST_MCP_TOOLS` after `'session_summary'`.

`src/host/holder.ts`:
- Import `openPgMcpReadSource` from `../main/store/pgReadSource.js` and `type OwnedReadSource` from `../main/store/readSource.js`. Drop the `pgReadSource` import if nothing else uses it, and delete `NO_QUERY`.
- Change `mcpServer(o)` to `mcpServer(o, readSource: () => Promise<OwnedReadSource>)`. In `tryStart`, replace the inline `startHostMcp({…})` call with:

```ts
    attempt = readSource()
      .then((rs) => startHostMcp({ socketPath: o.mcp.socketPath, socketGroup: o.mcp.socketGroup, workspaceId: o.workspaceId, log: o.log, readSource: rs }))
      .then(
```

  The two existing `.then` handlers (served / retry with backoff) stay as the arguments of that last `.then`.
- In `startHolder`, build it as:

```ts
  const mcp = mcpServer(o, () =>
    openPgMcpReadSource(stores.poolConfig.schema, stores.poolConfig, (message) => o.log.log('warn', 'mcp query isolation', { error: message })));
```

`openPgMcpReadSource` never throws on an isolation failure; it returns a source whose `query` reports why. A rejected promise, such as a pool error, takes the existing retry path.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run src/host/ && npx vitest run -c vitest.pg.config.ts src/host/bootstrap.pg.test.ts src/host/hostQuery.pg.test.ts src/host/main.pg.test.ts src/main/store/pgQueryIsolation.test.ts && npx tsc -p tsconfig.host.json`
Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/bootstrap.ts src/host/bootstrap.pg.test.ts src/host/holder.ts src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/hostQuery.pg.test.ts vitest.pg.config.ts
git -C "$W" commit -m "feat(host): query on the host MCP via role + RLS; bootstrap grants CREATEROLE on PG 16 (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Desktop: RPC timeout, liveness accessors, reply validation

**Files:**
- Modify: `src/main/remoteClient.ts`, `src/main/remote.ts`
- Create: `src/main/federation/remoteRows.ts`
- Test: `src/main/remoteClient.test.ts`, `src/main/remote.test.ts`, `src/main/federation/remoteRows.test.ts`

**Interfaces:**
- Produces:
  - `RemoteClient.rpc<T>(channel, args, opts?: { timeoutMs?: number })`.
  - `RemoteBackend.sources(): RemoteSourceInfo[]` and `RemoteBackend.isRemote(id): boolean`.
  - `RemoteSourceInfo { id; url; name; hue: number | null; tier: 'read' | 'steer' | 'session' | null; state: 'running' | 'unreachable' | null }`, exported from `remote.ts`.
  - `class RemoteShapeError`, `MAX_REMOTE_SESSIONS = 200`.
  - `RemoteSessionItem` (`RemoteSessionRow`'s fields).
  - `parseSessionsPage(v, workspaceId): { rows: RemoteSessionItem[]; next: SessionCursor | null }`.
  - `parseSummary(v): WorkspaceSummary | null`.

- [ ] **Step 1: Write the failing tests.**

`src/main/federation/remoteRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSessionsPage, parseSummary, RemoteShapeError } from './remoteRows';

const W = '01JC0000000000000000000000';
const good = { id: 's1', workspaceId: W, aiTitle: 'T\u202eitle', firstUserMessage: 'x'.repeat(900), userSetName: null, startedAt: 1, lastActiveAt: 2, eventCount: 3, usd: 0.5, tags: ['a', 7], headless: false };

describe('parseSessionsPage', () => {
  it('keeps valid rows, cleans text, drops foreign or malformed rows', () => {
    const p = parseSessionsPage({ rows: [good, { ...good, id: 'bad id' }, { ...good, id: 's2', workspaceId: 'OTHER' }, { ...good, id: 's3', usd: Infinity }], next: { lastActiveAt: 2, id: 's1' } }, W);
    expect(p.rows.map((r) => r.id)).toEqual(['s1']);
    expect(p.rows[0].aiTitle).toBe('T itle');
    expect(p.rows[0].firstUserMessage).toHaveLength(500);
    expect(p.rows[0].tags).toEqual(['a']);
    expect(p.next).toEqual({ lastActiveAt: 2, id: 's1' });
  });

  it('throws on a bad envelope or cursor', () => {
    expect(() => parseSessionsPage(null, W)).toThrow(RemoteShapeError);
    expect(() => parseSessionsPage({ rows: Array(201).fill(good), next: null }, W)).toThrow(RemoteShapeError);
    expect(() => parseSessionsPage({ rows: [], next: { lastActiveAt: -1, id: 's' } }, W)).toThrow(RemoteShapeError);
  });
});

describe('parseSummary', () => {
  const s = {
    sessionId: 's1', title: 't', model: 'm', startedAt: 1, lastActiveAt: 2, eventCount: 3, inputTokens: 1, outputTokens: 1,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usd: 0.1, lastTurnContextTokens: null, contextWindowTokens: 200000,
    topTools: [{ name: 'Bash', count: 2 }], recentToolCalls: [{ name: 'Bash', input: 'ls\n-la', durationMs: 3, status: 'ok', ts: 1 }],
    costSeries: [0.1], tokenSeries: [10],
  };
  it('accepts a summary and caps arrays', () => {
    const out = parseSummary({ ...s, costSeries: Array(500).fill(1) })!;
    expect(out.costSeries).toHaveLength(200);
    expect(out.recentToolCalls[0].input).toBe('ls -la');
  });
  it('null stays null; malformed throws', () => {
    expect(parseSummary(null)).toBeNull();
    expect(() => parseSummary({ ...s, contextWindowTokens: 'x' })).toThrow(RemoteShapeError);
    expect(() => parseSummary({ ...s, recentToolCalls: [{ ...s.recentToolCalls[0], status: 'boom' }] })).toThrow(RemoteShapeError);
  });
});
```

In `src/main/remoteClient.test.ts`, add a case using the file's existing fake `fetch` server helper. It answers `/rpc/x` after 200 ms; `rpc('x', [], { timeoutMs: 50 })` rejects with `RemoteError` kind `unreachable` and a message containing `timed out`.

In `src/main/remote.test.ts`, add a case using the file's existing deps fake:
- After `listLiveWorkspaces()` with one remote manifest and a healthy probe, `backend.isRemote(id)` is true and `backend.sources()` equals `[{ id, url, name, hue, tier, state: 'running' }]`.
- `backend.isRemote('nope')` is false.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/federation/remoteRows.test.ts src/main/remoteClient.test.ts src/main/remote.test.ts`
Expected: FAIL — the module is missing, `rpc` ignores the timeout, and `sources`/`isRemote` don't exist.

- [ ] **Step 3: Implement.**

`src/main/remoteClient.ts`, change `rpc`:

```ts
  async rpc<T>(channel: string, args: unknown[], opts: { timeoutMs?: number } = {}): Promise<T> {
    const body = (await this.request(`/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      auth: true,
      body: JSON.stringify({ args }),
      maxBody: MAX_RPC_BODY,
      timeoutMs: opts.timeoutMs
    })) as { ok?: unknown; result?: T } | null;
```

The rest is unchanged.

`src/main/remote.ts`:
- Export the interface:

```ts
export interface RemoteSourceInfo {
  id: string;
  url: string;
  name: string;
  hue: number | null;
  tier: 'read' | 'steer' | 'session' | null;
  state: 'running' | 'unreachable' | null;
}
```

- Add to `RemoteBackend`:

```ts
  /** Bookmarks the probe loop knows, with cached liveness; no I/O. */
  sources(): RemoteSourceInfo[];
  isRemote(id: string): boolean;
```

- In the returned object, add:

```ts
    sources: () =>
      [...watches.values()].map((w) => ({
        id: w.spec.id, url: w.spec.remote.url, name: w.spec.name, hue: w.spec.color?.hue ?? null, tier: w.spec.remote.tier, state: w.state
      })),
    isRemote: (id) => watches.has(id),
```

`src/main/federation/remoteRows.ts`:

```ts
// Host replies are untrusted (remote-workspaces §9): every field checked,
// strings one-lined and capped, arrays capped. A bad row is dropped; a bad
// envelope throws, which marks the source unavailable.
import { oneLine } from '../remoteUrl.js';
import type { WorkspaceSummary } from '../db.js';
import type { SessionCursor } from '../../preload/federation.js';

export class RemoteShapeError extends Error {}

export const MAX_REMOTE_SESSIONS = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TITLE = 500;

export interface RemoteSessionItem {
  id: string;
  workspaceId: string;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  tags: string[];
  headless: boolean;
}

const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const natOrNull = (v: unknown): number | null | undefined => (v === null ? null : nat(v) ? v : undefined);
const text = (v: unknown, max: number): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? oneLine(v, max) || null : undefined;
const fail = (what: string): never => { throw new RemoteShapeError(`malformed ${what}`); };

function parseCursor(v: unknown): SessionCursor | null {
  if (v === null || v === undefined) return null;
  const c = v as { lastActiveAt?: unknown; id?: unknown };
  if (!c || typeof c !== 'object' || !nat(c.lastActiveAt) || typeof c.id !== 'string' || !ID_RE.test(c.id)) return fail('cursor');
  return { lastActiveAt: c.lastActiveAt, id: c.id };
}

function parseSessionRow(v: unknown, workspaceId: string): RemoteSessionItem | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id) || r.workspaceId !== workspaceId) return null;
  const aiTitle = text(r.aiTitle, MAX_TITLE), firstUserMessage = text(r.firstUserMessage, MAX_TITLE), userSetName = text(r.userSetName, MAX_TITLE);
  const startedAt = natOrNull(r.startedAt), lastActiveAt = natOrNull(r.lastActiveAt);
  if (aiTitle === undefined || firstUserMessage === undefined || userSetName === undefined || startedAt === undefined || lastActiveAt === undefined) return null;
  if (!nat(r.eventCount) || typeof r.usd !== 'number' || !Number.isFinite(r.usd) || r.usd < 0 || typeof r.headless !== 'boolean' || !Array.isArray(r.tags)) return null;
  const tags = r.tags.filter((t): t is string => typeof t === 'string').slice(0, 20).map((t) => oneLine(t, 64)).filter(Boolean);
  return { id: r.id, workspaceId, aiTitle, firstUserMessage, userSetName, startedAt, lastActiveAt, eventCount: r.eventCount, usd: r.usd, tags, headless: r.headless };
}

export function parseSessionsPage(v: unknown, workspaceId: string): { rows: RemoteSessionItem[]; next: SessionCursor | null } {
  const o = v as { rows?: unknown; next?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows) || o.rows.length > MAX_REMOTE_SESSIONS) return fail('sessions page');
  const rows: RemoteSessionItem[] = [];
  for (const r of o.rows) {
    const row = parseSessionRow(r, workspaceId);
    if (row) rows.push(row);
  }
  return { rows, next: parseCursor(o.next) };
}

const STATUSES = new Set(['ok', 'error', 'pending']);
const finiteList = (v: unknown, max: number): number[] => {
  if (!Array.isArray(v)) return fail('summary series');
  return v.slice(-max).map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : fail('summary series')));
};

export function parseSummary(v: unknown): WorkspaceSummary | null {
  if (v === null) return null;
  const s = v as Record<string, unknown>;
  if (!s || typeof s !== 'object') return fail('summary');
  const sessionId = s.sessionId === null ? null : typeof s.sessionId === 'string' && ID_RE.test(s.sessionId) ? s.sessionId : fail('summary');
  const title = text(s.title, MAX_TITLE), model = text(s.model, 128);
  const startedAt = natOrNull(s.startedAt), lastActiveAt = natOrNull(s.lastActiveAt), lastTurn = natOrNull(s.lastTurnContextTokens);
  if (title === undefined || model === undefined || startedAt === undefined || lastActiveAt === undefined || lastTurn === undefined) return fail('summary');
  for (const k of ['eventCount', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'contextWindowTokens']) {
    if (!nat(s[k])) return fail('summary');
  }
  if (typeof s.usd !== 'number' || !Number.isFinite(s.usd) || !Array.isArray(s.topTools) || !Array.isArray(s.recentToolCalls)) return fail('summary');
  const topTools = s.topTools.slice(0, 20).map((t) => {
    const x = t as { name?: unknown; count?: unknown };
    if (typeof x?.name !== 'string' || !nat(x.count)) return fail('summary tool');
    return { name: oneLine(x.name, 64), count: x.count };
  });
  const recentToolCalls = s.recentToolCalls.slice(0, 50).map((t) => {
    const x = t as Record<string, unknown>;
    const input = text(x?.input, 2000), durationMs = natOrNull(x?.durationMs), ts = natOrNull(x?.ts);
    if (typeof x?.name !== 'string' || input === undefined || durationMs === undefined || ts === undefined || !STATUSES.has(x.status as string)) return fail('summary call');
    return { name: oneLine(x.name, 64), input, durationMs, status: x.status as 'ok' | 'error' | 'pending', ts };
  });
  return {
    sessionId, title, model, startedAt, lastActiveAt,
    eventCount: s.eventCount as number, inputTokens: s.inputTokens as number, outputTokens: s.outputTokens as number,
    cacheReadInputTokens: s.cacheReadInputTokens as number, cacheCreationInputTokens: s.cacheCreationInputTokens as number,
    usd: s.usd, lastTurnContextTokens: lastTurn, contextWindowTokens: s.contextWindowTokens as number,
    topTools, recentToolCalls, costSeries: finiteList(s.costSeries, 200), tokenSeries: finiteList(s.tokenSeries, 200),
  };
}
```

If `WorkspaceSummary` has fields this tree adds after `tokenSeries`, the typecheck will name them. Validate each the same way: numbers with `nat`/finite, strings with `text`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/federation/remoteRows.test.ts src/main/remoteClient.test.ts src/main/remote.test.ts src/main/remoteIpc.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/remoteClient.ts src/main/remoteClient.test.ts src/main/remote.ts src/main/remote.test.ts src/main/federation/remoteRows.ts src/main/federation/remoteRows.test.ts
git -C "$W" commit -m "feat(remote): rpc timeout, cached-liveness accessors, host reply validation (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `FederatedReader`

**Files:**
- Create: `src/main/federation/federatedReader.ts`
- Test: `src/main/federation/federatedReader.test.ts`

**Interfaces:**
- Consumes:
  - `RemoteSourceInfo` (Task 6), `parseSessionsPage`, `parseSummary`, `RemoteShapeError`, `MAX_REMOTE_SESSIONS` (Task 6).
  - `RemoteError` (`remoteClient.ts`).
  - `SourcePage`, `SessionCursor`, `UnavailableSource`, `UnavailableReason`, `RemoteSessionsResult` (Task 1).
- Produces:
  - `SOURCE_TIMEOUT_MS = 3_000`.
  - `RemoteListItem` = `RemoteSessionItem & { workspaceName; workspaceColorHue; workspaceState; capture: false; origin }`.
  - `FederatedReaderDeps { sources(): RemoteSourceInfo[]; rpc(url, channel, args, timeoutMs): Promise<unknown>; timeoutMs?: number }`.
  - `FederatedReader { listSessions(req: { origin?: string; after?: SessionCursor }): Promise<RemoteSessionsResult<RemoteListItem>>; summary(remoteId: string, sessionId: string | null): Promise<WorkspaceSummary | null | undefined>; call<T>(src, channel, args, parse): Promise<Outcome<T>> }`. `undefined` means unavailable.
  - `createFederatedReader(d): FederatedReader`.
  - `Outcome<T> = { ok: true; value: T } | { ok: false; reason: UnavailableReason }`.

- [ ] **Step 1: Write the failing test** — `src/main/federation/federatedReader.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFederatedReader } from './federatedReader';
import { RemoteError } from '../remoteClient';
import type { RemoteSourceInfo } from '../remote';

const A = '01JC0000000000000000000000';
const B = '01JC0000000000000000000001';
const C = '01JC0000000000000000000002';
const src = (id: string, state: RemoteSourceInfo['state']): RemoteSourceInfo => ({ id, url: `http://${id}`, name: `n${id.slice(-1)}`, hue: 10, tier: 'read', state });
const row = (id: string, ws: string) => ({ id, workspaceId: ws, aiTitle: null, firstUserMessage: 'hi', userSetName: null, startedAt: 1, lastActiveAt: 5, eventCount: 1, usd: 0, tags: [], headless: false });

afterEach(() => vi.useRealTimers());

describe('FederatedReader', () => {
  it('fans out, overlays bookmark fields, and lists failures without waiting on down hosts', async () => {
    const rpc = vi.fn(async (url: string) => {
      if (url === `http://${A}`) return { rows: [row('s1', A)], next: null };
      throw new RemoteError('forbidden', 'no grant', 403);
    });
    const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running'), src(C, 'unreachable')], rpc });
    const out = await r.listSessions({});
    expect(out.pages).toEqual([{ origin: A, next: null, rows: [{ ...row('s1', A), workspaceName: 'n0', workspaceColorHue: 10, workspaceState: 'running', capture: false, origin: A }] }]);
    expect(out.unavailable).toEqual([{ origin: B, name: 'n1', reason: 'forbidden' }, { origin: C, name: 'n2', reason: 'unreachable' }]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('bounds a hanging host at the timeout', async () => {
    vi.useFakeTimers();
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: () => new Promise(() => undefined), timeoutMs: 3000 });
    const p = r.listSessions({});
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).unavailable).toEqual([{ origin: A, name: 'n0', reason: 'timeout' }]);
  });

  it('pages one origin with its cursor and shares identical in-flight calls', async () => {
    let resolve!: (v: unknown) => void;
    const rpc = vi.fn(() => new Promise((res) => (resolve = res)));
    const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running')], rpc });
    const p1 = r.listSessions({ origin: A, after: { lastActiveAt: 5, id: 's1' } });
    const p2 = r.listSessions({ origin: A, after: { lastActiveAt: 5, id: 's1' } });
    resolve({ rows: [], next: null });
    await Promise.all([p1, p2]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(`http://${A}`, 'history:sessions', [{ after: { lastActiveAt: 5, id: 's1' }, limit: 200 }], 3000);
  });

  it('a malformed reply is a protocol failure; summary failure is undefined', async () => {
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: async () => ({ nope: 1 }) });
    expect((await r.listSessions({})).unavailable[0].reason).toBe('protocol');
    expect(await r.summary(A, null)).toBeUndefined();
    expect(await r.summary('unknown', null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/federation/federatedReader.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `src/main/federation/federatedReader.ts`:

```ts
// Federated reads (remote-workspaces §7): fan out to every bookmarked host,
// gated by the probe loop's cached liveness, bounded per source, validated.
// Nothing is kept after a call settles: remote data is live-only.
import { RemoteError } from '../remoteClient.js';
import type { RemoteSourceInfo } from '../remote.js';
import type { WorkspaceSummary } from '../db.js';
import type { RemoteSessionsResult, SessionCursor, SourcePage, UnavailableReason, UnavailableSource } from '../../preload/federation.js';
import { MAX_REMOTE_SESSIONS, parseSessionsPage, parseSummary, type RemoteSessionItem } from './remoteRows.js';

export const SOURCE_TIMEOUT_MS = 3_000;

export type RemoteListItem = RemoteSessionItem & {
  workspaceName: string;
  workspaceColorHue: number | null;
  workspaceState: 'running' | 'unreachable';
  capture: false;
  origin: string;
};

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: UnavailableReason };

export interface FederatedReaderDeps {
  sources(): RemoteSourceInfo[];
  rpc(url: string, channel: string, args: unknown[], timeoutMs: number): Promise<unknown>;
  timeoutMs?: number;
}

export interface FederatedReader {
  listSessions(req: { origin?: string; after?: SessionCursor }): Promise<RemoteSessionsResult<RemoteListItem>>;
  /** undefined: the host is unknown or unavailable. */
  summary(remoteId: string, sessionId: string | null): Promise<WorkspaceSummary | null | undefined>;
  call<T>(src: RemoteSourceInfo, channel: string, args: unknown[], parse: (v: unknown) => T): Promise<Outcome<T>>;
}

class SourceTimeout extends Error {}

function reasonOf(err: unknown): UnavailableReason {
  if (err instanceof SourceTimeout) return 'timeout';
  if (err instanceof RemoteError) return err.kind;
  return 'protocol';
}

const byOrigin = <T extends { origin: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));

export function createFederatedReader(d: FederatedReaderDeps): FederatedReader {
  const timeoutMs = d.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const inflight = new Map<string, Promise<unknown>>();

  function bounded(src: RemoteSourceInfo, channel: string, args: unknown[]): Promise<unknown> {
    const key = `${src.url}\u0000${channel}\u0000${JSON.stringify(args)}`;
    let p = inflight.get(key);
    if (!p) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SourceTimeout()), timeoutMs);
        timer.unref?.();
      });
      p = Promise.race([d.rpc(src.url, channel, args, timeoutMs), timeout]).finally(() => {
        clearTimeout(timer);
        inflight.delete(key);
      });
      inflight.set(key, p);
    }
    return p;
  }

  async function call<T>(src: RemoteSourceInfo, channel: string, args: unknown[], parse: (v: unknown) => T): Promise<Outcome<T>> {
    if (src.state !== 'running') return { ok: false, reason: src.state === null ? 'checking' : 'unreachable' };
    try {
      return { ok: true, value: parse(await bounded(src, channel, args)) };
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  }

  return {
    call,
    async listSessions(req) {
      const all = d.sources();
      const targets = req.origin ? all.filter((s) => s.id === req.origin) : all;
      const pages: SourcePage<RemoteListItem>[] = [];
      const unavailable: UnavailableSource[] = [];
      await Promise.all(
        targets.map(async (s) => {
          const after = req.origin ? (req.after ?? null) : null;
          const r = await call(s, 'history:sessions', [{ after, limit: MAX_REMOTE_SESSIONS }], (v) => parseSessionsPage(v, s.id));
          if (!r.ok) {
            unavailable.push({ origin: s.id, name: s.name, reason: r.reason });
            return;
          }
          pages.push({
            origin: s.id,
            next: r.value.next,
            rows: r.value.rows.map((row) => ({
              ...row, workspaceName: s.name, workspaceColorHue: s.hue, workspaceState: 'running' as const, capture: false as const, origin: s.id
            }))
          });
        })
      );
      return { pages: byOrigin(pages), unavailable: byOrigin(unavailable) };
    },
    async summary(remoteId, sessionId) {
      const s = d.sources().find((x) => x.id === remoteId);
      if (!s) return undefined;
      const r = await call(s, 'history:summary', [sessionId], parseSummary);
      return r.ok ? r.value : undefined;
    }
  };
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run src/main/federation/federatedReader.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: 4 passed; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/federation/federatedReader.ts src/main/federation/federatedReader.test.ts
git -C "$W" commit -m "feat(federation): FederatedReader with liveness gate, 3 s bound, unavailable sources (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Desktop wiring: `sessions:listRemote`, observability routing, summary relay, remote resume

**Files:**
- Create: `src/main/federation/federationIpc.ts`, `src/main/federation/summaryRelay.ts`
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`
- Test: `src/main/federation/federationIpc.test.ts`, `src/main/federation/summaryRelay.test.ts`

**Interfaces:**
- Consumes: `FederatedReader` (Task 7), `RemoteBackend.sources/isRemote` (Task 6), `RemoteClient.subscribe`, `broadcastObservabilitySummary`.
- Produces:
  - IPC `sessions:listRemote(req?: { origin: string; after: SessionCursor })` → `RemoteSessionsResult<SessionListItem>`.
  - `registerFederationIpc(ipc, reader)`.
  - `createSummaryRelay(deps): { sync(): void; stop(): void }`, `RELAY_DEBOUNCE_MS = 2_000`.
  - Preload: `window.api.sessions.listRemote(req?)`; `SessionListItem.origin?: string`.

- [ ] **Step 1: Write the failing tests.**

`src/main/federation/federationIpc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { registerFederationIpc } from './federationIpc';

const A = '01JC0000000000000000000000';
function rig() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const reader = { listSessions: vi.fn(async () => ({ pages: [], unavailable: [] })), summary: vi.fn(), call: vi.fn() };
  registerFederationIpc({ handle: (c: string, f: never) => handlers.set(c, f) } as never, reader as never);
  return { h: handlers.get('sessions:listRemote')!, reader };
}

describe('sessions:listRemote', () => {
  it('first pages with no argument; one origin with a cursor', async () => {
    const { h, reader } = rig();
    await h({});
    expect(reader.listSessions).toHaveBeenLastCalledWith({});
    await h({}, { origin: A, after: { lastActiveAt: 3, id: 's' } });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A, after: { lastActiveAt: 3, id: 's' } });
  });
  it('refuses a malformed request', async () => {
    const { h } = rig();
    await expect(h({}, { origin: 'x', after: { lastActiveAt: 3, id: 's' } })).rejects.toThrow();
    await expect(h({}, { origin: A, after: { lastActiveAt: -1, id: 's' } })).rejects.toThrow();
  });
});
```

`src/main/federation/summaryRelay.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSummaryRelay } from './summaryRelay';

const A = '01JC0000000000000000000000';
describe('SummaryRelay', () => {
  it('subscribes per bookmark, debounces hints, and pushes fetched summaries', async () => {
    const handlers = new Map<string, (e: { channel: string; payload: unknown }) => void>();
    const stops = new Map<string, ReturnType<typeof vi.fn>>();
    const timers: Array<() => void> = [];
    const broadcast = vi.fn();
    let sources = [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read' as const, state: 'running' as const }];
    const relay = createSummaryRelay({
      sources: () => sources,
      subscribe: (url, on) => { handlers.set(url, on); const s = vi.fn(); stops.set(url, s); return s; },
      fetchSummary: async () => ({ sessionId: 's' }) as never,
      broadcast,
      schedule: (fn) => { timers.push(fn); return () => undefined; },
    });
    relay.sync();
    const on = handlers.get('http://a')!;
    on({ channel: 'observability:summary', payload: { workspaceId: A } });
    on({ channel: 'observability:summary', payload: { workspaceId: A } });
    on({ channel: 'observability:summary', payload: { workspaceId: 'other' } });
    expect(timers).toHaveLength(1);
    await timers.shift()!();
    expect(broadcast).toHaveBeenCalledWith(A, { sessionId: 's' });
    sources = [];
    relay.sync();
    expect(stops.get('http://a')).toHaveBeenCalled();
  });

  it('a failed fetch pushes nothing', async () => {
    const timers: Array<() => void> = [];
    const broadcast = vi.fn();
    let on!: (e: { channel: string; payload: unknown }) => void;
    const relay = createSummaryRelay({
      sources: () => [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read', state: 'running' }],
      subscribe: (_u, f) => { on = f; return () => undefined; },
      fetchSummary: async () => undefined,
      broadcast,
      schedule: (fn) => { timers.push(fn); return () => undefined; },
    });
    relay.sync();
    on({ channel: 'observability:summary', payload: { workspaceId: A } });
    await timers.shift()!();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/federation/federationIpc.test.ts src/main/federation/summaryRelay.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement.**

`src/main/federation/federationIpc.ts`:

```ts
// sessions:listRemote: the remote half of the Sessions list (remote-workspaces
// (d)). The local half stays sessions:list; the renderer merges the two.
import type { IpcMain } from 'electron';
import type { SessionCursor } from '../../preload/federation.js';
import type { FederatedReader } from './federatedReader.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** workspaces.ts REMOTE_ID_RE, kept local so this module stays Electron-free. */
const REMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function parseReq(v: unknown): { origin?: string; after?: SessionCursor } {
  if (v === undefined || v === null) return {};
  const o = v as { origin?: unknown; after?: { lastActiveAt?: unknown; id?: unknown } };
  if (typeof o.origin !== 'string' || !REMOTE_ID_RE.test(o.origin)) throw new Error('origin must be a remote workspace id');
  const a = o.after;
  if (!a || typeof a.lastActiveAt !== 'number' || !Number.isSafeInteger(a.lastActiveAt) || a.lastActiveAt < 0 || typeof a.id !== 'string' || !ID_RE.test(a.id)) {
    throw new Error('after must be a session cursor');
  }
  return { origin: o.origin, after: { lastActiveAt: a.lastActiveAt, id: a.id } };
}

export function registerFederationIpc(ipc: Pick<IpcMain, 'handle'>, reader: FederatedReader): void {
  ipc.handle('sessions:listRemote', (_e, req: unknown) => reader.listSessions(parseReq(req)));
}
```

`src/main/federation/summaryRelay.ts`:

```ts
// Host `observability:summary` hints → one RPC read → the renderer's existing
// push. The hint carries no data, so every read stays tier-checked.
import type { RemoteEvent } from '../remoteClient.js';
import type { RemoteSourceInfo } from '../remote.js';
import type { WorkspaceSummary } from '../db.js';

export const RELAY_DEBOUNCE_MS = 2_000;

export interface SummaryRelayDeps {
  sources(): RemoteSourceInfo[];
  subscribe(url: string, onEvent: (e: RemoteEvent) => void): () => void;
  /** undefined: unavailable; nothing is pushed. */
  fetchSummary(remoteId: string): Promise<WorkspaceSummary | null | undefined>;
  broadcast(workspaceId: string, summary: WorkspaceSummary | null): void;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export function createSummaryRelay(d: SummaryRelayDeps): { sync(): void; stop(): void } {
  const schedule = d.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const subs = new Map<string, { url: string; stop: () => void; cancel: (() => void) | null }>();
  const drop = (id: string): void => {
    const s = subs.get(id);
    s?.stop();
    s?.cancel?.();
    subs.delete(id);
  };
  const hint = (id: string): void => {
    const s = subs.get(id);
    if (!s || s.cancel) return;
    s.cancel = schedule(async () => {
      s.cancel = null;
      const summary = await d.fetchSummary(id).catch(() => undefined);
      if (summary !== undefined && subs.get(id) === s) d.broadcast(id, summary);
    }, RELAY_DEBOUNCE_MS);
  };
  return {
    sync() {
      const want = new Map(d.sources().map((s) => [s.id, s]));
      for (const [id, s] of subs) if (want.get(id)?.url !== s.url) drop(id);
      for (const [id, src] of want) {
        if (subs.has(id)) continue;
        const entry = { url: src.url, stop: () => undefined, cancel: null as (() => void) | null };
        subs.set(id, entry);
        entry.stop = d.subscribe(src.url, (e) => {
          if (e.channel === 'observability:summary' && (e.payload as { workspaceId?: unknown } | null)?.workspaceId === id) hint(id);
        });
      }
    },
    stop() {
      for (const id of [...subs.keys()]) drop(id);
    }
  };
}
```

`src/main/ipc.ts`:
- Imports:

```ts
import { createFederatedReader } from './federation/federatedReader.js';
import { createSummaryRelay } from './federation/summaryRelay.js';
import { registerFederationIpc } from './federation/federationIpc.js';
```

- After `const remoteBackend = createRemoteBackend({…});`, add:

```ts
const federated = createFederatedReader({
  sources: () => (MOCK_MODE ? [] : remoteBackend.sources()),
  rpc: (url, channel, args, timeoutMs) => remoteBackend.clientFor(url).rpc(channel, args, { timeoutMs })
});
const summaryRelay = createSummaryRelay({
  sources: () => (MOCK_MODE ? [] : remoteBackend.sources()),
  subscribe: (url, on) => remoteBackend.clientFor(url).subscribe(on),
  fetchSummary: (id) => federated.summary(id, null),
  broadcast: (workspaceId, summary) => broadcastObservabilitySummary({ workspaceId, summary }, BrowserWindow.getAllWindows())
});
let relayTimer: NodeJS.Timeout | null = null;
```

- In `stopRemoteBackend()`, add `summaryRelay.stop(); if (relayTimer) clearInterval(relayTimer);` before `remoteBackend.stop();`.
- In `registerIpc`, right after `registerRemoteIpc(ipcMain, {…});`, add:

```ts
  registerFederationIpc(ipcMain, federated);
  relayTimer = setInterval(() => summaryRelay.sync(), 15_000);
  relayTimer.unref?.();
```

- Replace the `observability:summaryForWorkspace` handler with:

```ts
  ipcMain.handle('observability:summaryForWorkspace', async (_e, workspaceId: string) =>
    remoteBackend.isRemote(workspaceId) ? ((await federated.summary(workspaceId, null)) ?? null) : summaryForWorkspace(workspaceId)
  );
```

- At the top of the `observability:summaryForBrokerSession` handler body, add:

```ts
      if (remoteBackend.isRemote(workspaceId)) return (await federated.summary(workspaceId, null)) ?? null;
```

- In the `sessions:resume` handler, before `startWorkspace`, add:

```ts
      if (remoteBackend.isRemote(workspaceId)) return { containerId: workspaceId };
```

`src/preload/index.ts`:
- Add `origin?: string;` to `SessionListItem`, with the comment `/** Absent or 'local' for this desktop's rows; a remote workspace id otherwise. */`.
- Import `type { RemoteSessionsResult, SessionCursor } from './federation'`.
- In `sessions`, add:

```ts
    /** Remote pages for the Sessions list (remote-workspaces (d)); local rows stay in `list`. */
    listRemote: (req?: { origin: string; after: SessionCursor }): Promise<RemoteSessionsResult<SessionListItem>> =>
      ipcRenderer.invoke('sessions:listRemote', req),
```

- [ ] **Step 4: Run the suites and typechecks**

Run: `npx vitest run src/main/federation/ src/main/remoteIpc.test.ts src/main/perfIpc.test.ts && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all pass; both clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/federation/federationIpc.ts src/main/federation/federationIpc.test.ts src/main/federation/summaryRelay.ts src/main/federation/summaryRelay.test.ts src/main/ipc.ts src/preload/index.ts
git -C "$W" commit -m "feat(remote): sessions:listRemote, routed remote summaries with hint relay, remote resume (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Renderer: merged Sessions list with origin badges, unavailable note, load more

**Files:**
- Create: `src/renderer/src/components/CloudGlyph.tsx`
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx` (import the glyph), `src/renderer/src/sessionsView.ts`, `src/renderer/src/components/SessionsPane.tsx`, the Sessions pane stylesheet (the file holding `.session-row-meta`)
- Test: `src/renderer/src/sessionsView.test.ts`

**Interfaces:**
- Consumes: `mergeSessionPages`, `pagesOf`, `appendSessionPage`, `replaceSessionPage`, `LOCAL_ORIGIN`, `MergedSessions`, `UnavailableSource` (Task 1); `window.api.sessions.listRemote` (Task 8).
- Produces:
  - `withRemote(local: SessionListItem[], remote: MergedSessions<SessionListItem> | null): SessionListItem[]`.
  - `isRemoteRow(s): boolean`.
  - `unavailableText(u: UnavailableSource[]): string | null`.

- [ ] **Step 1: Write the failing test.** Add to `src/renderer/src/sessionsView.test.ts`:

```ts
import { mergeSessionPages } from '../../preload/federation';
import { isRemoteRow, unavailableText, withRemote } from './sessionsView';

describe('withRemote', () => {
  const item = (id: string, la: number, ws: string, origin?: string) =>
    ({ id, workspaceId: ws, lastActiveAt: la, origin } as unknown as SessionListItem);
  it('returns the local array untouched with no remote rows', () => {
    const local = [item('a', 2, 'L')];
    expect(withRemote(local, null)).toBe(local);
    expect(withRemote(local, { rows: [], more: [] })).toBe(local);
  });
  it('interleaves by recency and tags local rows', () => {
    const remote = mergeSessionPages([{ origin: 'R', rows: [item('r', 3, 'R')], next: null }]);
    const out = withRemote([item('a', 4, 'L'), item('b', 2, 'L')], remote);
    expect(out.map((s) => `${s.origin}:${s.id}`)).toEqual(['local:a', 'R:r', 'local:b']);
    expect(out.map(isRemoteRow)).toEqual([false, true, false]);
  });
  it('names unavailable sources', () => {
    expect(unavailableText([])).toBeNull();
    expect(unavailableText([{ origin: 'R', name: 'review-bot', reason: 'unreachable' }])).toBe('1 source unavailable: review-bot');
    expect(unavailableText([{ origin: 'R', name: 'a', reason: 'timeout' }, { origin: 'S', name: 'b', reason: 'forbidden' }])).toBe('2 sources unavailable: a, b');
  });
});
```

Use the file's existing `SessionListItem` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: FAIL — `withRemote` is not exported.

- [ ] **Step 3: Implement.**

`src/renderer/src/sessionsView.ts`, append:

```ts
import { LOCAL_ORIGIN, mergeSessionPages, pagesOf, type MergedSessions, type UnavailableSource } from '../../preload/federation';

export function withRemote(local: SessionListItem[], remote: MergedSessions<SessionListItem> | null): SessionListItem[] {
  if (!remote || remote.rows.length === 0) return local;
  return mergeSessionPages([{ origin: LOCAL_ORIGIN, rows: local, next: null }, ...pagesOf(remote)]).rows;
}

export const isRemoteRow = (s: SessionListItem): boolean => s.origin !== undefined && s.origin !== LOCAL_ORIGIN;

export function unavailableText(u: UnavailableSource[]): string | null {
  if (u.length === 0) return null;
  return `${u.length} source${u.length === 1 ? '' : 's'} unavailable: ${u.map((x) => x.name).join(', ')}`;
}
```

Move the `import` to the top of the file with the other imports.

`src/renderer/src/components/CloudGlyph.tsx`: move `CloudGlyph` out of `WorkspaceTabStrip.tsx` unchanged, as `export function CloudGlyph({ title }: { title: string }): JSX.Element`. Then `import { CloudGlyph } from './CloudGlyph';` in `WorkspaceTabStrip.tsx`.

`src/renderer/src/components/SessionsPane.tsx`:
- Imports: add `useMemo`; add `appendSessionPage, mergeSessionPages, replaceSessionPage, type MergedSessions, type UnavailableSource` from `'../../../preload/federation'`; add `withRemote, isRemoteRow, unavailableText` to the `sessionsView` import; add `import { CloudGlyph } from './CloudGlyph';`.
- Replace `const [items, setItems] = useState<SessionListItem[]>([]);` with:

```tsx
  const [localItems, setLocalItems] = useState<SessionListItem[]>([]);
  const [remote, setRemote] = useState<MergedSessions<SessionListItem> | null>(null);
  const [unavailable, setUnavailable] = useState<UnavailableSource[]>([]);
  const items = useMemo(() => withRemote(localItems, remote), [localItems, remote]);
```

- In `load`, `setItems(rows)` becomes `setLocalItems(rows)`, and `setItems([])` becomes `setLocalItems([])`.
- After `load`, add:

```tsx
  const remoteOrigins = useRef(new Set<string>());
  const loadRemote = useCallback(async () => {
    try {
      const r = await window.api.sessions.listRemote();
      remoteOrigins.current = new Set([...r.pages.map((p) => p.origin), ...r.unavailable.map((u) => u.origin)]);
      setRemote(r.pages.length ? mergeSessionPages(r.pages) : null);
      setUnavailable(r.unavailable);
    } catch {
      setRemote(null);
      setUnavailable([]);
    }
  }, []);
  const refreshOrigin = useCallback(async (origin: string) => {
    const r = await window.api.sessions.listRemote().catch(() => null);
    const page = r?.pages.find((p) => p.origin === origin);
    if (page) setRemote((cur) => (cur ? replaceSessionPage(cur, page) : mergeSessionPages([page])));
    if (r) setUnavailable(r.unavailable);
  }, []);
  const loadMore = useCallback(async (origin: string, after: { lastActiveAt: number; id: string }) => {
    const r = await window.api.sessions.listRemote({ origin, after }).catch(() => null);
    const page = r?.pages[0];
    if (page) setRemote((cur) => (cur ? appendSessionPage(cur, page) : mergeSessionPages([page])));
    else if (r) setUnavailable((u) => [...u.filter((x) => x.origin !== origin), ...r.unavailable]);
  }, []);
  useEffect(() => {
    void loadRemote();
    const t = setInterval(() => void loadRemote(), 60_000);
    return () => clearInterval(t);
  }, [loadRemote]);
```

- Change the live-refresh effect so a remote push refreshes that origin, throttled 5 s per origin, and a local push keeps the existing `load()` path:

```tsx
  const remoteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const unsub = window.api.observability.onSummary((workspaceId) => {
      if (remoteOrigins.current.has(workspaceId)) {
        if (remoteTimers.current.has(workspaceId)) return;
        remoteTimers.current.set(workspaceId, setTimeout(() => {
          remoteTimers.current.delete(workspaceId);
          void refreshOrigin(workspaceId);
        }, 5_000));
        return;
      }
      if (reloadTimer.current) return;
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        void load();
      }, 1500);
    });
    return () => {
      unsub();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      for (const t of remoteTimers.current.values()) clearTimeout(t);
      remoteTimers.current.clear();
    };
  }, [load, refreshOrigin]);
```

  This replaces the existing `useEffect` that subscribes to `onSummary`. `onSummary`'s callback receives the workspace id as its first argument, as `App.tsx` uses it.
- In `renderRow`:
  - The `<li>` `key` becomes `` `${s.origin ?? 'local'}:${s.id}` ``.
  - Inside `session-row-meta`, as its first child, add:

```tsx
            {isRemoteRow(s) && <CloudGlyph title={`Remote · ${s.workspaceName}`} />}
```

- In the row-menu portal:
  - `items.find((x) => x.id === rowMenu.id)` stays, because ids are unique after dedup.
  - Wrap the Rename button, the divider and the Delete button in `{!isRemoteRow(s) && (<>…</>)}`.
  - Disable the Resume button for a remote row whose workspace isn't at `session` tier. The row doesn't carry the tier, so pass a new optional prop `remoteTiers?: Record<string, string | null>` from `LeftRail`/`App`, built from the workspaces list (`w.kind === 'remote' ? { [w.id]: w.remote?.tier ?? null } : {}`). Use `disabled={isRemoteRow(s) && remoteTiers?.[s.workspaceId] !== 'session'}` and the title `"Resuming here needs the session tier on this host"` when disabled.
- Replace the header's manual refresh with `void load(); void loadRemote();`. If the pane has no refresh button, add a `btn-mini` with `IconRefresh` and `aria-label="Refresh sessions"` beside the search box.
- Below the `<ul className="sessions-list">` (and inside the `pane-body`), add:

```tsx
        {unavailableText(unavailable) && <div className="sessions-unavailable subdued">{unavailableText(unavailable)}</div>}
        {remote?.more.map((m) => (
          <button key={m.origin} className="btn-mini sessions-more" onClick={() => void loadMore(m.origin, m.after)}>
            Load older sessions from {remote.rows.find((r) => r.origin === m.origin)?.workspaceName ?? 'remote'}
          </button>
        ))}
```

- CSS, in the stylesheet that holds `.session-row-meta`:

```css
.session-row-meta .remote-glyph { flex: none; opacity: 0.8; }
.sessions-unavailable { font-size: 11px; padding: 4px 8px; }
.sessions-more { margin: 4px 8px; }
```

- [ ] **Step 4: Run the renderer tests, typechecks and build**

Run: `npx vitest run src/renderer/ && npx tsc --noEmit -p tsconfig.web.json && npx tsc --noEmit -p tsconfig.node.json && npm run build`
Expected: all pass; clean; the build succeeds. If `npm run build` is environment-blocked (memory: `@xterm` addons), record the exact error in the PR and rely on typecheck + tests.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/renderer/src/components/CloudGlyph.tsx src/renderer/src/components/WorkspaceTabStrip.tsx src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts src/renderer/src/components/SessionsPane.tsx src/renderer/src/components/LeftRail.tsx src/renderer/src/App.tsx src/renderer/src/*.css
git -C "$W" commit -m "feat(sessions): merged local + remote list with origin badges, unavailable note, load more (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Stage only the stylesheet you edited, not a glob, if `git status` shows other changes.

---

### Task 10: SPEC.md and the full gate

> Items 5–7 and 9 below follow D71 in the built SPEC, not the CREATEROLE text.

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Update SPEC.md.** Each edit is a replacement or insertion at the named anchor. Write in the file's register: short factual sentences.

1. **§6 *Sessions*.** After the paragraph that defines `sessions:list(workspaceId?)`, add:

   > - `sessions:listRemote(req?: { origin, after })` → `{ pages: SourcePage<SessionListItem>[], unavailable: { origin, name, reason }[] }` (remote-workspaces (d)). With no argument, it returns the first page (≤ 200, newest first) of every remote bookmark's sessions. With `origin` and `after`, it returns that host's next keyset page. Rows carry `origin` (the remote workspace id) and the bookmark's name, hue and state. `sessions:list` is unchanged and its rows are local (`origin` absent). The renderer merges the two with `preload/federation.ts` `mergeSessionPages`: order `COALESCE(lastActiveAt, 0) DESC, id` (byte order), then origin; dedup on `(workspaceId, id)` with local first. A host whose cached liveness is down or unprobed, or that errs or exceeds 3 s, is listed under `unavailable` (`unreachable`, `checking`, `timeout`, `unauthorized`, `forbidden`, `standby`, `not-signed-in`, `protocol`) and its rows are absent. Rename and Delete don't apply to remote rows; `sessions:resume` on a remote id returns `{ containerId: <id> }` without starting anything, and the tab attaches with `--resume` (needs `session` on that host).

2. **§6 *Observability*.** Append:

   > - **Remote workspaces** (remote-workspaces (d)). `summaryForWorkspace` and `summaryForBrokerSession` route a remote bookmark's id to its host's `history:summary` (3 s bound, liveness-gated, validated by `federation/remoteRows.ts`). A remote tab gets the workspace's latest session, since the host keeps no tab mapping. An unavailable host answers null. Pushes come from the host's data-free `observability:summary` hint on `/events`: `federation/summaryRelay.ts` keeps one `/events` subscription per bookmark, debounces hints 2 s per host, reads `history:summary`, and sends the usual `observability:summary` push; a failed read sends nothing. Nothing remote is cached (live-only).

3. **§7 *Remote host*, the RPC channels paragraph after the *Routes* table.** Replace `RPC channels: \`sessions:live\` (\`read\`, …), \`ports:list\` (\`read\`), \`ports:kill\` (\`steer\`).` with that sentence plus:

   > `history:sessions` (`read`; args `[{ after?: { lastActiveAt, id }, limit? ≤ 200 }]` → `{ rows, next }`, a keyset page of the hosted workspace's sessions ordered `COALESCE(last_active_at, 0) DESC, id COLLATE "C"`, with `eventCount`/`usd` from `session_costs` and the latest chapter's tags) and `history:summary` (`read`; args `[sessionId?]` → `WorkspaceSummary | null`, null for a session outside the workspace). Both use the holder's `HistoryReader` (`historyRead.ts`), whose SQL always names the `host_meta` workspace id; arguments are parsed strictly and never widen it. Without a holder (no `db:`, or stores not open) they answer 503 `history unavailable` (`RpcUnavailableError`).

4. **§7 *Remote host*, *Ingest*.** Append:

   > After each chunk commits, the holder bumps a 2 s trailing hint that publishes `observability:summary` `{ workspaceId }` (no data) to `/events`.

5. **§7 *Remote host*, *Host MCP*, the *Tools* bullet.**
   - Change `(`HOST_MCP_TOOLS`, 13)` to `(`HOST_MCP_TOOLS`, 14)`.
   - Add `query` to the served list.
   - In the not-served list, remove `query and`, so it reads `` `search_transcripts` ((d2)) ``.
   - Then add a sub-bullet:

   > - **`query`** runs under part 4a's isolation (`openPgMcpReadSource` on the holder's fenced state handle; §9 *MCP `query` on Postgres*): caller = the hosted workspace, scope = `{hosted}`. It needs the app role's `CREATEROLE` (bootstrap step 2 on PG ≥ 16); without it `query` reports why and the other tools work. Until the container split, sessions can reach the app role itself (shared uid and pod identity), so this is defense in depth; it becomes a boundary with the split and matters once (e) adds publish partitions.

6. **§7 *Remote host*, *Bootstrap and migrate*, step (2).** Replace `the app role \`LOGIN NOCREATEDB NOCREATEROLE\`` with:

   > the app role `LOGIN NOCREATEDB CREATEROLE` on PG ≥ 16 (`NOCREATEROLE` below 16, where CREATEROLE can grant any non-superuser role; on 16 it administers only roles it created, for `query` isolation)

7. **§9.** After the *MCP `query` on Postgres* bullet's *Needs* sub-bullet, add:

   > - **On fleet-host** the same module isolates `query` for the hosted workspace (§7 *Host MCP*). Caller roles log in with a minted SCRAM password, not IAM; RDS accepts that for roles outside `rds_iam` (on the host checklist).

8. **§9, the *GitHub token reaches a remote host* bullet.** Add a sub-bullet:

   > - **Federated reads** (remote-workspaces (d)) send a host only its own cursors and limits and session ids it returned; no local row, id or text. Replies are validated and capped (`federation/remoteRows.ts`: ids `[A-Za-z0-9_.:-]{1,128}`, safe non-negative integers, finite numbers, `oneLine` text capped at 500/128/64/2000, ≤ 200 rows, ≤ 20 tags, ≤ 50 calls, ≤ 200 series points); a bad row is dropped, a bad envelope marks the host unavailable. Remote text renders as React text only.

9. **§11 *Remote host: what remains*.** Replace the `query` and `search_transcripts` bullet with:

   > - **`search_transcripts` on the host** ((d2)): needs the host embedder and indexer (`2026-11-06-remote-d2-federated-search.md`). `query` shipped in (d1).

   Add a bullet:

   > - **Host checklist for (d1):** re-run `fleet-host bootstrap` so the app role gets `CREATEROLE`; verify a caller role's SCRAM login against Aurora; verify `query` from a session sees only the hosted workspace.

- [ ] **Step 2: Run the full gate**

```bash
npx vitest run
npx vitest run -c vitest.pg.config.ts
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx tsc -p tsconfig.host.json
npm run build
npx vite build --config vite.host.config.ts
```

Expected: all green. If `npm run build` is environment-blocked, record the error. The host bundle build must pass, because the import-graph allowlist gained `preload/federation.ts`.

- [ ] **Step 3: Commit**

```bash
git -C "$W" add docs/SPEC.md
git -C "$W" commit -m "docs(spec): federated history reads, history:* RPC, query on the host (remote d1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

## Questions for Troy

1. **`CREATEROLE` for `fleet_agent` on Aurora (D60): decided, D71 (Troy, 2026-11-06).** No CREATEROLE. Bootstrap pre-provisions an IAM query login; host `query` needs the bootstrap re-run and `rds-db:connect` on `fleet_agent_query` (platform-ops#46).

## Self-review notes

- **Coverage:**
  - FederatedReader across Sessions (Tasks 7–9) and Observability (Task 8, routing + relay).
  - Origin badges (Task 9) and unavailable sources (Tasks 7, 9).
  - `query` role + RLS on the host (Task 5).
  - Transport and tiers (D54, Task 3).
  - Row identity and dedup (D55, Task 1).
  - Tie-safe keyset across sources (D56, Tasks 1–2, validated).
  - Timeouts and liveness reuse (D57, Task 7).
  - Security validation and caps (D59, Task 6).
  - Performance (D61: unchanged local paths, push not poll).
  - Live-only (D62).
  - Search and `search_transcripts` are (d2).
- **Type consistency:**
  - `SessionCursor` is used by `historyRead.ts`, `remoteRows.ts`, `federationIpc.ts` and preload.
  - `RemoteSessionRow` (host) and `RemoteSessionItem` (desktop) carry the same fields.
  - `RemoteSourceInfo` is defined in `remote.ts` and used by Tasks 7–8.
  - `UnavailableReason` includes `'model'` for (d2).
- **Not covered here:** `observability:eventsForSession`/`getCost` have no renderer caller (checked: only preload exposes them), so they aren't federated.
