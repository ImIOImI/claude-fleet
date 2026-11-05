import { describe, expect, it, vi } from 'vitest';
import { authenticate, bearerToken, buildAuthContext, NEGATIVE_TTL_MS, type AuthContext } from './auth.js';
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

describe('negative verify cache', () => {
  const OTHER = 'gho_' + 'B'.repeat(36);
  const THIRD = 'gho_' + 'C'.repeat(36);
  const config = parseHostConfig({ workspace: { name: 'w' }, grants: [{ login: 'alice', tier: 'read' }] });
  const rejecting = () => vi.fn(async (_t: string): Promise<Identity> => { throw new IdentityError('unauthorized', 'bad credentials', 401); });

  it('a rejected token reaches the provider once within the TTL, then again after it', async () => {
    let t = 0;
    const verify = rejecting();
    const ctx = buildAuthContext(config, () => ({ id: 'github', verify }), { now: () => t });
    for (let i = 0; i < 3; i++) expect(await authenticate(`Bearer ${TOKEN}`, ctx)).toMatchObject({ ok: false, status: 401 });
    expect(verify).toHaveBeenCalledTimes(1);
    t = NEGATIVE_TTL_MS + 1;
    await authenticate(`Bearer ${TOKEN}`, ctx);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each(['network', 'upstream', 'forbidden', 'machine-unknown'] as const)('never caches a %s error', async (kind) => {
    const verify = vi.fn(async (): Promise<Identity> => { throw new IdentityError(kind, 'nope'); });
    const ctx = buildAuthContext(config, () => ({ id: 'github', verify }));
    await authenticate(`Bearer ${TOKEN}`, ctx);
    await authenticate(`Bearer ${TOKEN}`, ctx);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('a reload clears it: the new context re-verifies a token the old one rejected', async () => {
    const verify = rejecting();
    const factory = () => ({ id: 'github', verify });
    const old = buildAuthContext(config, factory);
    await authenticate(`Bearer ${TOKEN}`, old);
    await authenticate(`Bearer ${TOKEN}`, old);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockImplementation(async () => alice);
    expect(await authenticate(`Bearer ${TOKEN}`, buildAuthContext(config, factory))).toMatchObject({ ok: true });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('is a bounded LRU', async () => {
    const verify = rejecting();
    const ctx = buildAuthContext(config, () => ({ id: 'github', verify }), { negativeMaxEntries: 2 });
    await authenticate(`Bearer ${TOKEN}`, ctx);
    await authenticate(`Bearer ${OTHER}`, ctx);
    await authenticate(`Bearer ${TOKEN}`, ctx);
    await authenticate(`Bearer ${THIRD}`, ctx);
    expect(verify).toHaveBeenCalledTimes(3);
    await authenticate(`Bearer ${TOKEN}`, ctx);
    expect(verify).toHaveBeenCalledTimes(3);
    await authenticate(`Bearer ${OTHER}`, ctx);
    expect(verify).toHaveBeenCalledTimes(4);
  });
});

describe('AuthContext.peek', () => {
  const config = parseHostConfig({ workspace: { name: 'w' }, grants: [{ login: 'alice', tier: 'read' }] });

  it('is valid for a cached success, rejected for a cached unauthorized, miss otherwise; never calls the provider', async () => {
    const BAD = 'gho_' + 'D'.repeat(36);
    const verify = vi.fn(async (t: string): Promise<Identity> => {
      if (t === TOKEN) return alice;
      throw new IdentityError(t === BAD ? 'unauthorized' : 'network', 'no', 401);
    });
    const ctx = buildAuthContext(config, () => ({ id: 'github', verify }));
    expect(ctx.peek(TOKEN)).toBe('miss');
    await authenticate(`Bearer ${TOKEN}`, ctx);
    await authenticate(`Bearer ${BAD}`, ctx);
    await authenticate('Bearer gho_net', ctx);
    expect(verify).toHaveBeenCalledTimes(3);
    expect([ctx.peek(TOKEN), ctx.peek(BAD), ctx.peek('gho_net')]).toEqual(['valid', 'rejected', 'miss']);
    expect(verify).toHaveBeenCalledTimes(3);
  });
});
