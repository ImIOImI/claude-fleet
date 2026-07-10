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

/** BLOB → Float32Array. Copies, so the result is independent of `buf`. */
export function decodeVector(buf: Buffer): Float32Array {
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
