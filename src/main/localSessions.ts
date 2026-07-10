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

/** Minimal PTY-process shape the manager needs. node-pty's IPty satisfies it
 *  (wrapped in local.ts); tests supply a fake. */
export interface PtyProc {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
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
  sub: Duplex | null;
  exited: boolean;
}

const sessions = new Map<string, Session>();

function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}${SEP}${sessionId}`;
}

function appendRing(s: Session, buf: Buffer): void {
  s.ring.push(buf);
  s.ringBytes += buf.length;
  // Trim oldest chunks once over cap (keep at least the latest chunk).
  while (s.ringBytes > RING_CAP_BYTES && s.ring.length > 1) {
    s.ringBytes -= s.ring.shift()!.length;
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
  spawn: SpawnPty;
}

/**
 * Attach to a local session, spawning `claude` if it isn't already running.
 * Returns a `PtyHandle` whose `stream` is wired to the live process; `detach`
 * leaves the process alive (the whole point — a workspace switch must not kill
 * `claude`), while `stop`/`remove` (via killWorkspaceSessions) end it.
 */
export function attachLocalSession(opts: AttachOpts): PtyHandle {
  const key = sessionKey(opts.workspaceId, opts.sessionId);
  let session = sessions.get(key);

  if (!session || session.exited) {
    const args = [
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
    const s: Session = { proc, ring: [], ringBytes: 0, sub: null, exited: false };
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

  // Replay the ring (broker HISTORY analog) so reattach restores scrollback.
  for (const b of s.ring) stream.push(b);
  if (s.exited) stream.push(null);

  return {
    stream,
    resize: async (cols: number, rows: number) => {
      if (!s.exited) {
        try {
          s.proc.resize(cols, rows);
        } catch {
          /* exited */
        }
      }
    },
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

/** Send a signal (SIGSTOP/SIGCONT for pause/resume) to a workspace's sessions. */
export function signalWorkspaceSessions(workspaceId: string, signal: 'SIGSTOP' | 'SIGCONT'): void {
  const prefix = `${workspaceId}${SEP}`;
  for (const [key, s] of sessions) {
    if (key.startsWith(prefix) && !s.exited) {
      try {
        s.proc.kill(signal);
      } catch {
        /* */
      }
    }
  }
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
