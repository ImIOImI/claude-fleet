import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isWslEnvironment } from './wsl.js';
import { linuxPathToUnc } from './localLauncher.js';

/** Detected once at load: are we running under WSL? */
export const RUNNING_IN_WSL = ((): boolean => {
  let procVersion = '';
  try {
    procVersion = readFileSync('/proc/version', 'utf8');
  } catch {
    /* not linux / no procfs */
  }
  return isWslEnvironment({
    platform: process.platform,
    wslDistroName: process.env.WSL_DISTRO_NAME,
    procVersion
  });
})();

function openPathViaExplorer(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('wslpath', ['-w', path], (err, stdout) => {
      if (err) { resolve(`wslpath failed: ${err.message}`); return; }
      const winPath = stdout.trim();
      if (!winPath) { resolve('wslpath returned an empty path'); return; }
      execFile('explorer.exe', [winPath], () => { /* exits 1 even on success — ignore */ });
      resolve('');
    });
  });
}

/**
 * Host-openable form of a path (pure — exported for tests).
 *
 * The Windows app can hold paths that live *inside* a distro: a wsl-launcher
 * workspace's `workspaceRoot` is a Linux absolute path (`/home/troy/…`), which
 * `shell.openPath` cannot resolve — it fails with "Failed to open path" (#387).
 * Explorer reaches those through the `\\wsl.localhost\<distro>\…` share, so
 * translate when we know which distro the path belongs to.
 *
 * Only rewrites a POSIX-absolute path: host paths (`C:\…`, and every path when
 * the app itself runs on Linux/macOS) pass through untouched, so the shared
 * folder — a real host path — is never mangled.
 */
export function hostOpenablePath(
  path: string,
  opts: { platform: NodeJS.Platform; distro?: string }
): string {
  if (opts.platform !== 'win32') return path;
  if (!opts.distro || !path.startsWith('/')) return path;
  return linuxPathToUnc(opts.distro, path);
}

/**
 * Reveal a host path in the OS file manager (WSL-aware). Never rejects.
 *
 * `distro` names the WSL distro a Linux path belongs to (wsl-launcher
 * workspaces); omit it for ordinary host paths.
 */
export function openHostPath(path: string, distro?: string): Promise<string> {
  if (RUNNING_IN_WSL) return openPathViaExplorer(path);
  const target = hostOpenablePath(path, { platform: process.platform, distro });
  return Promise.resolve(shell.openPath(target));
}
