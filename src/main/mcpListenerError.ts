// Durable, actionable formatting for a host MCP listener bind failure (#159).
//
// Background: the host MCP listener (on win32, the single loopback-TCP listener
// at 127.0.0.1:7071; on Linux/macOS, a per-workspace unix socket) used to route
// its `error` event to `console.warn` only. `errorLog.ts` captures uncaught
// exceptions/rejections — not this — so a swallowed bind failure left NO durable
// trace: a double-clicked app discards the one line that would explain why a
// container's `claude-fleet-state` MCP shows "✘ Failed to connect".
//
// This module turns a raw listener error into a `logError`-shaped payload so the
// failure lands in error.log with enough context to diagnose. It is deliberately
// pure (no electron / native deps) — like `mcpReadonlySql.ts` / `mcpSocket.ts` —
// so it is unit-testable without mocking; `mcpServer.ts` wires it to the real
// `errorLog.logError` + `console`.

/** Which listener failed. `tcp` is the shared win32 loopback listener (carries a
 *  `port`); `unix` is a per-workspace socket (carries the `workspaceId`). */
export type ListenerScope =
  | { scope: 'tcp'; port: number }
  | { scope: 'unix'; workspaceId: string };

/** A `logError`-shaped payload (matches `errorLog.ts` LogPayload, minus the
 *  always-`main` source the caller fills in). `extra` is structured so the log
 *  line is greppable by `scope` / `code` / `port` / `workspaceId`. */
export interface ListenerErrorReport {
  type: 'mcpListenerError';
  message: string;
  stack?: string;
  extra: {
    scope: 'tcp' | 'unix';
    code?: string;
    port?: number;
    workspaceId?: string;
  };
}

function codeOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Build a durable, human-actionable report for a listener `error` event.
 *  EADDRINUSE — the leading #159 root cause — gets an explicit message naming
 *  the port/workspace and pointing at the real culprit (another claude-fleet
 *  instance still holding the address), since the bare "address already in use"
 *  doesn't tell the user that. */
export function describeListenerError(where: ListenerScope, err: unknown): ListenerErrorReport {
  const code = codeOf(err);
  const raw = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  const extra: ListenerErrorReport['extra'] =
    where.scope === 'tcp'
      ? { scope: 'tcp', code, port: where.port }
      : { scope: 'unix', code, workspaceId: where.workspaceId };

  let message: string;
  if (code === 'EADDRINUSE') {
    message =
      where.scope === 'tcp'
        ? `MCP host listener could not bind 127.0.0.1:${where.port} (EADDRINUSE): the port is already in use, ` +
          `most likely by another claude-fleet instance still running. In-container MCP (claude-fleet-state) ` +
          `will show "Failed to connect" until the stale instance is closed. Original: ${raw}`
        : `MCP host listener could not bind the socket for workspace ${where.workspaceId} (EADDRINUSE): ` +
          `a stale socket or duplicate listener is holding it. That workspace's claude-fleet-state MCP ` +
          `will show "Failed to connect" until it is freed. Original: ${raw}`;
  } else {
    message =
      where.scope === 'tcp'
        ? `MCP host TCP listener error on 127.0.0.1:${where.port}: ${raw}`
        : `MCP host listener error for workspace ${where.workspaceId}: ${raw}`;
  }

  return { type: 'mcpListenerError', message, stack, extra };
}
