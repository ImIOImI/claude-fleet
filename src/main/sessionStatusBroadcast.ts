// Resilient `sessionstatus:update` fan-out — mirrors inputWaitBroadcast.ts /
// observabilityBroadcast.ts. Pure (no electron/DB/fs) so it's unit-testable with
// plain stubs. Carries the authoritative peer-status snapshot (#286): a flat
// list of `{ claudeSessionId, status }` the renderer merges over the title
// glyph. Flat (not per-workspace) because claude session ids are globally
// unique — the renderer attributes them to workspaces via its own broker→claude
// mappings. Per-target sends are guarded (a window mid-teardown can throw).
import type { BroadcastTarget } from './mcpStatusBroadcast.js';

export interface SessionStatusEntry {
  claudeSessionId: string;
  status: 'busy' | 'idle' | 'waiting';
  waitingFor?: string;
}

export function broadcastSessionStatus(
  statuses: readonly SessionStatusEntry[],
  targets: readonly BroadcastTarget[]
): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('sessionstatus:update', { statuses });
    } catch {
      // swallow — see observabilityBroadcast.ts top-of-file comment.
    }
  }
}
