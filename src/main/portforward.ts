// Port-forward + dev-server detection over the broker socket.
//
// Two responsibilities, both riding the existing broker transport (unix
// socket on Linux/macOS, loopback TCP on Windows):
//
//  - PortMonitor: per running workspace, poll the broker's LISTPORTS every
//    `pollMs` and maintain an authoritative "Serving" snapshot
//    (Map<port, ServingPort>) for each workspace. A port enters the snapshot
//    only after passing the HTTP probe; `onDetected` fires on that first
//    admission, and `onChanged` fires whenever the snapshot changes (port
//    added, removed, or its pid changed). `onChanged(workspaceId, [])` fires
//    when a monitor stops so listeners can clear their view. LISTPORTS reports
//    EVERY listen socket in the container — Chromium DevTools ports, node
//    inspectors, short-lived tool servers — so each new port is HTTP-probed
//    through the broker first and only ports that answer with an HTTP response
//    line are reported. Non-answering ports are re-probed for a few ticks (a
//    dev server can accept connections before it serves), then silently ignored.
//  - PortForward: a loopback `net.Server`; each inbound browser TCP
//    connection gets its OWN BrokerClient (channel 1) and is relayed to
//    127.0.0.1:<containerPort> inside the container via DIAL + the reused
//    INPUT/OUTPUT channel frames — exactly mirroring attachPty's one-client-
//    per-session model. Cheap: broker sockets are.
//
// The host listener binds 127.0.0.1 only; the broker only ever dials
// 127.0.0.1 inside its container. No container ports are published.

import net from 'node:net';
import { BrokerClient, brokerPtyStream } from './broker.js';

type BrokerEndpoint = string | { host: string; port: number };

/** Consecutive failed probes before a listening port is written off as
 *  non-HTTP. At the 3s poll interval this gives a slow-starting dev server
 *  ~9s to begin serving. */
export const MAX_PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 1500;

/** One HTTP-serving container port in the authoritative rail snapshot. */
export interface ServingPort {
  port: number;
  pid: number | null;
  cmdline: string | null;
  /** Broker session id of the tab whose process tree owns the server;
   *  null when the broker couldn't attribute one (orphan, old image). */
  sessionId: string | null;
  firstSeenAt: number; // epoch ms (host clock)
}

/** True when the container port answers a minimal GET with an HTTP response
 *  line. Rides the same DIAL + channel-stream path the forward itself uses,
 *  so a probe that passes implies the preview will connect. */
async function httpProbe(
  makeClient: (endpoint: BrokerEndpoint) => BrokerClient,
  endpoint: BrokerEndpoint,
  port: number
): Promise<boolean> {
  const client = makeClient(endpoint);
  try {
    await client.ready();
    const resp = await client.dial(1, port);
    if (!resp.ok) return false;
    const duplex = brokerPtyStream(client, 1);
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      duplex.once('data', (chunk) => settle(() => resolve(String(chunk))));
      duplex.once('error', (err) => settle(() => reject(err)));
      duplex.once('end', () => settle(() => reject(new Error('closed before responding'))));
      duplex.write('GET / HTTP/1.0\r\n\r\n');
    });
    duplex.destroy();
    return first.startsWith('HTTP/');
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/** Pure detection diff: which scanned ports are new vs `prev`, after
 *  removing infra ports (broker/MCP). Returns the next baseline set. */
export function diffPorts(
  prev: Set<number>,
  current: number[],
  exclude: number[]
): { newly: number[]; next: Set<number> } {
  const ex = new Set(exclude);
  const next = new Set(current.filter((p) => !ex.has(p)));
  const newly = [...next].filter((p) => !prev.has(p));
  return { newly, next };
}

export interface PortForwardDeps {
  resolveEndpoint(workspaceId: string): Promise<BrokerEndpoint>;
  makeClient(endpoint: BrokerEndpoint): BrokerClient;
  onDetected(workspaceId: string, port: number): void;
  /** Full per-workspace snapshot after every membership/owner change —
   *  including an empty array when the workspace's monitor stops. */
  onChanged(workspaceId: string, ports: ServingPort[]): void;
  excludePorts(workspaceId: string): number[];
  pollMs?: number;
  /** Whether the container port answers like an HTTP server. Injectable for
   *  tests; defaults to a GET probe over a broker DIAL. */
  probePort?(endpoint: BrokerEndpoint, port: number): Promise<boolean>;
  /** Clock, injectable for tests. */
  now?(): number;
}

interface Monitor {
  timer: NodeJS.Timeout;
  seen: Set<number>;
  /** Consecutive failed probes per port — retried while < MAX_PROBE_ATTEMPTS,
   *  then given up on (kept in `seen`, never toasted). Cleared when the port
   *  stops listening, so a port that disappears and returns is probed afresh. */
  probeFails: Map<number, number>;
  /** Re-entrancy guard: probes make a poll tick slow enough to overlap the
   *  next interval fire; overlapping ticks would double-report. */
  polling: boolean;
  /** Authoritative "Serving" rail state: ports that passed the HTTP probe,
   *  keyed by port. Source of truth for ports:list / ports:changed. */
  serving: Map<number, ServingPort>;
}

