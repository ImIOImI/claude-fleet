// Stall sentinel (spec 2026-08-19-stall-sentinel-design.md): a second event
// loop in a worker thread. Main-and-worker stalling in the same window is
// the OS-starvation signature; main-only means a genuine main-loop blocker.
// Electron-free and perf.ts-free (perf.ts imports us — no cycles); the two
// constants mirror perf.ts's STALL_THRESHOLD_MS / SAMPLE_INTERVAL_MS.
// NEVER persisted: every app start is disarmed; the worker and the TTL
// timer are unref'd so the sentinel can never keep the app alive.

import { Worker } from 'node:worker_threads';

const SENTINEL_STALL_THRESHOLD_MS = 50;
const SENTINEL_SAMPLE_INTERVAL_MS = 5000;
const MAX_TTL_HOURS = 168;

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
setInterval(() => {
  parentPort.postMessage({ p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 });
  h.reset();
}, workerData.sampleIntervalMs);
`;

export interface SentinelStatus {
  enabled: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  lastWorkerWindow: { p50: number; p99: number; max: number; ageMs: number } | null;
}

export type SentinelWindowVerdict =
  | { workerMaxMs: number; aligned: boolean; ageMs: number }
  | { stale: true; ageMs: number };

export interface SentinelWorkerLike {
  on(event: 'message', cb: (win: { p50: number; p99: number; max: number }) => void): void;
  unref(): void;
  terminate(): Promise<unknown> | void;
}

export interface SentinelHooks {
  workerFactory?: () => SentinelWorkerLike;
  sampleIntervalMs?: number;
  now?: () => number;
}

interface State {
  worker: SentinelWorkerLike;
  startedAt: number;
  expiresAt: number | null;
  ttlTimer: NodeJS.Timeout | null;
  sampleIntervalMs: number;
  now: () => number;
  lastWindow: { p50: number; p99: number; max: number; at: number } | null;
}
let state: State | null = null;

export function armSentinel(opts?: { ttlHours?: number }, hooks?: SentinelHooks): void {
  const ttl = opts?.ttlHours;
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_HOURS)) {
    throw new Error(`ttlHours must be in (0, ${MAX_TTL_HOURS}]`);
  }
  disarmSentinel(); // idempotent re-arm: replace worker, reset TTL
  const now = hooks?.now ?? Date.now;
  const sampleIntervalMs = hooks?.sampleIntervalMs ?? SENTINEL_SAMPLE_INTERVAL_MS;
  const worker: SentinelWorkerLike =
    hooks?.workerFactory?.() ??
    new Worker(WORKER_SRC, { eval: true, workerData: { sampleIntervalMs } });
  const s: State = {
    worker,
    startedAt: now(),
    expiresAt: ttl !== undefined ? now() + ttl * 3_600_000 : null,
    ttlTimer: null,
    sampleIntervalMs,
    now,
    lastWindow: null
  };
  worker.on('message', (win) => {
    s.lastWindow = { ...win, at: s.now() };
  });
  worker.unref();
  if (ttl !== undefined) {
    s.ttlTimer = setTimeout(() => disarmSentinel(), ttl * 3_600_000);
    s.ttlTimer.unref();
  }
  state = s;
}

export function disarmSentinel(): void {
  const s = state;
  state = null;
  if (!s) return;
  if (s.ttlTimer) clearTimeout(s.ttlTimer);
  void s.worker.terminate();
}

export function sentinelStatus(): SentinelStatus {
  if (!state) return { enabled: false, startedAt: null, expiresAt: null, lastWorkerWindow: null };
  const { lastWindow, now } = state;
  return {
    enabled: true,
    startedAt: state.startedAt,
    expiresAt: state.expiresAt,
    lastWorkerWindow: lastWindow
      ? { p50: lastWindow.p50, p99: lastWindow.p99, max: lastWindow.max, ageMs: now() - lastWindow.at }
      : null
  };
}

/** Verdict for a stall observed at nowMs; null when not armed. A window
 *  older than 2 sample intervals (or never received) reports stale — an
 *  armed-but-silent worker is itself starvation evidence. */
export function sentinelWindowFor(nowMs: number): SentinelWindowVerdict | null {
  const s = state;
  if (!s) return null;
  const w = s.lastWindow;
  if (!w) return { stale: true, ageMs: nowMs - s.startedAt };
  const ageMs = nowMs - w.at;
  if (ageMs > 2 * s.sampleIntervalMs) return { stale: true, ageMs };
  return { workerMaxMs: w.max, aligned: w.max > SENTINEL_STALL_THRESHOLD_MS, ageMs };
}
