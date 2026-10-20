import { describe, it, expect } from 'vitest';
import { parseCron, nextFire, describeCron, isValidTimeZone, CronError } from './cron.js';

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('parseCron', () => {
  it('parses stars, lists, ranges and steps; maps DOW 7 to Sunday', () => {
    const s = parseCron('*/30 8-18 * * 1-5');
    expect([...s.minute]).toEqual([0, 30]);
    expect(s.hour.size).toBe(11);
    expect([...s.dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 9 * * 7').dow]).toEqual([0]);
    expect([...parseCron('5,10-12 * * * *').minute]).toEqual([5, 10, 11, 12]);
    expect([...parseCron('0 1/6 * * *').hour]).toEqual([1, 7, 13, 19]);
  });
  it('rejects bad expressions with a readable reason', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/minute out of range/);
    expect(() => parseCron('a * * * *')).toThrow(CronError);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
  });
});

describe('nextFire (host local time)', () => {
  it('finds the next match strictly after the given time', () => {
    const s = parseCron('*/30 8-18 * * 1-5');
    expect(nextFire(s, local(2026, 10, 19, 10, 5))).toBe(local(2026, 10, 19, 10, 30)); // Monday
    expect(nextFire(s, local(2026, 10, 19, 10, 30))).toBe(local(2026, 10, 19, 11, 0));
    expect(nextFire(s, local(2026, 10, 19, 18, 30))).toBe(local(2026, 10, 20, 8, 0));
    expect(nextFire(s, local(2026, 10, 23, 19, 0))).toBe(local(2026, 10, 26, 8, 0)); // Fri evening → Mon
  });
  it('daily times and Vixie DOM/DOW OR semantics', () => {
    expect(nextFire(parseCron('0 9,15 * * *'), local(2026, 10, 19, 9, 0))).toBe(local(2026, 10, 19, 15, 0));
    const either = parseCron('0 6 1 * 1'); // 1st of month OR Monday
    expect(nextFire(either, local(2026, 10, 19, 7, 0))).toBe(local(2026, 10, 26, 6, 0));
    expect(nextFire(either, local(2026, 10, 27, 7, 0))).toBe(local(2026, 11, 1, 6, 0));
  });
  it('returns null for an impossible date', () => {
    expect(nextFire(parseCron('0 0 31 2 *'), local(2026, 1, 1, 0))).toBeNull();
  });
});

describe('nextFire in an IANA time zone', () => {
  it('evaluates wall-clock time in the zone, across DST', () => {
    const s = parseCron('0 9 * * *');
    // 2026-11-01 is the US DST fall-back day; 09:00 EST = 14:00 UTC; the day before (EDT) 09:00 = 13:00 UTC.
    expect(nextFire(s, Date.UTC(2026, 9, 31, 12, 0), 'America/New_York')).toBe(Date.UTC(2026, 9, 31, 13, 0));
    expect(nextFire(s, Date.UTC(2026, 9, 31, 14, 0), 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 14, 0));
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('describeCron', () => {
  it('summarizes common shapes and falls back to the expression', () => {
    expect(describeCron('*/30 8-18 * * 1-5')).toBe('every 30 min · 08–18 · weekdays');
    expect(describeCron('*/15 * * * *')).toBe('every 15 min');
    expect(describeCron('0 9,15 * * *')).toBe('daily 09:00, 15:00');
    expect(describeCron('0 2 * * *')).toBe('daily 02:00');
    expect(describeCron('0 6 1 * *')).toBe('0 6 1 * *');
  });
});