interface Forward {
  close(): void;
  hostPort: number;
}

function servingSorted(monitor: { serving: Map<number, ServingPort> }): ServingPort[] {
  return [...monitor.serving.values()].sort((a, b) => a.port - b.port);
}

export class PortForwardManager {
  private readonly deps: Required<PortForwardDeps>;
  private readonly monitors = new Map<string, Monitor>();
  // workspaceId → containerPort → forward (dedupe re-opens of the same port).
  private readonly forwards = new Map<string, Map<number, Forward>>();

  constructor(deps: PortForwardDeps) {
    this.deps = {
      pollMs: 3000,
      probePort: (endpoint, port) => httpProbe(deps.makeClient, endpoint, port),
      now: () => Date.now(),
      ...deps
    };
  }

  reconcile(runningWorkspaceIds: string[]): void {
    const running = new Set(runningWorkspaceIds);
    for (const id of running) {
      if (!this.monitors.has(id)) this.startMonitor(id);
    }
    for (const id of [...this.monitors.keys()]) {
      if (!running.has(id)) {
        this.stopMonitor(id);
        this.closeForWorkspace(id);
      }
    }
  }

  private startMonitor(workspaceId: string): void {
    const monitor: Monitor = {
      seen: new Set<number>(),
      probeFails: new Map(),
      polling: false,
      serving: new Map(),
      timer: setInterval(() => void this.poll(workspaceId), this.deps.pollMs)
    };
    this.monitors.set(workspaceId, monitor);
  }

  private stopMonitor(workspaceId: string): void {
    const m = this.monitors.get(workspaceId);
    if (m) {
      clearInterval(m.timer);
      this.monitors.delete(workspaceId);
      if (m.serving.size > 0) this.deps.onChanged(workspaceId, []);
    }
  }

