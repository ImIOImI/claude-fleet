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
    // Async span = wall time incl. onnx threadpool; the sync tokenizer work
    // inside it is what can block the loop. texts attr sizes the batch.
    const out = await perfSpanAsync('claude_fleet.embed.run', () =>
      extractor(texts, { pooling: 'mean', normalize: true }), { texts: texts.length });
    return out.tolist().map((row) => {
      const v = new Float32Array(EMBED_DIM);
      for (let i = 0; i < EMBED_DIM; i++) v[i] = row[i] ?? 0;
      return v;
    });
  };
}
