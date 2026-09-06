# Admiral Rename — Phase 1 (Brand Strings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every zero-risk user-visible *product-name* occurrence of `claude-fleet` to **Admiral**, with no behavior change, no rebuild, and no migration.

**Architecture:** Pure display-string edits across the main process, the renderer, the Go broker log prefix, and docs prose. One task carries a real TDD cycle (the MCP listener-error message has a unit test that pins its copy); the rest are display strings with no meaningful test surface, so they are verified by targeted grep + `typecheck`/`build` rather than new tests. This is deliberate: the entire value of Phase 1 is that it is provably low-risk.

**Tech Stack:** Electron main (TypeScript), React renderer (TSX), Go broker, Markdown docs. Verified with `npm run typecheck`, `npm run test:unit`, `npm run build`, and `go build`/`go test` in `broker/`.

**Tracking:** Implements issue #365 (sub-issue of #364). Design doc: `docs/superpowers/specs/2026-08-26-admiral-rename-design.md`.

## Global Constraints

- **Display name is exactly `Admiral`** (capitalized) in prose, titles, and messages. Use lowercase `admiral` ONLY where the surrounding element is already lowercase by style (the first-run eyebrow).
- **KEEP the common noun "fleet"** everywhere it correctly describes the actual fleet of workspaces (left-rail "Fleet" label, "Fleet root", "cost across the fleet", "fleet tools"). This plan never touches those — the rename is a *promotion, not a find-replace*.
- **Frequent commits:** one commit per task.
- **Execution isolation:** run this plan in its own git worktree/branch off `main` (via superpowers:using-git-worktrees). Do NOT reuse the `worktree-admiral-rename-spec` branch — that is the docs-only PR #369.

### OUT OF SCOPE for Phase 1 — do NOT touch these (later phases own them)

Leaving these unchanged is a **requirement**, not an oversight. A grep for `claude-fleet` will still match them after this phase — that is expected.

