import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

const installed: string[] = [];
vi.mock('./loadouts.js', () => ({
  installLoadout: vi.fn(async (_ws: string, id: string) => { installed.push(id); return { installed: { id } }; }),
  listLoadouts: vi.fn(async () => [])
}));
const downloads: Array<{ source: string; id: string; version?: string }> = [];
vi.mock('./loadoutSources.js', () => ({
  download: vi.fn(async (source: string, id: string, version?: string) => { downloads.push({ source, id, version }); }),
  provenanceFor: vi.fn(async () => null),
  allRemote: vi.fn(async () => [])
}));

const { ensureAndInstall } = await import('./loadoutInstall.js');
const { loadoutDir } = await import('./paths.js');

beforeEach(async () => { userDataDir = await mkdtemp(join(tmpdir(), 'linst-')); installed.length = 0; downloads.length = 0; });
afterEach(async () => { await rm(userDataDir, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('ensureAndInstall', () => {
  it('downloads a not-present loadout from its source, then installs', async () => {
    const r = await ensureAndInstall('ws1', 'spec-driven', { source: 'ghcr.io/o/r', version: '1.0.0' });
    expect(r).toEqual({ status: 'installed' });
    expect(downloads).toEqual([{ source: 'ghcr.io/o/r', id: 'spec-driven', version: '1.0.0' }]);
    expect(installed).toEqual(['spec-driven']);
  });

  it('installs directly when the loadout is already present locally with provenance (no re-download)', async () => {
    await mkdir(loadoutDir('seen'), { recursive: true });
    await writeFile(join(loadoutDir('seen'), 'loadout.md'), '---\ntitle: x\n---\n');
    const src = await import('./loadoutSources.js');
    (src.provenanceFor as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ source: 'ghcr.io/o/r', version: '1.0.0' });
    const r = await ensureAndInstall('ws1', 'seen', { source: 'ghcr.io/o/r', version: '1.0.0' });
    expect(r).toEqual({ status: 'installed' });
    expect(downloads).toEqual([]); // present + same version ⇒ no pull
    expect(installed).toEqual(['seen']);
  });

  it('asks for confirmation before overwriting a locally-authored loadout (present, no provenance)', async () => {
    await mkdir(loadoutDir('mine'), { recursive: true });
    await writeFile(join(loadoutDir('mine'), 'loadout.md'), '---\ntitle: mine\n---\n');
    const r = await ensureAndInstall('ws1', 'mine', { source: 'ghcr.io/o/r', version: '1.0.0' });
    expect(r.status).toBe('needs-confirm');
    expect(downloads).toEqual([]); // not overwritten without force
    const forced = await ensureAndInstall('ws1', 'mine', { source: 'ghcr.io/o/r', version: '1.0.0', force: true });
    expect(forced).toEqual({ status: 'installed' });
    expect(downloads).toEqual([{ source: 'ghcr.io/o/r', id: 'mine', version: '1.0.0' }]);
  });
});
