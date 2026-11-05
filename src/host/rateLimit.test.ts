import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientAddress, UNAUTH_LIMIT, UnauthLimiter } from './rateLimit.js';

const req = (remoteAddress: string, xff?: string | string[]) =>
  ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

describe('UnauthLimiter', () => {
  it('limits an address after max 401s inside the window, until the window passes', () => {
    let t = 0;
    const l = new UnauthLimiter({ max: 2, windowMs: 1000, maxIps: 10, now: () => t });
    l.record('a');
    expect(l.limited('a')).toBe(false);
    l.record('a');
    expect(l.limited('a')).toBe(true);
    expect(l.limited('b')).toBe(false);
    t = 1000;
    expect(l.limited('a')).toBe(false);
  });

  it('tracks at most maxIps addresses, evicting the oldest', () => {
    const l = new UnauthLimiter({ max: 1, windowMs: 1000, maxIps: 2, now: () => 0 });
    l.record('a');
    l.record('b');
    l.record('c');
    expect(l.size).toBe(2);
    expect(l.limited('a')).toBe(false);
    expect(l.limited('b')).toBe(true);
    expect(l.limited('c')).toBe(true);
  });

  it('defaults are bounded', () => {
    expect(UNAUTH_LIMIT).toEqual({ max: 20, windowMs: 60_000, maxIps: 10_000 });
  });
});

describe('clientAddress', () => {
  it('uses the socket address and ignores X-Forwarded-For without trusted hops', () => {
    expect(clientAddress(req('10.0.0.9', '1.2.3.4'), 0)).toBe('10.0.0.9');
  });

  it('takes the address that many hops from the right, never the leftmost', () => {
    expect(clientAddress(req('10.0.0.9', 'spoofed, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.9', 'spoofed, 203.0.113.7, 10.0.0.2'), 2)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.9', ['spoofed', '203.0.113.7, 10.0.0.2']), 2)).toBe('203.0.113.7');
  });

  it('falls back to the socket address when the header is short or not an address', () => {
    expect(clientAddress(req('10.0.0.9', '203.0.113.7'), 2)).toBe('10.0.0.9');
    expect(clientAddress(req('10.0.0.9'), 1)).toBe('10.0.0.9');
    expect(clientAddress(req('10.0.0.9', 'x, not-an-ip'), 1)).toBe('10.0.0.9');
  });
});
