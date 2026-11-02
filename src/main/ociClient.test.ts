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

  it('integration: cross-host realm + manifest 401 — the raw token is sent only in requests to ghcr.io, never to the realm host', async () => {
    const fetchMock = fakeRegistry({
      manifest: ANN_MANIFEST,
      private: { token: 'ghp_good' },
      realm: 'https://evil.example/token'
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAnnotations(REF, { cred: { token: 'ghp_good' } })).rejects.toMatchObject({
      name: 'RegistryAuthError',
      kind: 'credential-rejected',
      status: 401
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const c of fetchMock.mock.calls) {
      const url = String(c[0]);
      const auth = (c[1] as Init | undefined)?.headers?.['Authorization'] ?? '';
      if (auth.includes('ghp_good')) {
        expect(url).toContain('ghcr.io');
      }
      if (url.includes('evil.example')) {
        expect(auth).not.toContain('ghp_good');
      }
    }
  });
});

describe('ociClient sanitised errors (#444 security review)', () => {
  it('rejects a malformed token up front (credential-rejected, no token in the message) without making any network call', async () => {
    const fetchMock = fakeRegistry({ manifest: ANN_MANIFEST, private: { token: 'ghp_good' } });
    vi.stubGlobal('fetch', fetchMock);
    const bad = 'ghp_SECRET\nX-Injected: evil';
    const err = await fetchAnnotations(REF, { cred: { token: bad } }).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ name: 'RegistryAuthError', kind: 'credential-rejected' });
    expect(err.message).not.toContain('ghp_SECRET');
    expect(err.message).not.toContain(bad);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitises a transport-level throw from the token-exchange fetch so the token never surfaces', async () => {
    const token = 'ghp_leaked_token_value';
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/token?')) {
        throw new TypeError(`Bearer ${token}\n" is an invalid header value`);
      }
      return new Response('unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${REPO}:pull"` }
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchAnnotations(REF, { cred: { token } }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(token);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('sanitises a transport-level throw from the manifest fetch so the token never surfaces', async () => {
    const token = 'ghp_leaked_token_value';
    // No WWW-Authenticate realm on the anonymous probe ⇒ registryToken takes the
    // static-Bearer-fallback path (no token-exchange call at all) and the *real*
    // manifest fetch — the only authenticated call here — carries the raw token.
    const fetchMock = vi.fn(async (url: string, init?: Init) => {
      const u = String(url);
      if (/\/manifests\//.test(u)) {
        const auth = init?.headers?.['Authorization'];
        if (auth) throw new TypeError(`"${auth}" is an invalid header value`);
        return new Response('unauthorized', { status: 401 }); // probe: no realm advertised
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchAnnotations(REF, { cred: { token } }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(token);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('sanitises a transport-level throw from the blob fetch so the token never surfaces', async () => {
    const token = 'ghp_leaked_token_value';
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/token?')) return Response.json({ token: 'public-bearer' });
      if (/\/manifests\//.test(u)) return new Response(JSON.stringify({ layers: [layer('sha256:a1', 'loadout.md')] }), { status: 200 });
      if (/\/blobs\//.test(u)) throw new TypeError(`"Bearer ${token}" is an invalid header value`);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const dest = await mkdtemp(join(tmpdir(), 'oci-pull-'));
    try {
      let err: Error | undefined;
      try {
        await pullArtifact(REF, dest, { cred: { token } });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toContain(token);
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('wraps a non-JSON token-exchange response body in a generic error (no body snippet)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/token?')) return new Response('<html>not json, maybe-a-secret-looking string</html>', { status: 200 });
      return new Response('unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${REPO}:pull"` }
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchAnnotations(REF).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('maybe-a-secret-looking string');
  });

  it('wraps a non-JSON manifest response body in a generic error (no body snippet)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/token?')) return Response.json({ token: 'public-bearer' });
      if (/\/manifests\/[^/]+$/.test(u)) {
        return new Response('<html>not json, maybe-a-secret-looking string</html>', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchAnnotations(REF).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('maybe-a-secret-looking string');
  });
});

describe('ociClient minor hardening (#444 security review)', () => {
  it('treats an empty-string token as no credential (anonymous flow, not a rejection)', async () => {
    const fetchMock = fakeRegistry({ manifest: ANN_MANIFEST });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF, { cred: { token: '' } });
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    expect(authHeaders(fetchMock, '/token?')).toEqual([undefined]);
  });

  it('treats a whitespace-only token as no credential (anonymous flow, not a rejection)', async () => {
    const fetchMock = fakeRegistry({ manifest: ANN_MANIFEST });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF, { cred: { token: '   ' } });
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    expect(authHeaders(fetchMock, '/token?')).toEqual([undefined]);
  });
});
