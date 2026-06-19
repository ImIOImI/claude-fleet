// The secret vault is now safeStorage-backed (was keytar). This exercises the
// REAL vault IPC (no mockMainIpc) and proves a secret survives encrypt-to-disk
// + decrypt-from-disk across two app launches sharing one userData — i.e. it
// works without an OS keyring daemon (the WSL failure mode that motivated #8).

import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

interface VaultApi {
  api: {
    vault: {
      available: () => Promise<boolean>;
      listKeys: (id: string) => Promise<string[]>;
      getSecret: (id: string, key: string) => Promise<string | null>;
      setSecret: (id: string, key: string, value: string) => Promise<void>;
      deleteSecret: (id: string, key: string) => Promise<void>;
    };
  };
}

async function launchAt(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_FLEET_MOCK: '1' } as Record<string, string>
  });
}

test('vault: secret round-trips across launches via safeStorage (no keyring)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-vault-'));
  const id = '01VAULTTEST0000000000000WS';

  // Launch 1: encryption available, write a secret, read it back.
  const app1 = await launchAt(userDataDir);
  try {
    const w = await app1.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    const available = await w.evaluate(() => (window as unknown as VaultApi).api.vault.available());
    expect(available).toBe(true);

    await w.evaluate(
      (wid) =>
        (window as unknown as VaultApi).api.vault.setSecret(wid, 'ANTHROPIC_API_KEY', 'sk-ant-secret'),
      id
    );
    const keys = await w.evaluate((wid) => (window as unknown as VaultApi).api.vault.listKeys(wid), id);
    expect(keys).toEqual(['ANTHROPIC_API_KEY']);
    const val = await w.evaluate(
      (wid) => (window as unknown as VaultApi).api.vault.getSecret(wid, 'ANTHROPIC_API_KEY'),
      id
    );
    expect(val).toBe('sk-ant-secret');
  } finally {
    await app1.close();
  }

  // Launch 2 (same userData): the value must decrypt back from secrets.enc.
  const app2 = await launchAt(userDataDir);
  try {
    const w = await app2.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    const persisted = await w.evaluate(
      (wid) => (window as unknown as VaultApi).api.vault.getSecret(wid, 'ANTHROPIC_API_KEY'),
      id
    );
    expect(persisted).toBe('sk-ant-secret');

    // Delete drops the key (and, being the last, the workspace's bag).
    await w.evaluate(
      (wid) => (window as unknown as VaultApi).api.vault.deleteSecret(wid, 'ANTHROPIC_API_KEY'),
      id
    );
    const after = await w.evaluate((wid) => (window as unknown as VaultApi).api.vault.listKeys(wid), id);
    expect(after).toEqual([]);
  } finally {
    await app2.close();
  }
});
