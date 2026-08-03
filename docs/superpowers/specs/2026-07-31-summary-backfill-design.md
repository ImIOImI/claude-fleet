# Chapter-summary backfill — chunked summarization + session-start sweep

**Date:** 2026-07-31
**Status:** approved (design review with Troy, this session)
**Builds on:** Phase 2 session hooks (#207/#208), summarizer diagnostics (#230/#233), rolling ai-title (#170/#238)

## Problem

`summarize.sh` only runs as a **Stop hook on a live session**. A session that ended before
the pipeline worked (wrong image, pre-Phase-2, silent #230 failure) never fires Stop again, so
its transcript stays unsummarized forever: no chapters, no tags, no summary embeddings, and no
Phase 3 (#206) value-scoring data. As of 2026-07-30 the manager workspace alone has ~25 such
sessions; fleet-wide the backlog is the majority of all history.

Two smaller defects in the same path, fixed here because the fix lives in the same lines:

1. **Mega-window on resume.** The Stop hook summarizes *everything* past the watermark as one
   window, `tail -c 8000`-truncated. A resumed session with 80 backlogged turns gets one coarse
   chapter (and silently drops most of the window text) instead of four real ones.
2. **Wrong chapter timestamps.** `fromEventTs`/`toEventTs` are stamped from the *whole
   transcript's* first/last entry, not the summarized window. Every chapter of a session carries
   identical timestamps, which poisons Phase 3's decayed-value scoring.

Decisions locked with Troy: backfill triggers **automatically on session start**; old transcripts
are chaptered by **replaying the organic ~20-turn cadence** (backfilled sessions become
indistinguishable from organically-summarized ones); the backlog **drains slowly** under an
env-tunable per-sweep budget rather than in one burst.

## Design

### A. Shared core: `docker/runner/summary-core.sh`

Extract the generation guts of `summarize.sh` into a sourced library. Central function:

```
summarize_next_chunk <tpath> <sid>   # one chapter for the next ≤N-turn chunk, then advance watermark
```

- **Chunk bound.** The turn-numbered window slice keeps the existing `jq` reduce (user prompts
  increment the turn counter; assistant replies carry their prompt's number) but gains an upper
  bound: entries with `n > skip and n <= skip + N`, where `skip` is the watermark's `last_turns`
  and N = `CF_SUMMARY_MIN_NEW_TURNS` (default 20). Today's slice is unbounded above — that is the
  mega-window bug.
- **Watermark per chunk.** The `.fleet.state` claim (`printf '%s %s' <turns> <now>`) moves inside
  the chunk step and records `skip + N` (not total turns), *before* the model call — same
  crash-safety trade-off as today: a killed run loses at most the in-flight chapter and never
  double-summarizes. State-file format is unchanged.
- **Windowed timestamps.** `fromEventTs`/`toEventTs` become the first/last `.timestamp` of the
  entries actually in the chunk (fixes defect 2).
- **Everything else rides along unchanged:** the `Previously: <prev>` chain (read from the
  sidecar's last summary line), strict-JSON validation, the rolling `ai-title` sidecar line
  (#238) — which means backfill also **retro-titles old sessions** — and all `report_status`
  breadcrumbs (`gate`/`attempt`/`generated`/`rejected`/`empty-window`, #233). Test seams
  (`CF_SUMMARIZE_CMD`, `CF_SUMMARY_STATUS_SINK`, `CF_SUMMARIZE_FG`) stay.

`summarize.sh` and the new sweep both `source /usr/local/lib/claude-fleet/summary-core.sh`.
One windowing implementation; no drift between live and backfill paths.

### B. Stop hook: `summarize.sh` becomes a thin caller

Same debounce gate as today (≥`CF_SUMMARY_MIN_NEW_TURNS` new turns AND
≥`CF_SUMMARY_MIN_INTERVAL_S` since last run), then instead of one unbounded `generate`:

```
while backlog ≥ min_turns and chapters_this_run < CF_SUMMARY_MAX_CHAPTERS_PER_RUN: summarize_next_chunk
```

`CF_SUMMARY_MAX_CHAPTERS_PER_RUN` default 5. On a normal live session (Stop fires every turn,
backlog ≈ 20 when the gate opens) behavior is identical to today: one chapter per qualifying
Stop. A resumed session with a large backlog now catches up in real chapters.

### C. Backfill sweep: new `docker/runner/backfill-summaries.sh` on SessionStart

Registered as a second **SessionStart** entry in `hooks.settings.json` (after
`session-report.sh`). Flow:

1. **Background immediately** (`( … ) >/dev/null 2>&1 &`; `exit 0`) — session start is never
   delayed. Like `generate`, the background body runs from `/tmp` so nested `claude -p`
   transcripts don't land in the watched project dir.
2. **Kill switch & lock.** `CF_BACKFILL=0` → no-op. `flock -n` on `/tmp/cf-backfill.lock` —
   a concurrent sweep (multi-tab wake) exits instead of double-scanning. The watermark files
   make a lost race benign anyway; the lock avoids wasted model calls.
3. **Scan** every `~/.claude/projects/*/`\*`.jsonl`, excluding `*.fleet.jsonl` and the transcript
   of the session that just started (`session_id` from the hook payload — the live Stop hook owns
   that one). Candidates = transcripts whose typed-turn count exceeds their watermark by
   ≥ `CF_SUMMARY_MIN_NEW_TURNS`. Order by file mtime, newest first (recently-touched sessions are
   the likeliest search targets).
4. **Drain under budget.** For each candidate, run `summarize_next_chunk` until the transcript is
   caught up or the **global sweep budget** is spent: `CF_BACKFILL_MAX_PER_SWEEP` chapters
   (default 10), sleeping `CF_BACKFILL_DELAY_S` (default 3) between model calls. Budget exhausted
   → stop; the next session start continues where this one left off. Steady state (no backlog) is
   a cheap scan and exit.
5. **Breadcrumbs.** Two new `report_status` phases: `backfill-start`
   `{candidates, backlogTurns}` and `backfill-done` `{generated, remaining, budget}` — so
   `list_errors type=summary-backfill-start/done` shows drain progress per workspace without
   `CF_SUMMARY_DIAG`. Per-chapter phases come from the core (`attempt`/`generated`/`rejected`).

### D. What is deliberately NOT done

- **Sub-threshold sessions stay unsummarized.** A dead 19-turn session gets nothing — exact
  parity with organic behavior. No special "final partial chapter" case.
- **No re-summarization.** Turns at or below a watermark are never revisited; the sweep only
  extends coverage forward.
- **No host watcher/DB/tool changes.** Sidecar ingestion is already restart-safe
  (`ignoreInitial: false` + per-line `dedup_key`), so backfilled sidecar lines — including ones
  written while the app is closed — ingest exactly like live ones. The
  `session_summaries`-duplication observed 2026-07-30 (4× identical rows) is a separate bug,
  tracked separately; it predates this design and this design neither fixes nor worsens it.
- **No cross-workspace anything.** The sweep sees only its own container's bind-mounted
  `~/.claude/projects`; scoping is structural.

### E. Host-side changes (small)

- Inject `CF_BACKFILL`, `CF_BACKFILL_MAX_PER_SWEEP`, `CF_BACKFILL_DELAY_S`,
  `CF_SUMMARY_MAX_CHAPTERS_PER_RUN` at container create alongside the existing `CF_SUMMARY_*`
  tunables, and surface them in `get_config`'s `summarizer` block — same pattern, host-tunable
  without an image rebuild.
- `docs/SPEC.md`: runner env contract, hook table (new SessionStart entry), observability
  section (new breadcrumb phases). Required by `.claude/rules/spec-maintenance.md` in the same
  commit as the behavior change.

### F. Env contract (all optional, script defaults shown)

| Var | Default | Meaning |
|---|---|---|
| `CF_BACKFILL` | `1` | `0` disables the sweep entirely |
| `CF_BACKFILL_MAX_PER_SWEEP` | `10` | global chapter budget per sweep |
| `CF_BACKFILL_DELAY_S` | `3` | sleep between backfill model calls |
| `CF_SUMMARY_MAX_CHAPTERS_PER_RUN` | `5` | chunk-loop cap per Stop-hook run |
| existing `CF_SUMMARY_*` | unchanged | gate, model, window chars, debounce |

### G. Testing

Extend the existing shell-test harness (`docker/runner/summarize.test.sh` pattern: fake
`CF_SUMMARIZE_CMD`, `CF_SUMMARY_STATUS_SINK` capture, `CF_SUMMARIZE_FG=1`):

- **Core:** a 65-turn fixture yields 3 chapters with windows (1–20), (21–40), (41–60), watermark
  60, 5 turns left unsummarized; window timestamps match the chunk's entries, not the file's;
  `Previously:` chains chapter N−1 into chapter N.
- **Stop hook:** 20-turn live case produces exactly one chapter (regression:
  behavior-identical to today); 80-turn backlog produces 4 chapters in one run under the
  default cap; cap honored at `CF_SUMMARY_MAX_CHAPTERS_PER_RUN`.
- **Sweep:** respects `CF_BACKFILL=0`; budget stops mid-transcript and a second sweep resumes
  from the watermark; lock prevents concurrent double-run; the just-started session's transcript
  is skipped; breadcrumb phases land in the sink.
- **Live verification:** after image republish + workspace recreate, the manager workspace's
  ~25-session backlog drains at ≤10 chapters per wake; chapters, tags, retro-titles, and summary
  embeddings appear (`search_transcripts kind=summary`), with `backfill-*` breadcrumbs in
  `list_errors`.

## Rollout

Ship in the runner images (base + devops), republish, recreate workspaces — the same activation
path as #233/#238. No migration: watermark files already on disk are honored as-is, so sessions
partially summarized by the old code backfill only their uncovered tail.
