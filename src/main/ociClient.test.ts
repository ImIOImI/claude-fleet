import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { fetchAnnotations, pullArtifact, MAX_BLOB_BYTES } = await import('./ociClient.js');

const REPO = 'imioimi/claude-fleet-loadouts';
const REF = `ghcr.io/${REPO}/spec-driven:1.0.0`;

type Init = { headers?: Record<string, string> };

/**
 * A fake OCI registry behind a `fetch` stub. parseImageRef pins https://ghcr.io,
 * so stubbing fetch reaches the fake without a scheme/host seam in product code.
 * - token endpoint: any URL containing `/token?` (so the realm host is configurable);
 * - public (no `private`): every token request gets `public-bearer`;
 * - private: `private-bearer` only for the right Basic credentials, 401 for wrong
 *   ones, and a useless `anon-bearer` when asked anonymously (GHCR's behaviour);
 * - `realm: null` omits WWW-Authenticate (static-token registries);
 * - `staticToken`: the registry also accepts `Bearer <staticToken>` directly.
 */
function fakeRegistry(opts: {
  manifest: object;
  blobs?: Record<string, { body: string; contentLength?: number }>;
  private?: { token: string; username?: string };
  realm?: string | null;
  staticToken?: string;
}) {
  const manifestJson = JSON.stringify(opts.manifest);
  const realm = opts.realm === undefined ? 'https://ghcr.io/token' : opts.realm;
  const accepted = new Set<string>([opts.private ? 'Bearer private-bearer' : 'Bearer public-bearer']);
  if (opts.staticToken) accepted.add(`Bearer ${opts.staticToken}`);
  const challenge = (): Response =>
    new Response('unauthorized', {
      status: 401,
      headers: realm
        ? { 'WWW-Authenticate': `Bearer realm="${realm}",service="ghcr.io",scope="repository:${REPO}:pull"` }
        : {}
    });
  return vi.fn(async (url: string, init?: Init) => {
    const u = String(url);
    const auth = init?.headers?.['Authorization'];
    if (u.includes('/token?')) {
      if (!opts.private) return Response.json({ token: 'public-bearer' });
      if (!auth) return Response.json({ token: 'anon-bearer' });
      const want = `Basic ${Buffer.from(`${opts.private.username ?? 'token'}:${opts.private.token}`).toString('base64')}`;
      return auth === want ? Response.json({ token: 'private-bearer' }) : new Response('denied', { status: 401 });
    }
    if (/\/manifests\/[^/]+$/.test(u)) {
      return auth && accepted.has(auth) ? new Response(manifestJson, { status: 200 }) : challenge();
    }
    const m = u.match(/\/blobs\/(sha256:[a-f0-9]+)$/);
    if (m && opts.blobs?.[m[1]]) {
      if (!auth || !accepted.has(auth)) return challenge();
      const b = opts.blobs[m[1]];
      const headers: Record<string, string> = {};
      if (b.contentLength != null) headers['content-length'] = String(b.contentLength);
      return new Response(b.body, { status: 200, headers });
    }
    return new Response('not found', { status: 404 });
  });
}

const authHeaders = (f: ReturnType<typeof fakeRegistry>, urlPart: string): Array<string | undefined> =>
  f.mock.calls.filter((c) => String(c[0]).includes(urlPart)).map((c) => (c[1] as Init | undefined)?.headers?.['Authorization']);

afterEach(() => vi.unstubAllGlobals());

const layer = (digest: string, title: string, size = 10) => ({
  mediaType: 'application/vnd.oci.image.layer.v1.tar',
  digest,
  size,
  annotations: { 'org.opencontainers.image.title': title }
});

const ANN_MANIFEST = {
  artifactType: 'application/vnd.claude-fleet.loadout.v1',
  annotations: { 'com.claude-fleet.loadout.id': 'spec-driven', 'com.claude-fleet.loadout.title': 'Spec-Driven' },
  layers: [layer('sha256:aaa', 'loadout.md')]
};

describe('ociClient.fetchAnnotations', () => {
  it('obtains an anonymous bearer via the 401 → /token flow and returns manifest annotations without pulling blobs', async () => {
    const fetchMock = fakeRegistry({ manifest: ANN_MANIFEST });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF);
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/blobs/'))).toBe(false);
    // Anonymous: the token endpoint got no Authorization header.
    expect(authHeaders(fetchMock, '/token?')).toEqual([undefined]);
  });
});

