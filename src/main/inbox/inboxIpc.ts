// Electron wiring for the inbox (#407): `inbox:*` IPC for the renderer and the
// MCP handlers for workspaces. The effects live in inboxService.ts (pure), so
// this file only binds them to ipcMain / BrowserWindow / the manifest reader.
import { BrowserWindow, ipcMain } from 'electron';
import type { TodoFilter } from '../../preload/inboxTypes.js';
import { readWorkspaceManifest } from '../workspaces.js';
import { setInboxHandlers } from '../mcpServer.js';
import { logError } from '../errorLog.js';
import { broadcastInboxChanged } from './inboxBroadcast.js';
import { emitInboxChanged } from './inboxEvents.js';
import { createInboxService } from './inboxService.js';
import type { InboxStore } from './inboxDb.js';
import type { NotifyService } from './notifyService.js';

/** Register `inbox:*` IPC and the MCP handlers. Called once from index.ts. */
export function registerInboxIpc(
  store: InboxStore,
  notifications?: NotifyService,
  attribution?: (runId: string, callerId: string) => { automationId: string } | null
): void {
  const svc = createInboxService(store, {
    manifest: (id) => readWorkspaceManifest(id),
    notifyChanged: () => {
      broadcastInboxChanged(store.counts(), BrowserWindow.getAllWindows());
      emitInboxChanged();
    },
    onPostRejected: (workspaceId, reason) => {
      logError({ source: 'main', type: 'inbox-post-rejected', level: 'warn', message: reason, workspaceId });
      notifications?.onPostRejected(workspaceId, reason);
    },
    notifications,
    attribution
  });
  setInboxHandlers(svc.mcp);
  ipcMain.handle('inbox:list', (_e, filter?: TodoFilter) => svc.ipc.list(filter ?? {}));
  ipcMain.handle('inbox:get', (_e, id: string) => svc.ipc.get(id));
  ipcMain.handle('inbox:create', (_e, input: Record<string, unknown>) => svc.ipc.create(input ?? {}));
  ipcMain.handle('inbox:update', (_e, id: string, patch: Record<string, unknown>) => svc.ipc.update(id, patch ?? {}));
  ipcMain.handle('inbox:counts', () => svc.ipc.counts());
}
