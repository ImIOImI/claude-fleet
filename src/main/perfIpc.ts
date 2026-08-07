// Generic IPC instrumentation: patch `ipcMain.handle` once, before ipc.ts
// registers anything, so every invoke handler runs inside a
// `claude_fleet.ipc.<channel>` span. With recording off the tracer is a
// no-op, so the wrapper's cost is one extra async frame per invoke.

import { perfSpanAsync } from './perf.js';

export function instrumentIpcHandle(ipc: {
  handle: (channel: string, listener: (...args: never[]) => unknown) => void;
}): void {
  const raw = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, listener: (...args: never[]) => unknown) =>
    raw(channel, ((...args: never[]) =>
      perfSpanAsync(`claude_fleet.ipc.${channel}`, () => listener(...args))) as never);
}
