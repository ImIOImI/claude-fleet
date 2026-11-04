// Unit tests for AuthMode 'endpoint' + manifest endpointId round-trip (#250).
// electron is mocked so app.getPath('userData') resolves to a per-test temp dir;
// the rest is plain fs against workspace.json.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

const { readWorkspaceManifest, writeWorkspaceManifest, FACTORY_MIRROR } = await import(
  './workspaces.js'
);
const { workspaceManifestPath } = await import('./paths.js');
const { defaultCaptureSettings } = await import('../preload/captureSettings.js');

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

// #483 §5a: knowledgeCapture is an object of capture settings. Absent ⇒ all
// defaults; the parser is a strict allowlist that clamps every value; the
// task-10 boolean `false` still reads as { enabled: false }.
const knowledgeCaptureSpec = (knowledgeCapture?: unknown) =>
  ({
    id: ID,
    name: 'knowledge-capture-test',
    labels: [],
    workspaceRoot: tmpdir(),
    workspaceSubdir: '',
    kind: 'local',
    authMode: 'oauth',
    ...(knowledgeCapture !== undefined ? { knowledgeCapture } : {}),
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 1,
    lastUsedAt: 1
  }) as unknown as Parameters<typeof writeWorkspaceManifest>[0];

it('reads a legacy on-disk knowledgeCapture: false as { enabled: false } with every other default', async () => {
  const path = workspaceManifestPath(ID);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(knowledgeCaptureSpec(false)));
  expect((await readWorkspaceManifest(ID))?.knowledgeCapture).toEqual({ ...defaultCaptureSettings(), enabled: false });
});

it('omits knowledgeCapture when absent or a legacy true', async () => {
  await writeWorkspaceManifest(knowledgeCaptureSpec());
  expect((await readWorkspaceManifest(ID))?.knowledgeCapture).toBeUndefined();
  await writeWorkspaceManifest(knowledgeCaptureSpec(true));
  expect((await readWorkspaceManifest(ID))?.knowledgeCapture).toBeUndefined();
});

it('clamps knowledgeCapture on write and drops unknown fields', async () => {
  await writeWorkspaceManifest(knowledgeCaptureSpec({ searchTopSessions: 99, contextBands: [0.2], model: 'gpt-4', evil: true }));
  const raw = JSON.parse(await readFile(workspaceManifestPath(ID), 'utf8')) as { knowledgeCapture: unknown };
  expect(raw.knowledgeCapture).toEqual({ ...defaultCaptureSettings(), searchTopSessions: 5, contextBands: [0.5] });
  expect((await readWorkspaceManifest(ID))?.knowledgeCapture).toEqual(raw.knowledgeCapture);
});
