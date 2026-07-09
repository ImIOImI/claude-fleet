import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, unembeddedSummaries } from './db.js';
import { EMBED_MODEL_ID } from './vectors.js';

let dir: string; const WS = '01WS', SES = 'ses-1';
const line = (o: object) => JSON.stringify(o);
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
});
