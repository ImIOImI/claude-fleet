import { describe, expect, it } from 'vitest';
import type { VaultEntry } from '../../preload/vaultTypes';
import * as v from './vaultView';

const e = (key: string, over: Partial<VaultEntry> = {}): VaultEntry =>
  ({ key, secret: true, tags: [], fleet: false, root: { set: false }, lines: [], ...over });
const names = { W1: 'Fleet Dev', W2: 'devops' };

describe('vaultView', () => {
  it('derives root/fleet/secret and workspace tags', () => {
    const x = e('A', { root: { set: true }, fleet: true, lines: [{ workspaceId: 'W1', mode: 'inherit', pending: false }] });
    expect(v.derivedTags(x, names).sort()).toEqual(['fleet', 'fleet-dev', 'root', 'secret']);
  });
  it('filters by text over key and tags, AND across chips', () => {
    const list = [
      e('DOPPLER_TOKEN', { tags: ['doppler'], lines: [{ workspaceId: 'W2', mode: 'override', pending: false }] }),
      e('AWS_REGION', { secret: false, tags: ['aws'] })
    ];
    expect(v.filterEntries(list, names, { text: 'dopp', tags: [] }).map((x) => x.key)).toEqual(['DOPPLER_TOKEN']);
    expect(v.filterEntries(list, names, { text: '', tags: ['aws', 'plain'] }).map((x) => x.key)).toEqual(['AWS_REGION']);
    expect(v.filterEntries(list, names, { text: '', tags: ['aws', 'devops'] })).toEqual([]);
  });
  it('groups fleet keys first in registry order', () => {
    const g = v.groupEntries([e('B'), e('GITHUB_TOKEN', { fleet: true }), e('A')]);
    expect(g.fleet.map((x) => x.key)).toEqual(['GITHUB_TOKEN']);
    expect(g.keys.map((x) => x.key)).toEqual(['A', 'B']);
  });
  it('lists publishable workspaces', () => {
    const ws = [{ id: 'W1', kind: 'local' }, { id: 'W2', kind: 'remote' }, { id: 'W3', kind: 'container' }];
    const x = e('A', { lines: [{ workspaceId: 'W1', mode: 'inherit', pending: false }] });
    expect(v.publishableWorkspaces(x, ws).map((w) => w.id)).toEqual(['W3']);
  });
  it('slugs workspace names', () => {
    expect(v.workspaceTag('Fleet Dev!')).toBe('fleet-dev');
  });
});
