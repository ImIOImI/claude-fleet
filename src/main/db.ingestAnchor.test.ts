// src/main/db.ingestAnchor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, latestLimitHitAnchor } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-ingest-anchor-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const LINE_429 = JSON.stringify({
  type: 'assistant',
  uuid: 'ebc349f7-f938-4798-a930-533183e64d62',
  timestamp: '2026-07-12T13:54:34.503Z',
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] },
});

describe('ingestLine → usage_anchors', () => {
  it('records a limit-hit anchor from a 429 assistant line', () => {
    ingestLine('ws1', 'sess1', LINE_429);
    const a = latestLimitHitAnchor();
    expect(a?.kind).toBe('limit-hit');
    expect(a?.resetAt).toBe(Date.parse('2026-07-12T18:00:00Z'));
    expect(a?.windowStart).toBe(Date.parse('2026-07-12T13:00:00Z'));
    expect(a?.ts).toBe(Date.parse('2026-07-12T13:54:34.503Z'));
  });

  it('does not record an anchor for an ordinary assistant line', () => {
    ingestLine('ws1', 'sess1', JSON.stringify({ type: 'assistant', uuid: 'u2', message: { model: 'claude-opus-4-8', usage: { output_tokens: 5 } } }));
    expect(latestLimitHitAnchor()).toBeNull();
  });
});
