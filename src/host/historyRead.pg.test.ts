import { afterEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { stateKysely } from '../main/db.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { STATE_PG_TRACK } from '../main/store/migrations/statePg.js';
import type { StateDb } from '../main/store/stateSchema.js';
import { isPg, openTestState, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { compareBytes } from '../preload/federation.js';
import { HistoryArgError, historyReader, parseSessionId, parseSessionsReq, sessionsPage, type SessionsPageReq } from './historyRead.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';

describe('parseSessionsReq / parseSessionId', () => {
  it('refuses malformed requests', () => {
    expect(() => parseSessionsReq({ limit: 0 })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ limit: 201 })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ limit: 2.5 })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq([])).toThrow(HistoryArgError);
    expect(() => parseSessionsReq(null)).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: { lastActiveAt: 1.5, id: 'x' } })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: { lastActiveAt: -1, id: 'x' } })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: { lastActiveAt: 1, id: "x' OR 1=1" } })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: { lastActiveAt: 1, id: 'x'.repeat(129) } })).toThrow(HistoryArgError);
    expect(() => parseSessionsReq({ after: 'x' })).toThrow(HistoryArgError);
    expect(parseSessionsReq({})).toEqual({ after: null, limit: 200 });
    expect(parseSessionsReq({ after: { lastActiveAt: 0, id: 'a', workspaceId: OTHER }, limit: 3, workspaceId: OTHER }))
      .toEqual({ after: { lastActiveAt: 0, id: 'a' }, limit: 3 });
    expect(parseSessionId(undefined)).toBeNull();
    expect(parseSessionId('s-1')).toBe('s-1');
    expect(() => parseSessionId('a b')).toThrow(HistoryArgError);
    expect(() => parseSessionId(5)).toThrow(HistoryArgError);
  });
});

function sessionRows() {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ id: `s-${String(i).padStart(2, '0')}`, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: i % 4 === 0 ? null : 1000 - (i % 3), ai_title: null, first_user_message: `m${i}`, user_set_name: null });
  for (let i = 0; i < 10; i++) rows.push({ id: `o-${i}`, workspace_id: OTHER, cwd: null, started_at: 1, last_active_at: 5000, ai_title: null, first_user_message: 'secret', user_set_name: null });
  return rows;
}

