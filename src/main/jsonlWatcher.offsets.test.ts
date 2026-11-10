import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlWatcher } from './jsonlWatcher.js';
import { eventsForSession, loadTranscriptOffsets, saveTranscriptOffsets, stateKysely } from './db.js';
import { openTestState, type TestState } from './store/testStore.js';

const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const line = (uuid: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content: `hi ${uuid}` } }) + '\n';
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

let st: TestState;
let projectDir: string;
let file: string;
beforeEach(async () => {
  st = await openTestState('cf-watch-offsets-');
  projectDir = join(st.dir, 'projects', '-workspace');
  mkdirSync(projectDir, { recursive: true });
  file = join(projectDir, `${SES}.jsonl`);
});
afterEach(async () => { await st.close(); rmSync(st.dir, { recursive: true, force: true }); });

async function run(fn: (w: JsonlWatcher) => Promise<void> = async () => undefined, opts = {}): Promise<void> {
  const w = new JsonlWatcher(opts);
  await w.start([]);
  w.registerLocalDirForTest('ws1', projectDir);
  await settle();
  await fn(w);
  await w.stop();
}

const uuids = async () => (await eventsForSession(SES)).map((e) => JSON.parse(e.rawJsonl).uuid).sort();
const wipeEvents = () => stateKysely().deleteFrom('events').execute();

describe('persisted transcript offsets', () => {
  it('saves the offset on stop and resumes from it on the next start', async () => {
    writeFileSync(file, line('u1') + line('u2'));
    await run();
    expect((await loadTranscriptOffsets()).get(file)?.byteOffset).toBe(statSync(file).size);

    // Wipe the events but keep the offset: a resumed watcher must not re-read u1/u2.
    await wipeEvents();
    appendFileSync(file, line('u3'));
    await run();
    expect(await uuids()).toEqual(['u3']);
  });

  it('re-reads from 0 when the file shrank below the saved offset', async () => {
    writeFileSync(file, line('u1'));
    await saveTranscriptOffsets([{ path: file, workspaceId: 'ws1', sessionId: SES, byteOffset: 10_000, tailLen: 1, tailHash: 'x' }]);
    await run();
    expect(await uuids()).toEqual(['u1']);
  });

  it('re-reads from 0 when the file was rewritten in place past the saved offset', async () => {
    writeFileSync(file, line('u1') + line('u2'));
    await run();
    await wipeEvents();
    writeFileSync(file, line('u7') + line('u8') + line('u9'));
    await run();
    expect(await uuids()).toEqual(['u7', 'u8', 'u9']);
  });

  it('drops the saved row when the transcript is unlinked', async () => {
    writeFileSync(file, line('u1'));
    await run(async () => {
      await settle(2200); // past the first flush
      unlinkSync(file);
      await settle();
    });
    expect((await loadTranscriptOffsets()).has(file)).toBe(false);
  });

  it('sweeps rows whose transcript no longer exists, keeps rows for existing unwatched files', async () => {
    const elsewhere = join(st.dir, 'other.jsonl');
    writeFileSync(elsewhere, line('x'));
    await saveTranscriptOffsets([
      { path: join(projectDir, 'gone.jsonl'), workspaceId: 'ws1', sessionId: 's-gone', byteOffset: 5, tailLen: 1, tailHash: 'x' },
      { path: elsewhere, workspaceId: 'ws2', sessionId: 's-x', byteOffset: 5, tailLen: 1, tailHash: 'x' },
    ]);
    await run(async () => { await settle(300); }, { offsetSweepMs: 100 });
    expect([...(await loadTranscriptOffsets()).keys()]).toEqual([elsewhere]);
  });

  it('unregistering a dir drops its rows, so a flush cannot re-save a purged workspace', async () => {
    writeFileSync(file, line('u1'));
    await run(async (w) => { w.unregisterLocalWorkspace('ws1'); await settle(100); });
    expect((await loadTranscriptOffsets()).has(file)).toBe(false);
  });
});
