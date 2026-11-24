import { describe, expect, it, vi } from 'vitest';
import { parseRemoteAttachTag, remoteAttachTag, type RemoteAuthState } from '../preload/remoteAuth.js';
import { RemoteError } from './remoteClient.js';
import { connKindOf, createRemoteAuthMonitor, SIGNED_OUT_NOTICE, type RemoteAuthMonitorDeps } from './remoteAuth.js';

const W = '01JC0000000000000000000000';

function rig(o: { signedIn?: boolean; bookmarks?: number } = {}) {
  const sent: RemoteAuthState[] = [];
  const deps: RemoteAuthMonitorDeps = {
    signedIn: async () => o.signedIn ?? true,
    bookmarkCount: async () => o.bookmarks ?? 1,
    send: (s) => void sent.push(s),
    notify: vi.fn(),
    reconnect: vi.fn(),
    ssoUrl: async () => 'https://github.com/orgs/acme/sso',
    log: vi.fn(),
    now: () => 1000
  };
  return { m: createRemoteAuthMonitor(deps), deps, sent, last: () => sent.at(-1)! };
}

describe('attach tag (D175)', () => {
  it('round-trips every block kind and ignores untagged text', () => {
    for (const k of ['not-signed-in', 'expired', 'host-refused', 'unreachable', 'forbidden'] as const) {
      expect(parseRemoteAttachTag(`${remoteAttachTag(k)}whatever`)).toBe(k);
    }
    expect(parseRemoteAttachTag('host attach failed: nope')).toBeNull();
    expect(parseRemoteAttachTag('x remote-expired: y')).toBeNull();
  });
});

describe('connKindOf', () => {
  it('maps RemoteError kinds; anything else is not a connection state', () => {
    expect(connKindOf(null)).toBe('ok');
    expect(connKindOf(new RemoteError('not-signed-in', 'x'))).toBe('not-signed-in');
    expect(connKindOf(new RemoteError('unauthorized', 'x', 401, undefined, 'expired'))).toBe('expired');
    expect(connKindOf(new RemoteError('unauthorized', 'x', 401))).toBe('host-refused');
    expect(connKindOf(new RemoteError('forbidden', 'x', 403))).toBe('forbidden');
    expect(connKindOf(new RemoteError('standby', 'x', 503))).toBe('unreachable');
    expect(connKindOf(new RemoteError('unreachable', 'x'))).toBe('unreachable');
    expect(connKindOf(new RemoteError('protocol', 'x'))).toBeNull();
    expect(connKindOf(new Error('x'))).toBeNull();
  });
});

describe('RemoteAuthMonitor', () => {
  it('starts signed out without notifying', async () => {
    const r = rig({ signedIn: false });
    await r.m.start();
    expect(r.last().signedOut).toEqual({ reason: 'not-signed-in', since: 1000 });
    expect(r.deps.notify).not.toHaveBeenCalled();
  });

  it('notifies once per involuntary sign-out, only with a bookmark (D172)', async () => {
    const r = rig();
    await r.m.start();
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(r.deps.notify).toHaveBeenCalledExactlyOnceWith(SIGNED_OUT_NOTICE);
    expect(r.last().signedOut?.reason).toBe('expired');
    const none = rig({ bookmarks: 0 });
    await none.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(none.deps.notify).not.toHaveBeenCalled();
  });

  it('starting signed out then a revoke does not notify; a later sign-in then revoke does', async () => {
    const r = rig({ signedIn: false });
    await r.m.start();
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(r.deps.notify).not.toHaveBeenCalled();
    await r.m.identityChanged({ cause: 'sign-in', signedIn: true });
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(r.deps.notify).toHaveBeenCalledOnce();
  });

  it('a token refresh bumps the epoch without touching other conns', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('forbidden', 'x', 403));
    await r.m.identityChanged({ cause: 'token-refreshed', signedIn: true });
    expect(r.last().epoch).toBe(1);
    expect(r.last().conns[W]?.kind).toBe('forbidden');
  });

  it("the user's own sign-out doesn't notify", async () => {
    const r = rig();
    await r.m.identityChanged({ cause: 'sign-out', signedIn: false });
    expect(r.last().signedOut?.reason).toBe('not-signed-in');
    expect(r.deps.notify).not.toHaveBeenCalled();
  });

  it('a sign-in clears signed-out, bumps the epoch, drops sign-in conns and reconnects (D174)', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('unauthorized', 'x', 401));
    await r.m.observe('other', new RemoteError('unreachable', 'x'));
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    await r.m.identityChanged({ cause: 'sign-in', signedIn: true });
    expect(r.last()).toEqual({ signedOut: null, epoch: 1, conns: { other: { kind: 'unreachable', since: 1000 } } });
    expect(r.deps.reconnect).toHaveBeenCalledOnce();
  });

  it('observe pushes only on change; ok removes the entry; forbidden carries the SSO link', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('unreachable', 'x'));
    await r.m.observe(W, new RemoteError('unreachable', 'y'));
    expect(r.sent).toHaveLength(1);
    await r.m.observe(W, null);
    expect(r.last().conns).toEqual({});
    await r.m.observe(W, new RemoteError('forbidden', 'x', 403));
    expect(r.last().conns[W]).toEqual({ kind: 'forbidden', since: 1000, ssoUrl: 'https://github.com/orgs/acme/sso' });
    await r.m.observe(W, new RemoteError('protocol', 'x'));
    expect(r.sent).toHaveLength(3);
  });

  it('logs transitions with the kind and never a message', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('unauthorized', 'gho_leak', 401));
    expect(r.deps.log).toHaveBeenCalledWith({ level: 'warn', message: 'remote connection blocked', extra: { workspaceId: W, kind: 'host-refused' } });
    expect(JSON.stringify((r.deps.log as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('gho_leak');
  });
});
