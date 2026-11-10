// state.db retention (SPEC §7 *Retention*): strip and compress old event lines,
// compact embeddings, purge orphaned workspaces, reclaim free pages. Work runs
// on the async store handle in bounded slices behind a Throttle, so the main
// thread is never held for more than one small transaction at a time.
import {
  acquireWalCheckpointer,
  applyAttachmentDedupe, attachmentBackfillKeys, compactEmbeddingSlice, maxAttachmentId, maintenanceGet, maintenanceSet, maxEmbeddingId, purgeWorkspace, retentionBodies, retentionCandidates,
  retentionKeys, rewriteEventRaw, setRetentionWatermarks, stateDialect, withRawSqlite, workspaceIdsInState, type RetentionRow,
} from '../db.js';
import { logError } from '../errorLog.js';
import { perfSpanAsync, perfSpanAsyncAttrs } from '../perf.js';
import type { Attributes } from '@opentelemetry/api';
import { COMPRESS_MIN_BYTES, deflateLine, rawLine, stripLine } from './rawCodec.js';
import { dedupeAttachment } from './attachmentCodec.js';
import type { WalCheckpointLease } from './walCheckpointer.js';

export const DAY_MS = 86_400_000;
export const COMPRESS_AFTER_MS = 30 * DAY_MS;
export const STRIP_AFTER_MS = 30 * DAY_MS;
export const STRIP_AFTER_RESUMED_MS = 90 * DAY_MS;
const SLICE_ROWS = 200;
export const SLICE_BYTES = 2 * 1024 * 1024;
/** Main-thread time one slice aims to stay under (SPEC §7 *Retention*). */
export const SLICE_TARGET_MS = 35;

export interface SliceBudget {
  /** This slice's time target. */
  readonly targetMs: number;
  /** The throttle's clock (ms). */
  now(): number;
  /** Mark where the slice's own work starts, once its first query holds the
   *  store: waiting for the store mutex isn't the slice's cost. Defaults to the slice start. */
  begin(): void;
  /** Milliseconds since begin(). */
  elapsed(): number;
  /** True once the slice has worked for its target: stop at the next row boundary. */
  expired(): boolean;
  /** Attributes for the slice's span (its slow_op row's meta). */
  note(attrs: Attributes): void;
}

export interface Throttle {
  /** Run one bounded unit of work, then pace the next one. */
  slice<T>(step: string, fn: (budget: SliceBudget) => Promise<T>): Promise<T>;
  /** True once the pass should stop at the next slice boundary. */
  stopped(): boolean;
}

/** Batch size for a statement that can't be interrupted part-way: cut in
 *  proportion when a run overshoots the target, grown slowly while well under it. */
export class AdaptiveBatch {
  constructor(public size: number, private readonly min: number, private readonly max: number) {}

  observe(ms: number, targetMs: number): void {
    if (ms > targetMs) this.size = Math.max(this.min, Math.floor(this.size * (targetMs / ms) * 0.8));
    else if (ms < targetMs / 2) this.size = Math.min(this.max, Math.ceil(this.size * 1.25));
  }
}

/** Keys whose summed bytes fit `budget`, always at least one. */
function takeWithin<K extends { bytes: number }>(keys: readonly K[], budget: number): K[] {
  let take = 0;
  for (let bytes = 0; take < keys.length && (take === 0 || bytes + keys[take].bytes <= budget); take++) bytes += keys[take].bytes;
  return keys.slice(0, take);
}

/** `rows` in `keys` order; a row deleted since its key was read is absent. */
function inKeyOrder<R extends { id: number }>(keys: readonly { id: number }[], rows: readonly R[]): (R | undefined)[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return keys.map((k) => byId.get(k.id));
}

export interface RetainEventsResult { rows: number; bytesBefore: number; bytesAfter: number }

const storedBytes = (r: { raw_jsonl: string; raw_z: Buffer | null }): number =>
  r.raw_z && r.raw_z.length > 0 ? r.raw_z.length : Buffer.byteLength(r.raw_jsonl, 'utf8');

