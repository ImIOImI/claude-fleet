# Remote (f) Per-Session Attribution and Session Ownership UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session a person starts in a remote workspace records that person as its owner, its commits and PRs credit them, cost can be grouped by owner on the host and on the desktop, and the desktop Sessions list shows each remote row's owner with a **Mine / Everyone** filter.

**Architecture:** On a viewer `CREATE`, `fleet-host` derives the owner from the verified principal only, pins the claude session id, writes one fenced `session_owners` row (host track v3) on the lease holder, then starts claude with one inline `--settings <json>` that merges the runner hooks with claude's `attribution` setting. Automation runs get an `automation` owner row; published (`pub_…`) sessions resolve to their partition's owner at read time. The holder's `SessionOwnerStore` feeds the fleet-state MCP (`owner` on `get_cost`/`session_summary`, new host-only `cost_by_owner`) and the RPC (`owner` on `history:sessions` rows, new `history:owners`). The desktop validates and caps owner fields like every other host reply, renders them as React text with avatars only from GitHub's avatar host, and filters Mine/Everyone purely in the view.

**Tech Stack:** TypeScript, Node `http`/`ws`, Kysely on Postgres (host), Electron main/preload/React renderer, vitest; claude 2.1.281 (pinned in `docker/Dockerfile`).

Spec: `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md`. The plan follows:
- §4 *Attribution* and *Authorship* (`session_owners`, owner cost, the `--settings` attribution layer, the env fallback, the trust note);
- §8 *Sessions with owners* (avatar + name + @login, Mine / Everyone defaulting to Everyone, watch-only tabs, per-owner cost in Observability when grouped);
- §9 trust notes (shared Linux user; the `session` tier is owner-equivalent);
- §11 item 6 and §12 (f).

## Attribution support at the pinned claude (verified, 2026-11-11)

The installed claude in this workspace is exactly the pin (`claude --version` → `2.1.281 (Claude Code)`; `docker/Dockerfile:47` installs `@anthropic-ai/claude-code@2.1.281`). What was checked and how:

| Question | Method | Result |
|---|---|---|
| Does the settings schema have `attribution`? | `grep -ao` over the native binary `…/claude-code/bin/claude.exe` for the zod schema | Yes: `attribution: false \| true \| { commit?: string, pr?: string, sessionUrl?: boolean }`, "Customize attribution text for commits and PRs… Empty string hides attribution." `includeCoAuthoredBy` is deprecated in its favour. |
| What does `commit` replace? | Same binary, the function that builds the texts | `{ commit: attribution.commit ?? "Co-Authored-By: <model> <noreply@anthropic.com>", pr: attribution.pr ?? <default> }`: the value **replaces** Claude's own line; it does not append. |
| Does the text reach the model? | Ran `claude -p hi --settings '<json>'` with `HOME` set to an empty scratch dir, `ANTHROPIC_API_KEY=sk-ant-dummy`, `ANTHROPIC_BASE_URL` pointed at a local Node capture server | The captured `/v1/messages` body contained "End git commit messages with:\nCo-authored-by: Ann Example <12345+ann@users.noreply.github.com>" and "End pull request descriptions with:\nGenerated with Claude Code on behalf of @ann", and no `noreply@anthropic.com` line. |
| Is `--settings` repeatable? | Two settings files, each with a `SessionStart` hook appending a letter to a file; ran with `--settings a.json --settings b.json` | Only `B` ran. `--settings <file-or-json>` is a single-valued commander option: a second flag **replaces** the first. Appending a second `--settings` would silently drop the runner hooks (input-wait, session report, summaries). |
| Can one flag carry hooks and attribution? | One file, then one inline JSON string, each with a `SessionStart` hook plus `attribution` | The hook ran in both cases, and the attribution was applied. `--settings` accepts inline JSON. |
| What does an invalid value do? | `"attribution": { "commit": 5 }` beside a hook | The whole flag-settings source was rejected silently: the hook did not run. A malformed attribution value would disable the runner hooks too, so the value must always be well-formed. |

So the settings path is supported and is the default. The env + `--append-system-prompt` fallback from spec §4 is not built (D112). Task 5 adds a test that re-runs the capture check whenever the installed claude equals the Dockerfile pin, so a pin bump that drops support fails loudly where claude is installed (this workspace, the runner images).

## Global Constraints

- **Owner identity comes only from the verified principal** (`Viewer.principal.identity`) on `CREATE`: provider + account id, login for display. Nothing in the frame body, the args or session text is ever read as an owner.
- **Owner rows are written fenced and holder-only.** Every `session_owners` write runs in a transaction on the holder's fenced state store (`afterBeginWrite: leaseFence`). One row per (broker session, claude session); `ON CONFLICT DO NOTHING`; there is no update path. A later attach, re-`CREATE` or resume by another person never changes an existing row.
- **Fail closed.** With `db:`, a `CREATE` whose owner row can't be written is refused (`could not record the session owner`) before the broker starts anything.
- **Attribution values are validated and escaped.**
  - Login: `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`; account id: `^[1-9][0-9]{0,19}$`.
  - Co-author name: Unicode letters, marks, digits, space, `.` and `-` only, whitespace collapsed, ≤ 64 characters, else the login.
  - The settings value is produced only by `JSON.stringify` of a fixed shape (`hooks`, `attribution: { commit, pr }`). It goes into argv without a shell (the broker uses `exec.Command(command, args...)`).
  - No file is written: the settings travel inline (D113), so nothing lands outside the host state dir.
- **Remote text is untrusted on the desktop.** Owner fields are re-validated (`parseSessionOwner`), one-lined and capped, owner-cost replies are capped at 100 rows, and everything renders as React text nodes. No `dangerouslySetInnerHTML`.
- **Avatars only from `https://avatars.githubusercontent.com/u/<id>`** (optional `?v=<n>`), checked on host write, desktop parse and render; otherwise none is loaded (D120). `referrerPolicy="no-referrer"`.
- **Mine / Everyone is a view filter.** Default Everyone, not persisted, and never sent to a host. Hiding is not access control (D122).
- **No new port, role or grant (D71, D73).** `session_owners` is a host-track table owned by the app role; the `query` login never reads it.
- **Migrations are expand-only:** one new host-track table (v3). The previous release keeps running against it (`fleet-host migrate` runs before rollout).
- **Desktop MCP surface unchanged:** `cost_by_owner` and the `owner` fields exist only where `setOwnerHandlers` is set (the host).
- **Code comments:** terse and only for non-obvious "why" (`.claude/rules/review-conventions.md`).
- **SPEC:** `docs/SPEC.md` is updated in the same PR (`.claude/rules/spec-maintenance.md`), in Task 11.
- **Gate:**
  - `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json` **separately** (`npm run typecheck` short-circuits).
  - `npx vitest run`, then `npm run build`.
  - Postgres suite: `scripts/pg-test-server.sh start`, export the printed `PG_TEST_URL`, run `npm run test:unit:pg`.
- **Environment:** no Docker and no display here. UI is eyeballed on Troy's host; host behaviour behind the gateway is verified on the cluster.
- **Worktree:** implement in a fresh worktree off `origin/main` on branch `feat/remote-f-attribution`; install with `npm ci --ignore-scripts`; never `cd /workspace/claude-fleet`; use `git -C <worktree>`.

## Decisions

Numbering continues from D111.

- **D112: claude's `attribution` setting is the attribution layer; the env fallback is not built.**
  - Verified at 2.1.281 (section above). The spec's fallback applies "when it isn't supported", and it is.
  - The fallback would also need a broker change: `CREATE` carries argv only, no per-session env.
  - Guard: `src/host/attributionClaude.test.ts` runs the capture check whenever the installed claude equals the Dockerfile pin, and the Dockerfile pin comment names it.
