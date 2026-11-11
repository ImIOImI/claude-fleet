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
import { context, createContextKey, metrics, trace, type Attributes, type Context, type Span } from '@opentelemetry/api';
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
import type { BootProfileResult } from './bootProfile.js';
import { RETENTION_MS } from './perfStore.js';

export const SLOW_OP_MS = 25;
/** Higher slow_op floors for spans that run near SLOW_OP_MS by design. */
export const SLOW_OP_MS_BY_NAME: Readonly<Record<string, number>> = {
  // Retention slices aim for ~35 ms; only overshoots are worth a row.
  'claude_fleet.retention.slice': 50,
  // One row per launch each, whatever the duration: they carry the WAL state.
  'claude_fleet.db.open': 0,
  'claude_fleet.db.wal_drain': 0,
  // Every directory listing (rare: watch start, overflow, unresolvable path, new dir).
  'claude_fleet.watcher.scan': 0,
};
export const FLUSH_INTERVAL_MS = 5000;
export const STALL_THRESHOLD_MS = 50;
export const SAMPLE_INTERVAL_MS = 5000;
export const MEM_SAMPLE_INTERVAL_MS = 60_000;
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
      if (durMs < (SLOW_OP_MS_BY_NAME[s.name] ?? SLOW_OP_MS)) continue;
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
  memSampleIntervalMs?: number;
}

interface Runtime {
  store: PerfStore;
  effective: EffectivePerfConfig;
  tracerProvider: BasicTracerProvider | null;
  flushTimer: NodeJS.Timeout | null;
  meterProvider: MeterProvider | null;
  sampleTimer: NodeJS.Timeout | null;
  memTimer: NodeJS.Timeout | null;
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
export async function getPerfStatus(): Promise<PerfStatus> {
  const r = rt; // captured: a shutdown during the awaits must not swap it under us
  if (!r) throw new Error('perf not initialized');
  await r.store.flush(); // counts include anything still buffered
  const eventCounts = await r.store.counts24h();
  return {
    enabled: r.effective.recording,
    source: r.effective.recordingSource,
    otlp: r.effective.otlp,
    eventCounts,
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
    memTimer: null,
    loopHistogram: null,
    ptyBytes: null,
    ptyChunks: null,
    latencyHists: null,
    sampleIntervalMs: hooks?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS,
    gcObserver: null
  };
  void store.prune(RETENTION_MS).catch((err: unknown) => console.warn('[perf] prune failed:', err));
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
    const r = rt;
    if (!r) return;
    // A failed flush keeps its rows buffered (PerfStore) for the next tick.
    void perfSpanAsync('claude_fleet.perf.flush', () => r.store.flush()).catch((err: unknown) =>
      console.warn('[perf] flush failed:', err)
    );
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

  rt.memTimer = setInterval(sampleMemory, hooks?.memSampleIntervalMs ?? MEM_SAMPLE_INTERVAL_MS);
  rt.memTimer.unref();

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
  if (r.memTimer) clearInterval(r.memTimer);
  r.loopHistogram?.disable();
  r.gcObserver?.disconnect();
  await r.meterProvider?.shutdown().catch(() => undefined); // final metric collection → exporter
  await r.tracerProvider?.shutdown().catch(() => undefined); // flushes batch processors
  trace.disable();
  metrics.disable();
  // context.disable() resets the global manager, so a later initPerf can re-register one.
  context.disable();
  // A rejection here must not propagate: callers chain closeDb() right after
  // shutdownPerf() on the before-quit path, and a thrown flush would skip it.
  await r.store.flush().catch((err: unknown) => console.warn('[perf] shutdown flush failed:', err));
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

/** The perfSpan* spans enclosing the active context, innermost last: SQLite time rolls up to all of them. */
const SPAN_CHAIN = createContextKey('claude_fleet.span_chain');

interface ChainEntry { span: Span; sqlMs: number; sqlN: number }

function startChained(name: string, attrs?: Attributes): { entry: ChainEntry; ctx: Context } {
  const active = context.active();
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs }, active);
  const entry: ChainEntry = { span, sqlMs: 0, sqlN: 0 };
  if (!span.isRecording()) return { entry, ctx: trace.setSpan(active, span) };
  const chain = [...((active.getValue(SPAN_CHAIN) as ChainEntry[] | undefined) ?? []), entry];
  return { entry, ctx: trace.setSpan(active, span).setValue(SPAN_CHAIN, chain) };
}

function endChained(entry: ChainEntry): void {
  if (entry.sqlN > 0) {
    entry.span.setAttribute('sql_sync_ms', Math.round(entry.sqlMs * 10) / 10);
    entry.span.setAttribute('sql_queries', entry.sqlN);
  }
  entry.span.end();
}

