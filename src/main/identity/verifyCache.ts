// Per-token verify cache (remote-workspaces §5): fleet-host verifies every
// request, so successes are cached for 5 minutes — revoking a token or removing
// someone from a team takes effect within that window. Keys are SHA-256 of the
// token (the raw token is never a map key). Failures are not cached; concurrent
// verifications of one token share one upstream call.

import { createHash } from 'node:crypto';
import type { Identity, IdentityProvider } from './types.js';

export const VERIFY_TTL_MS = 5 * 60_000;

export function withVerifyCache(
  inner: IdentityProvider,
  opts: { ttlMs?: number; now?: () => number; maxEntries?: number } = {}
): IdentityProvider {
  const ttl = opts.ttlMs ?? VERIFY_TTL_MS;
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? 1000;
  const hits = new Map<string, { identity: Identity; expiresAt: number }>();
  const inflight = new Map<string, Promise<Identity>>();
  const keyOf = (token: string): string => createHash('sha256').update(token).digest('hex');

  return {
    id: inner.id,
    verify(token) {
      const key = keyOf(token);
      const hit = hits.get(key);
      if (hit && hit.expiresAt > now()) return Promise.resolve(hit.identity);
      if (hit) hits.delete(key);
      const pending = inflight.get(key);
      if (pending) return pending;
      const p = inner
        .verify(token)
        .then((identity) => {
          if (hits.size >= max) {
            const oldest = hits.keys().next().value;
            if (oldest !== undefined) hits.delete(oldest);
          }
          hits.set(key, { identity, expiresAt: now() + ttl });
          return identity;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }
  };
}
