# Per-session Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Refresh" item to each session chip's `⋮` menu that exits and resumes that session (`claude --resume`) as soon as its terminal is idle, surfaced via the existing toast.

**Architecture:** Generalize the loadout-reload (#16) machinery. Today `TerminalPane` holds a single `reloadTarget` and a `pendingReload` boolean that only ever reloads the *active* session. Replace those with a per-session map `reloadTargets: Record<sessionId, token>` (consumed by each `TerminalSession` via a per-session `reloadToken` prop) and add a `pendingRefresh: Set<sessionId>` queue drained by a pure helper once a session is idle. The loadout path keeps its exact behavior (targets the active session, fires its own toast); the menu Refresh is a second producer that shows its toast at click time.

**Tech Stack:** Electron + React (renderer), TypeScript, Vitest (unit, pure-Node), Playwright + Electron (e2e, runs in CI under xvfb).

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-06-27-session-refresh-design.md`. Visual direction is **Option A (native & minimal)**.
- Decision-bearing changes MUST update `docs/SPEC.md` in the same change (`.claude/rules/spec-maintenance.md`).
- No new IPC channels — reuse `pty.closeSession`, `pty.attach(... resumeTarget)`, `observability.summaryForBrokerSession`.
- Toast copy: idle → `Refreshing <name>…`; busy → `Refreshing <name> when idle…`; eyebrow `Refreshing`; `kind: 'progress'`; default 4000ms TTL.
- Menu order (Option A): `Rename` · `Refresh` · `Auto rename` · divider · `Close`.
- Refresh is disabled when the session is ended (`endedIds.has(id)`).
- Commands: typecheck `npm run typecheck`; unit `npm run test:unit`; build `npm run build`; e2e (CI/local-with-display) `npm run test:e2e`. Electron cannot launch in the dev container (missing system libs) — e2e is verified by CI's `e2e (playwright)` job on the PR. Unit + typecheck + build are verified locally.

---

### Task 1: Pure refresh-queue helper + unit test

A pure function that decides which pending session ids may fire a refresh now. Pulling the rule out of the React effect makes the busy-defer logic deterministically unit-testable in vitest (no Electron).

**Files:**
- Create: `src/renderer/src/components/refreshQueue.ts`
- Test: `src/renderer/src/components/refreshQueue.test.ts`

**Interfaces:**
- Produces: `readyToRefresh(pending: Set<string>, busy: Set<string>, ended: Set<string>, existing: Set<string>): string[]` — the ids in `pending` that are not busy, not ended, and still exist. Order follows `pending` iteration order.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/components/refreshQueue.test.ts
import { describe, it, expect } from 'vitest';
import { readyToRefresh } from './refreshQueue';

const S = (...ids: string[]): Set<string> => new Set(ids);

describe('readyToRefresh', () => {
  it('returns idle, existing, non-ended pending ids', () => {
    expect(readyToRefresh(S('a', 'b'), S(), S(), S('a', 'b'))).toEqual(['a', 'b']);
  });
  it('defers ids whose session is busy', () => {
    expect(readyToRefresh(S('a', 'b'), S('a'), S(), S('a', 'b'))).toEqual(['b']);
  });
  it('skips ended sessions', () => {
    expect(readyToRefresh(S('a'), S(), S('a'), S('a'))).toEqual([]);
  });
  it('skips ids that no longer exist (tab closed while pending)', () => {
    expect(readyToRefresh(S('a'), S(), S(), S('b'))).toEqual([]);
  });
  it('returns empty for an empty queue', () => {
    expect(readyToRefresh(S(), S(), S(), S('a'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/refreshQueue.test.ts`
Expected: FAIL — cannot resolve `./refreshQueue`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/renderer/src/components/refreshQueue.ts

/**
 * Which pending-refresh session ids may fire right now: those that are not
 * busy (interrupting a working claude is destructive), not ended (nothing to
 * resume in place), and still present in the tab list (not closed mid-wait).
 * Pure so the busy-defer rule is unit-testable without Electron.
 */
export function readyToRefresh(
  pending: Set<string>,
  busy: Set<string>,
  ended: Set<string>,
  existing: Set<string>
): string[] {
  return [...pending].filter((id) => !busy.has(id) && !ended.has(id) && existing.has(id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/refreshQueue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/refreshQueue.ts src/renderer/src/components/refreshQueue.test.ts
git commit -m "feat: add pure refresh-queue readiness helper"
```

---

### Task 2: Generalize reload plumbing (single target → per-session map)

Pure refactor, no behavior change: replace the single `reloadTarget` object with a `reloadTargets` map and swap `TerminalSession`'s self-filtering `reloadTarget` prop for a per-session `reloadToken`. The loadout reload keeps targeting the active session and firing its toast. Verified by typecheck/build (the existing e2e has no reload-specific spec).

**Files:**
- Modify: `src/renderer/src/components/TerminalSession.tsx` (props ~100-167, reload effect ~535-565)
- Modify: `src/renderer/src/components/TerminalPane.tsx` (reload state ~458-477, TerminalSession render ~792)

**Interfaces:**
- Produces (TerminalSession prop): `reloadToken?: number | null` — when this number changes to a new non-null value, the session exits and re-attaches with `--resume`.
- Produces (TerminalPane state): `reloadTargets: Record<string, number>` — sessionId → monotonic token.

- [ ] **Step 1: Swap the TerminalSession prop type and destructure**

In `src/renderer/src/components/TerminalSession.tsx`, replace the `reloadTarget` prop doc+type (lines ~146-153) with:

```ts
  /**
   * Reload/refresh trigger. Each time this number changes to a new non-null
   * value, the session terminates its broker session (kills claude) and
   * re-attaches the same id with `claude --resume <uuid>`, resuming the
   * conversation in place. Fed per-session by TerminalPane's reloadTargets
   * map; the parent only advances it while the session is idle. Used by both
   * the loadout reload (#16) and the manual chip-menu Refresh.
   */
  reloadToken?: number | null;
```

Then change the destructure (line ~166) from `reloadTarget,` to `reloadToken,`.

- [ ] **Step 2: Rewrite the reload effect to key on the token**

In `src/renderer/src/components/TerminalSession.tsx`, replace the effect head + deps (lines ~535-538 and ~565). The guard becomes token-based and the `sessionId` filter is dropped (the parent already addresses this session by map key):

```ts
  useEffect(() => {
    if (reloadToken == null) return;
    if (reloadToken === lastReloadTokenRef.current) return;
    lastReloadTokenRef.current = reloadToken;
```

and the dependency array at the end of that effect becomes:

```ts
  }, [reloadToken, sessionId, workspaceId]);
```

Leave the effect body (resolve uuid via `observability.summaryForBrokerSession`, set `resumeOverrideRef`, `pty.closeSession`, bump `sessionEpoch`) unchanged.

- [ ] **Step 3: Replace reloadTarget state with reloadTargets map in TerminalPane**

In `src/renderer/src/components/TerminalPane.tsx`, replace the state declaration (lines ~459-461):

```ts
  const [reloadTargets, setReloadTargets] = useState<Record<string, number>>({});
```

Update the loadout gating effect (lines ~471-477) to write into the map while still targeting the active session:

```ts
  useEffect(() => {
    if (!pendingReload || !activeId) return;
    if (busyIds.has(activeId)) return; // claude is working — defer until idle
    setPendingReload(false);
    setReloadTargets((prev) => ({ ...prev, [activeId]: ++reloadTokenRef.current }));
    onReloadStarted?.();
  }, [pendingReload, activeId, busyIds, onReloadStarted]);
```

- [ ] **Step 4: Pass the per-session token to TerminalSession**

In `src/renderer/src/components/TerminalPane.tsx`, change the render prop (line ~792) from `reloadTarget={reloadTarget}` to:

```tsx
            reloadToken={reloadTargets[s.id] ?? null}
```

- [ ] **Step 5: Verify typecheck + build + unit pass**

Run: `npm run typecheck && npm run build && npm run test:unit`
Expected: all PASS, no type errors. (Confirms the prop rename is wired on both sides.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/TerminalSession.tsx src/renderer/src/components/TerminalPane.tsx
git commit -m "refactor: per-session reload tokens (reloadTargets map)"
```

---

### Task 3: Manual refresh queue + toast wiring

Add the `pendingRefresh` queue, the `requestRefresh` action, the idle-gated drain (via the Task 1 helper), and the App-level toast.

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx` (props block ~93-109 / destructure ~186-189; reload state region ~458; add effect + function)
- Modify: `src/renderer/src/App.tsx` (toast handlers ~323-328; TerminalPane render ~888-927)

**Interfaces:**
- Consumes: `readyToRefresh(...)` from Task 1; `reloadTargets`/`setReloadTargets`, `reloadTokenRef`, `busyIds`, `endedIds`, `sessions`, `loaded` from Task 2.
- Produces (TerminalPane prop): `onRefreshRequested?: (sessionName: string, busyNow: boolean) => void`.
- Produces (TerminalPane internal): `requestRefresh(s: Session): void`.

- [ ] **Step 1: Import the helper and add the prop**

In `src/renderer/src/components/TerminalPane.tsx`, add the import near the top (with the other local imports):

```ts
import { readyToRefresh } from './refreshQueue';
```

Add to the props interface (after `onReloadStarted?: () => void;`, ~line 109):

```ts
  /**
   * Fired when the user picks Refresh on a session chip. The parent shows the
   * shared toast; `busyNow` selects the copy ("…when idle" while claude works).
   */
  onRefreshRequested?: (sessionName: string, busyNow: boolean) => void;
```

Add `onRefreshRequested` to the destructured props (after `onReloadStarted`, ~line 189):

```ts
  onReloadStarted,
  onRefreshRequested
```

- [ ] **Step 2: Add the pendingRefresh state, drain effect, and requestRefresh**

In `src/renderer/src/components/TerminalPane.tsx`, immediately after the loadout gating effect (after line ~477), add:

```ts
  // Manual chip-menu Refresh (#NN): a per-session queue. requestRefresh enqueues
  // a session id and shows the toast at click time; this effect drains the queue
  // into reloadTargets once each session is idle (readyToRefresh enforces the
  // not-busy / not-ended / still-exists rule). Shares reloadTargets with the
  // loadout reload, so a loadout reload of one tab and a manual refresh of
  // another fire independently when each goes idle.
  const [pendingRefresh, setPendingRefresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (pendingRefresh.size === 0) return;
    const existing = new Set(sessions.map((s) => s.id));
    const ready = readyToRefresh(pendingRefresh, busyIds, endedIds, existing);
    if (ready.length === 0) return;
    setPendingRefresh((prev) => {
      const next = new Set(prev);
      ready.forEach((id) => next.delete(id));
      return next;
    });
    setReloadTargets((prev) => {
      const next = { ...prev };
      ready.forEach((id) => {
        next[id] = ++reloadTokenRef.current;
      });
      return next;
    });
  }, [pendingRefresh, busyIds, endedIds, sessions]);

  function requestRefresh(s: Session): void {
    if (!loaded || endedIds.has(s.id)) return;
    setPendingRefresh((prev) => {
      if (prev.has(s.id)) return prev;
      const next = new Set(prev);
      next.add(s.id);
      return next;
    });
    onRefreshRequested?.(s.name, busyIds.has(s.id));
  }
```

- [ ] **Step 3: Add the App toast handler**

In `src/renderer/src/App.tsx`, after `handleReloadStarted` (line ~328), add:

```ts
  const handleRefreshRequested = useCallback(
    (name: string, busyNow: boolean): void => {
      pushToast(
        busyNow ? `Refreshing ${name} when idle…` : `Refreshing ${name}…`,
        'Refreshing'
      );
    },
    [pushToast]
  );
```

- [ ] **Step 4: Wire the prop on the TerminalPane render**

In `src/renderer/src/App.tsx`, add to the `<TerminalPane …>` props (after `onReloadStarted={…}`, ~line 927):

```tsx
                  onRefreshRequested={handleRefreshRequested}
```

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS. (No UI yet to click; the menu item lands in Task 4.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/TerminalPane.tsx src/renderer/src/App.tsx
git commit -m "feat: per-session refresh queue + toast wiring"
```

---

### Task 4: Refresh menu item + icon (Option A)

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx` (icons ~145-168; menu JSX ~706-715)
- Modify: `src/renderer/src/styles.css` (`.ws-chip-menu` block ~1845)

- [ ] **Step 1: Add the IconRefresh component**

In `src/renderer/src/components/TerminalPane.tsx`, after `IconClose()` (line ~168), add:

```tsx
function IconRefresh(): JSX.Element {
  // Circular arrow — exit & resume this session in place.
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 6 A4 4 0 1 1 8.6 3" />
      <path d="M10.4 1.6 L10.4 4 L8 4" />
    </svg>
  );
}
```

- [ ] **Step 2: Add the Refresh menu item under Rename**

In `src/renderer/src/components/TerminalPane.tsx`, inside the portaled `.ws-chip-menu`, between the Rename button (ends ~line 715) and the Auto rename button (starts ~line 716), insert:

```tsx
              <button
                role="menuitem"
                disabled={endedIds.has(s.id)}
                aria-disabled={endedIds.has(s.id)}
                title="Exit and resume this session (waits until it's idle)"
                onClick={() => {
                  setTabMenu(null);
                  requestRefresh(s);
                }}
              >
                <IconRefresh />
                <span>Refresh</span>
              </button>
```

- [ ] **Step 3: Add disabled styling for menu buttons**

In `src/renderer/src/styles.css`, after the `.ws-chip-menu button:hover svg` rule (line ~1865), add:

```css
.ws-chip-menu button:disabled { opacity: 0.4; cursor: default; }
.ws-chip-menu button:disabled:hover { background: transparent; color: var(--ink-1); }
```

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TerminalPane.tsx src/renderer/src/styles.css
git commit -m "feat: Refresh item in the session chip menu"
```

---

### Task 5: End-to-end acceptance test

Drives the real app in mock mode: open the menu, click Refresh, assert the toast appears and the session does not get stuck in an ended state; assert Refresh is disabled on an ended session. (In mock mode there is no resolvable claude uuid, so the underlying reload no-ops gracefully — these assertions verify the user-facing wiring; the busy-defer rule is covered by Task 1's unit test.) Runs in CI's `e2e (playwright)` job.

**Files:**
- Modify: `tests/multi-session.spec.ts` (append two tests, mirroring the existing menu/overlay tests)

- [ ] **Step 1: Append the acceptance tests**

At the end of `tests/multi-session.spec.ts` (before the final newline), add:

```ts
test('Session tab menu: Refresh shows the toast and keeps the session live', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const pane = activePane(window);
    const tab = pane.locator('.session-tab-strip .session-tab').nth(0);
    await expect(tab).toContainText('main');
    const term = pane.locator('.terminal-host');
    await expect(term).toBeVisible();

    // ⋮ → Refresh
    await tab.getByRole('button', { name: 'Actions for main' }).click();
    const refresh = window.getByRole('menuitem', { name: 'Refresh' });
    await expect(refresh).toBeVisible();
    await refresh.click();

    // Idle session → toast without the "when idle" suffix.
    await expect(window.locator('.toast', { hasText: 'Refreshing main' })).toBeVisible();

    // Session stays usable — no stuck "ended" overlay or ended dot.
    await expect(term).toBeVisible();
    await expect(pane.locator('.session-ended-overlay')).toHaveCount(0);
    await expect(tab.locator('.session-tab-dot.ended')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Session tab menu: Refresh is disabled for an ended session', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const pane = activePane(window);
    const tab = pane.locator('.session-tab-strip .session-tab').nth(0);
    const term = pane.locator('.terminal-host');
    await expect(term).toBeVisible();

    // End the session via the mock shell.
    await term.click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');
    await expect(pane.locator('.session-ended-overlay')).toBeVisible();

    // Refresh is present but disabled — nothing to resume in place.
    await tab.getByRole('button', { name: 'Actions for main' }).click();
    await expect(window.getByRole('menuitem', { name: 'Refresh' })).toBeDisabled();
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Sanity-check the spec compiles (typecheck the web/test config)**

Run: `npm run typecheck`
Expected: PASS. (Electron can't launch in this container, so the e2e itself runs in CI — see Step 4.)

- [ ] **Step 3: Commit**

```bash
git add tests/multi-session.spec.ts
git commit -m "test: e2e for the session-chip Refresh action"
```

- [ ] **Step 4: Verify in CI**

The PR triggers `.github/workflows/build-app.yml`. The `e2e (playwright)` job runs `xvfb-run -a npm run test:e2e`. Confirm that job passes (both new tests green) before merging.

---

### Task 6: Spec + docs

**Files:**
- Modify: `docs/SPEC.md` (loadout-reload / session-lifecycle section)
- Modify: `docs/superpowers/specs/2026-06-27-session-refresh-design.md` (fix stale test-file reference)

- [ ] **Step 1: Update docs/SPEC.md**

Find the section describing the loadout reload (#16) / session lifecycle. Describe the generalized mechanism: `TerminalPane` holds `reloadTargets: Record<sessionId, token>`; each `TerminalSession` consumes its own `reloadToken` and, when it advances, exits and re-attaches with `claude --resume <uuid>`. Two producers feed it: the loadout reload (targets the active session, deferred until idle) and the manual chip-menu **Refresh** (targets the specific chip's session via the `pendingRefresh` queue, deferred until idle, disabled when the session is ended). The Refresh toast uses the shared toast component (`Refreshing <name>…`, or `… when idle` while busy). No new IPC channels. Edit in place, no changelog prose.

- [ ] **Step 2: Fix the design-doc test reference**

In `docs/superpowers/specs/2026-06-27-session-refresh-design.md`, the Testing section references `tests/smoke.spec.ts`; the suite has no such file. Replace that reference with `tests/multi-session.spec.ts`, and note the busy-defer rule is unit-tested via `src/renderer/src/components/refreshQueue.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-06-27-session-refresh-design.md
git commit -m "docs: spec the per-session refresh action"
```

---

## Self-Review

**Spec coverage:** menu item (Task 4) · per-chip target (Task 3 `requestRefresh(s.id)`) · toast-immediately-queued (Task 3 toast at click, Task 1 defer rule) · Option A visuals (Task 4) · disabled-when-ended (Tasks 3+4) · simultaneous refreshes (Task 2 map) · no new IPC (reuses existing) · SPEC update (Task 6). All covered.

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `reloadToken?: number | null` (Task 2) matches `reloadTargets[s.id] ?? null` (Task 2). `onRefreshRequested(name, busyNow)` defined (Task 3 props) matches `handleRefreshRequested(name, busyNow)` (Task 3 App) and the call `onRefreshRequested?.(s.name, busyIds.has(s.id))`. `readyToRefresh` signature (Task 1) matches the call site (Task 3).
