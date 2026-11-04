import { describe, expect, it } from 'vitest';
import type { AccountStatus, SignInPoll } from '../../preload/identityTypes';
import { accountControls, countdown, driveSignIn, packagesNote, parseIdentityError, ssoPrompt, type SignInRun } from './accountView';

describe('parseIdentityError', () => {
  it('unwraps the IPC prefix and recognises not-configured', () => {
    expect(
      parseIdentityError(new Error("Error invoking remote method 'identity:signInStart': Error: not-configured: GitHub sign-in isn't configured."))
    ).toEqual({ kind: 'not-configured', message: "GitHub sign-in isn't configured." });
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

/** A fake poll API + manual clock: records every wait and the max polls in flight. */
function rig(results: Array<SignInPoll | Error | ((run: SignInRun) => SignInPoll)>) {
  const waits: number[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let polls = 0;
  const run: SignInRun = { cancelled: false };
  const api = {
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
    expect(await driveSignIn(5000, r.api, r.run)).toEqual({ kind: 'done', status: STATUS });
    expect(r.waits).toEqual([5000, 5000, 10_000, 2500]);
    expect(r.stats()).toEqual({ polls: 4, maxInflight: 1 });
  });

  it('reports a service error', async () => {
    const r = rig([{ state: 'error', message: 'The sign-in code expired. Start again.' }]);
    expect(await driveSignIn(5000, r.api, r.run)).toEqual({ kind: 'error', message: 'The sign-in code expired. Start again.' });
  });

  it('reports a rejected poll with the IPC prefix stripped', async () => {
    const r = rig([new Error("Error invoking remote method 'identity:signInPoll': Error: boom")]);
    expect(await driveSignIn(5000, r.api, r.run)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('shows the signed-in state when a poll finishes after Cancel', async () => {
    const r = rig([
      (run) => {
        run.cancelled = true;
        return { state: 'done', status: STATUS };
      }
    ]);
    expect(await driveSignIn(5000, r.api, r.run)).toEqual({ kind: 'done', status: STATUS });
  });

  it('stops quietly after Cancel when the in-flight poll is pending or cancelled', async () => {
    const pending = rig([
      (run) => {
        run.cancelled = true;
        return { state: 'pending', intervalMs: 5000 };
      }
    ]);
    expect(await driveSignIn(5000, pending.api, pending.run)).toEqual({ kind: 'cancelled' });
    expect(pending.stats().polls).toBe(1);

    const err = rig([
      (run) => {
        run.cancelled = true;
        return { state: 'error', message: 'Sign-in was cancelled.' };
      }
    ]);
    expect(await driveSignIn(5000, err.api, err.run)).toEqual({ kind: 'cancelled' });

    const run: SignInRun = { cancelled: false };
    const rejecting = {
      wait: async () => undefined,
      poll: async (): Promise<SignInPoll> => {
        run.cancelled = true;
        throw new Error('x');
      }
    };
    expect(await driveSignIn(5000, rejecting, run)).toEqual({ kind: 'cancelled' });
  });

  it('never polls when cancelled during the wait', async () => {
    const r = rig([]);
    const api = {
      ...r.api,
      wait: async () => {
        r.run.cancelled = true;
      }
    };
    expect(await driveSignIn(5000, api, r.run)).toEqual({ kind: 'cancelled' });
    expect(r.stats().polls).toBe(0);
  });
});
