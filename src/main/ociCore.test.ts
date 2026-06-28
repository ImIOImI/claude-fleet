// Unit tests for the pure loadout-library-v2 OCI core: ref parsing, layer-path
// safety, index parsing, version compare, and catalog assembly. No electron,
// no network, no fs. The `it.todo` blocks enumerate the networked / electron-
// wired behaviors that land with ociClient.ts and loadoutSources.ts.

import { describe, expect, it } from 'vitest';
import {
  parseImageRef,
  loadoutRefFromSource,
  safeLayerPath,
  parseIndex,
  compareVersions,
  isUpdateAvailable,
  assembleCatalog,
  SUPPORTED_REGISTRY
} from './ociCore.js';

describe('parseImageRef', () => {
  it('parses registry, repository and explicit tag', () => {
    expect(parseImageRef('ghcr.io/imioimi/claude-fleet-loadouts/spec-driven:1.0.0')).toEqual({
      registry: 'ghcr.io',
      repository: 'imioimi/claude-fleet-loadouts/spec-driven',
      tag: '1.0.0'
    });
  });
  it('defaults the tag to latest', () => {
    expect(parseImageRef('ghcr.io/owner/repo/name').tag).toBe('latest');
  });
  it('strips an oci:// scheme', () => {
    expect(parseImageRef('oci://ghcr.io/o/r').repository).toBe('o/r');
  });
  it('rejects a non-GHCR registry in v1', () => {
    expect(() => parseImageRef('docker.io/library/alpine')).toThrow(/unsupported registry/);
    expect(SUPPORTED_REGISTRY).toBe('ghcr.io');
  });
  it('rejects a bare name with no registry', () => {
    expect(() => parseImageRef('spec-driven')).toThrow(/invalid image reference/);
  });
});

describe('loadoutRefFromSource', () => {
  it('joins base + id + version', () => {
    expect(loadoutRefFromSource('ghcr.io/o/claude-fleet-loadouts', 'spec-driven', '1.2.0')).toBe(
      'ghcr.io/o/claude-fleet-loadouts/spec-driven:1.2.0'
    );
  });
  it('defaults to :latest and trims a trailing slash on the base', () => {
    expect(loadoutRefFromSource('ghcr.io/o/loadouts/', 'x')).toBe('ghcr.io/o/loadouts/x:latest');
  });
  it('rejects an id with path separators', () => {
    expect(() => loadoutRefFromSource('ghcr.io/o/l', '../evil')).toThrow(/invalid loadout id/);
  });
});

describe('safeLayerPath (security-critical)', () => {
  const dest = '/tmp/loadouts/spec-driven';
  it('resolves a normal relative title under the destination', () => {
    expect(safeLayerPath(dest, 'skills/foo/SKILL.md')).toBe('/tmp/loadouts/spec-driven/skills/foo/SKILL.md');
    expect(safeLayerPath(dest, 'loadout.md')).toBe('/tmp/loadouts/spec-driven/loadout.md');
  });
  it('rejects parent-traversal titles', () => {
    expect(() => safeLayerPath(dest, '../../etc/passwd')).toThrow(/unsafe layer path/);
    expect(() => safeLayerPath(dest, 'skills/../../escape')).toThrow(/unsafe layer path/);
  });
  it('rejects absolute titles', () => {
    expect(() => safeLayerPath(dest, '/etc/passwd')).toThrow(/unsafe layer path/);
  });
});

describe('parseIndex', () => {
  it('parses + normalizes a valid index (string or object)', () => {
    const json = JSON.stringify([
      { id: 'spec-driven', title: 'Spec Driven', description: 'd', tags: ['workflow'], version: '1.1.0' },
      { id: 'bare', version: '0.1.0' }
    ]);
    const out = parseIndex(json);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'spec-driven', title: 'Spec Driven', description: 'd', tags: ['workflow'], version: '1.1.0' });
    expect(out[1]).toEqual({ id: 'bare', title: 'bare', description: '', tags: [], version: '0.1.0' });
  });
  it('accepts a {loadouts:[...]} envelope', () => {
    expect(parseIndex({ loadouts: [{ id: 'x', version: '1.0.0' }] })).toHaveLength(1);
  });
  it('throws on a non-array / missing id / missing version', () => {
    expect(() => parseIndex('{}')).toThrow(/not an array/);
    expect(() => parseIndex([{ version: '1.0.0' }])).toThrow(/missing id/);
    expect(() => parseIndex([{ id: 'x' }])).toThrow(/missing version/);
  });
});

