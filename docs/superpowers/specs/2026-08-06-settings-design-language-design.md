# Settings modal design-language alignment + gear icon replacement

**Date:** 2026-08-06
**Status:** approved (brainstormed with Troy via visual mockups; icon option B and layout option A selected)
**Target:** `origin/main` @ v0.9.0 (`cf2cbf3`)

## Goal

Two user-facing polish changes, no behavior changes:

1. Replace the settings trigger icon — the current `IconGear` reads as a sun/asterisk (circle + radiating ticks), not a gear.
2. Restyle the Settings modal body so it matches the app's design language (tiered surfaces, mono section headers, tight hint copy) instead of a flat stack of `form-row`s with paragraph-length hints.

## 1. Gear icon

`IconGear` in `src/renderer/src/components/WorkspaceTabStrip.tsx` (~line 104) is replaced with the classic Feather/Lucide "settings" cog (MIT-licensed path): center circle + smooth-toothed outline.

- Keep the component name, call site (`.icon-btn.settings-btn`), and rendered size (14×14).
- SVG: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.8"` (weight-parity with the 1.4-stroke 16-viewBox siblings), round caps/joins, `aria-hidden="true"`.
- Body: `<circle cx="12" cy="12" r="3"/>` plus the standard Feather settings outline path.

## 2. Settings tab restyle (approved mockup: "grouped sections")

The modal shell is untouched: `modal-backdrop` → `modal modal-tabbed` → `modal-tabs` with the two tabs (Settings / Model Endpoints + count badge) → `new-tab` panel → `modal-footer` with Cancel/Save.

The Settings tab body is reorganized into three sections, each headed by the app's established mono section-header idiom (as in ObservabilityPane): 10px mono, 600 weight, uppercase, 0.08em tracking, `--ink-2`, with a `--rule-soft` bottom border.

- **Storage** — the fleet-root input + Browse button (unchanged `input-with-button`), followed by a condensed 11px hint: "Private folder per workspace at `<root>/<id>` → `/workspace`, plus `<root>/shared` → `/shared` in every container. Applies to new containers and on next restart."
- **Behavior** — the two checkboxes become *toggle rows*: sans-serif 13px `--ink` title + 11px `--ink-2` description on the left, checkbox on the right.
  - "Disable hardware acceleration" — desc: "For GPU-process errors on startup (common on WSLg). Applies at next launch." The existing "Restart required to take effect." nudge (shown when the value differs from the persisted one) is appended to the description.
  - "Auto-reload loadouts into running workspaces" — desc: "Reload the Claude session (`--resume`) after a loadout install/update; waits until idle."
- **Plan usage** — a toggle-row-shaped line: title "Budget for the “tokens left” bar", desc "Rolling {windowHours}-hour window, fleet-wide. Presets are estimates — calibrate with Custom." with the preset `<select>` as the right-hand control. When *Custom…* is selected, the token-count number input appears full-width below the row inside the same section. The longer calibration guidance (Settings → Usage, limit-report spend) stays as a hint under the custom input only, where it's actionable.

Error display and footer are unchanged.

### New CSS (styles.css, alongside the existing form styles)

- `.settings-section` — section block, 18px bottom margin.
- `.settings-section-header` — the mono header described above.
- `.setting-row` — flex row: text column (flex 1) + control, 12px gap, 6px vertical padding.
- `.setting-title` — 13px, `--ink`, sans.
- `.setting-desc` — 11px, `--ink-2`, 1.4 line-height, 2px top margin.

This also fixes the styling leak where `label.checkbox-row` inherits `--font-mono` + 600 weight from `.form-row label` (visible in production as bold monospace checkbox labels): the new rows are plain sans elements, and the checkbox is bound with `htmlFor`/`id` instead of label-wrapping.

## 3. Model Endpoints tab — same idioms

Styling-only pass so the two tabs feel like one modal (no logic, IPC, or data changes):

- The endpoint list's inline `style={{…}}` attributes move to classes styled like the setting rows (name + detail left, actions right, `--rule-soft` separators).
- The add/edit endpoint form keeps its existing `form-row` fields but gains the same section-header treatment where it has natural groups.

## Constraints

- **No behavior changes.** Same state, handlers, IPC calls, and save semantics. `npm run typecheck` and the Playwright suite must pass; any e2e selectors that key on Settings-modal text/labels are updated only if the restyle renames visible text (the section headers add text; existing labels keep their wording).
- **SPEC.md:** not updated — this is styling with no change to flows, IPC, data model, or security model (per `.claude/rules/spec-maintenance.md`, trivial/no-behavior changes don't warrant it).
- **Non-goals:** no new settings, no settings search, no modal shell/tab changes, no icon-library dependency (icons stay hand-inlined).

## Testing

- `npm run typecheck` + `npm run test:unit` (no unit surface changes expected).
- `npm run test:e2e` — settings-related specs exercise open/edit/save; verify selectors.
- Visual check in `CLAUDE_FLEET_MOCK=1 npm run dev`: gear icon at 14px, Settings tab sections, Model Endpoints tab list, custom-budget reveal, HWA restart nudge.
