// Desktop GitHub sign-in: device-flow state, the token (vault scope
// identity:github, never sent to the renderer) and the cached profile.
// ipc.ts injects the real vault + client-id resolver; tests inject fakes.

import { GITHUB_IDENTITY_SCOPE } from '../vaultScopes.js';
import { DeviceFlowError, pollDeviceToken, requestDeviceCode, type DeviceCode, type PollResult } from './deviceFlow.js';
import { createGithubProvider, type GithubProbe } from './githubProvider.js';
import { hasPackagesRead, type SsoHint } from './githubHeaders.js';
import { IdentityError, displayName, type UserIdentity } from './types.js';
import { CLIENT_ID_MISSING } from './clientId.js';
import type { AccountSso, AccountStatus, SignInPoll, SignInStart } from '../../preload/identityTypes.js';

export const TOKEN_KEY = 'TOKEN';
export const PROFILE_KEY = 'PROFILE';

const REVOKED_NOTICE = 'GitHub no longer accepts the saved sign-in (revoked or expired). Sign in again.';
const NO_FLOW = 'No sign-in in progress.';
const CANCELLED = 'Sign-in was cancelled.';

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
}

interface Profile {
  identity: UserIdentity;
  scopes: string[];
  sso: SsoHint | null;
  verifiedAt: number;
}
interface Saved {
  token: string;
  profile: Profile;
}
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
    typeof p.verifiedAt === 'number'
  );
}

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
  /** Used only while the vault is unavailable (sign-in lasts this run). */
  private memory: Saved | null = null;
  private pending: Pending | null = null;
  private notice: string | null = null;
  /** Bumped by sign-out, cancel, start, revocation and a completed sign-in: a
   *  save started under an older epoch is dropped. */
  private epoch = 0;
  /** Serialises vault writes so a sign-out can't interleave with a save. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: IdentityServiceDeps) {
    this.vault = deps.vault;
    this.clientId = deps.clientId;
    this.github = deps.github ?? defaultGithub();
    this.now = deps.now ?? Date.now;
  }

  private persisted(): Promise<boolean> {
    return this.vault.isVaultAvailable();
  }

  private async load(): Promise<Saved | null> {
    if (!(await this.persisted())) return this.memory;
    const token = await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, TOKEN_KEY);
    if (!token) return null;
    const raw = await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, PROFILE_KEY);
    let profile: unknown = null;
    try {
      profile = raw ? JSON.parse(raw) : null;
    } catch {
      profile = null;
    }
    return isProfile(profile) ? { token, profile } : null;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** False when the epoch moved before or during the write (anything written is wiped). */
  private save(s: Saved, epoch: number): Promise<boolean> {
    return this.serial(async () => {
      if (epoch !== this.epoch) return false;
      if (!(await this.persisted())) {
        if (epoch !== this.epoch) return false;
        this.memory = s;
        return true;
      }
      // PROFILE first: a TOKEN is never visible without its profile.
      await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, PROFILE_KEY, JSON.stringify(s.profile));
      if (epoch === this.epoch) await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, TOKEN_KEY, s.token);
      if (epoch === this.epoch) return true;
      await this.clearNow();
      return false;
    });
  }

  private async clearNow(): Promise<void> {
    this.memory = null;
    if (await this.persisted()) await this.vault.deleteAllForWorkspace(GITHUB_IDENTITY_SCOPE);
  }

  private clear(): Promise<void> {
    return this.serial(() => this.clearNow());
  }

  private async toStatus(saved: Saved | null): Promise<AccountStatus> {
    const clientId = await this.clientId();
    const p = saved?.profile ?? null;
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
            avatarUrl: p.identity.avatarUrl,
            teams: [...p.identity.teams]
          }
        : null,
      scopes: p ? [...p.scopes] : [],
      packagesAccess: p ? hasPackagesRead(p.scopes) : false,
      sso: p?.sso ? toAccountSso(p.sso, clientId) : null,
      notice: this.notice
    };
  }

  /** `refresh` re-verifies with GitHub: a rejected token is cleared (with a
   *  notice); any other failure keeps the cached profile (with a notice). */
  async status(opts: { refresh?: boolean } = {}): Promise<AccountStatus> {
    const epoch = this.epoch;
    let saved = await this.load();
    if (saved && opts.refresh) {
      try {
        const probe = await this.github.probe(saved.token);
        const next: Saved = {
          token: saved.token,
          profile: { identity: probe.identity, scopes: probe.scopes, sso: probe.sso, verifiedAt: this.now() }
        };
        if (!(await this.save(next, epoch))) return this.toStatus(await this.load());
        saved = next;
        this.notice = null;
      } catch (err) {
        if (epoch !== this.epoch) return this.toStatus(await this.load());
        if (err instanceof IdentityError && err.kind === 'unauthorized') {
          this.epoch++;
          await this.clear();
          saved = null;
          this.notice = REVOKED_NOTICE;
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
    return { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt, intervalMs: code.intervalMs };
  }

  /** One step of the flow. Never polls GitHub faster than its interval, and
   *  at most one request is in flight. */
  async signInPoll(): Promise<SignInPoll> {
    const p = this.pending;
    if (!p) return { state: 'error', message: NO_FLOW };
    if (p.inflight || p.finishing) return { state: 'pending', intervalMs: p.intervalMs };
    const now = this.now();
    if (now >= p.code.expiresAt) {
      this.pending = null;
      return { state: 'error', message: 'The sign-in code expired. Start again.' };
    }
    if (now < p.nextPollAt) return { state: 'pending', intervalMs: p.nextPollAt - now };

    p.inflight = true;
    let r: PollResult;
    try {
      r = await this.github.pollDeviceToken(p.clientId, p.code.deviceCode, p.intervalMs);
    } catch (err) {
      if (this.pending !== p) return { state: 'error', message: CANCELLED };
      if (err instanceof DeviceFlowError && err.kind === 'network') {
        p.nextPollAt = this.now() + p.intervalMs;
        return { state: 'pending', intervalMs: p.intervalMs };
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
      return { state: 'pending', intervalMs: r.intervalMs };
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
    const saved: Saved = { token, profile: { identity: probe.identity, scopes, sso: probe.sso, verifiedAt: this.now() } };
    const saveEpoch = ++this.epoch;
    if (!(await this.save(saved, saveEpoch))) return { state: 'error', message: CANCELLED };
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
    this.epoch++;
    await this.clear();
  }

  /** For loadoutSources.setGithubTokenProvider: the token, only if it can pull
   *  from GHCR. Main process only. */
  async packagesToken(): Promise<string | null> {
    const s = await this.load();
    return s && hasPackagesRead(s.profile.scopes) ? s.token : null;
  }
}
