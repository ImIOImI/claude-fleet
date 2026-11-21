import { describe, expect, it } from 'vitest';
import * as m from './vaultModel.js';
import { APP_ENV_SCOPE, APP_INDEX_SCOPE } from './vaultScopes.js';

const W1 = '01HW1';
const W2 = '01HW2';
const base = (): m.Store => ({});

describe('validation', () => {
  it('keys', () => {
    expect(m.isValidKey('DOPPLER_TOKEN')).toBe(true);
    expect(m.isValidKey('_x1')).toBe(true);
    for (const bad of ['', '1A', 'A-B', 'A B', m.MIGRATED_MARKER, 7, null]) expect(m.isValidKey(bad)).toBe(false);
  });
  it('tags', () => {
    expect(m.isValidTag('aws')).toBe(true);
    for (const bad of ['', 'AWS', 'a b', 'x'.repeat(33), 3]) expect(m.isValidTag(bad)).toBe(false);
  });
});

describe('putKey', () => {
  it('creates root value and index', () => {
    const s = m.putKey(base(), { key: 'A', secret: true, tags: ['x'], rootValue: 'v' });
    expect(s[APP_ENV_SCOPE]).toEqual({ A: 'v' });
    expect(m.getMeta(s, 'A')).toEqual({ secret: true, inherit: [], tags: ['x'] });
  });
  it('rootValue null deletes the root, undefined keeps it', () => {
    let s = m.putKey(base(), { key: 'A', secret: true, tags: [], rootValue: 'v' });
    s = m.putKey(s, { key: 'A', secret: false, tags: [] });
    expect(s[APP_ENV_SCOPE]?.A).toBe('v');
    s = m.putKey(s, { key: 'A', secret: false, tags: [], rootValue: null });
    expect(s[APP_ENV_SCOPE]?.A).toBeUndefined();
  });
  it('deleting the root drops inherit links but keeps overrides', () => {
    let s = m.putKey(base(), { key: 'A', secret: true, tags: [], rootValue: 'v' });
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    s = m.setLine(s, 'A', W2, { mode: 'override', value: 'o' });
    s = m.putKey(s, { key: 'A', secret: true, tags: [], rootValue: null });
    expect(m.lineMode(s, 'A', W1)).toBeNull();
    expect(m.lineMode(s, 'A', W2)).toBe('override');
  });
  it('rejects bad key, bad tag, too many tags', () => {
    expect(() => m.putKey(base(), { key: '1A', secret: true, tags: [] })).toThrow(/key/);
    expect(() => m.putKey(base(), { key: 'A', secret: true, tags: ['BAD'] })).toThrow(/tag/);
    const tags = Array.from({ length: 17 }, (_, i) => `t${i}`);
    expect(() => m.putKey(base(), { key: 'A', secret: true, tags })).toThrow(/tag/);
  });
  it('dedupes tags', () => {
    const s = m.putKey(base(), { key: 'A', secret: true, tags: ['a', 'a', 'b'] });
    expect(m.getMeta(s, 'A')?.tags).toEqual(['a', 'b']);
  });
  it('fails closed to secret when the flag is omitted', () => {
    const s = m.putKey(base(), { key: 'A', tags: [] } as unknown as Parameters<typeof m.putKey>[1]);
    expect(m.getMeta(s, 'A')?.secret).toBe(true);
  });
});

