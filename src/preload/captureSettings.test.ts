import { describe, expect, it } from 'vitest';
import {
  captureSettingsEqual, clampDailyCap, classifyCostIncrease, defaultCaptureSettings, describeCaptureChange,
  diffCaptureSettings, effectiveCaptureSettings, isDefaultCaptureSettings, normalizeCaptureSettings,
  parseCaptureSettingsPatch
} from './captureSettings.js';

const D = defaultCaptureSettings();

describe('normalizeCaptureSettings (#483 §5a)', () => {
  it('fills defaults for absent, true, and garbage values', () => {
    expect(D).toEqual({
      enabled: true, onSearchHit: true, searchTopSessions: 3, recaptureAfterTurns: 30, contextBands: [0.85],
      turnsEvery: 0, model: 'session', transcriptRetentionDays: 365, captureVisibility: 'fleet'
    });
    for (const v of [undefined, null, true, 'x', 42, []]) expect(normalizeCaptureSettings(v)).toEqual(D);
  });
  it('reads the task-10 boolean false as { enabled: false }', () => {
    expect(normalizeCaptureSettings(false)).toEqual({ ...D, enabled: false });
  });
  it('clamps every numeric field and drops unknown fields', () => {
    const n = normalizeCaptureSettings({
      searchTopSessions: 9, recaptureAfterTurns: 2, turnsEvery: 5, transcriptRetentionDays: 1, evil: true
    });
    expect(n).toEqual({ ...D, searchTopSessions: 5, recaptureAfterTurns: 10, turnsEvery: 10, transcriptRetentionDays: 30 });
    expect(normalizeCaptureSettings({ searchTopSessions: 0, turnsEvery: 900, transcriptRetentionDays: 99999 }))
      .toMatchObject({ searchTopSessions: 1, turnsEvery: 500, transcriptRetentionDays: 3650 });
    expect(normalizeCaptureSettings({ turnsEvery: 0 }).turnsEvery).toBe(0);
    expect(normalizeCaptureSettings({ turnsEvery: -3 }).turnsEvery).toBe(0);
  });
  it('clamps, dedupes, sorts and caps context bands; an empty list is allowed', () => {
    expect(normalizeCaptureSettings({ contextBands: [0.3, 0.99, 0.85, 0.85, 0.7, 0.6, 0.55] }).contextBands).toEqual([0.5, 0.55, 0.6, 0.7]);
    expect(normalizeCaptureSettings({ contextBands: [] }).contextBands).toEqual([]);
    expect(normalizeCaptureSettings({ contextBands: 'x' }).contextBands).toEqual([0.85]);
  });
  it('accepts "session" or a claude model id, and fleet|private visibility', () => {
    expect(normalizeCaptureSettings({ model: 'claude-opus-5-5[1m]' }).model).toBe('claude-opus-5-5[1m]');
    expect(normalizeCaptureSettings({ model: 'gpt-4' }).model).toBe('session');
    expect(normalizeCaptureSettings({ captureVisibility: 'private' }).captureVisibility).toBe('private');
    expect(normalizeCaptureSettings({ captureVisibility: 'public' }).captureVisibility).toBe('fleet');
  });
  it('effectiveCaptureSettings reads a manifest-shaped object', () => {
    expect(effectiveCaptureSettings(null)).toEqual(D);
    expect(effectiveCaptureSettings({ knowledgeCapture: { searchTopSessions: 2 } }).searchTopSessions).toBe(2);
  });
  it('clampDailyCap defaults to 40 and clamps to 0-500', () => {
    expect(clampDailyCap(undefined)).toBe(40);
    expect(clampDailyCap(Number.NaN)).toBe(40);
    expect(clampDailyCap(0)).toBe(0);
    expect(clampDailyCap(9999)).toBe(500);
  });
});

