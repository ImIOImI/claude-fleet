// Desktop GitHub sign-in: device-flow state, the token (vault scope
// identity:github, never sent to the renderer) and the cached profile.
// A vault GITHUB_TOKEN (PAT), when set, wins over the device-flow token.
// ipc.ts injects the real vault + client-id resolver; tests inject fakes.

import { createHash } from 'node:crypto';
import { GITHUB_IDENTITY_SCOPE } from '../vaultScopes.js';
import { DeviceFlowError, SLOW_DOWN_STEP_MS, pollDeviceToken, requestDeviceCode, type DeviceCode, type PollResult } from './deviceFlow.js';
import { createGithubProvider, type GithubProbe } from './githubProvider.js';
import { hasPackagesRead, type SsoHint } from './githubHeaders.js';
import { IdentityError, displayName, type UserIdentity } from './types.js';
import { CLIENT_ID_MISSING } from './clientId.js';
import type { AccountSso, AccountStatus, SignInPoll, SignInStart } from '../../preload/identityTypes.js';

export const TOKEN_KEY = 'TOKEN';
export const PROFILE_KEY = 'PROFILE';
/** The verified profile of the vault PAT, keyed by its sha256; never paired with TOKEN. */
export const PAT_PROFILE_KEY = 'PAT_PROFILE';

const REVOKED_NOTICE = 'GitHub no longer accepts the saved sign-in (revoked or expired). Sign in again.';
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
}

export interface IdentityServiceDeps {
  vault: IdentityVault;
  clientId(): Promise<string | null>;
  github?: GithubSignInApi;
  now?: () => number;
  /** The vault GITHUB_TOKEN; absent on fleet-host. */
  patToken?: () => Promise<string | null>;
}

interface Profile {
  identity: UserIdentity;
  scopes: string[];
  sso: SsoHint | null;
  verifiedAt: number;
}
type Source = 'device' | 'pat';
interface Saved {
  token: string;
  profile: Profile;
  source: Source;
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
    pollDeviceToken,
    probe: (token) => provider.probe(token)
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

  constructor(deps: IdentityServiceDeps) {
    this.vault = deps.vault;
    this.clientId = deps.clientId;
    this.github = deps.github ?? defaultGithub();
    this.now = deps.now ?? Date.now;
    this.patToken = deps.patToken;
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
      return { saved: { token: pat, profile: cached, source: 'pat' } };
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
    return profile && patFields(profile).source === undefined ? { token, profile, source: 'device' } : null;
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
  private async recordProbe(sha: string, r: PatProbe, refresh: boolean): Promise<void> {
    if (this.patInflight?.sha === sha) this.patInflight = null;
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
      if (!(await this.persisted())) {
        this.memory = s;
        return true;
      }
      // PROFILE first: a TOKEN is never visible without its profile.
      await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, PROFILE_KEY, JSON.stringify(s.profile));
      await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, TOKEN_KEY, s.token);
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
      const r = await this.probePat(pat, sha);
      await this.serial(() => this.recordProbe(sha, r, false));
    }
    // The PAT kept changing under us.
    return this.serial(() => this.loadDevice());
  }

  private async clearNow(): Promise<void> {
    this.memory = null;
    if (!(await this.persisted())) return;
    await this.vault.deleteAllForWorkspace(GITHUB_IDENTITY_SCOPE);
    if (this.patRejected) await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, PAT_PROFILE_KEY, JSON.stringify({ rejectedSha: this.patRejected }));
  }

  /** A vault PAT is managed in the Vault, so sign-out leaves it (and the device token) be. */
  private clearUnlessPat(): Promise<void> {
    return this.serial(async () => {
      if ((await this.loadStep()).saved?.source === 'pat') return;
      await this.clearNow();
    });
  }

  /** Probes even a rejected or backed-off PAT. */
  private async refreshPat(pat: string): Promise<Saved | null> {
    const sha = sha256(pat);
    const r = await this.probePat(pat, sha);
    await this.serial(() => this.recordProbe(sha, r, true));
    return this.settled();
  }

  /** Clears only if `token` is still the stored one, so revoking an old token
   *  can't undo a newer sign-in. */
  private revoke(token: string): Promise<boolean> {
    return this.serial(async () => {
      if ((await this.loadDevice())?.token !== token) return false;
      await this.clearNow();
      return true;
    });
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
    const pat = opts.refresh ? await this.currentPat() : null;
    let saved = pat ? await this.refreshPat(pat) : await this.settled();
    if (saved?.source === 'pat') return this.toStatus(saved);
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
          source: 'device'
        };
        if (!(await this.save(next, epoch, true)) || epoch !== this.epoch) return this.toStatus(await this.settled());
        saved = next;
        if (!this.patNotice) this.notice = null;
      } catch (err) {
        if (err instanceof IdentityError && err.kind === 'unauthorized') {
          if (!(await this.revoke(saved.token))) return this.toStatus(await this.settled());
          saved = null;
          this.notice = REVOKED_NOTICE;
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
      return await this.finishSignIn(r.token, r.scopes);
    } finally {
      if (this.pending === p) this.pending = null;
    }
  }

  private async finishSignIn(token: string, tokenScopes: string[]): Promise<SignInPoll> {
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
    const saved: Saved = { token, profile: { identity: probe.identity, scopes, sso: probe.sso, verifiedAt: this.now() }, source: 'device' };
    const saveEpoch = ++this.epoch;
    if (!(await this.save(saved, saveEpoch))) return { state: 'error', message: CANCELLED };
    if (saveEpoch !== this.epoch) {
      const now = await this.settled();
      if (now?.token !== token) return { state: 'error', message: CANCELLED };
    }
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
    await this.clearUnlessPat();
  }

  /** For RemoteClient: the signed-in token, attached to fleet-host requests. Main process only. */
  async bearerToken(): Promise<string | null> {
    return (await this.settled())?.token ?? null;
  }

  /** The signed-in login; remote.ts keys its /whoami throttle by it. */
  async currentLogin(): Promise<string | null> {
    return (await this.settled())?.profile.identity.login ?? null;
  }

  /** For loadoutSources.setGithubTokenProvider: the token, only if it can pull
   *  from GHCR. Main process only. */
  async packagesToken(): Promise<string | null> {
    const s = await this.settled();
    return s && hasPackagesRead(s.profile.scopes) ? s.token : null;
  }
}
