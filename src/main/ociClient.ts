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
