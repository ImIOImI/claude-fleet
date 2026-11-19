// A host automation runtime over a test inbox, a fake broker and a fake drain gate (only *.test.ts import it).
import type { BrokerState } from '../main/broker.js';
import type { AutomationDeps } from '../main/automations/automationService.js';
import type { AutomationRecord } from '../main/automations/automationStore.js';
import { openTestInbox } from '../main/store/testStore.js';
import { isOpen, type GatePhase } from './drainGate.js';
import type { DrainStore } from './drainStore.js';
import { startHostAutomations, type HostAutomations } from './hostAutomations.js';
import { createLogger } from './log.js';
import { fakeBroker } from './testFakes.js';

export const RIG_WS = { id: '01JC0000000000000000000000', name: 'review-bot' };

export function fakeDrainGate(initial: GatePhase = 'serving') {
  let phase = initial;
  let last: BrokerState | null = null;
  const ended = new Map<string, string>();
  const waiters = new Set<() => void>();
  return {
    phase: () => phase,
    last: () => last,
    ended: (id: string) => ended.get(id),
    waitServing: (_ms: number) => (isOpen(phase) ? Promise.resolve(true) : new Promise<boolean>((r) => waiters.add(() => r(true)))),
    setPhase(p: GatePhase) {
      phase = p;
      if (isOpen(p)) for (const w of [...waiters]) { waiters.delete(w); w(); }
    },
    setLast(s: BrokerState) { last = s; },
    cut(id: string, reason: string) { ended.set(id, reason); }
  };
}

const live: Array<() => Promise<void>> = [];

/** afterEach: stops every rig this file started. */
export async function closeHostAutomationsRigs(): Promise<void> {
  for (const close of live.splice(0).reverse()) await close().catch(() => undefined);
}

export async function hostAutomationsRig(o: { phase?: GatePhase; stepWaitMs?: number; drains?: DrainStore } = {}) {
  const inbox = await openTestInbox();
  const broker = fakeBroker([]);
  const gate = fakeDrainGate(o.phase ?? 'serving');
  let deps: AutomationDeps | null = null;
  let spawned: Map<string, string | null> | null = null;
  const runtime: HostAutomations = await startHostAutomations({
    inbox, workspace: () => RIG_WS, ops: broker.ops, mcpArgs: [], events: { publish: () => undefined },
    log: createLogger(() => undefined), tickMs: 3_600_000, settleMs: 50, gate, stepWaitMs: o.stepWaitMs, drains: o.drains,
    onDeps: (d, m) => { deps = d; spawned = m; }
  });
  live.push(async () => { await runtime.stop(); inbox.close(); });
  const defs: Array<{ definition: Record<string, unknown>; enabled: boolean }> = [];
  return {
    runtime, broker, gate, inbox,
    deps: deps! as AutomationDeps,
    spawnedOn: (id: string, instance: string | null) => { spawned!.set(id, instance); },
    /** A host-config automation with one fresh step on $self. */
    async createFreshAutomation(stepId: string, name = `fresh-${defs.length + 1}`): Promise<{ id: string; raw: AutomationRecord }> {
      defs.push({ definition: { name, triggers: [{ manual: {} }], steps: [{ id: stepId, prompt: { workspace: '$self', mode: 'fresh', message: 'review' } }] }, enabled: true });
      await runtime.reconcile(defs);
      const raw = (await runtime.store.list()).find((a) => a.name === name)!;
      return { id: raw.id, raw };
    },
    async untilCreated(id: string, ms = 5_000): Promise<void> {
      const end = Date.now() + ms;
      while (!broker.created.some((c) => c.id === id)) {
        if (Date.now() > end) throw new Error(`${id} was never created`);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
}
