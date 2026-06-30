import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

// Mock the network client; assert sources logic in isolation.
const pulled: Array<{ ref: string; dest: string }> = [];
vi.mock('./ociClient.js', () => ({
  fetchAnnotations: vi.fn(),
  pullArtifact: vi.fn(async (ref: string, dest: string) => {
    pulled.push({ ref, dest });
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
});
afterEach(async () => {
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

  it('removeSource drops a source', async () => {
    await sources.addSource(SRC);
    await sources.removeSource(SRC);
    expect(await sources.listSources()).toEqual([]);
  });

  it('download pulls into <userData>/loadouts/<id>/ and records provenance', async () => {
    await sources.addSource(SRC);
    await sources.download(SRC, 'spec-driven', '1.0.0');
    expect(pulled.some((p) => p.ref === `${SRC}/spec-driven:1.0.0` && p.dest.endsWith('/loadouts/spec-driven'))).toBe(true);
    expect(await sources.provenanceFor('spec-driven')).toMatchObject({ source: SRC, version: '1.0.0' });
  });

  it('allRemote skips a source whose index fails to pull', async () => {
    await sources.addSource(SRC);
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const all = await sources.allRemote();
    expect(all).toEqual([]); // the one source failed → skipped, no throw
  });
});
