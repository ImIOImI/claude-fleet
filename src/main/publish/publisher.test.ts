import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '../remoteClient.js';
import type { PublishBatch } from './protocol.js';
import { PUBLISH_BACKOFF_MS, PUBLISH_BUSY_RETRY_MS, PUBLISH_SIGNED_OUT_MS, startPublisher, type PublisherDeps, type PublisherLog, type PublisherManifest } from './publisher.js';
import type { ScrubbedLine } from './scrub.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const SRC = '01JC0000000000000000000005';
const OFF = '01JC0000000000000000000006';
const R1 = '01JC00000000000000000000R1';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '22222222-2222-4333-8444-555555555555';
const msg = (c: string) => JSON.stringify({ type: 'user', message: { content: c } });
const local = (id: string, to: string[]): PublisherManifest =>
  ({ id, kind: 'local', createdAt: 1, env: { plain: {}, secretKeys: [] }, publish: to.length ? { to, since: Object.fromEntries(to.map((t) => [t, 5_000])) } : undefined });
const remote = (id: string, createdAt = 1, url = 'http://host'): PublisherManifest =>
  ({ id, kind: 'remote', createdAt, env: { plain: {}, secretKeys: [] }, remote: { url, tier: 'read', login: 'ann', checkedAt: 1 } });
interface Row { ws: string; id: number; sessionId: string; rawJsonl: string; started: number | null }
const BASE_ROWS: Row[] = [
  { ws: SRC, id: 1, sessionId: S1, rawJsonl: msg('before opt-in'), started: 4_000 },
  { ws: SRC, id: 2, sessionId: S2, rawJsonl: msg(`uses vault-secret-1 and ghp_${'A'.repeat(36)}`), started: 6_000 },
  { ws: SRC, id: 3, sessionId: S2, rawJsonl: msg('second'), started: 6_000 },
  { ws: OFF, id: 4, sessionId: S1, rawJsonl: msg('not opted in'), started: 6_000 }
];

function rig(o: {
  manifests?: PublisherManifest[]; publish?: PublisherDeps['publish']; secrets?: PublisherDeps['secretValues'];
  withheld?: string[]; schedule?: PublisherDeps['schedule']; rows?: Row[]; page?: number; cursors?: Map<string, number>;
  setCursor?: PublisherDeps['setCursor']; eventsError?: () => Error | null; beforeWithheld?: () => Promise<void>;
} = {}) {
  const sent: Array<{ url: string; batch: PublishBatch<ScrubbedLine> }> = [];
  const cursors = o.cursors ?? new Map<string, number>();
  let manifests = o.manifests ?? [local(SRC, [R1]), local(OFF, []), remote(R1)];
  const withheld = new Set(o.withheld ?? []);
  const reads: Array<{ after: number; n: number }> = [];
  const timers: Array<() => void> = [];
  const logs: PublisherLog[] = [];
  const eventsFor: string[] = [];
  const rows = o.rows ?? [...BASE_ROWS];
  let t = 10_000;
  const publish = vi.fn(async (url: string, batch: PublishBatch<ScrubbedLine>) => {
    const ack = o.publish ? await o.publish(url, batch) : { ok: true as const, accepted: batch.events.length, inserted: batch.events.length };
    sent.push({ url, batch });
    return ack;
  });
  const p = startPublisher({
    manifests: async () => manifests,
    publish,
    secretValues: o.secrets ?? (async () => [{ key: 'API_TOKEN', value: 'vault-secret-1' }]),
    events: async (ws, after, limit) => {
      eventsFor.push(ws);
      const err = o.eventsError?.();
      if (err) throw err;
      const out = rows.filter((r) => r.ws === ws && r.id > after).sort((a, b) => a.id - b.id).slice(0, limit)
        .map(({ id, sessionId, rawJsonl, started }) => ({ id, sessionId, rawJsonl, startedAt: started }));
      reads.push({ after, n: out.length });
      return out;
    },
    getCursor: async (s, tg) => cursors.get(`${s}>${tg}`) ?? 0,
    setCursor: o.setCursor ?? (async (s, tg, id) => void cursors.set(`${s}>${tg}`, id)),
    withheld: async () => {
      const snapshot = new Set(withheld);
      await o.beforeWithheld?.();
      return snapshot;
    },
    log: (e) => void logs.push(e),
    now: () => t,
    schedule: o.schedule ?? ((fn) => { timers.push(fn); return () => undefined; })
  }, { page: o.page });
  const texts = () => sent.flatMap((x) => x.batch.events.map((l) => JSON.parse(l).message.content as string));
  return {
    texts, p, sent, publish, cursors, logs, eventsFor, rows, reads, withheld, timers,
    setManifests: (m: PublisherManifest[]) => void (manifests = m),
    advance: (ms: number) => void (t += ms),
    /** One bump-triggered pass, run to completion. */
    bumpNow: async (ws = SRC) => {
      p.bump(ws);
      timers.pop()!();
      await new Promise((ok) => setTimeout(ok, 0));
      await p.drain(ws);
    }
  };
}

