import { describe, expect, it } from 'vitest';
import type { RemoteProbeErr, RemoteProbeOk } from '../../preload/remoteTypes';
import { readFileSync } from 'node:fs';
import { AUTO_REATTACH_GAP_MS, reattachAfterAuthEnd, applyProbe, canEndSession, drainBanner, drainEnded, resumesAfterDrain, sessionEndKind, ipcFailure, raceTimeout, canStartSessions, defaultTabOnTierChange, forgetText, mineIds, CHECKING_STATUS, joinableSessions, paneRules, remoteChip, remotePane, unreachableRemoteNames, canType, ipcErrorText, probeErrorText, remoteFormView, tierTitle, unreachableBanner, type RemoteFormState } from './remoteView';

const OK: RemoteProbeOk = {
  ok: true,
  url: 'https://h',
  workspace: { id: 'W', name: 'review-bot', description: null, color: null },
  user: { login: 'alice', name: null, avatarUrl: null },
  tier: 'read',
  warning: null,
  existing: false,
  existingUrl: null
};
const err = (kind: RemoteProbeErr['kind'], extra: Partial<RemoteProbeErr> = {}): RemoteProbeErr => ({ ok: false, kind, message: `${kind} msg`, ...extra });
const EMPTY: RemoteFormState = { ok: null, err: null };

describe('remote tier rules', () => {
  it('only steer and session type; only session starts sessions', () => {
    expect([canType('read'), canType('steer'), canType('session'), canType(null)]).toEqual([false, true, true, false]);
    expect([canStartSessions('read'), canStartSessions('steer'), canStartSessions('session'), canStartSessions(undefined)]).toEqual([false, false, true, false]);
  });

  it('titles every tier', () => {
    expect(tierTitle('read')).toMatch(/watch/);
    expect(tierTitle('steer')).toMatch(/type/);
    expect(tierTitle('session')).toMatch(/start/);
    expect(tierTitle(null)).toMatch(/unknown/);
  });
});

