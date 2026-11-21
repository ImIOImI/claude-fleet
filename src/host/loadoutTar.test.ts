import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractLoadout, TAR_LIMITS } from './loadoutTar.js';
import { buildTar, buildTarGz, type TarSpec } from './testTar.js';

const ROOT = 'SumerSports-claude-fleet-loadouts-abc1234';
const MD = '---\ntitle: demo\ndescription: d\nversion: 1.0.0\n---\n';
const md: TarSpec = { path: 'loadouts/demo/loadout.md', body: MD };
const repo = (entries: TarSpec[]): Buffer =>
  buildTarGz([{ path: `${ROOT}/`, type: '5' }, ...entries.map((e) => ({ ...e, path: `${ROOT}/${e.path}` }))]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ltar-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractLoadout', () => {
  it('extracts only loadouts/<id>/ and keeps exec bits', async () => {
    const files = await extractLoadout(
      repo([
        { path: 'README.md', body: 'repo readme' },
        { path: 'loadouts/', type: '5' },
        { path: 'loadouts/demo/', type: '5' },
        md,
        { path: 'loadouts/demo/skills/demo/run.sh', body: '#!/bin/sh\n', mode: 0o755 },
        { path: 'loadouts/demo-two/loadout.md', body: MD },
        { path: 'loadouts/other/loadout.md', body: MD }
      ]),
      'demo',
      dir
    );
    expect(files).toEqual(['loadout.md', 'skills/demo/run.sh']);
    expect((await stat(join(dir, 'skills/demo/run.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, 'loadout.md'))).mode & 0o777).toBe(0o644);
    expect((await readdir(dir)).sort()).toEqual(['loadout.md', 'skills']);
  });

  it('reads pax long paths', async () => {
    const inner = `skills/${'a'.repeat(60)}/${'b'.repeat(60)}/SKILL.md`;
    expect(await extractLoadout(repo([md, { path: `loadouts/demo/${inner}`, body: 'deep' }]), 'demo', dir)).toContain(inner);
    expect(await readFile(join(dir, inner), 'utf8')).toBe('deep');
  });

  it.each([
    ['symlink', { path: 'loadouts/demo/skills/x', type: '2', linkname: '/etc/passwd' }],
    ['hardlink', { path: 'loadouts/demo/skills/x', type: '1', linkname: `${ROOT}/README.md` }],
    ['entry type "6"', { path: 'loadouts/demo/fifo', type: '6' }]
  ] as [string, TarSpec][])('refuses a %s inside the loadout and writes nothing', async (kind, entry) => {
    await expect(extractLoadout(repo([md, entry]), 'demo', dir)).rejects.toThrow(`${kind} at ${entry.path} is not allowed`);
    expect(await readdir(dir)).toEqual([]);
  });

  it('ignores links outside the loadout', async () => {
    expect(await extractLoadout(repo([md, { path: 'docs/link', type: '2', linkname: '../README.md' }]), 'demo', dir)).toEqual(['loadout.md']);
  });

  it('refuses a path that escapes the loadout', async () => {
    await expect(extractLoadout(repo([md, { path: 'loadouts/demo/../../evil', body: 'x' }]), 'demo', dir)).rejects.toThrow(
      'unsafe path loadouts/demo/../../evil'
    );
  });

  it('refuses a second top-level directory', async () => {
    const tgz = buildTarGz([{ path: `${ROOT}/`, type: '5' }, { path: `${ROOT}/loadouts/demo/loadout.md`, body: MD }, { path: 'elsewhere/x', body: 'x' }]);
    await expect(extractLoadout(tgz, 'demo', dir)).rejects.toThrow('archive has more than one top-level directory');
  });

  it('refuses a duplicate entry and a missing loadout.md', async () => {
    await expect(extractLoadout(repo([md, md]), 'demo', dir)).rejects.toThrow('duplicate entry loadouts/demo/loadout.md');
    await expect(extractLoadout(repo([{ path: 'loadouts/demo/CLAUDE.md', body: 'x' }]), 'demo', dir)).rejects.toThrow(
      'loadouts/demo/loadout.md is not in the archive'
    );
  });

  it('refuses a duplicate spelled differently and writes nothing', async () => {
    await expect(extractLoadout(repo([md, { path: 'loadouts/demo/./loadout.md', body: MD }]), 'demo', dir)).rejects.toThrow(
      'duplicate entry loadouts/demo/./loadout.md'
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a file that is also a directory and writes nothing', async () => {
    const entries = [md, { path: 'loadouts/demo/skills/x', body: 'f' }, { path: 'loadouts/demo/skills/x/y', body: 'g' }];
    await expect(extractLoadout(repo(entries), 'demo', dir)).rejects.toThrow('skills/x is both a file and a directory');
    await expect(extractLoadout(repo([md, entries[2], entries[1]]), 'demo', dir)).rejects.toThrow('skills/x is both a file and a directory');
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a NUL in a path', async () => {
    await expect(extractLoadout(repo([md, { path: `loadouts/demo/${'a'.repeat(101)}\0b`, body: 'x' }]), 'demo', dir)).rejects.toThrow(
      /^unsafe path /
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('applies a pax path to the next entry only', async () => {
    const inner = `skills/${'a'.repeat(60)}/${'b'.repeat(60)}/SKILL.md`;
    expect(await extractLoadout(repo([{ path: `loadouts/demo/${inner}`, body: 'deep' }, md]), 'demo', dir)).toEqual(['loadout.md', inner]);
  });

  it('writes 0644 or 0755 only, whatever the header mode', async () => {
    await extractLoadout(
      repo([md, { path: 'loadouts/demo/s.sh', body: 'x', mode: 0o700 }, { path: 'loadouts/demo/w.md', body: 'x', mode: 0o600 }]),
      'demo',
      dir
    );
    expect((await stat(join(dir, 's.sh'))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(dir, 'w.md'))).mode & 0o7777).toBe(0o644);
  });

  it('never writes through an existing path', async () => {
    const outside = join(dir, '..', `${dir.split('/').pop()}-outside`);
    await writeFile(outside, 'keep');
    await symlink(outside, join(dir, 'loadout.md'));
    try {
      await expect(extractLoadout(repo([md]), 'demo', dir)).rejects.toThrow(/EEXIST/);
      expect(await readFile(outside, 'utf8')).toBe('keep');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('refuses GNU long names and base-256 numbers', async () => {
    await expect(extractLoadout(repo([md, { path: 'loadouts/demo/././@LongLink', type: 'L' }]), 'demo', dir)).rejects.toThrow(
      'GNU long names are not supported'
    );
    const tar = buildTar([{ path: `${ROOT}/`, type: '5' }, { path: `${ROOT}/loadouts/demo/loadout.md`, body: MD }]);
    const h = tar.subarray(1024, 1536);
    h[124] = 0x80;
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    await expect(extractLoadout(gzipSync(tar), 'demo', dir)).rejects.toThrow('size: base-256 numbers are not supported');
  });

  it('enforces every cap', async () => {
    expect(await extractLoadout(repo([md]), 'demo', dir, { ...TAR_LIMITS, file: Buffer.byteLength(MD) })).toEqual(['loadout.md']);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    await expect(extractLoadout(repo([md]), 'demo', dir, { ...TAR_LIMITS, file: Buffer.byteLength(MD) - 1 })).rejects.toThrow(/is over/);
    const two = [md, { path: 'loadouts/demo/a.md', body: 'x'.repeat(20) }, { path: 'loadouts/demo/b.md', body: 'y' }];
    await expect(extractLoadout(repo([md]), 'demo', dir, { ...TAR_LIMITS, file: 10 })).rejects.toThrow('loadouts/demo/loadout.md is over 10 bytes');
    await expect(extractLoadout(repo(two), 'demo', dir, { ...TAR_LIMITS, files: 2 })).rejects.toThrow('loadouts/demo has more than 2 files');
    await expect(extractLoadout(repo(two), 'demo', dir, { ...TAR_LIMITS, total: 60 })).rejects.toThrow('loadouts/demo is over 60 bytes');
    await expect(extractLoadout(repo(two), 'demo', dir, { ...TAR_LIMITS, tar: 2048 })).rejects.toThrow('archive is over 2048 bytes');
    await expect(extractLoadout(repo([md]), 'demo', dir, { ...TAR_LIMITS, tarball: 10 })).rejects.toThrow('tarball is over 10 bytes');
    expect(TAR_LIMITS.file).toBe(5_242_880);
  });

  it('refuses a corrupt header and a non-gzip body', async () => {
    const tar = buildTar([{ path: `${ROOT}/`, type: '5' }, { path: `${ROOT}/loadouts/demo/loadout.md`, body: MD }]);
    tar[1024] ^= 1;
    await expect(extractLoadout(gzipSync(tar), 'demo', dir)).rejects.toThrow('bad header checksum');
    await expect(extractLoadout(Buffer.from('not gzip'), 'demo', dir)).rejects.toThrow('not a gzip archive');
  });
});