describe('lines and resolution', () => {
  const seeded = () => {
    let s = m.putKey(base(), { key: 'A', secret: true, tags: [], rootValue: 'root' });
    s = m.putKey(s, { key: 'P', secret: false, tags: [], rootValue: 'plain' });
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    s = m.setLine(s, 'P', W1, { mode: 'override', value: 'mine' });
    return s;
  };
  it('resolves inherit and override', () => {
    expect(m.resolveWorkspaceEnv(seeded(), W1)).toEqual({ A: 'root', P: 'mine' });
    expect(m.resolveWorkspaceEnv(seeded(), W2)).toEqual({});
  });
  it('override then inherit flips state exclusively', () => {
    let s = m.setLine(seeded(), 'A', W1, { mode: 'override', value: 'x' });
    expect(m.getMeta(s, 'A')?.inherit).toEqual([]);
    expect(s[W1]?.A).toBe('x');
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    expect(s[W1]?.A).toBeUndefined();
    expect(m.getMeta(s, 'A')?.inherit).toEqual([W1]);
  });
  it('inherit without a root value resolves to empty string', () => {
    let s = m.putKey(base(), { key: 'N', secret: true, tags: [] });
    s = m.setLine(s, 'N', W1, { mode: 'inherit' });
    expect(m.resolveWorkspaceEnv(s, W1)).toEqual({ N: '' });
  });
  it('setLine requires an existing key', () => {
    expect(() => m.setLine(base(), 'NOPE', W1, { mode: 'inherit' })).toThrow(/unknown key/);
  });
  it('setLine on a bag-only key creates default metadata instead of throwing', () => {
    const s: m.Store = { [W1]: { ORPHAN: 'v' } };
    const t = m.setLine(s, 'ORPHAN', W1, { mode: 'override', value: 'v2' });
    expect(t[W1]?.ORPHAN).toBe('v2');
    expect(m.getMeta(t, 'ORPHAN')).toEqual({ secret: true, inherit: [], tags: [] });
  });
  it('lineMode validates the workspace id', () => {
    expect(() => m.lineMode(seeded(), 'A', '')).toThrow(/workspace id must be a non-empty string/);
  });
  it('rejects an empty workspace id', () => {
    expect(() => m.resolveWorkspaceEnv(seeded(), '')).toThrow(/workspace id must be a non-empty string/);
  });
  it('a dual bag+inherit entry resolves as override; removeLine clears both', () => {
    let s = m.putKey(base(), { key: 'A', secret: true, tags: [], rootValue: 'root' });
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    s = { ...s, [W1]: { ...s[W1], A: 'override-val' } };
    expect(m.getMeta(s, 'A')?.inherit).toEqual([W1]);
    expect(m.lineMode(s, 'A', W1)).toBe('override');
    expect(m.resolveWorkspaceEnv(s, W1)).toEqual({ A: 'override-val' });
    s = m.removeLine(s, 'A', W1);
    expect(m.lineMode(s, 'A', W1)).toBeNull();
    expect(m.getMeta(s, 'A')?.inherit).toEqual([]);
    expect(W1 in s).toBe(false);
  });
  it('removeLine clears both states and drops an orphan bag', () => {
    let s = m.removeLine(seeded(), 'P', W1);
    s = m.removeLine(s, 'A', W1);
    expect(m.lineMode(s, 'A', W1)).toBeNull();
    expect(W1 in s).toBe(false);
  });
  it('workspaceKeys and workspaceSecretValues', () => {
    const s = seeded();
    expect(m.workspaceKeys(s, W1)).toEqual([{ key: 'A', secret: true }, { key: 'P', secret: false }]);
    expect(m.workspaceSecretValues(s, W1)).toEqual([{ key: 'A', value: 'root' }]);
  });
  it('refuses reserved scopes as workspaces', () => {
    expect(() => m.resolveWorkspaceEnv(seeded(), 'app:env')).toThrow(/reserved/);
    expect(() => m.setLine(seeded(), 'A', 'endpoint:x', { mode: 'inherit' })).toThrow(/reserved/);
  });
});

describe('rename / delete / copy / removeWorkspace', () => {
  const seeded = () => {
    let s = m.putKey(base(), { key: 'A', secret: true, tags: ['t'], rootValue: 'r' });
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    s = m.setLine(s, 'A', W2, { mode: 'override', value: 'o' });
    return s;
  };
  it('rename moves root, index and overrides', () => {
    const s = m.renameKey(seeded(), 'A', 'B');
    expect(m.getMeta(s, 'A')).toBeNull();
    expect(m.getMeta(s, 'B')).toEqual({ secret: true, inherit: [W1], tags: ['t'] });
    expect(s[APP_ENV_SCOPE]).toEqual({ B: 'r' });
    expect(s[W2]).toEqual({ B: 'o' });
  });
  it('rename onto an existing key is refused', () => {
    const s = m.putKey(seeded(), { key: 'B', secret: true, tags: [] });
    expect(() => m.renameKey(s, 'A', 'B')).toThrow(/exists/);
  });
  it('rename throws when the source key exists nowhere', () => {
    expect(() => m.renameKey(base(), 'NOPE', 'OTHER')).toThrow(/unknown key: NOPE/);
  });
  it('deleteKey removes everything', () => {
    const s = m.deleteKey(seeded(), 'A');
    expect(m.listEntries(s)).toEqual([]);
    expect(W2 in s).toBe(false);
  });
  it('copyWorkspace copies inherit links and overrides', () => {
    const s = m.copyWorkspace(seeded(), W2, '01HW3');
    expect(m.lineMode(s, 'A', '01HW3')).toBe('override');
    const t = m.copyWorkspace(seeded(), W1, '01HW3');
    expect(m.lineMode(t, 'A', '01HW3')).toBe('inherit');
  });
  it('copyWorkspace of a bag-only key creates default metadata instead of throwing', () => {
    const s: m.Store = { [W1]: { ORPHAN: 'v' } };
    const t = m.copyWorkspace(s, W1, W2);
    expect(m.lineMode(t, 'ORPHAN', W2)).toBe('override');
    expect(m.getMeta(t, 'ORPHAN')).toEqual({ secret: true, inherit: [], tags: [] });
  });
  it('removeWorkspace drops links, bag, and orphan index entries', () => {
    let s = m.putKey(seeded(), { key: 'ONLY', secret: true, tags: [] });
    s = m.setLine(s, 'ONLY', W2, { mode: 'override', value: 'x' });
    s = m.removeWorkspace(s, W2);
    s = m.removeWorkspace(s, W1);
    expect(m.getMeta(s, 'A')?.inherit).toEqual([]);
    expect(m.getMeta(s, 'ONLY')).toBeNull();
    expect(W2 in s).toBe(false);
  });
  it('removeWorkspace keeps an index entry still referenced by another workspace', () => {
    let s = m.putKey(base(), { key: 'A', secret: true, tags: [] });
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    s = m.setLine(s, 'A', W2, { mode: 'inherit' });
    s = m.removeWorkspace(s, W1);
    expect(m.getMeta(s, 'A')?.inherit).toEqual([W2]);
    expect(m.lineMode(s, 'A', W2)).toBe('inherit');
  });
});