describe('startPublisher', () => {
  it('publishes only opted-in workspaces, only sessions started since, scrubbed, and moves past what it read', async () => {
    const r = rig();
    await r.p.sweep();
    expect(r.eventsFor).toEqual([SRC]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].url).toBe('http://host');
    expect(r.sent[0].batch.sessionId).toBe(S2);
    expect(r.texts()).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'second']);
    expect(JSON.stringify(r.sent)).not.toContain('vault-secret-1');
    expect(JSON.stringify(r.sent)).not.toContain('ghp_');
    await r.bumpNow();
    expect(r.reads.at(-1)).toEqual({ after: 3, n: 0 });
    await r.p.sweep();
    expect(r.sent).toHaveLength(1);
  });

  it('sends nothing for a target that is not a bookmarked remote workspace', async () => {
    const r = rig({ manifests: [local(SRC, [R1])] });
    await r.p.sweep();
    expect(r.sent).toEqual([]);
  });

  it('sends nothing from a remote bookmark or for a target without a since', async () => {
    const noSince: PublisherManifest = { ...local(SRC, [R1]), publish: { to: [R1], since: {} } };
    const fromRemote: PublisherManifest = { ...remote(OFF), publish: { to: [R1], since: { [R1]: 1 } } };
    const r = rig({ manifests: [noSince, fromRemote, remote(R1)], rows: [...BASE_ROWS, { ws: OFF, id: 5, sessionId: S1, rawJsonl: msg('x'), started: 6_000 }] });
    await r.p.sweep();
    expect(r.eventsFor).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it('a bookmark forgotten and added again, or another host now claiming the id, gets nothing until the box is ticked again', async () => {
    for (const url of ['http://host', 'http://other']) {
      const r = rig({ manifests: [local(SRC, [R1]), remote(R1, 8_000, url)] });
      await r.p.sweep();
      await r.bumpNow();
      expect(r.eventsFor).toEqual([]);
      expect(r.sent).toEqual([]);
      r.setManifests([{ ...local(SRC, [R1]), publish: { to: [R1], since: { [R1]: 9_000 } } }, remote(R1, 8_000, url)]);
      r.rows.push({ ws: SRC, id: 7, sessionId: S1, rawJsonl: msg('after re-tick'), started: 9_500 });
      await r.p.sweep();
      expect(r.texts()).toEqual(['after re-tick']);
      expect(r.sent[0].url).toBe(url);
    }
  });

  it('a bookmark re-pointed to a new address keeps publishing there', async () => {
    const r = rig({ manifests: [local(SRC, [R1]), remote(R1, 1, 'http://moved')] });
    await r.p.sweep();
    expect(r.sent.map((x) => x.url)).toEqual(['http://moved']);
  });

  it('passes over history from before the opt-in once, then reads only new rows', async () => {
    const old = Array.from({ length: 1000 }, (_, i): Row => ({ ws: SRC, id: i + 1, sessionId: S1, rawJsonl: msg(`old ${i}`), started: 4_000 }));
    const r = rig({ rows: old });
    await r.bumpNow();
    expect(r.reads).toEqual([{ after: 0, n: 500 }, { after: 500, n: 500 }, { after: 1000, n: 0 }]);
    await r.bumpNow();
    expect(r.reads.slice(3)).toEqual([{ after: 1000, n: 0 }]);
    expect(r.sent).toEqual([]);
  });

  it('never sends the session in progress at opt-in, and doesn’t re-read it', async () => {
    const r = rig({ rows: [BASE_ROWS[0]] });
    for (let id = 2; id <= 4; id++) {
      r.rows.push({ ws: SRC, id, sessionId: S1, rawJsonl: msg(`still going ${id}`), started: 4_000 });
      await r.bumpNow();
    }
    expect(r.reads).toEqual([{ after: 0, n: 2 }, { after: 2, n: 1 }, { after: 3, n: 1 }]);
    expect(r.sent).toEqual([]);
  });

  it('never sends a withheld session but moves past it', async () => {
    const r = rig({ withheld: [S2] });
    await r.p.sweep();
    expect(r.sent).toEqual([]);
    await r.bumpNow();
    expect(r.reads.at(-1)).toEqual({ after: 3, n: 0 });
  });

  it('re-checks withheld before every batch, so a session withheld mid-page is not sent', async () => {
    const S3 = '33333333-2222-4333-8444-555555555555';
    const rows: Row[] = [...BASE_ROWS, { ws: SRC, id: 5, sessionId: S3, rawJsonl: msg('third'), started: 6_000 }];
    let calls = 0;
    const r = rig({ rows, publish: async (_u, b) => { if (calls++ === 0) r.withheld.add(S3); return { ok: true, accepted: b.events.length, inserted: 0 }; } });
    await r.p.sweep();
    expect(r.sent.map((x) => x.batch.sessionId)).toEqual([S2]);
  });

  it('idle waits for a running pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const r = rig({ publish: async (_u, b) => { await gate; return { ok: true, accepted: b.events.length, inserted: 0 }; } });
    const swept = r.p.sweep();
    await vi.waitFor(() => expect(r.publish).toHaveBeenCalledTimes(1));
    let idle = false;
    const waiting = r.p.idle(SRC).then(() => void (idle = true));
    await new Promise((ok) => setTimeout(ok, 5));
    expect(idle).toBe(false);
    await r.p.idle(OFF);
    release();
    await Promise.all([swept, waiting]);
    expect(r.sent).toHaveLength(1);
  });

  it('idle resolves once the send in flight finishes, even while bumps keep re-running slow passes', async () => {
    const gates: Array<() => void> = [];
    const r = rig({ publish: (_u, b) => new Promise((ok) => gates.push(() => ok({ ok: true, accepted: b.events.length, inserted: 0 }))) });
    const swept = r.p.sweep();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    r.rows.push({ ws: SRC, id: 5, sessionId: S2, rawJsonl: msg('more'), started: 6_000 });
    r.p.bump(SRC);
    r.timers.pop()!();
    await new Promise((ok) => setTimeout(ok, 0));
    let idle = false;
    const waiting = r.p.idle(SRC).then(() => void (idle = true));
    await new Promise((ok) => setTimeout(ok, 5));
    expect(idle).toBe(false);
    gates[0]();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    await Promise.race([waiting, new Promise((_, no) => setTimeout(() => no(new Error('idle did not resolve')), 500))]);
    expect(idle).toBe(true);
    gates[1]();
    await swept;
    await r.p.drain(SRC);
    expect(r.texts()).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'second', 'more']);
  });

  it('idle waits for a withheld re-check already under way, so a withhold that lands during it is never outrun', async () => {
    let releaseRead!: () => void;
    let reads = 0;
    const read = new Promise<void>((ok) => (releaseRead = ok));
    const order: string[] = [];
    const r = rig({
      beforeWithheld: async () => { if (++reads === 2) await read; },
      publish: async (_u, b) => { order.push('send'); return { ok: true, accepted: b.events.length, inserted: 0 }; }
    });
    const swept = r.p.sweep();
    await vi.waitFor(() => expect(reads).toBe(2));
    r.withheld.add(S2);
    const waiting = r.p.idle(SRC).then(() => void order.push('idle'));
    await new Promise((ok) => setTimeout(ok, 5));
    expect(order).toEqual([]);
    releaseRead();
    await Promise.all([swept, waiting]);
    expect(order).toEqual(['send', 'idle']);
  });

  it('opting out mid-page sends no further batch', async () => {
    const rows = Array.from({ length: 6 }, (_, i): Row => ({ ws: SRC, id: i + 1, sessionId: i % 2 ? S1 : S2, rawJsonl: msg(`n${i}`), started: 6_000 }));
    let r!: ReturnType<typeof rig>;
    r = rig({ rows, publish: async (_u, b) => { r.setManifests([local(SRC, []), remote(R1)]); r.cursors.delete(`${SRC}>${R1}`); return { ok: true, accepted: b.events.length, inserted: 0 }; } });
    await r.p.sweep();
    expect(r.reads).toHaveLength(1);
    expect(r.publish).toHaveBeenCalledTimes(1);
    expect(r.cursors.has(`${SRC}>${R1}`)).toBe(false);
  });

  it('opting out mid-backlog stops the pass and leaves the cursor deleted', async () => {
    const rows = Array.from({ length: 5 }, (_, i): Row => ({ ws: SRC, id: i + 1, sessionId: S2, rawJsonl: msg(`n${i}`), started: 6_000 }));
    let r!: ReturnType<typeof rig>;
    r = rig({ rows, page: 1, publish: async (_u, b) => { r.setManifests([local(SRC, []), remote(R1)]); r.cursors.delete(`${SRC}>${R1}`); return { ok: true, accepted: b.events.length, inserted: 0 }; } });
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    expect(r.cursors.has(`${SRC}>${R1}`)).toBe(false);
  });

  it('a pass whose target was turned off during its last page does not write the cursor back', async () => {
    let r!: ReturnType<typeof rig>;
    r = rig({ publish: async (_u, b) => { r.setManifests([local(SRC, []), remote(R1)]); r.cursors.delete(`${SRC}>${R1}`); return { ok: true, accepted: b.events.length, inserted: 0 }; } });
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    expect(r.cursors.has(`${SRC}>${R1}`)).toBe(false);
  });

  it('a sweep re-reads its window and publishes a row that committed late with a lower id', async () => {
    const r = rig({ rows: [{ ws: SRC, id: 2, sessionId: S2, rawJsonl: msg('two'), started: 6_000 }, { ws: SRC, id: 4, sessionId: S2, rawJsonl: msg('four'), started: 6_000 }] });
    await r.p.sweep();
    expect(r.texts()).toEqual(['two', 'four']);
    r.rows.push({ ws: SRC, id: 3, sessionId: S2, rawJsonl: msg('three, late'), started: 6_000 });
    await r.bumpNow();
    expect(r.texts()).toEqual(['two', 'four']);
    await r.p.sweep();
    expect(r.texts()).toEqual(['two', 'four', 'three, late']);
    await r.p.sweep();
    expect(r.sent).toHaveLength(2);
  });

  it('the window slides: a sweep re-reads from the live position two sweeps back, which is also the durable floor', async () => {
    const r = rig({ rows: [] });
    const add = (id: number) => r.rows.push({ ws: SRC, id, sessionId: S2, rawJsonl: msg(`r${id}`), started: 6_000 });
    const floors: number[] = [];
    for (const id of [1, 2, 3, 4]) {
      add(id);
      await r.bumpNow();
      await r.p.sweep();
      floors.push(r.cursors.get(`${SRC}>${R1}`)!);
    }
    expect(floors).toEqual([0, 1, 2, 3]);
    expect(r.reads.filter((_, i) => i % 2 === 1).map((x) => x.after)).toEqual([0, 0, 1, 2]);
    expect(r.texts()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('after a restart re-sends from the durable floor; the re-sends move nothing backwards and a late row still lands', async () => {
    const cursors = new Map<string, number>();
    const first = rig({ cursors, rows: [] });
    const add = (rows: Row[], id: number, text = `r${id}`) => rows.push({ ws: SRC, id, sessionId: S2, rawJsonl: msg(text), started: 6_000 });
    for (const id of [1, 2, 3]) { add(first.rows, id); await first.p.sweep(); }
    first.p.stop();
    expect(cursors.get(`${SRC}>${R1}`)).toBe(1);
    const again = rig({ cursors, rows: [...first.rows], publish: async (_u, b) => ({ ok: true, accepted: b.events.length, inserted: 0 }) });
    add(again.rows, 6);
    await again.bumpNow();
    expect(again.texts()).toEqual(['r2', 'r3', 'r6']);
    expect(cursors.get(`${SRC}>${R1}`)).toBe(1);
    add(again.rows, 5, 'late');
    await again.bumpNow();
    expect(again.reads.at(-1)).toEqual({ after: 6, n: 0 });
    await again.p.sweep();
    expect(again.texts()).toEqual(['r2', 'r3', 'r6', 'late']);
  });

  it('skips a batch the host refuses as malformed or conflicting, once', async () => {
    for (const status of [400, 409, 413]) {
      const r = rig({ publish: async () => { throw new RemoteError('protocol', 'conflict', status); } });
      await r.p.sweep();
      await r.bumpNow();
      expect(r.reads.at(-1)).toEqual({ after: 3, n: 0 });
      await r.p.sweep();
      expect(r.publish).toHaveBeenCalledTimes(1);
      expect(r.logs.map((l) => l.type)).toEqual(['publish-batch-refused']);
    }
  });

  it('skips an unpublishable line, logs it once, and keeps publishing the rest', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i++) deep = [deep];
    const rows: Row[] = [...BASE_ROWS.slice(0, 2), { ws: SRC, id: 3, sessionId: S2, rawJsonl: JSON.stringify({ d: deep }), started: 6_000 },
      { ws: SRC, id: 5, sessionId: S2, rawJsonl: msg('after'), started: 6_000 }];
    const r = rig({ rows });
    await r.p.sweep();
    expect(r.texts()).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'after']);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-line-skipped']);
    await r.p.sweep();
    await r.bumpNow();
    expect(r.reads.at(-1)).toEqual({ after: 5, n: 0 });
    expect(r.logs).toHaveLength(1);
  });

  it('backs off on an unreachable host, honouring Retry-After, and keeps its place', async () => {
    const r = rig({ publish: async () => { throw new RemoteError('unreachable', 'busy', 429, 20_000); } });
    await r.p.sweep();
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed']);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    r.advance(19_999);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    r.advance(1);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(2);
    expect(r.publish.mock.calls[1][1].events).toEqual(r.publish.mock.calls[0][1].events);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed']);
  });

  it('steps the backoff 5 s → 15 s → 60 s → 5 min and logs recovery once', async () => {
    let failing = true;
    const r = rig({
      publish: async (_u, b) => {
        if (failing) throw new RemoteError('unreachable', 'down', 503);
        return { ok: true, accepted: b.events.length, inserted: 0 };
      }
    });
    for (const ms of [...PUBLISH_BACKOFF_MS, PUBLISH_BACKOFF_MS[3]]) {
      const before = r.publish.mock.calls.length;
      await r.p.sweep();
      expect(r.publish.mock.calls.length).toBe(before + 1);
      r.advance(ms - 1);
      await r.p.sweep();
      expect(r.publish.mock.calls.length).toBe(before + 1);
      r.advance(1);
    }
    failing = false;
    await r.p.sweep();
    expect(r.texts()).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'second']);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed', 'publish-recovered']);
  });

  it('a store error climbs the same backoff ladder', async () => {
    let failing = true;
    const r = rig({ eventsError: () => (failing ? new Error('database is locked') : null) });
    for (const ms of PUBLISH_BACKOFF_MS) {
      const reads = r.eventsFor.length;
      await r.p.sweep();
      r.advance(ms - 1);
      await r.p.sweep();
      expect(r.eventsFor.length).toBe(reads + 1);
      r.advance(1);
    }
    failing = false;
    await r.p.sweep();
    expect(r.sent).toHaveLength(1);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed', 'publish-recovered']);
  });

  it('waits five minutes when signed out, rejected or forbidden, even with a shorter Retry-After', async () => {
    for (const e of [new RemoteError('not-signed-in', 'sign in'), new RemoteError('unauthorized', 'x', 401), new RemoteError('forbidden', 'x', 403, 1_000)]) {
      const r = rig({ publish: async () => { throw e; } });
      await r.p.sweep();
      r.advance(PUBLISH_SIGNED_OUT_MS - 1);
      await r.p.sweep();
      expect(r.publish).toHaveBeenCalledTimes(1);
      r.advance(1);
      await r.p.sweep();
      expect(r.publish).toHaveBeenCalledTimes(2);
      expect(r.sent).toEqual([]);
    }
  });

  it('a signed-out wait does not climb the backoff ladder', async () => {
    const errors = [new RemoteError('not-signed-in', 'sign in'), new RemoteError('not-signed-in', 'sign in'), new RemoteError('unreachable', 'down', 503)];
    const r = rig({ publish: async () => { throw errors.shift() ?? new Error('unexpected'); } });
    await r.p.sweep();
    r.advance(PUBLISH_SIGNED_OUT_MS);
    await r.p.sweep();
    r.advance(PUBLISH_SIGNED_OUT_MS);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(3);
    r.advance(PUBLISH_BACKOFF_MS[0]);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(4);
  });

  it('a busy host (429) waits Retry-After or 1 s and does not climb the backoff ladder', async () => {
    const errors = [
      new RemoteError('unreachable', 'busy', 429, 2_000), new RemoteError('unreachable', 'busy', 429),
      new RemoteError('unreachable', 'busy', 429), new RemoteError('unreachable', 'down', 503)
    ];
    const r = rig({ publish: async () => { throw errors.shift() ?? new Error('unexpected'); } });
    await r.p.sweep();
    r.advance(1_999);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    for (const n of [2, 3, 4]) {
      r.advance(n === 2 ? 1 : PUBLISH_BUSY_RETRY_MS);
      await r.p.sweep();
      expect(r.publish).toHaveBeenCalledTimes(n);
    }
    // The 503 after three 429s takes the first ladder step.
    r.advance(PUBLISH_BACKOFF_MS[0] - 1);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(4);
    r.advance(1);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(5);
  });

  it('sends nothing when the workspace’s secrets can’t be read, and retries in five minutes', async () => {
    const secrets = vi.fn(async () => { throw new Error('secret API_TOKEN can’t be read from the vault'); });
    const r = rig({ secrets });
    await r.p.sweep();
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.eventsFor).toEqual([]);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-scrub-unavailable']);
    r.advance(PUBLISH_SIGNED_OUT_MS - 1);
    await r.p.sweep();
    expect(secrets).toHaveBeenCalledTimes(1);
    r.advance(1);
    await r.p.sweep();
    expect(secrets).toHaveBeenCalledTimes(2);
    expect(r.logs).toHaveLength(1);
  });

  it('never logs a secret value', async () => {
    const r = rig({ publish: async () => { throw new RemoteError('protocol', 'refused', 400); } });
    await r.p.sweep();
    expect(JSON.stringify(r.logs)).not.toContain('vault-secret-1');
  });

  it('bump publishes once after the debounce, however many ingests arrive', async () => {
    const timers: Array<() => void> = [];
    const r = rig({ schedule: (fn) => { timers.push(fn); return () => undefined; } });
    expect(timers).toHaveLength(1);
    r.p.bump(SRC);
    r.p.bump(SRC);
    expect(timers).toHaveLength(2);
    timers[1]();
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    r.p.stop();
  });

  it('runs one more pass when a bump lands during a pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const timers: Array<() => void> = [];
    const r = rig({
      schedule: (fn) => { timers.push(fn); return () => undefined; },
      publish: async (_u, b) => { await gate; return { ok: true, accepted: b.events.length, inserted: b.events.length }; }
    });
    const first = r.p.sweep();
    await vi.waitFor(() => expect(r.publish).toHaveBeenCalledTimes(1));
    r.rows.push({ ws: SRC, id: 9, sessionId: S2, rawJsonl: msg('late'), started: 6_000 });
    r.p.bump(SRC);
    timers.at(-1)!();
    release();
    await first;
    await vi.waitFor(() => expect(r.texts()).toContain('late'));
    expect(r.publish).toHaveBeenCalledTimes(2);
  });

  it('stop cancels the sweep timer and pending bumps', () => {
    const cancels: string[] = [];
    let n = 0;
    const r = rig({ schedule: () => { const id = String(n++); return () => void cancels.push(id); } });
    r.p.bump(SRC);
    r.p.stop();
    expect(cancels.sort()).toEqual(['0', '1']);
    r.p.bump(SRC);
    expect(n).toBe(2);
  });
});

