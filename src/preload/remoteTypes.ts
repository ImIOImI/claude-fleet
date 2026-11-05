// remote:* IPC payloads (add a remote workspace). No token ever appears here.

export type RemoteTier = 'read' | 'steer' | 'session';

export interface RemoteProbeOk {
  ok: true;
  /** Canonical URL the bookmark will store. */
  url: string;
  workspace: { id: string; name: string; description: string | null; color: { hue: number } | null };
  user: { login: string; name: string | null; avatarUrl: string | null };
  tier: RemoteTier;
  /** Plain-http warning for a non-loopback host, else null. */
  warning: string | null;
  /** A bookmark for this workspace id already exists. */
  existing: boolean;
  /** The existing bookmark's URL when it differs from `url`; adding then needs `sameHostNewAddress`. */
  existingUrl: string | null;
}

export type RemoteProbeErrorKind =
  | 'invalid-url'
  | 'not-signed-in'
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'sso'
  | 'standby'
  | 'protocol'
  /** The host's id is already a workspace on this computer that is not a remote bookmark. */
  | 'clash'
  /** The host's id is bookmarked at another URL and `sameHostNewAddress` was not set. */
  | 'moved'
  /** The user declined main's confirm (sending the token, or moving a bookmark). */
  | 'declined';

export interface RemoteProbeErr {
  ok: false;
  kind: RemoteProbeErrorKind;
  message: string;
  /** kind 'sso': GitHub's authorise URL when known. */
  ssoUrl?: string | null;
  /** kind 'moved': the URL the bookmark has now. */
  existingUrl?: string;
}

export type RemoteProbe = RemoteProbeOk | RemoteProbeErr;

export interface RemoteAddOptions {
  /** Confirmed: the bookmarked workspace moved to this URL. */
  sameHostNewAddress?: boolean;
}

export interface RemoteLiveSession {
  id: string;
  alive: boolean;
  /** The viewer created it (host-reported; the host still decides CLOSE). */
  mine: boolean;
}
