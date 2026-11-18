// The hosted workspace's automations, inbox and proposals, on the holder's
// fenced store (SPEC §7 *Host automations*). Definitions come only from the
// host config; sessions may propose drafts, which nothing applies (D126).
// Script steps, live steps and other workspaces are refused. Notices are
// recorded undelivered for desktops to fetch (D131).
import { randomUUID } from 'node:crypto';
import type { TodoSource } from '../preload/inboxTypes.js';
import { DRAIN_CUT_REASONS } from '../main/broker.js';
import { AutomationStore } from '../main/automations/automationStore.js';
import { createAutomationService, type AutomationDeps } from '../main/automations/automationService.js';
import { HOST_RESTART_ERROR, StepError } from '../main/automations/runner.js';
import { createProposalService } from '../main/automations/proposalService.js';
import { ProposalStore } from '../main/automations/proposalStore.js';
import { definitionToYaml, validateDefinition } from '../main/automations/definition.js';
import { freshArgv } from '../main/automations/freshArgv.js';
import { createInboxService } from '../main/inbox/inboxService.js';
import { NotifyStore } from '../main/inbox/notifyStore.js';
import type { InboxStore } from '../main/inbox/inboxDb.js';
import { setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import type { BrokerOps } from './brokerOps.js';
import { isOpen, type DrainGate } from './drainGate.js';
import type { DrainStore } from './drainStore.js';
import { freshRunId } from './hostDrain.js';
import type { HostAutomationEntry } from './config.js';
import type { EventHub } from './events.js';
import { memoryActionLedger, type ActionLedger } from './hostActions.js';
import { hostResolver, remoteHostRefusals, substituteSelf } from './hostDefinition.js';
import { hostNotices } from './hostNotices.js';
import { assertPendingRoom, markConfigApplied, selfDefinition } from './hostProposals.js';
import type { Logger } from './log.js';
import { LeaseLostError } from './pgLease.js';
import { automationOwner, type SessionOwnerStore } from './sessionOwners.js';

export const HOST_CONFIG_ORIGIN = { source: 'host-config' } as const;
const OPERATOR: TodoSource = { kind: 'user', id: null };
const TICK_MS = 30_000;
const SETTLE_MS = 2_000;
const PRUNE_MS = 3_600_000;
/** A fresh step queued behind a drain waits at most this long for the new pod (D149). */
export const STEP_WAIT_MS = 45 * 60_000;
export const RESTARTING = "the workspace is restarting; try again when it's back";
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
  /** At-most-once ledger for the RPC actions; the holder passes its fenced one. */
  ledger?: ActionLedger;
  now?: () => number;
  tickMs?: number;
  settleMs?: number;
  /** Tests: the MCP automation handlers this runtime installs. */
  onHandlers?: (h: Parameters<typeof setAutomationHandlers>[0]) => void;
  /** The workspace pod's drain (D148); absent: never paused. */
  gate?: Pick<DrainGate, 'phase' | 'last' | 'ended' | 'waitServing'>;
  stepWaitMs?: number;
  /** Re-run ledger: a CREATE the broker refuses as draining queues the run's one re-run (D150). */
  drains?: Pick<DrainStore, 'markRetry'>;
  /** Tests: the service deps and the spawned-instance map. */
  onDeps?: (deps: AutomationDeps, spawnedOn: Map<string, string | null>) => void;
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
  const notices = hostNotices({
    store: new NotifyStore(o.inbox.kysely),
    workspaceId: () => o.workspace().id,
    now,
    changed: () => o.events.publish('notices:changed', null),
    sourceName: (s) => (s.kind === 'workspace' && s.id === o.workspace().id ? o.workspace().name : s.kind === 'user' ? (s.id ? `@${s.id}` : 'host operator') : 'automation')
  });
  const notice = (n: Parameters<typeof notices.request>[0]): void => {
    void notices.request(n).catch(warn('notice failed'));
  };
  let automations: ReturnType<typeof createAutomationService> | null = null;
  const inbox = createInboxService(o.inbox, {
    notifications: notices,
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

  /** Fresh session id → the broker instance it was created on. */
  const spawnedOn = new Map<string, string | null>();
  const open = (): boolean => !o.gate || isOpen(o.gate.phase());
  const deps: AutomationDeps = {
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
    paused: () => (open() ? null : RESTARTING),
    spawnFresh: async (_ws, sessionId, args) => {
      if (o.gate && !(await o.gate.waitServing(o.stepWaitMs ?? STEP_WAIT_MS))) throw new Error('the workspace is still restarting');
      const claudeId = randomUUID();
      const argv = freshArgv(args, o.mcpArgs, claudeId);
      // A write transaction runs the lease fence. A takeover after it still starts this one session; its run's next write fails.
      await o.inbox.kysely.transaction().execute(async () => undefined);
      const recorded = (await o.owners?.record({ brokerSessionId: sessionId, sessionId: claudeId, owner: automationOwner(o.workspace().id), startedAt: now() })) ?? false;
      const r = await o.ops.create(sessionId, 120, 40, argv, { headless: true });
      if (!r.ok) {
        if (recorded) await o.owners?.release?.(sessionId, claudeId).catch(warn('session owner release failed'));
        // The pod started draining after waitServing: interrupted, not failed.
        if (r.error?.startsWith('draining')) {
          const runId = freshRunId(sessionId);
          const run = runId ? await store.getRun(runId) : null;
          if (run && !run.trigger.retryOf) await o.drains?.markRetry(run.id, run.automationId, now());
          throw new StepError(HOST_RESTART_ERROR, 'interrupted');
        }
        throw new Error(`could not start a fresh session: ${r.error ?? 'unknown broker error'}`);
      }
      spawnedOn.set(sessionId, o.gate?.last()?.instance ?? null);
    },
    // Never `ended` for a session the drain cut off: the runner would record success (D150, 1A).
    freshState: async (_ws, sessionId) => {
      const how = o.gate?.ended(sessionId);
      if (how) return DRAIN_CUT_REASONS.has(how) ? 'interrupted' : 'ended';
      const last = o.gate?.last();
      const on = spawnedOn.get(sessionId);
      if (last && on && last.instance !== on) return 'interrupted';
      if (last?.sessions.some((x) => x.id === sessionId && x.alive)) return 'alive';
      if (!open()) return 'alive';
      const s = (await o.ops.list()).find((x) => x.id === sessionId);
      if (!s) return 'missing';
      return s.alive ? 'alive' : DRAIN_CUT_REASONS.has(s.ended ?? '') ? 'interrupted' : 'ended';
    },
    // Best-effort: a viewer attached to the session keeps it.
    closeFresh: async (_ws, sessionId) => {
      const a = await o.ops.attach(sessionId, { onHistory: () => undefined, onOutput: () => undefined, onEnded: () => undefined, onGone: () => undefined }).catch(() => null);
      if (a?.ok) await a.upstream.closeSession().catch(() => undefined);
      spawnedOn.delete(sessionId);
    },
    emitTodo: async (id, runId, input) => inbox.host.todoFromAutomation(id, runId, input),
    resolveWorkspace: resolve,
    checkDefinition: remoteHostRefusals,
    mayRun: (a) => (fromConfig(a) ? null : 'it is not from the host config'),
    changed: automationsChanged,
    onError: warn('automation run failed to record'),
    notify: (n) => {
      o.log.log(n.priority === 'high' || n.priority === 'urgent' ? 'warn' : 'info', 'automation notice', { kind: n.kind, title: n.title });
      notice(n);
    }
  };
  const svc = createAutomationService(deps);
  o.onDeps?.(deps, spawnedOn);
  automations = svc;

  const proposalStore = new ProposalStore(o.inbox.kysely);
  const proposals = createProposalService({
    proposals: proposalStore,
    automations: store,
    now,
    resolveWorkspace: resolve,
    workspaceName: name,
    trusted: async () => false,
    checkDefinition: remoteHostRefusals,
    notify: notice,
    changed: () => {
      o.events.publish('automations:changed', null);
      o.events.publish('proposals:changed', null);
      publishCounts();
    }
  });

  setInboxHandlers(inbox.mcp);
  // The hosted workspace is privileged: every automation on the host is its own.
  // One propose at a time, so concurrent sessions can't overrun the pending cap.
  let proposing: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = proposing.then(fn);
    proposing = run.catch(() => undefined);
    return run;
  };
  const self = (d: unknown): unknown => selfDefinition(d, o.workspace().id);
  const hostedCaller = (c: string): void => {
    if (c !== o.workspace().id) throw new Error(`unknown workspace ${c}`);
  };
  const handlers = {
    list: (c: string) => svc.mcp.list(c, true),
    run: (c: string, a: Record<string, unknown>) => svc.mcp.run(c, a, true),
    get: (c: string, a: Record<string, unknown>) => svc.mcp.get(c, a, true),
    listRuns: (c: string, a: Record<string, unknown>) => svc.mcp.listRuns(c, a, true),
    scheduleNext: (c: string, a: Record<string, unknown>) => svc.mcp.scheduleNext(c, a),
    propose: (c: string, a: Record<string, unknown>) => serial(async () => {
      hostedCaller(c);
      await assertPendingRoom(proposalStore);
      return proposals.mcp.propose(c, { ...a, definition: self(a.definition) });
    }),
    proposeChange: (c: string, a: Record<string, unknown>) => serial(async () => {
      hostedCaller(c);
      await assertPendingRoom(proposalStore);
      return proposals.mcp.proposeChange(c, Array.isArray(a.batch)
        ? { ...a, batch: (a.batch as unknown[]).map((b) => (b && typeof b === 'object' ? { ...b, definition: self((b as Record<string, unknown>).definition) } : b)) }
        : { ...a, definition: self(a.definition) });
    }),
    getProposal: (c: string, a: Record<string, unknown>) => proposals.mcp.get(c, a)
  };
  setAutomationHandlers(handlers);
  o.onHandlers?.(handlers);

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
    if (await markConfigApplied({ proposals: proposalStore, automations: store, now, isConfig: fromConfig })) {
      o.events.publish('proposals:changed', null);
      publishCounts();
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
  await notices.prune().catch(warn('notice prune failed'));
  const pruneTimer = setInterval(() => {
    if (!stopped) void notices.prune().catch(warn('notice prune failed'));
  }, PRUNE_MS);
  pruneTimer.unref?.();

  return {
    automations: svc,
    store,
    proposals,
    inbox,
    ledger: o.ledger ?? memoryActionLedger(now),
    notices,
    reconcile,
    async tick(): Promise<void> {
      await svc.tick();
    },
    /** Waits at most settleMs for in-flight runs; one still running fails its next (fenced) write. */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(pruneTimer);
      svc.cancelPending();
      setAutomationHandlers(null);
      setInboxHandlers(null);
      let t: NodeJS.Timeout | undefined;
      await Promise.race([svc.settle(), new Promise<void>((r) => (t = setTimeout(r, o.settleMs ?? SETTLE_MS)))]);
      clearTimeout(t);
    }
  };
}
