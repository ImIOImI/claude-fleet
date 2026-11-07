// Global error logger.
//
// Captures uncaught exceptions and unhandled rejections from BOTH the main
// process and the renderer (via an IPC bridge), writing each one to
// `<userData>/error.log` as a single line of JSON. Users hit a popup they
// can't copy from? Have them cat the log and paste here.
//
// A no-frills append-only log: no level filtering, no remote sink. It rotates
// to error.log.1 at ERROR_LOG_MAX_BYTES, so at most two files stay on disk.

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

/** Test seam: log to `path` (null restores the userData default) and rotate at `max`. */
export function _setErrorLogForTests(path: string | null, max = ERROR_LOG_MAX_BYTES): void {
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

/** Append one JSON line to the log. Best-effort — never throws. Message and
 *  stack are capped: an error can echo an arbitrarily large value. */
export function logError(raw: LogPayload): void {
  const tsMs = Date.now();
  const payload: LogPayload = {
    ...raw,
    message: clipText(String(raw.message), MAX_FIELD_CHARS),
    ...(raw.stack !== undefined ? { stack: clipText(String(raw.stack), MAX_FIELD_CHARS) } : {}),
  };
  try {
    const row = { ts: new Date(tsMs).toISOString(), ...payload };
    const p = ensureLogPath();
    const line = JSON.stringify(row) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (logBytes === null) {
      try {
        logBytes = statSync(p).size;
      } catch {
        logBytes = 0;
      }
    }
    if (logBytes > 0 && logBytes + lineBytes > maxBytes) {
      try {
        renameSync(p, `${p}.1`);
        logBytes = 0;
      } catch {
        // Keep appending to the current file; the next line retries.
      }
    }
    appendFileSync(p, line, 'utf8');
    logBytes += lineBytes;
  } catch {
    // If writing the log itself errors, there's nothing useful we can do —
    // any throw here would cascade into the very error-handling path the
    // user invoked. Drop it.
  }
  try {
    sink?.({ ts: tsMs, ...payload });
  } catch {
    // DB sink is best-effort — a wedged DB must never break crash logging.
  }
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
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : null;
    logError({
      source: 'main',
      type: 'unhandledRejection',
      message: err?.message ?? String(reason),
      stack: err?.stack,
    });
  });
}

/** Path to the log file. Useful for the user to find it. */
export function getLogPath(): string {
  return ensureLogPath();
}
