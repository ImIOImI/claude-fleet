import { useEffect, useState, useCallback, useRef, useReducer, useMemo } from 'react';
import { WorkspaceTabStrip } from './components/WorkspaceTabStrip';
import { ToastStack } from './components/Toast';
import { toastReducer, makeToast, type Toast, type ToastKind } from './toasts';
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
import LoadoutBrowserModal from './components/LoadoutBrowserModal';
import { useDropIngestion } from './dropIngestion';
import {
  applyContainerEdit,
  type WorkspaceLifecycleApi,
  type WorkspaceManifest
} from './workspaceLifecycle';
import { contextBarSummary } from './contextBarSource';
import { busyClaudeIdSet, openSessionMap, type OpenTabRef } from './busySessions';
import { mergeWaitingSessionIds, waitingFlags } from './waitingSessions';
import type { WorkspaceObservabilitySummary, SessionListItem, UsageBudget } from '../../preload';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';
export type WorkspaceKind = 'container' | 'local';
export type AuthMode = 'oauth' | 'apikey' | 'endpoint';

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
  /** authMode 'endpoint' only — id into the app-level model-endpoint registry (#250). */
  endpointId?: string;
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
  const [browseOpen, setBrowseOpen] = useState(false);
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
  // Plan-usage bar (observability rail): the configured allowance + the live
  // rolling-window spend, polled separately from per-workspace summaries.
  const [usageBudget, setUsageBudget] = useState<UsageBudget | null>(null);
  const [budgetSpentTokens, setBudgetSpentTokens] = useState(0);
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
  // Whether each workspace's active tab is a fresh (+-created) one vs. loaded
  // from inventory — drives the terminal context-bar fallback (#148).
  const [activeTabFreshByWorkspace, setActiveTabFreshByWorkspace] = useState<
    Record<string, boolean>
  >({});

  // Per-workspace busy state (claude actively working in any of its sessions),
  // detected from the PTY title glyph in TerminalPane → drives the chip.
  const [busyByWorkspace, setBusyByWorkspace] = useState<Record<string, boolean>>({});
  const handleBusyChange = useCallback((workspaceId: string, busy: boolean) => {
    setBusyByWorkspace((prev) => (prev[workspaceId] === busy ? prev : { ...prev, [workspaceId]: busy }));
  }, []);

  // Per-workspace busy *broker* session ids (the granular form of the busy
  // flag above), bubbled up from each TerminalPane. Resolved below to the set
  // of busy *claude* session UUIDs so the left-rail Sessions list can pulse
  // exactly the running sessions' rows.
  const [busyBrokerByWorkspace, setBusyBrokerByWorkspace] = useState<Record<string, string[]>>({});
  const handleBusyIds = useCallback((workspaceId: string, ids: string[]) => {
    setBusyBrokerByWorkspace((prev) => {
      const prevIds = prev[workspaceId] ?? [];
      // Order-insensitive equality — skip the state churn when nothing changed.
      if (prevIds.length === ids.length && prevIds.every((id) => ids.includes(id))) return prev;
      return { ...prev, [workspaceId]: ids };
    });
  }, []);
  // Per-workspace LIVE broker session ids (tabs whose PTY hasn't ended),
  // bubbled up from each TerminalPane. Resolved with the busy set below into
  // the claude-UUID-keyed open map for the Sessions list's Open group.
  const [liveBrokerByWorkspace, setLiveBrokerByWorkspace] = useState<Record<string, string[]>>({});
  const handleLiveIds = useCallback((workspaceId: string, ids: string[]) => {
    setLiveBrokerByWorkspace((prev) => {
      const prevIds = prev[workspaceId] ?? [];
      if (prevIds.length === ids.length && prevIds.every((id) => ids.includes(id))) return prev;
      return { ...prev, [workspaceId]: ids };
    });
  }, []);
  const [openSessions, setOpenSessions] = useState<Map<string, OpenTabRef>>(new Map());
  const openSessionsRef = useRef(openSessions);
  useEffect(() => { openSessionsRef.current = openSessions; }, [openSessions]);
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(new Set());
  // workspaceId -> set of claude session UUIDs blocked on AskUserQuestion.
  const [waitingByWorkspace, setWaitingByWorkspace] = useState<Map<string, Set<string>>>(new Map());

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

  // Dev-server detection (#port-forward): the broker spotted a new listening
  // port inside a workspace container. Offer a one-click preview that opens
  // the system browser via a loopback forward over the broker socket.
  useEffect(() => {
    return window.api.ports.onDetected((workspaceId, port) => {
      const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
      // Sticky: this toast is the only way to reach the preview (bridge IPs
      // aren't routable from the host on Windows), so it must never expire —
      // missing it means restarting the dev server to re-trigger detection.
      // It clears on click or ✕. Keyless so multiple ports can stack.
      const id = ++toastIdRef.current;
      dispatchToast({
        type: 'push',
        toast: makeToast(id, {
          kind: 'info',
          eyebrow: 'Preview',
          message: `Dev server detected on port ${port} in ${name}`,
          placement: 'global',
          sticky: true,
          dismissible: true,
          action: {
            label: 'Open preview',
            onClick: () => {
              void window.api.ports.open(workspaceId, port);
              dispatchToast({ type: 'dismiss', id });
            }
          }
        })
      });
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
  const [activateRequest, setActivateRequest] = useState<{
    workspaceId: string;
    brokerSessionId: string;
    token: number;
  } | null>(null);
  const activateTokenRef = useRef(0);
  const handleResumeSession = useCallback(
    async (item: SessionListItem): Promise<void> => {
      try {
        // Already open as a live tab somewhere? Jump to it instead of
        // spawning a duplicate `claude --resume` tab.
        const openTab = openSessionsRef.current.get(item.id);
        if (openTab) {
          setSelectedId(openTab.workspaceId);
          setActivateRequest({ ...openTab, token: ++activateTokenRef.current });
          return;
        }
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

  // Toasts — one unified component (src/renderer/src/toasts.ts + components/
  // Toast.tsx) drives both the global bottom-center stack here and the in-tab
  // committee toast in TerminalPane. Most are transient (auto-dismiss after
  // ttl); the MCP-unreachable toast is sticky (see the mcp:status effect
  // below). Used by the loadout reload (#16), drag-and-drop results (#87), and
  // MCP health (#159 follow-up). `kind`: 'progress' (spinner, default), 'ok'/
  // 'error' (status glyph + coloring), 'info' (eyebrow-only, e.g. committee).
  const [toasts, dispatchToast] = useReducer(toastReducer, [] as Toast[]);
  const toastIdRef = useRef(0);
  const dismissToast = useCallback((id: number): void => dispatchToast({ type: 'dismiss', id }), []);
  const pushToast = useCallback(
    (message: string, eyebrow?: string, ttlMs = 4000, kind: ToastKind = 'progress'): void => {
      const id = ++toastIdRef.current;
      dispatchToast({
        type: 'push',
        toast: makeToast(id, {
          kind,
          message,
          eyebrow,
          placement: 'global',
          sticky: false,
          dismissible: false
        })
      });
      setTimeout(() => dispatchToast({ type: 'dismiss', id }), ttlMs);
    },
    []
  );
  // MCP health → a single sticky "unreachable" toast (#159 follow-up). Main
  // broadcasts mcp:status on listener bind success/failure (change-only). While
  // down we show one keyed sticky error toast (Open log + ✕); the ✕ snoozes it
  // for the duration of this outage, and a reconnect clears it. A window opened
  // mid-outage learns the current status via getMcpStatus().
  useEffect(() => {
    const apply = (s: { ok: boolean; detail?: string }): void => {
      if (s.ok) {
        dispatchToast({ type: 'dismissKey', key: 'mcp-down' });
        return;
      }
      dispatchToast({
        type: 'push',
        toast: makeToast(++toastIdRef.current, {
          kind: 'error',
          eyebrow: 'MCP unreachable',
          message: "claude-fleet-state can't reach the host (:7071).",
          placement: 'global',
          sticky: true,
          dismissible: true,
          key: 'mcp-down',
          action: { label: 'Open log', onClick: () => void window.api.app.openErrorLog() }
        })
      });
    };
    void window.api.app.getMcpStatus().then(apply).catch(() => {});
    return window.api.app.onMcpStatus(apply);
  }, []);
  // Drag-and-drop / clipboard-image ingestion → selected workspace's _dropped/.
  // Results surface through the existing toast stack; errors linger longer.
  const notify = useCallback(
    (kind: 'ok' | 'error', message: string): void => {
      pushToast(message, kind === 'error' ? 'Drop failed' : 'Saved', kind === 'error' ? 6000 : 4000, kind);
    },
    [pushToast]
  );
  const { dragging } = useDropIngestion({ workspaceId: selectedId, notify });
  const handleReloadStarted = useCallback(
    (workspaceId: string): void => {
      const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
      pushToast(`Applying loadout in ${name}…`, 'Reloading');
    },
    [pushToast]
  );
  const handleRefreshRequested = useCallback(
    (name: string, busyNow: boolean): void => {
      pushToast(
        busyNow ? `Refreshing ${name} when idle…` : `Refreshing ${name}…`,
        'Refreshing'
      );
    },
    [pushToast]
  );
  // A refresh that can't identify its tab's conversation is skipped, never
  // guessed — resuming the wrong session silently cross-wires the tab (#195).
  const handleRefreshUnresolved = useCallback(
    (name: string): void => {
      pushToast(
        `Couldn't identify which conversation "${name}" holds — refresh skipped instead of switching sessions.`,
        'Refresh skipped',
        8000,
        'error'
      );
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
      setUsageBudget(cfg.usageBudget);
    });
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [apiReady]);

  // Poll fleet-wide rolling-window token spend for the plan-usage bar. Separate
  // (slower) cadence from the per-workspace summary refresh — it's a single
  // cheap aggregate and the rolling window moves on the order of minutes.
  useEffect(() => {
    if (!apiReady) return;
    const poll = () =>
      window.api.usage.rollingSpend().then((r) => setBudgetSpentTokens(r.spentTokens));
    poll();
    const t = setInterval(poll, 15000);
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

  // Resolve busy + live *broker* session ids → busy *claude* session UUIDs for
  // the left-rail Sessions list and → the claude-UUID-keyed open map for the
  // Sessions list's Open group. `summaryForBrokerSession` carries the mapped
  // claude session id (`sessionId`). Re-runs when either set changes and on
  // every observability push — the broker→claude mapping is learned as
  // transcripts ingest, so a freshly-busy session may not resolve on the first
  // try. Keyed on a stable, order-insensitive serialization of both sets.
  const brokerResolveKey = JSON.stringify(
    [busyBrokerByWorkspace, liveBrokerByWorkspace].map((rec) =>
      Object.entries(rec)
        .filter(([, ids]) => ids.length > 0)
        .map(([ws, ids]) => [ws, [...ids].sort()] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    )
  );
  useEffect(() => {
    if (!apiReady) {
      setBusySessionIds(new Set());
      setOpenSessions(new Map());
      return;
    }
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      // One mapping fetch pass over the union of busy + live broker ids.
      const wanted = new Map<string, Set<string>>();
      for (const rec of [busyBrokerByWorkspace, liveBrokerByWorkspace]) {
        for (const [wsId, ids] of Object.entries(rec)) {
          if (ids.length === 0) continue;
          const set = wanted.get(wsId) ?? new Set<string>();
          for (const id of ids) set.add(id);
          wanted.set(wsId, set);
        }
      }
      const mappings = new Map<string, Map<string, string>>();
      await Promise.all(
        [...wanted.entries()].map(async ([wsId, ids]) => {
          const m = new Map<string, string>();
          await Promise.all(
            [...ids].map(async (brokerId) => {
              try {
                const sum = await window.api.observability.summaryForBrokerSession(wsId, brokerId);
                if (sum?.sessionId) m.set(brokerId, sum.sessionId);
              } catch {
                /* mapping not learned yet — resolves on a later pass */
              }
            })
          );
          mappings.set(wsId, m);
        })
      );
      if (cancelled) return;
      const nextBusy = busyClaudeIdSet(busyBrokerByWorkspace, mappings);
      setBusySessionIds((prev) =>
        prev.size === nextBusy.size && [...prev].every((id) => nextBusy.has(id)) ? prev : nextBusy
      );
      const nextOpen = openSessionMap(liveBrokerByWorkspace, mappings);
      setOpenSessions((prev) => {
        if (prev.size === nextOpen.size) {
          let same = true;
          for (const [k, v] of nextOpen) {
            const p = prev.get(k);
            if (!p || p.workspaceId !== v.workspaceId || p.brokerSessionId !== v.brokerSessionId) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return nextOpen;
      });
    };
    void resolve();
    const unsubscribe = window.api.observability.onSummary(() => void resolve());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, brokerResolveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to input-wait pushes (sessions blocked on AskUserQuestion).
  useEffect(() => {
    const unsubscribe = window.api.observability.onInputWait((workspaceId, waitingSessionIds) => {
      setWaitingByWorkspace((prev) => {
        const next = new Map(prev);
        if (waitingSessionIds.length === 0) next.delete(workspaceId);
        else next.set(workspaceId, new Set(waitingSessionIds));
        return next;
      });
    });
    return unsubscribe;
  }, []);

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
      // Pull the selected image (not just the default runner) so a brand-new
      // ref is fetched here with progress, rather than 404'ing at create.
      await window.api.workspace.ensureImage(({ message }) => setStatus(message), submit.image);
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
      endpointId: submit.endpointId,
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
      endpointId: submit.endpointId,
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
      await window.api.workspace.ensureImage(({ message }) => setStatus(message), submit.image);
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
      endpointId: submit.endpointId,
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
      endpointId: submit.endpointId,
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
      endpointId: source.endpointId,
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
    // Container-level edits (image/env/resources/authMode) are fixed at
    // create time, so applying them means RECREATING the container from the
    // saved manifest — not a stop→start, which would reuse the old spec.
    const api: WorkspaceLifecycleApi = {
      getManifest: (id) =>
        window.api.workspace.getManifest(id) as Promise<WorkspaceManifest | null>,
      ensureImage: (onProgress, image) => window.api.workspace.ensureImage(onProgress, image),
      stop: (cid) => window.api.workspace.stop(cid),
      start: (id) => window.api.workspace.start(id),
      remove: (cid, opts) => window.api.workspace.remove(cid, opts),
      create: (input) => window.api.workspace.create(input)
    };
    try {
      await applyContainerEdit(
        api,
        { id: workspaceId, containerId },
        (message) => pushToast(message, 'Recreating', 4000, 'progress')
      );
      setRestartBannerIds((prev) => {
        if (!prev.has(workspaceId)) return prev;
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
      focusWorkspaceWhenWarm(workspaceId);
      pushToast('Workspace recreated with the updated settings.', 'Recreated', 4000, 'ok');
    } catch (err) {
      // Keep the banner up so the user can retry.
      console.error('recreate from restart-banner failed:', err);
      pushToast(`Recreate failed: ${(err as Error).message}`, 'Recreate failed', 8000, 'error');
    } finally {
      refresh();
    }
  };

  const dismissBanner = (workspaceId: string): void => {
    setRestartBannerIds((prev) => {
      if (!prev.has(workspaceId)) return prev;
      const next = new Set(prev);
      next.delete(workspaceId);
      return next;
    });
  };

  // Union of waiting claude UUIDs across all workspaces — for the Sessions list.
  const waitingSessionIds = useMemo(() => mergeWaitingSessionIds(waitingByWorkspace), [waitingByWorkspace]);
  // Per-workspace boolean — for the workspace chip.
  const waitingByWorkspaceFlag = useMemo(() => waitingFlags(waitingByWorkspace), [waitingByWorkspace]);

  return (
    <div className={`app${dragging ? ' dragging' : ''}`}>
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
        waitingByWorkspace={waitingByWorkspaceFlag}
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
          busySessionIds={busySessionIds}
          waitingSessionIds={waitingSessionIds}
          openSessions={openSessions}
          collapsed={leftCollapsed}
          onToggleCollapse={toggleLeftCollapsed}
          onResume={handleResumeSession}
          onChanged={refresh}
          onLoadoutInstalled={handleLoadoutInstalled}
          onBrowse={() => setBrowseOpen(true)}
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
                  summary={contextBarSummary(
                    selectedId === w.id,
                    activeTabSummary,
                    summaries[w.id] ?? null,
                    activeTabFreshByWorkspace[w.id] ?? false
                  )}
                  inbound={inboundByWorkspace[w.id] ?? null}
                  restartBanner={restartBannerIds.has(w.id)}
                  onRestartFromBanner={() => restartFromBanner(w.id, w.containerId!)}
                  onDismissBanner={() => dismissBanner(w.id)}
                  onResume={async () => {
                    await window.api.workspace.start(w.id);
                    refresh();
                  }}
                  onActiveTabChange={(workspaceId, brokerSessionId, isFresh) => {
                    setActiveTabByWorkspace((prev) =>
                      prev[workspaceId] === brokerSessionId
                        ? prev
                        : { ...prev, [workspaceId]: brokerSessionId }
                    );
                    setActiveTabFreshByWorkspace((prev) =>
                      prev[workspaceId] === isFresh
                        ? prev
                        : { ...prev, [workspaceId]: isFresh }
                    );
                  }}
                  onBusyChange={handleBusyChange}
                  onBusyIdsChange={handleBusyIds}
                  onLiveIdsChange={handleLiveIds}
                  activateRequest={
                    activateRequest?.workspaceId === w.id ? activateRequest : null
                  }
                  onActivateConsumed={() => setActivateRequest(null)}
                  resumeRequest={resumeRequest?.workspaceId === w.id ? resumeRequest : null}
                  onResumeConsumed={() => setResumeRequest(null)}
                  reloadRequest={reloadRequest?.workspaceId === w.id ? reloadRequest : null}
                  onReloadConsumed={() => setReloadRequest(null)}
                  onReloadStarted={() => handleReloadStarted(w.id)}
                  onRefreshRequested={handleRefreshRequested}
                  onRefreshUnresolved={handleRefreshUnresolved}
                  waitingSessionIds={waitingSessionIds}
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
          budget={usageBudget}
          budgetSpentTokens={budgetSpentTokens}
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
            // Pick up any usage-budget change made in the modal.
            window.api.config.get().then((c) => setUsageBudget(c.usageBudget));
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
      {browseOpen && (
        <LoadoutBrowserModal
          workspace={selectedWorkspace}
          onClose={() => setBrowseOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <div className="drop-overlay-title">Drop to add to this workspace</div>
            <div className="drop-overlay-sub">
              {selected ? `→ ${selected.name} · /workspace/_dropped/` : 'Select a workspace first'}
            </div>
          </div>
        </div>
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
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

// The empty/first-run view doubles as the product's pitch: a new user opens
// claude-fleet to nothing, so the main pane sells what the fleet does before
// asking them to create a workspace. Each card names a distinctive capability
// and the value it buys; the footer strip name-drops the secondary features.
const FLEET_FEATURES: { glyph: string; title: string; body: string }[] = [
  {
    glyph: '⠿',
    title: 'Run a whole fleet at once',
    body: 'Drive 3–6 Claude Code sessions side by side in one window — one keyboard, one set of credentials. Stop juggling terminals and start delegating in parallel.'
  },
  {
    glyph: '▣',
    title: 'Every agent fully sandboxed',
    body: 'Each workspace runs claude in its own Docker container against a private folder. Agents work at full tilt without stepping on each other — or on your machine.'
  },
  {
    glyph: '❚❚',
    title: 'Experts that never lose the thread',
    body: 'Pause an agent mid-thought and wake it later with its in-memory context intact. Build specialists that learn your codebase once and stay ready to act.'
  },
  {
    glyph: '◑',
    title: 'See every token and tool call',
    body: 'Live cost, token burn, context window, and tool activity for each session — read straight from Claude’s transcripts, never scraped from the screen.'
  },
  {
    glyph: '⌘',
    title: 'Orchestrate with the Committee',
    body: 'Let a manager agent coordinate a panel of expert workspaces — real multi-agent collaboration, with you watching the whole conversation.'
  },
  {
    glyph: '⇲',
    title: 'Drop in anything',
    body: 'Drag files, images, web content, or text onto the window and it lands in the agent’s folder with the path on your clipboard. The window is the inbox.'
  }
];

function FirstRun({ onNewWorkspace }: { onNewWorkspace: () => void }) {
  return (
    <div className="landing">
      <section className="landing-hero">
        <span className="eyebrow">
          <span className="dot" />
          claude fleet
        </span>
        <h1>Command a fleet of Claude agents.</h1>
        <p className="landing-lede">
          One window to launch, watch, and steer a small fleet of isolated Claude Code
          workspaces — each in its own sandbox, each with live cost and context telemetry,
          all under your hand.
        </p>
        <div className="landing-cta">
          <button className="btn primary" onClick={onNewWorkspace}>
            + Launch your first workspace
          </button>
          <span className="hint">Takes a workspace folder and an API key — about a minute.</span>
        </div>
      </section>

      <section className="landing-features">
        {FLEET_FEATURES.map((f) => (
          <article className="feature-card" key={f.title}>
            <div className="feature-glyph" aria-hidden="true">
              {f.glyph}
            </div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </section>

      <footer className="landing-more">
        <span className="eyebrow">also inside</span>
        <ul>
          <li>
            <strong>Loadouts</strong> — equip agents with skills &amp; config, auto-applied when idle
          </li>
          <li>
            <strong>Session history</strong> — resume any past session in any workspace
          </li>
          <li>
            <strong>Keychain secrets</strong> — credentials never hit disk in plaintext
          </li>
          <li>
            <strong>Fleet-state MCP</strong> — agents can query their own cost &amp; history
          </li>
        </ul>
      </footer>
    </div>
  );
}
