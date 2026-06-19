// Integration test for the durable-mirror write path (#10): drives the REAL
// JsonlWatcher against JSONL files on disk and asserts the host-side mirror
// file. `./db.js` is mocked with a uuid-based dedup stub (the real
// better-sqlite3 is built for Electron's ABI and can't load under Node/vitest)
// — which is exactly the `inserted` signal the mirror logic keys off, so the
// compaction-proof guard is tested faithfully. electron is mocked for paths.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      if (which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

// Stub the DB layer: ingestLine reports a genuinely-new insert the first time
// it sees a uuid (mirroring the real dedup_key behaviour) and a duplicate
// thereafter — so a compaction re-read of an already-seen line yields
// inserted:false and the mirror must not re-append it.
const h = vi.hoisted(() => ({ seen: new Set<string>() }));
vi.mock('./db.js', () => ({
  ingestLine: (_workspaceId: string, sessionId: string, raw: string) => {
    const uuid = (JSON.parse(raw) as { uuid: string }).uuid;
    const inserted = !h.seen.has(uuid);
    h.seen.add(uuid);
    return { inserted, sessionId, type: 'user' };
  }
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');
const { setWorkspaceDefault, _resetMirrorPolicyForTests } = await import('./mirrorPolicy.js');
const { workspaceClaudeDir, workspaceHistoryFile } = await import('./paths.js');

const WS = '01WATCHMIRRORAAAAAAAAAAAAAA';
const S1 = 'aaaaaaaa-1111-1111-1111-111111111111';
const S2 = 'aaaaaaaa-2222-2222-2222-222222222222';
const S3 = 'aaaaaaaa-3333-3333-3333-333333333333';

const evt = (uuid: string): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n';

const transcriptPath = (session: string): string =>
  join(workspaceClaudeDir(WS), 'projects', '-workspace', `${session}.jsonl`);

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(fn: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

let watcher: InstanceType<typeof JsonlWatcher>;

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-watchmirror-'));
  h.seen.clear();
  _resetMirrorPolicyForTests();
  watcher = new JsonlWatcher();
});

afterEach(async () => {
  await watcher.stop();
  await rm(userDataDir, { recursive: true, force: true });
});

describe('watcher durable mirror', () => {
  it('writes a mirror file when the workspace default is on', async () => {
    setWorkspaceDefault(WS, 'on');
    await watcher.start([WS]); // registerWorkspace pre-creates the watched dir
    await writeFile(transcriptPath(S1), evt('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'utf8');

    const mirror = workspaceHistoryFile(WS, S1);
    expect(await waitUntil(() => exists(mirror))).toBe(true);
    expect(await readFile(mirror, 'utf8')).toContain('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('writes no mirror when the workspace default is off', async () => {
    setWorkspaceDefault(WS, 'off');
    await watcher.start([WS]);
    await writeFile(transcriptPath(S2), evt('22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'utf8');

    // Wait long enough for the watcher to have ingested, then assert absence.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await exists(workspaceHistoryFile(WS, S2))).toBe(false);
  });

  it('is compaction-proof: a shrink + re-read never double-appends', async () => {
    setWorkspaceDefault(WS, 'on');
    await watcher.start([WS]);
    const tp = transcriptPath(S3);
    const A = 'cccccccc-0000-0000-0000-000000000000';
    const fillers = Array.from({ length: 5 }, (_v, i) => `cccccccc-000${i + 1}-0000-0000-000000000000`);
    const B = 'cccccccc-9999-9999-9999-999999999999';

    // A big initial transcript, fully mirrored.
    await writeFile(tp, [A, ...fillers].map(evt).join(''), 'utf8');
    const mirror = workspaceHistoryFile(WS, S3);
    expect(await waitUntil(async () => (await readFile(mirror, 'utf8').catch(() => '')).includes(fillers[4]))).toBe(true);

    // Compaction: rewrite the file SMALLER, keeping A (already mirrored) and
    // adding B. size < prior offset → watcher resets to 0 and re-reads; the
    // DB dedup must keep A from being appended twice.
    await writeFile(tp, evt(A) + evt(B), 'utf8');
    expect(await waitUntil(async () => (await readFile(mirror, 'utf8').catch(() => '')).includes(B))).toBe(true);

    const body = await readFile(mirror, 'utf8');
    const count = (needle: string): number => body.split(needle).length - 1;
    expect(count(A)).toBe(1); // not re-appended on the post-shrink re-read
    expect(count(B)).toBe(1);
    for (const f of fillers) expect(count(f)).toBe(1);
  });
});