describe.skipIf(!isPg)('sessionsPage', () => {
  let t: TestPg | null = null;
  afterEach(async () => { await t?.drop(); t = null; });

  async function rig(): Promise<Kysely<StateDb>> {
    t = await testPgSchema();
    const k = postgresKysely<StateDb>(t.pool);
    await migratePostgres(k, t.schema, STATE_PG_TRACK);
    await k.insertInto('sessions').values(sessionRows()).execute();
    await k.insertInto('session_costs').values({ session_id: 's-01', workspace_id: HOSTED, model: 'claude-opus-4-1', service_tier: '', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, event_count: 3 }).execute();
    await k.insertInto('session_costs').values({ session_id: 'o-0', workspace_id: OTHER, model: 'claude-opus-4-1', service_tier: '', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, event_count: 9 }).execute();
    // Rows another workspace filed under hosted session ids must not leak into the page.
    await k.insertInto('session_costs').values({ session_id: 's-01', workspace_id: OTHER, model: 'claude-opus-4-1', service_tier: '', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, event_count: 100 }).execute();
    await k.insertInto('broker_sessions').values({ workspace_id: HOSTED, broker_session_id: 'auto-r1-s1', claude_session_id: 's-02', learned_at: 1, verified: 1, pending_claude_session_id: null }).execute();
    await k.insertInto('session_summaries').values([
      { session_id: 's-03', workspace_id: HOSTED, summary: 'x', tags: '["old"]', source_max_event_id: 1, from_ts: null, to_ts: null, model: null, generated_at: 1 },
      { session_id: 's-03', workspace_id: HOSTED, summary: 'y', tags: '["new",5]', source_max_event_id: 2, from_ts: null, to_ts: null, model: null, generated_at: 2 },
      { session_id: 's-03', workspace_id: OTHER, summary: 'z', tags: '["leak"]', source_max_event_id: 3, from_ts: null, to_ts: null, model: null, generated_at: 3 },
    ]).execute();
    return k;
  }

  it('pages tie-safe, newest first, and never leaves the hosted workspace', async () => {
    const k = await rig();
    const seen: string[] = [];
    let after: SessionsPageReq['after'] = null;
    for (let i = 0; i < 20; i++) {
      const p = await sessionsPage(k, HOSTED, { after, limit: 4 });
      seen.push(...p.rows.map((r) => r.id));
      expect(p.rows.every((r) => r.workspaceId === HOSTED)).toBe(true);
      if (!p.next) break;
      after = p.next;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    const one = await sessionsPage(k, HOSTED, { after: null, limit: 200 });
    expect(seen).toEqual(one.rows.map((r) => r.id));
    expect(one.next).toBeNull();
    expect(one.rows.find((r) => r.id === 's-01')?.eventCount).toBe(3);
    expect(one.rows.find((r) => r.id === 's-01')!.usd).toBeGreaterThan(0);
    expect(one.rows.find((r) => r.id === 's-02')?.headless).toBe(true);
    expect(one.rows.find((r) => r.id === 's-01')?.headless).toBe(false);
    expect(one.rows.find((r) => r.id === 's-03')?.tags).toEqual(['new']);
    // NULL last_active_at sorts as 0, after every dated row.
    expect(one.rows.slice(-7).every((r) => r.lastActiveAt === null)).toBe(true);
    const exact = await sessionsPage(k, HOSTED, { after: null, limit: 25 });
    expect(exact.rows).toHaveLength(25);
    expect(exact.next).toBeNull();
    const forged = await sessionsPage(k, HOSTED, parseSessionsReq({ after: { lastActiveAt: 9999, id: 'o-0' }, limit: 200 }));
    expect(forged.rows).toHaveLength(25);
    expect(forged.rows.every((r) => r.workspaceId === HOSTED)).toBe(true);
    expect(await sessionsPage(k, OTHER, { after: null, limit: 200 }).then((p) => p.rows.map((r) => r.workspaceId)))
      .toEqual(Array(10).fill(OTHER));
    await k.destroy();
  });

  it('orders and pages ids in byte order under a non-C column collation', async () => {
    t = await testPgSchema();
    const k = postgresKysely<StateDb>(t.pool);
    await migratePostgres(k, t.schema, STATE_PG_TRACK);
    await sql`ALTER TABLE sessions ALTER COLUMN id TYPE text COLLATE "und-x-icu"`.execute(k);
    const ids = ['b1', 'A1', 'a1', 'B1', '_x', 'a-2', 'Z9', 'a.1'];
    await k.insertInto('sessions').values(ids.map((id) => ({ id, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 7, ai_title: null, first_user_message: null, user_set_name: null }))).execute();
    const seen: string[] = [];
    let after: SessionsPageReq['after'] = null;
    for (let i = 0; i < 10; i++) {
      const p = await sessionsPage(k, HOSTED, { after, limit: 3 });
      seen.push(...p.rows.map((r) => r.id));
      if (!p.next) break;
      after = p.next;
    }
    expect(seen).toEqual([...ids].sort(compareBytes));
    await k.destroy();
  });

  it('clips long text and caps tags to the desktop D59 limits before a row leaves the DB', async () => {
    const k = await rig();
    await k.insertInto('sessions').values({
      id: 'big-1', workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 9999,
      ai_title: 'T'.repeat(1000), first_user_message: 'x'.repeat(1_000_000), user_set_name: 'N'.repeat(1000),
    }).execute();
    const tags = Array.from({ length: 30 }, (_, i) => `tag-${i}-`.padEnd(100, 'z'));
    await k.insertInto('session_summaries').values({
      session_id: 'big-1', workspace_id: HOSTED, summary: 's', tags: JSON.stringify(tags),
      source_max_event_id: 1, from_ts: null, to_ts: null, model: null, generated_at: 1,
    }).execute();
    const page = await sessionsPage(k, HOSTED, { after: null, limit: 1 });
    const row = page.rows.find((r) => r.id === 'big-1');
    expect(row?.aiTitle).toHaveLength(500);
    expect(row?.firstUserMessage).toHaveLength(500);
    expect(row?.userSetName).toHaveLength(500);
    expect(row?.tags).toHaveLength(20);
    expect(row?.tags.every((t) => t.length <= 64)).toBe(true);
    await k.destroy();
  });

  it('skips a row whose id fails the id charset; paging still advances past it', async () => {
    const k = await rig();
    await k.insertInto('sessions').values({
      id: 'bad id!', workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 1500,
      ai_title: null, first_user_message: null, user_set_name: null,
    }).execute();
    const seen: string[] = [];
    let after: SessionsPageReq['after'] = null;
    for (let i = 0; i < 20; i++) {
      const p = await sessionsPage(k, HOSTED, { after, limit: 4 });
      seen.push(...p.rows.map((r) => r.id));
      if (!p.next) break;
      after = p.next;
    }
    expect(seen).not.toContain('bad id!');
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    await k.destroy();
  });
});

describe.skipIf(!isPg)('historyReader.summary', () => {
  it('reads the hosted workspace and answers null for a session outside it', async () => {
    await openTestState();
    await stateKysely().insertInto('sessions').values(sessionRows()).execute();
    const r = historyReader(stateKysely, HOSTED);
    expect(r.workspaceId).toBe(HOSTED);
    expect((await r.summary(null))?.sessionId).toBe('s-03');
    expect((await r.summary('s-05'))?.sessionId).toBe('s-05');
    expect(await r.summary('o-0')).toBeNull();
    expect(await r.summary('missing')).toBeNull();
    expect((await historyReader(stateKysely, OTHER).summary(null))?.sessionId).toBe('o-0');
  });
});
