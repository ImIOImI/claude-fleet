// Pure copy and tier rules for remote workspaces. Display only: the host enforces every tier.
import type { RemoteDrain, RemoteLiveSession, RemoteProbe, RemoteProbeErr, RemoteProbeOk, RemoteTier } from '../../preload/remoteTypes';

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

export function ipcFailure(err: unknown): RemoteProbeErr {
  return { ok: false, kind: 'protocol', message: ipcErrorText(err) };
}

/** The value, or null if `p` rejects or takes longer than `ms`. */
export function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(null))
    );
  });
}

/** Row `status` of a bookmark main hasn't probed yet (remote.ts). */
export const CHECKING_STATUS = 'checking host';

export interface RemoteChip {
  phase: 'live' | 'checking' | 'unreachable' | 'restarting';
  /** Replaces the chip's sub-line, or null to keep the normal activity text. */
  sub: string | null;
}

const restarting = (d: RemoteDrain | null | undefined): boolean => d?.phase === 'draining' || d?.phase === 'unknown';

export function remoteChip(w: { kind: string; state: string; status?: string }, drain?: RemoteDrain | null): RemoteChip | null {
  if (w.kind !== 'remote') return null;
  if (w.state !== 'unreachable') {
    if (drain?.phase === 'draining') return { phase: 'restarting', sub: 'restarting · input paused' };
    if (drain?.phase === 'unknown') return { phase: 'restarting', sub: 'waiting for the workspace pod' };
    return { phase: 'live', sub: null };
  }
  if (w.status === CHECKING_STATUS) return { phase: 'checking', sub: 'checking host…' };
  return { phase: 'unreachable', sub: 'host unreachable' };
}

export interface PaneRules {
  remote: boolean;
  /** Keystrokes are dropped; the host drops them too. */
  readOnly: boolean;
  canNew: boolean;
  /** An empty inventory (or closing the last tab) gets a fresh tab; creating one would fail below `session`. */
  defaultTab: boolean;
  /** The workspace pod is restarting (D152). */
  restarting: boolean;
}

/** `undefined` means a local or container workspace. */
export function paneRules(t: RemoteTier | null | undefined, drain?: RemoteDrain | null): PaneRules {
  if (t === undefined) return { remote: false, readOnly: false, canNew: true, defaultTab: true, restarting: false };
  const canNew = canStartSessions(t);
  const r = restarting(drain);
  return { remote: true, readOnly: !canType(t) || r, canNew: canNew && !r, defaultTab: canNew, restarting: r };
}

export function drainBanner(d: RemoteDrain | null | undefined, now: number, fmt: (ms: number) => string): string | null {
  if (!d || d.phase === 'serving') return null;
  if (d.phase === 'unknown') return 'Waiting for the workspace pod…';
  if (d.softAt !== null && now >= d.softAt) return 'The host is restarting. Stopping turns that are still running.';
  const until = d.softAt !== null ? ` (until ${fmt(d.softAt)})` : '';
  return `The host is restarting. Running turns finish first${until}; idle sessions close now. Typing is paused. Tabs resume on their own when the host is back.`;
}

/** How a tab's session end reads: during a restart it waits for the host instead of offering a fresh claude. */
export function sessionEndKind(restarting: boolean): 'restarting' | 'natural' {
  return restarting ? 'restarting' : 'natural';
}

/** Only an open tab whose session ended during the restart re-attaches when it is over (D151). */
export function resumesAfterDrain(resumeToken: number | null | undefined, endedInDrain: boolean): boolean {
  return resumeToken != null && endedInDrain;
}

/** The restart is over: re-attach the tabs that ended during it. */
export function drainEnded(prev: RemoteDrain | null | undefined, next: RemoteDrain | null | undefined): boolean {
  return restarting(prev) && next?.phase === 'serving';
}

export function joinableSessions(live: RemoteLiveSession[], tabIds: string[]): RemoteLiveSession[] {
  return live.filter((l) => l.alive && !tabIds.includes(l.id));
}

interface RemoteRow {
  kind: string;
  state: string;
  name: string;
  status?: string;
  remote?: { url: string };
}

/** Banner names: an unprobed bookmark isn't reported down. */
export function unreachableRemoteNames(ws: RemoteRow[]): string[] {
  return ws.filter((w) => remoteChip(w)?.phase === 'unreachable').map((w) => w.name);
}

export function remotePane(w: RemoteRow): { tone: 'neutral' | 'error'; title: string; body: string } | null {
  const phase = remoteChip(w)?.phase;
  const where = `${w.name} (${w.remote?.url ?? 'unknown URL'})`;
  if (phase === 'checking') return { tone: 'neutral', title: 'Checking host…', body: `Contacting ${where}.` };
  if (phase === 'unreachable') return { tone: 'error', title: 'Host unreachable', body: `${where} isn't answering. Its sessions reappear when it's back.` };
  return null;
}

/** Ids of live host sessions the viewer created. */
export function mineIds(live: RemoteLiveSession[]): Set<string> {
  return new Set(live.filter((l) => l.alive && l.mine).map((l) => l.id));
}

/** Advisory: the host refuses CLOSE from anyone but the creator. */
export function canEndSession(t: MaybeTier, mine: ReadonlySet<string>, id: string): boolean {
  return canStartSessions(t) && mine.has(id);
}

/** The tier was unknown at inventory load; once it turns out to be `session`, an empty pane gets its default tab. */
export function defaultTabOnTierChange(prev: MaybeTier, next: MaybeTier, loaded: boolean, tabCount: number): boolean {
  return prev === null && canStartSessions(next) && loaded && tabCount === 0;
}

export function forgetText(name: string): string {
  return `Forget ${name}? Removes the bookmark and this computer's tab list. The host and its sessions are untouched.`;
}
