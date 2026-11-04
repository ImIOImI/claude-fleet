// Identity-provider seam (remote-workspaces §5, sub-project (b)). Pure — no
// electron — so fleet-host (sub-project (c)) imports it unchanged. GitHub is
// the first provider (githubProvider.ts); OIDC (e.g. Entra ID) is a later
// second implementation of the same IdentityProvider interface: verify an ID
// token against the issuer's JWKS, map groups to `teams`.

export type IdentityKind = 'user' | 'machine';

export interface Identity {
  /** Id of the provider that verified this identity, e.g. 'github'. */
  provider: string;
  kind: IdentityKind;
  /** For machines: the bot login configured in the host's `machines` rules. */
  login: string;
  /** Provider's numeric account id (GitHub user id, or the bot user's id). */
  id: number;
  /** Profile display name; null when unset. Render with displayName(). */
  name: string | null;
  avatarUrl: string | null;
  /** 'org/team-slug', lower-cased and sorted. Always empty for machines. */
  teams: string[];
}

export interface IdentityProvider {
  readonly id: string;
  /** Verify a bearer token and say who it belongs to. Throws IdentityError. */
  verify(token: string): Promise<Identity>;
}

export type IdentityErrorKind = 'unauthorized' | 'machine-unknown' | 'network' | 'upstream';

/** Messages never contain the token. */
export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;
  readonly status?: number;
  constructor(kind: IdentityErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'IdentityError';
    this.kind = kind;
    this.status = status;
  }
}

/** The profile name, or the login when the name is unset or blank. */
export function displayName(i: Pick<Identity, 'name' | 'login'>): string {
  const n = i.name?.trim();
  return n ? n : i.login;
}
