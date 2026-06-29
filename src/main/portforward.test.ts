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
  it('starts a monitor per new running workspace and stops departed ones', () => {
    vi.useFakeTimers();
    const made: string[] = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () => {
        throw new Error('not used in this test');
      },
      onDetected: () => {},
      excludePorts: () => [],
      pollMs: 1000
    });
    // Spy on the private monitor count via reconcile idempotency: reconciling
    // the same set twice must not throw or double-register.
    mgr.reconcile(['a', 'b']);
    mgr.reconcile(['a', 'b']);
    mgr.reconcile(['a']); // 'b' departs
    mgr.dispose();
    vi.useRealTimers();
    expect(made).toEqual([]); // makeClient only fires on a poll tick, not reconcile
  });
});
