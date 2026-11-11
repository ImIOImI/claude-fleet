# Remote (e) Transcript Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person opts a local or container workspace in to publishing. Its newly ingested transcript events are scrubbed on the desktop and pushed to a remote workspace's `fleet-host` (`POST /publish`). The host scrubs them again and stores them append-only under a partition derived from the verified caller, embeds them, and shows them to its own sessions' fleet-state MCP. The owner can withdraw a session (`DELETE /publish/<sessionId>`).

**Architecture:** Published rows go into the host's ordinary state tables (`events`, `sessions`, `embeddings`). Their `workspace_id` is a partition id derived from `(provider, account id, source workspace id)`, and their session id is derived from `(partition, source session id)`. Because of this, `ingestBatch`, the host indexer, the typed MCP tools, `search_transcripts` and the D71 `query` RLS all work unchanged once the MCP read scope is widened from `{hosted}` to `{hosted} ∪ partitions`. Two host-track tables (`publish_partitions`, `publish_sessions`) map partitions back to owners. On the desktop, a publisher driven by the JSONL watcher's `ingest` event reads events by id with a cursor (`publish_cursors`, state v19), runs them through one shared pure scrubber, and posts batches. The host runs the same scrubber, plus its own secret values, before it stores anything.

**Tech Stack:** TypeScript, Node `http`, Kysely on Postgres (host) and SQLite or Postgres (desktop), Electron main/preload/React renderer, vitest.

Spec: `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md`. The plan follows these parts of it:
- §6, the `POST /publish` row;
- §7 *One-way transcript publish*, *MCP visibility on the host*, *MCP `query` isolation on Postgres* and *Usefulness signals*;
- §9 *Publish scrubbing*;
- §11 item 5;
- §12 (e);
- §13 Q4.

## Global Constraints

- **D71:** nothing gets CREATEROLE.
  - No new role and no new grant.
  - The publish bookkeeping tables (`publish_partitions`, `publish_sessions`) are never granted to the `query` reader or raw roles. `ensureIsolation`'s `REVOKE ALL ON ALL TABLES` covers them.
  - `fleet-host bootstrap` is unchanged.
- **D73 / D96:** publish arrives at the host pod's `:8080` through the gateway as an authenticated request.
  - Any grant (`read` or higher) may publish.
  - No new TCP port opens.
  - Nothing reaches `:8081` or `:8082` from outside the mesh.
- **D82 / D83:** no image, architecture or memory-budget change.
- **D62 (live-only) still holds for federated reads.**
  - Publish is the one deliberate cross-boundary write.
  - Nothing a host holds is pulled into a desktop DB. The desktop receives only acks (`accepted`, `inserted`, `removed`).
- **Partition from identity only.**
  - The partition is derived only from the verified caller's `(identity.provider, identity.id)` plus the body's `sourceWorkspaceId`.
  - Any body key other than `sourceWorkspaceId`, `sessionId` and `events` is a 400.
- **Wire limits:**
  - body ≤ 1 MiB (`1048576` bytes);
  - 1–500 lines per request;
  - one session per request.
- **Rate limits:**
  - per identity, 1 request in flight and a token bucket of 20 burst refilling 2 per second;
  - host-wide, 4 publishes in flight.
- **Append-only.**
  - Inserts are `ON CONFLICT DO NOTHING` on `events (session_id, dedup_key)`. There is no update path for event rows.
  - The only delete is the owner-only `DELETE /publish/<sessionId>`.
- **Scrub before anything leaves.**
  - The desktop scrubs every line with `makeScrubber`. `RemoteClient.publish` accepts only `ScrubbedLine`.
  - The host scrubs every line again, with the patterns plus its own secret values, before `ingestBatch`.
- **Opt-in only.**
  - Only manifests with `publish.to` non-empty publish, and only to targets that are bookmarked remote workspaces.
  - Only sessions that started at or after the time that target was turned on are published.
- **Migrations are expand-only:** new tables and one nullable column. The previous release keeps running against them (`fleet-host migrate` runs before rollout).
- **Code comments:** terse and only for non-obvious "why" (`.claude/rules/review-conventions.md`).
- **SPEC:** `docs/SPEC.md` is updated in the same PR (`.claude/rules/spec-maintenance.md`), in Task 11.
- **Gate:**
  - Run `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json` **separately**, because `npm run typecheck` short-circuits.
  - Then `npx vitest run` and `npm run build`.
  - Then the Postgres suite: `scripts/pg-test-server.sh start`, export the printed `PG_TEST_URL`, and run `npm run test:unit:pg`.
- **Environment:**
  - There is no Docker and no display here.
  - UI is eyeballed on Troy's host.
  - Host behaviour behind the gateway is verified on the cluster.
- **Worktree:**
  - Implement in a fresh worktree off `origin/main` on branch `feat/remote-e-publish`.
  - Install with `npm ci --ignore-scripts` in the worktree.
  - Never `cd /workspace/claude-fleet`.
  - Use `git -C <worktree>`.

## Decisions

Numbering continues from D96.

- **D97: Published rows live in the ordinary state tables under a derived partition id.**
  - **Partition id:** `workspace_id` = `partitionIdFor(owner, sourceWorkspaceId)` = `pub_` + the first 32 hex characters of `sha256("<provider>:<accountId>\0<sourceWorkspaceId>")`.
  - **Why:** ingest, the indexer and its backfill, the typed MCP tools, `search_transcripts` and the `query` RLS key on `workspace_id`, so they need no change beyond the scope.
  - **Bookkeeping:** host track v2 adds `publish_partitions` (partition → owner provider, owner id, owner login, source workspace) and `publish_sessions` (stored session id → partition, source session id).
- **D98: Session ids are derived, so a publisher can't write into anyone else's session.**
  - The stored session id is `publishedSessionId(partitionId, sourceSessionId)`: a UUID-shaped string from `sha256("<partitionId>\0<sourceSessionId>")`, with version nibble `5` and variant `8`–`b`.
  - If a `sessions` row with that id already exists in another workspace, the request is refused with 409 and the transaction rolls back.
- **D99: Partitions are keyed on the account id, not the login.**
  - The spec says `owner_login` + `source_workspace_id`. Logins can be renamed and reused, so the key is `(owner_provider, owner_id, source_workspace_id)`.
  - `owner_login` is stored for display and refreshed on every publish.
- **D100: Only people publish.**
  - A machine identity (a GitHub App bot) gets 403 `publishing is for people, not machine identities` at admission.
  - Any grant tier may publish.
  - A host without `db:` has no `/publish` route (404).
- **D101: Wire format and limits.**
  - `POST /publish` takes the JSON body `{ sourceWorkspaceId: ULID, sessionId: lowercase UUID, events: string[1..500] }`.
    - Each event is one line (no CR or LF) that parses as a JSON object.
    - The body is at most 1 MiB.
  - One request is one fenced `ingestBatch` transaction with `SET LOCAL statement_timeout = '5s'`.
  - The reply is `{ ok: true, accepted, inserted }`.
  - Refusals:

    | Status | Reason |
    |---|---|
    | 400 | shape |
    | 409 | session conflict |
    | 413 | body |
    | 415 | content type |
    | 429 | per identity, with `Retry-After` |
    | 503 | busy, no holder, or standby, with `Retry-After` |

  - Admission (rate and machine checks) runs before the body is read.
- **D102: One shared scrubber, on both sides** (`src/main/publish/scrub.ts`).
  - **Order:** values first, then `redactSecrets`, then AWS `AKIA…`/`ASIA…`, then `*_KEY|*_TOKEN|*_SECRET|*_PASSWORD=` assignments.
  - **Values:**
    - Each secret value of at least 8 characters becomes `[redacted:<KEY>]`. Longer values go first.
    - Both the raw form and the JSON-escaped form are replaced.
  - **Patterns** become `[redacted]`.
  - **Structural pass:** decode the JSON line, scrub every nested string, and re-serialize only when something changed. A clean line keeps its bytes, and so its `dedup_key`.
  - **Text backstop:** a text pass then runs on the serialized line.
  - **Type gate:** the output type `ScrubbedLine` is branded. `RemoteClient.publish` takes only that type, so an unscrubbed line can't be sent.
- **D103: The host scrubs its own secret values too.**
  - **Sources:**
    - fleet-host's env vars whose names end in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or `CREDENTIAL(S)` (after `_` or at the start);
    - every name in `storeSecretEnvNames(config.db)`;
    - the password inside any `postgres://` value among them.
  - They are computed once at start, because `db` can't change on reload.
  - The App's PEM key and installation tokens are caught by the patterns.
- **D104: What gets published.**
  - The manifest gains `publish?: { to: string[]; since: Record<string, number> }`. `since[id]` is when target `id` was turned on.
  - Main sets `since` in `workspace:writeManifest` and never trusts the renderer for it. A target already on keeps its `since`.
  - A target turned off and on again gets a new `since`.
  - Only sessions with `started_at ≥ since[target]` are published.
    - Earlier sessions, including one in progress when publishing was turned on, are never sent.
    - A session with no timestamped line has no `started_at` and isn't published.
  - The shape adds `since` to the spec's `{ to }`.
  - A request whose manifest lacks the `publish` key keeps the existing block. The Saved-tab resume and the committee writes omit it.
- **D105: Desktop bookkeeping (state v19, both dialects).**
  - `publish_cursors(source_workspace_id, target_workspace_id, last_event_id, updated_at)` is a progress cache.
    - It is copied by the SQLite → Postgres import (`IMPORT_TABLES`), not by the user-state merge.
    - After a store switch it restarts at 0. The host's dedup keys make that a no-op apart from bandwidth.
  - `publish_withheld(session_id, workspace_id, withheld_at)` is user-authored. It is merged across store switches (`USER_STATE_MERGE`, upsert).
  - `usage_events.origin` (nullable) is added in the same version.
  - `purgeWorkspace` drops the workspace's cursors and withheld rows.
- **D106: Publisher behaviour.**
  - **Triggers:**
    - the first `ingest` event of a quiet period publishes 2 s later (not reset by later events);
    - a sweep runs every 60 s;
    - one pass runs per (source, target) pair at a time;
    - pages are 500 events.
  - **Batches:** consecutive same-session rows, ≤ 500 lines and ≤ 1 MiB per batch.
  - **Lines that are skipped:** withheld sessions, non-UUID session ids, and a line too big for a batch on its own. The cursor still advances past them.
  - **Error handling:**

    | Reply | Action |
    |---|---|
    | 400, 409, 413 | Skip the batch: log once, advance the cursor. |
    | not signed in, 401, 403 | Retry in 5 min. |
    | any other failure | Back off 5 s → 15 s → 60 s → 5 min, or by `Retry-After` when it is longer. |

  - If the workspace's vault can't be read, nothing is sent (fail closed): it logs `publish-scrub-unavailable` and retries in 5 min.
  - Log types: `publish-failed`, `publish-batch-refused`, `publish-line-skipped`, `publish-scrub-unavailable`, `publish-recovered`, each logged once per state change.
- **D107: Host MCP visibility.**
  - **Scope:** the host MCP's read scope is `{hosted} ∪ every partition id`. It is read from `publish_partitions` on every tool call, so a new partition shows at once.
  - **Tools covered:** the typed tools, `search_transcripts` and `query`. `query` gets the partitions through `mcp_grants`, under RLS, as the D71 login.
  - **Desktop viewers:** the `history:*` RPC stays hosted-only in (e). Desktop federation doesn't show published rows, which also avoids a publisher seeing their own session twice.
  - **Bookkeeping tables:** `publish_partitions` and `publish_sessions` are never readable through `query`.
- **D108: `usage_events.origin` and the counting rule.**
  - **What `origin` holds:** on the host, `origin` is the workspace of the marked or hit session (the hosted id or a partition id). The holder's recorder (`hostUsageRecorder`) writes it. The desktop leaves it NULL.
  - **The rule:** a `marked-useful` counts only when `origin` is non-null and differs from the marker's `workspace_id`. So the host's sessions marking their own sessions doesn't count, and marks on published (people's) sessions do. This follows spec §7 *Usefulness signals*.
  - **`mark_useful`:** it joins the host tool set, so the host serves 15 tools, or 16 with search.
  - **Consumer:** `usefulMarkCounts(sessionIds)` applies the rule. Its consumer (ranking, retention) comes later. No publisher-facing stats RPC ships in (e).
- **D109: Unpublish (spec §13 Q4 adopted).**
  - **Route:** `DELETE /publish/<sessionId>` (any grant, people only, the same admission). It deletes that source session from every partition the caller owns:
    - `events`, rollups and `embeddings` (through `deleteSessionRows`);
    - its `usage_events`;
    - its `publish_sessions` row.
  - Each stored session is removed in its own fenced transaction.
  - **Reply:** 200 `{ ok: true, removed: n }`, or 404 `not published`.
  - **Desktop:** the desktop first records the session in `publish_withheld`, so its later events are never published again, then calls every current target.
  - **Scope:** nothing else ever deletes or updates published rows.
- **D110: No host retention of published rows in (e).** The host runs no retention pass today, so published rows stay until unpublished. This is listed under §11 *Remote host: what remains*.
- **D111: There is no new port, role or grant.** Publish rides `:8080` (D73, D96). Its tables are host-track tables owned by the app role and are invisible to the `query` roles (D71).

## File Structure

**Shared, pure** (imported by both the desktop and fleet-host; no Electron):
- Create `src/main/publish/protocol.ts`:
  - constants (`PUBLISH_MAX_BODY`, `PUBLISH_MAX_LINES`, `ULID_RE`, `SESSION_UUID_RE`);
  - types (`PublishBatch`, `PublishAck`, `PublishOwner`);
  - `parsePublishBody`, `partitionIdFor`, `publishedSessionId`.
- Create `src/main/publish/scrub.ts`: `ScrubValue`, `ScrubbedLine`, `MIN_SECRET_LEN`, `makeScrubber`.
- Create `src/preload/publish.ts`:
  - `WorkspacePublish`, `UnpublishResult`, `sanitizePublish`, `publishForWrite`;
  - this directory is compiled by both tsconfigs.

**Host:**
- Modify `src/host/hostSchema.ts`: host track v2 (`publish_partitions`, `publish_sessions`).
- Create `src/host/publishStore.ts`: claim plus ingest, `partitionIds`, `unpublish`. Runs on the holder's fenced state store.
- Create `src/host/publishRoute.ts`: `PublishGate`, `hostSecretValues`, `createPublishRoute` (admit, post, remove).
- Modify `src/host/server.ts`: `/publish` (POST) and `/publish/<id>` (DELETE).
- Modify `src/host/holder.ts`: build the publish store, bump the indexer, pass the MCP scope and the usage recorder.
- Modify `src/host/hostMcp.ts`: `scope` and `recordUsage` options, `mark_useful`, `hostUsageRecorder`.
- Modify `src/host/main.ts`: wire the route.
- Modify `src/host/testHost.ts`: an optional `publish` route for desktop tests.

**Desktop data:**
- Modify `src/main/db.ts`:
  - v19 SQLite migration;
  - `blobsFor`, `publishableEvents` and the cursor and withheld helpers;
  - `recordUsageEvent` origin, `usefulMarkCounts`;
  - `deleteSessionRows`, and `purgeWorkspace` cleanup.
- Modify `src/main/store/migrations/statePg.ts`: v19 step.
- Modify `src/main/store/stateSchema.ts`: the new tables and the `origin` column.
- Modify `src/main/store/storeImport.ts` (`IMPORT_TABLES`) and `src/main/store/userStateMerge.ts` (`publish_withheld`).
- Modify `src/main/mcpCore.ts`: `setUsageRecorder` accepts `null`.

**Desktop publish:**
- Create `src/main/publish/batches.ts`: `planBatches`.
- Create `src/main/publish/publisher.ts`: `startPublisher`.
- Create `src/main/publish/secretValues.ts`: `publishSecretValues`.
- Create `src/main/publish/publishIpc.ts`: `publish:unpublish`.
- Modify `src/main/remoteClient.ts`: `publish`, `unpublish`.
- Modify `src/main/workspaces.ts`: the `publish` manifest field.
- Modify `src/main/ipc.ts`:
  - `writeManifest` computes `publish` and drops the cursors of removed targets;
  - wire the publisher and the IPC.
- Modify `src/preload/index.ts`: the `publish.unpublish` bridge.

**Renderer:**
- Create `src/renderer/src/components/publishTargets.ts`: copy and pure helpers.
- Modify:
  - `WorkspaceForm.tsx`: the "Publish transcripts to…" control, edit mode only;
  - `formInitial.ts`, `App.tsx`;
  - `sessionsView.ts`: `publishTargetsMap`;
  - `LeftRail.tsx`, `SessionsPane.tsx`: the Unpublish row action;
  - `styles.css`;
  - `tsconfig.web.json`: include `src/preload/publish.ts`.

**Tests:**
- New:
  - `src/main/publish/{protocol,scrub,batches,publisher,secretValues,publishIpc}.test.ts`;
  - `src/main/dbPublish.test.ts`, `src/main/dbUsefulMarks.test.ts`;
  - `src/host/{hostSchema.pg,publishStore.pg,publishRoute}.test.ts`;
  - `src/preload/publish.test.ts`, `src/renderer/src/components/publishTargets.test.ts`.
- Extended: `server.test.ts`, `hostMcp.test.ts`, `hostQuery.pg.test.ts`, `main.pg.test.ts`, `remoteClient.test.ts`, `sessionsView.test.ts`, `vitest.pg.config.ts`.

**Docs:** `docs/SPEC.md` (Task 11).

---

### Task 1: Schema — state v19 and host track v2

**Files:**
- Modify `src/main/db.ts`: the migration function, after the `user_version < 18` block (~line 918).
- Modify `src/main/store/migrations/statePg.ts`: add `PUBLISH_V19` and the step.
- Modify `src/main/store/stateSchema.ts`: `UsageEventsTable`, the new table interfaces and `StateDb`.
- Modify `src/main/store/storeImport.ts`: `IMPORT_TABLES.state`.
- Modify `src/main/store/userStateMerge.ts`: `USER_STATE_MERGE`.
- Modify `src/host/hostSchema.ts`.
- Create `src/main/dbPublish.test.ts`.
- Create `src/host/hostSchema.pg.test.ts`.
- Modify `vitest.pg.config.ts`: include both new tests.

**Interfaces:**
- Produces:
  - tables `publish_cursors`, `publish_withheld` and column `usage_events.origin` on both dialects (state v19);
  - `publish_partitions` and `publish_sessions` on the host track (v2);
  - Kysely types `PublishCursorsTable`, `PublishWithheldTable` and `HostDb.publish_partitions` / `publish_sessions`;
  - `UsageEventsTable.origin: string | null`.

- [ ] **Step 1: Write the failing tests**

`src/main/dbPublish.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as db from './db.js';
import { openTestState } from './store/testStore.js';

describe('state v19: publish tables', () => {
  it('creates publish_cursors, publish_withheld and usage_events.origin', async () => {
    await openTestState('pub-schema-');
    const k = db.stateKysely();
    await k.insertInto('publish_cursors').values({ source_workspace_id: 'W', target_workspace_id: 'R', last_event_id: 5, updated_at: 1 }).execute();
    await k.insertInto('publish_withheld').values({ session_id: 's1', workspace_id: 'W', withheld_at: 1 }).execute();
    await k.insertInto('usage_events').values({ ts: 1, workspace_id: 'W', session_id: 's1', kind: 'marked-useful', detail: null, origin: 'pub_x' }).execute();
    expect(Number((await k.selectFrom('publish_cursors').select('last_event_id').executeTakeFirstOrThrow()).last_event_id)).toBe(5);
    expect((await k.selectFrom('usage_events').select('origin').executeTakeFirstOrThrow()).origin).toBe('pub_x');
    await expect(
      k.insertInto('publish_cursors').values({ source_workspace_id: 'W', target_workspace_id: 'R', last_event_id: 6, updated_at: 2 }).execute()
    ).rejects.toThrow();
  });
});
```

`src/host/hostSchema.pg.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';

describe.skipIf(!isPg)('host track v2', () => {
  let t: TestPg | null = null;
  afterEach(async () => { await t?.drop(); t = null; });

  it('adds publish_partitions and publish_sessions, keyed by owner account and partition', async () => {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await k.insertInto('publish_partitions').values({ partition_id: 'pub_a', owner_provider: 'github', owner_id: '1', owner_login: 'ann', source_workspace_id: 'W', created_at: 1 }).execute();
    await expect(k.insertInto('publish_partitions').values({ partition_id: 'pub_b', owner_provider: 'github', owner_id: '1', owner_login: 'ann2', source_workspace_id: 'W', created_at: 1 }).execute())
      .rejects.toThrow(/unique/i);
    await k.insertInto('publish_sessions').values({ session_id: 's', partition_id: 'pub_a', source_session_id: 'x', first_published_at: 1, last_published_at: 1 }).execute();
    await expect(k.insertInto('publish_sessions').values({ session_id: 's2', partition_id: 'pub_zz', source_session_id: 'y', first_published_at: 1, last_published_at: 1 }).execute())
      .rejects.toThrow(/foreign key/i);
    const v = await sql<{ version: number }>`SELECT version FROM schema_migrations WHERE track = 'host'`.execute(k);
    expect(Number(v.rows[0].version)).toBe(2);
  });
});
```

Add to `vitest.pg.config.ts` `include`, in alphabetical position:

```ts
      'src/host/hostSchema.pg.test.ts',
```

```ts
      'src/main/dbPublish.test.ts',
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/dbPublish.test.ts`.
Expected: FAIL with `no such table: publish_cursors`.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: errors on `publish_cursors`, `origin` and `publish_partitions` (types not declared).

- [ ] **Step 3: Implement the migrations and types**

