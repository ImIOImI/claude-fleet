// Workspace → WorkspaceForm initial-value mapping, shared by the Saved-tab
// Resume flow (WorkspaceModal) and the live Edit modal (EditWorkspaceModal).
//
// Every field the form manages MUST be mapped here: an omitted field makes
// the form fall back to its default, and the writeManifest handler treats
// submitted fields as authoritative — so an omission is a silent factory
// reset on the next save. The Saved-tab flow used to omit `launcher`, which
// wiped a WSL workspace's distro/shell config from the manifest the first
// time it was resumed after an app restart; both flows used to omit `mirror`.
//
// Pure module (type-only imports) so it's unit-testable without React.

import type { WorkspaceSummary } from '../App';
import type { WorkspaceFormSubmit } from './WorkspaceForm';

/**
 * `secretKeys` is an output-only concept on submit, but the form's
 * initial reader looks for it on the partial object so edit surfaces can
 * show pre-existing secret keys as a "•••••" placeholder.
 */
export function workspaceToFormInitial(
  w: WorkspaceSummary
): Partial<WorkspaceFormSubmit> & { id: string } {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    labels: w.labels,
    color: w.color,
    workspaceSubdir: w.workspaceSubdir,
    kind: w.kind,
    workspaceRoot: w.workspaceRoot,
    launcher: w.launcher,
    terminalRenderer: w.terminalRenderer,
    image: w.image,
    authMode: w.authMode,
    endpointId: w.endpointId,
    plainEnv: w.env.plain,
    secretKeys: w.env.secretKeys,
    resources: w.resources,
    mirror: w.mirror,
    accessibility: w.accessibility
  };
}
