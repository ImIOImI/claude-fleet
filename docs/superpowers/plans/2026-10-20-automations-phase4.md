# Fresh Sessions & Event Triggers (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `prompt.mode: fresh` (a new headless `claude -p` session per step) and `event` triggers (`session.idle`, `workspace.started`, `todo.created`).

**Architecture:** No broker change: the broker's `CREATE` already appends `args` to the claude exec, so a fresh step is `CREATE auto-<run>-<step> args ["-p", prompt, "--allowedTools", inbox tools + allowedTools]`, polled via `LIST` until it ends, then attached + `CLOSE`d. `Backend` gains `spawnHeadless` / `headlessState` / `closeHeadless` (docker via `BrokerClient`, mock simulated, local refuses). Events come from `ipc.ts` (`setFleetEventObserver`: busy→idle from the attached-session detector; `workspace:start`) and the inbox (`todo` event on creation), into `automationService.onEvent` (match → per-automation debounce → one `event` run).

## Tasks
1. Types + definition validation (event triggers, fresh mode, `allowedTools`, `{{trigger.workspace}}` / `{{trigger.todo}}`).
2. Backend headless methods (docker / mock / local) + `ipc.ts` host functions and the fleet-event observer.
3. Runner fresh steps (spawn, wait with timeout, always close).
4. Service event engine (match, debounce/coalesce with count, loop guard, failure path).
5. Inbox `todo` event; UI (fresh/live, allowed tools, event summaries, event run label).
6. Tests (unit + e2e), SPEC.md, PR.
