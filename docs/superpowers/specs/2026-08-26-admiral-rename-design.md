# Admiral — rename `claude-fleet` → Admiral — design

The app is becoming agent-agnostic; the name `claude-fleet` hard-codes an
assumption (Claude) that is no longer true. This renames the **product** to
**Admiral** and the state MCP server to **`fleet-state`**, while deliberately
*keeping* the word "fleet" everywhere it is used correctly as a common noun.

The core insight that keeps this cheap: **the rename is a promotion, not a
find-replace.** "Fleet" is the collection of agent workspaces the app commands;
"Admiral" is the thing that commands the fleet. So the architecture's existing
vocabulary (`fleetRoot`, "cost across the fleet", the Fleet scope toggle) stays
accurate and untouched. Only the *product name* occurrences of `claude-fleet`
change.

## Decisions (locked with the user)

| Area | Decision |
|---|---|
| Product name | **`claude-fleet` → Admiral.** Naval metaphor promoted from the ships (fleet) to their commander (admiral); drops "claude" for agent-agnosticism. |
| The word "fleet" | **Kept as a common noun.** All UI text describing the actual fleet of workspaces stays. This is the property that shrinks the blast radius. |
| MCP server name | **`claude-fleet-state` → `fleet-state`.** Drop `claude` *and* the brand; name it for what it is (state of the fleet). Survives even a future product rename. |
| MCP migration | **Aliased, not hard-cut.** Register `fleet-state` alongside `claude-fleet-state` for one release, migrate all callers, then drop the old name. It's a contract other things type. |
| Bare `admiral` MCP name | **Reserved, not used here.** The state server is the read-only observability+committee surface; leave the unqualified brand for a possible future action server. |
| Ownability / trademark | **Deferred.** Audience is "maybe a product someday"; SEO crowding of a generic word is a cost the timeline lets us postpone, and trademark is category-scoped, not a wall. |
| Rollout | **Phased by risk** (below). Zero-risk brand strings first; packaging/repo/registry next; the MCP contract last. |

## Why Admiral (rationale, for the record)

- **Solves the actual problem** — drops "claude", says nothing about *which*
  agent, commits to the orchestration layer (durable) rather than the payload
  (changes yearly).
- **Additive** — keeps "fleet" coherent instead of orphaning it as jargon.
- **Beat `agent-fleet`** — that option welds the product to the most saturated
  word in tech, keeps the `X-fleet` placeholder shape (reads transitional), is
  an unownable category noun, and collides with the common-noun "fleet" already
  in the UI. Admiral is a *name*; agent-fleet is a *description*. The
  description survives as a tagline: **"Admiral — command your fleet of
  agents."**

## User-visible surface inventory

The rename target is only *product-name* occurrences. Grouped by where a human
encounters them and by change cost. (Purely-internal identifiers — container
labels `com.claude-fleet.*`, env var names, IPC channel strings — are out of
scope for the *user-visible* rename and tracked separately under Phase 2/3.)

### HARD — build config, packaging, OS integration
- `electron-builder.yml` → `productName: claude-fleet` (installer name, Start-menu/dock label, window title)
- `electron-builder.yml` → `appId: com.troyknapp.claudefleet` (bundle id in Win/macOS system listings) — **changing this is an identity break for existing installs; see Migration note**
- `package.json` → `name` + `description`
- `Makefile` → installer output filenames (`dist/claude-fleet Setup <ver>.exe`, portable target)
- App icon / branding assets carrying the name

### HARD — distribution / registry (rebuild + re-push)
- Runner image ref `ghcr.io/imioimi/claude-fleet/runner:latest` (README + docker.ts)
- Loadout refs `ghcr.io/<owner>/claude-fleet-loadouts/<id>` (separate repo)
- GitHub repo names `claude-fleet` / `claude-fleet-loadouts` (the URL is a visible surface)
- CI artifact names `claude-fleet-<os>` + release-notes body (`build-app.yml`)

