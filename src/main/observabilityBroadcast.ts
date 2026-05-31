// Resilient `observability:summary` fan-out to every renderer window.
//
// Pure module — no electron import, no DB, no fs. The caller (ipc.ts)
// passes `BrowserWindow.getAllWindows()` (which structurally satisfies
// `BroadcastTarget`), so this helper is unit-testable with plain stubs.
//
// The reason this exists as its own helper: the broadcast runs from the
// JsonlWatcher's 'ingest' emit, not an awaited IPC handler. An exception
// here unwinds into Node's EventEmitter internals and skips later
// listeners. We need a paranoid wrapper that swallows the one error
// Electron throws during window teardown (see comment below).

export interface BroadcastTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/**
 * Send `observability:summary` with the payload to every non-destroyed
 * target. Per-target failures are swallowed so one bad window doesn't
 * abort the broadcast.
 *
 * The non-obvious case: during BrowserWindow teardown there's a
 * transient window where both `win.isDestroyed()` and
 * `win.webContents.isDestroyed()` still return false, but the
 * underlying render frame has already been disposed. `webContents.send`
 * then throws "Render frame was disposed before WebFrameMain could be
 * accessed". The try/catch is what catches that case. Missing a push
 * for a closing window is harmless — App.tsx's 30s safety poll catches
 * any fresh window up.
 */
export function broadcastObservabilitySummary(
  payload: { workspaceId: string; summary: unknown },
  targets: readonly BroadcastTarget[]
): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('observability:summary', payload);
    } catch {
      // swallow — see top-of-file comment.
    }
  }
}
