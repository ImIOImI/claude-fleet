import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cf-atomic-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const noSleep = async () => undefined;
const busy = (code: string) => Object.assign(new Error(code), { code });

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp file behind', async () => {
    const p = join(dir, 'workspace.json');
    await writeFile(p, 'old', 'utf8');
    await writeFileAtomic(p, 'new');
    expect(await readFile(p, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['workspace.json']);
  });

  it('survives overlapping writers (unique temp names); one of them wins', async () => {
    const p = join(dir, 'workspace.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(p, `v${i}`)));
    expect(await readFile(p, 'utf8')).toMatch(/^v\d+$/);
    expect(await readdir(dir)).toEqual(['workspace.json']);
  });

  it('retries a rename that fails while the target is held open (Windows EPERM/EBUSY)', async () => {
    const p = join(dir, 'workspace.json');
    let fails = 2;
    const sleeps: number[] = [];
    await writeFileAtomic(p, 'new', {
      rename: async (a, b) => { if (fails-- > 0) throw busy(fails ? 'EPERM' : 'EBUSY'); await rename(a, b); },
      sleep: async (ms) => { sleeps.push(ms); }
    });
    expect(await readFile(p, 'utf8')).toBe('new');
    expect(sleeps).toEqual([20, 40]);
  });

  it('gives up after repeated failures, keeps the old file, and removes its temp file', async () => {
    const p = join(dir, 'workspace.json');
    await writeFile(p, 'old', 'utf8');
    await expect(writeFileAtomic(p, 'new', { rename: async () => { throw busy('EPERM'); }, sleep: noSleep })).rejects.toThrow('EPERM');
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['workspace.json']);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(writeFileAtomic(join(dir, 'x.json'), 'new', { rename: async () => { calls++; throw busy('ENOSPC'); }, sleep: noSleep })).rejects.toThrow('ENOSPC');
    expect(calls).toBe(1);
  });
});
