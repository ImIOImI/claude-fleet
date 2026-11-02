# Private Loadout Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a loadout source be a private OCI registry (e.g. a private `ghcr.io/<org>/claude-fleet-loadouts`): the user adds a per-source token once, and browse / install / update then work like a public source (issue #444).

**Architecture:** The per-source token lives in the existing safeStorage vault under scope `loadout-source:<base>`, and `sources.json` only records that a token exists. `loadoutSources.credentialFor(base)` resolves a credential (vault, then env, then a GitHub-token seam that is empty today, then anonymous) and passes it to `ociClient`. `ociClient` then runs the Docker/OCI token flow with Basic credentials, or falls back to a static Bearer token. Auth failures cross IPC as message-prefixed errors (`needs-credential: <base>` / `credential-rejected: <base> (HTTP <n>)`). The renderer parses these to show a token prompt in the browser modal.

**Tech Stack:** Electron main (Node 22 `fetch`), TypeScript, vitest (unit), Playwright (e2e, CI only), React renderer.

**Spec:** `docs/superpowers/specs/2026-11-02-private-loadout-sources-design.md`

## Global Constraints

- A token is **never** written to `sources.json`, logged, put in an error message, sent to the renderer (no read path), or passed to any container. Errors name the source, not the token.
- Vault scope `loadout-source:<normalised base>`, key `TOKEN`. Same `secrets.enc`, envelope and lock as workspace and endpoint secrets. Removing a source purges its scope.
- `sources.json` keeps `sources: string[]` and gains `credentials: Record<base, { username?: string }>`. A file without `credentials` reads as `{}`.
- Token exchange header: `Authorization: Basic base64(<username or "token">:<TOKEN>)`.
- Basic credentials go to a realm only when the realm is `https:` on the registry's own host or a known pairing (`ghcr.io` → `ghcr.io`, i.e. `ghcr.io/token`). Any other realm is asked anonymously.
- Static-token fallback: if the probe returns 401 with no `WWW-Authenticate` realm, or the token exchange is answered 401/403, send `Authorization: Bearer <TOKEN>` on the manifest/blob requests. These go to the registry host only.
- Resolution order in `credentialFor(base)`:
  1. vault token;
  2. `FLEET_LOADOUT_TOKEN_<SANITISED_BASE>`;
  3. (`ghcr.io/` bases only) the signed-in GitHub token via `setGithubTokenProvider` (no provider is registered: GitHub sign-in is out of scope);
  4. `FLEET_LOADOUT_TOKEN` (non-default sources only);
  5. none.
- IPC error contract (exact strings): `needs-credential: <base>` and `credential-rejected: <base> (HTTP <n>)`.
- UI copy (exact):
  - prompt: "This source is private. Add a token:";
  - rejection: "credential rejected (HTTP 401)" / "(HTTP 403)";
  - row actions: "Change token…", "Remove token";
  - badge: 🔒.
- The registry stays pinned to `ghcr.io` (`ociCore.parseImageRef` is unchanged). Widening registries is not part of this plan.
- **Do not build GitHub sign-in.** The only seam is `setGithubTokenProvider(fn | undefined)`.
- **Do not build a headless pin mechanism.** `FLEET_LOADOUTS` does not exist today. The env steps of `credentialFor` are the hook.
- `.claude/rules/spec-maintenance.md`: this changes IPC, a data model and the security model, so `docs/SPEC.md` is updated in the same PR (Task 9).

## Before you start (execution environment)

