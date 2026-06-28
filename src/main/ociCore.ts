// Pure core for the loadout library v2 — OCI ref handling, artifact-layer
// path safety, index parsing, version comparison, and catalog assembly.
//
// Like `loadoutCore.ts`, this module is deliberately free of electron, network
// and filesystem side effects so it unit-tests in isolation. The networked
// layer (anonymous GHCR token flow, manifest/blob fetch, writing the pulled
// tree to `<userData>/loadouts/<id>/`) lives in the not-yet-built
// `ociClient.ts`; the electron-wired source/provenance/favorites layer lives in
// `loadoutSources.ts`. Both call into the pure helpers here.

import { resolve, sep, isAbsolute } from 'node:path';

/** v1 supports GitHub Container Registry only. */
export const SUPPORTED_REGISTRY = 'ghcr.io';

export interface ParsedRef {
  registry: string;
  repository: string; // everything after the registry, e.g. owner/claude-fleet-loadouts/spec-driven
  tag: string;
}

/**
 * Parse an OCI image reference such as
 * `ghcr.io/imioimi/claude-fleet-loadouts/spec-driven:1.0.0`.
 * Defaults the tag to `latest`. Throws on a non-GHCR registry (v1 scope) or a
 * structurally invalid ref — callers surface that to the user, never silently
 * dial an unexpected host.
 */
