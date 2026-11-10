import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dot } from '../main/vectors.js';
import { EMBED_HF_REVISION, parseReference, runEmbedCheck } from './embedCheck.js';
import { EMBED_MODEL_FILES } from './embedder.js';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('embed reference (D78)', () => {
  const ref = parseReference(JSON.parse(read('embedder/reference/bge-small-q8.json')));

  it('covers the parity corpus with unit vectors', () => {
    expect(ref.texts).toEqual(JSON.parse(read('src/main/__fixtures__/embed-parity-corpus.json')));
    for (const v of ref.vectors) expect(Math.abs(Math.sqrt(dot(v, v)) - 1)).toBeLessThan(1e-4);
  });

  it('pins the same revision as embedCheck.ts and the manifest names both sidecar files', () => {
    expect(ref.revision).toBe(EMBED_HF_REVISION);
    expect(read('docker/host/embed-weights.sha256').trim().split('\n').map((l) => l.split(/\s+/)[1])).toEqual([...EMBED_MODEL_FILES]);
  });

  it.todo('pins the same revision as the Dockerfile', () => {
    expect(read('docker/host/Dockerfile')).toContain(`ARG EMBED_HF_REVISION=${EMBED_HF_REVISION}`);
  });

  it('refuses a reference for another model or with a short vector blob', () => {
    const raw = JSON.parse(read('embedder/reference/bge-small-q8.json'));
    expect(() => parseReference({ ...raw, model: 'other' })).toThrow(/model/);
    expect(() => parseReference({ ...raw, vectors: raw.vectors.slice(0, 100) })).toThrow();
    const oneShort = Buffer.from(raw.vectors, 'base64').subarray(384 * 4).toString('base64');
    expect(() => parseReference({ ...raw, vectors: oneShort })).toThrow();
  });
});

describe('runEmbedCheck', () => {
  const ref = parseReference(JSON.parse(read('embedder/reference/bge-small-q8.json')));
  it('passes the reference itself and fails a perturbed embedder', async () => {
    const same = async (t: string[]) => t.map((x) => ref.vectors[ref.texts.indexOf(x)]);
    expect(await runEmbedCheck(same, ref)).toMatchObject({ ok: true, n: 40, minCosine: expect.closeTo(1, 6) });
    const flipped = async (t: string[]) => (await same(t)).map((v, i) => (i === 0 ? v.map((x) => -x) : v));
    expect((await runEmbedCheck(flipped, ref)).ok).toBe(false);
  });

  it('draws the line at cosine 0.999, unit norm within 1e-4 and one vector per text', async () => {
    // Rotates the first text's vector by acos(c) toward another reference vector, keeping it unit.
    const rotated = (c: number) => async (t: string[]) => t.map((x) => {
      const v = ref.vectors[ref.texts.indexOf(x)];
      if (x !== ref.texts[0]) return v;
      const w = ref.vectors[1];
      const d = dot(w, v);
      const u = w.map((y, k) => y - d * v[k]);
      const n = Math.sqrt(dot(u, u));
      return v.map((y, k) => c * y + Math.sqrt(1 - c * c) * (u[k] / n));
    });
    const above = await runEmbedCheck(rotated(0.9992), ref);
    expect(above).toMatchObject({ ok: true, minCosine: expect.closeTo(0.9992, 5) });
    expect((await runEmbedCheck(rotated(0.9988), ref)).ok).toBe(false);
    const scaled = async (t: string[]) => t.map((x) => ref.vectors[ref.texts.indexOf(x)].map((y) => y * 1.0002));
    expect((await runEmbedCheck(scaled, ref)).ok).toBe(false);
    const short = async (t: string[]) => t.slice(0, -1).map((x) => ref.vectors[ref.texts.indexOf(x)]);
    expect((await runEmbedCheck(short, ref)).ok).toBe(false);
  });
});
