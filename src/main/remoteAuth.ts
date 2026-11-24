// App-wide GitHub sign-in state and per-bookmark connection state for remote workspaces (D169–D174).
// Pure: ipc.ts injects the identity reads, the push, the notification sink and reconnect.
import type { IdentityChange } from './identity/identityService.js';
import { RemoteError } from './remoteClient.js';
import type { RemoteAuthState, RemoteConn, RemoteConnKind } from '../preload/remoteAuth.js';

const SIGN_IN_KINDS: ReadonlySet<RemoteConnKind> = new Set(['not-signed-in', 'expired', 'host-refused']);

export const SIGNED_OUT_NOTICE = {
  title: 'Signed out of GitHub',
  body: 'Remote workspaces are paused. Your sessions are still running on the host. Open claude-fleet to sign in.'
} as const;

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
  const conns = new Map<string, RemoteConn>();
  const snapshot = (): RemoteAuthState => ({ signedOut, epoch, conns: Object.fromEntries(conns) });
  const push = (): void => d.send(snapshot());

  return {
    snapshot,
    async start() {
      if (!(await d.signedIn().catch(() => false))) signedOut = { reason: 'not-signed-in', since: now() };
      push();
    },
    async observe(id, err) {
      const kind = connKindOf(err);
      if (kind === null) return;
      if (kind === 'ok') {
        if (!conns.delete(id)) return;
        d.log({ level: 'info', message: 'remote connection ok', extra: { workspaceId: id } });
        push();
        return;
      }
      if (conns.get(id)?.kind === kind) return;
      const conn: RemoteConn = { kind, since: now() };
      if (kind === 'forbidden') conn.ssoUrl = (await d.ssoUrl?.().catch(() => null)) ?? null;
      conns.set(id, conn);
      d.log({ level: 'warn', message: 'remote connection blocked', extra: { workspaceId: id, kind } });
      push();
    },
    async identityChanged(c) {
      if (c.signedIn) {
        signedOut = null;
        epoch++;
        for (const [id, conn] of conns) if (SIGN_IN_KINDS.has(conn.kind)) conns.delete(id);
        d.log({ level: 'info', message: 'remote sign-in changed', extra: { cause: c.cause, epoch } });
        d.reconnect();
        push();
        return;
      }
      const first = signedOut === null;
      signedOut = { reason: c.cause === 'revoked' ? 'expired' : 'not-signed-in', since: signedOut?.since ?? now() };
      d.log({ level: 'warn', message: 'remote signed out', extra: { cause: c.cause } });
      if (first && c.cause === 'revoked' && (await d.bookmarkCount().catch(() => 0)) > 0) d.notify({ ...SIGNED_OUT_NOTICE });
      push();
    }
  };
}
