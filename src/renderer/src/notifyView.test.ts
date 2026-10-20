import { describe, it, expect } from 'vitest';
import {
  hhmm, minToHHMM, hhmmToMin, daysLabel, downtimeSummary, snoozePresets, pausePresets, quietLabel, heldReasonLabel,
  ruleScopeLabel, mutedHint
} from './notifyView';
import type { Downtime, QuietState } from '../../preload/inboxTypes';

const at = (h: number, m = 0, day = 19) => new Date(2026, 9, day, h, m).getTime();
const nights: Downtime = { id: 'D1', name: 'Nights', enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startMin: 1320, endMin: 420, bypass: 'none' };

describe('time + day formatting', () => {
  it('formats and parses clock times', () => {
    expect(hhmm(at(9, 5))).toBe('09:05');
    expect(minToHHMM(1320)).toBe('22:00');
    expect(hhmmToMin('7:30')).toBe(450);
    expect(hhmmToMin('25:00')).toBeNull();
    expect(hhmmToMin('nope')).toBeNull();
  });
  it('names day sets', () => {
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(daysLabel([4, 3, 2, 1, 0])).toBe('Mon–Fri');
    expect(daysLabel([5, 6])).toBe('Sat–Sun');
    expect(daysLabel([0, 2])).toBe('Mon, Wed');
    expect(downtimeSummary(nights)).toBe('every day · 22:00–07:00');
    expect(downtimeSummary({ ...nights, startMin: 0, endMin: 0 })).toBe('every day · all day');
  });
});

describe('presets', () => {
  it('offers snooze and pause durations; drops "Until 17:00" after 17:00', () => {
    expect(snoozePresets(at(10)).map((p) => p.label)).toEqual(['1 hour', 'Rest of today', '1 week']);
    expect(snoozePresets(at(10))[1].until).toBe(at(23, 59));
    expect(pausePresets(at(10)).map((p) => p.label)).toEqual(['For 30 minutes', 'For 1 hour', 'Until 17:00', 'Until tomorrow 08:00', 'Until I turn it back on']);
    expect(pausePresets(at(18)).map((p) => p.label)).not.toContain('Until 17:00');
    expect(pausePresets(at(10)).at(-1)?.until).toBeNull();
    expect(pausePresets(at(10))[3].until).toBe(at(8, 0, 20));
  });
});

describe('quietLabel', () => {
  const base: QuietState = { pause: null, activeDowntime: null, nextDowntime: null, heldSinceQuiet: 0 };
  it('describes notifying, paused and downtime states', () => {
    expect(quietLabel(base)).toEqual({ state: 'notifying', text: 'Notifying', detail: '' });
    expect(quietLabel({ ...base, nextDowntime: { downtime: nights, startsAt: at(22) } }).detail).toBe('Nights at 22:00');
    expect(quietLabel({ ...base, pause: { until: at(15, 30), letUrgent: true, setAt: 0 } })).toEqual({ state: 'paused', text: 'Paused', detail: 'until 15:30' });
    expect(quietLabel({ ...base, pause: { until: null, letUrgent: true, setAt: 0 } }).detail).toBe('until resumed');
    expect(quietLabel({ ...base, activeDowntime: nights })).toEqual({ state: 'downtime', text: 'Nights', detail: 'downtime · 07:00' });
  });
});

describe('held reasons, scopes and hints', () => {
  const names = { W1: 'ops-oncall' };
  it('explains held reasons', () => {
    const rules = [{ id: 'R1', scopeKind: 'source' as const, scopeValue: 'workspace:W1', level: 'off' as const, snoozeUntil: null }];
    expect(heldReasonLabel(null, [], [], names)).toBe('delivered');
    expect(heldReasonLabel('pause', [], [], names)).toBe('held: notifications were paused');
    expect(heldReasonLabel('downtime:D1', [], [nights], names)).toBe('held: downtime · Nights (every day · 22:00–07:00)');
    expect(heldReasonLabel('rule:R1', rules, [], names)).toBe('held by rule: ops-oncall → Off');
    expect(heldReasonLabel('rule:GONE', rules, [], names)).toBe('held by a rule you removed');
    expect(heldReasonLabel('default-level', [], [], names)).toBe('held by your default level');
  });
  it('labels rule scopes', () => {
    expect(ruleScopeLabel('key', 'workspace:W1:disk', names)).toBe('disk · ops-oncall');
    expect(ruleScopeLabel('key', 'user:water', names)).toBe('water · You');
    expect(ruleScopeLabel('tag', 'ops', names)).toBe('#ops');
    expect(ruleScopeLabel('source', 'user', names)).toBe('You');
  });
  it('builds the muted-row hint', () => {
    expect(mutedHint(undefined, at(10))).toBeNull();
    expect(mutedHint({ level: 'off', snoozeUntil: null, ruleId: null, scopeKind: 'global' }, at(10))).toBeNull();
    expect(mutedHint({ level: 'all', snoozeUntil: null, ruleId: 'R', scopeKind: 'key' }, at(10))).toBeNull();
    expect(mutedHint({ level: 'off', snoozeUntil: null, ruleId: 'R', scopeKind: 'key' }, at(10))).toBe('off for this item');
    expect(mutedHint({ level: 'urgent', snoozeUntil: null, ruleId: 'R', scopeKind: 'source' }, at(10))).toBe('urgent only for this source');
    expect(mutedHint({ level: 'off', snoozeUntil: at(23, 59), ruleId: 'R', scopeKind: 'tag' }, at(10))).toBe('snoozed for this tag · until 23:59');
  });
});
