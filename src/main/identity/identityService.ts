// Desktop GitHub sign-in: device-flow state, the token (vault scope
// identity:github, never sent to the renderer) and the cached profile.
// A vault GITHUB_TOKEN (PAT), when set, wins over the device-flow token.
// ipc.ts injects the real vault + client-id resolver; tests inject fakes.

import { createHash } from 'node:crypto';
import { GITHUB_IDENTITY_SCOPE } from '../vaultScopes.js';
import { DeviceFlowError, SLOW_DOWN_STEP_MS, pollDeviceToken, refreshDeviceToken, requestDeviceCode, type DeviceCode, type PollResult, type TokenGrant } from './deviceFlow.js';
import { createGithubProvider, type GithubProbe } from './githubProvider.js';
import { hasPackagesRead, type SsoHint } from './githubHeaders.js';
import { IdentityError, displayName, type UserIdentity } from './types.js';
import { CLIENT_ID_MISSING } from './clientId.js';
import type { AccountSso, AccountStatus, IdentityChange, SignInPoll, SignInStart } from '../../preload/identityTypes.js';

export const TOKEN_KEY = 'TOKEN';
export const PROFILE_KEY = 'PROFILE';
/** The verified profile of the vault PAT, keyed by its sha256; never paired with TOKEN. */
export const PAT_PROFILE_KEY = 'PAT_PROFILE';
/** Refresh token and expiries of an expiring (GitHub App user) token; '' for a token that never expires. */
export const REFRESH_KEY = 'REFRESH';
/** Refresh this long before the access token expires. */
export const REFRESH_LEAD_MS = 10 * 60_000;
/** After a failed refresh, wait this long before trying again. */
export const REFRESH_RETRY_MS = 60_000;
/** Minimum gap between successful refreshes, except once the token has expired. */
export const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const REVOKED_NOTICE = 'GitHub no longer accepts the saved sign-in (revoked or expired). Sign in again.';
const EXPIRED_NOTICE = 'Your GitHub sign-in expired and could not be renewed. Sign in again.';
const PAT_REJECTED = 'The GitHub token in the Vault was rejected (401).';
/** A PAT probe that failed transiently is not retried (except on refresh) for this long. */
const PAT_RETRY_MS = 60_000;
const FINE_GRAINED_NOTICE =
  'Fine-grained tokens report no scopes: GHCR access and team grants need a classic token with read:org and read:packages.';
const NO_FLOW = 'No sign-in in progress.';
const CANCELLED = 'Sign-in was cancelled.';
/** The renderer re-asks at least this often; main still gates real polls. */
const MAX_WAIT_MS = 60_000;

export interface IdentityVault {
  isVaultAvailable(): Promise<boolean>;
  getSecret(scope: string, key: string): Promise<string | null>;
  setSecret(scope: string, key: string, value: string): Promise<void>;
  deleteAllForWorkspace(scope: string): Promise<void>;
}

export interface GithubSignInApi {
  requestDeviceCode(clientId: string): Promise<DeviceCode>;
  pollDeviceToken(clientId: string, deviceCode: string, intervalMs: number): Promise<PollResult>;
  probe(token: string): Promise<GithubProbe>;
  /** Absent: tokens are never refreshed. */
  refresh?(clientId: string, refreshToken: string): Promise<TokenGrant>;
}