/** Strip (ts < stripCut) then compress (SQLite, ts < compressCut). Null when nothing changes. */
function transform(row: RetentionRow, now: number, stripCut: number, compressCut: number, compress: boolean):
  { raw_jsonl: string; raw_z: Buffer | null } | null {
  let line: string;
  try {
    line = rawLine(row, true);
  } catch {
    return null; // a corrupt raw_z is left as it is rather than stalling every pass
  }
  const out = row.ts < stripCut ? (stripLine(line, now) ?? line) : line;
  const isCompressed = row.raw_z !== null && row.raw_z.length > 0;
  const wantCompressed = compress && row.ts < compressCut && Buffer.byteLength(out, 'utf8') >= COMPRESS_MIN_BYTES;
  if (out === line && wantCompressed === isCompressed) return null;
  return wantCompressed ? { raw_jsonl: '', raw_z: deflateLine(out) } : { raw_jsonl: out, raw_z: null };
}

/** Walk one session range in slices; false when the throttle stopped it early. */
async function walkRange(
  sessionId: string, fromTs: number, toTs: number, toolOnly: boolean, t: Throttle, sliceRows: number, batch: AdaptiveBatch,
  apply: (row: RetentionRow) => { raw_jsonl: string; raw_z: Buffer | null } | null, acc: RetainEventsResult,
): Promise<boolean> {
  if (fromTs >= toTs) return true;
  let after: { ts: number; id: number } | null = null;
  for (;;) {
    if (t.stopped()) return false;
    const done = await t.slice('events', async (b) => {
      const keys = await retentionKeys(sessionId, fromTs, toTs, after, sliceRows, toolOnly);
      b.begin();
      if (keys.length === 0) return true;
      // Bodies only up to the byte budget, so no row is read twice.
      const taken = takeWithin(keys, batch.size);
      const bodies = inKeyOrder(taken, await retentionBodies(taken.map((k) => k.id)));
      const readMs = b.elapsed();
      const updates: { id: number; raw_jsonl: string; raw_z: Buffer | null }[] = [];
      let n = 0;
      let bytes = 0;
      for (; n < taken.length && (n === 0 || !b.expired()); n++) {
        const row = bodies[n];
        bytes += taken[n].bytes;
        const next = row && apply(row);
        if (row && next) {
          updates.push({ id: row.id, ...next });
          acc.rows++;
          acc.bytesBefore += storedBytes(row);
          acc.bytesAfter += storedBytes(next);
        }
      }
      after = { ts: taken[n - 1].ts, id: taken[n - 1].id };
      const w0 = b.elapsed();
      await rewriteEventRaw(updates);
      batch.observe(b.elapsed(), b.targetMs);
      b.note({ rows: n, rewritten: updates.length, bytes, batch_bytes: batch.size, read_ms: readMs, write_ms: b.elapsed() - w0 });
      return false;
    });
    if (done) return true;
  }
}

/** The events step of a retention pass. A session's watermarks advance only
 *  once its ranges finish, so a stopped pass resumes there next time. */
export async function retainEvents(now: number, t: Throttle, opts: { sliceRows?: number } = {}): Promise<RetainEventsResult> {
  const sliceRows = opts.sliceRows ?? SLICE_ROWS;
  const compress = stateDialect() === 'sqlite';
  const cCut = now - COMPRESS_AFTER_MS;
  const acc: RetainEventsResult = { rows: 0, bytesBefore: 0, bytesAfter: 0 };
  const batch = new AdaptiveBatch(SLICE_BYTES, 16 * 1024, SLICE_BYTES);
  for (const c of await perfSpanAsync('claude_fleet.retention.candidates', () => retentionCandidates(cCut))) {
    if (t.stopped()) break;
    const sCut = now - (c.resumed ? STRIP_AFTER_RESUMED_MS : STRIP_AFTER_MS);
    if (c.compressedBefore >= cCut && c.strippedBefore >= sCut) continue;
    // No row at or past either watermark: nothing to read, nothing to write.
    if (c.lastActiveAt < Math.min(c.compressedBefore, c.strippedBefore)) continue;
    const apply = (row: RetentionRow) => transform(row, now, sCut, cCut, compress);
    if (!(await walkRange(c.sessionId, c.compressedBefore, cCut, false, t, sliceRows, batch, apply, acc))) break;
    const ageingOut = Math.min(sCut, c.compressedBefore);
    if (!(await walkRange(c.sessionId, c.strippedBefore, ageingOut, true, t, sliceRows, batch, apply, acc))) break;
    await setRetentionWatermarks(c.sessionId, c.workspaceId, Math.max(c.compressedBefore, cCut), Math.max(c.strippedBefore, sCut));
  }
  return acc;
}

const ATTACHMENTS_CURSOR = 'attachments.deduped_through_id';

/** The attachments step (SQLite): dedupe attachment rows written before v17,
 *  up to the max id seen at the start. Ingest dedupes everything newer. */
