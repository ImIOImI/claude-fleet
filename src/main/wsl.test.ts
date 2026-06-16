import { describe, it, expect } from 'vitest';
import { isWslEnvironment } from './wsl';

describe('isWslEnvironment', () => {
  it('is false on non-linux platforms', () => {
    expect(isWslEnvironment({ platform: 'darwin', wslDistroName: 'Ubuntu' })).toBe(false);
    expect(isWslEnvironment({ platform: 'win32' })).toBe(false);
  });

  it('is true on linux when WSL_DISTRO_NAME is set', () => {
    expect(isWslEnvironment({ platform: 'linux', wslDistroName: 'Ubuntu-24.04' })).toBe(true);
  });

  it('is true on linux when /proc/version names microsoft', () => {
    expect(
      isWslEnvironment({
        platform: 'linux',
        procVersion: 'Linux version 6.6.114.1-microsoft-standard-WSL2'
      })
    ).toBe(true);
  });

  it('is false on plain linux (no WSL markers)', () => {
    expect(
      isWslEnvironment({ platform: 'linux', procVersion: 'Linux version 6.8.0-generic' })
    ).toBe(false);
    expect(isWslEnvironment({ platform: 'linux' })).toBe(false);
  });
});