describe('unreachableBanner', () => {
  it('names one or several hosts', () => {
    expect(unreachableBanner([])).toBeNull();
    expect(unreachableBanner(['review-bot'])).toBe("review-bot unreachable: its sessions and automations are hidden until it's back");
    expect(unreachableBanner(['a', 'b'])).toMatch(/^a, b unreachable: their .* they're back$/);
  });
});

describe('probeErrorText', () => {
  it('adds the network hint for unreachable hosts and passes other messages through', () => {
    expect(probeErrorText(err('unreachable'))).toMatch(/VPN/);
    expect(probeErrorText(err('not-signed-in'))).toMatch(/Sign in/);
    expect(probeErrorText({ ok: false, kind: 'forbidden', message: 'ask admins' })).toBe('ask admins');
  });
});

describe('applyProbe', () => {
  it('an ok probe replaces everything', () => {
    expect(applyProbe({ ok: null, err: err('forbidden') }, OK)).toEqual({ ok: OK, err: null });
  });

  it('declined and moved keep the last good probe on screen', () => {
    expect(applyProbe({ ok: OK, err: null }, err('declined'))).toEqual({ ok: OK, err: err('declined') });
    expect(applyProbe({ ok: OK, err: null }, err('moved'))).toEqual({ ok: OK, err: err('moved') });
  });

  it('a real error clears the stale probe', () => {
    expect(applyProbe({ ok: OK, err: null }, err('unreachable'))).toEqual({ ok: null, err: err('unreachable') });
  });
});

describe('remoteFormView', () => {
  it('starts on Check host with no notice', () => {
    expect(remoteFormView(EMPTY)).toEqual({ primary: 'check', primaryLabel: 'Check host', notice: null });
  });

  it('a fresh ok probe offers Add', () => {
    expect(remoteFormView({ ok: OK, err: null })).toEqual({ primary: 'add', primaryLabel: 'Add workspace', notice: null });
  });

  it('an existing bookmark at the same URL is a neutral note', () => {
    const v = remoteFormView({ ok: { ...OK, existing: true }, err: null });
    expect(v.primary).toBe('add');
    expect(v.notice).toEqual({ tone: 'neutral', text: expect.stringMatching(/Already added/) });
  });

  it('an existing bookmark at another URL offers Move and names the old URL', () => {
    const v = remoteFormView({ ok: { ...OK, existing: true, existingUrl: 'https://old' }, err: null });
    expect(v).toMatchObject({ primary: 'move', primaryLabel: 'Move here', notice: { tone: 'neutral', text: expect.stringContaining('https://old') } });
  });

  it('a moved reply offers Move even without a prior probe', () => {
    expect(remoteFormView({ ok: null, err: err('moved') })).toMatchObject({ primary: 'move', notice: { tone: 'neutral', text: 'moved msg' } });
  });

  it('declined is neutral and keeps the step', () => {
    expect(remoteFormView({ ok: null, err: err('declined') })).toEqual({ primary: 'check', primaryLabel: 'Check host', notice: { tone: 'neutral', text: 'declined msg' } });
    expect(remoteFormView({ ok: OK, err: err('declined') }).primary).toBe('add');
    expect(remoteFormView({ ok: { ...OK, existingUrl: 'https://old' }, err: err('declined') }).primary).toBe('move');
  });

  it('errors are error-toned, with the SSO link when given', () => {
    expect(remoteFormView({ ok: null, err: err('unreachable') }).notice).toEqual({ tone: 'error', text: expect.stringMatching(/VPN/) });
    expect(remoteFormView({ ok: null, err: err('sso', { ssoUrl: 'https://github.com/x' }) }).notice).toEqual({ tone: 'error', text: 'sso msg', linkUrl: 'https://github.com/x' });
    expect(remoteFormView({ ok: null, err: err('sso', { ssoUrl: null }) }).notice).toEqual({ tone: 'error', text: 'sso msg' });
  });
});

describe('ipcErrorText', () => {
  it("strips Electron's invoke prefix", () => {
    expect(ipcErrorText(new Error("Error invoking remote method 'remote:rename': Error: A name is required"))).toBe('A name is required');
    expect(ipcErrorText('plain')).toBe('plain');
  });
});

describe('remoteChip', () => {
  const remote = (state: 'running' | 'unreachable', status?: string) => ({ kind: 'remote' as const, state, status });

  it('is null for local and container chips', () => {
    expect(remoteChip({ kind: 'container', state: 'unreachable' })).toBeNull();
    expect(remoteChip({ kind: 'local', state: 'running' })).toBeNull();
  });

  it('a reachable host is live with no sub-line override', () => {
    expect(remoteChip(remote('running'))).toEqual({ phase: 'live', sub: null });
  });

  it('an unprobed bookmark is checking, not an error', () => {
    expect(remoteChip(remote('unreachable', CHECKING_STATUS))).toEqual({ phase: 'checking', sub: 'checking host…' });
  });

  it('a probed, failing host is unreachable', () => {
    expect(remoteChip(remote('unreachable', 'connect ECONNREFUSED'))).toEqual({ phase: 'unreachable', sub: 'host unreachable' });
    expect(remoteChip(remote('unreachable'))).toEqual({ phase: 'unreachable', sub: 'host unreachable' });
  });

  it("matches main's checking status", () => {
    expect(readFileSync('src/main/remote.ts', 'utf8')).toContain(`CHECKING_STATUS = '${CHECKING_STATUS}'`);
  });
});

describe('paneRules', () => {
  it('local and container panes are unrestricted', () => {
    expect(paneRules(undefined)).toEqual({ remote: false, readOnly: false, canNew: true, defaultTab: true, restarting: false });
  });

  it('read watches only and opens no default tab', () => {
    expect(paneRules('read')).toEqual({ remote: true, readOnly: true, canNew: false, defaultTab: false, restarting: false });
  });

  it('steer types but cannot start sessions', () => {
    expect(paneRules('steer')).toEqual({ remote: true, readOnly: false, canNew: false, defaultTab: false, restarting: false });
  });

  it('session is unrestricted', () => {
    expect(paneRules('session')).toEqual({ remote: true, readOnly: false, canNew: true, defaultTab: true, restarting: false });
  });

  it('an unknown tier is treated as read until the host answers', () => {
    expect(paneRules(null)).toEqual(paneRules('read'));
  });
});

describe('joinableSessions', () => {
  it('lists live host sessions that are not already tabs', () => {
    const live = [
      { id: 'a', alive: true, mine: false },
      { id: 'b', alive: false, mine: false },
      { id: 'c', alive: true, mine: true }
    ];
    expect(joinableSessions(live, ['c'])).toEqual([{ id: 'a', alive: true, mine: false }]);
    expect(joinableSessions([], [])).toEqual([]);
  });
});

describe('unreachableRemoteNames', () => {
  it('names probed, failing remotes only', () => {
    const ws = [
      { kind: 'remote', state: 'unreachable', name: 'down', status: 'refused' },
      { kind: 'remote', state: 'unreachable', name: 'new', status: CHECKING_STATUS },
      { kind: 'remote', state: 'running', name: 'up' },
      { kind: 'container', state: 'unreachable', name: 'docker' }
    ];
    expect(unreachableRemoteNames(ws)).toEqual(['down']);
  });
});

describe('remotePane', () => {
  const url = 'https://h';
  it('is null unless the selected remote is not running', () => {
    expect(remotePane({ kind: 'container', state: 'unreachable', name: 'c' })).toBeNull();
    expect(remotePane({ kind: 'remote', state: 'running', name: 'r', remote: { url } })).toBeNull();
  });

  it('a checking host is neutral', () => {
    expect(remotePane({ kind: 'remote', state: 'unreachable', name: 'r', status: CHECKING_STATUS, remote: { url } })).toEqual({
      tone: 'neutral',
      title: 'Checking host…',
      body: 'Contacting r (https://h).'
    });
  });

  it('an unreachable host is an error naming it', () => {
    expect(remotePane({ kind: 'remote', state: 'unreachable', name: 'r', remote: { url } })).toEqual({
      tone: 'error',
      title: 'Host unreachable',
      body: "r (https://h) isn't answering. Its sessions reappear when it's back."
    });
  });
});

describe('End session gating', () => {
  it('needs the session tier and a host-reported mine', () => {
    const mine = new Set(['s1']);
    expect(canEndSession('session', mine, 's1')).toBe(true);
    expect(canEndSession('session', mine, 's2')).toBe(false);
    expect(canEndSession('steer', mine, 's1')).toBe(false);
    expect(canEndSession('read', mine, 's1')).toBe(false);
    expect(canEndSession(null, mine, 's1')).toBe(false);
    expect(canEndSession(undefined, mine, 's1')).toBe(false);
  });

  it('mineIds keeps live sessions the host says are mine', () => {
    expect([...mineIds([{ id: 'a', alive: true, mine: true }, { id: 'b', alive: true, mine: false }, { id: 'c', alive: false, mine: true }])]).toEqual(['a']);
  });
});

describe('defaultTabOnTierChange', () => {
  it('opens the default tab once the host reports session for an empty, loaded pane', () => {
    expect(defaultTabOnTierChange(null, 'session', true, 0)).toBe(true);
  });

  it('does nothing otherwise', () => {
    expect(defaultTabOnTierChange(null, 'read', true, 0)).toBe(false);
    expect(defaultTabOnTierChange(null, 'steer', true, 0)).toBe(false);
    expect(defaultTabOnTierChange(null, 'session', false, 0)).toBe(false);
    expect(defaultTabOnTierChange(null, 'session', true, 1)).toBe(false);
    expect(defaultTabOnTierChange('session', 'session', true, 0)).toBe(false);
    expect(defaultTabOnTierChange('read', 'session', true, 0)).toBe(false);
    expect(defaultTabOnTierChange(undefined, undefined, true, 0)).toBe(false);
  });
});

describe('forgetText', () => {
  it('names the workspace and says the host is untouched', () => {
    expect(forgetText('review-bot')).toBe("Forget review-bot? Removes the bookmark and this computer's tab list. The host and its sessions are untouched.");
  });
});

describe('ipcFailure', () => {
  it('turns an IPC throw into an error notice and clears the last probe', () => {
    const err = ipcFailure(new Error("Error invoking remote method 'remote:probe': Error: boom"));
    expect(err).toEqual({ ok: false, kind: 'protocol', message: 'boom' });
    const next = applyProbe({ ok: OK, err: null }, err);
    expect(next.ok).toBeNull();
    expect(remoteFormView(next).notice).toEqual({ tone: 'error', text: 'boom' });
  });
});

describe('raceTimeout', () => {
  it('resolves the value when it lands in time', async () => {
    expect(await raceTimeout(Promise.resolve(7), 50)).toBe(7);
  });

  it('resolves null after the timeout, and null on rejection', async () => {
    const started = Date.now();
    expect(await raceTimeout(new Promise(() => undefined), 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(await raceTimeout(Promise.reject(new Error('x')), 30)).toBeNull();
  });
});

const draining = { phase: 'draining' as const, softAt: 1_000, hardAt: 2_000, instance: 'i' };
const serving = { phase: 'serving' as const, softAt: null, hardAt: null, instance: 'j' };
const unknown = { phase: 'unknown' as const, softAt: null, hardAt: null, instance: null };

describe('drain view', () => {
  it('chip', () => {
    const w = { kind: 'remote', state: 'running' };
    expect(remoteChip(w, draining)).toEqual({ phase: 'restarting', sub: 'restarting · input paused' });
    expect(remoteChip(w, unknown)).toEqual({ phase: 'restarting', sub: 'waiting for the workspace pod' });
    expect(remoteChip(w, serving)).toEqual({ phase: 'live', sub: null });
    expect(remoteChip(w, null)).toEqual({ phase: 'live', sub: null });
    expect(remoteChip({ kind: 'remote', state: 'unreachable' }, draining)).toEqual({ phase: 'unreachable', sub: 'host unreachable' });
    expect(remoteChip({ kind: 'container', state: 'running' }, draining)).toBeNull();
  });

  it('pane rules: read-only and no new tabs while restarting', () => {
    // Closing the last tab mid-restart must not auto-create one whose CREATE the host refuses.
    expect(paneRules('session', draining)).toEqual({ remote: true, readOnly: true, canNew: false, defaultTab: false, restarting: true });
    expect(paneRules('session', unknown).defaultTab).toBe(false);
    expect(paneRules('steer', unknown)).toEqual({ remote: true, readOnly: true, canNew: false, defaultTab: false, restarting: true });
    expect(paneRules('session', serving)).toEqual({ remote: true, readOnly: false, canNew: true, defaultTab: true, restarting: false });
    expect(paneRules(undefined, draining)).toEqual({ remote: false, readOnly: false, canNew: true, defaultTab: true, restarting: false });
  });

  it('banner text by phase and deadline', () => {
    const fmt = (ms: number) => `T${ms}`;
    expect(drainBanner(serving, 0, fmt)).toBeNull();
    expect(drainBanner(null, 0, fmt)).toBeNull();
    expect(drainBanner(unknown, 0, fmt)).toBe('Waiting for the workspace pod…');
    expect(drainBanner(draining, 500, fmt)).toBe('The host is restarting. Running turns finish first (until T1000); idle sessions close now. Typing is paused. Tabs resume on their own when the host is back.');
    expect(drainBanner({ ...draining, softAt: null }, 500, fmt)).toBe('The host is restarting. Running turns finish first; idle sessions close now. Typing is paused. Tabs resume on their own when the host is back.');
    expect(drainBanner(draining, 1_000, fmt)).toBe('The host is restarting. Stopping turns that are still running.');
  });

  it('a drain ends when a restarting host serves again', () => {
    expect(drainEnded(draining, serving)).toBe(true);
    expect(drainEnded(unknown, serving)).toBe(true);
    expect(drainEnded(serving, serving)).toBe(false);
    expect(drainEnded(null, serving)).toBe(false);
    expect(drainEnded(draining, unknown)).toBe(false);
    expect(drainEnded(draining, null)).toBe(false);
  });
});

describe('tab resume after a drain', () => {
  it('a session that ends while restarting waits; otherwise it ended', () => {
    expect(sessionEndKind(true)).toBe('restarting');
    expect(sessionEndKind(false)).toBe('natural');
  });

  it('re-attaches only a tab that ended during the restart, once the token is set', () => {
    expect(resumesAfterDrain(1, true)).toBe(true);
    expect(resumesAfterDrain(0, true)).toBe(true);
    expect(resumesAfterDrain(1, false)).toBe(false);
    expect(resumesAfterDrain(null, true)).toBe(false);
    expect(resumesAfterDrain(undefined, true)).toBe(false);
  });
});

describe('reattachAfterAuthEnd', () => {
  const base = { remote: true, reason: 'unauthorized' as const, signedIn: true, lastAutoAt: null, now: 1_000_000 };
  it('re-attaches a remote tab the host closed with 4401 while signed in', () => {
    expect(reattachAfterAuthEnd(base)).toBe(true);
  });
  it('not for a local tab, another end reason, or when signed out', () => {
    expect(reattachAfterAuthEnd({ ...base, remote: false })).toBe(false);
    expect(reattachAfterAuthEnd({ ...base, reason: undefined })).toBe(false);
    expect(reattachAfterAuthEnd({ ...base, signedIn: false })).toBe(false);
  });
  it('at most once per AUTO_REATTACH_GAP_MS, so a host that keeps closing it cannot loop', () => {
    expect(reattachAfterAuthEnd({ ...base, lastAutoAt: base.now - AUTO_REATTACH_GAP_MS + 1 })).toBe(false);
    expect(reattachAfterAuthEnd({ ...base, lastAutoAt: base.now - AUTO_REATTACH_GAP_MS })).toBe(true);
  });
});
