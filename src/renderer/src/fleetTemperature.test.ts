import { describe, expect, it } from 'vitest';
import { isWarm, isCold } from './fleetTemperature';

const w = (state: string, lastKnownState?: string) =>
  ({ state, lastKnownState }) as Parameters<typeof isWarm>[0];

describe('fleet temperature', () => {
  it('warm: running, paused, unreachable-was-warm', () => {
    expect(isWarm(w('running'))).toBe(true);
    expect(isWarm(w('paused'))).toBe(true);
    expect(isWarm(w('unreachable', 'running'))).toBe(true);
    expect(isWarm(w('unreachable', 'paused'))).toBe(true);
  });
  it('cold: stopped, deleted, unreachable-cold/unknown', () => {
    expect(isWarm(w('stopped'))).toBe(false);
    expect(isWarm(w('unreachable', 'stopped'))).toBe(false);
    expect(isWarm(w('unreachable'))).toBe(false);
    expect(isWarm(undefined)).toBe(false);
    expect(isCold(w('stopped'))).toBe(true);
    expect(isCold(w('deleted'))).toBe(true);
    expect(isCold(w('unreachable'))).toBe(true);
    expect(isCold(w('unreachable', 'running'))).toBe(false); // in the strip, not Saved
    expect(isCold(w('running'))).toBe(false);
  });
});
