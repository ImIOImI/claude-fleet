import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isWslEnvironment } from './wsl.js';

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

/** Reveal a host path in the OS file manager (WSL-aware). Never rejects. */
export function openHostPath(path: string): Promise<string> {
  return RUNNING_IN_WSL ? openPathViaExplorer(path) : Promise.resolve(shell.openPath(path));
}
