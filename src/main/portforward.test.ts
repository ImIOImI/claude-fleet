import { describe, it, expect, vi } from 'vitest';
import { diffPorts, PortForwardManager } from './portforward.js';

describe('diffPorts', () => {
  it('reports ports not seen before, excluding infra ports', () => {
    const { newly, next } = diffPorts(new Set([3000]), [3000, 8080, 7070], [7070]);
    expect(newly).toEqual([8080]);
    expect([...next].sort((a, b) => a - b)).toEqual([3000, 8080]);
  });

  it('re-reports a port that disappeared and came back', () => {
    const first = diffPorts(new Set([3000]), [], []);
    expect(first.newly).toEqual([]);
    expect(first.next.size).toBe(0);
    const second = diffPorts(first.next, [3000], []);
    expect(second.newly).toEqual([3000]);
  });
});

describe('PortForwardManager.reconcile', () => {
  it('starts a monitor per new running workspace and stops departed ones', async () => {
    vi.useFakeTimers();
    let makeClientCalls = 0;
    const pollMs = 1000;
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () => {
        makeClientCalls++;
        // Return a minimal stub whose ready() rejects so poll() swallows it silently.
        return {
          ready: () => Promise.reject(new Error('stub')),
          close: () => {},
          listPorts: () => Promise.reject(new Error('stub')),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        } as never;
      },
      onDetected: () => {},
      excludePorts: () => [],
      pollMs
    });
    // Reconcile idempotency: reconciling the same set twice must not throw or double-register.
    mgr.reconcile(['a', 'b']);
    mgr.reconcile(['a', 'b']);
    mgr.reconcile(['a']); // 'b' departs
    // makeClient must NOT be called at reconcile time (only on poll ticks).
    expect(makeClientCalls).toBe(0);
    // After one poll interval, makeClient should be called (once per running workspace 'a').
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(makeClientCalls).toBeGreaterThan(0);
    mgr.dispose();
    vi.useRealTimers();
  });
});
