# Loadout Library v2 — Phase 2 consumer (remote OCI sources) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the app add public GHCR sources, discover their loadouts via the published index artifact, download/install them, and surface updates — wiring remote sources into the Phase 1 catalog.

**Architecture:** A dependency-free `ociClient.ts` (anonymous GHCR pull over global `fetch`) + a `loadoutSources.ts` electron-wired layer (sources.json persistence, index browsing, download + provenance, pull-if-needed install) feed `assembleCatalog`'s `remote` arg. New IPC exposes source management + download; the browser modal gains source checkboxes + Add-source, and the rail gains an `Update ↑` affordance. The pure core (`ociCore.ts`) and Phase 1 install/uninstall are reused untouched.

**Tech Stack:** Electron main (global `fetch`, `AbortController`), Node fs, TypeScript, vitest (mocked `fetch`/fs), Playwright e2e. No new dependencies (no `oras` binary).

## Global Constraints

- **Public GHCR only, anonymous** — no stored credentials. Transport is the native client (`fetch` against `ghcr.io/v2`). `parseImageRef` rejects non-GHCR refs (`ociCore.ts`) — surface that error, never dial another host.
- **Anonymous token flow (verified against real GHCR):** request `https://ghcr.io/v2/<repo>/manifests/<tag>` → on 401 read `WWW-Authenticate: Bearer realm="...",service="...",scope="..."` → `GET <realm>?service=<service>&scope=<scope>` → use `{ token }` as `Authorization: Bearer`. Manifest `Accept: application/vnd.oci.image.manifest.v1+json`.
- **Index artifact contract (from the producer, now live):** `<source>/index:latest`, artifactType `application/vnd.claude-fleet.loadout-index.v1`, one `index.json` layer = `[{id,title,description,tags,version}]`. `source` base is `ghcr.io/<owner>/claude-fleet-loadouts`. Live source for the smoke test: `ghcr.io/imioimi/claude-fleet-loadouts`.
- **Security (§9):** every downloaded layer is written **only** through `ociCore.safeLayerPath(destDir, title)` (rejects `..`/absolute), confined to `<userData>/loadouts/<id>/` — host-private, never bind-mounted into a container. Abort the whole pull on a traversal title. Enforce a per-blob size cap (`MAX_BLOB_BYTES = 5_242_880`). Treat the index + annotations as untrusted (`parseIndex` already validates).
- **No "download" state** — install pulls-if-absent-or-stale then runs the existing `installLoadout`. A collision with a locally-authored id (present locally, no provenance) is **confirm-before-overwrite**, never silent.
- **MCP stays read-only** — all new IPC is host-side (`ipc.ts`), never an MCP tool.
- **Reuse `ociCore.ts` verbatim** (`parseImageRef`/`loadoutRefFromSource`/`safeLayerPath`/`parseIndex`/`compareVersions`/`isUpdateAvailable`/`assembleCatalog`) — do not duplicate its logic.
- Tests: `npx vitest run <path>`; full suite `npm run test:unit`; typecheck `npm run typecheck`; build `npm run build`. The live smoke pull is a Playwright test gated to skip when `process.env.NO_NETWORK` is set.

---

### Task 1: `ociClient.ts` — anonymous GHCR pull

**Files:**
- Create: `src/main/ociClient.ts`
- Test: `src/main/ociClient.test.ts`
- Modify: `src/main/ociCore.test.ts` (delete the 5 `it.todo` lines in the `ociClient (GHCR pull)` block at lines 167–173, since real tests now exist)

**Interfaces:**
- Consumes: `parseImageRef`, `safeLayerPath` from `./ociCore.js`.
- Produces:
  - `fetchAnnotations(ref: string): Promise<Record<string, string>>` — manifest annotations, no blob pull.
  - `pullArtifact(ref: string, destDir: string): Promise<void>` — pull every layer to `destDir` via `safeLayerPath`.
  - `export const MAX_BLOB_BYTES = 5_242_880;`

