import { describe, expect, it } from 'vitest';
import { EMPTY_REMOTE_AUTH, remoteAttachTag, type RemoteAuthState } from '../../preload/remoteAuth';
import { attachErrorBlock, blockFor, remoteCard, remoteEndKind, shouldReattach, shownRemoteBlock, signedOutBanner, SIGNED_OUT_BANNER, skipAttach } from './signedOutView';

const W = '01JC0000000000000000000000';
const out = (reason: 'not-signed-in' | 'expired'): RemoteAuthState => ({ ...EMPTY_REMOTE_AUTH, signedOut: { reason, since: 1 } });
const conn = (kind: 'unreachable' | 'forbidden' | 'host-refused'): RemoteAuthState => ({ ...EMPTY_REMOTE_AUTH, conns: { [W]: { kind, since: 1 } } });

describe('signed-out banner', () => {
  it('shows only while signed out with at least one remote bookmark', () => {
    expect(signedOutBanner(out('expired'), 1)).toBe(SIGNED_OUT_BANNER);
    expect(SIGNED_OUT_BANNER).toBe('Signed out of GitHub — remote workspaces are paused. Your sessions are still running on the host.');
    expect(signedOutBanner(out('expired'), 0)).toBeNull();
    expect(signedOutBanner(EMPTY_REMOTE_AUTH, 3)).toBeNull();
    expect(signedOutBanner(null, 3)).toBeNull();
  });
});

describe('blockFor (D170)', () => {
  it('app-wide sign-out wins over the bookmark; ok is no block', () => {
    expect(blockFor({ ...conn('forbidden'), signedOut: { reason: 'expired', since: 1 } }, W)).toBe('expired');
    expect(blockFor(conn('unreachable'), W)).toBe('unreachable');
    expect(blockFor({ ...EMPTY_REMOTE_AUTH, conns: { [W]: { kind: 'ok', since: 1 } } }, W)).toBeNull();
    expect(blockFor(EMPTY_REMOTE_AUTH, W)).toBeNull();
  });
});

describe('remoteCard copy', () => {
  it('matches the approved table', () => {
    expect(remoteCard('not-signed-in', 'rb')).toEqual({ tone: 'wait', title: 'Not signed in', body: 'Sign in to reconnect. Your sessions are still running on the host.', action: 'sign-in', linkUrl: null });
    expect(remoteCard('expired', 'rb').title).toBe('Sign-in expired');
    expect(remoteCard('host-refused', 'rb')).toMatchObject({ tone: 'warn', title: "rb didn't accept your sign-in; retrying", action: 'retry' });
    expect(remoteCard('unreachable', 'rb')).toMatchObject({ tone: 'warn', title: "Can't reach rb; retrying", body: 'Check your network, or that your VPN (Twingate) is connected. This tab reconnects by itself.', action: 'retry' });
    expect(remoteCard('forbidden', 'rb')).toEqual({ tone: 'danger', title: "You don't have access to rb", body: "Ask the host's admins to add you to a team with access.", action: null, linkUrl: null });
    expect(remoteCard('forbidden', 'rb', 'https://github.com/orgs/acme/sso').linkUrl).toBe('https://github.com/orgs/acme/sso');
    expect(remoteCard('forbidden', 'rb', 'https://github.com/orgs/acme/sso').body).toBe(
      'Authorise claude-fleet for your organisation on GitHub (a one-time step); this tab reconnects by itself.'
    );
    expect(remoteCard('expired', 'rb').tone).toBe('wait');
    expect(remoteCard('host-refused', 'rb').body).toBe('Your GitHub sign-in is valid. This tab reconnects by itself.');
  });
});

describe('attach errors (D175)', () => {
  it('reads the tag through the Electron prefix; untagged is null', () => {
    const e = new Error(`Error invoking remote method 'pty:attach': RemoteError: ${remoteAttachTag('expired')}Your GitHub sign-in expired`);
    expect(attachErrorBlock(e)).toBe('expired');
    expect(attachErrorBlock(new Error("Error invoking remote method 'pty:attach': Error: host attach failed: x"))).toBeNull();
  });
});

