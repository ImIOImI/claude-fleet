// Unit tests for the small, Docker/broker-free async helpers in docker.ts.
// docker.ts imports fine with no daemon present (dockerode's constructor
// doesn't connect eagerly) — only electron needs a stub.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' }
}));

const recordUsageEventMock = vi.fn();
const logErrorMock = vi.fn();
vi.mock('./db.js', () => ({
  recordBrokerSessionMapping: vi.fn(),
  recordUsageEvent: (...args: unknown[]) => recordUsageEventMock(...args)
}));
vi.mock('./errorLog.js', () => ({
  logError: (...args: unknown[]) => logErrorMock(...args)
}));

const recordEnvAppliedMock = vi.fn();
vi.mock('./envApplied.js', () => ({
  recordEnvApplied: (...args: unknown[]) => recordEnvAppliedMock(...args)
}));

const { recordResumeUsageQuietly, recordEnvAppliedQuietly } = await import('./docker.js');

beforeEach(() => {
  recordUsageEventMock.mockReset();
  logErrorMock.mockReset();
  recordEnvAppliedMock.mockReset();
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

// A disk error recording env-applied must not abort container create (it's
// awaited at the create call site), matching ensureContainerRetention's
// catch-and-log containment.
describe('recordEnvAppliedQuietly', () => {
  it('resolves once the write settles', async () => {
    recordEnvAppliedMock.mockResolvedValue(undefined);

    await expect(recordEnvAppliedQuietly('ws-a', { A: '1' })).resolves.toBeUndefined();

    expect(recordEnvAppliedMock).toHaveBeenCalledWith('ws-a', { A: '1' });
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('logs a warning and resolves instead of rejecting when the write fails', async () => {
    recordEnvAppliedMock.mockRejectedValue(new Error('disk full'));

    await expect(recordEnvAppliedQuietly('ws-a', { A: '1' })).resolves.toBeUndefined();

    expect(logErrorMock).toHaveBeenCalledWith({
      source: 'main',
      type: 'env-applied-record-failed',
      level: 'warn',
      message: 'Error: disk full',
      workspaceId: 'ws-a'
    });
  });
});

describe('env-applied record timing', () => {
  it('records only after createContainer succeeds', () => {
    const src = readFileSync(new URL('./docker.ts', import.meta.url), 'utf8');
    const created = src.indexOf('await docker.createContainer({');
    const recorded = src.indexOf('await recordEnvAppliedQuietly(spec.id, workspaceEnv);');
    expect(created).toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(created);
  });
});
