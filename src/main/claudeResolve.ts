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

import { access, constants as fsConstants } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** Run a command and capture stdout; rejects on non-zero exit. */
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>;
  /** True if `path` exists and is executable. */
  isExecutableFile: (path: string) => Promise<boolean>;
}

/** Extract the resolved binary path from a `command -v` invocation, tolerating
 *  banner/rc chatter a login+interactive shell may print before the answer. */
async function commandV(
  execFile: ResolveDeps['execFile'],
  file: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stdout } = await execFile(file, args);
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // `command -v` prints the absolute path last; a login shell may prepend
    // noise, so take the final line that looks like an absolute path.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('/')) return lines[i];
    }
    return null;
  } catch {
    return null;
  }
}

/** Well-known absolute locations a host claude may live at, in priority order. */
function wellKnownCandidates(homedir: string): string[] {
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
 *   3. Well-known install dirs (fast fs probe; catches ~/.local/bin GUI launches).
 *   4. The user's login shell (slow; last resort for exotic custom PATHs).
 */
export async function resolveClaudeBin(deps: ResolveDeps): Promise<string | null> {
  const override = deps.env.CLAUDE_FLEET_LOCAL_CLAUDE_BIN?.trim();
  if (override) return override;

  const onPath = await commandV(deps.execFile, 'sh', ['-c', 'command -v claude']);
  if (onPath) return onPath;

  for (const candidate of wellKnownCandidates(deps.homedir)) {
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
  return resolveClaudeBin({ env: process.env, homedir, execFile, isExecutableFile });
}

/** User-facing message when no claude can be found on the host. */
export const CLAUDE_NOT_FOUND_MESSAGE =
  "`claude` isn't installed on this host — it wasn't found on PATH, in ~/.local/bin, " +
  'or via your login shell. Install Claude Code (see claude.com/product/claude-code), ' +
  'set CLAUDE_FLEET_LOCAL_CLAUDE_BIN to its path, or use a Container workspace.';
