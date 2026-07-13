// Pure fold: windowed usage rows + the set of local-backend workspace ids →
// app-wide aggregates (totals, byModel, byBackend). No DB / manifests / IPC.
// The privacy contract lives here: the output has no per-workspace field.
import { costFor } from './pricing.js';
import type { PlanUsageRow } from './db.js';

export interface PlanUsageSpend {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface PlanUsageFold {
  spend: PlanUsageSpend;
  byModel: Array<{ model: string; usd: number }>;
  byBackend: Array<{ backend: 'container' | 'local'; usd: number }>;
}

export function foldPlanUsage(rows: PlanUsageRow[], localIds: Set<string>): PlanUsageFold {
  const spend: PlanUsageSpend = { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  const byModel = new Map<string, number>();
  const byBackend = new Map<'container' | 'local', number>([['container', 0], ['local', 0]]);

  for (const r of rows) {
    const usd = costFor(r.model, r.serviceTier, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadInputTokens: r.cacheReadInputTokens,
      cacheCreationInputTokens: r.cacheCreationInputTokens,
    });
    spend.usd += usd;
    spend.inputTokens += r.inputTokens;
    spend.outputTokens += r.outputTokens;
    spend.cacheReadTokens += r.cacheReadInputTokens;
    spend.cacheCreateTokens += r.cacheCreationInputTokens;

    const modelKey = r.model ?? '(unknown)';
    byModel.set(modelKey, (byModel.get(modelKey) ?? 0) + usd);
    const backend = localIds.has(r.workspaceId) ? 'local' : 'container';
    byBackend.set(backend, (byBackend.get(backend) ?? 0) + usd);
  }

  return {
    spend,
    byModel: [...byModel].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
    byBackend: [...byBackend].map(([backend, usd]) => ({ backend, usd })),
  };
}
