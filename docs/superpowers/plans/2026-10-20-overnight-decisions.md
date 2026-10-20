# Overnight build — decision log (2026-10-20)

Autonomous build of the inbox / automations feature (#407, design in
`docs/superpowers/specs/2026-10-20-inbox-automations-design.md`). Every call I
made without asking is listed here, newest last, with where it lives so it can
be undone. Mandate: as many phases as possible, merge on green CI, bump to
v0.14.0, CI-runnable e2e, no release.

| # | Phase | Decision | Why | Where / how to undo |
|---|---|---|---|---|
| 1 | — | Script steps run in the automations workspace container by default; opt-in `runIn: host` (decided with Troy before bed). | Troy's pick. | spec §3 decision log |
| 2 | — | Automations workspace defaults to the **devops** image; no automation-specific image. A `fleet-emit` stdout-protocol helper ships in the **base** runner image (Phase 7). | devops already covers log/API/cloud checks; base is too thin (no python3/gh/yq); a 4th image is extra build/publish/pin cost with ~90% overlap. | spec §7; workspace default in the automations-workspace bootstrap |
| 3 | 1 | Inbox code lives in its own `src/main/inbox/` module with its own `registerInboxIpc()`, not inside the 2,200-line `ipc.ts`. | Keeps the new subsystem testable and reviewable; same small-module pattern as the broadcast helpers. | `src/main/inbox/` |
| 4 | 1 | `inbox.db` opens in **mock mode too** (state.db does not). | The inbox is authoritative and needed for UI e2e in mock mode. | `src/main/index.ts` |
| 5 | 1 | Shared inbox types live in `src/preload/inboxTypes.ts`; main type-imports them. | Repo precedent (`ipc.ts` type-imports from preload); avoids duplicate type sets. | `src/preload/inboxTypes.ts` |
| 6 | 1 | A dedupe hit **replaces the body** with the newer body (when given), unions tags, keeps the title; the old body stays in the `seen` event. | Latest detail is what you act on; history keeps the rest. | `inboxDb.ts` `post()` |
| 7 | 1 | `post_todo` links the todo to the posting workspace by default (`workspace_id` = caller), so "jump to" works with no extra arg. | Every workspace post is about that workspace unless it says otherwise. | `inboxService.ts` |
| 8 | 1 | Over-cap posts in Phase 1 are rejected + logged (`inbox-post-rejected` in the error log); the "one notification to you" part arrives with Phase 2 notifications. | Notifications don't exist yet in Phase 1. | `inboxIpc.ts` |
| 9 | 1 | Executed plans inline (not subagent-driven) since Troy is asleep and can't pick. | Faster, single context. | — |
| 10 | 1 | Edit-workspace Phase 1 shows only "Can post" + "Posts per hour"; Trusted / Read-all switches arrive with the phases that use them. | YAGNI: no behavior behind them yet. | `WorkspaceForm.tsx` |
| 11 | 1 | Added `src/preload/inboxTypes.ts` to `tsconfig.web.json` include. | The composite web project must list a preload file imported by `preload/index.ts` (TS6307). | `tsconfig.web.json` |
| 12 | 1 | `mcpLocalBridge.run.test.ts` flakes under full-suite load locally (passes 4/4 alone); untouched by this work, left as is. | Pre-existing timing test; CI is the authority. | — |
| 13 | 2 | Split Phase 2 into **2a** (notification engine + UI) and **2b** (tray, taskbar overlay, dock badge, app icon, keep-running-in-tray) as separate PRs. | Phase 2 is roughly twice Phase 1; smaller PRs are easier to review and revert. | plans/2026-10-20-notifications-phase2a.md |
| 14 | 2a | Phase 2+ plans list interfaces, behaviors and test cases rather than full code for every step (Phase 1's plan had full code). | Same agent plans and executes tonight; the code + tests in the PR are the source of truth. | plans/ |
| 15 | 2a | Default global notification level = **All** (honour a poster's explicit request unless capped). | "Poster asks, you cap": a default of High-and-up would silently hold every normal-priority request, e.g. the water reminder. | Settings › Notifications › Notify me for |
| 16 | 2a | A todo **created or reopened at urgent** raises a notification request even without `notify: true`. | Matches the mocked "URGENT · prod-api…" toast; urgent means interrupt-worthy. | notifyService `onTodoPosted` |
| 17 | 2a | Notification settings (rules, downtimes, pause, default level) live in `inbox.db`, not `config.json`. | Authoritative, queried together, already-migrated store. | inbox.db schema v2 |
| 18 | 2a | Several matching tag rules → the **strictest** level wins. | Muting a tag should never be overridden by another tag's louder rule. | notifyPolicy |
| 19 | 2a | Downtime uses host local time; a window with end ≤ start wraps past midnight and belongs to the day it starts. | "Nights 22:00–07:00 every day" must just work. | notifyPolicy `downtimeWindowAt` |
| 20 | 2a | Version stays **0.14.0** for every phase merged tonight. | You asked for 0.14.0; no release is cut between phases, so per-phase bumps would just be noise. | package.json |
| 21 | 2a | Settings › Notifications saves each change immediately (no Save button), unlike the main Settings tab. | Rules are also edited live from the 🔔, so a batch-save tab would show stale state. | NotificationsSettings.tsx |
| 22 | 2a | `post_todo`/`notify` validate input **before** the rate gate. | A malformed post shouldn't use up the workspace's hourly allowance. | inboxService.ts |
| 23 | 2a | The 🔔 popover offers only the first tag as a scope; other tags are reachable from Settings later. | Mirrors the approved mock; keeps the popover small. | notifyService.scopesFor |
| 24 | 2b | App icon lives at `resources/icon.png` (electron-builder `icon:`), not `build/icon.png`. | `build/` is gitignored in this repo. | electron-builder.yml |
| 25 | 2b | Tray/overlay PNGs are pre-rendered (28 files, `scripts/icons/`) and shipped via `extraResources`, not drawn at runtime. | Counts need text rendering; pre-rendered PNGs are crisp and testable (an asset-existence unit test). | resources/presence/ |
| 26 | 2b | The tray exists whenever the app runs (not only with keep-running on). | The dot is the reliable signal on Linux and a pause entry point everywhere. | presence.ts |
| 27 | 2b | The one-time "keep Admiral running so automations fire?" prompt on first close is deferred to Phase 3. | There are no automations yet to justify it. | — |
| 34 | 2a | **Bug caught by Windows CI:** in a narrow window the 🔔 popover slid under the left rail, which swallowed clicks. Fixed by portaling it to `document.body` with fixed, viewport-clamped positioning (flips above near the bottom), the same approach as the existing chip menus. | Real UI bug at small window sizes, not just a test issue. | BellPopover.tsx, notifyView.bellPosition |
