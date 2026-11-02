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
  assertTokenShape,
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

/** An empty/whitespace-only token is treated as "no credential" (#444 minor),
 *  not a malformed one — the distinction matters because the former should
 *  fall through to the anonymous flow and the latter should reject outright. */
function normalizeCred(cred?: RegistryCredential | null): RegistryCredential | null {
  if (!cred || !cred.token || !cred.token.trim()) return null;
  return cred;
}

/**
 * Fetch wrapped so a transport-level throw never reaches the caller verbatim.
 * undici throws `Headers.append` errors (and some network errors) with the
 * offending value embedded in the message — if that value is an
 * `Authorization: Bearer <token>` header, the token would otherwise leak into
 * logs/toasts via the rejected promise. `assertTokenShape` is meant to catch
 * malformed tokens before they ever reach a header, so this is the backstop
 * for anything else that throws (DNS failures, aborts, a future bug): name
 * only the stage and host, never the original message or `cause`.
 */
async function safeFetch(stage: string, url: string, init?: Record<string, unknown>): Promise<Response> {
  try {
    return await fetch(url, init as RequestInit | undefined);
  } catch {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* leave the raw url if it doesn't even parse */
    }
    throw new Error(`${stage} failed for ${host}`);
  }
}

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
  credIn?: RegistryCredential | null
): Promise<string | null> {
  // An empty/whitespace token is "no credential" (#444 minor), not malformed.
  const cred = normalizeCred(credIn);
  // Up-front shape guard (#444 security review): reject a token that would
  // make `Headers.append` throw with the raw header value in its message,
  // before it ever reaches a header — no network call, no leak either way.
  if (cred) assertTokenShape(cred.token);

  const { signal, done } = withTimeout();
  try {
    // Anonymous probe — no credential attached, so there is nothing to sanitise.
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
    // Guard the exact URL we're about to fetch (post-query), not just the
    // advertised `realm` substring — check what you use, not an intermediate
    // value that happens to share its host today (#444 minor).
    if (cred && realmMayReceiveCredential(new URL(manifestUrl).host, tokenUrl)) {
      const basic = Buffer.from(`${cred.username || 'token'}:${cred.token}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
    // Relies on fetch (undici) stripping Authorization on a cross-origin
    // redirect (see ociRedirect.test.ts) — do not swap fetch implementations
    // without that guarantee, and do not add an explicit `redirect` option
    // that changes this default.
    const res = await safeFetch('token exchange', tokenUrl, { headers, signal });
    if (!res.ok) {
      if (isAuthStatus(res.status)) {
        if (cred) return `Bearer ${cred.token}`;
        throw new RegistryAuthError('needs-credential', res.status);
      }
      throw new Error(`token request failed (HTTP ${res.status})`);
    }
    let body: { token?: string; access_token?: string };
    try {
      body = (await res.json()) as { token?: string; access_token?: string };
    } catch {
      // #444 minor: never echo the (possibly attacker-controlled) response body.
      throw new Error(`token exchange response was not valid JSON for ${new URL(tokenUrl).host}`);
    }
    const token = body.token ?? body.access_token;
    return token ? `Bearer ${token}` : null;
  } finally {
    done();
  }
}

async function fetchManifest(
  ref: string,
  credIn?: RegistryCredential | null
): Promise<{ manifest: OciManifest; repository: string; auth: string | null }> {
  // Same empty/whitespace-token normalisation as registryToken, so an
  // ignored-as-anonymous credential doesn't get misreported as "rejected".
  const cred = normalizeCred(credIn);
  const { registry, repository, tag } = parseImageRef(ref);
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${tag}`;
  const auth = await registryToken(repository, manifestUrl, cred);
  const { signal, done } = withTimeout();
  try {
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
    if (auth) headers['Authorization'] = auth;
    // Relies on fetch (undici) stripping Authorization on a cross-origin
    // redirect (see ociRedirect.test.ts) — do not swap fetch implementations
    // without that guarantee, and do not add an explicit `redirect` option
    // that changes this default.
    const res = await safeFetch('manifest fetch', manifestUrl, { headers, signal });
    if (isAuthStatus(res.status)) {
      throw new RegistryAuthError(cred ? 'credential-rejected' : 'needs-credential', res.status);
    }
    if (!res.ok) throw new Error(`manifest fetch failed for ${ref} (HTTP ${res.status})`);
    try {
      return { manifest: (await res.json()) as OciManifest, repository, auth };
    } catch {
      // #444 minor: never echo the (possibly attacker-controlled) response body.
      throw new Error(`manifest response was not valid JSON for ${ref}`);
    }
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
      const blobUrl = `https://${registry}/v2/${repository}/blobs/${layer.digest}`;
      // Relies on fetch (undici) stripping Authorization on a cross-origin
      // redirect — this is the GHCR blob → CDN hop (see ociRedirect.test.ts).
      // Do not swap fetch implementations without that guarantee, and do not
      // add an explicit `redirect` option that changes this default.
      const res = await safeFetch('blob fetch', blobUrl, { headers, signal });
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
