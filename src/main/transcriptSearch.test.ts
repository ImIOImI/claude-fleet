import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine } from './db.js';
import { indexSessionTurns, searchTranscripts } from './transcriptIndex.js';
import { EMBED_DIM } from './vectors.js';

// Stub embedder mapping known phrases to fixed directions in 2 dims of the space.
const dir2 = (a: number, b: number) => { const v = new Float32Array(EMBED_DIM); v[0] = a; v[1] = b; return v; };
const stub = async (texts: string[]) => texts.map((t) =>
  t.includes('banana') ? dir2(0, 1) : dir2(1, 0));

let dir: string; const A = '01WSA', B = '01WSB';
const line = (o: object) => JSON.stringify(o);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-search-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

async function seed() {
  ingestLine(A, 'sa', line({ type: 'user', uuid: 'a1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'fixing the broker bug' } }));
  ingestLine(B, 'sb', line({ type: 'user', uuid: 'b1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'a banana recipe' } }));
  await indexSessionTurns('sa', stub);
  await indexSessionTurns('sb', stub);
}

describe('searchTranscripts', () => {
  it('ranks the semantically closest turn first', async () => {
    await seed();
    const hits = await searchTranscripts('broker debugging', new Set([A, B]), stub, { limit: 5 });
    expect(hits[0].text).toContain('broker bug');
  });

  it('never returns rows outside allowedWorkspaces', async () => {
    await seed();
    const hits = await searchTranscripts('banana', new Set([A]), stub); // only A allowed
    expect(hits.every((h) => h.workspaceId === A)).toBe(true);
    expect(hits.some((h) => h.workspaceId === B)).toBe(false);
  });

  it('returns [] for an empty allowed set', async () => {
    await seed();
    expect(await searchTranscripts('x', new Set<string>(), stub)).toEqual([]);
  });
});
