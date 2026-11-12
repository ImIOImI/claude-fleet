import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { RemoteActionResult } from '../../preload/remoteAutomations';
import {
  actionGate, actionMessage, configEntryYaml, intentKeys, intentRunner, remoteSourceLabel, rowKey, sortRemoteAutomations, sortRemoteTodos,
  stableFingerprint
} from './remoteAutomationsView';

const O = '01JC0000000000000000000000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FP = 'fp';

describe('remote automations view helpers', () => {
  it('gates steer actions with a tooltip naming the tier (display only)', () => {
    expect(actionGate('read', 'review-bot')).toBe('Needs steer on review-bot; you have read');
    expect(actionGate(null, 'review-bot')).toBe("Needs steer on review-bot; your tier isn't known yet");
    expect(actionGate('steer', 'review-bot')).toBeNull();
    expect(actionGate('session', 'review-bot')).toBeNull();
  });

  it('keeps one request id per intent until it settles; unavailable and busy keep it for the retry', () => {
    const k = intentKeys();
    const a = k.idFor('run:x', FP);
    expect(k.idFor('run:x', FP)).toBe(a);
    k.settle('run:x', { ok: false, kind: 'unavailable', message: 'down' });
    expect(k.idFor('run:x', FP)).toBe(a);
    k.settle('run:x', { ok: false, kind: 'busy', message: 'busy' });
    expect(k.idFor('run:x', FP)).toBe(a);
    k.settle('run:x', { ok: true, replayed: false, result: null });
    expect(k.has('run:x')).toBe(false);
    expect(k.idFor('run:x', FP)).not.toBe(a);
    expect(a).toMatch(UUID_V4);
  });

  it('an unsettled replay is terminal for the intent: the id is dropped and the next click mints a new one', () => {
    const k = intentKeys();
    const a = k.idFor('run:x', FP);
    k.settle('run:x', { ok: true, replayed: true, result: null });
    expect(k.has('run:x')).toBe(false);
    expect(k.idFor('run:x', FP)).not.toBe(a);
  });

  it('forbidden, invalid and failed also settle the intent', () => {
    for (const kind of ['forbidden', 'invalid', 'failed'] as const) {
      const k = intentKeys();
      const a = k.idFor('x', FP);
      k.settle('x', { ok: false, kind, message: 'm' });
      expect(k.idFor('x', FP)).not.toBe(a);
    }
  });

  it('busy with Retry-After holds the intent until then', () => {
    let now = 1_000;
    const k = intentKeys(() => now);
    k.idFor('x', FP);
    k.settle('x', { ok: false, kind: 'busy', message: 'busy', retryAfterMs: 5_000 });
    expect(k.waitMs('x')).toBe(5_000);
    now += 4_000;
    expect(k.waitMs('x')).toBe(1_000);
    now += 1_000;
    expect(k.waitMs('x')).toBe(0);
  });

  it('a different payload under the same key gets a new id, even while the old one is held for retry', () => {
    const k = intentKeys();
    const fp1 = stableFingerprint({ status: 'done' });
    const a = k.idFor('todo:T', fp1);
    // The write timed out; it may have committed on the host. The retry (same payload) must reuse the id.
    k.settle('todo:T', { ok: false, kind: 'unavailable', message: 'No answer from review-bot in 15 s' });
    expect(k.idFor('todo:T', fp1)).toBe(a);
    // The user now sends a different patch under the same intent key: a fresh id, so the late first
    // reply (if it lands) can never be mistaken for this one.
    const fp2 = stableFingerprint({ status: 'dismissed' });
    const b = k.idFor('todo:T', fp2);
    expect(b).not.toBe(a);
    expect(k.idFor('todo:T', fp2)).toBe(b);
  });

  it('stableFingerprint is insensitive to key order but sensitive to value changes', () => {
    expect(stableFingerprint({ a: 1, b: 2 })).toBe(stableFingerprint({ b: 2, a: 1 }));
    expect(stableFingerprint({ a: 1, b: 2 })).not.toBe(stableFingerprint({ a: 1, b: 3 }));
    expect(stableFingerprint({ a: [1, { x: 1, y: 2 }] })).toBe(stableFingerprint({ a: [1, { y: 2, x: 1 }] }));
  });

  it('messages: an unsettled replay says to check; a settled replay says already sent; errors say why', () => {
    expect(actionMessage({ ok: true, replayed: true, result: null })).toBe('Already sent — check Runs/Inbox');
    expect(actionMessage({ ok: true, replayed: true, result: { runId: 'R' } })).toBe('Already sent');
    expect(actionMessage({ ok: true, replayed: false, result: {} })).toBeNull();
    expect(actionMessage({ ok: false, kind: 'forbidden', message: 'forbidden: needs steer' })).toBe('forbidden: needs steer');
  });

  it('labels remote sources by login, operator, workspace or automation', () => {
    const names = { [O]: 'review-bot' };
    expect(remoteSourceLabel({ kind: 'user', id: 'ann' }, O, names)).toBe('@ann');
    expect(remoteSourceLabel({ kind: 'user', id: null }, O, names)).toBe('host operator');
    expect(remoteSourceLabel({ kind: 'workspace', id: O }, O, names)).toBe('review-bot');
    expect(remoteSourceLabel({ kind: 'automation', id: 'A' }, O, names)).toBe('automation');
  });

  it('the host config entry writes the hosted id back as $self', () => {
    const def = { name: 'triage', triggers: [{ manual: { allowFrom: [O] } }], steps: [{ id: 'go', prompt: { workspace: O, mode: 'fresh' as const, message: 'hi' } }] };
    const entry = parse(configEntryYaml(def, O));
    expect(entry).toEqual([{ definition: { ...def, triggers: [{ manual: { allowFrom: ['$self'] } }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: 'hi' } }] }, enabled: true }]);
    expect(def.steps[0].prompt.workspace).toBe(O);
  });

  it('sorts remote todos urgent first, then most recently seen', () => {
    const t = (id: string, priority: string, lastSeenAt: number) => ({ id, priority, lastSeenAt }) as never;
    expect(sortRemoteTodos([t('a', 'low', 9), t('b', 'urgent', 1), t('c', 'urgent', 5)]).map((x: { id: string }) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts remote automations by workspace then name; row keys pair origin and id', () => {
    const a = (workspaceName: string, name: string) => ({ workspaceName, name }) as never;
    expect(sortRemoteAutomations([a('b', 'x'), a('a', 'z'), a('a', 'y')]).map((x: { name: string }) => x.name)).toEqual(['y', 'z', 'x']);
    expect(rowKey(O, 'T')).toBe(`${O}:T`);
  });
});

