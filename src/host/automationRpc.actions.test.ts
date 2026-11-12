import { describe, expect, it } from 'vitest';
import { automationRpcChannels, defaultLimiters } from './automationRpc.js';
import { fakeRuntime } from './testAutomationRuntime.js';
import { dispatchRpc } from './rpc.js';
import type { Principal } from './attachHub.js';

const A = '01JC0000000000000000000001';
const T = '01JC0000000000000000000002';
const P = '01JC0000000000000000000003';
const id = (n: number) => `${String(n).padStart(8, '0')}-4b1c-4c2a-9a0e-1f2e3d4c5b6a`;
const who = (tier: Principal['tier']): Principal => ({ identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier });

describe('automation action channels', () => {
  it('every action is 403 for a read caller and the runtime is never touched', async () => {
    const rt = fakeRuntime();
    const reg = automationRpcChannels(() => rt);
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['automations:run', { id: A }], ['automations:draft', { text: 'x' }], ['automations:askChange', { id: A, text: 'x' }],
      ['inbox:create', { input: { title: 't' } }], ['inbox:update', { id: T, patch: { status: 'done' } }], ['proposals:reject', { id: P, note: null }]
    ];
    for (const [ch, b] of bodies) {
      const r = await dispatchRpc(reg, ch, { args: [{ requestId: id(1), ...b }] }, who('read'));
      expect([ch, r.status]).toEqual([ch, 403]);
    }
    expect(rt.calls).toEqual([]);
  });

  it('Run now: one run per request id, attributed to the person, coerced, refused when disabled', async () => {
    const rt = fakeRuntime();
    const reg = automationRpcChannels(() => rt);
    const body = { args: [{ requestId: id(1), id: A, args: { since: '1h' } }] };
    const one = await dispatchRpc(reg, 'automations:run', body, who('steer'));
    const two = await dispatchRpc(reg, 'automations:run', body, who('steer'));
    expect(one.body).toEqual({ ok: true, result: { replayed: false, result: { runId: '01JC00000000000000000000RR', status: 'running' }, error: null } });
    expect((two.body as { result: { replayed: boolean } }).result.replayed).toBe(true);
    expect(rt.calls).toEqual([`run:${A}:{"kind":"manual","by":{"kind":"user","id":"ann"},"args":{"since":"1h"},"coerce":true}`]);

    const off = fakeRuntime({ automations: { ...rt.automations, get: async () => ({ automation: { id: A, name: 'nightly', enabled: false } as never, runs: [], yaml: '', versions: [] }) } });
    const r = await dispatchRpc(automationRpcChannels(() => off), 'automations:run', { args: [{ requestId: id(2), id: A }] }, who('steer'));
    expect(r.body).toEqual({ ok: true, result: { replayed: false, result: null, error: 'nightly is disabled in the host config' } });
  });

  it('run args are checked before claiming', async () => {
    const reg = automationRpcChannels(() => fakeRuntime());
    for (const args of [[1], { 'bad key': 'x' }, { x: { nested: 1 } }, { x: 'y'.repeat(2001) }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, 1]))]) {
      expect((await dispatchRpc(reg, 'automations:run', { args: [{ requestId: id(3), id: A, args }] }, who('steer'))).status).toBe(400);
    }
  });

  it('todo create and update carry the person and only the allowed fields', async () => {
    const rt = fakeRuntime();
    const reg = automationRpcChannels(() => rt);
    await dispatchRpc(reg, 'inbox:create', { args: [{ requestId: id(4), input: { title: 'look', priority: 'high', source: { kind: 'workspace', id: 'x' } } }] }, who('steer'));
    await dispatchRpc(reg, 'inbox:update', { args: [{ requestId: id(5), id: T, patch: { status: 'done' } }] }, who('steer'));
    expect(rt.calls).toEqual([
      'create:{"title":"look","priority":"high"}:{"kind":"user","id":"ann"}',
      `update:${T}:{"status":"done"}:{"kind":"user","id":"ann"}`
    ]);
    for (const patch of [{}, { status: 'gone' }, { source: 'x' }, { tagsAdd: Array(21).fill('a') }, { bodyAppend: 'x'.repeat(2001) }]) {
      expect((await dispatchRpc(reg, 'inbox:update', { args: [{ requestId: id(6), id: T, patch }] }, who('steer'))).status).toBe(400);
    }
  });

  it('a double-clicked Mark done or Reject applies once', async () => {
    const rt = fakeRuntime();
    const reg = automationRpcChannels(() => rt);
    const done = { args: [{ requestId: id(7), id: T, patch: { status: 'done' } }] };
    const rej = { args: [{ requestId: id(8), id: P, note: 'too often' }] };
    await Promise.all([dispatchRpc(reg, 'inbox:update', done, who('steer')), dispatchRpc(reg, 'inbox:update', done, who('steer'))]);
    await Promise.all([dispatchRpc(reg, 'proposals:reject', rej, who('steer')), dispatchRpc(reg, 'proposals:reject', rej, who('steer'))]);
    expect(rt.calls.filter((c) => c.startsWith('update:'))).toHaveLength(1);
    expect(rt.calls.filter((c) => c.startsWith('reject:'))).toEqual([`reject:${P}:too often`]);
  });

  it('Run now is limited to 6 a minute per identity', async () => {
    const reg = automationRpcChannels(() => fakeRuntime(), { limiters: defaultLimiters() });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await dispatchRpc(reg, 'automations:run', { args: [{ requestId: id(100 + i), id: A }] }, who('steer'))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});
