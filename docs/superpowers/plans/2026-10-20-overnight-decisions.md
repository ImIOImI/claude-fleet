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
