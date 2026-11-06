// The hosted workspace's automations, inbox and proposals, on the holder's
// fenced store (SPEC §7 *Host automations*). Definitions come only from the
// host config; script steps, live steps, notifications and other workspaces
// are refused.
import { randomUUID } from 'node:crypto';
import type { TodoSource } from '../preload/inboxTypes.js';
import { AutomationStore } from '../main/automations/automationStore.js';
import { createAutomationService } from '../main/automations/automationService.js';
import { createProposalService } from '../main/automations/proposalService.js';
import { ProposalStore } from '../main/automations/proposalStore.js';
import { definitionToYaml, validateDefinition } from '../main/automations/definition.js';
import { createInboxService } from '../main/inbox/inboxService.js';
import type { InboxStore } from '../main/inbox/inboxDb.js';
import { setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import type { BrokerOps } from './brokerOps.js';
import type { HostAutomationEntry } from './config.js';
import type { EventHub } from './events.js';
import { hostResolver, remoteHostRefusals, substituteSelf } from './hostDefinition.js';
import type { Logger } from './log.js';

export const HOST_CONFIG_ORIGIN = { source: 'host-config' } as const;
const OPERATOR: TodoSource = { kind: 'user', id: null };
const TICK_MS = 30_000;
const SETTLE_MS = 2_000;
const CONFIG_ONLY = 'on a remote host, automations come from the host config (automations: in config.yaml)';

export interface HostAutomationsOptions {
  /** The holder's fenced store: every write here checks the lease. */
  inbox: InboxStore;
  workspace: () => { id: string; name: string };
  ops: BrokerOps;
  /** hostMcpArgs(...): fresh sessions get the fleet-state tools. */
  mcpArgs: string[];
  events: Pick<EventHub, 'publish'>;
  log: Logger;
  now?: () => number;
  tickMs?: number;
  settleMs?: number;
}

export type HostAutomations = Awaited<ReturnType<typeof startHostAutomations>>;

export async function startHostAutomations(o: HostAutomationsOptions) {
  const now = o.now ?? Date.now;
  const store = new AutomationStore(o.inbox.kysely);
  const resolve = (v: string) => hostResolver(o.workspace())(v);
  const name = (id: string) => (id === o.workspace().id ? o.workspace().name : id);
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const warn = (msg: string) => (e: unknown) => o.log.log('warn', msg, { error: errText(e) });

  const publishCounts = (): void => {
    void o.inbox.counts().then((c) => o.events.publish('inbox:changed', c)).catch(warn('inbox counts failed'));
  };
  let automations: ReturnType<typeof createAutomationService> | null = null;
  const inbox = createInboxService(o.inbox, {
    manifest: async (id) => (id === o.workspace().id ? {} : null),
    notifyChanged: publishCounts,
    onPostRejected: (_ws, reason) => o.log.log('warn', 'inbox post rejected', { reason }),
    attribution: (runId, callerId) => automations?.attribution(runId, callerId) ?? null,
    onTodoCreated: (t) => {
      void automations
        ?.onEvent({ on: 'todo.created', workspaceId: t.source.kind === 'workspace' ? t.source.id ?? undefined : undefined, todo: { id: t.id, title: t.title, tags: t.tags, source: t.source } })
        .catch(warn('automation event failed'));
    }
  });

  const svc = createAutomationService({
    store,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    workspaceState: async (id) => (id === o.workspace().id ? 'running' : null),
    workspaceName: name,
    ensureRunning: async () => undefined,
    // Defence in depth: checkDefinition already refuses these at validation and at run start.
    post: async () => { throw new Error('live steps are not available on a remote host'); },
    execScript: async () => { throw new Error('script steps are not available on a remote host'); },
    busy: () => false,
    spawnFresh: async (_ws, sessionId, args) => {
      const r = await o.ops.create(sessionId, 120, 40, [...args, '--session-id', randomUUID(), ...o.mcpArgs]);
      if (!r.ok) throw new Error(`could not start a fresh session: ${r.error ?? 'unknown broker error'}`);
    },
    freshState: async (_ws, sessionId) => {
      const s = (await o.ops.list()).find((x) => x.id === sessionId);
      return s ? (s.alive ? 'alive' : 'ended') : 'missing';
    },
    // Best-effort: a viewer attached to the session keeps it.
    closeFresh: async (_ws, sessionId) => {
      const a = await o.ops.attach(sessionId, { onHistory: () => undefined, onOutput: () => undefined, onEnded: () => undefined, onGone: () => undefined }).catch(() => null);
      if (a?.ok) await a.upstream.closeSession().catch(() => undefined);
    },
    emitTodo: async (id, runId, input) => inbox.host.todoFromAutomation(id, runId, input),
    resolveWorkspace: resolve,
    checkDefinition: remoteHostRefusals,
    changed: () => {
      o.events.publish('automations:changed', null);
      publishCounts();
    },
    onError: warn('automation run failed to record'),
    notify: (n) => o.log.log(n.priority === 'high' || n.priority === 'urgent' ? 'warn' : 'info', 'automation notice', { kind: n.kind, title: n.title })
  });
  automations = svc;

  const proposals = createProposalService({
    proposals: new ProposalStore(o.inbox.kysely),
    automations: store,
    now,
    resolveWorkspace: resolve,
    workspaceName: name,
    trusted: async () => false,
    checkDefinition: remoteHostRefusals,
    changed: () => {
      o.events.publish('automations:changed', null);
      o.events.publish('proposals:changed', null);
      publishCounts();
    }
  });

  setInboxHandlers(inbox.mcp);
  // The hosted workspace is privileged: every automation on the host is its own.
  setAutomationHandlers({
    list: (c) => svc.mcp.list(c, true),
    run: (c, a) => svc.mcp.run(c, a, true),
    get: (c, a) => svc.mcp.get(c, a, true),
    listRuns: (c, a) => svc.mcp.listRuns(c, a, true),
    scheduleNext: (c, a) => svc.mcp.scheduleNext(c, a),
    propose: async () => { throw new Error(CONFIG_ONLY); },
    proposeChange: async () => { throw new Error(CONFIG_ONLY); },
    getProposal: (c, a) => proposals.mcp.get(c, a)
  });

  /** Make the host-config automations match `entries`, by name. Others are never touched. */
  async function reconcile(entries: HostAutomationEntry[]): Promise<void> {
    const ws = o.workspace();
    const ctx = { workspace: resolve, check: remoteHostRefusals };
    const records = await store.list();
    const wanted = new Set<string>();
    for (const e of entries) {
      const n = String(e.definition.name);
      wanted.add(n);
      const v = validateDefinition(substituteSelf(e.definition, ws.id), ctx);
      if (!v.ok) {
        o.log.log('error', 'host-config automation skipped', { name: n, errors: v.errors });
        continue;
      }
      const yaml = definitionToYaml(v.value);
      const existing = records.find((r) => r.name === n);
      if (existing && existing.origin?.source !== HOST_CONFIG_ORIGIN.source) {
        o.log.log('error', 'host-config automation skipped: the name is taken by an automation not from the host config', { name: n });
        continue;
      }
      if (!existing) {
        const a = await svc.create(yaml, OPERATOR);
        await store.setOrigin(a.id, { ...HOST_CONFIG_ORIGIN });
        if (!e.enabled) await svc.setEnabled(a.id, false);
        continue;
      }
      if (definitionToYaml(existing.definition) !== yaml) await svc.update(existing.id, yaml, OPERATOR);
      if (existing.enabled !== e.enabled) await svc.setEnabled(existing.id, e.enabled);
    }
    for (const r of records) {
      if (r.origin?.source === HOST_CONFIG_ORIGIN.source && !wanted.has(r.name)) await svc.remove(r.id);
    }
  }

  await svc.recover();
  let stopped = false;
  const timer = setInterval(() => {
    if (!stopped) svc.tick().catch(warn('automation tick failed'));
  }, o.tickMs ?? TICK_MS);
  timer.unref?.();

  return {
    automations: svc,
    proposals,
    inbox,
    reconcile,
    async tick(): Promise<void> {
      await svc.tick();
    },
    /** Waits at most settleMs for in-flight runs; one still running fails its next (fenced) write. */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      svc.cancelPending();
      setAutomationHandlers(null);
      setInboxHandlers(null);
      let t: NodeJS.Timeout | undefined;
      await Promise.race([svc.settle(), new Promise<void>((r) => (t = setTimeout(r, o.settleMs ?? SETTLE_MS)))]);
      clearTimeout(t);
    }
  };
}
