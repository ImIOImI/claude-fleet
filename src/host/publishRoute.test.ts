import { describe, expect, it } from 'vitest';
import type { Principal } from './attachHub.js';
import { createLogger } from './log.js';
import { LeaseLostError } from './pgLease.js';
import { createPublishRoute, hostSecretValues, PUBLISH_BURST, PUBLISH_MAX_IN_FLIGHT, PUBLISH_PER_SEC, PublishGate } from './publishRoute.js';
import { PublishConflictError, type PublishStore } from './publishStore.js';
import { person } from './testFakes.js';

const SRC = '01JC0000000000000000000005';
const SID = '11111111-2222-4333-8444-555555555555';
const ann: Principal = { identity: person('ann', 7), tier: 'read' };
const bot: Principal = {
  identity: { provider: 'github', kind: 'machine', login: 'ci[bot]', id: 99, name: null, avatarUrl: null, teams: [], appId: 5 },
  tier: 'read'
};
const body = (events: string[], extra: Record<string, unknown> = {}) => ({ sourceWorkspaceId: SRC, sessionId: SID, events, ...extra });
const quiet = createLogger(() => undefined);

function fakeStore(fail?: unknown) {
  const calls: Array<{ owner: unknown; src: string; sid: string; lines: string[] }> = [];
  const removed: Array<{ owner: unknown; sid: string }> = [];
  const store: PublishStore = {
    ingest: async (owner, src, sid, lines) => {
      if (fail) throw fail;
      calls.push({ owner, src, sid, lines: [...lines] });
      return { sessionId: 'stored', partitionId: 'pub_x', inserted: lines.length };
    },
    partitionIds: async () => [],
    unpublish: async (owner, sid) => {
      if (fail) throw fail;
      removed.push({ owner, sid });
      return sid === SID ? 1 : 0;
    }
  };
  return { store, calls, removed };
}

