// Tests for registerPolledLocalDir — the second chokidar instance with
// usePolling:true for \\wsl.localhost 9P shares that deliver no inotify events
// (#253). Same handler wiring as the event-driven watcher; both feed enqueue().
//
// electron and db are mocked the same way as jsonlWatcherMirror.test.ts so
// that the ingest event fires (app.getPath would throw in the mirror path).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      if (which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

// Stub the DB layer so ingestLine works without a real better-sqlite3 binary.
// uuid-based dedup mirrors the real dedup_key behaviour.
const h = vi.hoisted(() => ({ seen: new Set<string>() }));
vi.mock('./db.js', () => ({
  ingestLine: (_workspaceId: string, sessionId: string, raw: string) => {
    const parsed = JSON.parse(raw) as { uuid?: string };
    const uuid = parsed.uuid ?? raw;
    const inserted = !h.seen.has(uuid);
    h.seen.add(uuid);
    return { inserted, sessionId, type: 'user' };
  },
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');

const SESSION = '11111111-2222-3333-4444-555555555555';

describe('polled local dirs', () => {
  let root: string;
  let watcher: InstanceType<typeof JsonlWatcher>;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cf-polled-'));
    userDataDir = root;
    h.seen.clear();
    watcher = new JsonlWatcher();
    await watcher.start([]);
  });
  afterEach(async () => {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('ingests transcripts from a dir registered as polled', async () => {
    const dir = join(root, 'projects', '-home-troy-proj');
    mkdirSync(dir, { recursive: true });
    watcher.registerPolledLocalDir('ws-polled', dir);
    const ingested = new Promise<{ workspaceId: string; sessionId: string }>((res) =>
      watcher.on('ingest', res)
    );
    writeFileSync(join(dir, `${SESSION}.jsonl`), '{"type":"user","uuid":"u1"}\n');
    const e = await ingested;
    expect(e.workspaceId).toBe('ws-polled');
    expect(e.sessionId).toBe(SESSION);
  });

  it('unregisterLocalWorkspace also removes polled dirs', async () => {
    const dir = join(root, 'p2');
    mkdirSync(dir, { recursive: true });
    watcher.registerPolledLocalDir('ws-polled', dir);
    watcher.unregisterLocalWorkspace('ws-polled');
    // registering again must be a fresh add (no dedup leak)
    watcher.registerPolledLocalDir('ws-polled', dir);
  });
});
