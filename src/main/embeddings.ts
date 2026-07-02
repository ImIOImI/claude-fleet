// Local, on-host embedding model (native onnxruntime-node backend). Transcript
// text never leaves the machine. Lazy-loads the model once per process.
import { EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export function makeEmbedder(cacheDir: string): (texts: string[]) => Promise<Float32Array[]> {
  let extractorP: Promise<Extractor> | null = null;

  async function load(): Promise<Extractor> {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;          // cache weights under <userData>
    env.allowRemoteModels = true;     // fetch once on first use
    return (await pipeline('feature-extraction', EMBED_MODEL_ID)) as unknown as Extractor;
  }

  return async function embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!extractorP) extractorP = load();
    const extractor = await extractorP;
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist().map((row) => {
      const v = new Float32Array(EMBED_DIM);
      for (let i = 0; i < EMBED_DIM; i++) v[i] = row[i] ?? 0;
      return v;
    });
  };
}
