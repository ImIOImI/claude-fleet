# Session-Row Kebab Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three hover action buttons (↻ resume / ✎ rename / 🗑 delete) on each left-rail session row with a single hover-revealed `⋮` trigger opening a portaled dropdown menu, reclaiming ~35px of title width per row.

**Architecture:** `SessionsPane.tsx` gets the same portaled-menu pattern already used by the session-tab `⋮` menu in `TerminalPane.tsx` (state = `{ id, top, left }` in viewport coords, `createPortal` to `document.body`, close on outside click / Escape / scroll / resize). The menu items dispatch into the *existing* flows: `onResume(s)`, inline rename (`setEditingId`), and the inline two-click delete confirm (`setConfirmDeleteId`). No IPC, main-process, or data-model changes.

**Tech Stack:** React 18 (`createPortal`), plain CSS in `src/renderer/src/styles.css` (`.ws-chip-menu` classes reused as-is).

**Spec:** `docs/superpowers/specs/2026-08-06-session-row-kebab-menu-design.md`

## Global Constraints

- Repo: work in the worktree at `/workspace/claude-fleet/.claude/worktrees/session-row-kebab` (branch `worktree-session-row-kebab`). Never `cd` to `/workspace/claude-fleet` (that's the main checkout on a different branch).
- `docs/SPEC.md` must be updated **in the same commit** as the implementation (`.claude/rules/spec-maintenance.md` — this changes a user-facing flow).
- No new unit test file: the change is presentational menu wiring, matching the untested chip/tab menus; list logic stays in `sessionsView.ts` (already tested). `tests/sessions-list.spec.ts` drives rename/delete via the preload API and is unaffected. Gate = typecheck + full unit suite + build.
- Menu markup/classes must match the existing `.ws-chip-menu` idiom (`role="menu"`, `role="menuitem"`, `className="danger"` for destructive items, `.ws-chip-menu-divider` before the destructive item).

---

### Task 1: Kebab trigger + portaled row menu

**Files:**
- Modify: `src/renderer/src/components/SessionsPane.tsx` (imports ~line 15; new icons after `formatUsd` ~line 70; new state/effect/helper inside the component ~line 90; replace the three-button block ~lines 262–292; portal render just before the closing fragment ~line 395)
- Modify: `src/renderer/src/styles.css` (after `.session-row-action:hover`, ~line 595 area — search for `.session-row-actions`)
- Modify: `docs/SPEC.md` §8 *Browse & resume a past session* — the "Hover reveals row actions" passage (~lines 830–833)

**Interfaces:**
- Consumes: existing `onResume(item: SessionListItem)` prop, existing `setEditingId` / `setDraftName` / `setConfirmDeleteId` state setters, existing `displayTitle(s)` helper, `openSessions?: Map<string, OpenTabRef>` prop.
- Produces: nothing consumed by later tasks (single-task plan).

- [ ] **Step 1: Add the `createPortal` import**

In `SessionsPane.tsx`, extend the imports:

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
```

- [ ] **Step 2: Add module-local menu icons**

Directly after the `formatUsd` function (module scope, before `export function SessionsPane`):

```tsx
// Row-menu icons — 12×12 viewBox, same visual set as the session-tab ⋮ menu
// (TerminalPane). Resume reuses the circular-arrow, rename the pencil.
function IconResume(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 6 A4 4 0 1 1 8.6 3" />
      <path d="M10.4 1.6 L10.4 4 L8 4" />
    </svg>
  );
}
function IconRename(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M2 9 L9 2 L11 4 L4 11 L2 11 Z" />
    </svg>
  );
}
function IconDelete(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="M2 3.5 H10" />
      <path d="M4.5 3.5 V2.5 H7.5 V3.5" />
      <path d="M3 3.5 L3.7 10.5 H8.3 L9 3.5" />
    </svg>
  );
}
```

- [ ] **Step 3: Add menu state, close-on-disturbance effect, and position helper**

Inside `SessionsPane`, after the `const [tagMenu, setTagMenu] = useState(false);` line:

```tsx
  // ── Row ⋮ menu: resume / rename / delete ──────────────────────────────────
  // Single open menu at a time; viewport coords for the portaled dropdown.
  // Same pattern as the session-tab menu (TerminalPane) and workspace chips.
  const [rowMenu, setRowMenu] = useState<{ id: string; top: number; left: number } | null>(null);

  // Close the menu on any outside click / Escape / layout shift (the portal is
  // positioned in viewport coords, so we can't follow the trigger when it moves).
  useEffect(() => {
    if (!rowMenu) return;
    const close = (): void => setRowMenu(null);
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRowMenu(null);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [rowMenu]);

  function openRowMenu(trigger: HTMLElement, id: string): void {
    const r = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 188));
    setRowMenu({ id, top: r.bottom + 4, left });
  }
