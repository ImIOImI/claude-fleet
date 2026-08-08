// Pure lookup over the pty handle maps (electron-free, vitest-loadable).
//
// The renderer addresses a live PTY by its per-attach `ptyHandleId`, but a tab
// only knows its stable broker session id. To reap a session on tab-close
// (#287) main must resolve (workspaceId, brokerSessionId) → the live handle.
// At most one live handle exists per (workspace, broker session): a tab attaches
// once, and detach drops the handle before any re-attach.

/**
 * ptyHandleId of the live handle for `(workspaceId, brokerSessionId)`, or null
 * if none is attached. `handleWorkspaceId` and `handleBrokerSessionId` are the
 * per-attach maps kept in ipc.ts (both keyed by ptyHandleId).
 */
export function findLiveHandleId(
  handleWorkspaceId: ReadonlyMap<string, string>,
  handleBrokerSessionId: ReadonlyMap<string, string>,
  workspaceId: string,
  brokerSessionId: string
): string | null {
  for (const [ptyHandleId, bsid] of handleBrokerSessionId) {
    if (bsid === brokerSessionId && handleWorkspaceId.get(ptyHandleId) === workspaceId) {
      return ptyHandleId;
    }
  }
  return null;
}
