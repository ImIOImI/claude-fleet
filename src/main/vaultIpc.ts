// The renderer-facing vault:* IPC surface. All operations are keyed by a
// workspace's id (the ULID) or an endpoint scope. The renderer sees the list of
// keys + a secret value on explicit getSecret; deleteAllForWorkspace runs at
// workspace delete time.
//
// Every scope-taking handler refuses host-only scopes (loadout-source:*, #444)
// — those are written via loadouts:* and never read back — and fails closed on
// any non-string scope, key or value: an array or String object survives
// structured clone and would be coerced to the real string inside vault.ts.

import { assertRendererVaultScope } from './vaultScopes.js';

export interface VaultIpcApi {
  isVaultAvailable(): Promise<boolean>;
  listKeys(scope: string): Promise<string[]>;
  getSecret(scope: string, key: string): Promise<string | null>;
  setSecret(scope: string, key: string, value: string): Promise<void>;
  deleteSecret(scope: string, key: string): Promise<void>;
  deleteAllForWorkspace(scope: string): Promise<void>;
}

export interface IpcHandleLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches IpcMain.handle's listener
  handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void;
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') throw new Error('vault key must be a string');
}

export function registerVaultIpc(ipc: IpcHandleLike, vault: VaultIpcApi): void {
  ipc.handle('vault:available', () => vault.isVaultAvailable());
  ipc.handle('vault:listKeys', (_e, scope: unknown) => {
    assertRendererVaultScope(scope);
    return vault.listKeys(scope);
  });
  ipc.handle('vault:getSecret', (_e, scope: unknown, key: unknown) => {
    assertRendererVaultScope(scope);
    assertKey(key);
    return vault.getSecret(scope, key);
  });
  ipc.handle('vault:setSecret', (_e, scope: unknown, key: unknown, value: unknown) => {
    assertRendererVaultScope(scope);
    assertKey(key);
    if (typeof value !== 'string') throw new Error('vault value must be a string');
    return vault.setSecret(scope, key, value);
  });
  ipc.handle('vault:deleteSecret', (_e, scope: unknown, key: unknown) => {
    assertRendererVaultScope(scope);
    assertKey(key);
    return vault.deleteSecret(scope, key);
  });
  ipc.handle('vault:deleteAllForWorkspace', (_e, scope: unknown) => {
    assertRendererVaultScope(scope);
    return vault.deleteAllForWorkspace(scope);
  });
}
