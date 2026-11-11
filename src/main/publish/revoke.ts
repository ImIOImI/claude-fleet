// Forgetting a remote bookmark withdraws every workspace's consent to publish to it (D104).
import type { WorkspaceSpec } from '../workspaces.js';

export interface RevokeDeps {
  listManifests(): Promise<WorkspaceSpec[]>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  deleteCursorsTo(target: string): Promise<void>;
}

export async function revokePublishTarget(target: string, d: RevokeDeps): Promise<void> {
  for (const m of await d.listManifests()) {
    if (m.kind === 'remote' || !m.publish || (!m.publish.to.includes(target) && !Object.hasOwn(m.publish.since, target))) continue;
    const to = m.publish.to.filter((id) => id !== target);
    const since = Object.fromEntries(Object.entries(m.publish.since).filter(([id]) => id !== target));
    await d.writeManifest({ ...m, publish: to.length ? { to, since } : undefined });
  }
  await d.deleteCursorsTo(target);
}
