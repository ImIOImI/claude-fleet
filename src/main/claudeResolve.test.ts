// Unit tests for host `claude` resolution (#16). The bug this guards against:
// a GUI-launched Electron app (or a bare `sh -c`) inherits a minimal PATH that
// omits the user's shell-profile additions — so a native-installer claude under
// ~/.local/bin is invisible to `command -v claude`, even though it's installed.
//
// The win32 suite guards the sibling bug: the original resolver was POSIX-only
// (`sh`, `/bin/bash -lic`, no `.exe` suffix), so on Windows every step failed
// even with claude.exe installed and on PATH.

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveClaudeBin, cachedNullableResolver, type ResolveDeps } from './claudeResolve.js';

const HOME = '/home/troy';
const LOCAL_BIN = `${HOME}/.local/bin/claude`;
const WIN_HOME = 'C:\\Users\\troy';
const WIN_EXE = 'C:\\Users\\troy\\.local\\bin\\claude.exe';

/** Build deps with sane no-op defaults; each test overrides what it exercises. */
function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    env: {},
    homedir: HOME,
    platform: 'linux',
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

describe('resolveClaudeBin on win32', () => {
  /** Windows baseline: no sh, no SHELL, native-installer claude.exe on disk. */
  function winDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
    return deps({ homedir: WIN_HOME, platform: 'win32', ...overrides });
  }

  it('resolves claude.exe via where.exe on the inherited PATH (CRLF output)', async () => {
    const got = await resolveClaudeBin(
      winDeps({
        execFile: async (file, args) => {
          expect(file).toBe('where.exe');
          expect(args).toEqual(['claude']);
          return { stdout: `${WIN_EXE}\r\n` };
        }
      })
    );
    expect(got).toBe(WIN_EXE);
  });

  it('prefers a spawnable .exe when where.exe also lists an extension-less shim', async () => {
    const got = await resolveClaudeBin(
      winDeps({
        // Git Bash shim first in PATH order; the real .exe second.
        execFile: async () => ({
          stdout: 'C:\\Users\\troy\\.local\\bin\\claude\r\n' + `${WIN_EXE}\r\n`
        })
      })
    );
    expect(got).toBe(WIN_EXE);
  });

  // The regression this suite exists for: claude.exe installed at
  // %USERPROFILE%\.local\bin but where.exe misses it (not on the app's PATH).
  // The POSIX-only resolver probed `...\.local\bin\claude` — no .exe — and
  // attach threw "claude isn't installed" at a user with claude on their PATH.
  it('probes %USERPROFILE%\\.local\\bin\\claude.exe when where.exe finds nothing', async () => {
    const expected = join(WIN_HOME, '.local', 'bin', 'claude.exe');
    const got = await resolveClaudeBin(
      winDeps({
        execFile: async () => {
          throw new Error('INFO: Could not find files for the given pattern(s).');
        },
        isExecutableFile: async (p) => p === expected
      })
    );
    expect(got).toBe(expected);
  });

  it('never consults a POSIX shell on win32', async () => {
    const execs: string[] = [];
    const got = await resolveClaudeBin(
      winDeps({
        env: { SHELL: '/bin/zsh' }, // even if some stray SHELL is set
        execFile: async (file) => {
          execs.push(file);
          throw new Error('not found');
        }
      })
    );
    expect(got).toBeNull();
    expect(execs).toEqual(['where.exe']); // no sh, no login shell
  });
});

describe('cachedNullableResolver', () => {
  it('caches a non-null resolution indefinitely', async () => {
    let calls = 0;
    const r = cachedNullableResolver(async () => { calls += 1; return '/bin/claude'; }, { nullTtlMs: 1000 });
    expect(await r.get()).toBe('/bin/claude');
    expect(await r.get()).toBe('/bin/claude');
    expect(calls).toBe(1);
  });

  it('caches null only for nullTtlMs, then re-probes', async () => {
    let calls = 0;
    let clock = 0;
    const r = cachedNullableResolver(async () => { calls += 1; return null; }, { nullTtlMs: 1000, now: () => clock });
    expect(await r.get()).toBeNull();
    clock = 999;
    expect(await r.get()).toBeNull();
    expect(calls).toBe(1);
    clock = 1001;
    expect(await r.get()).toBeNull();
    expect(calls).toBe(2);
  });

  it('shares one in-flight probe between concurrent gets', async () => {
    let calls = 0;
    let release: (v: string | null) => void = () => {};
    const r = cachedNullableResolver(
      () => { calls += 1; return new Promise<string | null>((res) => { release = res; }); },
      { nullTtlMs: 1000 }
    );
    const a = r.get();
    const b = r.get();
    release('/bin/claude');
    expect(await a).toBe('/bin/claude');
    expect(await b).toBe('/bin/claude');
    expect(calls).toBe(1);
  });

  it('does not cache a rejected probe', async () => {
    let calls = 0;
    const r = cachedNullableResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return '/bin/claude';
    }, { nullTtlMs: 1000 });
    await expect(r.get()).rejects.toThrow('flaky');
    expect(await r.get()).toBe('/bin/claude');
    expect(calls).toBe(2);
  });

  it('invalidate() forces a re-probe even after a non-null hit', async () => {
    let calls = 0;
    const r = cachedNullableResolver(async () => { calls += 1; return `/bin/claude${calls}`; }, { nullTtlMs: 1000 });
    expect(await r.get()).toBe('/bin/claude1');
    r.invalidate();
    expect(await r.get()).toBe('/bin/claude2');
  });
});
