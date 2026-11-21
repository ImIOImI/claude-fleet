// vault:* IPC surface: renderer workspace ids are guarded, remote/unknown
// workspaces refused for writes, and vault:list never returns secret values.
import { describe, expect, it } from 'vitest';
import { registerVaultIpc, resolveVaultWorkspaceKind, type VaultIpcDeps, type VaultWorkspaceKind } from './vaultIpc.js';
import * as model from './vaultModel.js';
import type { Store } from './vaultModel.js';
import type { VaultEntry } from '../preload/vaultTypes.js';

function setup() {
  let store: Store = {};
  const pending = new Set<string>();
  const pendingCalls: string[] = [];
  const putKeyCalls: { key: string; secret: boolean }[] = [];
  const kinds: Record<string, VaultWorkspaceKind> = {};
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn) };

  const deps: VaultIpcDeps = {
    isVaultAvailable: async () => true,
    listModelEntries: async () => model.listEntries(store),
    getRootValue: async (key) => store['app:env']?.[key] ?? null,
    revealValue: async (key, ws) => {
      if (ws === null) return store['app:env']?.[key] ?? null;
      return model.lineMode(store, key, ws) ? (model.resolveWorkspaceEnv(store, ws)[key] ?? null) : null;
    },
    putKey: async (a) => {
      putKeyCalls.push(a);
      store = model.putKey(store, a);
    },
    renameKey: async (key, next) => {
      store = model.renameKey(store, key, next);
    },
    deleteKey: async (key) => {
      store = model.deleteKey(store, key);
    },
    setLine: async (key, ws, line) => {
      store = model.setLine(store, key, ws, line);
    },
    removeLine: async (key, ws) => {
      store = model.removeLine(store, key, ws);
    },
    copyWorkspace: async (from, to) => {
      store = model.copyWorkspace(store, from, to);
    },
    applyWorkspaceEdits: async (ws, edits) => {
      store = model.applyWorkspaceEdits(store, ws, edits);
    },
    deleteAllForWorkspace: async (ws) => {
      store = model.removeWorkspace(store, ws);
    },
    pendingFor: async (ws) => {
      pendingCalls.push(ws);
      return pending.has(ws);
    },
    // default: an ordinary known workspace; tests pin 'remote' or null (no manifest yet) explicitly.
    workspaceKind: async (ws) => (ws in kinds ? kinds[ws] : 'container')
  };

  registerVaultIpc(ipc, deps);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { handlers, call, pending, pendingCalls, kinds, putKeyCalls };
}

const CHANNELS = [
  'vault:available', 'vault:list', 'vault:reveal', 'vault:putKey', 'vault:renameKey', 'vault:deleteKey',
  'vault:setLine', 'vault:removeLine', 'vault:copyWorkspace', 'vault:applyWorkspaceEdits', 'vault:deleteAllForWorkspace'
];

