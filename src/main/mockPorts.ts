// Mock-mode stand-in for the PortForwardManager's Serving snapshot
// (CLAUDE_FLEET_MOCK=1 — no Docker, no broker). Fake dev servers appear on
// a schedule after a workspace starts so the rail's Serving section is
// fully exercisable without a container: port 3000 ("vite dev") at 10s,
// port 8765 ("python http.server") at 25s. Same onChanged/snapshot/kill
// contract as the real manager.

import type { ServingPort } from './portforward.js';

const FAKES: ReadonlyArray<{ afterMs: number; port: number; pid: number; cmdline: string; attributed: boolean }> = [
  { afterMs: 10_000, port: 3000, pid: 4242, cmdline: 'node /workspace/node_modules/.bin/vite dev', attributed: true },
  { afterMs: 25_000, port: 8765, pid: 4343, cmdline: 'python3 -m http.server 8765', attributed: false }
];

export class MockServingPorts {
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly serving = new Map<string, Map<number, ServingPort>>();

  constructor(
    private readonly onChanged: (workspaceId: string, ports: ServingPort[]) => void,
    private readonly now: () => number = Date.now,
    /** Maps a workspace to the broker session id its first fake port is
     *  attributed to (mock stand-in for the broker's ancestry walk).
     *  Undefined/null → the port renders without a session chip. */
    private readonly resolveSessionId?: (workspaceId: string) => Promise<string | null>
  ) {}

  reconcile(runningIds: string[]): void {
    const running = new Set(runningIds);
    for (const id of running) {
      if (this.timers.has(id)) continue;
      this.timers.set(
        id,
        FAKES.map((f) => setTimeout(() => this.add(id, f), f.afterMs))
      );
    }
    for (const id of [...this.timers.keys()]) {
      if (!running.has(id)) this.stop(id);
    }
  }

  private add(id: string, f: (typeof FAKES)[number]): void {
    const sessionIdPromise = f.attributed && this.resolveSessionId
      ? this.resolveSessionId(id).catch(() => null)
      : null;

    if (!sessionIdPromise) {
      // Synchronous path for backward compatibility (no resolveSessionId)
      let ports = this.serving.get(id);
      if (!ports) {
        ports = new Map();
        this.serving.set(id, ports);
      }
      ports.set(f.port, { port: f.port, pid: f.pid, cmdline: f.cmdline, sessionId: null, firstSeenAt: this.now() });
      this.emit(id);
      return;
    }

    // Async path: resolve the session id first, then add the port
    void sessionIdPromise.then((sessionId) => {
      if (!this.timers.has(id)) return; // stopped while resolving
      let ports = this.serving.get(id);
      if (!ports) {
        ports = new Map();
        this.serving.set(id, ports);
      }
      ports.set(f.port, { port: f.port, pid: f.pid, cmdline: f.cmdline, sessionId, firstSeenAt: this.now() });
      this.emit(id);
    });
  }

  private stop(id: string): void {
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
    if (this.serving.delete(id)) this.onChanged(id, []);
  }

  private emit(id: string): void {
    const ports = [...(this.serving.get(id)?.values() ?? [])].sort((a, b) => a.port - b.port);
    this.onChanged(id, ports);
  }

  snapshot(): Array<{ workspaceId: string; ports: ServingPort[] }> {
    return [...this.serving.entries()]
      .filter(([, m]) => m.size > 0)
      .map(([workspaceId, m]) => ({
        workspaceId,
        ports: [...m.values()].sort((a, b) => a.port - b.port)
      }));
  }

  kill(workspaceId: string, port: number): { ok: boolean; error?: string } {
    const ports = this.serving.get(workspaceId);
    if (!ports?.delete(port)) return { ok: false, error: 'no such port' };
    this.emit(workspaceId);
    return { ok: true };
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.stop(id);
  }
}
