import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWatcher, parseSubagentPath } from './jsonlWatcher.js';
import { openDb, closeDb, costForSession } from './db.js';

const PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-subagent-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const subLine = JSON.stringify({
  type: 'assistant', uuid: 'sa1', timestamp: '2026-07-12T13:20:00Z',
  message: { model: 'claude-opus-4-8', usage: { output_tokens: 500 } },
});

describe('parseSubagentPath', () => {
  it('extracts the parent session id from a subagent file path', () => {
    const p = `/x/projects/-workspace/${PARENT}/subagents/agent-123.jsonl`;
    expect(parseSubagentPath(p)).toEqual({ parentSessionId: PARENT });
  });
  it('returns null for a primary transcript path', () => {
    expect(parseSubagentPath(`/x/projects/-workspace/${PARENT}.jsonl`)).toBeNull();
  });
});

describe('subagent ingestion', () => {
  it('rolls subagent tokens up into the parent session', async () => {
    const projectDir = join(dir, 'projects', '-workspace');
    const subDir = join(projectDir, PARENT, 'subagents');
    mkdirSync(subDir, { recursive: true });

    const w = new JsonlWatcher();
    await w.start([]);
    w.registerLocalDirForTest('ws1', projectDir); // reuse Task 4 seam for a watched dir

    writeFileSync(join(subDir, 'agent-123.jsonl'), subLine + '\n');
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();

    expect(costForSession(PARENT).outputTokens).toBe(500);
  });
});
