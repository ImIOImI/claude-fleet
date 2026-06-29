# Design: close out `ai_title`

**Date:** 2026-06-29
**Status:** approved (brainstorming) — pending implementation plan

## Background

`ai_title` was flagged as a "loose thread": the spec (§7, §11) describes the
column as dormant — schema + ingest hook present, but "nothing populates them
yet," with open questions about which model to use, when to title, and how much
transcript to feed it.

**That premise is stale.** Investigation against this dogfooding environment's
live state DB shows the chain already works end-to-end:

- Claude Code **2.1.177** (the pinned runner version) natively emits
  `{"type":"ai-title","aiTitle":"…","sessionId":…}` lines into its own
  transcript JSONL — verified with no hooks and no statusline configured.
- `db.ts:317-318` already ingests that line into `sessions.ai_title`.
- `db.ts:656-658` (`summaryFor*`) already prefers it:
  `ai_title ?? first_user_message`.
- A live `list_sessions` MCP query returned good titles for every session
  (e.g. "Review Claude Fleet repository updates",
  "Redesign Claude Fleet landing page as advertisement").

So there is **no titler to build**. The work is to close the thread out
honestly: correct the stale spec, lock the behavior in with a regression test
(it rides on an *undocumented native CC line type*, so it is fragile across
`claude` version bumps), and fix one latent bug surfaced along the way.

## Goals

1. Make `docs/SPEC.md` reflect reality: `ai_title` is populated natively, with a
   fragility note tying re-verification to the `claude` version pin.
2. Fix the `first_user_message` command-wrapper-noise bug.
3. Add a regression test that fails if either the `ai-title` ingest→display path
   or the noise filter regresses.

## Non-goals

- Building any LLM-based titler (Claude Code already produces the title).
- Stripping synthetic blocks out of otherwise-real prompts ("aggressive strip").
  We do conservative skip only — see Part 2.
- Backfilling titles for historical sessions (they already have them; the DB is
  rebuildable from JSONL regardless).

## Part 1 — Fix the stale spec

Two spots in `docs/SPEC.md` are now false and must be corrected in the same
change (per `.claude/rules/spec-maintenance.md`):

- **§7 JSONL→SQLite cache** — the `ai_title TEXT, -- latest \`ai-title.aiTitle\`
  (dormant — no producer yet)` comment becomes a statement of fact: Claude Code
  (≥2.1.x) writes `{type:"ai-title",aiTitle,sessionId}` lines natively; the
  watcher ingests them into the column; `summaryFor*` prefers it over
  `first_user_message`.
- **§11 Sessions table → Open (residual)** — remove the "nothing populates them
  yet / which model / when / how much transcript" bullet (moot). Replace with a
  short **fragility note**: the title depends on an undocumented native CC
  transcript line type, so bumping the `claude` pin (§4) should re-verify the
  `ai-title` line still appears, the same "bumping the pin is deliberate"
  discipline already documented for the PTY-navigation regression.
- Tighten §7's `first_user_message` derivation note to record that synthetic
  command-wrapper content is skipped (Part 2).

These are descriptive edits only — no changelog prose, edit in place.

## Part 2 — `first_user_message` noise fix

### Root cause

`updateSessionLastPrompt` is:

```sql
UPDATE sessions SET first_user_message = COALESCE(first_user_message, ?) WHERE id = ?
```

First non-null value wins, permanently. For a session started with `/clear`,
the first string-content `user` message ingested is the command-wrapper blob
(`<local-command-caveat>…</local-command-caveat>` + `<command-name>` etc.), so it
locks in as `first_user_message`. The real prompt — which arrived cleanly on its
own `last-prompt` line — never gets to win. `ai_title` masks this in the display,
but any session lacking an `ai-title` line shows the wrapper noise as its title.

### Fix

- New **pure module** `src/main/userPromptText.ts` exporting
  `isSyntheticPromptText(text: string): boolean`. Returns `true` when the
  *trimmed* string **starts with** a known harness/slash-command wrapper tag.
  Recognized set (conservative):
  - `<local-command-caveat>`
  - `<command-name>`
  - `<command-message>`
  - `<command-args>`
  - `<local-command-stdout>`
  - `<system-reminder>`
- In `db.ts` `ingestLine`, guard **both** `updateSessionLastPrompt` calls with
  `!isSyntheticPromptText(...)`:
  - the `last-prompt` path (`parsed.lastPrompt`, ~:320)
  - the `user` string-content path (`message.content`, ~:322)

  so the first *real* prompt wins instead of a wrapper blob.

### Behavior choice: conservative skip (approved)

If a message *starts with* a wrapper tag, the **whole message is treated as
noise and skipped** — `first_user_message` is left for the next real message to
fill. We do **not** attempt to strip a wrapper block out of an otherwise-real
prompt and keep the remainder. Rationale: the observed bug is an entirely-synthetic
`/clear` message, which skip handles perfectly; the real prompt arrives separately
and wins once the blob is skipped. Stripping is more code and risks mangling a
legitimate prompt that contains angle-bracket text. The only case conservative
skip loses is a session whose *very first* message is a real prompt with a wrapper
glued on and no clean prompt anywhere else — and `ai_title` covers the display
there anyway.

### Testability

`db.ts` imports `better-sqlite3` (native, Electron-ABI) and cannot run under
vitest. `userPromptText.ts` is pure, so it is unit-tested directly in
`src/main/userPromptText.test.ts`:

- each wrapper blob (incl. leading whitespace) → `true`
- ordinary prompts → `false`
- a real prompt that merely *mentions* a `<tag>` mid-text → `false`
- empty / whitespace-only string → its own defined result (treat as synthetic
  so it never wins as a title)

## Part 3 — regression test (e2e)

Because the ingest→column→display path runs through `db.ts`, the regression test
is Playwright, mirroring `tests/sessions-list.spec.ts` (seed a transcript JSONL on
disk, launch the app without `CLAUDE_FLEET_MOCK`, let the real watcher ingest, read
back through `window.api.sessions.list`).

New focused spec `tests/ai-title.spec.ts`, one workspace, two seeded sessions:

- **Session A** — lines in order: a synthetic wrapper `user` message (the
  `/clear` blob), then a real `last-prompt` line, then an `ai-title` line, then an
  `assistant` line. Assert on the `sessions:list` row:
  - `aiTitle` === the seeded title
  - `firstUserMessage` === the real prompt (**not** the wrapper blob)
- **Session B** — same shape but **no** `ai-title` line. Assert:
  - `aiTitle` === null
  - `firstUserMessage` === the real prompt (noise still skipped)

This pins both invariants: if a `claude` bump drops the `ai-title` line or an
ingest refactor breaks the column, Session A fails; if the noise filter
regresses, both fail.

## Files touched

| File | Change |
|---|---|
| `src/main/userPromptText.ts` | new pure module — `isSyntheticPromptText` |
| `src/main/userPromptText.test.ts` | new vitest unit tests |
| `src/main/db.ts` | guard both `updateSessionLastPrompt` calls |
| `tests/ai-title.spec.ts` | new e2e regression (2 seeded sessions) |
| `docs/SPEC.md` | §7 + §11 stale-note corrections + fragility note |

## Verification

- `npx vitest run src/main/userPromptText.test.ts` — unit green.
- `npx playwright test tests/ai-title.spec.ts` — e2e green (needs a display).
- `npm run typecheck` — both tsconfigs clean.
- Spec re-read: §7 and §11 no longer describe `ai_title` as dormant.
