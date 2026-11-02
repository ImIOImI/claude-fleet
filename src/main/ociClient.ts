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
