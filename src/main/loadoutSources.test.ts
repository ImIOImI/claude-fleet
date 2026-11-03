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

const logged: Array<{ type: string; message: string }> = [];
vi.mock('./errorLog.js', () => ({
  logError: vi.fn((e: { type: string; message: string }) => void logged.push(e))
}));

// loadoutInstall.js's only other dependency (besides the real loadoutSources.js
// under test): stub it out so `ensureAndInstall` can be exercised here without
// a real workspace/manifest/container stack (#444 final review I1).
const installed: string[] = [];
vi.mock('./loadouts.js', () => ({
  installLoadout: vi.fn(async (_ws: string, id: string) => { installed.push(id); return { installed: { id } }; })
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
  logged.length = 0;
  installed.length = 0;
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

  it('never seeds over an existing sources.json, and fails closed on a corrupt one', async () => {
    await mkdir(join(userDataDir, 'loadouts'), { recursive: true });
    await writeFile(join(userDataDir, 'loadouts', 'sources.json'), JSON.stringify({ sources: ['ghcr.io/other/loadouts'], provenance: {} }));
    expect(await sources.listSources()).toEqual(['ghcr.io/other/loadouts']);
    await writeFile(join(userDataDir, 'loadouts', 'sources.json'), '{not json');
    await expect(sources.listSources()).rejects.toThrow(/sources\.json/);
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

describe('security review fixes (#444)', () => {
  const corrupt = async (body: string) => {
    await mkdir(join(userDataDir, 'loadouts'), { recursive: true });
    await writeFile(join(userDataDir, 'loadouts', 'sources.json'), body);
  };

  it('a corrupt sources.json makes every writer throw instead of wiping the file', async () => {
    await corrupt('{not json');
    await expect(sources.addSource(SRC)).rejects.toThrow(/sources\.json/);
    await expect(sources.removeSource(SRC)).rejects.toThrow(/sources\.json/);
    await expect(sources.download(SRC, 'spec-driven')).rejects.toThrow(/sources\.json/);
    await expect(sources.listSourceInfo()).rejects.toThrow(/sources\.json/);
    expect(await sourcesJson()).toBe('{not json');
  });

  it('a non-object sources.json also fails closed', async () => {
    await corrupt('null');
    await expect(sources.listSources()).rejects.toThrow(/sources\.json/);
    await corrupt('[1,2]');
    await expect(sources.listSources()).rejects.toThrow(/sources\.json/);
  });

  it('writes sources.json atomically (no temp file left beside it)', async () => {
    await sources.addSource(SRC);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(userDataDir, 'loadouts'))).filter((f) => f.startsWith('sources.json'))).toEqual(['sources.json']);
  });

  it('concurrent credential writes and downloads all persist (serialised writers)', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good' });
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    await Promise.all([
      sources.setSourceCredential(PRIV, { token: 'ghp_good', username: 'bob' }),
      ...ids.map((id) => sources.download(SRC, id))
    ]);
    const raw = JSON.parse(await sourcesJson());
    expect(raw.credentials[PRIV]).toEqual({ username: 'bob' });
    expect(Object.keys(raw.provenance).sort()).toEqual(ids);
  });

  it('re-adding a known source with a bad token keeps the working token', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });
    const infoBefore = await sources.listSourceInfo();
    await expect(sources.addSource(PRIV, { token: 'ghp_bad', username: 'mallory' })).rejects.toThrow(/^credential-rejected: /);
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    expect(await sources.listSourceInfo()).toEqual(infoBefore);
  });

  it('re-adding an unlisted source that still has a credential restores it on rejection', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await writeSourcesFile({ sources: [], provenance: {}, credentials: { [PRIV]: { username: 'alice' } } });
    vaultStore.set(VAULT_KEY, 'ghp_good');
    await expect(sources.addSource(PRIV, { token: 'ghp_bad' })).rejects.toThrow(/^credential-rejected: /);
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    expect(JSON.parse(await sourcesJson()).credentials).toEqual({ [PRIV]: { username: 'alice' } });
  });

  it('setSourceCredential with a rejected token restores the previous token and username', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });
    await expect(sources.setSourceCredential(PRIV, { token: 'ghp_bad', username: 'eve' })).rejects.toThrow(
      /^credential-rejected: /
    );
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    expect((await sources.listSourceInfo()).find((s) => s.base === PRIV)).toEqual({
      base: PRIV,
      hasCredential: true,
      username: 'alice'
    });
    // ...and the source still browses with the restored token.
    expect((await sources.browseSource(PRIV, { refresh: true })).map((l) => l.id)).toContain('spec-driven');
  });

  it('setSourceCredential with a rejected token clears it when no credential existed before', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await writeSourcesFile({ sources: [PRIV], provenance: {}, credentials: {} });
    await expect(sources.setSourceCredential(PRIV, { token: 'ghp_bad' })).rejects.toThrow(/^credential-rejected: /);
    expect(vaultStore.size).toBe(0);
    expect(JSON.parse(await sourcesJson()).credentials).toEqual({});
  });

  it('logs (base, never token) when a rollback cannot clear the token', async () => {
    privateBases.set(PRIV, 'ghp_good');
    const v = await import('./vault.js');
    (v.deleteAllForWorkspace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('vault locked'));
    await expect(sources.addSource(PRIV, { token: 'ghp_bad_secret' })).rejects.toThrow(/^credential-rejected: /);
    expect(logged.length).toBe(1);
    expect(logged[0].message).toContain(PRIV);
    expect(JSON.stringify(logged)).not.toContain('ghp_bad_secret');
  });

  it('removeSource purges the vault before dropping the source, so a failed purge leaves it listed', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good' });
    const v = await import('./vault.js');
    (v.deleteAllForWorkspace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('vault locked'));
    await expect(sources.removeSource(PRIV)).rejects.toThrow(/vault locked/);
    expect(await sources.listSources()).toContain(PRIV);
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
  });

  it('canonicalises bases: oci:// prefix and case map to one scope', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource('oci://GHCR.io/Acme/Private/', { token: 'ghp_good' });
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    expect(await sources.listSources()).toContain(PRIV);
    expect(await sources.credentialFor('ghcr.io/ACME/private')).toEqual({ token: 'ghp_good' });
  });

  it('the default-source exclusion for FLEET_LOADOUT_TOKEN survives case and oci:// tricks', async () => {
    vi.stubEnv('FLEET_LOADOUT_TOKEN', 'generic-tok');
    expect(await sources.credentialFor('oci://ghcr.io/imioimi/claude-fleet-loadouts')).toBeNull();
    expect(await sources.credentialFor('GHCR.IO/Imioimi/Claude-Fleet-Loadouts')).toBeNull();
  });

  it('caps token and username length and refuses a username with a colon', async () => {
    await expect(sources.addSource(PRIV, { token: 'x'.repeat(4097) })).rejects.toThrow(/^malformed-credential: /);
    await expect(sources.addSource(PRIV, { token: 'ghp_ok', username: 'u'.repeat(257) })).rejects.toThrow(
      /^malformed-credential: /
    );
    await expect(sources.addSource(PRIV, { token: 'ghp_ok', username: 'a:b' })).rejects.toThrow(/^malformed-credential: /);
    expect(vaultStore.size).toBe(0);
  });

  it('a known source with an existing token restores it on a network failure during re-validation (addSource)', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network unreachable'));
    await expect(sources.addSource(PRIV, { token: 'ghp_new', username: 'mallory' })).rejects.toThrow(
      /network unreachable/
    );
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    expect((await sources.listSourceInfo()).find((s) => s.base === PRIV)).toEqual({
      base: PRIV,
      hasCredential: true,
      username: 'alice'
    });
  });

  it('a known source with an existing token restores it on a network failure during re-validation (setSourceCredential)', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('index is not an array'));
    await expect(sources.setSourceCredential(PRIV, { token: 'ghp_new', username: 'mallory' })).rejects.toThrow(
      /index is not an array/
    );
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_good');
    expect((await sources.listSourceInfo()).find((s) => s.base === PRIV)).toEqual({
      base: PRIV,
      hasCredential: true,
      username: 'alice'
    });
  });

  it('a brand-new source leaves no credential behind on a network failure, not just an auth failure', async () => {
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network unreachable'));
    await expect(sources.addSource(PRIV, { token: 'ghp_x' })).rejects.toThrow(/network unreachable/);
    expect(vaultStore.size).toBe(0);
    expect(await sources.listSources()).not.toContain(PRIV);
  });

  it('rollback does not clobber a credential a concurrent call already changed', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });

    const client = await import('./ociClient.js');
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCall = true;
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockImplementation(
      async (ref: string, dest: string, opts?: { cred?: Cred | null }) => {
        if (firstCall) {
          firstCall = false;
          await gate; // block the first (stale) call until the second has fully landed
          throw new Error('network unreachable');
        }
        pulled.push({ ref, dest, cred: opts?.cred ?? null });
        await mkdir(dest, { recursive: true });
        await writeFile(
          join(dest, 'index.json'),
          JSON.stringify([{ id: 'spec-driven', title: 'x', description: 'd', tags: [], version: '1.0.0' }])
        );
      }
    );

    const p1 = sources.setSourceCredential(PRIV, { token: 'ghp_stale', username: 'mallory' });
    await new Promise((r) => setTimeout(r, 0));
    const p2 = sources.setSourceCredential(PRIV, { token: 'ghp_fresh', username: 'bob' });
    await new Promise((r) => setTimeout(r, 0));
    releaseFirst();

    await expect(p1).rejects.toThrow(/network unreachable/);
    await expect(p2).resolves.toBeDefined();

    // p1's rollback must not have reverted p2's (newer, successful) write.
    expect(vaultStore.get(VAULT_KEY)).toBe('ghp_fresh');
    expect((await sources.listSourceInfo()).find((s) => s.base === PRIV)).toEqual({
      base: PRIV,
      hasCredential: true,
      username: 'bob'
    });
  });

  it('rollback does not resurrect a source removed while its re-validation was in flight', async () => {
    privateBases.set(PRIV, 'ghp_good');
    await sources.addSource(PRIV, { token: 'ghp_good', username: 'alice' });

    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await sources.removeSource(PRIV); // lands while this call's validation is "in flight"
      throw new Error('network unreachable');
    });

    await expect(sources.setSourceCredential(PRIV, { token: 'ghp_new', username: 'mallory' })).rejects.toThrow(
      /network unreachable/
    );
    expect(vaultStore.size).toBe(0);
    expect(await sources.listSources()).not.toContain(PRIV);
  });
});