```

- [ ] **Step 4: Replace the three buttons with the single trigger**

In `renderRow`, replace the entire `!editing && (<div className="session-row-actions"> … </div>)` block (the three `session-row-action` buttons `↻` `✎` `🗑`) with:

```tsx
          !editing && (
            <div className="session-row-actions">
              <button
                className="session-row-action"
                title="Session actions"
                aria-label="Session actions"
                aria-haspopup="menu"
                aria-expanded={rowMenu?.id === s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (rowMenu?.id === s.id) setRowMenu(null);
                  else openRowMenu(e.currentTarget, s.id);
                }}
              >
                ⋮
              </button>
            </div>
          )
```

- [ ] **Step 5: Render the portaled menu**

In the `body` JSX, immediately after the closing `</div>` of `.pane-body.sessions-body` (before the closing `</>`):

```tsx
      {rowMenu &&
        (() => {
          const s = items.find((x) => x.id === rowMenu.id);
          if (!s) return null;
          const isOpen = openSessions?.has(s.id) ?? false;
          return createPortal(
            <div
              className="ws-chip-menu"
              role="menu"
              style={{ position: 'fixed', top: rowMenu.top, left: rowMenu.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                role="menuitem"
                title={isOpen ? 'Jump to the open terminal tab' : 'Resume this session'}
                onClick={() => {
                  setRowMenu(null);
                  onResume(s);
                }}
              >
                <IconResume />
                <span>{isOpen ? 'Go to tab' : 'Resume'}</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setRowMenu(null);
                  setDraftName(s.userSetName ?? displayTitle(s));
                  setEditingId(s.id);
                }}
              >
                <IconRename />
                <span>Rename</span>
              </button>
              <div className="ws-chip-menu-divider" />
              <button
                role="menuitem"
                className="danger"
                title="Delete session + transcript"
                onClick={() => {
                  setRowMenu(null);
                  setConfirmDeleteId(s.id);
                }}
              >
                <IconDelete />
                <span>Delete</span>
              </button>
            </div>,
            document.body
          );
        })()}
```

Note: look up in `items` (not `filtered`) so the menu survives a mid-open list re-slice; the FLIP/scroll close listeners handle stale anchors.

- [ ] **Step 6: Keep the trigger visible while its menu is open**

In `styles.css`, after the `.session-row-action:hover` rule, add:

```css
/* The menu is portaled, so hovering it un-hovers the row — keep the open
   trigger visible instead of fading it under its own menu. */
.session-row-actions:has(> [aria-expanded='true']) { opacity: 1; }
```

- [ ] **Step 7: Typecheck + unit suite + build**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: typecheck clean; `Test Files 76 passed (76), Tests 483 passed (483)`; build completes (main + preload + renderer bundles).

- [ ] **Step 8: Update `docs/SPEC.md` §8**

Replace the passage (currently ~lines 830–833) from `Hover reveals row actions:` through the `**Delete (🗑)**` bullet with:

```markdown
Hover (or focus) reveals a single **`⋮` trigger** per row, which opens a portaled `.ws-chip-menu` dropdown (viewport-coordinate anchor, closes on outside click / Escape / scroll / resize — the same pattern as the workspace-chip and session-tab menus; the three former per-row buttons ↻/✎/🗑 reserved ~55px of invisible flex width per row and squeezed titles). Menu items:
- **Resume** (labelled **Go to tab** for an open session): for a session that is **not** currently open — App calls `sessions:resume(workspaceId)` to bring the container up, selects that workspace, and hands the matching `TerminalPane` a resume request. The pane opens a new tab whose `SessionEntry.resumeOf` is the Claude session UUID; that tab's first attach runs `claude --resume <uuid>` in the container (see §6 *PTY*). If the container can't be brought up, App logs a non-fatal warning and does nothing.
- **Rename**: inline edit → `sessions:rename`; empty clears the override.
- **Delete**: a two-click inline confirm → `sessions:delete` (drops cache rows + unlinks the transcript). No modal — the action is row-local and the confirm is reversible up to the second click.
```

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/SessionsPane.tsx src/renderer/src/styles.css docs/SPEC.md
git commit -m "feat: collapse session-row actions into a portaled ⋮ menu

The three hover buttons (resume/rename/delete) sat invisible at
opacity 0 but still reserved ~55px of flex width in every left-rail
session row, truncating titles early. Replace them with a single
hover-revealed ⋮ trigger opening the same portaled ws-chip-menu
dropdown the session tabs and workspace chips use. Resume/rename/
delete semantics are unchanged (inline edit + two-click confirm).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Interactive verification (mock mode)**

Run: `CLAUDE_FLEET_MOCK=1 npm run dev` (WSLg display available), then in the left rail:
- Titles render wider than before (no dead right gutter at rest).
- Hovering a row reveals only `⋮`; clicking opens the menu; trigger stays visible while open.
- Resume/Go-to-tab label matches open state; Rename enters the inline input; Delete shows the inline `Delete? Cancel/Delete` confirm.
- Menu closes on outside click, Escape, and list scroll; a bottom-of-list row's menu is not clipped.
