import { describe, it, expect, vi } from 'vitest';
import { diffPorts, PortForwardManager, MAX_PROBE_ATTEMPTS, ServingPort } from './portforward.js';

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
      onChanged: () => {},
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
      onChanged: () => {},
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
      onChanged: () => {},
      excludePorts: () => [],
      probePort: async () => true
    });
    await expect(failing.verifyPort('a', 3000)).resolves.toBe(false);
    mgr.dispose();
    failing.dispose();
  });
});

describe('PortForwardManager serving snapshot', () => {
  /** Manager wired for snapshot tests: detailed ports come from `feed()`,
   *  every probe passes, time is `clock.t`. */
  function servingHarness(feed: () => Array<{ port: number; pid?: number; cmdline?: string }>) {
    const changes: Array<{ workspaceId: string; ports: ServingPort[] }> = [];
    const clock = { t: 1000 };
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve(feed()),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: () => Promise.resolve({ ok: true })
        }) as never,
      onDetected: () => {},
      onChanged: (workspaceId, ports) => changes.push({ workspaceId, ports }),
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      now: () => clock.t,
      pollMs: 1000
    });
    return { mgr, changes, clock };
  }

  it('adds a probe-passed port to the snapshot and emits onChanged', async () => {
    vi.useFakeTimers();
    let ports: Array<{ port: number; pid?: number; cmdline?: string }> = [];
    const { mgr, changes } = servingHarness(() => ports);
    mgr.reconcile(['ws1']);
    ports = [{ port: 3000, pid: 42, cmdline: 'vite dev' }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([
      {
        workspaceId: 'ws1',
        ports: [{ port: 3000, pid: 42, cmdline: 'vite dev', firstSeenAt: 1000 }]
      }
    ]);
    expect(mgr.snapshot()).toEqual([
      { workspaceId: 'ws1', ports: [{ port: 3000, pid: 42, cmdline: 'vite dev', firstSeenAt: 1000 }] }
    ]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('does not re-emit while nothing changes, removes a vanished port', async () => {
    vi.useFakeTimers();
    let ports: Array<{ port: number; pid?: number }> = [{ port: 3000, pid: 42 }];
    const { mgr, changes } = servingHarness(() => ports);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000); // add → emit 1
    await vi.advanceTimersByTimeAsync(1000); // steady → no emit
    expect(changes).toHaveLength(1);
    ports = [];
    await vi.advanceTimersByTimeAsync(1000); // removal → emit 2
    expect(changes).toHaveLength(2);
    expect(changes[1].ports).toEqual([]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('resets firstSeenAt when the pid behind a port changes', async () => {
    vi.useFakeTimers();
    let ports = [{ port: 3000, pid: 42, cmdline: 'vite dev' }];
    const { mgr, changes, clock } = servingHarness(() => ports);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    clock.t = 5000;
    ports = [{ port: 3000, pid: 99, cmdline: 'vite dev (restarted)' }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveLength(2);
    expect(changes[1].ports).toEqual([
      { port: 3000, pid: 99, cmdline: 'vite dev (restarted)', firstSeenAt: 5000 }
    ]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('missing pid/cmdline (old broker) become nulls', async () => {
    vi.useFakeTimers();
    const { mgr, changes } = servingHarness(() => [{ port: 3000 }]);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes[0].ports).toEqual([{ port: 3000, pid: null, cmdline: null, firstSeenAt: 1000 }]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('emits an empty snapshot when a workspace with serving ports departs', async () => {
    vi.useFakeTimers();
    const { mgr, changes } = servingHarness(() => [{ port: 3000, pid: 42 }]);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    mgr.reconcile([]); // ws1 stops
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ workspaceId: 'ws1', ports: [] });
    expect(mgr.snapshot()).toEqual([]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('killPort forwards to the broker client', async () => {
    const calls: number[] = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: (port: number) => {
            calls.push(port);
            return Promise.resolve({ ok: true });
          }
        }) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => []
    });
    const res = await mgr.killPort('ws1', 8765);
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([8765]);
    mgr.dispose();
  });

  it('killPort surfaces broker failure as ok:false', async () => {
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => {
        throw new Error('workspace not running');
      },
      makeClient: () => ({}) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => []
    });
    const res = await mgr.killPort('ws1', 8765);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('workspace not running');
    mgr.dispose();
  });
});
