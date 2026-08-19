import { describe, expect, it } from 'vitest';
import { buildWslLauncherPayload } from './wslLauncherPayload.js';

const INITIAL = {
  mode: 'wsl' as const,
  distro: 'Ubuntu',
  shell: '/usr/bin/zsh',
  home: '/home/troy',
  claudePath: '/home/troy/.nvm/versions/node/v22/bin/claude',
  interopEnabled: true,
  ignoreClaudeVersion: '2.1.235'
};

const PROBE = {
  home: '/home/troy',
  claudePath: '/home/troy/.local/bin/claude', // the stale re-find (#336)
  interopEnabled: true
};

describe('buildWslLauncherPayload', () => {
  it('same distro: manifest is source of truth for claudePath + ignoreClaudeVersion (#339)', () => {
    const out = buildWslLauncherPayload(INITIAL, 'Ubuntu', '/usr/bin/zsh', PROBE);
    expect(out).toEqual({
      mode: 'wsl',
      distro: 'Ubuntu',
      shell: '/usr/bin/zsh',
      home: '/home/troy',
      claudePath: '/home/troy/.nvm/versions/node/v22/bin/claude',
      interopEnabled: true,
      ignoreClaudeVersion: '2.1.235'
    });
  });

  it('distro changed: full probe values, ignoreClaudeVersion dropped', () => {
    const out = buildWslLauncherPayload(INITIAL, 'Debian', '/bin/bash', PROBE);
    expect(out).toEqual({
      mode: 'wsl',
      distro: 'Debian',
      shell: '/bin/bash',
      home: '/home/troy',
      claudePath: '/home/troy/.local/bin/claude',
      interopEnabled: true
    });
    expect(out).not.toHaveProperty('ignoreClaudeVersion');
  });

  it('no initial wsl launcher (create / was native): probe values', () => {
    const out = buildWslLauncherPayload({ mode: 'native' }, 'Ubuntu', '/bin/bash', PROBE);
    expect(out.claudePath).toBe('/home/troy/.local/bin/claude');
    expect(out).not.toHaveProperty('ignoreClaudeVersion');
    expect(buildWslLauncherPayload(undefined, 'Ubuntu', '/bin/bash', PROBE).claudePath).toBe(
      '/home/troy/.local/bin/claude'
    );
  });

  it('probe not finished + same distro: keeps every manifest field (no blank-out)', () => {
    const out = buildWslLauncherPayload(INITIAL, 'Ubuntu', '/usr/bin/zsh', null);
    expect(out).toEqual(INITIAL);
  });

  it('probe not finished + distro changed: empty probe-owned fields, interop omitted ("not probed")', () => {
    const out = buildWslLauncherPayload(INITIAL, 'Debian', '/bin/bash', null);
    expect(out).toEqual({ mode: 'wsl', distro: 'Debian', shell: '/bin/bash', home: '', claudePath: '' });
    expect(out).not.toHaveProperty('interopEnabled');
  });

  it('same distro with an empty manifest claudePath falls back to the probe', () => {
    const out = buildWslLauncherPayload({ ...INITIAL, claudePath: '' }, 'Ubuntu', '/usr/bin/zsh', PROBE);
    expect(out.claudePath).toBe('/home/troy/.local/bin/claude');
  });
});
