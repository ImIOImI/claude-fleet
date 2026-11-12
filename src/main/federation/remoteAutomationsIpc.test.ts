import { describe, expect, it } from 'vitest';
import { createFederatedReader } from './federatedReader.js';
import { actionError, registerRemoteAutomationsIpc } from './remoteAutomationsIpc.js';
import { RemoteError } from '../remoteClient.js';
import type { RemoteSourceInfo } from '../remote.js';

const O = '01JC0000000000000000000000';
const DOWN = '01JC000000000000000000000D';
const RID = '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';
const src = (id: string, state: RemoteSourceInfo['state'], tier: RemoteSourceInfo['tier'] = 'steer'): RemoteSourceInfo => ({ id, url: `http://${id}`, name: id === O ? 'review-bot' : 'down-bot', hue: 200, tier, state });

function setup(reply: (url: string, channel: string, args: unknown[]) => unknown) {
  const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const calls: Array<[string, string, unknown[], number]> = [];
  const reader = createFederatedReader({
    sources: () => [src(O, 'running'), src(DOWN, 'unreachable')],
    rpc: async (url, channel, args, timeoutMs) => { calls.push([url, channel, args, timeoutMs]); return reply(url, channel, args); }
  });
  registerRemoteAutomationsIpc({ handle: (ch: string, fn: (...a: unknown[]) => Promise<unknown>) => void handlers.set(ch, (...a) => fn({}, ...a)) } as never, reader);
  return { invoke: (ch: string, ...a: unknown[]) => handlers.get(ch)!(...a), calls };
}

