import { describe, expect, it, vi } from 'vitest';
import { parseRemoteAttachTag, remoteAttachTag, type RemoteAuthState } from '../preload/remoteAuth.js';
import { RemoteError } from './remoteClient.js';
import { connKindOf, createRemoteAuthMonitor, eventsDisconnect, SIGNED_OUT_NOTICE, signedOutRequest, ssoLink, type RemoteAuthMonitorDeps } from './remoteAuth.js';

const W = '01JC0000000000000000000000';

function rig(o: { signedIn?: () => Promise<boolean>; bookmarks?: () => Promise<number>; ssoUrl?: () => Promise<string | null> } & { in?: boolean; n?: number } = {}) {
  const sent: RemoteAuthState[] = [];
  const deps: RemoteAuthMonitorDeps = {
    signedIn: o.signedIn ?? (async () => o.in ?? true),
    bookmarkCount: o.bookmarks ?? (async () => o.n ?? 1),
    send: (s) => void sent.push(s),
    notify: vi.fn(),
    reconnect: vi.fn(),
    ssoUrl: o.ssoUrl ?? (async () => 'https://github.com/orgs/acme/sso'),
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
  it('starts signed out without notifying or pushing (the renderer reads the snapshot)', async () => {
    const r = rig({ in: false });
    await r.m.start();
    expect(r.m.snapshot().signedOut).toEqual({ reason: 'not-signed-in', since: 1000 });
    expect(r.sent).toEqual([]);
    expect(r.deps.notify).not.toHaveBeenCalled();
  });

  it('notifies once per involuntary sign-out, only with a bookmark (D172)', async () => {
    const r = rig();
    await r.m.start();
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(r.deps.notify).toHaveBeenCalledExactlyOnceWith(SIGNED_OUT_NOTICE);
    expect(r.last().signedOut?.reason).toBe('expired');
    const none = rig({ n: 0 });
    await none.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(none.deps.notify).not.toHaveBeenCalled();
  });

  it('starting signed out then a revoke does not notify; a later sign-in then revoke does', async () => {
    const r = rig({ in: false });
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
}

describe('RemoteAuthMonitor races', () => {
  it('a forbidden observe waiting on the SSO link pushes once, and a later ok wins', async () => {
    const sso = deferred<string | null>();
    const r = rig({ ssoUrl: () => sso.p });
    const a = r.m.observe(W, new RemoteError('forbidden', 'x', 403));
    const b = r.m.observe(W, new RemoteError('forbidden', 'y', 403));
    sso.resolve('https://github.com/orgs/acme/sso');
    await Promise.all([a, b]);
    expect(r.sent).toHaveLength(1);

    const late = deferred<string | null>();
    const q = rig({ ssoUrl: () => late.p });
    const f = q.m.observe(W, new RemoteError('forbidden', 'x', 403));
    await q.m.observe(W, null);
    late.resolve(null);
    await f;
    expect(q.m.snapshot().conns).toEqual({});
  });

  it('a sign-in that lands while start reads the token is not overwritten', async () => {
    const read = deferred<boolean>();
    const r = rig({ signedIn: () => read.p });
    const s = r.m.start();
    await r.m.identityChanged({ cause: 'sign-in', signedIn: true });
    read.resolve(false);
    await s;
    expect(r.m.snapshot().signedOut).toBeNull();
  });

  it('a revoke that lands while start reads the token keeps its reason', async () => {
    const read = deferred<boolean>();
    const r = rig({ signedIn: () => read.p });
    const s = r.m.start();
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    read.resolve(false);
    await s;
    expect(r.m.snapshot().signedOut?.reason).toBe('expired');
  });

  it('a sign-in during the bookmark count cancels the revoke notification', async () => {
    const count = deferred<number>();
    const r = rig({ bookmarks: () => count.p });
    const revoke = r.m.identityChanged({ cause: 'revoked', signedIn: false });
    await r.m.identityChanged({ cause: 'sign-in', signedIn: true });
    count.resolve(2);
    await revoke;
    expect(r.deps.notify).not.toHaveBeenCalled();
    expect(r.last().signedOut).toBeNull();
  });
});

describe('/events disconnects (D169)', () => {
  it('4401 without a verdict rechecks; a recovered 401, 403 and no sign-in are observed; others ignored', () => {
    expect(eventsDisconnect({ kind: 'unauthorized' })).toEqual({ recheck: true });
    const v = eventsDisconnect({ kind: 'unauthorized', auth: 'expired', status: 401 });
    expect(v && 'observe' in v && connKindOf(v.observe)).toBe('expired');
    const f = eventsDisconnect({ kind: 'forbidden', status: 403 });
    expect(f && 'observe' in f && connKindOf(f.observe)).toBe('forbidden');
    const n = eventsDisconnect({ kind: 'not-signed-in' });
    expect(n && 'observe' in n && connKindOf(n.observe)).toBe('not-signed-in');
    expect(eventsDisconnect({ kind: 'unreachable' })).toBeNull();
    expect(eventsDisconnect({ kind: 'dropped' })).toBeNull();
  });
});

describe('signed-out notification request (D172)', () => {
  it('has the fixed kind, priority, source and dedupe key', () => {
    expect(signedOutRequest(SIGNED_OUT_NOTICE)).toEqual({
      kind: 'signed-out',
      title: 'Signed out of GitHub',
      body: SIGNED_OUT_NOTICE.body,
      priority: 'high',
      source: { kind: 'user', id: null },
      dedupeKey: 'remote-signed-out'
    });
  });
});

describe('ssoLink', () => {
  it('only the X-GitHub-SSO authorise URL, never the app settings fallback', () => {
    expect(ssoLink({ url: 'https://github.com/orgs/acme/sso', org: 'acme', orgCount: 0, appSettingsUrl: 'https://github.com/settings/x' })).toBe('https://github.com/orgs/acme/sso');
    expect(ssoLink({ url: null, org: null, orgCount: 2, appSettingsUrl: 'https://github.com/settings/x' })).toBeNull();
    expect(ssoLink(null)).toBeNull();
  });
});
