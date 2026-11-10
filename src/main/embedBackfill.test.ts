import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runEmbedBackfill, storeIdentity } from './embedBackfill.js';

function deps(markerPath: string) {
  const order: string[] = [];
  return {
    order,
    d: {
      markerPath,
      storeId: 'S1',
      modelId: 'm@q8',
      onError: vi.fn(),
      deleteStale: vi.fn(async () => { order.push('delete'); return 0; }),
      listPendingSessionIds: vi.fn(async () => ['s1', 's2']),
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
    expect(readFileSync(p, 'utf8')).toBe('S1 m@q8');
    expect(order).toEqual(['delete', 'yield', 's1', 'yield', 's2', 'yield', 'summaries']);
  });

  it('creates the marker directory on a fresh install', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'backfill-')), 'models', '.embed-model-id');
    await runEmbedBackfill(deps(p).d);
    expect(readFileSync(p, 'utf8')).toBe('S1 m@q8');
  });

  it('skips the purge when the marker matches the model', async () => {
    const p = marker();
    writeFileSync(p, 'S1 m@q8\n');
    const { d } = deps(p);
    await runEmbedBackfill(d);
    expect(d.deleteStale).not.toHaveBeenCalled();
    expect(d.indexTurns).toHaveBeenCalledTimes(2);
  });

  it('purges again after a model change', async () => {
    const p = marker();
    writeFileSync(p, 'S1 old@fp32');
    const { d } = deps(p);
    await runEmbedBackfill(d);
    expect(d.deleteStale).toHaveBeenCalledOnce();
    expect(readFileSync(p, 'utf8')).toBe('S1 m@q8');
  });

  it('leaves the marker untouched when the purge fails', async () => {
    const p = marker();
    writeFileSync(p, 'S1 old@fp32');
    const { d } = deps(p);
    d.deleteStale.mockRejectedValueOnce(new Error('locked'));
    await expect(runEmbedBackfill(d)).rejects.toThrow('locked');
    expect(readFileSync(p, 'utf8')).toBe('S1 old@fp32');
  });

  it('purges again when the store changes', async () => {
    const p = marker();
    writeFileSync(p, 'S0 m@q8');
    const { d } = deps(p);
    await runEmbedBackfill(d);
    expect(d.deleteStale).toHaveBeenCalledOnce();
  });

  it('keeps going after one session fails', async () => {
    const { d } = deps(marker());
    d.indexTurns.mockRejectedValueOnce(new Error('bad row'));
    await runEmbedBackfill(d);
    expect(d.indexTurns).toHaveBeenCalledTimes(2);
    expect(d.indexSummaries).toHaveBeenCalledOnce();
    expect(d.onError).toHaveBeenCalledWith('turns s1', expect.any(Error));
  });
});

describe('storeIdentity', () => {
  it('differs per store and never contains the connection string', () => {
    const a = storeIdentity({ kind: 'sqlite', path: '/u/state.db' });
    const b = storeIdentity({ kind: 'postgres', host: 'h', port: 5432, database: 'd', schema: 'fleet' });
    const c = storeIdentity({ kind: 'postgres', connectionString: 'postgres://u:secret@h/d', schema: 'fleet' });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c).not.toContain('secret');
  });
});
