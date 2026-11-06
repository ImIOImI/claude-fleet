import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { makeEmbedder, resolveEmbedderBin } from './embeddings.js';
import { makeInProcessEmbedder } from './embeddingsInProcess.js';
import { EMBED_DIM, dot } from './vectors.js';

// Where the model weights get cached. This was hard-coded to
// `/workspace/claude-fleet/.hf-cache` — an absolute path that only exists
// inside the dev container — so the suite failed with `EACCES: mkdir
// '/workspace'` for anyone running it anywhere else, CI included (#311).
const HF_CACHE = process.env.CF_HF_CACHE ?? join(tmpdir(), 'claude-fleet-hf-cache');

// The real-model test pulls ~90 MB of weights on a cold cache. Runner
// filesystems are ephemeral, so in CI that download would happen on every run
// and put a network dependency in front of the whole unit suite — the reason
// #311 flagged this as the blocker to running vitest in CI. Stays ON for local
// runs (where the cache persists between runs) and off in CI; set
// CF_EMBED_REAL=1 to force it anywhere. Restoring real-model coverage in CI
// wants an actions/cache step keyed on HF_CACHE — noted in #311.
const REAL_MODEL = process.env.CF_EMBED_REAL === '1' || !process.env.CI;

describe('embeddings loader (packaged-app regression, #194)', () => {
  it('loads transformers via CJS require, never dynamic import()', () => {
    // In the packaged app, `import('@huggingface/transformers')` goes through
    // Electron's ESM loader against a path inside app.asar, which fails with a
    // mangled ERR_MODULE_NOT_FOUND on every search_transcripts call (#194).
    // The CJS loader handles asar + asarUnpack redirection correctly, so the
    // module must be loaded with createRequire, like the other native deps.
    const src = readFileSync(new URL('./embeddingsInProcess.ts', import.meta.url), 'utf8');
    // `typeof import(...)` is a type-only annotation (erased at compile time) and is fine.
    expect(src).not.toMatch(/(?<!typeof )import\s*\(\s*['"]@huggingface/);
    expect(src).toContain('createRequire');
  });
});

describe('embeddings (real model)', () => {
  it.skipIf(!REAL_MODEL)('returns normalized 384-d vectors; related text scores higher than unrelated', async () => {
    const embed = makeInProcessEmbedder(HF_CACHE);
    const [q, near, far] = await embed([
      'how do I fix the broker PTY reconnect bug',
      'debugging the broker pseudo-terminal reconnection issue',
      'a recipe for banana bread',
    ]);
    expect(q.length).toBe(EMBED_DIM);
    expect(Math.sqrt(dot(q, q))).toBeCloseTo(1, 2);
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  }, 120_000); // first run downloads the model

  it('returns [] for empty input', async () => {
    // Short-circuits before the model loads, so this needs no weights and runs
    // everywhere — it only ever needed a writable cache path.
    expect(await makeInProcessEmbedder(HF_CACHE)([])).toEqual([]);
    expect(await makeEmbedder(HF_CACHE)([])).toEqual([]);
  });
});

const unit = (i: number) => { const v = new Float32Array(EMBED_DIM); v[i] = 1; return v; };

describe('resolveEmbedderBin', () => {
  const base = { env: {}, platform: 'linux' as const, packaged: true, resourcesPath: '/res', appPath: '/app' };
  it('prefers FLEET_EMBEDDER_BIN, then the packaged resource', () => {
    expect(resolveEmbedderBin({ ...base, env: { FLEET_EMBEDDER_BIN: '/x' }, exists: () => true })).toBe('/x');
    expect(resolveEmbedderBin({ ...base, exists: (p) => p !== '/x' })).toBe(join('/res', 'embedder', 'fleet-embedder'));
  });
  it('uses the dev build and .exe on Windows', () => {
    expect(resolveEmbedderBin({ ...base, platform: 'win32', packaged: false, exists: () => true }))
      .toBe(join('/app', 'embedder', 'target', 'release', 'fleet-embedder.exe'));
  });
  it('returns null when nothing exists', () => {
    expect(resolveEmbedderBin({ ...base, exists: () => false })).toBeNull();
  });
});

describe('makeEmbedder backend selection', () => {
  const ensureFiles = async () => '/unused';

  it('falls back in process when the binary is missing', async () => {
    const inProcess = vi.fn(async (t: string[]) => t.map(() => unit(0)));
    const embed = makeEmbedder(HF_CACHE, { bin: null, inProcess: () => inProcess, ensureFiles });
    expect(await embed(['a'])).toEqual([unit(0)]);
    expect(inProcess).toHaveBeenCalledOnce();
  });

  it('honors forceInProcess', async () => {
    const inProcess = vi.fn(async (t: string[]) => t.map(() => unit(0)));
    const embed = makeEmbedder(HF_CACHE, { bin: process.execPath, forceInProcess: true, inProcess: () => inProcess, ensureFiles });
    await embed(['a']);
    expect(inProcess).toHaveBeenCalledOnce();
  });

  it('switches to in-process after a sidecar crash loop', async () => {
    const inProcess = vi.fn(async (t: string[]) => t.map(() => unit(7)));
    const embed = makeEmbedder(HF_CACHE, { bin: '/nonexistent/fleet-embedder', inProcess: () => inProcess, ensureFiles });
    let out: Float32Array[] | null = null;
    for (let i = 0; i < 3 && !out; i++) out = await embed(['a']).catch(() => null);
    expect(out).toEqual([unit(7)]);
    expect(await embed(['b'])).toEqual([unit(7)]);
  }, 30_000);
});
