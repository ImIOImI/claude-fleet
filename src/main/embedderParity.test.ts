// Sidecar vs the committed reference vectors (embedder/reference/bge-small-q8.json,
// written by embedder/scripts/write-reference.mjs with transformers.js), on the
// pinned model files. Opt-in: needs a built binary (CF_EMBED_PARITY=1, FLEET_EMBEDDER_BIN).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBED_PARITY_THRESHOLDS, parseReference, runEmbedCheck } from '../host/embedCheck.js';
import { EmbedderClient } from './embedderClient.js';
import { ensureModelFiles, SIDECAR_MODEL_FILES } from './embedderModelFiles.js';
import { EMBED_HF_REVISION, EMBED_MODEL_SHA256 } from './vectors.js';

const HF_CACHE = process.env.CF_HF_CACHE ?? join(tmpdir(), 'claude-fleet-hf-cache');
const BIN = process.env.FLEET_EMBEDDER_BIN ?? '';
const ENABLED = process.env.CF_EMBED_PARITY === '1' && existsSync(BIN);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('fleet-embedder parity with the reference vectors', () => {
  it('pins match docker/host/embed-weights.sha256', () => {
    const manifest = Object.fromEntries(read('../../docker/host/embed-weights.sha256').trim().split('\n').map((l) => l.split(/\s+/).reverse()));
    expect(manifest).toEqual(EMBED_MODEL_SHA256);
    expect(Object.keys(EMBED_MODEL_SHA256).sort()).toEqual([...SIDECAR_MODEL_FILES].sort());
  });

  it.skipIf(!ENABLED)('reproduces every reference vector on the pinned weights', async () => {
    const ref = parseReference(JSON.parse(read('../../embedder/reference/bge-small-q8.json')));
    expect(ref.revision).toBe(EMBED_HF_REVISION);
    const dir = await ensureModelFiles(HF_CACHE);
    for (const f of SIDECAR_MODEL_FILES) {
      expect(createHash('sha256').update(readFileSync(join(dir, ...f.split('/')))).digest('hex'), f).toBe(EMBED_MODEL_SHA256[f]);
    }
    const client = new EmbedderClient({
      bin: BIN,
      args: ['--model-dir', dir],
      onFatal: (why) => { throw new Error(why); },
      log: (m) => console.warn(m),
    });
    try {
      const r = await runEmbedCheck((t) => client.embed(t), ref, EMBED_PARITY_THRESHOLDS);
      console.log(`parity over ${r.n} texts: min cosine ${r.minCosine.toFixed(6)} (text ${r.minIndex}), mean ${r.meanCosine.toFixed(6)}`);
      expect(r.ok).toBe(true);
    } finally {
      client.dispose();
    }
  }, 600_000);
});