- **D113: The settings travel inline, merged with the runner hooks; no attribution file.**
  - The spec's `<state>/sessions/<id>/attribution.settings.json` can't work in the two-pod split (#581): the host pod mounts the `claude` volume read-only and shares nothing else with the workspace pod, so no path fleet-host writes is readable by claude.
  - `--settings` is single-valued, so a second flag would drop `hooks.settings.json`.
  - The host replaces the gated `--settings /usr/local/lib/claude-fleet/hooks.settings.json` pair with `--settings <JSON of RUNNER_HOOKS + attribution>`. `RUNNER_HOOKS` (in `src/main/claudeArgs.ts`) mirrors `docker/runner/hooks.settings.json`; a test fails if they drift.
  - The value is visible in `ps` to every session in the container. It holds a public name, login and noreply address, and every session already shares one Linux user (spec §4 trust note).
- **D114: Attribution text, people only.**
  - `commit`: `Co-Authored-By: Claude <noreply@anthropic.com>` then `Co-authored-by: <name> <<id>+<login>@users.noreply.github.com>`. The setting replaces Claude's own line, so it is re-added; the model name in Claude's default isn't available to settings and becomes plain `Claude`.
  - `pr`: `🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @<login>`.
  - Only `kind: 'user'` GitHub owners get it. Machines (already the GitHub actor) and automation runs keep claude's default text.
- **D115: `session_owners` (host track v3).**
  - Columns: `broker_session_id`, `session_id` (claude), `workspace_id`, `kind` (`user` | `machine` | `automation`), `provider`, `account_id`, `login`, `name`, `avatar_url`, `started_at`. Primary key `(broker_session_id, session_id)`.
  - The spec's `github_id` becomes `(provider, account_id)`, as D99 did for partitions.
  - Broker ids are reused (a tab's "Start new session" re-`CREATE`s its broker id with a new claude id), so the key includes the claude id.
  - **A claude session's owner is its earliest row** (`started_at`, then `broker_session_id`).
- **D116: Capture on `CREATE`.**
  - The host pins the claude id: `--session-id <uuid>` or `--resume <uuid>` from the viewer, else it mints one. The id is lower-cased.
  - Order: gate args → owner from the principal → fenced insert → broker `CREATE`. If the broker refuses and this call inserted the row, the row is deleted again.
  - Without `db:` nothing is recorded; the attribution settings still apply.
  - A `CREATE` that arrives while the holder is still starting waits for it (`readyHolder()`); a failed holder start refuses it.
- **D117: Resuming doesn't transfer ownership.** Bob resuming Alice's session adds Bob's row for his broker session, and his commits from that process credit Bob. Cost and the Sessions row stay Alice's (earliest row). `CLOSE` ownership stays the in-memory map from (c).
- **D118: Automation runs are owned by the workspace.** `kind: 'automation'`, provider `fleet-host`, account id = the hosted workspace id, login `automation`. Written fenced in `spawnFresh`, after the lease-fence transaction and before the broker `CREATE`.
- **D119: Published (`pub_…`) sessions get no owner rows; their owner is derived from `publish_partitions` at read time** (`kind: 'publisher'`, provider and account id from the partition, `owner_login`, no name or avatar).
  - The partition already holds the verified owner (D97–D99). A copy would be a second source of truth that unpublish would also have to clean.
  - Derived owners are only ever visible where partitions are: the host MCP (`get_cost`, `session_summary`, `cost_by_owner`). `history:*` stays hosted-only (D107), so the desktop never shows them.
- **D120: Avatars are allowlisted, not proxied.** Only `https://avatars.githubusercontent.com/u/<digits>` with an optional `?v=<digits>` passes. That is what GitHub's `/user` returns and what Settings → Account already loads. A proxy would add a host fetch path for no gain. Anything else renders an initial instead.
- **D121: Per-owner cost.**
  - MCP: `get_cost` and `session_summary` gain `owner` on the host only. The new host-only tool `cost_by_owner({ since? })` groups the caller's scope (hosted + partitions) by owner. The host then serves 16 tools, 17 with search.
  - RPC: `history:owners` (`read`) → `{ rows: OwnerCostRow[] }`, at most 100 rows, most expensive first, sessions with no owner as `owner: null`.
  - Desktop: `observability:ownerCosts(remoteId)` → `OwnerCostRow[] | null`. The Observability rail's workspace view shows a collapsed **Cost by owner** section for remote workspaces ("per owner when grouped"). Local workspaces aren't grouped: every local session is the signed-in person's.
  - `session_costs` has no timestamps, so `since` filters on the session's `last_active_at`.
- **D122: Mine / Everyone.**
  - Shown only when the scoped list has a remote row. Default Everyone; component state only.
  - Mine keeps every local row plus remote rows whose owner is `kind: 'user'`, provider `github`, account id = the signed-in `AccountIdentity.id`. Rows with no owner are hidden in Mine.
  - Signed out: Mine is disabled with a tooltip, and the view is Everyone.
- **D123: Watch-only tabs already shipped in (c)** (`TerminalPane` `readOnly`, the "watching" tag, the host dropping `read` input; SPEC §8 *Attach a terminal* → *Remote panes*). (f) adds nothing there.
- **D124: Owner store reads go through the holder's state handle with an explicit workspace filter**, not the `query` login. `ownersOf` and `ownerCosts` always filter `session_owners.workspace_id` and `publish_partitions.partition_id` by the caller's scope.

## File Structure

**Shared, pure** (the host, main and the renderer import it):
- Create `src/preload/sessionOwner.ts`: `SessionOwner`, `OwnerKind`, `OwnerCostRow`, `Me`, constants, `githubAvatarUrl`, `ownerName`, `parseSessionOwner`, `isMine`, `ownerLabel`.
- Modify `tsconfig.web.json`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`, `src/host/importGraph.test.ts` (allowlist it).

**Host:**
- Modify `src/host/hostSchema.ts`: host track v3 `session_owners`.
- Create `src/host/sessionOwners.ts`: `OwnerClaim`, `ownerOfIdentity`, `automationOwner`, `SessionOwnerStore`, `sessionOwnerStore`.
- Modify `src/host/frameGate.ts`: `hostCreateArgs` returns `{ args, sessionId }` and pins a claude id.
- Modify `src/host/attachHub.ts`: `recordOwner` / `releaseOwner` options; `create()` records, then attributes.
- Create `src/host/attribution.ts`: `CLAUDE_COAUTHOR`, `coAuthorName`, `attributionFor`, `sessionSettings`, `withAttribution`.
- Modify `src/main/claudeArgs.ts`: `RUNNER_HOOKS`.
- Modify `src/host/holder.ts`: build `owners`; pass it to automations, the MCP and the history reader.
- Modify `src/host/main.ts`: `readyHolder()`, the hub's owner hooks.
- Modify `src/host/hostAutomations.ts`: automation owner rows.
- Modify `src/main/mcpCore.ts`: `OwnerHandlers`, `setOwnerHandlers`, `HOST_ONLY_TOOLS` (`cost_by_owner`), `owner` on `get_cost`/`session_summary`.
- Modify `src/host/hostMcp.ts`: `cost_by_owner` in `HOST_MCP_TOOLS`, the `owners` option.
- Modify `src/host/historyRead.ts`, `src/host/historyRpc.ts`: `OwnedSessionRow`, `ownerCosts`, `history:owners`.
- Modify `docker/Dockerfile`: one pin-comment line naming the attribution check.

**Desktop:**
- Modify `src/main/federation/remoteRows.ts`: `owner` on rows, `parseOwnerCosts`.
- Modify `src/main/federation/federatedReader.ts`: `ownerCosts`.
- Modify `src/main/federation/federationIpc.ts`: `observability:ownerCosts`.
- Modify `src/preload/index.ts`: `SessionListItem.owner`, `observability.ownerCosts`, type re-exports.

**Renderer:**
- Create `src/renderer/src/components/OwnerBadge.tsx`.
- Create `src/renderer/src/ownerView.ts`: `formatUsd` (moved from `SessionsPane.tsx`), `ownerCostLines`.
- Create `src/renderer/src/components/OwnerCostSection.tsx`.
- Modify `src/renderer/src/sessionsView.ts`: `OwnerFilter`, `filterByOwner`, `hasRemoteRows`.
- Modify `src/renderer/src/components/SessionsPane.tsx`, `ObservabilityPane.tsx`, `src/renderer/src/styles.css`.

**Tests:**
- New: `src/preload/sessionOwner.test.ts`, `src/host/sessionOwners.pg.test.ts`, `src/host/attribution.test.ts`, `src/host/attributionClaude.test.ts`, `src/main/mcpOwner.test.ts`, `src/renderer/src/components/OwnerBadge.test.ts`, `src/renderer/src/ownerView.test.ts`.
- Extended: `src/host/hostSchema.pg.test.ts`, `src/host/hostDb.test.ts`, `src/host/hostQuery.pg.test.ts`, `src/host/attachHub.test.ts`, `src/host/hostAutomations.test.ts`, `src/host/main.pg.test.ts`, `src/host/hostMcp.test.ts`, `src/host/historyRpc.test.ts`, `src/host/historyRead.pg.test.ts`, `src/main/federation/remoteRows.test.ts`, `src/main/federation/federatedReader.test.ts`, `src/main/federation/federationIpc.test.ts`, `src/renderer/src/sessionsView.test.ts`, `vitest.pg.config.ts`.

**Docs:** `docs/SPEC.md` (Task 11).

---

### Task 1: The shared owner shape

**Files:**
- Create `src/preload/sessionOwner.ts` and `src/preload/sessionOwner.test.ts`.
- Modify `tsconfig.web.json`: add `src/preload/sessionOwner.ts` to `include`.
- Modify `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`, `src/host/importGraph.test.ts`: the host will import this file (Task 3), so it joins the host build inputs.

**Interfaces:**
- Produces (`src/preload/sessionOwner.ts`):
  - `type OwnerKind = 'user' | 'machine' | 'automation' | 'publisher'`
  - `interface SessionOwner { kind: OwnerKind; provider: string; id: string; login: string; name: string | null; avatarUrl: string | null }`
  - `interface OwnerCostRow { owner: SessionOwner | null; sessions: number; usd: number }`
  - `interface Me { provider: string; id: number }`
  - `MAX_OWNER_COST_ROWS = 100`, `MAX_OWNER_NAME = 64`, `AUTOMATION_PROVIDER = 'fleet-host'`, `AUTOMATION_LOGIN = 'automation'`, `OWNER_LOGIN_RE`
  - `githubAvatarUrl(raw: unknown): string | null`
  - `ownerName(raw: unknown): string | null`
  - `parseSessionOwner(v: unknown): SessionOwner | null`
  - `isMine(owner: SessionOwner | null | undefined, me: Me | null): boolean`
  - `ownerLabel(o: SessionOwner): string`

- [ ] **Step 1: Write the failing test**

`src/preload/sessionOwner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { githubAvatarUrl, isMine, ownerLabel, ownerName, parseSessionOwner, type SessionOwner } from './sessionOwner';

const W = '01JC0000000000000000000000';
const AV = 'https://avatars.githubusercontent.com/u/7?v=4';
const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann', avatarUrl: AV };

describe('githubAvatarUrl', () => {
  it('passes only GitHub avatar URLs', () => {
    expect(githubAvatarUrl(AV)).toBe(AV);
    expect(githubAvatarUrl('https://avatars.githubusercontent.com/u/7')).toBe('https://avatars.githubusercontent.com/u/7');
    for (const bad of [
      'http://avatars.githubusercontent.com/u/7',
      'https://avatars.githubusercontent.com.evil.io/u/7',
      'https://evil.io/u/7',
      'https://x@avatars.githubusercontent.com/u/7',
      'https://avatars.githubusercontent.com:444/u/7',
      'https://avatars.githubusercontent.com/u/7?v=4&s=1',
      'https://avatars.githubusercontent.com/u/../x',
      'https://avatars.githubusercontent.com/u/0',
      'javascript:alert(1)',
      7,
      null
    ]) {
      expect(githubAvatarUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('ownerName', () => {
  it('one line, no controls or bidi overrides, capped; blank is null', () => {
    expect(ownerName(' Ann‮\n Example ')).toBe('Ann Example');
    expect(ownerName('x'.repeat(100))).toBe('x'.repeat(64));
    expect(ownerName(' ​ ')).toBeNull();
    expect(ownerName(7)).toBeNull();
    expect(ownerName(null)).toBeNull();
  });
});

describe('parseSessionOwner', () => {
  it('accepts people, bots, automation runs and publishers, dropping extra fields', () => {
    expect(parseSessionOwner({ ...ann, extra: 'x' })).toEqual(ann);
    expect(parseSessionOwner({ kind: 'machine', provider: 'github', id: '9', login: 'acme-reviewer[bot]', name: null, avatarUrl: null }))
      .toEqual({ kind: 'machine', provider: 'github', id: '9', login: 'acme-reviewer[bot]', name: null, avatarUrl: null });
    expect(parseSessionOwner({ kind: 'automation', provider: 'fleet-host', id: W, login: 'automation', name: 'x', avatarUrl: AV }))
      .toEqual({ kind: 'automation', provider: 'fleet-host', id: W, login: 'automation', name: null, avatarUrl: null });
    expect(parseSessionOwner({ ...ann, kind: 'publisher', name: null, avatarUrl: null })).toEqual({ ...ann, kind: 'publisher', name: null, avatarUrl: null });
  });

  it('normalizes text and drops an off-host avatar', () => {
    expect(parseSessionOwner({ ...ann, name: '<b>Ann</b>‮', avatarUrl: 'https://evil.io/a.png' }))
      .toEqual({ ...ann, name: '<b>Ann</b>', avatarUrl: null });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null, 'ann', [], {},
      { ...ann, kind: 'admin' },
      { ...ann, provider: 'gitlab' },
      { ...ann, id: 7 },
      { ...ann, id: '0' },
      { ...ann, id: '1'.repeat(21) },
      { ...ann, login: '-ann' },
      { ...ann, login: 'a'.repeat(40) },
      { ...ann, login: 'ann smith' },
      { ...ann, login: 'ann[bot]' },
      { kind: 'automation', provider: 'github', id: W, login: 'automation' },
      { kind: 'automation', provider: 'fleet-host', id: '7', login: 'automation' },
      { kind: 'automation', provider: 'fleet-host', id: W, login: 'ann' }
    ]) {
      expect(parseSessionOwner(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('isMine / ownerLabel', () => {
  it('mine is a GitHub person with the signed-in account id', () => {
    const me = { provider: 'github', id: 7 };
    expect(isMine(ann, me)).toBe(true);
    expect(isMine({ ...ann, id: '8' }, me)).toBe(false);
    expect(isMine({ ...ann, kind: 'machine' }, me)).toBe(false);
    expect(isMine({ ...ann, kind: 'publisher' }, me)).toBe(false);
    expect(isMine(ann, null)).toBe(false);
    expect(isMine(null, me)).toBe(false);
    expect(isMine(undefined, me)).toBe(false);
  });

  it('labels: the name, else @login; automation runs read "automation"', () => {
    expect(ownerLabel(ann)).toBe('Ann');
    expect(ownerLabel({ ...ann, name: null })).toBe('@ann');
    expect(ownerLabel({ kind: 'automation', provider: 'fleet-host', id: W, login: 'automation', name: null, avatarUrl: null })).toBe('automation');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `npx vitest run src/preload/sessionOwner.test.ts`.
Expected: FAIL, `Failed to resolve import "./sessionOwner"`.

- [ ] **Step 3: Implement**

`src/preload/sessionOwner.ts`:

```ts
// Session owners on the wire (remote-workspaces (f)): host → desktop → renderer. Pure; the host,
// main and the renderer import it. Every reader re-validates, because owner text is host-supplied.

export type OwnerKind = 'user' | 'machine' | 'automation' | 'publisher';

export interface SessionOwner {
  kind: OwnerKind;
  /** 'github', or 'fleet-host' for automation runs. */
  provider: string;
  /** The provider's account id as decimal text; the hosted workspace id for automation runs. */
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface OwnerCostRow {
  /** null: sessions with no recorded owner. */
  owner: SessionOwner | null;
  sessions: number;
  usd: number;
}

/** The signed-in identity, for Mine. */
export interface Me { provider: string; id: number }

export const MAX_OWNER_COST_ROWS = 100;
export const MAX_OWNER_NAME = 64;
export const AUTOMATION_PROVIDER = 'fleet-host';
export const AUTOMATION_LOGIN = 'automation';

/** No leading hyphen, so a login is never read as an option. */
export const OWNER_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const BOT_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$/;
const ACCOUNT_ID_RE = /^[1-9][0-9]{0,19}$/;
const WORKSPACE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// An exact match, not URL parsing: no userinfo, port, other path or extra query can pass.
const AVATAR_RE = /^https:\/\/avatars\.githubusercontent\.com\/u\/[1-9][0-9]{0,19}(?:\?v=[0-9]{1,4})?$/;
const CONTROL_RE = /[\x00-\x1f\x7f\p{Cf}]+/gu;
const KINDS: ReadonlySet<string> = new Set(['user', 'machine', 'automation', 'publisher']);

export function githubAvatarUrl(raw: unknown): string | null {
  return typeof raw === 'string' && AVATAR_RE.test(raw) ? raw : null;
}

export function ownerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_OWNER_NAME).trim();
  return s || null;
}

export function parseSessionOwner(v: unknown): SessionOwner | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  if (typeof o.provider !== 'string' || typeof o.id !== 'string' || typeof o.login !== 'string') return null;
  const kind = o.kind as OwnerKind;
  if (kind === 'automation') {
    if (o.provider !== AUTOMATION_PROVIDER || !WORKSPACE_ID_RE.test(o.id) || o.login !== AUTOMATION_LOGIN) return null;
    return { kind, provider: AUTOMATION_PROVIDER, id: o.id, login: AUTOMATION_LOGIN, name: null, avatarUrl: null };
  }
  if (o.provider !== 'github' || !ACCOUNT_ID_RE.test(o.id)) return null;
  const loginOk = OWNER_LOGIN_RE.test(o.login) || (kind === 'machine' && BOT_LOGIN_RE.test(o.login));
  if (!loginOk) return null;
  return { kind, provider: 'github', id: o.id, login: o.login, name: ownerName(o.name), avatarUrl: githubAvatarUrl(o.avatarUrl) };
}

export function isMine(owner: SessionOwner | null | undefined, me: Me | null): boolean {
  return !!owner && !!me && owner.kind === 'user' && owner.provider === me.provider && owner.id === String(me.id);
}

export function ownerLabel(o: SessionOwner): string {
  if (o.kind === 'automation') return 'automation';
  return o.name ?? `@${o.login}`;
}
```

- [ ] **Step 4: Add it to the build inputs**

`tsconfig.web.json` `include` ends:

```json
"src/preload/federation.ts", "src/preload/extraMounts.ts", "src/preload/publish.ts", "src/preload/sessionOwner.ts"]
```

`.dockerignore`, after `!src/preload/federation.ts`:

```
!src/preload/sessionOwner.ts
```

`.github/workflows/publish-runner.yml` (`on.push.paths`) and `.github/workflows/test-runner-images.yml` (`on.pull_request.paths`), after `- 'src/preload/federation.ts'` in each:

```yaml
      - 'src/preload/sessionOwner.ts'
```

`src/host/importGraph.test.ts`, the last `MAIN_ALLOWED` entry becomes:

```ts
  /^preload\/(inboxTypes|captureSettings|federation|sessionOwner)\.ts$/];
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run `npx vitest run src/preload/sessionOwner.test.ts src/host/importGraph.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`.
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/preload/sessionOwner.ts src/preload/sessionOwner.test.ts tsconfig.web.json .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml src/host/importGraph.test.ts
git commit -m "feat(owners): shared session-owner shape and validators"
```

**Verification:**

| Where | What |
|---|---|
| Local | All of the above. |
| CI | Same; `importGraph.test.ts` checks the build-input lists. |

---

### Task 2: Host schema — `session_owners` (host track v3)

**Files:**
- Modify `src/host/hostSchema.ts`.
- Modify `src/host/hostSchema.pg.test.ts`, `src/host/hostDb.test.ts:82`, `src/host/hostQuery.pg.test.ts:118-137`.

**Interfaces:**
- Consumes: nothing new.
- Produces: table `session_owners` (D115) and `HostDb.session_owners`:

```ts
session_owners: {
  broker_session_id: string; session_id: string; workspace_id: string; kind: string; provider: string;
  account_id: string; login: string; name: string | null; avatar_url: string | null; started_at: number;
};
```

- [ ] **Step 1: Write the failing tests**

In `src/host/hostSchema.pg.test.ts`, rename the describe to `'host track'`, change the existing test's last line to:

```ts
    expect(Number(v.rows[0].version)).toBe(3);
```

and add inside the describe:

```ts
  it('v3 adds session_owners: one row per broker and claude session, people, machines and automation runs only', async () => {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    const row = {
      broker_session_id: 'b1', session_id: 's1', workspace_id: 'W', kind: 'user', provider: 'github', account_id: '7',
      login: 'ann', name: null, avatar_url: null, started_at: 1
    };
    await k.insertInto('session_owners').values(row).execute();
    await expect(k.insertInto('session_owners').values({ ...row, account_id: '8', login: 'bob' }).execute()).rejects.toThrow(/unique|duplicate/i);
    await k.insertInto('session_owners').values({ ...row, session_id: 's2' }).execute();
    await k.insertInto('session_owners').values({ ...row, broker_session_id: 'b2', kind: 'automation' }).execute();
    await expect(k.insertInto('session_owners').values({ ...row, broker_session_id: 'b3', kind: 'publisher' }).execute()).rejects.toThrow(/check/i);
  });
```

In `src/host/hostDb.test.ts`, line 82:

```ts
    expect(v.rows).toEqual([{ version: '3' }]);
```

In `src/host/hostQuery.pg.test.ts`, the test at line 118 is renamed `'query sees published partitions too, and never the publish or owner bookkeeping tables'`, and its loop reads:

```ts
    for (const table of ['publish_partitions', 'publish_sessions', 'session_owners']) {
```

- [ ] **Step 2: Run the tests and confirm they fail**

Start Postgres: `scripts/pg-test-server.sh start`, then `export PG_TEST_URL=<printed>`.
Run `npx vitest run -c vitest.pg.config.ts src/host/hostSchema.pg.test.ts src/host/hostDb.test.ts`.
Expected: FAIL: `relation "session_owners" does not exist`, and the version is 2.

- [ ] **Step 3: Implement**

In `src/host/hostSchema.ts`, add to `HostDb` after `publish_sessions`:

```ts
  session_owners: {
    broker_session_id: string; session_id: string; workspace_id: string; kind: string; provider: string;
    account_id: string; login: string; name: string | null; avatar_url: string | null; started_at: number;
  };
```

After `HOST_PUBLISH_V2`:

```ts
// Who started each session (remote-workspaces §4). A claude session's owner is its earliest row (D115).
const HOST_SESSION_OWNERS_V3 = `
CREATE TABLE session_owners (
  broker_session_id TEXT COLLATE "C" NOT NULL,
  session_id TEXT COLLATE "C" NOT NULL,
  workspace_id TEXT COLLATE "C" NOT NULL,
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('user', 'machine', 'automation')),
  provider TEXT COLLATE "C" NOT NULL,
  account_id TEXT COLLATE "C" NOT NULL,
  login TEXT COLLATE "C" NOT NULL,
  name TEXT,
  avatar_url TEXT,
  started_at BIGINT NOT NULL,
  PRIMARY KEY (broker_session_id, session_id)
);
CREATE INDEX idx_session_owners_session ON session_owners (session_id, started_at);
`;
```

and the track:

```ts
export const HOST_TRACK: PgTrack = {
  track: 'host', baselineVersion: HOST_PG_BASELINE_VERSION, baseline: HOST_PG_BASELINE,
  steps: [{ version: 2, postgres: HOST_PUBLISH_V2 }, { version: 3, postgres: HOST_SESSION_OWNERS_V3 }]
};
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run -c vitest.pg.config.ts src/host/hostSchema.pg.test.ts src/host/hostDb.test.ts src/host/hostQuery.pg.test.ts src/host/bootstrap.pg.test.ts`.
Expected: PASS. `hostQuery` shows the `query` login gets `permission denied` on `session_owners` (D71: `ensureIsolation` revokes all).

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/host/hostSchema.ts src/host/hostSchema.pg.test.ts src/host/hostDb.test.ts src/host/hostQuery.pg.test.ts
git commit -m "feat(owners): host track v3 session_owners"
```

**Verification:**

| Where | What |
|---|---|
| Local | The Postgres suite through `scripts/pg-test-server.sh`. |
| CI | Both suites. |
| Cluster | `fleet-host migrate` logs `host` at 3 against RDS before rollout. |

---

### Task 3: The session owner store

**Files:**
- Create `src/host/sessionOwners.ts` and `src/host/sessionOwners.pg.test.ts`.
- Modify `vitest.pg.config.ts`: include `'src/host/sessionOwners.pg.test.ts'` (alphabetical position, after `'src/host/publishStore.pg.test.ts'`).

**Interfaces:**
- Consumes: `parseSessionOwner`, `MAX_OWNER_COST_ROWS`, `AUTOMATION_PROVIDER`, `AUTOMATION_LOGIN`, `SessionOwner`, `OwnerCostRow` (Task 1); table `session_owners` (Task 2); `costFor` from `src/main/pricing.ts`.
- Produces (`src/host/sessionOwners.ts`):
  - `interface OwnerClaim { brokerSessionId: string; sessionId: string; owner: SessionOwner; startedAt: number }`
  - `ownerOfIdentity(i: Identity): SessionOwner` (throws when the identity isn't recordable)
  - `automationOwner(workspaceId: string): SessionOwner`
  - `interface SessionOwnerStore { record(c: OwnerClaim): Promise<boolean>; release(brokerSessionId: string, sessionId: string): Promise<void>; ownersOf(sessionIds: readonly string[], workspaceIds: readonly string[]): Promise<Map<string, SessionOwner>>; ownerCosts(workspaceIds: readonly string[], o?: { since?: number }): Promise<OwnerCostRow[]> }`
  - `sessionOwnerStore(k: () => Kysely<StateDb>, workspaceId: string): SessionOwnerStore`
  - `OWNER_LOOKUP_CHUNK = 500`

- [ ] **Step 1: Write the failing tests**

`src/host/sessionOwners.pg.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import * as db from '../main/db.js';
import { costFor } from '../main/pricing.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, openTestState, type TestState } from '../main/store/testStore.js';
import { MAX_OWNER_COST_ROWS, type SessionOwner } from '../preload/sessionOwner.js';
import { HOST_TRACK } from './hostSchema.js';
import { leaseFence, LeaseLostError } from './pgLease.js';
import { automationOwner, ownerOfIdentity, sessionOwnerStore, type OwnerClaim } from './sessionOwners.js';
import { person } from './testFakes.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';
const S1 = '11111111-2222-4333-8444-555555555551';
const S2 = '11111111-2222-4333-8444-555555555552';
const S3 = '11111111-2222-4333-8444-555555555553';
const ann = ownerOfIdentity(person('ann', 7));
const bob = ownerOfIdentity(person('bob', 8));
const claim = (brokerSessionId: string, sessionId: string, owner: SessionOwner, startedAt: number): OwnerClaim => ({ brokerSessionId, sessionId, owner, startedAt });
const usd = (n: number) => costFor('claude-opus-4-1', null, { inputTokens: n, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

describe('ownerOfIdentity', () => {
  it('takes the provider, account id, login, a clean name and only an allowlisted avatar', () => {
    expect(ownerOfIdentity({ ...person('ann', 7), name: ' Ann‮ ', avatarUrl: 'https://evil.example/a.png' }))
      .toEqual({ kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann', avatarUrl: null });
    expect(ownerOfIdentity({ ...person('ann', 7), avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' }).avatarUrl)
      .toBe('https://avatars.githubusercontent.com/u/7?v=4');
  });

  it('refuses an identity whose login is not a GitHub login', () => {
    expect(() => ownerOfIdentity(person('-x', 7))).toThrow(/can't be recorded/);
    expect(() => ownerOfIdentity(person('a b', 7))).toThrow(/can't be recorded/);
  });
});

describe.skipIf(!isPg)('sessionOwnerStore', () => {
  let st: TestState | null = null;
  afterEach(async () => { await st?.close(); st = null; });

  async function rig() {
    st = await openTestState('owners-');
    await migratePostgres(postgresKysely(st.pg!.pool), st.pg!.schema, HOST_TRACK);
    return sessionOwnerStore(db.stateKysely, HOSTED);
  }
  const sess = (id: string, last: number) => ({ id, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: last, ai_title: null, first_user_message: null, user_set_name: null });
  const cost = (session_id: string, input_tokens: number) => ({
    session_id, workspace_id: HOSTED, model: 'claude-opus-4-1', service_tier: '', input_tokens, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, event_count: 1
  });

  it('records once per broker and claude session; a later record never changes it', async () => {
    const s = await rig();
    expect(await s.record(claim('tab-1', S1, ann, 10))).toBe(true);
    expect(await s.record(claim('tab-1', S1, bob, 20))).toBe(false);
    expect(await s.record(claim('tab-1', S2, bob, 30))).toBe(true);
    const m = await s.ownersOf([S1, S2], [HOSTED]);
    expect(m.get(S1)).toEqual(ann);
    expect(m.get(S2)).toEqual(bob);
  });

  it('the earliest row owns a claude session: a resume by someone else does not take it over', async () => {
    const s = await rig();
    await s.record(claim('tab-b', S1, bob, 20));
    await s.record(claim('tab-a', S1, ann, 10));
    expect((await s.ownersOf([S1], [HOSTED])).get(S1)).toEqual(ann);
  });

  it('release drops only the row it names', async () => {
    const s = await rig();
    await s.record(claim('tab-1', S1, ann, 10));
    await s.record(claim('tab-2', S1, bob, 20));
    await s.release('tab-1', S1);
    expect((await s.ownersOf([S1], [HOSTED])).get(S1)).toEqual(bob);
  });

  it('records automation runs as the workspace', async () => {
    const s = await rig();
    await s.record(claim(`auto-r1-go`, S1, automationOwner(HOSTED), 10));
    expect((await s.ownersOf([S1], [HOSTED])).get(S1)).toEqual({ kind: 'automation', provider: 'fleet-host', id: HOSTED, login: 'automation', name: null, avatarUrl: null });
  });

  it('reads only the workspaces it is given; published sessions resolve to their partition owner', async () => {
    const s = await rig();
    await s.record(claim('tab-1', S1, ann, 10));
    const schema = st!.pg!.schema;
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
      VALUES ('pub_a', 'github', '9', 'cat', $1, 1)`, [OTHER]);
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
      VALUES ($1, 'pub_a', 'src', 1, 1)`, [S3]);
    expect([...(await s.ownersOf([S1, S3], [OTHER])).keys()]).toEqual([]);
    expect([...(await s.ownersOf([S1, S3], [HOSTED])).keys()]).toEqual([S1]);
    const both = await s.ownersOf([S1, S3], [HOSTED, 'pub_a']);
    expect(both.get(S1)).toEqual(ann);
    expect(both.get(S3)).toEqual({ kind: 'publisher', provider: 'github', id: '9', login: 'cat', name: null, avatarUrl: null });
    expect(await s.ownersOf([], [HOSTED])).toEqual(new Map());
  });

  it('groups cost by owner, most expensive first, with unowned sessions under null', async () => {
    const s = await rig();
    const k = db.stateKysely();
    await k.insertInto('sessions').values([sess(S1, 100), sess(S2, 200), sess(S3, 300)]).execute();
    await k.insertInto('session_costs').values([cost(S1, 1000), cost(S2, 3000), cost(S3, 500)]).execute();
    await s.record(claim('t1', S1, ann, 1));
    await s.record(claim('t2', S2, ann, 1));
    await s.record(claim('t3', S2, bob, 2));
    expect(await s.ownerCosts([HOSTED])).toEqual([
      { owner: ann, sessions: 2, usd: usd(1000) + usd(3000) },
      { owner: null, sessions: 1, usd: usd(500) }
    ]);
    expect(await s.ownerCosts([HOSTED], { since: 250 })).toEqual([{ owner: null, sessions: 1, usd: usd(500) }]);
    expect(await s.ownerCosts([OTHER])).toEqual([]);
    expect(await s.ownerCosts([])).toEqual([]);
  });

  it(`returns at most ${MAX_OWNER_COST_ROWS} owners`, async () => {
    const s = await rig();
    const k = db.stateKysely();
    const n = MAX_OWNER_COST_ROWS + 1;
    const ids = Array.from({ length: n }, (_, i) => `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`);
    await k.insertInto('sessions').values(ids.map((id) => sess(id, 1))).execute();
    await k.insertInto('session_costs').values(ids.map((id, i) => cost(id, 1000 + i))).execute();
    for (const [i, id] of ids.entries()) await s.record(claim(`t${i}`, id, ownerOfIdentity(person(`u${i}`, i + 1)), 1));
    const rows = await s.ownerCosts([HOSTED]);
    expect(rows).toHaveLength(MAX_OWNER_COST_ROWS);
    expect(rows[0].owner!.login).toBe(`u${n - 1}`);
  });

  it('writes nothing once the lease is lost', async () => {
    const s = await rig();
    const schema = st!.pg!.schema;
    await st!.pg!.pool.query(`INSERT INTO ${schema}.host_lease VALUES ($1, 'me', 2, clock_timestamp() + interval '1 minute')`, [HOSTED]);
    await db.closeDb();
    const lost: Error[] = [];
    await db.openDbPostgres(st!.pg!.pool, {
      migrate: false,
      afterBeginWrite: leaseFence({ workspaceId: HOSTED, holder: 'me', epoch: () => 1, onLost: (e) => lost.push(e) })
    });
    await expect(s.record(claim('t1', S1, ann, 1))).rejects.toThrow(LeaseLostError);
    expect((await st!.pg!.pool.query(`SELECT count(*)::int AS n FROM ${schema}.session_owners`)).rows[0].n).toBe(0);
    expect(lost).toHaveLength(1);
  });
});
```

Add to `vitest.pg.config.ts` `include`, after `'src/host/publishStore.pg.test.ts'`:

```ts
      'src/host/sessionOwners.pg.test.ts',
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/host/sessionOwners.pg.test.ts`.
Expected: FAIL, `Failed to resolve import "./sessionOwners.js"`.

- [ ] **Step 3: Implement**

`src/host/sessionOwners.ts`:

```ts
// Session owners (remote-workspaces §4 Attribution) on the holder's fenced state store.
// Rows come only from a verified identity on CREATE (D116) or the host's own automation runs (D118).
import { sql, type Kysely } from 'kysely';
import type { Identity } from '../main/identity/types.js';
import { costFor } from '../main/pricing.js';
import type { StateDb } from '../main/store/stateSchema.js';
import {
  AUTOMATION_LOGIN, AUTOMATION_PROVIDER, MAX_OWNER_COST_ROWS, parseSessionOwner, type OwnerCostRow, type SessionOwner
} from '../preload/sessionOwner.js';

export const OWNER_LOOKUP_CHUNK = 500;

export interface OwnerClaim {
  brokerSessionId: string;
  /** The claude session id the host pinned. */
  sessionId: string;
  owner: SessionOwner;
  startedAt: number;
}

export function ownerOfIdentity(i: Identity): SessionOwner {
  const o = parseSessionOwner({ kind: i.kind, provider: i.provider, id: String(i.id), login: i.login, name: i.name, avatarUrl: i.avatarUrl });
  if (!o) throw new Error(`identity ${i.provider}:${i.id} can't be recorded as a session owner`);
  return o;
}

export function automationOwner(workspaceId: string): SessionOwner {
  return { kind: 'automation', provider: AUTOMATION_PROVIDER, id: workspaceId, login: AUTOMATION_LOGIN, name: null, avatarUrl: null };
}

export interface SessionOwnerStore {
  /** False: that (broker session, claude session) already had an owner, which is unchanged. */
  record(c: OwnerClaim): Promise<boolean>;
  release(brokerSessionId: string, sessionId: string): Promise<void>;
  /** Within `workspaceIds` only: a session's earliest row, or its publish partition's owner (D119). */
  ownersOf(sessionIds: readonly string[], workspaceIds: readonly string[]): Promise<Map<string, SessionOwner>>;
  /** Most expensive first, at most MAX_OWNER_COST_ROWS; `since` filters on last_active_at. */
  ownerCosts(workspaceIds: readonly string[], o?: { since?: number }): Promise<OwnerCostRow[]>;
}

interface OwnerRow {
  session_id: string; kind: string; provider: string; account_id: string; login: string; name: string | null; avatar_url: string | null;
}
interface CostRow {
  session_id: string; model: string | null; service_tier: string | null;
  input_tokens: number | string; output_tokens: number | string;
  cache_read_input_tokens: number | string; cache_creation_input_tokens: number | string;
}

const groupKey = (o: SessionOwner | null): string => (o ? `${o.kind}\u0000${o.provider}\u0000${o.id}` : '');

export function sessionOwnerStore(k: () => Kysely<StateDb>, workspaceId: string): SessionOwnerStore {
  async function ownersOf(sessionIds: readonly string[], workspaceIds: readonly string[]): Promise<Map<string, SessionOwner>> {
    const out = new Map<string, SessionOwner>();
    if (sessionIds.length === 0 || workspaceIds.length === 0) return out;
    const ws = sql.join([...workspaceIds]);
    for (let i = 0; i < sessionIds.length; i += OWNER_LOOKUP_CHUNK) {
      const ids = sql.join(sessionIds.slice(i, i + OWNER_LOOKUP_CHUNK));
      const r = await sql<OwnerRow>`
        (SELECT DISTINCT ON (session_id) session_id, kind, provider, account_id, login, name, avatar_url
           FROM session_owners WHERE workspace_id IN (${ws}) AND session_id IN (${ids})
           ORDER BY session_id, started_at, broker_session_id)
        UNION ALL
        (SELECT s.session_id, 'publisher', p.owner_provider, p.owner_id, p.owner_login, NULL::text, NULL::text
           FROM publish_sessions s JOIN publish_partitions p ON p.partition_id = s.partition_id
           WHERE p.partition_id IN (${ws}) AND s.session_id IN (${ids}))`.execute(k());
      for (const row of r.rows) {
        const o = parseSessionOwner({ kind: row.kind, provider: row.provider, id: row.account_id, login: row.login, name: row.name, avatarUrl: row.avatar_url });
        if (o && !out.has(row.session_id)) out.set(row.session_id, o);
      }
    }
    return out;
  }

  return {
    async record(c) {
      const o = c.owner;
      if (o.kind === 'publisher') throw new Error('published sessions take their owner from the partition');
      return k().transaction().execute(async (trx) => {
        const r = await sql<{ broker_session_id: string }>`
          INSERT INTO session_owners (broker_session_id, session_id, workspace_id, kind, provider, account_id, login, name, avatar_url, started_at)
          VALUES (${c.brokerSessionId}, ${c.sessionId}, ${workspaceId}, ${o.kind}, ${o.provider}, ${o.id}, ${o.login}, ${o.name}, ${o.avatarUrl}, ${c.startedAt})
          ON CONFLICT (broker_session_id, session_id) DO NOTHING
          RETURNING broker_session_id`.execute(trx);
        return r.rows.length > 0;
      });
    },
    async release(brokerSessionId, sessionId) {
      await k().transaction().execute(async (trx) => {
        await sql`DELETE FROM session_owners WHERE broker_session_id = ${brokerSessionId} AND session_id = ${sessionId}`.execute(trx);
      });
    },
    ownersOf,
    async ownerCosts(workspaceIds, o = {}) {
      if (workspaceIds.length === 0) return [];
      const since = o.since === undefined ? sql`` : sql`AND COALESCE(s.last_active_at, 0) >= ${o.since}`;
      const costs = (await sql<CostRow>`
        SELECT c.session_id, NULLIF(c.model, '') AS model, NULLIF(c.service_tier, '') AS service_tier,
               c.input_tokens, c.output_tokens, c.cache_read_input_tokens, c.cache_creation_input_tokens
        FROM session_costs c JOIN sessions s ON s.id = c.session_id AND s.workspace_id = c.workspace_id
        WHERE c.workspace_id IN (${sql.join([...workspaceIds])}) ${since}
        ORDER BY c.session_id, c.model, c.service_tier`.execute(k())).rows;
      const owners = await ownersOf([...new Set(costs.map((c) => c.session_id))], workspaceIds);
      const groups = new Map<string, { owner: SessionOwner | null; sessions: Set<string>; usd: number }>();
      for (const c of costs) {
        const owner = owners.get(c.session_id) ?? null;
        const key = groupKey(owner);
        const g = groups.get(key) ?? { owner, sessions: new Set<string>(), usd: 0 };
        g.sessions.add(c.session_id);
        g.usd += costFor(c.model, c.service_tier, {
          inputTokens: Number(c.input_tokens), outputTokens: Number(c.output_tokens),
          cacheReadInputTokens: Number(c.cache_read_input_tokens), cacheCreationInputTokens: Number(c.cache_creation_input_tokens)
        });
        groups.set(key, g);
      }
      return [...groups.entries()]
        .sort(([ka, a], [kb, b]) => b.usd - a.usd || (ka < kb ? -1 : ka > kb ? 1 : 0))
        .slice(0, MAX_OWNER_COST_ROWS)
        .map(([, g]) => ({ owner: g.owner, sessions: g.sessions.size, usd: g.usd }));
    }
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/host/sessionOwners.pg.test.ts`.
Expected: PASS (the `ownerOfIdentity` tests run; the store tests skip on SQLite).

Run `npx vitest run -c vitest.pg.config.ts src/host/sessionOwners.pg.test.ts`.
Expected: PASS.

Run `npx vitest run src/host/importGraph.test.ts` and `npx tsc --noEmit -p tsconfig.node.json`.
Expected: PASS, no errors. (`sessionOwners.ts` isn't reachable from `cli.ts` until Task 4.)

- [ ] **Step 5: Commit**

```bash
git add src/host/sessionOwners.ts src/host/sessionOwners.pg.test.ts vitest.pg.config.ts
git commit -m "feat(owners): fenced session owner store with per-owner cost"
```

**Verification:**

| Where | What |
|---|---|
| Local | Both suites. |
| CI | Both suites. |

---

### Task 4: Owner capture on `CREATE`

**Files:**
- Modify `src/host/frameGate.ts`: `hostCreateArgs`.
- Modify `src/host/attachHub.ts`: `AttachHubOptions`, `AttachHub` fields, `Viewer.create`.
- Modify `src/host/holder.ts`: `Holder.owners`; pass `owners` to `startHostAutomations`.
- Modify `src/host/main.ts`: `readyHolder()`; the hub's `recordOwner`/`releaseOwner`.
- Modify `src/host/hostAutomations.ts`: `HostAutomationsOptions.owners`; `spawnFresh`.
- Modify `src/host/attachHub.test.ts` (the `CREATE args` describe, lines 157-191; a new describe), `src/host/hostAutomations.test.ts`, `src/host/main.pg.test.ts`.

**Interfaces:**
- Consumes: `OwnerClaim`, `ownerOfIdentity`, `automationOwner`, `SessionOwnerStore`, `sessionOwnerStore` (Task 3).
- Produces:
  - `hostCreateArgs(args: unknown, mint?: () => string): { args: string[]; sessionId: string } | null`
  - `AttachHubOptions.recordOwner?: (c: OwnerClaim) => Promise<boolean>` and `releaseOwner?: (c: OwnerClaim) => Promise<void>`
  - `Holder.owners: SessionOwnerStore`
  - `HostAutomationsOptions.owners?: Pick<SessionOwnerStore, 'record'>`

- [ ] **Step 1: Write the failing tests**

In `src/host/attachHub.test.ts`, extend the imports:

```ts
import { AttachHub, MAX_PENDING_BYTES, MAX_PENDING_FRAMES, ReplayBuffer, trimToSafeStart, type AttachHubOptions } from './attachHub.js';
import type { OwnerClaim } from './sessionOwners.js';
```

add constants after `UUID`:

```ts
const UUID2 = '1c8e7d2f-2a7b-4d66-8d4a-7a2a9e7d3b22';
const PINNED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The `--settings` value a CREATE by alice carries. */
const SETTINGS_ARG = RUNNER_HOOK_SETTINGS;
```

and replace the whole `describe('CREATE args', …)` block with:

```ts
describe('CREATE args', () => {
  it.each([
    [['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID], ['--settings', SETTINGS_ARG, '--session-id', UUID]],
    [['--resume', UUID], ['--settings', SETTINGS_ARG, '--resume', UUID]],
    [['--resume', UUID.toUpperCase()], ['--settings', SETTINGS_ARG, '--resume', UUID]]
  ])('accepts %j', async (args, want) => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([{ id: 'n', args: want }]);
  });

  it.each([[undefined], [[]], [['--settings', RUNNER_HOOK_SETTINGS]]])('pins a fresh claude session id for %j', async (args) => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    const got = broker.created[0].args;
    expect(got).toHaveLength(4);
    expect(got.slice(0, 3)).toEqual(['--settings', SETTINGS_ARG, '--session-id']);
    expect(got[3]).toMatch(PINNED);
  });

  it.each([
    [['--dangerously-skip-permissions']],
    [['--resume', 'not-a-uuid']],
    [['--settings', '/tmp/evil.json', '--resume', UUID]],
    [['--resume', UUID, '--mcp-config', '/x']]
  ])('refuses %j', async (args) => {
    const { broker, rec, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([]);
    expect(last(rec).json).toMatchObject({ ok: false, error: 'forbidden: unsupported create args' });
  });

  it('appends createArgs after the gate', async () => {
    const broker = fakeBroker([]);
    const v = new AttachHub(broker.ops, { createArgs: (a) => [...a, '--mcp-config', '{}'] }).viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'm', args: ['--resume', UUID] }));
    expect(broker.created.map((c) => c.args)).toEqual([
      ['--settings', SETTINGS_ARG, '--session-id', expect.stringMatching(PINNED), '--mcp-config', '{}'],
      ['--settings', SETTINGS_ARG, '--resume', UUID, '--mcp-config', '{}']
    ]);
  });
});

describe('CREATE records the owner from the principal', () => {
  function rig(who = alice, tier: Tier = 'session', o: Partial<AttachHubOptions> = {}) {
    const broker = fakeBroker([]);
    const claims: OwnerClaim[] = [];
    const released: OwnerClaim[] = [];
    const order: string[] = [];
    const create = broker.ops.create.bind(broker.ops);
    broker.ops.create = async (...a) => { order.push('create'); return create(...a); };
    const hub = new AttachHub(broker.ops, {
      recordOwner: async (c) => {
        order.push('record');
        const fresh = !claims.some((x) => x.brokerSessionId === c.brokerSessionId && x.sessionId === c.sessionId);
        claims.push(c);
        return fresh;
      },
      releaseOwner: async (c) => { released.push(c); },
      now: () => 42,
      ...o
    });
    const rec = sinkRecorder();
    return { broker, hub, claims, released, order, rec, v: hub.viewer({ identity: who, tier }, rec.sink) };
  }

  it('records the verified caller before the broker starts claude; body fields never name the owner', async () => {
    const { broker, claims, order, v } = rig();
    await v.receive(jsonFrame(FrameType.CREATE, {
      id: 'n', args: ['--session-id', UUID], owner: { login: 'mallory', id: 666 }, login: 'mallory', identity: { provider: 'github', id: 666 }
    }));
    expect(order).toEqual(['record', 'create']);
    expect(claims).toEqual([{
      brokerSessionId: 'n', sessionId: UUID, startedAt: 42,
      owner: { kind: 'user', provider: 'github', id: '1', login: 'alice', name: null, avatarUrl: null }
    }]);
    expect(broker.created).toHaveLength(1);
  });

  it('records the claude id it pinned when the viewer sent none', async () => {
    const { broker, claims, v } = rig();
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    const args = broker.created[0].args;
    expect(claims[0].sessionId).toBe(args[args.indexOf('--session-id') + 1]);
  });

  it('refuses the CREATE when the owner row cannot be written', async () => {
    const { broker, rec, v } = rig(alice, 'session', { recordOwner: async () => { throw new Error('fenced off'); } });
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect(broker.created).toEqual([]);
    expect(last(rec).json).toMatchObject({ id: 'n', ok: false, error: 'could not record the session owner' });
  });

  it('refuses an identity that cannot be recorded as an owner', async () => {
    const { broker, claims, rec, v } = rig(person('-odd', 3));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect([claims, broker.created]).toEqual([[], []]);
    expect(last(rec).json).toMatchObject({ ok: false, error: 'could not record the session owner' });
  });

  it('a broker refusal releases only a row this CREATE wrote; ownership never moves', async () => {
    const { hub, released } = rig();
    const vb = hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink);
    await hub.viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x', args: ['--session-id', UUID] }));
    await vb.receive(jsonFrame(FrameType.CREATE, { id: 'x', args: ['--session-id', UUID] }));
    expect(released).toEqual([]);
    await vb.receive(jsonFrame(FrameType.CREATE, { id: 'x', args: ['--session-id', UUID2] }));
    expect(released.map((c) => [c.brokerSessionId, c.sessionId, c.owner.login])).toEqual([['x', UUID2, 'bob']]);
    expect(hub.owners.get('x')).toBe('github:1');
  });

  it('a steer or read viewer never reaches the owner hook', async () => {
    for (const tier of ['read', 'steer'] as const) {
      const { claims, v } = rig(alice, tier);
      await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
      expect(claims).toEqual([]);
    }
  });
});
```

In `src/host/hostAutomations.test.ts`, add imports:

```ts
import { automationOwner, type OwnerClaim } from './sessionOwners.js';
```

and inside `describe('startHostAutomations', …)`:

```ts
  it('records the run’s session as an automation owner before the broker starts it', async () => {
    const store = await openTestInbox();
    const broker = fakeBroker([]);
    const order: string[] = [];
    const claims: OwnerClaim[] = [];
    const create = broker.ops.create.bind(broker.ops);
    broker.ops.create = async (...a) => { order.push('create'); return create(...a); };
    h = await startHostAutomations({
      inbox: store, workspace: () => WS, ops: broker.ops, mcpArgs: MCP_ARGS, events: { publish: () => undefined },
      log: createLogger(() => undefined), tickMs: 60_000, settleMs: 50,
      owners: { record: async (c) => { order.push('record'); claims.push(c); return true; } }
    });
    await h.reconcile([fresh('a')]);
    const [a] = await h.automations.list();
    const run = await h.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await expect.poll(() => broker.created.length).toBe(1);
    const c = broker.created[0];
    expect(order).toEqual(['record', 'create']);
    expect(claims).toEqual([{
      brokerSessionId: `auto-${run.id}-go`, sessionId: c.args[c.args.indexOf('--session-id') + 1],
      owner: automationOwner(WS.id), startedAt: expect.any(Number)
    }]);
  });

  it('a failed owner write fails the step and starts nothing', async () => {
    const store = await openTestInbox();
    const broker = fakeBroker([]);
    h = await startHostAutomations({
      inbox: store, workspace: () => WS, ops: broker.ops, mcpArgs: MCP_ARGS, events: { publish: () => undefined },
      log: createLogger(() => undefined), tickMs: 60_000, settleMs: 50,
      owners: { record: async () => { throw new Error('fenced off'); } }
    });
    await h.reconcile([fresh('a')]);
    const [a] = await h.automations.list();
    const run = await h.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await h.automations.settle();
    expect(broker.created).toEqual([]);
    expect((await new AutomationStore(store.kysely).getRun(run.id))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/fenced off/) });
  });
```

In `src/host/main.pg.test.ts`, inside `describe.skipIf(!isPg)('runHost on Postgres', …)`:

```ts
  it('a viewer CREATE records its verified owner, fenced on the holder, before the broker starts claude', async () => {
    const broker = fakeBroker([]);
    const a = await start({ brokerOps: broker.ops });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(jsonFrame(FrameType.CREATE, { id: 'v2', cols: 80, rows: 24, owner: { login: 'mallory', id: 666 } }));
    await vi.waitFor(() => expect(broker.created).toHaveLength(1), { timeout: 10_000 });
    ws.close();
    const args = broker.created[0].args;
    const sid = args[args.indexOf('--session-id') + 1];
    const rows = await t!.pool.query(`SELECT broker_session_id, session_id, workspace_id, kind, provider, account_id, login FROM ${t!.schema}.session_owners`);
    expect(rows.rows).toEqual([{ broker_session_id: 'v2', session_id: sid, workspace_id: ID, kind: 'user', provider: 'github', account_id: '1', login: 'owner' }]);
  }, 30_000);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/host/attachHub.test.ts src/host/hostAutomations.test.ts`.
Expected: FAIL: no `--session-id` is pinned for `undefined` args, `recordOwner` is never called, and `owners` isn't an option.

- [ ] **Step 3: Implement `hostCreateArgs`**

In `src/host/frameGate.ts`, add `import { randomUUID } from 'node:crypto';` and replace `hostCreateArgs` with:

```ts
/**
 * A viewer's CREATE args, rebuilt by the host. Only the shape the desktop
 * sends (`claudeCreateArgs`) is accepted, so a viewer can't append arbitrary
 * claude flags. The claude session id is always pinned, so its owner row
 * (D116) names it before claude starts. Null means refuse.
 */
export function hostCreateArgs(args: unknown, mint: () => string = randomUUID): { args: string[]; sessionId: string } | null {
  const fresh = (): { args: string[]; sessionId: string } => {
    const id = mint();
    return { args: claudeCreateArgs(undefined, id), sessionId: id };
  };
  if (args === undefined) return fresh();
  if (!Array.isArray(args)) return null;
  const rest = args[0] === '--settings' && args[1] === RUNNER_HOOK_SETTINGS ? args.slice(2) : args;
  if (rest.length === 0) return fresh();
  if (rest.length !== 2 || typeof rest[1] !== 'string' || !UUID_RE.test(rest[1])) return null;
  const id = rest[1].toLowerCase();
  if (rest[0] === '--resume') return { args: claudeCreateArgs(id), sessionId: id };
  if (rest[0] === '--session-id') return { args: claudeCreateArgs(undefined, id), sessionId: id };
  return null;
}
```

- [ ] **Step 4: Record the owner in `Viewer.create`**

In `src/host/attachHub.ts`, add the import:

```ts
import { ownerOfIdentity, type OwnerClaim } from './sessionOwners.js';
```

extend `AttachHubOptions`:

```ts
  /** Writes a CREATE's owner row before the broker starts claude (D116); throwing refuses the CREATE. False: the row already existed. */
  recordOwner?: (c: OwnerClaim) => Promise<boolean>;
  /** Removes the row recordOwner wrote when the broker then refuses the CREATE. */
  releaseOwner?: (c: OwnerClaim) => Promise<void>;
```

add fields to `AttachHub` beside `createArgs`:

```ts
  readonly recordOwner: ((c: OwnerClaim) => Promise<boolean>) | undefined;
  readonly releaseOwner: ((c: OwnerClaim) => Promise<void>) | undefined;
```

and in its constructor, after `this.createArgs = …`:

```ts
    this.recordOwner = opts.recordOwner;
    this.releaseOwner = opts.releaseOwner;
```

Replace `Viewer.create` with the two methods below:

```ts
  /** Only the verified principal names the owner; nothing in the frame does. */
  private ownerClaim(brokerSessionId: string, sessionId: string): OwnerClaim | null {
    try {
      return { brokerSessionId, sessionId, owner: ownerOfIdentity(this.principal.identity), startedAt: this.hub.now() };
    } catch (err) {
      this.hub.log?.log('error', 'session owner unusable', { id: brokerSessionId, error: err });
      return null;
    }
  }

  private async create(req: Json): Promise<void> {
    const { id } = req;
    if (!validSessionId(id)) return this.reply(FrameType.CREATED, { id, ok: false, error: 'bad session id' });
    const gated = hostCreateArgs(req.args);
    if (!gated) return this.reply(FrameType.CREATED, { id, ok: false, error: 'forbidden: unsupported create args' });
    const refused = (): void => this.reply(FrameType.CREATED, { id, ok: false, error: 'could not record the session owner' });
    const claim = this.ownerClaim(id, gated.sessionId);
    if (!claim) return refused();
    let recorded = false;
    try {
      recorded = (await this.hub.recordOwner?.(claim)) ?? false;
    } catch (err) {
      this.hub.log?.log('error', 'session owner not recorded', { id, error: err });
      return refused();
    }
    const args = this.hub.createArgs(gated.args);
    const r = await this.hub.ops.create(id, dim(req.cols, 80), dim(req.rows, 24), args);
    if (r.ok) this.hub.setOwner(id, ownerKey(this.principal.identity));
    else if (recorded) {
      await this.hub.releaseOwner?.(claim).catch((err: Error) => this.hub.log?.log('warn', 'session owner release failed', { id, error: err.message }));
    }
    this.reply(FrameType.CREATED, { id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }
```

- [ ] **Step 5: Build the store on the holder and wire the hub**

In `src/host/holder.ts`:
- import `import { sessionOwnerStore, type SessionOwnerStore } from './sessionOwners.js';`;
- add `owners: SessionOwnerStore;` to `Holder`;
- after `const publish = publishStore(…);` add `const owners = sessionOwnerStore(stateKysely, o.workspaceId);`;
- in the `startHostAutomations({ … })` call add `owners,` after `ops: o.ops,`;
- in the returned object add `owners,` after `publish,`.

In `src/host/main.ts`, replace the `const hub = new AttachHub(…)` line with:

```ts
  const hub = new AttachHub(ops, {
    hostPort: env.port,
    log,
    createArgs: config.db ? (a) => [...a, ...mcpArgs] : undefined,
    ...(config.db
      ? {
          recordOwner: async (c: OwnerClaim) => (await readyHolder()).owners.record(c),
          releaseOwner: async (c: OwnerClaim) => (await readyHolder()).owners.release(c.brokerSessionId, c.sessionId)
        }
      : {})
  });
```

add `import type { OwnerClaim } from './sessionOwners.js';`, and directly after the `let holderNow: Holder | null = null;` line:

```ts
  /** A CREATE that lands while the holder is still starting waits for it rather than run unowned. */
  async function readyHolder(): Promise<Holder> {
    const h = holderNow ?? (holderP ? await holderP : null);
    if (!h || startAbort.signal.aborted) throw new Error('the host store is not open');
    return h;
  }
```

(`startAbort` is declared later in `runHost`; `readyHolder` only runs on a `CREATE`, after it exists.)

- [ ] **Step 6: Record automation runs**

In `src/host/hostAutomations.ts`:
- add `import { randomUUID } from 'node:crypto';` and `import { automationOwner, type SessionOwnerStore } from './sessionOwners.js';`;
- add to `HostAutomationsOptions`:

```ts
  /** The holder's owner store: each fresh step's session is recorded as the workspace's (D118). */
  owners?: Pick<SessionOwnerStore, 'record'>;
```

- replace `spawnFresh` with:

```ts
    spawnFresh: async (_ws, sessionId, args) => {
      const claudeId = randomUUID();
      const argv = freshArgv(args, o.mcpArgs, claudeId);
      // A write transaction runs the lease fence. A takeover after it still starts this one session; its run's next write fails.
      await o.inbox.kysely.transaction().execute(async () => undefined);
      await o.owners?.record({ brokerSessionId: sessionId, sessionId: claudeId, owner: automationOwner(o.workspace().id), startedAt: now() });
      const r = await o.ops.create(sessionId, 120, 40, argv);
      if (!r.ok) throw new Error(`could not start a fresh session: ${r.error ?? 'unknown broker error'}`);
    },
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run `npx vitest run src/host/attachHub.test.ts src/host/hostAutomations.test.ts src/host/server.test.ts src/host/main.test.ts src/host/importGraph.test.ts`.
Expected: PASS.

Run `npx vitest run -c vitest.pg.config.ts src/host/main.pg.test.ts src/host/hostAutomations.pg.test.ts src/host/hostAutomations.test.ts`.
Expected: PASS, including the existing "viewer CREATEs carry the MCP config" test: its `CREATE` now waits for the holder through `readyHolder()`.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/host/frameGate.ts src/host/attachHub.ts src/host/holder.ts src/host/main.ts src/host/hostAutomations.ts src/host/attachHub.test.ts src/host/hostAutomations.test.ts src/host/main.pg.test.ts
git commit -m "feat(owners): record each CREATE's verified owner, fenced, before claude starts"
```

**Verification:**

| Where | What |
|---|---|
| Local | Both suites. |
| CI | Both suites. |
| Cluster | A `session`-tier person starts a session from the desktop; `SELECT kind, login, session_id FROM session_owners` shows one row with their login; an automation run adds a `kind = 'automation'` row. |

---

### Task 5: The attribution layer

**Files:**
- Modify `src/main/claudeArgs.ts`: `RUNNER_HOOKS`.
- Create `src/host/attribution.ts`, `src/host/attribution.test.ts`, `src/host/attributionClaude.test.ts`.
- Modify `src/host/attachHub.ts`: `Viewer.create` swaps in the inline settings.
- Modify `src/host/attachHub.test.ts`: `SETTINGS_ARG`; one new test.
- Modify `docker/Dockerfile`: one line in the pin comment.

**Interfaces:**
- Consumes: `SessionOwner`, `OWNER_LOGIN_RE` (Task 1); `OwnerClaim`, `ownerOfIdentity` (Task 3); `RUNNER_HOOK_SETTINGS`.
- Produces:
  - `RUNNER_HOOKS: { hooks: … }` in `src/main/claudeArgs.ts` (equal to `docker/runner/hooks.settings.json`)
  - `CLAUDE_COAUTHOR = 'Co-Authored-By: Claude <noreply@anthropic.com>'`, `MAX_COAUTHOR_NAME = 64`
  - `coAuthorName(o: Pick<SessionOwner, 'name' | 'login'>): string`
  - `attributionFor(o: SessionOwner): { commit: string; pr: string } | null`
  - `sessionSettings(owner: SessionOwner | null): string | null`
  - `withAttribution(args: readonly string[], owner: SessionOwner | null): string[]`

- [ ] **Step 1: Write the failing tests**

`src/host/attribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNNER_HOOK_SETTINGS, RUNNER_HOOKS } from '../main/claudeArgs.js';
import type { SessionOwner } from '../preload/sessionOwner.js';
import { attributionFor, CLAUDE_COAUTHOR, coAuthorName, sessionSettings, withAttribution } from './attribution.js';

const UUID = '0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11';
const ann: SessionOwner = { kind: 'user', provider: 'github', id: '12345', login: 'ann', name: 'Ann Example', avatarUrl: null };

describe('RUNNER_HOOKS', () => {
  it('is docker/runner/hooks.settings.json', () => {
    expect(RUNNER_HOOKS).toEqual(JSON.parse(readFileSync(resolve(__dirname, '../../docker/runner/hooks.settings.json'), 'utf8')));
  });
});

describe('coAuthorName', () => {
  it.each([
    ['Ann Example', 'Ann Example'],
    ['  Zoë   Ŝmith-Jones Jr. ', 'Zoë Ŝmith-Jones Jr.'],
    ['Ann <ann@evil.io>', 'Ann annevil.io'],
    ['$(rm -rf ~)`id`', 'rm -rf id'],
    ['a"b\\c\'d', 'abcd'],
    ['line\nCo-authored-by: Mallory <m@x.io>', 'line Co-authored-by Mallory mx.io'],
    ['‮evil', 'evil'],
    ['x'.repeat(100), 'x'.repeat(64)],
    ['', 'ann'],
    [null, 'ann'],
    ['<>"', 'ann']
  ])('%j → %j', (name, want) => {
    expect(coAuthorName({ login: 'ann', name: name as string | null })).toBe(want);
  });
});

describe('attributionFor', () => {
  it('credits a GitHub person: Claude, then the person; and the PR line', () => {
    expect(attributionFor(ann)).toEqual({
      commit: `${CLAUDE_COAUTHOR}\nCo-authored-by: Ann Example <12345+ann@users.noreply.github.com>`,
      pr: '🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @ann'
    });
  });

  it('gives machines, automation runs, publishers and malformed owners nothing', () => {
    expect(attributionFor({ ...ann, kind: 'machine', login: 'acme-bot[bot]' })).toBeNull();
    expect(attributionFor({ kind: 'automation', provider: 'fleet-host', id: '01JC0000000000000000000000', login: 'automation', name: null, avatarUrl: null })).toBeNull();
    expect(attributionFor({ ...ann, kind: 'publisher' })).toBeNull();
    expect(attributionFor({ ...ann, provider: 'oidc' })).toBeNull();
    expect(attributionFor({ ...ann, login: '-ann' })).toBeNull();
    expect(attributionFor({ ...ann, login: 'ann@evil' })).toBeNull();
    expect(attributionFor({ ...ann, id: '0' })).toBeNull();
    expect(attributionFor({ ...ann, id: '12345 ' })).toBeNull();
  });
});

describe('sessionSettings / withAttribution', () => {
  it('is the runner hooks plus attribution, and nothing else', () => {
    const s = JSON.parse(sessionSettings(ann)!);
    expect(Object.keys(s).sort()).toEqual(['attribution', 'hooks']);
    expect(s.hooks).toEqual(RUNNER_HOOKS.hooks);
    expect(Object.keys(s.attribution).sort()).toEqual(['commit', 'pr']);
  });

  it('a hostile name stays inside one string value', () => {
    const s = JSON.parse(sessionSettings({ ...ann, name: '","hooks":{"SessionStart":[]},"x":"' })!);
    expect(Object.keys(s).sort()).toEqual(['attribution', 'hooks']);
    expect(s.hooks).toEqual(RUNNER_HOOKS.hooks);
    expect(s.attribution.commit).toBe(`${CLAUDE_COAUTHOR}\nCo-authored-by: hooksSessionStartx <12345+ann@users.noreply.github.com>`);
  });

  it('swaps only the gated hooks pair, and only for a person', () => {
    const args = ['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID];
    expect(withAttribution(args, ann)).toEqual(['--settings', sessionSettings(ann), '--session-id', UUID]);
    expect(withAttribution(args, { ...ann, kind: 'machine', login: 'acme-bot[bot]' })).toEqual(args);
    expect(withAttribution(args, null)).toEqual(args);
    expect(withAttribution(['--resume', UUID], ann)).toEqual(['--resume', UUID]);
  });
});
```

`src/host/attributionClaude.test.ts`:

```ts
// D112: the pinned claude honours inline `--settings` hooks and attribution. Runs only where the
// installed claude is the Dockerfile pin (this workspace, the runner images); skipped elsewhere.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionSettings } from './attribution.js';

const PIN = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(readFileSync(resolve(__dirname, '../../docker/Dockerfile'), 'utf8'))?.[1];

function installed(): string | null {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim().split(/\s+/)[0];
  } catch {
    return null;
  }
}

describe.skipIf(!PIN || installed() !== PIN)(`claude ${PIN} and the session settings`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'attr-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the hooks and sends the commit and PR attribution to the model', async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        bodies.push(b);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const marker = join(dir, 'hook-ran');
    const settings = JSON.parse(sessionSettings({ kind: 'user', provider: 'github', id: '12345', login: 'ann', name: 'Ann Example', avatarUrl: null })!);
    // The runner's hook scripts don't exist here; one stand-in proves hooks load from the same flag.
    settings.hooks = { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] };
    const home = join(dir, 'home');
    const cwd = join(dir, 'repo');
    mkdirSync(home);
    mkdirSync(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    await new Promise<void>((done) => {
      const p = spawn('claude', ['-p', 'hi', '--settings', JSON.stringify(settings)], {
        cwd,
        stdio: 'ignore',
        env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }
      });
      p.on('exit', () => done());
    });
    server.close();
    expect(existsSync(marker)).toBe(true);
    const sent = bodies.join('\n');
    expect(sent).toContain('Co-authored-by: Ann Example <12345+ann@users.noreply.github.com>');
    expect(sent).toContain('on behalf of @ann');
  }, 90_000);
});
```

In `src/host/attachHub.test.ts`, add imports:

```ts
import { sessionSettings } from './attribution.js';
import { ownerOfIdentity } from './sessionOwners.js';
```

replace the `SETTINGS_ARG` constant with:

```ts
/** The `--settings` value a CREATE by alice carries. */
const SETTINGS_ARG = sessionSettings(ownerOfIdentity(alice))!;
```

and add inside `describe('CREATE args', …)`:

```ts
  it('each CREATE carries its own caller’s attribution; machines keep the hooks file', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    const robot = { ...person('acme-bot[bot]', 9), kind: 'machine' as const, appId: 5 };
    await hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'b', args: ['--session-id', UUID] }));
    await hub.viewer({ identity: robot, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'm' }));
    expect(broker.created[0].args.slice(0, 2)).toEqual(['--settings', sessionSettings(ownerOfIdentity(bob))]);
    expect(JSON.parse(broker.created[0].args[1]).attribution.pr).toBe('🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @bob');
    expect(broker.created[1].args.slice(0, 2)).toEqual(['--settings', RUNNER_HOOK_SETTINGS]);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/host/attribution.test.ts src/host/attachHub.test.ts`.
Expected: FAIL, `Failed to resolve import "./attribution.js"`.

- [ ] **Step 3: Add `RUNNER_HOOKS`**

In `src/main/claudeArgs.ts`, after `RUNNER_HOOK_SETTINGS`:

```ts
/** The content of RUNNER_HOOK_SETTINGS, for fleet-host, which passes settings inline (D113). */
export const RUNNER_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' }] }],
    PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' }] }],
    SessionStart: [{
      hooks: [
        { type: 'command', command: '/usr/local/lib/claude-fleet/session-report.sh' },
        { type: 'command', command: '/usr/local/lib/claude-fleet/backfill-summaries.sh' }
      ]
    }],
    Stop: [{
      hooks: [
        { type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' },
        { type: 'command', command: '/usr/local/lib/claude-fleet/summarize.sh' }
      ]
    }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' }] }]
  }
} as const;
```

- [ ] **Step 4: Implement `attribution.ts`**

`src/host/attribution.ts`:

```ts
// The per-session attribution layer (remote-workspaces §4 Authorship; D112–D114): claude's
// `attribution` setting, passed inline with the runner hooks because `--settings` is single-valued.
import { RUNNER_HOOK_SETTINGS, RUNNER_HOOKS } from '../main/claudeArgs.js';
import { OWNER_LOGIN_RE, type SessionOwner } from '../preload/sessionOwner.js';

/** The setting replaces Claude's own co-author line, so it is re-added. */
export const CLAUDE_COAUTHOR = 'Co-Authored-By: Claude <noreply@anthropic.com>';
export const MAX_COAUTHOR_NAME = 64;
const ACCOUNT_ID_RE = /^[1-9][0-9]{0,19}$/;

/** Letters, marks, digits, space, `.` and `-` only: the name ends up in a git command the model writes. */
export function coAuthorName(o: Pick<SessionOwner, 'name' | 'login'>): string {
  const n = (o.name ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N} .-]/gu, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, MAX_COAUTHOR_NAME)
    .trim();
  return n || o.login;
}

export function attributionFor(o: SessionOwner): { commit: string; pr: string } | null {
  if (o.kind !== 'user' || o.provider !== 'github' || !ACCOUNT_ID_RE.test(o.id) || !OWNER_LOGIN_RE.test(o.login)) return null;
  return {
    commit: `${CLAUDE_COAUTHOR}\nCo-authored-by: ${coAuthorName(o)} <${o.id}+${o.login}@users.noreply.github.com>`,
    pr: `🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @${o.login}`
  };
}

/** The inline `--settings` value for a session `owner` starts; null keeps the hooks file. */
export function sessionSettings(owner: SessionOwner | null): string | null {
  const attribution = owner ? attributionFor(owner) : null;
  return attribution ? JSON.stringify({ hooks: RUNNER_HOOKS.hooks, attribution }) : null;
}

/** hostCreateArgs output with the hooks file swapped for the inline settings. */
export function withAttribution(args: readonly string[], owner: SessionOwner | null): string[] {
  const s = sessionSettings(owner);
  if (!s || args[0] !== '--settings' || args[1] !== RUNNER_HOOK_SETTINGS) return [...args];
  return ['--settings', s, ...args.slice(2)];
}
```

In `src/host/attachHub.ts`, add `import { withAttribution } from './attribution.js';` and in `Viewer.create` replace

```ts
    const args = this.hub.createArgs(gated.args);
```

with

```ts
    const args = this.hub.createArgs(withAttribution(gated.args, claim.owner));
```

- [ ] **Step 5: Name the check at the pin**

In `docker/Dockerfile`, directly above `RUN npm install -g @anthropic-ai/claude-code@2.1.281`, add:

```dockerfile
# Remote session attribution relies on this version's `attribution` setting and inline
# --settings; src/host/attributionClaude.test.ts re-checks both against the installed claude.
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run `npx vitest run src/host/attribution.test.ts src/host/attachHub.test.ts src/host/attributionClaude.test.ts src/host/importGraph.test.ts`.
Expected: PASS. In this workspace (claude 2.1.281 installed) `attributionClaude.test.ts` runs and passes in about 5 s; where claude is missing or another version, it reports as skipped.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/claudeArgs.ts src/host/attribution.ts src/host/attribution.test.ts src/host/attributionClaude.test.ts src/host/attachHub.ts src/host/attachHub.test.ts docker/Dockerfile
git commit -m "feat(owners): inline --settings attribution for each person's sessions"
```

**Verification:**

| Where | What |
|---|---|
| Local | All of the above, including the live check against the installed claude 2.1.281. |
| CI | Unit tests; `attributionClaude.test.ts` skips (no claude on the runner). |
| Cluster | In a session a person started: `ps -o args= -C claude` shows `--settings {"hooks":…,"attribution":…}`; the waiting chip still works (hooks loaded); a commit made by claude ends with both co-author trailers; a PR body ends with "on behalf of @<login>". |

---

### Task 6: Owners in the fleet-state MCP

**Files:**
- Modify `src/main/mcpCore.ts`.
- Modify `src/host/hostMcp.ts`, `src/host/holder.ts`.
- Create `src/main/mcpOwner.test.ts`.
- Modify `src/host/hostMcp.test.ts`.

**Interfaces:**
- Consumes: `SessionOwner`, `OwnerCostRow` (Task 1); `SessionOwnerStore` (Task 3); `Holder.owners` (Task 4).
- Produces:
  - `interface OwnerHandlers { ownersOf(sessionIds: readonly string[], allowed: ReadonlySet<string>): Promise<Map<string, SessionOwner>>; ownerCosts(allowed: ReadonlySet<string>, o: { since?: number }): Promise<OwnerCostRow[]> }`
  - `setOwnerHandlers(h: OwnerHandlers | null): void`
  - `HOST_ONLY_TOOLS: Tool[]` (`cost_by_owner`)
  - `get_cost` / `session_summary` results gain `owner: SessionOwner | null` when handlers are set
  - `startHostMcp({ …, owners?: Pick<SessionOwnerStore, 'ownersOf' | 'ownerCosts'> })`; `HOST_MCP_TOOLS` has 16 names

- [ ] **Step 1: Write the failing tests**

`src/main/mcpOwner.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, handleMcpRequestForTests, initReadSource, releaseReadSource, setExposedTools, setOwnerHandlers } from './mcpCore.js';
import type { OwnedReadSource } from './store/readSource.js';
import type { SessionOwner } from '../preload/sessionOwner.js';

const W = '01JC0000000000000000000000';
const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null };
const rs = {
  queryFlavor: null,
  close: async () => undefined,
  forgetCaller: async () => undefined,
  sessionWorkspace: async () => W,
  tokenGroups: async () => [],
  summaryParts: async () => ({ files: [], commands: [], tokens: [], span: { started_at: 1, last_active_at: 2 } })
} as unknown as OwnedReadSource;
const result = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
const listed = () => (handleMcpRequestForTests('tools/list') as { tools: Array<{ name: string }> }).tools.map((t) => t.name);

afterEach(() => {
  setOwnerHandlers(null);
  setExposedTools(null);
  releaseReadSource();
});

describe('session owners in the MCP core', () => {
  it('without owner handlers (the desktop) nothing changes', async () => {
    initReadSource(rs);
    expect(listed()).not.toContain('cost_by_owner');
    expect(result(await callTool({ name: 'get_cost', arguments: { session_id: 's1' } }, W))).not.toHaveProperty('owner');
    expect(result(await callTool({ name: 'session_summary', arguments: { id: 's1' } }, W))).not.toHaveProperty('owner');
  });

  it('with owner handlers get_cost and session_summary carry the owner, null when unknown', async () => {
    initReadSource(rs);
    const asked: Array<[readonly string[], string[]]> = [];
    setOwnerHandlers({
      ownersOf: async (ids, allowed) => { asked.push([ids, [...allowed]]); return new Map(ids.filter((i) => i === 's1').map((i) => [i, ann])); },
      ownerCosts: async () => []
    });
    expect(result(await callTool({ name: 'get_cost', arguments: { session_id: 's1' } }, W)).owner).toEqual(ann);
    expect(result(await callTool({ name: 'session_summary', arguments: { id: 's2' } }, W)).owner).toBeNull();
    expect(asked).toEqual([[['s1'], [W]], [['s2'], [W]]]);
  });

  it('cost_by_owner is served only where exposed, with the caller scope and a numeric since', async () => {
    initReadSource(rs);
    const got: unknown[] = [];
    setOwnerHandlers({ ownersOf: async () => new Map(), ownerCosts: async (allowed, o) => { got.push([[...allowed], o]); return [{ owner: ann, sessions: 1, usd: 2 }]; } });
    expect(listed()).not.toContain('cost_by_owner');
    setExposedTools(new Set(['cost_by_owner']));
    expect(listed()).toEqual(['cost_by_owner']);
    expect(result(await callTool({ name: 'cost_by_owner', arguments: { since: 5 } }, W))).toEqual([{ owner: ann, sessions: 1, usd: 2 }]);
    await callTool({ name: 'cost_by_owner', arguments: { since: 'yesterday' } }, W);
    expect(got).toEqual([[[W], { since: 5 }], [[W], { since: undefined }]]);
  });
});
```

In `src/host/hostMcp.test.ts`:
- add to the `rs` fake: `sessionWorkspace: async () => WS,` and `tokenGroups: async () => [],`;
- in `describe('HOST_MCP_TOOLS', …)` change `toBe(15)` to `toBe(16)`, `toBe(16)` to `toBe(17)`, and add `expect(HOST_MCP_TOOLS.has('cost_by_owner')).toBe(true);`;
- in `'is not served without an embedder'` change `toHaveLength(15)` to `toHaveLength(16)`;
- add:

```ts
describe('session owners on the host', () => {
  it('get_cost carries the owner and cost_by_owner groups the whole scope, partitions included', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const ann = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null } as const;
    const seen: unknown[] = [];
    const owners = {
      ownersOf: async (ids: readonly string[], ws: readonly string[]) => { seen.push(['ownersOf', ids, ws]); return new Map([['s1', ann]]); },
      ownerCosts: async (ws: readonly string[], o?: { since?: number }) => { seen.push(['ownerCosts', ws, o]); return [{ owner: ann, sessions: 1, usd: 2 }]; }
    };
    const sock = join(dir, 'mcp.sock');
    mcp = await startHostMcp({ listen: { path: sock }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), owners, scope: async () => ['pub_a'] });
    const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const out = await rpc(sock, [call(1, 'get_cost', { session_id: 's1' }), call(2, 'cost_by_owner', { since: 5 })]);
    const by = new Map(out.map((m) => [m.id, JSON.parse(m.result.content[0].text)]));
    expect(by.get(1)).toMatchObject({ session_id: 's1', owner: ann });
    expect(by.get(2)).toEqual([{ owner: ann, sessions: 1, usd: 2 }]);
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(expect.arrayContaining([['ownersOf', ['s1'], [WS, 'pub_a']], ['ownerCosts', [WS, 'pub_a'], { since: 5 }]]));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/mcpOwner.test.ts src/host/hostMcp.test.ts`.
Expected: FAIL, `setOwnerHandlers` is not exported and the host tool count is 15.

- [ ] **Step 3: Implement in `mcpCore.ts`**

Add to the imports:

```ts
import type { OwnerCostRow, SessionOwner } from '../preload/sessionOwner.js';
```

Directly after `setExposedTools`:

```ts
/** Host only (remote-workspaces (f)): owners for the `owner` fields and cost_by_owner. */
export interface OwnerHandlers {
  ownersOf(sessionIds: readonly string[], allowed: ReadonlySet<string>): Promise<Map<string, SessionOwner>>;
  ownerCosts(allowed: ReadonlySet<string>, o: { since?: number }): Promise<OwnerCostRow[]>;
}
let ownerHandlers: OwnerHandlers | null = null;
export function setOwnerHandlers(h: OwnerHandlers | null): void {
  ownerHandlers = h;
}
async function ownerField(sessionId: string, allowed: ReadonlySet<string>): Promise<{ owner?: SessionOwner | null }> {
  if (!ownerHandlers) return {};
  return { owner: (await ownerHandlers.ownersOf([sessionId], allowed)).get(sessionId) ?? null };
}
```

Replace `servedTools`:

```ts
function servedTools(): Tool[] {
  return exposedTools ? [...TOOLS, ...HOST_ONLY_TOOLS].filter((t) => exposedTools!.has(t.name)) : TOOLS;
}
```

Add `'cost_by_owner'` to `STATE_DB_TOOLS`:

```ts
const STATE_DB_TOOLS = new Set([
  'list_sessions', 'get_session', 'get_cost', 'list_events', 'search_transcripts', 'session_summary',
  'list_errors', 'query', 'mark_useful', 'cost_by_owner',
]);
```

In `get_cost`'s `run`, the return becomes:

```ts
      return {
        session_id: a.session_id,
        ...aggregateSessionCost(await source(rs).tokenGroups(ctx.allowedWorkspaces, a.session_id)),
        ...(await ownerField(a.session_id, ctx.allowedWorkspaces))
      };
```

In `session_summary`'s `run`, inside the object passed to `withIso`, after `...aggregateSessionCost(parts.tokens),`:

```ts
          ...(await ownerField(a.id, ctx.allowedWorkspaces)),
```

Directly after the closing `];` of `export const TOOLS: Tool[] = [`:

```ts
/** Served only when a process exposes them by name (fleet-host); the desktop's full list never includes them. */
export const HOST_ONLY_TOOLS: Tool[] = [
  {
    name: 'cost_by_owner',
    description:
      'USD per session owner (the person who started each session; automation runs and published sessions count ' +
      'as their own owners), most expensive first, at most 100 owners. Optional since (epoch ms on last_active_at).',
    inputSchema: { type: 'object', properties: { since: { type: 'number', description: 'epoch ms, last_active_at >= since' } } },
    run: async (_rs, a, ctx) => {
      if (!ownerHandlers) throw new Error('cost_by_owner is unavailable');
      return ownerHandlers.ownerCosts(ctx.allowedWorkspaces, { since: typeof a.since === 'number' && Number.isFinite(a.since) ? a.since : undefined });
    }
  }
];
```

- [ ] **Step 4: Wire the host**

In `src/host/hostMcp.ts`:
- import `setOwnerHandlers` from `../main/mcpCore.js` and `type SessionOwnerStore` from `./sessionOwners.js`;
- `HOST_MCP_TOOLS` gains `'cost_by_owner'` after `'mark_useful'`;
- add to the `startHostMcp` options:

```ts
  /** The holder's owner store: `owner` on get_cost/session_summary, and cost_by_owner. */
  owners?: Pick<SessionOwnerStore, 'ownersOf' | 'ownerCosts'>;
```

- after `setUsageRecorder(o.recordUsage ?? null);`:

```ts
  const owners = o.owners;
  setOwnerHandlers(owners
    ? { ownersOf: (ids, allowed) => owners.ownersOf(ids, [...allowed]), ownerCosts: (allowed, x) => owners.ownerCosts([...allowed], x) }
    : null);
```

- in `reset()`, after `setUsageRecorder(null);`: `setOwnerHandlers(null);`.

In `src/host/holder.ts`, give `mcpServer` an `owners: SessionOwnerStore` parameter after `publish`, pass `owners` at the call site (`mcpServer(o, embedder?.embed, publish, owners, () => …)`), and add `owners` to its `startHostMcp({ … })` options.

- [ ] **Step 5: Run the tests and confirm they pass**

Run `npx vitest run src/main/mcpOwner.test.ts src/host/hostMcp.test.ts src/main/mcpServer.test.ts`.
Expected: PASS. `mcpServer.test.ts` confirms the desktop tool list is unchanged.

Run `npx vitest run -c vitest.pg.config.ts src/host/main.pg.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpCore.ts src/main/mcpOwner.test.ts src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/holder.ts
git commit -m "feat(owners): owner on host get_cost/session_summary, and cost_by_owner"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit and Postgres suites. |
| CI | Same, plus the e2e MCP contract specs (`tests/mcp-*.spec.ts`), which pin the desktop surface and must stay green unchanged. |
| Cluster | From a session: `cost_by_owner` lists people, `automation` and publishers; `get_cost` on a person's session shows their `owner`. |

---

### Task 7: Owners over RPC

**Files:**
- Modify `src/host/historyRead.ts`, `src/host/historyRpc.ts`, `src/host/holder.ts`.
- Modify `src/host/historyRpc.test.ts`, `src/host/historyRead.pg.test.ts`, `src/host/main.pg.test.ts`.

**Interfaces:**
- Consumes: `SessionOwnerStore` (Task 3), `Holder.owners` (Task 4).
- Produces:
  - `type OwnedSessionRow = RemoteSessionRow & { owner: SessionOwner | null }`
  - `HistoryReader.sessions` resolves `{ rows: OwnedSessionRow[]; next }`; `HistoryReader.ownerCosts(): Promise<{ rows: OwnerCostRow[] }>`
  - `historyReader(k, workspaceId, owners?: Pick<SessionOwnerStore, 'ownersOf' | 'ownerCosts'>)`
  - RPC channel `history:owners` (`read`, no arguments) → `{ rows: OwnerCostRow[] }`

- [ ] **Step 1: Write the failing tests**

In `src/host/historyRpc.test.ts`, the `reader()` fake gains `ownerCosts: vi.fn(async () => ({ rows: [] })),`, and add:

```ts
  it('history:owners reads the hosted workspace only, ignores arguments, and 503s without a holder', async () => {
    const r = reader();
    const reg = historyRpcChannels(() => r);
    expect(await dispatchRpc(reg, 'history:owners', { args: ['X', { workspaceId: 'X' }] }, caller))
      .toEqual({ status: 200, body: { ok: true, result: { rows: [] } } });
    expect(r.ownerCosts).toHaveBeenCalledWith();
    expect((await dispatchRpc(historyRpcChannels(() => null), 'history:owners', { args: [] }, caller)).status).toBe(503);
  });
```

In `src/host/historyRead.pg.test.ts`, inside `describe.skipIf(!isPg)('sessionsPage', …)`:

```ts
  it('the reader adds each row’s owner, asking only about the hosted workspace', async () => {
    const k = await rig();
    const ann = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null } as const;
    const asked: Array<[readonly string[], readonly string[]]> = [];
    const r = historyReader(() => k, HOSTED, {
      ownersOf: async (ids, ws) => { asked.push([ids, ws]); return new Map([['s-01', ann]]); },
      ownerCosts: async (ws) => (ws.length === 1 && ws[0] === HOSTED ? [{ owner: ann, sessions: 1, usd: 1 }] : [])
    });
    const page = await r.sessions({ after: null, limit: 200 });
    expect(page.rows.find((x) => x.id === 's-01')?.owner).toEqual(ann);
    expect(page.rows.filter((x) => x.id !== 's-01').every((x) => x.owner === null)).toBe(true);
    expect(asked).toEqual([[page.rows.map((x) => x.id), [HOSTED]]]);
    expect(await r.ownerCosts()).toEqual({ rows: [{ owner: ann, sessions: 1, usd: 1 }] });
    expect(await historyReader(() => k, HOSTED).ownerCosts()).toEqual({ rows: [] });
  });
```

In `src/host/main.pg.test.ts`:

```ts
  it('history RPC shows each session’s owner and groups cost by owner', async () => {
    const SID = '22222222-3333-4444-8555-666666666666';
    const broker = fakeBroker([]);
    const a = await start({ brokerOps: broker.ops });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(jsonFrame(FrameType.CREATE, { id: 'v3', args: ['--session-id', SID] }));
    await vi.waitFor(() => expect(broker.created).toHaveLength(1), { timeout: 10_000 });
    ws.close();
    await t!.pool.query(`INSERT INTO ${t!.schema}.sessions (id, workspace_id, last_active_at) VALUES ($1, $2, 5), ('u1', $2, 4)`, [SID, ID]);
    await t!.pool.query(`INSERT INTO ${t!.schema}.session_costs (session_id, workspace_id, model, service_tier, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, event_count) VALUES ($1, $2, 'claude-opus-4-1', '', 1000, 0, 0, 0, 1)`, [SID, ID]);
    const call = async (channel: string, args: unknown[]) => {
      const res = await fetch(`${a.url}/rpc/${channel}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ args })
      });
      return (await res.json()) as Record<string, any>;
    };
    await vi.waitFor(async () => expect((await call('history:sessions', [{}])).ok).toBe(true), { timeout: 10_000 });
    const page = await call('history:sessions', [{}]);
    expect(page.result.rows.map((r: { id: string; owner: { login: string } | null }) => [r.id, r.owner?.login ?? null])).toEqual([[SID, 'owner'], ['u1', null]]);
    const owners = await call('history:owners', []);
    expect(owners.result.rows).toEqual([
      { owner: { kind: 'user', provider: 'github', id: '1', login: 'owner', name: null, avatarUrl: null }, sessions: 1, usd: expect.any(Number) }
    ]);
  }, 30_000);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/host/historyRpc.test.ts`.
Expected: FAIL, `no such channel` for `history:owners`.

- [ ] **Step 3: Implement**

In `src/host/historyRead.ts`, add imports:

```ts
import type { OwnerCostRow, SessionOwner } from '../preload/sessionOwner.js';
import type { SessionOwnerStore } from './sessionOwners.js';
```

after `RemoteSessionRow`:

```ts
export type OwnedSessionRow = RemoteSessionRow & { owner: SessionOwner | null };
```

replace the `HistoryReader` interface and `historyReader` with:

```ts
export interface HistoryReader {
  workspaceId: string;
  sessions(req: SessionsPageReq): Promise<{ rows: OwnedSessionRow[]; next: SessionCursor | null }>;
  /** null: the workspace's latest session. A session outside the workspace answers null. */
  summary(sessionId: string | null): Promise<WorkspaceSummary | null>;
  /** The exact pgvector scan over the hosted workspace (D66). */
  search(req: SearchReq): Promise<{ modelId: string; hits: EmbeddingHit[] }>;
  /** Cost per owner over the hosted workspace (D121). */
  ownerCosts(): Promise<{ rows: OwnerCostRow[] }>;
}

/** `summary` goes through db.ts's global store (summaryForWorkspace/summaryForSession), the same
 *  handle the holder passes as `k` here, not a store `k` could swap per call. */
export function historyReader(
  k: () => Kysely<StateDb>, workspaceId: string, owners?: Pick<SessionOwnerStore, 'ownersOf' | 'ownerCosts'>
): HistoryReader {
  return {
    workspaceId,
    async sessions(req) {
      const page = await sessionsPage(k(), workspaceId, req);
      const m = owners && page.rows.length > 0 ? await owners.ownersOf(page.rows.map((r) => r.id), [workspaceId]) : new Map<string, SessionOwner>();
      return { rows: page.rows.map((r) => ({ ...r, owner: m.get(r.id) ?? null })), next: page.next };
    },
    async summary(sessionId) {
      if (sessionId === null) return summaryForWorkspace(workspaceId);
      const row = await k().selectFrom('sessions').select('workspace_id').where('id', '=', sessionId).executeTakeFirst();
      return row?.workspace_id === workspaceId ? summaryForSession(sessionId) : null;
    },
    async search(req) {
      const hits = await readTransaction(k(), (q) => pgSearchEmbeddings(q, req.vector, [workspaceId], { limit: req.limit, kind: req.kind }));
      return {
        modelId: EMBED_MODEL_ID,
        hits: hits.map((h) => ({ ...h, text: h.text.slice(0, SEARCH_TEXT_MAX), score: Number(h.score), ts: num(h.ts) }))
      };
    },
    ownerCosts: async () => ({ rows: owners ? await owners.ownerCosts([workspaceId]) : [] }),
  };
}
```

In `src/host/historyRpc.ts`, add to the returned map after `history:summary`:

```ts
    ['history:owners', { tier: 'read', handle: () => guarded(() => need().ownerCosts()) }],
```

In `src/host/holder.ts`, the returned `history` becomes `historyReader(stateKysely, o.workspaceId, owners)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/host/historyRpc.test.ts src/host/server.test.ts`.
Expected: PASS.

Run `npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts src/host/main.pg.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/host/historyRead.ts src/host/historyRpc.ts src/host/holder.ts src/host/historyRpc.test.ts src/host/historyRead.pg.test.ts src/host/main.pg.test.ts
git commit -m "feat(owners): owner on history:sessions rows, and history:owners"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit and Postgres suites. |
| CI | Same. |
| Cluster | `POST /rpc/history:owners` with a `read` token returns the per-owner rows; `history:sessions` rows carry `owner`. |

---

### Task 8: Desktop validation, reader and IPC

**Files:**
- Modify `src/main/federation/remoteRows.ts`, `src/main/federation/federatedReader.ts`, `src/main/federation/federationIpc.ts`.
- Modify `src/preload/index.ts`.
- Modify `src/main/federation/remoteRows.test.ts`, `src/main/federation/federatedReader.test.ts`, `src/main/federation/federationIpc.test.ts`.

**Interfaces:**
- Consumes: `parseSessionOwner`, `MAX_OWNER_COST_ROWS`, `SessionOwner`, `OwnerCostRow` (Task 1); RPC `history:owners` (Task 7).
- Produces:
  - `RemoteSessionItem.owner: SessionOwner | null` (so `RemoteListItem` and the merged `SessionListItem` carry it)
  - `parseOwnerCosts(v: unknown): OwnerCostRow[]`
  - `FederatedReader.ownerCosts(remoteId: string): Promise<OwnerCostRow[] | undefined>`
  - IPC `observability:ownerCosts(workspaceId)` → `OwnerCostRow[] | null`
  - `SessionListItem.owner?: SessionOwner | null`; `window.api.observability.ownerCosts(workspaceId): Promise<OwnerCostRow[] | null>`; preload re-exports `SessionOwner`, `OwnerCostRow`

- [ ] **Step 1: Write the failing tests**

In `src/main/federation/remoteRows.test.ts`, change the import to:

```ts
import { MAX_SEARCH_HITS, parseOwnerCosts, parseSearchReply, parseSessionsPage, parseSummary, RemoteShapeError } from './remoteRows';
```

and add:

```ts
const ann = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann', avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' };

describe('owners on remote rows', () => {
  it('keeps a valid owner; a missing, malformed or hostile one becomes null or is cleaned, and the row stays', () => {
    const p = parseSessionsPage({
      rows: [
        { ...good, id: 'a', owner: ann },
        { ...good, id: 'b' },
        { ...good, id: 'c', owner: { ...ann, login: '-x' } },
        { ...good, id: 'd', owner: { ...ann, name: '<img src=x onerror=alert(1)>‮', avatarUrl: 'https://evil.io/a.png', extra: 1 } }
      ],
      next: null
    }, W);
    expect(p.rows.map((r) => [r.id, r.owner])).toEqual([
      ['a', ann],
      ['b', null],
      ['c', null],
      ['d', { ...ann, name: '<img src=x onerror=alert(1)>', avatarUrl: null }]
    ]);
  });
});

describe('parseOwnerCosts', () => {
  it('keeps valid rows, drops bad ones, and refuses a bad or oversized envelope', () => {
    expect(parseOwnerCosts({
      rows: [
        { owner: ann, sessions: 2, usd: 1.5 },
        { owner: null, sessions: 1, usd: 0 },
        { owner: { ...ann, id: 'x' }, sessions: 1, usd: 1 },
        { owner: null, sessions: -1, usd: 1 },
        { owner: null, sessions: 1, usd: Infinity },
        'junk'
      ]
    })).toEqual([{ owner: ann, sessions: 2, usd: 1.5 }, { owner: null, sessions: 1, usd: 0 }]);
    expect(() => parseOwnerCosts({ rows: Array(101).fill({ owner: null, sessions: 1, usd: 1 }) })).toThrow(RemoteShapeError);
    expect(() => parseOwnerCosts(null)).toThrow(RemoteShapeError);
    expect(() => parseOwnerCosts({ rows: 'x' })).toThrow(RemoteShapeError);
  });
});
```

In `src/main/federation/federatedReader.test.ts`, the expectation on line 23 becomes:

```ts
    expect(out.pages).toEqual([{ origin: A, next: null, rows: [{ ...row('s1', A), owner: null, workspaceName: 'n0', workspaceColorHue: 10, workspaceState: 'running', capture: false, origin: A }] }]);
```

and add inside `describe('FederatedReader', …)`:

```ts
  it('ownerCosts asks only that host, validates, and answers undefined when it is unknown or down', async () => {
    const rpc = vi.fn(async (url: string, channel: string, args: unknown[]) => {
      if (url !== `http://${A}`) throw new RemoteError('forbidden', 'no grant', 403);
      expect([channel, args]).toEqual(['history:owners', []]);
      return { rows: [{ owner: null, sessions: 1, usd: 2 }] };
    });
    const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running'), src(C, 'unreachable')], rpc });
    expect(await r.ownerCosts(A)).toEqual([{ owner: null, sessions: 1, usd: 2 }]);
    expect(await r.ownerCosts(B)).toBeUndefined();
    expect(await r.ownerCosts(C)).toBeUndefined();
    expect(await r.ownerCosts('01JC0000000000000000000009')).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
```

In `src/main/federation/federationIpc.test.ts`, the `rig()` reader gains

```ts
ownerCosts: vi.fn(async (id: string) => (id === A ? [{ owner: null, sessions: 1, usd: 1 }] : undefined)),
```

`rig()` returns `{ h: handlers.get('sessions:listRemote')!, reader, handlers }`, and add:

```ts
describe('observability:ownerCosts', () => {
  it('answers a remote workspace’s rows, null for anything else, and refuses a non-id', async () => {
    const { handlers, reader } = rig();
    const h = handlers.get('observability:ownerCosts')!;
    expect(await h({}, A)).toEqual([{ owner: null, sessions: 1, usd: 1 }]);
    expect(await h({}, '01JC0000000000000000000009')).toBeNull();
    await expect(h({}, '../x')).rejects.toThrow();
    await expect(h({}, 5)).rejects.toThrow();
    expect(reader.ownerCosts).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/main/federation/`.
Expected: FAIL: `parseOwnerCosts` is not exported, rows carry no `owner`, and there's no `observability:ownerCosts` handler.

- [ ] **Step 3: Implement**

In `src/main/federation/remoteRows.ts`, add:

```ts
import { MAX_OWNER_COST_ROWS, parseSessionOwner, type OwnerCostRow, type SessionOwner } from '../../preload/sessionOwner.js';
```

add `owner: SessionOwner | null;` as the last field of `RemoteSessionItem`, and in `parseSessionRow` replace the final `return` with:

```ts
  const owner = r.owner === undefined || r.owner === null ? null : parseSessionOwner(r.owner);
  return { id: r.id, workspaceId, aiTitle, firstUserMessage, userSetName, startedAt, lastActiveAt, eventCount: r.eventCount, usd: r.usd, tags, headless: r.headless, owner };
```

At the end of the file:

```ts
/** `history:owners`. A row with a malformed owner is dropped rather than shown as unattributed. */
export function parseOwnerCosts(v: unknown): OwnerCostRow[] {
  const o = v as { rows?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows) || o.rows.length > MAX_OWNER_COST_ROWS) return fail('owner costs');
  const out: OwnerCostRow[] = [];
  for (const raw of o.rows) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !nat(r.sessions) || !nonNeg(r.usd)) continue;
    const owner = r.owner === null ? null : parseSessionOwner(r.owner);
    if (r.owner !== null && !owner) continue;
    out.push({ owner, sessions: r.sessions, usd: r.usd });
  }
  return out;
}
```

In `src/main/federation/federatedReader.ts`, import `parseOwnerCosts` from `./remoteRows.js` and `type OwnerCostRow` from `../../preload/sessionOwner.js`; add to `FederatedReader`:

```ts
  /** undefined: the host is unknown or unavailable. */
  ownerCosts(remoteId: string): Promise<OwnerCostRow[] | undefined>;
```

and to the returned object after `summary`:

```ts
    async ownerCosts(remoteId) {
      const s = d.sources().find((x) => x.id === remoteId);
      if (!s) return undefined;
      const r = await call(s, 'history:owners', [], parseOwnerCosts);
      return r.ok ? r.value : undefined;
    }
```

In `src/main/federation/federationIpc.ts`, import `type OwnerCostRow` from `../../preload/sessionOwner.js` and add inside `registerFederationIpc`, after `sessions:listRemote`:

```ts
  ipc.handle('observability:ownerCosts', async (_e, id: unknown): Promise<OwnerCostRow[] | null> => {
    if (typeof id !== 'string' || !REMOTE_ID_RE.test(id)) throw new Error('workspaceId must be a workspace id');
    return (await reader.ownerCosts(id)) ?? null;
  });
```

In `src/preload/index.ts`:
- after the `identityTypes` imports:

```ts
import type { OwnerCostRow, SessionOwner } from './sessionOwner';
export type { OwnerCostRow, SessionOwner } from './sessionOwner';
```

- in `SessionListItem`, after `origin?: string;`:

```ts
  /** Remote rows: who started the session (remote-workspaces (f)); null when the host has no owner for it. */
  owner?: SessionOwner | null;
```

- in the `observability` bridge, after `summaryForWorkspace`:

```ts
    /** Cost per owner of a remote workspace (`history:owners`); null for a local workspace or an unavailable host. */
    ownerCosts: (workspaceId: string): Promise<OwnerCostRow[] | null> =>
      ipcRenderer.invoke('observability:ownerCosts', workspaceId),
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/main/federation/ src/main/ipcFederationWiring.test.ts src/renderer/src/sessionsView.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`.
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/federation/remoteRows.ts src/main/federation/federatedReader.ts src/main/federation/federationIpc.ts src/preload/index.ts src/main/federation/remoteRows.test.ts src/main/federation/federatedReader.test.ts src/main/federation/federationIpc.test.ts
git commit -m "feat(owners): validated owners and owner costs from remote hosts"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit tests, both typechecks. |
| CI | Same. |

---

### Task 9: Owners and Mine / Everyone in the Sessions pane

**Files:**
- Create `src/renderer/src/components/OwnerBadge.tsx` and `src/renderer/src/components/OwnerBadge.test.ts`.
- Modify `src/renderer/src/sessionsView.ts` and `src/renderer/src/sessionsView.test.ts`.
- Modify `src/renderer/src/components/SessionsPane.tsx`, `src/renderer/src/styles.css`.

**Interfaces:**
- Consumes: `SessionOwner`, `Me`, `githubAvatarUrl`, `isMine`, `ownerLabel` (Task 1); `SessionListItem.owner` (Task 8).
- Produces:
  - `OwnerBadge({ owner }: { owner: SessionOwner })`
  - `type OwnerFilter = 'everyone' | 'mine'`
  - `filterByOwner<T extends { origin?: string; owner?: SessionOwner | null }>(rows: readonly T[], f: OwnerFilter, me: Me | null): T[]`
  - `hasRemoteRows(rows: readonly SessionListItem[]): boolean`

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/components/OwnerBadge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerBadge } from './OwnerBadge';
import type { SessionOwner } from '../../../preload/sessionOwner';

const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann Example', avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' };
const html = (owner: SessionOwner) => renderToStaticMarkup(createElement(OwnerBadge, { owner }));

describe('OwnerBadge', () => {
  it('shows the avatar, name and @login', () => {
    const h = html(ann);
    expect(h).toContain('src="https://avatars.githubusercontent.com/u/7?v=4"');
    expect(h).toMatch(/referrerpolicy="no-referrer"/i);
    expect(h).toContain('>Ann Example<');
    expect(h).toContain('>@ann<');
  });

  it('renders hostile text as text, and never loads an off-host avatar', () => {
    const h = html({ ...ann, name: '<img src=x onerror=alert(1)>', avatarUrl: 'https://evil.io/a.png' });
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).not.toContain('evil.io');
    expect(h).toContain('owner-initial');
  });

  it('automation runs read "automation", with no handle', () => {
    const h = html({ kind: 'automation', provider: 'fleet-host', id: '01JC0000000000000000000000', login: 'automation', name: null, avatarUrl: null });
    expect(h).toContain('>automation<');
    expect(h).not.toContain('@automation');
  });
});
```

In `src/renderer/src/sessionsView.test.ts`, add `filterByOwner` and `hasRemoteRows` to the `./sessionsView` import, `import type { SessionOwner } from '../../preload/sessionOwner';`, and:

```ts
describe('filterByOwner / hasRemoteRows', () => {
  const R = '01JC0000000000000000000000';
  const me = { provider: 'github', id: 7 };
  const owner = (id: string, kind: SessionOwner['kind'] = 'user'): SessionOwner => ({ kind, provider: 'github', id, login: `u${id}`, name: null, avatarUrl: null });
  const rows: Array<{ id: string; origin?: string; owner?: SessionOwner | null }> = [
    { id: 'l' },
    { id: 'L', origin: 'local' },
    { id: 'm', origin: R, owner: owner('7') },
    { id: 'o', origin: R, owner: owner('8') },
    { id: 'n', origin: R, owner: null },
    { id: 'b', origin: R, owner: owner('7', 'machine') }
  ];
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

  it('Everyone keeps every row', () => {
    expect(ids(filterByOwner(rows, 'everyone', me))).toEqual(['l', 'L', 'm', 'o', 'n', 'b']);
  });
  it('Mine keeps local rows and the remote rows the signed-in person started', () => {
    expect(ids(filterByOwner(rows, 'mine', me))).toEqual(['l', 'L', 'm']);
  });
  it('Mine with nobody signed in keeps only local rows', () => {
    expect(ids(filterByOwner(rows, 'mine', null))).toEqual(['l', 'L']);
  });
  it('hasRemoteRows', () => {
    expect(hasRemoteRows([])).toBe(false);
    expect(hasRemoteRows([{ origin: 'local' } as never, { origin: undefined } as never])).toBe(false);
    expect(hasRemoteRows([{ origin: R } as never])).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/renderer/src/components/OwnerBadge.test.ts src/renderer/src/sessionsView.test.ts`.
Expected: FAIL: `./OwnerBadge` doesn't resolve and `filterByOwner` isn't exported.

- [ ] **Step 3: Implement**

`src/renderer/src/components/OwnerBadge.tsx`:

```tsx
// A session's owner (remote-workspaces (f)). Host-supplied text: React text nodes only; an avatar
// loads only from GitHub's avatar host (D120).
import { githubAvatarUrl, ownerLabel, type SessionOwner } from '../../../preload/sessionOwner';

export function OwnerBadge({ owner }: { owner: SessionOwner }) {
  const avatar = githubAvatarUrl(owner.avatarUrl);
  const label = ownerLabel(owner);
  const handle = owner.kind === 'automation' ? null : `@${owner.login}`;
  return (
    <span className={`owner-badge owner-${owner.kind}`} title={handle && owner.name ? `${owner.name} ${handle}` : label}>
      {avatar ? (
        <img className="owner-avatar" src={avatar} alt="" width={14} height={14} referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span className="owner-avatar owner-initial" aria-hidden="true">
          {label.replace(/^@/, '').charAt(0).toUpperCase()}
        </span>
      )}
      {owner.kind === 'automation' ? <span className="owner-name">automation</span> : owner.name && <span className="owner-name">{owner.name}</span>}
      {handle && <span className="owner-login">{handle}</span>}
    </span>
  );
}
```

In `src/renderer/src/sessionsView.ts`, add `import { isMine, type Me, type SessionOwner } from '../../preload/sessionOwner';` and after `isRemoteRow`:

```ts
export type OwnerFilter = 'everyone' | 'mine';

/** A view filter only (D122): hosts serve every row to a read viewer either way. */
export function filterByOwner<T extends { origin?: string; owner?: SessionOwner | null }>(rows: readonly T[], f: OwnerFilter, me: Me | null): T[] {
  if (f === 'everyone') return [...rows];
  return rows.filter((r) => r.origin === undefined || r.origin === LOCAL_ORIGIN || isMine(r.owner, me));
}

export function hasRemoteRows(rows: readonly SessionListItem[]): boolean {
  return rows.some(isRemoteRow);
}
```

In `src/renderer/src/components/SessionsPane.tsx`:
- add `filterByOwner,`, `hasRemoteRows,` and `type OwnerFilter,` to the `../sessionsView` import list; add `import { OwnerBadge } from './OwnerBadge';` and `import type { Me } from '../../../preload/sessionOwner';`;
- after `const [publishNote, setPublishNote] = useState<string | null>(null);`:

```tsx
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('everyone');
  const [me, setMe] = useState<Me | null>(null);
  const refreshMe = useCallback((): void => {
    window.api.identity.status().then(
      (s) => setMe(s.identity ? { provider: s.identity.provider, id: s.identity.id } : null),
      () => setMe(null)
    );
  }, []);
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);
```

- replace `const scoped = sessionsForScope(items, scope, selectedWorkspaceId);` with:

```tsx
  const scopedAll = sessionsForScope(items, scope, selectedWorkspaceId);
  const showOwnerFilter = hasRemoteRows(scopedAll);
  const ownerShown: OwnerFilter = me && showOwnerFilter ? ownerFilter : 'everyone';
  const scoped = filterByOwner(scopedAll, ownerShown, me);
```

- in the row meta, after `{remoteRow && <CloudGlyph title={`Remote · ${s.workspaceName}`} />}`:

```tsx
            {remoteRow && s.owner && <OwnerBadge owner={s.owner} />}
```

- in the header, replace

```tsx
            All · {allSessionsCount}
          </button>
        </div>
        <input
          type="search"
```

with

```tsx
            All · {allSessionsCount}
          </button>
        </div>
        {showOwnerFilter && (
          <div className="obs-scope-toggle sessions-owner-toggle" role="tablist" aria-label="Session owners">
            <button
              role="tab"
              aria-selected={ownerShown === 'everyone'}
              className={`obs-scope-btn ${ownerShown === 'everyone' ? 'active' : ''}`}
              onClick={() => setOwnerFilter('everyone')}
              title="Every session on the hosts you can read"
            >
              Everyone
            </button>
            <button
              role="tab"
              aria-selected={ownerShown === 'mine'}
              className={`obs-scope-btn ${ownerShown === 'mine' ? 'active' : ''}`}
              disabled={!me}
              onClick={() => {
                setOwnerFilter('mine');
                refreshMe();
              }}
              title={me ? 'This desktop’s sessions and the remote sessions you started' : 'Sign in (Settings → Account) to see only your sessions'}
            >
              Mine
            </button>
          </div>
        )}
        <input
          type="search"
```

Append to `src/renderer/src/styles.css`:

```css
.owner-badge { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; }
.owner-avatar { width: 14px; height: 14px; border-radius: 50%; flex: none; }
.owner-initial { display: inline-flex; align-items: center; justify-content: center; font-size: 9px; background: var(--rule); color: var(--ink-2); }
.owner-name, .owner-login { overflow: hidden; text-overflow: ellipsis; }
.owner-login { color: var(--ink-2); }
.sessions-owner-toggle { flex: none; }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/renderer/src/components/OwnerBadge.test.ts src/renderer/src/sessionsView.test.ts src/renderer/src/components/sessionsPaneRemote.test.ts`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.web.json` and `npm run build`.
Expected: no errors; the build completes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/OwnerBadge.tsx src/renderer/src/components/OwnerBadge.test.ts src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts src/renderer/src/components/SessionsPane.tsx src/renderer/src/styles.css
git commit -m "feat(owners): owner badges and a Mine / Everyone filter on remote session rows"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit tests, web typecheck, build. |
| CI | Same, plus the e2e smoke suite (no remote host there, so the toggle never shows). |
| Host eyeball (Troy) | With a remote bookmark: rows show avatar + name + @login; the toggle appears only when remote rows are in scope; Mine keeps local rows and your remote rows; signed out, Mine is disabled with the tooltip. |

---

### Task 10: Cost by owner in the Observability rail

**Files:**
- Create `src/renderer/src/ownerView.ts`, `src/renderer/src/ownerView.test.ts`.
- Create `src/renderer/src/components/OwnerCostSection.tsx`, `src/renderer/src/components/OwnerCostSection.test.ts`.
- Modify `src/renderer/src/components/ObservabilityPane.tsx`, `src/renderer/src/components/SessionsPane.tsx` (use the moved `formatUsd`), `src/renderer/src/styles.css`.

**Interfaces:**
- Consumes: `OwnerCostRow`, `SessionOwner` (Task 1); `window.api.observability.ownerCosts` (Task 8); `OwnerBadge` (Task 9).
- Produces:
  - `formatUsd(usd: number): string` (moved from `SessionsPane.tsx`, unchanged)
  - `interface OwnerCostLine { key: string; owner: SessionOwner | null; sessions: number; usd: number }`
  - `ownerCostLines(rows: readonly OwnerCostRow[]): OwnerCostLine[]`
  - `OwnerCostList({ rows }: { rows: OwnerCostRow[] | null | undefined })`, `OwnerCostSection({ workspaceId, refreshKey }: { workspaceId: string; refreshKey: number | null })`

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/ownerView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatUsd, ownerCostLines } from './ownerView';
import type { SessionOwner } from '../../preload/sessionOwner';

const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null };

describe('formatUsd', () => {
  it.each([[0, '$0.00'], [0.004, '<$0.01'], [1.234, '$1.23'], [123.46, '$123.5'], [1234.5, '$1,235']])('%d → %s', (n, s) => {
    expect(formatUsd(n)).toBe(s);
  });
});

describe('ownerCostLines', () => {
  it('keeps the host order, one line per owner, with stable keys', () => {
    expect(ownerCostLines([
      { owner: ann, sessions: 2, usd: 3 },
      { owner: null, sessions: 1, usd: 1 },
      { owner: ann, sessions: 9, usd: 9 }
    ])).toEqual([
      { key: 'user:github:7', owner: ann, sessions: 2, usd: 3 },
      { key: 'unattributed', owner: null, sessions: 1, usd: 1 }
    ]);
  });
});
```

`src/renderer/src/components/OwnerCostSection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerCostList, OwnerCostSection } from './OwnerCostSection';

describe('OwnerCostSection', () => {
  it('starts collapsed', () => {
    const h = renderToStaticMarkup(createElement(OwnerCostSection, { workspaceId: '01JC0000000000000000000000', refreshKey: null }));
    expect(h).toContain('Cost by owner');
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('obs-owner-list');
  });
});

describe('OwnerCostList', () => {
  const html = (rows: Parameters<typeof OwnerCostList>[0]['rows']) => renderToStaticMarkup(createElement(OwnerCostList, { rows }));
  it('lists owners as text, unattributed included', () => {
    const h = html([
      { owner: { kind: 'user', provider: 'github', id: '7', login: 'ann', name: '<b>Ann</b>', avatarUrl: null }, sessions: 2, usd: 3 },
      { owner: null, sessions: 1, usd: 0.5 }
    ]);
    expect(h).toContain('&lt;b&gt;Ann&lt;/b&gt;');
    expect(h).toContain('2 sessions');
    expect(h).toContain('$3.00');
    expect(h).toContain('Unattributed');
    expect(h).toContain('1 session<');
  });
  it('says loading, unavailable or empty', () => {
    expect(html(undefined)).toContain('Loading');
    expect(html(null)).toContain('Host unavailable');
    expect(html([])).toContain('No cost recorded yet');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/renderer/src/ownerView.test.ts src/renderer/src/components/OwnerCostSection.test.ts`.
Expected: FAIL: the modules don't exist.

- [ ] **Step 3: Implement**

`src/renderer/src/ownerView.ts`:

```ts
// Per-owner cost (remote-workspaces (f)) for the Observability rail.
import type { OwnerCostRow, SessionOwner } from '../../preload/sessionOwner';

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export interface OwnerCostLine { key: string; owner: SessionOwner | null; sessions: number; usd: number }

/** Host order (most expensive first); a repeated owner keeps its first line. */
export function ownerCostLines(rows: readonly OwnerCostRow[]): OwnerCostLine[] {
  const seen = new Set<string>();
  const out: OwnerCostLine[] = [];
  for (const r of rows) {
    const key = r.owner ? `${r.owner.kind}:${r.owner.provider}:${r.owner.id}` : 'unattributed';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, owner: r.owner, sessions: r.sessions, usd: r.usd });
  }
  return out;
}
```

`src/renderer/src/components/OwnerCostSection.tsx`:

```tsx
// "Cost by owner" for a remote workspace (remote-workspaces §8, D121). Collapsed until opened;
// fetched on open and on each summary change while open.
import { useEffect, useState } from 'react';
import type { OwnerCostRow } from '../../../preload/sessionOwner';
import { formatUsd, ownerCostLines } from '../ownerView';
import { OwnerBadge } from './OwnerBadge';

export function OwnerCostList({ rows }: { rows: OwnerCostRow[] | null | undefined }) {
  if (rows === undefined) return <div className="subdued">Loading…</div>;
  if (rows === null) return <div className="subdued">Host unavailable</div>;
  const lines = ownerCostLines(rows);
  if (lines.length === 0) return <div className="subdued">No cost recorded yet</div>;
  return (
    <ul className="obs-owner-list">
      {lines.map((l) => (
        <li key={l.key} className="obs-owner-row">
          {l.owner ? <OwnerBadge owner={l.owner} /> : <span className="owner-badge subdued">Unattributed</span>}
          <span className="obs-owner-sessions">{`${l.sessions} session${l.sessions === 1 ? '' : 's'}`}</span>
          <span className="obs-owner-usd">{formatUsd(l.usd)}</span>
        </li>
      ))}
    </ul>
  );
}

export function OwnerCostSection({ workspaceId, refreshKey }: { workspaceId: string; refreshKey: number | null }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<OwnerCostRow[] | null | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    window.api.observability.ownerCosts(workspaceId).then(
      (r) => live && setRows(r),
      () => live && setRows(null)
    );
    return () => {
      live = false;
    };
  }, [open, workspaceId, refreshKey]);
  return (
    <section className="obs-owner-costs">
      <button type="button" className="btn-mini obs-owner-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Cost by owner
      </button>
      {open && <OwnerCostList rows={rows} />}
    </section>
  );
}
```

In `src/renderer/src/components/ObservabilityPane.tsx`, add `import { OwnerCostSection } from './OwnerCostSection';` and, directly after the `)}` that closes the `!summary || summary.sessionId === null ? … : <SummaryView … />` expression:

```tsx
            {workspace?.kind === 'remote' && (
              <OwnerCostSection workspaceId={workspace.id} refreshKey={summary?.lastActiveAt ?? null} />
            )}
```

In `src/renderer/src/components/SessionsPane.tsx`, delete the local `function formatUsd(…)` and add `import { formatUsd } from '../ownerView';`.

Append to `src/renderer/src/styles.css`:

```css
.obs-owner-costs { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.obs-owner-list { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 4px; }
.obs-owner-row { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
.obs-owner-sessions { color: var(--ink-2); flex: none; }
.obs-owner-usd { margin-left: auto; font-family: var(--font-mono); flex: none; }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/renderer/src/`.
Expected: PASS.

Run `npx tsc --noEmit -p tsconfig.web.json` and `npm run build`.
Expected: no errors; the build completes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/ownerView.ts src/renderer/src/ownerView.test.ts src/renderer/src/components/OwnerCostSection.tsx src/renderer/src/components/OwnerCostSection.test.ts src/renderer/src/components/ObservabilityPane.tsx src/renderer/src/components/SessionsPane.tsx src/renderer/src/styles.css
git commit -m "feat(owners): Cost by owner in the Observability rail for remote workspaces"
```

**Verification:**

| Where | What |
|---|---|
| Local | Unit tests, web typecheck, build. |
| CI | Same. |
| Host eyeball (Troy) | Select a remote workspace: the rail shows a collapsed "Cost by owner"; opened, it lists people, `automation` and "Unattributed" with USD that adds up to the workspace total; a local workspace shows no such section. |

---

### Task 11: SPEC.md

**Files:**
- Modify `docs/SPEC.md`.

**Interfaces:** none (docs).

Each edit below is an exact replacement or an insertion before a unique anchor (each anchor occurs once in `docs/SPEC.md` at `origin/main` 3c60edc).

- [ ] **Step 1: §11 *How `claude` authenticates* (the design's §4): the attribution layer**

Insert before the line `**Non-goals (deferred):**`:

```markdown
**Remote sessions' attribution** (remote-workspaces (f)). Sessions in a remote workspace use the workspace's credentials, so GitHub shows the workspace's bot as the actor. fleet-host credits the person who started each session through claude's `attribution` setting. claude 2.1.281 supports it, and `src/host/attributionClaude.test.ts` re-checks it whenever the installed claude is the Dockerfile pin.
- **One inline `--settings`.** `--settings` is single-valued (a second flag replaces the first), and the host pod can't write a file the workspace pod reads. So on a person's `CREATE` the host replaces the gated `--settings /usr/local/lib/claude-fleet/hooks.settings.json` with `--settings <json>`: `RUNNER_HOOKS` (`claudeArgs.ts`, kept equal to `docker/runner/hooks.settings.json` by a test) plus `attribution: { commit, pr }`.
- **Text.** `commit` is `Co-Authored-By: Claude <noreply@anthropic.com>` and `Co-authored-by: <name> <<id>+<login>@users.noreply.github.com>`; the setting replaces Claude's own line, so it is re-added. `pr` is `🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @<login>`.
- **Escaping.** The name keeps only letters, marks, digits, space, `.` and `-` (≤ 64 characters, else the login); the login and account id are format-checked; the value is `JSON.stringify` of that fixed shape and travels in argv without a shell. A malformed `attribution` value would make claude drop the whole settings source, hooks included, so only this builder writes it.
- Machines and automation runs keep claude's default attribution. The design's env + `--append-system-prompt` fallback isn't built: the setting is supported, and `CREATE` carries no per-session env.

```

- [ ] **Step 2: §6 *Sessions* and *Observability***

Insert before the line starting ``- `history:search(query, { scope, limit? })` ``:

```markdown
- **Owners on remote rows** (remote-workspaces (f)). `sessions:listRemote` rows carry `owner: SessionOwner | null` (`src/preload/sessionOwner.ts`: `{ kind: 'user' | 'machine' | 'automation' | 'publisher', provider, id, login, name, avatarUrl }`), revalidated by `parseSessionOwner`: GitHub logins and decimal account ids only, the name one-lined and capped at 64, the avatar only `https://avatars.githubusercontent.com/u/<id>` (optional `?v=<n>`), else null. A malformed owner becomes `null` and the row stays. Local rows have no `owner`.
```

Insert before the line starting ``- **Remote workspaces** (remote-workspaces (d)). `summaryForWorkspace` ``:

```markdown
- `observability:ownerCosts(workspaceId)` → `OwnerCostRow[] | null` (remote-workspaces (f), `federation/federationIpc.ts`). For a remote bookmark, its host's `history:owners` (3 s bound, liveness-gated): `{ owner: SessionOwner | null, sessions, usd }[]`, most expensive first, at most 100 rows (more refuses the reply); a row with a malformed owner is dropped. Null for a local workspace, an unknown id, or an unavailable or older host. A non-ULID argument throws.
```

- [ ] **Step 3: §7 *Remote host***

Replace

```
the `host` migration track (`host_meta`, `host_lease`, `host_ingest_offsets`, beside
```

with

```
the `host` migration track (`host_meta`, `host_lease`, `host_ingest_offsets`; v2 the publish tables, v3 `session_owners`; beside
```

Replace

```
- **Tools** (`HOST_MCP_TOOLS`, 15): `list_sessions`, `get_session`, `get_cost`, `list_events`, `session_summary`, `query`, `mark_useful` (on the holder's state store);
```

with

```
- **Tools** (`HOST_MCP_TOOLS`, 16): `list_sessions`, `get_session`, `get_cost`, `list_events`, `session_summary`, `query`, `mark_useful`, `cost_by_owner` (on the holder's state store; `get_cost` and `session_summary` add `owner`, and `cost_by_owner` is the core's `HOST_ONLY_TOOLS`, never on the desktop; *Session owners*);
```

Replace `` `hostMcpTools(true)` adds `search_transcripts` (16) `` with `` `hostMcpTools(true)` adds `search_transcripts` (17) ``.

Replace

```
Right before the `CREATE`, an empty write transaction runs the lease fence.
```

with

```
Right before the `CREATE`, an empty write transaction runs the lease fence, then the session's `automation` owner row is written, fenced (*Session owners*); a failed write fails the step.
```

Replace

```
Unlisted channels (vault, filesystem, config, image, Docker) don't exist on the host.
```

with

```
Unlisted channels (vault, filesystem, config, image, Docker) don't exist on the host. `history:sessions` rows also carry `owner`, and `history:owners` (`read`, arguments ignored) → `{ rows: OwnerCostRow[] }` is the hosted workspace's cost per owner (*Session owners*).
```

Replace the whole line

```
- `CREATE` args are rebuilt by the host: only optional `--settings <hooks>`, then `--resume <uuid>` or `--session-id <uuid>`; anything else is refused. With `db:` the host then appends its `--mcp-config=…` (*Host MCP*).
```

with

```
- `CREATE` args are rebuilt by the host: only optional `--settings <hooks>`, then `--resume <uuid>` or `--session-id <uuid>`; anything else is refused. The claude id is lower-cased, and the host mints one when the viewer sent neither, so every `CREATE` names its claude session. The host then writes the owner row from the verified principal (*Session owners*; with `db:`, a failed write refuses the `CREATE` with `could not record the session owner`), swaps the hooks file for a person's inline attribution settings (§11 *How `claude` authenticates*), and with `db:` appends its `--mcp-config=…` (*Host MCP*).
```

Insert before the line starting ``**Verify limits** (`server.ts` `gate()`, in order)``:

```markdown
**Session owners** (`sessionOwners.ts`; remote-workspaces (f)). `session_owners(broker_session_id, session_id, workspace_id, kind, provider, account_id, login, name, avatar_url, started_at)`, host track v3. The primary key is `(broker_session_id, session_id)`, because a tab reuses its broker id across claude sessions.
- **Writes** happen only on the holder, in a fenced transaction (`leaseFence`), `ON CONFLICT DO NOTHING`, never updated:
  - a viewer `CREATE`, before the broker starts claude (`AttachHub` `recordOwner`; a `CREATE` during holder start waits for it through `readyHolder()`);
  - each automation fresh step: `kind: 'automation'`, provider `fleet-host`, account id = the hosted workspace id, login `automation`.
- **Identity.** The owner comes only from the verified identity (`ownerOfIdentity`); frame fields are never read. An identity whose login isn't a GitHub login can't `CREATE`. If the broker refuses a `CREATE` whose row this call inserted, the row is deleted. Without `db:` nothing is recorded.
- **A claude session's owner is its earliest row** (`started_at`, then `broker_session_id`). Resuming someone else's session adds the resumer's row, and their commits from that process credit them, but the session's owner and cost stay the first person's. `CLOSE` ownership is still the in-memory map (*`/attach`*).
- **Published sessions** have no rows. `ownersOf` resolves a `pub_…` session to its partition's owner (`kind: 'publisher'`, no name or avatar) when the partition is in the caller's scope.
- **Reads** (`ownersOf`, `ownerCosts`) run on the holder's state handle and always filter by the caller's workspaces: the hosted id for RPC, hosted plus partitions for the MCP. `ownerCosts` prices `session_costs` per owner through the pricing table, with `owner: null` for sessions that have none, most expensive first, at most 100 rows; `since` filters on the session's `last_active_at`. The `query` login can't read `session_owners`.

```

- [ ] **Step 4: §8 *Browse & resume a past session***

Insert before the line starting ``**Transcript search** (remote-workspaces (d2), `TranscriptSearch.tsx`).``:

```markdown
**Owners** (remote-workspaces (f)).
- A remote row's meta line shows its owner after the cloud glyph (`OwnerBadge`): the GitHub avatar when it passes the allowlist, else an initial, then the name and @login, all as React text. Automation runs read "automation".
- When the scoped list holds a remote row, a **Mine / Everyone** toggle sits beside the scope toggle, defaulting to Everyone. Mine keeps every local row and the remote rows whose owner is a GitHub person with the signed-in account id (`identity:status`, re-read when Mine is clicked); rows without an owner are hidden. Signed out, Mine is disabled and the view is Everyone.
- It is a view filter: nothing is sent to a host, every row stays loaded, and the All count ignores it.
- The Observability rail's workspace view has a collapsed **Cost by owner** section for a remote workspace. Opening it calls `observability:ownerCosts` (again on each summary change while open) and lists each owner's badge, session count and USD, with "Unattributed" for sessions without an owner.

```

- [ ] **Step 5: §9 *Security model***

Insert before the line starting ``- **Viewers' bearer tokens do enter a remote host,**``:

```markdown
- **Session owners and attribution** (remote-workspaces (f)).
  - A session's owner comes only from the verified identity on `CREATE` and is written once, fenced, on the holder; never from frame or session content.
  - The attribution settings are built from a format-checked login and account id and a name stripped to letters, marks, digits, space, `.` and `-`, serialized by `JSON.stringify` and passed in argv without a shell. They are visible in `ps` to every session in the container, which already shares one Linux user.
  - Owner text from a host is revalidated and capped on the desktop and rendered only as React text. The renderer loads avatars only from `https://avatars.githubusercontent.com/u/<id>`, with `referrerPolicy="no-referrer"`.
  - Mine / Everyone hides nothing from anyone: every `read` viewer is served every session.
```

- [ ] **Step 6: §11 *Remote host: what remains***

Insert before the line starting ``- **`--mcp-config` precedence:**``:

```markdown
- **Host checklist for (f):**
  - `fleet-host migrate` reports `host` 3;
  - in a person's session, `ps -o args= -C claude` shows the inline `--settings` with `attribution`, and the waiting chip still works (hooks loaded);
  - a commit claude makes there ends with both co-author lines, and a PR body ends with "on behalf of @<login>";
  - `session_owners` gains one row per `CREATE` and one `automation` row per fresh step;
  - `cost_by_owner` from a session agrees with the desktop's Cost by owner;
  - the desktop shows owners on remote rows, and Mine filters to them.
- **Owner follow-ups:** `CLOSE` owners stay in memory; seeding them from `session_owners` would keep `mine` across a fleet-host restart. `session_owners` has no retention, like the rest of the host store.
```

- [ ] **Step 7: Check and commit**

Run `command grep -c "Session owners" docs/SPEC.md`.
Expected: at least 5.

Run `command grep -n "HOST_MCP_TOOLS\`, 15\|search_transcripts\` (16)" docs/SPEC.md`.
Expected: no output.

```bash
git add docs/SPEC.md
git commit -m "docs(spec): remote (f) session owners, attribution, Mine / Everyone, cost by owner"
```

**Verification:**

| Where | What |
|---|---|
| Local | The greps above. |

---

### Task 12: Full gate and handoff

**Files:** none new.

- [ ] **Step 1: Typecheck both configs separately**

Run `npx tsc --noEmit -p tsconfig.node.json`, then `npx tsc --noEmit -p tsconfig.web.json`.
Expected: both clean.

- [ ] **Step 2: Unit suite and build**

Run `npx vitest run`, then `npm run build`.
Expected: all pass (the known flaky `jsonlWatcher.ordering` test, #510, may need one re-run); the build completes. `attributionClaude.test.ts` runs where claude 2.1.281 is installed.

- [ ] **Step 3: Postgres suite**

Run `scripts/pg-test-server.sh start`, `export PG_TEST_URL=<printed>`, then `npm run test:unit:pg`.
Expected: all pass.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/remote-f-attribution
gh pr create --title "feat(remote): per-session attribution and session ownership (remote f)" --body "<factual body: what changed, where, the host-track v3 migration, how to test; cluster and host checklists from SPEC §11>"
gh pr merge --auto --squash <n>
```

The PR body states what was verified locally (both suites, both typechecks, build, the live attribution check against claude 2.1.281), what CI covers, and what only the cluster (SPEC §11 *Host checklist for (f)*) and Troy's host eyeball (Tasks 9 and 10) can show.

**Verification:**

| Where | What |
|---|---|
| Local | Steps 1–3. |
| CI | The full workflow, including the e2e MCP contract specs and the runner-image tests (the host bundle's import graph). |
| Cluster | SPEC §11 *Host checklist for (f)*, after the runner-host image rolls out and `fleet-host migrate` reaches host 3. |
| Host eyeball (Troy) | Tasks 9 and 10. |

---

## Self-Review

**Spec coverage** (spec §4, §8, §9, §11 item 6, §12 (f)):

| Requirement | Where |
|---|---|
| `session_owners(session_id, broker_session_id, login, github_id, name, avatar_url, started_at)` | Task 2 (D115: `github_id` → `provider` + `account_id`; `kind`, `workspace_id` added) |
| Written on `CREATE`, owner from the verified caller only | Task 4 (principal-only claim; a test sends a fake owner in the body) |
| Fenced, holder-only, once per session; a later attach doesn't change it | Tasks 3 and 4 (fenced transaction, lease-loss test, `ON CONFLICT DO NOTHING`, earliest-row rule, re-`CREATE` test) |
| Automation sessions owned by the workspace's bot identity | Task 4 (D118: `automation` owner) |
| Published `pub_…` sessions | Task 3 (D119: derived from partitions, tested) |
| Usage and cost attributed to the owner; `get_cost`/`session_summary` and the rollups group by owner | Tasks 3, 6, 7 (`owner` fields, `cost_by_owner`, `history:owners`) |
| `--settings` attribution layer, verified at the pinned claude, env fallback | Verified above; Task 5 (inline settings, D112/D113; live check test; fallback not needed) |
| Escaping of name, email, login; file mode/location | Task 5 (`coAuthorName`, format checks, JSON-only; no file is written, D113) |
| Commit trailer and "on behalf of @login" | Task 5 (D114) |
| Desktop federated views get owner fields, validated and capped; React text only | Task 8 (`parseSessionOwner`, `parseOwnerCosts`), Tasks 9 and 10 (text-node render tests) |
| Avatars only from an allowlisted host | Tasks 1, 3, 8, 9 (D120) |
| Sessions pane avatar + name + @login, Mine / Everyone defaulting to Everyone, view-only | Task 9 (D122) |
| Cost per owner in Observability when grouped | Task 10 (D121) |
| Watch-only tabs | D123: shipped in (c); nothing to add |
| `session` tier owner-equivalent; shared Linux user | Unchanged; SPEC §9 bullet (Task 11) notes the `ps` visibility under it |
| SPEC §7, §5/§8 Sessions pane, §8 Attach a terminal, §4 How claude authenticates | Task 11 (§8 *Attach a terminal* already documents watch-only tabs) |

**Placeholder scan:** no TBD/TODO; every code step shows its code; the only angle-bracket fill-ins are runtime values (`PG_TEST_URL`, the PR number and body in Task 12's handoff).

**Type consistency:**
- `OwnerClaim { brokerSessionId, sessionId, owner, startedAt }` is used identically in Tasks 3, 4 and 5.
- `SessionOwnerStore.ownersOf(sessionIds, workspaceIds)` and `ownerCosts(workspaceIds, { since? })` (Task 3) match the `Pick` in Task 6 (`hostMcp`) and Task 7 (`historyReader`). `OwnerHandlers` (Task 6) takes `ReadonlySet<string>` and `hostMcp` spreads it into arrays.
- `hostCreateArgs` returns `{ args, sessionId }` (Task 4); `withAttribution(gated.args, claim.owner)` (Task 5) uses the `claim` that Task 4's `create()` builds.
- `OwnerCostRow` (Task 1) flows host → `parseOwnerCosts` → `FederatedReader.ownerCosts` → IPC → `OwnerCostList` unchanged.
- `SETTINGS_ARG` is defined in Task 4 and redefined in Task 5, and only the `CREATE args` tests read it.
