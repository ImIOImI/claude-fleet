// Global error logger.
//
// Captures uncaught exceptions and unhandled rejections from BOTH the main
// process and the renderer (via an IPC bridge), writing each one to
// `<userData>/error.log` as a single line of JSON. Users hit a popup they
// can't copy from? Have them cat the log and paste here.
//
// Intentionally a no-frills append-only log. No rotation, no level
// filtering, no remote sink. The file is small in practice (one line per
// crash) and the user can delete it whenever.

import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Source = 'main' | 'renderer';

interface LogPayload {
  source: Source;
  type: string;    // 'uncaughtException', 'unhandledRejection', 'window.onerror', …
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
}

let logPath: string | null = null;

function ensureLogPath(): string {
  if (logPath) return logPath;
  const p = join(app.getPath('userData'), 'error.log');
  mkdirSync(dirname(p), { recursive: true });
  logPath = p;
  return p;
}

/** Append one JSON line to the log. Best-effort — never throws. */
export function logError(payload: LogPayload): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      ...payload,
    };
    appendFileSync(ensureLogPath(), JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // If writing the log itself errors, there's nothing useful we can do —
    // any throw here would cascade into the very error-handling path the
    // user invoked. Drop it.
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
