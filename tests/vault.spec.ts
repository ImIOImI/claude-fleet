// Exercises the REAL vault IPC (no mockMainIpc): a root value survives
// safeStorage encrypt-to-disk + decrypt-from-disk across two launches sharing
// one userData, so it works without an OS keyring daemon.

import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

interface Entry {
  key: string;
  secret: boolean;
  tags: string[];
  fleet: boolean;
  root: { set: boolean; value?: string };
  lines: { workspaceId: string; mode: 'inherit' | 'override'; value?: string; pending: boolean }[];
}

interface VaultApi {
  api: {
    vault: {
      available: () => Promise<boolean>;
      list: () => Promise<Entry[]>;
      reveal: (key: string, workspaceId: string | null) => Promise<string | null>;
      putKey: (a: { key: string; secret: boolean; tags: string[]; rootValue?: string | null }) => Promise<void>;
      setLine: (key: string, workspaceId: string, line: { mode: 'inherit' }) => Promise<void>;
      applyWorkspaceEdits: (workspaceId: string, edits: { key: string; op: 'inherit' }[]) => Promise<void>;
    };
  };
}

const T = { timeout: 15_000 };

async function launchAt(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_FLEET_MOCK: '1' } as Record<string, string>
  });
}

test('vault: root value round-trips across launches; lines; Vault tab filters by tag', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-vault-'));
  const id = '01VAULTTEST0000000000000WS';

  const app1 = await launchAt(userDataDir);
  try {
    const w = await app1.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    expect(await w.evaluate(() => (window as unknown as VaultApi).api.vault.available())).toBe(true);

    await w.evaluate(() =>
      (window as unknown as VaultApi).api.vault.putKey({
        key: 'DOPPLER_TOKEN',
        secret: true,
        tags: ['doppler'],
        rootValue: 'dp_secret'
      })
    );
    const list = await w.evaluate(() => (window as unknown as VaultApi).api.vault.list());
    expect(list.find((e) => e.key === 'DOPPLER_TOKEN')).toMatchObject({
      secret: true,
      tags: ['doppler'],
      root: { set: true }
    });
    expect(JSON.stringify(list)).not.toContain('dp_secret');
  } finally {
    await app1.close();
  }

  const app2 = await launchAt(userDataDir);
  try {
    const w = await app2.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    expect(
      await w.evaluate(() => (window as unknown as VaultApi).api.vault.reveal('DOPPLER_TOKEN', null))
    ).toBe('dp_secret');

    // No manifest for `id`: setLine refuses it; applyWorkspaceEdits (pre-create path) accepts it.
    await expect(
      w.evaluate(
        (wid) => (window as unknown as VaultApi).api.vault.setLine('DOPPLER_TOKEN', wid, { mode: 'inherit' }),
        id
      )
    ).rejects.toThrow(/unknown workspace/);
    await w.evaluate(
      (wid) =>
        (window as unknown as VaultApi).api.vault.applyWorkspaceEdits(wid, [{ key: 'DOPPLER_TOKEN', op: 'inherit' }]),
      id
    );
    const after = await w.evaluate(() => (window as unknown as VaultApi).api.vault.list());
    expect(after.find((e) => e.key === 'DOPPLER_TOKEN')?.lines).toEqual([
      expect.objectContaining({ workspaceId: id, mode: 'inherit' })
    ]);
    expect(
      await w.evaluate((wid) => (window as unknown as VaultApi).api.vault.reveal('DOPPLER_TOKEN', wid), id)
    ).toBe('dp_secret');

    await w.getByRole('button', { name: 'Settings' }).click(T);
    await w.locator('.modal-tab', { hasText: 'Vault' }).click(T);
    const tab = w.locator('.vault-tab');
    await expect(tab.locator('.vault-section', { hasText: 'Fleet' })).toBeVisible(T);
    await expect(tab.locator('.vault-row[data-vault-key="GITHUB_TOKEN"]')).toBeVisible();
    await expect(tab.locator('.vault-row[data-vault-key="DOPPLER_TOKEN"]')).toBeVisible();

    await tab.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: 'doppler' }).click();
    await expect(tab.locator('.vault-row')).toHaveCount(1);
    await expect(tab.locator('.vault-row[data-vault-key="DOPPLER_TOKEN"]')).toBeVisible();
  } finally {
    await app2.close();
  }
});
