import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrMintWorkspaceId, resolveWorkspaceId, WORKSPACE_ID_FILE } from './hostState.js';

const A = '01JC0000000000000000000000';
const B = '01JC0000000000000000000001';

describe('loadOrMintWorkspaceId', () => {
  it('mints once and returns the same id afterwards', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'fh-state-')), 'nested');
    expect(await loadOrMintWorkspaceId(dir, () => A)).toBe(A);
    expect(await loadOrMintWorkspaceId(dir, () => B)).toBe(A);
    expect(readdirSync(dir)).toEqual([WORKSPACE_ID_FILE]);
  });

  it('concurrent mints agree on one id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    const ids = await Promise.all([loadOrMintWorkspaceId(dir, () => A), loadOrMintWorkspaceId(dir, () => B)]);
    expect(ids[0]).toBe(ids[1]);
  });

  it('refuses a corrupt id file rather than minting over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    writeFileSync(join(dir, WORKSPACE_ID_FILE), JSON.stringify({ id: 'not-a-ulid' }));
    await expect(loadOrMintWorkspaceId(dir, () => A)).rejects.toThrow(/no valid workspace id/);
  });
});

describe('resolveWorkspaceId', () => {
  const fileId = (dir: string): unknown => JSON.parse(readFileSync(join(dir, WORKSPACE_ID_FILE), 'utf8')).id;

  it('without a configured id, mints once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    expect(await resolveWorkspaceId(dir, null, () => A)).toBe(A);
    expect(await resolveWorkspaceId(dir, null, () => B)).toBe(A);
  });

  it('writes the configured id when the file is missing, never minting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    const mint = () => { throw new Error('minted'); };
    expect(await resolveWorkspaceId(dir, B, mint)).toBe(B);
    expect(fileId(dir)).toBe(B);
  });

  it('accepts a file that already holds the configured id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    await loadOrMintWorkspaceId(dir, () => B);
    expect(await resolveWorkspaceId(dir, B)).toBe(B);
  });

  it('refuses a file holding a different id, naming both ids and the path, and leaves it alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    await loadOrMintWorkspaceId(dir, () => A);
    const err = (await resolveWorkspaceId(dir, B).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(A);
    expect(err.message).toContain(B);
    expect(err.message).toContain(join(dir, WORKSPACE_ID_FILE));
    expect(fileId(dir)).toBe(A);
  });
});
