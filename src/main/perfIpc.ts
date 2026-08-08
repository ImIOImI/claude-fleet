// Generic IPC instrumentation: patch `ipcMain.handle` once, before ipc.ts
// registers anything, so every invoke handler runs inside a
// `claude_fleet.ipc.<channel>` span. With recording off the tracer is a
// no-op, so the wrapper's cost is one extra async frame per invoke.
//
// CHANNEL_CONTEXT stamps workspace/session attribution from handler args
// where the ids are literally present (the SQLite exporter lifts the
// `workspace_id`/`session_id` attributes into perf_events columns, which
// also scopes those rows to the workspace in the MCP query snapshot).
// Channels whose ids are only known post-lookup (pty:*) instead call
// perfSetSpanContext inside the handler. Channels with no id in their args
// (workspace:list, config:*, …) are deliberately absent: their rows stay
// app-global. NOTE: `workspace:stop/pause/remove` and `workspace:ensureImage`
// receive a container/channel id, not a workspace ULID — mapping them would
// stamp the wrong key space, so they are absent too.

import type { Attributes } from '@opentelemetry/api';
import { perfSpanAsync } from './perf.js';

const W0 = { workspaceArg: 0 } as const;
const W0S1 = { workspaceArg: 0, sessionArg: 1 } as const;

/** Channel → 0-based positions (after the Electron event) of id-bearing args.
 *  session ids here are broker session ids for `*ForBrokerSession`/`mirror:*`
 *  — matching what the rest of perf_events already stores. */
const CHANNEL_CONTEXT: Record<string, { workspaceArg?: number; sessionArg?: number }> = {
  'sessions:read': W0,
  'sessions:list': W0,
  'sessions:write': W0,
  'sessions:resume': W0,
  'sessions:delete': W0S1,
  'sessions:resolveResumeTarget': W0S1,
  'workspace:start': W0,
  'workspace:getManifest': W0,
  // committee:* args are (callerId, targetId, …) — both workspace ULIDs. We
  // stamp the CALLER: it owns the span for MCP scoping (the manager sees its
  // own rows), and the target id could be added as an attribute if ever needed.
  'committee:pause': W0,
  'committee:unpause': W0,
  'committee:post': W0,
  'committee:collect': W0,
  'committee:status': W0,
  'committee:roster': W0,
  'loadouts:install': W0,
  'loadouts:uninstall': W0,
  'loadouts:catalog': W0,
  'files:dropOsFiles': W0,
  'files:dropBytes': W0,
  'files:dropUrl': W0,
  'files:dropText': W0,
  'vault:listKeys': W0,
  'vault:getSecret': W0,
  'vault:setSecret': W0,
  'vault:deleteSecret': W0,
  'vault:deleteAllForWorkspace': W0,
  'transcript:list': W0,
  'transcript:hasForBrokerSession': W0S1,
  'transcript:deleteForBrokerSession': W0S1,
  'mirror:setOverride': W0S1,
  'ports:open': W0,
  'ports:kill': W0,
  'observability:summaryForWorkspace': W0,
  'observability:getCostForWorkspace': W0,
  'observability:summaryForBrokerSession': W0S1
};

/** Attribution attrs for a channel invoke. `handlerArgs` excludes the leading
 *  Electron event. Non-string args (optional params omitted) are skipped. */
export function channelAttrs(channel: string, handlerArgs: unknown[]): Attributes | undefined {
  const m = CHANNEL_CONTEXT[channel];
  if (!m) return undefined;
  const attrs: Attributes = {};
  if (m.workspaceArg !== undefined && typeof handlerArgs[m.workspaceArg] === 'string') {
    attrs.workspace_id = handlerArgs[m.workspaceArg] as string;
  }
  if (m.sessionArg !== undefined && typeof handlerArgs[m.sessionArg] === 'string') {
    attrs.session_id = handlerArgs[m.sessionArg] as string;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

export function instrumentIpcHandle(ipc: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (channel: string, listener: (...args: any[]) => unknown) => void;
}): void {
  const raw = ipc.handle.bind(ipc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc.handle = (channel: string, listener: (...args: any[]) => unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw(channel, ((...args: any[]) =>
      perfSpanAsync(`claude_fleet.ipc.${channel}`, () => listener(...args), channelAttrs(channel, args.slice(1)))));
}
