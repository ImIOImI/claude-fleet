// Resolves, per session, whether the durable transcript mirror is on. A pure
// in-memory registry — the IPC/watcher layer populates it; this module never
// touches disk, so it's trivially unit-testable.
//
// Indirection problem it solves: the per-session override is chosen at
// `pty:attach` time, keyed by the renderer's *broker* session id. The watcher,
// however, sees *claude* session ids (the JSONL filenames). The two are linked
// asynchronously when the broker->claude mapping is learned. So an override is
// stashed under the broker id at attach, then copied onto the claude id when
// the mapping lands (`learnMapping`). Until then -- and when no override was
// set -- resolution falls back to the workspace default, then the factory 'on'.
//
// Consequence (documented in SPEC section 11): a few lines emitted before the
// mapping is learned follow the workspace default rather than an off-override.
// The override is open-time only and locked for the session, so this is the
// only window where the two can disagree.

import type { MirrorSetting } from './workspaces.js';

const workspaceDefaults = new Map<string, MirrorSetting>();
const brokerOverrides = new Map<string, MirrorSetting>();
const claudeOverrides = new Map<string, MirrorSetting>();

// Composite map key. The '::' separator can never collide with content:
// workspace ids are ULIDs and session ids are path-safe [a-zA-Z0-9_-]+, so
// neither contains a colon.
const key = (a: string, b: string): string => `${a}::${b}`;

/** Cache a workspace's manifest `mirror.default`. Safe to call repeatedly. */
export function setWorkspaceDefault(workspaceId: string, setting: MirrorSetting): void {
  workspaceDefaults.set(workspaceId, setting);
}

/** Record a per-session override chosen at attach, keyed by broker session id. */
export function setSessionOverride(
  workspaceId: string,
  brokerSessionId: string,
  setting: MirrorSetting
): void {
  brokerOverrides.set(key(workspaceId, brokerSessionId), setting);
}

/** Propagate a pending broker-keyed override onto its claude session id. */
export function learnMapping(
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string
): void {
  const override = brokerOverrides.get(key(workspaceId, brokerSessionId));
  if (override) claudeOverrides.set(key(workspaceId, claudeSessionId), override);
}

/** Whether to mirror lines for a claude session: override -> workspace default -> 'on'. */
export function effectiveForClaudeSession(workspaceId: string, claudeSessionId: string): boolean {
  const setting =
    claudeOverrides.get(key(workspaceId, claudeSessionId)) ??
    workspaceDefaults.get(workspaceId) ??
    'on';
  return setting === 'on';
}

/** Test-only: drop all cached policy. */
export function _resetMirrorPolicyForTests(): void {
  workspaceDefaults.clear();
  brokerOverrides.clear();
  claudeOverrides.clear();
}
