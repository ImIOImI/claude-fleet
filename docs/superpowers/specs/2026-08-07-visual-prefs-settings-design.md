# Visual preferences in Settings — design

**Date:** 2026-08-07
**Status:** approved direction (persistence decision made by Troy: config.json via IPC)

## Goal

Display preferences in the settings modal:

1. **Show plan-usage budget in the observability rail** — hides/shows the
   `UsageBudgetBar` at the top of the right rail.
2. **Show session cost in the sessions list** — hides/shows the per-session
   USD badge (`.session-row-cost`) in the left rail.
3. **Sessions-list filters** — two preset dropdowns limiting what the left
   rail lists: **max sessions shown** (All / 10 / 25 / 50 / 100) and **max
   session age** (All / 1 day / 7 days / 30 days / 90 days).

All are pure display preferences: cost/token tracking, the SQLite pipeline,
and the observability data flow are unaffected. Defaults preserve current
behavior (both toggles shown, both filters All).

Out of scope: OTEL endpoint settings (separate effort, owned elsewhere),
theme/density preferences, per-workspace overrides.

## Data model

Extend `AppConfig` in `src/main/config.ts`:

```ts
uiPrefs?: {
  showBudgetBar?: boolean;       // default true
  showSessionCost?: boolean;     // default true
  maxSessions?: number;          // 0 = unlimited (default); else 10|25|50|100
  maxSessionAgeDays?: number;    // 0 = unlimited (default); else 1|7|30|90
}
```

- `getUiPrefs(): Required<UiPrefs>` — resolves absent booleans to `true` and
  absent numbers to `0`, so existing installs and partial configs see no
  change. Numbers are clamped to non-negative integers on read and write;
  values outside the preset list are preserved and honored by the filter
  (the dropdown renders them as an extra "N (custom)" option), keeping the
  door open for a first-class Custom option later.
- `setUiPrefs(partial)` — shallow-merges into the stored object and writes
  `<userData>/config.json` (same read-modify-write helper the other setters
  use).

## IPC / preload

- `config:get` response gains a `uiPrefs` field (resolved, both booleans
  present).
- New channel `config:setUiPrefs` (promise-based `ipcMain.handle`, mirrors
  `config:setAutoReloadLoadouts`). Returns `{ uiPrefs }`.
- Preload exposes `window.api.config.setUiPrefs(prefs: Partial<UiPrefs>)`
  with an exported `UiPrefs` type.

## Settings UI

New **Display** section in `SettingsModal.tsx`, after the plan-usage budget
block, using the existing `checkbox-row` pattern plus a `modal-section-label`
separator (first section header in this modal; existing fields stay
unsectioned to keep the diff minimal):

- ☑ Show plan-usage budget in the observability rail
  - hint: hiding only affects display; spend tracking continues.
- ☑ Show session cost in the sessions list
  - hint: costs are still recorded and visible in the observability rail.
- **Max sessions shown** — select: All (default) / 10 / 25 / 50 / 100.
- **Max session age** — select: All (default) / 1 day / 7 days / 30 days /
  90 days.
  - shared hint: filters only trim the left-rail list; sessions stay in the
    database and searching the list bypasses both filters. If `config.json`
    holds a non-preset value (hand-edited), the select renders it as an
    extra "N (custom)" option rather than silently rewriting it.

All save on the modal's existing Save action alongside the other settings.
Interactive mockup of the toggles reviewed 2026-08-07 (settings modal + live
previews of both affected sites); the two dropdowns follow the same
`form-row` + select pattern as the plan-usage budget control.

## Consumers

`App.tsx` already fetches `config.get()` on mount and after settings save:

- Hold `uiPrefs` in state; refresh in the same place `fleetRoot` refreshes
  after `onSaved`.
- `showBudgetBar` → prop to `ObservabilityPane`; gates the
  `{budget && <UsageBudgetBar …/>}` render (currently
  `ObservabilityPane.tsx:113`). The 15-second `usage:rollingSpend` poll in
  `App.tsx` is skipped while hidden (no data consumer).
- `showSessionCost` → prop through `LeftRail` to `SessionsPane`; gates the
  `.session-row-cost` span (currently `SessionsPane.tsx:247`). Row layout
  (workspace dot, timestamp) unchanged.
- `maxSessions` / `maxSessionAgeDays` → props through `LeftRail` to
  `SessionsPane`, applied via a new pure helper in
  `src/renderer/src/sessionsView.ts`:

  ```ts
  limitSessions<T extends { lastActiveAt: number }>(
    items: readonly T[],            // last-active-descending
    opts: { maxCount: number; maxAgeDays: number },  // 0 = unlimited
    now: number
  ): T[]
  ```

  Age filter first (drop rows with `lastActiveAt < now − maxAgeDays`), then
  count cap (keep the newest `maxCount`). Ordering rules:
  - Applied after scope selection (`sessionsForScope`) and only to the
    **recent** group — sessions with an open tab (`partitionByOpen`) always
    render; a live session never disappears from the rail.
  - A non-empty text search (or active tag filter) bypasses both limits —
    `filterSessions` runs over the unlimited scoped list, so old sessions
    remain findable. Limits re-apply when the query/tags clear.
  - The "All · N" badge keeps its #149 invariant: it counts exactly the rows
    the All view currently lists (i.e., the filtered count).

## Error handling

- Partial/legacy `config.json` (no `uiPrefs`): getter defaults both to
  `true` — same guard style the modal already uses for `usageBudget`.
- No renderer failure modes beyond existing settings-save error surface
  (modal `error-text`).

## Testing

- Unit (vitest, next to source): `getUiPrefs` defaults when absent/partial;
  `setUiPrefs` merge semantics (setting one key preserves the others);
  clamping of negative/fractional filter values; round-trip through the
  config file helper.
- Unit for `limitSessions` in `sessionsView.test.ts`: unlimited passthrough,
  age boundary (exactly `now − maxAgeDays` stays), count cap keeps newest N,
  both combined (age then cap), `now` injected — no `Date.now()` in the
  helper.
- Gate: `npm run typecheck` + `npm run test:unit` + `npm run build`. No
  in-container UI verification (no display); visual check happens on the
  host.

## SPEC.md impact (required, same commit)

- §6 *Settings (app config)*: add `uiPrefs` to the persisted config shape
  and describe the two toggles.
- IPC surface: add `config:setUiPrefs`; note the `config:get` payload
  addition.
