// The single answer to "what version of claude-fleet is this?" — used by the
// Help menu, the app-start error-log line, and the get_config MCP tool
// (#219, #298). The semver alone can't identify a build (two builds of the
// same 0.11.0 are indistinguishable), so every surface carries the git short
// sha too: packaged builds report `0.11.0+abc1234` (sha baked at build time —
// git isn't available/meaningful at runtime in a packaged app), dev builds
// report `0.11.0-dev.abc1234` from a live `git rev-parse` because between
// releases the bundle's baked sha may be stale.

import { app } from 'electron';
import { execFileSync } from 'node:child_process';

// Injected by electron-vite `define` at build time (electron.vite.config.ts):
// the short sha of HEAD when building inside a git checkout, else the CI
// GITHUB_SHA, else undefined. Undeclared under vitest — every read must stay
// behind `typeof`.
declare const __BUILD_SHA__: string | undefined;

/** Pure formatter: `<version>+<sha>` when packaged (semver build metadata),
 *  `<version>-dev.<sha>` otherwise; plain version when there's no sha. */
export function formatAppVersion(version: string, opts: { packaged: boolean; sha?: string }): string {
  if (!opts.sha) return version;
  return opts.packaged ? `${version}+${opts.sha}` : `${version}-dev.${opts.sha}`;
}

/** Pure pick of which sha identifies this build: packaged builds trust only
 *  the baked-at-build-time sha; dev builds prefer live git HEAD (the bundle's
 *  baked sha goes stale as commits land) and fall back to baked. */
export function pickBuildSha(opts: { packaged: boolean; baked?: string; gitSha?: string }): string | undefined {
  return opts.packaged ? opts.baked : opts.gitSha ?? opts.baked;
}

let cachedSha: string | undefined;
let shaComputed = false;

/** The git short sha identifying the running build, or undefined when unknown
 *  (dev outside a git checkout with no baked sha). Computed once and cached:
 *  neither the bundle nor HEAD changes under a running app in any way we
 *  need to track. */
export function appBuildSha(): string | undefined {
  if (!shaComputed) {
    const baked = typeof __BUILD_SHA__ === 'string' && __BUILD_SHA__ ? __BUILD_SHA__ : undefined;
    let gitSha: string | undefined;
    if (!app.isPackaged) {
      try {
        gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: app.getAppPath(),
          encoding: 'utf8'
        }).trim() || undefined;
      } catch {
        // Not a git checkout (or git missing) — baked/plain is fine.
      }
    }
    cachedSha = pickBuildSha({ packaged: app.isPackaged, baked, gitSha });
    shaComputed = true;
  }
  return cachedSha;
}

let cached: string | null = null;

/** The decorated version of the live host process. */
export function appVersionString(): string {
  if (cached === null) {
    cached = formatAppVersion(app.getVersion(), { packaged: app.isPackaged, sha: appBuildSha() });
  }
  return cached;
}
