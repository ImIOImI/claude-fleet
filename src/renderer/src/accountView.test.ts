import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccountStatus, SignInPoll } from '../../preload/identityTypes';
import { SIGN_IN_EXPIRED, accountAvatar, clientIdDraftError, clientIdField, accountControls, countdown, driveSignIn, loadAccount, packagesNote, parseIdentityError, ssoPrompt, type SignInRun } from './accountView';

describe('parseIdentityError', () => {
  it('unwraps the IPC prefix and recognises not-configured', () => {
    // Electron's real wire format is `error.toString()`: 'Name: message', so the
    // thrown class name (IdentityNotConfiguredError, DeviceFlowError, plain Error) rides along.
    expect(
      parseIdentityError(
        new Error("Error invoking remote method 'identity:signInStart': IdentityNotConfiguredError: not-configured: GitHub sign-in isn't configured.")
      )
    ).toEqual({ kind: 'not-configured', message: "GitHub sign-in isn't configured." });
    expect(
      parseIdentityError(new Error("Error invoking remote method 'identity:signInPoll': DeviceFlowError: boom"))
    ).toEqual({ kind: 'other', message: 'boom' });
    expect(parseIdentityError(new Error("Error invoking remote method 'identity:signInStart': Error: boom"))).toEqual({ kind: 'other', message: 'boom' });
    expect(parseIdentityError('plain')).toEqual({ kind: 'other', message: 'plain' });
  });
});

describe('ssoPrompt', () => {
  it('names the org and links its authorise URL', () => {
    expect(ssoPrompt({ url: 'https://github.com/orgs/acme/sso', org: 'acme', orgCount: 0, appSettingsUrl: null })).toEqual({
      text: 'Authorise claude-fleet for acme. Organisations that use SAML single sign-on need this one-time GitHub step before claude-fleet can see your teams there.',
      url: 'https://github.com/orgs/acme/sso'
    });
  });
  it('counts partial-results orgs and links the app settings page', () => {
    expect(
      ssoPrompt({ url: null, org: null, orgCount: 2, appSettingsUrl: 'https://github.com/settings/connections/applications/Iv1.x' })
    ).toEqual({
      text: "2 organisations use SAML single sign-on and haven't authorised claude-fleet yet, so their teams are hidden. Authorising is a one-time GitHub step.",
      url: 'https://github.com/settings/connections/applications/Iv1.x'
    });
    expect(ssoPrompt({ url: null, org: null, orgCount: 1, appSettingsUrl: null })?.text).toMatch(/^1 organisation uses/);
  });
  it('is null without a hint', () => {
    expect(ssoPrompt(null)).toBeNull();
    expect(ssoPrompt({ url: null, org: null, orgCount: 0, appSettingsUrl: null })).toBeNull();
  });
});

describe('countdown', () => {
  it('formats m:ss and floors at zero', () => {
    expect(countdown(900_000, 0)).toBe('15:00');
    expect(countdown(65_500, 0)).toBe('1:06');
    expect(countdown(0, 5000)).toBe('0:00');
  });
});

describe('packagesNote', () => {
  it('explains how sign-in relates to private ghcr.io sources', () => {
    expect(packagesNote(false, false)).toBeNull();
    expect(packagesNote(true, true)).toBe('Private ghcr.io loadout sources use this sign-in when they have no token of their own.');
    expect(packagesNote(true, false)).toBe(
      'This sign-in lacks the read:packages scope, so private ghcr.io loadout sources still need their own token. Sign out and sign in again to grant it.'
    );
  });
});

describe('accountControls', () => {
  it('disables sign-out and sign-in while a sign-in is pending; cancel stays available', () => {
    expect(accountControls({ busy: false, signingIn: true })).toEqual({ signInDisabled: true, signOutDisabled: true, cancelDisabled: false });
    expect(accountControls({ busy: true, signingIn: true })).toEqual({ signInDisabled: true, signOutDisabled: true, cancelDisabled: false });
  });
  it('disables both while another action is busy', () => {
    expect(accountControls({ busy: true, signingIn: false })).toEqual({ signInDisabled: true, signOutDisabled: true, cancelDisabled: false });
  });
  it('enables both when idle', () => {
    expect(accountControls({ busy: false, signingIn: false })).toEqual({ signInDisabled: false, signOutDisabled: false, cancelDisabled: false });
  });
});

const STATUS = { signedIn: true, identity: { login: 'octo' } } as unknown as AccountStatus;
const FLOW = { intervalMs: 5000, expiresAt: 1e12 };

