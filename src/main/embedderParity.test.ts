// Sidecar vs the in-process transformers.js fallback on a fixed corpus: rows
// from either backend must agree to cosine >= 0.999. Both embed each text
// alone (padded q8 batches are not batch-invariant). Opt-in: needs the model
// cache and a built binary (CF_EMBED_PARITY=1, FLEET_EMBEDDER_BIN).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EmbedderClient } from './embedderClient.js';
import { ensureModelFiles } from './embedderModelFiles.js';
import { makeInProcessEmbedder } from './embeddingsInProcess.js';
import { dot, EMBED_DIM, EMBED_DTYPE, EMBED_HF_ID } from './vectors.js';
import { EMBED_HF_REVISION } from '../host/embedCheck.js';

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

  it.skipIf(process.env.CF_EMBED_REFERENCE_WRITE !== '1')('writes the host image reference vectors (D78)', async () => {
    const dir = await ensureModelFiles(HF_CACHE);
    const manifest = readFileSync(fileURLToPath(new URL('../../docker/host/embed-weights.sha256', import.meta.url)), 'utf8');
    for (const line of manifest.trim().split('\n')) {
      const [sha, file] = line.split(/\s+/);
      expect(createHash('sha256').update(readFileSync(join(dir, ...file.split('/')))).digest('hex'), file).toBe(sha);
    }
    // The oracle also reads config.json and tokenizer_config.json, which the manifest doesn't pin; the sidecar reads only the two pinned files.
    const vecs = await embedAll(makeInProcessEmbedder(HF_CACHE), BATCH);
    const buf = Buffer.alloc(vecs.length * EMBED_DIM * 4);
    vecs.forEach((v, i) => v.forEach((x, k) => buf.writeFloatLE(x, (i * EMBED_DIM + k) * 4)));
    const out = { model: EMBED_HF_ID, dtype: EMBED_DTYPE, revision: EMBED_HF_REVISION, dim: EMBED_DIM, texts: corpus, vectors: buf.toString('base64') };
    writeFileSync(fileURLToPath(new URL('../../embedder/reference/bge-small-q8.json', import.meta.url)), JSON.stringify(out, null, 1) + '\n');
  }, 600_000);
});
