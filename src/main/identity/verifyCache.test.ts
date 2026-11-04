import { describe, expect, it, vi } from 'vitest';
import { withVerifyCache, VERIFY_TTL_MS } from './verifyCache.js';
import { IdentityError, type Identity, type IdentityProvider } from './types.js';

const who = (login: string): Identity => ({ provider: 'github', kind: 'user', login, id: 1, name: null, avatarUrl: null, teams: [] });

function inner(impl: (token: string) => Promise<Identity>) {
  const verify = vi.fn(impl);
  const p: IdentityProvider = { id: 'github', verify };
  return { p, verify };
}

describe('withVerifyCache', () => {
  it('caches a success for the TTL, then re-verifies', async () => {
    let t = 0;
    const { p, verify } = inner(async (tok) => who(tok));
    const cached = withVerifyCache(p, { now: () => t });
    expect(VERIFY_TTL_MS).toBe(300_000);
    expect(cached.id).toBe('github');
    await cached.verify('a');
    t = VERIFY_TTL_MS - 1;
    await cached.verify('a');
    expect(verify).toHaveBeenCalledTimes(1);
    t = VERIFY_TTL_MS + 1;
    await cached.verify('a');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('keeps tokens apart', async () => {
    const { p } = inner(async (tok) => who(tok));
    const cached = withVerifyCache(p);
    expect((await cached.verify('a')).login).toBe('a');
    expect((await cached.verify('b')).login).toBe('b');
  });

  it('does not cache failures', async () => {
    let fail = true;
    const { p, verify } = inner(async (tok) => {
      if (fail) throw new IdentityError('unauthorized', 'nope', 401);
      return who(tok);
    });
    const cached = withVerifyCache(p);
    await expect(cached.verify('a')).rejects.toMatchObject({ kind: 'unauthorized' });
    fail = false;
    expect((await cached.verify('a')).login).toBe('a');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent verifications of one token', async () => {
    let release: (v: Identity) => void = () => undefined;
    const { p, verify } = inner(() => new Promise<Identity>((r) => { release = r; }));
    const cached = withVerifyCache(p);
    const a = cached.verify('a');
    const b = cached.verify('a');
    release(who('a'));
    expect(await a).toEqual(await b);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('hands out frozen identities so callers cannot mutate the cached entry', async () => {
    const { p } = inner(async (tok) => ({ ...who(tok), teams: ['acme/eng'] }));
    const cached = withVerifyCache(p);
    const first = await cached.verify('a');
    expect(() => {
      (first as { login: string }).login = 'admin';
    }).toThrow(TypeError);
    expect(() => first.teams.push('acme/platform')).toThrow(TypeError);
    const again = await cached.verify('a');
    expect(again.login).toBe('a');
    expect(again.teams).toEqual(['acme/eng']);
  });

  it('does not freeze the inner provider\'s own object', async () => {
    const original = who('a');
    const { p } = inner(async () => original);
    await withVerifyCache(p).verify('a');
    expect(Object.isFrozen(original)).toBe(false);
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const { p, verify } = inner(async (tok) => who(tok));
    const cached = withVerifyCache(p, { maxEntries: 2 });
    await cached.verify('a');
    await cached.verify('b');
    await cached.verify('c');
    await cached.verify('a');
    expect(verify).toHaveBeenCalledTimes(4);
  });
});
