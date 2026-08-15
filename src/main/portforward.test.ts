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
        ports: [{ port: 3000, pid: 42, cmdline: 'vite dev', sessionId: null, firstSeenAt: 1000 }]
      }
    ]);
    expect(mgr.snapshot()).toEqual([
      { workspaceId: 'ws1', ports: [{ port: 3000, pid: 42, cmdline: 'vite dev', sessionId: null, firstSeenAt: 1000 }] }
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
      { port: 3000, pid: 99, cmdline: 'vite dev (restarted)', sessionId: null, firstSeenAt: 5000 }
    ]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('missing pid/cmdline (old broker) become nulls', async () => {
    vi.useFakeTimers();
    const { mgr, changes } = servingHarness(() => [{ port: 3000 }]);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes[0].ports).toEqual([{ port: 3000, pid: null, cmdline: null, sessionId: null, firstSeenAt: 1000 }]);
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

  it('a poll in flight when the workspace departs cannot resurrect ghost rows', async () => {
    vi.useFakeTimers();
    let releaseProbe: (v: boolean) => void = () => {};
    const changes: Array<{ workspaceId: string; ports: ServingPort[] }> = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([{ port: 3000, pid: 42 }]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: () => Promise.resolve({ ok: true })
        }) as never,
      onDetected: () => {},
      onChanged: (workspaceId, ports) => changes.push({ workspaceId, ports }),
      excludePorts: () => [],
      probePort: () => new Promise<boolean>((resolve) => (releaseProbe = resolve)),
      pollMs: 1000
    });
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000); // poll starts, probe now pending
    mgr.reconcile([]);                        // ws1 departs mid-probe
    releaseProbe(true);                       // probe finally passes
    await vi.advanceTimersByTimeAsync(0);     // let the poll tail run
    // The departed workspace must not have re-emitted ports after its stop.
    // (stopMonitor with an empty serving map emits nothing, so `changes`
    // must contain no entry with ports.length > 0.)
    expect(changes.filter((c) => c.ports.length > 0)).toEqual([]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('emitted arrays are sorted by port ascending', async () => {
    vi.useFakeTimers();
    const changes: Array<{ workspaceId: string; ports: ServingPort[] }> = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([{ port: 8765, pid: 1 }, { port: 3000, pid: 2 }]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: () => Promise.resolve({ ok: true })
        }) as never,
      onDetected: () => {},
      onChanged: (workspaceId, ports) => changes.push({ workspaceId, ports }),
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000
    });
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveLength(1);
    expect(changes[0].ports.map((p) => p.port)).toEqual([3000, 8765]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('killPort rejects ports not in the serving snapshot without constructing a broker client', async () => {
    let makeClientCalls = 0;
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () => {
        makeClientCalls++;
        return ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: () => Promise.resolve({ ok: true })
        }) as never;
      },
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => []
    });
    // ws1 has no monitor (never reconciled), so 8765 is not in the serving list.
    const res = await mgr.killPort('ws1', 8765);
    expect(res).toEqual({ ok: false, error: 'port 8765 is not in the serving list' });
    // The gate must fire before makeClient is called.
    expect(makeClientCalls).toBe(0);
    mgr.dispose();
  });

  it('killPort forwards to the broker client for a port in the serving snapshot', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([{ port: 8765, pid: 1 }]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: (port: number) => {
            calls.push(port);
            return Promise.resolve({ ok: true });
          }
        }) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000
    });
    // Drive port 8765 into the serving snapshot via a poll tick.
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    // Now killPort should pass the gate and reach the broker client.
    const res = await mgr.killPort('ws1', 8765);
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([8765]);
    mgr.dispose();
  });

  it('killPort surfaces broker failure as ok:false for a serving port whose resolveEndpoint throws', async () => {
    vi.useFakeTimers();
    // We need port 8765 in the serving snapshot first, then simulate a broker
    // failure at kill time by having resolveEndpoint throw after the poll phase.
    let resolveShouldThrow = false;
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => {
        if (resolveShouldThrow) throw new Error('workspace not running');
        return 'sock';
      },
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([{ port: 8765, pid: 1 }]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: () => Promise.resolve({ ok: true })
        }) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000
    });
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000); // drive 8765 into snapshot
    vi.useRealTimers();
    resolveShouldThrow = true; // simulate failure at kill time
    const res = await mgr.killPort('ws1', 8765);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('workspace not running');
    mgr.dispose();
  });
});

describe('ServingPort session attribution', () => {
  function mgrWith(listPorts: () => Array<{ port: number; pid?: number; cmdline?: string; session?: string }>, onChanged: (id: string, ports: ServingPort[]) => void): PortForwardManager {
    return new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve(listPorts()),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        }) as never,
      onDetected: () => {},
      onChanged,
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000,
      now: () => 111
    });
  }

  it('carries the broker session id into the snapshot', async () => {
    let last: ServingPort[] = [];
    const mgr = mgrWith(() => [{ port: 3000, pid: 42, cmdline: 'vite', session: 'tab-1' }], (_id, p) => (last = p));
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last).toEqual([{ port: 3000, pid: 42, cmdline: 'vite', sessionId: 'tab-1', firstSeenAt: 111 }]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('late attribution updates sessionId in place without resetting firstSeenAt', async () => {
    let last: ServingPort[] = [];
    let calls = 0;
    const details = [{ port: 3000, pid: 42, cmdline: 'vite' } as { port: number; pid?: number; cmdline?: string; session?: string }];
    const mgr = mgrWith(() => details, (_id, p) => ((last = p), calls++));
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last[0].sessionId).toBeNull();
    const seenAt = last[0].firstSeenAt;
    details[0].session = 'tab-1'; // fd-race resolved on a later scan
    await vi.advanceTimersByTimeAsync(1000);
    expect(last[0].sessionId).toBe('tab-1');
    expect(last[0].firstSeenAt).toBe(seenAt); // NOT a restart
    expect(calls).toBe(2);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('a pid change still resets the row (restart) and takes the new sessionId', async () => {
    let last: ServingPort[] = [];
    const details = [{ port: 3000, pid: 42, cmdline: 'vite', session: 'tab-1' } as { port: number; pid?: number; cmdline?: string; session?: string }];
    let t = 100;
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve(details),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        }) as never,
      onDetected: () => {},
      onChanged: (_id, p) => (last = p),
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000,
      now: () => t
    });
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000);
    t = 200;
    details[0].pid = 43;
    details[0].session = 'tab-2';
    await vi.advanceTimersByTimeAsync(1000);
    expect(last[0]).toEqual({ port: 3000, pid: 43, cmdline: 'vite', sessionId: 'tab-2', firstSeenAt: 200 });
    mgr.dispose();
    vi.useRealTimers();
  });
});

describe('killPort old-broker fallback', () => {
  it('maps a KILLED rpc timeout to actionable copy', async () => {
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([{ port: 3000, pid: 42 }]),
          killPort: () => Promise.reject(new Error('broker: KILLED timed out')),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        }) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000
    });
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000); // port 3000 enters the snapshot
    vi.useRealTimers();
    const res = await mgr.killPort('ws', 3000);
    expect(res).toEqual({
      ok: false,
      error: 'runner image too old — recreate the workspace to enable kill'
    });
    mgr.dispose();
  });
});