describe('intentRunner', () => {
  const ok: RemoteActionResult<{ id: string }> = { ok: true, replayed: false, result: { id: 'T' } };

  it('a double click shares the in-flight request: one send, one id', async () => {
    const r = intentRunner();
    const ids: string[] = [];
    let release!: () => void;
    const send = (id: string) => { ids.push(id); return new Promise<typeof ok>((res) => { release = () => res(ok); }); };
    const p1 = r.run('k', FP, send);
    const p2 = r.run('k', FP, send);
    expect(r.busy('k')).toBe(true);
    release();
    expect(await p1).toEqual(ok);
    expect(await p2).toEqual(ok);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(UUID_V4);
    expect(r.busy('k')).toBe(false);
  });

  it('a retry after unavailable reuses the id; the next deliberate click after success mints a new one', async () => {
    const r = intentRunner();
    const ids: string[] = [];
    await r.run('k', FP, async (id) => { ids.push(id); return { ok: false, kind: 'unavailable', message: 'down' }; });
    await r.run('k', FP, async (id) => { ids.push(id); return ok; });
    await r.run('k', FP, async (id) => { ids.push(id); return ok; });
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it('never auto-retries: each run sends at most once, whatever the reply', async () => {
    for (const reply of [
      { ok: false, kind: 'unavailable', message: 'automations unavailable' },
      { ok: false, kind: 'busy', message: 'busy' },
      { ok: true, replayed: true, result: null }
    ] as RemoteActionResult<unknown>[]) {
      let sends = 0;
      await intentRunner().run('k', FP, async () => { sends++; return reply; });
      expect(sends).toBe(1);
    }
  });

  it('respects Retry-After: a click before it elapses is refused locally without a send', async () => {
    let now = 0;
    const r = intentRunner(intentKeys(() => now));
    let sends = 0;
    await r.run('k', FP, async () => { sends++; return { ok: false, kind: 'busy', message: 'busy', retryAfterMs: 3_000 }; });
    const early = await r.run('k', FP, async () => { sends++; return ok; });
    expect(early).toMatchObject({ ok: false, kind: 'busy', retryAfterMs: 3_000 });
    expect(sends).toBe(1);
    now = 3_000;
    expect(await r.run('k', FP, async () => { sends++; return ok; })).toEqual(ok);
    expect(sends).toBe(2);
  });

  it('a refusal thrown by main is an invalid result with the IPC prefix stripped', async () => {
    const r = intentRunner();
    const out = await r.run('k', FP, async () => { throw new Error("Error invoking remote method 'remoteInbox:update': Error: patch must be an object"); });
    expect(out).toEqual({ ok: false, kind: 'invalid', message: 'patch must be an object' });
    expect(r.busy('k')).toBe(false);
  });

  it('an update that times out and may have committed, then a different patch under the same key, gets a new id and sends again', async () => {
    const r = intentRunner();
    const ids: string[] = [];
    const fp1 = stableFingerprint({ status: 'done' });
    const fp2 = stableFingerprint({ status: 'dismissed' });
    const timedOut: RemoteActionResult<unknown> = { ok: false, kind: 'unavailable', message: 'No answer from review-bot in 15 s; it may have gone through.' };
    await r.run('todo:T', fp1, async (id) => { ids.push(id); return timedOut; });
    // A second click with the same payload while still unsettled would share the in-flight promise;
    // here it already settled (unavailable keeps the id for a same-payload retry).
    await r.run('todo:T', fp1, async (id) => { ids.push(id); return timedOut; });
    expect(ids[0]).toBe(ids[1]);
    await r.run('todo:T', fp2, async (id) => { ids.push(id); return ok; });
    expect(ids[2]).not.toBe(ids[1]);
    expect(ids[2]).toMatch(UUID_V4);
  });

  it('two different payloads under the same key never share an in-flight request, even concurrently', async () => {
    const r = intentRunner();
    const ids: string[] = [];
    let releaseFirst!: () => void;
    const first = r.run('todo:T', stableFingerprint({ status: 'done' }), (id) => {
      ids.push(id);
      return new Promise<RemoteActionResult<unknown>>((res) => { releaseFirst = () => res({ ok: false, kind: 'unavailable', message: 'timed out' }); });
    });
    const second = r.run('todo:T', stableFingerprint({ status: 'dismissed' }), async (id) => { ids.push(id); return ok; });
    expect(await second).toEqual(ok);
    releaseFirst();
    await first;
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
