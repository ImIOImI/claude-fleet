// Unit tests for host `claude` resolution (#16). The bug this guards against:
// a GUI-launched Electron app (or a bare `sh -c`) inherits a minimal PATH that
// omits the user's shell-profile additions — so a native-installer claude under
// ~/.local/bin is invisible to `command -v claude`, even though it's installed.

import { describe, expect, it } from 'vitest';
import { resolveClaudeBin, type ResolveDeps } from './claudeResolve.js';

const HOME = '/home/troy';
const LOCAL_BIN = `${HOME}/.local/bin/claude`;

/** Build deps with sane no-op defaults; each test overrides what it exercises. */
function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    env: {},
    homedir: HOME,
    // Nothing on the inherited PATH, no shell, nothing on disk — the pessimistic
    // baseline. Tests opt into each source of truth.
    execFile: async () => {
      throw new Error('command not found');
    },
    isExecutableFile: async () => false,
    ...overrides
  };
}

describe('resolveClaudeBin', () => {
  it('honours the explicit CLAUDE_FLEET_LOCAL_CLAUDE_BIN override before anything else', async () => {
    const got = await resolveClaudeBin(
      deps({
        env: { CLAUDE_FLEET_LOCAL_CLAUDE_BIN: '/custom/claude' },
        // Override must win even if a PATH lookup would also succeed.
        execFile: async () => ({ stdout: '/usr/local/bin/claude\n' })
      })
    );
    expect(got).toBe('/custom/claude');
  });

  it('resolves via the inherited PATH when launched from a terminal', async () => {
    const got = await resolveClaudeBin(
      deps({ execFile: async () => ({ stdout: '/usr/local/bin/claude\n' }) })
    );
    expect(got).toBe('/usr/local/bin/claude');
  });

  // The regression: installed at ~/.local/bin, but the process PATH doesn't
  // include it (GUI launch / native installer). Old `command -v`-only logic
  // returned null here and attach threw "claude isn't installed".
  it('finds a native-installer claude under ~/.local/bin when it is off the inherited PATH', async () => {
    const got = await resolveClaudeBin(
      deps({
        // `command -v claude` on the inherited PATH finds nothing.
        execFile: async () => ({ stdout: '' }),
        isExecutableFile: async (p) => p === LOCAL_BIN
      })
    );
    expect(got).toBe(LOCAL_BIN);
  });

  it('falls back to the login shell for a custom install dir, tolerating banner noise', async () => {
    const got = await resolveClaudeBin(
      deps({
        env: { SHELL: '/bin/zsh' },
        // Inherited PATH: miss. Login shell: hit, but with rc-file chatter that
        // must be stripped down to the trailing absolute path.
        execFile: async (file, args) => {
          const cmd = args.join(' ');
          if (file === 'sh') return { stdout: '' };
          if (file === '/bin/zsh' && cmd.includes('-lic')) {
            return { stdout: 'nvm: loaded\n/opt/tools/bin/claude\n' };
          }
          throw new Error('unexpected exec');
        }
      })
    );
    expect(got).toBe('/opt/tools/bin/claude');
  });

  it('returns null only when claude is genuinely absent everywhere', async () => {
    expect(await resolveClaudeBin(deps())).toBeNull();
  });
});
