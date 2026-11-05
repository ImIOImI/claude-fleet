// Declared port exposure (docs/superpowers/specs/2026-11-05-port-exposure-design.md):
// joins expose_port declarations with the broker scan's Serving snapshots,
// decides when the preview popup shows, and records each port appearance.
import { ulid } from 'ulid';
import type { ServingPort } from './portforward.js';
import type { WorkspaceKind } from './workspaces.js';
import type { ExposurePatch, ExposureRow, ExposureSink, OpenVia } from './portExposureStore.js';

export const EPHEMERAL_MIN = 32768;
export const EPHEMERAL_MAX = 60999;
export const DECLARE_WAIT_MS = 30_000;
export const DECLARE_RATE_PER_MIN = 10;
const MINUTE_MS = 60_000;
const LABEL_MAX = 80;
const REASON_MAX = 200;
const LOCAL_END_AFTER_FAILS = 2;

/** Linux's default ip_local_port_range — what `listen(0)` hands out. */
export function isEphemeralPort(port: number): boolean {
  return port >= EPHEMERAL_MIN && port <= EPHEMERAL_MAX;
}

export interface PortPopup {
  workspaceId: string;
  port: number;
  label: string | null;
  reason: string | null;
  cmdline: string | null;
  /** false: the undeclared fallback fired. */
  declared: boolean;
}

export interface PortExposureDeps {
  sink: ExposureSink;
  workspace(workspaceId: string): Promise<{ kind: WorkspaceKind; running: boolean } | null>;
  onPopup(p: PortPopup): void;
  /** A label changed; re-send this workspace's Serving rows. */
  onLabelsChanged(workspaceId: string): void;
  /** `ports.undeclaredToastAfterSec`; 0 disables the fallback. */
  undeclaredToastAfterSec(): Promise<number>;
  /** Host-side HTTP probe for local workspaces (no broker scan). */
  probeLocal(port: number): Promise<boolean>;
  onWriteError?(err: unknown): void;
  now?(): number;
  localPollMs?: number;
}

type TimerSlot = 'waitTimer' | 'fallbackTimer' | 'pollTimer';

interface Live {
  row: ExposureRow;
  /** Passed the probe: in a Serving snapshot (container) or the host probe (local). */
  serving: boolean;
  local: boolean;
  declaredPopup: boolean;
  waitTimer: NodeJS.Timeout | null;
  fallbackTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  localFails: number;
  /** The insert must land before any update. */
  writes: Promise<void>;
}

const keyOf = (workspaceId: string, port: number): string => `${workspaceId}:${port}`;

function parseDeclare(a: Record<string, unknown>): { port: number; label: string; reason: string | null } {
  const port = typeof a.port === 'string' && /^\d+$/.test(a.port) ? Number(a.port) : a.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer 1–65535');
  }
  if (isEphemeralPort(port)) {
    throw new Error(
      `port ${port} is in the ephemeral range (${EPHEMERAL_MIN}–${EPHEMERAL_MAX}) the OS assigns to throwaway ` +
        `listeners such as test servers; bind the server to a fixed port below ${EPHEMERAL_MIN} and declare that`
    );
  }
  const label = typeof a.label === 'string' ? a.label.trim() : '';
  if (!label || label.length > LABEL_MAX) throw new Error(`label is required (1–${LABEL_MAX} chars)`);
  let reason: string | null = null;
  if (a.reason !== undefined && a.reason !== null) {
    if (typeof a.reason !== 'string' || a.reason.length > REASON_MAX) {
      throw new Error(`reason must be a string of at most ${REASON_MAX} chars`);
    }
    reason = a.reason.trim() || null;
  }
  return { port, label, reason };
}

export class PortExposureService {
  private readonly live = new Map<string, Live>();
  private readonly hits = new Map<string, number[]>();
  private allWrites: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly localPollMs: number;

  constructor(private readonly deps: PortExposureDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.localPollMs = deps.localPollMs ?? 3000;
  }

