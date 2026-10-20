import { describe, it, expect } from 'vitest';
import {
  scopesFor, sourceScopeValue, effectiveRule, levelAllows, downtimeWindowAt, activeDowntime, nextDowntime, resolve,
  type NotifyRequest, type ResolveCtx
} from './notifyPolicy.js';
import type { Downtime, NotifyRule } from '../../preload/inboxTypes.js';

const W1 = { kind: 'workspace' as const, id: 'W1' };
const req = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({ kind: 'post', priority: 'normal', source: W1, dedupeKey: null, tags: [], ...over });
const rule = (over: Partial<NotifyRule>): NotifyRule => ({ id: 'R', scopeKind: 'global', scopeValue: '', level: 'all', snoozeUntil: null, ...over });
// Monday 2026-10-19 local time.
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 19 + dayOffset, h, m).getTime();
const nights: Downtime = { id: 'D1', name: 'Nights', enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startMin: 22 * 60, endMin: 7 * 60, bypass: 'none' };
const focus: Downtime = { id: 'D2', name: 'Focus', enabled: true, days: [0, 1, 2, 3, 4], startMin: 13 * 60, endMin: 15 * 60, bypass: 'urgent+input' };
const weekend: Downtime = { id: 'D3', name: 'Weekends', enabled: true, days: [5, 6], startMin: 0, endMin: 0, bypass: 'urgent' };
const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({ rules: [], defaultLevel: 'all', pause: null, downtimes: [], now: at(10), ...over });

describe('scopes', () => {
  it('orders key > source > tags > global', () => {
    expect(sourceScopeValue({ kind: 'user', id: null })).toBe('user');
    expect(scopesFor(req({ dedupeKey: 'k', tags: ['ops', 'prod'] }))).toEqual([
      { scopeKind: 'key', scopeValue: 'workspace:W1:k' },
      { scopeKind: 'source', scopeValue: 'workspace:W1' },
      { scopeKind: 'tag', scopeValue: 'ops' },
      { scopeKind: 'tag', scopeValue: 'prod' },
      { scopeKind: 'global', scopeValue: '' }
    ]);
  });
});

describe('levelAllows', () => {
  it.each([
    ['all', 'low', true], ['high', 'normal', false], ['high', 'high', true], ['urgent', 'high', false],
    ['urgent', 'urgent', true], ['off', 'urgent', false]
  ] as const)('%s allows %s → %s', (level, prio, ok) => expect(levelAllows(level, prio)).toBe(ok));
});

describe('effectiveRule', () => {
  const now = at(10);
  it('falls back to the default level', () => {
    expect(effectiveRule(req(), [], 'high', now)).toEqual({ level: 'high', snoozeUntil: null, ruleId: null, scopeKind: 'global' });
  });
  it('key beats source beats tag', () => {
    const rules = [
      rule({ id: 'T', scopeKind: 'tag', scopeValue: 'ops', level: 'off' }),
      rule({ id: 'S', scopeKind: 'source', scopeValue: 'workspace:W1', level: 'urgent' }),
      rule({ id: 'K', scopeKind: 'key', scopeValue: 'workspace:W1:k', level: 'all' })
    ];
    expect(effectiveRule(req({ dedupeKey: 'k', tags: ['ops'] }), rules, 'all', now).ruleId).toBe('K');
    expect(effectiveRule(req({ tags: ['ops'] }), rules, 'all', now).ruleId).toBe('S');
    expect(effectiveRule(req({ source: { kind: 'user', id: null }, tags: ['ops'] }), rules, 'all', now).ruleId).toBe('T');
  });
  it('the strictest tag rule wins among several', () => {
    const rules = [rule({ id: 'A', scopeKind: 'tag', scopeValue: 'a', level: 'all' }), rule({ id: 'B', scopeKind: 'tag', scopeValue: 'b', level: 'urgent' })];
    expect(effectiveRule(req({ tags: ['a', 'b'] }), rules, 'all', now)).toMatchObject({ ruleId: 'B', level: 'urgent' });
  });
  it('an active snooze reads as off; an expired one falls back to the rule level', () => {
    const r = rule({ id: 'S', scopeKind: 'source', scopeValue: 'workspace:W1', level: 'high', snoozeUntil: now + 1 });
    expect(effectiveRule(req(), [r], 'all', now)).toMatchObject({ level: 'off', snoozeUntil: now + 1 });
    expect(effectiveRule(req(), [{ ...r, snoozeUntil: now - 1 }], 'all', now)).toMatchObject({ level: 'high', snoozeUntil: null });
  });
});

