// Pure vector helpers shared by the indexer (write side) and the MCP search
// tool (read side). No transformers/db imports here so mcpServer can use it
// without pulling in the model runtime.

/** HuggingFace repo the embedder loads. */
export const EMBED_HF_ID = 'Xenova/bge-small-en-v1.5';
/** Quantization the embedder runs at. q8 cuts steady-state RSS from
 *  1.9–3.4 GB (fp32, growing per batch — the ORT arena never shrinks) to
 *  ~300 MB at the indexer's batch/truncation settings, with negligible
 *  retrieval-quality loss for bge-small. */
export const EMBED_DTYPE = 'q8';
/** DB key for embedding rows. Includes the dtype: q8 vectors are not
 *  comparable to fp32 ones, so a dtype change re-keys (and re-embeds)
 *  everything rather than mixing incompatible vectors in one search. */
export const EMBED_MODEL_ID = `${EMBED_HF_ID}@${EMBED_DTYPE}`;
export const EMBED_DIM = 384;

/** Float32Array → little-endian BLOB. */
export function encodeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** A placeholder turn's stored vector: none. */
export const EMPTY_VECTOR = Buffer.alloc(0);

/** Float32Array → `[float32 scale LE][int8 × n]`, scale = max|v| / 127. Ranking
 *  vs float32 measured on real turns: recall@10 0.992, top-1 agreement 99%. */
export function encodeVectorInt8(v: Float32Array): Buffer {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max / 127;
  const out = Buffer.alloc(4 + v.length);
  out.writeFloatLE(scale, 0);
  for (let i = 0; i < v.length; i++) out.writeInt8(scale === 0 ? 0 : Math.round(v[i] / scale), 4 + i);
  return out;
}

/** BLOB → Float32Array, dispatching on length: EMBED_DIM + 4 bytes is int8,
 *  otherwise float32; empty or null is no vector. Copies. */
export function decodeVector(buf: Buffer | null): Float32Array {
  if (!buf || buf.byteLength === 0) return new Float32Array(0);
  if (buf.byteLength === EMBED_DIM + 4) {
    const scale = buf.readFloatLE(0);
    const out = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) out[i] = buf.readInt8(4 + i) * scale;
    return out;
  }
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Dot product. For L2-normalized vectors this equals cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function topK(
  query: Float32Array,
  candidates: { vec: Float32Array }[],
  k: number,
): { index: number; score: number }[] {
  const scored = candidates.map((c, index) => ({ index, score: dot(query, c.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;
