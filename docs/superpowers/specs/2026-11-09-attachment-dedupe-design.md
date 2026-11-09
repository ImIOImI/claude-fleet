# state.db attachment payload dedupe

Follow-up to state.db retention (#526, #476 fix #3). Approved by Troy 2026-11-09 after the host measurement.

## 1. Problem

Measured on a copy of Troy's `state.db` (4.2 GB, schema v15, 2026-11-09):

- `events` is 3.06 GB. `attachment` rows are the largest class: 1.19 GB in 102k rows (avg 11.6 KB).
- Growth is ~800 MB/week over the last two weeks (vs ~50 MB/week two months earlier). More than half of it is `attachment` rows.
- Retention (#532) compresses rows only after 30 days and never strips attachments, so it reclaims ~0.8 GB once and leaves growth untouched.

Claude Code re-records the same boilerplate on every session and turn:

| `attachment.type` | Rows | Payload | Distinct payload |
|---|---|---|---|
| `deferred_tools_delta` | 7,877 | 294 MB | 17 MB (499 distinct) |
| `prompt_snapshot` | 7,751 | 195 MB | 2 MB (44 distinct) |
| `instructions` | 4,008 | 107 MB | 2 MB (99 distinct) |
| `skill_listing` | 5,072 | 65 MB | 1 MB (103 distinct) |

661 MB of payload holds ~22 MB of distinct content.

## 2. Design

Store each distinct attachment payload once, keyed by its SHA-256. The event row keeps a marker in place of the payload and a reference column. Every reader rebuilds the original line byte-for-byte.

### 2.1 Which rows

`type = 'attachment'` lines whose `attachment` value serializes (`JSON.stringify`) to ≥ 1,024 bytes. Every attachment type qualifies: a unique payload costs one blob row and still gets deflated, so there's no loss.

### 2.2 Stored form

Let `s = JSON.stringify(parsed.attachment)` and `h = sha256(s)` (hex). The line is deduped only when all of these hold; otherwise it is stored as-is:

- `"attachment":` + `s` occurs in the line exactly once (the payload is the literal substring the writer produced);
- the line does not already contain `"fleetRef":"`;
- the rebuild of the stored form equals the original line (checked at write time).

Stored `raw_jsonl` = the line with `s` replaced by `{"fleetRef":"<h>"}`. It stays valid JSON, so a reader that skips the rebuild still parses it. `events.att_ref = h`.

On the real copy, all 46,731 attachment rows ≥ 1 KB passed the first two checks (0 misses, 0 multiple matches).

### 2.3 Blob table

```
event_blobs(hash TEXT PRIMARY KEY, body_z BLOB NOT NULL, bytes INTEGER NOT NULL, refs INTEGER NOT NULL)
```

`body_z` is the payload deflated (zlib level 6). `bytes` is its UTF-8 length. `refs` counts events whose `att_ref` is `hash`.

### 2.4 Reference counting

- **Insert/backfill (app code, same transaction):** the event write, then `INSERT … ON CONFLICT(hash) DO UPDATE SET refs = refs + 1`. Ingest upserts the blob only when the event insert landed, so a replayed line never inflates `refs`.
- **Delete (trigger):** `AFTER DELETE ON events WHEN old.att_ref IS NOT NULL` decrements `refs` and deletes the blob at 0. A trigger covers every delete path (`deleteSession`, `purgeWorkspace`, the orphan sweep) without each one knowing about blobs.
- **No `events(att_ref)` index.** Building one in the migration would read the whole events table at startup (#532 avoided an events index for the same reason). Counting makes it unnecessary.

### 2.5 Ingest

`ingestOne` dedupes before the insert, on SQLite only. `dedup_key` is computed from the original line by `parseIngestLine`, so it is unchanged, and a re-read line hits `ON CONFLICT DO NOTHING` without re-expanding. Hash plus stringify of a 100 KB payload is sub-millisecond.

### 2.6 Backfill

A new retention step, `attachments`, runs before the events step in each pass (SQLite only). It walks `type = 'attachment' AND att_ref IS NULL` by id (served by `idx_events_type`) up to the max id at the start of the step, in slices bounded by rows (200) and bytes (2 MB) behind the retention throttle. Compressed rows are inflated first; a deduped stub is stored uncompressed (it's small). The cursor is `maintenance['attachments.deduped_through_id']`. Rows that fail the checks are left as they are and passed by the cursor.

### 2.7 Readers

- `rawLine` stays the stored-form codec (retention keeps operating on the stored form, so stripping and compressing never expand a row). A new `expandLine(stored, attRef, bodyZ)` splices the payload back in.
- `eventsForSession` and `unembeddedTurnEvents` left-join `event_blobs` and return the expanded line.
- MCP `query` worker (`include_raw`): the snapshot copies the referenced blobs into `event_blobs`, and the `events` view's `raw_jsonl` is `fleet_raw(raw_jsonl, raw_z, att_ref, body_z)`. Without `include_raw` no blob is copied.
- SQLite → Postgres import expands lines and writes `att_ref` NULL. `event_blobs` is not imported.
- A missing or corrupt blob reads as the stored form (valid JSON with the marker); strict mode throws (import keeps the stored form rather than lose it).

### 2.8 Postgres

Postgres does not dedupe: TOAST already compresses large values, and the MCP query role reads `raw_jsonl` straight through a temp view under column grants. Expanding there would mean a join or function in that isolation layer for a store whose size isn't the reported problem. Postgres step 17 mirrors the schema (`events.att_ref`, `event_blobs`) for parity; both stay empty.

## 3. Schema (state v17, Postgres step 17)

- `events.att_ref TEXT` (nullable).
- `event_blobs` as in §2.3.
- SQLite trigger `events_att_ref_ad`.

## 4. Testing

- Codec: dedupe/expand round trip; small payload; payload appears twice; line already containing the marker; `$` patterns in the payload (no `String.replace`); unicode escapes that `JSON.stringify` would normalize (left as-is).
- Ingest: two lines with the same payload → one blob, refs 2; replay → refs unchanged; `eventsForSession` returns the original lines.
- Delete: `deleteSession` and `purgeWorkspace` drop refs and blobs.
- Backfill: plain and `raw_z` rows deduped, cursor resumes, stopped throttle.
- Query worker: `include_raw` returns original lines.
- Import: expanded lines on Postgres, `att_ref` NULL.
- Measurement on a copy of the host DB: bytes before/after, and a byte-exact rebuild check over every attachment row.

## 5. Decisions

1. **SQLite only** (§2.8).
2. **Whole `attachment` value, ≥ 1 KB, any type** (§2.1). Sub-payload dedupe (e.g. per tool in `deferred_tools_delta`) would save more on unique-but-similar payloads; not worth the rebuild complexity at 22 MB distinct.
3. **Marker splice, verified at write time** instead of a JSON re-serializer: exact by construction, and any line that doesn't round-trip stays plain.
4. **Refcount + delete trigger** instead of a sweep with an `events(att_ref)` index (§2.4).
5. **Deflated blob bodies.**
