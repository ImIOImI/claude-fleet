// Built-in starter seeding (#16-followup). Mocks electron so userData resolves
// to a temp dir (same pattern as claudeJsonSeed.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

const { ensureBuiltinLoadouts, listLoadouts, getLoadout, installLoadout, uninstallLoadout } =
  await import('./loadouts.js');
const { loadoutDir } = await import('./paths.js');
const { writeWorkspaceManifest, readWorkspaceManifest } = await import('./workspaces.js');

async function present(p: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  return stat(p).then(() => true).catch(() => false);
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'loadouts-seed-'));
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('ensureBuiltinLoadouts', () => {
  it('seeds the built-in starters, including the loadout-author skill', async () => {
    await ensureBuiltinLoadouts();
    const ids = (await listLoadouts()).map((l) => l.id);
    expect(ids).toEqual(
      expect.arrayContaining(['spec-driven', 'conventional-commits', 'loadout-author'])
    );

    const la = await getLoadout('loadout-author');
    expect(la.title).toBe('Loadout Author');
    expect(la.tags).toContain('authoring');
    // It ships a project skill that teaches the loadout format.
    expect(la.files).toContain('.claude/skills/writing-loadouts/SKILL.md');
  });

  it('seeds a missing starter without clobbering one the user edited', async () => {
    // User already has an edited spec-driven loadout on disk.
    await mkdir(loadoutDir('spec-driven'), { recursive: true });
    await writeFile(
      join(loadoutDir('spec-driven'), 'loadout.md'),
      '---\ntitle: My Spec Rules\n---\nedited',
      'utf8'
    );

    await ensureBuiltinLoadouts();

    // Edited starter is preserved…
    expect(await readFile(join(loadoutDir('spec-driven'), 'loadout.md'), 'utf8')).toContain(
      'My Spec Rules'
    );
    // …and the newly-shipped one is still seeded.
    expect((await getLoadout('loadout-author')).title).toBe('Loadout Author');
  });
});

describe('install / uninstall with the full apply model (files + merges)', () => {
  it('applies drop files + CLAUDE.md + settings/.mcp/hooks merges, tracks them, and reverts on uninstall', async () => {
    process.env.CLAUDE_FLEET_ROOT = join(userDataDir, 'fleet');
    // Author a loadout exercising every apply path.
    const ld = loadoutDir('test-merge');
    await mkdir(join(ld, 'skills', 'demo'), { recursive: true });
    await writeFile(join(ld, 'loadout.md'), '---\ntitle: Test Merge\n---\nbody', 'utf8');
    await writeFile(join(ld, 'skills', 'demo', 'SKILL.md'), '# demo', 'utf8');
    await writeFile(join(ld, 'CLAUDE.md'), 'rule line', 'utf8');
    await writeFile(join(ld, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }), 'utf8');
    await writeFile(join(ld, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'y' } } }), 'utf8');
    await writeFile(join(ld, 'hooks.json'), JSON.stringify({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'z' }] }] }), 'utf8');

    const wsId = '01WSMERGE0000000000000000A';
    await writeWorkspaceManifest({
      id: wsId, name: 'ws', labels: [], workspaceRoot: '', workspaceSubdir: '',
      kind: 'container', authMode: 'oauth', env: { plain: {}, secretKeys: [] },
      mirror: { default: 'on', cleanup: 'delete' }, createdAt: 1, lastUsedAt: 1
    });

    const res = await installLoadout(wsId, 'test-merge');
    expect(res.installed.merges?.settingsKeys).toContain('statusLine');
    expect(res.installed.merges?.mcpServers).toContain('demo');
    expect(res.installed.merges?.hooks).toHaveLength(1);

    const priv = join(userDataDir, 'fleet', wsId);
    expect(await present(join(priv, '.claude/skills/demo/SKILL.md'))).toBe(true);
    expect(await readFile(join(priv, 'CLAUDE.md'), 'utf8')).toContain('rule line');
    const s = JSON.parse(await readFile(join(priv, '.claude/settings.json'), 'utf8'));
    expect(s.statusLine).toBeDefined();
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(JSON.parse(await readFile(join(priv, '.mcp.json'), 'utf8')).mcpServers.demo).toBeDefined();
    expect((await readWorkspaceManifest(wsId))?.installedLoadouts?.[0].id).toBe('test-merge');

    await uninstallLoadout(wsId, 'test-merge');
    expect(await present(join(priv, '.claude/skills/demo/SKILL.md'))).toBe(false);
    expect(await present(join(priv, '.claude/settings.json'))).toBe(false); // only held loadout content
    expect(await present(join(priv, '.mcp.json'))).toBe(false);
    expect(await readFile(join(priv, 'CLAUDE.md'), 'utf8').catch(() => '')).not.toContain('rule line');
    expect((await readWorkspaceManifest(wsId))?.installedLoadouts).toEqual([]);
  });
});