describe('vault:* IPC', () => {
  it('registers exactly the current vault channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
  });

  it('legacy key channels are gone', () => {
    const { handlers } = setup();
    for (const c of ['vault:listKeys', 'vault:getSecret', 'vault:setSecret', 'vault:deleteSecret']) {
      expect(handlers.has(c)).toBe(false);
    }
  });

  it('vault:list never returns secret values', async () => {
    const { call } = setup();
    await call('vault:putKey', { key: 'S', secret: true, tags: [], rootValue: 'shh' });
    await call('vault:putKey', { key: 'P', secret: false, tags: [], rootValue: 'open' });
    const list = (await call('vault:list')) as VaultEntry[];
    expect(JSON.stringify(list)).not.toContain('shh');
    expect(list.find((e) => e.key === 'P')?.root.value).toBe('open');
    expect(list.find((e) => e.key === 'GITHUB_TOKEN')).toMatchObject({ fleet: true, root: { set: false } });
  });

  it('refuses reserved workspace ids and non-string args', async () => {
    const { call } = setup();
    await call('vault:putKey', { key: 'A', secret: true, tags: [] });
    await expect(call('vault:setLine', 'A', 'app:env', { mode: 'inherit' })).rejects.toThrow();
    await expect(call('vault:setLine', ['A'], '01HW1', { mode: 'inherit' })).rejects.toThrow();
    await expect(call('vault:reveal', 'A', { toString: () => '01HW1' })).rejects.toThrow();
  });

  it('refuses publishing to a remote workspace', async () => {
    const { call, kinds } = setup();
    kinds['01HREMOTE'] = 'remote';
    await call('vault:putKey', { key: 'A', secret: true, tags: [] });
    await expect(call('vault:setLine', 'A', '01HREMOTE', { mode: 'inherit' })).rejects.toThrow(/remote/);
  });

  it('applyWorkspaceEdits and copyWorkspace(to) refuse a remote workspace', async () => {
    const { call, kinds } = setup();
    kinds['01HREMOTE'] = 'remote';
    await call('vault:putKey', { key: 'A', secret: false, tags: [], rootValue: 'v' });
    await expect(
      call('vault:applyWorkspaceEdits', '01HREMOTE', [{ key: 'A', op: 'inherit' }])
    ).rejects.toThrow(/remote/);
    await expect(call('vault:copyWorkspace', '01HW1', '01HREMOTE')).rejects.toThrow(/remote/);
  });

  it('refuses setLine on a workspace with no manifest yet', async () => {
    const { call, kinds } = setup();
    kinds['01HUNKNOWN'] = null;
    await call('vault:putKey', { key: 'A', secret: true, tags: [] });
    await expect(call('vault:setLine', 'A', '01HUNKNOWN', { mode: 'inherit' })).rejects.toThrow();
  });

  it('applyWorkspaceEdits and copyWorkspace(to) accept a not-yet-created workspace', async () => {
    const { call, kinds } = setup();
    kinds['01HNEW'] = null;
    kinds['01HNEW2'] = null;
    await call('vault:putKey', { key: 'A', secret: false, tags: [], rootValue: 'root-val' });
    await expect(call('vault:applyWorkspaceEdits', '01HNEW', [{ key: 'A', op: 'inherit' }])).resolves.toBeUndefined();
    await expect(call('vault:copyWorkspace', '01HNEW', '01HNEW2')).resolves.toBeUndefined();
  });

  it('reports pending lines', async () => {
    const { call, pending } = setup();
    await call('vault:putKey', { key: 'A', secret: true, tags: [], rootValue: 'r' });
    await call('vault:setLine', 'A', '01HW1', { mode: 'inherit' });
    pending.add('01HW1');
    const list = (await call('vault:list')) as VaultEntry[];
    expect(list.find((e) => e.key === 'A')?.lines[0]).toMatchObject({ workspaceId: '01HW1', mode: 'inherit', pending: true });
  });

  it('caches pendingFor per workspace within one vault:list call', async () => {
    const { call, pendingCalls } = setup();
    await call('vault:putKey', { key: 'A', secret: false, tags: [], rootValue: 'a' });
    await call('vault:putKey', { key: 'B', secret: false, tags: [], rootValue: 'b' });
    await call('vault:setLine', 'A', '01HW1', { mode: 'inherit' });
    await call('vault:setLine', 'B', '01HW1', { mode: 'inherit' });
    pendingCalls.length = 0;
    await call('vault:list');
    expect(pendingCalls.filter((ws) => ws === '01HW1')).toHaveLength(1);
  });

  it('applyWorkspaceEdits validates each edit', async () => {
    const { call } = setup();
    await expect(call('vault:applyWorkspaceEdits', '01HW1', 'not-an-array')).rejects.toThrow(/array/);
    await expect(
      call('vault:applyWorkspaceEdits', '01HW1', [{ key: 'A', op: 'create', secret: 'no', asRoot: true, value: 'v', tags: [] }])
    ).rejects.toThrow();
    await expect(
      call('vault:applyWorkspaceEdits', '01HW1', [{ key: 'A', op: 'create', secret: true, asRoot: 'false', value: 'v', tags: [] }])
    ).rejects.toThrow();
    await expect(
      call('vault:applyWorkspaceEdits', '01HW1', [{ key: 'A', op: 'create', secret: true, asRoot: true, value: ['x'], tags: [] }])
    ).rejects.toThrow();
  });

  it('putKey refuses a non-boolean secret flag and a non-string root value', async () => {
    const { call } = setup();
    await expect(call('vault:putKey', { key: 'A', secret: 'yes', tags: [] })).rejects.toThrow(/boolean/);
    await expect(call('vault:putKey', { key: 'A', secret: true, tags: [], rootValue: 7 })).rejects.toThrow(/string/);
  });

  it('refuses an invalid key on every key-taking channel', async () => {
    const { call } = setup();
    await expect(call('vault:putKey', { key: 'bad key', secret: true, tags: [] })).rejects.toThrow(/key/);
    await expect(call('vault:renameKey', 'bad key', 'OK')).rejects.toThrow(/key/);
    await expect(call('vault:deleteKey', 'bad key')).rejects.toThrow(/key/);
    await expect(call('vault:removeLine', 'bad key', '01HW1')).rejects.toThrow(/key/);
  });
});

describe('fleet keys keep their registry secret flag', () => {
  it('vault:putKey forces a fleet key to its registry secret flag', async () => {
    const { call, putKeyCalls } = setup();
    await call('vault:putKey', { key: 'GITHUB_TOKEN', secret: false, tags: [], rootValue: 'ghp_x' });
    expect(putKeyCalls.at(-1)).toMatchObject({ key: 'GITHUB_TOKEN', secret: true });
    const list = (await call('vault:list')) as VaultEntry[];
    expect(JSON.stringify(list)).not.toContain('ghp_x');
  });

  it('leaves a non-fleet key\'s flag as given', async () => {
    const { call, putKeyCalls } = setup();
    await call('vault:putKey', { key: 'OTHER', secret: false, tags: [] });
    expect(putKeyCalls.at(-1)).toMatchObject({ key: 'OTHER', secret: false });
  });
});

describe('resolveVaultWorkspaceKind', () => {
  const mockList = async () => [{ id: 'mock-1', kind: 'local' as const }];
  it('prefers the manifest kind', async () => {
    expect(await resolveVaultWorkspaceKind('mock-1', { manifestKind: async () => 'container', mockWorkspaces: mockList })).toBe('container');
  });
  it('falls back to the mock workspace kind when there is no manifest', async () => {
    expect(await resolveVaultWorkspaceKind('mock-1', { manifestKind: async () => null, mockWorkspaces: mockList })).toBe('local');
    expect(await resolveVaultWorkspaceKind('nope', { manifestKind: async () => null, mockWorkspaces: mockList })).toBeNull();
  });
  it('is null without a manifest outside mock mode', async () => {
    expect(await resolveVaultWorkspaceKind('mock-1', { manifestKind: async () => null })).toBeNull();
  });
});
