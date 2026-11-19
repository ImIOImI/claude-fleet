// The holder's side of a workspace-pod drain (SPEC §7 *Workspace pod drain*): queue one re-run per
// drain-cut fresh step (D150, D156), record the interactive sessions to resume (D151), dispatch re-runs
// once the new broker serves. Work is serialized; a failure is logged and the next STATE retries.
import { DRAIN_CUT_REASONS, type BrokerState } from '../main/broker.js';
import { APP_QUIT_MID_RUN } from '../main/automations/automationStore.js';
import { HOST_RESTART_ERROR } from '../main/automations/runner.js';
import { isOpen, type DrainGate, type GatePhase } from './drainGate.js';
import { DRAINED_TTL_MS, RETRY_MAX_AGE_MS, type DrainStore, type PendingRetry } from './drainStore.js';
import type { HostAutomations } from './hostAutomations.js';
import type { Logger } from './log.js';
import type { SessionOwnerStore } from './sessionOwners.js';

const FRESH_RE = /^auto-([0-9A-HJKMNP-TV-Z]{26})-[A-Za-z0-9_-]+$/;
const PRUNE_EVERY_MS = 3_600_000;
const SEEN_MAX = 5_000;

export function freshRunId(sessionId: string): string | null {
  return FRESH_RE.exec(sessionId)?.[1] ?? null;
}

export interface HostDrainDeps {
  gate: Pick<DrainGate, 'phase' | 'subscribe'>;
  drains: DrainStore;
  automations: Pick<HostAutomations, 'automations' | 'store'>;
  owners: Pick<SessionOwnerStore, 'latestSessionOf'>;
  log: Logger;
  now?: () => number;
  pruneEveryMs?: number;
}

export function startHostDrain(d: HostDrainDeps): { stop(): Promise<void>; idle(): Promise<void> } {
  const now = d.now ?? Date.now;
  const store = d.automations.store;
  const seenCut = new Set<string>();
  const seenDrained = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let wasOpen = isOpen(d.gate.phase());
  const enqueue = (what: string, fn: () => Promise<void>): void => {
    chain = chain.then(() => (stopped ? undefined : fn())).catch((err: Error) => d.log.log('warn', 'drain bookkeeping failed', { what, error: err.message }));
  };
  const remember = (s: Set<string>, key: string): void => {
    s.add(key);
    if (s.size > SEEN_MAX) s.delete(s.values().next().value as string);
  };

  async function noteCuts(s: BrokerState): Promise<void> {
    for (const x of s.sessions) {
      // Headless: only fleet-host creates those, so a viewer can't name a run's session to queue a re-run.
      if (!x.headless || !x.ended || !DRAIN_CUT_REASONS.has(x.ended) || seenCut.has(x.id)) continue;
      const runId = freshRunId(x.id);
      if (!runId) continue;
      const run = await store.getRun(runId);
      if (run && !run.trigger.retryOf) {
        if (await d.drains.markRetry(runId, run.automationId, now())) d.log.log('info', 'automation run will re-run after the restart', { runId });
        if (run.status === 'interrupted' && run.error === APP_QUIT_MID_RUN) await store.noteInterrupted(runId, HOST_RESTART_ERROR);
      }
      remember(seenCut, x.id);
    }
  }

  async function recordDrained(s: BrokerState): Promise<void> {
    const key = (x: BrokerState['sessions'][number]): string => `${s.instance}\0${x.id}\0${x.ended ?? ''}`;
    const fresh = s.sessions.filter((x) =>
      !x.headless && !freshRunId(x.id) && (x.alive || (x.ended?.startsWith('drain-') ?? false)) && !seenDrained.has(key(x)));
    if (!fresh.length) return;
    const map = await d.owners.latestSessionOf(fresh.map((x) => x.id));
    const rows = fresh.flatMap((x) => {
      const sessionId = map.get(x.id);
      return sessionId ? [{ instance: s.instance, brokerSessionId: x.id, sessionId, reason: x.ended ?? null }] : [];
    });
    await d.drains.recordDrained(rows, now());
    for (const x of fresh) remember(seenDrained, key(x));
  }

  async function dispatch(): Promise<void> {
    for (const p of await d.drains.claimPending(now())) {
      // A claimed row is never pending again, so one failure must not strand the rest.
      try {
        await dispatchOne(p);
      } catch (err) {
        d.log.log('warn', 'automation re-run refused', { runId: p.runId, error: (err as Error).message });
        await d.drains.settle(p.runId, { skipped: (err as Error).message }, now())
          .catch((e: Error) => d.log.log('warn', 'automation re-run not settled', { runId: p.runId, error: e.message }));
      }
    }
  }

  async function dispatchOne(p: PendingRetry): Promise<void> {
    const run = await store.getRun(p.runId);
    const a = run ? await store.get(run.automationId) : null;
    const why = !run ? 'the run is gone'
      : run.status !== 'interrupted' ? `the run is ${run.status}`
      : run.trigger.retryOf ? 'the run is itself a re-run'
      : !a ? 'the automation is gone'
      : !a.enabled ? 'the automation is disabled'
      : now() - p.createdAt > RETRY_MAX_AGE_MS ? 'older than 24 h'
      : null;
    if (why || !run || !a) {
      await d.drains.settle(p.runId, { skipped: why ?? 'unknown' }, now());
      // Still running when the new pod serves: the cut wasn't seen as an end, so no re-run follows.
      d.log.log(run?.status === 'running' ? 'warn' : 'info', 'automation re-run skipped', { runId: p.runId, why });
      return;
    }
    const t = run.trigger;
    const next = await d.automations.automations.run(a.id, {
      kind: t.kind, ...(t.by ? { by: t.by } : {}), ...(t.cron ? { cron: t.cron } : {}), ...(t.event ? { event: t.event } : {}),
      args: run.args, callerSupplied: t.by?.kind === 'workspace', retryOf: run.id
    });
    if (next.status === 'skipped') {
      await d.drains.settle(p.runId, { skipped: `the re-run was skipped: ${next.error ?? 'unknown'}` }, now());
      d.log.log('info', 'automation re-run skipped', { runId: p.runId, why: next.error });
      return;
    }
    await d.drains.settle(p.runId, { retryRunId: next.id }, now());
    d.log.log('info', 'automation re-run started', { runId: p.runId, retryRunId: next.id });
  }

  const onGate = (phase: GatePhase, s: BrokerState | null): void => {
    if (s) enqueue('cuts', () => noteCuts(s));
    if (s && phase === 'draining') enqueue('drained', () => recordDrained(s));
    const open = isOpen(phase);
    if (open && !wasOpen) enqueue('dispatch', dispatch);
    wasOpen = open;
  };
  const off = d.gate.subscribe(onGate);
  const prune = (): void => enqueue('prune', () => d.drains.prune(now() - DRAINED_TTL_MS));
  prune();
  if (wasOpen) enqueue('dispatch', dispatch);
  const timer = setInterval(prune, d.pruneEveryMs ?? PRUNE_EVERY_MS);
  timer.unref?.();
  return {
    idle: () => chain,
    async stop() {
      stopped = true;
      off();
      clearInterval(timer);
      await chain;
    }
  };
}
