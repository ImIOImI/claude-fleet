// Regression test for the #243 `new-session` re-emission flood.
//
// `new-session` fires on the first sighting of a session's primary transcript,
// gated by `!existing` (no `files` entry). But `files` entries are dropped on
// chokidar unlink, workspace unregister, and stat failures — so a re-sighted
// transcript used to re-fire `new-session`, and under a chokidar unlink→add
// re-add storm that became a runaway that flooded the pending-attach layer
// with `new-session-dropped` events. The `announcedSessions` ledger must cap
// the emission to once per session id, regardless of re-sighting.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWatcher } from './jsonlWatcher.js';
import { openDb, closeDb } from './db.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-newsession-'));
  openDb(dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const line = JSON.stringify({
  type: 'assistant',
  uuid: 'm1',
  timestamp: '2026-07-27T00:00:00Z',
  message: { model: 'claude-opus-4-8', usage: { output_tokens: 10 } },
});

describe("jsonlWatcher 'new-session' dedup (#243)", () => {
  it('fires new-session once per session even when the transcript is re-sighted', async () => {
    const projectDir = join(dir, 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${SID}.jsonl`);

    const w = new JsonlWatcher();
    const seen: string[] = [];
    w.on('new-session', (e) => seen.push(e.sessionId));
    await w.start([]);
    w.registerLocalDirForTest('ws1', projectDir);

    writeFileSync(file, line + '\n');
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual([SID]); // first sighting announces exactly once

    // Deterministically drop and re-sight the transcript: unregister clears
    // the in-memory `files` map (as a chokidar unlink would), re-register
    // re-adds the dir so the existing file fires 'add' again. Without the
    // `announcedSessions` guard this pushes SID a second time.
    w.unregisterLocalWorkspace('ws1');
    await new Promise((r) => setTimeout(r, 150));
    w.registerLocalDirForTest('ws1', projectDir);
    await new Promise((r) => setTimeout(r, 500));

    await w.stop();
    expect(seen).toEqual([SID]); // NOT re-announced despite the re-sight
  });
});