- [ ] **Step 1: Write the failing tests** — `src/main/ociClient.test.ts`. Stub global `fetch` with a small router keyed by URL+headers:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/ociClient.test.ts`
Expected: FAIL — cannot import `./ociClient.js` (module missing).

- [ ] **Step 3: Implement `src/main/ociClient.ts`**

```ts
// Native, zero-dependency OCI pull for public GHCR (loadout-library-v2 Phase 2).
// No `oras` binary. Anonymous token flow only (public repos). Every layer is
// written through ociCore.safeLayerPath, confined to destDir, with a per-blob
// size cap — the security spine for pulling untrusted artifacts.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseImageRef, safeLayerPath } from './ociCore.js';

export const MAX_BLOB_BYTES = 5_242_880; // 5 MiB/layer — loadout files are small.
const MANIFEST_ACCEPT = 'application/vnd.oci.image.manifest.v1+json';
const TIMEOUT_MS = 30_000;

interface OciLayer {
  digest: string;
  size?: number;
  annotations?: Record<string, string>;
}
interface OciManifest {
  annotations?: Record<string, string>;
  layers?: OciLayer[];
}

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/** Anonymous bearer via the 401 → WWW-Authenticate → /token flow. `repository`
 *  is the GHCR path after the host (e.g. owner/claude-fleet-loadouts/spec-driven). */
async function anonToken(repository: string, manifestUrl: string): Promise<string | null> {
  const { signal, done } = withTimeout();
  try {
    const probe = await fetch(manifestUrl, { headers: { Accept: MANIFEST_ACCEPT }, signal });
    if (probe.status !== 401) return null; // public-unauthed or already ok
    const www = probe.headers.get('WWW-Authenticate') ?? '';
    const realm = /realm="([^"]+)"/.exec(www)?.[1] ?? 'https://ghcr.io/token';
    const service = /service="([^"]+)"/.exec(www)?.[1] ?? 'ghcr.io';
    const scope = /scope="([^"]+)"/.exec(www)?.[1] ?? `repository:${repository}:pull`;
    const tokenUrl = `${realm}?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(scope)}`;
    const res = await fetch(tokenUrl, { signal });
    if (!res.ok) throw new Error(`token request failed (HTTP ${res.status})`);
    const body = (await res.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  } finally {
    done();
  }
}

