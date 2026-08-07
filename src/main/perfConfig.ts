// Pure resolution of the *effective* perf-telemetry state from the persisted
// settings + env overrides. Kept Electron-free so it unit-tests directly.
// Precedence (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md §4):
//   recording: CLAUDE_FLEET_PERF=0 forces off → else the perfTelemetry setting.
//   export:    OTEL_EXPORTER_OTLP_ENDPOINT forces on (source 'env') → else the
//              perfOtlp setting. Export never runs while recording is off.

export interface EffectivePerfConfig {
  recording: boolean;
  recordingSource: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
}

export function resolvePerfConfig(
  stored: { perfTelemetry: boolean; perfOtlp: { enabled: boolean; endpoint: string } },
  env: Record<string, string | undefined>
): EffectivePerfConfig {
  const envOff = env.CLAUDE_FLEET_PERF === '0';
  const recording = envOff ? false : stored.perfTelemetry;
  const envEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const otlp = envEndpoint
    ? { enabled: recording, endpoint: envEndpoint, source: 'env' as const }
    : {
        enabled: recording && stored.perfOtlp.enabled && stored.perfOtlp.endpoint !== '',
        endpoint: stored.perfOtlp.endpoint || null,
        source: 'settings' as const
      };
  return { recording, recordingSource: envOff ? 'env-override' : 'settings', otlp };
}
