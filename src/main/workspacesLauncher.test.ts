import { describe, it, expect } from 'vitest';
import { sanitizeLauncher, manifestInvariant } from './workspaces.js';

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

  describe('wsl ignoreClaudeVersion round-trip (#336)', () => {
    it('round-trips ignoreClaudeVersion on a wsl launcher', () => {
      const l = sanitizeLauncher(
        {
          mode: 'wsl',
          distro: 'Ubuntu',
          shell: '/bin/bash',
          home: '/home/u',
          claudePath: '/home/u/.local/bin/claude',
          ignoreClaudeVersion: '2.1.235'
        },
        'win32'
      );
      expect(l).toMatchObject({ mode: 'wsl', ignoreClaudeVersion: '2.1.235' });
    });

    it('drops a non-string/empty ignoreClaudeVersion', () => {
      const base = {
        mode: 'wsl',
        distro: 'Ubuntu',
        shell: '/bin/bash',
        home: '/home/u',
        claudePath: '/home/u/.local/bin/claude'
      };
      expect(sanitizeLauncher({ ...base, ignoreClaudeVersion: 7 }, 'win32')).not.toHaveProperty(
        'ignoreClaudeVersion'
      );
      expect(sanitizeLauncher({ ...base, ignoreClaudeVersion: '' }, 'win32')).not.toHaveProperty(
        'ignoreClaudeVersion'
      );
    });
  });

  it('normalizes native / drops junk', () => {
    expect(sanitizeLauncher({ mode: 'native' }, 'linux')).toEqual({ mode: 'native' });
    expect(sanitizeLauncher('zsh', 'linux')).toBeUndefined();
    expect(sanitizeLauncher(undefined, 'linux')).toBeUndefined();
  });
});

// #323: a wsl launcher with a Windows workspaceRoot is a state both manifest
// writers claim to reject — and a live install had one anyway, costing ~6 days
// of silent, total observability loss (#313) with nothing logged. Until the
// writer hole is found, this is the detector that makes it loud.
describe('manifestInvariant — #323', () => {
  const base = {
    id: '01TEST000000000000000000WS',
    name: 'ws',
    labels: [],
    workspaceSubdir: '',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'preserve' },
    createdAt: 0,
    lastUsedAt: 0
  } as unknown as Parameters<typeof manifestInvariant>[0];

  const wsl = {
    mode: 'wsl' as const,
    distro: 'Ubuntu-24.04',
    shell: '/bin/zsh',
    home: '/home/troy',
    claudePath: '/home/troy/.local/bin/claude'
  };

  it('flags the exact live case that produced #313', () => {
    const v = manifestInvariant({
      ...base,
      kind: 'local',
      launcher: wsl,
      workspaceRoot: 'C:\\Users\\troyk\\fleet\\01KZKC42R3NZ00F8DRFYZV3XPP'
    });
    expect(v).toContain('non-Linux workspaceRoot');
    expect(v).toContain('C:\\Users\\troyk\\fleet');
  });

  it('accepts a wsl workspace with a Linux root (the correct shape)', () => {
    expect(
      manifestInvariant({ ...base, kind: 'local', launcher: wsl, workspaceRoot: '/home/troy/proj' })
    ).toBeNull();
  });

  // A Windows root is normal and correct for these — the invariant is
  // specifically about wsl, where wsl.exe rewrites the cwd underneath us.
  it('does not flag a native local workspace with a Windows root', () => {
    expect(
      manifestInvariant({
        ...base,
        kind: 'local',
        launcher: { mode: 'native' },
        workspaceRoot: 'C:\\Users\\troyk\\fleet\\ws'
      })
    ).toBeNull();
  });

  it('does not flag a local workspace with no launcher at all', () => {
    expect(
      manifestInvariant({ ...base, kind: 'local', workspaceRoot: 'C:\\Users\\troyk\\fleet\\ws' })
    ).toBeNull();
  });

  it('does not flag a container workspace (its root is always derived)', () => {
    expect(
      manifestInvariant({
        ...base,
        kind: 'container',
        workspaceRoot: 'C:\\Users\\troyk\\fleet\\ws'
      })
    ).toBeNull();
  });
});