export interface IdentityServiceDeps {
  vault: IdentityVault;
  clientId(): Promise<string | null>;
  github?: GithubSignInApi;
  now?: () => number;
  /** The vault GITHUB_TOKEN; absent on fleet-host. */
  patToken?: () => Promise<string | null>;
  /** Refresh timer; returns a cancel. Default: an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Fired after the vault write settles, only when the stored token changed. Never carries the token. */
export type { IdentityChange };
export type IdentityChangeCause = IdentityChange['cause'];
/** After a host 401: `retry` with the stored token; `expired` (GitHub refused it and it couldn't be renewed, now cleared); or `host-refused` (GitHub still accepts it, or couldn't be asked). */
export type RecoverResult = 'retry' | 'expired' | 'host-refused';

interface Profile {
  identity: UserIdentity;
  scopes: string[];
  sso: SsoHint | null;
  verifiedAt: number;
}
type Source = 'device' | 'pat';
type Grant = Omit<TokenGrant, 'token' | 'scopes'>;
interface Saved {
  token: string;
  profile: Profile;
  source: Source;
  /** Always empty for a PAT. */
  grant: Grant;
}
type PatProbe = { ok: true; probe: GithubProbe } | { ok: false; err: unknown };
/** A PAT with no usable verification yet needs a probe, run outside `serial`. */
type Step = { saved: Saved | null; verify?: undefined } | { saved?: undefined; verify: { pat: string; sha: string } };
interface Pending {
  clientId: string;
  code: DeviceCode;
  intervalMs: number;
  nextPollAt: number;
  inflight: boolean;
  /** Token received; the profile read and save are in progress. */
  finishing: boolean;
}

export class IdentityNotConfiguredError extends Error {
  constructor() {
    super(`not-configured: ${CLIENT_ID_MISSING}`);
    this.name = 'IdentityNotConfiguredError';
  }
}

function githubUrlOrNull(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

function httpsUrlOrNull(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export function toAccountSso(sso: SsoHint, clientId: string | null): AccountSso {
  return {
    url: githubUrlOrNull(sso.url),
    org: sso.org,
    orgCount: sso.orgIds.length,
    appSettingsUrl: clientId ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}` : null
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseGrant(raw: string | null): Grant {
  let o: Record<string, unknown> | null = null;
  try {
    o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    o = null;
  }
  if (!o || typeof o !== 'object') return {};
  const g: Grant = {};
  if (isTime(o.expiresAt)) g.expiresAt = o.expiresAt;
  if (isStr(o.refreshToken) && o.refreshToken) g.refreshToken = o.refreshToken;
  if (isTime(o.refreshExpiresAt)) g.refreshExpiresAt = o.refreshExpiresAt;
  return g;
}

function grantOf(t: TokenGrant): Grant {
  const g: Grant = {};
  if (t.expiresAt !== undefined) g.expiresAt = t.expiresAt;
  if (t.refreshToken !== undefined) g.refreshToken = t.refreshToken;
  if (t.refreshExpiresAt !== undefined) g.refreshExpiresAt = t.refreshExpiresAt;
  return g;
}
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function isSso(v: unknown): v is SsoHint {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return isStrOrNull(s.url) && isStrOrNull(s.org) && Array.isArray(s.orgIds) && s.orgIds.every((n) => typeof n === 'number');
}

/** The vault is host-side, but a stale or odd PROFILE must not sign anyone in. */
function isProfile(v: unknown): v is Profile {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  const i = p.identity as Record<string, unknown> | undefined;
  return (
    !!i &&
    typeof i === 'object' &&
    i.provider === 'github' &&
    i.kind === 'user' &&
    isStr(i.login) &&
    typeof i.id === 'number' &&
    isStrOrNull(i.name) &&
    isStrOrNull(i.avatarUrl) &&
    isStrArray(i.teams) &&
    isStrArray(p.scopes) &&
    (p.sso === null || isSso(p.sso)) &&
    typeof p.verifiedAt === 'number' &&
    (p.source === undefined || p.source === 'pat') &&
    (p.tokenSha === undefined || isStr(p.tokenSha))
  );
}

function parseProfile(raw: string | null): Profile | null {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  return isProfile(v) ? v : null;
}

function patFields(p: Profile): { source?: unknown; tokenSha?: unknown } {
  return p as { source?: unknown; tokenSha?: unknown };
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** IdentityError messages are token-free by contract; anything else is not echoed. */
function safeMessage(err: unknown): string {
  return err instanceof IdentityError ? err.message : 'unexpected error';
}

function defaultGithub(): GithubSignInApi {
  const provider = createGithubProvider();
  return {
    requestDeviceCode: (clientId) => requestDeviceCode(clientId),
    pollDeviceToken: (clientId, deviceCode, intervalMs) => pollDeviceToken(clientId, deviceCode, intervalMs),
    probe: (token) => provider.probe(token),
    refresh: (clientId, refreshToken) => refreshDeviceToken(clientId, refreshToken)
  };
}

export class IdentityService {
  private readonly vault: IdentityVault;
  private readonly clientId: () => Promise<string | null>;
  private readonly github: GithubSignInApi;
  private readonly now: () => number;
  private readonly patToken: (() => Promise<string | null>) | undefined;
  /** Used only while the vault is unavailable (sign-in lasts this run). */
  private memory: Saved | null = null;
  private patMemory: { sha: string; profile: Profile } | null = null;
  /** sha256 of a PAT GitHub answered 401 for; also tombstoned in PAT_PROFILE.
   *  Only status({ refresh: true }) or a different PAT probes again. */
  private patRejected: string | null = null;
  private patFailed: { sha: string; until: number; notice: string } | null = null;
  private patInflight: { sha: string; p: Promise<PatProbe> } | null = null;
  /** `notice` describes the PAT verification and goes once that resolves. */
  private patNotice = false;
  private pending: Pending | null = null;
  private notice: string | null = null;
  /** Bumped by sign-out, cancel, start and a completed sign-in: a save
   *  started under an older epoch is dropped. */
  private epoch = 0;
  /** Serialises vault writes so a sign-out can't interleave with a save. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private refreshing: Promise<string | null> | null = null;
  /** The last failed refresh; `definitive` when GitHub refused the refresh token. */
  private refreshFailed: { at: number; definitive: boolean } | null = null;
  private lastRefreshAt = -Infinity;
  private cancelRefresh: (() => void) | null = null;
  private readonly listeners = new Set<(c: IdentityChange) => void>();
  /** One recovery per rejected token; concurrent 401s share it. */
  private readonly recovering = new Map<string, Promise<RecoverResult>>();

  constructor(deps: IdentityServiceDeps) {
    this.vault = deps.vault;
    this.clientId = deps.clientId;
    this.github = deps.github ?? defaultGithub();
    this.now = deps.now ?? Date.now;
    this.patToken = deps.patToken;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      });
  }

  private persisted(): Promise<boolean> {
    return this.vault.isVaultAvailable();
  }

  private async currentPat(): Promise<string | null> {
    return (await this.patToken?.())?.trim() || null;
  }

  /** Runs inside `serial`; never probes. A rejected or backed-off PAT falls
   *  back to the device token, keeping the PAT notice. */
  private async loadStep(): Promise<Step> {
    const pat = await this.currentPat();
    if (!pat) {
      this.setPatNotice(null);
      return { saved: await this.loadDevice() };
    }
    const sha = sha256(pat);
    const cached = await this.readPatProfile(sha);
    if (cached === 'rejected' || this.patRejected === sha) {
      this.patRejected = sha;
      this.setPatNotice(PAT_REJECTED);
      return { saved: await this.loadDevice() };
    }
    if (cached) {
      this.setPatNotice(null);
      return { saved: { token: pat, profile: cached, source: 'pat', grant: {} } };
    }
    const f = this.patFailed;
    if (f?.sha === sha && this.now() < f.until) {
      this.setPatNotice(f.notice);
      return { saved: await this.loadDevice() };
    }
    return { verify: { pat, sha } };
  }

  private async loadDevice(): Promise<Saved | null> {
    if (!(await this.persisted())) return this.memory;
    const token = await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, TOKEN_KEY);
    if (!token) return null;
    const profile = parseProfile(await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, PROFILE_KEY));
    if (!profile || patFields(profile).source !== undefined) return null;
    return { token, profile, source: 'device', grant: parseGrant(await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, REFRESH_KEY)) };
  }

  private setPatNotice(notice: string | null): void {
    if (notice !== null) {
      this.notice = notice;
      this.patNotice = true;
    } else if (this.patNotice) {
      this.notice = null;
      this.patNotice = false;
    }
  }

  /** One probe per PAT until its result is recorded. */
  private probePat(pat: string, sha: string): Promise<PatProbe> {
    if (this.patInflight?.sha === sha) return this.patInflight.p;
    const p = this.github.probe(pat).then(
      (probe): PatProbe => ({ ok: true, probe }),
      (err: unknown): PatProbe => ({ ok: false, err })
    );
    this.patInflight = { sha, p };
    return p;
  }

  /** Runs inside `serial`; dropped if the vault PAT changed since the probe. */
  private async recordProbe(sha: string, p: Promise<PatProbe>, r: PatProbe, refresh: boolean): Promise<void> {
    if (this.patInflight?.p === p) this.patInflight = null;
    const pat = await this.currentPat();
    if (!pat || sha256(pat) !== sha) return;
    if (r.ok) {
      const profile: Profile = { identity: r.probe.identity, scopes: r.probe.scopes, sso: r.probe.sso, verifiedAt: this.now() };
      this.patRejected = null;
      this.patFailed = null;
      await this.writePatProfile(JSON.stringify({ ...profile, source: 'pat', tokenSha: sha }), { sha, profile });
      if (refresh) {
        this.notice = null;
        this.patNotice = false;
      }
      return;
    }
    if (r.err instanceof IdentityError && r.err.kind === 'unauthorized') {
      this.patRejected = sha;
      this.patFailed = null;
      await this.writePatProfile(JSON.stringify({ rejectedSha: sha }), null);
      return;
    }
    const cached = refresh ? await this.readPatProfile(sha) : null;
    if (cached && cached !== 'rejected') {
      this.notice = `Couldn't refresh your GitHub account (${safeMessage(r.err)}). Showing the last saved details.`;
      this.patNotice = false;
      return;
    }
    this.patFailed = { sha, until: this.now() + PAT_RETRY_MS, notice: `Couldn't verify the GitHub token in the Vault (${safeMessage(r.err)}).` };
  }

  private async writePatProfile(json: string, mem: { sha: string; profile: Profile } | null): Promise<void> {
    if (await this.persisted()) await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, PAT_PROFILE_KEY, json);
    else this.patMemory = mem;
  }

