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
  it('clamps slugs to 32 chars and trims a trailing dash after clamping', () => {
    const long = v.workspaceTag('a'.repeat(40));
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z0-9-]{1,32}$/);
  });
  it('falls back to the workspace id slug when the name slugs to empty', () => {
    const x = e('A', { lines: [{ workspaceId: 'W1', mode: 'inherit', pending: false }] });
    expect(v.derivedTags(x, { W1: '!!!' })).toContain(v.workspaceTag('W1'));
  });
  it('builds unique sorted tags across entries, derived winning on clash', () => {
    const list = [
      e('A', { tags: ['secret'], root: { set: true } }),
      e('B', { tags: ['aws'], secret: false })
    ];
    expect(v.allTags(list, names)).toEqual([
      { tag: 'aws', derived: false },
      { tag: 'plain', derived: true },
      { tag: 'root', derived: true },
      { tag: 'secret', derived: true }
    ]);
  });
  it('finds entries referencing a workspace via inherit or override lines', () => {
    const list = [
      e('A', { lines: [{ workspaceId: 'W1', mode: 'inherit', pending: false }] }),
      e('B', { lines: [{ workspaceId: 'W1', mode: 'override', pending: false }] }),
      e('C', { lines: [{ workspaceId: 'W2', mode: 'inherit', pending: false }] })
    ];
    expect(v.entriesForWorkspace(list, 'W1').map((x) => x.key)).toEqual(['A', 'B']);
  });
  it('parses tag input: split, lowercase, dedupe, flag invalid', () => {
    expect(v.parseTagInput(' AWS, secrets  aws,bad_tag ')).toEqual({ tags: ['aws', 'secrets'], invalid: ['bad_tag'] });
    expect(v.parseTagInput('')).toEqual({ tags: [], invalid: [] });
  });
  it('suggests completions of the last tag token', () => {
    expect(v.tagSuggestions('aws, do', ['aws', 'doppler', 'docker', 'x'])).toEqual(['aws, doppler', 'aws, docker']);
    expect(v.tagSuggestions('', ['a', 'b'])).toEqual(['a', 'b']);
    expect(v.tagSuggestions('a ', ['a', 'b'])).toEqual(['a b']);
  });
  it('validates key names', () => {
    expect(v.isValidKeyName('AWS_REGION')).toBe(true);
    expect(v.isValidKeyName('9X')).toBe(false);
    expect(v.isValidKeyName('A-B')).toBe(false);
  });
  it('counts inherit lines and labels pending by kind', () => {
    const x = e('A', {
      lines: [
        { workspaceId: 'W1', mode: 'inherit', pending: false },
        { workspaceId: 'W2', mode: 'override', pending: true }
      ]
    });
    expect(v.inheritCount(x)).toBe(1);
    expect(v.pendingLabel('container')).toBe('recreate to apply');
    expect(v.pendingLabel('local')).toBe('restart to apply');
    expect(v.pendingLabel('remote')).toBeNull();
  });
});