  async declare(workspaceId: string, args: Record<string, unknown>): Promise<{ status: 'shown' | 'waiting' }> {
    const { port, label, reason } = parseDeclare(args);
    this.takeRate(workspaceId);
    const ws = await this.deps.workspace(workspaceId);
    if (!ws) throw new Error('unknown workspace');
    if (ws.kind === 'remote') throw new Error('expose_port is not supported for remote workspaces yet');
    if (!ws.running) throw new Error('workspace is not running');

    const existing = this.live.get(keyOf(workspaceId, port));
    if (existing) {
      const patch: ExposurePatch = { label, reason };
      if (existing.row.declaredAt === null) {
        patch.declaredAt = this.now();
        patch.source = 'both';
      }
      this.patch(existing, patch);
      this.deps.onLabelsChanged(workspaceId);
      if (!existing.serving) return { status: 'waiting' };
      if (!existing.declaredPopup) this.showPopup(existing, true);
      return { status: 'shown' };
    }

    const l = this.open(workspaceId, port, { source: 'declared', declaredAt: this.now(), label, reason }, ws.kind === 'local');
    this.deps.onLabelsChanged(workspaceId);
    l.waitTimer = setTimeout(() => {
      l.waitTimer = null;
      if (!l.serving && this.isCurrent(l)) this.end(l);
    }, DECLARE_WAIT_MS);
    if (l.local) this.startLocalPoll(l);
    return { status: 'waiting' };
  }

  onSnapshot(workspaceId: string, ports: ServingPort[]): void {
    const present = new Set<number>();
    for (const sp of ports) {
      if (isEphemeralPort(sp.port)) continue;
      present.add(sp.port);
      const l = this.live.get(keyOf(workspaceId, sp.port));
      if (!l) {
        const n = this.open(
          workspaceId,
          sp.port,
          { source: 'scanned', firstScannedAt: this.now(), sessionId: sp.sessionId, cmdline: sp.cmdline },
          false
        );
        n.serving = true;
        void this.scheduleFallback(n);
      } else if (l.local) {
        continue;
      } else if (!l.serving) {
        l.serving = true;
        this.clearTimer(l, 'waitTimer');
        this.patch(l, { source: 'both', firstScannedAt: this.now(), sessionId: sp.sessionId, cmdline: sp.cmdline });
        this.showPopup(l, true);
      } else if (sp.sessionId !== l.row.sessionId || sp.cmdline !== l.row.cmdline) {
        this.patch(l, { sessionId: sp.sessionId, cmdline: sp.cmdline });
      }
    }
    for (const l of [...this.live.values()]) {
      if (l.row.workspaceId === workspaceId && !l.local && l.serving && !present.has(l.row.port)) this.end(l);
    }
  }

  recordOpen(workspaceId: string, port: number, via: OpenVia): void {
    const l = this.live.get(keyOf(workspaceId, port));
    if (!l) return;
    this.patch(l, { openCount: l.row.openCount + 1, openedVia: l.row.openedVia ?? via, outcome: 'opened' });
  }

  recordDismiss(workspaceId: string, port: number): void {
    const l = this.live.get(keyOf(workspaceId, port));
    if (!l || l.row.outcome !== null) return;
    this.patch(l, { outcome: 'dismissed' });
  }

  labelFor(workspaceId: string, port: number): string | null {
    return this.live.get(keyOf(workspaceId, port))?.row.label ?? null;
  }

  isLocalServing(workspaceId: string, port: number): boolean {
    const l = this.live.get(keyOf(workspaceId, port));
    return !!l && l.local && l.serving;
  }

  /** Settles every queued write. */
  flush(): Promise<unknown> {
    return this.allWrites;
  }

  dispose(): void {
    for (const l of this.live.values()) {
      for (const slot of ['waitTimer', 'fallbackTimer', 'pollTimer'] as const) this.clearTimer(l, slot);
    }
    this.live.clear();
  }

