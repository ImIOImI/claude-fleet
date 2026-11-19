import { describe, expect, it } from 'vitest';
import { createDrainRelay, parseDrainEvent } from './remoteDrain.js';

describe('broker:drain from a host', () => {
  it('accepts only the documented shape', () => {
    expect(parseDrainEvent({ phase: 'draining', softAt: 10, hardAt: 20, instance: 'abc' })).toEqual({ phase: 'draining', softAt: 10, hardAt: 20, instance: 'abc' });
    expect(parseDrainEvent({ phase: 'serving', softAt: null, hardAt: null, instance: null })).toEqual({ phase: 'serving', softAt: null, hardAt: null, instance: null });
    expect(parseDrainEvent({ phase: 'unknown', softAt: null, hardAt: null, instance: 'x'.repeat(32) })).not.toBeNull();
    for (const bad of [null, [], 'serving', {}, { phase: 'done', softAt: null, hardAt: null, instance: null }, { phase: 'draining', softAt: -1, hardAt: null, instance: null },
      { phase: 'draining', softAt: 1.5, hardAt: null, instance: null }, { phase: 'draining', softAt: null, hardAt: '2', instance: null },
      { phase: 'draining', softAt: null, hardAt: 2 ** 53, instance: null }, { phase: 'serving', softAt: null, hardAt: null, instance: 'x'.repeat(33) },
      { phase: 'serving', softAt: null, hardAt: null, instance: 'a\nb' }, { phase: 'serving', softAt: null, hardAt: null, instance: '' },
      { phase: 'serving', softAt: null, hardAt: null }, { phase: 'serving', softAt: null, hardAt: null, instance: 7 }]) {
      expect(parseDrainEvent(bad)).toBeNull();
    }
  });

  it('pushes changes only and keeps a snapshot per host', () => {
    const sent: unknown[] = [];
    const r = createDrainRelay((u) => sent.push(u));
    r.update('W1', { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' });
    r.update('W1', { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' });
    r.update('W1', { phase: 'bogus' });
    r.update('W2', { phase: 'serving', softAt: null, hardAt: null, instance: 'j' });
    expect(sent).toHaveLength(2);
    expect(r.snapshot()).toEqual({ W1: { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' }, W2: { phase: 'serving', softAt: null, hardAt: null, instance: 'j' } });
    r.update('W1', { phase: 'serving', softAt: null, hardAt: null, instance: 'k' });
    expect(sent.at(-1)).toEqual({ workspaceId: 'W1', drain: { phase: 'serving', softAt: null, hardAt: null, instance: 'k' } });
    r.forget('W1');
    expect(Object.keys(r.snapshot())).toEqual(['W2']);
  });
});
