// In-process transformers.js embedder (native onnxruntime-node backend): the
// fallback when the fleet-embedder sidecar is unavailable, and the parity
// oracle (embedderParity.test.ts). Lazy-loads the model once per process.
import { createRequire } from 'node:module';
import { EMBED_HF_ID, EMBED_DTYPE, EMBED_DIM } from './vectors.js';
import { perfSpan, perfSpanAsync } from './perf.js';

// transformers must load through the CJS loader: a dynamic import() resolves
// via Electron's ESM loader, which cannot load packages from inside app.asar
// (mangled ERR_MODULE_NOT_FOUND on every call in packaged builds — #194).
// require() picks the package's dist/transformers.node.cjs entry and honors
// asarUnpack redirection, same as better-sqlite3/keytar.
const requireCjs = createRequire(import.meta.url);

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export function makeInProcessEmbedder(cacheDir: string): (texts: string[]) => Promise<Float32Array[]> {
  let extractorP: Promise<Extractor> | null = null;

  async function load(): Promise<Extractor> {
    // Synchronous require of transformers + the native onnxruntime binding —
    // spanned so a startup stall it causes self-attributes (it runs on the
    // main loop the first time anything embeds, i.e. the startup backfill).
    const { pipeline, env } = perfSpan('claude_fleet.embed.require', () =>
      requireCjs('@huggingface/transformers') as typeof import('@huggingface/transformers'));
    env.cacheDir = cacheDir;          // cache weights under <userData>
    env.allowRemoteModels = true;     // fetch once on first use
    return (await perfSpanAsync('claude_fleet.embed.load', () =>
      pipeline('feature-extraction', EMBED_HF_ID, { dtype: EMBED_DTYPE }))) as unknown as Extractor;
  }

  return async function embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!extractorP) extractorP = load();
    const extractor = await extractorP;
    // One text per call, unpadded, like the sidecar: q8 activations are
    // quantized per tensor, so padding would make a vector depend on its
    // batch neighbours. Async span = wall time incl. onnx threadpool.
    return perfSpanAsync('claude_fleet.embed.run', async () => {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const [row] = (await extractor([text], { pooling: 'mean', normalize: true })).tolist();
        const v = new Float32Array(EMBED_DIM);
        for (let i = 0; i < EMBED_DIM; i++) v[i] = row[i] ?? 0;
        out.push(v);
      }
      return out;
    }, { texts: texts.length });
  };
}
