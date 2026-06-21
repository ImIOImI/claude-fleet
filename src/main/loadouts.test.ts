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

const { ensureBuiltinLoadouts, listLoadouts, getLoadout } = await import('./loadouts.js');
const { loadoutDir } = await import('./paths.js');

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
