// Review-before-install modal (#16-followup). Read-only preview of a loadout:
// what files it writes + its instructions, with Install/Uninstall as the commit
// step. Opened from the Library (clicking a card). "Open folder" reveals the
// loadout's source folder via the WSL-aware fs:openPath.

import { useEffect, useState } from 'react';

interface LoadoutDetail {
  id: string;
  title: string;
  version?: string;
  description: string;
  tags: string[];
  instructions: string;
  files: string[];
  merges?: { settingsKeys: string[]; mcpServers: string[]; hookEvents: string[] };
  dependencies?: { loadouts?: unknown[]; tools?: unknown[] };
  scripts?: { label: string }[];
  prompts?: { label: string }[];
}

interface Props {
  loadoutId: string;
  /** Install target — the selected workspace (null if none). */
  workspaceId: string | null;
  workspaceName: string | null;
  /** Selected workspace is a warm container we can install into. */
  installable: boolean;
  installed: boolean;
  onClose: () => void;
  /** Called after a successful install (refresh + restart nudge upstream). */
  onInstalled: () => void;
  onUninstalled: () => void;
}

function depList(d: unknown[] | undefined): string[] {
  if (!Array.isArray(d)) return [];
  return d.map((x) => (typeof x === 'string' ? x : ((x as { id?: string; cmd?: string }).id ?? (x as { cmd?: string }).cmd ?? ''))).filter(Boolean);
}

export function LoadoutReviewModal({
  loadoutId,
  workspaceId,
  workspaceName,
  installable,
  installed,
  onClose,
  onInstalled,
  onUninstalled
}: Props) {
  const [detail, setDetail] = useState<LoadoutDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.api.loadouts
      .get(loadoutId)
      .then((d) => live && setDetail(d as LoadoutDetail))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [loadoutId]);

  const install = async (): Promise<void> => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.loadouts.install(workspaceId, loadoutId);
      onInstalled();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const uninstall = async (): Promise<void> => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.loadouts.uninstall(workspaceId, loadoutId);
      onUninstalled();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const loadoutDeps = detail ? depList(detail.dependencies?.loadouts) : [];
  const toolDeps = detail ? depList(detail.dependencies?.tools) : [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal loadout-review" onClick={(e) => e.stopPropagation()}>
        <div className="lr-head">
          <span className="eyebrow">Loadout · review</span>
          <button
            className="btn btn-sm lr-open-folder"
            onClick={() => window.api.loadouts.openFolder(loadoutId)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            Open folder
          </button>
        </div>

        {!detail ? (
          <p className="subdued" style={{ padding: '12px 0' }}>{error ?? 'Loading…'}</p>
        ) : (
          <>
            <div className="lr-title-row">
              <h2>
                {detail.title}
                {detail.version && <span className="lr-ver">v{detail.version}</span>}
              </h2>
              {detail.tags.length > 0 && (
                <div className="tags">
                  {detail.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {detail.description && <p className="lr-desc">{detail.description}</p>}
            {(loadoutDeps.length > 0 || toolDeps.length > 0) && (
              <div className="lr-deps">
                {loadoutDeps.map((d) => (
                  <span className="dep" key={`l-${d}`}>needs · {d}</span>
                ))}
                {toolDeps.map((d) => (
                  <span className="dep" key={`t-${d}`}>tool · {d}</span>
                ))}
              </div>
            )}

            <div className="lr-meta">
              <span className="k">installs into</span> {workspaceName ?? '—'}
              <span className="k"> · </span>
              {detail.files.length} {detail.files.length === 1 ? 'file' : 'files'}
            </div>

            {detail.files.length > 0 && (
              <>
                <span className="lbl">Files written</span>
                <div className="manifest">
                  {detail.files.map((f) => (
                    <div className="mf" key={f}>
                      <span className="path">{f}</span>
                      <span className="badge-new">{f === 'CLAUDE.md' ? '+ block' : 'new'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.merges && (detail.merges.settingsKeys.length > 0 || detail.merges.mcpServers.length > 0) && (
              <>
                <span className="lbl">Merges into config</span>
                <div className="manifest">
                  {detail.merges.settingsKeys.map((k) => (
                    <div className="mf" key={`s-${k}`}>
                      <span className="path">.claude/settings.json · {k}</span>
                      <span className="badge-new">merge</span>
                    </div>
                  ))}
                  {detail.merges.mcpServers.map((s) => (
                    <div className="mf" key={`m-${s}`}>
                      <span className="path">.mcp.json · {s}</span>
                      <span className="badge-new">merge</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.merges && detail.merges.hookEvents.length > 0 && (
              <>
                <span className="lbl">Hooks · run on events</span>
                <div className="manifest">
                  {detail.merges.hookEvents.map((ev) => (
                    <div className="mf exec" key={`h-${ev}`}>
                      <span className="path">{ev}</span>
                      <span className="badge-run">runs</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.instructions && (
              <>
                <span className="lbl">Instructions</span>
                <div className="lr-instructions">{detail.instructions}</div>
              </>
            )}

            {!installed && installable && (
              <p className="lr-hint">
                Claude reads config at session start, so this loads on the next Claude session in
                this workspace. (One-click “reload current session” is coming.)
              </p>
            )}
            {error && <div className="error-text">{error}</div>}

            <div className="lr-foot">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              {installed ? (
                <button className="btn danger" disabled={busy} onClick={uninstall}>
                  Uninstall{workspaceName ? ` from ${workspaceName}` : ''}
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy || !installable}
                  title={installable ? undefined : 'Select a running container workspace to install'}
                  onClick={install}
                >
                  {installable ? `Install${workspaceName ? ` into ${workspaceName}` : ''}` : 'Not installable here'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
