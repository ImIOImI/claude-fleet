# Notifications Engine & UI (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notifications as their own primitive: requests from workspaces (`notify`, `post_todo{notify}`), urgent todos and system events, resolved against the user's rules, pause and downtime; delivered as an in-app toast or OS notification; logged in Activity; controlled from the 🔔 popover, the inbox header's notify menu and Settings › Notifications.

**Architecture:** inbox.db migration v2 adds `notifications`, `notification_rules`, `downtimes`, `notify_state`. A pure `notifyPolicy.ts` resolves deliver/hold; `notifyStore.ts` is the repository; `notifyService.ts` (pure, injected clock/delivery) owns requests, the digest ticker and needs-input timers; `notifyIpc.ts` binds Electron (Notification, BrowserWindow, ipcMain). Phase 2b (separate PR) adds tray, taskbar overlay, dock badge, app icon and keep-running-in-tray.

**Tech Stack:** as Phase 1.

## Global Constraints

- Spec §3/§5 (decision log rows "Notification authority", "Rules", "Global quiet", "Needs-input notifications", "Failures", "Retention", "Post cap").
- Rules: scopes key > source > tag > global, most specific wins; levels `all` · `high` (high+) · `urgent` · `off`; optional `snooze_until` acts as `off` until it passes. Created mostly via the 🔔 popover.
- Pause (one-off) + downtime (recurring; bypass `none` | `urgent` | `urgent+input`). Both hold notifications only. **Most recent explicit action wins** when both are active.
- End of a pause/downtime with ≥1 held item → **one digest**, never a replay.
- Needs-input: host-generated after ~20 s of waiting, only if the user isn't viewing that workspace (window focused + that workspace selected), auto-cleared when waiting ends; click → that workspace.
- Over-cap / disabled post → one notification to the user per workspace per hour.
- Notification log retained 30 days.
- No OS toast action buttons in v1.
- Every new IPC channel, table and tool goes into SPEC.md in the same PR. MCP contract pinned in unit + e2e.

## Decisions taken while planning (logged in the overnight decision log)

- Default global level = **`all`** (a poster's explicit request is honoured unless the user caps it). The Settings select offers All / High and up / Urgent only / Off.
- A todo that is **created or reopened at `urgent`** raises a notification request even without `notify: true`. Other todos notify only when the poster asks.
- Notification settings live in `inbox.db` (`notification_rules`, `downtimes`, `notify_state`), not `config.json`.
- Several matching tag rules → the **strictest** level wins.
- Downtime windows use the host's local time; a window whose end ≤ start wraps past midnight and belongs to the day it starts.

## Interfaces (all tasks)

```ts
// src/preload/inboxTypes.ts (additions)
export type NotifyLevel = 'all' | 'high' | 'urgent' | 'off';
export type NotificationKind = 'post' | 'todo' | 'input-wait' | 'post-rejected' | 'digest' | 'test';
export type RuleScopeKind = 'key' | 'source' | 'tag' | 'global';
export interface NotificationRow {
  id: string; ts: number; kind: NotificationKind; title: string; body: string | null; priority: TodoPriority;
  source: TodoSource; todoId: string | null; workspaceId: string | null; delivered: boolean;
  heldReason: string | null; channel: 'os' | 'in-app' | null; clearedAt: number | null;
}
export interface NotifyRule { id: string; scopeKind: RuleScopeKind; scopeValue: string; level: NotifyLevel; snoozeUntil: number | null; }
export interface Downtime { id: string; name: string; enabled: boolean; days: number[] /* 0=Mon..6=Sun */; startMin: number; endMin: number; bypass: 'none' | 'urgent' | 'urgent+input'; }
export interface PauseState { until: number | null /* null = until resumed */; letUrgent: boolean; setAt: number; }
export interface QuietState { pause: PauseState | null; activeDowntime: Downtime | null; nextDowntime: { downtime: Downtime; startsAt: number } | null; heldSinceQuiet: number; }
export interface RuleScope { scopeKind: RuleScopeKind; scopeValue: string; label: string; }
export interface EffectiveRule { level: NotifyLevel; snoozeUntil: number | null; ruleId: string | null; scopeKind: RuleScopeKind; }
```

## Tasks

1. **Schema v2 + `NotifyStore`** (`src/main/inbox/notifyStore.ts`, test). Insert/list/clear/prune notifications (`list({ filter: 'all'|'delivered'|'held', limit })`, `prune(olderThan)`), rule upsert by `(scopeKind, scopeValue)` / remove / list, downtime save/remove/list, `getPause/setPause/clearPause`, `getDefaultLevel/setDefaultLevel`, `markDigested(ids)`, `heldSince(ts)`. Tests: round-trips, unique rule scope upsert, prune.
2. **`notifyPolicy.ts`** (pure, test). `scopesFor(req)` → ordered scopes; `effectiveRule(req, rules, defaultLevel, now)`; `levelAllows(level, priority)`; `downtimeWindowAt(d, now)` → `{start, end} | null` (wrap past midnight, local time); `nextDowntime(ds, now)`; `resolve(req, ctx)` → `{ deliver: true } | { deliver: false; heldReason }` covering: key > source > tag(strictest) > global; snooze; level gates; pause with letUrgent; downtime with bypass; pause-vs-downtime most-recent-wins. ≥20 table-driven cases.
3. **`notifyService.ts`** (pure, injected `now`, `deliver(n)`, `names(id)`, `viewing()`; test with fake timers). `request(req)` → stores row with delivered/held; `onTodoPosted(todo, action, notifyFlag)`; `onPostRejected(ws)` (once/hour/ws); `onInputWait(ws, waitingIds)` (20 s debounce, viewing check, clear on empty, dedupe per ws); `tick()` digest on quiet→not-quiet transition; `test()`; `prune()`. Tests per behavior.
4. **MCP + inbox wiring.** `notify` tool (`{title, body?, priority?, todo_id?, key?, tags?}`) via `InboxHandlers.notify`, sharing the Phase 1 permission + cap; `post_todo` gains `notify` boolean; inboxService calls `notifications.onTodoPosted`. Unit tests for tool surface + service.
5. **`notifyIpc.ts`** — Electron delivery (focused window → `notifications:toast`; else `new Notification`, click → focus + `notifications:open`), ipc channels (`notifications:list|rules|setRule|removeRule|scopesFor|effective|effectiveMany|getSettings|setDefaultLevel|setPause|resume|saveDowntime|removeDowntime|quietState|test|setViewing`), pushes `notifications:changed`, 30 s ticker, daily prune; input-wait observer hook exported from `ipc.ts` (`setInputWaitObserver`). Preload `window.api.notifications`.
6. **Renderer:** Activity tab (Everything / Notifications / Held back) with log rows; 🔔 popover (`BellPopover.tsx`) on todo rows, the todo detail and log rows; muted-row hint; notify control + menu in the inbox header (`NotifyControl.tsx`), pause banner; in-app toast + open handling in `App.tsx`; Settings › Notifications tab (`NotificationsSettings.tsx`: default level, downtime week view + list + add/edit, rules table, permission row + Send a test). Pure helpers in `notifyView.ts` with tests.
7. **E2E** `tests/notifications.spec.ts` (mock): bell rule → held in Activity with reason; pause via header menu → banner + held → resume → digest; downtime add/remove in Settings; Send a test → in-app toast; MCP `notify` + `post_todo{notify}` in `tests/inbox-mcp.spec.ts` (real).
8. **SPEC.md** (§6 notifications channels, §7 schema v2, §8 flows, §9 notify tool gate, MCP list) + PR.
