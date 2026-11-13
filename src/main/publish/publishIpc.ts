// publish:unpublish: withdraw one session from every host its workspace publishes to (remote-workspaces §13 Q4).
import { publishFloor, widenPublish, type BackfillCount, type BackfillResult, type UnpublishResult } from '../../preload/publish.js';
import type { IpcHandleLike } from '../vaultIpc.js';
import { assertRendererWorkspaceId } from '../vaultScopes.js';
import { RemoteError } from '../remoteClient.js';
import { oneLine } from '../remoteUrl.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { SESSION_UUID_RE, ULID_RE } from './protocol.js';

export const PUBLISH_CHANNELS = ['publish:backfillCount', 'publish:backfill', 'publish:unpublish'] as const;

export const UNPUBLISH_RETRIES = 3;
export const UNPUBLISH_RETRY_DEFAULT_MS = 1_000;
export const UNPUBLISH_RETRY_MAX_MS = 5_000;
export const HOST_BUSY = 'the host is busy, try again';

const busy = (err: unknown): err is RemoteError => err instanceof RemoteError && (err.status === 429 || err.status === 503);

export interface PublishIpcDeps {
  readManifest(id: string): Promise<WorkspaceSpec | null>;
  unpublish(url: string, sessionId: string): Promise<number>;
  withhold(workspaceId: string, sessionId: string): Promise<void>;
  /** Resolves once no publish pass of the workspace is running. */
  idle(workspaceId: string): Promise<void>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  /** Deletes the (source, target) cursor, so the next pass reads from the first event. */
  resetCursor(workspaceId: string, target: string): Promise<void>;
  /** Publisher.exclusive: no pass of the workspace runs while `fn` does. */
  exclusive<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
  /** Publishable sessions of the workspace that started in [from, below). */
  countBackfill(workspaceId: string, from: number, below: number): Promise<number>;
  bump(workspaceId: string): void;
  /** Tests: replaces the wait between busy retries. */
  sleep?: (ms: number) => Promise<void>;
}

export function registerPublishIpc(ipc: IpcHandleLike, d: PublishIpcDeps): void {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const unpublish = async (url: string, sessionId: string): Promise<number> => {
    for (let retry = 0; ; retry++) {
      try {
        return await d.unpublish(url, sessionId);
      } catch (err) {
        if (!busy(err) || retry >= UNPUBLISH_RETRIES) throw err;
        await sleep(Math.min(err.retryAfterMs ?? UNPUBLISH_RETRY_DEFAULT_MS, UNPUBLISH_RETRY_MAX_MS));
      }
    }
  };
  const localSpec = async (workspaceId: unknown, channel: string): Promise<WorkspaceSpec> => {
    assertRendererWorkspaceId(workspaceId);
    const spec = await d.readManifest(workspaceId);
    if (!spec || spec.kind === 'remote') throw new Error(`${channel} needs a local or container workspace`);
    return spec;
  };
  /** Validates the action against the stored manifest; main owns the resulting floor (D140). */
  const backfillPlan = async (workspaceId: unknown, target: unknown, from: unknown, channel: string) => {
    const spec = await localSpec(workspaceId, channel);
    if (typeof target !== 'string' || !ULID_RE.test(target)) throw new Error(`${channel} needs a target workspace id`);
    const next = widenPublish(spec.publish, target, from);
    const remote = await d.readManifest(target);
    if (remote?.kind !== 'remote' || !remote.remote) throw new Error(`${channel}: the target is not a remote workspace`);
    return { spec, next, host: remote.name, from: next.from![target], below: publishFloor(spec.publish!, target) };
  };
  ipc.handle('publish:backfillCount', async (_e, workspaceId: unknown, target: unknown, from: unknown): Promise<BackfillCount> => {
    const p = await backfillPlan(workspaceId, target, from, 'publish:backfillCount');
    return { sessions: await d.countBackfill(p.spec.id, p.from, p.below), host: p.host };
  });
  ipc.handle('publish:backfill', async (_e, workspaceId: unknown, target: unknown, from: unknown): Promise<BackfillResult> => {
    const first = await backfillPlan(workspaceId, target, from, 'publish:backfill');
    try {
      return await d.exclusive(first.spec.id, async () => {
        // Re-read inside the lock: a save or a second action may have landed meanwhile.
        const p = await backfillPlan(workspaceId, target, from, 'publish:backfill');
        const sessions = await d.countBackfill(p.spec.id, p.from, p.below);
        // Cursor first: a crash between the two leaves a full re-scan under the old floor, never a lowered floor above a stale cursor.
        await d.resetCursor(p.spec.id, target as string);
        await d.writeManifest({ ...p.spec, publish: p.next });
        return { sessions };
      });
    } finally {
      d.bump(first.spec.id);
    }
  });
  ipc.handle('publish:unpublish', async (_e, workspaceId: unknown, sessionId: unknown): Promise<UnpublishResult> => {
    assertRendererWorkspaceId(workspaceId);
    if (typeof sessionId !== 'string' || !SESSION_UUID_RE.test(sessionId)) throw new Error('publish:unpublish needs a session id');
    const spec = await d.readManifest(workspaceId);
    if (!spec || spec.kind === 'remote') throw new Error('publish:unpublish needs a local or container workspace');
    // Withheld first, so no later pass sends it; then wait out a batch already in flight, which could land after the DELETE.
    await d.withhold(spec.id, sessionId);
    await d.idle(spec.id);
    const out: UnpublishResult = { removed: 0, failed: [] };
    for (const target of spec.publish?.to ?? []) {
      const remote = await d.readManifest(target);
      if (remote?.kind !== 'remote' || !remote.remote) continue;
      try {
        out.removed += await unpublish(remote.remote.url, sessionId);
      } catch (err) {
        if (err instanceof RemoteError && err.status === 404) continue;
        out.failed.push({ remoteId: target, name: remote.name, error: busy(err) ? HOST_BUSY : oneLine((err as Error).message, 200) });
      }
    }
    return out;
  });
}
