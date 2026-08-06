# Model picker in the workspace form — design

**Date:** 2026-08-06
**Status:** approved (Troy, via hi-fi mockup review)
**Scope:** renderer-only UX change to `WorkspaceForm` — no manifest, IPC, or main-process changes.

## Problem

The workspace form conflates two questions in one control. The `Auth` radio row
(OAuth / API key / Endpoint) answers both *which provider powers this workspace*
and *how to authenticate to Anthropic*. "Endpoint" is not an auth mode — its
auth already lives with the endpoint entry in the registry — so surfacing it as
an auth radio is confusing (observed in first real use of v0.9.0). Secondary
papercuts: with an empty registry the Endpoint radio is a locked 🔒 dead-end
that tells the user to go find Settings themselves; and a workspace whose
endpoint was deleted renders a blank select (#252 follow-up).

## Design

### Model row

A new **Model** row is inserted **directly above Auth**, in Auth's current
position at the bottom of the main form (below "Subfolder in /workspace").
Nothing else in the form moves. The row is a **rich combobox** (custom control,
not a native `<select>` — options need two lines + a badge):

- **Entry 1 — Claude.** Anthropic badge; subtitle "Anthropic · claude.ai
  account or API key". Always present, always first, default selection.
- **One entry per registry endpoint.** Badge + endpoint `name` (bold) +
  subtitle `` `modelId · baseUrl` ``. Ordered as the registry lists them.
- **Final entry — "＋ Add endpoint…"** (visually separated). Selecting it does
  not change the model; it opens Settings pre-focused on the Model Endpoints
  tab (small App-level hook required — see Cross-cutting).

Closed state shows the selected entry's badge, name, and subtitle. With an
empty registry the list is just Claude + "Add endpoint…" — the locked-radio
dead-end is gone.

**Dangling endpoint:** if the form loads with an `endpointId` that no longer
resolves in the registry, the combobox shows a "(deleted endpoint)" entry as
the selection; submit is blocked with the existing inline-error style until
the user re-picks. This closes the blank-select follow-up from #252.

### Auth row (contextual)

Auth keeps its position and label; its content depends on the Model selection:

- **Model = Claude:** today's OAuth / API-key radios, unchanged — including the
  API-key lock + tooltip when `ANTHROPIC_API_KEY` isn't in env, and the
  vault-unavailable degradation.
- **Model = endpoint:** the radios are replaced (not disabled) by a passive
  note: 🔑 *`<endpoint name>` — key from endpoint registry (none stored →
  placeholder token) · edit*, where *edit* opens Settings → Model Endpoints.
  Nothing is selectable.

The `Endpoint 🔒` radio and the conditional "Model endpoint" `<select>` row are
**deleted** — the combobox supersedes both.

Switching Model away from and back to Claude restores the previously selected
auth radio (form state is kept, not reset).

### State & derivation (renderer-only)

`WorkspaceForm` holds `model: 'claude' | <endpointId>` as the single source of
truth for the picker. The wire shape is derived at submit and parsed at load:

| form state | submitted |
|---|---|
| `model: 'claude'` + OAuth radio | `authMode: 'oauth'`, `endpointId: undefined` |
| `model: 'claude'` + API-key radio | `authMode: 'apikey'`, `endpointId: undefined` |
| `model: <id>` | `authMode: 'endpoint'`, `endpointId: <id>` |

Loading is the inverse (`authMode: 'endpoint'` → `model = endpointId`, else
`model = 'claude'` + radio from authMode). The derive/load pair is extracted
into a pure helper module so it's unit-testable and so every consumer of the
form (New tab, Saved-tab inline edit, Edit modal — all share `WorkspaceForm`)
gets identical behavior. **`WorkspaceSpec`, manifests, IPC channels, and the
vault contract are untouched; no migration.**

### Mechanical details

- **Registry freshness:** the endpoint list is fetched on form mount today;
  the combobox re-fetches on every open, so endpoints added via
  "＋ Add endpoint…" appear without remounting the form.
- **A11y/keyboard:** replacing a native select means we own semantics —
  trigger is a `button` with `aria-haspopup="listbox"`/`aria-expanded`; the
  list is `role="listbox"` with `role="option"` children; Arrow/Home/End move,
  Enter/Space select, Esc closes, click-outside closes. Focus returns to the
  trigger on close.

## Cross-cutting

- **Settings deep-link:** "＋ Add endpoint…" and the auth-note *edit* link need
  App-level plumbing to open `SettingsModal` on a specific tab (new optional
  prop / callback lifted through `App.tsx`).
- **SPEC.md:** this changes a user-facing flow, so `docs/SPEC.md` (workspace
  create/edit flow; the §11/#250 endpoint-UX wording) is updated in the same
  implementation PR, per `.claude/rules/spec-maintenance.md`.

## Testing

- **Unit (vitest):** the derive/load helper — round-trips for all three
  authModes, dangling-endpoint load, submit-block on dangling, radio-memory
  across model switches.
- **e2e (Playwright):** update specs that click the old `Endpoint` radio
  (`tests/endpoint-workspace.spec.ts` et al.) to drive the combobox; add a
  saved-tab resume round-trip asserting `endpointId` survives (pins the
  `savedToInitial` bug class caught in #252); empty-registry render (Claude +
  Add-endpoint only).

## Non-goals

- No changes to `AuthMode`/manifest schema (a provider/auth model split is a
  possible future refactor; not now).
- No endpoint CRUD inside the workspace form — "Add endpoint" navigates to
  Settings, it does not inline-create.
- The separate "API workspace kind" idea (no-TUI chat pane) and the alternative
  agent-TUI investigation (#255) are out of scope.
