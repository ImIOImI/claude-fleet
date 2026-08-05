import { describe, it, expect } from 'vitest';
import { sanitizeLauncher } from './workspaces.js';

describe('sanitizeLauncher', () => {
  it('passes a well-formed wsl launcher on win32', () => {
    const l = { mode: 'wsl', distro: 'Ubuntu', shell: '/usr/bin/zsh', home: '/home/t', claudePath: '/home/t/.local/bin/claude' };
    expect(sanitizeLauncher(l, 'win32')).toEqual(l);
  });
  it('rejects wsl off win32', () => {
    const l = { mode: 'wsl', distro: 'U', shell: '/bin/sh', home: '/h', claudePath: '/c' };
    expect(sanitizeLauncher(l, 'linux')).toBeUndefined();
  });
  it('rejects wsl with missing fields', () => {
    expect(sanitizeLauncher({ mode: 'wsl', distro: 'U' }, 'win32')).toBeUndefined();
  });
  it('passes custom on any platform', () => {
    expect(sanitizeLauncher({ mode: 'custom', command: 'x {args}' }, 'linux'))
      .toEqual({ mode: 'custom', command: 'x {args}' });
  });
  it('rejects custom with empty command', () => {
    expect(sanitizeLauncher({ mode: 'custom', command: '  ' }, 'linux')).toBeUndefined();
  });
  it('normalizes native / drops junk', () => {
    expect(sanitizeLauncher({ mode: 'native' }, 'linux')).toEqual({ mode: 'native' });
    expect(sanitizeLauncher('zsh', 'linux')).toBeUndefined();
    expect(sanitizeLauncher(undefined, 'linux')).toBeUndefined();
  });
});
