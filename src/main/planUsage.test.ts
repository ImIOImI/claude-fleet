import { describe, it, expect } from 'vitest';
import { foldPlanUsage } from './planUsage.js';
import type { PlanUsageRow } from './db.js';

const row = (ws: string, model: string, out: number): PlanUsageRow => ({
  workspaceId: ws, model, serviceTier: 'standard',
  inputTokens: 0, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
});

describe('foldPlanUsage', () => {
  it('sums usd by model and by backend without leaking per-workspace rows', () => {
    const rows = [row('wsC', 'claude-opus-4-8', 1_000_000), row('wsL', 'claude-opus-4-8', 1_000_000)];
    const out = foldPlanUsage(rows, new Set(['wsL']));
    // opus output = $75/Mtok → each row $75.
    expect(out.spend.usd).toBeCloseTo(150, 5);
    expect(out.byModel).toEqual([{ model: 'claude-opus-4-8', usd: 150 }]);
    expect(out.byBackend).toContainEqual({ backend: 'container', usd: 75 });
    expect(out.byBackend).toContainEqual({ backend: 'local', usd: 75 });
    // no per-workspace field anywhere:
    expect(JSON.stringify(out)).not.toContain('wsC');
    expect(JSON.stringify(out)).not.toContain('wsL');
  });
});
