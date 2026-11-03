// The renderer-facing vault:* IPC surface (#444 security review): host-only
// scopes are refused, and so is every non-string scope or key — an array or
// String object would survive structured clone and be coerced to the real key.
import { describe, expect, it, vi } from 'vitest';
import { registerVaultIpc, type VaultIpcApi } from './vaultIpc.js';

const PRIV = 'loadout-source:ghcr.io/acme/private';

function setup() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn) };
  const vault: VaultIpcApi = {
    isVaultAvailable: vi.fn(async () => true),
    listKeys: vi.fn(async () => ['TOKEN']),
    getSecret: vi.fn(async () => 'ghp_secret'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    deleteAllForWorkspace: vi.fn(async () => undefined)
  };
  registerVaultIpc(ipc, vault);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { handlers, vault, call };
}

const BAD_SCOPES: Array<[string, unknown]> = [
  ['host-only string', PRIV],
  ['array', [PRIV]],
  ['String object', new String(PRIV)],
  ['number', 7],
  ['undefined', undefined],
  ['null', null]
];

// channel → extra args after the scope
const SCOPED: Array<[string, unknown[]]> = [
  ['vault:listKeys', []],
  ['vault:getSecret', ['TOKEN']],
  ['vault:setSecret', ['TOKEN', 'v']],
  ['vault:deleteSecret', ['TOKEN']],
  ['vault:deleteAllForWorkspace', []]
];

describe('vault:* IPC guard', () => {
  it('registers every vault channel', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      ['vault:available', ...SCOPED.map(([c]) => c)].sort()
    );
  });

  for (const [ch, rest] of SCOPED) {
    for (const [label, scope] of BAD_SCOPES) {
      it(`${ch} refuses a ${label} scope without touching the vault`, async () => {
        const { vault, call } = setup();
        await expect(call(ch, scope, ...rest)).rejects.toThrow(/vault scope (is host-only|must be a string)/);
        for (const fn of Object.values(vault)) expect(fn).not.toHaveBeenCalled();
      });
    }
  }

  for (const [ch, rest] of SCOPED.filter(([, r]) => r.length > 0)) {
    for (const [label, key] of [
      ['array', ['TOKEN']],
      ['String object', new String('TOKEN')],
      ['undefined', undefined]
    ] as Array<[string, unknown]>) {
      it(`${ch} refuses a ${label} key`, async () => {
        const { vault, call } = setup();
        await expect(call(ch, '01HZXYWS', key, ...rest.slice(1))).rejects.toThrow(/key/);
        for (const fn of Object.values(vault)) expect(fn).not.toHaveBeenCalled();
      });
    }
  }

  it('vault:setSecret refuses a non-string value', async () => {
    const { vault, call } = setup();
    await expect(call('vault:setSecret', '01HZXYWS', 'K', ['v'])).rejects.toThrow(/value/);
    expect(vault.setSecret).not.toHaveBeenCalled();
  });

  it('passes ordinary workspace and endpoint scopes through', async () => {
    const { vault, call } = setup();
    expect(await call('vault:getSecret', '01HZXYWS', 'K')).toBe('ghp_secret');
    expect(vault.getSecret).toHaveBeenCalledWith('01HZXYWS', 'K');
    await call('vault:setSecret', 'endpoint:3f0c', 'API_KEY', 'v');
    expect(vault.setSecret).toHaveBeenCalledWith('endpoint:3f0c', 'API_KEY', 'v');
    expect(await call('vault:listKeys', '01HZXYWS')).toEqual(['TOKEN']);
    await call('vault:deleteSecret', '01HZXYWS', 'K');
    await call('vault:deleteAllForWorkspace', '01HZXYWS');
    expect(await call('vault:available')).toBe(true);
  });
});