describe('applyWorkspaceEdits', () => {
  it('creates workspace-only and root-backed keys, and removes', () => {
    let s = m.putKey(base(), { key: 'R', secret: true, tags: [], rootValue: 'r' });
    s = m.applyWorkspaceEdits(s, W1, [
      { key: 'R', op: 'inherit' },
      { key: 'L', op: 'create', secret: false, tags: ['x'], value: 'l', asRoot: false },
      { key: 'G', op: 'create', secret: true, tags: [], value: 'g', asRoot: true }
    ]);
    expect(m.resolveWorkspaceEnv(s, W1)).toEqual({ R: 'r', L: 'l', G: 'g' });
    expect(m.lineMode(s, 'L', W1)).toBe('override');
    expect(m.lineMode(s, 'G', W1)).toBe('inherit');
    s = m.applyWorkspaceEdits(s, W1, [{ key: 'L', op: 'remove' }]);
    expect(m.lineMode(s, 'L', W1)).toBeNull();
    expect(m.getMeta(s, 'L')).toBeNull();
  });
  it('create on an existing key updates nothing but the line', () => {
    let s = m.putKey(base(), { key: 'R', secret: true, tags: ['keep'], rootValue: 'r' });
    s = m.applyWorkspaceEdits(s, W1, [{ key: 'R', op: 'create', secret: false, tags: [], value: 'mine', asRoot: false }]);
    expect(m.getMeta(s, 'R')).toEqual({ secret: true, inherit: [], tags: ['keep'] });
    expect(s[W1]?.R).toBe('mine');
  });
  it('override on a bag-only key creates default metadata instead of throwing', () => {
    const s: m.Store = { [W1]: { ORPHAN: 'v' } };
    const t = m.applyWorkspaceEdits(s, W1, [{ key: 'ORPHAN', op: 'override', value: 'v2' }]);
    expect(t[W1]?.ORPHAN).toBe('v2');
    expect(m.getMeta(t, 'ORPHAN')).toEqual({ secret: true, inherit: [], tags: [] });
  });
});

describe('listEntries', () => {
  it('sorts, excludes the marker, reports lines', () => {
    let s = m.putKey(base(), { key: 'B', secret: true, tags: [] });
    s = m.putKey(s, { key: 'A', secret: false, tags: [], rootValue: 'a' });
    s = m.setLine(s, 'A', W1, { mode: 'inherit' });
    s = { ...s, [APP_INDEX_SCOPE]: { ...s[APP_INDEX_SCOPE], [m.MIGRATED_MARKER]: '1' } };
    const e = m.listEntries(s);
    expect(e.map((x) => x.key)).toEqual(['A', 'B']);
    expect(e[0]).toMatchObject({ rootSet: true, lines: [{ workspaceId: W1, mode: 'inherit' }] });
    expect(e[1]).toMatchObject({ rootSet: false, lines: [] });
  });
  it('tolerates a corrupt index entry as a secret key with no links', () => {
    const s: m.Store = { [APP_INDEX_SCOPE]: { X: 'not json' }, [W1]: { X: 'v' } };
    expect(m.listEntries(s)[0]).toMatchObject({ key: 'X', meta: { secret: true, inherit: [], tags: [] } });
  });
  it('drops inherit ids that contain \':\' or are empty', () => {
    const s: m.Store = { [APP_INDEX_SCOPE]: { A: JSON.stringify({ secret: true, inherit: ['ok', '', 'bad:scope'], tags: [] }) } };
    expect(m.getMeta(s, 'A')?.inherit).toEqual(['ok']);
  });
});

