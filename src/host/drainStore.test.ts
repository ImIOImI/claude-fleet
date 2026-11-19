import { describe, expect, it } from 'vitest';
import { memoryDrainStore, type DrainStore } from './drainStore.js';

export function drainStoreContract(name: string, make: () => Promise<DrainStore>, skip = false) {
  describe.skipIf(skip)(`${name} drain store`, () => {
    it('queues a run once, never a re-run, and claims each pending row once', async () => {
      const s = await make();
      expect(await s.markRetry('R1', 'A', 10)).toBe(true);
      expect(await s.markRetry('R1', 'A', 11)).toBe(false);
      const [a, b] = await Promise.all([s.claimPending(20), s.claimPending(20)]);
      expect([...a, ...b]).toEqual([{ runId: 'R1', automationId: 'A', createdAt: 10 }]);
      await s.settle('R1', { retryRunId: 'R2' }, 30);
      expect(await s.markRetry('R2', 'A', 40)).toBe(false);
      expect(await s.markRetry('R1', 'A', 41)).toBe(false);
      expect(await s.claimPending(50)).toEqual([]);
      expect(await s.markRetry('R3', 'A', 60)).toBe(true);
      await s.claimPending(61);
      await s.settle('R3', { skipped: 'the automation is disabled' }, 62);
      expect(await s.markRetry('R3', 'A', 63)).toBe(false);
      expect(await s.claimPending(64)).toEqual([]);
    });

    it('keeps the newest drained row per broker session and prunes old ones', async () => {
      const s = await make();
      await s.recordDrained([{ instance: 'i1', brokerSessionId: 'tab1', sessionId: 'c1', reason: null }, { instance: 'i1', brokerSessionId: 'tab2', sessionId: 'c2', reason: 'drain-idle' }], 100);
      await s.recordDrained([{ instance: 'i1', brokerSessionId: 'tab2', sessionId: 'c2', reason: 'drain-idle' }], 150);
      await s.recordDrained([{ instance: 'i2', brokerSessionId: 'tab1', sessionId: 'c9', reason: null }], 200);
      expect(await s.drained(0, 10)).toEqual([
        { brokerSessionId: 'tab1', sessionId: 'c9', drainedAt: 200 },
        { brokerSessionId: 'tab2', sessionId: 'c2', drainedAt: 150 }
      ]);
      expect(await s.drained(160, 10)).toEqual([{ brokerSessionId: 'tab1', sessionId: 'c9', drainedAt: 200 }]);
      expect(await s.drained(0, 1)).toHaveLength(1);
      await s.recordDrained([], 300);
      await s.prune(199);
      expect(await s.drained(0, 10)).toEqual([{ brokerSessionId: 'tab1', sessionId: 'c9', drainedAt: 200 }]);
    });
  });
}

drainStoreContract('memory', async () => memoryDrainStore());
