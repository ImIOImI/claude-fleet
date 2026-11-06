// state.db retention (SPEC §7 *Retention*): strip and compress old event lines,
// compact embeddings, purge orphaned workspaces, reclaim free pages. Work runs
// on the async store handle in bounded slices behind a Throttle, so the main
// thread is never held for more than one small transaction at a time.
import {
  compactEmbeddingSlice, maintenanceGet, purgeWorkspace, workspaceIdsInState, maintenanceSet, maxEmbeddingId, retentionCandidates, retentionRows,
  rewriteEventRaw, setRetentionWatermarks, stateDialect, withRawSqlite, type RetentionRow,
} from '../db.js';
import { logError } from '../errorLog.js';
import { perfSpanAsync } from '../perf.js';
import { COMPRESS_MIN_BYTES, deflateLine, rawLine, stripLine } from './rawCodec.js';

export const DAY_MS = 86_400_000;
export const COMPRESS_AFTER_MS = 30 * DAY_MS;
export const STRIP_AFTER_MS = 30 * DAY_MS;
export const STRIP_AFTER_RESUMED_MS = 90 * DAY_MS;
const SLICE_ROWS = 200;
const SLICE_BYTES = 2 * 1024 * 1024;

export interface Throttle {
  /** Run one bounded unit of work, then pace the next one. */
  slice<T>(fn: () => Promise<T>): Promise<T>;
  /** True once the pass should stop at the next slice boundary. */
  stopped(): boolean;
}

export interface RetainEventsResult { rows: number; bytesBefore: number; bytesAfter: number }

const storedBytes = (r: { raw_jsonl: string; raw_z: Buffer | null }): number =>
  r.raw_z && r.raw_z.length > 0 ? r.raw_z.length : Buffer.byteLength(r.raw_jsonl, 'utf8');

/** Strip (ts < stripCut) then compress (SQLite, ts < compressCut). Null when nothing changes. */
function transform(row: RetentionRow, now: number, stripCut: number, compressCut: number, compress: boolean):
  { raw_jsonl: string; raw_z: Buffer | null } | null {
  const line = rawLine(row);
  const out = row.ts < stripCut ? (stripLine(line, now) ?? line) : line;
  const isCompressed = row.raw_z !== null && row.raw_z.length > 0;
  const wantCompressed = compress && row.ts < compressCut && Buffer.byteLength(out, 'utf8') >= COMPRESS_MIN_BYTES;
  if (out === line && wantCompressed === isCompressed) return null;
  return wantCompressed ? { raw_jsonl: '', raw_z: deflateLine(out) } : { raw_jsonl: out, raw_z: null };
}

