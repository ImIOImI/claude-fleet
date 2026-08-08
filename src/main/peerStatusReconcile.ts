// Collapse per-file peer-statuses into an authoritative per-session snapshot
// (#286). Pure so it's unit-tested independent of the watcher/fs.
//
// A single claude session id can be described by more than one `<pid>.json`
// file: resuming a session spawns a new pid (new file) while the old pid's file
// may linger with a now-stale status. The live process writes the newer
// `statusUpdatedAt`, so the newest timestamp wins. An entry carrying a timestamp
// always beats one without (a file that never recorded one is older by
// assumption); between two timestampless entries, last-seen wins.

import type { PeerStatus } from './peerStatus.js';

export function reducePeerStatuses(entries: Iterable<PeerStatus>): Map<string, PeerStatus> {
  const out = new Map<string, PeerStatus>();
  for (const e of entries) {
    const prev = out.get(e.sessionId);
    if (!prev || isNewer(e, prev)) out.set(e.sessionId, e);
  }
  return out;
}

function isNewer(a: PeerStatus, b: PeerStatus): boolean {
  const ta = a.statusUpdatedAt;
  const tb = b.statusUpdatedAt;
  if (ta !== undefined && tb !== undefined) return ta >= tb;
  if (ta !== undefined) return true; // timestamped beats timestampless
  if (tb !== undefined) return false;
  return true; // both timestampless → last-seen wins
}