  private async readPatProfile(sha: string): Promise<Profile | 'rejected' | null> {
    if (!(await this.persisted())) return this.patMemory?.sha === sha ? this.patMemory.profile : null;
    const raw = await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, PAT_PROFILE_KEY);
    try {
      if (raw && (JSON.parse(raw) as { rejectedSha?: unknown }).rejectedSha === sha) return 'rejected';
    } catch {
      return null;
    }
    const p = parseProfile(raw);
    if (!p) return null;
    const f = patFields(p);
    return f.source === 'pat' && f.tokenSha === sha ? p : null;
  }

  onChange(fn: (c: IdentityChange) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(c: IdentityChange): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(c);
      } catch {
        // A listener's bug must not fail the sign-in or sign-out that fired it.
      }
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** False when superseded before the write began, or (with `sameToken`) when
   *  the stored token is no longer that one. A clear() requested during the
   *  write is queued behind it, so it still wins. */
  private save(s: Saved, epoch: number, sameToken = false): Promise<boolean> {
    return this.serial(async () => {
      if (epoch !== this.epoch) return false;
      if (sameToken && (await this.loadDevice())?.token !== s.token) return false;
      await this.write(s);
      return true;
    });
  }

  private async write(s: Saved): Promise<void> {
    if (!(await this.persisted())) {
      this.memory = s;
      return;
    }
    // TOKEN last: a TOKEN is never visible without its profile and grant.
    await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, PROFILE_KEY, JSON.stringify(s.profile));
    await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, REFRESH_KEY, Object.keys(s.grant).length ? JSON.stringify(s.grant) : '');
    await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, TOKEN_KEY, s.token);
  }

  /** Replaces the stored device pair only if `old` is still its token, so a refresh can't undo a newer sign-in or a sign-out. */
  private replace(old: string, next: Saved): Promise<boolean> {
    return this.serial(async () => {
      if ((await this.loadDevice())?.token !== old) return false;
      await this.write(next);
      return true;
    });
  }

  /** Read after every queued write and clear has settled. A PAT probe runs
   *  between two serial steps so it doesn't hold up queued writes. */
  private async settled(): Promise<Saved | null> {
    for (let i = 0; i < 3; i++) {
      const step = await this.serial(() => this.loadStep());
      if (!step.verify) return step.saved;
      const { pat, sha } = step.verify;
      const p = this.probePat(pat, sha);
      const r = await p;
      await this.serial(() => this.recordProbe(sha, p, r, false));
    }
    // The PAT kept changing under us.
    return this.serial(() => this.loadDevice());
  }

  private async clearNow(): Promise<void> {
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    this.memory = null;
    if (!(await this.persisted())) return;
    await this.vault.deleteAllForWorkspace(GITHUB_IDENTITY_SCOPE);
    if (this.patRejected) await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, PAT_PROFILE_KEY, JSON.stringify({ rejectedSha: this.patRejected }));
  }

  /** Probes even a rejected or backed-off PAT. */
  private async refreshPat(pat: string): Promise<Saved | null> {
    const sha = sha256(pat);
    const p = this.probePat(pat, sha);
    const r = await p;
    await this.serial(() => this.recordProbe(sha, p, r, true));
    return this.settled();
  }

  /** Clears only if `token` is still the stored one, so revoking an old token
   *  can't undo a newer sign-in. */
  private async revoke(token: string): Promise<boolean> {
    const done = await this.serial(async () => {
      if ((await this.loadDevice())?.token !== token) return false;
      await this.clearNow();
      return true;
    });
    if (done) this.emit({ cause: 'revoked', signedIn: false });
    return done;
  }

  private dueForRefresh(s: Saved): boolean {
    return s.grant.expiresAt !== undefined && this.now() >= s.grant.expiresAt - REFRESH_LEAD_MS;
  }

  private device(): Promise<Saved | null> {
    return this.serial(() => this.loadDevice());
  }

  /** App start: schedule the device token's refresh, if it expires. Runs even while a vault PAT wins, so the fallback stays fresh. */
  async startRefresh(): Promise<void> {
    const s = await this.device();
    if (s) this.scheduleRefresh(s);
  }

  private async refreshDeviceIfDue(): Promise<void> {
    const s = await this.device();
    if (s && this.dueForRefresh(s)) await this.refresh(s);
  }

  private scheduleRefresh(s: Saved): void {
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    if (s.grant.expiresAt === undefined) return;
    // Without a refresh token the timer fires at expiry, so the sign-out shows on time.
    const at = s.grant.refreshToken ? s.grant.expiresAt - REFRESH_LEAD_MS : s.grant.expiresAt;
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, at - this.now()));
    this.cancelRefresh = this.schedule(() => void this.refreshDeviceIfDue().catch(() => undefined), ms);
  }

  /** One device-token refresh at a time. Resolves to the token to use now, or null once an expired token is cleared.
   *  `force` (GitHub rejected the token) skips the minimum interval. */
  private refresh(s: Saved, force = false): Promise<string | null> {
    this.refreshing ??= this.refreshNow(s, force).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refreshNow(stale: Saved, force: boolean): Promise<string | null> {
    // A caller holding an older pair must not send a refresh token that was already spent.
    const s = await this.device();
    if (s?.token !== stale.token) return (await this.settled())?.token ?? null;
    const expired = s.grant.expiresAt !== undefined && this.now() >= s.grant.expiresAt;
    const giveUp = async (): Promise<string | null> => {
      if (!expired) return s.token;
      if (await this.revoke(s.token)) this.notice = EXPIRED_NOTICE;
      return (await this.settled())?.token ?? null;
    };
    const rt = s.grant.refreshToken;
    if (!rt || !this.github.refresh || (s.grant.refreshExpiresAt !== undefined && this.now() >= s.grant.refreshExpiresAt)) return giveUp();
    const failed = this.refreshFailed;
    if (failed && this.now() - failed.at < REFRESH_RETRY_MS) return failed.definitive ? giveUp() : s.token;
    if (!expired && !force && this.now() - this.lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return s.token;
    const clientId = await this.clientId();
    if (!clientId) return giveUp();
    let g: TokenGrant;
    try {
      g = await this.github.refresh(clientId, rt);
    } catch (err) {
      // An outage (or a captive portal's non-JSON page) is not a rejection: keep the sign-in.
      const transient = err instanceof DeviceFlowError && (err.kind === 'network' || err.kind === 'unexpected');
      this.refreshFailed = { at: this.now(), definitive: !transient };
      if (transient) return s.token;
      if (!expired) await this.dropRefreshToken(s);
      return giveUp();
    }
    const next: Saved = { token: g.token, profile: s.profile, source: 'device', grant: grantOf(g) };
    if (!(await this.replace(s.token, next))) return (await this.settled())?.token ?? null;
    this.refreshFailed = null;
    this.lastRefreshAt = this.now();
    this.scheduleRefresh(next);
    this.emit({ cause: 'token-refreshed', signedIn: true });
    return g.token;
  }

  /** GitHub refused the refresh token: forget it and sign out when the access token expires. */
  private async dropRefreshToken(s: Saved): Promise<void> {
    const grant: Grant = { ...s.grant };
    delete grant.refreshToken;
    delete grant.refreshExpiresAt;
    const next: Saved = { ...s, grant };
    if (await this.replace(s.token, next)) this.scheduleRefresh(next);
  }

  /** The stored pair, refreshed first when its access token is about to expire. */
  private async current(): Promise<Saved | null> {
    const s = await this.settled();
    if (!s || !this.dueForRefresh(s)) return s;
    await this.refresh(s);
    return this.settled();
  }

  private async toStatus(saved: Saved | null): Promise<AccountStatus> {
    const clientId = await this.clientId();
    const p = saved?.profile ?? null;
    const source = saved?.source ?? null;
    return {
      configured: clientId !== null,
      persisted: await this.persisted(),
      signedIn: saved !== null,
      identity: p
        ? {
            provider: 'github',
            login: p.identity.login,
            id: p.identity.id,
            name: p.identity.name,
            displayName: displayName(p.identity),
            avatarUrl: httpsUrlOrNull(p.identity.avatarUrl),
            teams: [...p.identity.teams]
          }
        : null,
      scopes: p ? [...p.scopes] : [],
      packagesAccess: p ? hasPackagesRead(p.scopes) : false,
      sso: p?.sso ? toAccountSso(p.sso, clientId) : null,
      notice: this.notice ?? (source === 'pat' && p?.scopes.length === 0 ? FINE_GRAINED_NOTICE : null),
      source
    };
  }

  /** `refresh` re-verifies with GitHub: a rejected token is cleared (with a
   *  notice); any other failure keeps the cached profile (with a notice). */
  async status(opts: { refresh?: boolean } = {}): Promise<AccountStatus> {
    const epoch = this.epoch;
    if (opts.refresh) {
      const pat = await this.currentPat();
      const viaPat = pat ? await this.refreshPat(pat) : null;
      if (viaPat?.source === 'pat') return this.toStatus(viaPat);
    }
    let saved = opts.refresh ? await this.current() : await this.settled();
    if (saved && opts.refresh) {
      try {
        const probe = await this.github.probe(saved.token);
        // parseScopes can't tell a missing X-OAuth-Scopes header from an empty
        // one, so an empty probe falls back to the saved scopes rather than
        // wiping them, matching finishSignIn's fallback to the token response.
        const scopes = probe.scopes.length > 0 ? probe.scopes : saved.profile.scopes;
        const next: Saved = {
          token: saved.token,
          profile: { identity: probe.identity, scopes, sso: probe.sso, verifiedAt: this.now() },
          source: 'device',
          grant: saved.grant
        };
        if (!(await this.save(next, epoch, true)) || epoch !== this.epoch) return this.toStatus(await this.settled());
        saved = next;
        if (!this.patNotice) this.notice = null;
      } catch (err) {
        if (err instanceof IdentityError && err.kind === 'unauthorized') {
          if (!(await this.revoke(saved.token))) return this.toStatus(await this.settled());
          saved = null;
          this.notice = REVOKED_NOTICE;
          this.patNotice = false;
        } else if (epoch !== this.epoch) {
          return this.toStatus(await this.settled());
        } else {
          this.notice = `Couldn't refresh your GitHub account (${safeMessage(err)}). Showing the last saved details.`;
        }
      }
    }
    return this.toStatus(saved);
  }

  async signInStart(): Promise<SignInStart> {
    const clientId = await this.clientId();
    if (!clientId) throw new IdentityNotConfiguredError();
    const code = await this.github.requestDeviceCode(clientId);
    this.epoch++;
    this.pending = { clientId, code, intervalMs: code.intervalMs, nextPollAt: this.now() + code.intervalMs, inflight: false, finishing: false };
    this.notice = null;
    return { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt, intervalMs: this.waitFor(this.pending, code.intervalMs) };
  }

  private waitFor(p: Pending, ms: number): number {
    return Math.max(0, Math.min(ms, MAX_WAIT_MS, p.code.expiresAt - this.now()));
  }

  /** One step of the flow. Never polls GitHub faster than its interval, and
   *  at most one request is in flight. */
  async signInPoll(): Promise<SignInPoll> {
    const p = this.pending;
    if (!p) return { state: 'error', message: NO_FLOW };
    if (p.inflight || p.finishing) return { state: 'pending', intervalMs: this.waitFor(p, p.intervalMs) };
    const now = this.now();
    if (now >= p.code.expiresAt) {
      this.pending = null;
      return { state: 'error', message: 'The sign-in code expired. Start again.' };
    }
    if (now < p.nextPollAt) return { state: 'pending', intervalMs: this.waitFor(p, p.nextPollAt - now) };

    p.inflight = true;
    let r: PollResult;
    try {
      r = await this.github.pollDeviceToken(p.clientId, p.code.deviceCode, p.intervalMs);
    } catch (err) {
      if (this.pending !== p) return { state: 'error', message: CANCELLED };
      if (err instanceof DeviceFlowError && err.kind === 'network') {
        if (err.throttled) p.intervalMs += SLOW_DOWN_STEP_MS;
        p.nextPollAt = this.now() + p.intervalMs;
        return { state: 'pending', intervalMs: this.waitFor(p, p.intervalMs) };
      }
      this.pending = null;
      return { state: 'error', message: err instanceof DeviceFlowError ? err.message : 'GitHub sign-in failed unexpectedly.' };
    } finally {
      p.inflight = false;
    }
    if (this.pending !== p) return { state: 'error', message: CANCELLED };
    if (r.status === 'pending') {
      p.intervalMs = r.intervalMs;
      p.nextPollAt = this.now() + r.intervalMs;
      return { state: 'pending', intervalMs: this.waitFor(p, r.intervalMs) };
    }

    p.finishing = true;
    try {
      return await this.finishSignIn(r);
    } finally {
      if (this.pending === p) this.pending = null;
    }
  }

  private async finishSignIn(grant: TokenGrant): Promise<SignInPoll> {
    const { token, scopes: tokenScopes } = grant;
    const epoch = this.epoch;
    let probe: GithubProbe;
    try {
      probe = await this.github.probe(token);
    } catch (err) {
      if (epoch !== this.epoch) return { state: 'error', message: CANCELLED };
      return { state: 'error', message: `Signed in, but reading your GitHub profile failed (${safeMessage(err)}). Try again.` };
    }
    if (epoch !== this.epoch) return { state: 'error', message: CANCELLED };
    const scopes = probe.scopes.length > 0 ? probe.scopes : tokenScopes;
    const saved: Saved = { token, profile: { identity: probe.identity, scopes, sso: probe.sso, verifiedAt: this.now() }, source: 'device', grant: grantOf(grant) };
    const saveEpoch = ++this.epoch;
    if (!(await this.save(saved, saveEpoch))) return { state: 'error', message: CANCELLED };
    if (saveEpoch !== this.epoch) {
      const now = await this.settled();
      if (now?.token !== token) return { state: 'error', message: CANCELLED };
    }
    this.refreshFailed = null;
    this.scheduleRefresh(saved);
    this.emit({ cause: 'sign-in', signedIn: true });
    return { state: 'done', status: await this.toStatus(saved) };
  }

  signInCancel(): void {
    this.pending = null;
    this.epoch++;
  }

  /** Forget the token on this computer. Revoking it on GitHub needs the app's
   *  client secret, so the UI links to GitHub's Authorized OAuth Apps page. */
  async signOut(): Promise<void> {
    this.pending = null;
    this.notice = null;
    this.patNotice = false;
    this.epoch++;
    const had = await this.serial(async () => {
      // A vault PAT is managed in the Vault, so sign-out leaves it (and the device token) be.
      if ((await this.loadStep()).saved?.source === 'pat') return false;
      const was = (await this.loadDevice()) !== null;
      await this.clearNow();
      return was;
    });
    if (had) this.emit({ cause: 'sign-out', signedIn: false });
  }

  /** For RemoteClient: the signed-in token, attached to fleet-host requests. Main process only. */
  async bearerToken(): Promise<string | null> {
    return (await this.current())?.token ?? null;
  }

  /** For RemoteClient after a host 401 on `sentToken`. */
  recover(sentToken: string): Promise<RecoverResult> {
    let p = this.recovering.get(sentToken);
    if (!p) {
      p = this.recoverOnce(sentToken).finally(() => this.recovering.delete(sentToken));
      this.recovering.set(sentToken, p);
    }
    return p;
  }

  private async recoverOnce(sent: string): Promise<RecoverResult> {
    const saved = await this.settled();
    if (!saved) return 'expired';
    if (saved.token !== sent) return 'retry';
    if (saved.source === 'pat') return this.recoverPat(sent);
    if (saved.grant.refreshToken && this.dueForRefresh(saved)) {
      const t = await this.refresh(saved);
      if (!t) return 'expired';
      // Same token: the refresh failed transiently and the sign-in stays.
      return t !== sent ? 'retry' : 'host-refused';
    }
    // Only a token GitHub rejects is renewed; otherwise a host that refuses valid tokens would rotate it on every 401.
    try {
      await this.github.probe(sent);
      return 'host-refused';
    } catch (err) {
      if (!(err instanceof IdentityError) || err.kind !== 'unauthorized') return 'host-refused';
    }
    if (saved.grant.refreshToken) {
      const t = await this.refresh(saved, true);
      if (t && t !== sent) return 'retry';
    }
    if (await this.revoke(sent)) this.notice = REVOKED_NOTICE;
    return 'expired';
  }

  /** A PAT GitHub rejects is tombstoned, never removed from the Vault; the device token, if any, takes over. */
  private async recoverPat(pat: string): Promise<RecoverResult> {
    const sha = sha256(pat);
    const p = this.probePat(pat, sha);
    const r = await p;
    if (!r.ok && !(r.err instanceof IdentityError && r.err.kind === 'unauthorized')) {
      // Unreachable GitHub is not a rejection: no backoff, the PAT stays in use.
      if (this.patInflight?.p === p) this.patInflight = null;
      return 'host-refused';
    }
    await this.serial(() => this.recordProbe(sha, p, r, false));
    if (r.ok) return 'host-refused';
    const next = await this.settled();
    if (this.patRejected === sha) this.emit({ cause: 'revoked', signedIn: next !== null });
    return next && next.token !== pat ? 'retry' : 'expired';
  }

  /** The signed-in login; remote.ts keys its /whoami throttle by it. */
  async currentLogin(): Promise<string | null> {
    return (await this.settled())?.profile.identity.login ?? null;
  }

  /** For loadoutSources.setGithubTokenProvider: the token, only if it can pull
   *  from GHCR. Main process only. */
  async packagesToken(): Promise<string | null> {
    const s = await this.current();
    return s && hasPackagesRead(s.profile.scopes) ? s.token : null;
  }
}
