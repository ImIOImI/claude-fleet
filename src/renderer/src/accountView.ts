// Pure copy, control state and the poll loop for Settings → Account.
import type { AccountSso, AccountStatus, SignInPoll, SignInStart } from '../../preload/identityTypes';
import { githubAvatarUrl } from '../../preload/sessionOwner';

const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

export type IdentityUiError = { kind: 'not-configured' | 'other'; message: string };

export function parseIdentityError(err: unknown): IdentityUiError {
  const raw = String((err as Error | undefined)?.message ?? err).replace(IPC_PREFIX, '');
  const m = /^not-configured: ([\s\S]*)$/.exec(raw);
  return m ? { kind: 'not-configured', message: m[1] } : { kind: 'other', message: raw };
}

export interface SsoPrompt {
  text: string;
  url: string | null;
}

export function ssoPrompt(sso: AccountSso | null): SsoPrompt | null {
  if (!sso) return null;
  if (sso.url) {
    return {
      text: `Authorise claude-fleet for ${sso.org ?? 'your organisation'}. Organisations that use SAML single sign-on need this one-time GitHub step before claude-fleet can see your teams there.`,
      url: sso.url
    };
  }
  if (sso.orgCount > 0) {
    const n = sso.orgCount === 1 ? '1 organisation uses' : `${sso.orgCount} organisations use`;
    return {
      text: `${n} SAML single sign-on and haven't authorised claude-fleet yet, so their teams are hidden. Authorising is a one-time GitHub step.`,
      url: sso.appSettingsUrl
    };
  }
  return null;
}

export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function packagesNote(signedIn: boolean, packagesAccess: boolean): string | null {
  if (!signedIn) return null;
  return packagesAccess
    ? 'Private ghcr.io loadout sources use this sign-in when they have no token of their own.'
    : 'This sign-in lacks the read:packages scope, so private ghcr.io loadout sources still need their own token. Sign out and sign in again to grant it.';
}

/** `signingIn` covers a cancelled flow whose last poll hasn't settled yet. */
export function accountControls(s: { busy: boolean; signingIn: boolean }): {
  signInDisabled: boolean;
  signOutDisabled: boolean;
  cancelDisabled: boolean;
} {
  const blocked = s.busy || s.signingIn;
  return { signInDisabled: blocked, signOutDisabled: blocked, cancelDisabled: false };
}

export interface SignInRun {
  cancelled: boolean;
}

export const SIGN_IN_EXPIRED = 'The sign-in code expired. Start again.';

export type SignInOutcome = { kind: 'done'; status: AccountStatus } | { kind: 'error'; message: string } | { kind: 'cancelled' };

/** Polls strictly one at a time and stops at the code's expiry. A `done` is
 *  honoured even after Cancel: the sign-in had already been saved. */
export async function driveSignIn(
  flow: Pick<SignInStart, 'intervalMs' | 'expiresAt'>,
  api: { poll(): Promise<SignInPoll>; wait(ms: number): Promise<void>; now(): number },
  run: SignInRun
): Promise<SignInOutcome> {
  let delay = flow.intervalMs;
  for (;;) {
    await api.wait(Math.max(0, Math.min(delay, flow.expiresAt - api.now())));
    if (run.cancelled) return { kind: 'cancelled' };
    if (api.now() >= flow.expiresAt) return { kind: 'error', message: SIGN_IN_EXPIRED };
    let r: SignInPoll;
    try {
      r = await api.poll();
    } catch (err) {
      return run.cancelled ? { kind: 'cancelled' } : { kind: 'error', message: parseIdentityError(err).message };
    }
    if (r.state === 'done') return { kind: 'done', status: r.status };
    if (run.cancelled) return { kind: 'cancelled' };
    if (r.state === 'error') return { kind: 'error', message: r.message };
    delay = r.intervalMs;
  }
}

/** Shows the local cached status, then the GitHub-refreshed one. Returns the
 *  error message, if any. */
export async function loadAccount(
  status: (opts?: { refresh?: boolean }) => Promise<AccountStatus>,
  show: (s: AccountStatus) => void
): Promise<string | null> {
  try {
    show(await status());
  } catch (err) {
    return parseIdentityError(err).message;
  }
  try {
    show(await status({ refresh: true }));
    return null;
  } catch (err) {
    return parseIdentityError(err).message;
  }
}

/** The signed-in avatar passes the same allowlist as owner avatars (D120). */
export function accountAvatar(identity: { avatarUrl: string | null }): string | null {
  return githubAvatarUrl(identity.avatarUrl);
}
