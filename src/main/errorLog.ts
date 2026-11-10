// Global error logger.
//
// Captures uncaught exceptions and unhandled rejections from BOTH the main
// process and the renderer (via an IPC bridge), writing each one to
// `<userData>/error.log` as a single line of JSON. Users hit a popup they
// can't copy from? Have them cat the log and paste here.
//
// A no-frills append-only log: no level filtering, no remote sink. It rotates
// to error.log.1 at ERROR_LOG_MAX_BYTES, so at most two files stay on disk.
// Error-level lines are written in the logError call, so they survive a crash;
// info/warn lines are buffered and written with one append every FLUSH_MS.

import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ErrorRow } from './db.js';
import { clipText } from './clipText.js';

type Source = 'main' | 'renderer';

interface LogPayload {
  source: Source;
  type: string;    // 'uncaughtException', 'unhandledRejection', 'window.onerror', …
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  workspaceId?: string;
  sessionId?: string;
  level?: 'error' | 'warn' | 'info';
}

let logPath: string | null = null;
/** Bytes in the current file: one stat at first use, then counted. */
let logBytes: number | null = null;

export const ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024;
let maxBytes = ERROR_LOG_MAX_BYTES;

export const FLUSH_MS = 200;
/** Retry delay cap while writes keep failing. */
export const MAX_RETRY_MS = 10_000;
/** Buffer bounds while writes fail; the oldest lines are dropped past either. */
export const MAX_PENDING_LINES = 5_000;
export const MAX_PENDING_BYTES = 1024 * 1024;
let pending: string[] = [];
let pendingBytes = 0;
let droppedLines = 0;
let failedWrites = 0;
let flushTimer: NodeJS.Timeout | null = null;

/** Test seam: log to `path` (null restores the userData default) and rotate at `max`. */
export function _setErrorLogForTests(path: string | null, max = ERROR_LOG_MAX_BYTES): void {
  flushErrorLogSync();
  logPath = path;
  logBytes = null;
  maxBytes = max;
  failedWrites = 0;
}
let sink: ((row: ErrorRow) => void) | null = null;

/** Register a best-effort DB sink for structured error rows. */
export function setErrorSink(fn: ((row: ErrorRow) => void) | null): void {
  sink = fn;
}

function ensureLogPath(): string {
  if (logPath) return logPath;
  const p = join(app.getPath('userData'), 'error.log');
  mkdirSync(dirname(p), { recursive: true });
  logPath = p;
  return p;
}

const MAX_FIELD_CHARS = 8_192;

export { clipText };

/** Next timer delay: FLUSH_MS, doubling per consecutive failed write up to MAX_RETRY_MS. */
export function errorLogRetryDelay(): number {
  return Math.min(FLUSH_MS * 2 ** failedWrites, MAX_RETRY_MS);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flushErrorLogSync, errorLogRetryDelay());
  flushTimer.unref?.();
}

/** Write every buffered line in one append, renaming to error.log.1 first if
 *  it would take the file past the cap. A failed write keeps the lines for the
 *  next tick; a failed rename keeps appending and retries next time. */
export function flushErrorLogSync(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.length) return;
  try {
    const lines = droppedLines
      ? [JSON.stringify({ ts: new Date().toISOString(), source: 'main', type: 'error-log-dropped', level: 'warn', message: `dropped ${droppedLines} lines` }) + '\n', ...pending]
      : pending;
    const data = lines.join('');
    const bytes = Buffer.byteLength(data, 'utf8');
    const p = ensureLogPath();
    if (logBytes === null) {
      try {
        logBytes = statSync(p).size;
      } catch {
        logBytes = 0;
      }
    }
    if (logBytes > 0 && logBytes + bytes > maxBytes) {
      try {
        renameSync(p, `${p}.1`);
        logBytes = 0;
      } catch {
        // Retried on the next write.
      }
    }
    appendFileSync(p, data, 'utf8');
    logBytes += bytes;
    pending = [];
    pendingBytes = 0;
    droppedLines = 0;
    failedWrites = 0;
  } catch {
    failedWrites++;
    scheduleFlush();
  }
}

/** Buffer one JSON line for the log. Best-effort — never throws. Message and
 *  stack are capped: an error can echo an arbitrarily large value. */
export function logError(raw: LogPayload): void {
  const tsMs = Date.now();
  const payload: LogPayload = {
    ...raw,
    message: clipText(String(raw.message), MAX_FIELD_CHARS),
    ...(raw.stack !== undefined ? { stack: clipText(String(raw.stack), MAX_FIELD_CHARS) } : {}),
  };
  try {
    const line = JSON.stringify({ ts: new Date(tsMs).toISOString(), ...payload }) + '\n';
    pending.push(line);
    pendingBytes += line.length;
    while (pending.length > 1 && (pending.length > MAX_PENDING_LINES || pendingBytes > MAX_PENDING_BYTES)) {
      pendingBytes -= pending.shift()!.length;
      droppedLines++;
    }
    if ((payload.level ?? 'error') === 'error') flushErrorLogSync();
    else scheduleFlush();
  } catch {
    // Any throw here would cascade into the very error-handling path the
    // user invoked. Drop it.
  }
  try {
    sink?.({ ts: tsMs, ...payload });
  } catch {
    // DB sink is best-effort — a wedged DB must never break crash logging.
  }
}

/** Rows the DB sink holds while a write is slow or failing; older ones are dropped. */
export const MAX_PENDING_ROWS = 1_000;

/** A sink that buffers rows and hands them to `write` together, at most once
 *  per `delayMs`, so a burst costs one transaction instead of one per row. At
 *  most one write runs; past `maxPending` buffered rows the oldest are dropped,
 *  and the next batch starts with one `error-rows-dropped` row giving the
 *  count. A rejected write drops its rows. */
export function batchedErrorSink(
  write: (rows: ErrorRow[]) => Promise<void>,
  delayMs = FLUSH_MS,
  maxPending = MAX_PENDING_ROWS,
): { sink: (row: ErrorRow) => void; flush: () => Promise<void> } {
  let rows: ErrorRow[] = [];
  let dropped = 0;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const schedule = (): void => {
    if (timer || running) return;
    timer = setTimeout(start, delayMs);
    timer.unref?.();
  };
  function start(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (running || !rows.length) return;
    const batch: ErrorRow[] = dropped
      ? [{ ts: Date.now(), source: 'main', type: 'error-rows-dropped', level: 'warn', message: `dropped ${dropped} error rows` }, ...rows]
      : rows;
    rows = [];
    dropped = 0;
    running = write(batch)
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (rows.length) schedule();
      });
  }
  const flush = async (): Promise<void> => {
    while (running || rows.length) {
      start();
      await running;
    }
  };
  const sink = (row: ErrorRow): void => {
    rows.push(row);
    if (rows.length > maxPending) {
      rows.shift();
      dropped++;
    }
    schedule();
  };
  return { sink, flush };
}

/**
 * Hook the main-process uncaughtException + unhandledRejection signals so
 * any crash in main lands in the log. Call once, after `app.whenReady` is
 * resolved (so `app.getPath('userData')` is valid).
 */
export function installMainProcessHandlers(): void {
  process.on('uncaughtException', (err) => {
    logError({
      source: 'main',
      type: 'uncaughtException',
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
    flushErrorLogSync();
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : null;
    logError({
      source: 'main',
      type: 'unhandledRejection',
      message: err?.message ?? String(reason),
      stack: err?.stack,
    });
    flushErrorLogSync();
  });
  process.on('exit', flushErrorLogSync);
}

/** Path to the log file. Useful for the user to find it. */
export function getLogPath(): string {
  return ensureLogPath();
}
