import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, dot, topK, EMBED_DIM } from './vectors.js';

describe('vectors', () => {
  it('round-trips a Float32 vector through BLOB encode/decode', () => {
    const v = Float32Array.from([0.5, -0.25, 1, 0]);
    const back = decodeVector(encodeVector(v));
    expect(Array.from(back)).toEqual([0.5, -0.25, 1, 0]);
  });

  it('decodeVector copies (independent of the source buffer)', () => {
    const v = Float32Array.from([1, 2, 3]);
    const buf = encodeVector(v);
    const back = decodeVector(buf);
    buf.fill(0);
    expect(Array.from(back)).toEqual([1, 2, 3]);
  });

  it('dot of unit vectors is cosine similarity', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([1, 0]);
    const c = Float32Array.from([0, 1]);
    expect(dot(a, b)).toBeCloseTo(1);
    expect(dot(a, c)).toBeCloseTo(0);
  });

  it('topK ranks by descending score and respects k', () => {
    const q = Float32Array.from([1, 0]);
    const cands = [
      { vec: Float32Array.from([0, 1]) },   // 0.0
      { vec: Float32Array.from([1, 0]) },   // 1.0
      { vec: Float32Array.from([0.7071, 0.7071]) }, // ~0.707
    ];
    const out = topK(q, cands, 2);
    expect(out.map((r) => r.index)).toEqual([1, 2]);
    expect(out[0].score).toBeCloseTo(1);
  });

  it('exposes the model identity constants', () => {
    expect(EMBED_DIM).toBe(384);
  });
});
