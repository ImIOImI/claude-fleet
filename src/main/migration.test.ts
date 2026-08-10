// Unit tests for the shared-OAuth credentials migration (Phase 3, #57).
//
// We mock the `electron` module so `app.getPath('userData')` resolves to
// a per-test temp dir. The rest of the migration is plain fs work, so
// the test can drive it directly against a populated state-dir tree.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

// Imported AFTER the mock so paths.ts picks up the stubbed electron.app.
const { runStartupMigration, migrateFleetFolders } = await import('./migration.js');
const { sharedClaudeCredentialsPath, workspaceClaudeDir } = await import('./paths.js');
const { writeWorkspaceManifest, listWorkspaceManifests, FACTORY_MIRROR } = await import('./workspaces.js');
const { fleetPrivateDir } = await import('./config.js');
type WorkspaceSpec = Parameters<typeof writeWorkspaceManifest>[0];

function seedSpec(over: Partial<WorkspaceSpec> & Pick<WorkspaceSpec, 'id' | 'kind' | 'workspaceRoot'>): WorkspaceSpec {
  return {
    name: 'w',
    labels: [],
    workspaceSubdir: '',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    mirror: FACTORY_MIRROR,
    createdAt: 1,
    lastUsedAt: 1,
    ...over
  } as WorkspaceSpec;
}

async function seedCreds(id: string, body: string, mtimeMs?: number): Promise<string> {
  const dir = workspaceClaudeDir(id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, '.credentials.json');
  await writeFile(path, body, 'utf8');
  if (mtimeMs != null) {
    // Force a specific mtime so we can assert which file the migration
    // picks as the "most recent".
    const { utimes } = await import('node:fs/promises');
    const t = mtimeMs / 1000;
    await utimes(path, t, t);
  }
  return path;
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'claude-fleet-migration-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('migrateOAuthCredentials', () => {
  it('no-ops when no workspaces exist', async () => {
    await runStartupMigration();
    // Shared dir may not exist at all — that's fine.
    const exists = await lstat(sharedClaudeCredentialsPath()).catch(() => null);
    expect(exists).toBeNull();
  });

  it('no-ops when a workspace has no credentials file', async () => {
    await mkdir(workspaceClaudeDir('01TESTA00000000000000000XY'), { recursive: true });
    await runStartupMigration();
    const exists = await lstat(sharedClaudeCredentialsPath()).catch(() => null);
    expect(exists).toBeNull();
  });

  it('promotes the most-recently-modified credentials file to the shared path', async () => {
    const idA = '01TESTAAAA00000000000000XY';
    const idB = '01TESTBBBB00000000000000XY';
    await seedCreds(idA, JSON.stringify({ token: 'A' }), 1_700_000_000_000);
    await seedCreds(idB, JSON.stringify({ token: 'B' }), 1_800_000_000_000); // newer

    await runStartupMigration();

    const shared = await readFile(sharedClaudeCredentialsPath(), 'utf8');
    expect(JSON.parse(shared).token).toBe('B');
  });

  it('replaces every per-workspace creds file with a symlink to the shared path', async () => {
    const idA = '01TESTAAAA00000000000000XY';
    const idB = '01TESTBBBB00000000000000XY';
    await seedCreds(idA, JSON.stringify({ token: 'A' }));
    await seedCreds(idB, JSON.stringify({ token: 'B' }));

    await runStartupMigration();

    const credsA = join(workspaceClaudeDir(idA), '.credentials.json');
    const credsB = join(workspaceClaudeDir(idB), '.credentials.json');
    const lstA = await lstat(credsA);
    const lstB = await lstat(credsB);
    expect(lstA.isSymbolicLink()).toBe(true);
    expect(lstB.isSymbolicLink()).toBe(true);
    expect(await readlink(credsA)).toBe(sharedClaudeCredentialsPath());
    expect(await readlink(credsB)).toBe(sharedClaudeCredentialsPath());
  });

  it('backs up the losers as .credentials.json.old', async () => {
    const idA = '01TESTAAAA00000000000000XY';
    const idB = '01TESTBBBB00000000000000XY';
    await seedCreds(idA, JSON.stringify({ token: 'A' }), 1_700_000_000_000);
    await seedCreds(idB, JSON.stringify({ token: 'B' }), 1_800_000_000_000);

    await runStartupMigration();

    // The winner (B) was renamed to the shared path — there's no .old
    // backup for it. The loser (A) gets a .old backup.
    const backupA = await readFile(
      join(workspaceClaudeDir(idA), '.credentials.json.old'),
      'utf8'
    );
    expect(JSON.parse(backupA).token).toBe('A');

    const backupB = await lstat(
      join(workspaceClaudeDir(idB), '.credentials.json.old')
    ).catch(() => null);
    expect(backupB).toBeNull();
  });

  it('is idempotent: a second run does nothing', async () => {
    const idA = '01TESTAAAA00000000000000XY';
    await seedCreds(idA, JSON.stringify({ token: 'A' }));

    await runStartupMigration();
    const sharedAfterFirst = await readFile(sharedClaudeCredentialsPath(), 'utf8');

    await runStartupMigration();
    const sharedAfterSecond = await readFile(sharedClaudeCredentialsPath(), 'utf8');
    expect(sharedAfterSecond).toBe(sharedAfterFirst);

    // No .old files appear on the second run — the per-workspace file
    // is already a symlink, so the migration sees nothing to back up.
    const stillNoBackup = await lstat(
      join(workspaceClaudeDir(idA), '.credentials.json.old')
    ).catch(() => null);
    expect(stillNoBackup).toBeNull();
  });

  it('skips empty credentials files (treats them as not real)', async () => {
    const idA = '01TESTAAAA00000000000000XY';
    await seedCreds(idA, ''); // empty

    await runStartupMigration();

    // Shared file shouldn't have been created (nothing to promote).
    const exists = await lstat(sharedClaudeCredentialsPath()).catch(() => null);
    expect(exists).toBeNull();
  });

  it('leaves a usable shared file alone when a new per-workspace file is added', async () => {
    // Prior run: shared file already has content.
    const sharedPath = sharedClaudeCredentialsPath();
    await mkdir(join(userDataDir, 'claude-shared'), { recursive: true });
    await writeFile(sharedPath, JSON.stringify({ token: 'SHARED' }), 'utf8');

    // User externally restored a per-workspace creds file.
    const idA = '01TESTAAAA00000000000000XY';
    await seedCreds(idA, JSON.stringify({ token: 'WORKSPACE-A' }));

    await runStartupMigration();

    // Shared content is preserved — the per-workspace file is treated
    // as stale and backed up.
    const shared = await readFile(sharedPath, 'utf8');
    expect(JSON.parse(shared).token).toBe('SHARED');
    const backup = await readFile(
      join(workspaceClaudeDir(idA), '.credentials.json.old'),
      'utf8'
    );
    expect(JSON.parse(backup).token).toBe('WORKSPACE-A');
    // And the per-workspace path is now a symlink to shared.
    const credsA = join(workspaceClaudeDir(idA), '.credentials.json');
    expect((await lstat(credsA)).isSymbolicLink()).toBe(true);
  });
});

