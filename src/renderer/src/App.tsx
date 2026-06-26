import { useEffect, useState, useCallback, useRef } from 'react';
import { WorkspaceTabStrip } from './components/WorkspaceTabStrip';
import { LeftRail } from './components/LeftRail';
import { ObservabilityPane } from './components/ObservabilityPane';
import { TerminalPane } from './components/TerminalPane';
import { BottomBar } from './components/BottomBar';
import { WorkspaceModal, suggestCloneName } from './components/WorkspaceModal';
import type { WorkspaceFormSubmit } from './components/WorkspaceForm';
import { CloseWorkspaceModal } from './components/CloseWorkspaceModal';
import { DeleteWorkspaceModal } from './components/DeleteWorkspaceModal';
import { EditWorkspaceModal, containerLevelChanged } from './components/EditWorkspaceModal';
import { SettingsModal } from './components/SettingsModal';
import type { WorkspaceObservabilitySummary, SessionListItem } from '../../preload';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';
export type WorkspaceKind = 'container' | 'local';
export type AuthMode = 'oauth' | 'apikey';

export interface WorkspaceColor {
  hue: number;
}
export interface WorkspaceEnv {
  plain: Record<string, string>;
  secretKeys: string[];
}
export interface WorkspaceResources {
  cpus?: number;
  memoryMb?: number;
}
export type MirrorSetting = 'on' | 'off';
export type CleanupSetting = 'delete' | 'preserve';
export interface WorkspaceMirror {
  default: MirrorSetting;
  cleanup: CleanupSetting;
}

// Cross-workspace committee control (#118) — render-side mirror of the manifest
// blocks. `control.canControl` = outbound grants (makes this a "manager");
// `accessibility.reachable` = inbound opt-in (makes this a reachable "expert").
export type CommitteeVerb = 'read' | 'post' | 'pause';
export interface ControlGrant {
  id: string;
  verbs: CommitteeVerb[];
}
export interface ControlConfig {
  canControl?: ControlGrant[];
}
export interface AccessibilityConfig {
  reachable: boolean;
  acceptFrom?: string[];
  roleHint?: string;
}

/**
 * Render-side projection of the main-process `Workspace` type. Identity is
 * the ULID (`id`) — stable across renames, container churn, etc. The
 * `containerId` is only present for live workspaces (state !== 'deleted')
 * and is what backend operations like attach/stop/pause/remove need.
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  labels: string[];
  color?: WorkspaceColor;
  containerId?: string;
  state: WorkspaceState;
  status?: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  kind: WorkspaceKind;
  image?: string;
  authMode: AuthMode;
  env: WorkspaceEnv;
  resources?: WorkspaceResources;
  mirror: WorkspaceMirror;
  /** Loadouts installed into this workspace (#16-followup); absent ⇒ none. */
  installedLoadouts?: { id: string; title: string; version?: string }[];
  /** Outbound committee grants (#118); presence of a grant ⇒ this is a manager. */
  control?: ControlConfig;
  /** Inbound committee opt-in (#118); absent ⇒ unreachable (default-deny). */
  accessibility?: AccessibilityConfig;
  createdAt: number;
  lastUsedAt: number;
}

// One of 14 preset hues from the workspace color palette (OKLCH L=72%
// C=0.14, evenly spaced 360°/14 ≈ 25.7° apart). If the workspace hasn't
// picked a hue, hash the name into the same space so two workspaces with
// different names get different chip colors without explicit picking.
const PRESET_HUES = Array.from({ length: 14 }, (_, i) => Math.round((i * 360) / 14));
export function hueFor(ws: { name: string; color?: WorkspaceColor }): number {
  if (typeof ws.color?.hue === 'number') return ws.color.hue;
  let h = 0;
  for (let i = 0; i < ws.name.length; i++) h = (h * 31 + ws.name.charCodeAt(i)) >>> 0;
  return PRESET_HUES[h % PRESET_HUES.length];
}

/** CSS background-color for a hue at the workspace palette's L/C. */
export function colorFor(ws: { name: string; color?: WorkspaceColor }): string {
  return `oklch(72% 0.14 ${hueFor(ws)})`;
}

