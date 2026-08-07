// Perf telemetry runtime (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md).
// Owns the OTel SDK lifecycle in main. All instrumentation goes through the
// @opentelemetry/api globals, so when no provider is registered (recording
// off) every perfSpan/metric call is a no-op — instrumentation sites cost
// ~nothing while disabled. Two export paths per signal: the SQLite exporters
// (always on while recording) feed the local perf_events table; OTLP HTTP
// exporters are added only when effective.otlp.enabled.

import { hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { metrics, trace, type Attributes } from '@opentelemetry/api';
import {
  BasicTracerProvider, BatchSpanProcessor,
  type ReadableSpan, type SpanExporter
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { EffectivePerfConfig } from './perfConfig.js';
import type { PerfStore } from './perfStore.js';
import { RETENTION_MS } from './perfStore.js';

export const SLOW_OP_MS = 25;
export const FLUSH_INTERVAL_MS = 5000;
const TRACER_NAME = 'claude-fleet';

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

interface Runtime {
  store: PerfStore;
  effective: EffectivePerfConfig;
  tracerProvider: BasicTracerProvider | null;
  flushTimer: NodeJS.Timeout | null;
}
let rt: Runtime | null = null;

export function getEffectivePerf(): EffectivePerfConfig | null {
  return rt?.effective ?? null;
}

export function initPerf(store: PerfStore, effective: EffectivePerfConfig): void {
  if (rt) throw new Error('initPerf called twice — use reconfigurePerf');
  rt = { store, effective, tracerProvider: null, flushTimer: null };
  store.prune(RETENTION_MS);
  if (!effective.recording) return; // globals stay no-op

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
}

export async function shutdownPerf(): Promise<void> {
  if (!rt) return;
  const r = rt;
  rt = null;
  if (r.flushTimer) clearInterval(r.flushTimer);
  await r.tracerProvider?.shutdown().catch(() => undefined); // flushes batch processors
  trace.disable();
  metrics.disable();
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
    return fn();
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
    return await fn();
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}
