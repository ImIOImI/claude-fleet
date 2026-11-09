import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlWatcher } from './jsonlWatcher.js';
import { eventsForSession, loadTranscriptOffsets, saveTranscriptOffsets, stateKysely } from './db.js';
import { openTestState, type TestState } from './store/testStore.js';

const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const line = (uuid: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content: `hi ${uuid}` } }) + '\n';
const settle = () => new Promise((r) => setTimeout(r, 400));

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

async function run(fn: () => Promise<void> = async () => undefined): Promise<void> {
  const w = new JsonlWatcher();
  await w.start([]);
  w.registerLocalDirForTest('ws1', projectDir);
  await settle();
  await fn();
  await w.stop();
}

const uuids = async () => (await eventsForSession(SES)).map((e) => JSON.parse(e.rawJsonl).uuid).sort();

describe('persisted transcript offsets', () => {
  it('saves the offset on stop and resumes from it on the next start', async () => {
    writeFileSync(file, line('u1') + line('u2'));
    await run();
    expect((await loadTranscriptOffsets()).get(file)?.byteOffset).toBe(statSync(file).size);

    // Wipe the events but keep the offset: a resumed watcher must not re-read u1/u2.
    await stateKysely().deleteFrom('events').execute();
    appendFileSync(file, line('u3'));
    await run();
    expect(await uuids()).toEqual(['u3']);
  });

  it('re-reads from 0 when the file shrank below the saved offset', async () => {
    writeFileSync(file, line('u1'));
    await saveTranscriptOffsets([{ path: file, workspaceId: 'ws1', sessionId: SES, byteOffset: 10_000, birthMs: null }]);
    await run();
    expect(await uuids()).toEqual(['u1']);
  });

  it('re-reads from 0 when the file was recreated (birth time changed)', async () => {
    writeFileSync(file, line('u1') + line('u2'));
    const birth = Math.round(statSync(file).birthtimeMs);
    await saveTranscriptOffsets([{ path: file, workspaceId: 'ws1', sessionId: SES, byteOffset: line('u1').length, birthMs: birth > 0 ? birth - 5000 : 1 }]);
    await run();
    expect(await uuids()).toEqual(['u1', 'u2']);
  });
});