describe('createPublishRoute', () => {
  it('derives the owner from the verified identity and refuses any other body key', async () => {
    const f = fakeStore();
    const r = createPublishRoute({ store: () => f.store, hostSecrets: [], log: quiet });
    expect(await r.post(ann, body(['{"type":"user"}'], { ownerLogin: 'bob' }))).toEqual({ status: 400, body: { ok: false, error: 'unknown field: ownerLogin' } });
    expect(await r.post(ann, body(['{"type":"user"}']))).toEqual({ status: 200, body: { ok: true, accepted: 1, inserted: 1 } });
    expect(f.calls).toEqual([{ owner: { provider: 'github', id: 7, login: 'ann' }, src: SRC, sid: SID, lines: ['{"type":"user"}'] }]);
  });

  it('repeats the pattern scrub and scrubs the host’s own secret values before storing', async () => {
    const f = fakeStore();
    const r = createPublishRoute({ store: () => f.store, hostSecrets: [{ key: 'FLEET_DB_PASSWORD', value: 'host-secret-123' }], log: quiet });
    const line = JSON.stringify({ type: 'user', message: { content: `ghp_${'A'.repeat(36)} and host-secret-123` } });
    await r.post(ann, body([line]));
    const stored = f.calls[0].lines[0];
    expect(stored).not.toContain('ghp_');
    expect(stored).not.toContain('host-secret-123');
    expect(JSON.parse(stored).message.content).toBe('[redacted] and [redacted:FLEET_DB_PASSWORD]');
  });

  it('scrubs host secrets taken from the env, in keys and JSON-escaped forms too', async () => {
    const f = fakeStore();
    const secret = `fake"pw\\${'z'.repeat(8)}`;
    const hostSecrets = hostSecretValues({ FAKE_SERVICE_TOKEN: secret, FLEET_PG: 'postgres://app:fakepgpass99@db/fleet', HOME: '/home/x' }, ['FLEET_PG']);
    const r = createPublishRoute({ store: () => f.store, hostSecrets, log: quiet });
    const line = JSON.stringify({ type: 'user', [secret]: 1, message: { content: `a ${secret} b fakepgpass99 c` } });
    expect((await r.post(ann, body([line]))).status).toBe(200);
    const stored = f.calls[0].lines[0];
    expect(stored).not.toContain('zzzzzzzz');
    expect(stored).not.toContain('fakepgpass99');
    expect(JSON.parse(stored).message.content).toBe('a [redacted:FAKE_SERVICE_TOKEN] b [redacted:FLEET_PG] c');
  });

  it('answers 400 for a line the scrubber refuses, without storing anything', async () => {
    const f = fakeStore();
    const r = createPublishRoute({ store: () => f.store, hostSecrets: [], log: quiet });
    const deep = `{"a":${'['.repeat(70)}${']'.repeat(70)}}`;
    const res = await r.post(ann, body(['{"type":"user"}', deep]));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/^events\[1\]: line nests deeper than/);
    expect(f.calls).toEqual([]);
  });

  it('answers 503 with no holder, 409 on a session conflict, 503 standby when fenced off, 503 on a statement timeout', async () => {
    const line = '{"type":"user"}';
    expect((await createPublishRoute({ store: () => null, hostSecrets: [], log: quiet }).post(ann, body([line]))).status).toBe(503);
    const conflict = createPublishRoute({ store: () => fakeStore(new PublishConflictError('session id belongs to another workspace')).store, hostSecrets: [], log: quiet });
    expect(await conflict.post(ann, body([line]))).toEqual({ status: 409, body: { ok: false, error: 'session id belongs to another workspace' } });
    const fenced = createPublishRoute({ store: () => fakeStore(new LeaseLostError('superseded')).store, hostSecrets: [], log: quiet });
    expect(await fenced.post(ann, body([line]))).toMatchObject({ status: 503, body: { ok: false, error: 'standby' } });
    const slow = createPublishRoute({ store: () => fakeStore(Object.assign(new Error('canceling statement'), { code: '57014' })).store, hostSecrets: [], log: quiet });
    expect(await slow.post(ann, body([line]))).toMatchObject({ status: 503, body: { ok: false, error: 'publish busy' } });
    const broken = createPublishRoute({ store: () => fakeStore(new Error('boom')).store, hostSecrets: [], log: quiet });
    await expect(broken.post(ann, body([line]))).rejects.toThrow('boom');
  });

  it('logs the request without its content', async () => {
    const lines: string[] = [];
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: createLogger((l) => lines.push(l)) });
    await r.post(ann, body([JSON.stringify({ type: 'user', message: { content: 'private words' } })]));
    expect(lines.join('\n')).not.toContain('private words');
    expect(JSON.parse(lines[0])).toMatchObject({ msg: 'publish', login: 'ann', sourceWorkspaceId: SRC, sessionId: SID, lines: 1, inserted: 1 });
  });

  it('refuses machine identities at admission, whatever their tier', () => {
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: quiet });
    expect(r.admit(bot)).toEqual({ ok: false, status: 403, error: 'publishing is for people, not machine identities' });
    expect(r.admit({ ...bot, tier: 'session' }).ok).toBe(false);
    expect(r.admit(ann).ok).toBe(true);
  });

  it('admits per identity through its gate', () => {
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: quiet });
    const a = r.admit(ann);
    expect(r.admit(ann)).toMatchObject({ ok: false, status: 429 });
    expect(r.admit({ identity: person('bob', 8), tier: 'read' }).ok).toBe(true);
    if (a.ok) a.release();
    expect(r.admit(ann).ok).toBe(true);
  });
});

describe('PublishGate', () => {
  it('pins the limits', () => {
    expect([PUBLISH_BURST, PUBLISH_PER_SEC, PUBLISH_MAX_IN_FLIGHT]).toEqual([20, 2, 4]);
  });

  it('allows one request in flight per identity', () => {
    const g = new PublishGate();
    const a = g.admit('github:7');
    expect(a.ok).toBe(true);
    expect(g.admit('github:7')).toEqual({ ok: false, status: 429, error: 'a publish from you is already in flight', retryAfterSec: 1 });
    expect(g.admit('github:8').ok).toBe(true);
    if (a.ok) a.release();
    expect(g.admit('github:7').ok).toBe(true);
  });

  it('caps host-wide concurrency', () => {
    const g = new PublishGate({ maxInFlight: 2 });
    expect(g.admit('a').ok).toBe(true);
    expect(g.admit('b').ok).toBe(true);
    expect(g.admit('c')).toEqual({ ok: false, status: 503, error: 'publish busy', retryAfterSec: 1 });
  });

  it('defaults to 4 in flight host-wide and a burst of 20 refilling at 2/s', () => {
    const g = new PublishGate({ now: () => 0 });
    for (const k of ['a', 'b', 'c', 'd']) expect(g.admit(k).ok).toBe(true);
    expect(g.admit('e')).toMatchObject({ ok: false, status: 503 });
    let t = 0;
    const b = new PublishGate({ now: () => t });
    for (let i = 0; i < 20; i++) {
      const a = b.admit('k');
      expect(a.ok).toBe(true);
      if (a.ok) a.release();
    }
    expect(b.admit('k')).toMatchObject({ ok: false, status: 429, error: 'publishing too fast' });
    t = 499;
    expect(b.admit('k').ok).toBe(false);
    t = 500;
    expect(b.admit('k').ok).toBe(true);
  });

  it('rate-limits each identity with a token bucket', () => {
    let t = 0;
    const g = new PublishGate({ burst: 2, perSec: 1, now: () => t });
    for (let i = 0; i < 2; i++) {
      const a = g.admit('k');
      expect(a.ok).toBe(true);
      if (a.ok) a.release();
    }
    expect(g.admit('k')).toEqual({ ok: false, status: 429, error: 'publishing too fast', retryAfterSec: 1 });
    t = 1_000;
    expect(g.admit('k').ok).toBe(true);
  });

  it('release is idempotent', () => {
    const g = new PublishGate({ maxInFlight: 1 });
    const a = g.admit('a');
    if (a.ok) { a.release(); a.release(); }
    expect(g.admit('b').ok).toBe(true);
    expect(g.admit('c').ok).toBe(false);
  });
});

