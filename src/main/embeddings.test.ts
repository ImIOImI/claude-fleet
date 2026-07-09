import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { makeEmbedder } from './embeddings.js';
import { EMBED_DIM, dot } from './vectors.js';

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
  it('returns normalized 384-d vectors; related text scores higher than unrelated', async () => {
    const embed = makeEmbedder('/workspace/claude-fleet/.hf-cache');
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
    const embed = makeEmbedder('/workspace/claude-fleet/.hf-cache');
    expect(await embed([])).toEqual([]);
  });
});
