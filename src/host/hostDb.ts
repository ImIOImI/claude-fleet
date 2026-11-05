// The host pool: the 'host' track (meta, lease, ingest offsets) on an unfenced
// handle, opened at start by holder and standby alike.
import type pg from 'pg';
import type { Kysely } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { createPgPool, postgresKysely, type PgPoolConfig } from '../main/store/postgres.js';
import { iamAuthHint, pgPoolConfig, StoreConfigError, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import type { Logger } from './log.js';

/** Below TTL − renew (20 s), so a partitioned holder's FOR SHARE can't block a takeover for long. */
export const HOST_PG_SESSION = { idleInTransactionMs: 10_000, statementTimeoutMs: 30_000 };

/** For both host pools (host and store). */
export const HOST_PG_POOL: Pick<PgPoolConfig, 'session' | 'keepAlive' | 'keepAliveInitialDelayMillis'> = {
  session: HOST_PG_SESSION,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000
};

export interface HostDbHandle {
  pool: pg.Pool;
  k: Kysely<HostDb>;
  ping(): Promise<void>;
  end(): Promise<void>;
}

export async function openHostDb(cfg: PostgresStoreConfig, o: { env?: NodeJS.ProcessEnv; log: Logger }): Promise<HostDbHandle> {
  const pool = createPgPool({ ...pgPoolConfig(cfg, o.env), ...HOST_PG_POOL, max: 2 });
  pool.on('error', (e) => o.log.log('warn', 'host db pool error', { error: e.message }));
  const k = postgresKysely<HostDb>(pool);
  try {
    await migratePostgres(k, cfg.schema, HOST_TRACK);
  } catch (e) {
    await k.destroy().catch(() => undefined);
    await pool.end().catch(() => undefined);
    const hint = iamAuthHint(cfg, e);
    if (hint) (e as Error).message += ` (${hint})`;
    throw e;
  }
  return {
    pool,
    k,
    async ping() {
      await k.selectNoFrom((eb) => eb.val(1).as('one')).execute();
    },
    async end() {
      await k.destroy();
      await pool.end();
    }
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Retries anything but a config error, so a DB blip at start doesn't crash-loop the container. */
export async function openHostDbRetrying(
  cfg: PostgresStoreConfig,
  o: { env?: NodeJS.ProcessEnv; log: Logger; sleep?: (ms: number) => Promise<void>; maxDelayMs?: number; signal?: AbortSignal }
): Promise<HostDbHandle> {
  const sleep = o.sleep ?? ((ms: number) => abortableSleep(ms, o.signal));
  const aborted = () => new Error('host db open aborted');
  for (let delay = 1_000; ; delay = Math.min(delay * 2, o.maxDelayMs ?? 30_000)) {
    if (o.signal?.aborted) throw aborted();
    try {
      const h = await openHostDb(cfg, o);
      if (o.signal?.aborted) {
        await h.end().catch(() => undefined);
        throw aborted();
      }
      return h;
    } catch (err) {
      if (err instanceof StoreConfigError || o.signal?.aborted) throw err;
      o.log.log('warn', 'host db unavailable; retrying', { error: (err as Error).message, delayMs: delay });
      await sleep(delay);
    }
  }
}

export interface DbHealth {
  ok(): boolean;
  tick(): Promise<void>;
  stop(): void;
}

export function startDbHealth(
  ping: () => Promise<void>,
  o: { log: Logger; intervalMs?: number; maxAgeMs?: number; timeoutMs?: number; now?: () => number }
): DbHealth {
  const now = o.now ?? Date.now;
  let lastOk: number | null = null;
  let failing = false;
  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    running ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ping(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('db ping timed out')), o.timeoutMs ?? 3_000);
          })
        ]);
        lastOk = now();
        if (failing) o.log.log('info', 'host db reachable again');
        failing = false;
      } catch (err) {
        if (!failing) o.log.log('warn', 'host db ping failed', { error: (err as Error).message });
        failing = true;
      } finally {
        clearTimeout(timer);
        running = null;
      }
    })();
    return running;
  };
  void tick();
  const t = setInterval(() => void tick(), o.intervalMs ?? 5_000);
  t.unref();
  return { ok: () => lastOk !== null && now() - lastOk <= (o.maxAgeMs ?? 15_000), tick, stop: () => clearInterval(t) };
}