/** A fake poll API + manual clock: records every wait and the max polls in flight. */
function rig(results: Array<SignInPoll | Error | ((run: SignInRun) => SignInPoll)>) {
  const waits: number[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let polls = 0;
  let clock = 0;
  const run: SignInRun = { cancelled: false };
  const api = {
    now: () => clock,
    poll: async (): Promise<SignInPoll> => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      polls++;
      await Promise.resolve();
      await Promise.resolve();
      inflight--;
      const r = results.shift();
      if (r === undefined) throw new Error('unexpected extra poll');
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(run) : r;
    },
    wait: async (ms: number): Promise<void> => {
      waits.push(ms);
      clock += ms;
    }
  };
  return { api, run, waits, stats: () => ({ polls, maxInflight }) };
}

describe('driveSignIn', () => {
  it('awaits each poll and waits the interval the service returns before the next', async () => {
    const r = rig([
      { state: 'pending', intervalMs: 5000 },
      { state: 'pending', intervalMs: 10_000 },
      { state: 'pending', intervalMs: 2500 },
      { state: 'done', status: STATUS }
    ]);
    expect(await driveSignIn(FLOW, r.api, r.run)).toEqual({ kind: 'done', status: STATUS });
    expect(r.waits).toEqual([5000, 5000, 10_000, 2500]);
    expect(r.stats()).toEqual({ polls: 4, maxInflight: 1 });
  });

  it('reports a service error', async () => {
    const r = rig([{ state: 'error', message: 'The sign-in code expired. Start again.' }]);
    expect(await driveSignIn(FLOW, r.api, r.run)).toEqual({ kind: 'error', message: 'The sign-in code expired. Start again.' });
  });

  it('reports a rejected poll with the IPC prefix stripped', async () => {
    const r = rig([new Error("Error invoking remote method 'identity:signInPoll': Error: boom")]);
    expect(await driveSignIn(FLOW, r.api, r.run)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('shows the signed-in state when a poll finishes after Cancel', async () => {
    const r = rig([
      (run) => {
        run.cancelled = true;
        return { state: 'done', status: STATUS };
      }
    ]);
    expect(await driveSignIn(FLOW, r.api, r.run)).toEqual({ kind: 'done', status: STATUS });
  });

  it('stops quietly after Cancel when the in-flight poll is pending or cancelled', async () => {
    const pending = rig([
      (run) => {
        run.cancelled = true;
        return { state: 'pending', intervalMs: 5000 };
      }
    ]);
    expect(await driveSignIn(FLOW, pending.api, pending.run)).toEqual({ kind: 'cancelled' });
    expect(pending.stats().polls).toBe(1);

    const err = rig([
      (run) => {
        run.cancelled = true;
        return { state: 'error', message: 'Sign-in was cancelled.' };
      }
    ]);
    expect(await driveSignIn(FLOW, err.api, err.run)).toEqual({ kind: 'cancelled' });

    const run: SignInRun = { cancelled: false };
    const rejecting = {
      now: () => 0,
      wait: async () => undefined,
      poll: async (): Promise<SignInPoll> => {
        run.cancelled = true;
        throw new Error('x');
      }
    };
    expect(await driveSignIn(FLOW, rejecting, run)).toEqual({ kind: 'cancelled' });
  });

  it('never polls when cancelled during the wait', async () => {
    const r = rig([]);
    const api = {
      ...r.api,
      wait: async () => {
        r.run.cancelled = true;
      }
    };
    expect(await driveSignIn(FLOW, api, r.run)).toEqual({ kind: 'cancelled' });
    expect(r.stats().polls).toBe(0);
  });
});

describe('driveSignIn expiry', () => {
  it('caps the last wait at the expiry and stops without polling', async () => {
    const r = rig([
      { state: 'pending', intervalMs: 5000 },
      { state: 'pending', intervalMs: 5000 }
    ]);
    expect(await driveSignIn({ intervalMs: 5000, expiresAt: 12_000 }, r.api, r.run)).toEqual({ kind: 'error', message: SIGN_IN_EXPIRED });
    expect(r.waits).toEqual([5000, 5000, 2000]);
    expect(r.stats().polls).toBe(2);
  });

  it('stops before the first poll when the code expires first', async () => {
    const r = rig([]);
    expect(await driveSignIn({ intervalMs: 5000, expiresAt: 3000 }, r.api, r.run)).toEqual({ kind: 'error', message: SIGN_IN_EXPIRED });
    expect(r.waits).toEqual([3000]);
    expect(r.stats().polls).toBe(0);
  });
});

describe('loadAccount', () => {
  const CACHED = { signedIn: true, notice: null } as unknown as AccountStatus;
  const FRESH = { signedIn: false, notice: 'revoked' } as unknown as AccountStatus;

  it('shows the cached status first, then the refreshed one', async () => {
    const calls: unknown[] = [];
    const shown: AccountStatus[] = [];
    const err = await loadAccount(
      async (o) => {
        calls.push(o);
        return o?.refresh ? FRESH : CACHED;
      },
      (st) => shown.push(st)
    );
    expect(err).toBeNull();
    expect(calls).toEqual([undefined, { refresh: true }]);
    expect(shown).toEqual([CACHED, FRESH]);
  });

  it('returns the error and skips the refresh when the cached read fails', async () => {
    const calls: unknown[] = [];
    const shown: AccountStatus[] = [];
    const err = await loadAccount(
      async (o) => {
        calls.push(o);
        throw new Error("Error invoking remote method 'identity:status': Error: vault locked");
      },
      (st) => shown.push(st)
    );
    expect(err).toBe('vault locked');
    expect(calls).toEqual([undefined]);
    expect(shown).toEqual([]);
  });

  it('keeps the cached status when the refresh fails', async () => {
    const shown: AccountStatus[] = [];
    const err = await loadAccount(
      async (o) => {
        if (o?.refresh) throw new Error('offline');
        return CACHED;
      },
      (st) => shown.push(st)
    );
    expect(err).toBe('offline');
    expect(shown).toEqual([CACHED]);
  });
});

describe('accountAvatar', () => {
  it('loads only a GitHub avatar URL', () => {
    expect(accountAvatar({ avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' })).toBe('https://avatars.githubusercontent.com/u/7?v=4');
    expect(accountAvatar({ avatarUrl: 'https://evil.io/a.png' })).toBeNull();
    expect(accountAvatar({ avatarUrl: 'http://avatars.githubusercontent.com/u/7' })).toBeNull();
    expect(accountAvatar({ avatarUrl: null })).toBeNull();
  });
});

describe('clientIdField', () => {
  it('is read-only with the override badge when the env var supplies the id', () => {
    expect(clientIdField({ value: 'Iv1.env', source: 'env' })).toEqual({ readOnly: true, override: true, initial: 'Iv1.env', placeholder: '', note: null });
  });

  it('edits the saved value', () => {
    expect(clientIdField({ value: 'Iv1.cfg', source: 'config' })).toEqual({ readOnly: false, override: false, initial: 'Iv1.cfg', placeholder: '', note: null });
  });

  it('shows the built-in id as a placeholder only', () => {
    expect(clientIdField({ value: 'Iv1.bi', source: 'builtin' })).toEqual({ readOnly: false, override: false, initial: '', placeholder: 'Iv1.bi', note: null });
  });

  it('asks for the id when nothing is set, without naming env vars or config.json', () => {
    const f = clientIdField({ value: null, source: 'none' });
    expect(f).toEqual({ readOnly: false, override: false, initial: '', placeholder: '', note: "Enter your organization's GitHub OAuth client ID below." });
    expect(f.note).not.toMatch(/CLAUDE_FLEET|config\.json|identity\.github|environment|json/i);
  });
});

describe('clientIdDraftError', () => {
  it('accepts an empty or valid draft and explains an invalid one', () => {
    expect(clientIdDraftError('')).toBeNull();
    expect(clientIdDraftError('  Iv1.0123456789abcdef ')).toBeNull();
    expect(clientIdDraftError('Ov23liAbc')).toBeNull();
    expect(clientIdDraftError('has space')).toMatch(/letters, digits/);
    expect(clientIdDraftError('x'.repeat(101))).toMatch(/100/);
  });
});

describe('Settings → Account source text', () => {
  const src = readFileSync('src/renderer/src/components/AccountSettings.tsx', 'utf8');

  it('never mentions config.json or the config key', () => {
    expect(src).not.toMatch(/config\.json|identity\.github/);
  });

  it('names the env var only inside the override badge', () => {
    const outside = src.replace(/<p className="setting-desc client-id-override">[\s\S]*?<\/p>/, '').replace(/^import .*$/gm, '');
    expect(outside).toMatch(/<input/);
    expect(src).toMatch(/client-id-override/);
    expect(outside).not.toMatch(/CLAUDE_FLEET_|GITHUB_CLIENT_ID_ENV|environment variable/);
    const badge = src.slice(src.indexOf('client-id-override'), src.indexOf('</p>', src.indexOf('client-id-override')));
    expect(badge).toMatch(/Set by <code>\{GITHUB_CLIENT_ID_ENV\}<\/code>; the environment variable takes precedence\./);
  });
});