| Surface | Example | Owned by |
|---|---|---|
| MCP server name `claude-fleet-state` | `App.tsx:429`, `WorkspaceForm.tsx:678`, `mcpListenerError.ts` `(claude-fleet-state)` | Phase 4 (#368) |
| `~/.config/claude-fleet/…` userData paths | `CloseWorkspaceModal.tsx:129` | Phase 2 (#366) |
| `ghcr.io/…/claude-fleet/runner` image refs | `WorkspaceForm.tsx:106`, `TerminalSession.tsx:847`, `README.md:198,201,207` | Phase 3 (#367) |
| Repo URLs / badge links | `README.md:7–10` | Phase 3 (#367) |
| Container labels `com.claude-fleet.*`, code comments | `docker.ts`, `index.ts:65` comment | Phase 3 (#367) / n/a |

---

### Task 1: Main-process display strings (window title + error-log prefix)

**Files:**
- Modify: `src/main/index.ts:93` (BrowserWindow title)
- Modify: `src/main/index.ts:137` (startup error-log console line)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks (pure string literals).

- [ ] **Step 1: Change the window title**

In `src/main/index.ts`, the `createWindow()` `BrowserWindow` options (currently line 93):

```ts
    title: 'claude-fleet',
```

becomes:

```ts
    title: 'Admiral',
```

- [ ] **Step 2: Change the startup error-log console prefix**

In `src/main/index.ts` (currently line 137):

```ts
  console.log(`[claude-fleet] error log: ${getLogPath()}`);
```

becomes:

```ts
  console.log(`[Admiral] error log: ${getLogPath()}`);
```

- [ ] **Step 3: Verify both edits landed and nothing else in this file changed**

Run: `grep -n "title: 'Admiral'\|\[Admiral\] error log" src/main/index.ts`
Expected: two matches (lines ~93 and ~137).

Run: `git diff --stat src/main/index.ts`
Expected: `1 file changed, 2 insertions(+), 2 deletions(-)`. (The `claude-fleet` mentions in the comment at line ~65 are intentionally untouched — code comments are out of scope.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "rename: window title + error-log prefix → Admiral (#365)"
```

---

### Task 2: First-run landing, reconnect toast, and tab-strip title (renderer)

**Files:**
- Modify: `src/renderer/src/App.tsx:1577` (first-run eyebrow)
- Modify: `src/renderer/src/App.tsx:1579` (first-run heading)
- Modify: `src/renderer/src/App.tsx:1524` (Docker-down reconnect message)
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx:154` (tab-strip product title)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (JSX text nodes only).

- [ ] **Step 1: Confirm no test pins these strings**

Run: `grep -rn "claude fleet\|Command a fleet\|claude-fleet will reconnect" src/renderer --include=*.test.ts --include=*.test.tsx`
Expected: no output (no test asserts this copy — safe to edit directly).

- [ ] **Step 2: Change the first-run eyebrow**

In `src/renderer/src/App.tsx` (line ~1575–1578):

```tsx
        <span className="eyebrow">
          claude fleet
        </span>
```

The eyebrow text `claude fleet` becomes `admiral` (lowercase — the eyebrow is styled lowercase/small-caps):

```tsx
        <span className="eyebrow">
          admiral
        </span>
```

- [ ] **Step 3: Change the first-run heading (drops "Claude" for agent-agnosticism)**

In `src/renderer/src/App.tsx` (line ~1579):

```tsx
        <h1>Command a fleet of Claude agents.</h1>
```

becomes:

```tsx
        <h1>Command a fleet of agents.</h1>
```

> **Copy decision (recommended, flag for Troy in the PR):** dropping "Claude" from the hero headline is the point of the rebrand (agent-agnostic). "fleet" stays — it's the correct common noun. If Troy prefers to keep "Claude agents" for now, revert just this line; the rest of the task stands.

- [ ] **Step 4: Change the Docker-down reconnect message**

In `src/renderer/src/App.tsx` (line ~1524):

```tsx
        Start Docker Desktop (with WSL2 integration on Windows). claude-fleet will reconnect
```

becomes:

```tsx
        Start Docker Desktop (with WSL2 integration on Windows). Admiral will reconnect
```

- [ ] **Step 5: Change the tab-strip product title**

In `src/renderer/src/components/WorkspaceTabStrip.tsx` (line ~154):

```tsx
          <span className="title">claude-fleet</span>
```

becomes:

```tsx
          <span className="title">Admiral</span>
```

- [ ] **Step 6: Verify the edits and that MCP-name / registry strings were left alone**

Run: `grep -n "admiral\|Admiral\|Claude agents\|claude-fleet will reconnect" src/renderer/src/App.tsx`
Expected: `admiral` (eyebrow), `Admiral will reconnect`; NO `Claude agents`, NO `claude-fleet will reconnect`.

Run: `grep -n "claude-fleet-state" src/renderer/src/App.tsx`
Expected: still present at line ~429 (the MCP-name toast — intentionally untouched, Phase 4).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/WorkspaceTabStrip.tsx
git commit -m "rename: first-run hero, reconnect toast, tab-strip title → Admiral (#365)"
```

---

### Task 3: MCP listener-error message product name (TDD)

The EADDRINUSE message names the likely culprit — "another claude-fleet instance". That is a product-name reference (→ Admiral). The same message also contains `claude-fleet-state` (the MCP name) which **stays** (Phase 4). A unit test pins this copy, so this task is a real red→green cycle.

**Files:**
- Modify: `src/main/mcpListenerError.test.ts:39,43` (comment + assertion)
- Modify: `src/main/mcpListenerError.ts:62` (the TCP EADDRINUSE message)

**Interfaces:**
- Consumes: existing `describeListenerError(where, err)` — unchanged signature.
- Produces: nothing new; only the message text changes.

- [ ] **Step 1: Update the failing test assertion first**

In `src/main/mcpListenerError.test.ts`, the TCP EADDRINUSE test (lines ~38–43) currently asserts the message mentions `claude-fleet`. That assertion passes trivially even after the rename because the message still contains `claude-fleet-state`. Retarget it to the *product name* so it actually pins the new copy. Change:

```ts
    // Actionable: the message must say which port and point at the real culprit
    // (another claude-fleet instance already holding it) so the user isn't left
    // guessing why MCP shows "Failed to connect".
    expect(out.message).toContain('7071');
    expect(out.message.toLowerCase()).toContain('already in use');
    expect(out.message.toLowerCase()).toContain('claude-fleet');
```

to:

```ts
    // Actionable: the message must say which port and point at the real culprit
    // (another Admiral instance already holding it) so the user isn't left
    // guessing why MCP shows "Failed to connect".
    expect(out.message).toContain('7071');
    expect(out.message.toLowerCase()).toContain('already in use');
    expect(out.message.toLowerCase()).toContain('another admiral instance');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/mcpListenerError.test.ts`
Expected: FAIL — the "names the port and the likely cause" test fails because the current message says "another claude-fleet instance", not "another Admiral instance".

- [ ] **Step 3: Update the message source**

In `src/main/mcpListenerError.ts`, the TCP branch of the EADDRINUSE message (line ~62). Change only the product-name phrase; leave `(claude-fleet-state)` — that is the MCP name (Phase 4):

```ts
        ? `MCP host listener could not bind 127.0.0.1:${where.port} (EADDRINUSE): the port is already in use, ` +
          `most likely by another claude-fleet instance still running. In-container MCP (claude-fleet-state) ` +
          `will show "Failed to connect" until the stale instance is closed. Original: ${raw}`
```

becomes:

```ts
        ? `MCP host listener could not bind 127.0.0.1:${where.port} (EADDRINUSE): the port is already in use, ` +
          `most likely by another Admiral instance still running. In-container MCP (claude-fleet-state) ` +
          `will show "Failed to connect" until the stale instance is closed. Original: ${raw}`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/mcpListenerError.test.ts`
Expected: PASS (all 5 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpListenerError.ts src/main/mcpListenerError.test.ts
git commit -m "rename: MCP bind-error names 'another Admiral instance' (#365)"
```

---

### Task 4: Broker log prefix (Go)

**Files:**
- Modify: `broker/cmd/broker/main.go:56` (`defaultLogPrefix`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (log-line cosmetic).

- [ ] **Step 1: Confirm no Go test pins the prefix**

Run: `grep -rn "claude-fleet-broker" broker/`
Expected: only `broker/cmd/broker/main.go:56` (no test asserts it — safe to edit).

- [ ] **Step 2: Change the log prefix**

In `broker/cmd/broker/main.go` (line ~56):

```go
	defaultLogPrefix   = "claude-fleet-broker: "
```

becomes:

```go
	defaultLogPrefix   = "admiral-broker: "
```

- [ ] **Step 3: Build the broker**

Run: `cd broker && CGO_ENABLED=0 go build -o /tmp/admiral-broker ./cmd/broker`
Expected: builds with no error.

- [ ] **Step 4: Run the broker tests (no regressions)**

Run: `cd broker && go test ./...`
Expected: PASS (tests use `/bin/cat` as a claude stand-in; no creds needed).

- [ ] **Step 5: Commit**

```bash
git add broker/cmd/broker/main.go
git commit -m "rename: broker log prefix admiral-broker (#365)"
```

---

### Task 5: Docs prose (README, SPEC.md, CLAUDE.md)

Change only *product-name* prose. **Keep** every URL, badge link, `ghcr.io/…` registry ref, `assets/…` image path, and `~/.config/claude-fleet` path (Phases 2/3).

**Files:**
- Modify: `README.md:3,5,16,22,24,112`
- Modify: `docs/SPEC.md:1,3`
- Modify: `CLAUDE.md:1`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: README — title and tagline**

`README.md` line 3:

```markdown
# 🚢 claude-fleet
```

becomes (anchor emoji for the naval-command frame; the ship emoji is fine too — cosmetic):

```markdown
# ⚓ Admiral
```

`README.md` line 5:

```markdown
### Command a fleet of Claude agents — from one window.
```

becomes:

```markdown
### Command a fleet of agents — from one window.
```

- [ ] **Step 2: README — image alt, section heading, body prose**

`README.md` line 16 (change the alt text only, keep the `assets/…` path):

```markdown
![claude-fleet welcome screen](assets/design/first-run/01-landing-desktop.png)
```

becomes:

```markdown
![Admiral welcome screen](assets/design/first-run/01-landing-desktop.png)
```

`README.md` line 22:

```markdown
## Why claude-fleet?
```

becomes:

```markdown
## Why Admiral?
```

`README.md` line 24 (product-name mention only; the factual "Claude Code session" reference stays — it accurately names the agent that runs today):

```markdown
Running one Claude Code session is great. Running **three to six at once** — each on its own task, in its own sandbox, without losing track of what any of them is doing or spending — is a different problem. claude-fleet is the operator console for exactly that.
```

becomes:

```markdown
Running one Claude Code session is great. Running **three to six at once** — each on its own task, in its own sandbox, without losing track of what any of them is doing or spending — is a different problem. Admiral is the operator console for exactly that.
```

`README.md` line 112 (product-name mention; keep the `docs/SPEC.md` link):

```markdown
- [`docs/SPEC.md`](docs/SPEC.md) — product spec. Single source of truth for what claude-fleet is, how it's built, and which decisions are pending. Start here if you're contributing.
```

becomes:

```markdown
- [`docs/SPEC.md`](docs/SPEC.md) — product spec. Single source of truth for what Admiral is, how it's built, and which decisions are pending. Start here if you're contributing.
```

- [ ] **Step 3: SPEC.md — title + intro, with a transition note**

`docs/SPEC.md` line 1:

```markdown
# claude-fleet — product spec
```

becomes:

```markdown
# Admiral — product spec

> Renamed from `claude-fleet`; the rebrand is rolling out in phases (see #364). Internal identifiers (image refs, container labels, the `claude-fleet-state` MCP name) still use the old name until their phase lands.
```

`docs/SPEC.md` line 3:

```markdown
This document is the single source of truth for what claude-fleet is and how it's built. The bar is rebuild-from-spec: a competent engineer (or Claude) reading only this file should be able to rebuild a functionally equivalent application.
```

becomes:

```markdown
This document is the single source of truth for what Admiral is and how it's built. The bar is rebuild-from-spec: a competent engineer (or Claude) reading only this file should be able to rebuild a functionally equivalent application.
```

- [ ] **Step 4: CLAUDE.md — title**

`CLAUDE.md` line 1:

```markdown
# claude-fleet — project conventions
```

becomes:

```markdown
# Admiral — project conventions
```

- [ ] **Step 5: Verify remaining README `claude-fleet` matches are only URLs/registry/paths**

Run: `grep -n "claude-fleet" README.md`
Expected: matches remain ONLY on lines 7–10 (badge/release URLs) and lines 198/201/207 (`ghcr.io/…/claude-fleet/runner` registry refs). No prose product-name mention should remain.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/SPEC.md CLAUDE.md
git commit -m "docs: rename product name → Admiral in README/SPEC/CLAUDE prose (#365)"
```

---

### Task 6: Full gate + open PR

**Files:** none (verification + PR only).

- [ ] **Step 1: Run the unit gate**

Run: `npm run test:unit`
Expected: PASS (includes the updated `mcpListenerError.test.ts`).

- [ ] **Step 2: Typecheck both tsconfigs**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Build all bundles**

Run: `npm run build`
Expected: main + preload + renderer bundles compile with no error.

- [ ] **Step 4: Confirm nothing out-of-scope was touched**

Run: `git diff main --stat`
Expected: only these files — `src/main/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/components/WorkspaceTabStrip.tsx`, `src/main/mcpListenerError.ts`, `src/main/mcpListenerError.test.ts`, `broker/cmd/broker/main.go`, `README.md`, `docs/SPEC.md`, `CLAUDE.md`. No `docker.ts`, no `electron-builder.yml`, no `mcpServer.ts`, no `CloseWorkspaceModal.tsx`.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin <phase1-branch>
gh pr create --repo ImIOImI/claude-fleet --base main \
  --title "Admiral rename — Phase 1: brand strings (#365)" \
  --body "Closes #365. Part of #364.

Zero-risk product-name rename claude-fleet → Admiral across user-visible display strings only. No behavior change, no rebuild, no migration.

**Changed:** window title, error-log prefix, first-run hero (eyebrow + heading), Docker-down reconnect toast, tab-strip title, MCP bind-error culprit phrase, broker log prefix, README/SPEC/CLAUDE prose.

**Deliberately NOT changed (later phases):** the \`claude-fleet-state\` MCP name (P4), \`~/.config/claude-fleet\` paths (P2), \`ghcr.io/.../claude-fleet\` image refs + repo URLs (P3). 'fleet' as a common noun is kept throughout.

**Copy decision for review:** hero headline drops 'Claude' → 'Command a fleet of agents.' (agent-agnostic).

Gated with typecheck + test:unit + build in-container; needs a human to eyeball the running app on the host (no display in-container)."
```

- [ ] **Step 6: Note host verification**

Per project convention (no display in-container), the PR body asks Troy to eyeball on the host: window title bar, first-run landing (eyebrow "admiral" + headline), tab-strip title, and the Docker-down toast. Say so explicitly in the PR — do not claim UI-verified.

---

## Self-Review

**Spec coverage (against issue #365 checklist):**
- Window title → Task 1 ✅
- First-run landing (eyebrow, heading, CTA) → Task 2 (CTA has no product name, correctly untouched) ✅
- Close-workspace modal path → correctly deferred to Phase 2 (real userData path); documented in OUT OF SCOPE ✅
- Toasts + error dialogs → Task 2 (reconnect toast) + Task 3 (MCP bind error) ✅
- Console/error-log line → Task 1 ✅
- Broker log prefix → Task 4 ✅
- Docs (README/SPEC/CLAUDE) → Task 5 ✅
- KEEP common-noun "fleet" → enforced in Global Constraints + verified in Task 2/5 greps ✅
- Gate typecheck+unit+build → Task 6 ✅
- Two surfaces the issue's inventory missed (tab-strip title, reconnect toast) → folded into Task 2 ✅

**Placeholder scan:** no TBD/TODO; every code step shows exact before/after. ✅

**Type consistency:** no new types/signatures introduced; `describeListenerError` signature unchanged. ✅

**Scope:** single subsystem (display strings), one plan, independently shippable. ✅
