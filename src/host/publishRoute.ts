// POST /publish (remote-workspaces §6, §7): admission before the body is read, the server-side
// scrub, then the holder's publish store. The owner comes only from the verified identity.
import type { OutgoingHttpHeaders } from 'node:http';
import { parsePublishBody, PublishArgError, type PublishBatch, type PublishOwner } from '../main/publish/protocol.js';
import { makeScrubber, UnpublishableLineError, type ScrubbedLine, type ScrubValue } from '../main/publish/scrub.js';
import { ownerKey, type Principal } from './attachHub.js';
import type { Logger } from './log.js';
import { LeaseLostError } from './pgLease.js';
import { PublishConflictError, type PublishStore } from './publishStore.js';

export const PUBLISH_BURST = 20;
export const PUBLISH_PER_SEC = 2;
export const PUBLISH_MAX_IN_FLIGHT = 4;
const MAX_TRACKED = 10_000;

export type Admission =
  | { ok: true; release(): void }
  | { ok: false; status: 403 | 429 | 503; error: string; retryAfterSec?: number };

export interface RouteReply {
  status: number;
  body: unknown;
  headers?: OutgoingHttpHeaders;
}

export interface PublishRoute {
  admit(caller: Principal): Admission;
  post(caller: Principal, body: unknown): Promise<RouteReply>;
}

/** Per identity: one in flight and a token bucket; host-wide: a cap on in-flight publishes. */
export class PublishGate {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly busy = new Set<string>();
  private inFlight = 0;

  constructor(private readonly o: { burst?: number; perSec?: number; maxInFlight?: number; now?: () => number } = {}) {}

  admit(key: string): Admission {
    if (this.busy.has(key)) return { ok: false, status: 429, error: 'a publish from you is already in flight', retryAfterSec: 1 };
    if (this.inFlight >= (this.o.maxInFlight ?? PUBLISH_MAX_IN_FLIGHT)) return { ok: false, status: 503, error: 'publish busy', retryAfterSec: 1 };
    const now = (this.o.now ?? Date.now)();
    const burst = this.o.burst ?? PUBLISH_BURST;
    const rate = this.o.perSec ?? PUBLISH_PER_SEC;
    const prev = this.buckets.get(key) ?? { tokens: burst, at: now };
    const tokens = Math.min(burst, prev.tokens + ((now - prev.at) / 1000) * rate);
    // Re-inserted last, so eviction at the cap drops the least recently seen identity.
    this.buckets.delete(key);
    if (this.buckets.size >= MAX_TRACKED) this.buckets.delete(this.buckets.keys().next().value as string);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return { ok: false, status: 429, error: 'publishing too fast', retryAfterSec: Math.ceil((1 - tokens) / rate) };
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    this.busy.add(key);
    this.inFlight++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.busy.delete(key);
        this.inFlight--;
      }
    };
  }
}

const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

function connectionPassword(v: string): string | null {
  if (!/^postgres(?:ql)?:\/\//i.test(v)) return null;
  try {
    return decodeURIComponent(new URL(v).password) || null;
  } catch {
    return null;
  }
}

/** fleet-host's own secrets, scrubbed from published lines on top of the patterns (D103). */
export function hostSecretValues(env: NodeJS.ProcessEnv, alsoNames: readonly string[] = []): ScrubValue[] {
  const named = new Set(alsoNames);
  const out: ScrubValue[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || (!SECRET_NAME.test(key) && !named.has(key))) continue;
    out.push({ key, value });
    const pw = connectionPassword(value);
    if (pw) out.push({ key, value: pw });
  }
  return out;
}

export function ownerOf(caller: Principal): PublishOwner {
  return { provider: caller.identity.provider, id: caller.identity.id, login: caller.identity.login };
}

export function failureReply(err: unknown): RouteReply {
  if (err instanceof PublishConflictError) return { status: 409, body: { ok: false, error: err.message } };
  if (err instanceof LeaseLostError) return { status: 503, body: { ok: false, error: 'standby' }, headers: { 'Retry-After': '5' } };
  if ((err as { code?: unknown } | null)?.code === '57014') return { status: 503, body: { ok: false, error: 'publish busy' }, headers: { 'Retry-After': '1' } };
  throw err;
}

const refuse = (error: string): RouteReply => ({ status: 400, body: { ok: false, error } });

export function createPublishRoute(o: { store: () => PublishStore | null; hostSecrets: readonly ScrubValue[]; log: Logger; gate?: PublishGate }): PublishRoute {
  const gate = o.gate ?? new PublishGate();
  const scrub = makeScrubber(o.hostSecrets);
  return {
    admit(caller) {
      if (caller.identity.kind !== 'user') return { ok: false, status: 403, error: 'publishing is for people, not machine identities' };
      return gate.admit(ownerKey(caller.identity));
    },
    async post(caller, body) {
      let req: PublishBatch;
      let lines: ScrubbedLine[];
      try {
        req = parsePublishBody(body);
        lines = req.events.map((l, i) => {
          try {
            return scrub(l);
          } catch (err) {
            if (err instanceof UnpublishableLineError) throw new PublishArgError(`events[${i}]: ${err.message}`);
            throw err;
          }
        });
      } catch (err) {
        if (err instanceof PublishArgError) return refuse(err.message);
        throw err;
      }
      const store = o.store();
      if (!store) return { status: 503, body: { ok: false, error: 'publish unavailable' }, headers: { 'Retry-After': '5' } };
      try {
        const r = await store.ingest(ownerOf(caller), req.sourceWorkspaceId, req.sessionId, lines);
        o.log.log('info', 'publish', {
          login: caller.identity.login, sourceWorkspaceId: req.sourceWorkspaceId, sessionId: req.sessionId, lines: lines.length, inserted: r.inserted
        });
        return { status: 200, body: { ok: true, accepted: lines.length, inserted: r.inserted } };
      } catch (err) {
        return failureReply(err);
      }
    }
  };
}
