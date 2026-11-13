// A fake AutomationRuntime that records every write, shared by the automationRpc tests.
import type { AutomationRuntime } from './automationRpc.js';
import { memoryActionLedger } from './hostActions.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const A = '01JC0000000000000000000001';
const T = '01JC0000000000000000000002';

export function fakeRuntime(over: Partial<AutomationRuntime> = {}): AutomationRuntime & { calls: string[] } {
  const calls: string[] = [];
  const auto = { id: A, name: 'nightly', enabled: true } as never;
  return {
    calls,
    workspace: () => WS,
    ledger: memoryActionLedger(),
    automations: {
      list: async () => [auto],
      get: async (id: string) => (id === A ? { automation: auto, runs: [], yaml: 'name: nightly\n', versions: [1] } : null),
      run: async (id: string, req) => { calls.push(`run:${id}:${JSON.stringify(req)}`); return { id: '01JC00000000000000000000RR', status: 'running' } as never; }
    },
    proposals: {
      list: async () => [],
      reject: async (id: string, note: string | null, by: { id: string | null }) => { calls.push(`reject:${id}:${note}:${by.id}`); return { id, status: 'rejected' } as never; }
    },
    inbox: {
      list: async (f) => { calls.push(`list:${JSON.stringify(f)}`); return []; },
      get: async (id: string) => (id === T ? { todo: { id: T } as never, events: Array.from({ length: 150 }, (_, i) => ({ id: i }) as never) } : null),
      counts: async () => ({ open: 1, urgent: 0, high: 0, approvals: 2 }),
      create: async (input, by) => { calls.push(`create:${JSON.stringify(input)}:${JSON.stringify(by)}`); return { id: T } as never; },
      update: async (id, patch, by) => { calls.push(`update:${id}:${JSON.stringify(patch)}:${JSON.stringify(by)}`); return { id } as never; }
    },
    notices: { feed: async () => [] },
    ...over
  };
}
