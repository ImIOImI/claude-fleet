import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, stateKysely } from './db.js';

let dir = '';
afterEach(async () => {
  await closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('state.db Kysely handle', () => {
  it('throws before openDb', async () => {
    expect(() => stateKysely()).toThrow(/db not opened/);
  });

  it('shares the raw connection: a Kysely write is visible to raw reads', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-dbstore-'));
    const raw = openDb(dir);
    await stateKysely().insertInto('usage_events').values({ ts: 1, workspace_id: 'w', session_id: null, kind: 'resumed', detail: null }).execute();
    expect(raw.prepare('SELECT kind FROM usage_events').all()).toEqual([{ kind: 'resumed' }]);
  });

  it('closeDb waits for an in-flight transaction, then closes the connection', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-dbstore-'));
    const raw = openDb(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tx = stateKysely().transaction().execute(async (trx) => {
      await trx.insertInto('usage_events').values({ ts: 2, workspace_id: 'w', session_id: null, kind: 'resumed', detail: null }).execute();
      await gate;
    });
    await new Promise((r) => setTimeout(r, 10));
    const closing = closeDb();
    expect(() => stateKysely()).toThrow(/db not opened/); // new work is refused at once
    await new Promise((r) => setTimeout(r, 10));
    expect(raw.open).toBe(true); // still open: the transaction holds the mutex
    release();
    await tx;
    await closing;
    expect(raw.open).toBe(false);
    const reopened = openDb(dir);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 1 });
  });
});