/** Walk one session range in slices; false when the throttle stopped it early. */
async function walkRange(
  sessionId: string, fromTs: number, toTs: number, toolOnly: boolean, t: Throttle, sliceRows: number,
  apply: (row: RetentionRow) => { raw_jsonl: string; raw_z: Buffer | null } | null, acc: RetainEventsResult,
): Promise<boolean> {
  if (fromTs >= toTs) return true;
  let after: { ts: number; id: number } | null = null;
  for (;;) {
    if (t.stopped()) return false;
    const done = await t.slice(async () => {
      const rows = await retentionRows(sessionId, fromTs, toTs, after, sliceRows, toolOnly);
      if (rows.length === 0) return true;
      const updates: { id: number; raw_jsonl: string; raw_z: Buffer | null }[] = [];
      let bytes = 0;
      for (const row of rows) {
        after = { ts: row.ts, id: row.id };
        bytes += storedBytes(row);
        const next = apply(row);
        if (next) {
          updates.push({ id: row.id, ...next });
          acc.rows++;
          acc.bytesBefore += storedBytes(row);
          acc.bytesAfter += storedBytes(next);
        }
        if (bytes >= SLICE_BYTES) break;
      }
      await rewriteEventRaw(updates);
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
  for (const c of await retentionCandidates(cCut)) {
    if (t.stopped()) break;
    const sCut = now - (c.resumed ? STRIP_AFTER_RESUMED_MS : STRIP_AFTER_MS);
    if (c.compressedBefore >= cCut && c.strippedBefore >= sCut) continue;
    const apply = (row: RetentionRow) => transform(row, now, sCut, cCut, compress);
    if (!(await walkRange(c.sessionId, c.compressedBefore, cCut, false, t, sliceRows, apply, acc))) break;
    const ageingOut = Math.min(sCut, c.compressedBefore);
    if (!(await walkRange(c.sessionId, c.strippedBefore, ageingOut, true, t, sliceRows, apply, acc))) break;
    await setRetentionWatermarks(c.sessionId, c.workspaceId, Math.max(c.compressedBefore, cCut), Math.max(c.strippedBefore, sCut));
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
  while (cursor < maxId && !t.stopped()) {
    const r = await t.slice(() => compactEmbeddingSlice(cursor, maxId, opts.sliceRows ?? SLICE_ROWS));
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
    await purgeWorkspace(id, (fn) => t.slice(fn));
    purged.push(id);
  }
  return purged;
}

export interface ThrottleOptions {
  minSleepMs?: number;
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
  const now = opts.now ?? (() => performance.now());
  let stopped = false;
  let wakeSleeper: (() => void) | null = null;
  const sleep = opts.sleep ?? ((ms: number, wake: (fn: () => void) => void) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    wake(() => { clearTimeout(timer); resolve(); });
  }));
  return {
    async slice(fn) {
      const t0 = now();
      try {
        return await perfSpanAsync('claude_fleet.retention.slice', fn);
      } finally {
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
const VACUUM_MAX_SLICES = 64;

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
  for (let i = 0; i < VACUUM_MAX_SLICES && free > VACUUM_FREE_PAGES && !t.stopped(); i++) {
    free = (await t.slice(() => withRawSqlite((d) => {
      d.pragma(`incremental_vacuum(${VACUUM_SLICE_PAGES})`);
      return d.pragma('freelist_count', { simple: true }) as number;
    }))) ?? free;
  }
  return start - free;
}

export interface RetentionDeps extends OrphanDeps {
  firstDelayMs?: number;
  intervalMs?: number;
  vacuumEveryMs?: number;
  now?: () => number;
  throttle?: ThrottleOptions;
  /** Test hook: called after each full pass. */
  onPass?: (r: PassResult) => void;
}

export interface PassResult {
  orphans: string[];
  events: RetainEventsResult;
  embeddings: { rows: number; bytesSaved: number };
  vacuumPages: number;
}

/** Schedule retention: a pass 5 min after start, then daily; an incremental
 *  vacuum check every 30 min. One unit of work runs at a time. */
export function startRetention(deps: RetentionDeps): { stop(): Promise<void> } {
  const throttle = createThrottle(deps.throttle);
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
      orphans: await step('orphans', () => sweepOrphans(deps, throttle), []),
      events: await step('events', () => retainEvents(at, throttle), { rows: 0, bytesBefore: 0, bytesAfter: 0 }),
      embeddings: await step('embeddings', () => compactEmbeddings(throttle), { rows: 0, bytesSaved: 0 }),
      vacuumPages: await step('vacuum', () => incrementalVacuum(throttle), 0),
    };
    if (throttle.stopped()) return;
    await step('bookkeeping', async () => {
      if (!(await maintenanceGet('retention.first_pass_at'))) await maintenanceSet('retention.first_pass_at', String(at));
      await maintenanceSet('retention.last_pass_at', String(at));
    }, undefined);
    logError({ source: 'main', level: 'info', type: 'retention-pass', message: `retention pass: ${r.events.rows} events, ${r.embeddings.rows} embeddings, ${r.orphans.length} orphaned workspaces`,
      extra: { ...r, ms: now() - at } });
    deps.onPass?.(r);
  };
  const run = (fn: () => Promise<unknown>) => {
    if (running || throttle.stopped()) return;
    running = fn().finally(() => { running = null; });
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
