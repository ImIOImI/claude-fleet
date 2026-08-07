import { describe, it, expect, vi } from 'vitest';
import { diffPorts, PortForwardManager, MAX_PROBE_ATTEMPTS } from './portforward.js';

/** Broker client stub whose listPorts yields `ports()` — enough for poll(). */
function stubClient(ports: () => number[]): unknown {
  return {
    ready: () => Promise.resolve(),
    close: () => {},
    listPorts: () => Promise.resolve(ports().map((port) => ({ port }))),
    dial: () => Promise.reject(new Error('stub')),
    closeChannel: () => Promise.resolve()
  };
}

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

describe('PortForwardManager probe gating', () => {
  const pollMs = 1000;

  function makeMgr(opts: {
    ports: () => number[];
    probe: (endpoint: unknown, port: number) => Promise<boolean>;
    onDetected: (workspaceId: string, port: number) => void;
  }): PortForwardManager {
    return new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () => stubClient(opts.ports) as never,
      onDetected: opts.onDetected,
      excludePorts: () => [],
      probePort: opts.probe,
      pollMs
    });
  }

  it('reports a port only when the probe confirms an HTTP answer', async () => {
    vi.useFakeTimers();
    const detected: number[] = [];
    const probe = vi.fn().mockResolvedValue(true);
    const mgr = makeMgr({ ports: () => [3000], probe, onDetected: (_ws, p) => detected.push(p) });
    mgr.reconcile(['a']);
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(detected).toEqual([3000]);
    // Stays reported once: no re-probe / re-report while it keeps listening.
    await vi.advanceTimersByTimeAsync(pollMs * 2);
    expect(detected).toEqual([3000]);
    expect(probe).toHaveBeenCalledTimes(1);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('retries a failing probe then gives up silently after the attempt budget', async () => {
    vi.useFakeTimers();
    const detected: number[] = [];
    const probe = vi.fn().mockResolvedValue(false);
    const mgr = makeMgr({ ports: () => [9229], probe, onDetected: (_ws, p) => detected.push(p) });
    mgr.reconcile(['a']);
    await vi.advanceTimersByTimeAsync(pollMs * (MAX_PROBE_ATTEMPTS + 3));
    expect(detected).toEqual([]);
    // Probed exactly MAX_PROBE_ATTEMPTS times, then written off while it listens.
    expect(probe).toHaveBeenCalledTimes(MAX_PROBE_ATTEMPTS);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('reports a port whose probe fails first (listening before serving) then passes', async () => {
    vi.useFakeTimers();
    const detected: number[] = [];
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const mgr = makeMgr({ ports: () => [5173], probe, onDetected: (_ws, p) => detected.push(p) });
    mgr.reconcile(['a']);
    await vi.advanceTimersByTimeAsync(pollMs * 3);
    expect(detected).toEqual([5173]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('re-probes a written-off port after it disappears and returns', async () => {
    vi.useFakeTimers();
    const detected: number[] = [];
    let current = [4000];
    const probe = vi.fn().mockResolvedValue(false);
    const mgr = makeMgr({ ports: () => current, probe, onDetected: (_ws, p) => detected.push(p) });
    mgr.reconcile(['a']);
    await vi.advanceTimersByTimeAsync(pollMs * (MAX_PROBE_ATTEMPTS + 1));
    expect(probe).toHaveBeenCalledTimes(MAX_PROBE_ATTEMPTS);
    current = []; // port stops listening…
    await vi.advanceTimersByTimeAsync(pollMs);
    current = [4000]; // …and returns, now answering HTTP
    probe.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(detected).toEqual([4000]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('verifyPort reflects the probe result and endpoint failures', async () => {
    const mgr = makeMgr({
      ports: () => [],
      probe: async (_ep, port) => port === 3000,
      onDetected: () => {}
    });
    await expect(mgr.verifyPort('a', 3000)).resolves.toBe(true);
    await expect(mgr.verifyPort('a', 4000)).resolves.toBe(false);
    const failing = new PortForwardManager({
      resolveEndpoint: async () => {
        throw new Error('no endpoint');
      },
      makeClient: () => stubClient(() => []) as never,
      onDetected: () => {},
      excludePorts: () => [],
      probePort: async () => true
    });
    await expect(failing.verifyPort('a', 3000)).resolves.toBe(false);
    mgr.dispose();
    failing.dispose();
  });
});
