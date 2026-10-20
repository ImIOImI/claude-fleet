// Resilient `inbox:changed` fan-out — mirrors inputWaitBroadcast.ts. Pure.
import type { BroadcastTarget } from '../mcpStatusBroadcast.js';
import type { InboxCounts } from '../../preload/inboxTypes.js';

export function broadcastInboxChanged(counts: InboxCounts, targets: readonly BroadcastTarget[]): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('inbox:changed', { counts });
    } catch {
      // a window mid-teardown can throw; never let a broadcast break a write
    }
  }
}