Run all commands from your own feature worktree. Never `cd /workspace/claude-fleet` (that's the shared main checkout).

```bash
git -C /workspace/claude-fleet fetch -q origin
git -C /workspace/claude-fleet worktree add -b feat/private-loadout-sources /workspace/claude-fleet/.claude/worktrees/private-sources origin/main
export WT=/workspace/claude-fleet/.claude/worktrees/private-sources
cd "$WT" && npm ci --ignore-scripts --no-audit --no-fund && printf 'electron-stub' > node_modules/electron/path.txt
```

Gates used throughout:
- Unit tests: `cd "$WT" && npx vitest run <file>`. better-sqlite3 loads from its prebuilds with the setup above.
- Typecheck: run **both configs separately**, because `npm run typecheck` short-circuits:
  - `cd "$WT" && npx tsc --noEmit -p tsconfig.node.json`
  - `cd "$WT" && npx tsc --noEmit -p tsconfig.web.json`
- e2e (Playwright) and UI can't run in this container (no display). CI and Troy's host check are the gate. Say so in the PR.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/main/ociCore.ts` | modify | Pure additions: `RegistryCredential`, `RegistryAuthError`, `KNOWN_REALM_HOSTS`, `realmMayReceiveCredential` |
| `src/main/ociCore.test.ts` | modify | Tests for the pure additions |
| `src/main/ociClient.ts` | modify | `registryToken` (Basic exchange, static Bearer fallback, cross-host guard), typed errors, `cred` option on `pullArtifact`/`fetchAnnotations` |
| `src/main/ociClient.test.ts` | rewrite | Fake registry behind a `fetch` stub: public, private, wrong token, static bearer, cross-host realm |
| `src/main/vaultScopes.ts` | create | Pure: `SOURCE_VAULT_PREFIX`, `SOURCE_VAULT_KEY`, `sourceVaultScope`, `assertRendererVaultScope` |
| `src/main/vaultScopes.test.ts` | create | Tests for the above |
| `src/main/loadoutSources.ts` | modify | `credentials` map, `credentialFor`, `sourceEnvVarName`, `setGithubTokenProvider`, `addSource(base, cred?)`, `setSourceCredential`, `listSourceInfo`, purge on remove, typed-error mapping |
| `src/main/loadoutSources.test.ts` | modify | Vault mock, private-index mock, resolution + flow tests |
| `src/main/ipc.ts` | modify | `loadouts:listSources` / `addSource` / `setSourceCredential`; vault-scope guard on `vault:*` |
| `src/preload/index.ts` | modify | Typed `listSources`, `addSource(base, cred?)`, `setSourceCredential` |
| `src/renderer/src/sourceErrors.ts` | create | Pure parser for the IPC error contract |
| `src/renderer/src/sourceErrors.test.ts` | create | Tests for the parser |
| `src/renderer/src/components/LoadoutBrowserModal.tsx` | modify | Token prompt, 🔒 badge, Change/Remove token |
| `src/renderer/src/styles.css` | modify | `.lb-source-item`, `.lb-source-lock`, `.lb-source-cred-actions`, `.lb-cred*` |
| `tests/_helpers.ts` | modify | `mockMainIpc`: object-shaped `listSources`, `privateLoadoutSources`, `setSourceCredential` |
| `tests/loadout-library.spec.ts` | modify | e2e: credential prompt on a private source |
| `docs/SPEC.md` | modify | §7 Vault layout, §7 Loadout library v2 Phase 2 (client, sources.json, IPC, modal), §9 |

---

### Task 1: Pure auth primitives in `ociCore.ts`

**Files:**
- Modify: `src/main/ociCore.ts` (append after `safeLayerPath`, before `export interface RemoteLoadout`)
- Test: `src/main/ociCore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RegistryCredential { token: string; username?: string }`
  - `type RegistryAuthKind = 'needs-credential' | 'credential-rejected'`
  - `class RegistryAuthError extends Error { readonly kind: RegistryAuthKind; readonly status: number }`. `name === 'RegistryAuthError'`. The message is `registry requires a credential (HTTP <n>)` or `credential rejected (HTTP <n>)`.
  - `const KNOWN_REALM_HOSTS: Readonly<Record<string, readonly string[]>>`
  - `function realmMayReceiveCredential(registryHost: string, realm: string): boolean`

- [ ] **Step 1: Write the failing tests**

In `src/main/ociCore.test.ts`, extend the existing import from `'./ociCore.js'` to add `RegistryAuthError` and `realmMayReceiveCredential`. Then append:

```ts
describe('realmMayReceiveCredential (#444)', () => {
  it('allows an https realm on the registry host', () => {
    expect(realmMayReceiveCredential('ghcr.io', 'https://ghcr.io/token')).toBe(true);
  });
  it('allows a known cross-host pairing', () => {
    expect(realmMayReceiveCredential('registry-1.docker.io', 'https://auth.docker.io/token')).toBe(true);
  });
  it('refuses a realm on a different host', () => {
    expect(realmMayReceiveCredential('ghcr.io', 'https://evil.example/token')).toBe(false);
  });
  it('refuses a lookalike host', () => {
    expect(realmMayReceiveCredential('ghcr.io', 'https://ghcr.io.evil.example/token')).toBe(false);
  });
  it('refuses plain http even on the registry host', () => {
    expect(realmMayReceiveCredential('ghcr.io', 'http://ghcr.io/token')).toBe(false);
  });
  it('refuses an unparseable realm', () => {
    expect(realmMayReceiveCredential('ghcr.io', 'not a url')).toBe(false);
  });
});

describe('RegistryAuthError (#444)', () => {
  it('carries kind + status and a token-free message', () => {
    const a = new RegistryAuthError('needs-credential', 401);
    expect(a).toBeInstanceOf(Error);
    expect(a).toMatchObject({ name: 'RegistryAuthError', kind: 'needs-credential', status: 401 });
    expect(a.message).toBe('registry requires a credential (HTTP 401)');
    expect(new RegistryAuthError('credential-rejected', 403).message).toBe('credential rejected (HTTP 403)');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "$WT" && npx vitest run src/main/ociCore.test.ts`
Expected: FAIL. `realmMayReceiveCredential` / `RegistryAuthError` are not exported (`is not a function` / `is not a constructor`).

- [ ] **Step 3: Implement**

Append to `src/main/ociCore.ts` immediately after the `safeLayerPath` function:

```ts
/** A loadout source's credential (#444). `username` defaults to "token" in the
 *  Basic exchange (GHCR, GitLab and Harbor accept any username with a token). */
export interface RegistryCredential {
  token: string;
  username?: string;
}

export type RegistryAuthKind = 'needs-credential' | 'credential-rejected';

/**
 * A registry refused us. `needs-credential` = we sent no credential;
 * `credential-rejected` = we sent one and it was refused. The message never
 * contains the token, only the HTTP status.
 */
export class RegistryAuthError extends Error {
  readonly kind: RegistryAuthKind;
  readonly status: number;
  constructor(kind: RegistryAuthKind, status: number) {
    super(
      kind === 'needs-credential'
        ? `registry requires a credential (HTTP ${status})`
        : `credential rejected (HTTP ${status})`
    );
    this.name = 'RegistryAuthError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Registry host → token-realm hosts that may receive its Basic credentials
 * besides the registry host itself. Anything not listed is asked anonymously,
 * so a hostile WWW-Authenticate can't redirect a source's token.
 */
export const KNOWN_REALM_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'ghcr.io': ['ghcr.io'],
  'registry-1.docker.io': ['auth.docker.io']
};

/** True when `realm` may receive the registry's Basic credentials: https, and
 *  either the registry's own host or a KNOWN_REALM_HOSTS pairing. */
export function realmMayReceiveCredential(registryHost: string, realm: string): boolean {
  let u: URL;
  try {
    u = new URL(realm);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.host.toLowerCase();
  const reg = registryHost.toLowerCase();
  return host === reg || (KNOWN_REALM_HOSTS[reg] ?? []).includes(host);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "$WT" && npx vitest run src/main/ociCore.test.ts`
Expected: PASS (all existing ociCore tests plus the 7 new ones).

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add src/main/ociCore.ts src/main/ociCore.test.ts
git -C "$WT" commit -m "feat(loadouts): registry auth error + realm credential guard (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Credentialed token flow in `ociClient.ts`

**Files:**
- Modify: `src/main/ociClient.ts`
- Rewrite: `src/main/ociClient.test.ts`

**Interfaces:**
- Consumes (Task 1): `RegistryCredential`, `RegistryAuthError`, `realmMayReceiveCredential` from `./ociCore.js`.
- Produces:
  - `interface PullOpts { cred?: RegistryCredential | null }`
  - `fetchAnnotations(ref: string, opts?: PullOpts): Promise<Record<string, string>>`
  - `pullArtifact(ref: string, destDir: string, opts?: PullOpts): Promise<void>`
  - Both reject with `RegistryAuthError` on a 401/403 manifest response.

**Test approach:** the existing suite stubs global `fetch` (`vi.stubGlobal`). `parseImageRef` pins `https://ghcr.io`, so a `fetch` stub reaches a fake registry without adding an http-scheme or host seam to product code. Keep that pattern: the "local fake registry" is a `fetch`-level router, not an `http.Server`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `src/main/ociClient.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd "$WT" && npx vitest run src/main/ociClient.test.ts`
Expected: the 4 original tests PASS. The `#444` tests FAIL: today's client ignores `opts` and throws a plain `Error('manifest fetch failed … (HTTP 401)')`, so `toMatchObject({ name: 'RegistryAuthError' })` fails and no Basic header is sent.

- [ ] **Step 3: Implement**

Replace the whole of `src/main/ociClient.ts` with:

```ts
// Native, zero-dependency OCI pull for GHCR loadout sources (loadout-library-v2
// Phase 2; private sources #444). No `oras` binary. Docker/OCI token flow:
// anonymous for public repos; with a per-source credential, Basic auth at the
// token realm (only an https realm on the registry host or a known pairing —
// ociCore.realmMayReceiveCredential) or a static Bearer for registries without a
// realm. Every layer is written through ociCore.safeLayerPath, confined to
// destDir, with a per-blob size cap: the security spine for untrusted artifacts.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  parseImageRef,
  safeLayerPath,
  RegistryAuthError,
  realmMayReceiveCredential,
  type RegistryCredential
} from './ociCore.js';

export const MAX_BLOB_BYTES = 5_242_880; // 5 MiB/layer — loadout files are small.
const MANIFEST_ACCEPT = 'application/vnd.oci.image.manifest.v1+json';
const TIMEOUT_MS = 30_000;

export interface PullOpts {
  /** The source's credential (loadoutSources.credentialFor); absent ⇒ anonymous. */
  cred?: RegistryCredential | null;
}

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

const isAuthStatus = (status: number): boolean => status === 401 || status === 403;

/**
 * The Authorization header value for the manifest + blob fetches, or null when
 * the registry needs none. Probe → 401 → WWW-Authenticate realm → token. With
 * `cred`: Basic at the realm when the realm may receive it; a direct
 * `Bearer <token>` when there is no realm or the exchange refuses the
 * credential (static-token registries — that header only goes to the registry).
 */
async function registryToken(
  repository: string,
  manifestUrl: string,
  cred?: RegistryCredential | null
): Promise<string | null> {
  const { signal, done } = withTimeout();
  try {
    const probe = await fetch(manifestUrl, { headers: { Accept: MANIFEST_ACCEPT }, signal });
    if (probe.status !== 401) return null; // public-unauthed or already ok; 403/404 surface on the real fetch
    const www = probe.headers.get('WWW-Authenticate') ?? '';
    const advertised = /realm="([^"]+)"/.exec(www)?.[1];
    if (!advertised && cred) return `Bearer ${cred.token}`;
    const realm = advertised ?? 'https://ghcr.io/token';
    const service = /service="([^"]+)"/.exec(www)?.[1] ?? 'ghcr.io';
    const scope = /scope="([^"]+)"/.exec(www)?.[1] ?? `repository:${repository}:pull`;
    const tokenUrl = `${realm}?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(scope)}`;
    const headers: Record<string, string> = {};
    if (cred && realmMayReceiveCredential(new URL(manifestUrl).host, realm)) {
      const basic = Buffer.from(`${cred.username || 'token'}:${cred.token}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
    const res = await fetch(tokenUrl, { headers, signal });
    if (!res.ok) {
      if (isAuthStatus(res.status)) {
        if (cred) return `Bearer ${cred.token}`;
        throw new RegistryAuthError('needs-credential', res.status);
      }
      throw new Error(`token request failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    return token ? `Bearer ${token}` : null;
  } finally {
    done();
  }
}

async function fetchManifest(
  ref: string,
  cred?: RegistryCredential | null
): Promise<{ manifest: OciManifest; repository: string; auth: string | null }> {
  const { registry, repository, tag } = parseImageRef(ref);
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${tag}`;
  const auth = await registryToken(repository, manifestUrl, cred);
  const { signal, done } = withTimeout();
  try {
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
    if (auth) headers['Authorization'] = auth;
    const res = await fetch(manifestUrl, { headers, signal });
    if (isAuthStatus(res.status)) {
      throw new RegistryAuthError(cred ? 'credential-rejected' : 'needs-credential', res.status);
    }
    if (!res.ok) throw new Error(`manifest fetch failed for ${ref} (HTTP ${res.status})`);
    return { manifest: (await res.json()) as OciManifest, repository, auth };
  } finally {
    done();
  }
}

/** Manifest annotations (the com.claude-fleet.loadout.* + org.opencontainers.* set)
 *  without pulling any blob. */
export async function fetchAnnotations(ref: string, opts: PullOpts = {}): Promise<Record<string, string>> {
  const { manifest } = await fetchManifest(ref, opts.cred);
  return manifest.annotations ?? {};
}

/** Pull every layer to destDir, each written at its
 *  org.opencontainers.image.title path via safeLayerPath. Aborts the whole pull
 *  on a traversal title or an over-cap blob. */
export async function pullArtifact(ref: string, destDir: string, opts: PullOpts = {}): Promise<void> {
  const { manifest, repository, auth } = await fetchManifest(ref, opts.cred);
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
      if (auth) headers['Authorization'] = auth;
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "$WT" && npx vitest run src/main/ociClient.test.ts src/main/ociCore.test.ts`
Expected: PASS (11 ociClient tests plus the ociCore suite).

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add src/main/ociClient.ts src/main/ociClient.test.ts
git -C "$WT" commit -m "feat(loadouts): credentialed OCI token flow + static-bearer fallback (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Host-only vault scope + guard on the generic `vault:*` IPC

**Files:**
- Create: `src/main/vaultScopes.ts`
- Create: `src/main/vaultScopes.test.ts`
- Modify: `src/main/ipc.ts` (the `vault:*` handlers, around lines 1852–1865; the imports near line 75)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SOURCE_VAULT_PREFIX = 'loadout-source:'`
  - `SOURCE_VAULT_KEY = 'TOKEN'`
  - `sourceVaultScope(normalisedBase: string): string`
  - `assertRendererVaultScope(scope: unknown): void` (throws `vault scope is host-only`)

Why: `vault:getSecret(scope, key)` takes an arbitrary scope string. Without this guard the renderer could read `loadout-source:<base>`/`TOKEN` back, which breaks the spec's "write but never read" rule.

- [ ] **Step 1: Write the failing test**

Create `src/main/vaultScopes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SOURCE_VAULT_KEY, SOURCE_VAULT_PREFIX, sourceVaultScope, assertRendererVaultScope } from './vaultScopes.js';

describe('vaultScopes (#444)', () => {
  it('names a source scope by its normalised base', () => {
    expect(SOURCE_VAULT_PREFIX).toBe('loadout-source:');
    expect(SOURCE_VAULT_KEY).toBe('TOKEN');
    expect(sourceVaultScope('ghcr.io/acme/loadouts')).toBe('loadout-source:ghcr.io/acme/loadouts');
  });

  it('refuses loadout-source scopes on the renderer vault surface', () => {
    expect(() => assertRendererVaultScope('loadout-source:ghcr.io/acme/loadouts')).toThrow(/host-only/);
  });

  it('allows workspace and endpoint scopes', () => {
    expect(() => assertRendererVaultScope('01HZXYWORKSPACEULID0000000')).not.toThrow();
    expect(() => assertRendererVaultScope('endpoint:3f0c')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "$WT" && npx vitest run src/main/vaultScopes.test.ts`
Expected: FAIL, `Failed to load url ./vaultScopes.js`.

- [ ] **Step 3: Implement the module**

Create `src/main/vaultScopes.ts`:

```ts
// Vault scope naming for host-only secrets (#444). Pure — no electron — so it
// unit-tests in isolation and ipc.ts can guard the generic vault:* surface.
//
// Loadout-source tokens live in the same secrets.enc as workspace env and
// endpoint keys, under `loadout-source:<normalised base>` / `TOKEN`. The
// renderer may WRITE one (loadouts:addSource / loadouts:setSourceCredential)
// but must never read one back, so the generic vault:* IPC refuses the prefix.

export const SOURCE_VAULT_PREFIX = 'loadout-source:';
export const SOURCE_VAULT_KEY = 'TOKEN';

export function sourceVaultScope(normalisedBase: string): string {
  return `${SOURCE_VAULT_PREFIX}${normalisedBase}`;
}

/** Throw when a renderer-supplied vault scope names a host-only bag. */
export function assertRendererVaultScope(scope: unknown): void {
  if (typeof scope === 'string' && scope.startsWith(SOURCE_VAULT_PREFIX)) {
    throw new Error('vault scope is host-only');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "$WT" && npx vitest run src/main/vaultScopes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Guard the IPC handlers**

In `src/main/ipc.ts`, add after `import * as vault from './vault.js';`:

```ts
import { assertRendererVaultScope } from './vaultScopes.js';
```

Replace the block

```ts
  ipcMain.handle('vault:listKeys', (_e, workspaceId: string) => vault.listKeys(workspaceId));
  ipcMain.handle('vault:getSecret', (_e, workspaceId: string, key: string) =>
    vault.getSecret(workspaceId, key)
  );
  ipcMain.handle('vault:setSecret', (_e, workspaceId: string, key: string, value: string) =>
    vault.setSecret(workspaceId, key, value)
  );
  ipcMain.handle('vault:deleteSecret', (_e, workspaceId: string, key: string) =>
    vault.deleteSecret(workspaceId, key)
  );
  ipcMain.handle('vault:deleteAllForWorkspace', (_e, workspaceId: string) =>
    vault.deleteAllForWorkspace(workspaceId)
  );
```

with

```ts
  // Every scope-taking vault:* handler refuses host-only scopes
  // (loadout-source:*, #444) — those are written via loadouts:* and never read back.
  ipcMain.handle('vault:listKeys', (_e, workspaceId: string) => {
    assertRendererVaultScope(workspaceId);
    return vault.listKeys(workspaceId);
  });
  ipcMain.handle('vault:getSecret', (_e, workspaceId: string, key: string) => {
    assertRendererVaultScope(workspaceId);
    return vault.getSecret(workspaceId, key);
  });
  ipcMain.handle('vault:setSecret', (_e, workspaceId: string, key: string, value: string) => {
    assertRendererVaultScope(workspaceId);
    return vault.setSecret(workspaceId, key, value);
  });
  ipcMain.handle('vault:deleteSecret', (_e, workspaceId: string, key: string) => {
    assertRendererVaultScope(workspaceId);
    return vault.deleteSecret(workspaceId, key);
  });
  ipcMain.handle('vault:deleteAllForWorkspace', (_e, workspaceId: string) => {
    assertRendererVaultScope(workspaceId);
    return vault.deleteAllForWorkspace(workspaceId);
  });
```

- [ ] **Step 6: Typecheck the main config**

Run: `cd "$WT" && npx tsc --noEmit -p tsconfig.node.json`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add src/main/vaultScopes.ts src/main/vaultScopes.test.ts src/main/ipc.ts
git -C "$WT" commit -m "feat(vault): host-only loadout-source scope, refused on vault:* IPC (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `credentials` map + `credentialFor` resolution in `loadoutSources.ts`

**Files:**
- Modify: `src/main/loadoutSources.ts`
- Modify: `src/main/loadoutSources.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `RegistryCredential` from `./ociCore.js`.
  - Task 3: `sourceVaultScope`, `SOURCE_VAULT_KEY` from `./vaultScopes.js`.
  - `getSecret` from `./vault.js`.
- Produces:
  - `SourcesFile.credentials: Record<string, { username?: string }>`
  - `sourceEnvVarName(base: string): string`
  - `setGithubTokenProvider(fn: (() => Promise<string | null>) | undefined): void`
  - `credentialFor(base: string): Promise<RegistryCredential | null>`

- [ ] **Step 1: Replace the test file's header (mocks + hooks)**

In `src/main/loadoutSources.test.ts`, replace everything from the first line through the closing `});` of `afterEach` (i.e. everything before `describe('loadoutSources', () => {`) with:

```ts
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
```

- [ ] **Step 2: Append the resolution tests**

Append to the end of `src/main/loadoutSources.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd "$WT" && npx vitest run src/main/loadoutSources.test.ts`
Expected: FAIL. `sources.setGithubTokenProvider is not a function` is thrown in `beforeEach`.

- [ ] **Step 4: Implement**

In `src/main/loadoutSources.ts`:

(a) Replace the header comment and imports (everything through `import { logError } from './errorLog.js';`) with:

```ts
// Remote loadout sources (loadout-library-v2 Phase 2; private sources #444):
// persist the user's GHCR source list + per-loadout download provenance + which
// sources have a credential in <userData>/loadouts/sources.json, resolve a
// source's credential (vault → env → signed-in GitHub token → anonymous),
// browse a source's index artifact, and download a loadout's artifact into the
// host-private library. Networking is in ociClient; pure helpers in ociCore.
// Tokens live only in the vault (scope loadout-source:<base>) — never here.

import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { pullArtifact } from './ociClient.js';
import { parseIndex, loadoutRefFromSource, type RemoteLoadout, type RegistryCredential } from './ociCore.js';
import { getSecret } from './vault.js';
import { sourceVaultScope, SOURCE_VAULT_KEY } from './vaultScopes.js';
import { logError } from './errorLog.js';
```

(b) Replace the `SourcesFile` interface with:

```ts
export interface SourcesFile {
  sources: string[];
  provenance: Record<string, { source: string; version: string; downloadedAt: number }>;
  /** Sources that have a vault credential, plus its non-secret username. Never a token. */
  credentials: Record<string, { username?: string }>;
}
```

(c) Replace the whole `read()` function with:

```ts
function parseCredentials(v: unknown): SourcesFile['credentials'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: SourcesFile['credentials'] = {};
  for (const [base, entry] of Object.entries(v as Record<string, unknown>)) {
    const username = (entry as { username?: unknown } | null)?.username;
    out[base] = typeof username === 'string' && username ? { username } : {};
  }
  return out;
}

async function read(): Promise<SourcesFile> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath(), 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ENOENT') return { sources: [], provenance: {}, credentials: {} };
    const seeded: SourcesFile = { sources: [...DEFAULT_SOURCES], provenance: {}, credentials: {} };
    await write(seeded).catch(() => undefined); // still seeded for this read if the write fails
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SourcesFile>;
    return {
      sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === 'string') : [],
      provenance: parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance : {},
      credentials: parseCredentials(parsed.credentials)
    };
  } catch {
    return { sources: [], provenance: {}, credentials: {} };
  }
}
```

(d) Insert immediately after the `write()` function:

```ts
/** `FLEET_LOADOUT_TOKEN_<SANITISED_BASE>`: base upper-cased, every
 *  non-alphanumeric → `_` (headless/remote hosts, spec #444). */
export function sourceEnvVarName(base: string): string {
  return `FLEET_LOADOUT_TOKEN_${normalizeBase(base).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

let githubTokenProvider: (() => Promise<string | null>) | undefined;

/**
 * Extension point for GitHub sign-in (remote-workspaces sub-project (b)): once
 * registered, ghcr.io sources without a vault/env token use the signed-in
 * user's read:packages token. Nothing registers a provider yet.
 */
export function setGithubTokenProvider(fn: (() => Promise<string | null>) | undefined): void {
  githubTokenProvider = fn;
}

/**
 * Resolve a source's credential, main process only: the vault token, then the
 * per-source env var, then (ghcr.io only) the signed-in GitHub token, then
 * FLEET_LOADOUT_TOKEN for a non-default source, else null (anonymous).
 */
export async function credentialFor(base: string): Promise<RegistryCredential | null> {
  const b = normalizeBase(base);
  const vaultToken = await getSecret(sourceVaultScope(b), SOURCE_VAULT_KEY);
  if (vaultToken) {
    const username = (await read()).credentials[b]?.username;
    return username ? { token: vaultToken, username } : { token: vaultToken };
  }
  const envToken = process.env[sourceEnvVarName(b)];
  if (envToken) return { token: envToken };
  if (b.startsWith('ghcr.io/') && githubTokenProvider) {
    const gh = await githubTokenProvider();
    if (gh) return { token: gh };
  }
  const generic = process.env.FLEET_LOADOUT_TOKEN;
  if (generic && !DEFAULT_SOURCES.includes(b)) return { token: generic };
  return null;
}
```

`DEFAULT_SOURCES` is declared above `read()`, so `credentialFor` can reference it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "$WT" && npx vitest run src/main/loadoutSources.test.ts`
Expected: PASS (7 original tests plus 8 new ones).

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/main/loadoutSources.ts src/main/loadoutSources.test.ts
git -C "$WT" commit -m "feat(loadouts): per-source credential map + credentialFor resolution (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Credentialed add / browse / download / remove flows

**Files:**
- Modify: `src/main/loadoutSources.ts`
- Modify: `src/main/loadoutSources.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `RegistryAuthError` from `./ociCore.js`.
  - Task 2: `pullArtifact(ref, dest, { cred })`.
  - Task 3: `sourceVaultScope`, `SOURCE_VAULT_KEY`.
  - Task 4: `credentialFor`.
  - `setSecret`, `deleteAllForWorkspace` from `./vault.js`.
- Produces (Task 7 wires these to IPC):
  - `interface SourceInfo { base: string; hasCredential: boolean; username?: string }`
  - `interface SourceCredentialInput { token: string; username?: string }`
  - `listSourceInfo(): Promise<SourceInfo[]>`
  - `addSource(base: string, cred?: SourceCredentialInput): Promise<RemoteLoadout[]>`
  - `setSourceCredential(base: string, cred: SourceCredentialInput | null): Promise<RemoteLoadout[]>`
  - Error messages: `needs-credential: <base>` and `credential-rejected: <base> (HTTP <n>)`
  - `listSources(): Promise<string[]>` is unchanged (`roleBrief.ts` and `allRemote` still use it).

- [ ] **Step 1: Write the failing tests**

Append to `src/main/loadoutSources.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "$WT" && npx vitest run src/main/loadoutSources.test.ts`
Expected: FAIL. `sources.listSourceInfo is not a function` / `setSourceCredential is not a function`. `addSource` ignores `cred`, so the vault stays empty and the private pull rejects with a raw `RegistryAuthError` message.

- [ ] **Step 3: Implement**

In `src/main/loadoutSources.ts`:

(a) Change the imports added in Task 4 to:

```ts
import { parseIndex, loadoutRefFromSource, RegistryAuthError, type RemoteLoadout, type RegistryCredential } from './ociCore.js';
import { getSecret, setSecret, deleteAllForWorkspace } from './vault.js';
```

(b) Add after the `SourcesFile` interface:

```ts
/** What the renderer sees per source (loadouts:listSources). Never the token. */
export interface SourceInfo {
  base: string;
  hasCredential: boolean;
  username?: string;
}

/** What the renderer may submit (loadouts:addSource / setSourceCredential). */
export interface SourceCredentialInput {
  token: string;
  username?: string;
}
```

(c) Add after `credentialFor`:

```ts
/**
 * Map a registry auth failure to the IPC error contract. Electron carries only
 * an Error's message across ipcMain.handle, so the kind is a parseable prefix
 * (renderer: sourceErrors.ts). Names the source, never the token.
 */
async function withSourceAuth<T>(b: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RegistryAuthError) {
      throw new Error(
        err.kind === 'needs-credential' ? `needs-credential: ${b}` : `credential-rejected: ${b} (HTTP ${err.status})`
      );
    }
    throw err;
  }
}

function cleanCredential(cred: SourceCredentialInput): SourceCredentialInput {
  const token = typeof cred?.token === 'string' ? cred.token.trim() : '';
  if (!token) throw new Error('A token is required');
  const username = typeof cred.username === 'string' && cred.username.trim() ? cred.username.trim() : undefined;
  return username ? { token, username } : { token };
}

async function storeCredential(b: string, cred: SourceCredentialInput): Promise<void> {
  await setSecret(sourceVaultScope(b), SOURCE_VAULT_KEY, cred.token);
  const cur = await read();
  await write({ ...cur, credentials: { ...cur.credentials, [b]: cred.username ? { username: cred.username } : {} } });
}

async function clearCredential(b: string): Promise<void> {
  await deleteAllForWorkspace(sourceVaultScope(b));
  const cur = await read();
  if (!(b in cur.credentials)) return;
  const credentials = { ...cur.credentials };
  delete credentials[b];
  await write({ ...cur, credentials });
}
```

(d) Replace `pullIndex` with:

```ts
/** Pull `<base>/index:latest` (with the source's credential) into a temp dir,
 *  parse + validate index.json. */
async function pullIndex(base: string): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const cred: RegistryCredential | null = await credentialFor(b);
  const tmp = await mkdtemp(join(tmpdir(), 'cf-index-'));
  try {
    await withSourceAuth(b, () => pullArtifact(`${b}/index:latest`, tmp, { cred }));
    return parseIndex(await readFile(join(tmp, 'index.json'), 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
```

(e) Replace `addSource` and `removeSource` with the following. Also add `listSourceInfo` after `listSources`, and add `setSourceCredential`:

```ts
export async function listSourceInfo(): Promise<SourceInfo[]> {
  const { sources, credentials } = await read();
  return sources.map((base) => {
    const c = credentials[base];
    if (!c) return { base, hasCredential: false };
    return c.username ? { base, hasCredential: true, username: c.username } : { base, hasCredential: true };
  });
}

/**
 * Validate (pull + parse the index) and add a source. With `cred`, the token is
 * stored in the vault first so validation can use it; if validation then fails
 * for a source that wasn't already configured, the token is deleted again.
 */
export async function addSource(base: string, cred?: SourceCredentialInput): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const before = await read();
  const known = before.sources.includes(b);
  const hadCredential = b in before.credentials;
  if (cred) await storeCredential(b, cleanCredential(cred));
  let index: RemoteLoadout[];
  try {
    index = await pullIndex(b); // validates: throws on a bad/hostile index or an auth failure
  } catch (err) {
    if (cred && !known && !hadCredential) await clearCredential(b).catch(() => undefined);
    throw err;
  }
  const cur = await read();
  if (!cur.sources.includes(b)) {
    await write({ ...cur, sources: [...cur.sources, b] });
  }
  indexCache.set(b, index);
  return index;
}

/** Set/replace (or, with null, remove) a configured source's token, then force-refresh it. */
export async function setSourceCredential(base: string, cred: SourceCredentialInput | null): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  if (!(await read()).sources.includes(b)) throw new Error(`unknown source: ${b}`);
  if (cred) await storeCredential(b, cleanCredential(cred));
  else await clearCredential(b);
  return browseSource(b, { refresh: true });
}

export async function removeSource(base: string): Promise<void> {
  const b = normalizeBase(base);
  const cur = await read();
  await write({ ...cur, sources: cur.sources.filter((s) => s !== b) });
  await clearCredential(b);
  indexCache.delete(b);
}
```

(f) Replace the body of `download` with:

```ts
export async function download(source: string, id: string, version?: string): Promise<void> {
  const b = normalizeBase(source);
  const ref = loadoutRefFromSource(b, id, version);
  const cred = await credentialFor(b);
  await withSourceAuth(b, () => pullArtifact(ref, loadoutDir(id), { cred }));
  const cur = await read();
  await write({
    ...cur,
    provenance: { ...cur.provenance, [id]: { source: b, version: version ?? 'latest', downloadedAt: Date.now() } }
  });
}
```

`browseSource` and `allRemote` need no change: they go through `pullIndex`. `allRemote`'s log line carries `needs-credential: <base>`, never a token.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "$WT" && npx vitest run src/main/loadoutSources.test.ts src/main/loadoutInstall.test.ts`
Expected: PASS (26 loadoutSources tests; loadoutInstall unchanged).

- [ ] **Step 5: Typecheck the main config**

Run: `cd "$WT" && npx tsc --noEmit -p tsconfig.node.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/main/loadoutSources.ts src/main/loadoutSources.test.ts
git -C "$WT" commit -m "feat(loadouts): credentialed add/browse/download, token rollback + purge (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Renderer parser for the source-error contract

**Files:**
- Create: `src/renderer/src/sourceErrors.ts`
- Create: `src/renderer/src/sourceErrors.test.ts`

**Interfaces:**
- Consumes: the message contract from Task 5.
- Produces:
  - `type SourceError = { kind: 'needs-credential'; base: string; message: string } | { kind: 'credential-rejected'; base: string; status: number; message: string } | { kind: 'other'; message: string }`
  - `parseSourceError(err: unknown): SourceError`
  - `SOURCE_PRIVATE_PROMPT = 'This source is private. Add a token:'`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/sourceErrors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSourceError, SOURCE_PRIVATE_PROMPT } from './sourceErrors';

const ipcErr = (msg: string): Error => new Error(`Error invoking remote method 'loadouts:addSource': Error: ${msg}`);

describe('parseSourceError (#444)', () => {
  it('recognises needs-credential through the Electron IPC wrapper', () => {
    expect(parseSourceError(ipcErr('needs-credential: ghcr.io/acme/private'))).toEqual({
      kind: 'needs-credential',
      base: 'ghcr.io/acme/private',
      message: SOURCE_PRIVATE_PROMPT
    });
    expect(SOURCE_PRIVATE_PROMPT).toBe('This source is private. Add a token:');
  });

  it('recognises credential-rejected with its status', () => {
    expect(parseSourceError(ipcErr('credential-rejected: ghcr.io/acme/private (HTTP 403)'))).toEqual({
      kind: 'credential-rejected',
      base: 'ghcr.io/acme/private',
      status: 403,
      message: 'credential rejected (HTTP 403)'
    });
  });

  it('passes other errors through with the IPC prefix stripped', () => {
    expect(parseSourceError(ipcErr('index is not an array of loadouts'))).toEqual({
      kind: 'other',
      message: 'index is not an array of loadouts'
    });
    expect(parseSourceError('boom')).toEqual({ kind: 'other', message: 'boom' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "$WT" && npx vitest run src/renderer/src/sourceErrors.test.ts`
Expected: FAIL, `Failed to load url ./sourceErrors`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/sourceErrors.ts`:

```ts
// Parse the loadouts:addSource / loadouts:setSourceCredential error contract
// (#444). Electron carries only an Error's message across IPC, so main encodes
// the kind as a prefix: `needs-credential: <base>` or
// `credential-rejected: <base> (HTTP <n>)` (loadoutSources.withSourceAuth).

export const SOURCE_PRIVATE_PROMPT = 'This source is private. Add a token:';

export type SourceError =
  | { kind: 'needs-credential'; base: string; message: string }
  | { kind: 'credential-rejected'; base: string; status: number; message: string }
  | { kind: 'other'; message: string };

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;

export function parseSourceError(err: unknown): SourceError {
  const raw = String((err as Error | undefined)?.message ?? err).replace(IPC_PREFIX, '');
  const need = /^needs-credential: (\S+)$/.exec(raw);
  if (need) return { kind: 'needs-credential', base: need[1], message: SOURCE_PRIVATE_PROMPT };
  const rejected = /^credential-rejected: (\S+) \(HTTP (\d+)\)$/.exec(raw);
  if (rejected) {
    return {
      kind: 'credential-rejected',
      base: rejected[1],
      status: Number(rejected[2]),
      message: `credential rejected (HTTP ${rejected[2]})`
    };
  }
  return { kind: 'other', message: raw };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "$WT" && npx vitest run src/renderer/src/sourceErrors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add src/renderer/src/sourceErrors.ts src/renderer/src/sourceErrors.test.ts
git -C "$WT" commit -m "feat(renderer): parse private-source IPC errors (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: IPC + preload + browser-modal token UI

**Files:**
- Modify: `src/main/ipc.ts` (the `loadouts:listSources` / `addSource` handlers around lines 1643–1644)
- Modify: `src/preload/index.ts` (the `listSources` / `addSource` entries around lines 572–577)
- Modify: `src/renderer/src/components/LoadoutBrowserModal.tsx`
- Modify: `src/renderer/src/styles.css` (after `.lb-source-error`)

**Interfaces:**
- Consumes:
  - Task 5: `listSourceInfo`, `addSource(base, cred?)`, `setSourceCredential`, `SourceCredentialInput`.
  - Task 6: `parseSourceError`, `SOURCE_PRIVATE_PROMPT`.
- Produces (Task 8 asserts these):
  - `window.api.loadouts.listSources(): Promise<{ base; hasCredential; username? }[]>`
  - `addSource(base, cred?)`
  - `setSourceCredential(base, cred | null)`
  - DOM:
    - `.lb-source-item` wraps each `.lb-source-row`;
    - `.lb-source-lock` (🔒);
    - buttons "Change token…" / "Remove token";
    - `.lb-cred` form with inputs labelled `Source token` (type=password) and `Source username (optional)`;
    - buttons "Save token" / "Cancel";
    - errors in `.lb-cred .lb-source-error`.

- [ ] **Step 1: Wire the IPC handlers**

In `src/main/ipc.ts`, replace

```ts
  ipcMain.handle('loadouts:listSources', () => loadoutSources.listSources());
  ipcMain.handle('loadouts:addSource', (_e, base: string) => loadoutSources.addSource(base));
```

with

```ts
  ipcMain.handle('loadouts:listSources', () => loadoutSources.listSourceInfo());
  ipcMain.handle('loadouts:addSource', (_e, base: string, cred?: loadoutSources.SourceCredentialInput) =>
    loadoutSources.addSource(base, cred)
  );
  ipcMain.handle(
    'loadouts:setSourceCredential',
    (_e, base: string, cred: loadoutSources.SourceCredentialInput | null) =>
      loadoutSources.setSourceCredential(base, cred)
  );
```

- [ ] **Step 2: Update the preload surface**

In `src/preload/index.ts`, replace

```ts
    listSources: (): Promise<string[]> => ipcRenderer.invoke('loadouts:listSources'),
    addSource: (
      base: string
    ): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
      ipcRenderer.invoke('loadouts:addSource', base),
```

with

```ts
    /** Configured sources; `hasCredential` says a vault token exists — the token itself never crosses IPC (#444). */
    listSources: (): Promise<Array<{ base: string; hasCredential: boolean; username?: string }>> =>
      ipcRenderer.invoke('loadouts:listSources'),
    /** Rejects with `needs-credential: <base>` / `credential-rejected: <base> (HTTP <n>)` (see sourceErrors.ts). */
    addSource: (
      base: string,
      cred?: { token: string; username?: string }
    ): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
      ipcRenderer.invoke('loadouts:addSource', base, cred),
    /** Set/replace (or with null remove) a source's token, then refresh it. Write-only: no read path. */
    setSourceCredential: (
      base: string,
      cred: { token: string; username?: string } | null
    ): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
      ipcRenderer.invoke('loadouts:setSourceCredential', base, cred),
```

- [ ] **Step 3: Update the modal**

In `src/renderer/src/components/LoadoutBrowserModal.tsx`:

(a) Replace the header comment and imports (lines 1–8) with:

```tsx
// Full-catalog browse modal (#16 Phase 1). Facet sidebar (tag cloud + search)
// + results list with install / favorite actions. Phase 2 adds source
// checkboxes and the Update ↑ affordance; #444 adds private-source tokens
// (token prompt on a needs-credential add, 🔒 badge, Change/Remove token).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';
import { ModalBackdrop } from './ModalBackdrop';
import { Markdown } from './Markdown';
import { parseSourceError, SOURCE_PRIVATE_PROMPT } from '../sourceErrors';
```

(b) Replace `type Entry = …;` with:

```tsx
type Entry = Awaited<ReturnType<typeof window.api.loadouts.catalog>>[number];
type SourceInfo = Awaited<ReturnType<typeof window.api.loadouts.listSources>>[number];

const shortBase = (s: string): string => s.replace(/^ghcr\.io\//, '');
```

(c) Replace `const [sources, setSources] = useState<string[]>([]);` with:

```tsx
  const [sources, setSources] = useState<SourceInfo[]>([]);
```

and add directly below `const [sourceError, setSourceError] = useState<string | null>(null);`:

```tsx
  // Token prompt (#444): 'add' after a needs-credential add, 'change' from a row.
  const [credPrompt, setCredPrompt] = useState<{ base: string; mode: 'add' | 'change' } | null>(null);
  const [credToken, setCredToken] = useState('');
  const [credUser, setCredUser] = useState('');
  const [credError, setCredError] = useState<string | null>(null);
```

(d) Replace the whole `addSource` function with:

```tsx
  const closeCred = (): void => {
    setCredPrompt(null);
    setCredToken('');
    setCredUser('');
    setCredError(null);
  };

  const addSource = async (): Promise<void> => {
    const base = addingSource.trim();
    if (!base) return;
    setSourceError(null);
    try {
      await window.api.loadouts.addSource(base);
      setAddingSource('');
      await reloadSources();
      await reload();
    } catch (err) {
      const e = parseSourceError(err);
      if (e.kind === 'needs-credential') {
        closeCred();
        setCredPrompt({ base, mode: 'add' });
        return;
      }
      setSourceError(e.message);
    }
  };

  const submitCredential = async (): Promise<void> => {
    if (!credPrompt || !credToken.trim()) return;
    setCredError(null);
    const cred = credUser.trim() ? { token: credToken, username: credUser.trim() } : { token: credToken };
    try {
      if (credPrompt.mode === 'add') await window.api.loadouts.addSource(credPrompt.base, cred);
      else await window.api.loadouts.setSourceCredential(credPrompt.base, cred);
      if (credPrompt.mode === 'add') setAddingSource('');
      closeCred();
      await reloadSources();
      await reload();
    } catch (err) {
      setCredError(parseSourceError(err).message);
    }
  };

  const removeToken = async (base: string): Promise<void> => {
    setSourceError(null);
    try {
      await window.api.loadouts.setSourceCredential(base, null);
    } catch (err) {
      // A private source that now has no token just stops listing; that's expected.
      const e = parseSourceError(err);
      if (e.kind !== 'needs-credential') setSourceError(e.message);
    }
    await reloadSources();
    await reload();
  };
```

(e) Replace the whole `<div className="lb-sources"> … </div>` block (from `<div className="lb-sources">` through the `{sourceError && …}` line and its closing `</div>`) with:

```tsx
            <div className="lb-sources">
              <div className="lb-sources-head">Sources</div>
              {sources.map((s) => (
                <div key={s.base} className="lb-source-item">
                  <label className="lb-source-row" title={s.base}>
                    <input
                      type="checkbox"
                      checked={selectedSources.includes(s.base)}
                      onChange={() =>
                        setSelectedSources((p) => (p.includes(s.base) ? p.filter((x) => x !== s.base) : [...p, s.base]))
                      }
                    />
                    <span className="lb-source-name">{shortBase(s.base)}</span>
                    {s.hasCredential && (
                      <span className="lb-source-lock" title="Has a token" aria-label="Has a token">🔒</span>
                    )}
                    <button
                      type="button"
                      className="lb-source-remove"
                      aria-label={`Remove ${s.base}`}
                      onClick={async (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        await window.api.loadouts.removeSource(s.base);
                        await reloadSources();
                        await reload();
                      }}
                    >
                      ×
                    </button>
                  </label>
                  {s.hasCredential && (
                    <div className="lb-source-cred-actions">
                      <button
                        type="button"
                        onClick={() => {
                          closeCred();
                          setCredUser(s.username ?? '');
                          setCredPrompt({ base: s.base, mode: 'change' });
                        }}
                      >
                        Change token…
                      </button>
                      <button type="button" onClick={() => void removeToken(s.base)}>
                        Remove token
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <div className="lb-add-source">
                <input
                  placeholder="ghcr.io/owner/repo"
                  value={addingSource}
                  onChange={(e) => setAddingSource(e.target.value)}
                />
                <button type="button" onClick={() => void addSource()}>+ Add</button>
              </div>
              {sourceError && <div className="lb-source-error">{sourceError}</div>}
              {credPrompt && (
                <form
                  className="lb-cred"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void submitCredential();
                  }}
                >
                  <div className="lb-cred-head">
                    {credPrompt.mode === 'add' ? SOURCE_PRIVATE_PROMPT : `Change token for ${shortBase(credPrompt.base)}:`}
                  </div>
                  <input
                    type="password"
                    aria-label="Source token"
                    placeholder="Token"
                    autoComplete="off"
                    value={credToken}
                    onChange={(e) => setCredToken(e.target.value)}
                  />
                  <input
                    aria-label="Source username (optional)"
                    placeholder="Username (optional)"
                    autoComplete="off"
                    value={credUser}
                    onChange={(e) => setCredUser(e.target.value)}
                  />
                  <div className="lb-cred-actions">
                    <button type="submit" className="btn btn-sm primary" disabled={!credToken.trim()}>
                      Save token
                    </button>
                    <button type="button" className="btn btn-sm" onClick={closeCred}>
                      Cancel
                    </button>
                  </div>
                  {credError && <div className="lb-source-error">{credError}</div>}
                </form>
              )}
            </div>
```

- [ ] **Step 4: Add the styles**

In `src/renderer/src/styles.css`, insert directly after the `.lb-source-error { … }` line:

```css
.lb-source-item { display: flex; flex-direction: column; gap: 2px; }
.lb-source-lock { font-size: 11px; flex-shrink: 0; }
.lb-source-cred-actions { display: flex; gap: 8px; padding-left: 20px; }
.lb-source-cred-actions button { border: none; background: none; padding: 0; color: var(--ink-2); cursor: pointer; font-size: 11px; text-decoration: underline; }
.lb-source-cred-actions button:hover { color: var(--ink-1); }
.lb-cred { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; padding: 6px; border: 1px solid var(--rule-strong); border-radius: 6px; }
.lb-cred-head { font-size: 11px; color: var(--ink-1); }
.lb-cred input { min-width: 0; }
.lb-cred-actions { display: flex; gap: 4px; }
```

- [ ] **Step 5: Typecheck both configs**

Run: `cd "$WT" && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: both exit 0. The web config catches any leftover `string` use of `sources` in the modal.

- [ ] **Step 6: Run the unit suite**

Run: `cd "$WT" && npx vitest run src/main/loadoutSources.test.ts src/main/ociClient.test.ts src/main/vaultScopes.test.ts src/renderer/src/sourceErrors.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add src/main/ipc.ts src/preload/index.ts src/renderer/src/components/LoadoutBrowserModal.tsx src/renderer/src/styles.css
git -C "$WT" commit -m "feat(loadouts): private-source token prompt, lock badge, change/remove token (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: e2e — credential prompt on a private source

**Files:**
- Modify: `tests/_helpers.ts` (`MockOpts`, the `__calls` init, the `channels` list, the loadout-sources mock handlers)
- Modify: `tests/loadout-library.spec.ts` (append a test)

**Interfaces:**
- Consumes: the Task 7 DOM and IPC shapes, and the Task 5 error strings.
- Produces:
  - `MockOpts.privateLoadoutSources?: Record<string, string>` (base → accepted token);
  - `__calls.addSource` entries `{ base, withToken }`;
  - `__calls.setSourceCredential` entries `{ base, cleared }`.

The e2e drives the renderer against a **mocked main IPC** (`mockMainIpc`), which is the established pattern in `loadout-library.spec.ts`. The registry-level behaviour is covered by the Task 2 fake-registry unit tests. This suite can't run in the container (no display): CI is the gate.

- [ ] **Step 1: Extend `MockOpts`**

In `tests/_helpers.ts`, replace

```ts
  // Source list returned from loadouts:listSources. Defaults to [].
  loadoutSources?: string[];
}
```

with

```ts
  // Source list returned from loadouts:listSources. Defaults to [].
  loadoutSources?: string[];
  // Private sources (#444): base → the only token loadouts:addSource accepts.
  // Without a token addSource rejects `needs-credential: <base>`; with the wrong
  // one, `credential-rejected: <base> (HTTP 401)`.
  privateLoadoutSources?: Record<string, string>;
}
```

- [ ] **Step 2: Register the new call log + channel**

In `tests/_helpers.ts`, replace

```ts
      removeSource: [],
      refreshSource: []
    };
```

with

```ts
      removeSource: [],
      refreshSource: [],
      setSourceCredential: []
    };
```

and replace

```ts
      'loadouts:refreshSource',
      'endpoints:list'
```

with

```ts
      'loadouts:refreshSource',
      'loadouts:setSourceCredential',
      'endpoints:list'
```

- [ ] **Step 3: Replace the sources mock handlers**

In `tests/_helpers.ts`, replace from `const sourcesState: string[] = [...(opts.loadoutSources ?? [])];` through the closing `});` of the `loadouts:removeSource` handler with:

```ts
    const sourcesState: Array<{ base: string; hasCredential: boolean; username?: string }> = (
      opts.loadoutSources ?? []
    ).map((base) => ({ base, hasCredential: false }));
    const privateSources: Record<string, string> = { ...(opts.privateLoadoutSources ?? {}) };
    ipcMain.handle('loadouts:listSources', () => sourcesState.map((s) => ({ ...s })));
    ipcMain.handle('loadouts:addSource', (_e, base: string, cred?: { token: string; username?: string }) => {
      g.__calls.addSource.push({ base, withToken: !!cred });
      const want = privateSources[base];
      if (want !== undefined) {
        if (!cred) throw new Error(`needs-credential: ${base}`);
        if (cred.token !== want) throw new Error(`credential-rejected: ${base} (HTTP 401)`);
      }
      if (!sourcesState.some((s) => s.base === base)) {
        sourcesState.push(
          cred?.username ? { base, hasCredential: !!cred, username: cred.username } : { base, hasCredential: !!cred }
        );
      }
      return [];
    });
    ipcMain.handle('loadouts:removeSource', (_e, base: string) => {
      g.__calls.removeSource.push(base);
      const idx = sourcesState.findIndex((s) => s.base === base);
      if (idx >= 0) sourcesState.splice(idx, 1);
      return undefined;
    });
    ipcMain.handle(
      'loadouts:setSourceCredential',
      (_e, base: string, cred: { token: string; username?: string } | null) => {
        g.__calls.setSourceCredential.push({ base, cleared: cred === null });
        const s = sourcesState.find((x) => x.base === base);
        if (s) {
          s.hasCredential = cred !== null;
          if (cred?.username) s.username = cred.username;
          else delete s.username;
        }
        return [];
      }
    );
```

The `loadouts:refreshSource` handler that follows stays as it is.

- [ ] **Step 4: Append the e2e test**

Append to `tests/loadout-library.spec.ts`:

```ts
// ── Private loadout sources (#444) ───────────────────────────────────────────

test('Library: a private source prompts for a token, rejects a bad one, then adds with a 🔒 (#444)', async () => {
  const PRIVATE = 'ghcr.io/acme/private';
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [],
      loadoutCatalog: [PHASE1_ENTRY],
      loadoutSources: [],
      privateLoadoutSources: { [PRIVATE]: 'good-token' },
    });

    await window.waitForTimeout(400);

    const libraryAccHeader = window.locator('.acc-header', { hasText: 'Library' });
    await libraryAccHeader.waitFor({ state: 'visible', timeout: 8_000 });
    if ((await libraryAccHeader.getAttribute('aria-expanded')) !== 'true') {
      await libraryAccHeader.click();
      await window.waitForTimeout(200);
    }

    await window.locator('.lib-browse').click();
    const modal = window.locator('.modal.loadout-browser');
    await modal.waitFor({ state: 'visible', timeout: 6_000 });

    // Adding the private source without a token opens the prompt.
    await modal.getByPlaceholder('ghcr.io/owner/repo').fill(PRIVATE);
    await modal.getByRole('button', { name: '+ Add' }).click();
    const form = modal.locator('.lb-cred');
    await expect(form).toBeVisible({ timeout: 4_000 });
    await expect(form).toContainText('This source is private. Add a token:');
    const tokenInput = form.getByLabel('Source token');
    await expect(tokenInput).toHaveAttribute('type', 'password');

    // A wrong token shows the rejection and keeps the prompt open.
    await tokenInput.fill('bad-token');
    await form.getByRole('button', { name: 'Save token' }).click();
    await expect(form.locator('.lb-source-error')).toHaveText('credential rejected (HTTP 401)');

    // The right token adds the source with a lock badge.
    await tokenInput.fill('good-token');
    await form.getByRole('button', { name: 'Save token' }).click();
    await expect(form).toBeHidden({ timeout: 4_000 });
    const item = modal.locator('.lb-source-item', { hasText: 'acme/private' });
    await expect(item.locator('.lb-source-lock')).toBeVisible();

    const calls = await getCalls(app);
    expect(calls.addSource).toEqual([
      { base: PRIVATE, withToken: false },
      { base: PRIVATE, withToken: true },
      { base: PRIVATE, withToken: true },
    ]);

    // Remove token → setSourceCredential(base, null), lock goes away.
    await item.getByRole('button', { name: 'Remove token' }).click();
    await expect(item.locator('.lb-source-lock')).toHaveCount(0, { timeout: 4_000 });
    expect((await getCalls(app)).setSourceCredential).toEqual([{ base: PRIVATE, cleared: true }]);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 5: Check the e2e sources load**

Neither tsconfig includes `tests/`, and Playwright transpiles specs itself. `--list` loads and parses the spec without launching Electron, so it works headless:

Run: `cd "$WT" && npx playwright test --list tests/loadout-library.spec.ts`
Expected: the listing includes `Library: a private source prompts for a token, rejects a bad one, then adds with a 🔒 (#444)`, with no syntax/import errors.

Playwright can't actually run here (no display). The gate is the PR's CI e2e job (`npx playwright test tests/loadout-library.spec.ts`).

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add tests/_helpers.ts tests/loadout-library.spec.ts
git -C "$WT" commit -m "test(e2e): private loadout source credential prompt (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: SPEC.md

**Files:**
- Modify: `docs/SPEC.md`:
  - §7 *Vault layout*;
  - §7 *Loadout library v2 — Phase 2* (the client, `sources.json`, IPC and modal paragraphs);
  - §9.

**Interfaces:**
- Consumes: the final names from Tasks 1–8.
- Produces: the documentation `.claude/rules/spec-maintenance.md` requires.

The loadout IPC is documented in §7 *Loadout library v2 — Phase 2*, not §6, so the spec's "§6 *Loadouts*" change lands there.

- [ ] **Step 1: Vault layout**

In `docs/SPEC.md`, after the paragraph ending `See *Model endpoint registry* below for the non-secret part.`, insert a new paragraph:

```markdown
The vault also holds **loadout-source tokens** (#444):
- **Scope and key:** scope `loadout-source:<normalised base>` (e.g. `loadout-source:ghcr.io/acme/loadouts`), key `TOKEN`. The same file, safeStorage envelope and lock as the other scopes.
- **Purge:** `removeSource(base)` and `setSourceCredential(base, null)` purge the whole scope.
- **No read path:** unlike workspace and endpoint scopes, the generic `vault:*` IPC refuses any `loadout-source:` scope (`vaultScopes.assertRendererVaultScope`). The renderer can write a source token only through `loadouts:addSource` / `loadouts:setSourceCredential`, and can never read one back.
```

- [ ] **Step 2: OCI client — private sources**

After the paragraph beginning `**\`src/main/ociClient.ts\` — anonymous GHCR pull.**`, insert:

```markdown
**Private sources (#444).** `pullArtifact(ref, destDir, { cred? })` and `fetchAnnotations(ref, { cred? })` take an optional `RegistryCredential { token, username? }` (`ociCore.ts`).

`registryToken(repository, manifestUrl, cred?)` replaces the anonymous-only helper. It runs the same 401 → `WWW-Authenticate` → realm flow, but with `cred` it sends `Authorization: Basic base64(<username or "token">:<token>)` to the realm. It does so only when `ociCore.realmMayReceiveCredential(registryHost, realm)` holds: an `https:` realm on the registry's own host, or a `KNOWN_REALM_HOSTS` pairing. Any other realm is asked anonymously.

**Static-token fallback:** if the probe returns 401 with no realm, or the token exchange is answered 401/403, the credential is sent as a direct `Bearer <token>` on the manifest and blob requests. That header only ever goes to the registry host.

**Errors:** a 401/403 on the manifest throws `RegistryAuthError` with `kind`:
- `needs-credential`: no credential was sent;
- `credential-rejected`: message `credential rejected (HTTP <n>)`.

Messages never contain the token. `parseImageRef` still pins the registry to `ghcr.io`.
```

- [ ] **Step 3: `sources.json` shape + credential resolution**

Replace

```markdown
Manages `<userData>/loadouts/sources.json` (shape: `{ sources: string[], provenance: Record<string, { source, version, downloadedAt }> }`).
```

with

```markdown
Manages `<userData>/loadouts/sources.json` (shape: `{ sources: string[], provenance: Record<string, { source, version, downloadedAt }>, credentials: Record<base, { username?: string }> }`). `credentials` records only that a source has a vault token, plus its non-secret username. The token is never in this file, and a file without the key reads as `{}`.
```

Then, after the paragraph that ends `…and the index ref is constructed as \`<base>/index:latest\`.`, insert:

```markdown
**Credential resolution (#444).** `credentialFor(base)` runs in the main process only and resolves, in order:
1. the vault token (`loadout-source:<base>` / `TOKEN`, with `credentials[base].username`);
2. `FLEET_LOADOUT_TOKEN_<SANITISED_BASE>` (base upper-cased, every non-alphanumeric → `_`, e.g. `FLEET_LOADOUT_TOKEN_GHCR_IO_ACME_LOADOUTS`);
3. for `ghcr.io/` bases, the signed-in GitHub token from the provider registered with `setGithubTokenProvider`. Nothing registers one until GitHub sign-in ships, so this step is skipped today;
4. `FLEET_LOADOUT_TOKEN`, for any source not in `DEFAULT_SOURCES`;
5. otherwise, anonymous.

There is no headless pin mechanism yet (`FLEET_LOADOUTS` isn't implemented). The env steps are its hook.

`pullIndex` (so `browseSource` / `allRemote`) and `download` pull with the resolved credential. Auth failures cross IPC as plain `Error` messages with a parseable prefix, because Electron carries only the message:
- `needs-credential: <base>`;
- `credential-rejected: <base> (HTTP <n>)`.

The renderer parses them in `sourceErrors.ts`. `addSource(base, cred?)` stores `cred` before validating. For a source that wasn't already configured, it deletes the token again if validation fails.
```

- [ ] **Step 4: IPC bullets**

Replace

```markdown
- `loadouts:listSources()` → `string[]` — current source base URLs from `sources.json`.
- `loadouts:addSource(base)` → `RemoteLoadout[]` — validates + adds a source, returns its index.
- `loadouts:removeSource(base)` → `void` — removes from `sources[]` + clears cache.
```

with

```markdown
- `loadouts:listSources()` → `{ base, hasCredential, username? }[]`: the current sources from `sources.json`, with whether each has a vault token. It never returns the token. Main-process callers that want bare bases use `loadoutSources.listSources()` → `string[]`.
- `loadouts:addSource(base, cred?: { token, username? })` → `RemoteLoadout[]`: stores `cred` in the vault (when given), then validates and adds the source and returns its index. It rejects with:
  - `needs-credential: <base>` when the index answers 401/403 without a credential;
  - `credential-rejected: <base> (HTTP <n>)` when the credential is refused.
- `loadouts:setSourceCredential(base, cred | null)` → `RemoteLoadout[]`: sets or replaces (with `null`, removes) a configured source's token, then force-refreshes its index. Same error contract. An unknown source rejects.
- `loadouts:removeSource(base)` → `void`: removes the source from `sources[]`, clears the cache, and purges the source's vault scope and `credentials` entry.
```

- [ ] **Step 5: Browser modal**

After the paragraph ending `…so it doesn't toggle the surrounding label's checkbox.`, insert:

```markdown
**Private sources in the modal (#444).**
- **Token prompt:** when `+ Add` fails with `needs-credential`, a `.lb-cred` form appears with:
  - the text "This source is private. Add a token:";
  - a password field (`Source token`) and an optional `Source username (optional)` field;
  - `Save token` / `Cancel` buttons.
- **Save:** re-calls `loadouts:addSource(base, cred)`. A refused token shows `credential rejected (HTTP 401)` (or 403) in the form.
- **Rows with a token:** each `.lb-source-row` sits in a `.lb-source-item`. A source with a token shows a `.lb-source-lock` 🔒 badge and two actions:
  - `Change token…` opens the same form, which calls `loadouts:setSourceCredential`;
  - `Remove token` calls `setSourceCredential(base, null)`.
```

- [ ] **Step 6: §9 Security model**

After the first §9 bullet (the one ending `Nothing reads a saved value without that click.`), insert:

```markdown
- **Loadout-source tokens are write-only from the renderer and bound to their host (#444).**
  - **Where it lives:** a private source's token lives only in the vault (`loadout-source:<base>`) and in main-process memory during a request.
  - **Where it never goes:** a container, `sources.json`, a log line or an error message (errors name the source).
  - **Renderer access:** the renderer can submit a token (`loadouts:addSource`, `loadouts:setSourceCredential`) but has no read path. The generic `vault:*` IPC refuses `loadout-source:` scopes.
  - **Where it is sent:** only to the source's registry host, and to its advertised token realm when that realm is `https:` on the same host or a known pairing (`ociCore.KNOWN_REALM_HOSTS`). A realm on any other host is asked anonymously, so a hostile `WWW-Authenticate` can't redirect credentials.
```

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add docs/SPEC.md
git -C "$WT" commit -m "docs(spec): private loadout sources — vault scope, client, IPC, §9 (#444)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Final gate (after Task 9)

- [ ] Run: `cd "$WT" && npx vitest run`. Expected: all unit tests PASS. Note any pre-existing, unrelated failures in the PR. Don't fix them here.
- [ ] Run: `cd "$WT" && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`. Expected: both exit 0.
- [ ] Open the PR (`Closes #444`). State that e2e and UI were not run in-container: CI Playwright plus Troy's host check are the gate. Host check: add a private GHCR source with a `read:packages` PAT, confirm the 🔒 badge, then install a loadout from it, Change token…, and Remove token.

## Self-review

**Spec coverage:**
- Goal and private-source listing/install: Tasks 2, 5 and 7.
- Non-goals: there is no push code, credentials are per source (Task 5), and ECR/GCR are out because the registry stays pinned to `ghcr.io`.
- Option C order: Task 4.
  - vault: covered;
  - GitHub-token seam: `setGithubTokenProvider`, no sign-in built;
  - anonymous: covered.
- Data model:
  - `credentials` map: Task 4;
  - vault scope + purge on remove: Tasks 3 and 5.
- OCI client: Task 2.
  - `registryToken(repository, manifestUrl, cred?)`, Basic with a `token` default username;
  - static-bearer fallback when there's no realm or the exchange is rejected;
  - typed errors, token-free messages.
- Flows:
  - Add-source needs-credential, prompt, retry, "credential rejected" (Tasks 5, 6, 7);
  - 🔒 badge, Change token…, Remove token (Task 7);
  - install/browse/update with the resolved credential, catalog cache untouched (Task 5);
  - headless env resolution (Task 4: resolver-only, because `FLEET_LOADOUTS` doesn't exist).
- IPC:
  - `addSource(base, cred?)`, `setSourceCredential`, `listSources` objects (Task 7).
- Security:
  - write-only renderer (Task 3 guard);
  - cross-host realm rule (Tasks 1 and 2);
  - tokens never logged or in messages (Tasks 2 and 5 tests).
- Testing:
  - every `ociClient.test.ts` case listed in the spec (Task 2);
  - every `loadoutSources.test.ts` case listed in the spec (Tasks 4 and 5);
  - the e2e (Task 8, against mocked IPC rather than a fake registry; the registry behaviour is unit-tested).
- SPEC changes: Task 9.

**Placeholder scan:** no TBD/TODO. Every code step has complete code. Task 8 Step 5 uses `playwright test --list` as the headless load check.

**Type consistency:**
- `RegistryCredential` is defined in Task 1 and used in Tasks 2, 4 and 5.
- `PullOpts.cred` is used by the Task 4/5 mocks as `opts?.cred`.
- `SourceCredentialInput`, `SourceInfo` and `listSourceInfo` are defined in Task 5 and used in Task 7.
- `sourceVaultScope` and `SOURCE_VAULT_KEY` are defined in Task 3 and used in Tasks 4 and 5.
- `parseSourceError` and `SOURCE_PRIVATE_PROMPT` are defined in Task 6 and used in Task 7.
- The error strings match across Task 5 (`withSourceAuth`), Task 6 (regexes) and Task 8 (mock).
