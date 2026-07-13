import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, planUsageRows } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-planrows-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

function assistant(uuid: string, tsIso: string, out: number, model = 'claude-opus-4-8') {
  return JSON.stringify({ type: 'assistant', uuid, timestamp: tsIso, message: { model, usage: { output_tokens: out } } });
}

describe('planUsageRows', () => {
  it('sums assistant tokens across workspaces within the window only', () => {
    ingestLine('wsA', 's1', assistant('a', '2026-07-12T13:10:00Z', 100));
    ingestLine('wsB', 's2', assistant('b', '2026-07-12T13:20:00Z', 200, 'claude-haiku-4-5'));
    ingestLine('wsA', 's1', assistant('c', '2026-07-12T09:00:00Z', 999)); // before window
    const rows = planUsageRows(Date.parse('2026-07-12T13:00:00Z'), Date.parse('2026-07-12T18:00:00Z'));
    const total = rows.reduce((n, r) => n + r.outputTokens, 0);
    expect(total).toBe(300);
    expect(rows.some((r) => r.workspaceId === 'wsA')).toBe(true);
    expect(rows.some((r) => r.workspaceId === 'wsB')).toBe(true);
  });

  it('excludes non-assistant events even if they carry usage', () => {
    ingestLine('wsA', 's1', assistant('a', '2026-07-12T13:10:00Z', 100));
    // A 'user' event inside the window with a usage block must NOT be summed.
    ingestLine('wsA', 's1', JSON.stringify({
      type: 'user', uuid: 'u-usage', timestamp: '2026-07-12T13:15:00Z',
      message: { model: 'claude-opus-4-8', usage: { output_tokens: 5000 } },
    }));
    const rows = planUsageRows(Date.parse('2026-07-12T13:00:00Z'), Date.parse('2026-07-12T18:00:00Z'));
    const total = rows.reduce((n, r) => n + r.outputTokens, 0);
    expect(total).toBe(100);
  });

  it('maps all token fields to camelCase', () => {
    ingestLine('wsA', 's1', JSON.stringify({
      type: 'assistant', uuid: 'full', timestamp: '2026-07-12T13:10:00Z',
      message: { model: 'claude-opus-4-8', usage: {
        input_tokens: 11, output_tokens: 22,
        cache_read_input_tokens: 33, cache_creation_input_tokens: 44,
      } },
    }));
    const rows = planUsageRows(Date.parse('2026-07-12T13:00:00Z'), Date.parse('2026-07-12T18:00:00Z'));
    const r = rows.find((x) => x.workspaceId === 'wsA')!;
    expect(r.inputTokens).toBe(11);
    expect(r.outputTokens).toBe(22);
    expect(r.cacheReadInputTokens).toBe(33);
    expect(r.cacheCreationInputTokens).toBe(44);
  });
});
