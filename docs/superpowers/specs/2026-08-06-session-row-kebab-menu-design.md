# Session-row kebab menu — design

**Date:** 2026-08-06
**Repo:** claude-fleet
**Files:** `src/renderer/src/components/SessionsPane.tsx`, `src/renderer/src/styles.css`, `docs/SPEC.md`

## Problem

Each left-rail session row renders three hover actions — Resume `↻`, Rename `✎`, Delete `🗑` (`SessionsPane.tsx` `.session-row-actions`). They are `opacity: 0` until hover, but they stay in the flex layout, so every row permanently reserves ~55px of width for invisible buttons. Titles truncate ~55px earlier than the 280px rail requires (visible in the app: "Improve settings icon an…" with dead space to its right). The `↻` button is also redundant — clicking the row title already resumes/activates.

## Decision

Replace the three per-row buttons with a single hover-revealed kebab trigger (`⋮`) that opens a dropdown menu with **Resume / Rename / Delete**. This matches the existing kebab idiom (loadout cards' `.lc-menu-trigger`, session tabs' and workspace chips' `⋮` menus).

## Behavior

- The trigger uses the same reveal rule as today: hidden (`opacity: 0`) at rest, visible on `.session-row:hover` and `:focus-within`. Width cost drops from ~55px to ~20px per row.
- Clicking `⋮` opens the menu; clicking again closes it. One menu open at a time (state: the open row's session id + viewport anchor coords).
- Menu items:
  - **Resume** (labelled **Go to tab** when the session is open, mirroring the title tooltip) → `onResume(s)`, same as today's `↻`.
  - **Rename** → enters the existing inline-edit input (unchanged flow: Enter/blur commits via `sessions:rename`, Escape cancels).
  - **Delete** (danger style) → enters the existing inline two-click confirm (`Delete? Cancel/Delete` → `sessions:delete`). No modal, unchanged.
- Menu closes on item click, outside click, Escape, scroll, or resize.

## Implementation

Reuse the **portaled fixed-position menu pattern** from `WorkspaceTabStrip.tsx` (`menuPositionFor` + `MenuAnchor` + `createPortal` + close-on-outside-click/Escape/scroll/resize listeners), styled as `.ws-chip-menu`. Rationale: the sessions list scrolls; the simpler `.lc-menu` (`position: absolute; top: 100%`) would clip against the scroll container for rows near the bottom. The chip menu already solves this with viewport coordinates and close-on-scroll.

- New local state in `SessionsPane`: `menu: { for: sessionId, top, right } | null`.
- The three buttons in `renderRow` collapse to one `⋮` button (`aria-label="Session actions"`, `aria-expanded`); the portaled menu renders once at pane level for the `menu.for` row.
- CSS: keep `.session-row-actions` reveal rules; trigger reuses `.session-row-action` sizing. Menu reuses `.ws-chip-menu` classes as-is (no new menu CSS unless a size tweak is needed).
- FLIP row animation and busy/waiting dots are untouched.

## SPEC.md update (same commit as implementation)

§8 *Browse & resume a past session*, lines describing "Hover reveals row actions" (~830–833): change to describe the single `⋮` trigger opening a portaled menu (chip-menu pattern) with the same three actions; per-action semantics (resume request, inline rename, two-click inline delete confirm) are unchanged.

## Testing

- `tests/sessions-list.spec.ts` exercises rename/delete via the preload API, not the DOM buttons — unaffected.
- Pure list logic lives in `sessionsView.ts` (tested); the menu is presentational wiring, consistent with the untested chip/tab menus. No new unit test target; verify interactively (hover reveal, menu open/close paths, rename + delete flows, bottom-of-list row not clipped).
- Gate: `npm run test:unit` + `npm run build` + typecheck.

## Non-goals

- No change to the Sessions filter header (scope toggle / search / tags).
- No change to Library or Committee panes.
- No removal of Resume from the menu (title click covers it, but the explicit item keeps the action discoverable).
