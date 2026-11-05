// src/main/db.ingestAnchor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, latestLimitHitAnchor } from './db.js';
import { openTestState, type TestState } from './store/testStore.js';

let dir: string;
let st: TestState;
beforeEach(async () => { st = await openTestState('cf-ingest-anchor-'); dir = st.dir; });
afterEach(async () => { await st.close(); });

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
  it('records a limit-hit anchor from a 429 assistant line', async () => {
    await ingestLine('ws1', 'sess1', LINE_429);
    const a = await latestLimitHitAnchor();
    expect(a?.kind).toBe('limit-hit');
    expect(a?.resetAt).toBe(Date.parse('2026-07-12T18:00:00Z'));
    expect(a?.windowStart).toBe(Date.parse('2026-07-12T13:00:00Z'));
    expect(a?.ts).toBe(Date.parse('2026-07-12T13:54:34.503Z'));
  });

  it('does not record an anchor for an ordinary assistant line', async () => {
    await ingestLine('ws1', 'sess1', JSON.stringify({ type: 'assistant', uuid: 'u2', message: { model: 'claude-opus-4-8', usage: { output_tokens: 5 } } }));
    expect(await latestLimitHitAnchor()).toBeNull();
  });
});
