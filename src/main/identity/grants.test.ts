import { describe, expect, it } from 'vitest';
import { GrantConfigError, parseGrantConfig, resolveTier, tierAtLeast, TIERS, type GrantConfig } from './grants.js';
import { displayName } from './types.js';

const CONFIG: GrantConfig = {
  grants: [
    { team: 'acme/platform', tier: 'session' },
    { team: 'acme/engineering', tier: 'read' },
    { login: 'some-contractor', tier: 'steer' }
  ],
  machines: [{ appId: 123456, login: 'acme-reviewer[bot]', tier: 'steer' }]
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
    expect(resolveTier({ kind: 'machine', login: 'acme-reviewer[bot]', teams: [] }, CONFIG)).toBe('steer');
    expect(resolveTier({ kind: 'machine', login: 'some-contractor', teams: ['acme/platform'] }, CONFIG)).toBeNull();
    expect(resolveTier(user('acme-reviewer[bot]'), CONFIG)).toBeNull();
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
    expect(parsed).toEqual(CONFIG);
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
    ['a duplicate appId', { machines: [{ appId: 1, login: 'a[bot]', tier: 'read' }, { appId: 1, login: 'b[bot]', tier: 'read' }] }, /appId 1 listed twice/]
  ])('rejects %s', (_label, raw, msg) => {
    expect(() => parseGrantConfig(raw)).toThrow(GrantConfigError);
    expect(() => parseGrantConfig(raw)).toThrow(msg);
  });
});

describe('displayName', () => {
  it('falls back to the login when the name is unset or blank', () => {
    expect(displayName({ name: 'Octo Cat', login: 'octo' })).toBe('Octo Cat');
    expect(displayName({ name: null, login: 'octo' })).toBe('octo');
    expect(displayName({ name: '   ', login: 'octo' })).toBe('octo');
  });
});
