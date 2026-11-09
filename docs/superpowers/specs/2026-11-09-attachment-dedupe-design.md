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

`type = 'attachment'` lines whose top-level `attachment` and `rendered` values together serialize (`JSON.stringify`) to ≥ 1,024 bytes. `rendered` is the attachment's rendered text: on the host copy, after deduping `attachment` alone, deduped rows still held 382 MB, 355 MB of it `rendered` with 19 MB distinct, and the (attachment, rendered) pairs number only 3,227. Every attachment type qualifies: a unique payload costs one blob row and still gets deflated, so there's no loss.

### 2.2 Stored form

For each moved key present (`attachment` = part 0, `rendered` = part 1), let `s_i = JSON.stringify(parsed[key])`. The body is `JSON.stringify([s_0, s_1])` and `h = sha256(body)` (hex). The line is deduped only when all of these hold; otherwise it is stored as-is:

- each `"<key>":` + `s_i` occurs in the line exactly once (the value is the literal substring the writer produced);
- the line does not already contain `"fleetRef":"`;
- the rebuild of the stored form equals the original line (checked at write time).

Stored `raw_jsonl` = the line with each `s_i` replaced by `{"fleetRef":"<h>","part":<i>}`. It stays valid JSON, so a reader that skips the rebuild still parses it. `events.att_ref = h`.

On the real copy, every attachment and `rendered` value of the eligible rows passed the first two checks (0 misses, 0 multiple matches).

### 2.3 Blob table

```
event_blobs(hash TEXT PRIMARY KEY, body_z BLOB NOT NULL, bytes INTEGER NOT NULL, refs INTEGER NOT NULL)
```

`body_z` is the body deflated (zlib level 6). `bytes` is its UTF-8 length. `refs` counts events whose `att_ref` is `hash`.

### 2.4 Reference counting