export function perfSpan<T>(name: string, fn: () => T, attrs?: Attributes): T {
  const { entry, ctx } = startChained(name, attrs);
  try {
    return context.with(ctx, fn);
  } catch (err) {
    if (err instanceof Error) entry.span.recordException(err);
    throw err;
  } finally {
    endChained(entry);
  }
}

export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T> | T,
  attrs?: Attributes
): Promise<T> {
  const { entry, ctx } = startChained(name, attrs);
  try {
    return await context.with(ctx, fn);
  } catch (err) {
    if (err instanceof Error) entry.span.recordException(err);
    throw err;
  } finally {
    endChained(entry);
  }
}

/** A span with explicit epoch-ms bounds, for work timed before perf was initialized. */
export function perfRecordSpan(name: string, startMs: number, endMs: number, attrs?: Attributes): void {
  trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs, startTime: startMs }).end(endMs);
}

/** Add one statement's synchronous SQLite time to every enclosing perfSpan*
 *  span; each reports `sql_sync_ms` / `sql_queries` when it ends, so its own
 *  DB cost (its children's included) is separable from mutex queueing. */
export function perfNoteSqlSync(ms: number): void {
  const chain = context.active().getValue(SPAN_CHAIN) as ChainEntry[] | undefined;
  if (!chain) return;
  for (const e of chain) {
    e.sqlMs += ms;
    e.sqlN++;
  }
}

/** perfSpanAsync that hands `fn` a setter for the span's attributes (they land in its slow_op row's meta). */
export async function perfSpanAsyncAttrs<T>(
  name: string,
  fn: (set: (attrs: Attributes) => void) => Promise<T> | T,
  attrs?: Attributes
): Promise<T> {
  const { entry, ctx } = startChained(name, attrs);
  try {
    return await context.with(ctx, () => fn((a) => entry.span.setAttributes(a)));
  } catch (err) {
    if (err instanceof Error) entry.span.recordException(err);
    throw err;
  } finally {
    endChained(entry);
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

/** One app-global `boot_profile` row per launch (#464): ts = profile start,
 *  dur_ms = profiled window, meta = the analyzeProfile summary + file path. */
export function recordBootProfile(r: BootProfileResult): void {
  const run = rt;
  if (!run?.effective.recording) return;
  const { startedAt, windowMs, ...meta } = r;
  run.store.enqueue({ ts: startedAt, kind: 'boot_profile', name: 'claude_fleet.boot.cpu_profile', durMs: windowMs, meta });
}

/** One Electron process in a memory sample (app.getAppMetrics, MB). */
export interface MemProcSample {
  pid: number;
  /** Electron process type: Browser (main) | Tab (renderer) | GPU | Utility | … */
  type: string;
  name?: string;
  workingSetMb: number;
  /** Windows-only in Electron; absent elsewhere. */
  privateMb?: number;
}
export interface MemSource {
  procs: MemProcSample[];
  /** Load context so memory can be normalized (e.g. MB per live PTY). */
  context?: Record<string, number>;
}

/** Injected per-process memory source (ipc.ts wires app.getAppMetrics —
 *  perf.ts stays Electron-free). Without one, mem rows still carry the main
 *  process's V8 heap from process.memoryUsage(). */
let memSource: (() => MemSource) | null = null;
export function setPerfMemorySource(cb: (() => MemSource) | null): void {
  memSource = cb;
}

const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Writes one app-global `mem` row: main V8 heap + per-process working sets.
 *  dur_ms holds the summed working set (MB) so trends chart without
 *  json_extract. Runs every MEM_SAMPLE_INTERVAL_MS while recording; exported
 *  for tests. A failing source degrades to heap-only, never throws. */
export function sampleMemory(): void {
  const r = rt;
  if (!r?.effective.recording) return;
  const m = process.memoryUsage();
  let src: MemSource = { procs: [] };
  try {
    if (memSource) src = memSource();
  } catch {
    src = { procs: [] };
  }
  const byType: Record<string, number> = {};
  let total = 0;
  for (const p of src.procs) {
    byType[p.type] = Math.round(((byType[p.type] ?? 0) + p.workingSetMb) * 10) / 10;
    total += p.workingSetMb;
  }
  total = Math.round(total * 10) / 10;
  r.store.enqueue({
    ts: Date.now(),
    kind: 'mem',
    name: 'claude_fleet.mem',
    durMs: total,
    meta: {
      main: {
        rssMb: toMb(m.rss),
        heapUsedMb: toMb(m.heapUsed),
        heapTotalMb: toMb(m.heapTotal),
        externalMb: toMb(m.external),
        arrayBuffersMb: toMb(m.arrayBuffers)
      },
      byType,
      totalWorkingSetMb: total,
      procs: src.procs,
      ...(src.context ? { context: src.context } : {})
    }
  });
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
