import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWatcher, parseSubagentPath } from './jsonlWatcher.js';
import { openDb, closeDb, costForSession } from './db.js';

const PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let dir: string;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'cf-subagent-')); openDb(dir); });
afterEach(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

const subLine = JSON.stringify({
  type: 'assistant', uuid: 'sa1', timestamp: '2026-07-12T13:20:00Z',
  message: { model: 'claude-opus-4-8', usage: { output_tokens: 500 } },
});

describe('parseSubagentPath', () => {
  it('extracts the parent session id from a subagent file path', async () => {
    const p = `/x/projects/-workspace/${PARENT}/subagents/agent-123.jsonl`;
    expect(parseSubagentPath(p)).toEqual({ parentSessionId: PARENT });
  });
  it('returns null for a primary transcript path', async () => {
    expect(parseSubagentPath(`/x/projects/-workspace/${PARENT}.jsonl`)).toBeNull();
  });
});

describe.each([
  ['chokidar', false],
  ['native recursive fs.watch', true]
])('subagent ingestion (%s)', (_backend, nativeRecursive) => {
  it('rolls subagent tokens up into the parent session', async () => {
    const projectDir = join(dir, 'projects', '-workspace');
    const subDir = join(projectDir, PARENT, 'subagents');
    mkdirSync(subDir, { recursive: true });

    const w = new JsonlWatcher({ nativeRecursive });
    await w.start([]);
    w.registerLocalDirForTest('ws1', projectDir); // reuse Task 4 seam for a watched dir

    writeFileSync(join(subDir, 'agent-123.jsonl'), subLine + '\n');
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();

    expect((await costForSession(PARENT)).outputTokens).toBe(500);
  });
});

describe('native recursive backend', () => {
  it('ingests transcripts that exist before start and ones written after', async () => {
    const projectDir = join(dir, 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    const before = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    const after = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(join(projectDir, `${before}.jsonl`), subLine.replace('sa1', 'b1') + '\n');

    const w = new JsonlWatcher({ nativeRecursive: true });
    await w.start([]);
    w.registerLocalDirForTest('ws1', projectDir);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(projectDir, `${after}.jsonl`), subLine.replace('sa1', 'c1') + '\n');
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();

    expect((await costForSession(before)).outputTokens).toBe(500);
    expect((await costForSession(after)).outputTokens).toBe(500);
  });
});
