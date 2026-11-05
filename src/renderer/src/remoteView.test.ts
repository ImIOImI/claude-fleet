import { describe, expect, it } from 'vitest';
import type { RemoteProbeErr, RemoteProbeOk } from '../../preload/remoteTypes';
import { readFileSync } from 'node:fs';
import { applyProbe, canStartSessions, CHECKING_STATUS, joinableSessions, paneRules, remoteChip, canType, ipcErrorText, probeErrorText, remoteFormView, tierTitle, unreachableBanner, type RemoteFormState } from './remoteView';

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
    expect(paneRules(undefined)).toEqual({ remote: false, readOnly: false, canNew: true, defaultTab: true });
  });

  it('read watches only and opens no default tab', () => {
    expect(paneRules('read')).toEqual({ remote: true, readOnly: true, canNew: false, defaultTab: false });
  });

  it('steer types but cannot start sessions', () => {
    expect(paneRules('steer')).toEqual({ remote: true, readOnly: false, canNew: false, defaultTab: false });
  });

  it('session is unrestricted', () => {
    expect(paneRules('session')).toEqual({ remote: true, readOnly: false, canNew: true, defaultTab: true });
  });

  it('an unknown tier is treated as read until the host answers', () => {
    expect(paneRules(null)).toEqual(paneRules('read'));
  });
});

describe('joinableSessions', () => {
  it('lists live host sessions that are not already tabs', () => {
    const live = [
      { id: 'a', alive: true },
      { id: 'b', alive: false },
      { id: 'c', alive: true }
    ];
    expect(joinableSessions(live, ['c'])).toEqual([{ id: 'a', alive: true }]);
    expect(joinableSessions([], [])).toEqual([]);
  });
});
