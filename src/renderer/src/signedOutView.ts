// Pure rules for the signed-out banner, remote tab cards and their reattach (D169–D176).
import { parseRemoteAttachTag, type RemoteAuthState, type RemoteBlockKind } from '../../preload/remoteAuth';
import type { PtyEndReason } from '../../preload/remoteTypes';
import { ipcErrorText } from './remoteView';

export const SIGNED_OUT_BANNER = 'Signed out of GitHub — remote workspaces are paused. Your sessions are still running on the host.';

export function signedOutBanner(s: RemoteAuthState | null, remoteCount: number): string | null {
  return s?.signedOut && remoteCount > 0 ? SIGNED_OUT_BANNER : null;
}

/** The app-wide sign-out wins over any per-bookmark kind (D170). */
export function blockFor(s: RemoteAuthState | null, workspaceId: string): RemoteBlockKind | null {
  if (s?.signedOut) return s.signedOut.reason;
  const k = s?.conns[workspaceId]?.kind;
  return k && k !== 'ok' ? k : null;
}

export const isSignInBlock = (b: RemoteBlockKind | null): boolean => b === 'not-signed-in' || b === 'expired';

export interface RemoteCard {
  tone: 'wait' | 'warn' | 'danger';
  title: string;
  body: string;
  action: 'sign-in' | 'retry' | null;
  linkUrl: string | null;
}

const SIGN_IN_BODY = 'Sign in to reconnect. Your sessions are still running on the host.';

export function remoteCard(kind: RemoteBlockKind, name: string, ssoUrl: string | null = null): RemoteCard {
  switch (kind) {
    case 'not-signed-in':
      return { tone: 'wait', title: 'Not signed in', body: SIGN_IN_BODY, action: 'sign-in', linkUrl: null };
    case 'expired':
      return { tone: 'wait', title: 'Sign-in expired', body: SIGN_IN_BODY, action: 'sign-in', linkUrl: null };
    case 'host-refused':
      return { tone: 'warn', title: `${name} didn't accept your sign-in; retrying`, body: 'Your GitHub sign-in is valid. This tab reconnects by itself.', action: 'retry', linkUrl: null };
    case 'unreachable':
      return {
        tone: 'warn',
        title: `Can't reach ${name}; retrying`,
        body: 'Check your network, or that your VPN (Twingate) is connected. This tab reconnects by itself.',
        action: 'retry',
        linkUrl: null
      };
    case 'forbidden':
      return {
        tone: 'danger',
        title: `You don't have access to ${name}`,
        body: ssoUrl
          ? 'Authorise claude-fleet for your organisation on GitHub (a one-time step); this tab reconnects by itself.'
          : "Ask the host's admins to add you to a team with access.",
        action: null,
        linkUrl: ssoUrl
      };
  }
}

export function attachErrorBlock(err: unknown): RemoteBlockKind | null {
  return parseRemoteAttachTag(ipcErrorText(err));
}

/** `authEnd`: the host closed it 4401/4403, so a block that lands later explains it. */
export type TabEnd =
  | { kind: 'natural'; authEnd?: boolean }
  | { kind: 'restarting' }
  | { kind: 'remote'; block: RemoteBlockKind }
  | { kind: 'attach-error'; message: string };

export function remoteEndKind(restarting: boolean, block: RemoteBlockKind | null, reason?: PtyEndReason): TabEnd {
  if (block && isSignInBlock(block)) return { kind: 'remote', block };
  if (restarting) return { kind: 'restarting' };
  if (block) return { kind: 'remote', block };
  return reason ? { kind: 'natural', authEnd: true } : { kind: 'natural' };
}

/** A host close (4401/4403) can beat the state push; unreachable never upgrades. */
const UPGRADES: ReadonlySet<RemoteBlockKind> = new Set(['not-signed-in', 'expired', 'host-refused', 'forbidden']);

export function shownRemoteBlock(remote: boolean, ended: TabEnd | null, block: RemoteBlockKind | null): RemoteBlockKind | null {
  if (!remote || !ended) return null;
  if (ended.kind === 'remote') return block ?? ended.block;
  if (ended.kind === 'natural' && ended.authEnd && block && UPGRADES.has(block)) return block;
  return null;
}

export interface AuthView {
  epoch: number;
  block: RemoteBlockKind | null;
}

export function shouldReattach(showing: RemoteBlockKind | null, prev: AuthView, next: AuthView): boolean {
  if (showing === null || isSignInBlock(next.block)) return false;
  return next.epoch !== prev.epoch || (prev.block !== null && next.block === null);
}

export function skipAttach(remote: boolean, block: RemoteBlockKind | null): boolean {
  return remote && isSignInBlock(block);
}

/** Whether a sign-in or block change should reattach this tab (D174). */
export function reattachOnAuthChange(o: { remote: boolean; ended: TabEnd | null; attaching: boolean; prev: AuthView; next: AuthView }): boolean {
  if (!o.remote || o.attaching) return false;
  const showing = shownRemoteBlock(true, o.ended, o.prev.block);
  if (showing) return shouldReattach(showing, o.prev, o.next);
  return o.ended?.kind === 'natural' && !!o.ended.authEnd && !isSignInBlock(o.next.block) && o.next.epoch !== o.prev.epoch;
}

export const REATTACH_JITTER_MS = 2_000;

/** Spreads the tabs of one host over a couple of seconds when its block clears. */
export function reattachJitterMs(tabId: string): number {
  let h = 0;
  for (let i = 0; i < tabId.length; i++) h = (h * 31 + tabId.charCodeAt(i)) >>> 0;
  return h % REATTACH_JITTER_MS;
}
