//
// WSL discovery for the local-workspace launcher (#253): enumerate installed
// distros and probe one for its login shell, $HOME, /etc/shells, Windows
// interop, and an in-distro claude install.
//
// Two exec flavors are injected: `execBuf` for wsl.exe's OWN output
// (`--list --verbose`), which is UTF-16LE, and `exec` (utf8) for commands run
// INSIDE a distro (`wsl.exe -d <d> -- sh -c …`), whose output comes from the
// Linux side and is plain UTF-8. Pure module — vitest-loadable.

import { resolveClaudeBin } from './claudeResolve.js';
import { posixQuote } from './localLauncher.js';

export interface ProbeDeps {
  /** execFile with { encoding: 'buffer' } — for wsl.exe's UTF-16 output. */
  execBuf(file: string, args: string[]): Promise<{ stdout: Buffer }>;
  /** execFile utf8 — for in-distro commands. */
  exec(file: string, args: string[]): Promise<{ stdout: string }>;
}

export interface WslDistroList {
  distros: string[];
  defaultDistro: string | null;
}

export interface WslDistroProbe {
  shells: string[];
  loginShell: string;
  home: string;
  claudePath: string | null;
  interopEnabled: boolean;
}

/** Distros that exist to serve other products, not to host a dev shell. */
const UTILITY_DISTROS = /^(docker-desktop|rancher-desktop|podman-machine)/i;

export function decodeWsl(buf: Buffer): string {
  return buf.toString('utf16le').replace(/\r/g, '').replace(/\0/g, '');
}

/** Parse `wsl.exe --list --verbose`: header row, then `[*] NAME STATE VERSION`. */
export function parseDistroList(verboseOut: string): WslDistroList {
  const distros: string[] = [];
  let defaultDistro: string | null = null;
  for (const line of verboseOut.split('\n')) {
    const m = /^(\*?)\s*(\S+)\s+(Running|Stopped|Installing)\s+\d+\s*$/.exec(line.trim());
    if (!m) continue;
    const name = m[2];
    if (UTILITY_DISTROS.test(name)) continue;
    distros.push(name);
    if (m[1] === '*') defaultDistro = name;
  }
  return { distros, defaultDistro };
}

export async function listWslDistros(deps: ProbeDeps): Promise<WslDistroList> {
  try {
    const { stdout } = await deps.execBuf('wsl.exe', ['--list', '--verbose']);
    return parseDistroList(decodeWsl(stdout));
  } catch {
    return { distros: [], defaultDistro: null }; // WSL absent ⇒ feature hidden
  }
}

/** Run a POSIX one-liner inside the distro; '' on any failure. */
async function inDistro(deps: ProbeDeps, distro: string, script: string): Promise<string> {
  try {
    const { stdout } = await deps.exec('wsl.exe', ['-d', distro, '--', 'sh', '-c', script]);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function probeWslDistro(distro: string, deps: ProbeDeps): Promise<WslDistroProbe> {
  const [loginShellRaw, home, shellsRaw, interopRaw] = await Promise.all([
    inDistro(deps, distro, 'getent passwd "$(id -un)" | cut -d: -f7'),
    inDistro(deps, distro, 'echo "$HOME"'),
    inDistro(deps, distro, 'while read -r s; do [ -x "$s" ] && echo "$s"; done < /etc/shells'),
    // Canonical interop check: the binfmt registration only exists when
    // wsl.conf [interop] is enabled. Prints 'yes' iff present.
    inDistro(deps, distro, 'test -f /proc/sys/fs/binfmt_misc/WSLInterop && echo yes')
  ]);

  if (!home) {
    throw new Error(`could not determine $HOME in ${distro} — is the distro runnable?`);
  }

  const loginShell = loginShellRaw || '/bin/bash';
  const shells = shellsRaw.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('/'));

  // Reuse the exact host resolution chain, but with every probe routed
  // through `wsl.exe -d <distro> --`. No env override — CLAUDE_FLEET_LOCAL_CLAUDE_BIN
  // means the HOST binary and must not leak in here.
  const claudePath = await resolveClaudeBin({
    env: { SHELL: loginShell },
    homedir: home,
    platform: 'linux',
    execFile: (file, args) =>
      deps.exec('wsl.exe', ['-d', distro, '--', file, ...args]),
    isExecutableFile: async (p) =>
      (await inDistro(deps, distro, `test -x ${posixQuote(p)} && echo yes`)) === 'yes'
  });

  return { shells, loginShell, home, claudePath, interopEnabled: interopRaw === 'yes' };
}
