import { describe, expect, it, vi } from 'vitest';

// openHostPath.ts imports electron for shell.openPath; the pure path
// translation under test never touches it.
vi.mock('electron', () => ({ shell: {} }));

const { hostOpenablePath } = await import('./openHostPath.js');

describe('hostOpenablePath (#387)', () => {
  it('rewrites a wsl workspace root to the UNC share Explorer can resolve', () => {
    expect(
      hostOpenablePath('/home/troy/fleet/local-wsl', {
        platform: 'win32',
        distro: 'Ubuntu-24.04'
      })
    ).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\troy\\fleet\\local-wsl');
  });

  it('leaves a Windows host path alone even when a distro is named', () => {
    expect(
      hostOpenablePath('C:\\Users\\troy\\claude-shared', {
        platform: 'win32',
        distro: 'Ubuntu-24.04'
      })
    ).toBe('C:\\Users\\troy\\claude-shared');
  });

  it('leaves a path alone with no distro — the shared folder is a real host path', () => {
    expect(hostOpenablePath('/home/troy/fleet', { platform: 'win32' })).toBe('/home/troy/fleet');
  });

  it('never rewrites off Windows — a Linux/macOS app opens its own paths directly', () => {
    expect(
      hostOpenablePath('/home/troy/fleet', { platform: 'linux', distro: 'Ubuntu-24.04' })
    ).toBe('/home/troy/fleet');
    expect(
      hostOpenablePath('/Users/troy/fleet', { platform: 'darwin', distro: 'Ubuntu-24.04' })
    ).toBe('/Users/troy/fleet');
  });
});
