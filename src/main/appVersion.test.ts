import { describe, expect, it, vi } from 'vitest';

// appVersion.ts imports electron for the impure getter; the pure formatter
// under test never touches it.
vi.mock('electron', () => ({ app: {} }));

const { formatAppVersion } = await import('./appVersion.js');

describe('formatAppVersion (#219)', () => {
  it('returns the plain version for packaged builds', () => {
    expect(formatAppVersion('0.6.0', { packaged: true, sha: 'abc1234' })).toBe('0.6.0');
  });

  it('appends -dev.<sha> for dev builds so the version distinguishes commits between releases', () => {
    expect(formatAppVersion('0.6.0', { packaged: false, sha: 'abc1234' })).toBe('0.6.0-dev.abc1234');
  });

  it('falls back to the plain version for a dev build outside a git checkout', () => {
    expect(formatAppVersion('0.6.0', { packaged: false })).toBe('0.6.0');
  });
});
