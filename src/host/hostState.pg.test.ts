import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { resolveHostWorkspaceId, WORKSPACE_ID_FILE } from './hostState.js';
import { createLogger } from './log.js';

const A = '01JC0000000000000000000000';
const B = '01JC0000000000000000000001';
const C = '01JC0000000000000000000002';

describe.skipIf(!isPg)('resolveHostWorkspaceId', () => {
  let t: TestPg | null = null;
  afterEach(async () => {
    await t?.drop();
    t = null;
  });

  async function rig() {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    const dir = mkdtempSync(join(tmpdir(), 'hs-'));
    const logs: string[] = [];
    return { k, dir, logs, log: createLogger((l) => logs.push(l)) };
  }
  const fileId = (dir: string) => JSON.parse(readFileSync(join(dir, WORKSPACE_ID_FILE), 'utf8')).id;
  const putFile = (dir: string, id: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKSPACE_ID_FILE), JSON.stringify({ id, createdAt: 1 }) + '\n');
  };
  const metaRows = async () => (await t!.pool.query(`SELECT workspace_id FROM ${t!.schema}.host_meta`)).rows;

  it('seeds from config, and writes the file', async () => {
    const { k, dir, log } = await rig();
    expect(await resolveHostWorkspaceId(k, dir, A, log, () => C)).toBe(A);
    expect(fileId(dir)).toBe(A);
  });

  it('adopts the c1 file’s id when config has none', async () => {
    const { k, dir, log } = await rig();
    putFile(dir, B);
    expect(await resolveHostWorkspaceId(k, dir, null, log, () => C)).toBe(B);
  });

  it('mints when there is neither, and the row then wins over a later config-less start', async () => {
    const { k, dir, log } = await rig();
    expect(await resolveHostWorkspaceId(k, dir, null, log, () => C)).toBe(C);
    expect(await resolveHostWorkspaceId(k, dir, null, log, () => A)).toBe(C);
  });

  it('refuses a configured id that differs from the row, naming both', async () => {
    const { k, dir, log } = await rig();
    await resolveHostWorkspaceId(k, dir, A, log);
    await expect(resolveHostWorkspaceId(k, dir, B, log)).rejects.toThrow(new RegExp(`${A}.*${B}`));
  });

  it('on an empty DB, refuses a configured id that differs from the c1 file, and seeds nothing', async () => {
    const { k, dir, log } = await rig();
    putFile(dir, B);
    await expect(resolveHostWorkspaceId(k, dir, A, log)).rejects.toThrow(new RegExp(`${B}.*${A}`));
    expect(await metaRows()).toEqual([]);
    expect(fileId(dir)).toBe(B);
  });

  it('on an empty DB, an unreadable c1 file refuses start rather than minting', async () => {
    const { k, dir, log } = await rig();
    writeFileSync(join(dir, WORKSPACE_ID_FILE), 'not json');
    await expect(resolveHostWorkspaceId(k, dir, null, log, () => C)).rejects.toThrow(/no valid workspace id/);
    expect(await metaRows()).toEqual([]);
  });

  it('rewrites a file that disagrees with the row, with a warning', async () => {
    const { k, dir, log, logs } = await rig();
    await resolveHostWorkspaceId(k, dir, A, log);
    putFile(dir, B);
    expect(await resolveHostWorkspaceId(k, dir, null, log)).toBe(A);
    expect(fileId(dir)).toBe(A);
    expect(logs.join('\n')).toMatch(/workspace-id.json differs from host_meta/);
  });

  it('rewrites a missing or unreadable file from the row', async () => {
    const { k, dir, log } = await rig();
    await resolveHostWorkspaceId(k, dir, A, log);
    writeFileSync(join(dir, WORKSPACE_ID_FILE), 'not json');
    expect(await resolveHostWorkspaceId(k, dir, A, log)).toBe(A);
    expect(fileId(dir)).toBe(A);
    const other = join(dir, 'fresh');
    expect(await resolveHostWorkspaceId(k, other, null, log)).toBe(A);
    expect(fileId(other)).toBe(A);
  });

  it('two pods seeding at once agree on one id', async () => {
    const { k, dir, log } = await rig();
    const k2: Kysely<HostDb> = postgresKysely<HostDb>(t!.pool);
    const [x, y] = await Promise.all([
      resolveHostWorkspaceId(k, join(dir, 'p1'), null, log, () => A),
      resolveHostWorkspaceId(k2, join(dir, 'p2'), null, log, () => B)
    ]);
    expect(x).toBe(y);
    expect(fileId(join(dir, 'p1'))).toBe(x);
    expect(fileId(join(dir, 'p2'))).toBe(x);
  });
});
