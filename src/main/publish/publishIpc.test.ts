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
    writeManifest: async (spec) => { order.push(`write ${spec.id} ${JSON.stringify(spec.publish)}`); store.set(spec.id, spec); },
    resetCursor: async (ws, target) => void order.push(`reset ${ws}>${target}`),
    exclusive: async (ws, fn) => { order.push(`exclusive ${ws}`); try { return await fn(); } finally { order.push(`released ${ws}`); } },
    countBackfill: async (ws, from, below) => { order.push(`count ${ws} ${from}..${below}`); return 7; },
    bump: (ws) => void order.push(`bump ${ws}`),
    ...over
  };
  registerPublishIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...a: unknown[]) => unknown) }, deps);
  return {
    call: (...a: unknown[]) => Promise.resolve(handlers.get('publish:unpublish')!({}, ...a)),
    on: (ch: string, ...a: unknown[]) => Promise.resolve(handlers.get(ch)!({}, ...a)),
    handlers, order
  };
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

describe('publish:backfillCount / publish:backfill (D140)', () => {
  const BW = '01JC000000000000000000000B';
  const fresh = () => store.set(BW, m(BW, { kind: 'container', publish: { to: [R1, R2], since: { [R1]: 5_000, [R2]: 6_000 } } }));

  it('counts the sessions a widen would add and names the host, without writing anything', async () => {
    fresh();
    const h = harness(async () => 0);
    expect(await h.on('publish:backfillCount', BW, R1, 'all')).toEqual({ sessions: 7, host: 'review-bot' });
    expect(await h.on('publish:backfillCount', BW, R2, 1_000)).toEqual({ sessions: 7, host: 'ops' });
    expect(h.order).toEqual([`count ${BW} 0..5000`, `count ${BW} 1000..6000`]);
  });

  it('inside exclusive: resets the cursor first, then lowers only that target’s floor; then bumps', async () => {
    fresh();
    const h = harness(async () => 0);
    expect(await h.on('publish:backfill', BW, R1, 2_000)).toEqual({ sessions: 7 });
    expect(h.order).toEqual([
      `exclusive ${BW}`, `count ${BW} 2000..5000`, `reset ${BW}>${R1}`,
      `write ${BW} ${JSON.stringify({ to: [R1, R2], since: { [R1]: 5_000, [R2]: 6_000 }, from: { [R1]: 2_000 } })}`,
      `released ${BW}`, `bump ${BW}`
    ]);
    expect(store.get(BW)?.publish?.from).toEqual({ [R1]: 2_000 });
  });

  it('only widens: a date at or after the floor, or a repeat of the same date, is refused and writes nothing', async () => {
    fresh();
    const h = harness(async () => 0);
    await expect(h.on('publish:backfill', BW, R1, 5_000)).rejects.toThrow(/earlier/);
    await expect(h.on('publish:backfill', BW, R1, 9_999_999)).rejects.toThrow(/earlier/);
    await expect(h.on('publish:backfillCount', BW, R1, 5_000)).rejects.toThrow(/earlier/);
    await h.on('publish:backfill', BW, R1, 'all');
    h.order.length = 0;
    await expect(h.on('publish:backfill', BW, R1, 'all')).rejects.toThrow(/earlier/);
    await expect(h.on('publish:backfill', BW, R1, 1_000)).rejects.toThrow(/earlier/);
    expect(h.order.filter((o) => o.startsWith('write') || o.startsWith('reset'))).toEqual([]);
  });

  it('refuses a bad workspace, a target that is not on, a non-remote target and a malformed date', async () => {
    fresh();
    const h = harness(async () => 0);
    const OTHER = '01JC00000000000000000000R3';
    store.set(OTHER, m(OTHER, { kind: 'remote', remote: { url: 'http://three', tier: 'read', login: 'a', checkedAt: 1 } }));
    for (const ch of ['publish:backfillCount', 'publish:backfill']) {
      await expect(h.on(ch, 'loadout-source:x', R1, 'all')).rejects.toThrow(/workspace id/);
      await expect(h.on(ch, R1, R1, 'all')).rejects.toThrow(/local or container/);
      await expect(h.on(ch, BW, OTHER, 'all')).rejects.toThrow(/not on/);
      await expect(h.on(ch, BW, 'nope', 'all')).rejects.toThrow(/target/);
      await expect(h.on(ch, BW, R1, '2026-01-01')).rejects.toThrow(/start date/);
      await expect(h.on(ch, BW, R1, -5)).rejects.toThrow(/start date/);
    }
    store.set(BW, m(BW, { kind: 'container', publish: { to: [BW], since: { [BW]: 5 } } }));
    await expect(h.on('publish:backfill', BW, BW, 'all')).rejects.toThrow(/remote/);
    expect(h.order).toEqual([]);
  });
});
