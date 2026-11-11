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

  it('pins the same revision as the Dockerfile', () => {
    expect(read('docker/host/Dockerfile')).toContain(`ARG EMBED_HF_REVISION=${EMBED_HF_REVISION}`);
  });

  it('refuses a reference for another model or with a short vector blob', () => {
    const raw = JSON.parse(read('embedder/reference/bge-small-q8.json'));
    expect(() => parseReference({ ...raw, model: 'other' })).toThrow(/model/);
    expect(() => parseReference({ ...raw, vectors: raw.vectors.slice(0, 100) })).toThrow();
    const oneShort = Buffer.from(raw.vectors, 'base64').subarray(384 * 4).toString('base64');
    expect(() => parseReference({ ...raw, vectors: oneShort })).toThrow();
  });

  it('refuses a vector blob longer than texts × dim', () => {
    const raw = JSON.parse(read('embedder/reference/bge-small-q8.json'));
    const oneLong = Buffer.concat([Buffer.from(raw.vectors, 'base64'), Buffer.alloc(384 * 4)]).toString('base64');
    expect(() => parseReference({ ...raw, vectors: oneLong })).toThrow(/bytes/);
    expect(() => parseReference({ ...raw, vectors: raw.vectors + 'AAAA' })).toThrow(/bytes/);
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

  // Rotates the vectors of texts with index in `which` by acos(c) toward the next reference vector, keeping them unit.
  const rotated = (c: number, which: (i: number) => boolean) => async (t: string[]) => t.map((x) => {
    const i = ref.texts.indexOf(x);
    const v = ref.vectors[i];
    if (!which(i)) return v;
    const w = ref.vectors[(i + 1) % ref.vectors.length];
    const d = dot(w, v);
    const u = w.map((y, k) => y - d * v[k]);
    const n = Math.sqrt(dot(u, u));
    return v.map((y, k) => c * y + Math.sqrt(1 - c * c) * (u[k] / n));
  });

  it('draws the line at cosine 0.995, unit norm within 1e-4 and one vector per text', async () => {
    const above = await runEmbedCheck(rotated(0.9952, (i) => i === 3), ref);
    expect(above).toMatchObject({ ok: true, minCosine: expect.closeTo(0.9952, 5), minIndex: 3 });
    expect(await runEmbedCheck(rotated(0.9948, (i) => i === 3), ref)).toMatchObject({ ok: false, minIndex: 3 });
    const scaled = async (t: string[]) => t.map((x) => ref.vectors[ref.texts.indexOf(x)].map((y) => y * 1.0002));
    expect((await runEmbedCheck(scaled, ref)).ok).toBe(false);
    const short = async (t: string[]) => t.slice(0, -1).map((x) => ref.vectors[ref.texts.indexOf(x)]);
    expect((await runEmbedCheck(short, ref)).ok).toBe(false);
  });

  it('requires mean cosine 0.9995 even when every text clears the minimum', async () => {
    const all = () => true;
    expect(await runEmbedCheck(rotated(0.9996, all), ref)).toMatchObject({ ok: true, meanCosine: expect.closeTo(0.9996, 5) });
    expect(await runEmbedCheck(rotated(0.9994, all), ref)).toMatchObject({ ok: false, minCosine: expect.closeTo(0.9994, 5), meanCosine: expect.closeTo(0.9994, 5) });
  });
});
