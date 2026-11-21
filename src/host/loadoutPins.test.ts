import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADOUTS_API,
  DEFAULT_SYNC_TIMEOUT_S,
  parseApiBase,
  parsePins,
  parseRepo,
  parseTimeoutS,
  pinTag,
  planSync
} from './loadoutPins.js';
import type { PinnedRecord } from './loadoutRecord.js';

describe('parsePins', () => {
  it('reads whitespace- and comma-separated id@version pins', () => {
    expect(parsePins('committee-pr-review@2.1.1 git-sync-sumer@1.0.0')).toEqual([
      { id: 'committee-pr-review', version: '2.1.1' },
      { id: 'git-sync-sumer', version: '1.0.0' }
    ]);
    expect(parsePins(' a@1.0.0,b@2.0.0-rc.1\n')).toEqual([
      { id: 'a', version: '1.0.0' },
      { id: 'b', version: '2.0.0-rc.1' }
    ]);
  });

  it('reads nothing pinned as an empty list', () => {
    expect(parsePins(undefined)).toEqual([]);
    expect(parsePins('  ,  ')).toEqual([]);
  });

  it.each(['a', 'a@', '@1.0.0', 'A@1.0.0', 'a@1.0', 'a@v1.0.0', 'a@01.0.0', 'a@1.0.0+build', 'a/b@1.0.0', '../x@1.0.0', '-a@1.0.0'])(
    'refuses %s',
    (text) => {
      expect(() => parsePins(text)).toThrow(`FLEET_LOADOUTS: "${text}" is not <id>@<semver>`);
    }
  );

  it('refuses an id pinned twice', () => {
    expect(() => parsePins('a@1.0.0 a@2.0.0')).toThrow('FLEET_LOADOUTS: a is pinned twice');
  });
});

describe('settings', () => {
  it('defaults and validates the repo', () => {
    expect(parseRepo(undefined)).toEqual({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
    expect(parseRepo('acme/loadouts')).toEqual({ owner: 'acme', repo: 'loadouts' });
    for (const bad of ['acme', 'acme/x/y', 'acme/..', 'ac me/x', '/x']) {
      expect(() => parseRepo(bad)).toThrow(`FLEET_LOADOUTS_REPO: "${bad}" is not <owner>/<repo>`);
    }
  });

  it('defaults and validates the API base', () => {
    expect(parseApiBase(undefined)).toBe(DEFAULT_LOADOUTS_API);
    expect(parseApiBase('http://gh-fake:8090/')).toBe('http://gh-fake:8090');
    for (const bad of ['nope', 'ftp://x', 'https://u:p@x', 'https://x/?q=1', 'https://x/#f']) {
      expect(() => parseApiBase(bad)).toThrow(/^FLEET_LOADOUTS_API /);
    }
  });

  it('reads the timeout', () => {
    expect(parseTimeoutS(undefined)).toBe(DEFAULT_SYNC_TIMEOUT_S);
    expect(parseTimeoutS('5')).toBe(5);
    for (const bad of ['0', '601', '1.5', 'x', '']) {
      if (bad === '') expect(parseTimeoutS(bad)).toBe(60);
      else expect(() => parseTimeoutS(bad)).toThrow('FLEET_LOADOUTS_TIMEOUT_S must be 1 to 600');
    }
  });

  it('names the tag', () => {
    expect(pinTag({ id: 'committee-pr-review', version: '2.1.1' })).toBe('committee-pr-review/v2.1.1');
  });
});

describe('planSync', () => {
  const repo = { owner: 'SumerSports', repo: 'claude-fleet-loadouts' };
  const r = (id: string, version: string, from = 'SumerSports/claude-fleet-loadouts'): PinnedRecord => ({
    id,
    version,
    repo: from,
    commit: 'a'.repeat(40),
    files: [],
    claudeMd: false,
    settingsKeys: [],
    mcpServers: [],
    hooks: [],
    installedAt: 1
  });

  it('plans unchanged, install and revert', () => {
    const plan = planSync(
      [{ id: 'a', version: '1.0.0' }, { id: 'b', version: '2.0.0' }, { id: 'c', version: '1.0.0' }],
      repo,
      [r('a', '1.0.0'), r('b', '1.0.0'), r('d', '1.0.0')]
    );
    expect(plan.unchanged.map((x) => x.id)).toEqual(['a']);
    expect(plan.install).toEqual([
      { pin: { id: 'b', version: '2.0.0' }, previous: r('b', '1.0.0') },
      { pin: { id: 'c', version: '1.0.0' }, previous: null }
    ]);
    expect(plan.revert.map((x) => x.id)).toEqual(['d']);
  });

  it('treats another repo as a change and matches the repo case-insensitively', () => {
    expect(planSync([{ id: 'a', version: '1.0.0' }], repo, [r('a', '1.0.0', 'acme/loadouts')]).install).toHaveLength(1);
    expect(planSync([{ id: 'a', version: '1.0.0' }], repo, [r('a', '1.0.0', 'sumersports/Claude-Fleet-Loadouts')]).unchanged).toHaveLength(1);
  });
});
