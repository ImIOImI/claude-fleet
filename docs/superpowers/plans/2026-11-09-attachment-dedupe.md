# state.db attachment dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each distinct `attachment` payload in state.db once (SHA-256 keyed, deflated), keep a marker plus `att_ref` on the event row, and rebuild the original line byte-for-byte on every read.

**Architecture:** A pure codec (`state/attachmentCodec.ts`) turns a line into `{ stored, ref, payload }` and splices it back. SQLite ingest and a retention backfill step write `event_blobs` rows with a refcount; an `AFTER DELETE` trigger releases them. Readers join `event_blobs` and call `expandLine`. Postgres mirrors the schema but never dedupes.

**Tech Stack:** TypeScript, Kysely (SQLite + Postgres dialects), better-sqlite3, node:zlib, node:crypto, vitest.

Spec: `docs/superpowers/specs/2026-11-09-attachment-dedupe-design.md` (#542).

## Global Constraints

- Dedupe on SQLite only; Postgres step 17 mirrors `events.att_ref` + `event_blobs` for schema parity and leaves them empty.
- Payload threshold: `JSON.stringify(parsed.attachment)` ≥ 1,024 bytes; any attachment type.
- Marker: `{"fleetRef":"<sha256 hex>"}`; never `String.prototype.replace` (payloads contain `$`).
- A line is deduped only if the rebuild equals the original (checked at write).
- `dedup_key` stays computed from the original line.
- No `events(att_ref)` index; refs counted in app code on write, released by trigger on delete.
- Never block the main thread: backfill runs in retention slices (≤200 rows, ≤2 MB).
- SPEC.md updated in the same commit as each data-model change.
- Test commands: `npx vitest run <files>`; `npm run typecheck:node` and `npm run typecheck:web` separately.

---

### Task 1: Attachment codec

**Files:**
- Create: `src/main/state/attachmentCodec.ts`
- Test: `src/main/state/attachmentCodec.test.ts`

**Interfaces:**
- Produces: `ATTACHMENT_MIN_BYTES = 1024`; `dedupeAttachment(line: string, parsed?: Record<string, unknown>): { stored: string; ref: string; payload: string } | null`; `expandLine(stored: string, ref: string | null, bodyZ: Uint8Array | null, strict?: boolean): string`; `deflatePayload(payload: string): Buffer`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MIN_BYTES, dedupeAttachment, deflatePayload, expandLine } from './attachmentCodec.js';

const att = (payload: unknown) => JSON.stringify({ parentUuid: 'p', type: 'attachment', attachment: payload, uuid: 'u', timestamp: '2026-11-01T00:00:00Z' });
const big = { type: 'instructions', content: 'x'.repeat(ATTACHMENT_MIN_BYTES) };

