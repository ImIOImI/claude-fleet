// Resilient `mcp:status` fan-out to every renderer window — mirrors
// observabilityBroadcast.ts. Pure (no electron/DB/fs): the caller (index.ts)
// passes `BrowserWindow.getAllWindows()`, which structurally satisfies
// BroadcastTarget, so this is unit-testable with plain stubs.
//
// Drives the "MCP unreachable" sticky toast (#159 follow-up): when the host
// MCP listener fails to bind (chiefly EADDRINUSE on win32 :7071) the renderer
// shows it; when the listener (re)binds, the renderer clears it.

export interface BroadcastTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export interface McpStatus {
  ok: boolean;
  detail?: string;
}

/** Send `mcp:status` to every non-destroyed target. Per-target failures are
 *  swallowed (a window mid-teardown can still throw "Render frame was disposed"
 *  — see observabilityBroadcast.ts) so one bad window doesn't abort the rest. */
export function broadcastMcpStatus(status: McpStatus, targets: readonly BroadcastTarget[]): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('mcp:status', status);
    } catch {
      // swallow — see top-of-file comment.
    }
  }
}
