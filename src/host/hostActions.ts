// At-most-once host actions (D128): claim the request id in the fenced ledger,
// run, then store the outcome. A replay returns the stored outcome.
import type { Kysely } from 'kysely';
import type { Tier } from '../main/identity/grants.js';
import { oneLine } from '../main/remoteUrl.js';
import { REQUEST_ID_RE, type HostActionReply } from '../preload/remoteAutomations.js';
import { ownerKey, type Principal } from './attachHub.js';
import type { HostDb } from './hostSchema.js';
import { redactSecrets } from './log.js';
import { LeaseLostError } from './pgLease.js';
import type { UnauthLimiter } from './rateLimit.js';
import { RpcArgError, RpcBusyError, RpcUnavailableError, type RpcChannel } from './rpc.js';

export const LEDGER_TTL_MS = 86_400_000;
export const MAX_STORED_RESULT = 16 * 1024;
/** Per identity per minute (D129). */
export const ACTION_LIMITS = { run: 6, draft: 2, other: 60 } as const;

export type Claim = { fresh: true } | { fresh: false; channel: string; result: unknown; error: string | null };

export interface ActionLedger {
  claim(actor: string, requestId: string, channel: string): Promise<Claim>;
  settle(actor: string, requestId: string, o: { result: unknown } | { error: string }): Promise<void>;
}

function capJson(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  return s.length > MAX_STORED_RESULT ? '{"truncated":true}' : s;
}

/** On the holder's fenced handle: every statement checks the lease. */
export function pgActionLedger(k: Kysely<HostDb>, now: () => number = Date.now): ActionLedger {
  return {
    async claim(actor, requestId, channel) {
      const t = now();
      await k.deleteFrom('host_action_requests').where('created_at', '<', t - LEDGER_TTL_MS).execute();
      const ins = await k.insertInto('host_action_requests')
        .values({ actor, request_id: requestId, channel, created_at: t, settled_at: null, result: null, error: null })
        .onConflict((oc) => oc.columns(['actor', 'request_id']).doNothing())
        .returning('request_id').executeTakeFirst();
      if (ins) return { fresh: true };
      const r = await k.selectFrom('host_action_requests').select(['channel', 'result', 'error'])
        .where('actor', '=', actor).where('request_id', '=', requestId).executeTakeFirstOrThrow();
      return { fresh: false, channel: r.channel, result: r.result === null ? null : (JSON.parse(r.result) as unknown), error: r.error };
    },
    async settle(actor, requestId, o) {
      await k.updateTable('host_action_requests')
        .set({ settled_at: now(), result: 'result' in o ? capJson(o.result) : null, error: 'error' in o ? o.error : null })
        .where('actor', '=', actor).where('request_id', '=', requestId).execute();
    }
  };
}

/** Process-local: tests, and a host without `db:` (which has no holder runtime anyway). */
export function memoryActionLedger(now: () => number = Date.now): ActionLedger {
  const rows = new Map<string, { channel: string; at: number; result: string | null; error: string | null }>();
  return {
    async claim(actor, requestId, channel) {
      const t = now();
      for (const [key, r] of rows) if (r.at < t - LEDGER_TTL_MS) rows.delete(key);
      const key = `${actor}\u0000${requestId}`;
      const r = rows.get(key);
      if (!r) {
        rows.set(key, { channel, at: t, result: null, error: null });
        return { fresh: true };
      }
      return { fresh: false, channel: r.channel, result: r.result === null ? null : (JSON.parse(r.result) as unknown), error: r.error };
    },
    async settle(actor, requestId, o) {
      const r = rows.get(`${actor}\u0000${requestId}`);
      if (!r) return;
      r.result = 'result' in o ? capJson(o.result) : null;
      r.error = 'error' in o ? o.error : null;
    }
  };
}

export interface ActionSpec<A> {
  tier: Tier;
  channel: string;
  /** Throws RpcArgError; runs before anything is claimed. */
  parse(o: Record<string, unknown>): A;
  /** null: no holder. */
  ledger(): ActionLedger | null;
  limit?: { key: string; limiter: UnauthLimiter };
  run(a: A, caller: Principal, requestId: string): Promise<unknown>;
}

const unavailable = (err: unknown): never => {
  if (err instanceof LeaseLostError) throw new RpcUnavailableError('automations unavailable');
  throw err;
};

export function actionChannel<A>(spec: ActionSpec<A>): RpcChannel {
  return {
    tier: spec.tier,
    async handle([raw], caller): Promise<HostActionReply> {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpcArgError('args must be [{ requestId, … }]');
      const o = raw as Record<string, unknown>;
      if (typeof o.requestId !== 'string' || !REQUEST_ID_RE.test(o.requestId)) throw new RpcArgError('requestId must be a lowercase UUID v4');
      const requestId = o.requestId;
      const a = spec.parse(o);
      const ledger = spec.ledger();
      if (!ledger) throw new RpcUnavailableError('automations unavailable');
      const actor = ownerKey(caller.identity);
      if (spec.limit) {
        // Checked and spent before the first await, so a concurrent burst can't overshoot; a replay spends one too.
        const key = `${spec.limit.key}\u0000${actor}`;
        if (spec.limit.limiter.limited(key)) {
          throw new RpcBusyError('too many requests; try again shortly', Math.max(1, Math.ceil(spec.limit.limiter.retryAfterMs(key) / 1000)));
        }
        spec.limit.limiter.record(key);
      }
      const c = await ledger.claim(actor, requestId, spec.channel).catch(unavailable);
      if (!c.fresh) {
        if (c.channel !== spec.channel) throw new RpcArgError('requestId was already used for another action');
        return { replayed: true, result: c.result, error: c.error };
      }
      let outcome: { result: unknown } | { error: string };
      try {
        outcome = { result: (await spec.run(a, caller, requestId)) ?? null };
      } catch (err) {
        // The claim stays unsettled: a retry replays "in flight or interrupted", never a second run.
        if (err instanceof LeaseLostError) unavailable(err);
        outcome = { error: oneLine(redactSecrets(err instanceof Error ? err.message : String(err)), 500) };
      }
      await ledger.settle(actor, requestId, outcome).catch(unavailable);
      return 'result' in outcome ? { replayed: false, result: outcome.result, error: null } : { replayed: false, result: null, error: outcome.error };
    }
  };
}
