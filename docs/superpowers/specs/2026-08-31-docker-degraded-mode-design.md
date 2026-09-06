# Docker degraded mode: the app stays usable when the daemon is down

**Date:** 2026-08-31
**Status:** Approved (designed with Troy; scope: degraded mode — not a docker-free first-run product)
**Repo:** claude-fleet

## Problem

A dead Docker daemon makes the whole app unusable, including local workspaces
that don't need Docker at all. Two mechanisms, both from the Docker-only era:

1. The renderer's `refresh()` gates everything on `workspace:ping` — on
   failure it sets `backendReady=false`, clears the workspace list, and
   renders the full-screen `DockerDisconnected` panel (a specified flow,
   SPEC §8 step 3, #23).
2. `fetchAllWorkspaces` (`src/main/ipc.ts`) merges backends with a bare
   `Promise.all`, so the docker backend's rejection takes the local backend
   and the manifests down with it.

Local workspaces (#16/#253) never need the daemon; every Docker Desktop
update, WSL flap, or daemon restart currently blanks live local sessions.
Fixing this also unblocks Docker-off perf experiments (#379 rev 1's fatal
flaw).

A machine with no Docker installed gets the same degraded experience for
free (ping always fails identically). First-run copy, create-flow defaults,
and Docker-specific UI stay Docker-first — full docker-optional is a
non-goal.

## Design

### 1. State model (main process) — `'unreachable'` + last-known-state map

- `WorkspaceState` gains a fifth value: `'unreachable'`. `Workspace` gains
  optional `lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted'`.
- `ipc.ts` keeps a module-level in-memory map `id → state`, overwritten from
  every **successful** merged fetch (the post-merge states, not the raw
  docker listing — so `'deleted'` is remembered too). Never persisted;
  cleared only by app quit. A mid-outage window reload keeps warm chips; an
  app started while the daemon is down has an empty map (everything
  unreachable lands cold, per the approved Option A mockup).
- `fetchAllWorkspaces` switches to `Promise.allSettled`. When the docker
  half rejects with a **daemon-connect error** (ECONNREFUSED / ENOENT /
  ENOTFOUND / EPIPE / ECONNRESET on the socket — a `isDaemonConnectError`
  predicate in `workspaceMerge.ts`), every container-kind manifest is synthesized as
  `state: 'unreachable'`, `lastKnownState` from the map (absent if unknown),
  `containerId: undefined`. Local workspaces and manifests merge exactly as
  today. **Any other docker error still rejects the whole fetch** — a real
  bug must not hide behind "unreachable".
- Exception inside the honest-state rule: an id whose last known state is
  `'deleted'` stays `'deleted'` during an outage (the last successful
  listing proved the container gone; an outage doesn't un-prove it).

### 2. IPC surface — no channel changes

- `workspace:ping` keeps its meaning (daemon reachable) and keeps driving
  the strip's Docker dot (#23).
- `workspace:list` still returns `Workspace[]`; the only payload change is
  the new state value plus `lastKnownState`.
- The renderer's `refresh()` no longer early-returns on ping-fail: it always
  fetches the list, and uses the ping result only for the dot + banner.

### 3. Renderer UX (per the approved Option A mockup)

- **`DockerDisconnected` is deleted.** A slim banner replaces it, rendered
  whenever ping is false: "Docker daemon unreachable — container workspaces
  are shown from last-known state and can't be started or attached until
  it's back."
- **Strip warm-filter** becomes `running | paused | (unreachable &&
  lastKnownState ∈ {running, paused})`. Unreachable warm chips render
  dimmed (reduced opacity, dashed border, pulsing red dot) with secondary
  line `unreachable · was running` / `… · was paused`. Chips don't vanish
  on a daemon flap.
- Unreachable chips stay **selectable**; selecting one shows an inert
  main-pane card ("Docker daemon unreachable — sessions will reattach when
  it's back") instead of yanking selection to another workspace. The
  auto-reselect rule (selected workspace leaves the warm set) treats
  warm-unreachable as still warm.
- `TerminalPane` mount filter unchanged (`running|paused` + containerId) —
  unreachable panes unmount. Tabs persist in `sessions.json`; when the
  daemon returns and the container auto-restarts (`unless-stopped`), the
  existing daemon-restart path reattaches.
- **Saved modal:** container workspaces that are unreachable-and-cold show
  an `unreachable` badge (instead of the false `deleted`); Resume/Recreate
  disabled with a hover hint while the daemon is down.
- **Create modal:** container kind disabled-with-hint while down; local kind
  fully works end-to-end. Empty fleet + daemon down = normal FirstRun with
  the banner above it.
- Recovery is purely poll-driven: the first successful listing restores real
  states, chips un-dim, banner drops. No retry button, no new timers (the
  5s poll already pings).

### 4. MCP / committee

- No tool-surface changes (contract tests untouched).
- `committee_pause`/`committee_unpause` on an unreachable target already
  throw ("no live container"); the error message gains a "Docker daemon
  unreachable" variant so a manager agent can distinguish outage from
  deletion.
- Mock mode unaffected (mock backend never fails ping), except a dev-only
  toggle for e2e (below).

## Non-goals

- Full docker-optional product (first-run pitch, create-flow defaults, and
  image UI stay Docker-first).
- Persisting last-known state across app restarts (rejected: after a reboot
  the persisted state is a guess — containers auto-restart or don't; cold
  Saved placement is honest).
- Remote daemons, daemon auto-start, or retry/backoff machinery.

## Testing

- **Unit (`ipc` merge logic, extracted or via injected backends):** daemon
  down → container manifests become `unreachable` with correct
  `lastKnownState`; `deleted` stays `deleted`; local workspaces unaffected;
  non-connect docker errors rethrow; recovery restores real states and
  refreshes the map; app-start-while-down (empty map) → no `lastKnownState`.
- **Unit (`isDaemonConnectError`):** connect-error codes match, others don't.
- **E2e (mock, CI):** with a forced `ping=false` (dev-only mock toggle), the
  banner renders, a warm chip renders dimmed with `unreachable`, the create
  modal's local path works, and the container option is disabled. Existing
  smoke tests keep passing with the gate removed.

## SPEC.md (same-commit rule)

- §5: strip warm-fleet rule (unreachable-warm chips), banner, Saved badge,
  create-modal gating.
- §8: startup flow step 3 rewritten (full-screen gate → banner; app is
  usable for local workspaces with the daemon down).
- §11 / data model: `WorkspaceState` union + `lastKnownState`, the
  in-memory last-known-state map and its lifetime, the
  daemon-connect-error-only rule.
