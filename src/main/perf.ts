// Perf telemetry runtime (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md).
// Owns the OTel SDK lifecycle in main. All instrumentation goes through the
// @opentelemetry/api globals, so when no provider is registered (recording
// off) every perfSpan/metric call is a no-op — instrumentation sites cost
// ~nothing while disabled. Two export paths per signal: the SQLite exporters
// (always on while recording) feed the local perf_events table; OTLP HTTP
// exporters are added only when effective.otlp.enabled.

import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { disarmSentinel, sentinelStatus, sentinelWindowFor, type SentinelStatus } from './perfSentinel.js';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { context, metrics, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { Counter, Histogram } from '@opentelemetry/api';
import {
  BasicTracerProvider, BatchSpanProcessor,
  type ReadableSpan, type SpanExporter
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  AggregationTemporality, MeterProvider, PeriodicExportingMetricReader,
  type PushMetricExporter, type ResourceMetrics
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { EffectivePerfConfig } from './perfConfig.js';
import type { PerfStore } from './perfStore.js';
import { RETENTION_MS } from './perfStore.js';

export const SLOW_OP_MS = 25;
export const FLUSH_INTERVAL_MS = 5000;
export const STALL_THRESHOLD_MS = 50;
export const SAMPLE_INTERVAL_MS = 5000;
const TRACER_NAME = 'claude-fleet';
const METER_NAME = 'claude-fleet';
export type LatencyKind = 'input_hop' | 'output_hop' | 'echo_rtt';
const TERMINAL_METRIC_PREFIX = 'claude_fleet.terminal.';
const LATENCY_KINDS: readonly LatencyKind[] = ['input_hop', 'output_hop', 'echo_rtt'];

/** Maps finished spans → slow_op rows. Spans faster than SLOW_OP_MS are
 *  dropped here (the OTLP exporter, when registered, still gets them all). */
export class SqliteSpanExporter implements SpanExporter {
  constructor(private readonly store: PerfStore) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    for (const s of spans) {
      const durMs = hrTimeToMilliseconds(s.duration);
      if (durMs < SLOW_OP_MS) continue;
      const attrs = s.attributes as Record<string, unknown>;
      this.store.enqueue({
        ts: hrTimeToMilliseconds(s.startTime),
        kind: 'slow_op',
        name: s.name,
        durMs,
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        workspaceId: typeof attrs.workspace_id === 'string' ? attrs.workspace_id : null,
        sessionId: typeof attrs.session_id === 'string' ? attrs.session_id : null,
        meta: Object.keys(attrs).length > 0 ? attrs : null
      });
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Maps DELTA counter data points → pty_window rows and terminal-latency histogram points → input_hop/output_hop/echo_rtt rows. Gauge metrics (the
 *  event-loop delay percentiles, exported for OTLP dashboards) are skipped:
 *  their local representation is the thresholded stall row the sampler
 *  writes directly. */
export class SqliteMetricExporter implements PushMetricExporter {
  constructor(private readonly store: PerfStore) {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  export(resourceMetrics: ResourceMetrics, done: (result: ExportResult) => void): void {
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        const name = metric.descriptor.name;
        if (name.startsWith('claude_fleet.pty.')) {
          for (const dp of metric.dataPoints) {
            const value = typeof dp.value === 'number' ? dp.value : 0;
            if (value === 0) continue;
            const attrs = dp.attributes as Record<string, unknown>;
            const workspaceIdRaw = typeof attrs.workspace_id === 'string' ? attrs.workspace_id : null;
            this.store.enqueue({
              ts: Date.now(),
              kind: 'pty_window',
              name,
              // Normalize '' workspace_id to null
              workspaceId: workspaceIdRaw === '' ? null : workspaceIdRaw,
              sessionId: typeof attrs.session_id === 'string' ? attrs.session_id : null,
              meta: { value }
            });
          }
        } else if (name.startsWith(TERMINAL_METRIC_PREFIX)) {
          const kind = name.slice(TERMINAL_METRIC_PREFIX.length) as LatencyKind;
          if (!LATENCY_KINDS.includes(kind)) continue;
          for (const dp of metric.dataPoints) {
            // Histogram data point: { count, sum, min?, max?, buckets: { boundaries, counts } }
            const v = dp.value as {
              count: number; sum?: number; min?: number; max?: number;
              buckets?: { boundaries: number[]; counts: number[] };
            };
            if (!v || typeof v.count !== 'number' || v.count === 0) continue;
            const attrs = dp.attributes as Record<string, unknown>;
            const ws = typeof attrs.workspace_id === 'string' && attrs.workspace_id !== '' ? attrs.workspace_id : null;
            const sess = typeof attrs.session_id === 'string' && attrs.session_id !== '' ? attrs.session_id : null;
            this.store.enqueue({
              ts: Date.now(),
              kind,
              name,
              workspaceId: ws,
              sessionId: sess,
              durMs: v.max ?? null,
              meta: {
                count: v.count,
                sum: v.sum ?? null,
                min: v.min ?? null,
                max: v.max ?? null,
                buckets: v.buckets ?? null
              }
            });
          }
        }
      }
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface PerfInitHooks {
  /** Test seam: replaces the monitorEventLoopDelay read (values in ms). */
  delaySource?: () => { p50: number; p99: number; max: number };
  sampleIntervalMs?: number;
}

interface Runtime {
  store: PerfStore;
  effective: EffectivePerfConfig;
  tracerProvider: BasicTracerProvider | null;
  flushTimer: NodeJS.Timeout | null;
  meterProvider: MeterProvider | null;
  sampleTimer: NodeJS.Timeout | null;
  loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null;
  ptyBytes: Counter | null;
  ptyChunks: Counter | null;
  latencyHists: Record<LatencyKind, Histogram> | null;
  sampleIntervalMs: number;
  gcObserver: PerformanceObserver | null;
}
let rt: Runtime | null = null;

/** Injected broadcaster for the one-way perf:state push (ipc.ts wires it to
 *  BrowserWindow — perf.ts stays Electron-free for testability). Fired with
 *  the effective recording state at the end of every initPerf, which covers
 *  reconfigurePerf too (it delegates to shutdown+init). */
let stateListener: ((recording: boolean) => void) | null = null;
export function setPerfStateListener(cb: ((recording: boolean) => void) | null): void {
  stateListener = cb;
}

// OS-suspend awareness (spec 2026-08-11-perf-stall-fixes-design.md F3).
// While the machine sleeps no code runs, but the sampler's next read sees
// the whole gap as one giant "delay" — six ~66 s phantom stalls per night
// in the first dogfood. ipc.ts wires Electron powerMonitor to this (perf.ts
// stays Electron-free); windows overlapping suspend→resume, plus the first
// window after resume, are read-and-discarded instead of recorded.
let suspendedAtWall: number | null = null;
let discardUntilWall = 0;
export function perfNotePowerEvent(event: 'suspend' | 'resume'): void {
  if (event === 'suspend') {
    suspendedAtWall = Date.now();
  } else {
    suspendedAtWall = null;
    discardUntilWall = Date.now() + (rt?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
  }
}

export interface PerfStatus {
  enabled: boolean;
  source: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
  eventCounts: Record<string, number>;
  sentinel: SentinelStatus;
}

export function getEffectivePerf(): EffectivePerfConfig | null {
  return rt?.effective ?? null;
}

/** One-call status for perf_status (MCP) and perf:status (Settings UI). */
export function getPerfStatus(): PerfStatus {
  if (!rt) throw new Error('perf not initialized');
  rt.store.flush(); // counts include anything still buffered
  return {
    enabled: rt.effective.recording,
    source: rt.effective.recordingSource,
    otlp: rt.effective.otlp,
    eventCounts: rt.store.counts24h(),
    sentinel: sentinelStatus()
  };
}

/** System-wide busy fraction since the previous call (0..1, 3 decimals).
 *  Starving hosts show sustained ~1.0 — stamped on every stall row so
 *  starvation is diagnosable even without the sentinel armed. */
function makeCpuSampler(): () => number {
  let prev = cpus();
  return () => {
    const cur = cpus();
    let idle = 0;
    let total = 0;
    for (let i = 0; i < cur.length; i += 1) {
      const c = cur[i].times;
      const p = prev[i]?.times ?? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
      idle += c.idle - p.idle;
      total += c.user - p.user + c.nice - p.nice + c.sys - p.sys + c.idle - p.idle + c.irq - p.irq;
    }
    prev = cur;
    if (total <= 0) return 0;
    return Math.round((1 - idle / total) * 1000) / 1000;
  };
}

export function initPerf(store: PerfStore, effective: EffectivePerfConfig, hooks?: PerfInitHooks): void {
  if (rt) throw new Error('initPerf called twice — use reconfigurePerf');
  rt = {
    store,
    effective,
    tracerProvider: null,
    flushTimer: null,
    meterProvider: null,
    sampleTimer: null,
    loopHistogram: null,
    ptyBytes: null,
    ptyChunks: null,
    latencyHists: null,
    sampleIntervalMs: hooks?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS,
    gcObserver: null
  };
  store.prune(RETENTION_MS);
  if (!effective.recording) {
    stateListener?.(effective.recording);
    return; // globals stay no-op
  }

  // Context propagation: lets perfSpan* parent nested spans and lets
  // perfSetSpanContext reach the active span. Without a registered manager
  // the API's context.with is a passthrough and getActiveSpan is undefined.
  const ctxManager = new AsyncLocalStorageContextManager();
  ctxManager.enable();
  context.setGlobalContextManager(ctxManager);

  const processors = [
    new BatchSpanProcessor(new SqliteSpanExporter(store), { scheduledDelayMillis: FLUSH_INTERVAL_MS })
  ];
  if (effective.otlp.enabled && effective.otlp.endpoint) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: otlpSignalUrl(effective.otlp.endpoint, 'traces') }),
        { scheduledDelayMillis: FLUSH_INTERVAL_MS }
      )
    );
  }
  rt.tracerProvider = new BasicTracerProvider({ spanProcessors: processors });
  trace.setGlobalTracerProvider(rt.tracerProvider);

  rt.flushTimer = setInterval(() => {
    perfSpan('claude_fleet.perf.flush', () => rt?.store.flush());
  }, FLUSH_INTERVAL_MS);
  rt.flushTimer.unref();

  // Metrics pipeline
  const readers = [
    new PeriodicExportingMetricReader({
      exporter: new SqliteMetricExporter(store),
      exportIntervalMillis: hooks?.sampleIntervalMs ?? FLUSH_INTERVAL_MS
    })
  ];
  if (effective.otlp.enabled && effective.otlp.endpoint) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlpSignalUrl(effective.otlp.endpoint, 'metrics') }),
        exportIntervalMillis: FLUSH_INTERVAL_MS
      })
    );
  }
  rt.meterProvider = new MeterProvider({ readers });
  metrics.setGlobalMeterProvider(rt.meterProvider);

  const meter = metrics.getMeter(METER_NAME);
  rt.ptyBytes = meter.createCounter('claude_fleet.pty.bytes', { description: 'PTY output bytes forwarded to the renderer' });
  rt.ptyChunks = meter.createCounter('claude_fleet.pty.chunks', { description: 'PTY output chunks forwarded to the renderer' });
  rt.latencyHists = Object.fromEntries(
    LATENCY_KINDS.map((k) => [
      k,
      meter.createHistogram(`${TERMINAL_METRIC_PREFIX}${k}`, {
        unit: 'ms',
        description: 'User-perceived terminal latency hop (perf telemetry Phase 2)'
      })
    ])
  ) as Record<LatencyKind, Histogram>;

  rt.gcObserver = new PerformanceObserver((list) => {
    recordGcEntries(list.getEntries() as unknown as Array<{ startTime: number; duration: number; detail?: unknown }>);
  });
  rt.gcObserver.observe({ entryTypes: ['gc'] });

  // Event-loop delay: gauges follow OTel semconv naming for OTLP dashboards;
  // the local record is the thresholded stall row.
  const lastWindow = { p50: 0, p99: 0, max: 0 };
  for (const [pct, key] of [['p50', 'p50'], ['p99', 'p99'], ['max', 'max']] as const) {
    meter
      .createObservableGauge(`nodejs.eventloop.delay.${pct}`, { unit: 'ms' })
      .addCallback((r) => r.observe(lastWindow[key]));
  }

  let readDelay: () => { p50: number; p99: number; max: number };
  if (hooks?.delaySource) {
    readDelay = hooks.delaySource;
    rt.loopHistogram = null;
  } else {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    rt.loopHistogram = h;
    readDelay = () => {
      const w = { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 };
      h.reset();
      return w;
    };
  }
  const cpuSample = makeCpuSampler();
  rt.sampleTimer = setInterval(() => {
    const w = readDelay();
    if (suspendedAtWall !== null || Date.now() < discardUntilWall) return; // sleep gap, not a block
    Object.assign(lastWindow, w);
    if (w.max > STALL_THRESHOLD_MS) {
      const nowMs = Date.now();
      const sv = sentinelWindowFor(nowMs);
      rt?.store.enqueue({
        ts: nowMs,
        kind: 'stall',
        durMs: w.max,
        meta: { ...w, cpu: { utilization: cpuSample() }, ...(sv ? { sentinel: sv } : {}) }
      });
    }
  }, hooks?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
  rt.sampleTimer.unref();

  stateListener?.(effective.recording);
}

