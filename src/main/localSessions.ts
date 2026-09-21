// In-process session manager for the local (non-container) backend (#16).
//
// This is the host-side analog of the in-container broker: it owns each local
// `claude` PTY and keeps it alive across renderer detach/reattach (workspace
// switches), replaying a ring buffer of recent output on reattach so scrollback
// is restored — exactly the broker's HISTORY behavior, but in the main process.
//
// Pure module: no node-pty / electron / better-sqlite3 imports, so it loads
// under vitest. The caller injects a `spawn` factory (node-pty in production, a
// fake in tests). The only runtime dep is node:stream; `PtyHandle` is type-only.

import { Duplex } from 'node:stream';
import type { PtyHandle } from './docker.js';
import type { Harness } from './workspaces.js';

/** Minimal PTY-process shape the manager needs. node-pty's IPty satisfies it
 *  (wrapped in local.ts); tests supply a fake. */
export interface PtyProc {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  /** The size the PTY actually holds right now, as opposed to the size we
   *  last asked it for. Ground truth for the width-agreement check in ipc.ts
   *  (#268): every layer between the renderer and the pty swallows resize
   *  failures, so "we sent 107" is not evidence that claude is at 107.
   *  Optional — only the node-pty backend can answer it; test fakes and the
   *  container/broker handles leave it undefined and are simply not checked. */
  getSize?(): { cols: number; rows: number };
}

export type SpawnPty = (opts: {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}) => PtyProc;

// Ring cap mirrors the broker's default (64KiB) order of magnitude but a bit
// larger — enough to restore a screen or two of scrollback on reattach.
const RING_CAP_BYTES = 256 * 1024;

// NUL can't appear in a workspace id or session id (both are path-safe), so
// it's a safe composite-key separator.
const SEP = '\u0000';

interface Session {
  proc: PtyProc;
  ring: Buffer[];
  ringBytes: number;
  /** True once the ring has dropped a chunk. Until then byte 0 is the real
   *  start of this session's output and must be replayed verbatim; only a
   *  trimmed ring can begin mid-escape-sequence (#268). */
  ringTrimmed: boolean;
  sub: Duplex | null;
  exited: boolean;
}

const sessions = new Map<string, Session>();

