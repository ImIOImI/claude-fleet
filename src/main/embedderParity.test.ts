// Sidecar vs the in-process transformers.js fallback on a fixed corpus: rows
// from either backend must agree to cosine >= 0.999. Both embed each text
// alone (padded q8 batches are not batch-invariant). Opt-in: needs the model
// cache and a built binary (CF_EMBED_PARITY=1, FLEET_EMBEDDER_BIN).
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmbedderClient } from './embedderClient.js';
import { ensureModelFiles } from './embedderModelFiles.js';
import { makeInProcessEmbedder } from './embeddingsInProcess.js';
import { dot } from './vectors.js';

const HF_CACHE = process.env.CF_HF_CACHE ?? join(tmpdir(), 'claude-fleet-hf-cache');
const BIN = process.env.FLEET_EMBEDDER_BIN ?? '';
const ENABLED = process.env.CF_EMBED_PARITY === '1' && existsSync(BIN);
const BATCH = 8;

const corpus = JSON.parse(readFileSync(new URL('./__fixtures__/embed-parity-corpus.json', import.meta.url), 'utf8')) as string[];

async function embedAll(embed: (t: string[]) => Promise<Float32Array[]>, batch: number): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < corpus.length; i += batch) out.push(...await embed(corpus.slice(i, i + batch)));
  return out;
}

describe('fleet-embedder parity with transformers.js', () => {
  it.skipIf(!ENABLED)('cosine >= 0.999 and unit norm for every corpus text', async () => {
    const reference = await embedAll(makeInProcessEmbedder(HF_CACHE), BATCH);
    const client = new EmbedderClient({
      bin: BIN,
      args: ['--model-dir', await ensureModelFiles(HF_CACHE)],
      onFatal: (why) => { throw new Error(why); },
      log: (m) => console.warn(m),
    });
    try {
      const sidecar = await embedAll((t) => client.embed(t), BATCH);
      const cos = reference.map((r, i) => dot(r, sidecar[i]));
      const min = Math.min(...cos);
      const mean = cos.reduce((a, b) => a + b, 0) / cos.length;
      console.log(`parity over ${cos.length} texts: min cosine ${min.toFixed(6)}, mean ${mean.toFixed(6)}`);
      cos.forEach((c, i) => expect(c, `text ${i}: ${corpus[i].slice(0, 40)}`).toBeGreaterThanOrEqual(0.999));
      for (const v of sidecar) expect(Math.abs(Math.sqrt(dot(v, v)) - 1)).toBeLessThan(1e-4);
    } finally {
      client.dispose();
    }
  }, 600_000);
});
