import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initPerfState, perfRecording, __resetPerfStateForTests } from './perfState.js';

interface FakeApi {
  perf: {
    status: () => Promise<{ enabled: boolean }>;
    onState: (cb: (recording: boolean) => void) => () => void;
  };
}

describe('perfState', () => {
  let stateCb: ((recording: boolean) => void) | null = null;

  beforeEach(() => {
    __resetPerfStateForTests();
    stateCb = null;
    (globalThis as unknown as { window: { api: FakeApi } }).window = {
      api: {
        perf: {
          status: vi.fn(async () => ({ enabled: true })),
          onState: (cb) => {
            stateCb = cb;
            return () => {};
          }
        }
      }
    };
  });

  it('defaults to off, pulls initial state, and follows pushes', async () => {
    expect(perfRecording()).toBe(false);
    initPerfState();
    await Promise.resolve(); // let the status() promise settle
    await Promise.resolve();
    expect(perfRecording()).toBe(true);
    stateCb!(false);
    expect(perfRecording()).toBe(false);
    stateCb!(true);
    expect(perfRecording()).toBe(true);
  });

  it('init is idempotent (one subscription, one status pull)', async () => {
    initPerfState();
    initPerfState();
    const api = (globalThis as unknown as { window: { api: FakeApi } }).window.api;
    expect(api.perf.status).toHaveBeenCalledTimes(1);
  });
});