describe('final review follow-ups (#444)', () => {
  const corrupt = async (body: string) => {
    await mkdir(join(userDataDir, 'loadouts'), { recursive: true });
    await writeFile(join(userDataDir, 'loadouts', 'sources.json'), body);
  };

  it('I1: allRemote degrades to an empty remote catalog (not a throw) on a corrupt sources.json', async () => {
    await corrupt('{not json');
    await expect(sources.allRemote()).resolves.toEqual([]);
    const entry = logged.find((e) => e.type === 'loadoutSources.allRemote');
    expect(entry?.message).toMatch(/could not list sources/);
    expect(entry?.message).not.toContain('{not json'); // the raw file body never leaks into the log
  });

  it('I1: provenanceFor returns null (not a throw) on a corrupt sources.json', async () => {
    await corrupt('{not json');
    await expect(sources.provenanceFor('spec-driven')).resolves.toBeNull();
  });

  it('I1: a local install still succeeds through ensureAndInstall when sources.json is corrupt', async () => {
    // ensureAndInstall's first call is provenanceFor(id); before this fix that
    // threw on a corrupt file and broke every install, even a purely local one
    // (no opts.source, so sources.json is otherwise irrelevant to it).
    await corrupt('{not json');
    const { ensureAndInstall } = await import('./loadoutInstall.js');
    await expect(ensureAndInstall('ws1', 'local-only')).resolves.toEqual({ status: 'installed' });
    expect(installed).toEqual(['local-only']);
  });

  it('I1: mutating paths still fail closed on a corrupt sources.json (addSource, setSourceCredential, removeSource, download)', async () => {
    await corrupt('{not json');
    await expect(sources.addSource(SRC)).rejects.toThrow(/sources\.json/);
    await expect(sources.setSourceCredential(SRC, { token: 'ghp_x' })).rejects.toThrow(/sources\.json/);
    await expect(sources.removeSource(SRC)).rejects.toThrow(/sources\.json/);
    await expect(sources.download(SRC, 'spec-driven')).rejects.toThrow(/sources\.json/);
    expect(await sourcesJson()).toBe('{not json'); // never wiped
  });

  it('M4: a base smuggling embedded credentials is rejected generically, echoing nothing', async () => {
    const hostile = 'oci://user:ghp_SECRETTOKEN@ghcr.io/org/repo';
    const err = (await sources.addSource(hostile).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('invalid source');
    expect(err.message).not.toContain('ghp_SECRETTOKEN');
    expect(err.message).not.toContain('@');
    expect(pulled).toEqual([]); // never even attempted a pull
  });

  it('M2: a malformed-credential registry error surfaces as malformed-credential, never a fake HTTP status', async () => {
    const { RegistryAuthError } = await import('./ociCore.js');
    const client = await import('./ociClient.js');
    (client.pullArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new RegistryAuthError('malformed', 0));
    const err = (await sources.addSource(SRC).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(`malformed-credential: ${SRC}`);
    expect(err.message).not.toMatch(/HTTP/);
  });

  it('M4: a base containing "://" after the oci:// prefix is rejected generically, with no "@" involved', async () => {
    const hostile = 'oci://ghcr.io/org/repo?redirect=http://evil.example';
    const err = (await sources.addSource(hostile).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('invalid source');
    expect(pulled).toEqual([]);
  });
});
