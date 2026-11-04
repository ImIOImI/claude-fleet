// Per-address limit on 401s, checked before verify so a flood of garbage
// tokens can't drive GitHub calls.
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export interface UnauthLimitOptions {
  max: number;
  windowMs: number;
  /** Tracked addresses; the oldest is evicted beyond this. */
  maxIps: number;
  now?: () => number;
}

export const UNAUTH_LIMIT = { max: 20, windowMs: 60_000, maxIps: 10_000 };

export class UnauthLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: UnauthLimitOptions = UNAUTH_LIMIT) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.hits.size;
  }

  limited(ip: string): boolean {
    const h = this.hits.get(ip);
    return !!h && this.now() - h.start < this.opts.windowMs && h.count >= this.opts.max;
  }

  record(ip: string): void {
    const t = this.now();
    const h = this.hits.get(ip);
    this.hits.delete(ip);
    const next = h && t - h.start < this.opts.windowMs ? { start: h.start, count: h.count + 1 } : { start: t, count: 1 };
    if (this.hits.size >= this.opts.maxIps) this.hits.delete(this.hits.keys().next().value as string);
    this.hits.set(ip, next);
  }
}

/** The socket address, or with `trustedHops` the X-Forwarded-For entry that many hops from the right. */
export function clientAddress(req: IncomingMessage, trustedHops: number): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (trustedHops <= 0) return socket;
  const raw = req.headers['x-forwarded-for'];
  const parts = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const hop = parts.length >= trustedHops ? parts[parts.length - trustedHops] : undefined;
  return hop && isIP(hop) ? hop : socket;
}
