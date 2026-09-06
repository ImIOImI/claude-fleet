// Raw PTY stream capture, for diagnosing terminal-rendering bugs (#268).
//
// Why this exists: four root-cause theories on #268 (ConPTY reflow, premature
// fit, stale paint, xterm scrollback reflow) were each argued from screenshots
// and inference, and three were wrong. The missing primitive was the ability
// to answer "what bytes did the terminal actually receive, and at what size?"
// — without that, every repro attempt is a fresh guess.
//
// A capture records the exact byte stream the renderer was sent, interleaved
// with the resize events that changed the geometry underneath it. Replaying
// that into a headless xterm reproduces the corruption deterministically and
// turns a "I saw junk" report into a regression fixture.
//
// Off unless CLAUDE_FLEET_CAPTURE_PTY is set to a directory. When off,
// `createPtyCapture` returns null and the data path pays one null check.
//
// Format: JSONL, one event per line.
//   {"t":0,    "k":"open",   "cols":107,"rows":45,"workspaceId":"…","brokerSessionId":"…"}
//   {"t":12,   "k":"data",   "b64":"…"}          // exactly what was sent to the renderer
//   {"t":3400, "k":"resize", "cols":115,"rows":45}
//   {"t":9000, "k":"close"}
// `t` is ms since the capture opened. Data chunks are base64 so the file stays
// line-oriented and binary-safe.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { logError } from './errorLog.js';

/** Per-session cap so a long-running capture can't fill the disk. Override
 *  with CLAUDE_FLEET_CAPTURE_PTY_MAX_MB. */
const DEFAULT_MAX_MB = 64;

export interface PtyCapture {
  data: (chunk: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  /** Bytes of payload written so far (diagnostics/tests). */
  readonly bytes: number;
}

export interface PtyCaptureOpts {
  handleId: string;
  workspaceId: string | null;
  brokerSessionId: string;
  cols: number;
  rows: number;
  /** Injectable for tests. */
  now?: () => number;
  dir?: string;
  /** Settings-configured capture dir; the env var still takes precedence. */
  configuredDir?: string | null;
  maxBytes?: number;
}

/**
 * Where to capture, or null when off. The env var wins so the e2e suite can
 * drive it without touching config; otherwise the Settings value is used.
 * `configured` is passed in rather than read here so this module stays free of
 * the config cache and remains synchronous.
 */
export function captureDir(configured?: string | null): string | null {
  const d = process.env.CLAUDE_FLEET_CAPTURE_PTY ?? configured ?? '';
  if (!d || !d.trim()) return null;
  const dir = d.trim();
  // Must be absolute FOR THIS PLATFORM. A Windows-style path on POSIX is a
  // perfectly legal *relative filename* containing backslashes, so mkdir
  // happily creates `./C:\Users\…` next to the cwd instead of failing —
  // which is how a stray env var scattered capture files through a git
  // checkout (and produced a path Windows then refused to check out).
  if (!isAbsolute(dir)) {
    logError({
      source: 'main',
      type: 'pty-capture-bad-dir',
      level: 'warn',
      message: `CLAUDE_FLEET_CAPTURE_PTY must be an absolute path on this platform; ignoring ${JSON.stringify(dir)}`,
      extra: { dir, platform: process.platform }
    });
    return null;
  }
  return dir;
}

function maxBytesFromEnv(): number {
  const raw = Number(process.env.CLAUDE_FLEET_CAPTURE_PTY_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** Filenames land in a user-specified dir, so keep them to a safe charset —
 *  ids are path-safe by construction, but a capture is a debugging tool run
 *  with odd inputs and must not be able to escape the directory. */
function safe(part: string): string {
  return part
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // Separators are already gone, so traversal is impossible either way —
    // but a literal `..` in a filename invites a second look during review.
    .replace(/\.{2,}/g, '_')
    .slice(0, 64);
}

/** Returns null when capture is off, or if the sink can't be opened — a
 *  diagnostic must never take the terminal down with it. */
export function createPtyCapture(opts: PtyCaptureOpts): PtyCapture | null {
  const dir = opts.dir ?? captureDir(opts.configuredDir);
  if (!dir) return null;

  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? maxBytesFromEnv();
  const t0 = now();

  let stream: WriteStream;
  let file: string;
  try {
    mkdirSync(dir, { recursive: true });
    // Sortable, collision-resistant, and readable at a glance.
    file = join(
      dir,
      `${new Date(t0).toISOString().replace(/[:.]/g, '-')}-${safe(opts.workspaceId ?? 'nows')}-${safe(opts.handleId)}.jsonl`
    );
    stream = createWriteStream(file, { flags: 'a' });
    // A capture sink dying (disk full, dir removed mid-run) must not raise an
    // unhandled 'error' and take main with it.
    stream.on('error', () => {
      dead = true;
    });
  } catch (err) {
    logError({
      source: 'main',
      type: 'pty-capture-failed',
      level: 'warn',
      message: `could not open PTY capture in ${dir}: ${String(err)}`,
      extra: { handleId: opts.handleId }
    });
    return null;
  }

  let bytes = 0;
  let dead = false;
  let cappedLogged = false;

  const write = (obj: Record<string, unknown>): void => {
    if (dead) return;
    try {
      stream.write(JSON.stringify({ t: now() - t0, ...obj }) + '\n');
    } catch {
      dead = true;
    }
  };

  write({
    k: 'open',
    cols: opts.cols,
    rows: opts.rows,
    workspaceId: opts.workspaceId,
    brokerSessionId: opts.brokerSessionId,
    handleId: opts.handleId
  });

  logError({
    source: 'main',
    type: 'pty-capture-open',
    level: 'info',
    message: `capturing PTY stream to ${file}`,
    extra: { handleId: opts.handleId, workspaceId: opts.workspaceId, file }
  });

  return {
    data(chunk: Buffer) {
      if (dead) return;
      if (bytes + chunk.length > maxBytes) {
        if (!cappedLogged) {
          cappedLogged = true;
          write({ k: 'capped', bytes });
          logError({
            source: 'main',
            type: 'pty-capture-capped',
            level: 'warn',
            message: `PTY capture hit ${Math.round(maxBytes / 1048576)}MB cap; no longer recording data for this session`,
            extra: { handleId: opts.handleId, file, bytes }
          });
        }
        return;
      }
      bytes += chunk.length;
      write({ k: 'data', b64: chunk.toString('base64') });
    },
    resize(cols: number, rows: number) {
      // Recorded even after the data cap — the geometry timeline stays cheap
      // and is exactly what a replay needs.
      write({ k: 'resize', cols, rows });
    },
    close() {
      if (dead) return;
      write({ k: 'close' });
      dead = true;
      try {
        stream.end();
      } catch {
        /* already gone */
      }
    },
    get bytes() {
      return bytes;
    }
  };
}