export async function dedupeAttachments(t: Throttle, opts: { sliceRows?: number } = {}): Promise<{ rows: number; bytesSaved: number }> {
  const acc = { rows: 0, bytesSaved: 0 };
  if (stateDialect() !== 'sqlite') return acc;
  const maxId = await maxAttachmentId();
  let cursor = Number((await maintenanceGet(ATTACHMENTS_CURSOR)) ?? 0);
  const batch = new AdaptiveBatch(SLICE_BYTES, 16 * 1024, SLICE_BYTES);
  while (cursor < maxId && !t.stopped()) {
    const next = await t.slice('attachments', async (b) => {
      const keys = await attachmentBackfillKeys(cursor, maxId, opts.sliceRows ?? SLICE_ROWS);
      b.begin();
      if (keys.length === 0) return maxId;
      const taken = takeWithin(keys, batch.size);
      const bodies = inKeyOrder(taken, await retentionBodies(taken.map((k) => k.id)));
      const readMs = b.elapsed();
      const updates: { id: number; raw_jsonl: string; raw_z: Buffer | null; ref: string; payload: string }[] = [];
      let n = 0;
      let bytes = 0;
      for (; n < taken.length && (n === 0 || !b.expired()); n++) {
        const row = bodies[n];
        bytes += taken[n].bytes;
        if (!row) continue;
        let line: string;
        try {
          line = rawLine(row, true);
        } catch {
          continue;
        }
        const d = dedupeAttachment(line);
        if (!d) continue;
        // A row retention already compressed stays compressed: it sits behind its watermark.
        const wasCompressed = row.raw_z !== null && row.raw_z.length > 0;
        const out = wasCompressed && Buffer.byteLength(d.stored, 'utf8') >= COMPRESS_MIN_BYTES
          ? { raw_jsonl: '', raw_z: deflateLine(d.stored) }
          : { raw_jsonl: d.stored, raw_z: null };
        updates.push({ id: row.id, ...out, ref: d.ref, payload: d.payload });
        acc.bytesSaved += storedBytes(row) - storedBytes(out);
      }
      const w0 = b.elapsed();
      await applyAttachmentDedupe(updates);
      acc.rows += updates.length;
      batch.observe(b.elapsed(), b.targetMs);
      b.note({ rows: n, rewritten: updates.length, bytes, batch_bytes: batch.size, read_ms: readMs, write_ms: b.elapsed() - w0 });
      return taken[n - 1].id;
    });
    cursor = next;
    await maintenanceSet(ATTACHMENTS_CURSOR, String(cursor));
  }
  return acc;
}

const EMBEDDINGS_CURSOR = 'embeddings.compacted_through_id';

/** The embeddings step: drop placeholder vectors and (SQLite) re-encode
 *  float32 vectors to int8, up to the max id seen at the start. */
