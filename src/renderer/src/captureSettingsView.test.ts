import { describe, expect, it } from 'vitest';
import { defaultCaptureSettings } from '../../preload/captureSettings';
import { captureSubmitValue, captureSummary, formatBands, fromCaptureForm, parseBands, toCaptureForm } from './captureSettingsView';

describe('capture settings form mapping (#483 §5a)', () => {
  it('round-trips the defaults and submits them as absent', () => {
    const f = toCaptureForm(undefined);
    expect(f).toEqual({
      enabled: true, onSearchHit: true, searchTopSessions: '3', recaptureAfterTurns: '30', contextBands: '85',
      turnsEvery: '0', model: 'session', transcriptRetentionDays: '365', captureVisibility: 'fleet'
    });
    const r = fromCaptureForm(f);
    expect(r.error).toBeNull();
    expect(r.settings).toEqual(defaultCaptureSettings());
    expect(captureSubmitValue(r.settings)).toBeUndefined();
    expect(captureSubmitValue({ ...r.settings, enabled: false })).toEqual({ ...defaultCaptureSettings(), enabled: false });
  });
  it('parses bands as percents or fractions; blank = none; garbage = null', () => {
    expect(parseBands('60, 85')).toEqual([0.6, 0.85]);
    expect(parseBands('70%')).toEqual([0.7]);
    expect(parseBands('0.75')).toEqual([0.75]);
    expect(parseBands('  ')).toEqual([]);
    expect(parseBands('sixty')).toBeNull();
    expect(formatBands([0.6, 0.85])).toBe('60, 85');
  });
  it('clamps numbers and reports bad bands or model ids', () => {
    const f = { ...toCaptureForm(undefined), searchTopSessions: '9', recaptureAfterTurns: '2', turnsEvery: '5', transcriptRetentionDays: '9999' };
    expect(fromCaptureForm(f).settings).toMatchObject({ searchTopSessions: 5, recaptureAfterTurns: 10, turnsEvery: 10, transcriptRetentionDays: 3650 });
    expect(fromCaptureForm({ ...f, contextBands: 'x' }).error).toMatch(/Context bands/);
    expect(fromCaptureForm({ ...f, model: 'gpt-4' }).error).toMatch(/Model/);
    expect(fromCaptureForm({ ...f, model: '  ' }).settings.model).toBe('session');
  });
  it('summarizes for the disclosure header', () => {
    expect(captureSummary({ ...defaultCaptureSettings(), enabled: false })).toBe('off');
    expect(captureSummary(defaultCaptureSettings())).toBe('search top 3 · at 85% context · keep 365 d');
    expect(captureSummary({
      ...defaultCaptureSettings(), onSearchHit: false, contextBands: [], turnsEvery: 40, model: 'claude-haiku-5', captureVisibility: 'private'
    })).toBe('no search capture · no context bands · every 40 turns · claude-haiku-5 · keep 365 d · private');
  });
});