describe('ociClient.pullArtifact', () => {
  it('pulls every layer blob by digest and reconstructs the tree from layer titles', async () => {
    vi.stubGlobal('fetch', fakeRegistry({
      manifest: { layers: [layer('sha256:a1', 'loadout.md'), layer('sha256:b2', 'skills/x/SKILL.md')] },
      blobs: { 'sha256:a1': { body: 'TITLE' }, 'sha256:b2': { body: 'SKILL' } }
    }));
    const dest = await mkdtemp(join(tmpdir(), 'oci-pull-'));
    try {
      await pullArtifact(REF, dest);
      expect(await readFile(join(dest, 'loadout.md'), 'utf8')).toBe('TITLE');
      expect(await readFile(join(dest, 'skills/x/SKILL.md'), 'utf8')).toBe('SKILL');
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('aborts the pull on a path-traversal layer title (safeLayerPath rejects)', async () => {
    vi.stubGlobal('fetch', fakeRegistry({
      manifest: { layers: [layer('sha256:evil', '../escape.txt')] },
      blobs: { 'sha256:evil': { body: 'x' } }
    }));
    const dest = await mkdtemp(join(tmpdir(), 'oci-pull-'));
    try {
      await expect(pullArtifact(REF, dest)).rejects.toThrow(/unsafe layer path/);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('enforces a per-blob size cap (content-length over cap aborts)', async () => {
    vi.stubGlobal('fetch', fakeRegistry({
      manifest: { layers: [layer('sha256:big', 'loadout.md', MAX_BLOB_BYTES + 1)] },
      blobs: { 'sha256:big': { body: 'x', contentLength: MAX_BLOB_BYTES + 1 } }
    }));
    const dest = await mkdtemp(join(tmpdir(), 'oci-pull-'));
    try {
      await expect(pullArtifact(REF, dest)).rejects.toThrow(/too large|size/i);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe('ociClient private registries (#444)', () => {
  it('a private repo without a credential rejects with needs-credential', async () => {
    vi.stubGlobal('fetch', fakeRegistry({ manifest: ANN_MANIFEST, private: { token: 'ghp_good' } }));
    await expect(fetchAnnotations(REF)).rejects.toMatchObject({
      name: 'RegistryAuthError',
      kind: 'needs-credential',
      status: 401
    });
  });

  it('exchanges Basic token:<TOKEN> at the realm for a bearer and pulls', async () => {
    const fetchMock = fakeRegistry({
      manifest: { layers: [layer('sha256:a1', 'loadout.md')] },
      blobs: { 'sha256:a1': { body: 'PRIVATE' } },
      private: { token: 'ghp_good' }
    });
    vi.stubGlobal('fetch', fetchMock);
    const dest = await mkdtemp(join(tmpdir(), 'oci-pull-'));
    try {
      await pullArtifact(REF, dest, { cred: { token: 'ghp_good' } });
      expect(await readFile(join(dest, 'loadout.md'), 'utf8')).toBe('PRIVATE');
      expect(authHeaders(fetchMock, '/token?')).toEqual([`Basic ${Buffer.from('token:ghp_good').toString('base64')}`]);
      expect(authHeaders(fetchMock, '/blobs/')).toEqual(['Bearer private-bearer']);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('uses the given username in the Basic exchange', async () => {
    const fetchMock = fakeRegistry({ manifest: ANN_MANIFEST, private: { token: 'ghp_good', username: 'alice' } });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF, { cred: { token: 'ghp_good', username: 'alice' } });
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    expect(authHeaders(fetchMock, '/token?')).toEqual([`Basic ${Buffer.from('alice:ghp_good').toString('base64')}`]);
  });

  it('a wrong token rejects with credential-rejected and the message never carries the token', async () => {
    vi.stubGlobal('fetch', fakeRegistry({ manifest: ANN_MANIFEST, private: { token: 'ghp_good' } }));
    const err = await fetchAnnotations(REF, { cred: { token: 'ghp_bad' } }).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ name: 'RegistryAuthError', kind: 'credential-rejected', status: 401 });
    expect(err.message).toBe('credential rejected (HTTP 401)');
    expect(err.message).not.toContain('ghp_bad');
  });

  it('sends the token as a static Bearer when the 401 carries no realm', async () => {
    const fetchMock = fakeRegistry({
      manifest: ANN_MANIFEST,
      private: { token: 'unused' },
      realm: null,
      staticToken: 'glpat-static'
    });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF, { cred: { token: 'glpat-static' } });
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/token?'))).toBe(false);
    expect(authHeaders(fetchMock, '/manifests/').at(-1)).toBe('Bearer glpat-static');
  });

  it('falls back to a static Bearer when the token exchange rejects the credential', async () => {
    const fetchMock = fakeRegistry({ manifest: ANN_MANIFEST, private: { token: 'ghp_other' }, staticToken: 'pat-direct' });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF, { cred: { token: 'pat-direct' } });
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    expect(authHeaders(fetchMock, '/manifests/').at(-1)).toBe('Bearer pat-direct');
  });

  it('never sends credentials to a realm on a different host', async () => {
    const fetchMock = fakeRegistry({
      manifest: ANN_MANIFEST,
      private: { token: 'ghp_good' },
      realm: 'https://evil.example/token'
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAnnotations(REF, { cred: { token: 'ghp_good' } })).rejects.toMatchObject({
      kind: 'credential-rejected'
    });
    expect(authHeaders(fetchMock, 'evil.example')).toEqual([undefined]);
    for (const c of fetchMock.mock.calls) {
      const h = (c[1] as Init | undefined)?.headers?.['Authorization'] ?? '';
      expect(h.startsWith('Basic ')).toBe(false);
    }
  });
});
