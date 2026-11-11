import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, stateKysely } from './db.js';
import { isPg } from './store/testStore.js';

const dirs: string[] = [];
afterEach(async () => {
  await closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(isPg)('openDb failure', () => {
  it('leaves no half-open handle, so a retry opens and migrates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-openfail-'));
    dirs.push(dir);
    const path = join(dir, 'state.db');
    writeFileSync(path, 'not a sqlite database, long enough to fill the header'.repeat(4));
    expect(() => openDb(dir)).toThrow();
    expect(() => stateKysely()).toThrow();

    rmSync(path);
    const conn = openDb(dir);
    expect(conn.open).toBe(true);
    expect(conn.pragma('user_version', { simple: true })).toBeGreaterThan(0);
    await stateKysely().selectFrom('sessions').select('id').limit(1).execute();
  });
});
