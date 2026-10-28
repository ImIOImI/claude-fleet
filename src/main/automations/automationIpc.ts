// Electron wiring for automations (#407 Phase 3): `automations:*` IPC, the MCP
// handlers, the 30 s scheduler tick and startup recovery. Effects into
// workspaces use ipc.ts's host-trusted functions (no committee gate).
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { getSecret, listKeys } from '../vault.js';
import { setLoadoutAutomationHooks, setLoadoutChangeListener } from '../loadouts.js';
import { prepareLoadoutAutomations, readLoadoutAutomations, readLoadoutVersion } from './loadoutAutomations.js';
import { createLoadoutInstaller } from './loadoutInstaller.js';
import { runScript } from './hostScript.js';
import {
  hostCloseFresh, hostEnsureRunning, hostExecScript, hostFreshState, hostPostToWorkspace, hostSpawnFresh, hostWorkspaceBusy, hostWorkspaceNames,
  hostWorkspaceState, hostWslDistros, setFleetEventObserver
} from '../ipc.js';
import { existsSync } from 'node:fs';
import type { HostShell } from '../../preload/inboxTypes.js';
import { detectHostShells, onPath } from './hostShells.js';
import { inboxEvents } from '../inbox/inboxEvents.js';
import type { Todo } from '../../preload/inboxTypes.js';
import { setAutomationHandlers } from '../mcpServer.js';
import { logError } from '../errorLog.js';
import type { InboxStore } from '../inbox/inboxDb.js';
import type { NotifyService } from '../inbox/notifyService.js';
import { emitInboxChanged } from '../inbox/inboxEvents.js';
import { AutomationStore } from './automationStore.js';
import { createAutomationService, type AutomationService } from './automationService.js';
import { STARTER_YAML, definitionToYaml } from './definition.js';
import { reviewPrompt } from './review.js';
import { changePrompt, draftPrompt, refinePrompt } from './authoring.js';
import { ProposalStore } from './proposalStore.js';
import { createProposalService, type ProposalService } from './proposalService.js';
import { listWorkspaceManifests, readWorkspaceManifest, writeWorkspaceManifest } from '../workspaces.js';
import { removeRoleBrief, writeRoleBrief } from './roleBrief.js';
import { broadcastInboxChanged } from '../inbox/inboxBroadcast.js';

function send(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send(channel, payload); } catch { /* mid-teardown */ }
  }
}

type InboxSink = {
  todoFromAutomation(automationId: string, runId: string, args: Record<string, unknown>): Promise<void>;
  notifyFromAutomation(automationId: string, runId: string, args: Record<string, unknown>): Promise<void>;
};

