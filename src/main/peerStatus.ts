// Claude's authoritative per-process status file (#286).
//
// Claude Code writes `~/.claude/sessions/<pid>.json` for every session:
//   {"pid":41420,"sessionId":"<uuid>","cwd":"…","status":"idle","statusUpdatedAt":…}
// with `status: busy | idle | waiting` (+ `waitingFor` when waiting). This is
// the ground truth the terminal-title glyph only approximates — the glyph can't
// tell idle from "waiting on input", and any signal parsed from PTY output can
// be lost upstream (the #283 stale-busy gap). We reconcile the renderer's busy
// state against these files.
//
// Pure parser (no fs) so it's unit-tested with plain strings. The watcher reads
// the file and hands the raw text here.

export type PeerStatusKind = 'busy' | 'idle' | 'waiting';

export interface PeerStatus {
  /** claude session UUID — the namespace-independent join key against the
   *  broker→claude mapping (works identically for container and local). */
  sessionId: string;
  status: PeerStatusKind;
  /** e.g. "input needed" — present when status is waiting. */
  waitingFor?: string;
  statusUpdatedAt?: number;
}

const KINDS = new Set<PeerStatusKind>(['busy', 'idle', 'waiting']);

/** Parse a peer-status file's contents, or null if malformed / not a status
 *  file (tolerates partial reads mid-write — the watcher re-reads on change). */
export function parsePeerStatus(raw: string): PeerStatus | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.sessionId !== 'string' || o.sessionId.length === 0) return null;
  if (typeof o.status !== 'string' || !KINDS.has(o.status as PeerStatusKind)) return null;
  const out: PeerStatus = { sessionId: o.sessionId, status: o.status as PeerStatusKind };
  if (typeof o.waitingFor === 'string' && o.waitingFor.length > 0) out.waitingFor = o.waitingFor;
  if (typeof o.statusUpdatedAt === 'number' && Number.isFinite(o.statusUpdatedAt)) {
    out.statusUpdatedAt = o.statusUpdatedAt;
  }
  return out;
}
