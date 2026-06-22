// Committee grant matrix (#118), rendered inside the left-rail "Committee"
// accordion section. Keys off the *selected* workspace as the would-be manager
// (mirrors how LibraryPane keys off the selected workspace): the rows are the
// other reachable container workspaces, and ticking read/post/pause writes the
// manager's outbound `control.canControl` grant.
//
// The host-side gate (control.ts:assertControl) is the real authority; this
// pane is just the editor. It reflects two of the gate's rules so the UI never
// offers an impossible grant: a *manager* can't be controlled by another
// manager (so managers are shown excluded), and committee control is
// container-only (so a local selected workspace can't act as a manager).

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceSummary, CommitteeVerb, ControlConfig, ControlGrant } from '../App';
import { COMMITTEE_VERBS, isManager, isReachable, ManagerGlyph, WifiGlyph } from './committee';

interface Props {
  /** The workspace acting as manager (the currently-selected one). */
  selectedWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  /** Refresh the workspace list after a grant change (re-renders chips + matrix). */
  onChanged: () => void;
}

/** Full manifest shape we read back to mutate grants without dropping fields. */
type Manifest = WorkspaceSummary & { control?: ControlConfig };

/** Recompute a manager's grant list after toggling one verb for one target. */
function withVerb(grants: ControlGrant[], peerId: string, verb: CommitteeVerb, on: boolean): ControlGrant[] {
  const next = grants.map((g) => ({ id: g.id, verbs: [...g.verbs] }));
  let entry = next.find((g) => g.id === peerId);
  if (!entry) {
    entry = { id: peerId, verbs: [] };
    next.push(entry);
  }
  const verbs = new Set(entry.verbs);
  if (on) verbs.add(verb);
  else verbs.delete(verb);
  entry.verbs = COMMITTEE_VERBS.filter((v) => verbs.has(v)); // canonical order
  return next.filter((g) => g.verbs.length > 0); // drop empty grants
}

export function CommitteePane({ selectedWorkspace, workspaces, onChanged }: Props) {
  const manager = selectedWorkspace;
  const managerId = manager?.id ?? null;

  // Optimistic local copy of the manager's grants: a checkbox is controlled off
  // this, so it flips instantly on click; the manifest write + list refresh
  // follow asynchronously and converge. Re-seed only when the manager changes
  // (our own writes are already reflected here, so a refresh can't stomp them).
  const [grants, setGrants] = useState<ControlGrant[]>(manager?.control?.canControl ?? []);
  useEffect(() => {
    setGrants(selectedWorkspace?.control?.canControl ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerId]);

  const verbsFor = (peerId: string): CommitteeVerb[] =>
    grants.find((g) => g.id === peerId)?.verbs ?? [];

  const setVerb = useCallback(
    async (peerId: string, verb: CommitteeVerb, on: boolean): Promise<void> => {
      if (!manager) return;
      const prev = grants;
      const next = withVerb(prev, peerId, verb, on);
      setGrants(next); // optimistic
      try {
        // Read the authoritative manifest fresh, swap in the new grants, write
        // it back. The writeManifest handler merges over the rest, so nothing
        // else on the manager's manifest is disturbed.
        const spec = (await window.api.workspace.getManifest(manager.id)) as Manifest | null;
        if (!spec) return;
        const control: ControlConfig | undefined = next.length ? { canControl: next } : undefined;
        await window.api.workspace.writeManifest({ ...spec, control });
        onChanged();
      } catch {
        setGrants(prev); // revert on failure
      }
    },
    [manager, grants, onChanged]
  );

  if (!manager) {
    return <div className="committee-empty">Select a workspace to manage its committee grants.</div>;
  }
  if (manager.kind === 'local') {
    return (
      <div className="committee-empty">
        Local workspaces can&apos;t act as a committee manager — control is container-only.
      </div>
    );
  }

  // Candidate targets: every other container workspace. Reachable non-managers
  // are editable; managers and opted-out workspaces are shown excluded so the
  // exclusion is visible rather than mysterious.
  const peers = workspaces.filter((w) => w.id !== manager.id && w.kind === 'container');
  const editable = peers.filter((w) => isReachable(w) && !isManager(w));
  const excluded = peers.filter((w) => !(isReachable(w) && !isManager(w)));

  return (
    <div className="committee-pane">
      <p className="committee-mgr-note">
        Grants for <strong>{manager.name}</strong> as manager. Tick a verb to let it act on a reachable
        workspace.
      </p>
      {editable.length === 0 && excluded.length === 0 ? (
        <div className="committee-empty">No other workspaces yet.</div>
      ) : (
        <table className="committee-matrix">
          <thead>
            <tr>
              <th>Workspace</th>
              {COMMITTEE_VERBS.map((v) => (
                <th key={v}>{v}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {editable.map((w) => {
              const verbs = verbsFor(w.id);
              return (
                <tr key={w.id}>
                  <td>
                    <span className="peer-name">
                      <WifiGlyph size={12} />
                      {w.name}
                    </span>{' '}
                    {w.accessibility?.roleHint && <span className="peer-role">{w.accessibility.roleHint}</span>}
                  </td>
                  {COMMITTEE_VERBS.map((v) => (
                    <td key={v}>
                      <input
                        type="checkbox"
                        aria-label={`${v} ${w.name}`}
                        checked={verbs.includes(v)}
                        onChange={(e) => setVerb(w.id, v, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            {excluded.map((w) => {
              const reason = isManager(w) ? 'manager — not controllable' : 'opted out';
              return (
                <tr key={w.id} className="excluded">
                  <td>
                    <span className="peer-name">
                      {isManager(w) && <ManagerGlyph size={11} />}
                      {w.name}
                    </span>{' '}
                    <span className="peer-role">{reason}</span>
                  </td>
                  <td colSpan={COMMITTEE_VERBS.length} className="peer-role">
                    {isManager(w) ? 'excluded by the no-manager-of-managers rule' : 'flip its Reachable toggle to appear'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
