// Start-time staleness check for wsl-launcher workspaces (#336). The manifest
// pins `launcher.claudePath` at save time and wrapSpawnForLauncher execs it
// unconditionally, so a distro that later gains a newer claude at a different
// path strands the workspace on the old binary invisibly. This module answers
// "did the distro grow a newer claude since?" by version-comparing the pinned
// path against the login shell's `command -v claude` (what the user's own
// terminal runs — the save-time probe never consults it when a well-known dir
// hits) and the well-known install dirs.
//
// Pure module: exec is injected (wsl.exe in production, fakes in vitest).
// Same discipline as wslProbe.ts / claudeResolve.ts.

import { wellKnownCandidates } from './claudeResolve.js';
import { posixQuote } from './localLauncher.js';

export interface FreshnessDeps {
  /** execFile utf8 — in-distro commands via wsl.exe; rejects on non-zero. */
  exec(file: string, args: string[]): Promise<{ stdout: string }>;
}

export interface ClaudeUpdate {
  /** version null ⇒ the pinned binary no longer runs (or prints no version). */
  pinned: { path: string; version: string | null };
  best: { path: string; version: string };
}

/** `claude --version` prints e.g. "2.1.235 (Claude Code)" — take the triple. */
export function parseClaudeVersion(out: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric x.y.z comparison: <0, 0, >0 (lexical order lies past single digits). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** One `sh -c` line per path: `<path>\t<first --version line, empty if broken>`.
 *  A single wsl.exe round-trip versions every candidate. */
export function versionBatchScript(paths: string[]): string {
  return paths
    .map(
      (p) =>
        `v=$(${posixQuote(p)} --version 2>/dev/null | head -n1); ` +
        `printf '%s\\t%s\\n' ${posixQuote(p)} "$v"`
    )
    .join('; ');
}

export function parseVersionBatch(stdout: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(0, tab);
    if (!path.startsWith('/')) continue; // shell/motd chatter guard
    out.set(path, parseClaudeVersion(line.slice(tab + 1)));
  }
  return out;
}

/**
 * Report a strictly-newer in-distro claude than the pinned one, or null.
 * - Candidates: pinned path + login-shell `command -v claude` + well-known dirs.
 * - A pinned binary that no longer runs makes ANY working candidate an offer
 *   (today that workspace fails to spawn with no explanation).
 * - `ignoreClaudeVersion` ("Keep" from a previous toast) suppresses offers at
 *   or below that version.
 * Never throws — probe failures degrade to null (no toast).
 */
export async function checkWslClaudeFreshness(
  l: {
    distro: string;
    shell: string;
    home: string;
    claudePath: string;
    ignoreClaudeVersion?: string;
  },
  deps: FreshnessDeps
): Promise<ClaudeUpdate | null> {
  // What the user's own terminal calls `claude`: login+interactive shell,
  // last absolute-path line wins (rc files may print banners first —
  // same tolerance as claudeResolve.ts's commandV).
  const login = await deps
    .exec('wsl.exe', ['-d', l.distro, '--exec', l.shell, '-lic', 'command -v claude'])
    .catch(() => ({ stdout: '' }));
  let loginPath: string | null = null;
  const loginLines = login.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = loginLines.length - 1; i >= 0; i--) {
    if (loginLines[i].startsWith('/')) {
      loginPath = loginLines[i];
      break;
    }
  }

  const candidates = [
    ...new Set([
      l.claudePath,
      ...(loginPath ? [loginPath] : []),
      ...wellKnownCandidates(l.home, 'linux')
    ])
  ];
  const batch = await deps
    .exec('wsl.exe', ['-d', l.distro, '--exec', 'sh', '-c', versionBatchScript(candidates)])
    .catch(() => ({ stdout: '' }));
  const versions = parseVersionBatch(batch.stdout);

  const pinnedVersion = versions.get(l.claudePath) ?? null;
  let best: { path: string; version: string } | null = null;
  for (const [path, version] of versions) {
    if (path === l.claudePath || version === null) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { path, version };
  }
  if (!best) return null;
  if (pinnedVersion !== null && compareVersions(best.version, pinnedVersion) <= 0) return null;
  if (l.ignoreClaudeVersion && compareVersions(best.version, l.ignoreClaudeVersion) <= 0) {
    return null;
  }
  return { pinned: { path: l.claudePath, version: pinnedVersion }, best };
}