describe('comparison and description', () => {
  it('equality, defaults, diff and readable change lines', () => {
    const after = { ...D, contextBands: [0.6, 0.85], turnsEvery: 40 };
    expect(captureSettingsEqual(D, defaultCaptureSettings())).toBe(true);
    expect(isDefaultCaptureSettings(after)).toBe(false);
    expect(diffCaptureSettings(D, after)).toEqual({ contextBands: [0.6, 0.85], turnsEvery: 40 });
    expect(describeCaptureChange(D, after)).toEqual(['contextBands: 85% → 60%, 85%', 'turnsEvery: off → 40']);
  });
});

describe('classifyCostIncrease', () => {
  const inc = (after: Partial<typeof D>, before: Partial<typeof D> = {}) =>
    classifyCostIncrease({ ...D, ...before }, { ...D, ...before, ...after }).increases;
  it('flags every cost-raising change from the spec', () => {
    expect(inc({ enabled: true }, { enabled: false })).toBe(true);
    expect(inc({ onSearchHit: true }, { onSearchHit: false })).toBe(true);
    expect(inc({ searchTopSessions: 4 })).toBe(true);
    expect(inc({ recaptureAfterTurns: 20 })).toBe(true);
    expect(inc({ contextBands: [0.6, 0.85] })).toBe(true);
    expect(inc({ contextBands: [0.7] })).toBe(true);
    expect(inc({ turnsEvery: 30 })).toBe(true);
    expect(inc({ turnsEvery: 20 }, { turnsEvery: 40 })).toBe(true);
    expect(inc({ model: 'claude-haiku-5' })).toBe(true);
  });
  it('treats reductions and neutral fields as not increasing cost', () => {
    expect(inc({ enabled: false })).toBe(false);
    expect(inc({ onSearchHit: false })).toBe(false);
    expect(inc({ searchTopSessions: 1 })).toBe(false);
    expect(inc({ recaptureAfterTurns: 100 })).toBe(false);
    expect(inc({ contextBands: [] })).toBe(false);
    expect(inc({ contextBands: [0.9] })).toBe(false);
    expect(inc({ turnsEvery: 0 }, { turnsEvery: 40 })).toBe(false);
    expect(inc({ model: 'session' }, { model: 'claude-haiku-5' })).toBe(false);
    expect(inc({ transcriptRetentionDays: 3650, captureVisibility: 'private' })).toBe(false);
  });
  it('explains why', () => {
    expect(classifyCostIncrease(D, { ...D, turnsEvery: 30 }).reasons).toEqual(['turns periodic capture on (every 30 turns)']);
  });
});

describe('parseCaptureSettingsPatch', () => {
  it('returns the typed patch and trimmed reason', () => {
    expect(parseCaptureSettingsPatch({ searchTopSessions: 2, contextBands: [0.7], reason: '  cheaper  ' }))
      .toEqual({ patch: { searchTopSessions: 2, contextBands: [0.7] }, reason: 'cheaper' });
  });
  it('rejects unknown fields, a missing reason, wrong types, bad models and empty patches', () => {
    expect(() => parseCaptureSettingsPatch({ foo: 1, reason: 'r' })).toThrow(/unknown capture setting\(s\): foo/);
    expect(() => parseCaptureSettingsPatch({ enabled: false })).toThrow(/reason is required/);
    expect(() => parseCaptureSettingsPatch({ enabled: 'no', reason: 'r' })).toThrow(/enabled must be true or false/);
    expect(() => parseCaptureSettingsPatch({ turnsEvery: '30', reason: 'r' })).toThrow(/turnsEvery must be a number/);
    expect(() => parseCaptureSettingsPatch({ contextBands: [0.8, 'x'], reason: 'r' })).toThrow(/contextBands must be/);
    expect(() => parseCaptureSettingsPatch({ model: 'gpt-4', reason: 'r' })).toThrow(/model must be/);
    expect(() => parseCaptureSettingsPatch({ captureVisibility: 'public', reason: 'r' })).toThrow(/captureVisibility must be/);
    expect(() => parseCaptureSettingsPatch({ reason: 'r' })).toThrow(/no settings to change/);
  });
});
