// Merge the authoritative peer-status signal (#286) with the low-latency title
// glyph. Claude writes `~/.claude/sessions/<pid>.json` with the true
// busy|idle|waiting per session; main watches those files and pushes a flat
// `claudeSessionId → status` map to the renderer. The glyph (parsed from PTY
// output, keyed by broker session id and resolved to claude ids here) can go
// stale (#283) or can't tell idle from waiting — so where the peer knows a
// session, its verdict is authoritative; the glyph covers only sessions the
// peer hasn't reported yet.
//
// Pure so the precedence rules are unit-tested independent of React/IPC.

export type PeerKind = 'busy' | 'idle' | 'waiting';

/**
 * Busy *claude* session ids: peer-status overrides the glyph per session.
 * A session the peer reports uses the peer's verdict (busy ⇒ in; idle/waiting ⇒
 * out, even if the glyph is stuck busy — the #283 self-heal); a session the peer
 * hasn't reported falls back to the glyph.
 */
export function resolveBusyClaudeIds(
  glyphBusy: Set<string>,
  peer: Map<string, PeerKind>
): Set<string> {
  const out = new Set<string>();
  for (const id of glyphBusy) if (!peer.has(id)) out.add(id);
  for (const [id, kind] of peer) if (kind === 'busy') out.add(id);
  return out;
}

/**
 * Busy verdict for a single session tab dot (#371). Same precedence as
 * `resolveBusyByWorkspace`: once the broker→claude mapping is known, the
 * peer-reconciled set is authoritative (so a peer-idle session clears a stuck
 * glyph, and a peer-busy one the glyph missed still lights); while the mapping
 * is unresolved, the raw title glyph (keyed by broker id) governs.
 *
 * @param claudeId            broker→claude mapping for this tab, or undefined
 * @param brokerId            this tab's broker session id
 * @param reconciledBusy      busy *claude* ids (from `resolveBusyClaudeIds`)
 * @param glyphBusyBroker     raw title-glyph busy set, keyed by broker id
 */
export function resolveTabBusy(
  claudeId: string | undefined,
  brokerId: string,
  reconciledBusy: Set<string>,
  glyphBusyBroker: Set<string>
): boolean {
  if (claudeId) return reconciledBusy.has(claudeId);
  return glyphBusyBroker.has(brokerId);
}

/**
 * Waiting *claude* session ids: same override. The glyph can never produce a
 * waiting signal, so `hookWaiting` is the legacy AskUserQuestion-hook set
 * (container-only); peer-status extends waiting to all prompt kinds and all
 * backends, and authoritatively clears a stale hook entry the peer says is
 * idle/busy.
 */
export function resolveWaitingClaudeIds(
  hookWaiting: Set<string>,
  peer: Map<string, PeerKind>
): Set<string> {
  const out = new Set<string>();
  for (const id of hookWaiting) if (!peer.has(id)) out.add(id);
  for (const [id, kind] of peer) if (kind === 'waiting') out.add(id);
  return out;
}

/**
 * Per-workspace busy chip, with per-session peer override. The glyph chip is
 * just the OR of `glyphBusyBroker[ws]`; we recompute it so a session the peer
 * marks idle can clear a stuck chip (#283), while a busy session the peer hasn't
 * mapped yet still keeps the chip lit.
 *
 * @param glyphBusyBroker  ws → busy *broker* session ids (glyph)
 * @param mappings         ws → (broker session id → claude session id)
 * @param peer             claude session id → status
 */
export function resolveBusyByWorkspace(
  glyphBusyBroker: Record<string, string[]>,
  mappings: Map<string, Map<string, string>>,
  peer: Map<string, PeerKind>
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const workspaces = new Set<string>([...Object.keys(glyphBusyBroker), ...mappings.keys()]);
  for (const ws of workspaces) {
    const map = mappings.get(ws);
    // Glyph busy for sessions the peer hasn't reported (broker→claude unmapped,
    // or mapped to a claude id with no peer entry) — glyph still governs those.
    let glyphBusyUnknown = false;
    for (const broker of glyphBusyBroker[ws] ?? []) {
      const claude = map?.get(broker);
      if (!claude || !peer.has(claude)) {
        glyphBusyUnknown = true;
        break;
      }
    }
    // Peer says any of this workspace's known sessions is busy.
    let peerBusy = false;
    if (map) {
      for (const claude of map.values()) {
        if (peer.get(claude) === 'busy') {
          peerBusy = true;
          break;
        }
      }
    }
    out[ws] = glyphBusyUnknown || peerBusy;
  }
  return out;
}

/**
 * Per-workspace waiting chip. A workspace waits if the legacy hook set has an
 * entry the peer hasn't overridden, or the peer reports any of the workspace's
 * mapped sessions as waiting.
 *
 * @param hookWaitingByWs  ws → claude session ids from the AskUserQuestion hook
 * @param mappings         ws → (broker session id → claude session id)
 * @param peer             claude session id → status
 */
export function resolveWaitingByWorkspace(
  hookWaitingByWs: Map<string, Set<string>>,
  mappings: Map<string, Map<string, string>>,
  peer: Map<string, PeerKind>
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const workspaces = new Set<string>([...hookWaitingByWs.keys(), ...mappings.keys()]);
  for (const ws of workspaces) {
    let waiting = false;
    for (const id of hookWaitingByWs.get(ws) ?? []) {
      if (!peer.has(id)) {
        waiting = true;
        break;
      }
    }
    if (!waiting) {
      const map = mappings.get(ws);
      if (map) {
        for (const claude of map.values()) {
          if (peer.get(claude) === 'waiting') {
            waiting = true;
            break;
          }
        }
      }
    }
    if (waiting) out[ws] = true;
  }
  return out;
}
