# Inbox, automations & desktop notifications

**Status:** design approved screen-by-screen 2026-10-19 → 2026-10-20; Phase 1 ready to plan.
**Mocks:** [hi-fi walkthrough](https://claude.ai/code/artifact/2d9c7211-1454-4350-91f1-ebe38e4afca2) (private artifact) · source + PNGs in [`assets/2026-10-20-inbox-automations/`](assets/2026-10-20-inbox-automations/). The mocks are built from the app's real React chrome (server-rendered from `origin/main`) and the real `styles.css`; every new element uses only existing tokens.

## 1. What this is

A host-owned **inbox** where automations, workspaces and the user post **todos**; **automations** that run on a schedule, by hand, or on fleet events, and that run scripts and/or prompt workspaces; and **desktop notifications** for the things that need the user, with fine-grained, low-friction control over noise. Workspaces can post todos and *propose* automations; nothing a workspace proposes runs without the user's approval. Authoring is **Claude-first**: the user describes an automation and a dedicated workspace drafts it. Automations can be **packaged in loadouts** and synced like any other loadout content.

## 2. Phasing

Each phase is its own plan → PR(s) → SPEC.md update (per `.claude/rules/spec-maintenance.md`). Phases 1–2 are useful on their own.

| # | Phase | Contents | Depends on |
|---|---|---|---|
| 1 | **Inbox core** | `inbox.db`, todos / tags / history, dedupe, `post_todo` / `update_todo` / `list_todos` MCP tools, Inbox chip + Todos tab, user-created todos, per-workspace `inbox` permissions (can-post, cap) | — |
| 2 | **Notifications & desktop presence** | `notify` tool, notification log (Activity › Notifications), rules + 🔔 popover, default level, downtime schedules, global pause (header control + tray), held-notification digest, "needs you" count, needs-input notifications, Electron `Notification`, Windows overlay / macOS dock badge / Tray, app icon assets, keep-running-in-tray | 1 |
| 3 | **Automations core** | definitions (user-authored via form/YAML), versions, schedule + manual triggers, typed params, **live** prompt steps, run history, Run-now modal, failure notifications, catch-up on launch | 1, 2 |
| 4 | **Headless sessions** | broker op to spawn a non-interactive session; **fresh** prompt mode; workspace-event triggers | 3 |
| 5 | **Proposals & approval** | `propose_automation` / `propose_automation_change` (incl. batch) / `get_proposal` / `run_automation`, Activity proposal + batch cards, trusted tier + `classifyChange`, auto-approved-with-Revert, **Ask Claude about this** review conversation, the **automations workspace** (`role: 'automations'`, created on first use) and its **session tabs inside the Inbox** + Inbox chip ⋮ | 3, 4 |
| 6 | **Claude-first authoring** | composer, drafts (proposal cards with Form/YAML + "Ask for changes" + Test run), "Ask Claude to change…" bar, `automation-author` loadout | 5 |
| 7 | **Script steps** | `ScriptExecutor` implementation + stdout JSON-lines protocol + exit-10 | **blocked on the execution-environment decision (§12)** |
| 8 | **Automations in loadouts** | `automations/` convention folder, install review section, `$self` binding, update Keep mine/Take update, provenance, Save/Add-to-loadout export — **cross-repo** with `claude-fleet-loadouts` | 3, 5 |

The app icon (§8.6) can ship independently of all of these; it overlaps Admiral rename Phase 2 (#366, packaging/OS identity).

## 3. Decision log

| Topic | Decision |
|---|---|
| Engine location | Electron **main process** (scheduler, run orchestrator, inbox store, notification policy). Core logic kept Electron-independent so a later always-on daemon is a lift-and-shift. Considered: an "automation manager" Claude session (non-deterministic, token cost per tick, authority inside an agent) and a separate Go daemon (new process + IPC + packaging). |
| Storage | New authoritative **`<userData>/inbox.db`**. Not `state.db`, which SPEC §7 defines as a droppable cache rebuilt from JSONL. |
| Inbox shape | **One inbox.** Every item has a **required, immutable `source`** (`user` / `workspace:<id>` / `automation:<id>`), host-stamped from ambient identity. Free-form **tags** on todos *and* automations, editable over time. |
| Duplicates | Poster-supplied **dedupe `key`** (unique per source). A hit updates the item (seen-count, last-seen, detail appended, `max(priority)`). A recurrence on a done **or dismissed** item **reopens** it with a `recurred` mark. There is **no per-item mute**: noise is controlled by notification rules. |
| Notification authority | Poster *requests* (priority + optional `notify`); the user's rules **cap**. Notifications are a separate primitive: a post can make a todo, a notification, or both. |
| Rules | Scopes **key > source > tag > global**, most specific wins. Levels `all` · `high+` · `urgent` · `off`, plus optional snooze-until. Created mostly through the 🔔 popover on any item. |
| Global quiet | **Pause** (one-off: 30m / 1h / until 17:00 / tomorrow 08:00 / until resumed) and **Downtime** (recurring schedules, each with its own urgent / needs-input bypass). Both hold notifications only; todos still arrive and counts stay true. When a pause or downtime ends: **one digest**, never a replay. Conflicts: **the most recent explicit action wins**. |
| "Needs you" | Urgent todos + pending approvals + workspaces waiting for input. Never plain open todos. Drives the taskbar overlay and dock badge: **1 → dot, ≥2 → count**; red if anything urgent, otherwise violet (`--wait`). The tray stays dot-only. The Inbox chip counts inbox items only (waiting workspaces already show violet on their own chips). |
| Needs-input notifications | Reuse `signal_input_wait`: a host-generated notification (no todo), fired after ~20s of waiting and only if the user isn't viewing that workspace, auto-cleared on `waiting=false`, click → that session tab, 🔔 rules apply. |
| Triggers (v1) | Schedule, manual, workspace event. No webhook (it would be a new network port). |
| Automation runtime | Automations run in the host engine; **steps** are *script* or *prompt a workspace*. **Where scripts execute is undecided** → `ScriptExecutor` interface (§12). |
| Prompt mode | Per step: **fresh** (new headless session; default) or **live** (inject via the `committee_post` path). |
| Script contract | Env-only inputs (`FLEET_ARGS`, `ARG_<NAME>`, `FLEET_STATE`, `FLEET_TRIGGER`, declared secrets). Stdout JSON lines `{"todo":…}` `{"notify":…}` `{"state":…}`. Exit **0** continue · **10** nothing to do (successful stop) · other = fail. Args are never interpolated into script text. |
| Params | Typed `string` / `number` / `boolean` / `enum`; validated before a run exists; per-trigger fixed args; workspace-supplied args wrapped as labeled data in prompts. |
| Consent for prompt targets | **Approval is the consent.** No committee `reachable` requirement; local workspaces allowed. |
| Workspace-proposed automations | `propose_automation` → pending → the user approves. Trusted workspaces auto-apply **low-risk** edits only (name, description, tags, prompt wording, schedule no faster than 5 min, disabling). New scripts, secrets, prompt targets, live mode, event triggers and re-enabling always need the user. Auto-applied edits still appear in Activity with Revert. |
| Authoring | **Claude-first.** "New automation" = describe it → the **dedicated automations workspace** (running the `automation-author` loadout; changeable per draft) drafts it in a fresh session → a draft card with Form/YAML views, "Ask for changes", Test run, Approve. A form with a YAML toggle is secondary. |
| Review help | "**Ask Claude about this**" on every review (loadout install/update, proposals, drafts) opens a review conversation beside the changes. Advice only. |
| Automations in loadouts | New `automations/` convention folder; synced through existing OCI sources + Update ↑; install review ticks = approval (**ticked = enabled at install**); `workspace: $self`; local edits kept + flagged on update. |
| Cost | **No pre-run cost estimates anywhere** (not reliably estimable). Real cost only, from actual runs. |
| Retention | Notification log 30 days. Proposals and the decisions on them kept permanently (audit). |
| Failures | A failed run is a **notification** (never a todo). |
| Post cap | Per workspace, default 60/hr; over-cap posts are **rejected** with a retry-after error plus one notification to the user. |
| Automations workspace | **The Inbox chip *is* the automations workspace**: no separate chip. Its terminal sessions open as tabs in the inbox view after Todos · Automations · Activity; the rails follow it when the Inbox is selected; the Inbox chip gets a ⋮ for managing that workspace (new session, edit env/secrets/image, restart, recreate). Manifest `role: 'automations'` (one per fleet, container-only) grants fleet-wide read over automations, runs and their results, plus propose-to-any, and it is **trusted automatically**. Bulk edits arrive as **one batch proposal** (per-item accept/decline; trusted auto-applies only the low-risk items, each with Revert). |
| UI entry | Inbox takes the **main pane**; entry is an **Inbox chip** after the workspace chips (workspace chip deselects while the inbox is open; rails keep the last workspace). |
| App icon | "**Teardrop**" outline starship (dark tile, ink outlines, app-green nacelle strips; simplified saucer + two nacelles at ≤24 px). |

## 4. Data model (`inbox.db`)

WAL, `user_version` migrations, and a **timestamped backup copy before every migration**, because this data is not rebuildable. Epoch-ms timestamps. Phase 1 tables are exact; later phases are sketches to be finalized in their plans.

```sql
-- Phase 1
CREATE TABLE todos (
  id            TEXT PRIMARY KEY,          -- ULID
  title         TEXT NOT NULL,
  body          TEXT,                      -- markdown
  status        TEXT NOT NULL CHECK (status IN ('open','done','dismissed')),
  priority      TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('user','workspace','automation')),
  source_id     TEXT,                      -- workspace / automation ULID; NULL for user
  source_run_id TEXT,                      -- Phase 3+
  via_workspace TEXT,                      -- workspace that did the work for an automation run
  dedupe_key    TEXT,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  recurred      INTEGER NOT NULL DEFAULT 0,
  workspace_id  TEXT,                      -- "jump to" link
  session_id    TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE UNIQUE INDEX todos_dedupe ON todos (source_kind, IFNULL(source_id,''), dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX todos_open ON todos (status, priority, last_seen_at);

CREATE TABLE tags (entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, tag TEXT NOT NULL,
                   PRIMARY KEY (entity_kind, entity_id, tag));       -- tag lowercased, [a-z0-9._-]{1,40}

CREATE TABLE todo_events (                                           -- append-only history
  id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id TEXT NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- created | seen | reopened | status | priority | tag_add | tag_remove | body_append
  actor_kind TEXT NOT NULL, actor_id TEXT, run_id TEXT, detail TEXT  -- detail: JSON
);

-- Phase 2 (sketch)
-- notifications(id, ts, title, body, priority, source_kind, source_id, todo_id, kind['post'|'input-wait'|'run-failed'|'digest'|'proposal'],
--               delivered, held_reason ['rule:<id>'|'downtime:<id>'|'pause'], cleared_at)   -- pruned after 30 days
-- notification_rules(id, scope_kind['key'|'source'|'tag'|'global'], scope_value, level, snooze_until)
-- downtimes(id, name, enabled, days_mask, start_min, end_min, bypass ['none'|'urgent'|'urgent+input'])
-- pause state lives in config.json: { until | null, letUrgent, setAt }
-- Phase 3+ (sketch)
-- automations(id, name, description, enabled, version, definition JSON, origin JSON, created_by, approved_at)
-- automation_versions(automation_id, version, definition JSON, approved_by, approved_at)
-- automation_state(automation_id, state JSON)            -- FLEET_STATE blob, size-capped
-- runs(id, automation_id, version, trigger JSON, args JSON, status, started_at, ended_at)
-- step_runs(run_id, step_id, status, exit_code, stdout_tail, stderr_tail, session_id, started_at, ended_at)
-- proposals(id, proposer_workspace, automation_id, kind['new'|'change'|'draft'], definition JSON, base_version,
--           rationale, risk JSON, status['pending'|'approved'|'rejected'|'superseded'|'auto-approved'], note, decided_at)  -- kept forever
```

**Dedupe algorithm (Phase 1, pure + unit-tested):** given `(source, key)` → if no row, insert. Otherwise: `seen_count++`, `last_seen_at=now`, `priority=max(old,new)`, append a `seen` event carrying the new body. If `status ∈ {done, dismissed}`, set `status=open`, `recurred=1`, `closed_at=NULL`, and append a `reopened` event. Returns `{id, action: 'created'|'updated'|'reopened'}`.

## 5. Notification policy (Phase 2)

- **Resolution (pure function):** for a request (priority, source, key, tags), find the most specific matching rule (key > source > tag > global default) whose snooze hasn't expired → level gate. Then the active **pause** (most recent explicit action wins over a downtime's bypass), then the active **downtime** with its bypass → `deliver` or `hold:<reason>`.
- **Delivery:** window focused → in-app toast (existing `.toast`). Otherwise → OS notification (Electron `Notification`); a click focuses the app on the item. No OS toast action buttons in v1 (platform-inconsistent).
- **Interruptions:** only a *new urgent* item flashes the taskbar (`flashFrame`) or bounces the dock; holds suppress these too.
- **"Needs you" count:** recomputed on every change → Windows `setOverlayIcon` (dot or count image), macOS `app.dock.setBadge(count)`, Tray image (dot) + tooltip. Linux badge support varies, so the Tray is authoritative there.
- **Digest:** when a pause or downtime ends with ≥1 held item → one summary notification ("6 held: 1 needs input, 5 todos") → Activity. Held items stay marked `held`.
- **Needs-input:** `setInputWaitHandler`'s existing per-workspace waiting set feeds a debounced (~20 s) host notification when the user isn't on that workspace; `waiting=false` clears it.

## 6. Automations (Phases 3–7)

Definition (stored as JSON, edited/displayed as YAML):

```yaml
name: webex-triage
description: Pull new #ops-alerts messages and turn real asks into todos
tags: [webex, ops]
triggers:
  - schedule: { cron: "*/30 8-18 * * 1-5", tz: America/New_York, args: { channel: ops-alerts } }
  - manual: { allowFrom: [<workspace-id>] }
  - event: { on: session.idle, workspace: <id>, debounce: 2m }    # Phase 4
concurrency: skip          # skip | queue
timeout: 10m
secrets: [WEBEX_TOKEN]     # vault keys, explicit
params:
  - { name: channel, type: string, required: true, description: WebEx room to scan }
steps:
  - id: fetch
    script: { run: fetch-webex.sh, timeout: 2m }                  # Phase 7
  - id: triage
    prompt: { workspace: <id> | $self, mode: fresh | live, wait: true, ensureRunning: true,
              message: "New messages:\n{{steps.fetch.stdout}}\nPost a todo for each real ask…" }
```

- **Templating** (`{{args.*}}`, `{{steps.<id>.stdout}}`, `{{trigger.*}}`) only in prompt messages, never in script text. Workspace-supplied args are wrapped in a labeled "caller-supplied input" block.
- **Run lifecycle:** `running` → `succeeded` | `nothing-to-do` (exit 10) | `failed` | `timed-out` | `skipped` | `cancelled`; on startup, `running` → `interrupted`. Each prompt step links its session; run cost = the sum of the linked sessions' priced cost.
- **Attribution:** todos posted by a prompted workspace during an active run are attributed `source=automation:<id>`, with `source_run_id` and `via_workspace`. The host validates that the run is active and targets that workspace.
- **Guard rails:** one catch-up run for missed schedules; event debounce; an automation is never triggered by its own output; per-automation rate cap (default 1 run/min); failure → notification.
- **Errors:** target not running → `ensureRunning` starts it (`startWorkspace` + `waitForBrokerReady`), else `target-not-running`; Docker degraded → `docker-unreachable` for containers (local targets still run); timeout → kill the tree / end the session; malformed stdout JSON lines → kept as text, a warning on the step.

## 7. Authoring, review & loadouts (Phases 5, 6, 8)

- **Automations workspace:** a container workspace created on first use, running the `automation-author` loadout (definition format, stdout protocol, exit-10, testing), marked `role: 'automations'` (one per fleet). **Trusted automatically.** It is the default drafter (changeable per draft) and the host for review conversations. It has **no chip of its own; the Inbox chip is its chip.** Its interactive sessions open as tabs in the inbox view (after Todos · Automations · Activity, with `+`). With the Inbox selected, the left rail's Sessions list and the Observability rail show this workspace. A session there can answer questions across all automations ("which failed this week and why"), using the role's fleet-wide read, and make **bulk changes** as one batch proposal: an Activity card listing each change with per-item Accept/Decline and **Apply accepted**. Trusted auto-applies only the low-risk items (each with Revert); anything touching scripts, secrets, targets or start-up behavior (e.g. `ensureRunning`) waits for the user. The Automations tab also offers **Open session** and, with several automations selected, **Ask Claude about N selected** (opens a session seeded with those automations). A waiting-for-input session here counts as "needs you" like any workspace.
- **Drafts:** a composer (description + drafter + requestable secrets) → a fresh session drafts → a `proposals(kind='draft')` card with Form | YAML views, "Ask for changes…" (re-drafts in the same session), **Test run** (runs once, without a schedule; todos and notifications go to a scratch view, never the inbox), Approve / Discard.
- **"Ask Claude to change…"** on an existing automation → a change proposal (diff) → approve.
- **Ask Claude about this:** the review widens to two columns; a fresh session in the automations workspace receives the current version, local edits, the incoming version, both diffs, scripts, secrets / targets and frequency, **as labeled data under review**. It opens with what changes / your edits / security (secrets, hosts, commands, injection surface) / noise / recommendation, and can send a merged version back as a proposal. It can never approve or take updates. "Open as session" continues in a full tab.
- **Loadouts:** `automations/<name>/automation.yaml` plus scripts, as a new convention folder (the parse in `loadoutCore.ts`; layers already ride the OCI artifact format, since each file is one layer). The install review gains an "Automations · turn on with this install" section (ticked by default; a missing secret → unticked and disabled with "add the secret to turn on"). `workspace: $self` binds to the install target; secrets resolve from its vault; two installs → two copies with `origin {loadoutId, version, workspaceId}`. Update → per-automation Keep mine / Take update / Diff; new automations arrive unticked. Uninstall → disable + remove (history kept). Export: "Save as loadout…" / "Add to loadout". **Cross-repo:** `claude-fleet-loadouts` `README.md` and the `loadout-author` guide document the folder, and the new `automation-author` loadout lands in the same change.

## 8. UI (component map)

1. **Inbox chip** (`WorkspaceTabStrip.tsx`): a compact `.ws-chip-group` after the workspace chips. The dot is red (urgent) / violet (approval) / grey; the sub-line is "7 open · 1 urgent" or "paused · until 15:30" with a bell-off glyph. Selecting it shows the inbox in the main pane and drops the workspace chip's active outline. From Phase 5 it fronts the automations workspace: a ⋮ menu (New session · Edit workspace… · Restart · Recreate with latest image), and the rails follow that workspace.
2. **InboxView** (new; main pane): a `session-tab-strip` with Todos · Automations · Activity (+ counts; Activity's in violet), then (Phase 5) a divider and the automations workspace's **terminal session tabs** (reusing `TerminalPane` session tabs: rename, ⋮, busy/waiting dots, `+`), and the **notify control** ("Notifying · Nights at 22:00 ▾" → menu with a state line, durations, let-urgent-through, Downtime schedules…; while paused: Resume / Extend 30m / Extend until 17:00 / Change end time).
3. **Todos:** status tabs, search, Source / Tags / Workspace filters; a list grouped by priority with colored left edges; rows with source · age · seen-count · recurred · tags, plus 🔔 and jump; a permanent detail pane (chips, title, Done / Dismiss / Notifications / priority, key-value block, body, history timeline). The **🔔 popover** has scope tabs, levels, snooze, and the current effective rule.
4. **Automations:** a list (switch, trigger summary, next fire, last-run chip, tags) + a detail pane (ask bar, Run now…, Edit ▾ [form, YAML, Save as loadout, Add to loadout], 🔔, tags, provenance line + Update ↑, week stats, triggers, steps with secrets, params, expandable runs). **Run modal** generated from params.
5. **Activity:** Everything / Needs approval / Notifications / Held back; proposal and draft cards; auto-approved lines with Revert; the notification log with held reasons.
6. **Desktop presence:** Teardrop app icon (`.ico` / `.icns` / `.png` set + `icon` in `electron-builder.yml`), Windows overlay, macOS dock badge, **Tray** (icon + dot, tooltip, menu: Open Inbox, Open Admiral, pause items mirroring the notify-control menu, next scheduled automation, Quit).
7. **Settings › Notifications** (a new `SettingsModal` tab): Notify me for; Keep running in the background (**off by default**; a one-time prompt on the first window close while automations are enabled); Downtime (week view + schedules + Add); Rules table; OS permission row + Send a test.
8. **Edit workspace › Inbox & automations** (a `WorkspaceForm.tsx` disclosure after Committee access): Can post (+ posts/hour), Trusted for low-risk automation edits (with the in-place consent note), Can read the whole inbox.

## 9. MCP & IPC surface

New tools on the existing per-workspace socket. **No caller-identity argument**; `ctx.callerId` is host-stamped. Effects are injected from `ipc.ts` via `set…Handler`, as `signal_input_wait` / committee do.

| Tool | Phase | Gate |
|---|---|---|
| `post_todo({title, body?, priority?, key?, tags?, workspace_link?, session_link?, notify?, run_id?})` → `{id, action}` | 1 | `inbox.canPost` (default true) + hourly cap (reject with `retryAfterMs`) |
| `update_todo({id, status?, priority?, tags_add?, tags_remove?, body_append?})` | 1 | only todos this workspace sourced (or that came from a run it executed) |
| `list_todos({status?, tags?, limit?})` | 1 | own-sourced + linked to this workspace; everything with `inbox.canReadAll` |
| `notify({title, body?, priority, todo_id?})` | 2 | same as post |
| `list_automations()`, `run_automation({id, args?})` | 3 | automations it proposed / targets / is listed in `manual.allowFrom` |
| `propose_automation({definition, rationale})`, `propose_automation_change({id, patch, rationale} \| {batch: [{id, patch}], rationale})`, `get_proposal({id})` | 5 | any workspace; never self-approves |
| `get_automation({id})`, `list_runs({automation_id?, status?, since?, limit?})` | 5 | own/targeted automations; **all** for `role: 'automations'` |

Phase 1 IPC (renderer → main; `window.api.inbox.*`): `inbox:listTodos(filter)`, `inbox:getTodo(id)` (+ events), `inbox:createTodo(input)` (source `user`), `inbox:updateTodo(id, patch)`, `inbox:counts()`; push `inbox:changed`. Later phases add `notifications:*`, `automations:*`, `proposals:*`, `tray:*`, to be fixed in their plans.

## 10. Security (SPEC §9 amendment)

- MCP gains **host-mediated writes** for inbox, notifications and proposals only, each rate-capped, with an unforgeable source (ambient socket identity). The scheduler, definitions, rules, grants and approvals are never reachable from a workspace.
- The new manifest block `inbox?: { canPost?: boolean; maxPostsPerHour?: number; trusted?: boolean; canReadAll?: boolean }` must be added to **both** `WorkspaceSpec` **and** the strict allowlist constructor in `readWorkspaceManifest` (otherwise it vanishes on round-trip), sanitized on read, and merged on write (`workspace:writeManifest` already merges).
- **Local-workspace caveat** (as with committee identity): a local workspace's derived identity is spoofable on the host. For posting todos this is accepted (low impact; the source is labeled best-effort for local). Proposals from local workspaces are allowed (they still need approval), but local workspaces can't be **trusted** (no auto-approve).
- Proposal, draft and loadout content shown to a reviewing Claude is passed as labeled data; reviewer output is advisory.
- `role: 'automations'` lives in the host-private manifest (type + allowlist constructor, like `inbox`). The host enforces at most one per fleet and container-only. The role widens **read** and **propose** reach; it never grants approval, scheduler access, or another workspace's secrets.
- Script args are env-only; secrets are only the declared vault keys and never params.

## 11. Testing

- **Pure units:** dedupe/reopen, the tag normalizer, rule resolution (specificity, snooze expiry, pause-vs-downtime precedence, bypasses), "needs you" count, `classifyChange`, param validation, cron next-fire + single catch-up, the self-trigger loop guard, the stdout JSON-lines parser, cap accounting.
- **Repository tests** against a real SQLite file (note: the bs3 ABI recipe in the run-unit-tests memory; run both `tsconfig` typechecks separately).
- **MCP contract tests**, unit (`mcpServer.test.ts`) **and** e2e (`tests/mcp-*.spec.ts`).
- **Mock fleet** (`CLAUDE_FLEET_MOCK=1`) gains fake todos, automations and notifications for UI iteration. UI is verified on the host (no display in the container).

## 12. Open questions

1. **Script execution environment** (blocks Phase 7). Candidates: a dedicated runner container (the automations workspace is the natural candidate), the host, inside a chosen workspace, or an ephemeral container per run. `ScriptExecutor` keeps Phases 1–6 independent of this.
2. **Icon / name timing:** the Teardrop icon and "Admiral" strings in the tray and toasts assume the rename (#364). Until it ships, use "claude-fleet" for strings and ship the icon either way.

## 13. Phase 1 — inputs for the plan

- **Main:** `src/main/inbox/` with `inboxDb.ts` (open, migrate + backup, repository), `inboxCore.ts` (pure: dedupe, tag normalize, filter), `inboxPolicy.ts` (pure: post permission + cap). Wire into `ipc.ts` (handlers + `inbox:changed` broadcast) and `mcpServer.ts` (three tools via a `setInboxHandlers` injection).
- **Manifest:** `inbox` block in `workspaces.ts` (type + allowlist constructor + sanitize).
- **Preload:** `window.api.inbox` (typed).
- **Renderer:** Inbox chip in `WorkspaceTabStrip.tsx`, `InboxView.tsx` (Todos tab only in P1; the Automations/Activity tabs hidden until their phases), `TodoList.tsx`, `TodoDetail.tsx`, "+ Add todo"; Edit-workspace disclosure (can post + cap only in P1). CSS from existing tokens (classes mirrored from the mocks).
- **Tests:** units for `inboxCore` / `inboxPolicy`, a repository test, MCP unit + e2e contract, an e2e smoke for the chip → inbox → add todo in mock mode.
- **SPEC.md:** §6 IPC (`inbox:*`), §7 data model (`inbox.db`, manifest `inbox` block), §8 user flow (inbox), §9 security (MCP host-mediated writes), §11 fleet-state MCP tool list, all in the same commit as the code.
