import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, ingestLine, openDb, sessionCaptureSignals, isAutomationSession } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'capsig-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 's1', timestamp: '2026-11-04T00:00:00Z', ...o });

describe('sessionCaptureSignals', () => {
  it('reads latest context usage, user turns and compactions', () => {
    ingestLine('wsA', 's1', line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }));
    ingestLine('wsA', 's1', line({ type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 5 }, content: [] } }));
    ingestLine('wsA', 's1', line({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'again' } }));
    ingestLine('wsA', 's1', line({ type: 'system', subtype: 'compact_boundary', uuid: 'c1' }));
    expect(sessionCaptureSignals('s1')).toEqual({ workspaceId: 'wsA', model: 'claude-opus-5-5', contextTokens: 1100, userTurns: 2, compactions: 1 });
  });
  it('returns null for an unknown session', () => {
    expect(sessionCaptureSignals('nope')).toBeNull();
  });
  it('isAutomationSession is false without an auto- broker mapping', () => {
    expect(isAutomationSession('s1')).toBe(false);
  });
});
