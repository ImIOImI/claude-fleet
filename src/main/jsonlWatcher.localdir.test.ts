import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWatcher } from './jsonlWatcher.js';
import { openDb, closeDb, costForWorkspace } from './db.js';

let dir: string;
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-localdir-')); openDb(dir); });
afterEach(async () => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const line = JSON.stringify({
  type: 'assistant', uuid: 'e1', timestamp: '2026-07-12T13:10:00Z',
  message: { model: 'claude-opus-4-8', usage: { output_tokens: 1000, input_tokens: 10 } },
});

describe('local-workspace host-dir ingestion', () => {
  it('attributes a file under a registered host dir to the real workspace id', async () => {
    // A fake "host projects" dir standing in for ~/.claude/projects/<encoded>/
    const hostProjectDir = join(dir, 'projects', '-fake-root');
    mkdirSync(hostProjectDir, { recursive: true });

    const w = new JsonlWatcher();
    await w.start([]);
    // Register by explicit dir (test seam): see implementation note.
    w.registerLocalDirForTest('ws-local', hostProjectDir);

    writeFileSync(join(hostProjectDir, `${UUID}.jsonl`), line + '\n');
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();

    expect(costForWorkspace('ws-local').outputTokens).toBe(1000);
  });
});
