import { describe, expect, it } from 'vitest';
import { resolvePerfConfig } from './perfConfig.js';

const stored = (perfTelemetry: boolean, enabled = false, endpoint = '') => ({
  perfTelemetry,
  perfOtlp: { enabled, endpoint }
});

describe('resolvePerfConfig', () => {
  it('defaults: recording on from settings, export off', () => {
    expect(resolvePerfConfig(stored(true), {})).toEqual({
      recording: true,
      recordingSource: 'settings',
      otlp: { enabled: false, endpoint: null, source: 'settings' }
    });
  });

  it('setting off turns recording off', () => {
    expect(resolvePerfConfig(stored(false), {}).recording).toBe(false);
  });

  it('CLAUDE_FLEET_PERF=0 forces recording off even when the setting is on', () => {
    const r = resolvePerfConfig(stored(true), { CLAUDE_FLEET_PERF: '0' });
    expect(r.recording).toBe(false);
    expect(r.recordingSource).toBe('env-override');
  });

  it('CLAUDE_FLEET_PERF=1 does NOT force recording on over an off setting', () => {
    expect(resolvePerfConfig(stored(false), { CLAUDE_FLEET_PERF: '1' }).recording).toBe(false);
  });

  it('settings-driven export requires enabled + endpoint + recording', () => {
    expect(resolvePerfConfig(stored(true, true, 'http://localhost:4318'), {}).otlp).toEqual({
      enabled: true, endpoint: 'http://localhost:4318', source: 'settings'
    });
    expect(resolvePerfConfig(stored(true, true, ''), {}).otlp.enabled).toBe(false);
    expect(resolvePerfConfig(stored(false, true, 'http://x:4318'), {}).otlp.enabled).toBe(false);
  });

  it('OTEL_EXPORTER_OTLP_ENDPOINT overrides the setting (source env)', () => {
    const r = resolvePerfConfig(stored(true, false, ''), { OTEL_EXPORTER_OTLP_ENDPOINT: ' http://collector:4318 ' });
    expect(r.otlp).toEqual({ enabled: true, endpoint: 'http://collector:4318', source: 'env' });
  });

  it('env endpoint does not export while recording is forced off', () => {
    const r = resolvePerfConfig(stored(true), {
      CLAUDE_FLEET_PERF: '0',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'
    });
    expect(r.otlp.enabled).toBe(false);
  });
});