### MEDIUM — the one contract
- MCP server name `claude-fleet-state` → `fleet-state` (`mcpServer.ts:54`, referenced in `docker.ts`, skills, docs, and root `CLAUDE.md` as `mcp__claude-fleet-state__*`)

### EASY — plain strings (safe, reversible)
- Window title `src/main/index.ts:54`
- First-run landing (`App.tsx`): eyebrow "claude fleet", heading, CTA
- Left rail nav label; Settings "Fleet root (host path)"; Observability "Fleet · cost across N workspaces" + scope toggle *(these are correct common-noun uses — KEEP; listed so we consciously don't touch them)*
- Close-workspace modal path display
- Toasts + error dialogs (`mcpListenerError.ts` "another claude-fleet instance…")
- Console/error-log line `[claude-fleet] error log:` (`index.ts:97`)
- Broker log prefix `claude-fleet-broker:` (`broker/cmd/broker/main.go`)
- Docs: `README.md` (both repos), `docs/SPEC.md`, `CLAUDE.md`

**Count:** ~6 hard packaging + ~4 hard registry/repo + 1 contract + ~25 easy strings.

## Rollout — phased by risk

Each phase is independently shippable and leaves the app fully working.

- **Phase 1 — Brand strings (zero risk).** Every EASY surface: window title,
  UI copy, toasts, logs, docs. No behavior change, no migration, no rebuild.
  This is the bulk of the visible payoff for near-zero risk. *Explicitly keep
  the common-noun "fleet" UI text.*
- **Phase 2 — Packaging & OS identity.** `productName`, `package.json`,
  Makefile output names, icons. Decide `appId` (see Migration note). Produces
  installers that *say* Admiral.
- **Phase 3 — Registry & repos.** Rename/redirect GHCR image + loadout paths,
  CI artifact names, and the GitHub repos. Cross-repo; coordinate with
  `claude-fleet-loadouts`.
- **Phase 4 — MCP contract (`fleet-state`), last.** Register the new name
  aliased alongside the old, migrate every caller (skills, docs, `docker.ts`,
  root `CLAUDE.md`), ship one release with both, then remove
  `claude-fleet-state`. Existing workspaces' skills keep working across the
  transition.

## Migration notes

- **`appId` is a one-way door for existing installs.** Changing
  `com.troyknapp.claudefleet` makes the OS treat Admiral as a *different app*
  (new user-data dir, no auto-update continuity from old installs). Options: (a)
  keep the old `appId`, only change the display `productName` — cleanest for
  continuity; (b) change it and document a one-time reinstall. **Recommend (a)**
  unless there's a reason to sever old installs.
- **`userData` path** (`~/.config/claude-fleet/…`) is derived from the app name;
  if it changes, existing workspaces/manifests/vault/history don't carry over.
  Tie this decision to the `appId` decision — treat them as one call.
- **MCP alias window** is what makes Phase 4 non-breaking. Never rename the
  server without the overlap release.

## Verification

Per repo convention, UI changes are gated by `typecheck` + `test:unit` +
`build` in-container; a human eyeballs the actual app on the host (no display
here). Additionally:
- Phase 4: the MCP tool surface is pinned by `mcpServer.test.ts` (unit) and
  `tests/mcp-*.spec.ts` (e2e) — both must assert the new `fleet-state` name and
  the alias during the overlap release.
- Any change here that touches an IPC channel, data model, or the security
  model **must update `docs/SPEC.md` in the same commit** (spec-maintenance
  rule).

## Scope guard (YAGNI)

- **Not** renaming the common-noun "fleet" anywhere it's correct.
- **Not** claiming the bare `admiral` MCP name in this work.
- **Not** buying domains / filing trademarks (deferred with the ownability
  decision).
- **Not** a big-bang rename — each phase stands alone; we can stop after any
  phase and the app is coherent.