describe('remote automations IPC', () => {
  it('federates the list: rows carry origin, name, hue and tier; an unreachable host is listed as unavailable and never asked', async () => {
    const { invoke, calls } = setup(() => ({ rows: [] }));
    const r = await invoke('remoteInbox:list', { status: 'open' }) as { items: unknown[]; unavailable: unknown[] };
    expect(r.unavailable).toEqual([{ origin: DOWN, name: 'down-bot', reason: 'unreachable' }]);
    expect(calls.map((c) => c[0])).toEqual([`http://${O}`]);
    expect(calls[0].slice(1, 3)).toEqual(['inbox:list', [{ status: 'open', limit: 200 }]]);
  });

  it('a malformed envelope makes the source unavailable (protocol)', async () => {
    const { invoke } = setup(() => ({ rows: 'nope' }));
    const r = await invoke('remoteAutomations:list') as { unavailable: Array<{ reason: string }> };
    expect(r.unavailable.map((u) => u.reason).sort()).toEqual(['protocol', 'unreachable']);
  });

  it('actions go to one host with the request id and a 15 s bound, and replies are validated', async () => {
    const { invoke, calls } = setup(() => ({ replayed: false, result: { runId: 'R', status: 'running' }, error: null }));
    const r = await invoke('remoteAutomations:run', O, '01JC0000000000000000000001', { since: '1h' }, RID);
    expect(r).toEqual({ ok: true, replayed: false, result: { runId: 'R', status: 'running' } });
    expect(calls[0]).toEqual([`http://${O}`, 'automations:run', [{ requestId: RID, id: '01JC0000000000000000000001', args: { since: '1h' } }], 15_000]);
  });

  it('a stored host error is a failed result, not a throw', async () => {
    const { invoke } = setup(() => ({ replayed: true, result: null, error: 'nightly is disabled in the host config' }));
    expect(await invoke('remoteInbox:update', O, '01JC0000000000000000000002', { status: 'done' }, RID))
      .toEqual({ ok: false, kind: 'failed', message: 'nightly is disabled in the host config' });
  });

  it('refuses bad arguments in main before any network call', async () => {
    const { invoke, calls } = setup(() => null);
    await expect(invoke('remoteAutomations:run', 'nope', '01JC0000000000000000000001', {}, RID)).rejects.toThrow(/origin/);
    await expect(invoke('remoteAutomations:run', O, '01JC0000000000000000000001', {}, 'not-a-uuid')).rejects.toThrow(/requestId/);
    await expect(invoke('remoteInbox:update', O, '01JC0000000000000000000002', { source: 'x' }, RID)).rejects.toThrow(/patch/);
    expect(calls).toEqual([]);
  });

  it('registers no remote draft or askChange channel (D127)', () => {
    const chans: string[] = [];
    registerRemoteAutomationsIpc({ handle: (ch: string) => void chans.push(ch) } as never, createFederatedReader({ sources: () => [], rpc: async () => null }));
    expect(chans.filter((c) => /draft|askChange/i.test(c))).toEqual([]);
    expect(chans).toContain('remoteAutomations:run');
  });

  it('an action on an unreachable host is unavailable without a call', async () => {
    const { invoke, calls } = setup(() => null);
    expect(await invoke('remoteProposals:reject', DOWN, '01JC0000000000000000000003', null, RID)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(calls).toEqual([]);
  });

  it('counts sum across hosts and list the unavailable', async () => {
    const { invoke } = setup(() => ({ open: 2, urgent: 1, high: 0, approvals: 3 }));
    expect(await invoke('remoteInbox:counts')).toEqual({ open: 2, urgent: 1, high: 0, approvals: 3, unavailable: [{ origin: DOWN, name: 'down-bot', reason: 'unreachable' }] });
  });

  it('maps host refusals to kinds', () => {
    expect(actionError(new RemoteError('forbidden', 'forbidden: needs steer', 403))).toEqual({ kind: 'forbidden', message: 'forbidden: needs steer' });
    expect(actionError(new RemoteError('protocol', 'x answered 400: id must be an id', 400)).kind).toBe('invalid');
    expect(actionError(new RemoteError('unreachable', 'x is busy', 429)).kind).toBe('busy');
    expect(actionError(new RemoteError('standby', 'standby', 503)).kind).toBe('unavailable');
    expect(actionError(new Error('boom')).kind).toBe('failed');
  });

  it('an unsettled replay comes back as a replayed success with no result (terminal for the intent), not an error', async () => {
    const { invoke, calls } = setup(() => ({ replayed: true, result: null, error: null }));
    expect(await invoke('remoteAutomations:run', O, '01JC0000000000000000000001', {}, RID)).toEqual({ ok: true, replayed: true, result: null });
    expect(calls).toHaveLength(1);
  });

  it('a 429 is busy and carries Retry-After; a 503 is unavailable and is sent once', async () => {
    const busy = setup(() => { throw new RemoteError('unreachable', 'busy', 429, 7_000); });
    expect(await busy.invoke('remoteInbox:create', O, { title: 'x' }, RID)).toEqual({ ok: false, kind: 'busy', message: 'the host is busy; try again shortly', retryAfterMs: 7_000 });
    expect(busy.calls).toHaveLength(1);
    const down = setup(() => { throw new RemoteError('unreachable', 'automations unavailable', 503); });
    expect(await down.invoke('remoteAutomations:run', O, '01JC0000000000000000000001', {}, RID)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(down.calls).toHaveLength(1);
  });

  it('a malformed action reply is never a success; the request went out, so the id is kept (unavailable)', async () => {
    const { invoke } = setup(() => ({ replayed: 'yes', result: { runId: 'R' }, error: null }));
    expect(await invoke('remoteAutomations:run', O, '01JC0000000000000000000001', {}, RID)).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('an action to an origin that is not bookmarked is unavailable without a call', async () => {
    const { invoke, calls } = setup(() => ({ replayed: false, result: null, error: null }));
    expect(await invoke('remoteInbox:update', '01JC000000000000000000000Q', '01JC0000000000000000000002', { status: 'done' }, RID)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(calls).toEqual([]);
  });

  it('forwards only allowlisted, well-typed fields', async () => {
    const { invoke, calls } = setup(() => ({ replayed: false, result: { id: 'T' }, error: null }));
    await invoke('remoteInbox:create', O, { title: ' disk ', priority: 'high', workspaceId: 'x', source: { kind: 'workspace' } }, RID);
    await invoke('remoteInbox:update', O, '01JC0000000000000000000002', { status: 'done', tagsAdd: ['a'], title: ' t ' }, RID);
    await invoke('remoteAutomations:run', O, '01JC0000000000000000000001', { a: 1, c: 'x' }, RID);
    expect(calls.map((c) => c[2][0])).toEqual([
      { requestId: RID, input: { title: 'disk', priority: 'high' } },
      { requestId: RID, id: '01JC0000000000000000000002', patch: { status: 'done', tagsAdd: ['a'], title: 't' } },
      { requestId: RID, id: '01JC0000000000000000000001', args: { a: 1, c: 'x' } }
    ]);
    await expect(invoke('remoteInbox:update', O, '01JC0000000000000000000002', { status: 'gone' }, RID)).rejects.toThrow(/status/);
    await expect(invoke('remoteInbox:update', O, '01JC0000000000000000000002', { tagsAdd: [1] }, RID)).rejects.toThrow(/tags/);
    await expect(invoke('remoteInbox:create', O, { title: 'x', priority: 'meh' }, RID)).rejects.toThrow(/priority/);
    await expect(invoke('remoteInbox:create', O, { title: '   ' }, RID)).rejects.toThrow(/title/);
    await expect(invoke('remoteProposals:reject', O, '01JC0000000000000000000003', 5, RID)).rejects.toThrow(/note/);
    await expect(invoke('remoteInbox:list', { status: 'everything' })).rejects.toThrow(/status/);
    expect(calls).toHaveLength(3);
  });

  it('refuses a bad run arg value or an over-long key instead of silently dropping it', async () => {
    const { invoke, calls } = setup(() => ({ replayed: false, result: null, error: null }));
    await expect(invoke('remoteAutomations:run', O, '01JC0000000000000000000001', { b: { deep: 1 } }, RID)).rejects.toThrow(/args\.b must be a string/);
    await expect(invoke('remoteAutomations:run', O, '01JC0000000000000000000001', { [`k${'x'.repeat(65)}`]: 1 }, RID)).rejects.toThrow(/args key must be at most 64/);
    expect(calls).toEqual([]);
  });

  it('reads: rows get origin info; get answers null for an unknown or down host', async () => {
    const todo = {
      id: '01JC0000000000000000000002', title: 't', body: null, status: 'open', priority: 'high', source: { kind: 'user', id: 'ann' }, sourceRunId: null,
      viaWorkspace: null, dedupeKey: null, seenCount: 1, recurred: false, workspaceId: O, sessionId: null, tags: [], createdAt: 1, updatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, closedAt: null
    };
    const { invoke, calls } = setup((_u, ch) => (ch === 'inbox:get' ? { todo, events: [] } : { rows: [todo] }));
    const list = await invoke('remoteInbox:list') as { items: Array<Record<string, unknown>> };
    expect(list.items[0]).toMatchObject({ id: todo.id, origin: O, workspaceName: 'review-bot', workspaceColorHue: 200, tier: 'steer' });
    expect(calls[0][2]).toEqual([{ status: 'open', limit: 200 }]);
    expect(await invoke('remoteInbox:get', O, todo.id)).toMatchObject({ todo: { id: todo.id, origin: O }, events: [] });
    expect(await invoke('remoteInbox:get', DOWN, todo.id)).toBeNull();
    expect(await invoke('remoteInbox:get', '01JC000000000000000000000Q', todo.id)).toBeNull();
    await expect(invoke('remoteInbox:get', O, 'x')).rejects.toThrow(/id/);
  });
});
