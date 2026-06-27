# Design: per-session Refresh menu action

## Summary

Add a **Refresh** item to each session chip's `⋮` (hamburger) menu. Refresh exits the
session and immediately resumes the same Claude conversation (`claude --resume <uuid>`)
as soon as that session's terminal is not busy. It reuses the toast component already
used for loadout installs.

Mechanically this is the loadout-reload feature (#16) generalized: that feature already
defers-until-idle and then closes + re-attaches with `--resume`. Today it can only act on
the *active* session and only one at a time. This change promotes that machinery into a
per-session, queued refresh that the menu feeds — and the loadout path becomes just one
more producer of the same queue.

## Decisions (locked during brainstorming)

- **Target:** Refresh acts on the **specific chip's session**, even if it's a background
  (non-focused) tab — not only the active session.
- **Busy feedback:** **toast immediately, queued.** Clicking Refresh shows the toast at
  once; the actual exit+resume fires when the session goes idle.
- **Visual direction:** **Option A — native & minimal.** A plain "Refresh" item styled
  identically to the other menu items (gray circular-arrow icon, same weight), placed in
  the top group directly under **Rename**. No special color or grouping. The resulting
  toast is the standard `progress` toast; only its copy reflects queued state.

## Visual spec (Option A)

- **Menu order:** `Rename` · `Refresh` · `Auto rename ✓` · divider · `Close` (danger).
- **Icon:** a new `IconRefresh()` — a circular arrow in a 12×12 viewBox, `stroke="currentColor"`,
  `stroke-width="1.2"`, matching the existing icon set. Renders in `--ink-2` like the
  other item icons (brightens to `--ink` on hover, via the existing `.ws-chip-menu button:hover svg` rule).
- **Disabled state:** when the session is already **ended** (`endedIds.has(s.id)`), the
  Refresh item is disabled — there is no live conversation to resume in place; the ended
  overlay's "Start new session" covers that path.
- **Toast (reused component, `kind: 'progress'`, eyebrow `Refreshing`):**
  - session idle at click time → `Refreshing <name>…`
  - session busy at click time → `Refreshing <name> when idle…`
  - Default 4s TTL, same as the loadout toast. The toast is an acknowledgement; it is not
    kept alive for the whole wait.

The mockup of this direction is saved at `/workspace/refresh-mockups.png` (Option A, left).

## Components & data flow

### 1. `TerminalPane` — generalize the reload queue

Replace the single-shot, active-only reload state with a per-session queue:

- `pendingRefresh: Set<string>` — session ids asked to refresh, waiting for idle.
  **Replaces** today's `pendingReload: boolean`.
- `reloadTargets: Record<string, number>` — `sessionId → token`. **Replaces** today's
  single `reloadTarget: { sessionId, token } | null`.

Producers add to the queue:
- **Loadout reload** (`reloadRequest` effect): adds `activeId` to `pendingRefresh`
  (unchanged behavior — the loadout always reloads the active tab).
- **Menu Refresh** (`requestRefresh(s)`, new): adds `s.id` to `pendingRefresh` and calls a
  new `onRefreshRequested?(sessionName, busyNow)` prop so `App` can show the toast
  immediately. `busyNow = busyIds.has(s.id)` selects the toast copy.

Consumer (the busy-gating effect, generalized from today's single-boolean version):
for every id in `pendingRefresh` that is **not** in `busyIds`, still exists, and is not
ended → bump `reloadTargets[id] = ++token` and remove the id from `pendingRefresh`. This
fires the exit+resume "as soon as the terminal is not busy."

Using a map (rather than the single object) means a loadout reload of tab A and a manual
refresh of busy tab B can be queued at once and fire independently when each goes idle,
with no clobbering — which the current single `reloadTarget` cannot guarantee.

### 2. `TerminalSession` — simplify the trigger prop

Replace the `reloadTarget={ sessionId, token }` prop (which each session self-filters by
`sessionId`) with a per-session `reloadToken: number | null`, passed from the pane as
`reloadTargets[s.id] ?? null`. The existing exit+resume effect fires when *its own* token
changes; the `sessionId` filter is removed. The effect body is unchanged: resolve the
Claude session uuid via `observability.summaryForBrokerSession`, set `resumeOverrideRef`,
`pty.closeSession(handle)`, then bump the local session epoch so the attach effect
re-CREATEs the broker session with `--resume <uuid>`. No-ops safely when no uuid resolves
(Claude never started in the tab).

### 3. Menu item + icon (`TerminalPane`)

- Add `IconRefresh()` alongside `IconRename` / `IconAuto` / `IconClose`.
- Add a `role="menuitem"` button for Refresh in the portaled `.ws-chip-menu`, under Rename.
  `onClick` → `setTabMenu(null)` then `requestRefresh(s)`. Apply `disabled` /
  `aria-disabled` when `endedIds.has(s.id)`.

### 4. Toast wiring (`App`)

- New `onRefreshRequested?(sessionName: string, busyNow: boolean)` prop on `TerminalPane`,
  forwarded from `App` to the existing `pushToast`:
  `pushToast(busyNow ? \`Refreshing \${name} when idle…\` : \`Refreshing \${name}…\`, 'Refreshing')`.
  Same toast component/kind as the loadout reload toast.

## Edge cases

- **No Claude session to resume:** existing reload effect already no-ops when it can't
  resolve a uuid; Refresh inherits that.
- **Simultaneous refreshes** (loadout reload of A + manual refresh of busy B): per-session
  `reloadTargets` map keys independently — both fire when each goes idle.
- **Background (non-visible) tab:** exit/resume doesn't require focus; works unchanged.
- **Ended session:** Refresh disabled (nothing to resume in place).
- **Refresh of the active session while idle:** fires immediately — same path as a loadout
  reload that lands on an idle tab.

## Testing

Add coverage to `tests/smoke.spec.ts`:
- Clicking Refresh on an **idle** session triggers `pty.closeSession` followed by a
  re-attach carrying `--resume`.
- Clicking Refresh on a **busy** session **defers** — no close until the activity detector
  flips the session to idle, then it fires.
- The toast appears immediately on click (queued copy when busy).

## Docs

- Update `docs/SPEC.md` (the loadout-reload / session-lifecycle sections) to describe the
  generalized per-session refresh queue and the manual Refresh menu action, per
  `.claude/rules/spec-maintenance.md`. New IPC is not introduced — this rides existing
  channels (`pty.closeSession`, `pty.attach … --resume`, `observability.summaryForBrokerSession`).
- **No change to the cross-repo loadout-format contract**, so `claude-fleet-loadouts` is
  untouched.

## Out of scope

- Refreshing a whole workspace (all tabs) at once.
- A keyboard shortcut for Refresh.
- Persisting/keeping the toast alive for the full duration of a long busy wait.
