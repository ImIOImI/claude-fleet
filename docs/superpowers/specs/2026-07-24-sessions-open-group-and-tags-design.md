# Sessions pane: Open/Recent grouping + summary tags

**Date:** 2026-07-24
**Status:** approved (design review via mockups; Troy picked grouping design "B" and tag design "D — house style")

## Overview

Two additions to the left-rail Sessions pane, landing together:

1. **Open/Recent grouping** — sessions whose terminal tab is currently attached to a live PTY
   render first under an `Open · N` group header; everything else falls under `Recent`.
   Clicking an open row jumps to its existing tab instead of spawning a duplicate resume.
2. **Summary tags** — each row shows its session's 1–2 leading tags (from the Phase-2
   summarizer, #207) in the meta line, and the pane gains tag filtering + tag-aware search
   using the Library pane's existing filter vocabulary.

## Definition of "open"

A Claude session is **open** iff some running/paused workspace currently has a terminal tab
attached to a live broker PTY whose broker session maps (via `broker_sessions`) to that
Claude session UUID. A tab whose PTY has exited (`endedIds`) is **not** open. Stopped
workspaces have no live PTYs and contribute nothing. There is **no manual designation and no
new persistent state** — openness is derived at runtime.

## Architecture

### Open-set derivation (renderer, mirrors the busy-pulse pipeline)

Every running/paused workspace's `TerminalPane` is already mounted simultaneously (hidden
via CSS when not selected), so the renderer holds all tab + PTY liveness state. Derivation
copies the existing busy pipeline (`onBusyIdsChange` → `busyBrokerByWorkspace` →
`busyClaudeIdSet()`):

- `TerminalPane` gains `onLiveIdsChange(brokerIds: string[])` — reports the broker session
  ids of tabs whose PTY is currently attached and alive (tab list minus `endedIds`, gated on
  attach success). Fires on tab open/close, attach, and PTY exit.
- `App.tsx` collects these into `liveBrokerByWorkspace: Record<workspaceId, string[]>` and
  resolves broker → Claude UUIDs through the same `summaryForBrokerSession` mapping data used
  by `busyClaudeIdSet` (extract the shared resolution into `busySessions.ts` or a sibling).
- Result: `openSessions: Map<claudeUuid, { workspaceId: string; brokerSessionId: string }>`,
  passed to `SessionsPane` as a prop.

Trust model is identical to the busy pulse: accurate for mounted panes, self-healing on the
next observability push (which already triggers a SessionsPane reload). A brand-new tab whose
broker→claude mapping hasn't been learned yet simply isn't marked open until the mapping
lands — acceptable, the session row itself appears via the same ingest.

### Jump-to-tab (mirrors the resumeRequest plumbing)

`App.handleResumeSession` checks `openSessions` first:

- **Open:** `setSelectedId(workspaceId)` + set `activateTabRequest { workspaceId,
  brokerSessionId, token }`. The target `TerminalPane` consumes it (effect keyed on the
  token, like `resumeRequest`) by calling `setActiveId(brokerSessionId)` and acking via
  `onActivateConsumed()`. No IPC involved.
- **Not open:** existing resume flow, unchanged. The new tab then flows into the Open group
  once its mapping is learned.

### Tags data flow

Phase 2 (#207) already writes `session_summaries_v8` (latest row per session carries a
`tags` JSON array, ordered by relevance as generated) and the normalized `session_tags`
table. The Sessions list needs tags on each row:

- `db.listSessions()` adds a third grouped query (keeping the no-N+1 property): latest
  `session_summaries_v8.tags` per session id (`MAX(generated_at)` per group), parsed and
  attached as `tags: string[]` (empty array when no summary yet).
- `SessionListItem` (preload) gains `tags: string[]`. **IPC payload shape change** —
  `sessions:list` response; SPEC.md updated in the same commit (see below).
- Renderer derives the `Tags ▾` menu contents + counts client-side from the loaded rows
  (exactly how `LibraryPane` computes `allTags` from entries). No new IPC channel.

## UI

### Grouping (approved mockup "B")

- List splits into `Open · N` and `Recent` group headers (small caps label + hairline,
  green leading dot on the Open header). A header renders only when its group is non-empty.
- Open rows: 2px green (`--ok`) left border, `--ok-tint` background. Busy dot, rename,
  delete, hover actions unchanged in both groups.
- Both groups keep the existing last-active-descending order; scope toggle, search, and tag
  filters apply to **both** groups (an open row that doesn't match is hidden).
- Rows animate between groups via FLIP (Web Animations API, ~350 ms ease, brief green
  outline on the moved row), matching the approved jump demo. Group membership changes are
  the only animated transition; initial render is static.

### Tags (approved mockup "D — house style")

Reuses the Library kit verbatim — no new visual vocabulary:

- **Row chips:** up to 2 leading tags as existing `.tag` chips (10px mono, neutral gray,
  `--bg-3`, 4px radius) in the meta line's slack space between the relative time and the
  cost. Tags truncate/drop first when the line is tight (`.meta-tags` is the shrinkable
  flex item). Clicking a row chip toggles that tag as an active filter.
- **Filter row** (under the search input): `Tags ▾` button opening the existing checkbox
  menu with per-tag counts (`.tag-menu` / `.tm-count`), multi-select **OR** semantics —
  identical to `LibraryPane`. Active tags render as green `.pill` chips with `✕`, plus the
  `.nofm` "N of M" count. The row renders only when the fleet has ≥1 tagged session.
- **Search:** stays plain substring, but the haystack adds each session's full tag list
  (all tags, not just the 2 displayed). No `#` grammar, no autocomplete (possible later
  extension; explicitly out of scope now).

## Edge cases

- Session with no summary yet → `tags: []`, no chips, row otherwise normal.
- Filters compose: scope ∧ text query ∧ tag filters, applied before grouping; group
  headers show post-filter counts.
- Deleting an open session keeps existing semantics (deletes transcript + DB rows); the
  live tab is untouched and the row disappears from the list.
- Renaming/busy/pulse behavior is orthogonal and unchanged.
- Mock mode (`CLAUDE_FLEET_MOCK=1`): mock fleet should stamp a couple of sessions
  open + tagged so the UI is exercisable without Docker.

## Non-goals

- No main-process/broker-`LIST`-based open derivation (renderer state is the existing
  trust model for liveness UI; revisit only if it proves flaky).
- No persistent "open" column in SQLite; no changes to `sessions.json`.
- No `#` search tokens or smart-search dropdown.
- No tag editing/curation UI — tags are summarizer-owned.

## Testing

- **Unit (vitest):** pure grouping + filtering logic extracted next to
  `sessionsView.ts::sessionsForScope` (same pattern): open/recent partition, filter
  composition (scope/text/tags incl. tag-text search), tag-count derivation, and the
  open-map broker→claude resolution helper.
- **Unit:** `db.listSessions` tags join (latest summary wins, absent summary → empty).
- **e2e (Playwright, mock mode):** Open group renders with the mock's open sessions;
  clicking an open row activates the existing tab (no new tab created); tag chip click
  filters the list; `Tags ▾` menu toggles.

## SPEC.md updates (same commit as implementation)

- Sessions-pane section: Open/Recent grouping, openness definition + derivation, jump-to-tab
  flow, tag display + filter UI.
- IPC surface: `sessions:list` payload gains `tags`.
- Renderer data-flow: `onLiveIdsChange` / `activateTabRequest` contracts alongside the
  existing busy/resume plumbing.
