// Per-request identity: Bearer token → verified Identity → tier. The provider
// and its verify cache are built together from one config snapshot, so a
// reload never pairs a new grant list with identities cached under the old
// one.
import { createGithubProvider } from '../main/identity/githubProvider.js';
import { resolveTier, type GrantConfig, type MachineRule, type Tier } from '../main/identity/grants.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';
import { withVerifyCache } from '../main/identity/verifyCache.js';
import type { HostConfig } from './config.js';

export interface AuthContext {
  readonly provider: IdentityProvider;
  readonly grants: GrantConfig;
}

export type ProviderFactory = (machines: readonly MachineRule[]) => IdentityProvider;

export const githubProviderFactory: ProviderFactory = (machines) => createGithubProvider({ machines });

export function buildAuthContext(config: HostConfig, factory: ProviderFactory = githubProviderFactory): AuthContext {
  return { provider: withVerifyCache(factory(config.grants.machines)), grants: config.grants };
}

export type AuthResult =
  | { ok: true; identity: Identity; tier: Tier }
  | { ok: false; status: 401 | 403 | 502 | 503; error: string };

const BEARER_RE = /^Bearer ([A-Za-z0-9_.~+/=-]{1,4096})$/;

export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = BEARER_RE.exec(header);
  return m ? m[1] : null;
}

export async function authenticate(header: string | string[] | undefined, ctx: AuthContext): Promise<AuthResult> {
  const token = bearerToken(header);
  if (!token) return { ok: false, status: 401, error: 'missing or malformed bearer token' };
  let identity: Identity;
  try {
    identity = await ctx.provider.verify(token);
  } catch (err) {
    if (!(err instanceof IdentityError)) return { ok: false, status: 502, error: 'identity check failed' };
    switch (err.kind) {
      case 'unauthorized':
        return { ok: false, status: 401, error: 'token rejected by GitHub' };
      case 'forbidden':
      case 'machine-unknown':
        return { ok: false, status: 403, error: err.message };
      case 'network':
        return { ok: false, status: 503, error: 'GitHub unreachable' };
      default:
        return { ok: false, status: 502, error: 'GitHub identity check failed' };
    }
  }
  const tier = resolveTier(identity, ctx.grants);
  if (!tier) return { ok: false, status: 403, error: `no grant for @${identity.login}` };
  return { ok: true, identity, tier };
}
