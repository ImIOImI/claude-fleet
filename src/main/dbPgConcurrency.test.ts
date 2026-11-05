import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import * as db from './db.js';
import { WS, S, FIXTURE } from './state/ingestFixture.js';
import { openTestState, pgMultiConnection, type TestState } from './store/testStore.js';

/** Holds the first query whose SQL matches `re` until release(); resolves `reached` when it gets there. */
function gateQuery(pool: pg.Pool, re: RegExp) {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  const hit = new Promise<void>((r) => { reached = r; });
  let armed = true;
  const connect = pool.connect.bind(pool);
  (pool as { connect: unknown }).connect = async () => {
    const client = await connect();
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as { query: unknown }).query = async (...a: unknown[]) => {
      if (armed && typeof a[0] === 'string' && re.test(a[0])) { armed = false; reached(); await open; }
      return query(...a);
    };
    return client;
  };
  return { reached: hit, release: () => { (pool as { connect: unknown }).connect = connect; release(); } };
}

describe.skipIf(!pgMultiConnection)('Postgres concurrency', () => {
  let st: TestState;
  beforeEach(async () => {
    st = await openTestState('cf-pg-conc-');
    for (const line of FIXTURE) await db.ingestLine(WS, S, line);
  });
  afterEach(() => st.close());

  it('an invalidation that commits during a summary recompute wins (D11)', async () => {
    const gate = gateQuery(st.pg!.pool, /from "session_stats"/);
    const stale = db.summaryForSession(S);
    await gate.reached;
    await db.deleteSession(S);
    gate.release();
    expect(await stale).not.toBeNull();
    expect(await db.summaryForSession(S)).toBeNull();
  });

  it('a summary recompute reads one snapshot while ingest commits mid-way (D12)', async () => {
    const before = await db.summaryForSession(S, 3);
    const gate = gateQuery(st.pg!.pool, /from "session_stats"/);
    const during = db.summaryForSession(S, 3);
    await gate.reached;
    await db.ingestLine(WS, S, JSON.stringify({ type: 'assistant', uuid: 'conc-1', timestamp: '2026-07-01T12:00:00.000Z',
      message: { model: 'claude-opus-4-1', usage: { input_tokens: 7, output_tokens: 7 }, content: [{ type: 'tool_use', id: 'tu-c', name: 'Bash', input: {} }] } }));
    gate.release();
    expect(await during).toEqual(before);
  });
});