In `src/main/db.ts`, after the `user_version < 18` block and before the closing `}` of the migration function:

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 19) {
    // Transcript publish (SPEC §7 *Transcript publish*).
    const cols = d.prepare(`PRAGMA table_info(usage_events)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'origin')) d.exec(`ALTER TABLE usage_events ADD COLUMN origin TEXT`);
    d.exec(`
      CREATE TABLE IF NOT EXISTS publish_cursors (
        source_workspace_id TEXT NOT NULL,
        target_workspace_id TEXT NOT NULL,
        last_event_id       INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        PRIMARY KEY (source_workspace_id, target_workspace_id)
      );
      CREATE TABLE IF NOT EXISTS publish_withheld (
        session_id   TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        withheld_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_publish_withheld_workspace ON publish_withheld(workspace_id);
    `);
    d.pragma('user_version = 19');
  }
```

In `src/main/store/migrations/statePg.ts`, after `TRANSCRIPT_OFFSETS_V18`:

```ts
const PUBLISH_V19 = `
ALTER TABLE usage_events ADD COLUMN origin ${T};
CREATE TABLE publish_cursors (
  source_workspace_id ${T} NOT NULL,
  target_workspace_id ${T} NOT NULL,
  last_event_id BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (source_workspace_id, target_workspace_id)
);
CREATE TABLE publish_withheld (
  session_id ${T} PRIMARY KEY,
  workspace_id ${T} NOT NULL,
  withheld_at BIGINT NOT NULL
);
CREATE INDEX idx_publish_withheld_workspace ON publish_withheld (workspace_id);
`;
```

and extend `steps`:

```ts
  steps: [{ version: 15, postgres: PORT_EXPOSURES_V15 }, { version: 16, postgres: RETENTION_V16 }, { version: 17, postgres: ATTACHMENTS_V17 }, { version: 18, postgres: TRANSCRIPT_OFFSETS_V18 }, { version: 19, postgres: PUBLISH_V19 }]
```

In `src/main/store/stateSchema.ts`, add `origin` as the last field of `UsageEventsTable`:

```ts
  /** Host only: the workspace of the session the signal is about (hosted id or a publish partition). */
  origin: string | null;
```

After `TranscriptOffsetsTable`:

```ts
export interface PublishCursorsTable {
  source_workspace_id: string;
  target_workspace_id: string;
  last_event_id: number;
  updated_at: number;
}
export interface PublishWithheldTable {
  session_id: string;
  workspace_id: string;
  withheld_at: number;
}
```

and in `StateDb`, after `transcript_offsets`:

```ts
  publish_cursors: PublishCursorsTable;
  publish_withheld: PublishWithheldTable;
```

In `src/main/store/storeImport.ts`, the `state` list ends:

```ts
    'port_exposures', 'event_retention', 'maintenance', 'event_blobs', 'transcript_offsets', 'publish_cursors', 'publish_withheld'],
```

In `src/main/store/userStateMerge.ts`, append to `USER_STATE_MERGE`:

```ts
  // Unpublished on purpose: must survive a store switch.
  { table: 'publish_withheld', key: ['session_id'], mode: 'upsert' },
```

In `src/host/hostSchema.ts`, extend `HostDb`:

```ts
  publish_partitions: { partition_id: string; owner_provider: string; owner_id: string; owner_login: string; source_workspace_id: string; created_at: number };
  publish_sessions: { session_id: string; partition_id: string; source_session_id: string; first_published_at: number; last_published_at: number };
```

and replace the `HOST_TRACK` line with:

```ts
// Transcript publish: who owns each partition, and which source session each stored session came from.
const HOST_PUBLISH_V2 = `
CREATE TABLE publish_partitions (
  partition_id TEXT COLLATE "C" PRIMARY KEY,
  owner_provider TEXT COLLATE "C" NOT NULL,
  owner_id TEXT COLLATE "C" NOT NULL,
  owner_login TEXT COLLATE "C" NOT NULL,
  source_workspace_id TEXT COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (owner_provider, owner_id, source_workspace_id)
);
CREATE TABLE publish_sessions (
  session_id TEXT COLLATE "C" PRIMARY KEY,
  partition_id TEXT COLLATE "C" NOT NULL REFERENCES publish_partitions (partition_id),
  source_session_id TEXT COLLATE "C" NOT NULL,
  first_published_at BIGINT NOT NULL,
  last_published_at BIGINT NOT NULL,
  UNIQUE (partition_id, source_session_id)
);
CREATE INDEX idx_publish_sessions_source ON publish_sessions (source_session_id);
`;

export const HOST_TRACK: PgTrack = {
  track: 'host', baselineVersion: HOST_PG_BASELINE_VERSION, baseline: HOST_PG_BASELINE, steps: [{ version: 2, postgres: HOST_PUBLISH_V2 }]
};
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/main/dbPublish.test.ts src/main/store/storeImport.test.ts src/main/store/userStateMerge.test.ts`.
Expected: PASS. `storeImport.test.ts` "copies every table" pins `IMPORT_TABLES.state` to the track, so it now passes only with the two new names.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

On Postgres (`scripts/pg-test-server.sh start`, then `export PG_TEST_URL=<printed>`):
```bash
npx vitest run -c vitest.pg.config.ts src/main/dbPublish.test.ts src/host/hostSchema.pg.test.ts src/main/store/schemaParity.test.ts src/main/store/storeImport.test.ts src/main/store/userStateMerge.test.ts
```
Expected: PASS. `schemaParity` confirms SQLite v19 ≡ Postgres v19.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/store/migrations/statePg.ts src/main/store/stateSchema.ts src/main/store/storeImport.ts src/main/store/userStateMerge.ts src/host/hostSchema.ts src/main/dbPublish.test.ts src/host/hostSchema.pg.test.ts vitest.pg.config.ts
git commit -m "feat(publish): state v19 and host track v2 tables"
```

**Verification:**

| Where | What |
|---|---|
| Local | SQLite tests; the Postgres suite through `scripts/pg-test-server.sh`. |
| CI | Both suites. |
| Cluster | `fleet-host migrate` logs `host` at 2 and `state` at 19 against RDS. |

---

### Task 2: Shared scrubber and wire protocol

**Files:**
- Create `src/main/publish/scrub.ts` and `src/main/publish/scrub.test.ts`.
- Create `src/main/publish/protocol.ts` and `src/main/publish/protocol.test.ts`.

**Interfaces:**
- Consumes: `redactSecrets(s: string): string` from `src/main/identity/redact.ts`.
- Produces from `scrub.ts`:
  - `interface ScrubValue { key: string; value: string }`
  - `type ScrubbedLine = string & { readonly [brand]: true }`
  - `MIN_SECRET_LEN = 8`
  - `makeScrubber(values: readonly ScrubValue[]): (line: string) => ScrubbedLine`
- Produces from `protocol.ts`:
  - constants `PUBLISH_MAX_BODY = 1048576`, `PUBLISH_MAX_LINES = 500`, `ULID_RE`, `SESSION_UUID_RE`
  - `interface PublishBatch<L extends string = string> { sourceWorkspaceId: string; sessionId: string; events: L[] }`
  - `interface PublishAck { ok: true; accepted: number; inserted: number }`
  - `interface PublishOwner { provider: string; id: number; login: string }`
  - `class PublishArgError`
  - `parsePublishBody(v: unknown): PublishBatch`
  - `partitionIdFor(owner: Pick<PublishOwner, 'provider' | 'id'>, sourceWorkspaceId: string): string`
  - `publishedSessionId(partitionId: string, sourceSessionId: string): string`

- [ ] **Step 1: Write the failing tests**

`src/main/publish/scrub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeScrubber, MIN_SECRET_LEN } from './scrub.js';

const line = (o: unknown): string => JSON.stringify(o);
const text = (out: string): string => JSON.parse(out).t as string;

describe('makeScrubber', () => {
  it('replaces secret values with [redacted:<KEY>], longest first, in nested strings', () => {
    const s = makeScrubber([{ key: 'DB_PASS_PREFIX', value: 'hunter2h' }, { key: 'DB_PASS', value: 'hunter2hunter2' }]);
    const out = JSON.parse(s(line({ type: 'user', message: { content: [{ text: 'pw is hunter2hunter2 ok' }] } })));
    expect(out.message.content[0].text).toBe('pw is [redacted:DB_PASS] ok');
  });

  it('ignores values shorter than MIN_SECRET_LEN', () => {
    const short = 'x'.repeat(MIN_SECRET_LEN - 1);
    expect(makeScrubber([{ key: 'SHORT', value: short }])(line({ t: short }))).toBe(line({ t: short }));
  });

  it('finds a value that contains JSON-escaped characters', () => {
    const s = makeScrubber([{ key: 'TOK', value: 'abc"def\\ghi' }]);
    expect(text(s(line({ t: 'x abc"def\\ghi y' })))).toBe('x [redacted:TOK] y');
  });

  it.each([
    ['sk-ant-api03-' + 'a'.repeat(30)],
    ['ghp_' + 'A'.repeat(36)],
    ['gho_' + 'A'.repeat(36)],
    ['ghs_' + 'A'.repeat(36)],
    ['github_pat_' + 'A'.repeat(40)],
    ['AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['ASIA' + 'ABCDEFGHIJKLMNOP'],
    ['Bearer abcdefgh12345678xyz']
  ])('redacts the token shape %s', (secret) => {
    const out = text(makeScrubber([])(line({ t: `before ${secret} after` })));
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----';
    expect(text(makeScrubber([])(line({ t: `key: ${pem}` })))).not.toContain('MIIEsecret');
  });

  it('redacts *_KEY / *_TOKEN / *_SECRET / *_PASSWORD assignments, quoted or not', () => {
    const out = text(makeScrubber([])(line({ t: `export OPENAI_API_KEY=abc123 MY_TOKEN="q w" app_secret='x' DB_PASSWORD=p FOO=bar` })));
    expect(out).toBe('export OPENAI_API_KEY=[redacted] MY_TOKEN=[redacted] app_secret=[redacted] DB_PASSWORD=[redacted] FOO=bar');
  });

  it('does not re-redact a value already replaced by its key', () => {
    const s = makeScrubber([{ key: 'MY_TOKEN', value: 'tok-123456789' }]);
    expect(text(s(line({ t: 'MY_TOKEN=tok-123456789' })))).toBe('MY_TOKEN=[redacted:MY_TOKEN]');
  });

  it('leaves a clean line byte-identical and keeps a tricky line valid JSON', () => {
    const clean = '{"type":"user","a":"b c"}';
    expect(makeScrubber([])(clean)).toBe(clean);
    const out = makeScrubber([])(line({ a: 'X_TOKEN=', b: 'c' }));
    expect(JSON.parse(out)).toEqual({ a: 'X_TOKEN=', b: 'c' });
  });

  it('scrubs a non-JSON line as text', () => {
    expect(makeScrubber([{ key: 'K', value: 'supersecret1' }])('raw supersecret1')).toBe('raw [redacted:K]');
  });
});
```

`src/main/publish/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  parsePublishBody, partitionIdFor, PublishArgError, publishedSessionId, PUBLISH_MAX_LINES, SESSION_UUID_RE
} from './protocol.js';

const SRC = '01JC0000000000000000000005';
const SID = '11111111-2222-4333-8444-555555555555';
const ok = { sourceWorkspaceId: SRC, sessionId: SID, events: ['{"type":"user"}'] };

describe('parsePublishBody', () => {
  it('accepts the three fields', () => {
    expect(parsePublishBody(ok)).toEqual(ok);
  });

  it.each([
    [{ ...ok, ownerLogin: 'bob' }, /unknown field: ownerLogin/],
    [{ ...ok, workspaceId: SRC }, /unknown field: workspaceId/],
    [JSON.parse(`{"__proto__":{},"sourceWorkspaceId":"${SRC}","sessionId":"${SID}","events":["{}"]}`), /unknown field: __proto__/],
    [{ ...ok, sourceWorkspaceId: 'not-a-ulid' }, /sourceWorkspaceId/],
    [{ ...ok, sessionId: SID.toUpperCase() }, /sessionId/],
    [{ ...ok, events: [] }, /1-500/],
    [{ ...ok, events: Array(PUBLISH_MAX_LINES + 1).fill('{}') }, /1-500/],
    [{ ...ok, events: ['{"a":\n1}'] }, /events\[0\] must be one JSONL line/],
    [{ ...ok, events: ['nope'] }, /events\[0\] is not JSON/],
    [{ ...ok, events: ['[1]'] }, /events\[0\] must be a JSON object/],
    [[ok], /body must be/]
  ])('refuses %j', (body, msg) => {
    expect(() => parsePublishBody(body)).toThrow(PublishArgError);
    expect(() => parsePublishBody(body)).toThrow(msg);
  });
});

describe('partition and session ids', () => {
  const ann = { provider: 'github', id: 7 };
  it('derives a stable partition per (provider, account, source workspace)', () => {
    const p = partitionIdFor(ann, SRC);
    expect(p).toMatch(/^pub_[0-9a-f]{32}$/);
    expect(partitionIdFor({ ...ann }, SRC)).toBe(p);
    expect(partitionIdFor({ ...ann, id: 8 }, SRC)).not.toBe(p);
    expect(partitionIdFor({ ...ann, provider: 'gitlab' }, SRC)).not.toBe(p);
    expect(partitionIdFor(ann, '01JC0000000000000000000006')).not.toBe(p);
  });

  it('derives a UUID-shaped session id per partition', () => {
    const p = partitionIdFor(ann, SRC);
    const s = publishedSessionId(p, SID);
    expect(s).toMatch(SESSION_UUID_RE);
    expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publishedSessionId(p, SID)).toBe(s);
    expect(publishedSessionId(partitionIdFor({ ...ann, id: 8 }, SRC), SID)).not.toBe(s);
    expect(s).not.toBe(SID);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/publish/scrub.test.ts src/main/publish/protocol.test.ts`.
Expected: FAIL. The modules don't exist.

- [ ] **Step 3: Implement**

`src/main/publish/scrub.ts`:

```ts
// Publish scrubbing (remote-workspaces §7, §9). Pure: the desktop publisher and fleet-host both run it.
import { redactSecrets } from '../identity/redact.js';

export interface ScrubValue {
  key: string;
  value: string;
}

declare const scrubbedBrand: unique symbol;
/** Only makeScrubber returns this; RemoteClient.publish accepts nothing else. */
export type ScrubbedLine = string & { readonly [scrubbedBrand]: true };

/** Shorter values would match ordinary words. */
export const MIN_SECRET_LEN = 8;

const AWS_KEY = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g;
const NAME = String.raw`((?<![A-Za-z0-9_])(?:export\s+)?[A-Za-z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?!\[redacted)`;
// Serialized JSON gets no quoted form: a match there could swallow a string's closing quote.
const ASSIGN_DECODED = new RegExp(`${NAME}("[^"\\n]*"|'[^'\\n]*'|[^\\s"'\\\\]+)`, 'gi');
const ASSIGN_TEXT = new RegExp(`${NAME}([^\\s"'\\\\]+)`, 'gi');

type Swap = Array<[RegExp, string]>;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeKey = (k: string): string => k.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'SECRET';

function compile(values: readonly ScrubValue[]): { decoded: Swap; escaped: Swap } {
  const decoded: Swap = [];
  const escaped: Swap = [];
  const seen = new Set<string>();
  for (const v of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (v.value.length < MIN_SECRET_LEN || seen.has(v.value)) continue;
    seen.add(v.value);
    const label = `[redacted:${safeKey(v.key)}]`;
    decoded.push([new RegExp(escapeRe(v.value), 'g'), label]);
    escaped.push([new RegExp(escapeRe(JSON.stringify(v.value).slice(1, -1)), 'g'), label]);
  }
  return { decoded, escaped };
}

const swap = (s: string, list: Swap): string => list.reduce((acc, [re, label]) => acc.replace(re, () => label), s);
const patterns = (s: string, assign: RegExp): string => redactSecrets(s).replace(AWS_KEY, '[redacted]').replace(assign, '$1[redacted]');

/** Strips every secret value and known token shape from one JSONL line; a clean line keeps its bytes (and dedup key). */
export function makeScrubber(values: readonly ScrubValue[]): (line: string) => ScrubbedLine {
  const c = compile(values);
  const text = (s: string): string => patterns(swap(s, c.decoded), ASSIGN_DECODED);
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  return (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return text(line) as ScrubbedLine;
    }
    const after = JSON.stringify(deep(parsed));
    const out = after === JSON.stringify(parsed) ? line : after;
    // Backstop on the serialized form, as host ingest's redactJsonLine does.
    return patterns(swap(out, c.escaped), ASSIGN_TEXT) as ScrubbedLine;
  };
}
```

`src/main/publish/protocol.ts`:

```ts
// POST /publish wire format (remote-workspaces §7). Pure: shared by the desktop publisher and fleet-host.
import { createHash } from 'node:crypto';

export const PUBLISH_MAX_BODY = 1024 * 1024;
/** INGEST_TX_LINES: one request is one fenced ingest transaction on the host. */
export const PUBLISH_MAX_LINES = 500;
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PublishBatch<L extends string = string> {
  sourceWorkspaceId: string;
  sessionId: string;
  events: L[];
}

export interface PublishAck {
  ok: true;
  accepted: number;
  inserted: number;
}

/** From the verified identity only, never from a request body. */
export interface PublishOwner {
  provider: string;
  id: number;
  login: string;
}

export class PublishArgError extends Error {}

const FIELDS = new Set(['sourceWorkspaceId', 'sessionId', 'events']);

export function parsePublishBody(v: unknown): PublishBatch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PublishArgError('body must be {sourceWorkspaceId, sessionId, events}');
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !FIELDS.has(k));
  if (extra !== undefined) throw new PublishArgError(`unknown field: ${extra.slice(0, 40)}`);
  if (typeof o.sourceWorkspaceId !== 'string' || !ULID_RE.test(o.sourceWorkspaceId)) throw new PublishArgError('sourceWorkspaceId must be a workspace id');
  if (typeof o.sessionId !== 'string' || !SESSION_UUID_RE.test(o.sessionId)) throw new PublishArgError('sessionId must be a lowercase session UUID');
  const events = o.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > PUBLISH_MAX_LINES) {
    throw new PublishArgError(`events must hold 1-${PUBLISH_MAX_LINES} lines`);
  }
  events.forEach((l, i) => {
    if (typeof l !== 'string' || !l || /[\r\n]/.test(l)) throw new PublishArgError(`events[${i}] must be one JSONL line`);
    let p: unknown;
    try {
      p = JSON.parse(l);
    } catch {
      throw new PublishArgError(`events[${i}] is not JSON`);
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PublishArgError(`events[${i}] must be a JSON object`);
  });
  return { sourceWorkspaceId: o.sourceWorkspaceId, sessionId: o.sessionId, events: events as string[] };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Keyed on the account id, not the login: logins can be renamed and reused. */
export function partitionIdFor(owner: Pick<PublishOwner, 'provider' | 'id'>, sourceWorkspaceId: string): string {
  return `pub_${sha(`${owner.provider}:${owner.id}\0${sourceWorkspaceId}`).slice(0, 32)}`;
}

/** Derived per partition, so no caller can name a session outside its own partition. */
export function publishedSessionId(partitionId: string, sourceSessionId: string): string {
  const h = sha(`${partitionId}\0${sourceSessionId}`);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/main/publish/scrub.test.ts src/main/publish/protocol.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/publish/scrub.ts src/main/publish/scrub.test.ts src/main/publish/protocol.ts src/main/publish/protocol.test.ts
git commit -m "feat(publish): shared transcript scrubber and publish wire protocol"
```

**Verification:**

| Where | What |
|---|---|
| Local | Everything; pure modules. |
| CI | The unit suite. |

---

### Task 3: Host publish store

**Files:**
- Create `src/host/publishStore.ts`.
- Create `src/host/publishStore.pg.test.ts`.
- Modify `vitest.pg.config.ts`: include it.

**Interfaces:**
- Consumes:
  - `ingestBatch(workspaceId, sessionId, lines, { atStart })` from `src/main/db.ts`;
  - `partitionIdFor`, `publishedSessionId`, `PublishOwner` (Task 2);
  - `ScrubbedLine` (Task 2);
  - host track v2 (Task 1).
- Produces:
  - `class PublishConflictError extends Error`
  - `const PUBLISH_STATEMENT_TIMEOUT = '5s'`
  - `interface PublishIngestResult { sessionId: string; partitionId: string; inserted: number }`
  - `interface PublishStore { ingest(owner: PublishOwner, sourceWorkspaceId: string, sourceSessionId: string, lines: readonly ScrubbedLine[]): Promise<PublishIngestResult>; partitionIds(): Promise<string[]> }`. Task 10 adds `unpublish`.
  - `publishStore(k: () => Kysely<StateDb>, o?: { ingest?: typeof ingestBatch; onIngested?: (sessionId: string) => void; now?: () => number }): PublishStore`

- [ ] **Step 1: Write the failing test**

`src/host/publishStore.pg.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import * as db from '../main/db.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, openTestState, type TestState } from '../main/store/testStore.js';
import { partitionIdFor, publishedSessionId, PUBLISH_MAX_LINES } from '../main/publish/protocol.js';
import { makeScrubber, type ScrubbedLine } from '../main/publish/scrub.js';
import { HOST_TRACK } from './hostSchema.js';
import { PublishConflictError, publishStore } from './publishStore.js';

const HOSTED = '01JC0000000000000000000000';
const SRC = '01JC0000000000000000000005';
const SID = '11111111-2222-4333-8444-555555555555';
const ANN = { provider: 'github', id: 7, login: 'ann' };
const BOB = { provider: 'github', id: 8, login: 'bob' };
const scrub = makeScrubber([]);
const turn = (uuid: string, type: string, content: string): ScrubbedLine =>
  scrub(JSON.stringify({ type, uuid, sessionId: SID, timestamp: '2026-11-05T00:00:00Z', message: { role: type, content } }));

it('one publish request is one ingest transaction', () => {
  expect(PUBLISH_MAX_LINES).toBe(db.INGEST_TX_LINES);
});

describe.skipIf(!isPg)('publishStore', () => {
  let st: TestState | null = null;
  afterEach(async () => { await st?.close(); st = null; });

  async function rig(o: Parameters<typeof publishStore>[1] = {}) {
    st = await openTestState('pub-');
    await migratePostgres(postgresKysely(st.pg!.pool), st.pg!.schema, HOST_TRACK);
    return publishStore(db.stateKysely, o);
  }

  it('files rows under the caller’s partition and a derived session id, idempotently', async () => {
    const bumped: string[] = [];
    const s = await rig({ onIngested: (id) => bumped.push(id) });
    const part = partitionIdFor(ANN, SRC);
    const r1 = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'hello'), turn('a1', 'assistant', 'hi')]);
    expect(r1).toEqual({ partitionId: part, sessionId: publishedSessionId(part, SID), inserted: 2 });
    const r2 = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'hello'), turn('a1', 'assistant', 'hi')]);
    expect(r2.inserted).toBe(0);
    expect(bumped).toEqual([r1.sessionId]);
    const k = db.stateKysely();
    expect(await k.selectFrom('events').select(['workspace_id', 'session_id']).distinct().execute())
      .toEqual([{ workspace_id: part, session_id: r1.sessionId }]);
    expect((await db.getSession(r1.sessionId))?.workspaceId).toBe(part);
    expect(await s.partitionIds()).toEqual([part]);
  });

  it('keeps two owners’ identical source session ids apart', async () => {
    const s = await rig();
    const a = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'ann')]);
    const b = await s.ingest(BOB, SRC, SID, [turn('u1', 'user', 'bob')]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.partitionId).not.toBe(b.partitionId);
    expect((await db.eventsForSession(a.sessionId)).map((e) => JSON.parse(e.rawJsonl).message.content)).toEqual(['ann']);
  });

  it('refreshes the display login, never the key', async () => {
    const s = await rig();
    await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')]);
    await s.ingest({ ...ANN, login: 'ann-renamed' }, SRC, SID, [turn('u2', 'user', 'y')]);
    const rows = (await st!.pg!.pool.query(`SELECT owner_id, owner_login FROM ${st!.pg!.schema}.publish_partitions`)).rows;
    expect(rows).toEqual([{ owner_id: '7', owner_login: 'ann-renamed' }]);
  });

  it('refuses a derived session id another workspace already holds, and writes nothing', async () => {
    const s = await rig();
    const id = publishedSessionId(partitionIdFor(ANN, SRC), SID);
    await db.stateKysely().insertInto('sessions').values({
      id, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 1, ai_title: null, first_user_message: null, user_set_name: null
    }).execute();
    await expect(s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')])).rejects.toThrow(PublishConflictError);
    expect(await db.eventsForSession(id)).toEqual([]);
    expect(await s.partitionIds()).toEqual([]);
  });

  it('runs the claim inside the ingest transaction, under a statement timeout', async () => {
    const seen: string[] = [];
    const s = await rig({
      ingest: async (_w: string, _s: string, _l: readonly string[], opts: Parameters<typeof db.ingestBatch>[3] = {}) => {
        await db.stateKysely().transaction().execute(async (trx) => {
          await opts.atStart!(trx);
          const r = await sql<{ t: string }>`SELECT current_setting('statement_timeout') AS t`.execute(trx);
          seen.push(r.rows[0].t);
        });
        return [];
      }
    });
    await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')]);
    expect(seen).toEqual(['5s']);
    expect(await s.partitionIds()).toEqual([partitionIdFor(ANN, SRC)]);
  });
});
```

Add `'src/host/publishStore.pg.test.ts',` to `vitest.pg.config.ts` `include`.

- [ ] **Step 2: Run the test and confirm it fails**

Run `PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/host/publishStore.pg.test.ts`.
Expected: FAIL. `./publishStore.js` doesn't exist.

- [ ] **Step 3: Implement**

`src/host/publishStore.ts`:

```ts
// Published transcripts on the holder's fenced state store (remote-workspaces §7). Rows go into the
// ordinary state tables under a partition derived from the verified caller (D97, D98).
import { sql, type Kysely, type Transaction } from 'kysely';
import { ingestBatch } from '../main/db.js';
import { partitionIdFor, publishedSessionId, type PublishOwner } from '../main/publish/protocol.js';
import type { ScrubbedLine } from '../main/publish/scrub.js';
import type { StateDb } from '../main/store/stateSchema.js';