export async function compactEmbeddings(t: Throttle, opts: { sliceRows?: number } = {}): Promise<{ rows: number; bytesSaved: number }> {
  const maxId = await maxEmbeddingId();
  let cursor = Number((await maintenanceGet(EMBEDDINGS_CURSOR)) ?? 0);
  const acc = { rows: 0, bytesSaved: 0 };
  const batch = new AdaptiveBatch(opts.sliceRows ?? SLICE_ROWS, 1, opts.sliceRows ?? SLICE_ROWS);
  while (cursor < maxId && !t.stopped()) {
    const r = await t.slice('embeddings', async (b) => {
      const out = await compactEmbeddingSlice(cursor, maxId, batch.size, () => b.expired(), () => b.begin());
      batch.observe(b.elapsed(), b.targetMs);
      b.note({ rows: out.scanned, rewritten: out.rewritten, bytes: out.bytesSaved, batch_rows: batch.size });
      return out;
    });
    if (r.lastId === null) break;
    cursor = r.lastId;
    acc.rows += r.rewritten;
    acc.bytesSaved += r.bytesSaved;
    await maintenanceSet(EMBEDDINGS_CURSOR, String(cursor));
  }
  return acc;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface OrphanDeps {
  /** Ids of every workspace manifest on disk (all kinds). */
  listManifestIds(): Promise<string[]>;
  /** Whether `<userData>/state/<id>` exists. */
  stateDirExists(id: string): boolean;
}

/** Purge state.db rows of workspaces that are gone. Guarded so a transient
 *  manifest-listing failure can never wipe history: the listing must be
 *  non-empty, and an id is purged only if it is ULID-shaped, unlisted and has
 *  no state dir. */
export async function sweepOrphans(deps: OrphanDeps, t: Throttle): Promise<string[]> {
  const manifests = new Set(await deps.listManifestIds());
  if (manifests.size === 0) return [];
  const purged: string[] = [];
  for (const id of await workspaceIdsInState()) {
    if (t.stopped()) break;
    if (manifests.has(id) || !ULID.test(id) || deps.stateDirExists(id)) continue;
    await purgeWorkspace(id, (fn) => t.slice('orphans', fn));
    purged.push(id);
  }
  return purged;
}

export interface ThrottleOptions {
  minSleepMs?: number;
  /** A slice's budget expires after this long (default SLICE_TARGET_MS). */
  targetMs?: number;
  /** Called after each slice, before its sleep. */
  afterSlice?: () => void;
  /** Awaited before each slice starts, outside its timing. */
  beforeSlice?: () => Promise<void>;
  /** Extra attributes for every slice span (e.g. WAL state). */
  sliceMeta?: () => Attributes;
  /** Sleep this many times a slice's duration after it (9 → ≤10% duty cycle). */
  idleRatio?: number;
  now?: () => number;
  sleep?: (ms: number, wake: (fn: () => void) => void) => Promise<void>;
}

/** Paces slices at a low duty cycle; stop() ends the pass at the next slice
 *  boundary and cuts a sleep in progress short. */
export function createThrottle(opts: ThrottleOptions = {}): Throttle & { stop(): void } {
  const minSleep = opts.minSleepMs ?? 250;
  const ratio = opts.idleRatio ?? 9;
  const target = opts.targetMs ?? SLICE_TARGET_MS;
  const now = opts.now ?? (() => performance.now());
  let stopped = false;
  let wakeSleeper: (() => void) | null = null;
  const sleep = opts.sleep ?? ((ms: number, wake: (fn: () => void) => void) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    wake(() => { clearTimeout(timer); resolve(); });
  }));
  return {
    async slice(step, fn) {
      await opts.beforeSlice?.();
      let t0 = now();
      try {
        return await perfSpanAsyncAttrs('claude_fleet.retention.slice', (set) => {
          const meta = opts.sliceMeta?.();
          if (meta) set(meta);
          return fn({
            targetMs: target,
            now,
            begin: () => { t0 = now(); },
            elapsed: () => now() - t0,
            expired: () => now() - t0 >= target,
            note: set,
          });
        }, { step });
      } finally {
        opts.afterSlice?.();
        // Paced on the slice's own work, not on time spent waiting for the store.
        if (!stopped) await sleep(Math.max(minSleep, ratio * (now() - t0)), (w) => { wakeSleeper = w; });
        wakeSleeper = null;
      }
    },
    stopped: () => stopped,
    stop() {
      stopped = true;
      wakeSleeper?.();
    },
  };
}

const VACUUM_FREE_PAGES = 4096;
const VACUUM_SLICE_PAGES = 1024;
/** Pages one check may return, so a large backlog spreads over several checks. */
const VACUUM_MAX_PAGES = 64 * VACUUM_SLICE_PAGES;

/** Return free pages to the OS in small slices (SQLite with
 *  auto_vacuum = INCREMENTAL only; Postgres relies on autovacuum). */
export async function incrementalVacuum(t: Throttle): Promise<number> {
  const state = await withRawSqlite((d) => ({
    mode: d.pragma('auto_vacuum', { simple: true }) as number,
    free: d.pragma('freelist_count', { simple: true }) as number,
  }));
  if (!state || state.mode !== 2) return 0;
  let free = state.free;
  const start = free;
  const batch = new AdaptiveBatch(256, 8, VACUUM_SLICE_PAGES);
  while (free > VACUUM_FREE_PAGES && start - free < VACUUM_MAX_PAGES && !t.stopped()) {
    const before = free;
    free = (await t.slice('vacuum', async (b) => {
      const pages = batch.size;
      const left = await withRawSqlite((d) => {
        b.begin();
        d.pragma(`incremental_vacuum(${pages})`);
        return d.pragma('freelist_count', { simple: true }) as number;
      });
      batch.observe(b.elapsed(), b.targetMs);
      b.note({ pages, batch_pages: batch.size });
      return left;
    })) ?? free;
    if (free >= before) break;
  }
  return start - free;
}

