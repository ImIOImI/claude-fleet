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
import { freshArgv } from '../main/automations/freshArgv.js';
import { createInboxService } from '../main/inbox/inboxService.js';
import type { InboxStore } from '../main/inbox/inboxDb.js';
import { setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import type { BrokerOps } from './brokerOps.js';
import type { HostAutomationEntry } from './config.js';
import type { EventHub } from './events.js';
import { hostResolver, remoteHostRefusals, substituteSelf } from './hostDefinition.js';
import type { Logger } from './log.js';
import { LeaseLostError } from './pgLease.js';
import { automationOwner, type SessionOwnerStore } from './sessionOwners.js';

export const HOST_CONFIG_ORIGIN = { source: 'host-config' } as const;
const OPERATOR: TodoSource = { kind: 'user', id: null };
const TICK_MS = 30_000;
const SETTLE_MS = 2_000;
const CONFIG_ONLY = 'on a remote host, automations come from the host config (automations: in config.yaml)';
const fromConfig = (a: { origin: Record<string, unknown> | null }): boolean => a.origin?.source === HOST_CONFIG_ORIGIN.source;

export interface HostAutomationsOptions {
  /** The holder's fenced store: every write here checks the lease. */
  inbox: InboxStore;
  workspace: () => { id: string; name: string };
  ops: BrokerOps;
  /** hostMcpArgs(...): fresh sessions get the fleet-state tools. */
  mcpArgs: string[];
  events: Pick<EventHub, 'publish'>;
  log: Logger;
  /** The holder's owner store: each fresh step's session is recorded as the workspace's (D118). */
  owners?: Pick<SessionOwnerStore, 'record'> & Partial<Pick<SessionOwnerStore, 'release'>>;
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
  const automationsChanged = (): void => {
    o.events.publish('automations:changed', null);
    publishCounts();
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
      const claudeId = randomUUID();
      const argv = freshArgv(args, o.mcpArgs, claudeId);
      // A write transaction runs the lease fence. A takeover after it still starts this one session; its run's next write fails.
      await o.inbox.kysely.transaction().execute(async () => undefined);
      const recorded = (await o.owners?.record({ brokerSessionId: sessionId, sessionId: claudeId, owner: automationOwner(o.workspace().id), startedAt: now() })) ?? false;
      const r = await o.ops.create(sessionId, 120, 40, argv);
      if (!r.ok) {
        if (recorded) await o.owners?.release?.(sessionId, claudeId).catch(warn('session owner release failed'));
        throw new Error(`could not start a fresh session: ${r.error ?? 'unknown broker error'}`);
      }
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
    mayRun: (a) => (fromConfig(a) ? null : 'it is not from the host config'),
    changed: automationsChanged,
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
    getProposal: async () => { throw new Error(CONFIG_ONLY); }
  });

  /** Make the DB match the config: host-config rows follow `entries` by name, a same-name row with no origin
   *  is adopted, and any other enabled row is disabled. A lost lease ends it; other failures skip one entry. */
  async function reconcileOnce(entries: HostAutomationEntry[]): Promise<void> {
    const ws = o.workspace();
    const ctx = { workspace: resolve, check: remoteHostRefusals };
    const records = await store.list();
    const wanted = new Set<string>();
    const each = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        o.log.log('error', 'host-config automation failed', { name, error: errText(err) });
      }
    };
    for (const e of entries) {
      wanted.add(String(e.definition.name));
      await each(String(e.definition.name), async () => {
        const v = validateDefinition(substituteSelf(e.definition, ws.id), ctx);
        if (!v.ok) {
          o.log.log('error', 'host-config automation skipped', { name: String(e.definition.name), errors: v.errors });
          return;
        }
        const def = v.value;
        wanted.add(def.name);
        const existing = records.find((r) => r.name === def.name);
        if (!existing) {
          await store.create(def, OPERATOR, now(), e.enabled, { ...HOST_CONFIG_ORIGIN });
          automationsChanged();
          return;
        }
        if (!fromConfig(existing)) {
          if (existing.origin !== null) {
            o.log.log('error', 'host-config automation skipped: the name is taken by an automation not from the host config', { name: def.name });
            return;
          }
          await store.setOrigin(existing.id, { ...HOST_CONFIG_ORIGIN });
          existing.origin = { ...HOST_CONFIG_ORIGIN };
          o.log.log('info', 'adopted an automation with no origin into the host config', { name: def.name });
        }
        if (definitionToYaml(existing.definition) !== definitionToYaml(def)) await svc.update(existing.id, definitionToYaml(def), OPERATOR);
        if (existing.enabled !== e.enabled) await svc.setEnabled(existing.id, e.enabled);
      });
    }
    for (const r of records) {
      await each(r.name, async () => {
        if (fromConfig(r)) {
          if (!wanted.has(r.name)) await svc.remove(r.id);
        } else if (r.enabled) {
          await svc.setEnabled(r.id, false);
          o.log.log('warn', 'disabled an automation not from the host config', { name: r.name });
        }
      });
    }
  }
  let reconciling: Promise<unknown> = Promise.resolve();
  function reconcile(entries: HostAutomationEntry[]): Promise<void> {
    const run = reconciling.then(() => reconcileOnce(entries));
    reconciling = run.catch(() => undefined);
    return run;
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
