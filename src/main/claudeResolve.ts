// Host `claude` binary resolution for local (non-container) workspaces (#16).
//
// Kept as a pure, electron-free module (like localSessions.ts) so it's
// unit-testable without the Electron ABI: all IO is injected via ResolveDeps.
//
// The subtlety: a *local* workspace runs the user's host claude, but the
// Electron main process only sees the PATH it was launched with. A GUI launch
// (desktop icon, WSLg) — and even a bare `sh -c` — gets a minimal PATH that
// omits the user's shell-profile additions. The native Claude Code installer
// puts the binary at `~/.local/bin/claude`, which is added to PATH by the
// user's `~/.profile`/`~/.zshrc`, *not* by a non-login shell. So `command -v
// claude` alone reports "not installed" for a claude that's plainly there.
// We therefore try, in order: inherited PATH → well-known install dirs →
// the user's login shell (which sources their profile).
//
// On Windows there are no POSIX shells to consult: the PATH lookup is
// `where.exe claude` (preferring a directly spawnable `.exe` over an
// extension-less shim), the well-known candidate is the native installer's
// `%USERPROFILE%\.local\bin\claude.exe`, and the login-shell step is skipped
// (GUI processes get the registry-backed user PATH anyway).

import { access, constants as fsConstants } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** process.platform — 'win32' switches to where.exe + .exe candidates. */
  platform: NodeJS.Platform;
  /** Run a command and capture stdout; rejects on non-zero exit. */
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>;
  /** True if `path` exists and is executable. */
  isExecutableFile: (path: string) => Promise<boolean>;
}

const isPosixPath = (line: string): boolean => line.startsWith('/');
const isWindowsPath = (line: string): boolean => /^[A-Za-z]:[\\/]/.test(line);

/** Run a lookup command and return its stdout as trimmed, non-empty lines
 *  (tolerates CRLF and banner/rc chatter); [] on any failure. */
async function lookupLines(
  execFile: ResolveDeps['execFile'],
  file: string,
  args: string[]
): Promise<string[]> {
  try {
    const { stdout } = await execFile(file, args);
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Extract the resolved binary path from a `command -v` invocation, tolerating
 *  banner/rc chatter a login+interactive shell may print before the answer. */
async function commandV(
  execFile: ResolveDeps['execFile'],
  file: string,
  args: string[]
): Promise<string | null> {
  const lines = await lookupLines(execFile, file, args);
  // `command -v` prints the absolute path last; a login shell may prepend
  // noise, so take the final line that looks like an absolute path.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPosixPath(lines[i])) return lines[i];
  }
  return null;
}

/** `where.exe claude` — every PATH match, one per line, PATH order first. */
async function whereClaude(execFile: ResolveDeps['execFile']): Promise<string | null> {
  const lines = (await lookupLines(execFile, 'where.exe', ['claude'])).filter(isWindowsPath);
  // Prefer a directly spawnable .exe: `where` may list an extension-less
  // shell shim (for Git Bash) ahead of the real claude.exe.
  return lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0] ?? null;
}

/** Well-known absolute locations a host claude may live at, in priority order. */
function wellKnownCandidates(homedir: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    // Native installer default. npm-global shims live on the registry-backed
    // user PATH, which where.exe already covers.
    return homedir ? [join(homedir, '.local', 'bin', 'claude.exe')] : [];
  }
  const candidates: string[] = [];
  if (homedir) candidates.push(join(homedir, '.local/bin/claude')); // native installer (default)
  candidates.push('/usr/local/bin/claude'); // npm global on many setups
  candidates.push('/opt/homebrew/bin/claude'); // macOS Homebrew (Apple Silicon)
  candidates.push('/usr/bin/claude');
  return candidates;
}

/**
 * Resolve the `claude` binary, or null if it can't be found. Order:
 *   1. `CLAUDE_FLEET_LOCAL_CLAUDE_BIN` override (non-PATH install / test stand-in).
 *   2. The PATH we inherited (fast; correct when launched from a terminal).
 *      POSIX: `sh -c 'command -v claude'`; Windows: `where.exe claude`.
 *   3. Well-known install dirs (fast fs probe; catches ~/.local/bin GUI launches).
 *   4. POSIX only: the user's login shell (slow; last resort for exotic custom PATHs).
 */
export async function resolveClaudeBin(deps: ResolveDeps): Promise<string | null> {
  const override = deps.env.CLAUDE_FLEET_LOCAL_CLAUDE_BIN?.trim();
  if (override) return override;

  if (deps.platform === 'win32') {
    const onPath = await whereClaude(deps.execFile);
    if (onPath) return onPath;
    for (const candidate of wellKnownCandidates(deps.homedir, deps.platform)) {
      if (await deps.isExecutableFile(candidate)) return candidate;
    }
    return null; // no POSIX shells to consult on Windows
  }

  const onPath = await commandV(deps.execFile, 'sh', ['-c', 'command -v claude']);
  if (onPath) return onPath;

  for (const candidate of wellKnownCandidates(deps.homedir, deps.platform)) {
    if (await deps.isExecutableFile(candidate)) return candidate;
  }

  const shell = deps.env.SHELL?.trim() || '/bin/bash';
  const viaLoginShell = await commandV(deps.execFile, shell, ['-lic', 'command -v claude']);
  if (viaLoginShell) return viaLoginShell;

  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Production resolver bound to the real host environment. */
export async function findClaude(
  execFile: ResolveDeps['execFile'],
  homedir: string
): Promise<string | null> {
  return resolveClaudeBin({
    env: process.env,
    homedir,
    platform: process.platform,
    execFile,
    isExecutableFile
  });
}

/** User-facing message when no claude can be found on the host. */
export const CLAUDE_NOT_FOUND_MESSAGE =
  "`claude` isn't installed on this host — it wasn't found on PATH, in ~/.local/bin, " +
  'or via your login shell. Install Claude Code (see claude.com/product/claude-code), ' +
  'set CLAUDE_FLEET_LOCAL_CLAUDE_BIN to its path, or use a Container workspace.';

/** Memoize a nullable async resolution (perf stall fix F1, spec
 *  2026-08-11-perf-stall-fixes-design.md). The lookup behind findClaude
 *  spawns where.exe/login-shell probes, so callers should not re-run it
 *  per invocation. Policy: a non-null result is cached until invalidate();
 *  null (claude not found) is cached for nullTtlMs so a later install is
 *  picked up; concurrent gets share one in-flight probe; a rejected probe
 *  is not cached. */
export function cachedNullableResolver<T>(
  resolve: () => Promise<T | null>,
  opts: { nullTtlMs: number; now?: () => number }
): { get(): Promise<T | null>; invalidate(): void } {
  const now = opts.now ?? Date.now;
  let cached: { value: T | null; at: number } | null = null;
  let inFlight: Promise<T | null> | null = null;
  let generation = 0; // bumped by invalidate(); probes from older generations must not write back
  return {
    get(): Promise<T | null> {
      if (cached && (cached.value !== null || now() - cached.at < opts.nullTtlMs)) {
        return Promise.resolve(cached.value);
      }
      if (!inFlight) {
        const gen = generation;
        inFlight = resolve().then(
          (value) => {
            if (gen === generation) {
              cached = { value, at: now() };
              inFlight = null;
            }
            return value;
          },
          (err) => {
            if (gen === generation) inFlight = null;
            throw err;
          }
        );
      }
      return inFlight;
    },
    invalidate(): void {
      cached = null;
      inFlight = null;
      generation += 1;
    }
  };
}
