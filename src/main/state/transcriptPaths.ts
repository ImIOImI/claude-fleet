// Transcript path → session id, shared by the desktop watcher and fleet-host ingest.
import { basename, extname } from 'node:path';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_FILE_RE = /^agent-.*\.jsonl$/i;

/** Parent session id from a subagent transcript path
 *  `.../<parent-session-uuid>/subagents/agent-*.jsonl`, or null. */
export function parseSubagentPath(path: string): { parentSessionId: string } | null {
  const segs = path.split(/[\\/]/);
  const file = segs[segs.length - 1] ?? '';
  if (!AGENT_FILE_RE.test(file)) return null;
  if (segs[segs.length - 2] !== 'subagents') return null;
  const parent = segs[segs.length - 3] ?? '';
  return UUID_RE.test(parent) ? { parentSessionId: parent } : null;
}

/** Session id + sidecar flag from a watched file path, or null if neither a
 *  primary transcript (<uuid>.jsonl) nor a fleet sidecar (<uuid>.fleet.jsonl).
 *  Sidecars carry host-bound events (session-summary chapters, #207) and are
 *  ingested under their session id but NEVER fire 'new-session' — they must
 *  not touch the pending-attach fallback or look like fresh conversations. */
export function parseTranscriptFilename(
  path: string
): { sessionId: string; sidecar: boolean } | null {
  if (extname(path) !== '.jsonl') return null;
  let stem = basename(path, '.jsonl');
  let sidecar = false;
  if (stem.endsWith('.fleet')) {
    stem = stem.slice(0, -'.fleet'.length);
    sidecar = true;
  }
  if (!UUID_RE.test(stem)) return null;
  return { sessionId: stem, sidecar };
}
