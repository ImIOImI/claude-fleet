import { describe, expect, it, vi } from 'vitest';
import { authenticate, bearerToken, buildAuthContext, type AuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { createLogger } from './log.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';

const TOKEN = 'gho_' + 'A'.repeat(36);

const alice: Identity = {
  provider: 'github', kind: 'user', login: 'alice', id: 1, name: 'Alice', avatarUrl: null, teams: ['acme/platform']
};

function ctxWith(verify: IdentityProvider['verify'], grants = [{ team: 'acme/platform', tier: 'steer' }]): AuthContext {
  const config = parseHostConfig({ workspace: { name: 'w' }, grants });
  return buildAuthContext(config, () => ({ id: 'github', verify }));
}

describe('bearerToken', () => {
  it('accepts only "Bearer <token>"', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBeNull();
    expect(bearerToken(`token ${TOKEN}`)).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('authenticate', () => {
  it('resolves the tier from the grant config', async () => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async () => alice));
    expect(r).toEqual({ ok: true, identity: alice, tier: 'steer' });
  });

  it('401s with no token and never calls the provider', async () => {
    const verify = vi.fn(async () => alice);
    expect(await authenticate(undefined, ctxWith(verify))).toMatchObject({ ok: false, status: 401 });
    expect(verify).not.toHaveBeenCalled();
  });

  it('403s a verified identity with no matching grant', async () => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async () => ({ ...alice, teams: ['acme/other'] })));
    expect(r).toEqual({ ok: false, status: 403, error: 'no grant for @alice' });
  });

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
    ['machine-unknown', 403],
    ['network', 503],
    ['upstream', 502]
  ] as const)('maps IdentityError %s to %d', async (kind, status) => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async () => { throw new IdentityError(kind, 'nope'); }));
    expect(r).toMatchObject({ ok: false, status });
  });

  it.each(['forbidden', 'machine-unknown'] as const)('a %s machine gets a generic 403; the detail goes only to the log', async (kind) => {
    const lines: string[] = [];
    const detail = 'GitHub App acme-reviewer installation is not limited to org acme';
    const r = await authenticate(
      `Bearer ${TOKEN}`,
      ctxWith(async () => { throw new IdentityError(kind, detail); }),
      createLogger((l) => lines.push(l))
    );
    expect(r).toEqual({ ok: false, status: 403, error: 'machine not permitted' });
    expect(lines.join('\n')).toContain(detail);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('never echoes a non-IdentityError message (it may carry the token)', async () => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async (t) => { throw new Error(`fetch failed for ${t}`); }));
    expect(r).toEqual({ ok: false, status: 502, error: 'identity check failed' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('caches verification per context, and a new context re-verifies', async () => {
    const verify = vi.fn(async () => alice);
    const config = parseHostConfig({ workspace: { name: 'w' }, grants: [{ login: 'alice', tier: 'read' }] });
    const factory = () => ({ id: 'github', verify });
    const a = buildAuthContext(config, factory);
    await authenticate(`Bearer ${TOKEN}`, a);
    await authenticate(`Bearer ${TOKEN}`, a);
    expect(verify).toHaveBeenCalledTimes(1);
    await authenticate(`Bearer ${TOKEN}`, buildAuthContext(config, factory));
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

describe('config reload (#479)', () => {
  it('a new AuthContext re-proves a machine against the new rule, never reusing the old cache', async () => {
    const machine: Identity = { provider: 'github', kind: 'machine', appId: 123456, login: 'acme-reviewer[bot]', id: 9, name: null, avatarUrl: null, teams: [] };
    const seen: string[][] = [];
    const factory = (machines: readonly { org: string }[]) => {
      seen.push(machines.map((m) => m.org));
      return { id: 'github', verify: vi.fn(async () => machine) };
    };
    const cfg = (org: string) =>
      parseHostConfig({ workspace: { name: 'w' }, machines: [{ appId: 123456, login: 'acme-reviewer[bot]', org, tier: 'steer' }] });
    const before = buildAuthContext(cfg('acme'), factory);
    await authenticate(`Bearer ${TOKEN}`, before);
    const after = buildAuthContext(cfg('other-org'), factory);
    await authenticate(`Bearer ${TOKEN}`, after);
    expect(seen).toEqual([['acme'], ['other-org']]);
    expect(after.provider).not.toBe(before.provider);
  });
});
