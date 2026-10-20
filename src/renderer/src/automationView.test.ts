import { describe, it, expect } from 'vitest';
import { runTone, nextLabel, runDuration, initialArgs, RUN_LABELS } from './automationView';
import type { Automation, RunRow } from '../../preload/inboxTypes';

const now = new Date(2026, 9, 19, 10, 0).getTime();
const auto = (over: Partial<Automation>): Automation => ({
  id: 'A', name: 'x', description: null, enabled: true, version: 1, definition: { name: 'x', triggers: [], steps: [] },
  tags: [], createdBy: { kind: 'user', id: null }, createdAt: 0, updatedAt: 0, lastScheduledAt: null, nextFireAt: null,
  lastRun: null, weekStats: { runs: 0, nothingToDo: 0, failed: 0 }, triggerSummaries: [], ...over
});

describe('automationView', () => {
  it('maps run statuses to labels and tones', () => {
    expect(RUN_LABELS['nothing-to-do']).toBe('nothing to do');
    expect(runTone('succeeded')).toBe('ok');
    expect(runTone('timed-out')).toBe('bad');
    expect(runTone('nothing-to-do')).toBe('idle');
    expect(runTone('interrupted')).toBe('warn');
  });
  it('describes the next fire', () => {
    expect(nextLabel(auto({ enabled: false }), now)).toBe('disabled');
    expect(nextLabel(auto({}), now)).toBe('by hand only');
    expect(nextLabel(auto({ nextFireAt: now + 12 * 60_000 }), now)).toBe('in 12m');
    expect(nextLabel(auto({ nextFireAt: new Date(2026, 9, 19, 15, 0).getTime() }), now)).toBe('15:00');
  });
  it('formats durations and seeds the run form', () => {
    const r = (ms: number | null) => ({ startedAt: 0, endedAt: ms } as RunRow);
    expect(runDuration(r(null))).toBe('—');
    expect(runDuration(r(600))).toBe('600ms');
    expect(runDuration(r(1500))).toBe('1.5s');
    expect(runDuration(r(72_000))).toBe('1m 12s');
    expect(initialArgs([{ name: 'since', type: 'string', default: '1h' }, { name: 'dry', type: 'boolean' }])).toEqual({ since: '1h', dry: '' });
  });
});
