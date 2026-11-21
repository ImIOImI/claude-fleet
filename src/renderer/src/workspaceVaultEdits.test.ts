import { expect, it } from 'vitest';
import { discard, previewEntries, rekeyLines, resolvesNonEmpty, stage } from './workspaceVaultEdits';
import type { VaultEntry, VaultWorkspaceEdit } from '../../preload/vaultTypes';
const root = (key: string): VaultEntry => ({ key, secret: true, tags: [], fleet: false, root: { set: true }, lines: [] });

it('last edit per key wins', () => {
  let s = stage({ edits: [] }, { key: 'A', op: 'inherit' });
  s = stage(s, { key: 'A', op: 'override', value: 'x' });
  expect(s.edits).toEqual([{ key: 'A', op: 'override', value: 'x' }]);
});
it('remove after create drops the key entirely', () => {
  let s = stage({ edits: [] }, { key: 'N', op: 'create', secret: true, tags: [], value: 'v', asRoot: false });
  s = stage(s, { key: 'N', op: 'remove' });
  expect(s.edits).toEqual([]);
});
it('override after create updates the created value', () => {
  let s = stage({ edits: [] }, { key: 'N', op: 'create', secret: true, tags: [], value: 'v', asRoot: false });
  s = stage(s, { key: 'N', op: 'override', value: 'w' });
  expect(s.edits).toEqual([{ key: 'N', op: 'create', secret: true, tags: [], value: 'w', asRoot: false }]);
});
it('root-backed create keeps a later override, and inherit drops it again', () => {
  const create: VaultWorkspaceEdit = { key: 'N', op: 'create', secret: true, tags: [], value: 'r', asRoot: true };
  let s = stage(stage({ edits: [] }, create), { key: 'N', op: 'override', value: 'o' });
  expect(s.edits).toEqual([create, { key: 'N', op: 'override', value: 'o' }]);
  s = stage(s, { key: 'N', op: 'inherit' });
  expect(s.edits).toEqual([create]);
});
it('preview shows staged lines', () => {
  const s = stage(stage({ edits: [] }, { key: 'A', op: 'inherit' }), { key: 'N', op: 'create', secret: false, tags: ['t'], value: 'v', asRoot: false });
  const p = previewEntries([root('A')], 'W1', s);
  expect(p.find((e) => e.key === 'A')?.lines).toEqual([{ workspaceId: 'W1', mode: 'inherit', pending: false }]);
  expect(p.find((e) => e.key === 'N')).toMatchObject({ secret: false, root: { set: false }, lines: [{ workspaceId: 'W1', mode: 'override', value: 'v', pending: false }] });
});
it('preview of create as root inherits and sets root', () => {
  const s = stage({ edits: [] }, { key: 'N', op: 'create', secret: false, tags: [], value: 'v', asRoot: true });
  expect(previewEntries([], 'W1', s)[0]).toMatchObject({ root: { set: true, value: 'v' }, lines: [{ workspaceId: 'W1', mode: 'inherit' }] });
});
it('preview hides secret override values', () => {
  const s = stage({ edits: [] }, { key: 'A', op: 'override', value: 'hush' });
  expect(previewEntries([root('A')], 'W1', s)[0].lines).toEqual([{ workspaceId: 'W1', mode: 'override', pending: false }]);
});
it('preview of remove hides the line', () => {
  const e: VaultEntry = { ...root('A'), lines: [{ workspaceId: 'W1', mode: 'inherit', pending: false }] };
  expect(previewEntries([e], 'W1', stage({ edits: [] }, { key: 'A', op: 'remove' }))[0].lines).toEqual([]);
});
it('preview does not mutate the input', () => {
  const e = root('A');
  previewEntries([e], 'W1', stage({ edits: [] }, { key: 'A', op: 'inherit' }));
  expect(e.lines).toEqual([]);
});
it('rekeyLines copies a source workspace line onto the target', () => {
  const e: VaultEntry = { ...root('A'), lines: [{ workspaceId: 'S', mode: 'override', pending: true }] };
  expect(rekeyLines([e], 'S', 'T')[0].lines).toEqual([
    { workspaceId: 'S', mode: 'override', pending: true },
    { workspaceId: 'T', mode: 'override', pending: false }
  ]);
});
it('discard drops every staged edit for a key', () => {
  const create: VaultWorkspaceEdit = { key: 'N', op: 'create', secret: true, tags: [], value: 'r', asRoot: true };
  const s = stage(stage(stage({ edits: [] }, create), { key: 'N', op: 'override', value: 'o' }), { key: 'A', op: 'inherit' });
  expect(discard(s, 'N').edits).toEqual([{ key: 'A', op: 'inherit' }]);
});
it('preview of a root-backed create on an existing rooted key inherits, like main', () => {
  const s = stage({ edits: [] }, { key: 'A', op: 'create', secret: false, tags: [], value: 'v', asRoot: true });
  expect(previewEntries([root('A')], 'W1', s)[0].lines).toEqual([{ workspaceId: 'W1', mode: 'inherit', pending: false }]);
});
it('resolvesNonEmpty: override, or inherit with a root value', () => {
  const line = (mode: 'inherit' | 'override', value?: string) => [{ workspaceId: 'W1', mode, value, pending: false }];
  expect(resolvesNonEmpty({ ...root('A'), lines: line('inherit') }, 'W1')).toBe(true);
  expect(resolvesNonEmpty({ ...root('A'), root: { set: false }, lines: line('inherit') }, 'W1')).toBe(false);
  expect(resolvesNonEmpty({ ...root('A'), root: { set: false }, lines: line('override') }, 'W1')).toBe(true);
  expect(resolvesNonEmpty({ ...root('A'), secret: false, lines: line('override', '') }, 'W1')).toBe(false);
  expect(resolvesNonEmpty(root('A'), 'W1')).toBe(false);
});
it('resolvesNonEmpty: a staged override counts only with a non-empty typed value', () => {
  const ovr = [{ workspaceId: 'W1', mode: 'override' as const, pending: false }];
  const e: VaultEntry = { ...root('A'), lines: ovr };
  const plain: VaultEntry = { ...root('P'), secret: false, lines: [{ ...ovr[0], value: 'old' }] };
  expect(resolvesNonEmpty(e, 'W1', stage({ edits: [] }, { key: 'A', op: 'override', value: '' }))).toBe(false);
  expect(resolvesNonEmpty(e, 'W1', stage({ edits: [] }, { key: 'A', op: 'override', value: 'x' }))).toBe(true);
  expect(resolvesNonEmpty(plain, 'W1', stage({ edits: [] }, { key: 'P', op: 'override', value: '' }))).toBe(false);
  const created = stage({ edits: [] }, { key: 'A', op: 'create', secret: true, tags: [], value: '', asRoot: false });
  expect(resolvesNonEmpty(e, 'W1', created)).toBe(false);
  expect(resolvesNonEmpty(e, 'W1', { edits: [] })).toBe(true);
});
it('resolvesNonEmpty: a staged root-backed create counts only with a non-empty value', () => {
  const empty = stage({ edits: [] }, { key: 'N', op: 'create', secret: true, tags: [], value: '', asRoot: true });
  expect(resolvesNonEmpty(previewEntries([], 'W1', empty)[0], 'W1', empty)).toBe(false);
  const set = stage({ edits: [] }, { key: 'N', op: 'create', secret: true, tags: [], value: 'v', asRoot: true });
  expect(resolvesNonEmpty(previewEntries([], 'W1', set)[0], 'W1', set)).toBe(true);
  // An existing rooted key keeps its root; the typed value doesn't apply.
  const onExisting = stage({ edits: [] }, { key: 'A', op: 'create', secret: true, tags: [], value: '', asRoot: true });
  expect(resolvesNonEmpty(previewEntries([root('A')], 'W1', onExisting)[0], 'W1', onExisting, new Set(['A']))).toBe(true);
});
