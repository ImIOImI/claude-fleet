// Review-before-install modal (#16-followup). Read-only preview of a loadout:
// what files it writes + its instructions, with Install/Uninstall as the commit
// step. Opened from the Library (clicking a card). "Open folder" reveals the
// loadout's source folder via the WSL-aware fs:openPath.

import { useEffect, useState } from 'react';
import type { LoadoutAutomationPreview } from '../../../preload';
import { ModalBackdrop } from './ModalBackdrop';

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
  // Automations the loadout ships (#407 Phase 8): ticked = turned on by this install.
  const [autos, setAutos] = useState<LoadoutAutomationPreview[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [allowHost, setAllowHost] = useState(false);

  useEffect(() => {
    if (!workspaceId) { setAutos([]); return; }
    let live = true;
    window.api.loadouts.automations(workspaceId, loadoutId, allowHost).then((rows) => {
      if (!live) return;
      setAutos(rows);
      setTicked(new Set(rows.filter((r) => r.defaultOn && !r.blocked).map((r) => r.folder)));
    }).catch(() => live && setAutos([]));
    return () => { live = false; };
  }, [workspaceId, loadoutId, allowHost]);

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
      const res = (await window.api.loadouts.install(workspaceId, loadoutId, autos.length ? { automations: [...ticked], allowHost } : undefined)) as {
        scripts?: { label: string; status: string }[];
      };
      onInstalled();
      const failed = (res.scripts ?? []).filter((s) => s.status === 'failed');
      if (failed.length > 0) {
        // Files/merges landed; surface script failures and keep the modal open.
        setError(`Installed, but ${failed.length} script(s) failed: ${failed.map((f) => f.label).join(', ')}`);
        setBusy(false);
      } else {
        onClose();
      }
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
    <ModalBackdrop onClose={onClose}>
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

            {detail.scripts && detail.scripts.length > 0 && (
              <>
                <span className="lbl">Scripts · run on install</span>
                <div className="manifest">
                  {detail.scripts.map((s, i) => (
                    <div className="mf exec" key={`sc-${i}`}>
                      <span className="path">{s.label}</span>
                      <span className="badge-run">runs</span>
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

            {autos.length > 0 && (
              <>
                <span className="lbl">Automations · {installed ? 'update with this install' : 'turn on with this install'}</span>
                <div className="manifest lr-autos" aria-label="Automations in this loadout">
                  {autos.map((a) => {
                    const off = !!a.blocked || a.status !== 'new';
                    return (
                      <label className={`mf auto${a.hostStep ? ' host' : ''}`} key={a.folder}>
                        <input
                          type="checkbox"
                          aria-label={`Turn on ${a.name}`}
                          checked={ticked.has(a.folder)}
                          disabled={off}
                          onChange={(e) => setTicked((t) => { const n = new Set(t); if (e.target.checked) n.add(a.folder); else n.delete(a.folder); return n; })}
                        />
                        <span className="path">{a.name}</span>
                        <span className="lr-auto-flags">
                          {a.flags.map((f) => <span key={f} className={`tag${f.startsWith('runs a script on your computer') ? ' danger' : ''}`}>{f}</span>)}
                        </span>
                        <span className={`badge-new${a.status === 'invalid' || a.blocked ? ' warn' : ''}`}>
                          {a.status === 'invalid' ? 'invalid' : a.status === 'kept-edited' ? 'you edited it · kept' : a.status === 'update' ? 'update' : a.status === 'unchanged' ? 'installed' : 'new'}
                        </span>
                        {(a.blocked || a.errors.length > 0) && <span className="lr-auto-why">{a.errors[0] ?? a.blocked}</span>}
                      </label>
                    );
                  })}
                </div>
                {autos.some((a) => a.hostStep) && (
                  <label className="lr-host-allow">
                    <input type="checkbox" checked={allowHost} onChange={(e) => setAllowHost(e.target.checked)} />
                    Allow this loadout's automations to run scripts on this computer
                  </label>
                )}
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
    </ModalBackdrop>
  );
}
