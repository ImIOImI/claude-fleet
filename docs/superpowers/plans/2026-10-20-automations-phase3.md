# Automations Core (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-authored automations (YAML) with schedule + manual triggers, typed params and **live** prompt steps, versioned, with run history, Run-now, failure notifications and single catch-up after downtime; visible in Inbox › Automations; listable/runnable by workspaces over MCP.

**Architecture:** `src/main/automations/`: pure `cron.ts` (5-field cron, IANA tz via `Intl`), `definition.ts` (YAML/JSON → validated `AutomationDef`), `template.ts` (`{{args.*}}` / `{{trigger.*}}` / `{{run.id}}` rendering, caller-supplied args wrapped as data), `scheduler.ts` (what is due), `runner.ts` (step executor, injected effects), `automationStore.ts` (inbox.db schema v3), `automationService.ts` (create/update/delete/run/tick + active-run registry), `automationIpc.ts` (Electron + MCP wiring). Host-trusted workspace effects (`hostPostToWorkspace`, `hostEnsureRunning`, `hostWorkspaceBusy`) are exported from `ipc.ts` next to the committee equivalents but **without** the committee grant gate: the user's approval of the automation is the consent (spec §3).

## Global Constraints
- Spec §6: definition shape, run lifecycle, attribution (`source=automation:<id>`, `via_workspace`, `source_run_id`, validated against the active run), guard rails (one catch-up, rate cap 1 run/min, self-trigger guard), errors (`target-not-running`, `docker-unreachable`, timeouts).
- Phase 3 accepts only `schedule` + `manual` triggers and **live** prompt steps; `event` triggers, `fresh` mode and `script` steps are rejected with a message naming the phase that adds them.
- Params: `string` / `number` / `boolean` / `enum`, validated before a run row exists; workspace-supplied args are wrapped as labeled data inside prompts and never interpolated anywhere else.
- No pre-run cost estimates; cost shown only from real sessions (deferred: live sessions are the user's own sessions, so per-run cost lands with fresh mode in Phase 4).
- Failure → a notification (kind `run-failed`, source automation), never a todo.

## Decisions (logged)
- Phase 3 editor is **YAML with live validation + a starter template**; the Form view ships with Phase 6's draft cards (same component).
- Prompt steps get a run footer ("automation run `<id>`: pass `run_id` to post_todo/notify"); attribution to the automation happens **only** when `run_id` is passed and matches an active run that targets the caller.
- `wait: true` on a live step waits for the target to go busy → idle (host busy signal), bounded by the step timeout (default 10 m).
- Cron supports `*`, lists, ranges, steps, and `tz` (IANA, default host local). DOM + DOW both restricted → either matches (Vixie semantics).

## Tasks
1. `cron.ts` + tests (parse errors, next-fire in local and America/New_York incl. DST, `*/30 8-18 * * 1-5`).
2. `definition.ts` + tests (validation messages, phase-gated features, duration parsing, normalization, YAML round-trip).
3. `template.ts` + params validation + tests.
4. Schema v3 + `automationStore.ts` + tests (CRUD, versions, tags, runs, step runs, state, run pruning).
5. `scheduler.ts` + `runner.ts` + tests (due/catch-up/rate cap; step success/failure/timeout/ensureRunning/wait).
6. `automationService.ts` + tests (concurrency skip/queue, attribution registry, failure notification, run-now validation, MCP list/run permissions).
7. `ipc.ts` host-trusted effects + `automationIpc.ts` + MCP `list_automations` / `run_automation` + `post_todo`/`notify` `run_id` + preload.
8. Renderer: Automations tab (list, detail, runs), YAML editor modal, Run-now modal, enable/disable, delete, tags; helpers + tests.
9. E2E `tests/automations.spec.ts` (mock) + MCP list/run in `tests/inbox-mcp.spec.ts` (real).
10. SPEC.md + PR.