export async function shutdownPerf(): Promise<void> {
  suspendedAtWall = null;
  discardUntilWall = 0;
  disarmSentinel();
  if (!rt) return;
  const r = rt;
  rt = null;
  if (r.flushTimer) clearInterval(r.flushTimer);
  if (r.sampleTimer) clearInterval(r.sampleTimer);
  r.loopHistogram?.disable();
  r.gcObserver?.disconnect();
  await r.meterProvider?.shutdown().catch(() => undefined); // final metric collection → exporter
  await r.tracerProvider?.shutdown().catch(() => undefined); // flushes batch processors
  trace.disable();
  metrics.disable();
  // context.disable() resets the global manager, so a later initPerf can re-register one.
  context.disable();
  r.store.flush();
}

export async function reconfigurePerf(effective: EffectivePerfConfig): Promise<void> {
  const store = rt?.store;
  if (!store) throw new Error('reconfigurePerf before initPerf');
  await shutdownPerf();
  initPerf(store, effective);
}

/** OTLP/HTTP per-signal URL: `<endpoint>/v1/<signal>` (standard layout). */
export function otlpSignalUrl(endpoint: string, signal: 'traces' | 'metrics'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

export function perfSpan<T>(name: string, fn: () => T, attrs?: Attributes): T {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs });
  try {
    return context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T> | T,
  attrs?: Attributes
): Promise<T> {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs });
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

