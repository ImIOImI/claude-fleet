// Shared committee bits (#118): the two chip glyphs + role predicates, used by
// the workspace ribbon (WorkspaceTabStrip), the grant matrix (CommitteePane),
// and the opt-in form section. Keeping them in one place means the "manager"
// and "reachable" definitions can't drift between surfaces.

import type { CommitteeVerb, ControlConfig, AccessibilityConfig } from '../App';

/** The verbs a grant can carry, in display order. */
export const COMMITTEE_VERBS: CommitteeVerb[] = ['read', 'post', 'pause'];

/** Minimal shape the helpers need (a WorkspaceSummary structurally satisfies it). */
export interface CommitteeFields {
  id: string;
  kind: 'container' | 'local';
  control?: ControlConfig;
  accessibility?: AccessibilityConfig;
}

/** A workspace is a manager iff it holds at least one outbound grant. Mirrors
 *  `control.ts:isManager` on the main side — keep them in lockstep. */
export function isManager(ws: { control?: ControlConfig }): boolean {
  return (ws.control?.canControl?.length ?? 0) > 0;
}

/** A workspace is reachable (an opted-in expert) iff it explicitly set the flag. */
export function isReachable(ws: { accessibility?: AccessibilityConfig }): boolean {
  return ws.accessibility?.reachable === true;
}

/** Verbs `manager` currently grants over `targetId` (empty if none). */
export function grantedVerbs(manager: { control?: ControlConfig }, targetId: string): CommitteeVerb[] {
  return manager.control?.canControl?.find((g) => g.id === targetId)?.verbs ?? [];
}

/** Expert "reachable / listening" marker — the wifi glyph. */
export function WifiGlyph({ size = 14, title }: { size?: number; title?: string }): React.JSX.Element {
  return (
    <svg className="committee-glyph wifi" width={size} height={size} viewBox="0 0 16 16" aria-hidden={!title}>
      {title && <title>{title}</title>}
      <circle cx="8" cy="11.5" r="1.5" fill="currentColor" />
      <path
        d="M5 8.5a4 4 0 016 0M3 6.2a7 7 0 0110 0"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Manager "controls others" marker — the hierarchy / org-chart glyph: one
 *  node commanding two below it. */
export function ManagerGlyph({ size = 14, title }: { size?: number; title?: string }): React.JSX.Element {
  return (
    <svg className="committee-glyph mgr" width={size} height={size} viewBox="0 0 16 16" aria-hidden={!title}>
      {title && <title>{title}</title>}
      <rect x="5.7" y="1.4" width="4.6" height="3.4" rx="0.9" fill="currentColor" />
      <rect x="1.2" y="11.2" width="4.6" height="3.4" rx="0.9" fill="currentColor" />
      <rect x="10.2" y="11.2" width="4.6" height="3.4" rx="0.9" fill="currentColor" />
      <path d="M8 4.8v2.4M3.5 11.2V8.6h9v2.6" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  );
}
