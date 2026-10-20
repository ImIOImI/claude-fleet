// The role brief's I/O: written into the role holder's /workspace/CLAUDE.md
// (host side of the bind mount), removed from a former holder.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
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
vi.mock('../mcpServer.js', () => ({
  TOOLS: [{ name: 'propose_automation', description: 'Propose a NEW automation.' }]
}));
vi.mock('../appVersion.js', () => ({ appVersionString: () => '9.9.9' }));

const { writeRoleBrief, removeRoleBrief } = await import('./roleBrief.js');
const { BRIEF_START } = await import('./roleBriefCore.js');
const { writeWorkspaceManifest } = await import('../workspaces.js');

const base = {
  labels: [], workspaceRoot: '', workspaceSubdir: '', authMode: 'oauth' as const,
  env: { plain: {}, secretKeys: [] }, mirror: { default: 'on' as const, cleanup: 'delete' as const }, createdAt: 1, lastUsedAt: 1
};
const claudeMd = (id: string) => join(userDataDir, 'fleet', id, 'CLAUDE.md');
const present = (p: string) => stat(p).then(() => true).catch(() => false);

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'role-brief-'));
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('writeRoleBrief / removeRoleBrief', () => {
  it('writes the brief above existing notes, then removes only the brief', async () => {
    await writeWorkspaceManifest({ ...base, id: 'W1', name: 'auto', kind: 'container', role: 'automations',
      installedLoadouts: [{ id: 'gh-triage', title: 'GitHub Notification Triage', files: [], installedAt: 1 }] });
    await mkdir(join(userDataDir, 'fleet', 'W1'), { recursive: true });
    await writeFile(claudeMd('W1'), '# My notes\n', 'utf8');

    await writeRoleBrief('W1');
    const text = await readFile(claudeMd('W1'), 'utf8');
    expect(text.startsWith(BRIEF_START)).toBe(true);
    expect(text).toContain('workspace **auto** (`W1`)');
    expect(text).toContain('`gh-triage`');
    expect(text).toContain('9.9.9');
    expect(text.trimEnd().endsWith('# My notes')).toBe(true);

    await removeRoleBrief('W1');
    expect(await readFile(claudeMd('W1'), 'utf8')).toBe('# My notes\n');
  });

  it('deletes CLAUDE.md when the brief was all it held', async () => {
    await writeWorkspaceManifest({ ...base, id: 'W2', name: 'auto', kind: 'container', role: 'automations' });
    await writeRoleBrief('W2');
    expect(await present(claudeMd('W2'))).toBe(true);
    await removeRoleBrief('W2');
    expect(await present(claudeMd('W2'))).toBe(false);
  });

  it('does nothing for a workspace without the role', async () => {
    await writeWorkspaceManifest({ ...base, id: 'W3', name: 'other', kind: 'container' });
    await writeRoleBrief('W3');
    expect(await present(claudeMd('W3'))).toBe(false);
  });
});