describe('attachment codec', () => {
  it('round-trips a large payload byte-for-byte', () => {
    const line = att(big);
    const d = dedupeAttachment(line)!;
    expect(d.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(d.stored).toBe(line.replace(JSON.stringify(big), `{"fleetRef":"${d.ref}"}`));
    expect(JSON.parse(d.stored).attachment).toEqual({ fleetRef: d.ref });
    expect(expandLine(d.stored, d.ref, deflatePayload(d.payload))).toBe(line);
  });
  it('same payload, same ref', () => {
    expect(dedupeAttachment(att(big))!.ref).toBe(dedupeAttachment(att(big).replace('"u"', '"v"'))!.ref);
  });
  it('skips small payloads, non-attachments, non-JSON and marker collisions', () => {
    expect(dedupeAttachment(att({ type: 'x', content: 'small' }))).toBeNull();
    expect(dedupeAttachment(JSON.stringify({ type: 'user', attachment: big }))).toBeNull();
    expect(dedupeAttachment('{not json')).toBeNull();
    expect(dedupeAttachment(att({ ...big, note: '"fleetRef":"' }))).toBeNull();
  });
  it('skips a payload whose text is not what JSON.stringify produces', () => {
    const line = att(big).replace('"instructions"', '"instructi\\u006fns"');
    expect(dedupeAttachment(line)).toBeNull();
  });
  it('keeps $ patterns literal', () => {
    const line = att({ type: 'instructions', content: `$& $1 $$ ${'y'.repeat(ATTACHMENT_MIN_BYTES)}` });
    const d = dedupeAttachment(line)!;
    expect(expandLine(d.stored, d.ref, deflatePayload(d.payload))).toBe(line);
  });
  it('a missing or corrupt body reads as the stored form; strict throws', () => {
    const d = dedupeAttachment(att(big))!;
    expect(expandLine(d.stored, d.ref, null)).toBe(d.stored);
    expect(expandLine(d.stored, d.ref, Buffer.from('junk'))).toBe(d.stored);
    expect(() => expandLine(d.stored, d.ref, Buffer.from('junk'), true)).toThrow();
    expect(expandLine('plain', null, null)).toBe('plain');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/state/attachmentCodec.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// Attachment payload dedupe codec (SPEC §7 *Attachment dedupe*): replace a
// line's `attachment` value with a hash marker, and splice it back. Pure: no DB.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ATTACHMENT_MIN_BYTES = 1024;
const MARKER_KEY = '"fleetRef":"';
const marker = (ref: string): string => `{${MARKER_KEY}${ref}"}`;

function splice(s: string, at: number, len: number, insert: string): string {
  return s.slice(0, at) + insert + s.slice(at + len);
}

/** The stored form of an attachment line with a large payload, or null when
 *  the line is not one or would not rebuild exactly. */
export function dedupeAttachment(line: string, parsed?: Record<string, unknown>): { stored: string; ref: string; payload: string } | null {
  let o = parsed;
  if (!o) {
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  }
  if (!o || o.type !== 'attachment' || o.attachment === undefined) return null;
  const payload = JSON.stringify(o.attachment);
  if (Buffer.byteLength(payload, 'utf8') < ATTACHMENT_MIN_BYTES || line.includes(MARKER_KEY)) return null;
  const key = `"attachment":${payload}`;
  const at = line.indexOf(key);
  if (at < 0 || line.indexOf(key, at + 1) >= 0) return null;
  const ref = createHash('sha256').update(payload, 'utf8').digest('hex');
  const stored = splice(line, at + '"attachment":'.length, payload.length, marker(ref));
  return rebuild(stored, ref, payload) === line ? { stored, ref, payload } : null;
}

function rebuild(stored: string, ref: string, payload: string): string | null {
  const m = marker(ref);
  const at = stored.indexOf(m);
  return at < 0 ? null : splice(stored, at, m.length, payload);
}

export function deflatePayload(payload: string): Buffer {
  return deflateSync(Buffer.from(payload, 'utf8'), { level: 6 });
}

/** The original line. A missing or corrupt body reads as the stored form
 *  (valid JSON with the marker); `strict` throws instead. */
export function expandLine(stored: string, ref: string | null, bodyZ: Uint8Array | null, strict = false): string {
  if (!ref) return stored;
  try {
    if (!bodyZ || bodyZ.length === 0) throw new Error(`attachment blob ${ref} missing`);
    const out = rebuild(stored, ref, inflateSync(bodyZ).toString('utf8'));
    if (out === null) throw new Error(`attachment marker ${ref} not found`);
    return out;
  } catch (e) {
    if (strict) throw e;
    return stored;
  }
}
```

- [ ] **Step 4: Run** the test again — expect PASS.
- [ ] **Step 5: Commit** `feat(state): attachment payload dedupe codec (#542)`.

### Task 2: Schema v17 (SQLite + Postgres step 17) and delete trigger

**Files:**
- Modify: `src/main/db.ts` (migrate(): v17 block after v16)
- Modify: `src/main/store/stateSchema.ts` (`EventsTable.att_ref`, `EventBlobsTable`, `StateDb.event_blobs`)
- Modify: `src/main/store/migrations/statePg.ts` (`ATTACHMENTS_V17`, step 17)
- Modify: `src/main/store/storeImport.ts` (`IMPORT_TABLES.state` adds `event_blobs`; import skips its rows — see Task 5)
- Modify: `docs/SPEC.md` (§7 schema + new *Attachment dedupe* paragraph)
- Test: `src/main/dbAttachmentBlobs.test.ts`

**Interfaces:**
- Produces: tables `event_blobs(hash TEXT PK, body_z BLOB NOT NULL, bytes INTEGER NOT NULL, refs INTEGER NOT NULL)`, column `events.att_ref TEXT`, trigger `events_att_ref_ad` (SQLite).

- [ ] **Step 1: Failing test** — after `openTestState`, on SQLite: insert a blob with `refs = 2` and two events with that `att_ref` via `stateKysely()`; `deleteSession` of one session drops refs to 1; deleting the other removes the blob. On both dialects: `SELECT att_ref FROM events` and `SELECT hash FROM event_blobs` succeed.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { deleteSession, ingestLine, stateKysely } from './db.js';
import { isPg, openTestState, queryRows } from './store/testStore.js';

const WS = '01WS';
const line = (u: string) => JSON.stringify({ type: 'system', uuid: u, timestamp: '2026-11-01T00:00:00Z' });

beforeEach(async () => { await openTestState('cf-att-blobs-'); });

describe('state v17 attachment blobs', () => {
  it('has att_ref and event_blobs on both dialects', async () => {
    expect(await queryRows('SELECT att_ref FROM events')).toEqual([]);
    expect(await queryRows('SELECT hash, body_z, bytes, refs FROM event_blobs')).toEqual([]);
  });
  it.skipIf(isPg)('the delete trigger releases refs and drops a blob at zero', async () => {
    await ingestLine(WS, 's1', line('a'));
    await ingestLine(WS, 's2', line('b'));
    await stateKysely().updateTable('events').set({ att_ref: 'h' }).execute();
    await stateKysely().insertInto('event_blobs').values({ hash: 'h', body_z: Buffer.from('z'), bytes: 1, refs: 2 }).execute();
    await deleteSession('s1');
    expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([{ refs: 1 }]);
    await deleteSession('s2');
    expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** — FAIL (no such column/table).
- [ ] **Step 3: Implement.** SQLite v17:

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 17) {
    const cols = d.prepare(`PRAGMA table_info(events)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'att_ref')) d.exec(`ALTER TABLE events ADD COLUMN att_ref TEXT`);
    d.exec(`
      CREATE TABLE IF NOT EXISTS event_blobs (
        hash   TEXT PRIMARY KEY,
        body_z BLOB NOT NULL,
        bytes  INTEGER NOT NULL,
        refs   INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_att_ref_ad AFTER DELETE ON events WHEN old.att_ref IS NOT NULL BEGIN
        UPDATE event_blobs SET refs = refs - 1 WHERE hash = old.att_ref;
        DELETE FROM event_blobs WHERE hash = old.att_ref AND refs <= 0;
      END;
    `);
    d.pragma('user_version = 17');
  }
```

Postgres step 17:

```ts
const ATTACHMENTS_V17 = `
ALTER TABLE events ADD COLUMN att_ref ${T};
CREATE TABLE event_blobs (
  hash ${T} PRIMARY KEY,
  body_z BYTEA NOT NULL,
  bytes BIGINT NOT NULL,
  refs BIGINT NOT NULL
);
`;
// steps: [..., { version: 17, postgres: ATTACHMENTS_V17 }]
```

stateSchema: `att_ref: string | null;` on `EventsTable` (doc: payload hash when the line holds a `fleetRef` marker; SQLite only); `EventBlobsTable { hash: string; body_z: Buffer; bytes: number; refs: number }`; `event_blobs: EventBlobsTable` in `StateDb`. Update the header comment to v1–v17. `IMPORT_TABLES.state` appends `'event_blobs'`.

- [ ] **Step 4: Run** the new test + `src/main/store/storeImport.test.ts src/main/dbRetentionSchema.test.ts src/main/store/pgStores.test.ts` — PASS (fix any track-version expectation 16 → 17).
- [ ] **Step 5: Commit** `feat(state): schema v17 event_blobs + att_ref (#542)` with SPEC.md.

### Task 3: Dedupe at ingest; readers expand

**Files:**
- Modify: `src/main/db.ts` (`ingestOne`, `rowFromSql`/`eventsForSession`, `unembeddedTurnEvents`; new `upsertBlob`)
- Test: `src/main/dbAttachmentBlobs.test.ts`

**Interfaces:**
- Consumes: `dedupeAttachment`, `expandLine`, `deflatePayload` (Task 1).
- Produces: `upsertBlob(q, ref, payload): Promise<void>` (internal); `eventsForSession`/`unembeddedTurnEvents` return expanded `rawJsonl`.

- [ ] **Step 1: Failing tests**

```ts
const big = (u: string, n = 0) => JSON.stringify({ type: 'attachment', uuid: u, timestamp: '2026-11-01T00:00:00Z',
  attachment: { type: 'deferred_tools_delta', tools: 'T'.repeat(2000), n } });

it('dedupes identical payloads at ingest and reads the originals back', async () => {
  const lines = [big('a'), big('b'), big('c', 1)];
  for (const l of lines) await ingestLine(WS, 's1', l);
  expect((await eventsForSession('s1')).map((e) => e.rawJsonl)).toEqual(lines);
  if (isPg) return expect(await queryRows('SELECT hash FROM event_blobs')).toEqual([]);
  const blobs = await queryRows<{ refs: number }>('SELECT refs FROM event_blobs ORDER BY refs');
  expect(blobs.map((b) => Number(b.refs))).toEqual([1, 2]);
  const raw = await queryRows<{ raw_jsonl: string }>(`SELECT raw_jsonl FROM events WHERE uuid = 'a'`);
  expect(raw[0].raw_jsonl.length).toBeLessThan(200);
});

it('a replayed line does not bump refs', async () => {
  await ingestLine(WS, 's1', big('a'));
  await ingestLine(WS, 's1', big('a'));
  if (!isPg) expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([{ refs: 1 }]);
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `ingestOne`:

```ts
  const d = stateDialect() === 'sqlite' && e.type === 'attachment' ? dedupeAttachment(rawLine, p.parsed) : null;
  const ins = await q
    .insertInto('events')
    .values({ ...e, session_id: sessionId, workspace_id: workspaceId, raw_jsonl: d ? d.stored : rawLine, att_ref: d?.ref ?? null })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  const inserted = num(ins.numInsertedOrUpdatedRows) > 0;
  if (inserted && d) await upsertBlob(q, d.ref, d.payload);
```

```ts
/** One more reference to `ref`'s payload; inserts the blob on first use. */
async function upsertBlob(q: Kysely<StateDb>, ref: string, payload: string): Promise<void> {
  await q.insertInto('event_blobs')
    .values({ hash: ref, body_z: deflatePayload(payload), bytes: Buffer.byteLength(payload, 'utf8'), refs: 1 })
    .onConflict((oc) => oc.column('hash').doUpdateSet((eb) => ({ refs: eb('event_blobs.refs', '+', 1) })))
    .execute();
}
```

(Deflating on every hit is wasted work on conflicts; acceptable at ~1 ms per 100 KB, and it keeps one statement. If profiling says otherwise, check existence first.)

Readers: `eventsForSession` → `selectFrom('events as e').leftJoin('event_blobs as b', 'b.hash', 'e.att_ref').selectAll('e').select('b.body_z as att_body_z')`; `rowFromSql` → `rawJsonl: expandLine(rawLine(r), r.att_ref, r.att_body_z ?? null)`. Same join + expansion in `unembeddedTurnEvents`.

- [ ] **Step 4: Run** the dedupe tests + `src/main/dbRetentionSchema.test.ts src/main/state/retention.test.ts src/main/dbIngestBatch.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(state): dedupe attachment payloads at ingest (#542)`.

### Task 4: Retention backfill step

**Files:**
- Modify: `src/main/db.ts` (`attachmentBackfillKeys`, `attachmentBackfillBodies`, `applyAttachmentDedupe`, `maxAttachmentId`)
- Modify: `src/main/state/retention.ts` (`dedupeAttachments(t)`, wired into `pass` before `events`, `PassResult.attachments`)
- Modify: `docs/SPEC.md` (retention pass steps)
- Test: `src/main/state/retention.test.ts`

**Interfaces:**
- Produces: `dedupeAttachments(t: Throttle, opts?: { sliceRows?: number }): Promise<{ rows: number; bytesSaved: number }>`; cursor key `attachments.deduped_through_id`.

- [ ] **Step 1: Failing test** — on SQLite, write two big attachment rows with `att_ref` NULL and the full line (one plain, one `raw_jsonl: '', raw_z: deflateLine(line)`) directly via `stateKysely().updateTable` after ingest-with-dedupe disabled (ingest then reset: `UPDATE events SET raw_jsonl = <orig>, att_ref = NULL; DELETE FROM event_blobs`); run `dedupeAttachments(unthrottled)`; expect `rows === 2`, one blob with refs 2, `eventsForSession` returns the originals, cursor set; a second run returns `rows === 0`. A stopped throttle (`stopped: () => true`) does nothing.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in db.ts:

```ts
export async function attachmentBackfillKeys(afterId: number, maxId: number, limit: number): Promise<{ id: number; bytes: number }[]> {
  const rows = await kyselyOrThrow().selectFrom('events')
    .select(['id', sql<number>`octet_length(raw_jsonl) + COALESCE(octet_length(raw_z), 0)`.as('bytes')])
    .where('type', '=', 'attachment').where('att_ref', 'is', null)
    .where('id', '>', afterId).where('id', '<=', maxId)
    .orderBy('id').limit(limit).execute();
  return rows.map((r) => ({ id: num(r.id), bytes: num(r.bytes) }));
}

export async function maxAttachmentId(): Promise<number> {
  const r = await kyselyOrThrow().selectFrom('events')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m')).where('type', '=', 'attachment').executeTakeFirst();
  return num(r?.m ?? 0);
}

/** Rewrite rows to their deduped form and count the blob references, in one transaction. */
export async function applyAttachmentDedupe(updates: readonly { id: number; stored: string; ref: string; payload: string }[]): Promise<void> {
  if (updates.length === 0) return;
  await kyselyOrThrow().transaction().execute(async (trx) => {
    for (const u of updates) {
      const r = await trx.updateTable('events').set({ raw_jsonl: u.stored, raw_z: null, att_ref: u.ref })
        .where('id', '=', u.id).where('att_ref', 'is', null).executeTakeFirst();
      if (num(r.numUpdatedRows) > 0) await upsertBlob(trx, u.ref, u.payload);
    }
  });
}
```

Bodies reuse `retentionBodies(ids)`. In retention.ts:

```ts
const ATTACHMENTS_CURSOR = 'attachments.deduped_through_id';

/** The attachments step (SQLite): dedupe attachment rows written before v17,
 *  up to the max id seen at the start. */
export async function dedupeAttachments(t: Throttle, opts: { sliceRows?: number } = {}): Promise<{ rows: number; bytesSaved: number }> {
  const acc = { rows: 0, bytesSaved: 0 };
  if (stateDialect() !== 'sqlite') return acc;
  const maxId = await maxAttachmentId();
  let cursor = Number((await maintenanceGet(ATTACHMENTS_CURSOR)) ?? 0);
  while (cursor < maxId && !t.stopped()) {
    const next = await t.slice(async () => {
      const keys = await attachmentBackfillKeys(cursor, maxId, opts.sliceRows ?? SLICE_ROWS);
      if (keys.length === 0) return null;
      let take = 0;
      for (let bytes = 0; take < keys.length && (take === 0 || bytes + keys[take].bytes <= SLICE_BYTES); take++) bytes += keys[take].bytes;
      const updates: { id: number; stored: string; ref: string; payload: string }[] = [];
      for (const row of await retentionBodies(keys.slice(0, take).map((k) => k.id))) {
        let line: string;
        try { line = rawLine(row, true); } catch { continue; }
        const d = dedupeAttachment(line);
        if (!d) continue;
        updates.push({ id: row.id, ...d });
        acc.bytesSaved += storedBytes(row) - Buffer.byteLength(d.stored, 'utf8');
      }
      await applyAttachmentDedupe(updates);
      acc.rows += updates.length;
      return keys[take - 1].id;
    });
    if (next === null) { cursor = maxId; break; }
    cursor = next;
    await maintenanceSet(ATTACHMENTS_CURSOR, String(cursor));
  }
  if (cursor >= maxId && maxId > 0) await maintenanceSet(ATTACHMENTS_CURSOR, String(maxId));
  return acc;
}
```

`pass`: `attachments: await step('attachments', () => dedupeAttachments(throttle), { rows: 0, bytesSaved: 0 })` before `events`; add to `PassResult` and the log message.

- [ ] **Step 4: Run** `src/main/state/retention.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(state): backfill attachment dedupe in the retention pass (#542)` with SPEC.md.

### Task 5: Query worker and store import

**Files:**
- Modify: `src/main/queryWorker.ts` (snapshot copies referenced blobs; `fleet_raw(raw, z, ref, body)`)
- Modify: `src/main/store/storeImport.ts` (expand attachment rows; skip `event_blobs` rows)
- Modify: `docs/SPEC.md` (§ MCP query `fleet_raw`, import)
- Test: `src/main/queryWorker.test.ts`, `src/main/store/storeImport.test.ts`

- [ ] **Step 1: Failing tests** — query worker: ingest two identical big attachments, run the snapshot query `SELECT raw_jsonl FROM events ORDER BY id` with `includeRaw: true` → the two original lines; `SELECT fleet_raw(raw_jsonl, raw_z, att_ref, NULL) …` with a missing body → the stored form. Import: a SQLite source with deduped rows imports into Postgres with the original `raw_jsonl`, `att_ref` NULL and an empty `event_blobs` (Postgres suite only, like the existing raw_z import test).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Worker:

```ts
    mem.function('fleet_raw', { deterministic: true }, (raw: unknown, z: unknown, ref: unknown = null, body: unknown = null) => {
      let line = raw;
      if (z instanceof Uint8Array && z.length > 0) {
        try { line = zlib.inflateSync(z).toString('utf8'); } catch { line = raw; }
      }
      if (typeof ref !== 'string' || typeof line !== 'string' || !(body instanceof Uint8Array)) return line;
      const m = `{"fleetRef":"${ref}"}`;
      const at = line.indexOf(m);
      if (at < 0) return line;
      try { return line.slice(0, at) + zlib.inflateSync(body).toString('utf8') + line.slice(at + m.length); } catch { return line; }
    });
```

`fleet_raw` is registered with `varargs: true` so the two- and four-argument forms both work. Snapshot (includeRaw): copy `att_ref` (or `NULL AS att_ref` on a pre-v17 source); `CREATE TABLE event_blobs AS SELECT hash, body_z FROM ${alias}.event_blobs WHERE hash IN (SELECT att_ref FROM events_store)` (empty table on pre-v17); view: `fleet_raw(s.raw_jsonl, s.raw_z, s.att_ref, b.body_z) AS raw_jsonl FROM events_store s LEFT JOIN event_blobs b ON b.hash = s.att_ref`. The worker's zlib arg type gains nothing new (`inflateSync` only).

Import: for `events`, after the `raw_z` inflate, `if (row.att_ref) { row.raw_jsonl = expandLine(row.raw_jsonl, row.att_ref, blobOf(row.att_ref), true); row.att_ref = null; }` inside the same try (keep the stored form on failure) with `blobOf = src.prepare('SELECT body_z FROM event_blobs WHERE hash = ?')`. `copyTable` returns early (0 rows copied, marked done) for `event_blobs`.

- [ ] **Step 4: Run** both test files — PASS.
- [ ] **Step 5: Commit** `feat(mcp): query and import rebuild deduped attachment lines (#542)` with SPEC.md.

### Task 6: Measure on the host copy; retention spec numbers

**Files:**
- Create: `scripts/measure-attachment-dedupe.mjs` (copies nothing; runs on a path you pass, which must be a scratch copy)
- Modify: `docs/superpowers/specs/2026-11-06-statedb-retention-design.md` §2.2
- Modify: `docs/superpowers/specs/2026-11-09-attachment-dedupe-design.md` (results)

- [ ] **Step 1:** `cp` the host copy to a scratch path; open it through the app's real code (`openDb` on a temp dir holding the copy as `state.db`, running v16/v17 migrations), run `dedupeAttachments(unthrottled)` via a vitest-free tsx/vite-node script, then `VACUUM` the scratch copy.
- [ ] **Step 2:** Report: file size and `dbstat` for `events` + `event_blobs` before/after; then for every attachment row compare `eventsForSession`-equivalent expansion (`expandLine(rawLine(row), att_ref, body_z, true)`) to the original line from the untouched copy, by id. Expected: 0 mismatches.
- [ ] **Step 3:** Replace §2.2 of the retention spec with the measured table (events 3.06 GB by class, embeddings 0.77 GB, retention alone ~0.8 GB: 4.2 → ~3.4 GB) and add the dedupe result.
- [ ] **Step 4: Commit** `docs: real state.db numbers; attachment dedupe measurement (#542)`.

## Self-review

- Spec §2.1–2.8 → Tasks 1–5; §3 → Task 2; §4 → Tasks 1–6.
- Names consistent: `dedupeAttachment`, `expandLine`, `deflatePayload`, `upsertBlob`, `applyAttachmentDedupe`, `attachmentBackfillKeys`, `maxAttachmentId`, `dedupeAttachments`, `ATTACHMENTS_CURSOR`.
