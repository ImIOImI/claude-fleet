// Remote sign-in and connection state (D169–D176). Main imports it; the renderer via preload.

export type RemoteBlockKind = 'not-signed-in' | 'expired' | 'host-refused' | 'unreachable' | 'forbidden';
export type RemoteConnKind = 'ok' | RemoteBlockKind;

export interface RemoteConn {
  kind: RemoteConnKind;
  since: number;
  /** `forbidden` only: GitHub's SSO authorise link from AccountStatus.sso. */
  ssoUrl?: string | null;
}

export interface RemoteAuthState {
  signedOut: { reason: 'not-signed-in' | 'expired'; since: number } | null;
  /** Bumped on every sign-in or token refresh; remote tabs on a card reattach when it moves. */
  epoch: number;
  /** Absent means ok. */
  conns: Record<string, RemoteConn>;
}

export const EMPTY_REMOTE_AUTH: RemoteAuthState = { signedOut: null, epoch: 0, conns: {} };

const TAG_RE = /^remote-(not-signed-in|expired|host-refused|unreachable|forbidden): /;

/** Electron drops error fields over IPC, so the kind rides at the start of the message. */
export function remoteAttachTag(kind: RemoteBlockKind): string {
  return `remote-${kind}: `;
}

export function parseRemoteAttachTag(message: string): RemoteBlockKind | null {
  const m = TAG_RE.exec(message);
  return m ? (m[1] as RemoteBlockKind) : null;
}