describe('hostSecretValues', () => {
  it('takes secret-named env vars, the store’s named vars and connection-string passwords', () => {
    expect(hostSecretValues(
      { AWS_SECRET_ACCESS_KEY: 'k1k1k1k1', HOME: '/home/fleet', FLEET_PG: 'postgres://u:p%40ssword@h/db', PATH: '/bin', EMPTY_TOKEN: '' },
      ['FLEET_PG']
    )).toEqual([
      { key: 'AWS_SECRET_ACCESS_KEY', value: 'k1k1k1k1' },
      { key: 'FLEET_PG', value: 'postgres://u:p%40ssword@h/db' },
      { key: 'FLEET_PG', value: 'p@ssword' }
    ]);
  });

  it('matches each secret suffix after an underscore or alone, not inside a word', () => {
    const names = ['GH_TOKEN', 'TOKEN', 'X_SECRET', 'DB_PASSWORD', 'DB_PASSWD', 'AWS_CREDENTIAL', 'GCP_CREDENTIALS', 'api_key', 'MONKEY', 'TOKENS', 'SECRET_NAME'];
    const env = Object.fromEntries(names.map((n) => [n, 'v'.repeat(10)]));
    expect(hostSecretValues(env).map((v) => v.key)).toEqual(['GH_TOKEN', 'TOKEN', 'X_SECRET', 'DB_PASSWORD', 'DB_PASSWD', 'AWS_CREDENTIAL', 'GCP_CREDENTIALS', 'api_key']);
  });
});

describe('remove', () => {
  it('validates the id, answers 404 when nothing was published, 200 with the count otherwise', async () => {
    const r = createPublishRoute({ store: () => fakeStore().store, hostSecrets: [], log: quiet });
    expect((await r.remove(ann, 'nope')).status).toBe(400);
    expect(await r.remove(ann, '99999999-2222-4333-8444-555555555555')).toEqual({ status: 404, body: { ok: false, error: 'not published' } });
    expect(await r.remove(ann, SID)).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect((await createPublishRoute({ store: () => null, hostSecrets: [], log: quiet }).remove(ann, SID)).status).toBe(503);
  });

  it('removes only the verified caller’s copies and never reaches the store with a bad id', async () => {
    const f = fakeStore();
    const r = createPublishRoute({ store: () => f.store, hostSecrets: [], log: quiet });
    await r.remove(ann, SID.toUpperCase().replace(/^1/, 'A'));
    await r.remove(ann, '../x');
    await r.remove(ann, SID);
    expect(f.removed).toEqual([{ owner: { provider: 'github', id: 7, login: 'ann' }, sid: SID }]);
  });

  it('maps a lost lease to 503 standby and rethrows anything else', async () => {
    const lost = createPublishRoute({ store: () => fakeStore(new LeaseLostError('gone')).store, hostSecrets: [], log: quiet });
    expect(await lost.remove(ann, SID)).toEqual({ status: 503, body: { ok: false, error: 'standby' }, headers: { 'Retry-After': '5' } });
    const boom = createPublishRoute({ store: () => fakeStore(new Error('boom')).store, hostSecrets: [], log: quiet });
    await expect(boom.remove(ann, SID)).rejects.toThrow('boom');
  });
});
