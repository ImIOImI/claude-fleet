// The single answer to "what version of claude-fleet is this?" — used by the
// Help menu and the get_config MCP tool (#219). Packaged builds report the
// package.json version verbatim. Dev builds append the git HEAD sha
// (`0.6.0-dev.abc1234`) because between releases package.json alone can't
// distinguish "release 0.6.0" from "main, N commits later".

import { app } from 'electron';
import { execFileSync } from 'node:child_process';

/** Pure formatter: plain version when packaged, `-dev.<sha>` suffix otherwise
 *  (no suffix when there's no sha — e.g. a dev run outside a git checkout). */
export function formatAppVersion(version: string, opts: { packaged: boolean; sha?: string }): string {
  return !opts.packaged && opts.sha ? `${version}-dev.${opts.sha}` : version;
}

let cached: string | null = null;

/** The decorated version of the live host process. The git lookup runs once
 *  (dev-only, cached): HEAD doesn't change under a running app in any way we
 *  need to track. */
export function appVersionString(): string {
  if (cached === null) {
    let sha: string | undefined;
    if (!app.isPackaged) {
      try {
        sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: app.getAppPath(),
          encoding: 'utf8'
        }).trim() || undefined;
      } catch {
        // Not a git checkout (or git missing) — plain version is fine.
      }
    }
    cached = formatAppVersion(app.getVersion(), { packaged: app.isPackaged, sha });
  }
  return cached;
}
