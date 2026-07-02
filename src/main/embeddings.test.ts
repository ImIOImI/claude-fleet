import { describe, it, expect } from 'vitest';
import { makeEmbedder } from './embeddings.js';
import { EMBED_DIM, dot } from './vectors.js';

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
