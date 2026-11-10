// fleet-host embed-check (D78): the image's sidecar must reproduce the
// committed reference vectors before the image ships.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeVectors } from '../main/embedderClient.js';
import { dot, EMBED_DIM, EMBED_HF_ID, type EmbedFn } from '../main/vectors.js';
import { DEFAULT_EMBED_DIR } from './config.js';
import { startHostEmbedder } from './embedder.js';
import { createLogger } from './log.js';

/** HF commit of the baked weights; docker/host/Dockerfile's EMBED_HF_REVISION. */
export const EMBED_HF_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';

export interface EmbedReference { model: string; dtype: string; revision: string; dim: number; texts: string[]; vectors: string }

export function parseReference(v: unknown): { revision: string; texts: string[]; vectors: Float32Array[] } {
  const r = v as Partial<EmbedReference> | null;
  if (!r || typeof r !== 'object') throw new Error('reference: not an object');
  if (r.model !== EMBED_HF_ID || r.dtype !== 'q8') throw new Error(`reference: model ${String(r.model)}/${String(r.dtype)} is not ${EMBED_HF_ID}/q8`);
  if (r.dim !== EMBED_DIM) throw new Error(`reference: dim ${String(r.dim)}`);
  if (typeof r.revision !== 'string' || !Array.isArray(r.texts) || r.texts.length === 0 || r.texts.some((t) => typeof t !== 'string') || typeof r.vectors !== 'string') {
    throw new Error('reference: needs revision, texts and vectors');
  }
  return { revision: r.revision, texts: r.texts, vectors: decodeVectors(r.vectors, r.texts.length, EMBED_DIM) };
}

// Runner CPUs' int8 kernels differ by up to ~2e-3 per text; broken weights or tokenization score <= 0.967.
export const EMBED_CHECK_MIN_COSINE = 0.995;
export const EMBED_CHECK_MIN_MEAN_COSINE = 0.9995;
const CHECK_BATCH = 8;

export async function runEmbedCheck(embed: EmbedFn, ref: { texts: string[]; vectors: Float32Array[] }): Promise<{ ok: boolean; n: number; minCosine: number; minIndex: number; meanCosine: number }> {
  const cos: number[] = [];
  let unit = true;
  for (let i = 0; i < ref.texts.length; i += CHECK_BATCH) {
    const got = await embed(ref.texts.slice(i, i + CHECK_BATCH));
    got.forEach((v, k) => {
      cos.push(dot(v, ref.vectors[i + k]));
      if (Math.abs(Math.sqrt(dot(v, v)) - 1) > 1e-4) unit = false;
    });
  }
  const minCosine = Math.min(...cos);
  const minIndex = cos.indexOf(minCosine);
  const meanCosine = cos.reduce((a, b) => a + b, 0) / cos.length;
  const ok = unit && cos.length === ref.texts.length && minCosine >= EMBED_CHECK_MIN_COSINE && meanCosine >= EMBED_CHECK_MIN_MEAN_COSINE;
  return { ok, n: cos.length, minCosine, minIndex, meanCosine };
}

async function peakRssKiB(pid: number | undefined): Promise<number | null> {
  if (!pid) return null;
  const m = /VmHWM:\s+(\d+) kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''));
  return m ? Number(m[1]) : null;
}

/** `fleet-host embed-check [reference.json]`: 0 when the sidecar reproduces the reference. */
export async function embedCheckCli(args: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const dir = env.FLEET_HOST_EMBED_DIR || DEFAULT_EMBED_DIR;
  const e = startHostEmbedder({ dir, log: createLogger((l) => process.stderr.write(l + '\n')) });
  try {
    const ref = parseReference(JSON.parse(await readFile(args[0] ?? join(dir, 'reference.json'), 'utf8')));
    const r = await runEmbedCheck(e.embed, ref);
    out(JSON.stringify({ ...r, revision: ref.revision, peakRssKiB: await peakRssKiB(e.pid()) }));
    return r.ok ? 0 : 1;
  } catch (err) {
    out(JSON.stringify({ ok: false, error: (err as Error).message }));
    return 1;
  } finally {
    e.close();
  }
}
