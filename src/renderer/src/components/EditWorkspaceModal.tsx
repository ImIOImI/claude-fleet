// Single-purpose edit modal for a live workspace. Opened from the chip
// ⋮ menu (running / paused / stopped — anywhere the workspace isn't in
// the Saved tab). Wraps `WorkspaceForm` in edit mode.
//
// Why a separate component rather than reusing `WorkspaceModal`: the
// Saved tab lists *non-running* workspaces by design (state 8 of the
// design doc). Editing a running workspace shouldn't require it to
// also appear in Saved — that would confuse the tab's mental model.
// A focused single-modal makes the chip-menu Edit interaction direct
// and lets the Save action know to surface the restart-to-apply banner
// when container-level fields changed.
//
// The "container-level changed" check is what triggers the banner in
// `TerminalPane` (see the `bannerByWorkspaceId` map in App.tsx). Plain
// labels / description / color / name edits land in the manifest
// immediately and don't trigger the banner.

import { useState } from 'react';
import { WorkspaceForm, type WorkspaceFormSubmit } from './WorkspaceForm';
import { DeleteWorkspaceModal } from './DeleteWorkspaceModal';
import type { WorkspaceSummary } from '../App';

interface Props {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  vaultAvailable: boolean | null;
  onClose: () => void;
  /** Apply edits to the manifest. Returns true if container-level fields changed (triggers the restart banner). */
  onSave: (submit: WorkspaceFormSubmit) => Promise<boolean>;
  /** Clone the source into a new workspace. */
  onClone: (submit: WorkspaceFormSubmit) => Promise<void>;
  /** Workspace was deleted — caller refreshes + closes. */
  onDeleted: () => void;
}

export function EditWorkspaceModal({
  workspace,
  workspaces,
  vaultAvailable,
  onClose,
  onSave,
  onClone,
  onDeleted
}: Props) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const handleSave = async (
    submit: WorkspaceFormSubmit,
    _setStatus: (m: string | null) => void
  ): Promise<void> => {
    await onSave(submit);
    onClose();
  };

  const handleClone = async (submit: WorkspaceFormSubmit): Promise<void> => {
    await onClone(submit);
    onClose();
  };

  const handleDeleteRequest = async (): Promise<void> => {
    setDeleteConfirmOpen(true);
  };

  if (deleteConfirmOpen) {
    return (
      <DeleteWorkspaceModal
        workspace={workspace}
        onClose={() => setDeleteConfirmOpen(false)}
        onDeleted={() => {
          setDeleteConfirmOpen(false);
          onDeleted();
          onClose();
        }}
      />
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-tabbed" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs" role="tablist">
          <div className="modal-tab active" aria-current="page">
            Edit {workspace.name}
          </div>
        </div>
        <div className="new-tab" role="tabpanel">
          <WorkspaceForm
            mode="edit"
            initial={{
              id: workspace.id,
              name: workspace.name,
              description: workspace.description,
              labels: workspace.labels,
              color: workspace.color,
              workspaceRoot: workspace.workspaceRoot,
              workspaceSubdir: workspace.workspaceSubdir,
              kind: workspace.kind,
              image: workspace.image,
              authMode: workspace.authMode,
              plainEnv: workspace.env.plain,
              // secretKeys is read by WorkspaceForm via a separate cast
              // (the initial reader looks for it on the partial object).
              secretKeys: workspace.env.secretKeys,
              resources: workspace.resources
            }}
            workspaces={workspaces}
            vaultAvailable={vaultAvailable}
            primaryLabel="Save"
            onSubmit={handleSave}
            onCancel={onClose}
            onClone={handleClone}
            onDelete={handleDeleteRequest}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Compare two workspace specs and report whether any container-level
 * field changed. Container-level = the fields the runner container
 * itself materializes (env, image, authMode, resources). Render-only
 * fields (name, description, labels, color, workspaceRoot,
 * workspaceSubdir) don't trigger the restart-to-apply banner — though
 * note that workspaceRoot + workspaceSubdir technically affect the
 * bind-mount; in practice changing those is rare and the user has to
 * recreate the container manually anyway.
 */
export function containerLevelChanged(
  before: WorkspaceSummary,
  after: WorkspaceFormSubmit
): boolean {
  if (before.authMode !== after.authMode) return true;
  if ((before.image ?? '') !== (after.image ?? '')) return true;
  // env.plain values
  const beforePlain = before.env.plain;
  const afterPlain = after.plainEnv;
  const allPlainKeys = new Set([...Object.keys(beforePlain), ...Object.keys(afterPlain)]);
  for (const k of allPlainKeys) {
    if ((beforePlain[k] ?? '') !== (afterPlain[k] ?? '')) return true;
  }
  // secretKeys add/remove
  const beforeSecrets = new Set(before.env.secretKeys);
  const afterSecrets = new Set(after.secretKeys);
  if (beforeSecrets.size !== afterSecrets.size) return true;
  for (const k of beforeSecrets) if (!afterSecrets.has(k)) return true;
  // Any newly-typed secret value
  if (Object.keys(after.secrets).length > 0) return true;
  // resources
  const beforeRes = before.resources;
  const afterRes = after.resources;
  if ((beforeRes?.cpus ?? null) !== (afterRes?.cpus ?? null)) return true;
  if ((beforeRes?.memoryMb ?? null) !== (afterRes?.memoryMb ?? null)) return true;
  return false;
}
