import { describe, it, expect } from 'vitest';
import { setPlanUsageHandler, __getToolForTest } from './mcpServer.js';

describe('plan_usage tool', () => {
  it('delegates to the injected handler and needs no grant', async () => {
    setPlanUsageHandler(async (opts) => ({ echoedAt: opts?.at ?? 0, spend: { usd: 42 } }));
    const tool = __getToolForTest('plan_usage');
    expect(tool).toBeTruthy();
    // Empty allowedWorkspaces proves it is not gated on read scope.
    const res = await tool!.run({} as never, { at: 123 }, { callerId: 'anyone', allowedWorkspaces: new Set() });
    expect(res).toEqual({ echoedAt: 123, spend: { usd: 42 } });
  });
});