async function fetchManifest(ref: string): Promise<{ manifest: OciManifest; repository: string; token: string | null }> {
  const { registry, repository, tag } = parseImageRef(ref);
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${tag}`;
  const token = await anonToken(repository, manifestUrl);
  const { signal, done } = withTimeout();
  try {
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(manifestUrl, { headers, signal });
    if (!res.ok) throw new Error(`manifest fetch failed for ${ref} (HTTP ${res.status})`);
    return { manifest: (await res.json()) as OciManifest, repository, token };
  } finally {
    done();
  }
}

/** Manifest annotations (the com.claude-fleet.loadout.* + org.opencontainers.* set)
 *  without pulling any blob. */
export async function fetchAnnotations(ref: string): Promise<Record<string, string>> {
  const { manifest } = await fetchManifest(ref);
  return manifest.annotations ?? {};
}

/** Pull every layer to destDir, each written at its
 *  org.opencontainers.image.title path via safeLayerPath. Aborts the whole pull
 *  on a traversal title or an over-cap blob. */
export async function pullArtifact(ref: string, destDir: string): Promise<void> {
  const { manifest, repository, token } = await fetchManifest(ref);
  const { registry } = parseImageRef(ref);
  const layers = manifest.layers ?? [];
  if (!layers.length) throw new Error(`artifact ${ref} has no layers`);
  for (const layer of layers) {
    const title = layer.annotations?.['org.opencontainers.image.title'];
    if (!title) throw new Error(`layer ${layer.digest} has no title annotation`);
    // safeLayerPath throws on ../absolute — that aborts the pull.
    const target = safeLayerPath(destDir, title);
    if (layer.size != null && layer.size > MAX_BLOB_BYTES) {
      throw new Error(`layer ${title} too large (${layer.size} > ${MAX_BLOB_BYTES})`);
    }
    const { signal, done } = withTimeout();
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`https://${registry}/v2/${repository}/blobs/${layer.digest}`, { headers, signal });
      if (!res.ok) throw new Error(`blob fetch failed for ${title} (HTTP ${res.status})`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
        throw new Error(`layer ${title} too large (${declared} > ${MAX_BLOB_BYTES})`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BLOB_BYTES) throw new Error(`layer ${title} too large (${buf.byteLength} > ${MAX_BLOB_BYTES})`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buf);
    } finally {
      done();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass + delete the stale `it.todo`s**

Delete lines 168–172 (the 5 `it.todo` specs) inside the `ociClient (GHCR pull)` block in `src/main/ociCore.test.ts`, leaving the empty `describe` or removing it.
Run: `npx vitest run src/main/ociClient.test.ts src/main/ociCore.test.ts`
Expected: PASS (ociClient tests green; ociCore tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/main/ociClient.ts src/main/ociClient.test.ts src/main/ociCore.test.ts
git commit -m "feat(loadouts): native anonymous GHCR pull client (ociClient)"
```

---

### Task 2: `loadoutSources.ts` — sources, indexes, download, provenance

**Files:**
- Create: `src/main/loadoutSources.ts`
- Test: `src/main/loadoutSources.test.ts`

**Interfaces:**
- Consumes: `pullArtifact`, `fetchAnnotations` (Task 1); `parseIndex`, `loadoutRefFromSource`, `compareVersions`, type `RemoteLoadout` (`./ociCore.js`); `loadoutsRoot`, `loadoutDir` (`./paths.js`); `listLoadouts` (`./loadouts.js`).
- Produces:
  - `listSources(): Promise<string[]>`
  - `addSource(base: string): Promise<RemoteLoadout[]>` (validates by pulling+parsing the index, persists, returns the index)
  - `removeSource(base: string): Promise<void>`
  - `browseSource(base: string, opts?: { refresh?: boolean }): Promise<RemoteLoadout[]>`
  - `allRemote(): Promise<{ source: string; loadouts: RemoteLoadout[] }[]>` (every source's index, failed sources skipped + logged)
  - `download(source: string, id: string, version?: string): Promise<void>` (pull into `loadoutDir(id)`, record provenance)
  - `provenanceFor(id: string): Promise<{ source: string; version: string } | null>`
  - `SourcesFile` type `{ sources: string[]; provenance: Record<string, { source: string; version: string; downloadedAt: number }> }`

- [ ] **Step 1: Write the failing tests** — `src/main/loadoutSources.test.ts`. Mock `ociClient` + electron paths:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/loadoutSources.test.ts`
Expected: FAIL — cannot import `./loadoutSources.js`.

- [ ] **Step 3: Implement `src/main/loadoutSources.ts`**

```ts
// Remote loadout sources (loadout-library-v2 Phase 2): persist the user's GHCR
// source list + per-loadout download provenance in <userData>/loadouts/sources.json,
// browse a source's index artifact, and download a loadout's artifact into the
// host-private library. Networking is in ociClient; pure helpers in ociCore.

import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { pullArtifact } from './ociClient.js';
import { parseIndex, loadoutRefFromSource, type RemoteLoadout } from './ociCore.js';
import { logError } from './errorLog.js';

export interface SourcesFile {
  sources: string[];
  provenance: Record<string, { source: string; version: string; downloadedAt: number }>;
}

function sourcesPath(): string {
  return join(loadoutsRoot(), 'sources.json');
}
function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

async function read(): Promise<SourcesFile> {
  try {
    const raw = await readFile(sourcesPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SourcesFile>;
    return {
      sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === 'string') : [],
      provenance: parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance : {}
    };
  } catch {
    return { sources: [], provenance: {} };
  }
}
async function write(next: SourcesFile): Promise<void> {
  await mkdir(loadoutsRoot(), { recursive: true });
  await writeFile(sourcesPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** Pull `<base>/index:latest` into a temp dir, parse + validate index.json. */
async function pullIndex(base: string): Promise<RemoteLoadout[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'cf-index-'));
  try {
    await pullArtifact(`${normalizeBase(base)}/index:latest`, tmp);
    return parseIndex(await readFile(join(tmp, 'index.json'), 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function listSources(): Promise<string[]> {
  return (await read()).sources;
}

export async function addSource(base: string): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const index = await pullIndex(b); // validates: throws on a bad/hostile index
  const cur = await read();
  if (!cur.sources.includes(b)) {
    await write({ ...cur, sources: [...cur.sources, b] });
  }
  indexCache.set(b, index);
  return index;
}

export async function removeSource(base: string): Promise<void> {
  const b = normalizeBase(base);
  const cur = await read();
  await write({ ...cur, sources: cur.sources.filter((s) => s !== b) });
  indexCache.delete(b);
}

const indexCache = new Map<string, RemoteLoadout[]>();

export async function browseSource(base: string, opts: { refresh?: boolean } = {}): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  if (!opts.refresh && indexCache.has(b)) return indexCache.get(b)!;
  const index = await pullIndex(b);
  indexCache.set(b, index);
  return index;
}

/** Every configured source's index, failed sources skipped (logged), for the catalog. */
export async function allRemote(): Promise<{ source: string; loadouts: RemoteLoadout[] }[]> {
  const srcs = await listSources();
  const out: { source: string; loadouts: RemoteLoadout[] }[] = [];
  for (const source of srcs) {
    try {
      out.push({ source, loadouts: await browseSource(source) });
    } catch (err) {
      logError('loadoutSources.allRemote', `source ${source} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

export async function provenanceFor(id: string): Promise<{ source: string; version: string } | null> {
  const p = (await read()).provenance[id];
  return p ? { source: p.source, version: p.version } : null;
}

/** Pull a loadout's artifact into <userData>/loadouts/<id>/ and record provenance. */
export async function download(source: string, id: string, version?: string): Promise<void> {
  const b = normalizeBase(source);
  const ref = loadoutRefFromSource(b, id, version);
  await pullArtifact(ref, loadoutDir(id));
  const cur = await read();
  await write({
    ...cur,
    provenance: { ...cur.provenance, [id]: { source: b, version: version ?? 'latest', downloadedAt: Date.now() } }
  });
}
```

> Match `logError`'s actual signature from `src/main/errorLog.ts` (the explore shows `logError`/`getLogPath` exist); adjust the call if its arity differs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/loadoutSources.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/loadoutSources.ts src/main/loadoutSources.test.ts
git commit -m "feat(loadouts): remote sources + index browsing + download/provenance"
```

---

### Task 3: Catalog merges remote sources; pull-if-needed install

**Files:**
- Modify: `src/main/loadoutCatalog.ts`
- Create: `src/main/loadoutInstall.ts` (the pull-if-needed wrapper)
- Test: `src/main/loadoutInstall.test.ts`

**Interfaces:**
- Consumes: `allRemote`, `provenanceFor`, `download` (Task 2); `listLoadouts`, `installLoadout` (`./loadouts.js`); `loadoutDir` (`./paths.js`); `assembleCatalog` (`./ociCore.js`).
- Produces:
  - `loadoutCatalog.ts`: `buildLoadoutCatalog` now passes `remote: await allRemote()`.
  - `loadoutInstall.ts`: `ensureAndInstall(workspaceId: string, id: string, opts?: { source?: string; version?: string; force?: boolean }): Promise<{ status: 'installed' } | { status: 'needs-confirm'; reason: string }>` — downloads if absent/stale, then `installLoadout`; collision-confirm for a locally-authored id.

- [ ] **Step 1: Extend `buildLoadoutCatalog`** in `src/main/loadoutCatalog.ts` — change the `remote: []` to real sources:

Replace the import line and the `assembleCatalog` call:
```ts
import { allRemote } from './loadoutSources.js';
```
```ts
  const remote = await allRemote();
  return assembleCatalog({ local, installed, favorites, remote });
```
(Keep the rest of the Phase 1 function unchanged; `allRemote` skips failed sources so an offline/empty config yields `[]`, preserving current behavior.)

- [ ] **Step 2: Write the failing test** — `src/main/loadoutInstall.test.ts`:

```ts
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
```

- [ ] **Step 3: Implement `src/main/loadoutInstall.ts`**

```ts
// Pull-if-needed install (loadout-library-v2 Phase 2). There is no standalone
// "download" state: installing a loadout downloads its artifact first if it is
// absent (or a different version than what's recorded), then runs the existing
// installLoadout. A collision with a LOCALLY-AUTHORED loadout (present on disk
// but with no download provenance) is confirm-before-overwrite, never silent.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadoutDir } from './paths.js';
import { installLoadout } from './loadouts.js';
import { download, provenanceFor } from './loadoutSources.js';

async function presentLocally(id: string): Promise<boolean> {
  try {
    await stat(join(loadoutDir(id), 'loadout.md'));
    return true;
  } catch {
    return false;
  }
}

export async function ensureAndInstall(
  workspaceId: string,
  id: string,
  opts: { source?: string; version?: string; force?: boolean } = {}
): Promise<{ status: 'installed' } | { status: 'needs-confirm'; reason: string }> {
  const present = await presentLocally(id);
  const prov = await provenanceFor(id);

  if (present && !prov && opts.source && !opts.force) {
    // On disk but never downloaded by us ⇒ locally authored. Don't clobber.
    return { status: 'needs-confirm', reason: `"${id}" already exists as a local loadout` };
  }

  // Download when: absent, OR a remote install of a different version than recorded.
  const needsPull =
    !!opts.source && (!present || opts.force || (prov?.version !== undefined && opts.version !== undefined && prov.version !== opts.version));
  if (needsPull && opts.source) {
    await download(opts.source, id, opts.version);
  }

  await installLoadout(workspaceId, id);
  return { status: 'installed' };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/main/loadoutInstall.test.ts && npm run typecheck:node`
Expected: PASS (3 tests) + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/main/loadoutCatalog.ts src/main/loadoutInstall.ts src/main/loadoutInstall.test.ts
git commit -m "feat(loadouts): catalog merges remote sources; pull-if-needed install"
```

---

### Task 4: IPC + preload

**Files:**
- Modify: `src/main/ipc.ts` (loadouts handler block ~line 879–894)
- Modify: `src/preload/index.ts` (the `loadouts` API ~line 335)

**Interfaces:**
- Consumes: `listSources`/`addSource`/`removeSource`/`browseSource` (Task 2); `ensureAndInstall` (Task 3).
- Produces (preload `window.api.loadouts`): `listSources()`, `addSource(base)`, `removeSource(base)`, `refreshSource(base)`, `install(workspaceId, id, opts?)` revised to call `ensureAndInstall` and return `{status}`.

- [ ] **Step 1: Add IPC handlers** in `src/main/ipc.ts`, in the loadouts block:

```ts
ipcMain.handle('loadouts:listSources', () => loadoutSources.listSources());
ipcMain.handle('loadouts:addSource', (_e, base: string) => loadoutSources.addSource(base));
ipcMain.handle('loadouts:removeSource', (_e, base: string) => loadoutSources.removeSource(base));
ipcMain.handle('loadouts:refreshSource', (_e, base: string) => loadoutSources.browseSource(base, { refresh: true }));
```
Revise the existing `loadouts:install` handler to the pull-if-needed path:
```ts
ipcMain.handle('loadouts:install', (_e, workspaceId: string, loadoutId: string, opts?: { source?: string; version?: string; force?: boolean }) =>
  ensureAndInstall(workspaceId, loadoutId, opts ?? {})
);
```
Add imports:
```ts
import * as loadoutSources from './loadoutSources.js';
import { ensureAndInstall } from './loadoutInstall.js';
```

- [ ] **Step 2: Add preload methods** in `src/preload/index.ts`, inside `loadouts`:

```ts
listSources: (): Promise<string[]> => ipcRenderer.invoke('loadouts:listSources'),
addSource: (
  base: string
): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
  ipcRenderer.invoke('loadouts:addSource', base),
removeSource: (base: string): Promise<void> => ipcRenderer.invoke('loadouts:removeSource', base),
refreshSource: (
  base: string
): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
  ipcRenderer.invoke('loadouts:refreshSource', base),
```
Revise the existing `install` method signature to forward opts:
```ts
install: (
  workspaceId: string,
  loadoutId: string,
  opts?: { source?: string; version?: string; force?: boolean }
): Promise<{ status: 'installed' } | { status: 'needs-confirm'; reason: string }> =>
  ipcRenderer.invoke('loadouts:install', workspaceId, loadoutId, opts),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (Renderer callers of `install` that ignore the return value still typecheck; callers that read the old `unknown` return must be checked — `LibraryPane.doInstall`/`LoadoutBrowserModal.onInstall` discard the result, so they're unaffected at this step; Task 5/6 update them to handle `needs-confirm`.)

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat(loadouts): IPC + preload for sources + pull-if-needed install"
```

---

### Task 5: Browser modal — source checkboxes + Add source + remote install

**Files:**
- Modify: `src/renderer/src/components/LoadoutBrowserModal.tsx`

**Interfaces:**
- Consumes: `window.api.loadouts.listSources`/`addSource`/`removeSource`/`catalog`/`install`. CatalogEntry already carries `sources: string[]`, `present`, `installed`.

- [ ] **Step 1: Add source facet + state.** In `LoadoutBrowserModal.tsx`, after the tag cloud in `.lb-facets`, add a sources section: list `sources` (from `listSources()` on mount) each with a checkbox (selected sources filter the results to entries whose `sources` intersect, plus always-present local entries), and an "+ Add source" inline input that calls `addSource(base)` then reloads. Add state:

```tsx
const [sources, setSources] = useState<string[]>([]);
const [selectedSources, setSelectedSources] = useState<string[]>([]);
const [addingSource, setAddingSource] = useState('');
const [sourceError, setSourceError] = useState<string | null>(null);

const reloadSources = useCallback(async () => { setSources(await window.api.loadouts.listSources()); }, []);
useEffect(() => { void reloadSources(); }, [reloadSources]);

const addSource = async (): Promise<void> => {
  const base = addingSource.trim();
  if (!base) return;
  setSourceError(null);
  try {
    await window.api.loadouts.addSource(base);
    setAddingSource('');
    await reloadSources();
    await reload(); // refresh catalog with the new source's entries
  } catch (err) {
    setSourceError((err as Error).message);
  }
};
```
Render (inside `.lb-facets`, after `.lb-tagcloud`):
```tsx
<div className="lb-sources">
  <div className="lb-sources-head">Sources</div>
  {sources.map((s) => (
    <label key={s} className="lb-source-row" title={s}>
      <input
        type="checkbox"
        checked={selectedSources.includes(s)}
        onChange={() =>
          setSelectedSources((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))
        }
      />
      <span className="lb-source-name">{s.replace(/^ghcr\.io\//, '')}</span>
      <button type="button" className="lb-source-remove" aria-label={`Remove ${s}`}
        onClick={async () => { await window.api.loadouts.removeSource(s); await reloadSources(); await reload(); }}>×</button>
    </label>
  ))}
  <div className="lb-add-source">
    <input placeholder="ghcr.io/owner/repo" value={addingSource} onChange={(e) => setAddingSource(e.target.value)} />
    <button type="button" onClick={() => void addSource()}>+ Add</button>
  </div>
  {sourceError && <div className="lb-source-error">{sourceError}</div>}
</div>
```

- [ ] **Step 2: Apply the source filter** to `filtered`:
```ts
const filtered = entries.filter((e) => {
  if (selectedSources.length && !e.present && !e.sources.some((s) => selectedSources.includes(s))) return false;
  if (activeTags.length && !activeTags.every((t) => e.tags.includes(t))) return false;
  if (query && !`${e.title} ${e.description}`.toLowerCase().includes(query.toLowerCase())) return false;
  return true;
});
```

- [ ] **Step 3: Remote install path.** Update `onInstall` to pass the entry's source + version and handle `needs-confirm`:
```ts
const onInstall = async (e: Entry): Promise<void> => {
  if (!workspace) return;
  const source = e.sources[0];
  const r = await window.api.loadouts.install(workspace.id, e.id, source ? { source, version: e.remoteVersion } : undefined);
  if (r && (r as { status?: string }).status === 'needs-confirm') {
    if (!window.confirm(`"${e.id}" already exists locally. Overwrite with the downloaded copy?`)) return;
    await window.api.loadouts.install(workspace.id, e.id, { source, version: e.remoteVersion, force: true });
  }
  onChanged();
  void reload();
};
```
Update the Install button to call `onInstall(e)` and to render for not-installed entries whether `present` or remote-only (`+ Install` for present, `↓ Install` for remote-only). Keep `✓ Installed` for installed.

- [ ] **Step 4: Typecheck + unit**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/LoadoutBrowserModal.tsx
git commit -m "feat(loadouts): browser modal source checkboxes + add-source + remote install"
```

---

### Task 6: Rail `Update ↑` affordance

**Files:**
- Modify: `src/renderer/src/components/LibraryPane.tsx`

**Interfaces:**
- Consumes: `e.updateAvailable`, `e.remoteVersion`, `e.sources`; `window.api.loadouts.install` (pull-if-needed with the newer version).

- [ ] **Step 1: Add an Update action** in the installed-card actions area. Where an installed entry renders the `✓ Installed` button + `⋮` menu, add — only when `e.updateAvailable` — an `Update ↑` button before the `⋮`:
```tsx
{e.updateAvailable && (
  <button
    className="btn update btn-sm"
    title={`Update to ${e.remoteVersion}`}
    disabled={!installable}
    onClick={async () => {
      const source = e.sources[0];
      if (!source) return;
      await window.api.loadouts.install(selectedWorkspace!.id, e.id, { source, version: e.remoteVersion, force: true });
      onChanged();
      void reload();
    }}
  >
    Update ↑
  </button>
)}
```
(`force: true` because update re-pulls over the present copy; the present copy has provenance, so no confirm.)

- [ ] **Step 2: Typecheck + unit**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/LibraryPane.tsx
git commit -m "feat(loadouts): rail Update affordance for a newer remote version"
```

---

### Task 7: Styles, SPEC, e2e (mocked), live smoke pull

**Files:**
- Modify: `src/renderer/src/styles.css`
- Modify: `docs/SPEC.md` (§7 Phase 2; move the §11 Open-decisions entry)
- Modify: `tests/loadout-library.spec.ts` + `tests/_helpers.ts` (mocked source IPC + an entry with `updateAvailable`)
- Create: `tests/oci-live.spec.ts` (one real pull, gated)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Styles** — append to `styles.css` (reuse `--ok`/`--rule`/`--bg-3`/`--ink-2`/`--warn`/`--r-sm`):
```css
/* Loadout sources + update (library v2 Phase 2) */
.lb-sources { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.lb-sources-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2); }
.lb-source-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-1); }
.lb-source-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-source-remove { border: none; background: none; color: var(--ink-2); cursor: pointer; font-size: 14px; }
.lb-add-source { display: flex; gap: 4px; margin-top: 4px; }
.lb-add-source input { flex: 1; min-width: 0; }
.lb-source-error { font-size: 11px; color: var(--danger); }
.btn.update { background: color-mix(in oklch, var(--warn) 22%, transparent); color: var(--warn); border-color: var(--warn); }
```

- [ ] **Step 2: SPEC** — in `docs/SPEC.md` §7, document: `ociClient` (anon token flow, `pullArtifact`/`fetchAnnotations`, `safeLayerPath` + size cap), `loadoutSources` (`sources.json` shape, add/remove/browse, `download` + provenance), the catalog's `remote` merge, pull-if-needed install + collision-confirm, the new IPC, and the modal source checkboxes + rail `Update ↑`. Update the §11 "Loadout library v2" entry: **Phase 2 (remote OCI sources) implemented; the paired index publisher shipped in claude-fleet-loadouts.** Note the §9 invariant (downloads host-private, never bind-mounted; size cap + traversal abort).

- [ ] **Step 3: Mocked e2e** — extend `tests/_helpers.ts` to register `loadouts:listSources` (return `opts.loadoutSources ?? []`), `loadouts:addSource`/`removeSource`/`refreshSource` (record + return), and accept a catalog entry with `updateAvailable: true`. In `tests/loadout-library.spec.ts` add a v2 test: with a source configured + a catalog entry whose `sources` includes it and `updateAvailable: true`, the browser modal lists the source checkbox and the rail shows `Update ↑`. Follow the existing mocked-launch pattern (plain `launch()` + `mockMainIpc`).

- [ ] **Step 4: Live smoke pull** — `tests/oci-live.spec.ts`. A single real pull of the now-published index, gated to skip offline:
```ts
import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SKIP = !!process.env.NO_NETWORK;

test.skip(SKIP, 'NO_NETWORK set — skipping live GHCR pull');
test('live: pulls the published claude-fleet-loadouts index from GHCR', async () => {
  // Import the built client directly (no Electron needed for a pure fetch).
  const { pullArtifact } = await import('../out/main/ociClient.js').catch(async () => await import('../src/main/ociClient.ts'));
  const dest = await mkdtemp(join(tmpdir(), 'oci-live-'));
  try {
    await pullArtifact('ghcr.io/imioimi/claude-fleet-loadouts/index:latest', dest);
    const index = JSON.parse(await readFile(join(dest, 'index.json'), 'utf8'));
    expect(Array.isArray(index)).toBe(true);
    expect(index.map((l: { id: string }) => l.id)).toContain('spec-driven');
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
```
> Adjust the import path to however the e2e harness loads built main modules; if importing the source `.ts` is simplest under the Playwright/ts setup, use that. The goal: one real anonymous pull that proves the token→manifest→blob flow against the live index.

- [ ] **Step 5: Full verify + commit**

Run: `npm run typecheck && npm run test:unit && npm run build`
Then locally (network permitting): `npx playwright test tests/oci-live.spec.ts` — if Electron/display blocks the harness, rely on CI.
```bash
git add -A
git commit -m "feat(loadouts): styles + SPEC + e2e + live smoke pull for library v2 phase 2"
```

---

## Self-review notes
- **Coverage vs `it.todo` specs:** token flow / annotations-without-blobs / tree reconstruction / traversal abort / size cap → Task 1. add/remove/browse / download+provenance / pull-if-absent-or-stale / collision-confirm / §9 host-private → Tasks 2–3. favorites + favorites-filter were Phase 1 (already shipped). The §9 no-bind-mount invariant is satisfied structurally (downloads only ever target `loadoutDir(id)` under `<userData>/loadouts`); asserted by the loadoutSources download test + documented in SPEC.
- **Type consistency:** `ensureAndInstall` return `{status:'installed'}|{status:'needs-confirm',reason}` is identical in Task 3 (impl), Task 4 (preload), Tasks 5–6 (callers). `RemoteLoadout`/`CatalogEntry` come from `ociCore.ts` (single source). Source base normalization (`replace(/\/+$/,'')`) is shared via `loadoutSources`.
- **Security:** every pulled byte routes through `safeLayerPath` + size cap (Task 1), confined to `<userData>/loadouts/<id>`; no credentials; non-GHCR refs rejected by `parseImageRef`.
- **YAGNI:** no private registries, no background polling, no auto-update, no publishing-from-app — all out of scope per the design.