  private open(workspaceId: string, port: number, init: Partial<ExposureRow>, local: boolean): Live {
    const row: ExposureRow = {
      id: ulid(),
      workspaceId,
      port,
      sessionId: null,
      cmdline: null,
      label: null,
      reason: null,
      source: 'scanned',
      firstScannedAt: null,
      declaredAt: null,
      popupShownAt: null,
      outcome: null,
      openedVia: null,
      openCount: 0,
      endedAt: null,
      ...init
    };
    const l: Live = {
      row,
      serving: false,
      local,
      declaredPopup: false,
      waitTimer: null,
      fallbackTimer: null,
      pollTimer: null,
      localFails: 0,
      writes: this.deps.sink.insert({ ...row }).catch((e) => this.deps.onWriteError?.(e))
    };
    this.allWrites = this.allWrites.then(() => l.writes);
    this.live.set(keyOf(workspaceId, port), l);
    return l;
  }

  private patch(l: Live, p: ExposurePatch): void {
    Object.assign(l.row, p);
    l.writes = l.writes.then(() => this.deps.sink.update(l.row.id, p)).catch((e) => this.deps.onWriteError?.(e));
    this.allWrites = this.allWrites.then(() => l.writes);
  }

  private showPopup(l: Live, declared: boolean): void {
    if (declared) l.declaredPopup = true;
    this.clearTimer(l, 'fallbackTimer');
    if (l.row.popupShownAt === null) this.patch(l, { popupShownAt: this.now() });
    const { workspaceId, port, label, reason, cmdline } = l.row;
    this.deps.onPopup({ workspaceId, port, label, reason, cmdline, declared });
  }

  private async scheduleFallback(l: Live): Promise<void> {
    const sec = await this.deps.undeclaredToastAfterSec().catch(() => 0);
    if (sec <= 0 || !this.isCurrent(l) || l.row.declaredAt !== null) return;
    l.fallbackTimer = setTimeout(() => {
      l.fallbackTimer = null;
      if (this.isCurrent(l) && l.row.declaredAt === null && l.row.popupShownAt === null) this.showPopup(l, false);
    }, sec * 1000);
  }

  private startLocalPoll(l: Live): void {
    const tick = async (): Promise<void> => {
      l.pollTimer = null;
      const ok = await this.deps.probeLocal(l.row.port).catch(() => false);
      if (!this.isCurrent(l)) return;
      if (ok) {
        l.localFails = 0;
        if (!l.serving) {
          l.serving = true;
          this.clearTimer(l, 'waitTimer');
          this.patch(l, { firstScannedAt: this.now() });
          this.showPopup(l, true);
        }
      } else if (l.serving && ++l.localFails >= LOCAL_END_AFTER_FAILS) {
        this.end(l);
        return;
      }
      l.pollTimer = setTimeout(() => void tick(), this.localPollMs);
    };
    void tick();
  }

  private end(l: Live): void {
    for (const slot of ['waitTimer', 'fallbackTimer', 'pollTimer'] as const) this.clearTimer(l, slot);
    this.live.delete(keyOf(l.row.workspaceId, l.row.port));
    this.patch(l, { endedAt: this.now(), outcome: l.row.outcome ?? (l.serving ? 'ignored' : 'not_serving') });
  }

  private clearTimer(l: Live, slot: TimerSlot): void {
    const t = l[slot];
    if (t) clearTimeout(t);
    l[slot] = null;
  }

  private isCurrent(l: Live): boolean {
    return this.live.get(keyOf(l.row.workspaceId, l.row.port)) === l;
  }

  private takeRate(workspaceId: string): void {
    const now = this.now();
    const recent = (this.hits.get(workspaceId) ?? []).filter((t) => now - t < MINUTE_MS);
    if (recent.length >= DECLARE_RATE_PER_MIN) {
      this.hits.set(workspaceId, recent);
      throw new Error(`rate limited: at most ${DECLARE_RATE_PER_MIN} expose_port calls per minute`);
    }
    recent.push(now);
    this.hits.set(workspaceId, recent);
  }
}
