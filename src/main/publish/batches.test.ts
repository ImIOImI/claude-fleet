import { describe, expect, it, vi } from 'vitest';
import { planBatches, type PublishRow } from './batches.js';
import { makeScrubber, type ScrubbedLine } from './scrub.js';

const SRC = '01JC0000000000000000000005';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '22222222-2222-4333-8444-555555555555';
const real = makeScrubber([]);
const scrub = (l: string): ScrubbedLine => real(l.replace('secret', '[x]'));
const row = (id: number, sessionId: string, text = 'a'): PublishRow => ({ id, sessionId, rawJsonl: JSON.stringify({ t: text }), startedAt: 1 });

describe('planBatches', () => {
  it('groups consecutive same-session rows, scrubbed, and starts a batch on a session change', () => {
    const plan = planBatches(SRC, [row(1, S1, 'secret'), row(2, S1), row(3, S2), row(4, S1)], { scrub, withheld: new Set(), since: 0 });
    expect(plan.map((p) => [p.batch?.sessionId, p.batch?.events.length, p.lastId])).toEqual([[S1, 2, 2], [S2, 1, 3], [S1, 1, 4]]);
    expect(plan[0].batch!.events[0]).toBe('{"t":"[x]"}');
    expect(plan[0].batch!.sourceWorkspaceId).toBe(SRC);
  });

  it('splits at maxLines and at maxBody', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, S1));
    expect(planBatches(SRC, rows, { scrub, withheld: new Set(), since: 0, maxLines: 2 }).map((p) => p.batch!.events.length)).toEqual([2, 2, 1]);
    const base = JSON.stringify({ sourceWorkspaceId: SRC, sessionId: S1, events: [] }).length;
    const cost = JSON.stringify(row(1, S1).rawJsonl).length + 1;
    const plan = planBatches(SRC, rows, { scrub, withheld: new Set(), since: 0, maxBody: base + cost * 2 });
    expect(plan.map((p) => p.batch!.events.length)).toEqual([2, 2, 1]);
    for (const p of plan) expect(Buffer.byteLength(JSON.stringify(p.batch))).toBeLessThanOrEqual(base + cost * 2);
  });

  it('keeps every default-sized batch within the wire limits', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row(i + 1, S1, 'é'.repeat(1500)));
    const plan = planBatches(SRC, rows, { scrub, withheld: new Set(), since: 0 });
    for (const p of plan) {
      expect(p.batch!.events.length).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(JSON.stringify(p.batch))).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(plan.reduce((n, p) => n + p.batch!.events.length, 0)).toBe(1200);
    expect(plan.at(-1)!.lastId).toBe(1200);
  });

  it('skips withheld sessions and non-UUID ids but still advances past them', () => {
    const plan = planBatches(SRC, [row(1, S1), row(2, S2), row(3, 'not-a-uuid'), row(4, S1)], { scrub, withheld: new Set([S2]), since: 0 });
    expect(plan.map((p) => [p.batch?.sessionId ?? null, p.lastId])).toEqual([[S1, 1], [null, 3], [S1, 4]]);
  });

  it('skips a line too big for any batch and reports it', () => {
    const onOversize = vi.fn();
    const plan = planBatches(SRC, [row(1, S1, 'x'.repeat(200)), row(2, S1)], { scrub, withheld: new Set(), since: 0, maxBody: 150, onOversize });
    expect(onOversize).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(plan.map((p) => [p.batch?.events.length ?? 0, p.lastId])).toEqual([[0, 1], [1, 2]]);
  });

  it('skips a line the scrubber refuses, or that is not a JSON object, and reports it', () => {
    const onUnpublishable = vi.fn();
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i++) deep = [deep];
    const rows = [row(1, S1), { id: 2, sessionId: S1, rawJsonl: JSON.stringify({ d: deep }), startedAt: 1 }, { id: 3, sessionId: S1, rawJsonl: '[1,2]', startedAt: 1 }, row(4, S1)];
    const plan = planBatches(SRC, rows, { scrub: real, withheld: new Set(), since: 0, onUnpublishable });
    expect(onUnpublishable.mock.calls.map(([r]) => r.id)).toEqual([2, 3]);
    expect(plan.map((p) => [p.batch?.events.length ?? 0, p.lastId])).toEqual([[1, 1], [0, 3], [1, 4]]);
  });

  it('passes over sessions that started before since, or have no start, and advances past them', () => {
    const at = (id: number, startedAt: number | null): PublishRow => ({ ...row(id, S1), startedAt });
    const plan = planBatches(SRC, [at(1, 4_999), at(2, null), at(3, 5_000), at(4, 4_000)], { scrub, withheld: new Set(), since: 5_000 });
    expect(plan.map((p) => [p.batch?.events.length ?? 0, p.lastId])).toEqual([[0, 2], [1, 3], [0, 4]]);
  });
});
