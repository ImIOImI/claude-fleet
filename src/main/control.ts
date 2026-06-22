// Cross-workspace committee control — the single enforcement point (#118).
//
// `assertControl(callerId, targetId, verb)` is the ONLY gate every committee
// effect (#119 pause/unpause, #120 post/collect) must pass through. Authority
// lives in the host-private manifests, never in anything a container holds, so
// a compromised workspace cannot grant itself power it wasn't given.
//
// Two-sided AND, default-deny: a call is permitted iff the CALLER holds an
// explicit per-target verb grant (outbound) AND the TARGET has opted in
// (inbound `reachable`, and either accepts everyone or names this caller).
// Both manifests are re-read fresh on every call so a revoked grant or a
// flipped `reachable` takes effect immediately — there is no cached authority.
//
// Container-only (hard constraint from the #116 threat-model review): a local
// (non-container) workspace runs with full host-FS access and could open any
// per-workspace socket, so its derived identity is NOT unspoofable. Either side
// being local fails closed.

import { readWorkspaceManifest, type WorkspaceSpec, type CommitteeVerb } from './workspaces.js';

export interface ControlDecision {
  ok: boolean;
  /** Human-readable denial reason (absent when ok). Surfaced to the caller. */
  reason?: string;
}

/** A workspace is a "manager" iff it holds at least one outbound grant. */
export function isManager(spec: WorkspaceSpec): boolean {
  return (spec.control?.canControl?.length ?? 0) > 0;
}

/**
 * Pure decision over already-loaded manifests. All the rules live here so the
 * truth table is unit-testable with no filesystem I/O. `caller`/`target` are
 * `null` when the respective manifest is missing.
 */
export function decideControl(
  caller: WorkspaceSpec | null,
  target: WorkspaceSpec | null,
  callerId: string,
  targetId: string,
  verb: CommitteeVerb
): ControlDecision {
  // A workspace controlling itself is meaningless and would bypass the
  // two-sided opt-in (it trivially "accepts" itself).
  if (callerId === targetId) return { ok: false, reason: 'a workspace cannot control itself' };
  if (!caller) return { ok: false, reason: `unknown caller workspace: ${callerId}` };
  if (!target) return { ok: false, reason: `unknown target workspace: ${targetId}` };

  // Container-only. Identity is only unspoofable for containers (#116).
  if (caller.kind !== 'container')
    return { ok: false, reason: 'caller is a local workspace (committee control is container-only)' };
  if (target.kind !== 'container')
    return { ok: false, reason: 'target is a local workspace (committee control is container-only)' };

  // No manager-of-managers: a workspace that itself holds outbound grants is a
  // manager and can NEVER be a control target — regardless of its own opt-in.
  // This keeps the committee a strict two-level hierarchy (managers → experts)
  // with no control chains or loops (#118). Only managers ever initiate control,
  // so "target is a manager" is exactly "a manager being controlled by another."
  if (isManager(target))
    return { ok: false, reason: `target ${targetId} is a manager; managers cannot be controlled by another manager` };

  // Inbound opt-in (default-deny). The target must be reachable, and — if it
  // restricts callers via acceptFrom — must name this caller.
  const acc = target.accessibility;
  if (!acc?.reachable) return { ok: false, reason: `target ${targetId} has not opted in (not reachable)` };
  if (acc.acceptFrom && acc.acceptFrom.length > 0 && !acc.acceptFrom.includes(callerId))
    return { ok: false, reason: `target ${targetId} does not accept caller ${callerId}` };

  // Outbound grant. The caller must hold this exact verb for this exact target.
  const grant = caller.control?.canControl?.find((g) => g.id === targetId);
  if (!grant || !grant.verbs.includes(verb))
    return { ok: false, reason: `caller ${callerId} lacks '${verb}' grant for ${targetId}` };

  return { ok: true };
}

/**
 * Load both manifests fresh and throw a descriptive error on denial; return
 * normally on permit. The fresh read is deliberate — it makes revocation
 * (editing either manifest) take effect on the very next call.
 */
export async function assertControl(callerId: string, targetId: string, verb: CommitteeVerb): Promise<void> {
  const [caller, target] = await Promise.all([
    readWorkspaceManifest(callerId),
    readWorkspaceManifest(targetId)
  ]);
  const decision = decideControl(caller, target, callerId, targetId, verb);
  if (!decision.ok) throw new Error(`control denied: ${decision.reason}`);
}
