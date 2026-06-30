// Resilient `inputwait:update` fan-out — mirrors observabilityBroadcast.ts /
// mcpStatusBroadcast.ts. Pure (no electron/DB/fs) so it's unit-testable with
// plain stubs. Fires from the MCP signal_input_wait handler, not an awaited IPC
// call, so per-target sends are guarded (a window mid-teardown can throw).
import type { BroadcastTarget } from './mcpStatusBroadcast.js';

export function broadcastInputWait(
  payload: { workspaceId: string; waitingSessionIds: string[] },
  targets: readonly BroadcastTarget[]
): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('inputwait:update', payload);
    } catch {
      // swallow — see observabilityBroadcast.ts top-of-file comment.
    }
  }
}
