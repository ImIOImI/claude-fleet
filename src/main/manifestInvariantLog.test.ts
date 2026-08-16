// The invariant DETECTOR is unit-tested in workspacesLauncher.test.ts. This
// covers the half that actually matters in the wild (#323): that a violating
// write really does land a line in error.log.
//
// Worth testing separately because the logger is imported lazily inside
// writeWorkspaceManifest — errorLog pulls in electron, and this module is
// loaded by unit tests that don't mock it — so a broken lazy import would
// silently log nothing, which is precisely the failure mode being fixed.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_DATA = mkdtempSync(join(tmpdir(), 'cf-invariant-'));

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getVersion: () => '0.0.0-test' }
}));

const { writeWorkspaceManifest } = await import('./workspaces.js');

const LOG = join(USER_DATA, 'error.log');
const WS = '01INVARIANTTESTWS0000000WS';

const base = {
  id: WS,
  name: 'invariant-test',
  labels: [],
  workspaceSubdir: '',
  authMode: 'oauth',
  env: { plain: {}, secretKeys: [] },
  mirror: { default: 'on', cleanup: 'preserve' },
  createdAt: 0,
  lastUsedAt: 0
} as unknown as Parameters<typeof writeWorkspaceManifest>[0];

const WSL = {
  mode: 'wsl' as const,
  distro: 'Ubuntu-24.04',
  shell: '/bin/zsh',
  home: '/home/troy',
  claudePath: '/home/troy/.local/bin/claude'
};

function logLines(): Array<Record<string, unknown>> {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The lazy import resolves on a later microtask than the write completes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && logLines().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('writeWorkspaceManifest — invariant logging (#323)', () => {
  beforeEach(() => {
    rmSync(LOG, { force: true });
    rmSync(join(USER_DATA, 'state'), { recursive: true, force: true });
  });
  afterAll(() => rmSync(USER_DATA, { recursive: true, force: true }));

  it('logs a violating write, with the stack that identifies the caller', async () => {
    await writeWorkspaceManifest({
      ...base,
      kind: 'local',
      launcher: WSL,
      workspaceRoot: 'C:\\Users\\troyk\\fleet\\01KZKC42R3NZ00F8DRFYZV3XPP'
    });
    await settle();

    const entry = logLines().find((e) => e.type === 'manifest-invariant');
    expect(entry, 'no manifest-invariant entry was written').toBeTruthy();
    expect(entry!.level).toBe('error');
    expect(entry!.workspaceId).toBe(WS);
    expect(String(entry!.message)).toContain('non-Linux workspaceRoot');
    // The stack is the whole point — #323 is open because we can see the bad
    // state on disk and can't tell which code path produced it.
    const extra = entry!.extra as Record<string, unknown>;
    expect(String(extra.stack)).toContain('manifest-invariant');
    expect(extra.workspaceRoot).toBe('C:\\Users\\troyk\\fleet\\01KZKC42R3NZ00F8DRFYZV3XPP');
  });

  it('still writes the manifest — detection must not block the write', async () => {
    await writeWorkspaceManifest({
      ...base,
      kind: 'local',
      launcher: WSL,
      workspaceRoot: 'C:\\Users\\troyk\\fleet\\ws'
    });
    const manifest = join(USER_DATA, 'state', WS, 'workspace.json');
    expect(existsSync(manifest)).toBe(true);
  });

  it('stays silent for a coherent manifest', async () => {
    await writeWorkspaceManifest({
      ...base,
      kind: 'local',
      launcher: WSL,
      workspaceRoot: '/home/troy/proj'
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(logLines().filter((e) => e.type === 'manifest-invariant')).toEqual([]);
  });
});
