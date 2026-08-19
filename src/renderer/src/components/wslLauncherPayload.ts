// Submit-time wsl-launcher payload for WorkspaceForm (#339). The form probes
// the distro at modal open, but the probe re-finds well-known install dirs
// before the login shell (#336) — so rebuilding the launcher purely from
// probe state silently reverted an adopted claudePath and dropped
// ignoreClaudeVersion on every Saved-tab resume and edit-save. Rule: when the
// picked distro matches the manifest's, the MANIFEST owns claudePath and
// ignoreClaudeVersion (the claude-update toast is the mechanism that changes
// them); the probe only refreshes home/interopEnabled. A genuine distro
// change gets full probe values and clears the ignore.
//
// Pure module (type-only shapes, no React) so it's unit-testable — same
// discipline as formInitial.ts.

export interface WslLauncherFields {
  mode: 'wsl';
  distro: string;
  shell: string;
  home: string;
  claudePath: string;
  interopEnabled?: boolean;
  ignoreClaudeVersion?: string;
}

/** The subset of a finished distro probe this payload consumes. */
export interface WslProbeFields {
  home: string;
  claudePath: string | null;
  interopEnabled: boolean;
}

export function buildWslLauncherPayload(
  initial: { mode: 'native' } | WslLauncherFields | { mode: 'custom'; command: string } | undefined,
  distro: string,
  shell: string,
  probe: WslProbeFields | null
): WslLauncherFields {
  const kept = initial?.mode === 'wsl' && initial.distro === distro ? initial : null;
  const claudePath = kept?.claudePath || probe?.claudePath || '';
  // `home` prefers the fresh probe (same distro ⇒ same answer); the manifest
  // value only backstops a probe that hasn't finished.
  const home = probe?.home ?? kept?.home ?? '';
  // interopEnabled keeps the #259 tri-state: omitted means "not probed".
  const interopEnabled = probe ? probe.interopEnabled : kept?.interopEnabled;
  return {
    mode: 'wsl',
    distro,
    shell,
    home,
    claudePath,
    ...(interopEnabled !== undefined ? { interopEnabled } : {}),
    ...(kept?.ignoreClaudeVersion ? { ignoreClaudeVersion: kept.ignoreClaudeVersion } : {})
  };
}