/** Read a persisted id-order array from localStorage (used for chip order). */
function loadIdOrder(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '');
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Stable-sort `list` by a saved id order. Items whose id is in `order` lead, in
 * that order; anything not yet in `order` (newly created workspaces) keeps its
 * original relative position at the end. Pure — used to apply the user's
 * drag-reordered chip order to each fresh `workspace:list`.
 */
function applyIdOrder<T extends { id: string }>(list: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.get(a.item.id) ?? Infinity;
      const rb = rank.get(b.item.id) ?? Infinity;
      return ra === rb ? a.i - b.i : ra - rb;
    })
    .map(({ item }) => item);
}

/** Move `draggedId` to sit immediately before `targetId` in a list of items. */
function moveBefore<T extends { id: string }>(list: T[], draggedId: string, targetId: string): T[] {
  if (draggedId === targetId) return list;
  const dragged = list.find((x) => x.id === draggedId);
  if (!dragged) return list;
  const without = list.filter((x) => x.id !== draggedId);
  const ti = without.findIndex((x) => x.id === targetId);
  if (ti < 0) return list;
  without.splice(ti, 0, dragged);
  return without;
}

export function App() {
  const apiReady = typeof window !== 'undefined' && !!window.api;
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  // Latest workspace list, readable from stable callbacks without re-binding.
  const workspacesRef = useRef<WorkspaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Observability rail collapse, persisted across restarts (pure UI pref —
  // localStorage, not the main-side config.json).
  const [obsCollapsed, setObsCollapsed] = useState(
    () => localStorage.getItem('obsRailCollapsed') === '1'
  );
  const toggleObsCollapsed = useCallback(() => {
    setObsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('obsRailCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);
  // Left rail collapse, same pattern/precedent as the observability rail (#4).
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem('leftRailCollapsed') === '1'
  );
  const toggleLeftCollapsed = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('leftRailCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);
  // User's drag-reordered chip order (workspace ids). Applied to every fresh
  // `workspace:list` so `workspaces` is always the display-ordered source (#1).
  const wsOrderRef = useRef<string[]>(loadIdOrder('workspaceOrder'));
  // A just-created workspace to focus the moment it comes up warm; suppresses
  // the auto-select "rescue" until then so creation doesn't bounce away (#2).
  const pendingSelectRef = useRef<string | null>(null);
  // The shared folder path (<fleetRoot>/shared), fetched once from app config.
  // Drives the observability rail's "Shared" link.
  const [sharedDir, setSharedDir] = useState<string | null>(null);
  // Auto-reload loadouts into running workspaces when claude is idle (#16).
  // Mirrors the config setting; default on until the first config.get resolves.
  const [autoReloadLoadouts, setAutoReloadLoadouts] = useState(true);
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  // When the user clicks Clone (Saved-row footer, chip menu, or
  // EditWorkspaceModal), the source spec lands here and the modal
  // reopens on the New tab pre-filled. Cleared when modal closes.
  const [cloneSource, setCloneSource] =
    useState<Partial<WorkspaceFormSubmit & { id: string }> | null>(null);
  // Workspaces whose container-level fields were just edited while
  // running. TerminalPane reads this map to render the
  // restart-to-apply banner; clearing happens on Restart or Dismiss.
  const [restartBannerIds, setRestartBannerIds] = useState<Set<string>>(new Set());
  const [summaries, setSummaries] = useState<
    Record<string, WorkspaceObservabilitySummary | null>
  >({});

  // Per-workspace active tab id, bubbled up from TerminalPane.
  // Keyed by workspace id (ULID) — names are mutable, ids aren't.
  const [activeTabByWorkspace, setActiveTabByWorkspace] = useState<
    Record<string, string>
  >({});

  // Per-workspace busy state (claude actively working in any of its sessions),
  // detected from the PTY title glyph in TerminalPane → drives the chip.
  const [busyByWorkspace, setBusyByWorkspace] = useState<Record<string, boolean>>({});
  const handleBusyChange = useCallback((workspaceId: string, busy: boolean) => {
    setBusyByWorkspace((prev) => (prev[workspaceId] === busy ? prev : { ...prev, [workspaceId]: busy }));
  }, []);

  // Latest committee message injected into each workspace (#123). The `nonce`
  // bumps on every inbound so TerminalPane re-shows its `[committee]` toast even
  // when the same text is posted twice.
  const [inboundByWorkspace, setInboundByWorkspace] = useState<
    Record<string, { message: string; nonce: number }>
  >({});
  useEffect(() => {
    return window.api.committee.onInbound((workspaceId, message) => {
      setInboundByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: { message, nonce: (prev[workspaceId]?.nonce ?? 0) + 1 }
      }));
    });
  }, []);

  const [activeTabSummary, setActiveTabSummary] = useState<
    WorkspaceObservabilitySummary | null
  >(null);

  // Pending resume request from the Sessions list, targeted at one workspace.
  // App brings the container up, selects the workspace, and hands this to the
  // matching TerminalPane, which opens a `claude --resume <uuid>` tab and
  // clears it via onResumeConsumed. `token` lets the same session be resumed
  // again later (a fresh token re-fires the pane's effect).
  const [resumeRequest, setResumeRequest] = useState<{
    workspaceId: string;
    claudeSessionId: string;
    title: string;
    token: number;
  } | null>(null);
  const resumeTokenRef = useRef(0);
  const handleResumeSession = useCallback(
    async (item: SessionListItem): Promise<void> => {
      try {
        const res = await window.api.sessions.resume(item.workspaceId);
        if (!res) {
          // Container gone / not recreatable here — non-fatal.
          // eslint-disable-next-line no-console
          console.warn('resume: workspace container could not be brought up', item.workspaceId);
          return;
        }
        setSelectedId(item.workspaceId);
        setResumeRequest({
          workspaceId: item.workspaceId,
          claudeSessionId: item.id,
          title: item.userSetName || item.aiTitle || item.firstUserMessage || 'resumed',
          token: ++resumeTokenRef.current
        });
        refresh();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('resume failed:', err);
      }
    },
    []
  );

  // Loadout reload request, targeted at one workspace (#16). Set when a loadout
  // is installed and the auto-reload setting is on; handed to the matching
  // TerminalPane, which reloads its active session in place once idle.
  const [reloadRequest, setReloadRequest] = useState<{
    workspaceId: string;
    token: number;
  } | null>(null);
  const reloadRequestTokenRef = useRef(0);

  // Transient toasts (bottom-center, auto-dismissing). Used so far for the
  // loadout reload, whose close+resume briefly flickers the terminal (#16).
  const [toasts, setToasts] = useState<{ id: number; eyebrow?: string; message: string }[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((message: string, eyebrow?: string, ttlMs = 4000): void => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, eyebrow, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttlMs);
  }, []);
  const handleReloadStarted = useCallback(
    (workspaceId: string): void => {
      const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
      pushToast(`Applying loadout in ${name}…`, 'Reloading');
    },
    [pushToast]
  );
  // Fired by the Library after a loadout install. Auto-reload only makes sense
  // for a running container workspace whose claude is live; if the setting is
  // off the user reloads manually (the loadout loads on their next claude start).
  const handleLoadoutInstalled = useCallback(
    (workspaceId: string): void => {
      if (!autoReloadLoadouts) return;
      const ws = workspacesRef.current.find((w) => w.id === workspaceId);
      if (!ws || ws.state !== 'running' || !ws.containerId) return;
      setReloadRequest({ workspaceId, token: ++reloadRequestTokenRef.current });
    },
    [autoReloadLoadouts]
  );

  // Per-terminal context for the selected workspace — one entry per session
  // tab (from sessions.json), each with its session's context-window usage.
  // Drives the observability pane's "Context · N terminals" bars.
  const [terminals, setTerminals] = useState<
    Array<{ id: string; name: string; contextTokens: number; windowTokens: number }>
  >([]);

  const refresh = async () => {
    if (!window.api) return;
    const ok = await window.api.workspace.backendReady();
    setBackendReady(ok);
    if (!ok) {
      setWorkspaces([]);
      workspacesRef.current = [];
      return;
    }
    const list = applyIdOrder((await window.api.workspace.list()) as WorkspaceSummary[], wsOrderRef.current);
    setWorkspaces(list);
    workspacesRef.current = list;
  };

  // Drag-reorder of workspace chips. `workspaces` is the display-ordered source,
  // so move the dragged workspace before the drop target and persist the new id
  // order (applied to every subsequent refresh). (#1)
  const handleReorderWorkspaces = useCallback((draggedId: string, targetId: string): void => {
    setWorkspaces((prev) => {
      const next = moveBefore(prev, draggedId, targetId);
      if (next === prev) return prev;
      wsOrderRef.current = next.map((w) => w.id);
      localStorage.setItem('workspaceOrder', JSON.stringify(wsOrderRef.current));
      workspacesRef.current = next;
      return next;
    });
  }, []);

  // Select a just-created/resumed workspace and keep focus on it as it boots:
  // pendingSelectRef suppresses the auto-select rescue until it's warm, with a
  // 10s safety release so a failed bring-up can't strand selection (#2).
  const focusWorkspaceWhenWarm = useCallback((id: string): void => {
    pendingSelectRef.current = id;
    setSelectedId(id);
    window.setTimeout(() => {
      if (pendingSelectRef.current === id) pendingSelectRef.current = null;
    }, 10000);
  }, []);

  useEffect(() => {
    if (!apiReady) return;
    refresh();
    window.api.vault.available().then(setVaultAvailable);
    window.api.app.mockMode().then(setMockMode);
    window.api.config.get().then((cfg) => {
      setSharedDir(cfg.sharedDir);
      setAutoReloadLoadouts(cfg.autoReloadLoadouts);
    });
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [apiReady]);

  // Keep a sensible selection on the "warm" fleet (running + paused — the only
  // states the top strip shows, #21). Three jobs:
  //   - On startup (nothing selected) focus the leftmost warm workspace (#3).
  //   - When a just-created workspace is coming up, lock onto it the moment it's
  //     warm and don't rescue away in the meantime — prevents the create bounce
  //     (selectedId set before `workspace:list` has caught up). (#2)
  //   - If the selected workspace leaves the warm set (stopped/removed), fall
  //     back to the leftmost warm one (or nothing).
  useEffect(() => {
    const warm = (w?: WorkspaceSummary): boolean =>
      !!w && (w.state === 'running' || w.state === 'paused');
    const pending = pendingSelectRef.current;
    if (pending) {
      const pw = workspaces.find((w) => w.id === pending);
      if (warm(pw)) {
        pendingSelectRef.current = null;
        setSelectedId(pending);
        return;
      }
      // Still booting (present-but-not-warm) or not in the list yet — hold.
      return;
    }
    const sel = selectedId ? workspaces.find((w) => w.id === selectedId) : undefined;
    if (warm(sel)) return;
    const firstWarm = workspaces.find(warm);
    setSelectedId(firstWarm?.id ?? null);
  }, [workspaces, selectedId]);

  // Observability summary distribution. Updates arrive via live push +
  // 30s safety poll. Re-keyed on the sorted workspace-id list so an
  // add/remove triggers resubscribe but a per-workspace lastUsedAt nudge
  // doesn't.
  const liveIds = workspaces
    .filter((w) => w.state !== 'deleted')
    .map((w) => w.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!apiReady) return;
    if (!liveIds) {
      setSummaries({});
      return;
    }
    const ids = liveIds.split(',');
    let cancelled = false;
    const refreshAll = async (): Promise<void> => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const s = await window.api.observability.summaryForWorkspace(id);
            return [id, s] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) return;
      setSummaries(Object.fromEntries(entries));
    };

    void refreshAll();

    const unsubscribe = window.api.observability.onSummary((workspaceId, summary) => {
      if (cancelled) return;
      if (!ids.includes(workspaceId)) return;
      setSummaries((prev) => ({ ...prev, [workspaceId]: summary }));
    });

    const id = setInterval(refreshAll, 30_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(id);
    };
  }, [apiReady, liveIds]);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedId) ?? null;
  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const activeTabId = selectedWorkspaceId
    ? activeTabByWorkspace[selectedWorkspaceId] ?? null
    : null;
  useEffect(() => {
    if (!apiReady || !selectedWorkspaceId || !activeTabId) {
      setActiveTabSummary(null);
      return;
    }
    let cancelled = false;
    const fetchOne = async (): Promise<void> => {
      try {
        const s = await window.api.observability.summaryForBrokerSession(
          selectedWorkspaceId,
          activeTabId
        );
        if (!cancelled) setActiveTabSummary(s);
      } catch {
        if (!cancelled) setActiveTabSummary(null);
      }
    };
    void fetchOne();
    const unsubscribe = window.api.observability.onSummary((pushedWorkspaceId) => {
      if (pushedWorkspaceId === selectedWorkspaceId) void fetchOne();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, selectedWorkspaceId, activeTabId]);

  // Per-terminal context for the selected workspace: read its session
  // inventory (sessions.json) and fetch each session's summary for the
  // context-window usage. Re-keyed on activeTabId so adding/closing a tab
  // (which moves activeId) re-reads; also refreshed on every push for the
  // selected workspace so a turn's growth shows live.
  useEffect(() => {
    if (!apiReady || !selectedWorkspaceId) {
      setTerminals([]);
      return;
    }
    let cancelled = false;
    const fetchTerminals = async (): Promise<void> => {
      try {
        const inv = await window.api.sessions.read(selectedWorkspaceId);
        const rows = await Promise.all(
          inv.sessions.map(async (s) => {
            const sum = await window.api.observability
              .summaryForBrokerSession(selectedWorkspaceId, s.id)
              .catch(() => null);
            return {
              id: s.id,
              name: s.name,
              contextTokens: sum?.lastTurnContextTokens ?? 0,
              windowTokens: sum?.contextWindowTokens ?? 200_000
            };
          })
        );
        if (!cancelled) setTerminals(rows);
      } catch {
        if (!cancelled) setTerminals([]);
      }
    };
    void fetchTerminals();
    const unsubscribe = window.api.observability.onSummary((pushedWorkspaceId) => {
      if (pushedWorkspaceId === selectedWorkspaceId) void fetchTerminals();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, selectedWorkspaceId, activeTabId]);

  if (!apiReady) {
    return (
      <div className="app">
        <div className="empty">
          <div className="preload-error">
            <h2>Preload script not loaded</h2>
            <p>
              <code>window.api</code> is undefined — the preload script failed to load. Stop and
              restart <code>npm run dev</code>; if you still see this after a clean restart, check
              the terminal where dev is running for a preload error.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const selected = selectedWorkspace;
  const liveCount = workspaces.filter((w) => w.state !== 'deleted').length;

  /**
   * Persist any newly-typed secret env values to the keychain. Pre-existing
   * secrets the form passed through unchanged (no value in `secrets`,
   * still listed in `secretKeys`) are left alone.
   */
  const persistSecrets = async (id: string, submit: WorkspaceFormSubmit): Promise<void> => {
    for (const [key, value] of Object.entries(submit.secrets)) {
      if (!value) continue;
      try {
        await window.api.vault.setSecret(id, key, value);
      } catch (err) {
        console.warn(`vault.setSecret(${id}, ${key}) failed:`, err);
      }
    }
  };

  /**
   * Mint workspace identity + persist any secret env values to the OS
   * keychain, then call `workspace:create`. Secrets are written *before*
   * the container is created so the main process can resolve them at
   * start time (see docker.ts → vault.resolveEnv).
   */
  const handleCreate = async (
    submit: WorkspaceFormSubmit,
    setStatus: (msg: string | null) => void
  ): Promise<void> => {
    const id = submit.id ?? `ws-${Date.now()}`; // WorkspaceModal mints a real ULID before calling
    const kind = submit.kind;

    if (kind === 'container') {
      await window.api.workspace.ensureImage(({ message }) => setStatus(message));
    }

    await persistSecrets(id, submit);

    setStatus('Creating workspace…');
    await window.api.workspace.create({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceSubdir: submit.workspaceSubdir,
      kind,
      workspaceRoot: submit.workspaceRoot,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources,
      mirror: submit.mirror
    });
    focusWorkspaceWhenWarm(id);
    refresh();
  };

  /**
   * Resume a saved workspace, applying any edits the user made in the
   * Saved-tab expand-edit form. Three cases by the workspace's current
   * state:
   *   - **stopped / paused**: write the updated manifest, then
   *     `workspace:start(id)` resumes the existing container by id-label
   *     lookup. Container-level edits (env, image, resources, authMode)
   *     don't take effect until the container is recreated — Phase 2's
   *     restart-to-apply banner surfaces this.
   *   - **deleted** (manifest exists, no container): the create flow runs
   *     with the original id reused so state-dir + vault + observability
   *     history stay attached.
   *   - **container disappeared between list + click**: `workspace:start`
   *     returns null and we fall through to recreate.
   */
  const handleResume = async (
    submit: WorkspaceFormSubmit,
    setStatus: (msg: string | null) => void
  ): Promise<void> => {
    const id = submit.id;
    if (!id) throw new Error('handleResume requires submit.id');

    await persistSecrets(id, submit);

    // Always write the manifest first so renderer-visible edits
    // (description, labels, color) take effect immediately even if the
    // container needs a restart for env/image changes.
    setStatus('Saving changes…');
    await window.api.workspace.writeManifest({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceSubdir: submit.workspaceSubdir,
      kind: submit.kind,
      workspaceRoot: submit.workspaceRoot,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources,
      mirror: submit.mirror,
      accessibility: submit.accessibility,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    });

    setStatus(`Starting ${submit.name}…`);
    const started = (await window.api.workspace.start(id)) as WorkspaceSummary | null;
    if (started) {
      focusWorkspaceWhenWarm(id);
      refresh();
      return;
    }
    // No container exists — recreate from spec, reusing the id.
    if (submit.kind === 'container') {
      await window.api.workspace.ensureImage(({ message }) => setStatus(message));
    }
    setStatus('Recreating workspace…');
    await window.api.workspace.create({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceSubdir: submit.workspaceSubdir,
      kind: submit.kind,
      workspaceRoot: submit.workspaceRoot,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources,
      mirror: submit.mirror
    });
    focusWorkspaceWhenWarm(id);
    refresh();
  };

  /**
   * Apply edits to a live workspace's manifest. Returns true when any
   * container-level field changed (caller flips the restart-to-apply
   * banner in TerminalPane).
   */
  const handleEditSave = async (submit: WorkspaceFormSubmit): Promise<boolean> => {
    const id = submit.id;
    if (!id) throw new Error('handleEditSave requires submit.id');
    const before = workspaces.find((w) => w.id === id);
    if (!before) throw new Error(`Workspace ${id} not found`);

    await persistSecrets(id, submit);
    await window.api.workspace.writeManifest({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceSubdir: submit.workspaceSubdir,
      kind: submit.kind,
      workspaceRoot: submit.workspaceRoot,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources,
      mirror: submit.mirror,
      accessibility: submit.accessibility,
      createdAt: before.createdAt,
      lastUsedAt: Date.now()
    });

    const containerEdit = containerLevelChanged(before, submit);
    if (containerEdit && (before.state === 'running' || before.state === 'paused')) {
      setRestartBannerIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
    refresh();
    return containerEdit;
  };

  /**
   * Open the modal in Clone mode pre-filled with the source's spec.
   * Strips the source's id, suggests `<source>-N` for the name, and
   * clears the color so a fresh hue is picked.
   */
  const openCloneFrom = (source: WorkspaceFormSubmit | WorkspaceSummary): void => {
    const isSummary = 'state' in source;
    const baseName = source.name;
    const plain = isSummary ? source.env.plain : source.plainEnv;
    const secretKeys = isSummary ? source.env.secretKeys : source.secretKeys;
    const clone: Partial<WorkspaceFormSubmit & { id: string }> = {
      // No id — WorkspaceModal.handleCreate mints a fresh ULID on submit.
      name: suggestCloneName(baseName, workspaces),
      description: source.description,
      labels: source.labels,
      color: undefined, // fresh hue
      workspaceSubdir: source.workspaceSubdir,
      kind: source.kind,
      workspaceRoot: source.workspaceRoot,
      image: source.image,
      authMode: source.authMode,
      plainEnv: { ...plain },
      // Don't carry secret *values* across — they live in the source's
      // vault entry, not in the clone's. The user re-enters them in the
      // env editor before submitting. (Showing pre-existing secret keys
      // would be misleading: those keys exist for the *source* id.)
      secretKeys: [...secretKeys],
      secrets: {},
      resources: source.resources,
      mirror: source.mirror
    };
    setCloneSource(clone);
    setEditTargetId(null); // close edit modal if open
    setCreateOpen(true);
  };

  const restartFromBanner = async (workspaceId: string, containerId: string): Promise<void> => {
    try {
      await window.api.workspace.stop(containerId);
    } catch (err) {
      console.warn('workspace.stop during restart-banner failed:', err);
    }
    try {
      await window.api.workspace.start(workspaceId);
    } catch (err) {
      console.warn('workspace.start during restart-banner failed:', err);
    }
    setRestartBannerIds((prev) => {
      if (!prev.has(workspaceId)) return prev;
      const next = new Set(prev);
      next.delete(workspaceId);
      return next;
    });
    refresh();
  };

  const dismissBanner = (workspaceId: string): void => {
    setRestartBannerIds((prev) => {
      if (!prev.has(workspaceId)) return prev;
      const next = new Set(prev);
      next.delete(workspaceId);
      return next;
    });
  };

  return (
    <div className="app">
      <WorkspaceTabStrip
        workspaces={workspaces}
        summaries={summaries}
        busyByWorkspace={busyByWorkspace}
        selectedId={selectedId}
        backendReady={backendReady}
        mockMode={mockMode}
        onSelect={setSelectedId}
        onNewWorkspace={() => setCreateOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onCloseWorkspace={(w) => setCloseTargetId(w.id)}
        onEditWorkspace={(w) => setEditTargetId(w.id)}
        onCloneWorkspace={(w) => openCloneFrom(w)}
        onDeleteWorkspace={(w) => setDeleteTargetId(w.id)}
        onRefresh={refresh}
        onReorderWorkspace={handleReorderWorkspaces}
      />

      <div
        className={`app-body${leftCollapsed ? ' left-collapsed' : ''}${
          obsCollapsed ? ' obs-collapsed' : ''
        }`}
      >
        <LeftRail
          workspaces={workspaces}
          selectedWorkspaceId={selectedId}
          selectedWorkspace={selectedWorkspace}
          collapsed={leftCollapsed}
          onToggleCollapse={toggleLeftCollapsed}
          onResume={handleResumeSession}
          onChanged={refresh}
          onLoadoutInstalled={handleLoadoutInstalled}
        />

        <main
          className="main-pane"
          // `--hue` is a full color (same as the chips, via colorFor) — every
          // CSS consumer (context-accent band, active session-tab underline)
          // uses it directly as a color. A bare `${hueFor}deg` angle is an
          // invalid color there, which silently blanked the context bar.
          style={selected ? { ['--hue' as never]: colorFor(selected) } : undefined}
        >
          <div className="main-body">
            {backendReady === false ? (
              <DockerDisconnected onRetry={refresh} />
            ) : liveCount === 0 ? (
              <FirstRun onNewWorkspace={() => setCreateOpen(true)} />
            ) : !selected || !selected.containerId ? (
              <div className="empty">
                <p style={{ color: 'var(--ink-2)' }}>No workspace selected.</p>
              </div>
            ) : null}
            {workspaces
              // Only the warm fleet (running + paused) gets an always-mounted
              // pane — stopped/deleted live in the modal, never the main pane (#21).
              .filter((w) => (w.state === 'running' || w.state === 'paused') && w.containerId)
              .map((w) => (
                <TerminalPane
                  key={w.id}
                  visible={selectedId === w.id}
                  workspaceId={w.id}
                  mirrorDefault={w.mirror.default}
                  cleanupDefault={w.mirror.cleanup}
                  containerId={w.containerId!}
                  paused={w.state === 'paused'}
                  summary={summaries[w.id] ?? null}
                  inbound={inboundByWorkspace[w.id] ?? null}
                  restartBanner={restartBannerIds.has(w.id)}
                  onRestartFromBanner={() => restartFromBanner(w.id, w.containerId!)}
                  onDismissBanner={() => dismissBanner(w.id)}
                  onResume={async () => {
                    await window.api.workspace.start(w.id);
                    refresh();
                  }}
                  onActiveTabChange={(workspaceId, brokerSessionId) => {
                    setActiveTabByWorkspace((prev) =>
                      prev[workspaceId] === brokerSessionId
                        ? prev
                        : { ...prev, [workspaceId]: brokerSessionId }
                    );
                  }}
                  onBusyChange={handleBusyChange}
                  resumeRequest={resumeRequest?.workspaceId === w.id ? resumeRequest : null}
                  onResumeConsumed={() => setResumeRequest(null)}
                  reloadRequest={reloadRequest?.workspaceId === w.id ? reloadRequest : null}
                  onReloadConsumed={() => setReloadRequest(null)}
                  onReloadStarted={() => handleReloadStarted(w.id)}
                />
              ))}
          </div>
        </main>

        <ObservabilityPane
          workspaceName={selected?.name ?? null}
          summary={activeTabSummary}
          workspace={selected ?? null}
          sharedDir={sharedDir}
          workspaces={workspaces}
          summaries={summaries}
          terminals={terminals}
          activeTerminalId={activeTabId}
          collapsed={obsCollapsed}
          onToggleCollapse={toggleObsCollapsed}
        />
      </div>

      <BottomBar vaultAvailable={vaultAvailable} />

      <WorkspaceModal
        open={createOpen}
        workspaces={workspaces}
        vaultAvailable={vaultAvailable}
        onClose={() => {
          setCreateOpen(false);
          setCloneSource(null);
        }}
        onCreate={async (submit, setStatus) => {
          await handleCreate(submit, setStatus);
          setCloneSource(null);
        }}
        onResume={handleResume}
        onClone={async (submit) => openCloneFrom(submit)}
        onDelete={(w) => setDeleteTargetId(w.id)}
        initialNewTabValues={cloneSource}
      />
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={(cfg) => {
            setSharedDir(cfg.sharedDir);
            refresh();
          }}
        />
      )}
      {(() => {
        if (!editTargetId) return null;
        const target = workspaces.find((w) => w.id === editTargetId);
        if (!target) return null;
        return (
          <EditWorkspaceModal
            workspace={target}
            workspaces={workspaces}
            vaultAvailable={vaultAvailable}
            onClose={() => setEditTargetId(null)}
            onSave={handleEditSave}
            onClone={async (submit) => openCloneFrom(submit)}
            onDeleted={() => {
              if (selectedId === target.id) setSelectedId(null);
              refresh();
            }}
          />
        );
      })()}
      {(() => {
        if (!deleteTargetId) return null;
        const target = workspaces.find((w) => w.id === deleteTargetId);
        if (!target) return null;
        return (
          <DeleteWorkspaceModal
            workspace={target}
            onClose={() => setDeleteTargetId(null)}
            onDeleted={() => {
              if (selectedId === target.id) setSelectedId(null);
              refresh();
            }}
          />
        );
      })()}
      {(() => {
        if (!closeTargetId) return null;
        const target = workspaces.find((w) => w.id === closeTargetId);
        if (!target || !target.containerId) return null;
        return (
          <CloseWorkspaceModal
            workspace={target}
            onClose={() => setCloseTargetId(null)}
            onClosed={() => {
              if (selectedId === target.id) setSelectedId(null);
              refresh();
            }}
          />
        );
      })()}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span className="toast-spinner" aria-hidden="true" />
              <span className="toast-body">
                {t.eyebrow && <span className="toast-eyebrow">{t.eyebrow}</span>}
                <span className="toast-text">{t.message}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DockerDisconnected({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="empty">
      <div className="icon-card error">!</div>
      <span className="eyebrow error">
        <span className="dot" />
        disconnected
      </span>
      <h2>Docker daemon unreachable</h2>
      <p>
        Start Docker Desktop (with WSL2 integration on Windows). claude-fleet will reconnect
        automatically once it's back.
      </p>
      <button className="btn" onClick={onRetry}>
        Retry connection
      </button>
    </div>
  );
}

function FirstRun({ onNewWorkspace }: { onNewWorkspace: () => void }) {
  return (
    <div className="empty">
      <div className="icon-card">▢</div>
      <span className="eyebrow">first run</span>
      <h2>No workspaces yet</h2>
      <p>
        Each workspace runs <code>claude</code> in an isolated Docker container against a host
        directory. Spin up your first to get started.
      </p>
      <button className="btn primary" onClick={onNewWorkspace}>
        + New workspace
      </button>
      <span className="hint">You'll need a workspace folder and an API key</span>
    </div>
  );
}
