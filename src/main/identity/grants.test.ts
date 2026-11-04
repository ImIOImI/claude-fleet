import { describe, expect, it } from 'vitest';
import { GITHUB_SHARED_APPS, GrantConfigError, parseGrantConfig, resolveTier, tierAtLeast, TIERS, type GrantConfig } from './grants.js';
import { displayName } from './types.js';

const CONFIG: GrantConfig = {
  grants: [
    { team: 'acme/platform', tier: 'session' },
    { team: 'acme/engineering', tier: 'read' },
    { login: 'some-contractor', tier: 'steer' }
  ],
  machines: [{ appId: 123456, login: 'acme-reviewer[bot]', org: 'acme', tier: 'steer' }]
};
const user = (login: string, teams: string[] = []) => ({ kind: 'user' as const, login, teams });

describe('resolveTier', () => {
  it('denies when no rule matches', () => {
    expect(resolveTier(user('stranger', ['other/team']), CONFIG)).toBeNull();
    expect(resolveTier(user('anyone'), { grants: [], machines: [] })).toBeNull();
  });

  it('grants by team and by login', () => {
    expect(resolveTier(user('dev', ['acme/engineering']), CONFIG)).toBe('read');
    expect(resolveTier(user('some-contractor'), CONFIG)).toBe('steer');
  });

  it('takes the highest tier any rule grants', () => {
    expect(resolveTier(user('lead', ['acme/engineering', 'acme/platform']), CONFIG)).toBe('session');
    expect(resolveTier(user('some-contractor', ['acme/engineering']), CONFIG)).toBe('steer');
  });

  it('compares teams and logins case-insensitively', () => {
    expect(resolveTier(user('Some-Contractor'), CONFIG)).toBe('steer');
    expect(resolveTier(user('dev', ['ACME/Platform']), CONFIG)).toBe('session');
  });

  it('gives machines a tier only from machines rules', () => {
    expect(resolveTier({ kind: 'machine', appId: 123456 }, CONFIG)).toBe('steer');
    expect(resolveTier({ kind: 'machine', appId: 999 }, CONFIG)).toBeNull();
    expect(resolveTier(user('acme-reviewer[bot]'), CONFIG)).toBeNull();
  });

  it('resolves machines by appId, never by login', () => {
    const two: GrantConfig = {
      grants: [{ login: 'ci', tier: 'session' }],
      machines: [
        { appId: 1, login: 'ci[bot]', org: 'acme', tier: 'read' },
        { appId: 2, login: 'ci-deploy[bot]', org: 'acme', tier: 'session' }
      ]
    };
    // A machine identity for App 1 whose login happens to name App 2's rule
    // (or a user rule) still gets only App 1's tier.
    const m = { kind: 'machine' as const, appId: 1, login: 'ci-deploy[bot]', teams: [] };
    expect(resolveTier(m, two)).toBe('read');
    expect(resolveTier({ kind: 'machine', appId: 2, login: 'ci[bot]', teams: [] }, two)).toBe('session');
  });
});

describe('tierAtLeast', () => {
  it('orders tiers read < steer < session', () => {
    expect(TIERS).toEqual(['read', 'steer', 'session']);
    expect(tierAtLeast('session', 'read')).toBe(true);
    expect(tierAtLeast('steer', 'steer')).toBe(true);
    expect(tierAtLeast('read', 'steer')).toBe(false);
    expect(tierAtLeast(null, 'read')).toBe(false);
  });
});

