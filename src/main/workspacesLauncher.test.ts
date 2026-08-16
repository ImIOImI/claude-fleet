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
  // #259: the probed interop flag has to survive a manifest round-trip for
  // attach to act on it, and "absent" must stay distinguishable from "false" —
  // every manifest written before this field existed has no value, and those
  // workspaces must keep getting MCP wired.
  describe('wsl interopEnabled round-trip (#259)', () => {
    const base = {
      mode: 'wsl',
      distro: 'Ubuntu',
      shell: '/usr/bin/zsh',
      home: '/home/t',
      claudePath: '/home/t/.local/bin/claude'
    };
    it('round-trips true', () => {
      expect(sanitizeLauncher({ ...base, interopEnabled: true }, 'win32')).toEqual({
        ...base,
        interopEnabled: true
      });
    });
    it('round-trips false — the value the MCP skip keys on', () => {
      expect(sanitizeLauncher({ ...base, interopEnabled: false }, 'win32')).toEqual({
        ...base,
        interopEnabled: false
      });
    });
    it('leaves it absent (not false) for a pre-#259 manifest', () => {
      const out = sanitizeLauncher(base, 'win32') as Record<string, unknown>;
      expect('interopEnabled' in out).toBe(false);
      expect(out.interopEnabled).toBeUndefined();
    });
    it('drops a non-boolean rather than coercing it', () => {
      for (const junk of ['false', 0, null, {}]) {
        const out = sanitizeLauncher({ ...base, interopEnabled: junk }, 'win32') as Record<
          string,
          unknown
        >;
        expect('interopEnabled' in out).toBe(false);
      }
    });
  });

  it('normalizes native / drops junk', () => {
    expect(sanitizeLauncher({ mode: 'native' }, 'linux')).toEqual({ mode: 'native' });
    expect(sanitizeLauncher('zsh', 'linux')).toBeUndefined();
    expect(sanitizeLauncher(undefined, 'linux')).toBeUndefined();
  });
});