export interface RetentionDeps extends OrphanDeps {
  /** Only where this desktop owns every workspace in the store: SQLite or the
   *  managed (local) Postgres, never a shared external one. */
  orphanSweep: boolean;
  /** SQLite: lease the store's WAL checkpointer while a run works. */
  walCheckpoints?: boolean;
  firstDelayMs?: number;
  intervalMs?: number;
  vacuumEveryMs?: number;
  now?: () => number;
  throttle?: ThrottleOptions;
  /** Test hook: called after each full pass. */
  onPass?: (r: PassResult) => void;
  /** Test hook: called when a run starts its WAL checkpointer. */
  onCheckpointer?: (c: WalCheckpointLease | null) => void;
}

export interface PassResult {
  orphans: string[];
  attachments: { rows: number; bytesSaved: number };
  events: RetainEventsResult;
  embeddings: { rows: number; bytesSaved: number };
  vacuumPages: number;
}

/** Schedule retention: a pass 5 min after start, then daily; an incremental
 *  vacuum check every 30 min. One unit of work runs at a time. */
export function startRetention(deps: RetentionDeps): { stop(): Promise<void> } {
  // Started on a run's first slice, so a run with nothing to do spawns no worker.
  let wantCheckpointer = false;
  let checkpointer: Promise<WalCheckpointLease | null> | null = null;
  let ck: WalCheckpointLease | null = null;
  const throttle = createThrottle({
    ...deps.throttle,
    afterSlice: () => {
      deps.throttle?.afterSlice?.();
      if (wantCheckpointer && !checkpointer && deps.walCheckpoints) {
        checkpointer = acquireWalCheckpointer().then((c) => { deps.onCheckpointer?.(c); return (ck = c); }).catch(() => null);
      }
      ck?.request();
    },
    // SQLite rewinds the WAL only when a write starts after a complete
    // checkpoint; once it has grown, the next slice waits for one.
    beforeSlice: async () => { await deps.throttle?.beforeSlice?.(); await ck?.drain(); },
    sliceMeta: () => {
      const l = ck?.last();
      return { ...deps.throttle?.sliceMeta?.(), ...(l ? { wal_log: l.log, wal_ckpt: l.checkpointed, wal_busy: l.busy, wal_worker: ck!.active() } : {}) };
    },
  });
  const now = deps.now ?? Date.now;
  let running: Promise<unknown> | null = null;
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      logError({ source: 'main', level: 'warn', type: 'retention-step', message: String(e), extra: { step: name } });
      return fallback;
    }
  };
  const pass = async (): Promise<void> => {
    const at = now();
    const r: PassResult = {
      orphans: deps.orphanSweep ? await step('orphans', () => sweepOrphans(deps, throttle), []) : [],
      attachments: await step('attachments', () => dedupeAttachments(throttle), { rows: 0, bytesSaved: 0 }),
      events: await step('events', () => retainEvents(at, throttle), { rows: 0, bytesBefore: 0, bytesAfter: 0 }),
      embeddings: await step('embeddings', () => compactEmbeddings(throttle), { rows: 0, bytesSaved: 0 }),
      vacuumPages: await step('vacuum', () => incrementalVacuum(throttle), 0),
    };
    if (throttle.stopped()) return;
    await step('bookkeeping', async () => {
      if (!(await maintenanceGet('retention.first_pass_at'))) await maintenanceSet('retention.first_pass_at', String(at));
      await maintenanceSet('retention.last_pass_at', String(at));
    }, undefined);
    logError({ source: 'main', level: 'info', type: 'retention-pass', message: `retention pass: ${r.attachments.rows} attachments deduped, ${r.events.rows} events, ${r.embeddings.rows} embeddings, ${r.orphans.length} orphaned workspaces`,
      extra: { ...r, ms: now() - at } });
    deps.onPass?.(r);
  };
  const run = (fn: () => Promise<unknown>) => {
    if (running || throttle.stopped()) return;
    running = (async () => {
      wantCheckpointer = true;
      try {
        await fn();
      } finally {
        wantCheckpointer = false;
        const c = await checkpointer;
        checkpointer = null;
        ck = null;
        await c?.close();
      }
    })().finally(() => { running = null; });
  };
  const timers = [
    setTimeout(() => run(pass), deps.firstDelayMs ?? 5 * 60_000),
    setInterval(() => run(pass), deps.intervalMs ?? DAY_MS),
    setInterval(() => run(() => step('vacuum', () => incrementalVacuum(throttle), 0)), deps.vacuumEveryMs ?? 30 * 60_000),
  ];
  for (const t of timers) t.unref?.();
  return {
    async stop() {
      for (const t of timers) clearTimeout(t);
      throttle.stop();
      await running?.catch(() => undefined);
    },
  };
}
