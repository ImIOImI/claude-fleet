// identity:* IPC payloads (Settings → Account). Main imports them type-only,
// the renderer via FleetApi. The OAuth token and the device code never appear here.

export interface AccountIdentity {
  provider: 'github';
  login: string;
  id: number;
  name: string | null;
  /** name, or login when the name is unset. */
  displayName: string;
  avatarUrl: string | null;
  teams: string[];
}

export interface AccountSso {
  /** Org-specific authorise URL from `X-GitHub-SSO: required; url=…`. */
  url: string | null;
  org: string | null;
  /** Orgs that withheld results (`partial-results`). */
  orgCount: number;
  /** github.com/settings/connections/applications/<clientId> — per-org grants. */
  appSettingsUrl: string | null;
}

export interface AccountStatus {
  /** An OAuth client id resolved (env, config.json or built-in). */
  configured: boolean;
  /** The vault is usable; false ⇒ the sign-in lasts until the app quits. */
  persisted: boolean;
  signedIn: boolean;
  identity: AccountIdentity | null;
  scopes: string[];
  /** The token can pull private ghcr.io loadout sources (read:packages). */
  packagesAccess: boolean;
  sso: AccountSso | null;
  /** One-off explanation, e.g. the saved token was revoked. */
  notice: string | null;
}

export interface SignInStart {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}

export type SignInPoll =
  | { state: 'pending'; intervalMs: number }
  | { state: 'done'; status: AccountStatus }
  | { state: 'error'; message: string };
