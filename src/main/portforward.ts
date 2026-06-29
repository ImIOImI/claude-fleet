// Port-forward + dev-server detection over the broker socket.
//
// Two responsibilities, both riding the existing broker transport (unix
// socket on Linux/macOS, loopback TCP on Windows):
//
//  - PortMonitor: per running workspace, poll the broker's LISTPORTS every
//    `pollMs` and emit `onDetected(workspaceId, port)` the first time a port
//    appears (a port that stays open is reported once; one that disappears
//    and returns is reported again).
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
  excludePorts(workspaceId: string): number[];
  pollMs?: number;
}

interface Monitor {
  timer: NodeJS.Timeout;
  seen: Set<number>;
}

interface Forward {
  close(): void;
  hostPort: number;
}

export class PortForwardManager {
  private readonly deps: Required<PortForwardDeps>;
  private readonly monitors = new Map<string, Monitor>();
  // workspaceId → containerPort → forward (dedupe re-opens of the same port).
  private readonly forwards = new Map<string, Map<number, Forward>>();

  constructor(deps: PortForwardDeps) {
    this.deps = { pollMs: 3000, ...deps };
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
    const seen = new Set<number>();
    const monitor: Monitor = {
      seen,
      timer: setInterval(() => void this.poll(workspaceId), this.deps.pollMs)
    };
    this.monitors.set(workspaceId, monitor);
  }

  private stopMonitor(workspaceId: string): void {
    const m = this.monitors.get(workspaceId);
    if (m) {
      clearInterval(m.timer);
      this.monitors.delete(workspaceId);
    }
  }

  private async poll(workspaceId: string): Promise<void> {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor) return;
    let client: BrokerClient | undefined;
    try {
      const endpoint = await this.deps.resolveEndpoint(workspaceId);
      client = this.deps.makeClient(endpoint);
      await client.ready();
      const ports = await client.listPorts();
      const { newly, next } = diffPorts(monitor.seen, ports, this.deps.excludePorts(workspaceId));
      monitor.seen = next;
      for (const port of newly) this.deps.onDetected(workspaceId, port);
    } catch {
      // Broker not ready / workspace paused — skip this tick silently.
    } finally {
      client?.close();
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