describe('backfill (D140)', () => {
  const widened = (from: number): PublisherManifest => ({ ...local(SRC, [R1]), publish: { to: [R1], since: { [R1]: 5_000 }, from: { [R1]: from } } });
  /** The opt-in seeded the cursor past existing history (I2). */
  const seeded = () => new Map([[`${SRC}>${R1}`, 3]]);
  const backfill = async (r: ReturnType<typeof rig>, from: number) =>
    r.p.exclusive(SRC, async () => {
      r.cursors.delete(`${SRC}>${R1}`);
      r.setManifests([widened(from), local(OFF, []), remote(R1)]);
    });

  it('older sessions stay unsent until the action lowers the floor and resets the cursor; then they are sent', async () => {
    const r = rig({ cursors: seeded() });
    r.rows.push({ ws: SRC, id: 5, sessionId: S2, rawJsonl: msg('new'), started: 6_000 });
    await r.p.sweep();
    await r.p.sweep();
    expect(r.texts()).toEqual(['new']);
    await backfill(r, 0);
    await r.p.sweep();
    expect(r.texts()).toEqual(['new', 'before opt-in', 'uses [redacted:API_TOKEN] and [redacted]', 'second', 'new']);
  });

  it('a lowered floor without the cursor reset reads nothing older than the cursor', async () => {
    const r = rig({ cursors: seeded() });
    await r.p.sweep();
    r.setManifests([widened(0), local(OFF, []), remote(R1)]);
    await r.p.sweep();
    expect(r.texts()).toEqual([]);
  });

  it('a chosen date sends only sessions that started on or after it', async () => {
    const S3 = '33333333-2222-4333-8444-555555555555';
    const r = rig({ cursors: seeded(), rows: [...BASE_ROWS, { ws: SRC, id: 6, sessionId: S3, rawJsonl: msg('older still'), started: 1_000 }] });
    await backfill(r, 3_000);
    await r.p.sweep();
    expect(r.texts()).toEqual(['before opt-in', 'uses [redacted:API_TOKEN] and [redacted]', 'second']);
  });

  it('withheld sessions stay withheld', async () => {
    const r = rig({ cursors: seeded(), withheld: [S1] });
    await backfill(r, 0);
    await r.p.sweep();
    expect(r.sent.map((x) => x.batch.sessionId)).toEqual([S2]);
  });

  it('fails closed when a secret can’t be read', async () => {
    const r = rig({ cursors: seeded(), secrets: async () => { throw new Error('secret API_TOKEN can’t be read from the vault'); } });
    await backfill(r, 0);
    await r.p.sweep();
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.logs.map((l) => l.type)).toEqual(['publish-scrub-unavailable']);
  });

  it('exclusive waits out a running pass, so its cursor write can’t land after the reset; no pass starts meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const r = rig({ cursors: seeded(), publish: async (_u, b) => { await gate; return { ok: true, accepted: b.events.length, inserted: 0 }; } });
    r.rows.push({ ws: SRC, id: 5, sessionId: S2, rawJsonl: msg('new'), started: 6_000 });
    const swept = r.p.sweep();
    await vi.waitFor(() => expect(r.publish).toHaveBeenCalledTimes(1));
    let ran = false;
    const held = r.p.exclusive(SRC, async () => {
      ran = true;
      const reads = r.reads.length;
      await r.p.sweep();
      expect(r.reads.length).toBe(reads);
      r.cursors.delete(`${SRC}>${R1}`);
      r.setManifests([widened(0), local(OFF, []), remote(R1)]);
    });
    await new Promise((ok) => setTimeout(ok, 5));
    expect(ran).toBe(false);
    release();
    await Promise.all([swept, held]);
    expect(ran).toBe(true);
    expect(r.cursors.has(`${SRC}>${R1}`)).toBe(false);
    await r.p.sweep();
    expect(r.texts()).toContain('before opt-in');
  });
});
