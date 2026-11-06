import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runEmbedBackfill } from './embedBackfill.js';

function deps(markerPath: string) {
  const order: string[] = [];
  return {
    order,
    d: {
      markerPath,
      modelId: 'm@q8',
      deleteStale: vi.fn(async () => { order.push('delete'); return 0; }),
      listSessionIds: vi.fn(async () => ['s1', 's2']),
      indexTurns: vi.fn(async (id: string) => { order.push(id); }),
      indexSummaries: vi.fn(async () => { order.push('summaries'); }),
      yieldFn: vi.fn(async () => { order.push('yield'); }),
    },
  };
}

const marker = () => join(mkdtempSync(join(tmpdir(), 'backfill-')), '.embed-model-id');

describe('runEmbedBackfill', () => {
  it('purges and writes the marker when none exists', async () => {
    const p = marker();
    const { d, order } = deps(p);
    await runEmbedBackfill(d);
    expect(d.deleteStale).toHaveBeenCalledOnce();
    expect(readFileSync(p, 'utf8')).toBe('m@q8');
    expect(order).toEqual(['delete', 'yield', 's1', 'yield', 's2', 'yield', 'summaries']);
  });

  it('creates the marker directory on a fresh install', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'backfill-')), 'models', '.embed-model-id');
    await runEmbedBackfill(deps(p).d);
    expect(readFileSync(p, 'utf8')).toBe('m@q8');
  });

  it('skips the purge when the marker matches the model', async () => {
    const p = marker();
    writeFileSync(p, 'm@q8\n');
    const { d } = deps(p);
    await runEmbedBackfill(d);
    expect(d.deleteStale).not.toHaveBeenCalled();
    expect(d.indexTurns).toHaveBeenCalledTimes(2);
  });

  it('purges again after a model change', async () => {
    const p = marker();
    writeFileSync(p, 'old@fp32');
    const { d } = deps(p);
    await runEmbedBackfill(d);
    expect(d.deleteStale).toHaveBeenCalledOnce();
    expect(readFileSync(p, 'utf8')).toBe('m@q8');
  });

  it('leaves the marker untouched when the purge fails', async () => {
    const p = marker();
    writeFileSync(p, 'old@fp32');
    const { d } = deps(p);
    d.deleteStale.mockRejectedValueOnce(new Error('locked'));
    await expect(runEmbedBackfill(d)).rejects.toThrow('locked');
    expect(readFileSync(p, 'utf8')).toBe('old@fp32');
  });
});
