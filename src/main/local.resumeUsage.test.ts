// Unit test for local.ts's recordResumeUsageQuietly (final-review fix,
// async store 2a): the resume usage write off attachPty's onFreshSpawn
// callback must fire-and-forget (void + .catch()), not block on an awaited
// call inside the mapping IIFE. Mirrors docker.test.ts's recordResumeUsageQuietly
// coverage for the container backend's equivalent.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' }
}));

const recordUsageEventMock = vi.fn();
const logErrorMock = vi.fn();
vi.mock('./db.js', () => ({
  recordBrokerSessionMapping: vi.fn(),
  recordUsageEvent: (...args: unknown[]) => recordUsageEventMock(...args),
  lookupResumableBrokerSession: vi.fn()
}));
vi.mock('./errorLog.js', () => ({
  logError: (...args: unknown[]) => logErrorMock(...args)
}));
vi.mock('node-pty', () => ({}));

const { recordResumeUsageQuietly } = await import('./local.js');

beforeEach(() => {
  recordUsageEventMock.mockReset();
  logErrorMock.mockReset();
});

describe('recordResumeUsageQuietly', () => {
  it('fires a resumed usage event and returns without waiting on it', () => {
    let resolveWrite!: () => void;
    recordUsageEventMock.mockReturnValue(new Promise<void>((r) => { resolveWrite = r; }));

    recordResumeUsageQuietly('ws-a', 'claude-1');

    expect(recordUsageEventMock).toHaveBeenCalledWith({ workspaceId: 'ws-a', sessionId: 'claude-1', kind: 'resumed' });
    expect(logErrorMock).not.toHaveBeenCalled(); // the write hasn't settled yet, and nothing here waits on it
    resolveWrite();
  });

  it('logs a warning instead of throwing when the write rejects', async () => {
    recordUsageEventMock.mockRejectedValue(new Error('db wedged'));

    expect(() => recordResumeUsageQuietly('ws-a', 'claude-1')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the rejection's .catch() run

    expect(logErrorMock).toHaveBeenCalledWith({
      source: 'main',
      level: 'warn',
      type: 'usage-record-failed',
      message: 'Error: db wedged',
      workspaceId: 'ws-a'
    });
  });
});
