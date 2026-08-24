// Unit tests for AuthMode 'endpoint' + manifest endpointId round-trip (#250).
// electron is mocked so app.getPath('userData') resolves to a per-test temp dir;
// the rest is plain fs against workspace.json.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      if (which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

const { readWorkspaceManifest, writeWorkspaceManifest, FACTORY_MIRROR, manifestInvariant } = await import(
  './workspaces.js'
);

const ID = '01ENDPOINTTEST0000000000WS';

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-wsendpoint-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

it('round-trips authMode endpoint + endpointId through the manifest (no oauth coercion)', async () => {
  // Build a minimal spec with authMode='endpoint' and an endpointId.
  // Cast as unknown to bypass the type-level restriction (the type
  // will expand in the implementing step; the test is written first).
  const spec = {
    id: ID,
    name: 'ep-test',
    labels: [],
    workspaceRoot: tmpdir(),
    workspaceSubdir: '',
    kind: 'container',
    authMode: 'endpoint',
    endpointId: 'ep-uuid-1',
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 1,
    lastUsedAt: 1
  } as unknown as Parameters<typeof writeWorkspaceManifest>[0];

  await writeWorkspaceManifest(spec);
  const back = await readWorkspaceManifest(ID);
  expect(back?.authMode).toBe('endpoint'); // NOT 'oauth'
  expect(back?.endpointId).toBe('ep-uuid-1');
});

it('still coerces garbage authMode to oauth', async () => {
  // Write a manifest with an unknown authMode directly (bypassing the type-safe
  // writer) and verify that readWorkspaceManifest sanitises it to 'oauth'.
  const dir = join(userDataDir, 'state', ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'workspace.json'),
    JSON.stringify({
      id: ID,
      name: 'garbage-auth',
      workspaceRoot: '/tmp/x',
      authMode: 'bogus',
      workspaceSubdir: '',
      labels: [],
      env: { plain: {}, secretKeys: [] },
      mirror: FACTORY_MIRROR,
      createdAt: 1,
      lastUsedAt: 1
    }),
    'utf8'
  );
  const back = await readWorkspaceManifest(ID);
  expect(back?.authMode).toBe('oauth');
});

// #268: per-workspace terminal renderer. The manifest parser is a strict
// allowlist, so an unlisted field silently vanishes on the next read/write —
// which is exactly how this would regress.
const rendererSpec = (terminalRenderer: unknown) =>
  ({
    id: ID,
    name: 'renderer-test',
    labels: [],
    workspaceRoot: tmpdir(),
    workspaceSubdir: '',
    kind: 'local',
    authMode: 'oauth',
    terminalRenderer,
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 1,
    lastUsedAt: 1
  }) as unknown as Parameters<typeof writeWorkspaceManifest>[0];

it('round-trips a per-workspace terminalRenderer through the manifest (#268)', async () => {
  for (const r of ['canvas', 'webgl', 'dom'] as const) {
    await writeWorkspaceManifest(rendererSpec(r));
    expect((await readWorkspaceManifest(ID))?.terminalRenderer).toBe(r);
  }
});

it('treats an absent terminalRenderer as inherit (undefined), not a value', async () => {
  await writeWorkspaceManifest(rendererSpec(undefined));
  expect((await readWorkspaceManifest(ID))?.terminalRenderer).toBeUndefined();
});

it('drops an unrecognised terminalRenderer rather than persisting it', async () => {
  // A hand-edited manifest must not be able to leave a pane unable to paint.
  await writeWorkspaceManifest(rendererSpec('vulkan'));
  expect((await readWorkspaceManifest(ID))?.terminalRenderer).toBeUndefined();
});

const base = () => ({
  id: '01TESTWS0000000000000000AA', name: 'ws', labels: [] as string[],
  workspaceRoot: '/workspace', workspaceSubdir: '', kind: 'container' as const,
  authMode: 'endpoint' as const, endpointId: 'ep-1',
  env: { plain: {}, secretKeys: [] }, mirror: { default: 'on' as const, cleanup: 'off' as const },
  createdAt: 1, lastUsedAt: 1
});

describe('harness field', () => {
  it('round-trips harness through write→read', async () => {
    await writeWorkspaceManifest({ ...base(), harness: 'qwen-code' } as never);
    const got = await readWorkspaceManifest(base().id);
    expect(got?.harness).toBe('qwen-code');
  });

  it('drops harness when authMode is not endpoint', async () => {
    const dir = join(userDataDir, 'state', base().id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'workspace.json'),
      JSON.stringify({ ...base(), authMode: 'oauth', endpointId: undefined, harness: 'qwen-code' }));
    const got = await readWorkspaceManifest(base().id);
    expect(got?.harness).toBeUndefined();
  });

  it('invariant rejects an endpoint workspace with no harness', () => {
    // harness is required for endpoint workspaces once the feature ships.
    expect(manifestInvariant({ ...base(), harness: undefined } as never)).toMatch(/harness/);
  });

  it('invariant accepts an endpoint workspace with a harness', () => {
    expect(manifestInvariant({ ...base(), harness: 'claude-code' } as never)).toBeNull();
  });
});
