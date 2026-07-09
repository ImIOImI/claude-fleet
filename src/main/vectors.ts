// Pure vector helpers shared by the indexer (write side) and the MCP search
// tool (read side). No transformers/db imports here so mcpServer can use it
// without pulling in the model runtime.

export const EMBED_MODEL_ID = 'Xenova/bge-small-en-v1.5';
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
