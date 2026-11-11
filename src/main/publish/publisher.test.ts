import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '../remoteClient.js';
import type { PublishBatch } from './protocol.js';
import { PUBLISH_BACKOFF_MS, PUBLISH_SIGNED_OUT_MS, startPublisher, type PublisherDeps, type PublisherLog, type PublisherManifest } from './publisher.js';
import type { ScrubbedLine } from './scrub.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const SRC = '01JC0000000000000000000005';
const OFF = '01JC0000000000000000000006';
const R1 = '01JC00000000000000000000R1';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '22222222-2222-4333-8444-555555555555';
const msg = (c: string) => JSON.stringify({ type: 'user', message: { content: c } });
const local = (id: string, to: string[]): PublisherManifest =>
  ({ id, kind: 'local', env: { plain: {}, secretKeys: [] }, publish: to.length ? { to, since: Object.fromEntries(to.map((t) => [t, 5_000])) } : undefined });
const remote = (id: string): PublisherManifest =>
  ({ id, kind: 'remote', env: { plain: {}, secretKeys: [] }, remote: { url: 'http://host', tier: 'read', login: 'ann', checkedAt: 1 } });
interface Row { ws: string; id: number; sessionId: string; rawJsonl: string; started: number }
const BASE_ROWS: Row[] = [
  { ws: SRC, id: 1, sessionId: S1, rawJsonl: msg('before opt-in'), started: 4_000 },
  { ws: SRC, id: 2, sessionId: S2, rawJsonl: msg(`uses vault-secret-1 and ghp_${'A'.repeat(36)}`), started: 6_000 },
  { ws: SRC, id: 3, sessionId: S2, rawJsonl: msg('second'), started: 6_000 },
  { ws: OFF, id: 4, sessionId: S1, rawJsonl: msg('not opted in'), started: 6_000 }
];

function rig(o: {
  manifests?: PublisherManifest[]; publish?: PublisherDeps['publish']; secrets?: PublisherDeps['secretValues'];
  withheld?: string[]; schedule?: PublisherDeps['schedule']; rows?: Row[];
} = {}) {
  const sent: Array<{ url: string; batch: PublishBatch<ScrubbedLine> }> = [];
  const cursors = new Map<string, number>();
  const logs: PublisherLog[] = [];
  const eventsFor: string[] = [];
  const rows = o.rows ?? [...BASE_ROWS];
  let t = 10_000;
  const publish = vi.fn(o.publish ?? (async (url: string, batch: PublishBatch<ScrubbedLine>) => {
    sent.push({ url, batch });
    return { ok: true as const, accepted: batch.events.length, inserted: batch.events.length };
  }));
  const p = startPublisher({
    manifests: async () => o.manifests ?? [local(SRC, [R1]), local(OFF, []), remote(R1)],
    publish,
    secretValues: o.secrets ?? (async () => [{ key: 'API_TOKEN', value: 'vault-secret-1' }]),
    events: async (ws, after, since, limit) => {
      eventsFor.push(ws);
      return rows.filter((r) => r.ws === ws && r.id > after && r.started >= since).slice(0, limit).map(({ id, sessionId, rawJsonl }) => ({ id, sessionId, rawJsonl }));
    },
    getCursor: async (s, tg) => cursors.get(`${s}>${tg}`) ?? 0,
    setCursor: async (s, tg, id) => void cursors.set(`${s}>${tg}`, id),
    withheld: async () => new Set(o.withheld ?? []),
    log: (e) => void logs.push(e),
    now: () => t,
    schedule: o.schedule ?? (() => () => undefined)
  });
  return { p, sent, publish, cursors, logs, eventsFor, rows, advance: (ms: number) => void (t += ms) };
}

describe('startPublisher', () => {
  it('publishes only opted-in workspaces, only sessions started since, scrubbed, and advances the cursor', async () => {
    const r = rig();
    await r.p.sweep();
    expect(r.eventsFor).toEqual([SRC]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].url).toBe('http://host');
    expect(r.sent[0].batch.sessionId).toBe(S2);
    expect(r.sent[0].batch.events.map((l) => JSON.parse(l).message.content)).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'second']);
    expect(JSON.stringify(r.sent)).not.toContain('vault-secret-1');
    expect(JSON.stringify(r.sent)).not.toContain('ghp_');
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
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

  it('never sends a withheld session but moves past it', async () => {
    const r = rig({ withheld: [S2] });
    await r.p.sweep();
    expect(r.sent).toEqual([]);
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
  });

  it('skips a batch the host refuses as malformed or conflicting', async () => {
    for (const status of [400, 409, 413]) {
      const r = rig({ publish: async () => { throw new RemoteError('protocol', 'conflict', status); } });
      await r.p.sweep();
      expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
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
    expect(r.sent.flatMap((s) => s.batch.events.map((l) => JSON.parse(l).message.content))).toEqual(['uses [redacted:API_TOKEN] and [redacted]', 'after']);
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(5);
    expect(r.logs.map((l) => l.type)).toEqual(['publish-line-skipped']);
    await r.p.sweep();
    expect(r.logs).toHaveLength(1);
  });

  it('backs off on an unreachable host, honouring Retry-After, and keeps the cursor', async () => {
    const r = rig({ publish: async () => { throw new RemoteError('unreachable', 'busy', 429, 20_000); } });
    await r.p.sweep();
    expect(r.cursors.get(`${SRC}>${R1}`)).toBeUndefined();
    expect(r.logs.map((l) => l.type)).toEqual(['publish-failed']);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    r.advance(19_999);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(1);
    r.advance(1);
    await r.p.sweep();
    expect(r.publish).toHaveBeenCalledTimes(2);
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
    expect(r.cursors.get(`${SRC}>${R1}`)).toBe(3);
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
      expect(r.cursors.get(`${SRC}>${R1}`)).toBeUndefined();
    }
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
    await vi.waitFor(() => expect(r.cursors.get(`${SRC}>${R1}`)).toBe(9));
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
