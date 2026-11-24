// App-wide GitHub sign-in state and per-bookmark connection state for remote workspaces (D169–D174).
// Pure: ipc.ts injects the identity reads, the push, the notification sink and reconnect.
import type { IdentityChange } from './identity/identityService.js';
import { RemoteError, type RemoteDisconnect } from './remoteClient.js';
import type { NotifyInput } from './inbox/notifyService.js';
import type { AccountSso } from '../preload/identityTypes.js';
import type { RemoteAuthState, RemoteConn, RemoteConnKind } from '../preload/remoteAuth.js';

const SIGN_IN_KINDS: ReadonlySet<RemoteConnKind> = new Set(['not-signed-in', 'expired', 'host-refused']);

export const SIGNED_OUT_NOTICE = {
  title: 'Signed out of GitHub',
  body: 'Remote workspaces are paused. Your sessions are still running on the host. Open claude-fleet to sign in.'
} as const;

export function signedOutRequest(n: { title: string; body: string }): NotifyInput {
  return { kind: 'signed-out', title: n.title, body: n.body, priority: 'high', source: { kind: 'user', id: null }, dedupeKey: 'remote-signed-out' };
}

/** Only GitHub's per-org authorise link (`X-GitHub-SSO`); other SSO hints don't unlock a 403. */
export function ssoLink(sso: AccountSso | null | undefined): string | null {
  return sso?.url ?? null;
}

/** A 4401 close carries no verdict, so /whoami re-asks; others feed the monitor as they are. */
export function eventsDisconnect(why: Pick<RemoteDisconnect, 'kind' | 'auth' | 'status'>): { observe: RemoteError } | { recheck: true } | null {
  if (why.kind === 'unauthorized' && !why.auth) return { recheck: true };
  if (why.kind === 'unauthorized' || why.kind === 'forbidden' || why.kind === 'not-signed-in') {
    return { observe: new RemoteError(why.kind, 'events closed', why.status, undefined, why.auth) };
  }
  return null;
}

/** null: not a connection state (protocol, disabled, model, a non-remote error). */
export function connKindOf(err: unknown): RemoteConnKind | null {
  if (err === null) return 'ok';
  if (!(err instanceof RemoteError)) return null;
  switch (err.kind) {
    case 'not-signed-in':
      return 'not-signed-in';
    case 'unauthorized':
      return err.auth === 'expired' ? 'expired' : 'host-refused';
    case 'forbidden':
      return 'forbidden';
    case 'unreachable':
    case 'standby':
      return 'unreachable';
    default:
      return null;
  }
}

export interface RemoteAuthMonitorDeps {
  signedIn(): Promise<boolean>;
  bookmarkCount(): Promise<number>;
  send(s: RemoteAuthState): void;
  notify(n: { title: string; body: string }): void;
  reconnect(): void;
  ssoUrl?(): Promise<string | null>;
  log(e: { level: 'info' | 'warn'; message: string; extra: Record<string, unknown> }): void;
  now?: () => number;
}

export interface RemoteAuthMonitor {
  /** Reads the sign-in without pushing; `remote:authState` waits for it. */
  start(): Promise<void>;
  /** `err` null means the bookmark answered fine. */
  observe(workspaceId: string, err: unknown): Promise<void>;
  identityChanged(c: IdentityChange): Promise<void>;
  snapshot(): RemoteAuthState;
}

export function createRemoteAuthMonitor(d: RemoteAuthMonitorDeps): RemoteAuthMonitor {
  const now = d.now ?? Date.now;
  let signedOut: RemoteAuthState['signedOut'] = null;
  let epoch = 0;
  /** Bumped by every identity change, so a slower start read can't overwrite it. */
  let changes = 0;
  const conns = new Map<string, RemoteConn>();
  /** Latest observe per bookmark; an older one still awaiting the SSO link drops its result. */
  const seq = new Map<string, number>();
  const snapshot = (): RemoteAuthState => ({ signedOut, epoch, conns: Object.fromEntries(conns) });
  let started: Promise<void> = Promise.resolve();
  // The renderer drops its snapshot once a push lands, so no push may precede the start read.
  const push = async (): Promise<void> => {
    await started;
    d.send(snapshot());
  };
  const signIn = async (cause: string): Promise<void> => {
    changes++;
    signedOut = null;
    epoch++;
    for (const [id, conn] of conns) if (SIGN_IN_KINDS.has(conn.kind)) conns.delete(id);
    d.log({ level: 'info', message: 'remote sign-in changed', extra: { cause, epoch } });
    d.reconnect();
    await push();
  };

  return {
    snapshot,
    start() {
      started = (async () => {
        const seen = changes;
        const ok = await d.signedIn().catch(() => false);
        if (!ok && changes === seen) signedOut = { reason: 'not-signed-in', since: now() };
      })();
      return started;
    },
    async observe(id, err) {
      const kind = connKindOf(err);
      if (kind === null) return;
      const my = (seq.get(id) ?? 0) + 1;
      seq.set(id, my);
      if (kind === 'ok') {
        // A host answered, so a token exists: a sign-in this monitor missed.
        if (signedOut !== null) {
          const seen = changes;
          if ((await d.signedIn().catch(() => false)) && signedOut !== null && changes === seen) await signIn('observed');
        }
        if (!conns.delete(id)) return;
        d.log({ level: 'info', message: 'remote connection ok', extra: { workspaceId: id } });
        await push();
        return;
      }
      if (conns.get(id)?.kind === kind) return;
      const conn: RemoteConn = { kind, since: now() };
      if (kind === 'forbidden') {
        conn.ssoUrl = (await d.ssoUrl?.().catch(() => null)) ?? null;
        if (seq.get(id) !== my || conns.get(id)?.kind === kind) return;
      }
      conns.set(id, conn);
      d.log({ level: 'warn', message: 'remote connection blocked', extra: { workspaceId: id, kind } });
      await push();
    },
    async identityChanged(c) {
      if (c.signedIn) return signIn(c.cause);
      const my = ++changes;
      const first = signedOut === null;
      signedOut = { reason: c.cause === 'revoked' ? 'expired' : 'not-signed-in', since: signedOut?.since ?? now() };
      d.log({ level: 'warn', message: 'remote signed out', extra: { cause: c.cause } });
      await push();
      if (!first || c.cause !== 'revoked') return;
      const n = await d.bookmarkCount().catch(() => 0);
      if (n > 0 && changes === my) d.notify({ ...SIGNED_OUT_NOTICE });
    }
  };
}
