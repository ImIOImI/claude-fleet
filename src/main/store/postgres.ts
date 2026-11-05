// The Postgres dialect of the async store layer (remote-workspaces spec §7
// "One store layer"). Stores stay dialect-neutral; this file owns the pool
// shape, type parsing, search_path and the in-process write lock.
import pg from 'pg';
import {
  CompiledQuery, Kysely, PostgresDialect,
  type DatabaseConnection, type Driver, type OperationNode, type QueryResult, type TransactionSettings, type WithNode,
} from 'kysely';

const INT8 = 20;
const NUMERIC = 1700;

/** int8 (COUNT, BIGINT columns) and numeric (SUM of BIGINT) parse to number,
 *  as SQLite returns them. Per pool, never pg's global registry. */
export const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8 || oid === NUMERIC) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format);
  },
};

export interface PgSessionSettings {
  /** idle_in_transaction_session_timeout: the server ends a session (and its locks) left idle in a transaction. */
  idleInTransactionMs?: number;
  statementTimeoutMs?: number;
}

export interface PgPoolConfig extends Omit<pg.PoolConfig, 'types'> {
  /** Every store table lives here; it must already exist. */
  schema: string;
  session?: PgSessionSettings;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const poolSchema = new WeakMap<pg.Pool, string>();
const poolSession = new WeakMap<pg.Pool, string>();
const inSchema = new WeakSet<pg.PoolClient>();

export function createPgPool(cfg: PgPoolConfig): pg.Pool {
  const { schema, session, ...rest } = cfg;
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid store schema name: ${schema}`);
  const pool = new pg.Pool({ ...rest, types: pgTypes });
  poolSchema.set(pool, schema);
  poolSession.set(pool, sessionSql(session));
  return pool;
}

function sessionSql(s: PgSessionSettings | undefined): string {
  const ms = (n: number | undefined, name: string) => {
    if (n === undefined) return '';
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${name}: ${n}`);
    return `; SET ${name} = ${n}`;
  };
  return ms(s?.idleInTransactionMs, 'idle_in_transaction_session_timeout') + ms(s?.statementTimeoutMs, 'statement_timeout');
}

/** The schema a pool was created for. */
export function schemaOf(pool: pg.Pool): string {
  const s = poolSchema.get(pool);
  if (!s) throw new Error('not a store pool: create it with createPgPool');
  return s;
}

/** pool.connect() with search_path set once per physical connection. A
 *  startup `options` parameter would do it too, but poolers and some servers
 *  drop it; an explicit SET is honored everywhere. */
async function connectInSchema(pool: pg.Pool): Promise<pg.PoolClient> {
  const client = await pool.connect();
  if (!inSchema.has(client)) {
    const schema = poolSchema.get(pool);
    try {
      if (schema) await client.query(`SET search_path TO ${schema}, public${poolSession.get(pool) ?? ''}`);
    } catch (e) {
      client.release(e as Error);
      throw e;
    }
    inSchema.add(client);
    // pg leaves a checked-out client's 'error' (server ended the session) unhandled, which would crash the process.
    client.on('error', (e) => pool.emit('error', e, client));
  }
  return client;
}

/** Promise-chain mutex: `await lock()` resolves to its release function. */
export function writeLock(): () => Promise<() => void> {
  let tail = Promise.resolve();
  return () => {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const acquired = tail.then(() => release);
    tail = tail.then(() => next);
    return acquired;
  };
}

/** Runs first in every read-write transaction (and around a bare write);
 *  a throw rolls the transaction back. fleet-host's lease fence plugs in here. */
