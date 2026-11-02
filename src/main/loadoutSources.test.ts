import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

// In-memory vault keyed `<scope>|<key>` (the real one needs safeStorage).
const vaultStore = new Map<string, string>();
vi.mock('./vault.js', () => ({
  getSecret: vi.fn(async (scope: string, key: string) => vaultStore.get(`${scope}|${key}`) ?? null),
  setSecret: vi.fn(async (scope: string, key: string, value: string) => {
    vaultStore.set(`${scope}|${key}`, value);
  }),
  deleteAllForWorkspace: vi.fn(async (scope: string) => {
    for (const k of [...vaultStore.keys()]) if (k.startsWith(`${scope}|`)) vaultStore.delete(k);
  })
}));

// Mock the network client; assert sources logic in isolation. `privateBases`
// maps a source base → the only token its fake registry accepts.
type Cred = { token: string; username?: string };
const pulled: Array<{ ref: string; dest: string; cred: Cred | null }> = [];
const privateBases = new Map<string, string>();
vi.mock('./ociClient.js', async () => {
  const { RegistryAuthError } = await import('./ociCore.js');
  return {
    fetchAnnotations: vi.fn(),
    pullArtifact: vi.fn(async (ref: string, dest: string, opts?: { cred?: Cred | null }) => {
      const cred = opts?.cred ?? null;
      pulled.push({ ref, dest, cred });
      for (const [base, token] of privateBases) {
        if (ref.startsWith(`${base}/`) && cred?.token !== token) {
          throw new RegistryAuthError(cred ? 'credential-rejected' : 'needs-credential', 401);
        }
      }
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
  };
});

const sources = await import('./loadoutSources.js');
const SRC = 'ghcr.io/imioimi/claude-fleet-loadouts';
const PRIV = 'ghcr.io/acme/private';
const VAULT_KEY = `loadout-source:${PRIV}|TOKEN`;

const sourcesJson = (): Promise<string> => readFile(join(userDataDir, 'loadouts', 'sources.json'), 'utf8');
async function writeSourcesFile(f: object): Promise<void> {
  await mkdir(join(userDataDir, 'loadouts'), { recursive: true });
  await writeFile(join(userDataDir, 'loadouts', 'sources.json'), JSON.stringify(f));
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'lsrc-'));
  pulled.length = 0;
  vaultStore.clear();
  privateBases.clear();
  sources.setGithubTokenProvider(undefined);
  // Empty ⇒ treated as unset, so a developer's real env can't leak into tests.
  vi.stubEnv('FLEET_LOADOUT_TOKEN', '');
  vi.stubEnv(sources.sourceEnvVarName(PRIV), '');
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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

describe('loadoutSources.credentialFor (#444)', () => {
  it('is null when no credential exists anywhere', async () => {
    expect(await sources.credentialFor(PRIV)).toBeNull();
  });

  it('prefers the vault token, with the username recorded in sources.json', async () => {
    await writeSourcesFile({ sources: [PRIV], provenance: {}, credentials: { [PRIV]: { username: 'alice' } } });
    vaultStore.set(VAULT_KEY, 'vault-tok');
    vi.stubEnv(sources.sourceEnvVarName(PRIV), 'env-tok');
    vi.stubEnv('FLEET_LOADOUT_TOKEN', 'generic-tok');
    sources.setGithubTokenProvider(async () => 'gh-tok');
    expect(await sources.credentialFor(`${PRIV}/`)).toEqual({ token: 'vault-tok', username: 'alice' });
  });

  it('reads a pre-#444 sources.json that has no credentials map', async () => {
    await writeSourcesFile({ sources: [PRIV], provenance: {} });
    vaultStore.set(VAULT_KEY, 'vault-tok');
    expect(await sources.credentialFor(PRIV)).toEqual({ token: 'vault-tok' });
  });

  it('names the per-source env var from the sanitised base', () => {
    expect(sources.sourceEnvVarName('ghcr.io/Acme/private-loadouts/')).toBe(
      'FLEET_LOADOUT_TOKEN_GHCR_IO_ACME_PRIVATE_LOADOUTS'
    );
  });

  it('falls back to the per-source env var before the GitHub token', async () => {
    vi.stubEnv(sources.sourceEnvVarName(PRIV), 'env-tok');
    sources.setGithubTokenProvider(async () => 'gh-tok');
    expect(await sources.credentialFor(PRIV)).toEqual({ token: 'env-tok' });
  });

  it('uses the signed-in GitHub token for ghcr.io sources only', async () => {
    sources.setGithubTokenProvider(async () => 'gh-tok');
    expect(await sources.credentialFor(PRIV)).toEqual({ token: 'gh-tok' });
    expect(await sources.credentialFor('registry.gitlab.com/acme/loadouts')).toBeNull();
  });

  it('a GitHub provider returning null falls through', async () => {
    sources.setGithubTokenProvider(async () => null);
    expect(await sources.credentialFor(PRIV)).toBeNull();
  });

  it('uses FLEET_LOADOUT_TOKEN for a non-default source, never for the public default', async () => {
    vi.stubEnv('FLEET_LOADOUT_TOKEN', 'generic-tok');
    expect(await sources.credentialFor(PRIV)).toEqual({ token: 'generic-tok' });
    expect(await sources.credentialFor(sources.DEFAULT_SOURCES[0])).toBeNull();
  });
});

describe('private sources (#444)', () => {
  it('addSource on a private index without a token rejects with needs-credential and saves nothing', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await expect(sources.addSource(PRIV)).rejects.toThrow(/^needs-credential: ghcr\.io\/acme\/private$/);
    expect(await sources.listSources()).not.toContain(PRIV);
  });

  it('addSource with a token stores it in the vault and never in sources.json', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    const raw = await sourcesJson();
    expect(raw).not.toContain('ghp_good');
    expect(JSON.parse(raw).credentials).toEqual({ [PRIV]: { username: 'alice' } });
    expect(JSON.parse(raw).sources).toContain(PRIV);
    expect(pulled.at(-1)?.cred).toEqual({ token: 'ghp_good', username: 'alice' });
  });

  it('a rejected token on a new source rejects with credential-rejected and leaves no credential behind', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await expect(sources.addSource(PRIV, { token: 'ghp_bad' })).rejects.toThrow(
      /^credential-rejected: ghcr\.io\/acme\/private \(HTTP 401\)$/
    );
    expect(vaultStore.size).toBe(0);
    expect(JSON.parse(await sourcesJson()).credentials).toEqual({});
    expect(await sources.listSources()).not.toContain(PRIV);
  });

  it('rejects an empty token before touching the vault', async () => {
    await expect(sources.addSource(PRIV, { token: '   ' })).rejects.toThrow(/token is required/);
    expect(vaultStore.size).toBe(0);
  });

  it('rejects a malformed token before touching the vault (addSource)', async () => {
    await expect(sources.addSource(PRIV, { token: 'bad token with spaces' })).rejects.toThrow(
      /^malformed-credential: ghcr\.io\/acme\/private$/
    );
    expect(vaultStore.size).toBe(0);
    expect(await sources.listSources()).not.toContain(PRIV);
  });

  it('rejects a malformed token before touching the vault (setSourceCredential), leaving the old one in place', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good' });
    await expect(sources.setSourceCredential(PRIV, { token: 'bad\ttoken' })).rejects.toThrow(
      /^malformed-credential: ghcr\.io\/acme\/private$/
    );
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
  });

  it('listSourceInfo reports hasCredential + username, never the token', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });
    const info = await sources.listSourceInfo();
    expect(info).toEqual([
      { base: sources.DEFAULT_SOURCES[0], hasCredential: false },
      { base: PRIV, hasCredential: true, username: 'alice' }
    ]);
    expect(JSON.stringify(info)).not.toContain('ghp_good');
  });

  it('setSourceCredential replaces the token and refreshes the index', async () => {
    privateBases.set(PRIV, 'ghp_old');
    await sources.addSource(PRIV, { token: 'ghp_old' });
    privateBases.set(PRIV, 'ghp_new');
    const idx = await sources.setSourceCredential(PRIV, { token: 'ghp_new' });
    expect(idx.map((l) => l.id)).toContain('spec-driven');
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_new');
    expect(pulled.at(-1)).toMatchObject({ ref: `${PRIV}/index:latest`, cred: { token: 'ghp_new' } });
  });

  it('setSourceCredential(null) removes the token; a private source then needs one again', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good' });
    await expect(sources.setSourceCredential(PRIV, null)).rejects.toThrow(/^needs-credential: /);
    expect(vaultStore.size).toBe(0);
    expect((await sources.listSourceInfo()).find((s) => s.base === PRIV)).toEqual({ base: PRIV, hasCredential: false });
  });

  it('setSourceCredential refuses a source that is not configured', async () => {
    await expect(sources.setSourceCredential(PRIV, { token: 'ghp_x' })).rejects.toThrow(/unknown source/);
    expect(vaultStore.size).toBe(0);
  });

  it('removeSource purges the source vault scope and its credentials entry', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good' });
    await sources.removeSource(PRIV);
    expect(vaultStore.size).toBe(0);
    expect(JSON.parse(await sourcesJson()).credentials).toEqual({});
  });

  it('download pulls with the resolved credential and maps a refused token', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good' });
    await sources.download(PRIV, 'spec-driven', '1.0.0');
    expect(pulled.at(-1)).toMatchObject({ ref: `${PRIV}/spec-driven:1.0.0`, cred: { token: 'ghp_good' } });
    privateBases.set(PRIV, 'ghp_rotated');
    await expect(sources.download(PRIV, 'spec-driven', '1.0.0')).rejects.toThrow(
      /^credential-rejected: ghcr\.io\/acme\/private \(HTTP 401\)$/
    );
  });

  it('public sources still pull anonymously', async () => {
    await sources.addSource(SRC);
    expect(pulled.at(-1)).toMatchObject({ ref: `${SRC}/index:latest`, cred: null });
  });
});