export function registerAutomationIpc(inbox: InboxStore, notify: NotifyService | null): {
  automations: AutomationService; proposals: ProposalService; setInboxSink(s: InboxSink): void;
} {
  let sink: InboxSink | null = null;
  const store = new AutomationStore(inbox.db);
  // Name ↔ id map refreshed on use; automations name workspaces in YAML.
  let names: Array<{ id: string; name: string }> = [];
  /** The workspace behind the Inbox chip (manifest role 'automations'), if any. */
  let roleWs: string | null = null;
  const refresh = async () => {
    names = await hostWorkspaceNames().catch(() => names);
    const prev = roleWs;
    let manifests = -1;
    roleWs = await listWorkspaceManifests()
      .then((ms) => { manifests = ms.length; return ms.find((m) => m.role === 'automations')?.id ?? null; })
      .catch((e) => {
        logError({ source: 'main', type: 'automations-role-refresh', level: 'warn', message: `couldn't list workspace manifests; keeping the automations workspace as ${prev ?? 'unset'}: ${String(e)}` });
        return prev;
      });
    // Every change of the automations workspace is recorded, so a run that fails
    // with "no automations workspace" can be matched to when and why it went unset.
    if (roleWs !== prev) {
      logError({
        source: 'main', type: 'automations-role-change', level: roleWs ? 'info' : 'warn',
        message: `automations workspace ${prev ?? 'unset'} → ${roleWs ?? 'unset'} (${manifests} manifests read)`,
        ...(roleWs ?? prev ? { workspaceId: (roleWs ?? prev)! } : {})
      });
    }
  };
  const privileged = (id: string) => id === roleWs;
  // Host shells (#407): PATH for native shells, the local-workspace WSL probe for distros. Refreshed every 5 min.
  let shells: HostShell[] = [];
  let shellsAt = 0;
  const refreshShells = async (): Promise<HostShell[]> => {
    if (Date.now() - shellsAt < 5 * 60_000 && shells.length) return shells;
    const wsl = await hostWslDistros().catch(() => ({ distros: [], defaultDistro: null }));
    shells = detectHostShells(process.platform, (c) => onPath(c, process.env.PATH, process.platform, existsSync), wsl.distros, wsl.defaultDistro);
    shellsAt = Date.now();
    return shells;
  };
  void refreshShells();
  const hostShellIds = () => (shells.length ? shells.map((x) => x.id as string) : undefined);
  // The role brief (roleBrief.ts): the automations workspace's generated CLAUDE.md block.
  const syncBrief = (id: string | null) => {
    if (!id) return;
    void writeRoleBrief(id).catch((e) => logError({ source: 'main', type: 'automation-role-brief', level: 'warn', message: String(e) }));
  };
  void refresh().then(() => syncBrief(roleWs));
  setLoadoutChangeListener((workspaceId) => { if (workspaceId === roleWs) syncBrief(workspaceId); });

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
    // Script steps (#407 Phase 7).
    execScript: (target, o) => target.kind === 'container'
      ? hostExecScript(target.workspaceId, o)
      : runScript({ shell: target.shell, script: o.script, env: o.env, cwd: path.join(app.getPath('userData'), 'automations', o.automationId), timeoutMs: o.timeoutMs }),
    automationsWorkspace: () => roleWs,
    secret: (ws, key) => getSecret(ws, key),
    emitTodo: async (id, runId, input) => { if (!sink) throw new Error('the inbox is unavailable'); await sink.todoFromAutomation(id, runId, input); },
    emitNotify: async (id, runId, input) => { if (!sink) throw new Error('the inbox is unavailable'); await sink.notifyFromAutomation(id, runId, input); },
    resolveWorkspace: (v) => names.find((n) => n.id === v)?.id ?? names.find((n) => n.name === v)?.id ?? null,
    hostShells: hostShellIds,
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
    hostShells: hostShellIds,
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

  // Automations shipped in loadouts (#407 Phase 8).
  const installer = createLoadoutInstaller({ store, now: Date.now, workspaceName: (id) => names.find((n) => n.id === id)?.name ?? id });
  const prepareFor = async (srcDir: string, workspaceId: string) => {
    await refresh();
    const sources = await readLoadoutAutomations(srcDir);
    if (!sources.length) return [];
    const keys = new Map<string, string[]>();
    for (const ws of new Set([workspaceId, ...(roleWs ? [roleWs] : []), ...names.map((n) => n.id)])) keys.set(ws, await listKeys(ws).catch(() => []));
    await refreshShells();
    return prepareLoadoutAutomations(sources, workspaceId, { workspace: (v) => names.find((n) => n.id === v)?.id ?? names.find((n) => n.name === v)?.id ?? null, hostShells: hostShellIds() },
      (ws) => keys.get(ws) ?? [], roleWs);
  };
  setLoadoutAutomationHooks({
    preview: async (srcDir, loadoutId, workspaceId, allowHost) => installer.preview(await prepareFor(srcDir, workspaceId), loadoutId, workspaceId, allowHost),
    install: async (srcDir, loadoutId, workspaceId, opts) => {
      const prepared = await prepareFor(srcDir, workspaceId);
      const empty = { created: [], updated: [], kept: [], skipped: [], names: [] };
      if (!prepared.length) return empty;
      const r = installer.install(prepared, {
        loadoutId, version: await readLoadoutVersion(srcDir), targetId: workspaceId,
        targetName: names.find((n) => n.id === workspaceId)?.name ?? workspaceId, enable: opts.enable, allowHost: opts.allowHost
      });
      send('automations:changed');
      emitInboxChanged();
      return { ...r, names: r.ids.map((id) => store.get(id)?.name).filter((n): n is string => !!n) };
    },
    uninstall: async (loadoutId, workspaceId) => {
      if (installer.uninstall(loadoutId, workspaceId).length) { send('automations:changed'); emitInboxChanged(); }
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
    scheduleNext: async (callerId, args) => { await refresh(); return svc.mcp.scheduleNext(callerId, args); },
    propose: async (callerId, args) => { await refresh(); return proposals.mcp.propose(callerId, args); },
    proposeChange: async (callerId, args) => { await refresh(); return proposals.mcp.proposeChange(callerId, args); },
    getProposal: async (callerId, args) => proposals.mcp.get(callerId, args)
  });

  const USER = { kind: 'user' as const, id: null };
  const withNames = async <T>(fn: () => T): Promise<T> => { await Promise.all([refresh(), refreshShells()]); return fn(); };
  ipcMain.handle('automations:hostShells', () => refreshShells());
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
      if (m.role === 'automations' && m.id !== id) {
        await writeWorkspaceManifest({ ...m, role: undefined });
        await removeRoleBrief(m.id).catch((e) => logError({ source: 'main', type: 'automation-role-brief', level: 'warn', message: String(e) }));
      }
    }
    if (id) {
      const m = (await readWorkspaceManifest(id))!;
      await writeWorkspaceManifest({ ...m, role: 'automations', inbox: { ...(m.inbox ?? {}), trusted: true } });
      await writeRoleBrief(id).catch((e) => logError({ source: 'main', type: 'automation-role-brief', level: 'warn', message: String(e) }));
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

  // Claude-first authoring (#407 Phase 6): the request goes to the automations
  // workspace's session as labeled data; the draft comes back as a proposal.
  const toRole = async (prompt: (ctx: { workspaces: string[]; automations: string[] }) => string): Promise<string> => {
    await refresh();
    if (!roleWs) throw new Error('set up an automations workspace first');
    const ctx = { workspaces: names.filter((n) => n.id !== roleWs).map((n) => n.name), automations: store.list().map((a) => a.name), hostShells: (await refreshShells()).map((x) => `${x.id} (${x.label})`) };
    await hostPostToWorkspace(roleWs, prompt(ctx));
    return roleWs;
  };
  const need = (v: unknown, what: string): string => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) throw new Error(`describe ${what} first`);
    return t.slice(0, 8000);
  };
  ipcMain.handle('automations:draft', (_e, text: string) => {
    const d = need(text, 'the automation');
    return toRole((ctx) => draftPrompt(d, ctx));
  });
  ipcMain.handle('automations:askChange', (_e, id: string, text: string) => {
    const d = need(text, 'the change');
    const a = store.get(id);
    if (!a) throw new Error('automation not found');
    return toRole((ctx) => changePrompt(a.name, definitionToYaml(a.definition), d, ctx));
  });
  ipcMain.handle('proposals:refine', (_e, id: string, index: number, text: string) => {
    const d = need(text, 'the changes');
    const p = proposals.list().find((x) => x.id === id);
    const it = p?.items[index ?? 0];
    if (!p || !it) throw new Error('proposal not found');
    if (p.status !== 'pending') throw new Error(`this proposal is already ${p.status}`);
    return toRole((ctx) => refinePrompt(definitionToYaml(it.after), d, !it.automationId, ctx));
  });

  ipcMain.handle('proposals:list', () => withNames(() => proposals.list()));
  ipcMain.handle('proposals:yaml', (_e, id: string, index: number) => proposals.yamlOf(id, index ?? 0));
  ipcMain.handle('proposals:approve', (_e, id: string, opts: { accept?: number[]; editedYaml?: string; editedIndex?: number }) =>
    withNames(() => proposals.approve(id, opts ?? {})));
  ipcMain.handle('proposals:reject', (_e, id: string, note: string | null) => proposals.reject(id, note ?? null));
  ipcMain.handle('proposals:revert', (_e, id: string, index: number) => proposals.revert(id, index));
  return { automations: svc, proposals, setInboxSink: (s) => { sink = s; } };
}