export type WriteHook = (exec: (sqlText: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<void>;

// Raw `sql` statements count as writes: closeDb's `select 1` must queue behind
// in-flight write transactions, as it did on the SQLite mutex.
const WRITE_KINDS = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode', 'RawNode']);

/** A SELECT whose WITH holds an INSERT/UPDATE/DELETE/MERGE (at any depth) writes too. */
function isWrite(node: OperationNode): boolean {
  if (WRITE_KINDS.has(node.kind)) return true;
  const w = (node as { with?: WithNode }).with;
  return !!w?.expressions.some((cte) => isWrite(cte.expression));
}

/** Postgres rejects a NUL (U+0000) anywhere in a text value outright
 *  ("invalid byte sequence for encoding UTF8: 0x00"), which would otherwise
 *  stick an ingest batch forever at the same offset. SQLite has no such
 *  restriction, so this runs only on this dialect. Only top-level string
 *  params are mapped: arrays and buffers pass through unchanged. */
function sanitizeNul<T>(value: T): T {
  return (typeof value === 'string' ? value.replace(/\u0000/g, '�') : value) as T;
}

function sanitizeNulParams(cq: CompiledQuery): CompiledQuery {
  return { ...cq, parameters: cq.parameters.map(sanitizeNul) };
}

interface Conn extends DatabaseConnection { inner: DatabaseConnection | null; inTx: boolean; unlock: (() => void) | null }

/** Serializes every in-process write (read-write transactions and bare write
 *  statements), as SQLite's connection mutex did; reads and read-only
 *  transactions run concurrently on the pool. The pool connection is taken
 *  lazily, after the write lock, so queued writers never starve reads. */
class SerializingDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly lock: () => Promise<() => void>,
    private readonly hook: WriteHook | undefined,
  ) {}

  init(): Promise<void> { return this.inner.init(); }

  async acquireConnection(): Promise<DatabaseConnection> {
    const conn: Conn = {
      inner: null, inTx: false, unlock: null,
      executeQuery: <R>(cq: CompiledQuery) => this.execute<R>(conn, cq),
      streamQuery: (cq, chunk) => this.stream(conn, cq, chunk),
    };
    return conn;
  }

  private async innerOf(conn: Conn): Promise<DatabaseConnection> {
    conn.inner ??= await this.inner.acquireConnection();
    return conn.inner;
  }

  private async *stream<R>(conn: Conn, cq: CompiledQuery, chunk?: number): AsyncIterableIterator<QueryResult<R>> {
    yield* (await this.innerOf(conn)).streamQuery<R>(sanitizeNulParams(cq), chunk);
  }

  private async execute<R>(conn: Conn, cq0: CompiledQuery): Promise<QueryResult<R>> {
    const cq = sanitizeNulParams(cq0);
    if (conn.inTx || !isWrite(cq.query)) return (await this.innerOf(conn)).executeQuery<R>(cq);
    const unlock = await this.lock();
    try {
      const inner = await this.innerOf(conn);
      if (!this.hook) return await inner.executeQuery<R>(cq);
      await inner.executeQuery(CompiledQuery.raw('begin'));
      try {
        await this.hook(this.exec(inner));
        const r = await inner.executeQuery<R>(cq);
        await inner.executeQuery(CompiledQuery.raw('commit'));
        return r;
      } catch (e) {
        await inner.executeQuery(CompiledQuery.raw('rollback')).catch(() => undefined);
        throw e;
      }
    } finally {
      unlock();
    }
  }

  async beginTransaction(c: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const conn = c as Conn;
    const write = settings.accessMode !== 'read only';
    if (write) conn.unlock = await this.lock();
    conn.inTx = true;
    let inner: DatabaseConnection;
    try {
      inner = await this.innerOf(conn);
      await this.inner.beginTransaction(inner, settings);
    } catch (e) {
      this.end(conn);
      throw e;
    }
    if (!write || !this.hook) return;
    try {
      await this.hook(this.exec(inner));
    } catch (e) {
      await this.inner.rollbackTransaction(inner).catch(() => undefined);
      this.end(conn);
      throw e;
    }
  }

  async commitTransaction(c: DatabaseConnection): Promise<void> {
    try { await this.inner.commitTransaction(await this.innerOf(c as Conn)); } finally { this.end(c as Conn); }
  }

  async rollbackTransaction(c: DatabaseConnection): Promise<void> {
    try { await this.inner.rollbackTransaction(await this.innerOf(c as Conn)); } finally { this.end(c as Conn); }
  }

  async releaseConnection(c: DatabaseConnection): Promise<void> {
    const conn = c as Conn;
    if (conn.inner) await this.inner.releaseConnection(conn.inner);
    conn.inner = null;
  }

  destroy(): Promise<void> { return this.inner.destroy(); }

  private exec(inner: DatabaseConnection) {
    return async (sqlText: string, params: readonly unknown[] = []) =>
      (await inner.executeQuery(CompiledQuery.raw(sqlText, params.map(sanitizeNul)))).rows as unknown[];
  }

  private end(conn: Conn): void {
    conn.inTx = false;
    conn.unlock?.();
    conn.unlock = null;
  }
}

class SerializingPostgresDialect extends PostgresDialect {
  constructor(
    cfg: ConstructorParameters<typeof PostgresDialect>[0],
    private readonly lock: () => Promise<() => void>,
    private readonly hook: WriteHook | undefined,
  ) { super(cfg); }
  override createDriver(): Driver { return new SerializingDriver(super.createDriver(), this.lock, this.hook); }
}

export interface PostgresKyselyOptions { afterBeginWrite?: WriteHook }

/** A Kysely handle on a shared pool, with its own write lock (one per store,
 *  as each SQLite file had its own mutex). destroy() leaves the pool open: the
 *  store factory owns it. */
export function postgresKysely<DB>(pool: pg.Pool, opts: PostgresKyselyOptions = {}): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SerializingPostgresDialect(
      { pool: { connect: () => connectInSchema(pool), end: async () => undefined } }, writeLock(), opts.afterBeginWrite,
    ),
  });
}