describe('downtime windows (local time)', () => {
  it('wraps past midnight and belongs to the day it starts', () => {
    expect(downtimeWindowAt(nights, at(23))).toEqual({ start: at(22), end: at(7, 0, 1) });
    expect(downtimeWindowAt(nights, at(6, 59))).toEqual({ start: at(22, 0, -1), end: at(7) });
    expect(downtimeWindowAt(nights, at(7))).toBeNull();
    expect(downtimeWindowAt(nights, at(12))).toBeNull();
  });
  it('respects days and enabled; all-day when start = end', () => {
    expect(downtimeWindowAt(focus, at(14))).not.toBeNull();
    expect(downtimeWindowAt(focus, at(14, 0, 5))).toBeNull(); // Saturday
    expect(downtimeWindowAt(weekend, at(12, 0, 5))).toEqual({ start: at(0, 0, 5), end: at(0, 0, 6) });
    expect(downtimeWindowAt({ ...nights, enabled: false }, at(23))).toBeNull();
  });
  it('finds the active and the next downtime', () => {
    expect(activeDowntime([focus, nights], at(23))?.downtime.id).toBe('D1');
    expect(nextDowntime([focus, nights], at(10))).toEqual({ downtime: focus, startsAt: at(13) });
    expect(nextDowntime([nights], at(23))).toEqual({ downtime: nights, startsAt: at(22, 0, 1) });
    expect(nextDowntime([], at(10))).toBeNull();
  });
});

describe('resolve', () => {
  it('delivers by default and holds below the level with the rule id or default-level', () => {
    expect(resolve(req(), ctx())).toEqual({ deliver: true });
    expect(resolve(req(), ctx({ defaultLevel: 'high' }))).toEqual({ deliver: false, heldReason: 'default-level' });
    const r = rule({ id: 'R9', scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off' });
    expect(resolve(req({ priority: 'urgent' }), ctx({ rules: [r] }))).toEqual({ deliver: false, heldReason: 'rule:R9' });
  });
  it('tests and digests bypass rules and quiet', () => {
    const quiet = ctx({ defaultLevel: 'off', pause: { until: null, letUrgent: false, setAt: 0 } });
    expect(resolve(req({ kind: 'test' }), quiet)).toEqual({ deliver: true });
    expect(resolve(req({ kind: 'digest' }), quiet)).toEqual({ deliver: true });
  });
  it('pause holds, lets urgent through when asked, and expires', () => {
    const pause = { until: at(11), letUrgent: true, setAt: at(9) };
    expect(resolve(req(), ctx({ pause }))).toEqual({ deliver: false, heldReason: 'pause' });
    expect(resolve(req({ priority: 'urgent' }), ctx({ pause }))).toEqual({ deliver: true });
    expect(resolve(req({ priority: 'urgent' }), ctx({ pause: { ...pause, letUrgent: false } }))).toEqual({ deliver: false, heldReason: 'pause' });
    expect(resolve(req(), ctx({ pause, now: at(12) }))).toEqual({ deliver: true });
    expect(resolve(req(), ctx({ pause: { until: null, letUrgent: false, setAt: 0 }, now: at(12) }))).toEqual({ deliver: false, heldReason: 'pause' });
  });
  it('downtime holds with its bypass', () => {
    expect(resolve(req({ priority: 'urgent' }), ctx({ downtimes: [nights], now: at(23) }))).toEqual({ deliver: false, heldReason: 'downtime:D1' });
    expect(resolve(req({ priority: 'urgent' }), ctx({ downtimes: [weekend], now: at(12, 0, 5) }))).toEqual({ deliver: true });
    expect(resolve(req({ kind: 'input-wait', priority: 'high' }), ctx({ downtimes: [focus], now: at(14) }))).toEqual({ deliver: true });
    expect(resolve(req({ priority: 'high' }), ctx({ downtimes: [focus], now: at(14) }))).toEqual({ deliver: false, heldReason: 'downtime:D2' });
  });
  it('pause vs downtime: the most recent explicit action wins', () => {
    // Paused (holding urgent) at 13:30, inside a focus block that started at 13:00 → the pause decides.
    const pauseAfter = { until: null, letUrgent: false, setAt: at(13, 30) };
    expect(resolve(req({ priority: 'urgent' }), ctx({ downtimes: [focus], pause: pauseAfter, now: at(14) }))).toEqual({ deliver: false, heldReason: 'pause' });
    // Paused (letting urgent through) at 21:00; Nights (urgent waits) began at 22:00 → the downtime decides.
    const pauseBefore = { until: null, letUrgent: true, setAt: at(21) };
    expect(resolve(req({ priority: 'urgent' }), ctx({ downtimes: [nights], pause: pauseBefore, now: at(23) }))).toEqual({ deliver: false, heldReason: 'downtime:D1' });
  });
});
