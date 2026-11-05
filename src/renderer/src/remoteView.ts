// Pure copy and tier rules for remote workspaces. Display only: the host enforces every tier.
import type { RemoteProbe, RemoteProbeErr, RemoteProbeOk, RemoteTier } from '../../preload/remoteTypes';

export type MaybeTier = RemoteTier | null | undefined;

export const canType = (t: MaybeTier): boolean => t === 'steer' || t === 'session';
export const canStartSessions = (t: MaybeTier): boolean => t === 'session';

export function tierTitle(t: MaybeTier): string {
  switch (t) {
    case 'read':
      return 'read: you can watch sessions but not type';
    case 'steer':
      return 'steer: you can type into sessions';
    case 'session':
      return 'session: you can start and close your own sessions';
    default:
      return 'tier unknown until the host answers';
  }
}

/** Banner text for unreachable remote workspaces, or null when none are. */
export function unreachableBanner(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} unreachable: its sessions and automations are hidden until it's back`;
  return `${names.join(', ')} unreachable: their sessions and automations are hidden until they're back`;
}

export function probeErrorText(e: RemoteProbeErr): string {
  switch (e.kind) {
    case 'unreachable':
      return `Not reachable. Check your network or VPN. (${e.message})`;
    case 'not-signed-in':
      return 'Sign in with GitHub first.';
    default:
      return e.message;
  }
}

export interface RemoteFormState {
  ok: RemoteProbeOk | null;
  err: RemoteProbeErr | null;
}

export interface RemoteFormView {
  primary: 'check' | 'add' | 'move';
  primaryLabel: string;
  notice: { tone: 'error' | 'neutral'; text: string; linkUrl?: string } | null;
}

/** `declined` and `moved` are steps, not failures: the last good probe stays on screen. */
export function applyProbe(prev: RemoteFormState, r: RemoteProbe): RemoteFormState {
  if (r.ok) return { ok: r, err: null };
  if (r.kind === 'declined' || r.kind === 'moved') return { ok: prev.ok, err: r };
  return { ok: null, err: r };
}

const PRIMARY_LABEL: Record<RemoteFormView['primary'], string> = { check: 'Check host', add: 'Add workspace', move: 'Move here' };

export function remoteFormView({ ok, err }: RemoteFormState): RemoteFormView {
  const primary: RemoteFormView['primary'] = err?.kind === 'moved' || ok?.existingUrl ? 'move' : ok ? 'add' : 'check';
  let notice: RemoteFormView['notice'] = null;
  if (err && (err.kind === 'declined' || err.kind === 'moved')) notice = { tone: 'neutral', text: err.message };
  else if (err) notice = { tone: 'error', text: probeErrorText(err), ...(err.ssoUrl ? { linkUrl: err.ssoUrl } : {}) };
  else if (ok?.existingUrl) notice = { tone: 'neutral', text: `Already added at ${ok.existingUrl}. Moving updates that bookmark to this address.` };
  else if (ok?.existing) notice = { tone: 'neutral', text: 'Already added; adding again refreshes it.' };
  return { primary, primaryLabel: PRIMARY_LABEL[primary], notice };
}

const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

export function ipcErrorText(err: unknown): string {
  return String((err as Error | undefined)?.message ?? err).replace(IPC_PREFIX, '');
}
