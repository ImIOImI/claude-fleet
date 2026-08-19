//
// Launcher translation for local (non-container) workspaces (#253): turns the
// per-workspace `launcher` manifest choice into the actual node-pty spawn.
// Implemented as a SpawnPty *wrapper* so localSessions.ts (which composes
// claude's own args and owns the ring buffer) stays byte-identical: the
// session manager thinks it's spawning `claude file+args`; this module
// rewrites that into `wsl.exe -d <distro> -- <shell> -lic '…'` (wsl mode) or
// a platform-shell template invocation (custom mode).
//
// Pure module: no electron / node-pty imports (types from localSessions are
// type-only), so it loads under vitest. Same discipline as claudeResolve.ts.

import type { SpawnPty } from './localSessions.js';

/** Per-workspace launch strategy (manifest `launcher`; absent ⇒ native). */
export type WorkspaceLauncher =
  | { mode: 'native' }
  | {
      mode: 'wsl';
      /** wsl.exe distro name, e.g. 'Ubuntu'. */
      distro: string;
      /** Absolute shell path inside the distro, e.g. '/usr/bin/zsh'. */
      shell: string;
      /** $HOME inside the distro — probed at save time; the transcript
       *  watcher derives the \\wsl.localhost root from it. */
      home: string;
      /** claude path inside the distro — probed at save time. */
      claudePath: string;
      /** Whether Windows interop is usable in this distro — probed at save
       *  time (#259). Interop is how the fleet-state MCP bridge crosses the
       *  boundary (it execs the app's own .exe from inside the distro), so
       *  `false` means MCP wiring is skipped for this workspace rather than
       *  wired up to fail inside claude.
       *
       *  `undefined` means "not probed" — every manifest written before this
       *  field existed — and is treated as "wire it", preserving the previous
       *  behaviour for those workspaces. Only an explicit `false` skips. */
      interopEnabled?: boolean;
      /** "Keep" from the newer-claude toast (#336): suppress update offers at
       *  or below this version. Cleared when the user adopts a new path. */
      ignoreClaudeVersion?: string;
    }
  | {
      mode: 'custom';
      /** Command template; `{claude}` → resolved host binary, `{args}` →
       *  fleet's pre-quoted flags (appended if the placeholder is absent). */
      command: string;
    };

/** POSIX single-quote: safe against every metacharacter except NUL. */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Windows double-quote: encloses the value in double quotes and escapes
 *  any embedded double quotes by doubling them (cmd.exe convention). */
export function win32Quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** \\wsl.localhost\<distro>\a\b (or legacy \\wsl$\…) → { distro, '/a/b' }. */
export function uncToLinuxPath(p: string): { distro: string; path: string } | null {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(p);
  if (!m) return null;
  const path = (m[2] ?? '').replace(/\\/g, '/');
  return { distro: m[1], path: path || '/' };
}