describe('compareVersions / isUpdateAvailable', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.3.0', '1.0.0')).toBe(-1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });
  it('ignores a prerelease suffix in v1', () => {
    expect(compareVersions('1.2.0-rc1', '1.2.0')).toBe(0);
  });
  it('flags an update only when remote is strictly newer', () => {
    expect(isUpdateAvailable('1.0.0', '1.1.0')).toBe(true);
    expect(isUpdateAvailable('1.1.0', '1.1.0')).toBe(false);
    expect(isUpdateAvailable('1.2.0', '1.1.0')).toBe(false);
    expect(isUpdateAvailable(undefined, '1.0.0')).toBe(false);
  });
});

describe('assembleCatalog', () => {
  const remote = [
    {
      source: 'ghcr.io/imioimi/claude-fleet-loadouts',
      loadouts: [
        { id: 'spec-driven', title: 'Spec Driven', description: 'r', tags: ['workflow'], version: '1.1.0' },
        { id: 'oci-loadout-repo', title: 'OCI repo', description: 'r', tags: ['ci'], version: '1.0.0' }
      ]
    }
  ];

  it('merges local + remote by id, deduped and sorted', () => {
    const cat = assembleCatalog({
      local: [{ id: 'spec-driven', title: 'Spec Driven', description: 'local', tags: ['workflow'], version: '1.0.0' }],
      remote
    });
    expect(cat.map((e) => e.id)).toEqual(['oci-loadout-repo', 'spec-driven']);
    const spec = cat.find((e) => e.id === 'spec-driven')!;
    expect(spec.present).toBe(true);
    expect(spec.sources).toEqual(['ghcr.io/imioimi/claude-fleet-loadouts']);
    expect(spec.remoteVersion).toBe('1.1.0');
  });

  it('flags updateAvailable when the remote version beats the installed/present one', () => {
    const cat = assembleCatalog({
      local: [{ id: 'spec-driven', title: 'S', description: '', tags: [], version: '1.0.0' }],
      remote,
      installed: [{ id: 'spec-driven', version: '1.0.0' }]
    });
    expect(cat.find((e) => e.id === 'spec-driven')!.updateAvailable).toBe(true);
    // remote-only entry, not installed → no false update
    expect(cat.find((e) => e.id === 'oci-loadout-repo')!.updateAvailable).toBe(false);
  });

  it('marks installed + favorited state', () => {
    const cat = assembleCatalog({
      local: [{ id: 'spec-driven', title: 'S', description: '', tags: [], version: '1.1.0' }],
      remote,
      installed: [{ id: 'spec-driven', version: '1.1.0' }],
      favorites: ['spec-driven']
    });
    const spec = cat.find((e) => e.id === 'spec-driven')!;
    expect(spec.installed).toBe(true);
    expect(spec.favorited).toBe(true);
    expect(spec.updateAvailable).toBe(false);
  });

  it('represents a remote-only loadout the user has not pulled yet', () => {
    const cat = assembleCatalog({ local: [], remote });
    const e = cat.find((x) => x.id === 'oci-loadout-repo')!;
    expect(e.present).toBe(false);
    expect(e.installed).toBe(false);
    expect(e.version).toBe('1.0.0');
  });
});

// ── Networked layer (ociClient.ts) — to implement ────────────────────────────
describe('ociClient (GHCR pull)', () => {
  it.todo('obtains an anonymous bearer via the 401 → /token flow for a public repo');
  it.todo('fetches a manifest and returns its com.claude-fleet.loadout.* annotations without pulling blobs');
  it.todo('pulls every layer blob by digest and reconstructs the tree from layer titles');
  it.todo('routes every layer write through safeLayerPath and aborts the pull on a traversal title');
  it.todo('enforces a per-blob size cap');
});

// ── Source + provenance + favorites layer (loadoutSources.ts) — to implement ──
describe('loadoutSources (electron-wired)', () => {
  it.todo('addSource validates a base ref by pulling + parsing its index, then persists it to <userData>/loadouts/sources.json');
  it.todo('removeSource drops a source and its cached index');
  it.todo('browseSource returns the cached index, refreshing on demand');
  it.todo('download pulls into <userData>/loadouts/<id>/ and records provenance {source, version}');
  it.todo('install pulls-if-absent-or-stale then runs the existing installLoadout (no standalone Download state)');
  it.todo('confirm-before-overwrite when a download collides with a locally-authored loadout of the same id');
  it.todo('favorites persist globally in config.json and toggle via the expanded card / modal');
  it.todo('the rail favorites filter narrows the list to favorited loadouts only');
  it.todo('downloads land only under host-private <userData>/loadouts and are never bind-mounted into a container (§9)');
});
