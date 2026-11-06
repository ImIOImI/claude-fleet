// Identity-provider seam. Pure (no electron) so fleet-host imports it unchanged.

export type IdentityKind = 'user' | 'machine';

interface IdentityBase {
  /** Id of the provider that verified this identity, e.g. 'github'. */
  provider: string;
  kind: IdentityKind;
  /** For machines: the bot login configured in the host's `machines` rules
   *  (display only — grants resolve machines by `appId`, never by login). */
  login: string;
  /** Provider's numeric account id (GitHub user id, or the bot user's id). */
  id: number;
  /** Profile display name; null when unset. Render with displayName(). */
  name: string | null;
  avatarUrl: string | null;
  /** 'org/team-slug', lower-cased and sorted. Always empty for machines. */
  teams: string[];
}

export interface UserIdentity extends IdentityBase {
  kind: 'user';
}

export interface MachineIdentity extends IdentityBase {
  kind: 'machine';
  /** The GitHub App id the token was proven to belong to. resolveTier keys on this. */
  appId: number;
}

export type Identity = UserIdentity | MachineIdentity;

export interface IdentityProvider {
  readonly id: string;
  /** Verify a bearer token and say who it belongs to. Throws IdentityError. */
  verify(token: string): Promise<Identity>;
}

/** `forbidden`: the token is genuine but not acceptable here (e.g. an App
 *  installation that reaches repositories outside the rule's org). */
export type IdentityErrorKind = 'unauthorized' | 'forbidden' | 'machine-unknown' | 'network' | 'upstream';

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
