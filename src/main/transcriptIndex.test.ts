import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, unembeddedTurnEvents } from './db.js';
import { extractText, indexSessionTurns, indexSessionSummaries } from './transcriptIndex.js';
import { EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

// Deterministic stub embedder: unit vector whose first slot is text length mod 1.
const stubEmbed = async (texts: string[]) =>
  texts.map((t) => { const v = new Float32Array(EMBED_DIM); v[0] = 1; v[1] = t.length / 1000; return v; });

let dir: string;
const WS = '01WS', SES = 'ses-1';
const line = (o: object) => JSON.stringify(o);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-idx-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('extractText', () => {
  it('reads a string content', () => {
    expect(extractText({ content: 'hello' })).toBe('hello');
  });
  it('joins text blocks and ignores tool blocks', () => {
    const msg = { content: [{ type: 'text', text: 'part one' }, { type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: 'part two' }] };
    expect(extractText(msg)).toBe('part one\npart two');
  });
  it('returns empty for a tool-only message', () => {
    expect(extractText({ content: [{ type: 'tool_result', tool_use_id: 'x' }] })).toBe('');
  });
});

describe('indexSessionTurns', () => {
  it('embeds pending user/assistant turns and skips empty/tool-only ones', async () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'first prompt' } }));
    ingestLine(WS, SES, line({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-01T00:00:01Z', message: { content: [{ type: 'text', text: 'a reply' }] } }));
    ingestLine(WS, SES, line({ type: 'assistant', uuid: 'a2', timestamp: '2026-07-01T00:00:02Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));

    const inserted = await indexSessionTurns(SES, stubEmbed);
    expect(inserted).toBe(2); // two text turns; tool-only assistant skipped
    expect(unembeddedTurnEvents(SES, EMBED_MODEL_ID).length).toBe(0);
  });

  it('is idempotent — a second run inserts nothing', async () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    await indexSessionTurns(SES, stubEmbed);
    expect(await indexSessionTurns(SES, stubEmbed)).toBe(0);
  });
});

describe('indexSessionSummaries', () => {
  it('embeds a pending session summary once', async () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    ingestLine(WS, SES, line({ type: 'session-summary', summary: 'Fixed the reconnect bug.', timestamp: '2026-07-01T00:01:00Z' }));
    expect(await indexSessionSummaries(stubEmbed)).toBe(1);
    expect(await indexSessionSummaries(stubEmbed)).toBe(0);
  });
});
