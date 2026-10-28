import { describe, expect, it } from 'vitest';
import { applyFloor, MAX_NEXT_MS, parseNextRequest } from './reschedule';

const NOW = Date.UTC(2026, 9, 28, 12, 0);

describe('parseNextRequest', () => {
  it('resolves `in` against now', () => {
    expect(parseNextRequest({ in: '4h' }, NOW)).toEqual({ ok: true, at: NOW + 4 * 3_600_000 });
    expect(parseNextRequest({ in: '2d' }, NOW)).toEqual({ ok: true, at: NOW + 2 * 86_400_000 });
  });
  it('takes an absolute ISO `at`', () => {
    expect(parseNextRequest({ at: '2026-10-29T09:00:00Z' }, NOW)).toEqual({ ok: true, at: Date.UTC(2026, 9, 29, 9, 0) });
  });
  it('needs exactly one of in / at', () => {
    expect(parseNextRequest({}, NOW).ok).toBe(false);
    expect(parseNextRequest({ in: '1h', at: '2026-10-29T09:00:00Z' }, NOW).ok).toBe(false);
    expect(parseNextRequest(null, NOW).ok).toBe(false);
  });
  it('rejects bad values and the far future', () => {
    expect(parseNextRequest({ in: 'soon' }, NOW).ok).toBe(false);
    expect(parseNextRequest({ at: 'tomorrow' }, NOW).ok).toBe(false);
    expect(parseNextRequest({ at: 12345 }, NOW).ok).toBe(false);
    expect(parseNextRequest({ in: '400d' }, NOW).ok).toBe(false);
    expect(parseNextRequest({ at: new Date(NOW + MAX_NEXT_MS + 60_000).toISOString() }, NOW).ok).toBe(false);
  });
});

describe('applyFloor', () => {
  it('keeps a request at or past the floor', () => {
    expect(applyFloor(NOW + 3_600_000, NOW, 30 * 60_000)).toEqual({ at: NOW + 3_600_000, clamped: false });
  });
  it('clamps a request sooner than the floor (including the past)', () => {
    expect(applyFloor(NOW + 60_000, NOW, 30 * 60_000)).toEqual({ at: NOW + 30 * 60_000, clamped: true });
    expect(applyFloor(NOW - 60_000, NOW, 30 * 60_000)).toEqual({ at: NOW + 30 * 60_000, clamped: true });
  });
});
