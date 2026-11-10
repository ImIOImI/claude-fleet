import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dot } from '../main/vectors.js';
import { EMBED_HF_REVISION, parseReference } from './embedCheck.js';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('embed reference (D78)', () => {
  const ref = parseReference(JSON.parse(read('embedder/reference/bge-small-q8.json')));

  it('covers the parity corpus with unit vectors', () => {
    expect(ref.texts).toEqual(JSON.parse(read('src/main/__fixtures__/embed-parity-corpus.json')));
    for (const v of ref.vectors) expect(Math.abs(Math.sqrt(dot(v, v)) - 1)).toBeLessThan(1e-4);
  });

  it.todo('pins the same revision as the Dockerfile and the manifest names both sidecar files', () => {
    expect(ref.revision).toBe(EMBED_HF_REVISION);
    expect(read('docker/host/Dockerfile')).toContain(`ARG EMBED_HF_REVISION=${EMBED_HF_REVISION}`);
    expect(read('docker/host/embed-weights.sha256').trim().split('\n').map((l) => l.split(/\s+/)[1])).toEqual(['tokenizer.json', 'onnx/model_quantized.onnx']);
  });

  it('refuses a reference for another model or with a short vector blob', () => {
    const raw = JSON.parse(read('embedder/reference/bge-small-q8.json'));
    expect(() => parseReference({ ...raw, model: 'other' })).toThrow(/model/);
    expect(() => parseReference({ ...raw, vectors: raw.vectors.slice(0, 100) })).toThrow();
    const oneShort = Buffer.from(raw.vectors, 'base64').subarray(384 * 4).toString('base64');
    expect(() => parseReference({ ...raw, vectors: oneShort })).toThrow();
  });
});
