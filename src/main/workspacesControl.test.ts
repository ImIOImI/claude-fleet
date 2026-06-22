// Committee grant round-trip through the manifest parser (#118). The parser is
// a strict allowlist that drops unrecognized fields — so the regression these
// tests guard is: a `control` / `accessibility` block written to disk MUST
// survive a read back (otherwise grants silently vanish on the next edit), and
// malformed blocks MUST be dropped to default-deny.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData' || which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

const { readWorkspaceManifest, writeWorkspaceManifest } = await import('./workspaces.js');
const { workspaceManifestPath } = await import('./paths.js');

const ID = '01WSCONTROLAAAAAAAAAAAAAAAA';

function baseSpec(over: object = {}) {
  return {
    id: ID,
    name: 'control-test',
    labels: [],
    workspaceRoot: '/tmp/x',
    workspaceSubdir: '',
    kind: 'container' as const,
    authMode: 'oauth' as const,
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on' as const, cleanup: 'delete' as const },
    createdAt: 1,
    lastUsedAt: 1,
    ...over
  };
}

async function writeRaw(body: object): Promise<void> {
  await mkdir(join(userDataDir, 'state', ID), { recursive: true });
  await writeFile(workspaceManifestPath(ID), JSON.stringify(body), 'utf8');
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'claude-fleet-control-'));
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('control/accessibility manifest round-trip (#118)', () => {
  it('preserves grants written via writeWorkspaceManifest (allowlist-drop regression)', async () => {
    const spec = baseSpec({
      control: { canControl: [{ id: '01EXPERT', verbs: ['read', 'post'] }] },
      accessibility: { reachable: true, acceptFrom: ['01MANAGER'], roleHint: 'security' }
    });
    await writeWorkspaceManifest(spec as never);

    const back = await readWorkspaceManifest(ID);
    expect(back?.control).toEqual({ canControl: [{ id: '01EXPERT', verbs: ['read', 'post'] }] });
    expect(back?.accessibility).toEqual({ reachable: true, acceptFrom: ['01MANAGER'], roleHint: 'security' });

    // And it is genuinely on disk, not just echoed.
    const onDisk = JSON.parse(await readFile(workspaceManifestPath(ID), 'utf8'));
    expect(onDisk.control.canControl[0].verbs).toEqual(['read', 'post']);
  });

  it('omits both blocks when absent (legacy manifests stay default-deny)', async () => {
    await writeRaw(baseSpec());
    const back = await readWorkspaceManifest(ID);
    expect(back?.control).toBeUndefined();
    expect(back?.accessibility).toBeUndefined();
  });

  it('sanitizes garbage: bad verbs, empty grants, non-boolean reachable are dropped', async () => {
    await writeRaw(
      baseSpec({
        control: {
          canControl: [
            { id: '01EXPERT', verbs: ['post', 'delete-everything'] }, // bogus verb filtered out
            { id: '01NOVERBS', verbs: [] }, // no surviving verbs ⇒ grant dropped
            { verbs: ['read'] } // missing id ⇒ dropped
          ]
        },
        accessibility: { reachable: 'yes' } // not a boolean ⇒ whole block dropped
      })
    );
    const back = await readWorkspaceManifest(ID);
    expect(back?.control).toEqual({ canControl: [{ id: '01EXPERT', verbs: ['post'] }] });
    expect(back?.accessibility).toBeUndefined();
  });

  it('drops a control block whose grants are all invalid (⇒ undefined, not empty)', async () => {
    await writeRaw(baseSpec({ control: { canControl: [{ id: 'x', verbs: ['nope'] }] } }));
    const back = await readWorkspaceManifest(ID);
    expect(back?.control).toBeUndefined();
  });
});
