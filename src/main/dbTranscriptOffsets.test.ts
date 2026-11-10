import { describe, it, expect, beforeEach } from 'vitest';
import { deleteSession, deleteTranscriptOffsets, loadTranscriptOffsets, purgeWorkspace, saveTranscriptOffsets } from './db.js';
import { openTestState } from './store/testStore.js';

const row = (path: string, sessionId: string, byteOffset: number, workspaceId = '01WS') =>
  ({ path, workspaceId, sessionId, byteOffset, tailLen: 3, tailHash: `h${byteOffset}` });

beforeEach(async () => {
  await openTestState('cf-offsets-');
});

describe('transcript offsets', () => {
  it('round-trips and upserts by path', async () => {
    await saveTranscriptOffsets([row('/a.jsonl', 's1', 10), row('/b.jsonl', 's2', 20)]);
    await saveTranscriptOffsets([row('/a.jsonl', 's1', 15)]);
    const m = await loadTranscriptOffsets();
    expect(m.get('/a.jsonl')).toEqual({ byteOffset: 15, tailLen: 3, tailHash: 'h15' });
    expect(m.size).toBe(2);
  });

  it('saving or deleting nothing is a no-op', async () => {
    await saveTranscriptOffsets([]);
    await deleteTranscriptOffsets([]);
    expect((await loadTranscriptOffsets()).size).toBe(0);
  });

  it('deletes by path, session and workspace', async () => {
    await saveTranscriptOffsets([row('/a.jsonl', 's1', 10), row('/b.jsonl', 's2', 20), row('/c.jsonl', 's3', 30, '01OTHER'), row('/d.jsonl', 's4', 40)]);
    await deleteTranscriptOffsets(['/d.jsonl', '/missing.jsonl']);
    await deleteSession('s1');
    expect([...(await loadTranscriptOffsets()).keys()].sort()).toEqual(['/b.jsonl', '/c.jsonl']);
    await purgeWorkspace('01WS');
    expect([...(await loadTranscriptOffsets()).keys()]).toEqual(['/c.jsonl']);
  });
});