export const PUBLISH_STATEMENT_TIMEOUT = '5s';

export class PublishConflictError extends Error {}

export interface PublishIngestResult {
  sessionId: string;
  partitionId: string;
  inserted: number;
}

export interface PublishStore {
  ingest(owner: PublishOwner, sourceWorkspaceId: string, sourceSessionId: string, lines: readonly ScrubbedLine[]): Promise<PublishIngestResult>;
  /** The host MCP's read scope beyond the hosted workspace. */
  partitionIds(): Promise<string[]>;
}

interface Claim {
  owner: PublishOwner;
  partitionId: string;
  sourceWorkspaceId: string;
  sessionId: string;
  sourceSessionId: string;
  at: number;
}

async function claim(trx: Transaction<StateDb>, c: Claim): Promise<void> {
  const held = await sql<{ w: string }>`SELECT workspace_id AS w FROM sessions WHERE id = ${c.sessionId}`.execute(trx);
  if (held.rows[0] && held.rows[0].w !== c.partitionId) throw new PublishConflictError('session id belongs to another workspace');
  await sql`INSERT INTO publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
    VALUES (${c.partitionId}, ${c.owner.provider}, ${String(c.owner.id)}, ${c.owner.login}, ${c.sourceWorkspaceId}, ${c.at})
    ON CONFLICT (partition_id) DO UPDATE SET owner_login = EXCLUDED.owner_login
    WHERE publish_partitions.owner_login IS DISTINCT FROM EXCLUDED.owner_login`.execute(trx);
  const p = await sql<{ owner_provider: string; owner_id: string; source_workspace_id: string }>`
    SELECT owner_provider, owner_id, source_workspace_id FROM publish_partitions WHERE partition_id = ${c.partitionId}`.execute(trx);
  const row = p.rows[0];
  if (!row || row.owner_provider !== c.owner.provider || row.owner_id !== String(c.owner.id) || row.source_workspace_id !== c.sourceWorkspaceId) {
    throw new PublishConflictError('partition belongs to another owner');
  }
  await sql`INSERT INTO publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
    VALUES (${c.sessionId}, ${c.partitionId}, ${c.sourceSessionId}, ${c.at}, ${c.at})
    ON CONFLICT (session_id) DO UPDATE SET last_published_at = EXCLUDED.last_published_at`.execute(trx);
}

export function publishStore(
  k: () => Kysely<StateDb>,
  o: { ingest?: typeof ingestBatch; onIngested?: (sessionId: string) => void; now?: () => number } = {}
): PublishStore {
  const ingest = o.ingest ?? ingestBatch;
  const now = o.now ?? Date.now;
  return {
    async ingest(owner, sourceWorkspaceId, sourceSessionId, lines) {
      const partitionId = partitionIdFor(owner, sourceWorkspaceId);
      const sessionId = publishedSessionId(partitionId, sourceSessionId);
      const at = now();
      const results = await ingest(partitionId, sessionId, lines, {
        atStart: async (trx) => {
          await sql`SET LOCAL statement_timeout = ${sql.lit(PUBLISH_STATEMENT_TIMEOUT)}`.execute(trx);
          await claim(trx, { owner, partitionId, sourceWorkspaceId, sessionId, sourceSessionId, at });
        }
      });
      const inserted = results.filter((r) => r.inserted).length;
      if (inserted > 0) o.onIngested?.(sessionId);
      return { sessionId, partitionId, inserted };
    },
    async partitionIds() {
      const r = await sql<{ partition_id: string }>`SELECT partition_id FROM publish_partitions ORDER BY partition_id`.execute(k());
      return r.rows.map((x) => x.partition_id);
    }
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run `PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/host/publishStore.pg.test.ts`.
Expected: PASS.

Run `npx vitest run src/host/publishStore.pg.test.ts`.
Expected: the `INGEST_TX_LINES` check passes; the Postgres block is skipped.

- [ ] **Step 5: Commit**

```bash
git add src/host/publishStore.ts src/host/publishStore.pg.test.ts vitest.pg.config.ts
git commit -m "feat(host): publish store files published rows under derived partitions"
```

**Verification:**

| Where | What |
|---|---|
| Local | The Postgres suite via `scripts/pg-test-server.sh`. |
| CI | The Postgres job. |

---

### Task 4: Host `/publish` route — admission, server scrub, server routing

**Files:**
- Create `src/host/publishRoute.ts` and `src/host/publishRoute.test.ts`.
- Modify `src/host/server.ts`.
- Modify `src/host/server.test.ts`: add a `describe('POST /publish')`.
- Modify `src/host/testHost.ts`: add the `publish?` option.

**Interfaces:**
- Consumes:
  - `PublishStore`, `PublishConflictError` (Task 3);
  - `parsePublishBody`, `PublishArgError`, `PublishOwner`, `PUBLISH_MAX_BODY` (Task 2);
  - `makeScrubber`, `ScrubValue` (Task 2);
  - `ownerKey`, `Principal` (`attachHub.ts`);
  - `LeaseLostError` (`pgLease.ts`).
- Produces:
  - `PUBLISH_BURST = 20`, `PUBLISH_PER_SEC = 2`, `PUBLISH_MAX_IN_FLIGHT = 4`
  - `type Admission = { ok: true; release(): void } | { ok: false; status: 403 | 429 | 503; error: string; retryAfterSec?: number }`
  - `interface RouteReply { status: number; body: unknown; headers?: OutgoingHttpHeaders }`
  - `interface PublishRoute { admit(caller: Principal): Admission; post(caller: Principal, body: unknown): Promise<RouteReply> }`. Task 10 adds `remove`.
  - `class PublishGate { constructor(o?: { burst?: number; perSec?: number; maxInFlight?: number; now?: () => number }); admit(key: string): Admission }`
  - `hostSecretValues(env: NodeJS.ProcessEnv, alsoNames?: readonly string[]): ScrubValue[]`
  - `ownerOf(caller: Principal): PublishOwner`
  - `createPublishRoute(o: { store: () => PublishStore | null; hostSecrets: readonly ScrubValue[]; log: Logger; gate?: PublishGate }): PublishRoute`
  - from `server.ts`: `MAX_PUBLISH_BODY` and `HostServerDeps.publish?: PublishRoute`
  - from `testHost.ts`: `startTestHost({ …, publish?: PublishRoute })`

- [ ] **Step 1: Write the failing tests**

`src/host/publishRoute.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Principal } from './attachHub.js';
import { createLogger } from './log.js';
import { LeaseLostError } from './pgLease.js';
import { createPublishRoute, hostSecretValues, PublishGate } from './publishRoute.js';
import { PublishConflictError, type PublishStore } from './publishStore.js';
import { person } from './testFakes.js';

const SRC = '01JC0000000000000000000005';
const SID = '11111111-2222-4333-8444-555555555555';
const ann: Principal = { identity: person('ann', 7), tier: 'read' };
const bot: Principal = {
  identity: { provider: 'github', kind: 'machine', login: 'ci[bot]', id: 99, name: null, avatarUrl: null, teams: [], appId: 5 },
  tier: 'read'
};
const body = (events: string[], extra: Record<string, unknown> = {}) => ({ sourceWorkspaceId: SRC, sessionId: SID, events, ...extra });
const quiet = createLogger(() => undefined);

function fakeStore(fail?: unknown) {
  const calls: Array<{ owner: unknown; src: string; sid: string; lines: string[] }> = [];
  const store: PublishStore = {
    ingest: async (owner, src, sid, lines) => {
      if (fail) throw fail;
      calls.push({ owner, src, sid, lines: [...lines] });
      return { sessionId: 'stored', partitionId: 'pub_x', inserted: lines.length };
    },
    partitionIds: async () => []
  };
  return { store, calls };
}

describe('createPublishRoute', () => {
  it('derives the owner from the verified identity and refuses any other body key', async () => {
    const f = fakeStore();
    const r = createPublishRoute({ store: () => f.store, hostSecrets: [], log: quiet });
    expect(await r.post(ann, body(['{"type":"user"}'], { ownerLogin: 'bob' }))).toEqual({ status: 400, body: { ok: false, error: 'unknown field: ownerLogin' } });
    expect(await r.post(ann, body(['{"type":"user"}']))).toEqual({ status: 200, body: { ok: true, accepted: 1, inserted: 1 } });
    expect(f.calls).toEqual([{ owner: { provider: 'github', id: 7, login: 'ann' }, src: SRC, sid: SID, lines: ['{"type":"user"}'] }]);
  });

  it('repeats the pattern scrub and scrubs the host’s own secret values before storing', async () => {
    const f = fakeStore();
    const r = createPublishRoute({ store: () => f.store, hostSecrets: [{ key: 'FLEET_DB_PASSWORD', value: 'host-secret-123' }], log: quiet });
    const line = JSON.stringify({ type: 'user', message: { content: `ghp_${'A'.repeat(36)} and host-secret-123` } });
    await r.post(ann, body([line]));
    const stored = f.calls[0].lines[0];
    expect(stored).not.toContain('ghp_');
    expect(stored).not.toContain('host-secret-123');
    expect(JSON.parse(stored).message.content).toBe('[redacted] and [redacted:FLEET_DB_PASSWORD]');
  });

  it('answers 503 with no holder, 409 on a session conflict, 503 standby when fenced off, 503 on a statement timeout', async () => {
    const line = '{"type":"user"}';
    expect((await createPublishRoute({ store: () => null, hostSecrets: [], log: quiet }).post(ann, body([line]))).status).toBe(503);
    const conflict = createPublishRoute({ store: () => fakeStore(new PublishConflictError('session id belongs to another workspace')).store, hostSecrets: [], log: quiet });
    expect(await conflict.post(ann, body([line]))).toEqual({ status: 409, body: { ok: false, error: 'session id belongs to another workspace' } });
    const fenced = createPublishRoute({ store: () => fakeStore(new LeaseLostError('superseded')).store, hostSecrets: [], log: quiet });
    expect(await fenced.post(ann, body([line]))).toMatchObject({ status: 503, body: { ok: false, error: 'standby' } });
    const slow = createPublishRoute({ store: () => fakeStore(Object.assign(new Error('canceling statement'), { code: '57014' })).store, hostSecrets: [], log: quiet });
    expect(await slow.post(ann, body([line]))).toMatchObject({ status: 503, body: { ok: false, error: 'publish busy' } });
  });

  it('logs the request without its content', async () => {
    const lines: string[] = [];
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: createLogger((l) => lines.push(l)) });
    await r.post(ann, body([JSON.stringify({ type: 'user', message: { content: 'private words' } })]));
    expect(lines.join('\n')).not.toContain('private words');
    expect(JSON.parse(lines[0])).toMatchObject({ msg: 'publish', login: 'ann', sourceWorkspaceId: SRC, sessionId: SID, lines: 1, inserted: 1 });
  });

  it('refuses machine identities at admission', () => {
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: quiet });
    expect(r.admit(bot)).toEqual({ ok: false, status: 403, error: 'publishing is for people, not machine identities' });
    expect(r.admit(ann).ok).toBe(true);
  });
});

describe('PublishGate', () => {
  it('allows one request in flight per identity', () => {
    const g = new PublishGate();
    const a = g.admit('github:7');
    expect(a.ok).toBe(true);
    expect(g.admit('github:7')).toEqual({ ok: false, status: 429, error: 'a publish from you is already in flight', retryAfterSec: 1 });
    expect(g.admit('github:8').ok).toBe(true);
    if (a.ok) a.release();
    expect(g.admit('github:7').ok).toBe(true);
  });

  it('caps host-wide concurrency', () => {
    const g = new PublishGate({ maxInFlight: 2 });
    expect(g.admit('a').ok).toBe(true);
    expect(g.admit('b').ok).toBe(true);
    expect(g.admit('c')).toEqual({ ok: false, status: 503, error: 'publish busy', retryAfterSec: 1 });
  });

  it('rate-limits each identity with a token bucket', () => {
    let t = 0;
    const g = new PublishGate({ burst: 2, perSec: 1, now: () => t });
    for (let i = 0; i < 2; i++) {
      const a = g.admit('k');
      expect(a.ok).toBe(true);
      if (a.ok) a.release();
    }
    expect(g.admit('k')).toEqual({ ok: false, status: 429, error: 'publishing too fast', retryAfterSec: 1 });
    t = 1_000;
    expect(g.admit('k').ok).toBe(true);
  });

  it('release is idempotent', () => {
    const g = new PublishGate({ maxInFlight: 1 });
    const a = g.admit('a');
    if (a.ok) { a.release(); a.release(); }
    expect(g.admit('b').ok).toBe(true);
    expect(g.admit('c').ok).toBe(false);
  });
});

describe('hostSecretValues', () => {
  it('takes secret-named env vars, the store’s named vars and connection-string passwords', () => {
    expect(hostSecretValues(
      { AWS_SECRET_ACCESS_KEY: 'k1k1k1k1', HOME: '/home/fleet', FLEET_PG: 'postgres://u:p%40ssword@h/db', PATH: '/bin', EMPTY_TOKEN: '' },
      ['FLEET_PG']
    )).toEqual([
      { key: 'AWS_SECRET_ACCESS_KEY', value: 'k1k1k1k1' },
      { key: 'FLEET_PG', value: 'postgres://u:p%40ssword@h/db' },
      { key: 'FLEET_PG', value: 'p@ssword' }
    ]);
  });
});
```

In `src/host/server.test.ts`:
- add `MAX_PUBLISH_BODY` to the `./server.js` import list;
- add `import type { PublishRoute } from './publishRoute.js';`;
- add at the end of the file:

```ts
describe('POST /publish', () => {
  function route(over: Partial<PublishRoute> = {}): PublishRoute & { posted: unknown[] } {
    const posted: unknown[] = [];
    return {
      posted,
      admit: () => ({ ok: true, release: () => undefined }),
      post: async (c, b) => {
        posted.push([c.identity.login, b]);
        return { status: 200, body: { ok: true, accepted: 1, inserted: 1 } };
      },
      ...over
    };
  }
  const post = (r: Rig, body: string, token?: string, type = 'application/json') =>
    fetch(`${r.url}/publish`, { method: 'POST', headers: { 'Content-Type': type, ...(token ? bearer(token) : {}) }, body });

  it('does not exist without a publish route', async () => {
    const r = await start();
    expect((await post(r, '{}', `${TOKEN}r`)).status).toBe(404);
  });

  it('needs a bearer token and any grant; read is enough', async () => {
    const p = route();
    const r = await start([], { publish: p });
    expect((await post(r, '{}')).status).toBe(401);
    expect((await post(r, '{}', `${TOKEN}n`)).status).toBe(403);
    expect((await post(r, '{"a":1}', `${TOKEN}r`)).status).toBe(200);
    expect(p.posted).toEqual([['reader', { a: 1 }]]);
  });

  it('takes only POST with a JSON body of at most 1 MiB', async () => {
    const r = await start([], { publish: route() });
    expect(MAX_PUBLISH_BODY).toBe(1024 * 1024);
    expect((await fetch(`${r.url}/publish`, { headers: bearer(`${TOKEN}r`) })).status).toBe(405);
    expect((await post(r, '{}', `${TOKEN}r`, 'text/plain')).status).toBe(415);
    expect((await post(r, JSON.stringify({ a: 'x'.repeat(MAX_PUBLISH_BODY) }), `${TOKEN}r`)).status).toBe(413);
    expect((await post(r, '{', `${TOKEN}r`)).status).toBe(400);
  });

  it('answers an admission refusal with its status and Retry-After, without calling the handler', async () => {
    const handler = vi.fn();
    const r = await start([], { publish: route({ admit: () => ({ ok: false, status: 429, error: 'publishing too fast', retryAfterSec: 3 }), post: handler }) });
    const res = await post(r, '{}', `${TOKEN}r`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(handler).not.toHaveBeenCalled();
  });

  it('releases the admission when the handler throws', async () => {
    const release = vi.fn();
    const r = await start([], { publish: route({ admit: () => ({ ok: true, release }), post: async () => { throw new Error('boom'); } }) });
    expect((await post(r, '{}', `${TOKEN}r`)).status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a standby refuses publish like every authenticated route', async () => {
    const r = await start([], { publish: route() });
    r.setLease('standby');
    expect((await post(r, '{}', `${TOKEN}x`)).status).toBe(503);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/host/publishRoute.test.ts src/host/server.test.ts`.
Expected: FAIL. `publishRoute.js` is missing, `MAX_PUBLISH_BODY` isn't exported, and `/publish` answers 404.

- [ ] **Step 3: Implement**

`src/host/publishRoute.ts`:

```ts
// POST /publish (remote-workspaces §6, §7): admission before the body is read, the server-side
// scrub, then the holder's publish store. The owner comes only from the verified identity.
import type { OutgoingHttpHeaders } from 'node:http';
import { parsePublishBody, PublishArgError, type PublishOwner } from '../main/publish/protocol.js';
import { makeScrubber, type ScrubValue } from '../main/publish/scrub.js';
import { ownerKey, type Principal } from './attachHub.js';
import type { Logger } from './log.js';
import { LeaseLostError } from './pgLease.js';
import { PublishConflictError, type PublishStore } from './publishStore.js';

export const PUBLISH_BURST = 20;
export const PUBLISH_PER_SEC = 2;
export const PUBLISH_MAX_IN_FLIGHT = 4;
const MAX_TRACKED = 10_000;

export type Admission =
  | { ok: true; release(): void }
  | { ok: false; status: 403 | 429 | 503; error: string; retryAfterSec?: number };

export interface RouteReply {
  status: number;
  body: unknown;
  headers?: OutgoingHttpHeaders;
}

export interface PublishRoute {
  admit(caller: Principal): Admission;
  post(caller: Principal, body: unknown): Promise<RouteReply>;
}

/** Per identity: one in flight and a token bucket; host-wide: a cap on in-flight publishes. */
export class PublishGate {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly busy = new Set<string>();
  private inFlight = 0;

  constructor(private readonly o: { burst?: number; perSec?: number; maxInFlight?: number; now?: () => number } = {}) {}

  admit(key: string): Admission {
    if (this.busy.has(key)) return { ok: false, status: 429, error: 'a publish from you is already in flight', retryAfterSec: 1 };
    if (this.inFlight >= (this.o.maxInFlight ?? PUBLISH_MAX_IN_FLIGHT)) return { ok: false, status: 503, error: 'publish busy', retryAfterSec: 1 };
    const now = (this.o.now ?? Date.now)();
    const burst = this.o.burst ?? PUBLISH_BURST;
    const rate = this.o.perSec ?? PUBLISH_PER_SEC;
    const prev = this.buckets.get(key) ?? { tokens: burst, at: now };
    const tokens = Math.min(burst, prev.tokens + ((now - prev.at) / 1000) * rate);
    this.buckets.delete(key);
    if (this.buckets.size >= MAX_TRACKED) this.buckets.delete(this.buckets.keys().next().value as string);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return { ok: false, status: 429, error: 'publishing too fast', retryAfterSec: Math.ceil((1 - tokens) / rate) };
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    this.busy.add(key);
    this.inFlight++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.busy.delete(key);
        this.inFlight--;
      }
    };
  }
}

const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

function connectionPassword(v: string): string | null {
  if (!/^postgres(?:ql)?:\/\//i.test(v)) return null;
  try {
    return decodeURIComponent(new URL(v).password) || null;
  } catch {
    return null;
  }
}

/** fleet-host's own secrets, scrubbed from published lines on top of the patterns (D103). */
export function hostSecretValues(env: NodeJS.ProcessEnv, alsoNames: readonly string[] = []): ScrubValue[] {
  const named = new Set(alsoNames);
  const out: ScrubValue[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || (!SECRET_NAME.test(key) && !named.has(key))) continue;
    out.push({ key, value });
    const pw = connectionPassword(value);
    if (pw) out.push({ key, value: pw });
  }
  return out;
}

export function ownerOf(caller: Principal): PublishOwner {
  return { provider: caller.identity.provider, id: caller.identity.id, login: caller.identity.login };
}

export function failureReply(err: unknown): RouteReply {
  if (err instanceof PublishConflictError) return { status: 409, body: { ok: false, error: err.message } };
  if (err instanceof LeaseLostError) return { status: 503, body: { ok: false, error: 'standby' }, headers: { 'Retry-After': '5' } };
  if ((err as { code?: unknown } | null)?.code === '57014') return { status: 503, body: { ok: false, error: 'publish busy' }, headers: { 'Retry-After': '1' } };
  throw err;
}

export function createPublishRoute(o: { store: () => PublishStore | null; hostSecrets: readonly ScrubValue[]; log: Logger; gate?: PublishGate }): PublishRoute {
  const gate = o.gate ?? new PublishGate();
  const scrub = makeScrubber(o.hostSecrets);
  return {
    admit(caller) {
      if (caller.identity.kind !== 'user') return { ok: false, status: 403, error: 'publishing is for people, not machine identities' };
      return gate.admit(ownerKey(caller.identity));
    },
    async post(caller, body) {
      let req;
      try {
        req = parsePublishBody(body);
      } catch (err) {
        if (err instanceof PublishArgError) return { status: 400, body: { ok: false, error: err.message } };
        throw err;
      }
      const store = o.store();
      if (!store) return { status: 503, body: { ok: false, error: 'publish unavailable' }, headers: { 'Retry-After': '5' } };
      try {
        const r = await store.ingest(ownerOf(caller), req.sourceWorkspaceId, req.sessionId, req.events.map(scrub));
        o.log.log('info', 'publish', {
          login: caller.identity.login, sourceWorkspaceId: req.sourceWorkspaceId, sessionId: req.sessionId, lines: req.events.length, inserted: r.inserted
        });
        return { status: 200, body: { ok: true, accepted: req.events.length, inserted: r.inserted } };
      } catch (err) {
        return failureReply(err);
      }
    }
  };
}
```

`src/host/server.ts`:

1. Imports. Add:

```ts
import { PUBLISH_MAX_BODY } from '../main/publish/protocol.js';
import type { PublishRoute } from './publishRoute.js';
```

2. After `export const MAX_RPC_PER_IDENTITY = 8;`:

```ts
export const MAX_PUBLISH_BODY = PUBLISH_MAX_BODY;
```

3. In `HostServerDeps`, after `rpc: RpcRegistry;`:

```ts
  /** Absent: no host store, so `/publish` doesn't exist. */
  publish?: PublishRoute;
```

4. Replace `readBody` with a version that takes a limit:

```ts
// Pauses at the limit: breaking a for-await would destroy the socket before the 413 is sent.
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        resolve(null);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
```

5. In `handleRpc`, change `const raw = await readBody(req);` to `const raw = await readBody(req, MAX_RPC_BODY);`.

6. In `handle()`, replace the block from `const isRpc = path.startsWith('/rpc/');` through the method check with:

```ts
    const isRpc = path.startsWith('/rpc/');
    const isPublish = !!deps.publish && path === '/publish';
    if (path !== '/whoami' && !isRpc && !isPublish && path !== '/attach' && path !== '/events') {
      sendJson(res, 404, { error: 'not found' });
      return null;
    }
    if (req.method !== (isRpc || isPublish ? 'POST' : 'GET')) {
      sendJson(res, 405, { error: 'method not allowed' });
      return null;
    }
```

7. In `handle()`, change the post-auth dispatch:

```ts
    if (path === '/attach' || path === '/events') {
      sendJson(res, 426, { error: 'WebSocket upgrade required' });
    } else if (isPublish) {
      await handlePublish(req, res, auth);
    } else if (path === '/whoami') {
```

   The rest is unchanged.

8. Add after `handleRpc`:

```ts
  async function handlePublish(req: IncomingMessage, res: ServerResponse, caller: Principal): Promise<void> {
    const route = deps.publish as PublishRoute;
    const adm = route.admit(caller);
    if (!adm.ok) {
      // The body wasn't read: don't let it be parsed as the next request on this connection.
      res.setHeader('Connection', 'close');
      return sendJson(res, adm.status, { ok: false, error: adm.error }, adm.retryAfterSec !== undefined ? { 'Retry-After': String(adm.retryAfterSec) } : {});
    }
    try {
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
      }
      const raw = await readBody(req, MAX_PUBLISH_BODY);
      if (!raw) {
        res.setHeader('Connection', 'close');
        return sendJson(res, 413, { ok: false, error: 'body too large' });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'body is not JSON' });
      }
      const r = await route.post(caller, body);
      sendJson(res, r.status, r.body, r.headers);
    } finally {
      adm.release();
    }
  }
```

`src/host/testHost.ts`:
- add `import type { PublishRoute } from './publishRoute.js';`;
- change the options type to `{ tokens: Record<string, Identity>; grants: GrantRule[]; sessions?: string[]; pingMs?: number; publish?: PublishRoute }`;
- add `publish: opts.publish,` to the `createHostServer({…})` call after `rpc:`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/host/publishRoute.test.ts src/host/server.test.ts`.
Expected: PASS, including the existing rpc-limit tests.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/host/publishRoute.ts src/host/publishRoute.test.ts src/host/server.ts src/host/server.test.ts src/host/testHost.ts
git commit -m "feat(host): POST /publish with admission, server-side scrub and identity-derived owner"
```

**Verification:**

| Where | What |
|---|---|
| Local | Everything (HTTP on loopback). |
| CI | The unit suite. |
| Cluster | A 1 MiB `POST /publish` passes the ALB, the gateway and the sidecar. A 413 means a proxy body limit to raise. |

---

### Task 5: Holder and main wiring, embedding of published rows

**Files:**
- Modify `src/host/holder.ts`.
- Modify `src/host/main.ts`.
- Modify `src/host/publishStore.pg.test.ts`: indexer coverage.
- Modify `src/host/main.pg.test.ts`: end to end.

**Interfaces:**
- Consumes:
  - `publishStore` (Task 3);
  - `createPublishRoute`, `hostSecretValues` (Task 4);
  - `storeSecretEnvNames(cfg)` from `src/main/store/storeConfig.ts`;
  - `startHostIndexer` (`hostIndexer.ts`).
- Produces: `Holder.publish: PublishStore`, and the main server's `publish` dependency.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe.skipIf(!isPg)('publishStore', …)` block of `src/host/publishStore.pg.test.ts`:

```ts
  it('published turns are embedded under the partition, live and by backfill', async () => {
    const unit = (): Float32Array => new Float32Array(EMBED_DIM).fill(1 / Math.sqrt(EMBED_DIM));
    const log = createLogger(() => undefined);
    const ix = startHostIndexer({ embed: async (t) => t.map(unit), log });
    const s = await rig({ onIngested: (id) => ix.bump(id) });
    const live = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'published words')]);
    const k = db.stateKysely();
    const embedded = (id: string) => k.selectFrom('embeddings').select(['workspace_id', 'text']).where('session_id', '=', id).execute();
    await vi.waitFor(async () => expect(await embedded(live.sessionId)).toEqual([{ workspace_id: live.partitionId, text: 'published words' }]));
    await ix.stop(5_000);
    const later = await publishStore(db.stateKysely).ingest(BOB, SRC, SID, [turn('u9', 'user', 'backfilled words')]);
    const again = startHostIndexer({ embed: async (t) => t.map(unit), log });
    await again.backfill();
    await vi.waitFor(async () => expect(await embedded(later.sessionId)).toEqual([{ workspace_id: later.partitionId, text: 'backfilled words' }]));
    await again.stop(5_000);
  });
```

with these imports added at the top:

```ts
import { EMBED_DIM } from '../main/vectors.js';
import { startHostIndexer } from './hostIndexer.js';
import { createLogger } from './log.js';
```

In `src/host/main.pg.test.ts`:
- add the import `import { partitionIdFor, publishedSessionId } from '../main/publish/protocol.js';`;
- add after the `'history RPC reads only the hosted workspace…'` test:

```ts
  it('POST /publish lands under the caller’s partition, scrubbed, idempotent, and stays out of history', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const SRC = '01JC0000000000000000000005';
    const SID = '11111111-2222-4333-8444-555555555555';
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
    const publish = async (events: string[]) => {
      const res = await fetch(`${a.url}/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ sourceWorkspaceId: SRC, sessionId: SID, events }) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const line = JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: `token ghp_${'A'.repeat(36)}` } });
    // 503 until the holder's publish store is up.
    await vi.waitFor(async () => expect((await publish([line])).status).toBe(200), { timeout: 10_000 });
    const part = partitionIdFor({ provider: 'github', id: 1 }, SRC);
    const sid = publishedSessionId(part, SID);
    const rows = (await t!.pool.query(`SELECT workspace_id, raw_jsonl FROM ${t!.schema}.events WHERE session_id = $1`, [sid])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(part);
    expect(rows[0].raw_jsonl).not.toContain('ghp_');
    expect(await publish([line])).toEqual({ status: 200, body: { ok: true, accepted: 1, inserted: 0 } });
    const hist = await fetch(`${a.url}/rpc/history:sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ args: [{}] }) });
    expect(((await hist.json()) as { result: { rows: unknown[] } }).result.rows).toEqual([]);
  }, 30_000);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/host/publishStore.pg.test.ts src/host/main.pg.test.ts`.
Expected:
- The indexer test passes already, because the indexer is workspace-agnostic. It stays as a regression guard.
- The main test fails with 404 on `/publish`.

- [ ] **Step 3: Implement**

`src/host/holder.ts`:
- add the import `import { publishStore, type PublishStore } from './publishStore.js';`;
- add `publish: PublishStore;` to `Holder` after `history: HistoryReader;`;
- after the `const hint = trailingHint(…)` line, add:

```ts
  const publish = publishStore(stateKysely, { onIngested: (id) => indexer?.bump(id) });
```

- in the returned object, after `history: historyReader(stateKysely, o.workspaceId),`, add `publish,`.

`src/host/main.ts`:
- add the imports:

```ts
import { storeSecretEnvNames } from '../main/store/storeConfig.js';
import { createPublishRoute, hostSecretValues } from './publishRoute.js';
```

- in `createHostServer({…})`, after the `rpc:` entry:

```ts
    publish: config.db
      ? createPublishRoute({ store: () => holderNow?.publish ?? null, hostSecrets: hostSecretValues(procEnv, storeSecretEnvNames(config.db)), log })
      : undefined,
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/host/publishStore.pg.test.ts src/host/main.pg.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

Run `npx vitest run src/host/importGraph.test.ts`.
Expected: PASS. No Electron reaches the host bundle.

- [ ] **Step 5: Commit**

```bash
git add src/host/holder.ts src/host/main.ts src/host/publishStore.pg.test.ts src/host/main.pg.test.ts
git commit -m "feat(host): holder serves /publish and indexes published sessions"
```

**Verification:**

| Where | What |
|---|---|
| Local | The Postgres suite. |
| CI | The Postgres job, including `main.pg.test.ts`. |
| Cluster | After rollout, publish one session from a desktop, then check `SELECT count(*) FROM fleet.events WHERE workspace_id LIKE 'pub\_%'` grows and its embeddings appear. |

---

### Task 6: Host MCP sees partitions; `mark_useful` with `origin`

**Files:**
- Modify `src/main/mcpCore.ts`: `setUsageRecorder` signature.
- Modify `src/main/db.ts`: `recordUsageEvent` origin, `usefulMarkCounts`.
- Modify `src/host/hostMcp.ts`.
- Modify `src/host/holder.ts`: `mcpServer` gets the publish store.
- Modify `src/host/hostMcp.test.ts`, `src/host/hostQuery.pg.test.ts`, `src/host/publishStore.pg.test.ts`.
- Create `src/main/dbUsefulMarks.test.ts`.
- Modify `vitest.pg.config.ts`: include `dbUsefulMarks.test.ts`.

**Interfaces:**
- Consumes:
  - `PublishStore.partitionIds()` (Task 3);
  - `getSession(id)` from `src/main/db.ts`.
- Produces:
  - `setUsageRecorder(fn: UsageRecorder | null): void`
  - `recordUsageEvent(e: { workspaceId; sessionId?; kind; detail?; origin?: string | null })`
  - `usefulMarkCounts(sessionIds: readonly string[]): Promise<Map<string, number>>`
  - `startHostMcp` options `scope?: () => Promise<readonly string[]>` and `recordUsage?: UsageRecorder`
  - `hostUsageRecorder: UsageRecorder`
  - `HOST_MCP_TOOLS` with 15 tools, adding `mark_useful`; `hostMcpTools(true)` with 16

- [ ] **Step 1: Write the failing tests**

`src/main/dbUsefulMarks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as db from './db.js';
import { openTestState } from './store/testStore.js';

describe('usefulMarkCounts', () => {
  it('counts marked-useful only where the origin is another workspace', async () => {
    await openTestState('useful-');
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'pub1', kind: 'marked-useful', origin: 'pub_a' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'pub1', kind: 'marked-useful', origin: 'pub_a' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'own1', kind: 'marked-useful', origin: 'H' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'old1', kind: 'marked-useful' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'pub1', kind: 'clickthrough', origin: 'pub_a' });
    expect(await db.usefulMarkCounts(['pub1', 'own1', 'old1', 'none'])).toEqual(new Map([['pub1', 2]]));
    expect(await db.usefulMarkCounts([])).toEqual(new Map());
  });
});
```

Add `'src/main/dbUsefulMarks.test.ts',` to `vitest.pg.config.ts`.

In `src/host/hostMcp.test.ts`, update the tool-count tests:
- `expect(HOST_MCP_TOOLS.size).toBe(14)` → `15`;
- `expect(hostMcpTools(true).size).toBe(15)` → `16`;
- `expect(names(list)).toHaveLength(14)` → `15`;
- add `expect(HOST_MCP_TOOLS.has('mark_useful')).toBe(true);` in `'serves query; search_transcripts only with an embedder'`.

Then append:

```ts
describe('published partitions on the host MCP', () => {
  it('reads the hosted workspace plus every partition, resolved on each call', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    let parts = ['pub_a'];
    mcp = await startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), scope: async () => parts });
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
    await rpc(socketPath, [call(1)]);
    parts = ['pub_a', 'pub_b'];
    await rpc(socketPath, [call(2)]);
    expect(scopes).toEqual([[WS, 'pub_a'], [WS, 'pub_a', 'pub_b']]);
  });

  it('serves mark_useful through the holder’s recorder, for a session in scope only', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    const recorded: unknown[] = [];
    const withSession = { ...rs, sessionWorkspace: async (_scope: ReadonlySet<string>, id: string) => (id === 'p1' ? 'pub_a' : null) } as unknown as OwnedReadSource;
    mcp = await startHostMcp({
      listen: { path: socketPath }, workspaceId: WS, readSource: withSession, log: createLogger(() => undefined),
      scope: async () => ['pub_a'], recordUsage: async (e) => void recorded.push(e)
    });
    const mark = (id: number, sessionId: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'mark_useful', arguments: { sessionId } } });
    const [ok, missing] = await rpc(socketPath, [mark(1, 'p1'), mark(2, 'nope')]).then((ms) => [1, 2].map((id) => ms.find((m) => m.id === id)!));
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ ok: true });
    expect(missing.result.isError).toBe(true);
    expect(recorded).toEqual([{ workspaceId: WS, sessionId: 'p1', kind: 'marked-useful', detail: undefined }]);
  });
});
```

In `src/host/hostQuery.pg.test.ts`:
- add the imports:

```ts
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { HOST_TRACK } from './hostSchema.js';
```

- change `serve`'s signature and its `startHostMcp` call:

```ts
  async function serve(role: string, password: () => Promise<string>, logs: string[] = [], scope?: () => Promise<readonly string[]>): Promise<string> {
```

```ts
    mcp = await startHostMcp({ listen: { path: socketPath }, workspaceId: HOSTED, readSource: rs, log: createLogger(() => undefined), scope });
```

- append inside the describe:

```ts
  it('query sees published partitions too, and never the publish bookkeeping tables', async () => {
    const { queryUser, pw } = await rig();
    await migratePostgres(postgresKysely(t!.appPool), t!.schema, HOST_TRACK);
    await stateKysely().insertInto('sessions').values({
      id: 'p1', workspace_id: 'pub_aaaa', cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'published', user_set_name: null
    }).execute();
    const sock = await serve(queryUser, async () => pw, [], async () => ['pub_aaaa']);
    expect(rowsOf(await query(sock, 'SELECT id FROM sessions ORDER BY id'))).toEqual([{ id: 'h1' }, { id: 'p1' }]);
    expect(rowsOf(await query(sock, `SELECT count(*)::int AS n FROM sessions WHERE workspace_id = '${OTHER}'`))).toEqual([{ n: 0 }]);
    for (const table of ['publish_partitions', 'publish_sessions']) {
      const r = await query(sock, `SELECT * FROM ${table}`);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/permission denied/);
    }
  });
