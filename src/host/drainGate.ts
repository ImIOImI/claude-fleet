// The workspace pod's drain as fleet-host sees it (SPEC §7 *Workspace pod drain*, D148): one persistent
// WATCH connection, reduced to serving / draining / unknown / legacy and published as sticky `broker:drain`.
import type { BrokerState } from '../main/broker.js';
import type { BrokerOps } from './brokerOps.js';
import type { EventHub } from './events.js';
import type { Logger } from './log.js';

export type GatePhase = 'serving' | 'draining' | 'unknown' | 'legacy';
export const LEGACY_AFTER_MS = 5_000;
export const WATCH_RETRY_MS = 1_000;
export const WATCH_RETRY_MAX_MS = 10_000;
/** 3 × the broker's 5 s STATE heartbeat: a half-open WATCH (node loss, partition) must not pin the phase. */
export const WATCH_STALE_MS = 15_000;
const ENDED_MEMORY = 1_000;

export interface DrainEvent {
  phase: 'serving' | 'draining' | 'unknown';
  softAt: number | null;
  hardAt: number | null;
  instance: string | null;
}

export interface DrainGate {
  phase(): GatePhase;
  /** The last STATE from the broker currently or last watched. */
  last(): BrokerState | null;
  /** How a session ended, on any broker instance seen since start. */
  ended(sessionId: string): string | undefined;
  /** True once serving or legacy; false after maxMs. */
  waitServing(maxMs: number): Promise<boolean>;
  /** Called after every STATE and every phase change. */
  subscribe(fn: (phase: GatePhase, s: BrokerState | null) => void): () => void;
  stop(): void;
}

export interface DrainGateOptions {
  ops: Pick<BrokerOps, 'watch'>;
  log: Logger;
  events: Pick<EventHub, 'publishSticky'>;
  legacyMs?: number;
  retryMs?: number;
  retryMaxMs?: number;
  staleMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export const isOpen = (p: GatePhase): boolean => p === 'serving' || p === 'legacy';

export function startDrainGate(o: DrainGateOptions): DrainGate {
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  });
  const retryStart = o.retryMs ?? WATCH_RETRY_MS;
  const listeners = new Set<(p: GatePhase, s: BrokerState | null) => void>();
  const endedBy = new Map<string, string>();
  let phase: GatePhase = o.ops.watch ? 'unknown' : 'legacy';
  let last: BrokerState | null = null;
  let stopped = false;
  let delay = retryStart;
  let pending: (() => void) | null = null;
  let current: { stop(): void } | null = null;

  const emit = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn(phase, last);
      } catch (err) {
        o.log.log('warn', 'drain listener failed', { error: (err as Error).message });
      }
    }
  };
  const publish = (): void => {
    const draining = phase === 'draining';
    const e: DrainEvent = {
      phase: isOpen(phase) ? 'serving' : draining ? 'draining' : 'unknown',
      softAt: draining ? last?.softAt ?? null : null,
      hardAt: draining ? last?.hardAt ?? null : null,
      instance: last?.instance ?? null
    };
    o.events.publishSticky('broker:drain', e);
  };
  const setPhase = (p: GatePhase): void => {
    if (p === phase) return;
    const was = phase;
    phase = p;
    o.log.log(isOpen(p) ? 'info' : 'warn', 'broker drain state', { phase: p, was, instance: last?.instance ?? null });
    publish();
  };
  const remember = (s: BrokerState): void => {
    for (const x of s.sessions) {
      if (!x.ended || endedBy.get(x.id) === x.ended) continue;
      endedBy.delete(x.id);
      endedBy.set(x.id, x.ended);
      if (endedBy.size > ENDED_MEMORY) endedBy.delete(endedBy.keys().next().value as string);
    }
  };
  const retry = (): void => {
    if (stopped || pending) return;
    const ms = delay;
    delay = Math.min(delay * 2, o.retryMaxMs ?? WATCH_RETRY_MAX_MS);
    pending = schedule(() => {
      pending = null;
      connect();
    }, ms);
  };
  const connect = (): void => {
    const watch = o.ops.watch;
    if (stopped || !watch) return;
    let gotState = false;
    let closed = false;
    let legacy: (() => void) | null = null;
    let stale: (() => void) | null = null;
    let handle: { stop(): void } | null = null;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      legacy?.();
      legacy = null;
      stale?.();
      stale = null;
      current = null;
      if (stopped) return;
      setPhase('unknown');
      emit();
      retry();
    };
    const armStale = (): void => {
      stale?.();
      stale = schedule(() => {
        stale = null;
        if (closed || stopped) return;
        o.log.log('warn', 'broker watch went quiet; reconnecting', { ms: o.staleMs ?? WATCH_STALE_MS });
        handle?.stop();
        onClose();
      }, o.staleMs ?? WATCH_STALE_MS);
    };
    watch({
      onState: (s) => {
        if (stopped || closed) return;
        gotState = true;
        legacy?.();
        legacy = null;
        armStale();
        delay = retryStart;
        last = s;
        remember(s);
        // Anything but serving (done, or a phase the codec didn't know) holds dispatch.
        setPhase(s.phase === 'serving' ? 'serving' : 'draining');
        emit();
      },
      onClose
    }).then(
      (w) => {
        if (stopped) return w.stop();
        // The watchdog fired before the connection resolved.
        if (closed) return w.stop();
        handle = w;
        current = w;
        if (!gotState) {
          legacy = schedule(() => {
            legacy = null;
            if (!gotState && !closed) {
              setPhase('legacy');
              emit();
            }
          }, o.legacyMs ?? LEGACY_AFTER_MS);
        }
      },
      (err: Error) => {
        if (stopped) return;
        o.log.log('warn', 'broker watch failed', { error: err.message });
        setPhase('unknown');
        emit();
        retry();
      }
    );
  };

  const subscribe = (fn: (p: GatePhase, s: BrokerState | null) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  publish();
  connect();
  return {
    phase: () => phase,
    last: () => last,
    ended: (id) => endedBy.get(id),
    subscribe,
    waitServing(maxMs) {
      if (isOpen(phase)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let cancel: () => void = () => undefined;
        const off = subscribe((p) => {
          if (!isOpen(p)) return;
          off();
          cancel();
          resolve(true);
        });
        cancel = schedule(() => {
          off();
          resolve(false);
        }, maxMs);
      });
    },
    stop() {
      stopped = true;
      pending?.();
      pending = null;
      current?.stop();
      current = null;
      listeners.clear();
    }
  };
}