- **Insert/backfill (app code, same transaction):** the event write, then `UPDATE event_blobs SET refs = refs + 1 WHERE hash = ?`, and only on a miss the deflate plus `INSERT … ON CONFLICT(hash) DO UPDATE SET refs = refs + 1`. Nearly every call is a hit, and deflating is the costly part (a single upsert would deflate every time: ~40% slower fresh attachment ingest in the state bench). Ingest upserts the blob only when the event insert landed, so a replayed line never inflates `refs`.
- **Release (triggers, both dialects):** `AFTER DELETE ON events WHEN old.att_ref IS NOT NULL`, and `AFTER UPDATE OF att_ref` when the old value was set and changes, decrement `refs` and delete the blob at 0. They cover every delete path (`deleteSession`, `purgeWorkspace`, the orphan sweep) and any future writer of `att_ref` without each one knowing about blobs. On Postgres they are one plpgsql function (`events_att_ref_release`) and never fire today.
- **No `events(att_ref)` index.** Building one in the migration would read the whole events table at startup (#532 avoided an events index for the same reason). Counting makes it unnecessary.

### 2.5 Ingest

`ingestOne` dedupes before the insert, on SQLite only, and only a line not stored yet: the watcher replays every JSONL from offset 0 on each start, so an attachment line ≥ 1 KB first probes `(session_id, dedup_key)` on the unique index and skips the stringify/hash/parse on a hit. The INSERT still runs either way (an ignored INSERT advances AUTOINCREMENT, which event ids depend on). `dedup_key` is computed from the original line by `parseIngestLine`, so it is unchanged, and a re-read line hits `ON CONFLICT DO NOTHING` without re-expanding.

### 2.6 Backfill

A new retention step, `attachments`, runs before the events step in each pass (SQLite only). It walks `type = 'attachment' AND att_ref IS NULL` by id (served by `idx_events_type`) up to the max id at the start of the step, in slices bounded by rows (200) and an estimate of 2 MB of work behind the retention throttle (a deflated row counts 3× its stored size, its typical inflated size). Compressed rows are inflated first; when the source row was compressed and the stub is ≥ 512 bytes, the stub is deflated back into `raw_z`, since the row already sits behind its retention watermark and retention won't revisit it. The cursor is `maintenance['attachments.deduped_through_id']`. Rows that fail the checks are left as they are and passed by the cursor.

### 2.7 Readers

- `rawLine` stays the stored-form codec (retention keeps operating on the stored form, so stripping and compressing never expand a row). A new `expandLine(stored, attRef, bodyZ)` splices the payload back in.
- `eventsForSession` fetches each distinct blob of the page once (`hash IN (…)`) and returns the expanded lines. `unembeddedTurnEvents` reads only user/assistant rows, which never carry `att_ref`, so it doesn't touch blobs.
- MCP `query` worker (`include_raw`): the snapshot copies the referenced blobs into `event_blobs(hash PRIMARY KEY, body_z)`, and the `events` view's `raw_jsonl` is `fleet_raw(raw_jsonl, raw_z, att_ref, body_z)`, which splices each part back. Without `include_raw` no blob is copied.
- SQLite → Postgres import expands lines and writes `att_ref` NULL. `event_blobs` is not imported.
- A missing or corrupt blob reads as the stored form (valid JSON with the marker); strict mode throws (import keeps the stored form rather than lose it).

### 2.8 Postgres

Postgres does not dedupe: TOAST already compresses large values, and the MCP query role reads `raw_jsonl` straight through a temp view under column grants. Expanding there would mean a join or function in that isolation layer for a store whose size isn't the reported problem. Postgres step 17 mirrors the schema (`events.att_ref`, `event_blobs`) for parity; both stay empty.

## 3. Schema (state v17, Postgres step 17)

- `events.att_ref TEXT` (nullable).
- `event_blobs` as in §2.3.
- Triggers `events_att_ref_ad` and `events_att_ref_au` (SQLite; Postgres via `events_att_ref_release()`).
- Opening a v17 database with an older build shows the `{"fleetRef":…}` markers in place of attachment payloads; nothing is lost, and the next v17 start reads them back.

## 4. Testing

- Codec: dedupe/expand round trip; small payload; payload appears twice; line already containing the marker; `$` patterns in the payload (no `String.replace`); unicode escapes that `JSON.stringify` would normalize (left as-is).
- Ingest: two lines with the same payload → one blob, refs 2; replay → refs unchanged; `eventsForSession` returns the original lines.
- Delete: `deleteSession` and `purgeWorkspace` drop refs and blobs.
- Backfill: plain and `raw_z` rows deduped, cursor resumes, stopped throttle.
- Query worker: `include_raw` returns original lines.
- Import: expanded lines on Postgres, `att_ref` NULL.
- Measurement on a copy of the host DB: bytes before/after, and a byte-exact rebuild check over every attachment row.

## 5. Measured result

Real code (`dedupeAttachments`, after a retention pass) on a scratch copy of the host `state.db`, 2026-11-09:

| Step | File after VACUUM | `events` | `embeddings` | `event_blobs` |
|---|---|---|---|---|
| Before | 4,228 MB | 3,058 MB | 770 MB | — |
| Retention (#532) | 3,107 MB | 2,638 MB | 105 MB | — |
| + attachment dedupe | **2,033 MB** | 1,540 MB | 105 MB | 23 MB |

- **Coverage:** 52,012 of 101,929 attachment rows deduped into 6,962 blobs (79 MB of distinct bodies, 18 MB deflated), saving 1,056 MB of stored bytes. A deduped row averages 576 bytes (max 7.6 KB). The 49,917 rows left as they are hold 34 MB (each under the 1 KB threshold).
- **Byte-exact check:** every attachment row rebuilt (`expandLine(rawLine(row))`) equals the original line from the untouched copy: 0 mismatches in 101,929. Every blob's `refs` equals its referencing row count.
- **First-pass cost:** unthrottled, the backfill takes 44 s and retention 63 s. At the pass's ≤ 10% duty cycle that is ~7 min of idle time, once.
- **Backfilled stubs:** 2,023 stubs whose source row was already compressed stay compressed (avg stored stub 567 bytes).
- **Restart replay:** the watcher re-ingests every line on each start. Replaying all 101,929 attachment lines into the deduped copy took 23.9 s when every line was deduped before its (ignored) INSERT, and 7.2 s with the index probe (§2.5). State bench, 1,000 lines with 9–30 KB attachments (median of 3 runs, two sessions each): replay 307 → 69 µs/line; fresh 431 → 367 µs/line.
- **Growth:** new attachment lines are deduped at ingest, so repeated boilerplate costs a ~0.6 KB row instead of its payload.

## 6. Decisions

1. **SQLite only** (§2.8).
2. **Whole `attachment` + `rendered` values, ≥ 1 KB together, any type** (§2.1); one blob per distinct pair. Sub-payload dedupe (e.g. per tool in `deferred_tools_delta`) would save more on unique-but-similar payloads; not worth the rebuild complexity at 22 MB distinct.
3. **Marker splice, verified at write time** instead of a JSON re-serializer: exact by construction, and any line that doesn't round-trip stays plain.
4. **Refcount + release triggers** instead of a sweep with an `events(att_ref)` index (§2.4).
5. **Deflated blob bodies.**
