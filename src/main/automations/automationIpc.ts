// Electron wiring for automations (#407 Phase 3): `automations:*` IPC, the MCP
// handlers, the 30 s scheduler tick and startup recovery. Effects into
// workspaces use ipc.ts's host-trusted functions (no committee gate).
import { BrowserWindow, ipcMain } from 'electron';
import {
  hostCloseFresh, hostEnsureRunning, hostFreshState, hostPostToWorkspace, hostSpawnFresh, hostWorkspaceBusy, hostWorkspaceNames,
  hostWorkspaceState, setFleetEventObserver
} from '../ipc.js';
import { inboxEvents } from '../inbox/inboxEvents.js';
import type { Todo } from '../../preload/inboxTypes.js';
import { setAutomationHandlers } from '../mcpServer.js';
import { logError } from '../errorLog.js';
import type { InboxStore } from '../inbox/inboxDb.js';
import type { NotifyService } from '../inbox/notifyService.js';
import { emitInboxChanged } from '../inbox/inboxEvents.js';
import { AutomationStore } from './automationStore.js';
import { createAutomationService, type AutomationService } from './automationService.js';
import { STARTER_YAML } from './definition.js';
import { reviewPrompt } from './review.js';
import { ProposalStore } from './proposalStore.js';
import { createProposalService, type ProposalService } from './proposalService.js';
import { listWorkspaceManifests, readWorkspaceManifest, writeWorkspaceManifest } from '../workspaces.js';
import { broadcastInboxChanged } from '../inbox/inboxBroadcast.js';

function send(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send(channel, payload); } catch { /* mid-teardown */ }
  }
}

export function registerAutomationIpc(inbox: InboxStore, notify: NotifyService | null): { automations: AutomationService; proposals: ProposalService } {
  const store = new AutomationStore(inbox.db);
  // Name ↔ id map refreshed on use; automations name workspaces in YAML.
  let names: Array<{ id: string; name: string }> = [];
  /** The workspace behind the Inbox chip (manifest role 'automations'), if any. */
  let roleWs: string | null = null;
  const refresh = async () => {
    names = await hostWorkspaceNames().catch(() => names);
    roleWs = await listWorkspaceManifests().then((ms) => ms.find((m) => m.role === 'automations')?.id ?? null).catch(() => roleWs);
  };
  const privileged = (id: string) => id === roleWs;
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
    spawnFresh: hostSpawnFresh,
    freshState: hostFreshState,
    closeFresh: hostCloseFresh,
    resolveWorkspace: (v) => names.find((n) => n.id === v)?.id ?? names.find((n) => n.name === v)?.id ?? null,
    notify: notify ? (n) => notify.request(n) : undefined,
    changed: () => { send('automations:changed'); emitInboxChanged(); }
  });

  // Proposals (#407 Phase 5): workspaces propose, the user approves.
  const proposals = createProposalService({
    proposals: new ProposalStore(inbox.db),
    automations: store,
    now: Date.now,
    resolveWorkspace: (v) => names.find((n) => n.id === v)?.id ?? names.find((n) => n.name === v)?.id ?? null,
    workspaceName: (id) => names.find((n) => n.id === id)?.name ?? id,
    trusted: async (id) => {
      const m = await readWorkspaceManifest(id);
      return m?.kind === 'container' && (m.inbox?.trusted === true || m.role === 'automations');
    },
    notify: notify ? (n) => notify.request(n) : undefined,
    changed: () => {
      send('automations:changed');
      send('proposals:changed');
      broadcastInboxChanged(inbox.counts(), BrowserWindow.getAllWindows());
      emitInboxChanged();
    }
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

  // Event triggers (#407 Phase 4).
  setFleetEventObserver((e) => { svc.onEvent(e); });
  inboxEvents.on('todo', (t: Todo) => {
    svc.onEvent({ on: 'todo.created', workspaceId: t.source.kind === 'workspace' ? t.source.id ?? undefined : undefined, todo: { id: t.id, title: t.title, tags: t.tags, source: t.source } });
  });

  setAutomationHandlers({
    list: async (callerId) => { await refresh(); return svc.mcp.list(callerId, privileged(callerId)); },
    run: async (callerId, args) => { await refresh(); return svc.mcp.run(callerId, args, privileged(callerId)); },
    get: async (callerId, args) => { await refresh(); return svc.mcp.get(callerId, args, privileged(callerId)); },
    listRuns: async (callerId, args) => { await refresh(); return svc.mcp.listRuns(callerId, args, privileged(callerId)); },
    propose: async (callerId, args) => { await refresh(); return proposals.mcp.propose(callerId, args); },
    proposeChange: async (callerId, args) => { await refresh(); return proposals.mcp.proposeChange(callerId, args); },
    getProposal: async (callerId, args) => proposals.mcp.get(callerId, args)
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
  // The automations workspace (#407 Phase 5b): one per fleet, container-only, trusted.
  ipcMain.handle('automations:roleWorkspace', async () => { await refresh(); return roleWs; });
  ipcMain.handle('automations:setRole', async (_e, id: string | null) => {
    if (id) {
      const target = await readWorkspaceManifest(id);
      if (!target) throw new Error('workspace not found');
      if (target.kind !== 'container') throw new Error('the automations workspace must be a container workspace');
    }
    for (const m of await listWorkspaceManifests()) {
      if (m.role === 'automations' && m.id !== id) await writeWorkspaceManifest({ ...m, role: undefined });
    }
    if (id) {
      const m = (await readWorkspaceManifest(id))!;
      await writeWorkspaceManifest({ ...m, role: 'automations', inbox: { ...(m.inbox ?? {}), trusted: true } });
    }
    await refresh();
    send('automations:changed');
    return roleWs;
  });
  ipcMain.handle('automations:discuss', async (_e, proposalId: string) => {
    await refresh();
    if (!roleWs) throw new Error('set up an automations workspace first');
    const p = proposals.list().find((x) => x.id === proposalId);
    if (!p) throw new Error('proposal not found');
    await hostPostToWorkspace(roleWs, reviewPrompt(p, (id) => names.find((n) => n.id === id)?.name ?? id));
    return roleWs;
  });

  ipcMain.handle('proposals:list', () => withNames(() => proposals.list()));
  ipcMain.handle('proposals:yaml', (_e, id: string, index: number) => proposals.yamlOf(id, index ?? 0));
  ipcMain.handle('proposals:approve', (_e, id: string, opts: { accept?: number[]; editedYaml?: string; editedIndex?: number }) =>
    withNames(() => proposals.approve(id, opts ?? {})));
  ipcMain.handle('proposals:reject', (_e, id: string, note: string | null) => proposals.reject(id, note ?? null));
  ipcMain.handle('proposals:revert', (_e, id: string, index: number) => proposals.revert(id, index));
  return { automations: svc, proposals };
}
