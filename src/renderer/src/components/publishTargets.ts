// Copy and pure helpers for the Edit form's "Publish transcripts to…" control and the Unpublish note.
import type { UnpublishResult } from '../../../preload/publish';

export const PUBLISH_HINT =
  "Sessions that start after you turn a host on are sent to it as they're recorded. Before anything leaves this computer, this workspace's secrets and your GitHub sign-in are replaced and common token shapes are removed. Earlier sessions are sent only if you choose “Also publish existing sessions…” for a host.";

export function publishVisibility(name: string): string {
  return `Visible to everyone with read on ${name} and to its sessions.`;
}

export function togglePublishTarget(to: readonly string[], id: string, on: boolean): string[] {
  if (!on) return to.filter((x) => x !== id);
  return to.includes(id) ? [...to] : [...to, id];
}

export function publishSummary(to: readonly string[], remotes: ReadonlyArray<{ id: string; name: string }>): string {
  const names = to.flatMap((id) => remotes.filter((r) => r.id === id).map((r) => r.name));
  return names.length ? `on: ${names.join(', ')}` : 'off';
}

/** Only the Edit form owns `publish`: other manifest writes omit the key, so main keeps the stored block. */
export function withoutPublish<T extends object>(spec: T): Omit<T, 'publish'> {
  const { publish: _drop, ...rest } = spec as T & { publish?: unknown };
  return rest;
}

/** `{ publish }` only when the form sent targets (edit mode); otherwise no key at all. */
export function publishPayload(publishTo: readonly string[] | undefined): { publish?: { to: string[] } } {
  return publishTo === undefined ? {} : { publish: { to: [...publishTo] } };
}

export function unpublishConfirmText(hosts: readonly string[]): string {
  return `Remove this session from ${hosts.length ? hosts.join(', ') : 'the host'}? It will never be published again.`;
}

export function unpublishNote(r: UnpublishResult): string {
  if (r.failed.length) {
    const names = r.failed.map((f) => f.name).join(', ');
    return `Not yet removed from ${names} (${r.failed[0].error}). It won’t be published again; try Unpublish once the host is reachable.`;
  }
  return r.removed ? 'Unpublished. This session won’t be published again.' : 'Nothing of this session was published. It won’t be published.';
}

const sessions = (n: number): string => `${n} existing session${n === 1 ? '' : 's'}`;

export function backfillConfirmText(n: number, host: string): string {
  return n ? `This will scrub and upload ${sessions(n)} to ${host}.` : `No existing sessions to add for ${host}.`;
}

export function backfillNote(n: number, host: string): string {
  return n ? `Publishing ${sessions(n)} to ${host} in the background.` : `No existing sessions to add for ${host}.`;
}

/** `'all'`, or local midnight of a `yyyy-mm-dd` date input; null when the date is not a real day. */
export function backfillFrom(choice: 'all' | 'date', date: string): number | 'all' | null {
  if (choice === 'all') return 'all';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(y, mo, d);
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d || at.getTime() < 0) return null;
  return at.getTime();
}

/** Main widens only a target stored as on, so the action needs it saved and still ticked. */
export function canBackfill(saved: readonly string[] | undefined, ticked: readonly string[], id: string): boolean {
  return !!saved?.includes(id) && ticked.includes(id);
}

/** An IPC rejection's message without Electron's "Error invoking remote method" prefix. */
export function ipcErrorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