describe('tab end and card (D170, D176)', () => {
  it('sign-in blocks beat restarting; restarting beats other blocks', () => {
    expect(remoteEndKind(true, 'expired')).toEqual({ kind: 'remote', block: 'expired' });
    expect(remoteEndKind(true, 'unreachable')).toEqual({ kind: 'restarting' });
    expect(remoteEndKind(false, 'forbidden')).toEqual({ kind: 'remote', block: 'forbidden' });
    expect(remoteEndKind(false, null)).toEqual({ kind: 'natural' });
    expect(remoteEndKind(true, null)).toEqual({ kind: 'restarting' });
    expect(remoteEndKind(false, 'not-signed-in')).toEqual({ kind: 'remote', block: 'not-signed-in' });
  });

  it('a 4401/4403 end with no block yet is natural but marked, so a later block can upgrade it', () => {
    expect(remoteEndKind(false, null, 'unauthorized')).toEqual({ kind: 'natural', authEnd: true });
    expect(remoteEndKind(false, null, 'forbidden')).toEqual({ kind: 'natural', authEnd: true });
    expect(remoteEndKind(true, null, 'unauthorized')).toEqual({ kind: 'restarting' });
    expect(remoteEndKind(false, 'host-refused', 'unauthorized')).toEqual({ kind: 'remote', block: 'host-refused' });
  });

  it('only an auth-closed natural end upgrades to a later sign-in or refusal block, never to unreachable', () => {
    expect(shownRemoteBlock(true, { kind: 'natural', authEnd: true }, 'host-refused')).toBe('host-refused');
    expect(shownRemoteBlock(true, { kind: 'natural', authEnd: true }, 'forbidden')).toBe('forbidden');
    expect(shownRemoteBlock(true, { kind: 'natural', authEnd: true }, 'unreachable')).toBeNull();
    expect(shownRemoteBlock(false, { kind: 'natural', authEnd: true }, 'expired')).toBeNull();
    expect(shownRemoteBlock(true, { kind: 'natural' }, 'host-refused')).toBeNull();
    expect(shownRemoteBlock(true, { kind: 'natural' }, 'expired')).toBeNull();
    expect(shownRemoteBlock(true, { kind: 'remote', block: 'unreachable' }, null)).toBe('unreachable');
    expect(shownRemoteBlock(true, { kind: 'remote', block: 'expired' }, 'host-refused')).toBe('host-refused');
  });

  it('only remote tabs with a sign-in block skip the attach', () => {
    expect(skipAttach(true, 'not-signed-in')).toBe(true);
    expect(skipAttach(true, 'unreachable')).toBe(false);
    expect(skipAttach(false, 'expired')).toBe(false);
  });
});

describe('shouldReattach (D174)', () => {
  it('on an epoch move or a cleared block, only for a tab on a remote card', () => {
    expect(shouldReattach('expired', { epoch: 0, block: 'expired' }, { epoch: 1, block: null })).toBe(true);
    expect(shouldReattach('unreachable', { epoch: 2, block: 'unreachable' }, { epoch: 2, block: null })).toBe(true);
    expect(shouldReattach('unreachable', { epoch: 2, block: 'unreachable' }, { epoch: 2, block: 'unreachable' })).toBe(false);
    expect(shouldReattach(null, { epoch: 0, block: null }, { epoch: 1, block: null })).toBe(false);
    expect(shouldReattach('expired', { epoch: 0, block: 'expired' }, { epoch: 1, block: 'not-signed-in' })).toBe(false);
    expect(shouldReattach('unreachable', { epoch: 2, block: 'unreachable' }, { epoch: 2, block: 'forbidden' })).toBe(false);
    expect(shouldReattach('host-refused', { epoch: 0, block: 'unreachable' }, { epoch: 1, block: 'unreachable' })).toBe(true);
    expect(shouldReattach('host-refused', { epoch: 1, block: null }, { epoch: 1, block: null })).toBe(false);
  });
});
