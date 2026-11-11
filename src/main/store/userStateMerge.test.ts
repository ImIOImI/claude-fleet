import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { FIXTURE, S, WS } from '../state/ingestFixture.js';
import { firstSwitchCopy, switchBackToSqlite } from './firstSwitch.js';
import { migratePgStores } from './pgStores.js';
import { IMPORT_PG_TRACK } from './storeImport.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';
import { USER_STATE_MERGE } from './userStateMerge.js';

it('merges exactly the user-authored state tables', () => {
  expect(USER_STATE_MERGE.map((m) => m.table).sort()).toEqual(
    ['broker_sessions', 'port_exposures', 'publish_withheld', 'session_tags', 'sessions', 'usage_anchors', 'usage_events'],
  );
});

describe.skipIf(!isPg)('user-authored state follows every switch', () => {
  let dir: string;
  let t: TestPg;
  const stateFile = (): string => join(dir, 'state.db');
  const noop = (): void => undefined;

  const pg = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    (await t.pool.query(text.replaceAll('$S.', `${t.schema}.`), params)).rows as R[];
  const lite = <R = Record<string, unknown>>(text: string, params: unknown[] = []): R[] => {
    const d = new Database(stateFile());
    try {
      const st = d.prepare(text);
      if (st.reader) return st.all(...params) as R[];
      st.run(...params);
      return [];
    } finally {
      d.close();
    }
  };

  /** One of each user-authored change, on either store. */
  async function author(on: 'pg' | 'sqlite', tag: string): Promise<void> {
    const stmts: Array<[string, unknown[]]> = [
      [`UPDATE $S.sessions SET user_set_name = ${on === 'pg' ? '$1' : '?'} WHERE id = ${on === 'pg' ? '$2' : '?'}`, [`${tag} name`, S]],
      [`INSERT INTO $S.session_tags (workspace_id, session_id, tag) VALUES (${on === 'pg' ? '$1, $2, $3' : '?, ?, ?'})`, [WS, S, `${tag}-tag`]],
      [`INSERT INTO $S.broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at) VALUES (${on === 'pg' ? '$1, $2, $3, 1' : '?, ?, ?, 1'})`, [WS, `tab-${tag}`, S]],
      [`INSERT INTO $S.usage_events (ts, workspace_id, session_id, kind) VALUES (${on === 'pg' ? '5, $1, $2, $3' : '5, ?, ?, ?'})`, [WS, S, `${tag}-kind`]],
      [`INSERT INTO $S.usage_anchors (ts, kind, dedup_key) VALUES (${on === 'pg' ? '1, $1, $2' : '1, ?, ?'})`, ['limit-hit', `${tag}-anchor`]],
      [`INSERT INTO $S.port_exposures (id, workspace_id, port, source) VALUES (${on === 'pg' ? '$1, $2, 3000, $3' : '?, ?, 3000, ?'})`, [`pe-${tag}`, WS, 'scan']],
      [`INSERT INTO $S.publish_withheld (session_id, workspace_id, withheld_at) VALUES (${on === 'pg' ? '$1, $2, 1' : '?, ?, 1'})`, [`wh-${tag}`, WS]],
    ];
    for (const [text, params] of stmts) {
      if (on === 'pg') await pg(text, params);
      else lite(text.replaceAll('$S.', ''), params);
    }
  }

  const snapshot = async (on: 'pg' | 'sqlite') => {
    const q = async (text: string) => (on === 'pg' ? pg(text) : lite(text.replaceAll('$S.', '')));
    return {
      name: (await q(`SELECT user_set_name AS n FROM $S.sessions WHERE id = '${S}'`))[0]?.n,
      tags: (await q(`SELECT tag FROM $S.session_tags WHERE tag LIKE '%-tag' ORDER BY tag`)).map((r) => r.tag),
      tabs: (await q(`SELECT broker_session_id AS b FROM $S.broker_sessions ORDER BY 1`)).map((r) => r.b),
      usage: (await q(`SELECT kind FROM $S.usage_events ORDER BY kind`)).map((r) => r.kind),
      anchors: (await q(`SELECT dedup_key AS d FROM $S.usage_anchors ORDER BY 1`)).map((r) => r.d),
      ports: (await q(`SELECT id FROM $S.port_exposures ORDER BY 1`)).map((r) => r.id),
      withheld: (await q(`SELECT session_id AS s FROM $S.publish_withheld ORDER BY 1`)).map((r) => r.s),
    };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-merge-'));
    db.openDb(dir);
    await db.ingestBatch(WS, S, FIXTURE);
    await db.closeDb();
    const inbox = InboxStore.open(dir);
    await inbox.close();
    t = await testPgSchema();
    await migratePgStores(t.pool, { state: true, extraTracks: [IMPORT_PG_TRACK] });
    await author('sqlite', 'before');
    await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: noop });
  });
  afterEach(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('changes made on Postgres reach state.db on the switch back', async () => {
    await author('pg', 'pg');
    const want = await snapshot('pg');
    expect(want.tags).toEqual(['before-tag', 'pg-tag']);
    await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: noop, commit: async () => undefined });
    expect(await snapshot('sqlite')).toEqual(want);
  });

  it('changes made on SQLite after a switch back reach Postgres on the next switch; the outgoing store wins', async () => {
    await author('pg', 'pg');
    await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: noop, commit: async () => undefined });
    await author('sqlite', 'lite');
    const want = await snapshot('sqlite');
    expect(want.name).toBe('lite name');
    expect(want.tags).toEqual(['before-tag', 'lite-tag', 'pg-tag']);
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: noop })).toBeNull();
    expect(await snapshot('pg')).toEqual(want);
    expect(want.usage).toEqual(['before-kind', 'lite-kind', 'pg-kind']);
    expect(want.withheld).toEqual(['wh-before', 'wh-lite', 'wh-pg']);
  });

  it('a Postgres start with no switch in between does not replay state.db over newer Postgres rows', async () => {
    await pg(`UPDATE $S.sessions SET user_set_name = 'renamed on postgres' WHERE id = $1`, [S]);
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: noop })).toBeNull();
    expect((await snapshot('pg')).name).toBe('renamed on postgres');
  });

  it('a round trip with no changes duplicates nothing', async () => {
    const want = await snapshot('pg');
    for (let i = 0; i < 2; i++) {
      await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: noop, commit: async () => undefined });
      lite(`UPDATE sessions SET cwd = cwd WHERE id = ?`, [S]);
      await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: noop });
    }
    expect(await snapshot('pg')).toEqual(want);
    expect(await snapshot('sqlite')).toEqual(want);
  }, 60_000);

  it('a switch back that was not committed does not replay state.db over later Postgres rows', async () => {
    await expect(switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: noop, commit: async () => { throw new Error('config.json unwritable'); } }))
      .rejects.toThrow('config.json unwritable');
    await pg(`UPDATE $S.sessions SET user_set_name = 'after the failed switch' WHERE id = $1`, [S]);
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: noop })).toBeNull();
    expect((await snapshot('pg')).name).toBe('after the failed switch');
  });

  it('session tags are a union: a tag only one store has is never dropped', async () => {
    await author('pg', 'pg');
    await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: noop, commit: async () => undefined });
    lite(`DELETE FROM session_tags WHERE tag = 'pg-tag'`);
    lite(`INSERT INTO session_tags (workspace_id, session_id, tag) VALUES (?, ?, 'lite-tag')`, [WS, S]);
    await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: noop });
    expect((await snapshot('pg')).tags).toEqual(['before-tag', 'lite-tag', 'pg-tag']);
  });
});
