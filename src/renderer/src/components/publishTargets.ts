// Copy and pure helpers for the Edit form's "Publish transcripts to…" control.

export const PUBLISH_HINT =
  "Sessions that start after you turn a host on are sent to it as they're recorded. Before anything leaves this computer, this workspace's secrets and your GitHub sign-in are replaced and common token shapes are removed. Earlier sessions are never sent.";

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
