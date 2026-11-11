import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '../remoteClient.js';
import type { UnpublishResult } from '../../preload/publish.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { HOST_BUSY, PUBLISH_CHANNELS, registerPublishIpc, UNPUBLISH_RETRIES, UNPUBLISH_RETRY_MAX_MS, type PublishIpcDeps } from './publishIpc.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const W = '01JC0000000000000000000005';
const R1 = '01JC00000000000000000000R1';
const R2 = '01JC00000000000000000000R2';
const SID = '11111111-2222-4333-8444-555555555555';
const m = (id: string, extra: object) => ({ id, name: id === R1 ? 'review-bot' : id === R2 ? 'ops' : 'mine', kind: 'local', env: { plain: {}, secretKeys: [] }, ...extra }) as unknown as WorkspaceSpec;
const store = new Map<string, WorkspaceSpec>([
  [W, m(W, { publish: { to: [R1, R2], since: { [R1]: 1, [R2]: 1 } } })],
  [R1, m(R1, { kind: 'remote', remote: { url: 'http://one', tier: 'read', login: 'a', checkedAt: 1 } })],
  [R2, m(R2, { kind: 'remote', remote: { url: 'http://two', tier: 'read', login: 'a', checkedAt: 1 } })]
]);

function harness(unpublish: PublishIpcDeps['unpublish'], over: Partial<PublishIpcDeps> = {}) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const order: string[] = [];
  const deps: PublishIpcDeps = {
    readManifest: async (id) => store.get(id) ?? null,
    unpublish: async (url, sid) => { order.push(`unpublish ${url}`); return unpublish(url, sid); },
    withhold: async (ws, sid) => void order.push(`withhold ${ws} ${sid}`),
    idle: async (ws) => void order.push(`idle ${ws}`),
    ...over
  };
  registerPublishIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...a: unknown[]) => unknown) }, deps);
  return { call: (...a: unknown[]) => Promise.resolve(handlers.get('publish:unpublish')!({}, ...a)), handlers, order };
}

describe('publish:unpublish', () => {
  it('registers exactly its channels', () => {
    expect([...harness(async () => 0).handlers.keys()]).toEqual([...PUBLISH_CHANNELS]);
  });

  it('withholds, waits for running passes, then asks every target; 404 counts as nothing to remove; other failures are listed', async () => {
    const h = harness(async (url) => {
      if (url === 'http://two') throw new RemoteError('unreachable', 'http://two is not reachable');
      return 1;
    });
    expect(await h.call(W, SID)).toEqual({ removed: 1, failed: [{ remoteId: R2, name: 'ops', error: 'http://two is not reachable' }] });
    expect(h.order).toEqual([`withhold ${W} ${SID}`, `idle ${W}`, 'unpublish http://one', 'unpublish http://two']);
    const h404 = harness(async () => { throw new RemoteError('protocol', 'not published', 404); });
    expect(await h404.call(W, SID)).toEqual({ removed: 0, failed: [] });
  });

  it('sends no DELETE until a running pass has finished', async () => {
    let finish!: () => void;
    const running = new Promise<void>((r) => { finish = r; });
    const h = harness(async () => 1, { idle: () => running });
    const out = h.call(W, SID);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.order).toEqual([`withhold ${W} ${SID}`]);
    finish();
    expect(await out).toEqual({ removed: 2, failed: [] });
    expect(h.order).toEqual([`withhold ${W} ${SID}`, 'unpublish http://one', 'unpublish http://two']);
  });

  it('sends nothing when the withhold fails', async () => {
    const h = harness(async () => 1, { withhold: async () => { throw new Error('db down'); } });
    await expect(h.call(W, SID)).rejects.toThrow('db down');
    expect(h.order).toEqual([]);
  });

  it('refuses a bad workspace id, a bad session id and a remote workspace', async () => {
    const h = harness(async () => 0);
    await expect(h.call('loadout-source:x', SID)).rejects.toThrow(/workspace id/);
    await expect(h.call(W, 'nope')).rejects.toThrow(/session id/);
    await expect(h.call(R1, SID)).rejects.toThrow(/local or container/);
    await expect(h.call('01JC0000000000000000000009', SID)).rejects.toThrow(/local or container/);
    expect(h.order).toEqual([]);
  });

  it('skips targets that are no longer remote bookmarks', async () => {
    const W2 = '01JC0000000000000000000007';
    store.set(W2, m(W2, { publish: { to: ['01JC0000000000000000000GONE', W], since: {} } }));
    const h = harness(async () => 1);
    expect(await h.call(W2, SID)).toEqual({ removed: 0, failed: [] });
    expect(h.order).toEqual([`withhold ${W2} ${SID}`, `idle ${W2}`]);
  });

  it('retries a busy host (429/503) up to 3 times, honouring Retry-After, then reports it busy', async () => {
    const waits: number[] = [];
    let calls = 0;
    const h = harness(async (url) => {
      if (url === 'http://one') {
        calls++;
        if (calls === 1) throw new RemoteError('unreachable', 'http://one is busy', 429, 2_500);
        if (calls === 2) throw new RemoteError('standby', 'standby', 503);
        if (calls === 3) throw new RemoteError('unreachable', 'busy', 429, 60_000);
        return 1;
      }
      throw new RemoteError('unreachable', 'http://two is busy', 429);
    }, { sleep: async (ms) => void waits.push(ms) });
    expect(await h.call(W, SID)).toEqual({ removed: 1, failed: [{ remoteId: R2, name: 'ops', error: HOST_BUSY }] });
    expect(calls).toBe(4);
    expect(waits).toEqual([2_500, 1_000, UNPUBLISH_RETRY_MAX_MS, 1_000, 1_000, 1_000]);
    expect(h.order.filter((o) => o === 'unpublish http://two')).toHaveLength(UNPUBLISH_RETRIES + 1);
  });

  it('does not retry other failures', async () => {
    const waits: number[] = [];
    const h = harness(async () => { throw new RemoteError('unreachable', 'http://x answered 500', 500); }, { sleep: async (ms) => void waits.push(ms) });
    expect(((await h.call(W, SID)) as UnpublishResult).failed.map((f) => f.error)).toEqual(['http://x answered 500', 'http://x answered 500']);
    expect(waits).toEqual([]);
  });
});
