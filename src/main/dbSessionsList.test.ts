// listSessions() tags enrichment: each row carries the tags of its LATEST
// tagged summary chapter (ordered as emitted), [] when none exists.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, listSessions, listSessionIds, latestActivityByWorkspace, latestSessionId } from './db.js';

let dir: string;
const WS = '01WS';
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });
const summaryLine = (summary: string, tags?: string[]) =>
  JSON.stringify({ type: 'session-summary', summary, tags, model: 'haiku' });

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'cf-sesslist-')); openDb(dir); });
afterEach(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('listSessions tags', () => {
  it('returns [] for a session with no summary', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'hello'));
    const rows = await listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual([]);
  });

  it('returns the latest tagged chapter tags, in emitted order', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    await ingestLine(WS, 'ses-a', summaryLine('chapter one', ['broker', 'reconnect']));
    await ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    await ingestLine(WS, 'ses-a', summaryLine('chapter two', ['mcp', 'bridge']));
    const rows = await listSessions();
    expect(rows[0].tags).toEqual(['mcp', 'bridge']);
  });

  it('skips untagged later chapters (latest TAGGED chapter wins)', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    await ingestLine(WS, 'ses-a', summaryLine('tagged', ['ci']));
    await ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    await ingestLine(WS, 'ses-a', summaryLine('untagged later chapter'));
    const rows = await listSessions();
    expect(rows[0].tags).toEqual(['ci']);
  });

  it('scopes by workspace and tags the right rows', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'x'));
    await ingestLine(WS, 'ses-a', summaryLine('s', ['alpha']));
    await ingestLine('01WS2', 'ses-b', userLine('u2', 'y'));
    const rows = await listSessions(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('ses-a');
    expect(rows[0].tags).toEqual(['alpha']);
  });
});

describe('latestActivityByWorkspace', () => {
  const at = (uuid: string, ts: string) =>
    JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { content: 'x' } });

  it('equals listSessions(ws)[0]?.lastActiveAt for each workspace; absent when it has no sessions', async () => {
    await ingestLine('ws-a', 'a1', at('u1', '2026-07-01T00:00:00Z'));
    await ingestLine('ws-a', 'a2', at('u2', '2026-07-01T00:05:00Z'));
    await ingestLine('ws-b', 'b1', JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: 'b1' }));
    const got = await latestActivityByWorkspace(['ws-a', 'ws-b', 'ws-none']);
    for (const ws of ['ws-a', 'ws-b']) {
      expect(got.get(ws)).toBe((await listSessions(ws))[0]?.lastActiveAt ?? null);
    }
    expect(got.get('ws-a')).toBe(Date.parse('2026-07-01T00:05:00Z'));
    expect(got.get('ws-b')).toBeNull();
    expect(got.has('ws-none')).toBe(false);
  });
});

describe('listSessionIds', () => {
  const at = (uuid: string, ts: string) =>
    JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { content: 'x' } });

  it('matches listSessions() ids in order, including a NULL last_active_at session', async () => {
    await ingestLine('ws-e', 'e1', at('u1', '2026-07-01T00:00:00Z'));
    await ingestLine('ws-f', 'f1', at('u2', '2026-07-01T00:05:00Z'));
    // A light session (only a timestamp-less line) never gets a real
    // last_active_at and must still sort in (as COALESCE(..., 0) DESC puts it last).
    await ingestLine('ws-g', 'g1', JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: 'g1' }));

    const ids = await listSessionIds();
    const wantIds = (await listSessions()).map((s) => s.id);
    expect(ids).toEqual(wantIds);
    expect(ids.indexOf('f1')).toBeLessThan(ids.indexOf('e1'));
    expect(ids.at(-1)).toBe('g1');
  });
});

describe('latestSessionId', () => {
  it('matches listSessions(ws)[0]?.id, including when the only session has a NULL last_active_at', async () => {
    await ingestLine('ws-c', 'c1', userLine('u1', 'first'));
    await ingestLine('ws-c', 'c2', userLine('u2', 'second'));
    expect(await latestSessionId('ws-c')).toBe((await listSessions('ws-c'))[0]?.id ?? null);

    // A light session (only a timestamp-less line) never gets a real
    // last_active_at; it must still resolve as "latest" when it's the only one.
    await ingestLine('ws-d', 'd1', JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: 'd1' }));
    expect(await latestSessionId('ws-d')).toBe('d1');
    expect(await latestSessionId('ws-d')).toBe((await listSessions('ws-d'))[0]?.id ?? null);

    expect(await latestSessionId('ws-none')).toBeNull();
  });

  it('orders sessions tied on last_active_at by id', async () => {
    for (const id of ['s-b', 's-a', 's-c']) {
      await ingestLine('ws-tie', id, JSON.stringify({ type: 'ai-title', aiTitle: id, sessionId: id }));
    }
    expect((await listSessions('ws-tie')).map((s) => s.id)).toEqual(['s-a', 's-b', 's-c']);
    expect((await listSessionIds()).filter((id) => id.startsWith('s-'))).toEqual(['s-a', 's-b', 's-c']);
    expect(await latestSessionId('ws-tie')).toBe('s-a');
  });
});
