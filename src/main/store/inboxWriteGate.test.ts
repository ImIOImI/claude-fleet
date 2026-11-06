// The inbox write gate on a real Postgres inbox, and the live switch back to
// SQLite built on it: a write attempted during the switch is refused, a write
// already in flight lands in the copy, and nothing succeeds unseen.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { firstSwitchCopy, switchBackPlan, switchBackToSqlite } from './firstSwitch.js';
import { InboxWriteGate, InboxWriteRefused } from './inboxWriteGate.js';
import { migratePgStores } from './pgStores.js';
import { IMPORT_PG_TRACK } from './storeImport.js';
import { switchBackLive } from './storeSwitch.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const ME = { kind: 'user', id: 'me' } as const;

it('drain() refuses to run on an open gate', async () => {
  await expect(new InboxWriteGate().drain({} as never)).rejects.toThrow('closed gate');
});

it('the hook refuses with the reason while closed and lets writes through once open', async () => {
  const g = new InboxWriteGate();
  await expect(g.hook(async () => [])).resolves.toBeUndefined();
  g.close('moving');
  expect(g.closed).toBe(true);
  await expect(g.hook(async () => [])).rejects.toThrow(new InboxWriteRefused('moving'));
  g.open();
  await expect(g.hook(async () => [])).resolves.toBeUndefined();
});

describe.skipIf(!isPg)('InboxWriteGate on Postgres', () => {
  let dir: string;
  let t: TestPg;
  let gate: InboxWriteGate;
  let inbox: InboxStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-gate-'));
    t = await testPgSchema();
    await migratePgStores(t.pool, { state: false, extraTracks: [IMPORT_PG_TRACK] });
    // No inbox.db: the copy is `absent` and writes the marker, as a real first start does.
    await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined });
    gate = new InboxWriteGate();
    inbox = await InboxStore.openPostgres(t.pool, { afterBeginWrite: gate.hook, migrate: false });
  });
  afterEach(async () => {
    await inbox.close();
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A write transaction that stays open until release(). */
  function heldEdit(id: string, title: string) {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const done = inbox.kysely.transaction().execute(async (trx) => {
      await trx.updateTable('todos').set({ title }).where('id', '=', id).execute();
      entered();
      await held;
    });
    return { inside, release, done };
  }

  it('drain waits for a write in flight; writes after close are refused; open lets them through', async () => {
    const { todo } = await inbox.post(ME, { title: 'before' });
    const edit = heldEdit(todo.id, 'edited in flight');
    await edit.inside;
    gate.close('the inbox is moving');
    let drained = false;
    const drain = gate.drain(inbox.kysely).then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(drained).toBe(false);
    edit.release();
    await edit.done;
    await drain;
    expect((await inbox.list({})).map((x) => x.title)).toEqual(['edited in flight']);
    await expect(inbox.post(ME, { title: 'during' })).rejects.toBeInstanceOf(InboxWriteRefused);
    await expect(inbox.update(ME, todo.id, { title: 'during' })).rejects.toBeInstanceOf(InboxWriteRefused);
    expect((await inbox.list({})).map((x) => x.title)).toEqual(['edited in flight']);
    gate.open();
    await inbox.post(ME, { title: 'after' });
    expect((await inbox.list({ status: 'all' })).map((x) => x.title).sort()).toEqual(['after', 'edited in flight']);
  });

  it('a live switch back carries every write that succeeded and refuses the rest', async () => {
    const { todo } = await inbox.post(ME, { title: 'before' });
    const edit = heldEdit(todo.id, 'edited in flight');
    await edit.inside;
    const attempts: Array<Promise<unknown>> = [];
    const attempt = (title: string): void => {
      const p = inbox.post(ME, { title });
      p.catch(() => undefined);
      attempts.push(p);
    };
    const calls: string[] = [];
    const switching = switchBackLive<{ pool: pg.Pool }>({
      inboxOn: () => 'postgres',
      exclusive: (fn) => fn({ pool: t.pool }),
      plan: () => switchBackPlan(dir),
      postgresInboxLive: () => true,
      open: async () => { throw new Error('unused'); },
      close: async () => undefined,
      quiesce: async () => {
        gate.close('the inbox is moving to SQLite');
        attempt('while draining');
        await gate.drain(inbox.kysely);
        calls.push('quiesced');
      },
      copy: (s, commit) => switchBackToSqlite({
        pool: s.pool, userData: dir, commit,
        onProgress: () => attempt('during the copy'),
      }),
      commit: async () => { attempt('during the commit'); calls.push('commit'); },
      resume: async (on) => { calls.push(`resume ${on}`); },
      stopBringUp: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 30));
    edit.release();
    expect(await switching).toEqual({ switched: true, notice: null });
    expect(calls).toEqual(['quiesced', 'commit', 'resume sqlite']);

    const results = await Promise.allSettled(attempts);
    expect(results.length).toBeGreaterThanOrEqual(3);
    const local = InboxStore.open(dir);
    try {
      const titles = (await local.list({ status: 'all' })).map((x) => x.title);
      expect(titles).toContain('edited in flight');
      for (const r of results) {
        // Never dropped: a write either failed loudly or is in the new inbox.db.
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(InboxWriteRefused);
        else expect(titles).toContain((r.value as { todo: { title: string } }).todo.title);
      }
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
    } finally {
      await local.close();
    }
  });
});