describe('migrateManifestEnv', () => {
  it('moves plain values into bags as overrides and marks secrets', () => {
    const s0: m.Store = { [W2]: { TOK: 's' } };
    const s = m.migrateManifestEnv(s0, [
      { id: W1, plain: { REGION: 'us', TOK: 'p' }, secretKeys: [] },
      { id: W2, plain: {}, secretKeys: ['TOK'] }
    ]);
    expect(s[W1]).toEqual({ REGION: 'us', TOK: 'p' });
    expect(m.getMeta(s, 'TOK')?.secret).toBe(true);
    expect(m.getMeta(s, 'REGION')?.secret).toBe(false);
    expect(s[APP_INDEX_SCOPE]?.[m.MIGRATED_MARKER]).toBe('1');
    expect(m.resolveWorkspaceEnv(s, W2)).toEqual({ TOK: 's' });
  });
  it('skips invalid keys and reserved ids', () => {
    const s = m.migrateManifestEnv({}, [{ id: 'app:x', plain: { A: '1' }, secretKeys: [] }, { id: W1, plain: { 'bad-key': '1' }, secretKeys: [] }]);
    expect(m.listEntries(s)).toEqual([]);
  });
  it('deletes bag keys referenced by neither secretKeys nor plain', () => {
    const s0: m.Store = { [W1]: { STALE: 'old', TOK: 's' } };
    const s = m.migrateManifestEnv(s0, [{ id: W1, plain: {}, secretKeys: ['TOK'] }]);
    expect(s[W1]).toEqual({ TOK: 's' });
  });
  it('keeps the stored bag value over a plain value for the same key', () => {
    const s0: m.Store = { [W1]: { TOK: 'stored-secret' } };
    const s = m.migrateManifestEnv(s0, [{ id: W1, plain: { TOK: 'plain-val' }, secretKeys: ['TOK'] }]);
    expect(s[W1]).toEqual({ TOK: 'stored-secret' });
  });
  it('a secretKeys entry with no stored value becomes an empty override, not an orphan', () => {
    const s = m.migrateManifestEnv({}, [{ id: W1, plain: {}, secretKeys: ['TOK'] }]);
    expect(s[W1]).toEqual({ TOK: '' });
    expect(m.getMeta(s, 'TOK')).toEqual({ secret: true, inherit: [], tags: [] });
  });
  it('does not touch bags of workspaces outside the manifest list', () => {
    const s0: m.Store = { [W2]: { OTHER: 'x' } };
    const s = m.migrateManifestEnv(s0, [{ id: W1, plain: { A: '1' }, secretKeys: [] }]);
    expect(s[W2]).toEqual({ OTHER: 'x' });
  });
});

describe('envHash', () => {
  it('is order-independent and value-sensitive', () => {
    expect(m.envHash({ A: '1', B: '2' })).toBe(m.envHash({ B: '2', A: '1' }));
    expect(m.envHash({ A: '1' })).not.toBe(m.envHash({ A: '2' }));
  });
});

describe('prototype-member key names (constructor/__proto__/toString)', () => {
  it('are valid keys', () => {
    for (const k of ['constructor', '__proto__', 'toString']) expect(m.isValidKey(k)).toBe(true);
  });

  it('read as absent on an empty store, not as the inherited prototype member', () => {
    const s = base();
    expect(m.getMeta(s, 'constructor')).toBeNull();
    expect(m.lineMode(s, 'constructor', W1)).toBeNull();
    expect(Object.hasOwn(m.resolveWorkspaceEnv(s, W1), 'constructor')).toBe(false);
    expect(m.listEntries(s)).toEqual([]);
  });

  it('a real constructor key round-trips through root, override, and rename', () => {
    let s = m.putKey(base(), { key: 'constructor', secret: false, tags: [], rootValue: 'v' });
    expect(s[APP_ENV_SCOPE]).toEqual({ constructor: 'v' });
    expect(m.getMeta(s, 'constructor')).toEqual({ secret: false, inherit: [], tags: [] });
    s = m.setLine(s, 'constructor', W1, { mode: 'override', value: 'o' });
    expect(m.lineMode(s, 'constructor', W1)).toBe('override');
    expect(m.resolveWorkspaceEnv(s, W1)).toEqual({ constructor: 'o' });
    s = m.renameKey(s, 'constructor', 'RENAMED');
    expect(m.getMeta(s, 'constructor')).toBeNull();
    expect(m.getMeta(s, 'RENAMED')).toEqual({ secret: false, inherit: [], tags: [] });
  });
});