/** Stamp workspace/session attribution onto the active span, for handlers
 *  that only learn the ids after work starts (pty:attach owner lookup,
 *  pty:input handle map). No-op outside a span or while recording is off. */
export function perfSetSpanContext(ctx: { workspaceId?: string; sessionId?: string }): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (typeof ctx.workspaceId === 'string') span.setAttribute('workspace_id', ctx.workspaceId);
  if (typeof ctx.sessionId === 'string') span.setAttribute('session_id', ctx.sessionId);
}

const GC_KIND_NAMES: Record<number, string> = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' };

/** GC pauses are synchronous stops no span can capture — the 2026-08-17
 *  analysis found 84% of surviving big stalls overlap no instrumented op.
 *  Entries >= SLOW_OP_MS become app-global gc rows (workspace NULL, like
 *  stalls). Exported for tests; the observer callback delegates here. */
export function recordGcEntries(
  entries: ReadonlyArray<{ startTime: number; duration: number; detail?: unknown }>
): void {
  const r = rt;
  if (!r?.effective.recording) return;
  for (const e of entries) {
    if (e.duration < SLOW_OP_MS) continue;
    const detail = (e.detail ?? {}) as { kind?: number; flags?: number };
    const kindName = GC_KIND_NAMES[detail.kind ?? -1] ?? 'unknown';
    r.store.enqueue({
      ts: Math.round(performance.timeOrigin + e.startTime),
      kind: 'gc',
      name: `claude_fleet.gc.${kindName}`,
      durMs: e.duration,
      meta: { gcKind: kindName, flags: detail.flags ?? 0 }
    });
  }
}

/** PTY throughput instrumentation point (ipc.ts pty:attach data handler).
 *  No-op while recording is off. */
export function recordPtyChunk(workspaceId: string | null, sessionId: string, byteLength: number): void {
  const r = rt;
  if (!r?.effective.recording) return;
  const attrs = { workspace_id: workspaceId ?? '', session_id: sessionId };
  r.ptyBytes?.add(byteLength, attrs);
  r.ptyChunks?.add(1, attrs);
}

/** Terminal latency sample (perf telemetry Phase 2). Sources: main's
 *  pty:input receipt (input_hop) and the renderer's perf:samples batches
 *  (output_hop, echo_rtt). No-op while recording is off. */
export function recordLatencySample(
  kind: LatencyKind,
  workspaceId: string | null,
  sessionId: string | null,
  durMs: number
): void {
  const r = rt;
  if (!r?.effective.recording || !r.latencyHists) return;
  if (!Number.isFinite(durMs) || durMs < 0) return;
  r.latencyHists[kind].record(durMs, {
    workspace_id: workspaceId ?? '',
    session_id: sessionId ?? ''
  });
}