```

In `src/host/publishStore.pg.test.ts`:
- add the import `import { hostUsageRecorder } from './hostMcp.js';`;
- append inside the Postgres describe:

```ts
  it('hostUsageRecorder stamps the session’s workspace as origin; only marks on published sessions count', async () => {
    const s = await rig();
    const pub = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')]);
    await db.stateKysely().insertInto('sessions').values({
      id: 'own-1', workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 1, ai_title: null, first_user_message: null, user_set_name: null
    }).execute();
    await hostUsageRecorder({ workspaceId: HOSTED, sessionId: pub.sessionId, kind: 'marked-useful' });
    await hostUsageRecorder({ workspaceId: HOSTED, sessionId: 'own-1', kind: 'marked-useful' });
    const origins = await db.stateKysely().selectFrom('usage_events').select(['session_id', 'origin']).orderBy('id').execute();
    expect(origins).toEqual([{ session_id: pub.sessionId, origin: pub.partitionId }, { session_id: 'own-1', origin: HOSTED }]);
    expect(await db.usefulMarkCounts([pub.sessionId, 'own-1'])).toEqual(new Map([[pub.sessionId, 1]]));
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/dbUsefulMarks.test.ts src/host/hostMcp.test.ts`.
Expected: FAIL. `usefulMarkCounts` is undefined, the tool count is still 14, and `scope` is ignored.

- [ ] **Step 3: Implement**

`src/main/mcpCore.ts`: change

```ts
export function setUsageRecorder(fn: UsageRecorder): void {
```

to

```ts
export function setUsageRecorder(fn: UsageRecorder | null): void {
```

`src/main/db.ts`, change `recordUsageEvent` to:

```ts
/** Append-only value signal (#207). Scores are derived at read time (Phase 3). */
export async function recordUsageEvent(e: {
  workspaceId: string;
  sessionId?: string | null;
  kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed';
  detail?: Record<string, unknown>;
  origin?: string | null;
}): Promise<void> {
  await kyselyOrThrow()
    .insertInto('usage_events')
    .values({
      ts: Date.now(),
      workspace_id: e.workspaceId,
      session_id: e.sessionId ?? null,
      kind: e.kind,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      origin: e.origin ?? null,
    })
    .execute();
}

/** marked-useful marks that count (SPEC §7 *Usefulness signals*): not a workspace marking its own session, and not one of unknown origin. */
export async function usefulMarkCounts(sessionIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunked([...sessionIds], 500)) {
    const rows = await kyselyOrThrow()
      .selectFrom('usage_events')
      .select((eb) => ['session_id', eb.fn.countAll().as('n')])
      .where('kind', '=', 'marked-useful')
      .where('session_id', 'in', part)
      .where('origin', 'is not', null)
      .whereRef('origin', '<>', 'workspace_id')
      .groupBy('session_id')
      .execute();
    for (const r of rows) if (r.session_id) out.set(r.session_id, num(r.n));
  }
  return out;
}
```

`src/host/hostMcp.ts`:

1. Imports. Change the `../main/mcpCore.js` import to:

```ts
import {
  initReadSource, releaseReadSource, serveMcpConnection, setExposedTools, setMcpLogSink, setQueryEmbedder, setReadScopeResolver,
  setUsageRecorder, type McpLogEntry, type UsageRecorder
} from '../main/mcpCore.js';
import { getSession, recordUsageEvent } from '../main/db.js';
```

2. Tool set:

```ts
export const HOST_MCP_TOOLS: ReadonlySet<string> = new Set([
  'list_sessions', 'get_session', 'get_cost', 'list_events', 'session_summary', 'query', 'mark_useful',
  'post_todo', 'update_todo', 'list_todos',
  'list_automations', 'get_automation', 'list_runs', 'run_automation', 'schedule_next'
]);
```

3. Recorder, after `hostMcpTools`:

```ts
/** The workspace of the session a signal is about is its origin: the hosted id or a publish partition. */
export const hostUsageRecorder: UsageRecorder = async (e) => {
  const origin = e.sessionId ? (await getSession(e.sessionId))?.workspaceId ?? null : null;
  await recordUsageEvent({ ...e, origin });
};
```

4. `startHostMcp` options. Add after `embed?: EmbedFn;`:

```ts
  /** Read scope beyond the hosted workspace (publish partitions), read on every call. */
  scope?: () => Promise<readonly string[]>;
  /** Writes usage_events; without it mark_useful answers unavailable. */
  recordUsage?: UsageRecorder;
```

5. Replace `setReadScopeResolver(async () => [o.workspaceId]);` with:

```ts
  setReadScopeResolver(async () => [o.workspaceId, ...((await o.scope?.()) ?? [])]);
  setUsageRecorder(o.recordUsage ?? null);
```

6. In `reset()`, add `setUsageRecorder(null);` after `setQueryEmbedder(null);`.

`src/host/holder.ts`:
- the import from `./hostMcp.js` becomes `import { hostUsageRecorder, startHostMcp, type HostMcp } from './hostMcp.js';`;
- `const publish = publishStore(…)` (Task 5, right after `const hint`) already comes before `const mcp = mcpServer(…)`;
- change the `mcpServer` call and signature:

```ts
  const mcp = mcpServer(o, embedder?.embed, publish, () =>
    openPgMcpReadSource(stores.poolConfig.schema, stores.poolConfig, (message) => o.log.log('warn', 'mcp query isolation', { error: message }), {
      preprovisioned: queryLogin(o.db, stores.poolConfig, o.env)
    }));
```

```ts
function mcpServer(o: HolderOptions, embed: EmbedFn | undefined, publish: PublishStore, readSource: () => Promise<OwnedReadSource>): { start(): void; stop(): Promise<void> } {
```

```ts
      .then((rs) => startHostMcp({
        listen: o.mcp.listen, workspaceId: o.workspaceId, log: o.log, readSource: rs, embed,
        scope: () => publish.partitionIds(), recordUsage: hostUsageRecorder
      }))
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/main/dbUsefulMarks.test.ts src/host/hostMcp.test.ts src/main/mcpServer.contract.test.ts src/main/mcpServer.test.ts`.
Expected: PASS. The desktop contract is unchanged, because the desktop still serves every tool.

Run:
```bash
PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/main/dbUsefulMarks.test.ts src/host/hostQuery.pg.test.ts src/host/publishStore.pg.test.ts src/host/main.pg.test.ts
```
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpCore.ts src/main/db.ts src/host/hostMcp.ts src/host/holder.ts src/host/hostMcp.test.ts src/host/hostQuery.pg.test.ts src/host/publishStore.pg.test.ts src/main/dbUsefulMarks.test.ts vitest.pg.config.ts
git commit -m "feat(host): MCP reads published partitions; mark_useful records origin"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit and Postgres suites. `hostQuery.pg.test.ts` proves that RLS admits the partition and that the bookkeeping tables are denied, as the D71 login. |
| CI | Both jobs. |
| Cluster | From a hosted session: `list_sessions` shows a `pub_…` workspace after a publish; `query` `SELECT DISTINCT workspace_id FROM sessions` lists it; `search_transcripts` finds a published phrase. |

---

### Task 7: Desktop data helpers and `RemoteClient.publish`

**Files:**
- Modify `src/main/db.ts`: `blobsFor`, `publishableEvents`, the cursor and withheld helpers, `purgeWorkspace`.
- Modify `src/main/dbPublish.test.ts`.
- Modify `src/main/remoteClient.ts` and `src/main/remoteClient.test.ts`.

**Interfaces:**
- Consumes:
  - state v19 (Task 1);
  - `PublishBatch`, `PublishAck`, `PUBLISH_MAX_BODY` (Task 2);
  - `ScrubbedLine` (Task 2);
  - `startTestHost({ publish })` (Task 4).
- Produces from `db.ts`:
  - `interface PublishableEvent { id: number; sessionId: string; rawJsonl: string }`
  - `publishableEvents(workspaceId: string, afterId: number, startedSince: number, limit: number): Promise<PublishableEvent[]>`
  - `getPublishCursor(source: string, target: string): Promise<number>` (0 when absent)
  - `setPublishCursor(source: string, target: string, lastEventId: number): Promise<void>`
  - `deletePublishCursor(source: string, target: string): Promise<void>`
  - `withholdSession(workspaceId: string, sessionId: string): Promise<void>`
  - `withheldSessions(workspaceId: string): Promise<Set<string>>`
- Produces from `remoteClient.ts`:
  - `PUBLISH_TIMEOUT_MS = 30_000`
  - `RemoteClient.publish(batch: PublishBatch<ScrubbedLine>): Promise<PublishAck>`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/dbPublish.test.ts`:

```ts
const W = '01JC0000000000000000000005';
const turn = (sessionId: string, uuid: string, ts: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, sessionId, timestamp: ts, message: { role: 'user', content } });

describe('publish helpers', () => {
  it('lists a workspace’s events after the cursor, from sessions started since, with attachments expanded', async () => {
    await openTestState('pub-ev-');
    await db.ingestBatch(W, 'old', [turn('old', 'o1', '2026-11-01T00:00:00Z', 'before opt-in')]);
    await db.ingestBatch(W, 'new', [turn('new', 'n1', '2026-11-05T00:00:00Z', 'first'), turn('new', 'n2', '2026-11-05T00:01:00Z', 'second')]);
    await db.ingestBatch('01JC0000000000000000000006', 'x', [turn('x', 'x1', '2026-11-05T00:00:00Z', 'other workspace')]);
    const since = Date.parse('2026-11-04T00:00:00Z');
    const all = await db.publishableEvents(W, 0, since, 10);
    expect(all.map((e) => [e.sessionId, JSON.parse(e.rawJsonl).message.content])).toEqual([['new', 'first'], ['new', 'second']]);
    expect(await db.publishableEvents(W, all[0].id, since, 10)).toEqual([all[1]]);
    expect(await db.publishableEvents(W, 0, since, 1)).toEqual([all[0]]);
  });

  it('keeps cursors and withheld sessions per workspace, and purges them with it', async () => {
    await openTestState('pub-cur-');
    expect(await db.getPublishCursor(W, 'R')).toBe(0);
    await db.setPublishCursor(W, 'R', 7);
    await db.setPublishCursor(W, 'R', 9);
    expect(await db.getPublishCursor(W, 'R')).toBe(9);
    await db.withholdSession(W, 's1');
    await db.withholdSession(W, 's1');
    expect(await db.withheldSessions(W)).toEqual(new Set(['s1']));
    await db.deletePublishCursor(W, 'R');
    expect(await db.getPublishCursor(W, 'R')).toBe(0);
    await db.setPublishCursor(W, 'R', 3);
    await db.purgeWorkspace(W);
    expect(await db.getPublishCursor(W, 'R')).toBe(0);
    expect(await db.withheldSessions(W)).toEqual(new Set());
  });
});
```

Append to `src/main/remoteClient.test.ts`:
- add the imports `import { makeScrubber } from './publish/scrub.js';` and `import type { PublishRoute } from '../host/publishRoute.js';`;
- append:

```ts
describe('RemoteClient.publish', () => {
  const SRC = '01JC0000000000000000000005';
  const SID = '11111111-2222-4333-8444-555555555555';
  async function publishHost(route: Partial<PublishRoute>) {
    const seen: unknown[] = [];
    const h = await startTestHost({
      tokens: { [TOKEN]: person('alice', 1, ['acme/eng']) }, grants: [{ team: 'acme/eng', tier: 'read' }],
      publish: {
        admit: () => ({ ok: true, release: () => undefined }),
        post: async (c, b) => { seen.push([c.identity.login, b]); return { status: 200, body: { ok: true, accepted: 1, inserted: 1 } }; },
        ...route
      }
    });
    cleanups.push(h.close);
    return { client: new RemoteClient({ url: h.url, token: async () => TOKEN }), seen };
  }

  it('posts a scrubbed batch and returns the ack', async () => {
    const { client, seen } = await publishHost({});
    const line = makeScrubber([])('{"type":"user"}');
    expect(await client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })).toEqual({ ok: true, accepted: 1, inserted: 1 });
    expect(seen).toEqual([['alice', { sourceWorkspaceId: SRC, sessionId: SID, events: ['{"type":"user"}'] }]]);
  });

  it('refuses a batch over 1 MiB without sending it', async () => {
    const { client, seen } = await publishHost({});
    const big = makeScrubber([])(JSON.stringify({ t: 'x'.repeat(1024 * 1024) }));
    await expect(client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [big] })).rejects.toMatchObject({ kind: 'protocol', status: 413 });
    expect(seen).toEqual([]);
  });

  it('maps a 429 to unreachable with its Retry-After', async () => {
    const { client } = await publishHost({ admit: () => ({ ok: false, status: 429, error: 'publishing too fast', retryAfterSec: 3 }) });
    const line = makeScrubber([])('{"type":"user"}');
    await expect(client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })).rejects.toMatchObject({ kind: 'unreachable', status: 429, retryAfterMs: 3000 });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/dbPublish.test.ts src/main/remoteClient.test.ts`.
Expected: FAIL. `publishableEvents` and `client.publish` are not functions.

- [ ] **Step 3: Implement**

In `src/main/db.ts`, replace the blob fetch inside `eventsForSession` with a helper. Add above `eventsForSession`:

```ts
/** Each distinct blob once per page: a session repeats the same few payloads. */
async function blobsFor(k: Kysely<StateDb>, rows: readonly { att_ref: string | null }[]): Promise<Map<string, Buffer>> {
  const refs = [...new Set(rows.flatMap((r) => (r.att_ref ? [r.att_ref] : [])))];
  const blobs = new Map<string, Buffer>();
  for (const part of chunked(refs, 500)) {
    for (const b of await k.selectFrom('event_blobs').select(['hash', 'body_z']).where('hash', 'in', part).execute()) blobs.set(b.hash, b.body_z);
  }
  return blobs;
}
```

and in `eventsForSession`, replace everything from its `// Each distinct blob once per page` comment to the end of the function body with:

```ts
  const blobs = await blobsFor(k, rows);
  return rows.map((r) => rowFromSql(r, blobs));
```

Add, after `recordUsageEvent`/`usefulMarkCounts`:

```ts
// ── Transcript publish (SPEC §7 *Transcript publish*) ─────────────────────

export interface PublishableEvent {
  id: number;
  sessionId: string;
  rawJsonl: string;
}

/** `workspaceId`'s events after `afterId`, in id order, from sessions that started at or after `startedSince`. */
export async function publishableEvents(workspaceId: string, afterId: number, startedSince: number, limit: number): Promise<PublishableEvent[]> {
  const k = kyselyOrThrow();
  const rows = await k
    .selectFrom('events as e')
    .innerJoin('sessions as s', 's.id', 'e.session_id')
    .selectAll('e')
    .where('e.workspace_id', '=', workspaceId)
    .where('e.id', '>', afterId)
    .where('s.started_at', '>=', startedSince)
    .orderBy('e.id', 'asc')
    .limit(limit)
    .execute();
  const blobs = await blobsFor(k, rows);
  return rows.map((r) => {
    const e = rowFromSql(r, blobs);
    return { id: num(e.id), sessionId: e.sessionId, rawJsonl: e.rawJsonl };
  });
}

export async function getPublishCursor(source: string, target: string): Promise<number> {
  const r = await kyselyOrThrow().selectFrom('publish_cursors').select('last_event_id')
    .where('source_workspace_id', '=', source).where('target_workspace_id', '=', target).executeTakeFirst();
  return r ? num(r.last_event_id) : 0;
}

export async function setPublishCursor(source: string, target: string, lastEventId: number): Promise<void> {
  const at = Date.now();
  await kyselyOrThrow().insertInto('publish_cursors')
    .values({ source_workspace_id: source, target_workspace_id: target, last_event_id: lastEventId, updated_at: at })
    .onConflict((oc) => oc.columns(['source_workspace_id', 'target_workspace_id']).doUpdateSet({ last_event_id: lastEventId, updated_at: at }))
    .execute();
}

export async function deletePublishCursor(source: string, target: string): Promise<void> {
  await kyselyOrThrow().deleteFrom('publish_cursors').where('source_workspace_id', '=', source).where('target_workspace_id', '=', target).execute();
}

export async function withholdSession(workspaceId: string, sessionId: string): Promise<void> {
  await kyselyOrThrow().insertInto('publish_withheld').values({ session_id: sessionId, workspace_id: workspaceId, withheld_at: Date.now() })
    .onConflict((oc) => oc.column('session_id').doNothing()).execute();
}

export async function withheldSessions(workspaceId: string): Promise<Set<string>> {
  const rows = await kyselyOrThrow().selectFrom('publish_withheld').select('session_id').where('workspace_id', '=', workspaceId).execute();
  return new Set(rows.map((r) => r.session_id));
}
```

In `purgeWorkspace`:
- in the final table list, add `'publish_withheld'` after `'transcript_offsets'`;
- before `summaryCache.clear();`, add:

```ts
  const cursors = await slice(() => k.deleteFrom('publish_cursors').where('source_workspace_id', '=', workspaceId).executeTakeFirst());
  deleted += num(cursors.numDeletedRows);
```

In `src/main/remoteClient.ts`:
- add the imports:

```ts
import { PUBLISH_MAX_BODY, type PublishAck, type PublishBatch } from './publish/protocol.js';
import type { ScrubbedLine } from './publish/scrub.js';
```

- after `MAX_RPC_BODY`:

```ts
export const PUBLISH_TIMEOUT_MS = 30_000;
```

- add the method after `rpc()`:

```ts
  /** Only scrubbed lines type-check here (remote-workspaces §9). */
  async publish(batch: PublishBatch<ScrubbedLine>): Promise<PublishAck> {
    const body = JSON.stringify(batch);
    if (Buffer.byteLength(body) > PUBLISH_MAX_BODY) throw new RemoteError('protocol', 'publish batch is over 1 MiB', 413);
    const r = (await this.request('/publish', { method: 'POST', auth: true, body, maxBody: MAX_SMALL_BODY, timeoutMs: PUBLISH_TIMEOUT_MS })) as
      { ok?: unknown; accepted?: unknown; inserted?: unknown } | null;
    if (r?.ok !== true || typeof r.accepted !== 'number' || typeof r.inserted !== 'number') throw new RemoteError('protocol', `${this.url} publish failed`);
    return { ok: true, accepted: r.accepted, inserted: r.inserted };
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/main/dbPublish.test.ts src/main/remoteClient.test.ts src/main/dbPurgeWorkspace.test.ts src/main/db.test.ts`.
Expected: PASS.

Run `PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/main/dbPublish.test.ts src/main/dbPurgeWorkspace.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/dbPublish.test.ts src/main/remoteClient.ts src/main/remoteClient.test.ts
git commit -m "feat(publish): desktop event cursor helpers and RemoteClient.publish"
```

**Verification:**

| Where | What |
|---|---|
| Local | Everything. |
| CI | Both suites. |

---

### Task 8: Desktop publisher

**Files:**
- Create `src/main/publish/batches.ts` and `src/main/publish/batches.test.ts`.
- Create `src/main/publish/secretValues.ts` and `src/main/publish/secretValues.test.ts`.
- Create `src/main/publish/publisher.ts` and `src/main/publish/publisher.test.ts`.
- Modify `src/main/ipc.ts`: wire the publisher.

**Interfaces:**
- Consumes:
  - `makeScrubber`, `ScrubbedLine`, `ScrubValue` (Task 2);
  - `PublishBatch`, `PublishAck`, `PUBLISH_MAX_BODY`, `PUBLISH_MAX_LINES`, `SESSION_UUID_RE` (Task 2);
  - `publishableEvents`, `getPublishCursor`, `setPublishCursor`, `withheldSessions` (Task 7);
  - `RemoteClient.publish`, `RemoteError` (Task 7).
  - `WorkspaceSpec.publish?: { to: string[]; since: Record<string, number> }`. The field is added in Task 9; until then `PublisherManifest` (below) declares it as optional, and `WorkspaceSpec` is assignable to `PublisherManifest` either way.
- Produces from `batches.ts`:
  - `interface PublishRow { id: number; sessionId: string; rawJsonl: string }`
  - `interface PlannedBatch { batch: PublishBatch<ScrubbedLine> | null; lastId: number }`
  - `planBatches(sourceWorkspaceId: string, rows: readonly PublishRow[], o: { scrub: (line: string) => ScrubbedLine; withheld: ReadonlySet<string>; maxBody?: number; maxLines?: number; onOversize?: (row: PublishRow) => void }): PlannedBatch[]`
- Produces from `secretValues.ts`:
  - `interface VaultReader { listKeys(id: string): Promise<string[]>; getSecret(id: string, key: string): Promise<string | null> }`
  - `publishSecretValues(spec: { id: string; env: { secretKeys: string[] } }, vault: VaultReader, githubToken: () => Promise<string | null>): Promise<ScrubValue[]>`
- Produces from `publisher.ts`:
  - `PUBLISH_DEBOUNCE_MS = 2_000`, `PUBLISH_SWEEP_MS = 60_000`, `PUBLISH_PAGE = 500`, `PUBLISH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000]`, `PUBLISH_SIGNED_OUT_MS = 300_000`
  - `interface PublisherLog { level: 'info' | 'warn'; type: string; message: string; workspaceId?: string }`
  - `interface PublisherDeps { manifests(): Promise<PublisherManifest[]>; publish(url: string, batch: PublishBatch<ScrubbedLine>): Promise<PublishAck>; secretValues(spec: PublisherManifest): Promise<ScrubValue[]>; events(workspaceId: string, afterId: number, startedSince: number, limit: number): Promise<PublishRow[]>; getCursor(source: string, target: string): Promise<number>; setCursor(source: string, target: string, lastEventId: number): Promise<void>; withheld(workspaceId: string): Promise<Set<string>>; log(e: PublisherLog): void; now?: () => number; schedule?: (fn: () => void, ms: number) => () => void }`
  - `type PublisherManifest = Pick<WorkspaceSpec, 'id' | 'kind' | 'env' | 'remote'> & { publish?: { to: string[]; since: Record<string, number> } }`
  - `interface Publisher { bump(workspaceId: string): void; sweep(): Promise<void>; stop(): void }`
  - `startPublisher(d: PublisherDeps, o?: { debounceMs?: number; sweepMs?: number; page?: number }): Publisher`

- [ ] **Step 1: Write the failing tests**

`src/main/publish/batches.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { planBatches, type PublishRow } from './batches.js';
import type { ScrubbedLine } from './scrub.js';

const SRC = '01JC0000000000000000000005';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '22222222-2222-4333-8444-555555555555';
const scrub = (l: string): ScrubbedLine => l.replace('secret', '[x]') as ScrubbedLine;
const row = (id: number, sessionId: string, text = 'a'): PublishRow => ({ id, sessionId, rawJsonl: JSON.stringify({ t: text }) });

describe('planBatches', () => {
  it('groups consecutive same-session rows, scrubbed, and starts a batch on a session change', () => {
    const plan = planBatches(SRC, [row(1, S1, 'secret'), row(2, S1), row(3, S2), row(4, S1)], { scrub, withheld: new Set() });
    expect(plan.map((p) => [p.batch?.sessionId, p.batch?.events.length, p.lastId])).toEqual([[S1, 2, 2], [S2, 1, 3], [S1, 1, 4]]);
    expect(plan[0].batch!.events[0]).toBe('{"t":"[x]"}');
    expect(plan[0].batch!.sourceWorkspaceId).toBe(SRC);
  });

  it('splits at maxLines and at maxBody', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, S1));
    expect(planBatches(SRC, rows, { scrub, withheld: new Set(), maxLines: 2 }).map((p) => p.batch!.events.length)).toEqual([2, 2, 1]);
    const base = JSON.stringify({ sourceWorkspaceId: SRC, sessionId: S1, events: [] }).length;
    const cost = JSON.stringify(row(1, S1).rawJsonl).length + 1;
    const plan = planBatches(SRC, rows, { scrub, withheld: new Set(), maxBody: base + cost * 2 });
    expect(plan.map((p) => p.batch!.events.length)).toEqual([2, 2, 1]);
    for (const p of plan) expect(Buffer.byteLength(JSON.stringify(p.batch))).toBeLessThanOrEqual(base + cost * 2);
  });

  it('skips withheld sessions and non-UUID ids but still advances past them', () => {
    const plan = planBatches(SRC, [row(1, S1), row(2, S2), row(3, 'not-a-uuid'), row(4, S1)], { scrub, withheld: new Set([S2]) });
    expect(plan.map((p) => [p.batch?.sessionId ?? null, p.lastId])).toEqual([[S1, 1], [null, 3], [S1, 4]]);
  });

  it('skips a line too big for any batch and reports it', () => {
    const onOversize = vi.fn();
    const plan = planBatches(SRC, [row(1, S1, 'x'.repeat(200)), row(2, S1)], { scrub, withheld: new Set(), maxBody: 150, onOversize });
    expect(onOversize).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(plan.map((p) => [p.batch?.events.length ?? 0, p.lastId])).toEqual([[0, 1], [1, 2]]);
  });
});
```

`src/main/publish/secretValues.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { publishSecretValues } from './secretValues.js';

const vault = (bag: Record<string, string>) => ({
  listKeys: async () => Object.keys(bag),
  getSecret: async (_id: string, k: string) => bag[k] ?? null
});

describe('publishSecretValues', () => {
  it('returns the vault bag and the GitHub token', async () => {
    expect(await publishSecretValues({ id: 'W', env: { secretKeys: ['API_TOKEN'] } }, vault({ API_TOKEN: 'v1v1v1v1' }), async () => 'gho_tok'))
      .toEqual([{ key: 'API_TOKEN', value: 'v1v1v1v1' }, { key: 'GITHUB_TOKEN', value: 'gho_tok' }]);
  });

  it('fails closed when a declared secret can’t be read', async () => {
    await expect(publishSecretValues({ id: 'W', env: { secretKeys: ['API_TOKEN'] } }, vault({}), async () => null))
      .rejects.toThrow('secret API_TOKEN can’t be read from the vault');
  });

  it('fails closed when the vault throws', async () => {
    const broken = { listKeys: async () => { throw new Error('locked'); }, getSecret: async () => null };
    await expect(publishSecretValues({ id: 'W', env: { secretKeys: [] } }, broken, async () => null)).rejects.toThrow('locked');
  });
});
```

`src/main/publish/publisher.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '../remoteClient.js';
import type { PublishBatch } from './protocol.js';
import { PUBLISH_SIGNED_OUT_MS, startPublisher, type PublisherDeps, type PublisherLog, type PublisherManifest } from './publisher.js';
import type { ScrubbedLine } from './scrub.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const SRC = '01JC0000000000000000000005';
const OFF = '01JC0000000000000000000006';
const R1 = '01JC00000000000000000000R1';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '22222222-2222-4333-8444-555555555555';
const msg = (c: string) => JSON.stringify({ type: 'user', message: { content: c } });
const local = (id: string, to: string[]): PublisherManifest =>
  ({ id, kind: 'local', env: { plain: {}, secretKeys: [] }, publish: to.length ? { to, since: Object.fromEntries(to.map((t) => [t, 5_000])) } : undefined });
const remote = (id: string): PublisherManifest =>
  ({ id, kind: 'remote', env: { plain: {}, secretKeys: [] }, remote: { url: 'http://host', tier: 'read', login: 'ann', checkedAt: 1 } });
interface Row { ws: string; id: number; sessionId: string; rawJsonl: string; started: number }
const ROWS: Row[] = [
  { ws: SRC, id: 1, sessionId: S1, rawJsonl: msg('before opt-in'), started: 4_000 },
  { ws: SRC, id: 2, sessionId: S2, rawJsonl: msg(`uses vault-secret-1 and ghp_${'A'.repeat(36)}`), started: 6_000 },
  { ws: SRC, id: 3, sessionId: S2, rawJsonl: msg('second'), started: 6_000 },
  { ws: OFF, id: 4, sessionId: S1, rawJsonl: msg('not opted in'), started: 6_000 }
];

function rig(o: {
  manifests?: PublisherManifest[]; publish?: PublisherDeps['publish']; secrets?: PublisherDeps['secretValues'];
  withheld?: string[]; schedule?: PublisherDeps['schedule'];
} = {}) {
  const sent: Array<{ url: string; batch: PublishBatch<ScrubbedLine> }> = [];
  const cursors = new Map<string, number>();
  const logs: PublisherLog[] = [];
  const eventsFor: string[] = [];
  let t = 10_000;
  const publish = vi.fn(o.publish ?? (async (url: string, batch: PublishBatch<ScrubbedLine>) => {
    sent.push({ url, batch });
    return { ok: true as const, accepted: batch.events.length, inserted: batch.events.length };
  }));
  const p = startPublisher({
    manifests: async () => o.manifests ?? [local(SRC, [R1]), local(OFF, []), remote(R1)],
    publish,
    secretValues: o.secrets ?? (async () => [{ key: 'API_TOKEN', value: 'vault-secret-1' }]),
    events: async (ws, after, since, limit) => {
      eventsFor.push(ws);
      return ROWS.filter((r) => r.ws === ws && r.id > after && r.started >= since).slice(0, limit).map(({ id, sessionId, rawJsonl }) => ({ id, sessionId, rawJsonl }));
    },
    getCursor: async (s, tg) => cursors.get(`${s}>${tg}`) ?? 0,
    setCursor: async (s, tg, id) => void cursors.set(`${s}>${tg}`, id),
    withheld: async () => new Set(o.withheld ?? []),
    log: (e) => void logs.push(e),
    now: () => t,
    schedule: o.schedule ?? (() => () => undefined)
  });
  return { p, sent, publish, cursors, logs, eventsFor, advance: (ms: number) => void (t += ms) };
}

describe('startPublisher', () => {
  it('publishes only opted-in workspaces, only sessions started since, scrubbed, and advances the cursor', async () => {
    const r = rig();
    await r.p.sweep();
    expect(r.eventsFor).toEqual([SRC]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].url).toBe('http://host');
    expect(r.sent[0].batch.sessionId).toBe(S2);
    expect(r.sent[0].batch.events.map((l) => JSON.parse(l).message.content)).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'second']);
    expect(JSON.stringify(r.sent)).not.toContain('vault-secret-1');
    expect(JSON.stringify(r.sent)).not.toContain('ghp_');
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
    await r.p.sweep();
    expect(r.sent).toHaveLength(1);
  });

  it('sends nothing for a target that is not a bookmarked remote workspace', async () => {
    const r = rig({ manifests: [local(SRC, [R1])] });
    await r.p.sweep();
    expect(r.sent).toEqual([]);
  });

  it('never sends a withheld session but moves past it', async () => {
    const r = rig({ withheld: [S2] });
    await r.p.sweep();
    expect(r.sent).toEqual([]);
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
  });

  it('skips a batch the host refuses as malformed or conflicting', async () => {
    const r = rig({ publish: async () => { throw new RemoteError('protocol', 'conflict', 409); } });
    await r.p.sweep();
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-batch-refused']);
  });

  it('backs off on an unreachable host, honouring Retry-After, and keeps the cursor', async () => {
    const r = rig({ publish: async () => { throw new RemoteError('unreachable', 'busy', 429, 20_000); } });
    await r.p.sweep();
    expect(r.cursors.get(`${SRC}>${R1}`)).toBeUndefined();
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed']);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    r.advance(20_000);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(2);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed']);
  });

  it('waits five minutes when signed out', async () => {
    const r = rig({ publish: async () => { throw new RemoteError('not-signed-in', 'sign in'); } });
    await r.p.sweep();
    r.advance(PUBLISH_SIGNED_OUT_MS - 1);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    r.advance(1);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(2);
  });

  it('sends nothing when the workspace’s secrets can’t be read', async () => {
    const r = rig({ secrets: async () => { throw new Error('secret API_TOKEN can’t be read from the vault'); } });
    await r.p.sweep();
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.eventsFor).toEqual([]);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-scrub-unavailable']);
  });

  it('bump publishes once after the debounce, however many ingests arrive', async () => {
    const timers: Array<() => void> = [];
    const r = rig({ schedule: (fn) => { timers.push(fn); return () => undefined; } });
    expect(timers).toHaveLength(1);
    r.p.bump(SRC);
    r.p.bump(SRC);
    expect(timers).toHaveLength(2);
    timers[1]();
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    r.p.stop();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/publish/batches.test.ts src/main/publish/secretValues.test.ts src/main/publish/publisher.test.ts`.
Expected: FAIL. The modules don't exist.

- [ ] **Step 3: Implement**

`src/main/publish/batches.ts`:

```ts
// Splits publishable rows into POST /publish batches (remote-workspaces §7). Pure.
import { PUBLISH_MAX_BODY, PUBLISH_MAX_LINES, SESSION_UUID_RE, type PublishBatch } from './protocol.js';
import type { ScrubbedLine } from './scrub.js';

export interface PublishRow {
  id: number;
  sessionId: string;
  rawJsonl: string;
}

/** `batch` null: nothing to send, only move the cursor to `lastId`. */
export interface PlannedBatch {
  batch: PublishBatch<ScrubbedLine> | null;
  lastId: number;
}

export function planBatches(
  sourceWorkspaceId: string,
  rows: readonly PublishRow[],
  o: { scrub: (line: string) => ScrubbedLine; withheld: ReadonlySet<string>; maxBody?: number; maxLines?: number; onOversize?: (row: PublishRow) => void }
): PlannedBatch[] {
  const maxBody = o.maxBody ?? PUBLISH_MAX_BODY;
  const maxLines = o.maxLines ?? PUBLISH_MAX_LINES;
  const out: PlannedBatch[] = [];
  let cur: { sessionId: string; lines: ScrubbedLine[]; bytes: number; lastId: number } | null = null;
  const flush = (): void => {
    if (cur) out.push({ batch: { sourceWorkspaceId, sessionId: cur.sessionId, events: cur.lines }, lastId: cur.lastId });
    cur = null;
  };
  const skip = (id: number): void => {
    flush();
    const last = out[out.length - 1];
    if (last && !last.batch) last.lastId = id;
    else out.push({ batch: null, lastId: id });
  };
  for (const row of rows) {
    if (o.withheld.has(row.sessionId) || !SESSION_UUID_RE.test(row.sessionId)) {
      skip(row.id);
      continue;
    }
    const line = o.scrub(row.rawJsonl);
    const cost = Buffer.byteLength(JSON.stringify(line)) + 1;
    const base = Buffer.byteLength(JSON.stringify({ sourceWorkspaceId, sessionId: row.sessionId, events: [] }));
    if (base + cost > maxBody) {
      o.onOversize?.(row);
      skip(row.id);
      continue;
    }
    if (cur && (cur.sessionId !== row.sessionId || cur.lines.length >= maxLines || cur.bytes + cost > maxBody)) flush();
    cur ??= { sessionId: row.sessionId, lines: [], bytes: base, lastId: row.id };
    cur.lines.push(line);
    cur.bytes += cost;
    cur.lastId = row.id;
  }
  flush();
  return out;
}
```

`src/main/publish/secretValues.ts`:

```ts
// What a workspace's published transcripts are scrubbed of on the desktop (remote-workspaces §7).
import type { ScrubValue } from './scrub.js';

export interface VaultReader {
  listKeys(workspaceId: string): Promise<string[]>;
  getSecret(workspaceId: string, key: string): Promise<string | null>;
}

/** The vault bag plus the GitHub sign-in. Throws (so nothing is sent) when a declared secret can't be read. */
export async function publishSecretValues(
  spec: { id: string; env: { secretKeys: string[] } },
  vault: VaultReader,
  githubToken: () => Promise<string | null>
): Promise<ScrubValue[]> {
  const out: ScrubValue[] = [];
  const declared = new Set(spec.env.secretKeys);
  for (const key of new Set([...declared, ...(await vault.listKeys(spec.id))])) {
    const value = await vault.getSecret(spec.id, key);
    if (value) out.push({ key, value });
    else if (declared.has(key)) throw new Error(`secret ${key} can’t be read from the vault`);
  }
  const token = await githubToken();
  if (token) out.push({ key: 'GITHUB_TOKEN', value: token });
  return out;
}
```

`src/main/publish/publisher.ts`:

```ts
// Pushes opted-in workspaces' newly ingested events to their remote targets (remote-workspaces §7).
// The one cross-boundary write: only acks come back, nothing lands in the local DB (D62).
import { RemoteError } from '../remoteClient.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { planBatches, type PublishRow } from './batches.js';
import type { PublishAck, PublishBatch } from './protocol.js';
import { makeScrubber, type ScrubbedLine, type ScrubValue } from './scrub.js';

export const PUBLISH_DEBOUNCE_MS = 2_000;
export const PUBLISH_SWEEP_MS = 60_000;
export const PUBLISH_PAGE = 500;
export const PUBLISH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const PUBLISH_SIGNED_OUT_MS = 300_000;
/** The host will refuse this batch every time: skip it rather than block the cursor. */
const SKIP_STATUSES = new Set([400, 409, 413]);

export type PublisherManifest = Pick<WorkspaceSpec, 'id' | 'kind' | 'env' | 'remote'> & {
  publish?: { to: string[]; since: Record<string, number> };
};

export interface PublisherLog {
  level: 'info' | 'warn';
  type: string;
  message: string;
  workspaceId?: string;
}

export interface PublisherDeps {
  manifests(): Promise<PublisherManifest[]>;
  publish(url: string, batch: PublishBatch<ScrubbedLine>): Promise<PublishAck>;
  secretValues(spec: PublisherManifest): Promise<ScrubValue[]>;
  events(workspaceId: string, afterId: number, startedSince: number, limit: number): Promise<PublishRow[]>;
  getCursor(source: string, target: string): Promise<number>;
  setCursor(source: string, target: string, lastEventId: number): Promise<void>;
  withheld(workspaceId: string): Promise<Set<string>>;
  log(e: PublisherLog): void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface Publisher {
  /** A workspace ingested events: publish after a short quiet period. */
  bump(workspaceId: string): void;
  /** Every opted-in (workspace, target) pair now; also runs on a timer. */
  sweep(): Promise<void>;
  stop(): void;
}

interface Pair { spec: PublisherManifest; target: string; url: string; since: number }
interface PairState { running: Promise<void> | null; retryAt: number; attempt: number; failing: string | null }

export function startPublisher(d: PublisherDeps, o: { debounceMs?: number; sweepMs?: number; page?: number } = {}): Publisher {
  const now = d.now ?? Date.now;
  const schedule = d.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  });
  const page = o.page ?? PUBLISH_PAGE;
  const states = new Map<string, PairState>();
  const pending = new Map<string, () => void>();
  let stopped = false;

  async function pairs(only?: string): Promise<Pair[]> {
    const all = await d.manifests();
    const urls = new Map(all.flatMap((m) => (m.kind === 'remote' && m.remote ? [[m.id, m.remote.url] as const] : [])));
    const out: Pair[] = [];
    for (const spec of all) {
      if (spec.kind === 'remote' || !spec.publish || (only !== undefined && spec.id !== only)) continue;
      for (const target of spec.publish.to) {
        const url = urls.get(target);
        const since = spec.publish.since[target];
        if (url && Number.isSafeInteger(since)) out.push({ spec, target, url, since });
      }
    }
    return out;
  }

  function fail(st: PairState, ws: string, type: string, message: string, waitMs: number): void {
    st.retryAt = now() + waitMs;
    if (st.failing !== type) d.log({ level: 'warn', type, message, workspaceId: ws });
    st.failing = type;
  }

  async function pass(p: Pair, st: PairState): Promise<void> {
    const ws = p.spec.id;
    let scrub: (line: string) => ScrubbedLine;
    try {
      scrub = makeScrubber(await d.secretValues(p.spec));
    } catch (err) {
      return fail(st, ws, 'publish-scrub-unavailable', `not publishing: this workspace's secrets can't be read to scrub transcripts (${(err as Error).message})`, PUBLISH_SIGNED_OUT_MS);
    }
    for (;;) {
      if (stopped) return;
      const rows = await d.events(ws, await d.getCursor(ws, p.target), p.since, page);
      if (rows.length === 0) break;
      const plan = planBatches(ws, rows, {
        scrub,
        withheld: await d.withheld(ws),
        onOversize: (r) => d.log({ level: 'warn', type: 'publish-line-skipped', message: `event ${r.id} is over the 1 MiB publish limit; not published`, workspaceId: ws })
      });
      for (const b of plan) {
        if (stopped) return;
        if (b.batch) {
          try {
            await d.publish(p.url, b.batch);
          } catch (err) {
            const e = err instanceof RemoteError ? err : null;
            if (e?.status === undefined || !SKIP_STATUSES.has(e.status)) {
              const signedOut = e?.kind === 'not-signed-in' || e?.kind === 'unauthorized' || e?.kind === 'forbidden';
              const backoff = PUBLISH_BACKOFF_MS[Math.min(st.attempt++, PUBLISH_BACKOFF_MS.length - 1)];
              return fail(st, ws, 'publish-failed', (err as Error).message, signedOut ? PUBLISH_SIGNED_OUT_MS : Math.max(backoff, e?.retryAfterMs ?? 0));
            }
            d.log({ level: 'warn', type: 'publish-batch-refused', message: `the host refused a batch (${e.status}); skipped: ${e.message}`, workspaceId: ws });
          }
        }
        await d.setCursor(ws, p.target, b.lastId);
      }
      if (rows.length < page) break;
    }
    if (st.failing) d.log({ level: 'info', type: 'publish-recovered', message: 'publishing resumed', workspaceId: ws });
    st.failing = null;
    st.attempt = 0;
  }

  function run(p: Pair): Promise<void> {
    const key = `${p.spec.id}>${p.target}`;
    let st = states.get(key);
    if (!st) states.set(key, (st = { running: null, retryAt: 0, attempt: 0, failing: null }));
    if (st.running) return st.running;
    if (stopped || now() < st.retryAt) return Promise.resolve();
    const s = st;
    s.running = pass(p, s)
      .catch((err: Error) => fail(s, p.spec.id, 'publish-failed', err.message, PUBLISH_BACKOFF_MS[0]))
      .finally(() => {
        s.running = null;
      });
    return s.running;
  }

  async function sweep(): Promise<void> {
    for (const p of await pairs()) await run(p);
  }

  const sweepMs = o.sweepMs ?? PUBLISH_SWEEP_MS;
  let cancelSweep = schedule(function tick() {
    void sweep()
      .catch((err: Error) => d.log({ level: 'warn', type: 'publish-failed', message: err.message }))
      .finally(() => {
        if (!stopped) cancelSweep = schedule(tick, sweepMs);
      });
  }, sweepMs);

  return {
    bump(ws) {
      if (stopped || pending.has(ws)) return;
      pending.set(ws, schedule(() => {
        pending.delete(ws);
        void pairs(ws)
          .then((ps) => Promise.all(ps.map(run)))
          .catch((err: Error) => d.log({ level: 'warn', type: 'publish-failed', message: err.message, workspaceId: ws }));
      }, o.debounceMs ?? PUBLISH_DEBOUNCE_MS));
    },
    sweep,
    stop() {
      stopped = true;
      cancelSweep();
      for (const cancel of pending.values()) cancel();
      pending.clear();
    }
  };
}
```

Wire it in `src/main/ipc.ts`:

1. Imports:

```ts
import { startPublisher, type Publisher } from './publish/publisher.js';
import { publishSecretValues } from './publish/secretValues.js';
```

   Add `getPublishCursor, publishableEvents, setPublishCursor, withheldSessions,` to the existing `from './db.js'` import list.

2. Module level, after `const remoteBackend = createRemoteBackend({…});`:

```ts
// Started by registerIpc once the identity service exists; writeManifest bumps it.
let publisher: Publisher | null = null;
```

3. In `registerIpc`, after `registerFederationIpc(ipcMain, federated, localSearch);`:

```ts
  if (jsonlWatcher && !MOCK_MODE) {
    publisher = startPublisher({
      manifests: () => listWorkspaceManifests(),
      publish: (url, batch) => remoteBackend.clientFor(url).publish(batch),
      secretValues: (spec) => publishSecretValues(spec, vault, () => identity.bearerToken()),
      events: publishableEvents,
      getCursor: getPublishCursor,
      setCursor: setPublishCursor,
      withheld: withheldSessions,
      log: (e) => logError({ source: 'main', ...e })
    });
    jsonlWatcher.on('ingest', ({ workspaceId }) => publisher?.bump(workspaceId));
  }
```


- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/main/publish`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/publish/batches.ts src/main/publish/batches.test.ts src/main/publish/secretValues.ts src/main/publish/secretValues.test.ts src/main/publish/publisher.ts src/main/publish/publisher.test.ts src/main/ipc.ts
git commit -m "feat(publish): desktop publisher with cursor, batching and fail-closed scrub"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit tests with fakes. Nothing publishes yet, because no manifest has `publish` until Task 9. |
| CI | The unit suite. |
| Host | The end-to-end run with a real host comes after Task 9 (Task 12 checklist). |

---

### Task 9: Manifest `publish` block and the Edit form control

**Files:**
- Create `src/preload/publish.ts` and `src/preload/publish.test.ts`.
- Modify `tsconfig.web.json`: add `"src/preload/publish.ts"` to `include`.
- Modify `src/main/workspaces.ts`: `WorkspaceSpec`, `readWorkspaceManifest`.
- Modify `src/main/workspacesManifestRead.test.ts`.
- Modify `src/main/ipc.ts`: in the `workspace:writeManifest` handler, add `publishOnWrite`, the cursor drop and the publisher bump.
- Modify `src/main/ipcWorkspaceIdGuard.test.ts`: the source-text guard.
- Create `src/renderer/src/components/publishTargets.ts` and `src/renderer/src/components/publishTargets.test.ts`.
- Modify `src/renderer/src/components/WorkspaceForm.tsx`, `src/renderer/src/components/formInitial.ts` and `src/renderer/src/App.tsx`.
- Modify `src/renderer/src/styles.css`.

**Interfaces:**
- Consumes:
  - `deletePublishCursor` (Task 7);
  - `publisher` (Task 8).
- Produces:
  - `interface WorkspacePublish { to: string[]; since: Record<string, number> }`
  - `PUBLISH_TARGETS_MAX = 16`
  - `sanitizePublish(v: unknown): WorkspacePublish | undefined`
  - `publishForWrite(incoming: unknown, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined`
  - `publishOnWrite(spec: object, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined`
  - `WorkspaceSpec.publish?: WorkspacePublish`
  - `WorkspaceSummary.publish?: WorkspacePublish`
  - `WorkspaceFormSubmit.publishTo?: string[]`
  - from `publishTargets.ts`: `PUBLISH_HINT`, `publishVisibility(name)`, `togglePublishTarget(to, id, on)`, `publishSummary(to, remotes)`

- [ ] **Step 1: Write the failing tests**

`src/preload/publish.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { publishForWrite, publishOnWrite, sanitizePublish } from './publish';

const R1 = '01JC00000000000000000000R1';
const R2 = '01JC00000000000000000000R2';
const remotes = new Set([R1, R2]);

describe('sanitizePublish', () => {
  it('keeps well-formed targets that have a since', () => {
    expect(sanitizePublish({ to: [R1, R1, 'bad', 7, R2], since: { [R1]: 5, [R2]: 0 } })).toEqual({ to: [R1], since: { [R1]: 5 } });
  });
  it('drops anything else', () => {
    expect(sanitizePublish(undefined)).toBeUndefined();
    expect(sanitizePublish({ to: [], since: {} })).toBeUndefined();
    expect(sanitizePublish({ to: 'x' })).toBeUndefined();
  });
});

describe('publishForWrite', () => {
  it('stamps a newly added target with now and keeps an existing since', () => {
    expect(publishForWrite({ to: [R1, R2] }, { to: [R1], since: { [R1]: 5 } }, remotes, 100)).toEqual({ to: [R1, R2], since: { [R1]: 5, [R2]: 100 } });
  });
  it('ignores a since sent by the renderer', () => {
    expect(publishForWrite({ to: [R2], since: { [R2]: 1 } }, undefined, remotes, 100)).toEqual({ to: [R2], since: { [R2]: 100 } });
  });
  it('drops targets that are not bookmarked remote workspaces, and clears when none remain', () => {
    expect(publishForWrite({ to: ['01JC00000000000000000000ZZ'] }, undefined, remotes, 100)).toBeUndefined();
    expect(publishForWrite({ to: [] }, { to: [R1], since: { [R1]: 5 } }, remotes, 100)).toBeUndefined();
    expect(publishForWrite(undefined, undefined, remotes, 100)).toBeUndefined();
  });
  it('gives a target turned off and on again a new since', () => {
    const off = publishForWrite({ to: [R2] }, { to: [R1, R2], since: { [R1]: 5, [R2]: 6 } }, remotes, 100);
    expect(publishForWrite({ to: [R1, R2] }, off, remotes, 200)).toEqual({ to: [R1, R2], since: { [R1]: 200, [R2]: 6 } });
  });
});

describe('publishOnWrite', () => {
  it('keeps the stored block when the spec has no publish key', () => {
    const stored = { to: [R1], since: { [R1]: 5 } };
    expect(publishOnWrite({ name: 'x' }, stored, remotes, 100)).toBe(stored);
    expect(publishOnWrite({ publish: undefined }, stored, remotes, 100)).toBeUndefined();
  });
});
```

`src/renderer/src/components/publishTargets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { publishSummary, publishVisibility, togglePublishTarget } from './publishTargets';

describe('publish targets', () => {
  it('toggles a target without duplicates', () => {
    expect(togglePublishTarget(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(togglePublishTarget(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(togglePublishTarget(['a', 'b'], 'a', false)).toEqual(['b']);
  });
  it('summarizes by host name', () => {
    const remotes = [{ id: 'a', name: 'review-bot' }, { id: 'b', name: 'ops' }];
    expect(publishSummary([], remotes)).toBe('off');
    expect(publishSummary(['b', 'a'], remotes)).toBe('on: ops, review-bot');
    expect(publishSummary(['gone'], remotes)).toBe('off');
  });
  it('states who can see published transcripts', () => {
    expect(publishVisibility('review-bot')).toBe('Visible to everyone with read on review-bot and to its sessions.');
  });
});
```

Add to `src/main/workspacesManifestRead.test.ts`:

```ts
it('keeps a sanitized publish block on a local manifest', async () => {
  const R = '01JC00000000000000000000R1';
  await writeRaw('E', { ...spec('E'), kind: 'local', publish: { to: [R, 'junk'], since: { [R]: 5 } } });
  expect((await readWorkspaceManifest('E'))?.publish).toEqual({ to: [R], since: { [R]: 5 } });
});
```

Add to the `describe('remote bookmark wiring', …)` block of `src/main/ipcWorkspaceIdGuard.test.ts`:

```ts
  it('workspace:writeManifest derives publish in main and drops cursors of removed targets', () => {
    const write = handlerSource('workspace:writeManifest');
    expect(write).toMatch(/const publish = publishOnWrite\(spec, existing\?\.publish, remoteIds, Date\.now\(\)\)/);
    expect(write).toMatch(/deletePublishCursor\(spec\.id, id\)/);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
npx vitest run src/preload/publish.test.ts src/renderer/src/components/publishTargets.test.ts src/main/workspacesManifestRead.test.ts src/main/ipcWorkspaceIdGuard.test.ts
```
Expected: FAIL. The modules are missing, `publish` is undefined, and the source-text guard doesn't match.

- [ ] **Step 3: Implement**

`src/preload/publish.ts`:

```ts
// Shared by main and renderer (the only dir both tsconfigs compile).

/** `since[id]`: epoch ms when target `id` was turned on. Main sets it; the renderer can't. */
export interface WorkspacePublish {
  to: string[];
  since: Record<string, number>;
}

export const PUBLISH_TARGETS_MAX = 16;
const REMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && REMOTE_ID_RE.test(x)))].slice(0, PUBLISH_TARGETS_MAX) : [];

/** Read side: drops malformed targets and any target without a valid `since`. */
export function sanitizePublish(v: unknown): WorkspacePublish | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { to?: unknown; since?: unknown };
  const since = o.since && typeof o.since === 'object' ? (o.since as Record<string, unknown>) : {};
  const to = ids(o.to).filter((id) => Number.isSafeInteger(since[id]) && (since[id] as number) > 0);
  return to.length ? { to, since: Object.fromEntries(to.map((id) => [id, since[id] as number])) } : undefined;
}

/** Write side: `to` from the form, limited to bookmarked remote workspaces; a target already on keeps its `since`. */
export function publishForWrite(incoming: unknown, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined {
  const raw = incoming && typeof incoming === 'object' ? (incoming as { to?: unknown }).to : undefined;
  const to = ids(raw).filter((id) => remoteIds.has(id));
  if (!to.length) return undefined;
  return { to, since: Object.fromEntries(to.map((id) => [id, existing?.to.includes(id) ? existing.since[id] : now])) };
}

/** writeManifest: an absent `publish` key keeps the stored block (the resume and committee writes don't send it). */
export function publishOnWrite(spec: object, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined {
  return 'publish' in spec ? publishForWrite((spec as { publish?: unknown }).publish, existing, remoteIds, now) : existing;
}
```

`tsconfig.web.json`: append `"src/preload/publish.ts"` to `include`.

`src/main/workspaces.ts`:
- `import { sanitizePublish, type WorkspacePublish } from '../preload/publish.js';`
- in `WorkspaceSpec`, after `mounts?: ExtraMount[];`:

```ts
  /** Local and container only: remote workspaces this one publishes transcripts to. */
  publish?: WorkspacePublish;
```

- in `readWorkspaceManifest`'s returned object, after the `mounts:` line:

```ts
      publish: kind === 'remote' ? undefined : sanitizePublish((parsed as { publish?: unknown }).publish),
```

`src/main/ipc.ts`:
- `import { publishOnWrite } from '../preload/publish.js';`
- add `deletePublishCursor,` to the `./db.js` import;
- in `workspace:writeManifest`, after the `const mounts = await mountsFor(…);` line:

```ts
      const remoteIds = new Set((await listWorkspaceManifests()).filter((m) => m.kind === 'remote').map((m) => m.id));
      const publish = publishOnWrite(spec, existing?.publish, remoteIds, Date.now());
```

- in the `writeWorkspaceManifest({ … })` object of that handler, add `publish,` after `mounts,`;
- right after that `await writeWorkspaceManifest({ … });` statement:

```ts
      for (const id of existing?.publish?.to ?? []) if (!publish?.to.includes(id)) await deletePublishCursor(spec.id, id);
      publisher?.bump(spec.id);
```

`src/renderer/src/components/publishTargets.ts`:

```ts
// Copy and pure helpers for the Edit form's "Publish transcripts to…" control.

export const PUBLISH_HINT =
  "Sessions that start after you turn a host on are sent to it as they're recorded. Before anything leaves this computer, this workspace's secrets and your GitHub sign-in are replaced and common token shapes are removed. Earlier sessions are never sent.";

export function publishVisibility(name: string): string {
  return `Visible to everyone with read on ${name} and to its sessions.`;
}

export function togglePublishTarget(to: readonly string[], id: string, on: boolean): string[] {
  if (!on) return to.filter((x) => x !== id);
  return to.includes(id) ? [...to] : [...to, id];
}

export function publishSummary(to: readonly string[], remotes: ReadonlyArray<{ id: string; name: string }>): string {
  const names = to.flatMap((id) => remotes.filter((r) => r.id === id).map((r) => r.name));
  return names.length ? `on: ${names.join(', ')}` : 'off';
}
```

`src/renderer/src/App.tsx`:
- `import type { WorkspacePublish } from '../../preload/publish';`
- in `WorkspaceSummary`, after `mounts?: ExtraMount[];`:

```ts
  /** Local and container only: remote workspaces this one publishes to (main sets `since`). */
  publish?: WorkspacePublish;
```

- in `handleEditSave`'s `window.api.workspace.writeManifest({ … })`, after `knowledgeCapture: submit.knowledgeCapture,`:

```ts
      publish: { to: submit.publishTo ?? [] },
```

`src/renderer/src/components/formInitial.ts`: after `knowledgeCapture: w.knowledgeCapture`, add `,` and:

```ts
    publishTo: w.publish?.to
```

`src/renderer/src/components/WorkspaceForm.tsx`:
- `import { PUBLISH_HINT, publishSummary, publishVisibility, togglePublishTarget } from './publishTargets';`
- in `WorkspaceFormSubmit`, after `knowledgeCapture?: CaptureSettings;`:

```ts
  /** Edit mode only: remote workspace ids to publish transcripts to (empty = off). */
  publishTo?: string[];
```

- state, after the `capture` state line:

```ts
  const [publishTo, setPublishTo] = useState<string[]>(() => initial?.publishTo ?? []);
  const remotes = useMemo(() => workspaces.filter((w) => w.kind === 'remote').map((w) => ({ id: w.id, name: w.name })), [workspaces]);
```

- in `buildPayload`'s returned object, after `knowledgeCapture: captureSubmitValue(cap.settings)`, add `,` and:

```ts
      publishTo: mode === 'edit' ? publishTo : undefined
```

- JSX, directly after the Transcript mirror `</details>` and before `{mode === 'edit' && (` for the committee block:

```tsx
      {mode === 'edit' && (
        <details className="form-disclosure">
          <summary>
            Publish transcripts to…{' '}
            <span className="form-hint">{publishSummary(publishTo, remotes)}</span>
          </summary>
          {remotes.length === 0 ? (
            <p className="form-hint">Add a remote workspace first (+ → Remote).</p>
          ) : (
            <>
              <p className="form-hint">{PUBLISH_HINT}</p>
              {remotes.map((r) => (
                <label key={r.id} className="publish-target">
                  <input
                    type="checkbox"
                    checked={publishTo.includes(r.id)}
                    onChange={(e) => setPublishTo((to) => togglePublishTarget(to, r.id, e.target.checked))}
                    disabled={busy}
                  />
                  <span>{r.name}</span>
                  <span className="form-hint">{publishVisibility(r.name)}</span>
                </label>
              ))}
            </>
          )}
        </details>
      )}
```

`src/renderer/src/styles.css`: append:

```css
.publish-target {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 4px 0;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
```bash
npx vitest run src/preload/publish.test.ts src/renderer/src/components/publishTargets.test.ts src/main/workspacesManifestRead.test.ts src/main/ipcWorkspaceIdGuard.test.ts src/renderer/src/components/formInitial.test.ts
```
Expected: PASS.

Typecheck: run `npx tsc --noEmit -p tsconfig.node.json`, then `npx tsc --noEmit -p tsconfig.web.json`.
Expected: no errors.

Run `npm run build`.
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/preload/publish.ts src/preload/publish.test.ts tsconfig.web.json src/main/workspaces.ts src/main/workspacesManifestRead.test.ts src/main/ipc.ts src/main/ipcWorkspaceIdGuard.test.ts src/renderer/src/components/publishTargets.ts src/renderer/src/components/publishTargets.test.ts src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/components/formInitial.ts src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "feat(publish): manifest publish block and the Edit form's Publish transcripts control"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit tests, both typechecks, build. |
| CI | Same, plus Playwright on the build. |
| Host eyeball (Troy) | Edit a local workspace with one remote bookmarked: the control lists it with the visibility line; Save; `workspace.json` shows `publish.to` and `since`. Resume from the Saved tab keeps the block. Untick it and Save: the block is gone. |

---

### Task 10: Unpublish — host `DELETE /publish/<sessionId>` and the desktop action

**Files:**
- Modify `src/main/db.ts`: extract `deleteSessionRows`.
- Modify `src/host/publishStore.ts`: add `unpublish`.
- Modify `src/host/publishStore.pg.test.ts`.
- Modify `src/host/publishRoute.ts`: add `remove`.
- Modify `src/host/publishRoute.test.ts`.
- Modify `src/host/server.ts`: DELETE routing.
- Modify `src/host/server.test.ts`.
- Modify `src/preload/publish.ts`: add `UnpublishResult`.
- Modify `src/main/remoteClient.ts`: add `unpublish`.
- Modify `src/main/remoteClient.test.ts`.
- Create `src/main/publish/publishIpc.ts` and `src/main/publish/publishIpc.test.ts`.
- Modify `src/main/ipc.ts`: register it.
- Modify `src/preload/index.ts`: the `publish` bridge.
- Modify `src/renderer/src/components/publishTargets.ts`: add `unpublishNote`.
- Modify `src/renderer/src/components/publishTargets.test.ts`.
- Modify `src/renderer/src/sessionsView.ts`: add `publishTargetsMap`.
- Modify `src/renderer/src/sessionsView.test.ts`.
- Modify `src/renderer/src/components/LeftRail.tsx` and `src/renderer/src/components/SessionsPane.tsx`.

**Interfaces:**
- Consumes:
  - `withholdSession` (Task 7);
  - `PublishStore`, `PublishRoute`, `failureReply`, `ownerOf` (Tasks 3 and 4);
  - `SESSION_UUID_RE` (Task 2).
- Produces:
  - `deleteSessionRows(q: Kysely<StateDb>, id: string): Promise<void>`
  - `PublishStore.unpublish(owner: PublishOwner, sourceSessionId: string): Promise<number>`
  - `PublishRoute.remove(caller: Principal, sessionId: string): Promise<RouteReply>`
  - `interface UnpublishResult { removed: number; failed: { remoteId: string; name: string; error: string }[] }`
  - `RemoteClient.unpublish(sessionId: string): Promise<number>`
  - `PUBLISH_CHANNELS = ['publish:unpublish']`
  - `registerPublishIpc(ipc, deps: PublishIpcDeps)`
  - `window.api.publish.unpublish(workspaceId, sessionId): Promise<UnpublishResult>`
  - `unpublishNote(r: UnpublishResult): string`
  - `publishTargetsMap(workspaces): Record<string, string[]>`
  - `SessionsPane` prop `publishTargets?: Record<string, string[]>`

- [ ] **Step 1: Write the failing tests**

Append inside the Postgres describe of `src/host/publishStore.pg.test.ts`:

```ts
  it('unpublish removes only the caller’s copy: events, embeddings, usage rows and the session claim', async () => {
    const s = await rig();
    const mine = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'ann words')]);
    const theirs = await s.ingest(BOB, SRC, SID, [turn('u1', 'user', 'bob words')]);
    await db.insertEmbeddings([{ workspaceId: mine.partitionId, sessionId: mine.sessionId, kind: 'turn', refEventId: null, ts: 1, text: 'ann words', modelId: 'm', dim: EMBED_DIM, vec: Buffer.from(new Float32Array(EMBED_DIM).fill(1 / Math.sqrt(EMBED_DIM)).buffer), dedupKey: 'd1' }]);
    await hostUsageRecorder({ workspaceId: HOSTED, sessionId: mine.sessionId, kind: 'marked-useful' });
    expect(await s.unpublish(ANN, SID)).toBe(1);
    expect(await db.eventsForSession(mine.sessionId)).toEqual([]);
    expect(await db.getSession(mine.sessionId)).toBeNull();
    const k = db.stateKysely();
    expect(await k.selectFrom('embeddings').select('id').where('session_id', '=', mine.sessionId).execute()).toEqual([]);
    expect(await k.selectFrom('usage_events').select('id').where('session_id', '=', mine.sessionId).execute()).toEqual([]);
    expect((await st!.pg!.pool.query(`SELECT session_id FROM ${st!.pg!.schema}.publish_sessions`)).rows).toEqual([{ session_id: theirs.sessionId }]);
    expect(await db.eventsForSession(theirs.sessionId)).toHaveLength(1);
    expect(await s.unpublish(ANN, SID)).toBe(0);
  });
```

Append to `src/host/publishRoute.test.ts`:
- in `fakeStore`, add `unpublish: async (_owner, sid) => (sid === SID ? 1 : 0),` to the `store` object;
- add:

```ts
describe('remove', () => {
  it('validates the id, answers 404 when nothing was published, 200 with the count otherwise', async () => {
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: quiet });
    expect((await r.remove(ann, 'nope')).status).toBe(400);
    expect(await r.remove(ann, '99999999-2222-4333-8444-555555555555')).toEqual({ status: 404, body: { ok: false, error: 'not published' } });
    expect(await r.remove(ann, SID)).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect((await createPublishRoute({ store: () => null, hostSecrets: [], log: quiet }).remove(ann, SID)).status).toBe(503);
  });
});
```

Append inside `describe('POST /publish', …)` in `src/host/server.test.ts` (and add `remove: async () => ({ status: 200, body: { ok: true, removed: 1 } }),` to the `route()` helper's object):

```ts
  it('DELETE /publish/<id> reaches remove with the caller; other methods are refused', async () => {
    const seen: unknown[] = [];
    const r = await start([], { publish: route({ remove: async (c, id) => { seen.push([c.identity.login, id]); return { status: 200, body: { ok: true, removed: 1 } }; } }) });
    const del = (path: string, token?: string) => fetch(`${r.url}${path}`, { method: 'DELETE', headers: token ? bearer(token) : {} });
    expect((await del('/publish/abc')).status).toBe(401);
    expect((await del('/publish/abc', `${TOKEN}r`)).status).toBe(200);
    expect((await del('/publish/%E0%A4%A', `${TOKEN}r`)).status).toBe(400);
    expect((await fetch(`${r.url}/publish/abc`, { headers: bearer(`${TOKEN}r`) })).status).toBe(405);
    expect((await del('/publish', `${TOKEN}r`)).status).toBe(405);
    expect(seen).toEqual([['reader', 'abc']]);
  });
```

Append to `src/main/remoteClient.test.ts`, inside `describe('RemoteClient.publish', …)`. In `publishHost`'s route object add `remove: async (_c, id) => (id === SID ? { status: 200, body: { ok: true, removed: 2 } } : { status: 404, body: { ok: false, error: 'not published' } }),`. Then:

```ts
  it('unpublish returns the removed count and maps 404 to a protocol error', async () => {
    const { client } = await publishHost({});
    expect(await client.unpublish(SID)).toBe(2);
    await expect(client.unpublish('99999999-2222-4333-8444-555555555555')).rejects.toMatchObject({ kind: 'protocol', status: 404 });
    await expect(client.unpublish('../x')).rejects.toMatchObject({ kind: 'protocol' });
  });
```

`src/main/publish/publishIpc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '../remoteClient.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { PUBLISH_CHANNELS, registerPublishIpc, type PublishIpcDeps } from './publishIpc.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const W = '01JC0000000000000000000005';
const R1 = '01JC00000000000000000000R1';
const R2 = '01JC00000000000000000000R2';
const SID = '11111111-2222-4333-8444-555555555555';
const m = (id: string, extra: object) => ({ id, name: id === R1 ? 'review-bot' : id === R2 ? 'ops' : 'mine', kind: 'local', env: { plain: {}, secretKeys: [] }, ...extra }) as unknown as WorkspaceSpec;
const store = new Map<string, WorkspaceSpec>([
  [W, m(W, { publish: { to: [R1, R2], since: { [R1]: 1, [R2]: 1 } } })],
  [R1, m(R1, { kind: 'remote', remote: { url: 'http://one', tier: 'read', login: 'a', checkedAt: 1 } })],
  [R2, m(R2, { kind: 'remote', remote: { url: 'http://two', tier: 'read', login: 'a', checkedAt: 1 } })]
]);

function harness(unpublish: PublishIpcDeps['unpublish']) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const order: string[] = [];
  const deps: PublishIpcDeps = {
    readManifest: async (id) => store.get(id) ?? null,
    unpublish: async (url, sid) => { order.push(`unpublish ${url}`); return unpublish(url, sid); },
    withhold: async (ws, sid) => void order.push(`withhold ${ws} ${sid}`)
  };
  registerPublishIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...a: unknown[]) => unknown) }, deps);
  return { call: (...a: unknown[]) => Promise.resolve(handlers.get('publish:unpublish')!({}, ...a)), handlers, order };
}

describe('publish:unpublish', () => {
  it('registers exactly its channels', () => {
    expect([...harness(async () => 0).handlers.keys()]).toEqual([...PUBLISH_CHANNELS]);
  });

  it('withholds first, then asks every target; 404 counts as nothing to remove; other failures are listed', async () => {
    const h = harness(async (url) => {
      if (url === 'http://two') throw new RemoteError('unreachable', 'http://two is not reachable');
      return 1;
    });
    expect(await h.call(W, SID)).toEqual({ removed: 1, failed: [{ remoteId: R2, name: 'ops', error: 'http://two is not reachable' }] });
    expect(h.order).toEqual([`withhold ${W} ${SID}`, 'unpublish http://one', 'unpublish http://two']);
    const h404 = harness(async () => { throw new RemoteError('protocol', 'not published', 404); });
    expect(await h404.call(W, SID)).toEqual({ removed: 0, failed: [] });
  });

  it('refuses a bad workspace id, a bad session id and a remote workspace', async () => {
    const h = harness(async () => 0);
    await expect(h.call('loadout-source:x', SID)).rejects.toThrow(/workspace id/);
    await expect(h.call(W, 'nope')).rejects.toThrow(/session id/);
    await expect(h.call(R1, SID)).rejects.toThrow(/local or container/);
  });
});
```

Append to `src/renderer/src/components/publishTargets.test.ts`:

```ts
import { unpublishNote } from './publishTargets';

describe('unpublishNote', () => {
  it('says what happened', () => {
    expect(unpublishNote({ removed: 1, failed: [] })).toBe('Unpublished. This session won’t be published again.');
    expect(unpublishNote({ removed: 0, failed: [] })).toBe('Nothing of this session was published. It won’t be published.');
    expect(unpublishNote({ removed: 0, failed: [{ remoteId: 'r', name: 'ops', error: 'ops is not reachable' }] }))
      .toBe('Not yet removed from ops (ops is not reachable). It won’t be published again; try Unpublish once the host is reachable.');
  });
});
```

Append to `src/renderer/src/sessionsView.test.ts`:

```ts
describe('publishTargetsMap', () => {
  it('maps publishing workspaces to their hosts’ names', () => {
    expect(publishTargetsMap([
      { id: 'R', kind: 'remote', name: 'review-bot' },
      { id: 'L', kind: 'local', name: 'mine', publish: { to: ['R', 'gone'], since: { R: 1, gone: 1 } } },
      { id: 'C', kind: 'container', name: 'quiet' }
    ])).toEqual({ L: ['review-bot', 'gone'] });
  });
});
```

and add `publishTargetsMap` to that file's `./sessionsView` import.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
npx vitest run src/host/publishRoute.test.ts src/host/server.test.ts src/main/remoteClient.test.ts src/main/publish/publishIpc.test.ts src/renderer/src/components/publishTargets.test.ts src/renderer/src/sessionsView.test.ts
```
Expected: FAIL. `remove`, `unpublish`, `publishIpc`, `unpublishNote` and `publishTargetsMap` are missing.

- [ ] **Step 3: Implement**

`src/main/db.ts`: replace `deleteSession` with:

```ts
/** A session's rows in every per-session cache table; the caller owns the transaction. */
export async function deleteSessionRows(q: Kysely<StateDb>, id: string): Promise<void> {
  await q.deleteFrom('events').where('session_id', '=', id).execute();
  await q.deleteFrom('session_costs').where('session_id', '=', id).execute();
  await q.deleteFrom('session_stats').where('session_id', '=', id).execute();
  await q.deleteFrom('session_tool_counts').where('session_id', '=', id).execute();
  await q.deleteFrom('broker_sessions').where('claude_session_id', '=', id).execute();
  await q.deleteFrom('embeddings').where('session_id', '=', id).execute();
  await q.deleteFrom('event_retention').where('session_id', '=', id).execute();
  await q.deleteFrom('transcript_offsets').where('session_id', '=', id).execute();
  await q.deleteFrom('sessions').where('id', '=', id).execute();
}

/**
 * Drop a session from the cache entirely: its events, rollups, embeddings,
 * retention watermarks, broker mapping and the session row. The on-disk JSONL is removed by the caller (IPC
 * layer), which knows the host path. Idempotent.
 */
export async function deleteSession(id: string): Promise<void> {
  await kyselyOrThrow().transaction().execute((trx) => deleteSessionRows(trx, id));
  summaryCache.invalidate(id);
  spendCache.clear();
}
```

`src/host/publishStore.ts`:
- change the db import to `import { deleteSessionRows, ingestBatch } from '../main/db.js';`;
- add to `PublishStore`:

```ts
  /** The caller's own copies of `sourceSessionId`, in every partition they own; returns how many were removed. */
  unpublish(owner: PublishOwner, sourceSessionId: string): Promise<number>;
```

- add to the returned object, after `partitionIds`:

```ts
    async unpublish(owner, sourceSessionId) {
      const r = await sql<{ session_id: string }>`
        SELECT s.session_id FROM publish_sessions s JOIN publish_partitions p ON p.partition_id = s.partition_id
        WHERE p.owner_provider = ${owner.provider} AND p.owner_id = ${String(owner.id)} AND s.source_session_id = ${sourceSessionId}
        ORDER BY s.session_id`.execute(k());
      for (const { session_id: id } of r.rows) {
        await k().transaction().execute(async (trx) => {
          await deleteSessionRows(trx, id);
          await trx.deleteFrom('usage_events').where('session_id', '=', id).execute();
          await sql`DELETE FROM publish_sessions WHERE session_id = ${id}`.execute(trx);
        });
      }
      return r.rows.length;
    }
```

`src/host/publishRoute.ts`:
- `import { parsePublishBody, PublishArgError, SESSION_UUID_RE, type PublishOwner } from '../main/publish/protocol.js';`
- add to `PublishRoute`:

```ts
  remove(caller: Principal, sessionId: string): Promise<RouteReply>;
```

- add to the returned object, after `post`:

```ts
    async remove(caller, sessionId) {
      if (!SESSION_UUID_RE.test(sessionId)) return { status: 400, body: { ok: false, error: 'not a session id' } };
      const store = o.store();
      if (!store) return { status: 503, body: { ok: false, error: 'publish unavailable' }, headers: { 'Retry-After': '5' } };
      try {
        const removed = await store.unpublish(ownerOf(caller), sessionId);
        o.log.log('info', 'unpublish', { login: caller.identity.login, sessionId, removed });
        return removed ? { status: 200, body: { ok: true, removed } } : { status: 404, body: { ok: false, error: 'not published' } };
      } catch (err) {
        return failureReply(err);
      }
    }
```

`src/host/server.ts`:
- `import type { PublishRoute, RouteReply } from './publishRoute.js';`
- in `handle()`, replace the `isPublish` line and the method check with:

```ts
    const isPublish = !!deps.publish && (path === '/publish' || path.startsWith('/publish/'));
    if (path !== '/whoami' && !isRpc && !isPublish && path !== '/attach' && path !== '/events') {
      sendJson(res, 404, { error: 'not found' });
      return null;
    }
    const method = isRpc || path === '/publish' ? 'POST' : isPublish ? 'DELETE' : 'GET';
    if (req.method !== method) {
      sendJson(res, 405, { error: 'method not allowed' });
      return null;
    }
```

- change the dispatch call to `await handlePublish(req, res, path, auth);`;
- replace `handlePublish` with:

```ts
  async function handlePublish(req: IncomingMessage, res: ServerResponse, path: string, caller: Principal): Promise<void> {
    const route = deps.publish as PublishRoute;
    const adm = route.admit(caller);
    if (!adm.ok) {
      // The body wasn't read: don't let it be parsed as the next request on this connection.
      res.setHeader('Connection', 'close');
      return sendJson(res, adm.status, { ok: false, error: adm.error }, adm.retryAfterSec !== undefined ? { 'Retry-After': String(adm.retryAfterSec) } : {});
    }
    try {
      let r: RouteReply;
      if (path === '/publish') {
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
          return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
        }
        const raw = await readBody(req, MAX_PUBLISH_BODY);
        if (!raw) {
          res.setHeader('Connection', 'close');
          return sendJson(res, 413, { ok: false, error: 'body too large' });
        }
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { ok: false, error: 'body is not JSON' });
        }
        r = await route.post(caller, body);
      } else {
        let id: string;
        try {
          id = decodeURIComponent(path.slice('/publish/'.length));
        } catch {
          return sendJson(res, 400, { ok: false, error: 'not a session id' });
        }
        r = await route.remove(caller, id);
      }
      sendJson(res, r.status, r.body, r.headers);
    } finally {
      adm.release();
    }
  }
```

`src/preload/publish.ts`: append:

```ts
export interface UnpublishResult {
  removed: number;
  /** Hosts that couldn't be reached or refused; the session is withheld from publishing regardless. */
  failed: { remoteId: string; name: string; error: string }[];
}
```

`src/main/remoteClient.ts`:
- change the protocol import to `import { PUBLISH_MAX_BODY, SESSION_UUID_RE, type PublishAck, type PublishBatch } from './publish/protocol.js';`;
- add after `publish()`:

```ts
  async unpublish(sessionId: string): Promise<number> {
    if (!SESSION_UUID_RE.test(sessionId)) throw new RemoteError('protocol', 'not a session id');
    const r = (await this.request(`/publish/${sessionId}`, { method: 'DELETE', auth: true, maxBody: MAX_SMALL_BODY })) as { ok?: unknown; removed?: unknown } | null;
    if (r?.ok !== true || typeof r.removed !== 'number') throw new RemoteError('protocol', `${this.url} unpublish failed`);
    return r.removed;
  }
```

`src/main/publish/publishIpc.ts`:

```ts
// publish:unpublish: withdraw one session from every host its workspace publishes to (remote-workspaces §13 Q4).
import type { UnpublishResult } from '../../preload/publish.js';
import type { IpcHandleLike } from '../vaultIpc.js';
import { assertRendererWorkspaceId } from '../vaultScopes.js';
import { oneLine, RemoteError } from '../remoteClient.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { SESSION_UUID_RE } from './protocol.js';

export const PUBLISH_CHANNELS = ['publish:unpublish'] as const;

export interface PublishIpcDeps {
  readManifest(id: string): Promise<WorkspaceSpec | null>;
  unpublish(url: string, sessionId: string): Promise<number>;
  withhold(workspaceId: string, sessionId: string): Promise<void>;
}

export function registerPublishIpc(ipc: IpcHandleLike, d: PublishIpcDeps): void {
  ipc.handle('publish:unpublish', async (_e, workspaceId: unknown, sessionId: unknown): Promise<UnpublishResult> => {
    assertRendererWorkspaceId(workspaceId);
    if (typeof sessionId !== 'string' || !SESSION_UUID_RE.test(sessionId)) throw new Error('publish:unpublish needs a session id');
    const spec = await d.readManifest(workspaceId as string);
    if (!spec || spec.kind === 'remote') throw new Error('publish:unpublish needs a local or container workspace');
    // First, so a host that is down now can't receive this session's later events.
    await d.withhold(spec.id, sessionId);
    const out: UnpublishResult = { removed: 0, failed: [] };
    for (const target of spec.publish?.to ?? []) {
      const remote = await d.readManifest(target);
      if (remote?.kind !== 'remote' || !remote.remote) continue;
      try {
        out.removed += await d.unpublish(remote.remote.url, sessionId);
      } catch (err) {
        if (err instanceof RemoteError && err.status === 404) continue;
        out.failed.push({ remoteId: target, name: remote.name, error: oneLine((err as Error).message, 200) });
      }
    }
    return out;
  });
}
```

`src/main/ipc.ts`:
- `import { registerPublishIpc } from './publish/publishIpc.js';`
- add `withholdSession,` to the `./db.js` import;
- after the publisher wiring block (outside the `if`, so the channel always exists):

```ts
  registerPublishIpc(ipcMain, {
    readManifest: readWorkspaceManifest,
    unpublish: (url, sessionId) => remoteBackend.clientFor(url).unpublish(sessionId),
    withhold: withholdSession
  });
```

`src/preload/index.ts`:
- `import type { UnpublishResult } from './publish';` and `export type { UnpublishResult, WorkspacePublish } from './publish';`;
- after the `remote: { … },` namespace:

```ts
  publish: {
    /** Withdraw a session from every host its workspace publishes to; it is never published again. */
    unpublish: (workspaceId: string, sessionId: string): Promise<UnpublishResult> =>
      ipcRenderer.invoke('publish:unpublish', workspaceId, sessionId)
  },
```

`src/renderer/src/components/publishTargets.ts`: append:

```ts
import type { UnpublishResult } from '../../../preload/publish';

export function unpublishNote(r: UnpublishResult): string {
  if (r.failed.length) {
    const names = r.failed.map((f) => f.name).join(', ');
    return `Not yet removed from ${names} (${r.failed[0].error}). It won’t be published again; try Unpublish once the host is reachable.`;
  }
  return r.removed ? 'Unpublished. This session won’t be published again.' : 'Nothing of this session was published. It won’t be published.';
}
```

Put the `import type` line at the top of the file with the other imports.

`src/renderer/src/sessionsView.ts`: after `remoteNamesMap`:

```ts
/** Local or container workspace id → names of the remote workspaces it publishes to. */
export function publishTargetsMap(
  workspaces: ReadonlyArray<{ id: string; kind: string; name: string; publish?: { to: string[] } }>
): Record<string, string[]> {
  const names = remoteNamesMap(workspaces);
  const out: Record<string, string[]> = {};
  for (const w of workspaces) {
    if (w.kind === 'remote' || !w.publish?.to.length) continue;
    out[w.id] = w.publish.to.map((id) => names[id] ?? id);
  }
  return out;
}
```

`src/renderer/src/components/LeftRail.tsx`:
- the import becomes `import { publishTargetsMap, remoteNamesMap, remoteResumeMap } from '../sessionsView';`;
- after the `remoteNames` memo:

```ts
  const publishTargets = useMemo(() => publishTargetsMap(workspaces), [workspaces]);
```

- pass `publishTargets={publishTargets}` to `<SessionsPane …>` after `remoteNames={remoteNames}`.

`src/renderer/src/components/SessionsPane.tsx`:
- `import { unpublishNote } from './publishTargets';`
- in `Props`, after `remoteNames?`:

```ts
  /** Workspace id → names of the hosts it publishes to; its rows offer Unpublish. */
  publishTargets?: Record<string, string[]>;
```

- add `publishTargets,` to the destructured props after `remoteNames,`;
- state, next to the other `useState` calls:

```ts
  const [publishNote, setPublishNote] = useState<string | null>(null);
```

- handler, next to `commitRename`:

```ts
  const unpublish = async (s: SessionListItem): Promise<void> => {
    try {
      setPublishNote(unpublishNote(await window.api.publish.unpublish(s.workspaceId, s.id)));
    } catch (err) {
      setPublishNote(`Unpublish failed: ${String(err)}`);
    }
  };
```

- render, directly after `{unavailableNote && <div className="sessions-unavailable subdued">{unavailableNote}</div>}`:

```tsx
        {publishNote && <div className="sessions-unavailable subdued" role="status">{publishNote}</div>}
```

- in the row menu's `{!isRemoteRow(s) && (<>`, after the Rename `</button>` and before the divider:

```tsx
                  {(publishTargets?.[s.workspaceId]?.length ?? 0) > 0 && (
                    <button
                      role="menuitem"
                      title={`Remove from ${publishTargets![s.workspaceId].join(', ')} and never publish it again`}
                      onClick={() => {
                        closeRowMenu();
                        void unpublish(s);
                      }}
                    >
                      <IconTrash />
                      <span>Unpublish</span>
                    </button>
                  )}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
```bash
npx vitest run src/host src/main/remoteClient.test.ts src/main/publish src/renderer/src/components/publishTargets.test.ts src/renderer/src/sessionsView.test.ts src/main/db.test.ts src/main/dbPurgeWorkspace.test.ts
```
Expected: PASS. `deleteSession`'s existing tests still pass.

Run `PG_TEST_URL=<url> npx vitest run -c vitest.pg.config.ts src/host/publishStore.pg.test.ts src/main/db.test.ts`.
Expected: PASS.

Typecheck: run `npx tsc --noEmit -p tsconfig.node.json`, then `npx tsc --noEmit -p tsconfig.web.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/host/publishStore.ts src/host/publishStore.pg.test.ts src/host/publishRoute.ts src/host/publishRoute.test.ts src/host/server.ts src/host/server.test.ts src/preload/publish.ts src/main/remoteClient.ts src/main/remoteClient.test.ts src/main/publish/publishIpc.ts src/main/publish/publishIpc.test.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/components/publishTargets.ts src/renderer/src/components/publishTargets.test.ts src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts src/renderer/src/components/LeftRail.tsx src/renderer/src/components/SessionsPane.tsx
git commit -m "feat(publish): owner-only unpublish on the host and the Sessions pane"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit and Postgres suites, both typechecks. |
| CI | All suites. |
| Host eyeball | The ⋮ menu of a publishing workspace's session shows Unpublish; the note reads correctly with the host up and down. |
| Cluster | After an unpublish, the session's `pub_…` rows and embeddings are gone and the other owners' copies remain. |

---

### Task 11: SPEC.md

**Files:**
- Modify `docs/SPEC.md`.

**Interfaces:**
- Consumes: Tasks 1–10 as built.

- [ ] **Step 1: §6 IPC — add a *Publish* subsection**

Directly before the line `### PTY`, insert:

```markdown
### Publish
Withdraw published transcripts (`src/main/publish/publishIpc.ts`, types `src/preload/publish.ts`). Publishing has no channel of its own: it follows the manifest's `publish` block (§7 *Transcript publish*).
- `publish:unpublish(workspaceId, sessionId)` → `{ removed, failed: { remoteId, name, error }[] }`.
  - **Arguments:** `workspaceId` must be renderer-valid and name a local or container workspace. `sessionId` must be a lowercase UUID.
  - **Order:** main first records the session in `publish_withheld`, so its later events are never published. It then sends `DELETE /publish/<sessionId>` to every current target.
  - **Results:** a 404 counts as nothing to remove. Any other failure is listed, with its error as one line of at most 200 chars.
  - **UI:** the Sessions pane's row ⋮ menu offers **Unpublish** on rows of a workspace that publishes.

```

- [ ] **Step 2: §7 *Workspace manifest* — the `publish` field**

After the line beginning `  mounts?: { hostPath: string; containerPath: string; readOnly: boolean }[];`, insert:

```
  publish?: { to: string[]; since: Record<string, number> }; // local/container only: remote workspace ids this workspace publishes transcripts to; since[id] = epoch ms that target was turned on (set by main, never the renderer)
```

- [ ] **Step 3: §7 *JSONL→SQLite cache* — the v19 schema**

In the schema code block, after `CREATE INDEX idx_transcript_offsets_session ON transcript_offsets(session_id);` and before the closing fence, insert:

```sql

-- v19: transcript publish, see *Transcript publish*.
ALTER TABLE usage_events ADD COLUMN origin TEXT;  -- host only: workspace of the session the signal is about (hosted id or publish partition)
CREATE TABLE publish_cursors (
  source_workspace_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  last_event_id       INTEGER NOT NULL,   -- last event id the target acked
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (source_workspace_id, target_workspace_id)
);
CREATE TABLE publish_withheld (           -- unpublished sessions: never published again
  session_id   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  withheld_at  INTEGER NOT NULL
);
CREATE INDEX idx_publish_withheld_workspace ON publish_withheld(workspace_id);
```

- [ ] **Step 4: §7 — a new *Transcript publish* subsection**

Directly before `### Remote host (\`fleet-host\`)`, insert:

```markdown
### Transcript publish
A person's local or container workspace can publish its transcripts to remote workspaces (remote-workspaces (e)). This is the one deliberate cross-boundary write. Nothing a host holds comes back to the desktop, and remote reads stay live-only.

- **Opt-in.**
  - The Edit form's "Publish transcripts to…" lists the bookmarked remote workspaces. Each says "Visible to everyone with read on *host* and to its sessions". It is off by default.
  - `workspace:writeManifest` derives `publish` (`publishOnWrite`):
    - targets must be remote bookmarks, at most 16;
    - a target already on keeps its `since`, and a new one gets the current time;
    - a `since` sent by the renderer is ignored;
    - a spec without the `publish` key keeps the stored block (the Saved-tab resume and the committee rail don't send it);
    - removing a target drops its cursor.
- **What is sent.**
  - The events of sessions whose `started_at` ≥ `since[target]`, in event-id order, after the `publish_cursors` row for (workspace, target).
  - Skipped, with the cursor still advancing past them:
    - sessions in `publish_withheld`;
    - non-UUID session ids;
    - a line too large for a 1 MiB batch on its own.
  - Earlier sessions are never sent.
- **Scrub before send** (`publish/scrub.ts`, shared with the host).
  - **Values:** every vault secret of the workspace, plus the signed-in GitHub token, becomes `[redacted:<KEY>]`.
    - Each `env.secretKeys` entry must be readable; otherwise nothing is sent.
    - Values of at least 8 chars, longest first, in raw and JSON-escaped form.
  - **Patterns** become `[redacted]`: the `redactSecrets` token shapes, AWS `AKIA…`/`ASIA…` keys, and `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD` assignments.
  - **Passes:** each string of the decoded line is scrubbed, then the serialized line again. A clean line keeps its bytes.
  - **Type gate:** `RemoteClient.publish` accepts only `ScrubbedLine`.
- **Publisher** (`publish/publisher.ts`, main).
  - **When:** 2 s after the first `ingest` event of a quiet period, and every 60 s. One pass runs per (workspace, target) at a time.
  - **Batches:** pages of 500 events. Each batch is consecutive same-session lines, at most 500 lines and 1 MiB, sent as `{ sourceWorkspaceId, sessionId, events }`.
  - **Cursor:** after each ack it moves to the batch's last event id.
  - **Errors:**

    | Reply | Action |
    |---|---|
    | 400, 409, 413 | The batch is skipped and logged. |
    | signed out, 401, 403 | Retry in 5 min. |
    | anything else | Back off 5 s, 15 s, 60 s, 5 min, or by `Retry-After` when it is longer. |

  - **Logs**, each once per state change: `publish-failed`, `publish-batch-refused`, `publish-line-skipped`, `publish-scrub-unavailable`, `publish-recovered`.
- **Cursors are a cache.**
  - The SQLite → Postgres import copies them; the user-state merge doesn't. After a store switch they restart at 0, and the host's dedup keys absorb the resend.
  - `publish_withheld` is merged.
  - `purgeWorkspace` drops both.
- **On the host:** see *Remote host*, *Publish*.

```

- [ ] **Step 5: §7 *Remote host* — the routes, *Publish*, and the *Host MCP* edits**

Routes table: after the row starting `| \`GET /events\` (WS) |`, insert:

```markdown
| `POST /publish` | Bearer | any grant; people only | JSON ≤ 1 MiB; *Publish* |
| `DELETE /publish/<sessionId>` | Bearer | any grant; people only | the caller's own copies only; *Publish* |
```

Directly before the paragraph starting `**Verify limits**`, insert:

```markdown
**Publish** (`publishRoute.ts`, `publishStore.ts`). Present only with `db:`; without it the route is 404.

- **Admission, before the body is read:**
  - machine identities get 403 `publishing is for people, not machine identities`;
  - per identity: one request in flight (429, `Retry-After: 1`) and a token bucket of 20 burst refilling 2 per second (429 with `Retry-After`);
  - host-wide: 4 in flight (503, `Retry-After: 1`);
  - a refusal closes the connection.
- **`POST /publish` body.**
  - It must be `application/json` (else 415) and at most 1 MiB (else 413).
  - It is exactly `{ sourceWorkspaceId: ULID, sessionId: lowercase UUID, events: 1–500 single-line JSON objects }`. Any other key is a 400.
  - The host scrubs every line again with the shared scrubber, plus its own secret values (computed at start):
    - env vars whose names end in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or `CREDENTIAL(S)`;
    - the store's `storeSecretEnvNames`;
    - the password in any `postgres://` value among them.
- **The partition comes only from the verified identity.**
  - `partition_id` = `pub_` + 32 hex characters of `sha256("<provider>:<account id>\0<sourceWorkspaceId>")`.
  - The stored session id is a UUID-shaped sha256 of (`partition_id`, source session id).
  - `ingestBatch` stores the rows under those ids in one fenced transaction, with `statement_timeout` 5 s. Dedup keys make a resend a no-op, and nothing updates an event row.
- **The transaction first claims the session.**
  - A `sessions` row with that id in another workspace is a 409.
  - It upserts `publish_partitions` (`partition_id`, `owner_provider`, `owner_id`, `owner_login`, `source_workspace_id`). `owner_login` is refreshed on each publish.
  - It upserts `publish_sessions` (`session_id`, `partition_id`, `source_session_id`, first and last published). Both tables are host migration track v2.
- **Reply** `{ ok: true, accepted, inserted }`.
  - A fenced-off holder is 503 `standby`; a statement timeout is 503 `publish busy`.
  - The log line carries the login, ids and counts, never content.
- **Indexing:** a request that inserted rows bumps the holder's indexer for that session. The start-up backfill covers partitions like hosted sessions.
- **`DELETE /publish/<sessionId>`** (same admission) removes that source session from every partition the caller owns, one transaction per stored session:
  - events, rollups and embeddings (`deleteSessionRows`);
  - its `usage_events`;
  - its `publish_sessions` row.

  It answers 200 `{ ok: true, removed }` or 404 `not published`. Nothing else deletes or updates published rows. The host keeps them until then; there is no retention yet.
- **Visibility.**
  - The host MCP's read scope is the hosted workspace plus every `publish_partitions` id, read on each call.
  - `history:*` stays hosted-only.
  - `publish_partitions` and `publish_sessions` get no grant, so `query` can't read them.

```

In *Host MCP*, make these replacements:
- `Published partitions and cross-host committee grants are later.` → `Every publish partition widens it (*Publish*), read from \`publish_partitions\` on each call; cross-host committee grants are later.`
- `**Tools** (\`HOST_MCP_TOOLS\`, 14): \`list_sessions\`, \`get_session\`, \`get_cost\`, \`list_events\`, \`session_summary\`, \`query\` (on the holder's state store);` → `**Tools** (\`HOST_MCP_TOOLS\`, 15): \`list_sessions\`, \`get_session\`, \`get_cost\`, \`list_events\`, \`session_summary\`, \`query\`, \`mark_useful\` (on the holder's state store);`
- `adds \`search_transcripts\` (15)` → `adds \`search_transcripts\` (16)`
- `(\`pgSearchEmbeddings\`, scope \`{hosted}\`)` → `(\`pgSearchEmbeddings\`, scope \`{hosted}\` plus partitions)`
- `` `notify` and the proposal tools ((g)), `mark_useful` ((e)), `` → `` `notify` and the proposal tools ((g)), ``
- `caller = the hosted workspace, scope = \`{hosted}\`` → `caller = the hosted workspace, scope = \`{hosted}\` plus every partition (written to \`mcp_grants\` on each call)`

Then add this sentence at the end of the **Tools** bullet:

```markdown
`mark_useful`, and `search_transcripts`' impressions and clickthroughs, are recorded by `hostUsageRecorder` with `usage_events.origin` = the session's workspace (the hosted id or a partition). `usefulMarkCounts` counts a `marked-useful` only when `origin` is set and differs from the marker's `workspace_id`. So the workspace marking its own sessions doesn't count, and marks on published sessions do. The desktop writes no origin.
```

- [ ] **Step 6: §8 — the user flow**

Directly before `### Manage per-workspace env vars`, insert:

```markdown
### Publish transcripts to a remote workspace
1. Edit a local or container workspace and open **Publish transcripts to…**.
2. Tick one or more remote workspaces, then Save.

From then on, sessions that start in this workspace are scrubbed and sent to those hosts as they are ingested. Earlier sessions never are.

To withdraw one session, open its ⋮ menu in the Sessions pane and choose **Unpublish**.
- The current target hosts drop it, and it is never published again.
- A host that can't be reached is named in the note, and Unpublish can be repeated.

Turning a host off stops further sends. Rows already published stay on that host until they are unpublished while it is still a target.

```

- [ ] **Step 7: §9 — the security bullet**

Directly before the line starting `- **The embedder sidecar parses session-written transcript text**`, insert:

```markdown
- **Transcript publish crosses the network only for opted-in workspaces, and it is scrubbed on both sides** (§7 *Transcript publish*, *Remote host* → *Publish*).
  - **Desktop:** it scrubs before sending (vault values, the GitHub token and token shapes). It fails closed when a declared secret can't be read.
  - **Host:** it scrubs again, with its own secret values too.
  - **Ownership:** the partition comes only from the verified identity. A body can't name an owner, a partition or a stored session id.
  - **Writes:** publish is append-only except the owner's `DELETE /publish/<sessionId>`.
  - **Readers:** published rows are readable by everyone with read on the host (through its sessions) and by the host sessions' MCP, `query` included.
  - **Limit:** scrubbing is by pattern and by value, so a secret that matches neither is published.
```

- [ ] **Step 8: §11 *Remote host: what remains***

After the `**Host checklist for the two-pod split:**` bullet, insert:

```markdown
- **Publish follow-ups:**
  - retention of published rows (there is none; they are kept until unpublished);
  - `history:*` visibility of partitions to desktop viewers, deduplicated against the publisher's own rows;
  - a publisher-facing, counts-only signals channel;
  - consumers of `usefulMarkCounts` (ranking, retention).
- **Host checklist for (e):**
  - a 1 MiB `POST /publish` passes the ALB, the gateway and the sidecar;
  - `fleet-host migrate` reports `host` 2 and `state` 19;
  - a session's `list_sessions` and `search_transcripts` show a published session;
  - `query` can read `sessions` rows of a `pub_…` workspace but not `publish_partitions`.
```

- [ ] **Step 9: Check and commit**

Run `command grep -an 'mark_useful\` ((e))\|HOST_MCP_TOOLS\`, 14' docs/SPEC.md`.
Expected: no output.

```bash
git add docs/SPEC.md
git commit -m "docs(spec): remote (e) transcript publish"
```

**Verification:**

| Where | What |
|---|---|
| Local | The grep above; a read-through of each inserted section against Tasks 1–10. |

---

### Task 12: Full gate and handoff

**Files:**
- None new.

- [ ] **Step 1: Typecheck both configs separately**

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no output.

Run `npx tsc --noEmit -p tsconfig.web.json`.
Expected: no output.

- [ ] **Step 2: Unit suite**

Run `npx vitest run`.
Expected: all pass. The flaky `jsonlWatcher.ordering` test (#510) may need one re-run.

- [ ] **Step 3: Postgres suite**

```bash
scripts/pg-test-server.sh start
export PG_TEST_URL=<the URL it printed>
npm run test:unit:pg
scripts/pg-test-server.sh stop
```

Expected: all pass, including:
- `schemaParity`;
- `hostSchema.pg`, `publishStore.pg`, `hostQuery.pg` and `main.pg`;
- `dbPublish` and `dbUsefulMarks`.

- [ ] **Step 4: Build**

Run `npm run build`.
Expected: success.

Run `npx vitest run src/host/importGraph.test.ts`.
Expected: PASS. The host bundle pulls in no Electron.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/remote-e-publish
gh pr create --title "feat: remote (e) transcript publish" --body "<factual summary: what changed per task, the SPEC sections, how to test; state that UI is unverified in the container (no display) and that host-side behaviour behind the gateway needs the (e) host checklist>"
gh pr merge --auto --squash <n>
```

- [ ] **Step 6: Hand the cluster checks to Work**

Post the SPEC §11 "Host checklist for (e)" items to `/shared/remote-agent-design/threads/001-kickoff.md`, with the PR URL. The gateway or ALB body-size limit (≥ 1 MiB plus headers) is the one infra-side item.

**Verification:**

| Where | What |
|---|---|
| Local | Steps 1–4. |
| CI | The full gate, including Playwright. |
| Host eyeball (Troy) | The form control, Unpublish, and a real publish to a dev host. |
| Cluster (Work) | The (e) checklist. |

---

## Self-Review

**Spec coverage** (spec §7 *One-way transcript publish*, §9, §11 item 5, §12 (e), §13 Q4):

| Requirement | Task |
|---|---|
| Opt-in per workspace, `publish` block, Edit-form control, off by default | Task 9 (D104) |
| Visibility wording | Task 9, `publishVisibility` |
| Client scrub: vault values + GitHub token → `[redacted:<KEY>]` | Tasks 2 and 8 |
| Client scrub: the spec's token patterns | Task 2 |
| Before anything leaves | Task 8 scrubs inside `pass` before `publish`; `ScrubbedLine` gates `RemoteClient.publish` |
| Server scrub repeats the patterns and adds host secret values | Task 4, `createPublishRoute` and `hostSecretValues` (D103) |
| Partition from the verified identity, never the body | Task 2 (`partitionIdFor` takes only the owner); Task 4 (`ownerOf(caller)`, unknown body keys 400); Task 3 (derived session id, conflict 409) |
| Batches ≤ 1 MiB, resume-from-last-acked cursor | Task 2 (`PUBLISH_MAX_BODY`), Task 4 (server cap), Task 7 (cursor), Task 8 (`planBatches`) |
| Idempotent inserts on (owner, session, dedup key) | Task 3: the derived session id encodes the owner; `events UNIQUE(session_id, dedup_key)` |
| No update path; append-only except owner unpublish | Task 3 (insert only); Task 10 (DELETE, D109) |
| Per-identity rate limit | Task 4, `PublishGate` |
| Host embeds published rows | Task 5 (live bump and backfill) |
| MCP visibility of partitions | Task 6 (scope resolver) |
| D71 `query` RLS includes partitions, excludes the bookkeeping tables | Task 6, `hostQuery.pg.test.ts` |
| `usage_events.origin` and the own-marks rule | Task 6 (D108) |
| Nothing flows back | D62 note; the client only reads acks |
| §13 Q4 unpublish | Task 10 |
| SPEC sections the spec names | Task 11 (§7 manifest, tables and origin; §9; §11 MCP visibility and counting rule) |

**Deliberate narrowing:**
- `history:*` stays hosted-only (D107), so the spec's "visible to everyone with read on host" holds through the host's sessions, not the desktop's federated views.
- No retention of published rows (D110).
- No publisher-facing stats (D108).

All three are listed in SPEC §11 for a later sub-project.

**Placeholder scan:**
- No "TBD" or "similar to".
- Each code step shows its code.
- The PR body in Task 12 is described rather than literal on purpose, since it summarises the finished diff.

**Type consistency:**
- `PublishOwner { provider, id, login }` is used by `partitionIdFor` (via `Pick`), `publishStore` and `ownerOf`.
- `PublishStore.ingest(owner, sourceWorkspaceId, sourceSessionId, lines: readonly ScrubbedLine[])` matches its Task 4 caller (`req.events.map(scrub)` returns `ScrubbedLine[]`).
- `PublishRoute` grows `remove` in Task 10. The Task 4 test fakes add it in Task 10.
- `RouteReply`, `Admission`, `failureReply` and `ownerOf` are exported from `publishRoute.ts`, and Task 10 uses them.
- `WorkspaceSpec` is assignable to `PublisherManifest` before and after Task 9 (its `publish` is optional on both), so the wiring needs no cast.
- `UnpublishResult` is defined in Task 10 in `src/preload/publish.ts`. Its users are `publishIpc.ts`, `preload/index.ts` and `publishTargets.ts`.
- `setUsageRecorder(null)` comes from Task 6's signature change.
- Host tool counts are 15, or 16 with search, in both `hostMcp.test.ts` and SPEC.
