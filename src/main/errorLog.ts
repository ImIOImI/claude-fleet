// Global error logger.
//
// Captures uncaught exceptions and unhandled rejections from BOTH the main
// process and the renderer (via an IPC bridge), writing each one to
// `<userData>/error.log` as a single line of JSON. Users hit a popup they
// can't copy from? Have them cat the log and paste here.
//
// A no-frills append-only log: no level filtering, no remote sink. It rotates
// to error.log.1 at ERROR_LOG_MAX_BYTES, so at most two files stay on disk.
// Lines are buffered and appended off the main thread every FLUSH_MS; process
// exit, quit and an uncaught exception flush synchronously.

import { app } from 'electron';
import { appendFileSync, mkdirSync, promises as fsp, renameSync, statSync } from 'node:fs';
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
/** Lines not yet handed to a write. */
let pending: string[] = [];
/** Lines in the async append now running. */
let inflight: string[] | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

/** Test seam: log to `path` (null restores the userData default) and rotate at `max`. */
export function _setErrorLogForTests(path: string | null, max = ERROR_LOG_MAX_BYTES): void {
  flushErrorLogSync();
  logPath = path;
  logBytes = null;
  maxBytes = max;
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

function scheduleFlush(): void {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushErrorLog();
  }, FLUSH_MS);
  flushTimer.unref?.();
}

function clearFlushTimer(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

/** Whether `lineBytes` more would take the current file past the cap. */
function needsRotation(lineBytes: number): boolean {
  return logBytes! > 0 && logBytes! + lineBytes > maxBytes;
}

/** Append `lines`, rotating before the line that would pass the cap. A failed
 *  rename keeps appending to the current file and retries on the next line. */
function writeLinesSync(lines: string[]): void {
  const p = ensureLogPath();
  if (logBytes === null) {
    try {
      logBytes = statSync(p).size;
    } catch {
      logBytes = 0;
    }
  }
  let chunk = '';
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (needsRotation(lineBytes)) {
      if (chunk) appendFileSync(p, chunk, 'utf8');
      chunk = '';
      try {
        renameSync(p, `${p}.1`);
        logBytes = 0;
      } catch {
        // Retried on the next line.
      }
    }
    chunk += line;
    logBytes! += lineBytes;
  }
  if (chunk) appendFileSync(p, chunk, 'utf8');
}

/** writeLinesSync on fs.promises. */
async function writeLinesAsync(lines: string[]): Promise<void> {
  const p = ensureLogPath();
  if (logBytes === null) {
    try {
      logBytes = (await fsp.stat(p)).size;
    } catch {
      logBytes = 0;
    }
  }
  let chunk = '';
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (needsRotation(lineBytes)) {
      if (chunk) await fsp.appendFile(p, chunk, 'utf8');
      chunk = '';
      try {
        await fsp.rename(p, `${p}.1`);
        logBytes = 0;
      } catch {
        // Retried on the next line.
      }
    }
    chunk += line;
    logBytes! += lineBytes;
  }
  if (chunk) await fsp.appendFile(p, chunk, 'utf8');
}

/** Append everything buffered; resolves once it is on disk. Never rejects. */
export function flushErrorLog(): Promise<void> {
  clearFlushTimer();
  flushing ??= (async () => {
    while (pending.length) {
      const batch = pending;
      pending = [];
      inflight = batch;
      try {
        await writeLinesAsync(batch);
      } catch {
        // Nothing useful to do if the log itself can't be written.
      }
      if (inflight === batch) inflight = null;
    }
  })().finally(() => {
    flushing = null;
    if (pending.length) scheduleFlush();
  });
  return flushing;
}

/** Write everything buffered before returning, for paths where the event loop
 *  may not run again. An async append still running is written again too, so
 *  a crash mid-append can repeat lines but never loses them. */
export function flushErrorLogSync(): void {
  clearFlushTimer();
  const lines = [...(inflight ?? []), ...pending];
  inflight = null;
  pending = [];
  if (!lines.length) return;
  try {
    writeLinesSync(lines);
  } catch {
    // Nothing useful to do if the log itself can't be written.
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
    pending.push(JSON.stringify({ ts: new Date(tsMs).toISOString(), ...payload }) + '\n');
    scheduleFlush();
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

/** A sink that buffers rows and hands them to `write` together, at most once
 *  per `delayMs`, so a burst costs one transaction instead of one per row.
 *  Writes run one at a time; a rejected write drops its rows. */
export function batchedErrorSink(
  write: (rows: ErrorRow[]) => Promise<void>,
  delayMs = FLUSH_MS,
): { sink: (row: ErrorRow) => void; flush: () => Promise<void> } {
  let rows: ErrorRow[] = [];
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = rows;
    rows = [];
    if (batch.length) running = running.then(() => write(batch)).catch(() => undefined);
    return running;
  };
  const sink = (row: ErrorRow): void => {
    rows.push(row);
    if (timer) return;
    timer = setTimeout(() => void flush(), delayMs);
    timer.unref?.();
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