describe('migrateFleetFolders — workspaceRoot canonicalization', () => {
  beforeEach(() => {
    // Deterministic <fleetRoot>/<id> without touching the real ~/fleet.
    process.env.CLAUDE_FLEET_ROOT = join(userDataDir, 'fleet');
  });
  afterEach(() => {
    delete process.env.CLAUDE_FLEET_ROOT;
  });

  const rootOf = async (id: string): Promise<string | undefined> =>
    (await listWorkspaceManifests()).find((m) => m.id === id)?.workspaceRoot;

  it('leaves a WSL local workspaceRoot untouched (the in-distro Linux path)', async () => {
    const id = '01TESTWSL0000000000000000A';
    await writeWorkspaceManifest(
      seedSpec({
        id,
        kind: 'local',
        workspaceRoot: '/home/troy/fleet/local-wsl',
        launcher: { mode: 'wsl', distro: 'Debian', shell: '/bin/bash', home: '/home/troy', claudePath: '/usr/bin/claude' }
      })
    );
    await migrateFleetFolders();
    // Must NOT be rewritten to <fleetRoot>/<id> (which wsl --cd would land in /mnt/c).
    expect(await rootOf(id)).toBe('/home/troy/fleet/local-wsl');
  });

  it('leaves a native local workspaceRoot untouched (the user-picked host dir)', async () => {
    const id = '01TESTNATIVE00000000000000';
    await writeWorkspaceManifest(seedSpec({ id, kind: 'local', workspaceRoot: 'C:\\Users\\troy\\proj' }));
    await migrateFleetFolders();
    expect(await rootOf(id)).toBe('C:\\Users\\troy\\proj');
  });

  it('canonicalizes a container workspaceRoot to <fleetRoot>/<id>', async () => {
    const id = '01TESTCONTAINER0000000000A';
    await writeWorkspaceManifest(
      seedSpec({ id, kind: 'container', image: 'img:latest', workspaceRoot: '/some/stale/pre-migration/path' })
    );
    await migrateFleetFolders();
    expect(await rootOf(id)).toBe(await fleetPrivateDir(id));
  });
});
