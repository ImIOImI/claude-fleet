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