export function linuxPathToUnc(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`;
}

/** C:\a\b → /mnt/c/a/b (default WSL automount); null for non-drive paths. */
export function windowsPathToWslPath(p: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** In-distro pidfile written by the -lic bootstrap (`echo $$ > …; exec claude`).
 *  Lives in the distro's /tmp so it vanishes with the WSL VM — stale-file
 *  signals are harmless no-ops. Ids are path-safe (assertValidWorkspaceId). */
export function wslPidFile(workspaceId: string, sessionId: string): string {
  return `/tmp/claude-fleet-${workspaceId}-${sessionId}.pid`;
}

/** The two buttons on the newer-claude toast (#336). */
export type ClaudeUpdateDecision =
  | { action: 'adopt'; path: string }
  | { action: 'ignore'; version: string };

/** Fold a toast decision into the launcher. Pure — the caller persists the
 *  returned launcher via writeWorkspaceManifest. */
export function applyClaudeUpdateDecision(
  launcher: WorkspaceLauncher,
  decision: ClaudeUpdateDecision
): WorkspaceLauncher {
  if (launcher.mode !== 'wsl') {
    throw new Error(`claude-update decisions only apply to wsl launchers (got ${launcher.mode})`);
  }
  if (decision.action === 'adopt') {
    const { ignoreClaudeVersion: _cleared, ...rest } = launcher;
    return { ...rest, claudePath: decision.path };
  }
  return { ...launcher, ignoreClaudeVersion: decision.version };
}

/** Forward `passKeys` across the wsl.exe boundary: WSLENV names the vars
 *  (`/u` = Win→WSL only); the values ride the normal Windows env. */
export function buildWslSpawnEnv(
  base: NodeJS.ProcessEnv,
  passKeys: string[]
): NodeJS.ProcessEnv {
  if (passKeys.length === 0) return { ...base };
  const wslenv = [base.WSLENV, ...passKeys.map((k) => `${k}/u`)].filter(Boolean).join(':');
  return { ...base, WSLENV: wslenv };
}

/** Env vars fleet sets that claude must see inside the distro. Workspace env
 *  keys are appended at wrap time. TERM rides along so the TUI renders. */
const BASE_WSL_PASS_KEYS = ['CLAUDE_FLEET_BROKER_SESSION_ID', 'TERM'];

/**
 * Wrap a SpawnPty so the launcher decides what actually gets spawned.
 * - native: passthrough.
 * - wsl (win32 only): `wsl.exe -d <distro> --cd <cwd> --exec <shell> -lic
 *   'echo $$ > <pidfile>; exec <claudePath> <args…>'`. The pty's own cwd must
 *   be a valid WINDOWS dir (`opts.windowsCwd`) — the Linux cwd goes via --cd.
 *   The inner spawn's `file` (host claude) is ignored; the manifest-cached
 *   in-distro claudePath is used instead.
 * - custom: `{claude}`/`{args}` substitution, run via the platform shell from
 *   the original (host) cwd.
 */
export function wrapSpawnForLauncher(
  launcher: WorkspaceLauncher,
  inner: SpawnPty,
  opts: { workspaceId: string; platform: NodeJS.Platform; windowsCwd?: string; passEnvKeys?: string[] }
): SpawnPty {
  if (launcher.mode === 'native') return inner;

  if (launcher.mode === 'wsl') {
    if (opts.platform !== 'win32') {
      throw new Error(`launcher mode 'wsl' is only valid on win32 (got ${opts.platform})`);
    }
    if (!opts.windowsCwd) {
      throw new Error("launcher mode 'wsl' requires opts.windowsCwd (a valid Windows dir for wsl.exe itself)");
    }
    const windowsCwd = opts.windowsCwd;
    return (spawnOpts) => {
      const sessionId = spawnOpts.env.CLAUDE_FLEET_BROKER_SESSION_ID ?? 'unknown';
      const pidFile = wslPidFile(opts.workspaceId, sessionId);
      const cmd =
        `echo $$ > ${posixQuote(pidFile)}; ` +
        `exec ${[launcher.claudePath, ...spawnOpts.args].map(posixQuote).join(' ')}`;
      // Forward workspace env keys + fleet's own vars across the boundary.
      // opts.passEnvKeys carries any non-prefixed per-workspace keys (e.g. a
      // custom MYAPP_TOKEN in the workspace env) that the caller knows should
      // cross the WSL boundary; they're unioned with the auto-detected ones.
      const passKeys = [
        ...BASE_WSL_PASS_KEYS,
        ...Object.keys(spawnOpts.env).filter(
          (k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')
        ),
        ...(opts.passEnvKeys ?? [])
      ];
      return inner({
        ...spawnOpts,
        file: 'wsl.exe',
        args: ['-d', launcher.distro, '--cd', spawnOpts.cwd, '--exec', launcher.shell, '-lic', cmd],
        cwd: windowsCwd,
        env: buildWslSpawnEnv(spawnOpts.env, [...new Set(passKeys)])
      });
    };
  }

  // custom
  return (spawnOpts) => {
    // Use platform-appropriate quoting: POSIX single-quote on POSIX, cmd.exe
    // double-quote (with embedded-quote doubling) on win32. POSIX quoting
    // inside cmd.exe /c is unsafe — cmd.exe treats ' as a literal character
    // and uses " for grouping.
    const quote = opts.platform === 'win32' ? win32Quote : posixQuote;
    const quotedArgs = spawnOpts.args.map(quote).join(' ');
    let cmd = launcher.command;
    cmd = cmd.replace(/\{claude\}/g, quote(spawnOpts.file));
    cmd = cmd.includes('{args}') ? cmd.replace(/\{args\}/g, quotedArgs) : `${cmd} ${quotedArgs}`;
    const shell: { file: string; args: string[] } =
      opts.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/d', '/s', '/c', cmd] }
        : { file: 'sh', args: ['-c', cmd] };
    return inner({ ...spawnOpts, file: shell.file, args: shell.args });
  };
}

/**
 * The cwd claude will ACTUALLY have inside the distro, given a stored
 * `workspaceRoot` (#313).
 *
 * This is not always the stored string. `wrapSpawnForLauncher` hands the root
 * to `wsl.exe --cd` (above), and wsl.exe rewrites a Windows path into its
 * `/mnt/<drive>` automount form before claude ever sees it — so a root of
 * `C:\Users\t\fleet\ws` lands claude in `/mnt/c/Users/t/fleet/ws`. Anything
 * deriving a path from claude's cwd (its `~/.claude/projects/<encoded-cwd>`
 * dir, most of all) has to apply the same rewrite or it describes a directory
 * that will never exist.
 *
 * A path already in Linux form — the normal case, since both manifest writers
 * run `normalizeAndValidateWslRoot` — passes through untouched.
 */
export function wslInDistroPath(workspaceRoot: string): string {
  // A \\wsl.localhost\<distro>\… root is the same story one layer out: claude
  // sees the plain Linux path, not the UNC the host uses to reach it.
  const unc = uncToLinuxPath(workspaceRoot);
  if (unc) return unc.path;
  return windowsPathToWslPath(workspaceRoot) ?? workspaceRoot;
}

/** \\wsl.localhost transcript dir for a wsl-launcher workspace: the in-distro
 *  ~/.claude/projects/<encoded-cwd>, viewed over the 9P share. `encode` is
 *  paths.ts's encodeClaudeProjectDir, injected to keep this module pure.
 *  The cwd is normalized to its in-distro form first (#313) — encoding the
 *  stored Windows path made the watcher poll a directory claude never writes
 *  to, so such a workspace ingested nothing and showed up in neither the
 *  observability rail nor the session rail. */
export function wslLocalProjectsDir(
  distro: string,
  home: string,
  workspaceRoot: string,
  encode: (p: string) => string
): string {
  return linuxPathToUnc(
    distro,
    `${home}/.claude/projects/${encode(wslInDistroPath(workspaceRoot))}`
  );
}

/** \\wsl.localhost peer-status dir for a wsl-launcher workspace: the in-distro
 *  ~/.claude/sessions, viewed over the 9P share (polled, like projects). #286 */
export function wslLocalSessionsDir(distro: string, home: string): string {
  return linuxPathToUnc(distro, `${home}/.claude/sessions`);
}
