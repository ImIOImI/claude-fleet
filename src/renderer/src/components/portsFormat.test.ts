import { describe, it, expect } from 'vitest';
import { formatUptime } from './portsFormat';

describe('formatUptime', () => {
  const t0 = 1_000_000;
  it('seconds under a minute', () => {
    expect(formatUptime(t0, t0 + 42_000)).toBe('up 42s');
  });
  it('minutes under an hour', () => {
    expect(formatUptime(t0, t0 + 12 * 60_000)).toBe('up 12m');
  });
  it('hours under a day', () => {
    expect(formatUptime(t0, t0 + 2 * 3_600_000)).toBe('up 2h');
  });
  it('days beyond', () => {
    expect(formatUptime(t0, t0 + 3 * 86_400_000)).toBe('up 3d');
  });
  it('clock skew clamps to zero', () => {
    expect(formatUptime(t0, t0 - 5_000)).toBe('up 0s');
  });
});
