import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

// In-memory vault (the real one needs Electron safeStorage).
const vaultStore = new Map<string, string>();
vi.mock('./vault.js', () => ({
  getSecret: vi.fn(async (scope: string, key: string) => vaultStore.get(`${scope}|${key}`) ?? null),
  setSecret: vi.fn(async (scope: string, key: string, value: string) => { vaultStore.set(`${scope}|${key}`, value); }),
  deleteSecret: vi.fn(async (scope: string, key: string) => { vaultStore.delete(`${scope}|${key}`); })
}));

// Mock the network client; assert sources logic in isolation.
const pulled: Array<{ ref: string; dest: string; credential?: string; artifactType?: string }> = [];
vi.mock('./ociClient.js', () => ({
  fetchAnnotations: vi.fn(),
  pullArtifact: vi.fn(async (ref: string, dest: string, opts?: { credential?: string; artifactType?: string }) => {
    pulled.push({ ref, dest, credential: opts?.credential, artifactType: opts?.artifactType });
    // Simulate a pulled tree: write a loadout.md (or index.json for the index ref).
    await mkdir(dest, { recursive: true });
    if (ref.endsWith('/index:latest')) {
      await writeFile(join(dest, 'index.json'), JSON.stringify([
        { id: 'spec-driven', title: 'Spec-Driven', description: 'd', tags: ['workflow'], version: '1.0.0' }
      ]));
    } else {
      await writeFile(join(dest, 'loadout.md'), '---\ntitle: Spec-Driven\nversion: 1.0.0\n---\n');
    }
  })
}));