export function parseImageRef(ref: string): ParsedRef {
  const s = ref.trim().replace(/^oci:\/\//, '');
  if (!s) throw new Error('empty image reference');
  const lastSlash = s.lastIndexOf('/');
  const lastColon = s.lastIndexOf(':');
  let name = s;
  let tag = 'latest';
  // A colon is a tag separator only when it follows the final path segment;
  // GHCR has no host:port, so any colon after the last slash is the tag.
  if (lastColon > lastSlash) {
    tag = s.slice(lastColon + 1);
    name = s.slice(0, lastColon);
  }
  const firstSlash = name.indexOf('/');
  if (firstSlash <= 0) throw new Error(`invalid image reference: ${ref}`);
  const registry = name.slice(0, firstSlash);
  const repository = name.slice(firstSlash + 1);
  if (registry !== SUPPORTED_REGISTRY) {
    throw new Error(`unsupported registry "${registry}" (v1 supports ${SUPPORTED_REGISTRY} only)`);
  }
  if (!repository) throw new Error(`invalid image reference: ${ref}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw new Error(`invalid tag "${tag}"`);
  return { registry, repository, tag };
}

/** Derive a loadout's pull ref from a source base + id (+ optional version). */
export function loadoutRefFromSource(sourceBase: string, id: string, version?: string): string {
  const base = sourceBase.trim().replace(/\/+$/, '');
  if (!id || /[\s/:]/.test(id)) throw new Error(`invalid loadout id "${id}"`);
  return `${base}/${id}:${version && version.trim() ? version.trim() : 'latest'}`;
}

/**
 * Resolve a layer's `org.opencontainers.image.title` (a loadout-relative path)
 * to an absolute path confined to `destDir`. This is the load-bearing guard
 * against a malicious artifact writing outside the loadout folder via `..` or
 * an absolute title — the pull MUST route every layer through this.
 */
export function safeLayerPath(destDir: string, title: string): string {
  if (!title || isAbsolute(title)) throw new Error(`unsafe layer path: ${title}`);
  const parts = title.split(/[\\/]+/);
  if (parts.some((p) => p === '..' || p === '')) throw new Error(`unsafe layer path: ${title}`);
  const dest = resolve(destDir);
  const target = resolve(dest, title);
  if (target !== dest && !target.startsWith(dest + sep)) {
    throw new Error(`unsafe layer path escapes destination: ${title}`);
  }
  return target;
}

export interface RemoteLoadout {
  id: string;
  title: string;
  description: string;
  tags: string[];
  version: string;
}

/**
 * Parse + validate the index artifact's `index.json` (an array of loadout
 * summaries). Accepts a JSON string or an already-parsed value. Throws on a
 * structurally invalid index so a corrupt/hostile source can't inject
 * malformed entries into the catalog.
 */
export function parseIndex(input: string | unknown): RemoteLoadout[] {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const arr = Array.isArray(data) ? data : (data as { loadouts?: unknown })?.loadouts;
  if (!Array.isArray(arr)) throw new Error('index is not an array of loadouts');
  return arr.map((raw, i) => {
    const e = raw as Record<string, unknown>;
    if (typeof e?.id !== 'string' || !e.id) throw new Error(`index entry ${i}: missing id`);
    if (typeof e.version !== 'string' || !e.version) throw new Error(`index entry ${i} (${e.id}): missing version`);
    const tags = Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [];
    return {
      id: e.id,
      title: typeof e.title === 'string' && e.title ? e.title : e.id,
      description: typeof e.description === 'string' ? e.description : '',
      tags,
      version: e.version
    };
  });
}

/** Compare two dotted numeric versions. Non-numeric/missing segments sort low;
 *  a prerelease suffix (after `-`) is ignored in v1. Returns -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string): number[] =>
    v.split('-')[0].split('.').map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
  const pa = seg(a);
  const pb = seg(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** True when `remoteVersion` is strictly newer than `haveVersion`. */
export function isUpdateAvailable(haveVersion: string | undefined, remoteVersion: string | undefined): boolean {
  if (!haveVersion || !remoteVersion) return false;
  return compareVersions(remoteVersion, haveVersion) > 0;
}

export interface LocalLoadout {
  id: string;
  title: string;
  description: string;
  tags: string[];
  version?: string;
}
export interface InstalledRef {
  id: string;
  version?: string;
}
export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  version: string; // best-known: local present version, else newest remote
  remoteVersion?: string;
  present: boolean; // exists in the local library (pulled/authored/builtin)
  installed: boolean; // installed in the target workspace
  installedVersion?: string;
  updateAvailable: boolean;
  favorited: boolean;
  sources: string[]; // remote source bases that offer this id
}

/**
 * Merge the local library with every remote source index into one de-duplicated
 * catalog keyed by loadout id, stamping per-entry state for the modal browser
 * and the rail. Pure: the caller supplies the local library, the per-source
 * remote indexes, the target workspace's installed set, and the favorites set.
 */
export function assembleCatalog(args: {
  local: LocalLoadout[];
  remote?: { source: string; loadouts: RemoteLoadout[] }[];
  installed?: InstalledRef[];
  favorites?: string[];
}): CatalogEntry[] {
  const { local, remote = [], installed = [], favorites = [] } = args;
  const favSet = new Set(favorites);
  const instMap = new Map(installed.map((i) => [i.id, i.version]));
  const map = new Map<string, CatalogEntry>();

  for (const l of local) {
    map.set(l.id, {
      id: l.id,
      title: l.title,
      description: l.description,
      tags: [...l.tags],
      version: l.version ?? '',
      present: true,
      installed: instMap.has(l.id),
      installedVersion: instMap.get(l.id),
      updateAvailable: false,
      favorited: favSet.has(l.id),
      sources: []
    });
  }

  for (const { source, loadouts } of remote) {
    for (const r of loadouts) {
      const cur = map.get(r.id);
      if (cur) {
        cur.sources.push(source);
        cur.remoteVersion = !cur.remoteVersion || compareVersions(r.version, cur.remoteVersion) > 0 ? r.version : cur.remoteVersion;
        if (!cur.present || !cur.version) {
          cur.title = cur.title || r.title;
          cur.description = cur.description || r.description;
          if (!cur.tags.length) cur.tags = [...r.tags];
        }
      } else {
        map.set(r.id, {
          id: r.id,
          title: r.title,
          description: r.description,
          tags: [...r.tags],
          version: r.version,
          remoteVersion: r.version,
          present: false,
          installed: instMap.has(r.id),
          installedVersion: instMap.get(r.id),
          updateAvailable: false,
          favorited: favSet.has(r.id),
          sources: [source]
        });
      }
    }
  }

  for (const e of map.values()) {
    const have = e.installedVersion ?? (e.present ? e.version : undefined);
    e.updateAvailable = isUpdateAvailable(have, e.remoteVersion);
    if (!e.version) e.version = e.remoteVersion ?? '';
  }

  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
