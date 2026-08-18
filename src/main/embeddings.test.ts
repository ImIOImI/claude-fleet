import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { makeEmbedder } from './embeddings.js';
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
    const src = readFileSync(new URL('./embeddings.ts', import.meta.url), 'utf8');
    // `typeof import(...)` is a type-only annotation (erased at compile time) and is fine.
    expect(src).not.toMatch(/(?<!typeof )import\s*\(\s*['"]@huggingface/);
    expect(src).toContain('createRequire');
  });
});

describe('embeddings (real model)', () => {
  it.skipIf(!REAL_MODEL)('returns normalized 384-d vectors; related text scores higher than unrelated', async () => {
    const embed = makeEmbedder(HF_CACHE);
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
    const embed = makeEmbedder(HF_CACHE);
    expect(await embed([])).toEqual([]);
  });
});