function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}${SEP}${sessionId}`;
}

/**
 * Index of the first byte of `history` that is safe to feed a terminal as the
 * start of a stream (#268).
 *
 * The ring drops whole chunks off the front, and PTY chunk boundaries are
 * whatever the OS handed over — they do not align with escape sequences. So
 * the retained head routinely begins *inside* one. Replay that verbatim and
 * the terminal sees the sequence's tail as ordinary text and prints it: drop
 * the ESC from `ESC[6n` (the cursor-position query) and a literal `[6n`
 * lands in the transcript. Same for a cut mid-word, which is where the
 * reported `Re` / `Th` / `So.` fragments came from. Nothing ever repairs it,
 * because scrollback is never rewritten.
 *
 * Two byte positions are guaranteed not to be mid-sequence: an ESC (0x1B),
 * which always *starts* a sequence, and the byte after a newline, which a CSI
 * sequence cannot span. Take whichever comes first so we discard as little
 * restored scrollback as possible. Both are ASCII, so this also lands on a
 * UTF-8 codepoint boundary for free.
 *
 * Cost: up to one partial line of history. When the cut happens to land on a
 * clean line start we drop one real line — cheap next to printing control
 * residue over the user's transcript.
 */
export function safeReplayStart(history: Buffer): number {
  if (history.length === 0) return 0;

  const esc = history.indexOf(0x1b);
  const nl = history.indexOf(0x0a);

  if (esc < 0 && nl < 0) {
    // One unterminated line with no escapes: nothing can be cut safely, but
    // don't hand the decoder a dangling UTF-8 continuation byte.
    let i = 0;
    while (i < history.length && (history[i] & 0xc0) === 0x80) i++;
    return i;
  }
  if (esc < 0) return nl + 1;
  if (nl < 0) return esc;
  return Math.min(esc, nl + 1);
}

function appendRing(s: Session, buf: Buffer): void {
  s.ring.push(buf);
  s.ringBytes += buf.length;
  // Trim oldest chunks once over cap (keep at least the latest chunk).
  while (s.ringBytes > RING_CAP_BYTES && s.ring.length > 1) {
    s.ringBytes -= s.ring.shift()!.length;
    s.ringTrimmed = true;
  }
}

export interface AttachOpts {
  workspaceId: string;
  sessionId: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The `claude` binary (absolute path or name on PATH). */
  file: string;
  /** Claude session UUID to resume; spawns `claude --resume <uuid>`. */
  resumeOf?: string;
  /** Host-assigned claude session UUID for a FRESH spawn (#195): passed as
   *  `--session-id` so the broker→claude mapping is known up front instead of
   *  guessed from JSONL appearance order. Ignored when resumeOf is set. */
  claudeSessionId?: string;
  /** Fired only when this attach actually spawned claude, with the session
   *  UUID the process will use (resumeOf, else claudeSessionId). The caller
   *  learns the tab→claude mapping here — never on a re-attach, where the
   *  live process's id is whatever it already was. */
  onFreshSpawn?: (claudeSessionId: string) => void;
  /** Path to a `--mcp-config` file wiring the fleet MCP server (#16, optional). */
  mcpConfigPath?: string;
  /** Extra args prepended before claude's own flags. Used by e2e tests to
   *  inject a stub script path when CLAUDE_FLEET_LOCAL_CLAUDE_BIN is an
   *  interpreter (e.g. `node`) rather than a self-contained binary. */
  extraArgs?: string[];
  /** Which harness drives this workspace. Absent = 'claude-code'. qwen-code is
   *  not yet supported for local workspaces (binary resolution deferred to Task 5). */
  harness?: Harness;
  spawn: SpawnPty;
}

/**
 * Attach to a local session, spawning `claude` if it isn't already running.
 * Returns a `PtyHandle` whose `stream` is wired to the live process; `detach`
 * leaves the process alive (the whole point — a workspace switch must not kill
 * `claude`), while `stop`/`remove` (via killWorkspaceSessions) end it.
 */
export function attachLocalSession(opts: AttachOpts): PtyHandle {
  if (opts.harness === 'qwen-code') {
    throw new Error('qwen-code harness is not yet supported for local workspaces');
  }
  const key = sessionKey(opts.workspaceId, opts.sessionId);
  let session = sessions.get(key);

  if (!session || session.exited) {
    const args = [
      ...(opts.extraArgs ?? []),
      ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
      ...(opts.resumeOf
        ? ['--resume', opts.resumeOf]
        : opts.claudeSessionId
          ? ['--session-id', opts.claudeSessionId]
          : [])
    ];
    const proc = opts.spawn({
      file: opts.file,
      args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: { ...opts.env, CLAUDE_FLEET_BROKER_SESSION_ID: opts.sessionId }
    });
    const s: Session = { proc, ring: [], ringBytes: 0, ringTrimmed: false, sub: null, exited: false };
    sessions.set(key, s);
    proc.onData((data) => {
      const buf = Buffer.from(data, 'utf8');
      appendRing(s, buf);
      s.sub?.push(buf);
    });
    proc.onExit(() => {
      s.exited = true;
      s.sub?.push(null);
      sessions.delete(key);
    });
    session = s;
    const spawnedId = opts.resumeOf ?? opts.claudeSessionId;
    if (spawnedId) opts.onFreshSpawn?.(spawnedId);
  }

  const s = session;

  // Defensive: if a prior subscriber is still wired (no detach ran), end it
  // before swapping in the new one — only one writer/reader at a time.
  if (s.sub) {
    const prev = s.sub;
    s.sub = null;
    prev.push(null);
  }

  const stream = new Duplex({
    read() {
      /* push-driven */
    },
    write(chunk: Buffer | string, _enc, cb) {
      try {
        s.proc.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      } catch {
        /* process may have exited between attach and write */
      }
      cb();
    }
  });
  s.sub = stream;

  // Replay the ring (broker HISTORY analog) so reattach restores scrollback,
  // starting at a boundary that isn't inside an escape sequence (#268 — see
  // safeReplayStart). Concatenated first because the safe boundary may lie
  // past the end of the (arbitrarily sized) first retained chunk.
  const history = Buffer.concat(s.ring);
  // An untrimmed ring still holds byte 0 of the session — replay it as-is.
  const from = s.ringTrimmed ? safeReplayStart(history) : 0;
  if (from < history.length) stream.push(history.subarray(from));
  if (s.exited) stream.push(null);

  return {
    stream,
    // Report failure instead of swallowing it (#268). A resize that never
    // reaches the pty leaves claude laying out at a stale width while xterm
    // renders at the new one; every full-width row then overflows by the
    // difference and wraps onto the next line's first columns, permanently
    // corrupting scrollback. The renderer only advances its "last sent size"
    // latch when this resolves true, so a dropped resize is retried rather
    // than being remembered as delivered.
    resize: async (cols: number, rows: number) => {
      if (s.exited) return false;
      try {
        s.proc.resize(cols, rows);
        return true;
      } catch {
        return false;
      }
    },
    getSize: () => s.proc.getSize?.(),
    detach: () => {
      // Leave proc + ring alive (workspace switch / reattach). Just unwire.
      if (s.sub === stream) s.sub = null;
      stream.destroy();
    },
    close: async () => {
      // Terminate the session: kill the claude process and drop it. Loadouts
      // are container-only so this path isn't exercised by the reload today,
      // but the handle must satisfy the PtyHandle contract.
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      if (s.sub === stream) s.sub = null;
      s.exited = true;
      sessions.delete(key);
      stream.destroy();
    }
  };
}

/** Kill every live session for a workspace (stop / remove). */
export function killWorkspaceSessions(workspaceId: string): void {
  const prefix = `${workspaceId}${SEP}`;
  for (const [key, s] of sessions) {
    if (!key.startsWith(prefix)) continue;
    try {
      s.proc.kill();
    } catch {
      /* already dead */
    }
    s.sub?.push(null);
    sessions.delete(key);
  }
}

/** Is this exact tab's process alive right now? False for a tab that exited
 *  or was never spawned in this app run — the signal the local backend's
 *  cross-restart auto-resume keys off (a dead/unknown tab with a verified
 *  broker→claude mapping re-spawns as `claude --resume <uuid>`). */
export function hasLiveSession(workspaceId: string, sessionId: string): boolean {
  const s = sessions.get(sessionKey(workspaceId, sessionId));
  return !!s && !s.exited;
}

export function hasLiveSessions(workspaceId: string): boolean {
  const prefix = `${workspaceId}${SEP}`;
  for (const [key, s] of sessions) {
    if (key.startsWith(prefix) && !s.exited) return true;
  }
  return false;
}

/** Test-only: clear all sessions between cases. */
export function _resetForTest(): void {
  sessions.clear();
}
