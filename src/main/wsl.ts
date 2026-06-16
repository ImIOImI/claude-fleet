// WSL detection for host-path opening. Under WSL2 there is typically no Linux
// file manager and no `xdg-open`, so Electron's `shell.openPath` fails
// silently. We instead translate the path with `wslpath -w` and hand it to
// `explorer.exe`. This module isolates the (pure) detection so it can be unit
// tested without spawning anything.

/**
 * True when the process is running inside WSL — `shell.openPath` won't reach a
 * GUI file manager and the explorer.exe bridge should be used instead.
 *
 * Detection order: only Linux can be WSL; `WSL_DISTRO_NAME` is set in every
 * WSL shell; otherwise `/proc/version` contains "microsoft" under WSL kernels.
 */
export function isWslEnvironment(opts: {
  platform: NodeJS.Platform;
  wslDistroName?: string;
  procVersion?: string;
}): boolean {
  if (opts.platform !== 'linux') return false;
  if (opts.wslDistroName && opts.wslDistroName.length > 0) return true;
  return (opts.procVersion ?? '').toLowerCase().includes('microsoft');
}
