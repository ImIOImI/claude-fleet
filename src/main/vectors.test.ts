import { describe, it, expect } from 'vitest';
import { encodeVector, encodeVectorInt8, decodeVector, dot, topK, EMBED_DIM, EMPTY_VECTOR } from './vectors.js';

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

  it('int8 encoding is 388 bytes and decodes within half a quantization step', () => {
    const v = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.sin(i * 1.7) / 10;
    const buf = encodeVectorInt8(v);
    expect(buf.length).toBe(EMBED_DIM + 4);
    const scale = buf.readFloatLE(0);
    const back = decodeVector(buf);
    expect(back.length).toBe(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(scale / 2 + 1e-7);
  });

  it('int8 of a zero vector decodes to zeros', () => {
    expect(Array.from(decodeVector(encodeVectorInt8(new Float32Array(EMBED_DIM)))).every((x) => x === 0)).toBe(true);
  });

  it('an empty or null vector decodes to an empty array', () => {
    expect(decodeVector(EMPTY_VECTOR).length).toBe(0);
    expect(decodeVector(null).length).toBe(0);
  });

  it('still decodes a legacy float32 vector of full width', () => {
    const v = new Float32Array(EMBED_DIM); v[3] = 0.5;
    expect(decodeVector(encodeVector(v))[3]).toBe(0.5);
  });
});
