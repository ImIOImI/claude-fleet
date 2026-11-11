import { describe, expect, it } from 'vitest';
import { automationRpcChannels, type AutomationRuntime } from './automationRpc.js';
import { fakeRuntime } from './testAutomationRuntime.js';
import { dispatchRpc } from './rpc.js';
import type { Principal } from './attachHub.js';

const A = '01JC0000000000000000000001';
const T = '01JC0000000000000000000002';
const reader: Principal = { identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier: 'read' };

const call = (rt: AutomationRuntime | null, ch: string, args: unknown[], who: Principal = reader) =>
  dispatchRpc(automationRpcChannels(() => rt), ch, { args }, who);

describe('automation read channels', () => {
  it('serve read callers and wrap lists in { rows }', async () => {
    const rt = fakeRuntime();
    expect((await call(rt, 'automations:list', [])).body).toEqual({ ok: true, result: { rows: [{ id: A, name: 'nightly', enabled: true }] } });
    expect((await call(rt, 'automations:get', [A])).body).toMatchObject({ ok: true, result: { yaml: 'name: nightly\n', runs: [] } });
    expect((await call(rt, 'automations:get', ['01JC0000000000000000000009'])).body).toEqual({ ok: true, result: null });
    expect((await call(rt, 'inbox:counts', [])).body).toEqual({ ok: true, result: { open: 1, urgent: 0, high: 0, approvals: 2 } });
    expect((await call(rt, 'proposals:list', [])).body).toEqual({ ok: true, result: { rows: [] } });
  });

  it('get drops the versions list and inbox:get keeps the newest 100 events', async () => {
    const rt = fakeRuntime();
    const g = (await call(rt, 'automations:get', [A])).body as { result: Record<string, unknown> };
    expect('versions' in g.result).toBe(false);
    const t = (await call(rt, 'inbox:get', [T])).body as { result: { events: Array<{ id: number }> } };
    expect(t.result.events).toHaveLength(100);
    expect(t.result.events[0].id).toBe(50);
  });

  it('parses inbox:list strictly: status from the set, limit clamped to 1–200, nothing else passes', async () => {
    const rt = fakeRuntime();
    await call(rt, 'inbox:list', [{ status: 'all', limit: 999, visibleTo: 'x', tags: ['a'] }]);
    await call(rt, 'inbox:list', []);
    expect(rt.calls).toEqual(['list:{"status":"all","limit":200}', 'list:{"status":"open","limit":200}']);
    expect((await call(rt, 'inbox:list', [{ status: 'nope' }])).status).toBe(400);
  });

  it('refuses malformed ids with 400 and answers 503 without a holder', async () => {
    expect((await call(fakeRuntime(), 'automations:get', ['../x'])).status).toBe(400);
    expect((await call(fakeRuntime(), 'inbox:get', [42])).status).toBe(400);
    expect(await call(null, 'automations:list', [])).toEqual({ status: 503, body: { ok: false, error: 'automations unavailable' } });
  });

  it('caps lists at the federated read limits', async () => {
    const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
    const rt = fakeRuntime({
      automations: { ...fakeRuntime().automations, list: async () => many(150, (i) => ({ id: String(i) }) as never) },
      proposals: { ...fakeRuntime().proposals, list: async () => many(150, (i) => ({ id: String(i) }) as never) },
      inbox: { ...fakeRuntime().inbox, list: async () => many(300, (i) => ({ id: String(i) }) as never) }
    });
    const rows = async (ch: string) => ((await call(rt, ch, [])).body as { result: { rows: unknown[] } }).result.rows.length;
    expect([await rows('automations:list'), await rows('proposals:list'), await rows('inbox:list')]).toEqual([100, 100, 200]);
  });

  it('notices:feed parses its cursor strictly', async () => {
    const seen: unknown[] = [];
    const rt = fakeRuntime({ notices: { feed: async (q) => { seen.push(q); return []; } } });
    expect((await call(rt, 'notices:feed', [{ sinceTs: 5, limit: 1000 }])).body).toEqual({ ok: true, result: { rows: [] } });
    await call(rt, 'notices:feed', []);
    expect(seen).toEqual([{ sinceTs: 5, limit: 100 }, { sinceTs: null, limit: 100 }]);
    for (const q of [{ sinceTs: -1 }, { sinceTs: '5' }, { sinceTs: 1.5 }, 'x', [1]]) expect((await call(rt, 'notices:feed', [q])).status).toBe(400);
  });

  it('inbox:list refuses a non-object filter', async () => {
    for (const f of ['open', 3, [1]]) expect((await call(fakeRuntime(), 'inbox:list', [f])).status).toBe(400);
  });

  it('drafting answers 503 for a steer caller until it is available on the host', async () => {
    const rt = fakeRuntime();
    const steer: Principal = { ...reader, tier: 'steer' };
    for (const ch of ['automations:draft', 'automations:askChange']) {
      expect((await call(rt, ch, [{ requestId: '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a', id: A, text: 'x' }], steer)).status).toBe(503);
    }
    expect(rt.calls).toEqual([]);
  });

  it('declares read on every read channel and steer on every action channel', () => {
    const reg = automationRpcChannels(() => null);
    const tiers = Object.fromEntries([...reg].map(([k, v]) => [k, v.tier]));
    expect(tiers).toEqual({
      'automations:list': 'read', 'automations:get': 'read', 'inbox:list': 'read', 'inbox:get': 'read', 'inbox:counts': 'read',
      'proposals:list': 'read', 'notices:feed': 'read',
      'automations:run': 'steer', 'automations:draft': 'steer', 'automations:askChange': 'steer',
      'inbox:create': 'steer', 'inbox:update': 'steer', 'proposals:reject': 'steer'
    });
  });
});
