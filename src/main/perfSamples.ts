// Validation for renderer-originated perf:samples batches (perf telemetry
// Phase 2). The renderer is untrusted input to main: unknown shapes are
// rejected, invalid entries dropped, batches capped. input_hop is absent by
// design — main measures it itself at pty:input receipt; a renderer must not
// be able to fabricate main-side measurements.

const RENDERER_KINDS = ['output_hop', 'echo_rtt'] as const;
export type RendererSampleKind = (typeof RENDERER_KINDS)[number];
const MAX_BATCH = 1000;
const MAX_DUR_MS = 60_000;

export interface PerfSampleBatch {
  sessionId: string;
  samples: Array<{ kind: RendererSampleKind; durMs: number }>;
}

export function sanitizePerfSamples(payload: unknown): PerfSampleBatch | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { sessionId?: unknown; samples?: unknown };
  if (typeof p.sessionId !== 'string' || !Array.isArray(p.samples)) return null;
  const samples: PerfSampleBatch['samples'] = [];
  for (const s of p.samples.slice(0, MAX_BATCH * 2)) {
    if (samples.length >= MAX_BATCH) break;
    if (typeof s !== 'object' || s === null) continue;
    const { kind, durMs } = s as { kind?: unknown; durMs?: unknown };
    if (!RENDERER_KINDS.includes(kind as RendererSampleKind)) continue;
    if (typeof durMs !== 'number' || !Number.isFinite(durMs) || durMs < 0 || durMs > MAX_DUR_MS) continue;
    samples.push({ kind: kind as RendererSampleKind, durMs });
  }
  return { sessionId: p.sessionId, samples };
}
