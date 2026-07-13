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
});