describe('parseGrantConfig', () => {
  it('parses the spec example and ignores unrelated keys', () => {
    const parsed = parseGrantConfig({
      identity: { provider: 'github', org: 'acme' },
      grants: [
        { team: 'acme/platform', tier: 'session' },
        { team: 'acme/engineering', tier: 'read' },
        { login: 'some-contractor', tier: 'steer' }
      ],
      machines: [{ appId: 123456, login: 'acme-reviewer[bot]', tier: 'steer' }]
    });
    // The machine rule inherits identity.org.
    expect(parsed).toEqual(CONFIG);
  });

  it('keeps a machine rule\'s own org over identity.org', () => {
    const parsed = parseGrantConfig({
      identity: { org: 'acme' },
      machines: [{ appId: 1, login: 'ci[bot]', org: 'Other-Org', tier: 'read' }]
    });
    expect(parsed.machines).toEqual([{ appId: 1, login: 'ci[bot]', org: 'Other-Org', tier: 'read' }]);
  });

  it('accepts distinct machine logins', () => {
    const parsed = parseGrantConfig({
      identity: { org: 'acme' },
      machines: [
        { appId: 1, login: 'ci[bot]', tier: 'read' },
        { appId: 2, login: 'ci-deploy[bot]', tier: 'session' }
      ]
    });
    expect(parsed.machines.map((m) => m.appId)).toEqual([1, 2]);
  });

  it('defaults missing lists to empty', () => {
    expect(parseGrantConfig({})).toEqual({ grants: [], machines: [] });
  });

  it.each([
    ['a non-object', 'nope', /grant config must be an object/],
    ['grants not a list', { grants: {} }, /grants must be a list/],
    ['a bad tier', { grants: [{ team: 'acme/x', tier: 'admin' }] }, /grants\[0\]\.tier/],
    ['both team and login', { grants: [{ team: 'acme/x', login: 'y', tier: 'read' }] }, /exactly one of team or login/],
    ['neither team nor login', { grants: [{ tier: 'read' }] }, /exactly one of team or login/],
    ['a team without org', { grants: [{ team: 'platform', tier: 'read' }] }, /org\/team-slug/],
    ['a bad login', { grants: [{ login: 'has space', tier: 'read' }] }, /GitHub login/],
    ['a bad appId', { machines: [{ appId: -1, login: 'x[bot]', tier: 'read' }] }, /machines\[0\]\.appId/],
    ['a machine login without [bot]', { machines: [{ appId: 1, login: 'x', tier: 'read' }] }, /\[bot\]/],
    ['a duplicate appId', { machines: [{ appId: 1, login: 'a[bot]', org: 'acme', tier: 'read' }, { appId: 1, login: 'b[bot]', org: 'acme', tier: 'read' }] }, /appId 1 listed twice/],
    [
      'a duplicate machine login (case-insensitive)',
      {
        machines: [
          { appId: 1, login: 'ci[bot]', org: 'acme', tier: 'read' },
          { appId: 2, login: 'CI[bot]', org: 'acme', tier: 'session' }
        ]
      },
      /machines\[1\]\.login ci\[bot\] listed twice/i
    ],
    ['the github-actions shared App', { machines: [{ appId: 15368, login: 'github-actions[bot]', org: 'acme', tier: 'read' }] }, /appId 15368 is GitHub's shared github-actions App.*dedicated org-owned GitHub App/],
    ['the dependabot shared App', { machines: [{ appId: 29110, login: 'dependabot[bot]', org: 'acme', tier: 'read' }] }, /appId 29110 is GitHub's shared dependabot App.*dedicated org-owned GitHub App/],
    ['a machine without org or identity.org', { machines: [{ appId: 1, login: 'x[bot]', tier: 'read' }] }, /machines\[0\]\.org is required/],
    ['a bad machine org', { machines: [{ appId: 1, login: 'x[bot]', org: 'not an org', tier: 'read' }] }, /machines\[0\]\.org must be a GitHub org login/],
    ['a bad identity.org when inherited', { identity: { org: 'a/b' }, machines: [{ appId: 1, login: 'x[bot]', tier: 'read' }] }, /identity\.org must be a GitHub org login/]
  ])('rejects %s', (_label, raw, msg) => {
    expect(() => parseGrantConfig(raw)).toThrow(GrantConfigError);
    expect(() => parseGrantConfig(raw)).toThrow(msg);
  });
});

describe('GITHUB_SHARED_APPS', () => {
  it('names the github-actions and dependabot app ids', () => {
    expect(GITHUB_SHARED_APPS.get(15368)).toBe('github-actions');
    expect(GITHUB_SHARED_APPS.get(29110)).toBe('dependabot');
    expect(GITHUB_SHARED_APPS.get(1)).toBeUndefined();
  });
});

describe('displayName', () => {
  it('falls back to the login when the name is unset or blank', () => {
    expect(displayName({ name: 'Octo Cat', login: 'octo' })).toBe('Octo Cat');
    expect(displayName({ name: null, login: 'octo' })).toBe('octo');
    expect(displayName({ name: '   ', login: 'octo' })).toBe('octo');
  });
});
