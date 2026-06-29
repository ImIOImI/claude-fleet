// Live smoke test: one real anonymous pull from GHCR. Gated by NO_NETWORK so CI
// can opt out. Does NOT launch Electron — ociClient is a pure fetch module, so
// it runs in Node directly. We import from source via the Playwright ts setup.

import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SKIP = !!process.env.NO_NETWORK;

test.skip(SKIP, 'NO_NETWORK set — skipping live GHCR pull');

test('live: pulls the published claude-fleet-loadouts index from GHCR', async () => {
  // Import from the built output if available (post-build), otherwise source.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { pullArtifact } = await import('../out/main/ociClient.js').catch(
    async () => await import('../src/main/ociClient.js')
  ) as { pullArtifact: (ref: string, dest: string) => Promise<void> };

  const dest = await mkdtemp(join(tmpdir(), 'oci-live-'));
  try {
    await pullArtifact('ghcr.io/imioimi/claude-fleet-loadouts/index:latest', dest);
    const raw = await readFile(join(dest, 'index.json'), 'utf8');
    const index = JSON.parse(raw) as Array<{ id: string }>;
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBeGreaterThan(0);
    expect(index.map((l) => l.id)).toContain('spec-driven');
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
