// listSessions() tags enrichment: each row carries the tags of its LATEST
// tagged summary chapter (ordered as emitted), [] when none exists.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, listSessions } from './db.js';

let dir: string;
const WS = '01WS';
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });
const summaryLine = (summary: string, tags?: string[]) =>
  JSON.stringify({ type: 'session-summary', summary, tags, model: 'haiku' });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-sesslist-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('listSessions tags', () => {
  it('returns [] for a session with no summary', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'hello'));
    const rows = listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual([]);
  });

  it('returns the latest tagged chapter tags, in emitted order', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    ingestLine(WS, 'ses-a', summaryLine('chapter one', ['broker', 'reconnect']));
    ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    ingestLine(WS, 'ses-a', summaryLine('chapter two', ['mcp', 'bridge']));
    const rows = listSessions();
    expect(rows[0].tags).toEqual(['mcp', 'bridge']);
  });

  it('skips untagged later chapters (latest TAGGED chapter wins)', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    ingestLine(WS, 'ses-a', summaryLine('tagged', ['ci']));
    ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    ingestLine(WS, 'ses-a', summaryLine('untagged later chapter'));
    const rows = listSessions();
    expect(rows[0].tags).toEqual(['ci']);
  });

  it('scopes by workspace and tags the right rows', () => {
    ingestLine(WS, 'ses-a', userLine('u1', 'x'));
    ingestLine(WS, 'ses-a', summaryLine('s', ['alpha']));
    ingestLine('01WS2', 'ses-b', userLine('u2', 'y'));
    const rows = listSessions(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('ses-a');
    expect(rows[0].tags).toEqual(['alpha']);
  });
});
