import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { fetchAnnotations, pullArtifact, MAX_BLOB_BYTES } = await import('./ociClient.js');

const REPO = 'imioimi/claude-fleet-loadouts';
const REF = `ghcr.io/${REPO}/spec-driven:1.0.0`;

// Build a fake GHCR. `manifest` + `blobs` (digest→{bytes, size?}) drive responses.
function fakeGhcr(opts: {
  manifest: object;
  blobs?: Record<string, { body: string; contentLength?: number }>;
  failTokenAuth?: boolean;
}) {
  const manifestJson = JSON.stringify(opts.manifest);
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    // Token endpoint.
    if (u.startsWith('https://ghcr.io/token')) {
      return new Response(JSON.stringify({ token: 'fake-bearer' }), { status: 200 });
    }
    // Manifest: 401 without bearer (triggers the token flow), 200 with it.
    if (u.endsWith('/manifests/1.0.0') || u.endsWith('/manifests/latest')) {
      if (auth !== 'Bearer fake-bearer') {
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${REPO}:pull"`
          }
        });
      }
      return new Response(manifestJson, { status: 200 });
    }
    // Blob by digest.
    const m = u.match(/\/blobs\/(sha256:[a-f0-9]+)$/);
    if (m && opts.blobs?.[m[1]]) {
      const b = opts.blobs[m[1]];
      const headers: Record<string, string> = {};
      if (b.contentLength != null) headers['content-length'] = String(b.contentLength);
      return new Response(b.body, { status: 200, headers });
    }
    return new Response('not found', { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

const layer = (digest: string, title: string, size = 10) => ({
  mediaType: 'application/vnd.oci.image.layer.v1.tar',
  digest,
  size,
  annotations: { 'org.opencontainers.image.title': title }
});

describe('ociClient.fetchAnnotations', () => {
  it('obtains an anonymous bearer via the 401 → /token flow and returns manifest annotations without pulling blobs', async () => {
    const blobFetch = vi.fn();
    const fetchMock = fakeGhcr({
      manifest: {
        artifactType: 'application/vnd.claude-fleet.loadout.v1',
        annotations: { 'com.claude-fleet.loadout.id': 'spec-driven', 'com.claude-fleet.loadout.title': 'Spec-Driven' },
        layers: [layer('sha256:aaa', 'loadout.md')]
      }
    });
    vi.stubGlobal('fetch', fetchMock);
    const ann = await fetchAnnotations(REF);
    expect(ann['com.claude-fleet.loadout.id']).toBe('spec-driven');
    // No blob endpoint was hit.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/blobs/'))).toBe(false);
  });
});

describe('ociClient.pullArtifact', () => {
  it('pulls every layer blob by digest and reconstructs the tree from layer titles', async () => {
    vi.stubGlobal('fetch', fakeGhcr({
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
    vi.stubGlobal('fetch', fakeGhcr({
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
    vi.stubGlobal('fetch', fakeGhcr({
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
