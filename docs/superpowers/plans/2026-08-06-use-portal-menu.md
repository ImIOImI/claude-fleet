# usePortalMenu Extraction Implementation Plan (#264)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the thrice-duplicated portaled ⋮ menu mechanics (anchor state, close-listener effect, viewport clamp) into a shared `usePortalMenu()` hook and consolidate the duplicated menu SVG icons into one module, then migrate `WorkspaceTabStrip`, `TerminalPane`, and `SessionsPane`.

**Architecture:** Pure refactor — no behavior change, no IPC/data-model/SPEC changes (spec-maintenance rule classifies shape-preserving refactors as trivial). New `portalMenu.tsx` exports pure anchor math (`leftAnchor`/`rightAnchor`, unit-testable without DOM) and the `usePortalMenu` hook (state + close-on-outside-click/Escape/scroll/resize effect + `toggle`/`close`). New `menuIcons.tsx` exports the glyph components. One deliberate visual nit: the session-row Delete icon switches from the one-off stroke trash (added in #263) to the shared filled `IconTrash` used by the chip menu.

**Tech Stack:** React 18, vitest for the pure anchor math.

**Base:** stacked on `worktree-session-row-kebab` (PR #263); branch `feat/use-portal-menu`.

## Global Constraints

- Work in `/workspace/claude-fleet/.claude/worktrees/session-row-kebab`; never `cd` to the main checkout.
- Behavior parity: every menu must keep its exact anchor side, clamp values (188/8/4), open/close semantics, `aria-*` attributes, and item structure. `IconGear` stays in `WorkspaceTabStrip` (top-strip button, not a menu icon).
- Gate: `npm run typecheck && npm run test:unit && npm run build`.

---

### Task 1: `portalMenu.tsx` + unit tests (TDD)

**Files:**
- Create: `src/renderer/src/components/portalMenu.tsx`
- Create: `src/renderer/src/components/portalMenu.test.ts`

**Interfaces (produced):**
- `interface MenuAnchor { id: string; top: number; left?: number; right?: number }`
- `leftAnchor(rect: {left: number; right: number; bottom: number}, innerWidth: number): { top: number; left: number }` — `top = bottom + 4`, `left = max(8, min(rect.left, innerWidth - 188))`
- `rightAnchor(rect, innerWidth): { top: number; right: number }` — `top = bottom + 4`, `right = max(8, innerWidth - rect.right)`
- `usePortalMenu(): { menu: MenuAnchor | null; toggle(trigger: HTMLElement, id: string, side?: 'left' | 'right'): void; close(): void }` — `toggle` closes when `menu.id === id`, else opens anchored to the trigger (default `'left'`); the hook owns the close-on-outside-click/Escape/scroll(capture)/resize effect.

- [ ] **Step 1: Write failing tests** (`portalMenu.test.ts`): leftAnchor passes `rect.left` through when it fits; clamps to `innerWidth - 188` when the trigger sits too far right; floors at 8 on a viewport narrower than the menu; `top = bottom + 4`. rightAnchor mirrors from the right edge and floors at 8.
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/components/portalMenu.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `portalMenu.tsx` (constants `MENU_WIDTH=188`, `VIEWPORT_MARGIN=8`, `TRIGGER_GAP=4`; pure fns; hook with the exact close-listener effect currently copied in the three components).
- [ ] **Step 4: Run the test again** — expect PASS.
- [ ] **Step 5: Commit** `feat: add shared usePortalMenu hook + anchor math (#264)`.

### Task 2: `menuIcons.tsx`

**Files:**
- Create: `src/renderer/src/components/menuIcons.tsx`

**Interfaces (produced):** `IconPlay, IconPause, IconStop, IconEject, IconPencil, IconCopy, IconTrash, IconRefresh, IconAuto` — glyph-named; SVG bodies moved verbatim from `WorkspaceTabStrip.tsx` (Play/Pause/Stop/Eject/Edit→Pencil/Copy/Trash) and `TerminalPane.tsx` (Refresh, Auto).

- [ ] **Step 1: Create the module** with the nine components (12×12 viewBox, `currentColor`, `aria-hidden`), header comment noting they serve the shared `.ws-chip-menu` idiom.
- [ ] **Step 2: Commit** `feat: consolidate menu SVG icons into menuIcons.tsx (#264)`.

### Task 3: Migrate the three components

**Files:**
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx` (delete local icons except `IconGear`, `menuPositionFor`, `MenuAnchor`, menu state + effect; use `usePortalMenu` with `side: 'right'`; `menu.for` → `menu.id`)
- Modify: `src/renderer/src/components/TerminalPane.tsx` (delete `IconRename/IconAuto/IconClose/IconRefresh`, `tabMenu` state + effect + `openTabMenu`; use hook; `tabMenu` → `menu`)
- Modify: `src/renderer/src/components/SessionsPane.tsx` (delete `IconResume/IconRename/IconDelete`, `rowMenu` state + effect + `openRowMenu`; use hook; Delete item uses `IconTrash`)

- [ ] **Step 1: Migrate `SessionsPane.tsx`** (freshest copy, in this PR stack).
- [ ] **Step 2: Migrate `TerminalPane.tsx`**.
- [ ] **Step 3: Migrate `WorkspaceTabStrip.tsx`**.
- [ ] **Step 4: Gate** `npm run typecheck && npm run test:unit && npm run build` — expect clean / 483+new passing / build ok.
- [ ] **Step 5: Grep for leftovers** `grep -rn "menuPositionFor\|openTabMenu\|openRowMenu\|IconRename\|IconResume\|IconDelete\|IconEdit\|IconClose\b" src/renderer/src/components/*.tsx` — expect no hits outside `menuIcons.tsx`/`portalMenu.tsx`.
- [ ] **Step 6: Commit** `refactor: migrate chip/tab/row menus to usePortalMenu (#264)`.

### Task 4: PR

- [ ] **Step 1:** Push `feat/use-portal-menu`, open PR with base `worktree-session-row-kebab` (retargets to main when #263 merges), body links #264, notes the one visual nit (session-row Delete icon → filled trash).
