// Resolving the busy "session chip" set (#…).
//
// Busy/idle is detected per terminal tab and is keyed by *broker* session id
// (the stable tab id). The left-rail Sessions list, however, is keyed by the
// *claude* session UUID. To pulse only the genuinely-running session's row we
// translate the busy broker ids to claude UUIDs using each workspace's learned
// broker→claude mapping (sourced in App from
// `observability.summaryForBrokerSession(...).sessionId`).
//
// Pure so the translation is unit-tested independent of React/IPC.

/**
 * @param busyBrokerByWorkspace  workspace id → its currently-busy broker session ids
 * @param mappings               workspace id → (broker session id → claude session UUID)
 * @returns the set of busy *claude* session UUIDs; broker sessions whose
 *          mapping isn't known yet are skipped (they surface once observability
 *          learns the mapping and the caller re-resolves).
 */
export function busyClaudeIdSet(
  busyBrokerByWorkspace: Record<string, string[]>,
  mappings: Map<string, Map<string, string>>
): Set<string> {
  const out = new Set<string>();
  for (const [workspaceId, brokerIds] of Object.entries(busyBrokerByWorkspace)) {
    const map = mappings.get(workspaceId);
    if (!map) continue;
    for (const brokerId of brokerIds) {
      const claudeId = map.get(brokerId);
      if (claudeId) out.add(claudeId);
    }
  }
  return out;
}

/** A live terminal tab, addressed for jump-to-tab. */
export interface OpenTabRef {
  workspaceId: string;
  brokerSessionId: string;
}

/**
 * Resolve live tab *broker* ids to a claude-UUID-keyed open map, the same
 * translation busyClaudeIdSet does but keeping the (workspace, tab) address
 * so the Sessions list can jump to the tab. Unmapped broker ids are skipped
 * (they resolve once observability learns the mapping and the caller
 * re-resolves).
 */
export function openSessionMap(
  liveBrokerByWorkspace: Record<string, string[]>,
  mappings: Map<string, Map<string, string>>
): Map<string, OpenTabRef> {
  const out = new Map<string, OpenTabRef>();
  for (const [workspaceId, brokerIds] of Object.entries(liveBrokerByWorkspace)) {
    const map = mappings.get(workspaceId);
    if (!map) continue;
    for (const brokerSessionId of brokerIds) {
      const claudeId = map.get(brokerSessionId);
      if (claudeId) out.set(claudeId, { workspaceId, brokerSessionId });
    }
  }
  return out;
}
