// Electron wiring for automations (#407 Phase 3): `automations:*` IPC, the MCP
// handlers, the 30 s scheduler tick and startup recovery. Effects into
// workspaces use ipc.ts's host-trusted functions (no committee gate).
import { BrowserWindow, ipcMain } from 'electron';
import { hostEnsureRunning, hostPostToWorkspace, hostWorkspaceBusy, hostWorkspaceNames, hostWorkspaceState } from '../ipc.js';
import { setAutomationHandlers } from '../mcpServer.js';
import { logError } from '../errorLog.js';
import type { InboxStore } from '../inbox/inboxDb.js';
import type { NotifyService } from '../inbox/notifyService.js';
import { emitInboxChanged } from '../inbox/inboxEvents.js';
import { AutomationStore } from './automationStore.js';
import { createAutomationService, type AutomationService } from './automationService.js';
import { STARTER_YAML } from './definition.js';

function send(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send(channel, payload); } catch { /* mid-teardown */ }
  }
}

export function registerAutomationIpc(inbox: InboxStore, notify: NotifyService | null): AutomationService {
  const store = new AutomationStore(inbox.db);
  // Name ↔ id map refreshed on use; automations name workspaces in YAML.
  let names: Array<{ id: string; name: string }> = [];
  const refresh = async () => { names = await hostWorkspaceNames().catch(() => names); };
  void refresh();

  const svc = createAutomationService({
    store,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    workspaceState: async (id) => { await refresh(); return hostWorkspaceState(id); },
    workspaceName: (id) => names.find((n) => n.id === id)?.name ?? id,
    ensureRunning: hostEnsureRunning,
    post: hostPostToWorkspace,
    busy: hostWorkspaceBusy,
    resolveWorkspace: (v) => names.find((n) => n.id === v)?.id ?? names.find((n) => n.name === v)?.id ?? null,
    notify: notify ? (n) => notify.request(n) : undefined,
    changed: () => { send('automations:changed'); emitInboxChanged(); }
  });

  try {
    svc.recover();
  } catch (e) {
    logError({ source: 'main', type: 'automation-recover', level: 'warn', message: String(e) });
  }
  const tick = setInterval(() => {
    void refresh().then(() => {
      try { svc.tick(); } catch (e) { logError({ source: 'main', type: 'automation-tick', level: 'warn', message: String(e) }); }
    });
  }, 30_000);
  tick.unref?.();

  setAutomationHandlers({
    list: async (callerId) => { await refresh(); return svc.mcp.list(callerId); },
    run: async (callerId, args) => { await refresh(); return svc.mcp.run(callerId, args); }
  });

  const USER = { kind: 'user' as const, id: null };
  const withNames = async <T>(fn: () => T): Promise<T> => { await refresh(); return fn(); };
  ipcMain.handle('automations:list', () => withNames(() => svc.list()));
  ipcMain.handle('automations:get', (_e, id: string) => withNames(() => svc.get(id)));
  ipcMain.handle('automations:validate', (_e, text: string) => withNames(() => svc.validate(String(text ?? ''))));
  ipcMain.handle('automations:create', (_e, text: string) => withNames(() => svc.create(String(text ?? ''), USER)));
  ipcMain.handle('automations:update', (_e, id: string, text: string) => withNames(() => svc.update(id, String(text ?? ''), USER)));
  ipcMain.handle('automations:setEnabled', (_e, id: string, enabled: boolean) => svc.setEnabled(id, enabled === true));
  ipcMain.handle('automations:remove', (_e, id: string) => svc.remove(id));
  ipcMain.handle('automations:run', (_e, id: string, args: Record<string, unknown>) =>
    withNames(() => svc.run(id, { kind: 'manual', by: USER, args: args ?? {}, coerce: true })));
  ipcMain.handle('automations:starter', () =>
    withNames(() => STARTER_YAML.replace('REPLACE-WITH-WORKSPACE-NAME', names[0]?.name ?? 'REPLACE-WITH-WORKSPACE-NAME')));
  return svc;
}
