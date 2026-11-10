// fleet-host embed-check (D78): the image's sidecar must reproduce the
// committed reference vectors before the image ships.
import { decodeVectors } from '../main/embedderClient.js';
import { EMBED_DIM, EMBED_HF_ID } from '../main/vectors.js';

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