  private async poll(workspaceId: string): Promise<void> {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor || monitor.polling) return;
    monitor.polling = true;
    let client: BrokerClient | undefined;
    try {
      const endpoint = await this.deps.resolveEndpoint(workspaceId);
      client = this.deps.makeClient(endpoint);
      await client.ready();
      const details = await client.listPorts();
      const byPort = new Map(details.map((d) => [d.port, d]));
      const { newly, next } = diffPorts(
        monitor.seen,
        details.map((d) => d.port),
        this.deps.excludePorts(workspaceId)
      );
      let changed = false;
      // Serving ports that stopped listening drop out of the snapshot.
      for (const port of [...monitor.serving.keys()]) {
        if (!byPort.has(port)) {
          monitor.serving.delete(port);
          changed = true;
        }
      }
      // A pid change behind a still-listening port is a server restart:
      // replace the row and restart its uptime clock. A sessionId change
      // alone is late attribution (fd race on an earlier scan) — update in
      // place, keeping firstSeenAt.
      for (const [port, sp] of monitor.serving) {
        const d = byPort.get(port);
        if (!d) continue;
        const pid = d.pid ?? null;
        const sessionId = d.session ?? null;
        if (pid !== sp.pid) {
          monitor.serving.set(port, {
            port,
            pid,
            cmdline: d.cmdline ?? null,
            sessionId,
            firstSeenAt: this.deps.now()
          });
          changed = true;
        } else if (sessionId !== sp.sessionId) {
          monitor.serving.set(port, { ...sp, sessionId });
          changed = true;
        }
      }
      // Ports that stopped listening get a fresh probe budget if they return.
      for (const p of [...monitor.probeFails.keys()]) {
        if (!next.has(p)) monitor.probeFails.delete(p);
      }
      for (const port of newly) {
        if (await this.deps.probePort(endpoint, port)) {
          monitor.probeFails.delete(port);
          const d = byPort.get(port);
          monitor.serving.set(port, {
            port,
            pid: d?.pid ?? null,
            cmdline: d?.cmdline ?? null,
            sessionId: d?.session ?? null,
            firstSeenAt: this.deps.now()
          });
          changed = true;
          this.deps.onDetected(workspaceId, port);
          continue;
        }
        const fails = (monitor.probeFails.get(port) ?? 0) + 1;
        monitor.probeFails.set(port, fails);
        // Keep an unconfirmed port out of `seen` so the next tick re-probes it
        // (a dev server can listen before it serves). Past the attempt budget
        // it stays in `seen`: a non-HTTP listener, never reported.
        if (fails < MAX_PROBE_ATTEMPTS) next.delete(port);
      }
      // A reconcile() may have stopped this workspace while a probe was in
      // flight; the stop already broadcast the clearing snapshot, so a stale
      // poll must not resurrect ghost rows it can never clear again.
      if (this.monitors.get(workspaceId) !== monitor) return;
      monitor.seen = next;
      if (changed) this.deps.onChanged(workspaceId, servingSorted(monitor));
    } catch {
      // Broker not ready / workspace paused — skip this tick silently.
    } finally {
      client?.close();
      monitor.polling = false;
    }
  }

  /** Current Serving state across all monitored workspaces — seeds the
   *  renderer on mount/reload (`ports:list`). Workspaces with nothing
   *  serving are omitted. */
  snapshot(): Array<{ workspaceId: string; ports: ServingPort[] }> {
    const out: Array<{ workspaceId: string; ports: ServingPort[] }> = [];
    for (const [workspaceId, monitor] of this.monitors) {
      if (monitor.serving.size > 0) out.push({ workspaceId, ports: servingSorted(monitor) });
    }
    return out;
  }

  /** Terminate the process behind a serving port. The broker re-resolves
   *  port→pid at kill time; the snapshot row disappears via the normal
   *  poll once the socket closes. */
  async killPort(workspaceId: string, port: number): Promise<{ ok: boolean; error?: string }> {
    // Defense-in-depth: the kill affordance only exists for serving rows, but
    // we enforce the same boundary here so a buggy or compromised renderer
    // cannot kill infra listeners (broker socket 7070, MCP relay 7071) or any
    // never-probed non-HTTP port. The display-side INFRA_PORTS exclusions do
    // not bind the broker, so this check is the authoritative gate.
    const monitor = this.monitors.get(workspaceId);
    if (!monitor?.serving.has(port)) {
      return { ok: false, error: `port ${port} is not in the serving list` };
    }
    let client: BrokerClient | undefined;
    try {
      const endpoint = await this.deps.resolveEndpoint(workspaceId);
      client = this.deps.makeClient(endpoint);
      await client.ready();
      return await client.killPort(port);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A pre-KILLPORT broker logs-and-drops the unknown frame, so the RPC
      // times out. Translate into copy the toast can show as-is.
      if (/timed out/.test(msg)) {
        return { ok: false, error: 'runner image too old — recreate the workspace to enable kill' };
      }
      return { ok: false, error: msg };
    } finally {
      client?.close();
    }
  }

  /** Whether anything still answers on the container port — `ports:open` gates
   *  the browser launch on this so "Open preview" on a stale toast surfaces an
   *  error instead of a dead localhost tab. */
  async verifyPort(workspaceId: string, containerPort: number): Promise<boolean> {
    try {
      const endpoint = await this.deps.resolveEndpoint(workspaceId);
      return await this.deps.probePort(endpoint, containerPort);
    } catch {
      return false;
    }
  }

  async openPort(workspaceId: string, containerPort: number): Promise<{ hostPort: number }> {
    const existing = this.forwards.get(workspaceId)?.get(containerPort);
    if (existing) return { hostPort: existing.hostPort };

    const endpoint = await this.deps.resolveEndpoint(workspaceId);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      const client = this.deps.makeClient(endpoint);
      client
        .ready()
        .then(() => client.dial(1, containerPort))
        .then((resp) => {
          if (!resp.ok) {
            socket.destroy();
            client.close();
            return;
          }
          const duplex = brokerPtyStream(client, 1);
          socket.pipe(duplex);
          duplex.pipe(socket);
          let closed = false;
          const cleanup = (endSocket = false): void => {
            if (closed) return;
            closed = true;
            sockets.delete(socket);
            void client.closeChannel(1).catch(() => undefined);
            duplex.destroy();
            client.close();
            if (endSocket) socket.end();
            else socket.destroy();
          };
          socket.on('close', () => cleanup());
          socket.on('error', () => cleanup());
          duplex.on('end', () => cleanup(true));
          duplex.on('error', () => cleanup());
        })
        .catch(() => {
          sockets.delete(socket);
          socket.destroy();
          client.close();
        });
    });

    const hostPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('port-forward: no listen address'));
      });
    });

    const close = (): void => {
      server.close();
      for (const s of sockets) s.destroy();
      sockets.clear();
    };

    let byPort = this.forwards.get(workspaceId);
    if (!byPort) {
      byPort = new Map();
      this.forwards.set(workspaceId, byPort);
    }
    byPort.set(containerPort, { close, hostPort });
    return { hostPort };
  }

  closeForWorkspace(workspaceId: string): void {
    const byPort = this.forwards.get(workspaceId);
    if (!byPort) return;
    for (const fwd of byPort.values()) fwd.close();
    this.forwards.delete(workspaceId);
  }

  dispose(): void {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
    for (const id of [...this.forwards.keys()]) this.closeForWorkspace(id);
  }
}