const sources = await import('./loadoutSources.js');
const SRC = 'ghcr.io/imioimi/claude-fleet-loadouts';

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'lsrc-'));
  pulled.length = 0;
  vaultStore.clear();
  vi.stubEnv('GH_TOKEN', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(userDataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('loadoutSources', () => {
  it('addSource validates by pulling+parsing the index, then persists to sources.json', async () => {
    const idx = await sources.addSource(SRC);
    expect(idx.map((l) => l.id)).toContain('spec-driven');
    expect(await sources.listSources()).toEqual([SRC]);
    const raw = JSON.parse(await readFile(join(userDataDir, 'loadouts', 'sources.json'), 'utf8'));
    expect(raw.sources).toEqual([SRC]);
  });

  it('a fresh install starts with the default source and saves it', async () => {
    expect(await sources.listSources()).toEqual(sources.DEFAULT_SOURCES);
    const raw = JSON.parse(await readFile(join(userDataDir, 'loadouts', 'sources.json'), 'utf8'));
    expect(raw.sources).toEqual(sources.DEFAULT_SOURCES);
  });

  it('a removed default source stays removed', async () => {
    for (const d of sources.DEFAULT_SOURCES) await sources.removeSource(d);
    expect(await sources.listSources()).toEqual([]);
    expect(await sources.listSources()).toEqual([]);
  });

  it('never seeds over an existing sources.json, even a corrupt one', async () => {
    await mkdir(join(userDataDir, 'loadouts'), { recursive: true });
    await writeFile(join(userDataDir, 'loadouts', 'sources.json'), JSON.stringify({ sources: ['ghcr.io/other/loadouts'], provenance: {} }));
    expect(await sources.listSources()).toEqual(['ghcr.io/other/loadouts']);
    await writeFile(join(userDataDir, 'loadouts', 'sources.json'), '{not json');
    expect(await sources.listSources()).toEqual([]);
    expect(await readFile(join(userDataDir, 'loadouts', 'sources.json'), 'utf8')).toBe('{not json');
  });

  it('removeSource drops a source', async () => {
    await sources.addSource(SRC);
    await sources.removeSource(SRC);
    expect(await sources.listSources()).toEqual([]);
  });

  it('download pulls into <userData>/loadouts/<id>/ and records provenance', async () => {
    await sources.addSource(SRC);
    await sources.download(SRC, 'spec-driven', '1.0.0');
    expect(pulled.some((p) => p.ref === `${SRC}/spec-driven:1.0.0` && p.artifactType === 'application/vnd.claude-fleet.loadout.v1')).toBe(true);
    expect(await readFile(join(userDataDir, 'loadouts', 'spec-driven', 'loadout.md'), 'utf8')).toContain('Spec-Driven');
    expect(await sources.provenanceFor('spec-driven')).toMatchObject({ source: SRC, version: '1.0.0' });
  });

  it('download of latest records the version it actually pulled', async () => {
    await sources.download(SRC, 'spec-driven');
    expect(pulled.some((p) => p.ref === `${SRC}/spec-driven:latest`)).toBe(true);
    expect(await sources.provenanceFor('spec-driven')).toMatchObject({ version: '1.0.0' });
  });

  it('pulls the index as an index artifact', async () => {
    await sources.addSource(SRC);
    expect(pulled.find((p) => p.ref === `${SRC}/index:latest`)?.artifactType).toBe('application/vnd.claude-fleet.loadout-index.v1');
  });

  it('a re-download replaces the folder: files dropped upstream do not linger, no staging dirs remain', async () => {
    const dir = join(userDataDir, 'loadouts', 'spec-driven');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'removed-upstream.md'), 'old');
    await sources.download(SRC, 'spec-driven', '1.0.0');
    expect(await readdir(dir)).toEqual(['loadout.md']);
    expect((await readdir(join(userDataDir, 'loadouts'))).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('a failed pull leaves the existing copy untouched and cleans up its staging dir', async () => {
    const dir = join(userDataDir, 'loadouts', 'spec-driven');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'loadout.md'), 'old copy');
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_ref: string, dest: string) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, 'partial.md'), 'half');
      throw new Error('layer loadout.md digest mismatch');
    });
    await expect(sources.download(SRC, 'spec-driven', '1.0.0')).rejects.toThrow(/digest mismatch/);
    expect(await readFile(join(dir, 'loadout.md'), 'utf8')).toBe('old copy');
    expect((await readdir(join(userDataDir, 'loadouts'))).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('refuses the reserved id "index"', async () => {
    await expect(sources.download(SRC, 'index')).rejects.toThrow(/reserved/);
    expect(pulled.some((p) => p.ref.endsWith('/index:latest') && !p.artifactType?.includes('index'))).toBe(false);
  });

  it('addSource with a token stores it in the vault (not sources.json) and pulls with it', async () => {
    await sources.addSource(SRC, 'ghp_source');
    await sources.download(SRC, 'spec-driven', '1.0.0');
    expect(pulled.map((p) => p.credential)).toEqual(['ghp_source', 'ghp_source']);
    expect(await readFile(join(userDataDir, 'loadouts', 'sources.json'), 'utf8')).not.toContain('ghp_source');
  });

  it('falls back to GH_TOKEN when no token is stored', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_env');
    await sources.addSource(SRC);
    expect(pulled[0].credential).toBe('ghp_env');
  });

  it('prefers the stored token over GH_TOKEN', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_env');
    await sources.addSource(SRC, 'ghp_source');
    expect(pulled[0].credential).toBe('ghp_source');
  });

  it('does not keep the token when the source fails to add', async () => {
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 401'));
    await expect(sources.addSource(SRC, 'ghp_bad')).rejects.toThrow(/401/);
    expect(vaultStore.size).toBe(0);
  });

  it('removeSource deletes the stored token', async () => {
    await sources.addSource(SRC, 'ghp_source');
    await sources.removeSource(SRC);
    pulled.length = 0;
    await sources.addSource(SRC);
    expect(pulled[0].credential).toBeUndefined();
  });

  it('allRemote skips a source whose index fails to pull', async () => {
    await sources.addSource(SRC);
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const all = await sources.allRemote();
    expect(all).toEqual([]); // the one source failed → skipped, no throw
  });
});
