import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, unembeddedSummaries } from './db.js';
import { EMBED_MODEL_ID } from './vectors.js';

let dir: string; const WS = '01WS', SES = 'ses-1';
const line = (o: object) => JSON.stringify(o);
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-sum-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('session-summary ingest', () => {
  it('routes a session-summary event into session_summaries as a pending embedding', () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    ingestLine(WS, SES, line({ type: 'session-summary', summary: 'Worked on the broker reconnect bug.', timestamp: '2026-07-01T00:01:00Z' }));
    const pending = unembeddedSummaries(EMBED_MODEL_ID);
    expect(pending.length).toBe(1);
    expect(pending[0].summary).toContain('broker reconnect');
    expect(pending[0].sourceMaxEventId).toBeGreaterThan(0);
  });

  it('appends chapter rows per source_max_event_id, never replaces (#207)', () => {
    ingestLine(WS, SES, userLine('u1', 'first prompt'));
    ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 'chapter one', tags: ['a', 'b'], model: 'haiku' }));
    ingestLine(WS, SES, userLine('u2', 'second prompt'));
    ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 'chapter two', tags: ['b', 'c'], model: 'haiku' }));
    const db = openDb(dir);
    const rows = db.prepare('SELECT summary FROM session_summaries WHERE session_id = ? ORDER BY id').all(SES) as Array<{ summary: string }>;
    expect(rows.map((r) => r.summary)).toEqual(['chapter one', 'chapter two']);
  });

  it('accumulates tags as a union across chapters', () => {
    ingestLine(WS, SES, userLine('u1', 'x'));
    ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 's1', tags: ['a', 'b'] }));
    ingestLine(WS, SES, userLine('u2', 'y'));
    ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 's2', tags: ['b', 'c'] }));
    const db = openDb(dir);
    const tags = db.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag').all(SES) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['a', 'b', 'c']);
  });
});
