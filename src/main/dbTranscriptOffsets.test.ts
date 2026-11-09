import { describe, it, expect, beforeEach } from 'vitest';
import { deleteSession, loadTranscriptOffsets, purgeWorkspace, saveTranscriptOffsets } from './db.js';
import { openTestState } from './store/testStore.js';

const row = (path: string, sessionId: string, byteOffset: number, workspaceId = '01WS', birthMs: number | null = 1000) =>
  ({ path, workspaceId, sessionId, byteOffset, birthMs });

beforeEach(async () => {
  await openTestState('cf-offsets-');
});

describe('transcript offsets', () => {
  it('round-trips and upserts by path', async () => {
    await saveTranscriptOffsets([row('/a.jsonl', 's1', 10), row('/b.jsonl', 's2', 20, '01WS', null)]);
    await saveTranscriptOffsets([row('/a.jsonl', 's1', 15)]);
    const m = await loadTranscriptOffsets();
    expect(m.get('/a.jsonl')).toEqual({ byteOffset: 15, birthMs: 1000 });
    expect(m.get('/b.jsonl')).toEqual({ byteOffset: 20, birthMs: null });
    expect(m.size).toBe(2);
  });

  it('saving nothing is a no-op', async () => {
    await saveTranscriptOffsets([]);
    expect((await loadTranscriptOffsets()).size).toBe(0);
  });

  it('deleteSession and purgeWorkspace drop their offsets', async () => {
    await saveTranscriptOffsets([row('/a.jsonl', 's1', 10), row('/b.jsonl', 's2', 20), row('/c.jsonl', 's3', 30, '01OTHER')]);
    await deleteSession('s1');
    expect([...(await loadTranscriptOffsets()).keys()].sort()).toEqual(['/b.jsonl', '/c.jsonl']);
    await purgeWorkspace('01WS');
    expect([...(await loadTranscriptOffsets()).keys()]).toEqual(['/c.jsonl']);
  });
});
