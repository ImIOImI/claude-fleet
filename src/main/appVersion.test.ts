import { describe, expect, it, vi } from 'vitest';

// appVersion.ts imports electron for the impure getter; the pure formatter
// under test never touches it.
vi.mock('electron', () => ({ app: {} }));

const { formatAppVersion, pickBuildSha } = await import('./appVersion.js');

describe('formatAppVersion (#219, #298)', () => {
  it('appends +<sha> for packaged builds so two builds of the same semver are distinguishable', () => {
    expect(formatAppVersion('0.11.0', { packaged: true, sha: 'abc1234' })).toBe('0.11.0+abc1234');
  });

  it('returns the plain version for a packaged build with no baked sha', () => {
    expect(formatAppVersion('0.6.0', { packaged: true })).toBe('0.6.0');
  });

  it('appends -dev.<sha> for dev builds so the version distinguishes commits between releases', () => {
    expect(formatAppVersion('0.6.0', { packaged: false, sha: 'abc1234' })).toBe('0.6.0-dev.abc1234');
  });

  it('falls back to the plain version for a dev build outside a git checkout', () => {
    expect(formatAppVersion('0.6.0', { packaged: false })).toBe('0.6.0');
  });
});

describe('pickBuildSha (#298)', () => {
  it('packaged builds use only the build-time baked sha (runtime git is meaningless there)', () => {
    expect(pickBuildSha({ packaged: true, baked: 'bake111', gitSha: 'git2222' })).toBe('bake111');
    expect(pickBuildSha({ packaged: true, gitSha: 'git2222' })).toBeUndefined();
  });

  it('dev builds prefer live git HEAD over a possibly stale baked sha, falling back to baked', () => {
    expect(pickBuildSha({ packaged: false, baked: 'bake111', gitSha: 'git2222' })).toBe('git2222');
    expect(pickBuildSha({ packaged: false, baked: 'bake111' })).toBe('bake111');
    expect(pickBuildSha({ packaged: false })).toBeUndefined();
  });
});
