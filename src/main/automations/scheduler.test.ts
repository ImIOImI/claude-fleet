import { describe, expect, it } from 'vitest';
import type { AutomationDef } from '../../preload/inboxTypes.js';
import type { AutomationRecord } from './automationStore.js';
import { dueSchedule, nextFireAt } from './scheduler.js';

const T0 = Date.UTC(2026, 9, 28, 12, 0);
const HOUR = 3_600_000;

function rec(def: Partial<AutomationDef>, over: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: 'A1', name: 'a', enabled: true, version: 1, createdBy: { kind: 'user', id: null }, origin: null,
    createdAt: T0, updatedAt: T0, lastScheduledAt: T0, nextRunAt: null, nextRunBy: null,
    definition: { name: 'a', triggers: [{ manual: {} }], steps: [], ...def },
    ...over
  };
}
const hourly: Partial<AutomationDef> = { triggers: [{ schedule: { cron: '0 * * * *', tz: 'UTC' } }], reschedule: { min: '30m' } };

describe('scheduler with a run-chosen next fire (#437)', () => {
  it('without one, the cron decides', () => {
    const a = rec(hourly);
    expect(nextFireAt(a, T0)).toBe(T0 + HOUR);
    expect(dueSchedule(a, T0 + HOUR)).toMatchObject({ kind: 'schedule', cron: '0 * * * *' });
  });
  it('a pending next replaces the cron, sooner or later', () => {
    const later = rec(hourly, { nextRunAt: T0 + 3 * HOUR });
    expect(nextFireAt(later, T0)).toBe(T0 + 3 * HOUR);
    expect(dueSchedule(later, T0 + HOUR)).toBeNull();
    expect(dueSchedule(later, T0 + 3 * HOUR)).toMatchObject({ kind: 'rescheduled', args: {} });
    const sooner = rec(hourly, { nextRunAt: T0 + 40 * 60_000 });
    expect(dueSchedule(sooner, T0 + 40 * 60_000)).toMatchObject({ kind: 'rescheduled' });
  });
  it('works with no cron at all', () => {
    const a = rec({ reschedule: { min: '1h' } }, { nextRunAt: T0 + 2 * HOUR });
    expect(nextFireAt(a, T0)).toBe(T0 + 2 * HOUR);
    expect(dueSchedule(a, T0 + 2 * HOUR + 5)).toMatchObject({ kind: 'rescheduled' });
    expect(nextFireAt(rec({ reschedule: { min: '1h' } }), T0)).toBeNull();
  });
  it('a disabled automation never fires', () => {
    const a = rec(hourly, { enabled: false, nextRunAt: T0 });
    expect(dueSchedule(a, T0 + HOUR)).toBeNull();
    expect(nextFireAt(a, T0)).toBeNull();
  });
});
