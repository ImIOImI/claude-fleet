# Remote workspaces (c3): the host's Postgres store, fenced lease, ingest, and App credentials — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `fleet-host` its Postgres store: a `db:` config block opening part 3's store layer, a Postgres `host_lease` whose epoch fences every store write, the workspace id in `host_meta`, ingest of the container's own transcripts, and a GitHub App credential helper that hands sessions short-lived tokens scoped to the repository they act on.

**Architecture:** `fleet-host` opens one small pool for the host track (`host_meta`, `host_lease`, `host_ingest_offsets`) at start and runs the lease loop on it. Only after it holds the lease does it open part 3's state and inbox stores, on their own pool, with part 3's `afterBeginWrite` hook set to a fence: `SELECT … FROM host_lease … FOR SHARE` checking holder, epoch and expiry inside every write transaction. A takeover's `UPDATE` therefore waits for in-flight fenced writes, and any write after it fails with `LeaseLostError`, which ends the process. The App helper runs inside `fleet-host`, holds the key as a `KeyObject`, and serves tokens on a 0600 Unix socket to a small second bundle (`fleet-host-cred`) used by git's credential helper and a `gh` shim.

**Tech Stack:** TypeScript (NodeNext for `src/host`), Node 22, `pg` + Kysely (part 3), vitest on SQLite and on PG 16 + pgvector (local `scripts/pg-test-server.sh`, CI service), `node:crypto` RS256, Vite SSR multi-entry build, bash.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §3 *Remote host*, §7 *Data architecture*, §9, §11 item (c). `docs/SPEC.md` §7 *Remote host (`fleet-host`)*, §11 *Remote host DB*. Part 3 plan `2026-11-04-async-store-part3.md` D20–D38 (D36 is the seam). `/shared/remote-agent-design/design-state.md` and `threads/001-kickoff.md` (infra contract). Issues #479, #489, #491.

**This file replaces the gated c3 outline** (same path). The outline's automation, MCP and RPC parts move to the **c3b outline** at the end of this file (G1).

## Global Constraints

Copied from the spec, part 3 and the infra thread. Every task implicitly includes these.

- **Spec, verbatim:**
  - "The host's DB is **Postgres with pgvector** on a managed database service or on a block volume attached to the host." / "**The DB is not on shared file storage.**" (§3)
  - "`fleet-host` uses the same store layer, always on Postgres." (§7)
  - "A fenced lease in the host DB is the correctness backstop. The row is `host_lease(workspace_id PK, holder, epoch, expires_at)`." (§3)
  - "Every write transaction checks `epoch` against the lease row inside the transaction. A stale holder's write fails, and the process drops to standby and exits." (§3)
  - "Until it holds the lease, the process is **standby**. It runs no scheduler or ingest, serves no RPC or attach, and creates no broker sessions." (§3)
  - "**Readiness is not lease state.** The pod is *ready* when the process is healthy (DB reachable, lease loop running), whether it's holder or standby." (§3)
  - "Ingest is rebuildable from the JSONL on shared storage, like `state.db`." (§3)
  - "`fleet-host` mints short-lived installation tokens on demand and serves them to `gh` and git through a credential helper, so long-lived sessions never hold an expired token." / "No person's credentials ever enter the container." (§3)
  - "The pool calls the provider on **every new connection** (the `pg` pool's async `password` function)." (§7)
- **Infra contract** (design-state and thread 001, agreed with the Work workspace):
  - Aurora PostgreSQL 16.8, pgvector 0.8.0. Database `fleet`; user `fleet_agent` with `rds_iam`; schema `fleet` owned by `fleet_agent`; `ALTER ROLE fleet_agent SET search_path = fleet, public`.
  - The hand-run bootstrap (`/shared/fleet-agent-db-bootstrap.sh`) creates the database, extension, user and schema. **The store never creates them** (part 3 D23).
  - `aws-rds-iam` through the SDK's default Node chain (EKS Pod Identity: `AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`), signed for the exact writer endpoint; `verify-full` with `/etc/ssl/certs/rds-global-bundle.pem`, already in the image.
  - One replica, no overlap (`maxSurge: 0`, `maxUnavailable: 1`, infra#3007). c3's fenced lease is what makes an overlap safe; the invariant stays until Troy relaxes it.
  - GitHub App `sumer-fleet-agent` (App id 5612251) is installed on **all** SumerSports repos. Branch rulesets are deferred.
  - Env: `FLEET_HOST_GITHUB_APP_ID`, `FLEET_HOST_GITHUB_INSTALLATION_ID`, `FLEET_HOST_GITHUB_APP_KEY_FILE` (a **path** to the PEM, mounted from a Secret, mode 0400, uid 1000). "Without all three set, the App credential helper stays off."
  - "c3's credential helper will scope each installation token it mints to the repos it needs (the `repositories` parameter on `POST /app/installations/{id}/access_tokens`)."
- **The c1 seams are unchanged:** `LeaseStore`, `runHost({ leaseStore })`, `RpcChannel { tier, handle }`, `EventHub.publish` with its `EVENT_CHANNELS` allowlist, `HostServerDeps.healthy()`. The c1 config parser refuses unknown keys; c3 adds exactly `db` and `github`.
- **Part 3's rules bind here:** dialect branches only in `src/main/store/*`; every list read has a total `ORDER BY`; the store never creates its schema or extension; errors name keys, never values.
- **Repo rules:**
  - Comments are terse and necessary (`/workspace/.claude/rules/review-conventions.md`).
  - SPEC.md is updated in the same PR (Task 7).
  - Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Environment:**
  - Never `npm install` into `/workspace/claude-fleet/node_modules`. Work in your own worktree with its own `npm ci --ignore-scripts --no-audit --no-fund`, then `printf 'electron-stub' > node_modules/electron/path.txt`.
  - Typecheck the three configs separately: `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, `npx tsc -p tsconfig.host.json`.
  - Never use real GitHub or AWS credentials in a test. GitHub is `src/host/testGithubApp.ts`; AWS is part 3's `fakePgAuth.ts`.

## Decisions (recorded in SPEC.md by Task 7)

- **G1 — c3 is split; automations, MCP and store-backed RPC move to c3b.**
  - The scheduler can't usefully run on the host yet. An automation's fresh session reports through the fleet-state MCP tools (`INBOX_TOOLS` in `automations/runner.ts`: `post_todo`, `notify`, …), and `mcpServer.ts` can't run in `fleet-host`: it reaches `electron` through `config.ts`, `errorLog.ts` and `paths.ts`, plus OpenTelemetry through `perf.ts`, and on Postgres its history tools are off until part 4's `ReadSource` (part 3 D34).
  - The outline's RPC channels have no consumer until (d) (`FederatedReader`) and (g) (remote automations UX). Each of those defines the shape it needs.
  - **c3 ships:** a host that is safe to run as two pods, keeps its identity in its DB, has its own sessions' history in Postgres, and gives sessions scoped GitHub credentials. **c3b ships** remote automations (outline at the end).
- **G2 — `db:` is optional during the rollout.** With no `db:` block the host behaves as c1 (process-local lease, no ingest) and logs a warning at start. This keeps the image smoke test and any pre-bootstrap deploy working. With `db:` it is Postgres-only; nothing falls back to the file or memory store.
- **G3 — Two pools, one schema.**
  - **Host pool** (always, opened at start): an unfenced Kysely handle for `host_meta` and `host_lease`, and the health ping. Standby pods hold only this.
  - **Store pool** (holder only): part 3's `openPgStores(cfg, { state: true, afterBeginWrite: fence })`, opened after the lease is acquired. Migrations of `state` and `inbox` therefore run fenced, as the holder.
  - All host SQL goes through `postgresKysely` handles. **Found in validation:** `pool.query()` on a store pool bypasses the per-connection `SET search_path`, so a bare `host_lease` resolves to nothing. Tests that use raw `pool.query` qualify table names with the schema.
- **G4 — `postgresLeaseStore`: one statement per operation, judged on the DB clock.**
  - `tryAcquire`: `INSERT … ON CONFLICT (workspace_id) DO UPDATE SET holder, epoch = epoch + 1, expires_at = clock_timestamp() + ttl WHERE holder IS NULL OR holder = EXCLUDED.holder OR expires_at <= clock_timestamp() RETURNING epoch`. The `holder = EXCLUDED.holder` arm keeps c1's contract ("`tryAcquire` by the current holder re-grants with a new epoch").
  - `renew` and `release` match on `holder` and `epoch`.
  - **`clock_timestamp()`, not `now()`. Found in validation:** `now()` is the statement's start time, so an acquire that waited on the row lock judged expiry as of before the wait and intermittently returned `null` for an expired lease.
  - The caller's `now` argument is ignored.
- **G5 — The fence.**
  - `leaseFence({ workspaceId, holder, epoch, onLost })` is the `WriteHook`. It runs `SELECT holder, epoch, expires_at > clock_timestamp() AS live FROM host_lease WHERE workspace_id = $1 FOR SHARE` as the first statement of every write transaction and around every bare write.
  - A missing row, another holder, another epoch, an expired row or no local epoch throws `LeaseLostError` and calls `onLost`, which is `LeaseManager.markLost()`. That emits `'lost'`, and c1's handler shuts down with exit 1.
  - `FOR SHARE` conflicts with the takeover's row lock, so a takeover waits for in-flight fenced writes to commit, and every write after it sees the new epoch. A renew by the holder also waits behind an in-flight write transaction; ingest transactions are one chunk, far below the renew budget (TTL − renew interval = 20 s).
  - **Validated in a scratch worktree** on PG 16.15: the concurrency test in Task 4 fails 3/3 with `FOR SHARE` removed, and passes repeatedly with it.
- **G6 — The workspace id lives in `host_meta`.**
  - A single-row table: `host_meta(singleton, workspace_id, created_at)`.
  - First start on an empty DB seeds it from, in order: config `workspace.id`, the c1 file `$FLEET_HOST_STATE/workspace-id.json`, a fresh ULID. `INSERT … ON CONFLICT DO NOTHING`, then re-read, so two pods agree.
  - Afterwards the row is authoritative. A configured `workspace.id` that differs refuses start, naming both. A file that differs or is missing is rewritten from the row (temp file + `rename`), with a warning when it differed.
  - `fleet-host init` resolves the id the same way when `db:` is set.
- **G7 — Ingest on the host.**
  - Holder only, after the stores open. Every `*.jsonl` under `~/.claude/projects/*/` (and `<session>/subagents/agent-*.jsonl`) is attributed to the hosted workspace id: everything in this container is that workspace's.
  - Change detection is `fs.watch(projectsDir, { recursive: true })` (writers are local processes, so inotify fires even on EFS) plus a full rescan every 60 s as the backstop.
  - Per-file byte offsets persist in `host_ingest_offsets`, written through the fenced handle after each batch. **Why:** the desktop re-reads every transcript from offset 0 on each start, which is acceptable locally, but on the host it means re-reading all of EFS and re-sending every line to Aurora on every deploy.
  - Reuses `ingestBatch` (dedup keys make a re-read idempotent) and `keyedSerialQueue`. The two path parsers move from `jsonlWatcher.ts` (which reaches `electron`) to `src/main/state/transcriptPaths.ts`.
  - No mirror, no `new-session` mapping (that pairs desktop tabs; (f) owns host session ownership), no embeddings or summaries (c3b/(d)).
- **G8 — Health.** `healthy()` = the lease loop is running and, with `db:`, the last DB ping (every 5 s, 3 s timeout) succeeded within 15 s. `/healthz` is `{ status, lease, db }` with `db` = `ok` | `down` | `none`. A DB outage makes the pod unready; the chart should use `/healthz` for readiness, not liveness.
- **G9 — Startup against an unreachable DB retries.** Opening the host pool retries with backoff (1 s doubling to 30 s), logging each failure with part 3's IAM hint, so a DB blip during a `fleet-host` restart doesn't crash-loop the container (the entry script gives up after 5 restarts in 60 s, which would kill every PTY). An invalid `db:` block (`StoreConfigError`) fails at once.
- **G10 — `db` can't change on reload.** The pools are built at start; a reload that changes `db` is refused like a `workspace.id` change.
- **G11 — The bundle reaches the store.**
  - `better-sqlite3` is aliased to `src/host/sqliteStub.ts`, which throws if called; the host only calls `openDbPostgres`/`InboxStore.openPostgres`.
  - Two entries, `fleet-host.mjs` and `fleet-host-cred.mjs`, with shared chunks under `out/host/chunks/` (the AWS SDK's lazy provider imports become chunks). The image copies the whole directory.
  - **Validated:** the multi-entry bundle builds, and the bundled `openPgStores` + `ingestBatch` ran against PG 16 (one event inserted).
  - The import-graph test widens its allowlists to the store modules and `kysely`, `pg`, `pg-connection-string`, `@aws-sdk`, `better-sqlite3` (aliased).
- **G12 — The GitHub App credential helper.**
  - **On only when all three env vars are set**; a partial set is a startup error.
  - **Key:** read once at start into a `KeyObject`, never into env, logs or errors. An App JWT (RS256, `iss` = App id, `iat` = now − 60 s, `exp` = `iat` + 540 s) is signed per GitHub call.
  - **Every token is scoped.** A request names repositories (and optionally an owner and permissions); an unscoped request is refused. The minter passes `repositories` to `POST /app/installations/{id}/access_tokens` and hands out the token only when GitHub's returned repository list equals the request.
  - **Allowlist:** optional host config `github.repositories` (names in the installation's account). When set, nothing outside it is minted (403, no GitHub call). `github.permissions` (e.g. `{ contents: write, pull_requests: write }`) is the default `permissions` for every token.
  - **Owner:** a request's `owner` must equal the installation's account login, fetched once (`GET /app/installations/{id}`) and cached.
  - **Cache:** per (repositories, permissions) until 5 min before `expires_at`; concurrent identical requests share one GitHub call; at most 64 entries.
  - **Socket:** `/run/fleet-host/cred.sock` (`FLEET_HOST_CRED_SOCKET`), mode 0600 in a 0700 directory, HTTP `POST /token` with a JSON body ≤ 8 KiB.
  - **Clients** (`fleet-host-cred`, the second bundle):
    - `git-credential get`: git's credential protocol. `/etc/gitconfig` sets `credential.https://github.com.helper` to it with `useHttpPath = true`, so each request names one `owner/repo` and gets a token for exactly that repo.
    - `gh-token -- <gh args>`: the repo from `-R`/`--repo`, `GH_REPO`, a `gh api repos/<o>/<r>/…` path, or the cwd's `origin` remote. The image's `gh` shim (first on `PATH`) exports `GH_TOKEN` from it and execs the real `gh`. No resolvable repo means no token: `gh search` and org-wide `gh api` calls run unauthenticated.
    - `token --repo <name|owner/name>…`: for scripts.
    - `serve`: runs the same server standalone (the separate-uid layout below).
- **G13 — The shared-uid limitation, stated plainly.** Sessions run as uid 1000, like `fleet-host`. Under that layout:
  - any session can read the mounted key file (0400, uid 1000) directly, and so mint any token the installation allows (org-wide today);
  - any session can ask the socket for a token for any repo the allowlist permits.

  So the helper limits token **lifetime and scope** for well-behaved sessions and keeps the key out of env, logs and process arguments. **It is not a boundary against a session.** The durable fix is c1's recommendation: run the credential server in its own container or uid, with the Secret volume mounted only there and the socket shared through an `emptyDir`. `fleet-host-cred serve` is that server; moving it needs a chart change, the socket mode 0660 with a shared group, and nothing else in this code. **Pending Troy's decision.**
- **G14 — Carry-overs.**
  - **#491:** every item shipped in part 3 (D26, D30, D35, Task 7). Nothing is left for c3; it can be closed.
  - **#479:** item 1 shipped in c1 (`buildAuthContext`, D15). Items 2–3 are desktop identity work, untouched here.
  - **#489** (scoped `KILLPORT`): broker work, independent of the store; not in c3.

## Out of scope (where it goes)

| Item | Goes to |
|---|---|
| Scheduler + runner on the host, `automations:changed` / `proposals:changed` events | c3b |
| fleet-state MCP on the container's socket (typed tools; inbox/automation tools) | c3b, gated on part 4's `ReadSource` for the history tools |
| Store-backed read RPC (`sessions:list`, `observability:*`) and `observability:summary` push | (d) |
| `automations:*`, `proposals:*`, `inbox:*` RPC and `inbox:changed` push | (g) |
| `query` isolation (role + RLS) on the host | (d) |
| Embeddings and summaries of host sessions; published partitions | (d) / (e) |
| `session_owners`, attribution layer, per-owner cost | (f) |
| Scoped `KILLPORT` (#489) | broker follow-up |

## File Structure

| File | Responsibility |
|---|---|
| `src/host/appToken.ts` (new) | App env, key loading, App JWT, scoped token minter with cache. |
| `src/host/testGithubApp.ts` (new, test-only) | Fake GitHub App API: verifies the JWT, mints fake tokens, records requests. |
| `src/host/credServer.ts` (new) | The 0600 socket server and `startCredHelper`. |
| `src/host/credCli.ts` (new) | `fleet-host-cred` subcommands and the repo parsers. |
| `src/host/credMain.ts` (new) | Bundle entry for `fleet-host-cred.mjs`. |
| `src/host/config.ts` | `github` and `db` config blocks; `credSocket`, `projectsDir` env. |
| `src/host/configReload.ts` | Refuse a `db` change. |
| `src/host/hostSchema.ts` (new) | `HostDb` types and the `host` migration track. |
| `src/host/hostDb.ts` (new) | Open the host pool (retrying), migrate the host track, health pinger. |
| `src/host/sqliteStub.ts` (new) | `better-sqlite3` alias target for the host bundle. |
| `src/host/pgLease.ts` (new) | `postgresLeaseStore`, `leaseFence`, `LeaseLostError`. |
| `src/host/lease.ts` | `LeaseManager.markLost()`. |
| `src/host/holder.ts` (new) | Holder-only resources: fenced stores, then ingest. |
| `src/host/hostState.ts` | `resolveHostWorkspaceId`, file read/write helpers. |
| `src/host/hostIngest.ts` (new) | Transcript ingest with persisted offsets. |
| `src/main/state/transcriptPaths.ts` (new) | `parseTranscriptFilename`, `parseSubagentPath` (moved). |
| `src/main/jsonlWatcher.ts` | Imports and re-exports the moved parsers. |
| `src/host/server.ts` | `/healthz` gains `db`. |
| `src/host/main.ts`, `src/host/cli.ts` | Wiring. |
| `vite.host.config.ts` | Alias, two entries, chunks. |
| `docker/host/Dockerfile`, `docker/host/gh`, `docker/host/gitconfig`, `docker/host/gh.test.sh`, `docker/host/smoke.test.sh` | Image: bundle directory, cred CLI, shim, git config, socket dir. |
| `src/host/importGraph.test.ts`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml` | Build inputs for the widened graph. |
| `vitest.pg.config.ts` | The host's Postgres tests. |
| `docs/SPEC.md` | Task 7. |

---

## Verification environment (once, before Task 1)

```bash
git -C /workspace/claude-fleet fetch -q origin
WT=/workspace/claude-fleet/.claude/worktrees/remote-c3
git -C /workspace/claude-fleet worktree add -b feat/remote-c3 "$WT" origin/main
cd "$WT"
npm ci --ignore-scripts --no-audit --no-fund
printf 'electron-stub' > node_modules/electron/path.txt
eval "$(scripts/pg-test-server.sh start)"     # exports PG_TEST_URL (Unix socket under /tmp/fleet-pg-test)
CI=true npx vitest run src/host                # baseline: PASS
CI=true npm run test:unit:pg                   # baseline: PASS
```

Never `cd /workspace/claude-fleet` from inside the worktree. Use `$WT` paths or `git -C "$WT"`; every command below runs from `$WT`.

**Gates for every task** (each task's last step runs them):

```bash
CI=true npx vitest run src                              # SQLite / no-DB: whole unit suite
CI=true PG_TEST_POOL_MAX=8 npm run test:unit:pg         # Postgres suite, host tests included
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx tsc -p tsconfig.host.json
```

Known flakes on unchanged `origin/main`: `src/main/mcpLocalBridge.run.test.ts` and `src/main/jsonlWatcher.ordering.test.ts > stop() resolves only after every queued batch has finished`. Three clean re-runs of that file mean it's the flake.

**Edit helper.** Tasks apply exact replacements with `edit()`; each `old` must occur exactly `count` times, or it stops.

```bash
cat > /tmp/c3_edit.py <<'PYEOF'
"""Exact-replacement edits for the c3 plan. Run from the worktree root."""
import re


def edit(path, pairs):
    s = open(path).read()
    for old, new, count in pairs:
        n = s.count(old)
        assert n == count, f'{path}: expected {count} of {old[:80]!r}, found {n}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


def add_pg_suite(*files):
    """Add test files to vitest.pg.config.ts's include list, kept sorted."""
    path = 'vitest.pg.config.ts'
    s = open(path).read()
    m = re.search(r'(    include: \[\n)(.*?)(\n    \],)', s, flags=re.S)
    have = set(re.findall(r"'([^']+)'", m.group(2)))
    have.update(files)
    body = '\n'.join(f"      '{f}'," for f in sorted(have))
    open(path, 'w').write(s[:m.start()] + m.group(1) + body + m.group(3) + s[m.end():])
PYEOF
```

---
### Task 1: The App token minter and the `github` config block

**Files:**
- Create: `src/host/appToken.ts`, `src/host/appToken.test.ts`, `src/host/testGithubApp.ts`
- Modify: `src/host/config.ts`, `src/host/config.test.ts`, `.dockerignore`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `readAppEnv(env): AppEnv | null`, `loadAppCredentials(e: AppEnv): Promise<AppCredentials>`, `appJwt(c, nowMs): string`
  - `validateTokenRequest(raw: unknown): TokenRequest` with `TokenRequest { owner?: string; repositories: string[]; permissions?: Record<string, 'read' | 'write'> }`
  - `createTokenMinter(o: MinterOptions): TokenMinter` with `TokenMinter { account(): Promise<string>; mint(req: unknown): Promise<ScopedToken> }`, `ScopedToken { token; expiresAt: number; repositories: string[] }`
  - `AppTokenError(message, status)`; `REFRESH_BEFORE_MS = 300_000`
  - `HostGithubConfig { repositories: string[] | null; permissions: Record<string, 'read' | 'write'> | null }`; `HostConfig.github: HostGithubConfig | null`
  - Test-only: `startFakeGithubApp({ appId, installationId, account, repos }): Promise<FakeGithubApp>`

- [ ] **Step 1: Write the fake GitHub App API**

`src/host/testGithubApp.ts`:

```ts
// Fake GitHub App API for tests (not shipped): verifies the App JWT, mints fake
// installation tokens and records every request.
import { createServer, type Server } from 'node:http';
import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FakeGithubApp {
  url: string;
  privatePem: string;
  publicKey: KeyObject;
  requests: { method: string; path: string; body: unknown; jwt: Record<string, unknown> }[];
  /** Repos the installation can reach. */
  repos: Set<string>;
  delayMs: number;
  ttlMs: number;
  /** Answer with every installation repo, whatever was asked. */
  widen: boolean;
  close(): Promise<void>;
}

function verifyJwt(auth: string, key: KeyObject): Record<string, unknown> | null {
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth);
  if (!m) return null;
  if (!createVerify('RSA-SHA256').update(`${m[1]}.${m[2]}`).verify(key, Buffer.from(m[3], 'base64url'))) return null;
  if (JSON.parse(Buffer.from(m[1], 'base64url').toString()).alg !== 'RS256') return null;
  return JSON.parse(Buffer.from(m[2], 'base64url').toString());
}

export async function startFakeGithubApp(o: { appId: string; installationId: string; account: string; repos: string[] }): Promise<FakeGithubApp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fake = {
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKey,
    requests: [] as FakeGithubApp['requests'],
    repos: new Set(o.repos),
    delayMs: 0,
    ttlMs: 60 * 60_000,
    widen: false
  } as FakeGithubApp;
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const jwt = verifyJwt(String(req.headers.authorization ?? ''), publicKey);
      const body = raw ? JSON.parse(raw) : undefined;
      fake.requests.push({ method: req.method!, path: req.url!, body, jwt: jwt ?? {} });
      if (!jwt || jwt.iss !== o.appId) return send(401, { message: 'A JSON web token could not be decoded' });
      if (req.method === 'GET' && req.url === `/app/installations/${o.installationId}`) {
        return send(200, { id: Number(o.installationId), account: { login: o.account } });
      }
      if (req.method === 'POST' && req.url === `/app/installations/${o.installationId}/access_tokens`) {
        const want: string[] = body?.repositories ?? [];
        if (want.some((r) => !fake.repos.has(r))) {
          return send(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
        }
        if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
        n++;
        return send(201, {
          token: `ghs_fake${String(n).padStart(4, '0')}${'x'.repeat(28)}`,
          expires_at: new Date(Date.now() + fake.ttlMs).toISOString(),
          permissions: body?.permissions ?? { contents: 'write' },
          repositories: (want.length && !fake.widen ? want : [...fake.repos]).map((name) => ({ name, full_name: `${o.account}/${name}` }))
        });
      }
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
```

Keep it out of the image: in `.dockerignore`, after the line `src/host/testHost.ts`, add `src/host/testGithubApp.ts`.

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('.dockerignore', [('src/host/testHost.ts\n', 'src/host/testHost.ts\nsrc/host/testGithubApp.ts\n', 1)])
EOF
```

- [ ] **Step 2: Write the failing minter tests**

`src/host/appToken.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appJwt, createTokenMinter, loadAppCredentials, readAppEnv, REFRESH_BEFORE_MS } from './appToken.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

const APP = '5612251';
const INST = '777';
let gh: FakeGithubApp | null = null;
afterEach(async () => {
  await gh?.close();
  gh = null;
});

async function rig(repos = ['fleet-reviews', 'fleet-expertise', 'claude-fleet']) {
  gh = await startFakeGithubApp({ appId: APP, installationId: INST, account: 'SumerSports', repos });
  const keyFile = join(mkdtempSync(join(tmpdir(), 'app-')), 'key.pem');
  writeFileSync(keyFile, gh.privatePem, { mode: 0o400 });
  return { gh, creds: await loadAppCredentials({ appId: APP, installationId: INST, keyFile }) };
}

const posts = (g: FakeGithubApp) => g.requests.filter((r) => r.method === 'POST').length;

describe('readAppEnv', () => {
  it('is off with none set, on with all three, and an error when partial', () => {
    expect(readAppEnv({})).toBeNull();
    expect(readAppEnv({ FLEET_HOST_GITHUB_APP_ID: '1', FLEET_HOST_GITHUB_INSTALLATION_ID: '2', FLEET_HOST_GITHUB_APP_KEY_FILE: '/k' }))
      .toEqual({ appId: '1', installationId: '2', keyFile: '/k' });
    expect(() => readAppEnv({ FLEET_HOST_GITHUB_APP_ID: '1' })).toThrow(/set together/);
    expect(() => readAppEnv({ FLEET_HOST_GITHUB_APP_ID: 'x', FLEET_HOST_GITHUB_INSTALLATION_ID: '2', FLEET_HOST_GITHUB_APP_KEY_FILE: '/k' })).toThrow(/APP_ID must be a number/);
    expect(() => readAppEnv({ FLEET_HOST_GITHUB_APP_ID: '1', FLEET_HOST_GITHUB_INSTALLATION_ID: '2', FLEET_HOST_GITHUB_APP_KEY_FILE: 'k' })).toThrow(/absolute path/);
  });
});

describe('createTokenMinter', () => {
  it('signs an RS256 JWT the API accepts: iss = app id, iat −60 s, lifetime under 10 min', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    expect(await m.account()).toBe('SumerSports');
    expect(gh.requests[0].jwt.iss).toBe(APP);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const body = JSON.parse(Buffer.from(appJwt(creds, now).split('.')[1], 'base64url').toString());
    expect(body.iat).toBe(now / 1000 - 60);
    expect(body.exp - body.iat).toBeLessThan(600);
    expect(body.exp).toBeGreaterThan(now / 1000);
  });

  it('scopes each token to exactly the requested repositories', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    const t = await m.mint({ repositories: ['Fleet-Reviews'] });
    expect(t.repositories).toEqual(['fleet-reviews']);
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'] });
  });

  it('passes config permissions unless the request names its own', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url, defaultPermissions: () => ({ contents: 'write' }) });
    await m.mint({ repositories: ['fleet-reviews'] });
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'], permissions: { contents: 'write' } });
    await m.mint({ repositories: ['fleet-reviews'], permissions: { contents: 'read' } });
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'], permissions: { contents: 'read' } });
  });

  it('refuses a token GitHub scoped wider than asked', async () => {
    const { gh, creds } = await rig();
    gh.widen = true;
    await expect(createTokenMinter({ creds, apiBase: gh.url }).mint({ repositories: ['fleet-reviews'] })).rejects.toThrow(/other repositories/);
  });

  it('caches per scope until 5 min before expiry; concurrent requests share one call', async () => {
    const { gh, creds } = await rig();
    let now = Date.now();
    const m = createTokenMinter({ creds, apiBase: gh.url, now: () => now });
    gh.delayMs = 50;
    const [a, b] = await Promise.all([m.mint({ repositories: ['fleet-reviews'] }), m.mint({ repositories: ['fleet-reviews'] })]);
    expect(a.token).toBe(b.token);
    expect(posts(gh)).toBe(1);
    expect((await m.mint({ repositories: ['claude-fleet'] })).token).not.toBe(a.token);
    expect(posts(gh)).toBe(2);
    now = a.expiresAt - REFRESH_BEFORE_MS - 1;
    expect((await m.mint({ repositories: ['fleet-reviews'] })).token).toBe(a.token);
    now = a.expiresAt - REFRESH_BEFORE_MS + 1;
    expect((await m.mint({ repositories: ['fleet-reviews'] })).token).not.toBe(a.token);
    expect(posts(gh)).toBe(3);
  });

  it('refuses repos outside github.repositories, unscoped requests and another owner, without minting', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url, allow: () => ['fleet-reviews'] });
    await expect(m.mint({ repositories: ['claude-fleet'] })).rejects.toMatchObject({ status: 403 });
    await expect(m.mint({ repositories: [] })).rejects.toMatchObject({ status: 400 });
    await expect(m.mint({ repositories: ['../x'] })).rejects.toMatchObject({ status: 400 });
    await expect(m.mint({ owner: 'someone-else', repositories: ['fleet-reviews'] })).rejects.toMatchObject({ status: 403 });
    expect(posts(gh)).toBe(0);
    expect((await m.mint({ owner: 'sumersports', repositories: ['fleet-reviews'] })).repositories).toEqual(['fleet-reviews']);
  });

  it('a repo the installation cannot reach is a 400 carrying GitHub’s reason', async () => {
    const { gh, creds } = await rig(['fleet-reviews']);
    await expect(createTokenMinter({ creds, apiBase: gh.url }).mint({ repositories: ['secret-repo'] }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not accessible/) });
  });

  it('never puts the key, a JWT or a token in an error', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    const t = await m.mint({ repositories: ['fleet-reviews'] });
    const errs: string[] = [];
    for (const bad of [{ repositories: ['nope'] }, { repositories: 'x' }]) {
      await m.mint(bad).catch((e: Error) => errs.push(`${e.message} ${e.stack}`));
    }
    await createTokenMinter({ creds, apiBase: 'http://127.0.0.1:1' }).mint({ repositories: ['fleet-reviews'] })
      .catch((e: Error) => errs.push(`${e.message} ${e.stack}`));
    expect(errs).toHaveLength(3);
    const keyLine = gh.privatePem.split('\n')[1];
    for (const e of errs) {
      expect(e).not.toContain(t.token);
      expect(e).not.toContain(keyLine);
      expect(e).not.toMatch(/eyJ/);
    }
  });

  it('a bad or unreadable key fails without echoing the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-'));
    writeFileSync(join(dir, 'k'), '-----BEGIN PRIVATE KEY-----\nnotakey\n-----END PRIVATE KEY-----\n');
    await expect(loadAppCredentials({ appId: APP, installationId: INST, keyFile: join(dir, 'k') }))
      .rejects.toThrow(/^FLEET_HOST_GITHUB_APP_KEY_FILE is not a PEM private key$/);
    await expect(loadAppCredentials({ appId: APP, installationId: INST, keyFile: join(dir, 'missing') })).rejects.toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/host/appToken.test.ts`
Expected: FAIL, "Cannot find module './appToken.js'".

- [ ] **Step 4: Implement the minter**

`src/host/appToken.ts`:

```ts
// GitHub App installation tokens, each scoped to the repositories a request
// names. The private key stays a KeyObject in this process; only tokens leave.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const GITHUB_API = 'https://api.github.com';
/** A token handed out is good for at least this long. */
export const REFRESH_BEFORE_MS = 5 * 60_000;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const PERMISSION = /^[a-z_]{1,64}$/;
const MAX_CACHED = 64;

export type Permissions = Record<string, 'read' | 'write'>;
export interface AppEnv { appId: string; installationId: string; keyFile: string }
export interface AppCredentials { appId: string; installationId: string; key: KeyObject }

export class AppTokenError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'AppTokenError';
  }
}

/** All three set: on. None: off. Some: a startup error. */
export function readAppEnv(env: NodeJS.ProcessEnv): AppEnv | null {
  const appId = env.FLEET_HOST_GITHUB_APP_ID ?? '';
  const installationId = env.FLEET_HOST_GITHUB_INSTALLATION_ID ?? '';
  const keyFile = env.FLEET_HOST_GITHUB_APP_KEY_FILE ?? '';
  const set = [appId, installationId, keyFile].filter(Boolean).length;
  if (set === 0) return null;
  if (set !== 3) throw new Error('FLEET_HOST_GITHUB_APP_ID, FLEET_HOST_GITHUB_INSTALLATION_ID and FLEET_HOST_GITHUB_APP_KEY_FILE must be set together');
  if (!/^\d+$/.test(appId)) throw new Error('FLEET_HOST_GITHUB_APP_ID must be a number');
  if (!/^\d+$/.test(installationId)) throw new Error('FLEET_HOST_GITHUB_INSTALLATION_ID must be a number');
  if (!keyFile.startsWith('/')) throw new Error('FLEET_HOST_GITHUB_APP_KEY_FILE must be an absolute path');
  return { appId, installationId, keyFile };
}

export async function loadAppCredentials(e: AppEnv): Promise<AppCredentials> {
  let pem: string;
  try {
    pem = await readFile(e.keyFile, 'utf8');
  } catch (err) {
    throw new Error(`cannot read FLEET_HOST_GITHUB_APP_KEY_FILE: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('FLEET_HOST_GITHUB_APP_KEY_FILE is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('FLEET_HOST_GITHUB_APP_KEY_FILE must be an RSA key');
  return { appId: e.appId, installationId: e.installationId, key };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** iat is backdated 60 s for clock drift; GitHub caps exp − iat at 10 min. */
export function appJwt(c: AppCredentials, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: c.appId }));
  return `${head}.${body}.${b64url(createSign('RSA-SHA256').update(`${head}.${body}`).sign(c.key))}`;
}

export interface TokenRequest { owner?: string; repositories: string[]; permissions?: Permissions }
export interface ScopedToken { token: string; expiresAt: number; repositories: string[] }

export function validateTokenRequest(raw: unknown): TokenRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppTokenError('request must be an object', 400);
  const { owner, repositories, permissions } = raw as Record<string, unknown>;
  if (owner !== undefined && (typeof owner !== 'string' || !OWNER.test(owner))) throw new AppTokenError('owner must be a GitHub login', 400);
  if (!Array.isArray(repositories) || repositories.length === 0 || repositories.length > 100) {
    throw new AppTokenError('repositories must list 1 to 100 repository names', 400);
  }
  for (const r of repositories) if (typeof r !== 'string' || !REPO_NAME.test(r) || r === '.' || r === '..') throw new AppTokenError('repositories must be repository names', 400);
  let perms: Permissions | undefined;
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new AppTokenError('permissions must be an object', 400);
    perms = {};
    for (const [k, v] of Object.entries(permissions)) {
      if (!PERMISSION.test(k) || (v !== 'read' && v !== 'write')) throw new AppTokenError('permissions must map names to "read" or "write"', 400);
      perms[k] = v;
    }
  }
  return {
    ...(typeof owner === 'string' ? { owner } : {}),
    repositories: [...new Set((repositories as string[]).map((r) => r.toLowerCase()))].sort(),
    ...(perms ? { permissions: perms } : {})
  };
}

export interface MinterOptions {
  creds: AppCredentials;
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Host config `github.repositories`: when set, nothing outside it is minted. */
  allow?: () => readonly string[] | null;
  /** Host config `github.permissions`: used when a request names none. */
  defaultPermissions?: () => Permissions | null;
}

export interface TokenMinter {
  /** The installation's account login, fetched once. */
  account(): Promise<string>;
  mint(req: unknown): Promise<ScopedToken>;
}

export function createTokenMinter(o: MinterOptions): TokenMinter {
  const api = (o.apiBase ?? GITHUB_API).replace(/\/$/, '');
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const cache = new Map<string, ScopedToken>();
  const inflight = new Map<string, Promise<ScopedToken>>();
  let accountP: Promise<string> | null = null;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${appJwt(o.creds, now())}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'fleet-host',
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new AppTokenError('GitHub is unreachable', 503);
    }
    if (!res.ok) {
      const msg = await res.json().then(
        (j: unknown) => {
          const m = (j as { message?: unknown } | null)?.message;
          return typeof m === 'string' ? m.slice(0, 200) : '';
        },
        () => ''
      );
      const where = `${method} ${path.replace(/\d+/g, ':id')}`;
      throw new AppTokenError(`GitHub ${where} → ${res.status}${msg ? `: ${msg}` : ''}`, res.status === 422 || res.status === 404 ? 400 : 502);
    }
    return res.json();
  }

  function account(): Promise<string> {
    accountP ??= call('GET', `/app/installations/${o.creds.installationId}`).then((j) => {
      const login = (j as { account?: { login?: unknown } }).account?.login;
      if (typeof login !== 'string') throw new AppTokenError('the installation has no account login');
      return login;
    });
    accountP.catch(() => (accountP = null));
    return accountP;
  }

  async function fetchToken(req: TokenRequest): Promise<ScopedToken> {
    const j = (await call('POST', `/app/installations/${o.creds.installationId}/access_tokens`, {
      repositories: req.repositories,
      ...(req.permissions ? { permissions: req.permissions } : {})
    })) as { token?: unknown; expires_at?: unknown; repositories?: { name?: unknown }[] };
    const expiresAt = typeof j.expires_at === 'string' ? Date.parse(j.expires_at) : NaN;
    if (typeof j.token !== 'string' || !Number.isFinite(expiresAt)) throw new AppTokenError('GitHub returned no token');
    const granted = (j.repositories ?? []).map((r) => String(r.name).toLowerCase()).sort();
    if (granted.join(',') !== req.repositories.join(',')) throw new AppTokenError('GitHub scoped the token to other repositories');
    return { token: j.token, expiresAt, repositories: granted };
  }

  return {
    account,
    async mint(raw) {
      const v = validateTokenRequest(raw);
      const allow = o.allow?.();
      if (allow) {
        const allowed = new Set(allow.map((r) => r.toLowerCase()));
        const outside = v.repositories.filter((r) => !allowed.has(r));
        if (outside.length) throw new AppTokenError(`not in github.repositories: ${outside.join(', ')}`, 403);
      }
      if (v.owner && v.owner.toLowerCase() !== (await account()).toLowerCase()) {
        throw new AppTokenError(`owner ${v.owner} is not this installation's account`, 403);
      }
      const req: TokenRequest = { repositories: v.repositories, permissions: v.permissions ?? o.defaultPermissions?.() ?? undefined };
      const key = JSON.stringify(req);
      const hit = cache.get(key);
      if (hit && hit.expiresAt - now() > REFRESH_BEFORE_MS) return hit;
      let p = inflight.get(key);
      if (!p) {
        p = fetchToken(req).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const tok = await p;
      cache.delete(key);
      cache.set(key, tok);
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      return tok;
    }
  };
}
```

`JSON.stringify(req)` drops an `undefined` `permissions`, so `{ repositories }` and `{ repositories, permissions: undefined }` share a cache key, and the POST body omits it (the test pins the body).

- [ ] **Step 5: Run the minter tests**

Run: `npx vitest run src/host/appToken.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Mutation-check the three guards**

Each mutation must turn exactly the named test red; restore the file after each (`git checkout -- src/host/appToken.ts`).

```bash
sed -i "s/if (granted.join(',') !== req.repositories.join(','))/if (false)/" src/host/appToken.ts
npx vitest run src/host/appToken.test.ts | grep -E '×|Tests'   # × refuses a token GitHub scoped wider than asked
git checkout -- src/host/appToken.ts
sed -i 's/      let p = inflight.get(key);/      let p: Promise<ScopedToken> | undefined;/' src/host/appToken.ts
npx vitest run src/host/appToken.test.ts | grep -E '×|Tests'   # × caches per scope …
git checkout -- src/host/appToken.ts
sed -i 's/      if (allow) {/      if (false) {/' src/host/appToken.ts
npx vitest run src/host/appToken.test.ts | grep -E '×|Tests'   # × refuses repos outside github.repositories …
git checkout -- src/host/appToken.ts
```

- [ ] **Step 7: Write the failing config tests for `github`**

Append to `src/host/config.test.ts`, inside `describe('parseHostConfig', …)` (before its closing `});`):

```ts
  it('parses an optional github block: repositories allowlist and default permissions', () => {
    expect(parseHostConfig(base).github).toBeNull();
    const c = parseHostConfig({ ...base, github: { repositories: ['fleet-reviews', 'Fleet-Expertise'], permissions: { contents: 'write', pull_requests: 'write' } } });
    expect(c.github).toEqual({ repositories: ['fleet-reviews', 'fleet-expertise'], permissions: { contents: 'write', pull_requests: 'write' } });
    expect(parseHostConfig({ ...base, github: {} }).github).toEqual({ repositories: null, permissions: null });
  });

  it('refuses a malformed github block', () => {
    expect(() => parseHostConfig({ ...base, github: { repositories: [] } })).toThrow(/github.repositories/);
    expect(() => parseHostConfig({ ...base, github: { repositories: ['SumerSports/x'] } })).toThrow(/github.repositories/);
    expect(() => parseHostConfig({ ...base, github: { permissions: { contents: 'admin' } } })).toThrow(/github.permissions/);
    expect(() => parseHostConfig({ ...base, github: { repos: ['x'] } })).toThrow(/unknown key repos/);
  });
```

- [ ] **Step 8: Run them to see them fail**

Run: `npx vitest run src/host/config.test.ts`
Expected: FAIL, "host config has unknown key github".

- [ ] **Step 9: Parse the `github` block**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/config.ts', [
  ("""export interface HostConfig {
  workspace: HostWorkspaceInfo;""",
   """/** Host config `github`: limits on the App credential helper's tokens. */
export interface HostGithubConfig {
  /** Repository names in the installation's account; null = any. */
  repositories: string[] | null;
  /** Default `permissions` for every token; null = the installation's. */
  permissions: Record<string, 'read' | 'write'> | null;
}

export interface HostConfig {
  workspace: HostWorkspaceInfo;
  github: HostGithubConfig | null;""", 1),
  ("""export function parseHostConfig(raw: unknown): HostConfig {""",
   """function parseGithub(v: unknown): HostGithubConfig {
  const g = record(v, 'github');
  onlyKeys(g, 'github', ['repositories', 'permissions']);
  let repositories: string[] | null = null;
  if (g.repositories !== undefined) {
    const r = g.repositories;
    if (!Array.isArray(r) || r.length === 0 || r.length > 500 || r.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(x))) {
      throw new HostConfigError('github.repositories must list 1 to 500 repository names (no owner)');
    }
    repositories = [...new Set((r as string[]).map((x) => x.toLowerCase()))].sort();
  }
  let permissions: Record<string, 'read' | 'write'> | null = null;
  if (g.permissions !== undefined) {
    const p = record(g.permissions, 'github.permissions');
    permissions = {};
    for (const [k, val] of Object.entries(p)) {
      if (!/^[a-z_]{1,64}$/.test(k) || (val !== 'read' && val !== 'write')) throw new HostConfigError('github.permissions must map permission names to read or write');
      permissions[k] = val;
    }
  }
  return { repositories, permissions };
}

export function parseHostConfig(raw: unknown): HostConfig {""", 1),
  ("""  onlyKeys(o, 'host config', ['workspace', 'identity', 'grants', 'machines', 'trustedProxyHops']);""",
   """  onlyKeys(o, 'host config', ['workspace', 'identity', 'grants', 'machines', 'trustedProxyHops', 'github']);""", 1),
  ("""    workspace: parseWorkspace(o.workspace),
    identity:""",
   """    workspace: parseWorkspace(o.workspace),
    github: o.github === undefined ? null : parseGithub(o.github),
    identity:""", 1),
])
EOF
```

- [ ] **Step 10: Run the host suite and the gates**

Run: `CI=true npx vitest run src/host && npx tsc -p tsconfig.host.json`
Expected: PASS; tsc exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/host/appToken.ts src/host/appToken.test.ts src/host/testGithubApp.ts src/host/config.ts src/host/config.test.ts .dockerignore
git commit -m "feat(host): scoped GitHub App installation-token minter and github config block

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The credential socket, `fleet-host-cred`, and the image's git/gh wiring

**Files:**
- Create: `src/host/credServer.ts`, `src/host/credServer.test.ts`, `src/host/credCli.ts`, `src/host/credCli.test.ts`, `src/host/credMain.ts`, `docker/host/gh`, `docker/host/gitconfig`, `docker/host/gh.test.sh`
- Modify: `src/host/config.ts` (`credSocket`), `src/host/config.test.ts`, `src/host/main.ts`, `vite.host.config.ts`, `docker/host/Dockerfile`, `docker/host/smoke.test.sh`, `src/host/importGraph.test.ts`

**Interfaces:**
- Consumes: Task 1's `readAppEnv`, `loadAppCredentials`, `createTokenMinter`, `AppTokenError`, `HostGithubConfig`.
- Produces:
  - `DEFAULT_CRED_SOCKET = '/run/fleet-host/cred.sock'`; `HostEnv.credSocket`
  - `listenCredSocket(socketPath, minter, log): Promise<CredServer>`; `startCredHelper(o: CredHelperOptions): Promise<CredServer>`; `CredServer { close(): Promise<void> }`
  - `repoFromGitUrl(url)`, `repoFromCredentialInput(text)`, `repoFromGhArgs(args, env, cwdOrigin)` → `{ owner, repo } | null`
  - `requestToken(socketPath, body): Promise<string>`; `runCredCli(argv, io: CredIo): Promise<number>`
  - `RunHostOptions.githubApiBase?: string`
  - Bundle: `out/host/fleet-host-cred.mjs`; image command `fleet-host-cred`

- [ ] **Step 1: Write the failing socket tests**

`src/host/credServer.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenMinter, loadAppCredentials } from './appToken.js';
import { listenCredSocket, startCredHelper, type CredServer } from './credServer.js';
import { requestToken } from './credCli.js';
import { createLogger } from './log.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

let gh: FakeGithubApp | null = null;
let srv: CredServer | null = null;
afterEach(async () => {
  await srv?.close();
  await gh?.close();
  srv = null;
  gh = null;
});

async function rig(allow: string[] | null = null) {
  gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a', 'b'] });
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const keyFile = join(dir, 'key.pem');
  writeFileSync(keyFile, gh.privatePem, { mode: 0o400 });
  const logs: string[] = [];
  const sock = join(dir, 'run', 'cred.sock');
  srv = await startCredHelper({
    appEnv: { appId: '1', installationId: '2', keyFile },
    socketPath: sock,
    github: () => (allow ? { repositories: allow, permissions: null } : null),
    log: createLogger((l) => logs.push(l)),
    apiBase: gh.url
  });
  return { gh, sock, dir, logs };
}

describe('credential socket', () => {
  it('is 0600 in a 0700 directory and answers a scoped token', async () => {
    const { sock, gh } = await rig();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(join(sock, '..')).mode & 0o777).toBe(0o700);
    const token = await requestToken(sock, { owner: 'acme', repositories: ['a'] });
    expect(token).toMatch(/^ghs_fake/);
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['a'] });
  });

  it('relays refusals with their status, and never logs a token or the key', async () => {
    const { sock, gh, logs } = await rig(['a']);
    const token = await requestToken(sock, { repositories: ['a'] });
    await expect(requestToken(sock, { repositories: ['b'] })).rejects.toThrow(/403.*not in github.repositories/);
    await expect(requestToken(sock, { repositories: [] })).rejects.toThrow(/400/);
    const all = logs.join('\n');
    expect(all).toContain('app token issued');
    expect(all).not.toContain(token);
    expect(all).not.toContain(gh.privatePem.split('\n')[1]);
  });

  it('replaces a stale socket but refuses to unlink a regular file', async () => {
    const { sock } = await rig();
    await srv!.close();
    srv = null;
    const minter = createTokenMinter({ creds: await loadAppCredentials({ appId: '1', installationId: '2', keyFile: join(sock, '..', '..', 'key.pem') }), apiBase: gh!.url });
    srv = await listenCredSocket(sock, minter, createLogger(() => undefined));
    expect(await requestToken(sock, { repositories: ['a'] })).toMatch(/^ghs_/);
    const file = join(sock, '..', 'not-a-socket');
    writeFileSync(file, 'x');
    await expect(listenCredSocket(file, minter, createLogger(() => undefined))).rejects.toThrow(/not a socket/);
  });

  it('answers an oversize body with 413', async () => {
    const { sock } = await rig();
    await expect(requestToken(sock, { repositories: ['a'], pad: 'x'.repeat(9000) })).rejects.toThrow(/413/);
  });
});
```

- [ ] **Step 2: Write the failing CLI tests**

`src/host/credCli.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoFromCredentialInput, repoFromGhArgs, repoFromGitUrl, runCredCli, type CredIo } from './credCli.js';
import { startCredHelper, type CredServer } from './credServer.js';
import { createLogger } from './log.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

describe('repo parsers', () => {
  it('reads owner/repo from GitHub remote URLs only', () => {
    expect(repoFromGitUrl('https://github.com/SumerSports/fleet-reviews.git')).toEqual({ owner: 'SumerSports', repo: 'fleet-reviews' });
    expect(repoFromGitUrl('https://x-access-token@github.com/acme/a')).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGitUrl('git@github.com:acme/a.git')).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGitUrl('https://gitlab.com/acme/a.git')).toBeNull();
    expect(repoFromGitUrl('https://github.com/acme')).toBeNull();
  });

  it('reads git credential input (useHttpPath) and ignores other hosts', () => {
    expect(repoFromCredentialInput('protocol=https\nhost=github.com\npath=acme/a.git\n\n')).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromCredentialInput('protocol=https\nhost=github.com\n\n')).toBeNull();
    expect(repoFromCredentialInput('protocol=https\nhost=example.com\npath=acme/a\n')).toBeNull();
  });

  it('finds the repo gh acts on: -R/--repo, GH_REPO, gh api repos/…, then the cwd origin', () => {
    const none = () => null;
    expect(repoFromGhArgs(['pr', 'view', '1', '-R', 'acme/a'], {}, none)).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGhArgs(['pr', 'list', '--repo=acme/b'], {}, none)).toEqual({ owner: 'acme', repo: 'b' });
    expect(repoFromGhArgs(['pr', 'list', '-Racme/c'], {}, none)).toEqual({ owner: 'acme', repo: 'c' });
    expect(repoFromGhArgs(['issue', 'list'], { GH_REPO: 'acme/d' }, none)).toEqual({ owner: 'acme', repo: 'd' });
    expect(repoFromGhArgs(['api', 'repos/acme/e/pulls/1'], {}, none)).toEqual({ owner: 'acme', repo: 'e' });
    expect(repoFromGhArgs(['pr', 'view'], {}, () => 'git@github.com:acme/f.git')).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['search', 'prs'], {}, none)).toBeNull();
  });
});

describe('runCredCli', () => {
  let gh: FakeGithubApp | null = null;
  let srv: CredServer | null = null;
  afterEach(async () => {
    await srv?.close();
    await gh?.close();
  });

  async function rig() {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a', 'b'] });
    const dir = mkdtempSync(join(tmpdir(), 'credcli-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const sock = join(dir, 'run', 'cred.sock');
    srv = await startCredHelper({
      appEnv: { appId: '1', installationId: '2', keyFile: join(dir, 'key.pem') }, socketPath: sock,
      github: () => null, log: createLogger(() => undefined), apiBase: gh.url
    });
    return sock;
  }

  function io(sock: string | null, stdin = '', cwdOrigin: string | null = null) {
    const out: string[] = [];
    const err: string[] = [];
    const o: CredIo = {
      env: sock ? { FLEET_HOST_CRED_SOCKET: sock } : { FLEET_HOST_CRED_SOCKET: '/nonexistent/cred.sock' },
      stdin: async () => stdin, out: (s) => out.push(s), err: (s) => err.push(s), cwdOrigin: () => cwdOrigin
    };
    return { o, out, err };
  }

  it('git-credential get answers with x-access-token for the one repo in the path', async () => {
    const sock = await rig();
    const { o, out } = io(sock, 'protocol=https\nhost=github.com\npath=acme/a.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a'] });
  });

  it('git-credential store/erase and non-GitHub hosts print nothing and succeed', async () => {
    const sock = await rig();
    for (const [argv, stdin] of [[['git-credential', 'store'], ''], [['git-credential', 'get'], 'protocol=https\nhost=example.com\npath=x/y\n']] as const) {
      const { o, out } = io(sock, stdin);
      expect(await runCredCli([...argv], o)).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it('with the helper off, git-credential and gh-token print nothing and exit 0', async () => {
    for (const argv of [['git-credential', 'get'], ['gh-token', '--', 'pr', 'view', '-R', 'acme/a']]) {
      const { o, out, err } = io(null, 'protocol=https\nhost=github.com\npath=acme/a\n');
      expect(await runCredCli(argv, o)).toBe(0);
      expect(out).toEqual([]);
      expect(err.join('')).toMatch(/fleet-host-cred: /);
    }
  });

  it('gh-token prints a token for the repo gh acts on, or nothing', async () => {
    const sock = await rig();
    const a = io(sock);
    expect(await runCredCli(['gh-token', '--', 'pr', 'view', '-R', 'acme/b'], a.o)).toBe(0);
    expect(a.out.join('')).toMatch(/^ghs_fake\w+\n$/);
    const none = io(sock);
    expect(await runCredCli(['gh-token', '--', 'search', 'prs'], none.o)).toBe(0);
    expect(none.out).toEqual([]);
  });

  it('token needs at least one --repo and exits 1 on refusal', async () => {
    const sock = await rig();
    const ok = io(sock);
    expect(await runCredCli(['token', '--repo', 'acme/a', '--repo', 'b'], ok.o)).toBe(0);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a', 'b'] });
    const bad = io(sock);
    expect(await runCredCli(['token'], bad.o)).toBe(2);
    const refused = io(sock);
    expect(await runCredCli(['token', '--repo', 'zzz'], refused.o)).toBe(1);
    expect(refused.err.join('')).toMatch(/400/);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/host/credServer.test.ts src/host/credCli.test.ts`
Expected: FAIL, "Cannot find module './credServer.js'".

- [ ] **Step 4: Implement the socket server**

`src/host/credServer.ts`:

```ts
// The App credential socket. Sessions ask for a token scoped to named repos;
// the key never leaves this process. See SPEC §9 for what it does not protect.
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { AppTokenError, createTokenMinter, loadAppCredentials, type AppEnv, type TokenMinter } from './appToken.js';
import type { HostGithubConfig } from './config.js';
import type { Logger } from './log.js';

export const DEFAULT_CRED_SOCKET = '/run/fleet-host/cred.sock';
const MAX_BODY = 8 * 1024;

export interface CredServer { close(): Promise<void> }

export async function listenCredSocket(socketPath: string, minter: TokenMinter, log: Logger): Promise<CredServer> {
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const st = await lstat(socketPath).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
    await unlink(socketPath);
  }
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/token') return send(404, { error: 'not found' });
    let raw = '';
    let size = 0;
    req.setEncoding('utf8');
    // Drain an oversize body rather than reset it, so the client reads the 413.
    req.on('data', (c: string) => {
      size += Buffer.byteLength(c);
      if (size <= MAX_BODY) raw += c;
    });
    req.on('end', async () => {
      if (size > MAX_BODY) return send(413, { error: 'body too large' });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: 'body must be JSON' });
      }
      try {
        const t = await minter.mint(body);
        log.log('info', 'app token issued', { repositories: t.repositories });
        send(200, { token: t.token, expiresAt: new Date(t.expiresAt).toISOString() });
      } catch (err) {
        const status = err instanceof AppTokenError ? err.status : 500;
        const error = err instanceof AppTokenError ? err.message : 'internal error';
        log.log(status >= 500 ? 'error' : 'warn', 'app token refused', { status, error });
        send(status, { error });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface CredHelperOptions {
  appEnv: AppEnv;
  socketPath: string;
  /** Read per request, so a config reload applies. */
  github(): HostGithubConfig | null;
  log: Logger;
  apiBase?: string;
}

/** Loads the key and serves the socket. A failed account check is logged, not fatal: tokens are minted on demand. */
export async function startCredHelper(o: CredHelperOptions): Promise<CredServer> {
  const creds = await loadAppCredentials(o.appEnv);
  const minter = createTokenMinter({
    creds,
    apiBase: o.apiBase,
    allow: () => o.github()?.repositories ?? null,
    defaultPermissions: () => o.github()?.permissions ?? null
  });
  minter.account().then(
    (account) => o.log.log('info', 'github app ready', { appId: o.appEnv.appId, account }),
    (err: Error) => o.log.log('warn', 'github app check failed; tokens are minted on demand', { error: err.message })
  );
  return listenCredSocket(o.socketPath, minter, o.log);
}
```

- [ ] **Step 5: Implement the CLI**

`src/host/credCli.ts`:

```ts
// fleet-host-cred: the session side of the App credential helper (git's
// credential protocol, the gh shim, scripts) plus `serve` for a standalone server.
import { request } from 'node:http';
import { DEFAULT_CRED_SOCKET } from './credServer.js';

export interface OwnerRepo { owner: string; repo: string }

const OWNER_REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

function ownerRepo(s: string): OwnerRepo | null {
  const m = OWNER_REPO.exec(s.replace(/^github\.com\//, ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function repoFromGitUrl(url: string): OwnerRepo | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+)$/.exec(url.trim());
  return m ? ownerRepo(m[1]) : null;
}

/** git sends `key=value` lines; with useHttpPath it includes `path=owner/repo(.git)`. */
export function repoFromCredentialInput(text: string): OwnerRepo | null {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
  }
  if (kv.get('protocol') !== 'https' || kv.get('host') !== 'github.com' || !kv.get('path')) return null;
  return ownerRepo(kv.get('path')!);
}

export function repoFromGhArgs(args: string[], env: NodeJS.ProcessEnv, cwdOrigin: () => string | null): OwnerRepo | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') return ownerRepo(args[i + 1] ?? '');
    if (a.startsWith('--repo=')) return ownerRepo(a.slice('--repo='.length));
    if (a.startsWith('-R') && a.length > 2) return ownerRepo(a.slice(2));
  }
  if (env.GH_REPO) return ownerRepo(env.GH_REPO);
  if (args[0] === 'api' && args[1]) {
    const m = /^\/?repos\/([^/]+)\/([^/?#]+)/.exec(args[1]);
    if (m) return ownerRepo(`${m[1]}/${m[2]}`);
  }
  const origin = cwdOrigin();
  return origin ? repoFromGitUrl(origin) : null;
}

export function requestToken(socketPath: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/token', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15_000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (raw += c));
      res.on('end', () => {
        let j: { token?: unknown; error?: unknown } = {};
        try {
          j = JSON.parse(raw);
        } catch {
          /* status says it */
        }
        if (res.statusCode === 200 && typeof j.token === 'string') resolve(j.token);
        else reject(new Error(`${res.statusCode}: ${typeof j.error === 'string' ? j.error : 'no token'}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(new Error(`credential helper unavailable (${e.code ?? e.message})`)));
    req.end(JSON.stringify(body));
  });
}

export interface CredIo {
  env: NodeJS.ProcessEnv;
  stdin(): Promise<string>;
  out(s: string): void;
  err(s: string): void;
  /** `git remote get-url origin` in the cwd, or null. */
  cwdOrigin(): string | null;
}

const USAGE = 'usage: fleet-host-cred token --repo <name|owner/name>... | git-credential <get|store|erase> | gh-token -- <gh args> | serve';

export async function runCredCli(argv: string[], io: CredIo): Promise<number> {
  const sock = io.env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET;
  const say = (e: unknown) => io.err(`fleet-host-cred: ${(e as Error).message}\n`);
  switch (argv[0]) {
    case 'git-credential': {
      const input = await io.stdin();
      if (argv[1] !== 'get') return 0;
      const r = repoFromCredentialInput(input);
      if (!r) return 0;
      try {
        const token = await requestToken(sock, { owner: r.owner, repositories: [r.repo] });
        io.out(`username=x-access-token\npassword=${token}\n`);
      } catch (e) {
        say(e);
      }
      return 0;
    }
    case 'gh-token': {
      const r = repoFromGhArgs(argv.slice(argv[1] === '--' ? 2 : 1), io.env, io.cwdOrigin);
      if (!r) return 0;
      try {
        io.out(`${await requestToken(sock, { owner: r.owner, repositories: [r.repo] })}\n`);
      } catch (e) {
        say(e);
      }
      return 0;
    }
    case 'token': {
      const repos: string[] = [];
      let owner: string | undefined;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] !== '--repo' || !argv[i + 1]) return (io.err(`${USAGE}\n`), 2);
        const v = argv[++i];
        const r = v.includes('/') ? ownerRepo(v) : { owner: undefined, repo: v };
        if (!r) return (io.err(`${USAGE}\n`), 2);
        if (r.owner) owner = r.owner;
        repos.push(r.repo);
      }
      if (repos.length === 0) return (io.err(`${USAGE}\n`), 2);
      try {
        io.out(`${await requestToken(sock, { ...(owner ? { owner } : {}), repositories: repos })}\n`);
        return 0;
      } catch (e) {
        say(e);
        return 1;
      }
    }
    default:
      io.err(`${USAGE}\n`);
      return 2;
  }
}
```

`serve` is handled in the entry (it needs the logger and config), not in `runCredCli`.

`src/host/credMain.ts`:

```ts
// Bundle entry for fleet-host-cred.mjs. git runs it per credential lookup, so
// `serve`'s dependencies (config, and through it the store's AWS SDK) load lazily.
import { execFileSync } from 'node:child_process';
import { readAppEnv } from './appToken.js';
import { runCredCli } from './credCli.js';
import { createLogger, redactSecrets } from './log.js';

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'serve') {
    const { loadHostConfig, readHostEnv } = await import('./config.js');
    const { startCredHelper } = await import('./credServer.js');
    const appEnv = readAppEnv(process.env);
    if (!appEnv) throw new Error('serve needs FLEET_HOST_GITHUB_APP_ID, FLEET_HOST_GITHUB_INSTALLATION_ID and FLEET_HOST_GITHUB_APP_KEY_FILE');
    const env = readHostEnv(process.env);
    const config = await loadHostConfig(env.configPath);
    await startCredHelper({ appEnv, socketPath: env.credSocket, github: () => config.github, log: createLogger() });
    return new Promise<number>(() => undefined);
  }
  return runCredCli(argv, {
    env: process.env,
    stdin: async () => {
      if (process.stdin.isTTY) return '';
      let s = '';
      for await (const c of process.stdin) s += c;
      return s;
    },
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwdOrigin: () => {
      try {
        return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
      } catch {
        return null;
      }
    }
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`fleet-host-cred: ${redactSecrets(err.message)}\n`);
    process.exit(1);
  }
);
```

- [ ] **Step 6: Add `credSocket` to the env contract**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/config.ts', [
  ("""  brokerSocket: string;
}""", """  brokerSocket: string;
  credSocket: string;
}""", 1),
  ("""    brokerSocket: env.CLAUDE_FLEET_BROKER_SOCKET || '/run/broker/broker.sock'
  };""", """    brokerSocket: env.CLAUDE_FLEET_BROKER_SOCKET || '/run/broker/broker.sock',
    credSocket: env.FLEET_HOST_CRED_SOCKET || '/run/fleet-host/cred.sock'
  };""", 1),
])
edit('src/host/config.test.ts', [
  ("""      stateDir: '/home/fleet/.claude/fleet-host',""", """      stateDir: '/home/fleet/.claude/fleet-host',
      credSocket: '/run/fleet-host/cred.sock',""", 1),
])
EOF
sed -n '/applies the deployment contract defaults/,/});/p' src/host/config.test.ts
```

The printed block must list `credSocket` once; `toEqual` checks the whole object.

- [ ] **Step 7: Run the socket and CLI tests**

Run: `npx vitest run src/host/credServer.test.ts src/host/credCli.test.ts src/host/config.test.ts`
Expected: PASS.

- [ ] **Step 8: Start the helper from `runHost`**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/main.ts', [
  ("""import { AttachHub } from './attachHub.js';""", """import { readAppEnv } from './appToken.js';
import { AttachHub } from './attachHub.js';""", 1),
  ("""import { createReloader, watchConfigDir } from './configReload.js';""", """import { createReloader, watchConfigDir } from './configReload.js';
import { startCredHelper, type CredServer } from './credServer.js';""", 1),
  ("""  fatalStopMs?: number;
}""", """  fatalStopMs?: number;
  /** GitHub API base for the App credential helper (tests). */
  githubApiBase?: string;
}""", 1),
  ("""  const workspaceId = await resolveWorkspaceId(env.stateDir, config.workspace.id);
""", """  const workspaceId = await resolveWorkspaceId(env.stateDir, config.workspace.id);
  let cred: CredServer | null = null;
  try {
    const appEnv = readAppEnv(opts.env ?? process.env);
    if (appEnv) cred = await startCredHelper({ appEnv, socketPath: env.credSocket, github: () => config.github, log, apiBase: opts.githubApiBase });
    else log.log('info', 'github app credential helper off (FLEET_HOST_GITHUB_* unset)');
  } catch (err) {
    uninstallGuards();
    throw err;
  }
""", 1),
  ("""      await server.close();
      uninstallGuards();""", """      await server.close();
      await cred?.close();
      uninstallGuards();""", 1),
])
EOF
```

Add a `runHost` test to `src/host/main.test.ts` (inside `describe('runHost', …)`), next to the existing ones:

```ts
  it('serves App tokens on the credential socket when the three env vars are set', async () => {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const { requestToken } = await import('./credCli.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'fh-cred-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const sock = join(dir, 'run', 'cred.sock');
    const port = await freePort();
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + 'github: { repositories: [a] }\n');
    const host = await runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_SOCKET: sock, FLEET_HOST_GITHUB_APP_ID: '9', FLEET_HOST_GITHUB_INSTALLATION_ID: '8', FLEET_HOST_GITHUB_APP_KEY_FILE: join(dir, 'key.pem')
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, githubApiBase: gh.url
    });
    try {
      expect(await requestToken(sock, { repositories: ['a'] })).toMatch(/^ghs_fake/);
    } finally {
      await host.shutdown(0);
      await gh.close();
    }
  });
```

Run: `npx vitest run src/host/main.test.ts`
Expected: PASS.

- [ ] **Step 9: Bundle `fleet-host-cred.mjs` as a second entry**

Replace `vite.host.config.ts` with:

```ts
import { defineConfig } from 'vite';

// fleet-host and fleet-host-cred for plain Node 22 (no node_modules in the image).
// Shared code and lazily imported modules land in out/host/chunks/.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'out/host',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: { 'fleet-host': 'src/host/cli.ts', 'fleet-host-cred': 'src/host/credMain.ts' },
      output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs', format: 'es' }
    }
  },
  ssr: { noExternal: true, target: 'node' }
});
```

The import-graph test walks only `cli.ts`; walk both entries. In `src/host/importGraph.test.ts`:

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/importGraph.test.ts', [
  ("""const ENTRY = join(SRC, 'host', 'cli.ts');""", """const ENTRIES = [join(SRC, 'host', 'cli.ts'), join(SRC, 'host', 'credMain.ts')];""", 1),
  ("""  const stack = [ENTRY];""", """  const stack = [...ENTRIES];""", 1),
])
EOF
```

Run: `npm run build:host && ls out/host && node out/host/fleet-host-cred.mjs; echo "exit $?"`
Expected: `fleet-host.mjs` and `fleet-host-cred.mjs` listed (a `chunks/` directory may appear), then the usage line and `exit 2`.

Run: `printf 'protocol=https\nhost=github.com\npath=acme/a\n\n' | FLEET_HOST_CRED_SOCKET=/nonexistent/s node out/host/fleet-host-cred.mjs git-credential get; echo "exit $?"`
Expected: `fleet-host-cred: credential helper unavailable (ENOENT)` on stderr, `exit 0`.

- [ ] **Step 10: The gh shim, git config and image**

`docker/host/gh` (mode 0755):

```sh
#!/bin/sh
# gh with a short-lived App token scoped to the repo it acts on (fleet-host-cred
# gh-token). An explicit GH_TOKEN wins; no resolvable repo runs gh without one.
real=${FLEET_GH_REAL:-/usr/local/bin/gh}
if [ ! -x "$real" ]; then
  echo "gh is not installed in this image" >&2
  exit 127
fi
if [ -z "${GH_TOKEN:-}" ]; then
  tok=$(fleet-host-cred gh-token -- "$@" 2>/dev/null) || tok=
  if [ -n "$tok" ]; then
    GH_TOKEN=$tok
    export GH_TOKEN
  fi
fi
exec "$real" "$@"
```

`docker/host/gitconfig`:

```ini
[credential "https://github.com"]
	helper =
	helper = !fleet-host-cred git-credential
	useHttpPath = true
```

`docker/host/gh.test.sh` (mode 0755):

```bash
#!/usr/bin/env bash
# The gh shim: passes a scoped token as GH_TOKEN, keeps arguments intact, and
# runs gh without a token when fleet-host-cred has none.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cat > "$t/fleet-host-cred" <<'EOF'
#!/bin/sh
[ "$1" = gh-token ] || exit 2
shift; [ "$1" = -- ] && shift
case "$*" in *acme/a*) echo ghs_scoped ;; esac
EOF
cat > "$t/gh-real" <<'EOF'
#!/bin/sh
printf 'token=%s args=%s\n' "${GH_TOKEN:-none}" "$*"
EOF
chmod +x "$t/fleet-host-cred" "$t/gh-real"
run() { PATH="$t:$PATH" FLEET_GH_REAL="$t/gh-real" sh "$here/gh" "$@"; }
test "$(run pr view 1 -R acme/a)" = 'token=ghs_scoped args=pr view 1 -R acme/a'
test "$(run search prs 'a b')" = 'token=none args=search prs a b'
test "$(GH_TOKEN=mine run pr view -R acme/a)" = 'token=mine args=pr view -R acme/a'
echo "gh shim: OK"
```

Run: `chmod 0755 docker/host/gh docker/host/gh.test.sh && bash docker/host/gh.test.sh`
Expected: `gh shim: OK`.

Exclude the test from the image context: in `.dockerignore` the existing `docker/host/*.test.sh` line already covers it.

Update `docker/host/Dockerfile`:

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('docker/host/Dockerfile', [
  ("""COPY --from=host-build /src/out/host/fleet-host.mjs /usr/local/lib/fleet-host/fleet-host.mjs
COPY docker/host/fleet-host-entry /usr/local/bin/fleet-host-entry
RUN chmod 0644 /usr/local/lib/fleet-host/fleet-host.mjs /etc/ssl/certs/rds-global-bundle.pem \\
 && chmod 0755 /usr/local/bin/fleet-host-entry \\
 && printf '#!/bin/sh\\nexec node /usr/local/lib/fleet-host/fleet-host.mjs "$@"\\n' > /usr/local/bin/fleet-host \\
 && chmod 0755 /usr/local/bin/fleet-host \\
 && mkdir -p /etc/fleet-host""",
   """COPY --from=host-build /src/out/host/ /usr/local/lib/fleet-host/
COPY docker/host/fleet-host-entry /usr/local/bin/fleet-host-entry
# The gh shim goes first on PATH; git asks fleet-host-cred for github.com.
COPY docker/host/gh /usr/local/lib/fleet-host/bin/gh
COPY docker/host/gitconfig /etc/gitconfig
RUN find /usr/local/lib/fleet-host -type f -exec chmod 0644 {} + \\
 && chmod 0644 /etc/ssl/certs/rds-global-bundle.pem /etc/gitconfig \\
 && chmod 0755 /usr/local/bin/fleet-host-entry /usr/local/lib/fleet-host/bin /usr/local/lib/fleet-host/bin/gh \\
 && printf '#!/bin/sh\\nexec node /usr/local/lib/fleet-host/fleet-host.mjs "$@"\\n' > /usr/local/bin/fleet-host \\
 && printf '#!/bin/sh\\nexec node /usr/local/lib/fleet-host/fleet-host-cred.mjs "$@"\\n' > /usr/local/bin/fleet-host-cred \\
 && chmod 0755 /usr/local/bin/fleet-host /usr/local/bin/fleet-host-cred \\
 && mkdir -p /etc/fleet-host /run/fleet-host \\
 && chown fleet:fleet /run/fleet-host && chmod 0700 /run/fleet-host""", 1),
  ("""ENV FLEET_HOST_PORT=8080 \\""", """ENV PATH=/usr/local/lib/fleet-host/bin:$PATH \\
    FLEET_HOST_PORT=8080 \\""", 1),
])
EOF
grep -n 'out/host\|gitconfig\|PATH=\|run/fleet-host' docker/host/Dockerfile
```

Expected: the four greps each match.

Extend `docker/host/smoke.test.sh` (before the `docker stop` line):

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('docker/host/smoke.test.sh', [
  ("""docker exec "$cid" fleet-host init | grep -q '"workspaceId"'
""", """docker exec "$cid" fleet-host init | grep -q '"workspaceId"'
docker exec "$cid" git config --system --get-all credential.https://github.com.helper | grep -q 'fleet-host-cred git-credential'
test "$(docker exec "$cid" sh -c 'printf "protocol=https\\nhost=github.com\\npath=a/b\\n\\n" | fleet-host-cred git-credential get 2>/dev/null; echo rc=$?')" = rc=0
test "$(docker exec "$cid" sh -c 'command -v gh || true')" != /usr/local/bin/gh
""", 1),
])
EOF
```

(The third check: in `runner-host`, which has no `gh`, `command -v gh` finds the shim; in `runner-devops-host` it must not resolve to the real binary.)

- [ ] **Step 11: Run the gates**

Run the three gate commands from *Verification environment*, plus `bash docker/host/gh.test.sh`.
Expected: PASS; tsc exit 0 for all three configs.

- [ ] **Step 12: Commit**

```bash
git add src/host/credServer.ts src/host/credServer.test.ts src/host/credCli.ts src/host/credCli.test.ts src/host/credMain.ts \
  src/host/config.ts src/host/config.test.ts src/host/main.ts src/host/main.test.ts src/host/importGraph.test.ts \
  vite.host.config.ts docker/host/gh docker/host/gitconfig docker/host/gh.test.sh docker/host/Dockerfile docker/host/smoke.test.sh
git commit -m "feat(host): App credential socket, fleet-host-cred (git helper, gh shim), image wiring

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `db:` block, the host pool, health, and the bundle reaching the store

**Files:**
- Create: `src/host/hostSchema.ts`, `src/host/hostDb.ts`, `src/host/hostDb.test.ts`, `src/host/sqliteStub.ts`, `src/host/configReload.db.test.ts`
- Modify: `src/host/config.ts`, `src/host/config.test.ts`, `src/host/configReload.ts`, `src/host/server.ts`, `src/host/server.test.ts`, `src/host/main.ts`, `vite.host.config.ts`, `src/host/importGraph.test.ts`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: part 3's `parseStoreConfig`, `pgPoolConfig`, `iamAuthHint`, `StoreConfigError`, `PostgresStoreConfig` (`src/main/store/storeConfig.ts`); `createPgPool`, `postgresKysely` (`postgres.ts`); `migratePostgres`, `PgTrack` (`pgMigrate.ts`).
- Produces:
  - `HostDb` (tables `host_meta`, `host_lease`, `host_ingest_offsets`), `HOST_TRACK: PgTrack`
  - `HostConfig.db: PostgresStoreConfig | null`
  - `openHostDb(cfg, { env?, log }): Promise<HostDbHandle>`; `openHostDbRetrying(cfg, { env?, log, sleep?, maxDelayMs? })`; `HostDbHandle { pool; k: Kysely<HostDb>; ping(); end() }`
  - `startDbHealth(ping, { log, intervalMs?, maxAgeMs?, timeoutMs?, now? }): DbHealth { ok(); tick(): Promise<void>; stop() }`
  - `HostServerDeps.db?(): 'ok' | 'down' | 'none'`; `/healthz` → `{ status, lease, db }`

- [ ] **Step 1: The host track**

`src/host/hostSchema.ts`:

```ts
// The host's own tables (migration track 'host'), in the store's schema beside 'state' and 'inbox'.
import type { PgTrack } from '../main/store/pgMigrate.js';

export interface HostDb {
  host_meta: { singleton: boolean; workspace_id: string; created_at: number };
  host_lease: { workspace_id: string; holder: string | null; epoch: number; expires_at: Date };
  host_ingest_offsets: { path: string; byte_offset: number; updated_at: number };
}

export const HOST_PG_BASELINE_VERSION = 1;

export const HOST_PG_BASELINE = `
CREATE TABLE host_meta (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  workspace_id TEXT COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE host_lease (
  workspace_id TEXT COLLATE "C" PRIMARY KEY,
  holder TEXT COLLATE "C",
  epoch BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE host_ingest_offsets (
  path TEXT COLLATE "C" PRIMARY KEY,
  byte_offset BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
`;

export const HOST_TRACK: PgTrack = { track: 'host', baselineVersion: HOST_PG_BASELINE_VERSION, baseline: HOST_PG_BASELINE, steps: [] };
```

(`offset` is a reserved word in Postgres, hence `byte_offset`.)

- [ ] **Step 2: Write the failing config and reload tests**

Append inside `describe('parseHostConfig', …)` in `src/host/config.test.ts`:

```ts
  it('parses an optional db block as a Postgres store config (static secrets allowed: the config is a mounted secret)', () => {
    expect(parseHostConfig(base).db).toBeNull();
    const c = parseHostConfig({
      ...base,
      db: { host: 'fleet.cluster-abc.us-east-1.rds.amazonaws.com', database: 'fleet', user: 'fleet_agent', password: { kind: 'aws-rds-iam', region: 'us-east-1' }, caFile: '/etc/ssl/certs/rds-global-bundle.pem' }
    });
    expect(c.db).toEqual({
      kind: 'postgres', schema: 'fleet', poolMax: 4,
      connection: {
        host: 'fleet.cluster-abc.us-east-1.rds.amazonaws.com', port: 5432, database: 'fleet', user: 'fleet_agent',
        password: { kind: 'aws-rds-iam', region: 'us-east-1' }, ssl: 'verify-full', caFile: '/etc/ssl/certs/rds-global-bundle.pem'
      }
    });
    expect(parseHostConfig({ ...base, db: { connectionString: 'postgres://u:pw@localhost/fleet' } }).db?.connection).toEqual({ connectionString: 'postgres://u:pw@localhost/fleet' });
  });

  it('refuses a db block with kind, an unknown key, or no connection', () => {
    expect(() => parseHostConfig({ ...base, db: { kind: 'postgres', connectionString: 'postgres://x' } })).toThrow(/db has unknown key kind/);
    expect(() => parseHostConfig({ ...base, db: { connectionString: 'postgres://x', name: 'fleet' } })).toThrow(/db: unknown key "name"/);
    expect(() => parseHostConfig({ ...base, db: {} })).toThrow(/db: needs exactly one of/);
  });
```

`src/host/configReload.db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseHostConfig, type HostConfig } from './config.js';
import { createReloader } from './configReload.js';
import { createLogger } from './log.js';

describe('reload and db', () => {
  it('refuses a reload that changes db, and keeps the running config', async () => {
    const logs: string[] = [];
    const mk = (db: string): HostConfig => parseHostConfig({ workspace: { name: 'w' }, db: { connectionString: `postgres://u@localhost/${db}` } });
    let next = mk('fleet');
    const r = createReloader({ path: '/x', load: async () => next, apply: async () => undefined, log: createLogger((l) => logs.push(l)) });
    expect(await r.reload('start')).toBe(true);
    next = mk('other');
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(r.current()?.db).toEqual(mk('fleet').db);
    expect(logs.join('\n')).toMatch(/db cannot change on reload/);
  });
});
```

Run: `npx vitest run src/host/config.test.ts src/host/configReload.db.test.ts`
Expected: FAIL, "host config has unknown key db".

- [ ] **Step 3: Parse `db` and refuse a change on reload**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/config.ts', [
  ("""import { ORG_RE, parseGrantConfig, type GrantConfig } from '../main/identity/grants.js';""",
   """import { ORG_RE, parseGrantConfig, type GrantConfig } from '../main/identity/grants.js';
import { parseStoreConfig, StoreConfigError, type PostgresStoreConfig } from '../main/store/storeConfig.js';""", 1),
  ("""  github: HostGithubConfig | null;""", """  github: HostGithubConfig | null;
  /** The host store; null runs without one (process-local lease, no ingest). */
  db: PostgresStoreConfig | null;""", 1),
  ("""export function parseHostConfig(raw: unknown): HostConfig {""", """function parseDb(v: unknown): PostgresStoreConfig {
  const d = record(v, 'db');
  if ('kind' in d) throw new HostConfigError('db has unknown key kind (the host store is always Postgres)');
  try {
    return parseStoreConfig({ ...d, kind: 'postgres' }, { allowStaticSecrets: true }) as PostgresStoreConfig;
  } catch (err) {
    if (err instanceof StoreConfigError) throw new HostConfigError(`db: ${err.message.replace(/^store: /, '')}`);
    throw err;
  }
}

export function parseHostConfig(raw: unknown): HostConfig {""", 1),
  ("""'trustedProxyHops', 'github']);""", """'trustedProxyHops', 'github', 'db']);""", 1),
  ("""    github: o.github === undefined ? null : parseGithub(o.github),""", """    github: o.github === undefined ? null : parseGithub(o.github),
    db: o.db === undefined ? null : parseDb(o.db),""", 1),
])
edit('src/host/configReload.ts', [
  ("""      if (isDeepStrictEqual(cfg, current)) {""", """      if (!isDeepStrictEqual(cfg.db, current.db)) return reject('db cannot change on reload; restart to apply');
      if (isDeepStrictEqual(cfg, current)) {""", 1),
])
EOF
```

Run: `npx vitest run src/host/config.test.ts src/host/configReload.db.test.ts src/host/configReload.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing host-pool and health tests**

`src/host/hostDb.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import { isPg } from '../main/store/testStore.js';
import { openHostDb, openHostDbRetrying, startDbHealth, type HostDbHandle } from './hostDb.js';
import { createLogger } from './log.js';

const quiet = createLogger(() => undefined);

describe('startDbHealth', () => {
  it('is ok only while the last good ping is at most maxAge old', async () => {
    let now = 1_000;
    let fail = false;
    const h = startDbHealth(async () => { if (fail) throw new Error('down'); }, { log: quiet, intervalMs: 3_600_000, maxAgeMs: 15_000, now: () => now });
    await h.tick();
    expect(h.ok()).toBe(true);
    fail = true;
    now += 10_000;
    await h.tick();
    expect(h.ok()).toBe(true);
    now += 6_000;
    expect(h.ok()).toBe(false);
    fail = false;
    await h.tick();
    expect(h.ok()).toBe(true);
    h.stop();
  });

  it('a hung ping times out and counts as a failure', async () => {
    const logs: string[] = [];
    const h = startDbHealth(() => new Promise<void>(() => undefined), { log: createLogger((l) => logs.push(l)), intervalMs: 3_600_000, timeoutMs: 20 });
    await h.tick();
    expect(h.ok()).toBe(false);
    expect(logs.join('\n')).toMatch(/host db ping failed.*timed out/);
    h.stop();
  });
});

describe.skipIf(!isPg)('openHostDb', () => {
  const schema = `t_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString('hex')}`;
  const cfg: PostgresStoreConfig = { kind: 'postgres', schema, poolMax: 2, connection: { connectionString: process.env.PG_TEST_URL ?? 'postgres://unset' } };
  const admin = async (q: string) => {
    const c = new pg.Client({ connectionString: process.env.PG_TEST_URL });
    await c.connect();
    try { return await c.query(q); } finally { await c.end(); }
  };
  let h: HostDbHandle | null = null;
  afterEach(async () => {
    await h?.end();
    h = null;
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('migrates the host track inside the existing schema, idempotently, and pings', async () => {
    await admin(`CREATE SCHEMA ${schema}`);
    h = await openHostDb(cfg, { log: quiet });
    await h.ping();
    await h.end();
    h = await openHostDb(cfg, { log: quiet });
    const v = await admin(`SELECT version FROM ${schema}.schema_migrations WHERE track = 'host'`);
    expect(v.rows).toEqual([{ version: '1' }]);
    const t = await admin(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name LIKE 'host_%' ORDER BY 1`);
    expect(t.rows.map((r) => r.table_name)).toEqual(['host_ingest_offsets', 'host_lease', 'host_meta']);
  });

  it('retries until the schema exists, logging each failure', async () => {
    const logs: string[] = [];
    let attempts = 0;
    h = await openHostDbRetrying(cfg, {
      log: createLogger((l) => logs.push(l)),
      sleep: async () => {
        if (++attempts === 2) await admin(`CREATE SCHEMA ${schema}`);
      }
    });
    expect(attempts).toBe(2);
    expect(logs.filter((l) => l.includes('host db unavailable; retrying'))).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/does not exist/);
  });

  it('does not retry a config error', async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(openHostDbRetrying({ ...cfg, connection: { env: 'FLEET_DB_UNSET' } }, { log: quiet, env: {}, sleep })).rejects.toThrow(/FLEET_DB_UNSET is not set/);
    expect(sleep).not.toHaveBeenCalled();
  });
});
```

(`admin()` uses a plain `pg.Client` whose `int8` parses as a string, hence `'1'`.)

Run: `npx vitest run src/host/hostDb.test.ts`
Expected: FAIL, "Cannot find module './hostDb.js'".

- [ ] **Step 5: Implement the host pool and health**

`src/host/hostDb.ts`:

```ts
// The host pool: the 'host' track (meta, lease, ingest offsets) on an unfenced
// handle, opened at start by holder and standby alike.
import type pg from 'pg';
import type { Kysely } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { createPgPool, postgresKysely } from '../main/store/postgres.js';
import { iamAuthHint, pgPoolConfig, StoreConfigError, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import type { Logger } from './log.js';

export interface HostDbHandle {
  pool: pg.Pool;
  k: Kysely<HostDb>;
  ping(): Promise<void>;
  end(): Promise<void>;
}

export async function openHostDb(cfg: PostgresStoreConfig, o: { env?: NodeJS.ProcessEnv; log: Logger }): Promise<HostDbHandle> {
  const pool = createPgPool({ ...pgPoolConfig(cfg, o.env), max: 2 });
  pool.on('error', (e) => o.log.log('warn', 'host db pool error', { error: e.message }));
  const k = postgresKysely<HostDb>(pool);
  try {
    await migratePostgres(k, cfg.schema, HOST_TRACK);
  } catch (e) {
    await k.destroy().catch(() => undefined);
    await pool.end().catch(() => undefined);
    const hint = iamAuthHint(cfg, e);
    if (hint) (e as Error).message += ` (${hint})`;
    throw e;
  }
  return {
    pool,
    k,
    async ping() {
      await k.selectNoFrom((eb) => eb.val(1).as('one')).execute();
    },
    async end() {
      await k.destroy();
      await pool.end();
    }
  };
}

/** Retries anything but a config error, so a DB blip at start doesn't crash-loop the container. */
export async function openHostDbRetrying(
  cfg: PostgresStoreConfig,
  o: { env?: NodeJS.ProcessEnv; log: Logger; sleep?: (ms: number) => Promise<void>; maxDelayMs?: number }
): Promise<HostDbHandle> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let delay = 1_000; ; delay = Math.min(delay * 2, o.maxDelayMs ?? 30_000)) {
    try {
      return await openHostDb(cfg, o);
    } catch (err) {
      if (err instanceof StoreConfigError) throw err;
      o.log.log('warn', 'host db unavailable; retrying', { error: (err as Error).message, delayMs: delay });
      await sleep(delay);
    }
  }
}

export interface DbHealth {
  ok(): boolean;
  tick(): Promise<void>;
  stop(): void;
}

export function startDbHealth(
  ping: () => Promise<void>,
  o: { log: Logger; intervalMs?: number; maxAgeMs?: number; timeoutMs?: number; now?: () => number }
): DbHealth {
  const now = o.now ?? Date.now;
  let lastOk: number | null = null;
  let failing = false;
  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    running ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ping(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('db ping timed out')), o.timeoutMs ?? 3_000);
          })
        ]);
        lastOk = now();
        if (failing) o.log.log('info', 'host db reachable again');
        failing = false;
      } catch (err) {
        if (!failing) o.log.log('warn', 'host db ping failed', { error: (err as Error).message });
        failing = true;
      } finally {
        clearTimeout(timer);
        running = null;
      }
    })();
    return running;
  };
  void tick();
  const t = setInterval(() => void tick(), o.intervalMs ?? 5_000);
  t.unref();
  return { ok: () => lastOk !== null && now() - lastOk <= (o.maxAgeMs ?? 15_000), tick, stop: () => clearInterval(t) };
}
```

Add it to the Postgres suite:

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
add_pg_suite('src/host/hostDb.test.ts')
EOF
```

Run: `npx vitest run src/host/hostDb.test.ts && CI=true npx vitest run -c vitest.pg.config.ts src/host/hostDb.test.ts`
Expected: PASS (2 tests on the default run, 5 on Postgres).

- [ ] **Step 6: `/healthz` reports the DB**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/server.ts', [
  ("""  healthy(): boolean;
  hub: AttachHub;""", """  healthy(): boolean;
  /** Absent: no host store. */
  db?(): 'ok' | 'down' | 'none';
  hub: AttachHub;""", 1),
  ("""{ status: deps.healthy() ? 'ok' : 'unhealthy', lease: deps.lease() });""",
   """{ status: deps.healthy() ? 'ok' : 'unhealthy', lease: deps.lease(), db: deps.db?.() ?? 'none' });""", 1),
])
edit('src/host/server.test.ts', [
  ("""toEqual({ status: 'ok', lease: 'holder' });""", """toEqual({ status: 'ok', lease: 'holder', db: 'none' });""", 1),
  ("""toEqual({ status: 'ok', lease: 'standby' });""", """toEqual({ status: 'ok', lease: 'standby', db: 'none' });""", 1),
])
EOF
```

- [ ] **Step 7: Open the host pool in `runHost`**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/main.ts', [
  ("""import { resolveWorkspaceId } from './hostState.js';""", """import { openHostDbRetrying, startDbHealth, type DbHealth, type HostDbHandle } from './hostDb.js';
import { resolveWorkspaceId } from './hostState.js';""", 1),
  ("""  const workspaceId = await resolveWorkspaceId(env.stateDir, config.workspace.id);
""", """  let hostDb: HostDbHandle | null = null;
  let dbHealth: DbHealth | null = null;
  try {
    if (config.db) {
      hostDb = await openHostDbRetrying(config.db, { env: opts.env ?? process.env, log });
      dbHealth = startDbHealth(hostDb.ping, { log });
    } else {
      log.log('warn', 'no db configured: process-local lease and no ingest; run exactly one replica');
    }
  } catch (err) {
    uninstallGuards();
    throw err;
  }
  const workspaceId = await resolveWorkspaceId(env.stateDir, config.workspace.id);
""", 1),
  ("""    healthy: () => leaseMgr.running,""", """    healthy: () => leaseMgr.running && (dbHealth?.ok() ?? true),
    db: () => (dbHealth ? (dbHealth.ok() ? 'ok' : 'down') : 'none'),""", 1),
  ("""      await cred?.close();""", """      await cred?.close();
      dbHealth?.stop();
      await hostDb?.end().catch(() => undefined);""", 1),
])
EOF
```

- [ ] **Step 8: Let the bundle reach the store**

Alias `better-sqlite3` (the host never opens SQLite; `db.ts` and `inboxDb.ts` import it at the top):

`src/host/sqliteStub.ts`:

```ts
// The host bundle's stand-in for better-sqlite3: the host store is Postgres only.
export default function Database(): never {
  throw new Error('SQLite is not available in fleet-host');
}
```

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('vite.host.config.ts', [
  ("""import { defineConfig } from 'vite';
""", """import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
""", 1),
  ("""export default defineConfig({
  build: {""", """export default defineConfig({
  resolve: { alias: { 'better-sqlite3': fileURLToPath(new URL('src/host/sqliteStub.ts', import.meta.url)) } },
  build: {""", 1),
])
edit('src/host/importGraph.test.ts', [
  ("""const BARE_ALLOWED = new Set(['ws', 'yaml', 'ulid']);""",
   """// better-sqlite3 resolves to src/host/sqliteStub.ts in the bundle (vite.host.config.ts).
const BARE_ALLOWED = new Set(['ws', 'yaml', 'ulid', 'kysely', 'pg', 'pg-connection-string', '@aws-sdk', 'better-sqlite3']);""", 1),
  ("""/^preload\\/identityTypes\\.ts$/];""",
   """/^preload\\/identityTypes\\.ts$/,
  /^main\\/store\\/(kysely|postgres|pgMigrate|storeConfig|passwordProvider|pgSsl|pgStores|stateSchema|inboxSchema)\\.ts$/,
  /^main\\/store\\/migrations\\/(statePg|inboxPg)\\.ts$/,
  /^main\\/(db|asyncCache|contextWindow|pricing|usageAnchors|userPromptText|vectors)\\.ts$/,
  /^main\\/state\\/(ingestParse|serialQueue|transcriptPaths)\\.ts$/,
  /^main\\/inbox\\/(inboxDb|inboxCore)\\.ts$/,
  /^preload\\/inboxTypes\\.ts$/];""", 1),
])
inputs = """src/main/store/kysely.ts
src/main/store/postgres.ts
src/main/store/pgMigrate.ts
src/main/store/storeConfig.ts
src/main/store/passwordProvider.ts
src/main/store/pgSsl.ts
src/main/store/pgStores.ts
src/main/store/stateSchema.ts
src/main/store/inboxSchema.ts
src/main/store/migrations/**
src/main/db.ts
src/main/asyncCache.ts
src/main/contextWindow.ts
src/main/pricing.ts
src/main/usageAnchors.ts
src/main/userPromptText.ts
src/main/vectors.ts
src/main/state/ingestParse.ts
src/main/state/serialQueue.ts
src/main/state/transcriptPaths.ts
src/main/inbox/inboxDb.ts
src/main/inbox/inboxCore.ts
src/preload/inboxTypes.ts""".split('\n')
edit('.dockerignore', [('!src/preload/identityTypes.ts\n', '!src/preload/identityTypes.ts\n' + ''.join(f'!{p}\n' for p in inputs), 1)])
for wf in ('.github/workflows/publish-runner.yml', '.github/workflows/test-runner-images.yml'):
    edit(wf, [("      - 'src/preload/identityTypes.ts'\n", "      - 'src/preload/identityTypes.ts'\n" + ''.join(f"      - '{p}'\n" for p in inputs), 1)])
EOF
```

(`build-app.yml`'s path filter already matches all of `src/`.)

- [ ] **Step 9: Run the gates and build the bundle**

Run the three gate commands, then `npm run build:host && ls out/host out/host/chunks`.
Expected: PASS; tsc exit 0; `fleet-host.mjs`, `fleet-host-cred.mjs` and a `chunks/` directory.

Check the bundle against Postgres (the c1 broker isn't needed for `/healthz`):

```bash
d=$(mktemp -d); s=t_bundle_$$
psql_admin() { node -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.PG_TEST_URL});c.connect().then(()=>c.query(process.argv[1])).then(()=>c.end())" "$1"; }
psql_admin "CREATE SCHEMA $s"
printf 'workspace: { name: bundle }\ndb: %s\n' "{\"connectionString\": \"$PG_TEST_URL\", \"schema\": \"$s\"}" > "$d/config.yaml"
FLEET_HOST_PORT=18099 FLEET_HOST_CONFIG="$d/config.yaml" FLEET_HOST_STATE="$d/state" CLAUDE_FLEET_BROKER_SOCKET="$d/none.sock" node out/host/fleet-host.mjs > "$d/log" 2>&1 &
pid=$!; sleep 3; curl -s localhost:18099/healthz; echo; kill $pid; wait $pid; psql_admin "DROP SCHEMA $s CASCADE"
```

Expected: `{"status":"ok","lease":"holder","db":"ok"}`. (`lease` is still the in-memory store until Task 4.)

- [ ] **Step 10: Commit**

```bash
git add src/host/hostSchema.ts src/host/hostDb.ts src/host/hostDb.test.ts src/host/sqliteStub.ts src/host/configReload.db.test.ts \
  src/host/config.ts src/host/config.test.ts src/host/configReload.ts src/host/server.ts src/host/server.test.ts src/host/main.ts \
  vite.host.config.ts src/host/importGraph.test.ts .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml vitest.pg.config.ts
git commit -m "feat(host): db config block, host pool with retrying open and health, store-ready bundle

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The Postgres lease, the write fence, and holder-only stores

**Files:**
- Create: `src/host/pgLease.ts`, `src/host/pgLease.test.ts`, `src/host/holder.ts`, `src/host/main.pg.test.ts`
- Modify: `src/host/lease.ts`, `src/host/lease.test.ts`, `src/host/main.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: Task 3's `HostDb`, `HOST_TRACK`, `HostDbHandle`; part 3's `WriteHook`, `postgresKysely`, `openPgStores`, `PgStores`, `closeDb`.
- Produces:
  - `postgresLeaseStore(k: Kysely<HostDb>, workspaceId): LeaseStore`
  - `leaseFence(t: FenceTarget): WriteHook`; `FenceTarget { workspaceId; holder; epoch(): number | null; onLost(err: LeaseLostError): void }`; `class LeaseLostError`
  - `LeaseManager.markLost(): void`
  - `startHolder(o: HolderOptions): Promise<Holder>`; `HolderOptions { db; env; workspaceId; holder; epoch(); onLost(); log }`; `Holder { stores: PgStores; stop(): Promise<void> }` (Task 6 adds `projectsDir` and ingest)
  - `RunHostOptions.leaseRenewMs?`, `leaseTtlMs?`

- [ ] **Step 1: Write the failing lease and fence tests**

`src/host/pgLease.test.ts` (validated in a scratch worktree on PG 16.15; the concurrency test fails 3/3 with `FOR SHARE` removed from the fence):

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { postgresKysely } from '../main/store/postgres.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { isPg, pgMultiConnection, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK } from './hostSchema.js';
import { leaseFence, LeaseLostError, postgresLeaseStore } from './pgLease.js';

const WS = '01JC0000000000000000000000';
interface T { w: { epoch: number; seq: number } }

describe.skipIf(!isPg)('postgresLeaseStore + leaseFence', () => {
  let t: TestPg | null = null;
  afterEach(async () => {
    await t?.drop();
    t = null;
  });

  async function setup() {
    t = await testPgSchema();
    const k = postgresKysely<unknown>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await sql`CREATE SEQUENCE wseq`.execute(k);
    await sql`CREATE TABLE w (epoch BIGINT NOT NULL, seq BIGINT NOT NULL DEFAULT nextval('wseq'))`.execute(k);
    return postgresLeaseStore(postgresKysely(t.pool), WS);
  }
  const q = (text: string) => t!.pool.query(text.replaceAll('$S', t!.schema));
  const fenced = (holder: string, epoch: () => number | null, lost: Error[] = []): Kysely<T> =>
    postgresKysely<T>(t!.pool, { afterBeginWrite: leaseFence({ workspaceId: WS, holder, epoch, onLost: (e) => lost.push(e) }) });

  it('one holder; a live lease is refused; re-acquire by the holder bumps the epoch; release frees it', async () => {
    const s = await setup();
    expect(await s.tryAcquire('a', 0, 30_000)).toBe(1);
    expect(await s.tryAcquire('b', 0, 30_000)).toBeNull();
    expect(await s.renew('a', 1, 0, 30_000)).toBe(true);
    expect(await s.renew('a', 2, 0, 30_000)).toBe(false);
    expect(await s.tryAcquire('a', 0, 30_000)).toBe(2);
    await s.release('a', 2);
    expect(await s.tryAcquire('b', 0, 30_000)).toBe(3);
    expect(await s.renew('a', 2, 0, 30_000)).toBe(false);
  });

  it('judges expiry on the DB clock, never the caller’s', async () => {
    const s = await setup();
    await s.tryAcquire('a', 0, 30_000);
    expect(await s.tryAcquire('b', Date.now() + 3_600_000, 30_000)).toBeNull();
    await q(`UPDATE $S.host_lease SET expires_at = clock_timestamp() - interval '1 second'`);
    expect(await s.tryAcquire('b', 0, 30_000)).toBe(2);
  });

  it('a fenced write passes for the holder and fails, calling onLost, for anyone else', async () => {
    const s = await setup();
    const e = (await s.tryAcquire('a', 0, 30_000))!;
    await fenced('a', () => e).insertInto('w').values({ epoch: e }).execute();
    const lost: Error[] = [];
    await expect(fenced('b', () => e, lost).insertInto('w').values({ epoch: e }).execute()).rejects.toBeInstanceOf(LeaseLostError);
    await expect(fenced('a', () => null, lost).insertInto('w').values({ epoch: e }).execute()).rejects.toThrow(/not the holder/);
    await expect(fenced('a', () => e + 1, lost).insertInto('w').values({ epoch: e }).execute()).rejects.toThrow(/lease lost/);
    expect(lost).toHaveLength(3);
    expect((await q(`SELECT count(*)::int AS n FROM $S.w`)).rows[0].n).toBe(1);
  });

  it.skipIf(!pgMultiConnection)('a takeover waits for an in-flight fenced write; the stale holder then fails', async () => {
    const s = await setup();
    const lostA: Error[] = [];
    const epochA = (await s.tryAcquire('a', 0, 1_000))!;
    const ka = fenced('a', () => epochA, lostA);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inTx!: () => void;
    const entered = new Promise<void>((r) => (inTx = r));
    const txA = ka.transaction().execute(async (trx) => {
      await trx.insertInto('w').values({ epoch: epochA }).execute();
      inTx();
      await gate;
    });
    await entered;
    // Wait for expiry on the DB clock; a plain SELECT doesn't wait on A's FOR SHARE.
    while (!(await q(`SELECT expires_at <= clock_timestamp() AS e FROM $S.host_lease`)).rows[0].e) {
      await new Promise((r) => setTimeout(r, 100));
    }
    let acquired: number | null | undefined;
    const take = s.tryAcquire('b', 0, 30_000).then((e) => (acquired = e));
    await new Promise((r) => setTimeout(r, 300));
    expect(acquired).toBeUndefined();
    release();
    await txA;
    await take;
    expect(acquired).toBe(epochA + 1);
    await expect(ka.insertInto('w').values({ epoch: epochA }).execute()).rejects.toBeInstanceOf(LeaseLostError);
    expect(lostA).toHaveLength(1);
    await fenced('b', () => acquired!).insertInto('w').values({ epoch: acquired! }).execute();
    expect((await q(`SELECT epoch FROM $S.w ORDER BY seq`)).rows.map((r) => Number(r.epoch))).toEqual([epochA, epochA + 1]);
  }, 30_000);

  it.skipIf(!pgMultiConnection)('under concurrent writers and repeated takeovers, no stale write commits after a takeover', async () => {
    const s = await setup();
    const holders = ['a', 'b', 'c'];
    const held = new Map<string, number | null>(holders.map((h) => [h, null]));
    // One write transaction at a time per handle (its write lock), so the epoch
    // the fence validated last is the one the open transaction runs under.
    const validated = new Map<string, number>();
    const handles = new Map(holders.map((h) => [h, postgresKysely<T>(t!.pool, {
      afterBeginWrite: async (exec) => {
        const e = held.get(h) ?? null;
        await leaseFence({ workspaceId: WS, holder: h, epoch: () => e, onLost: () => undefined })(exec);
        validated.set(h, e!);
      }
    })]));
    const takeovers: { epoch: number; seq: number }[] = [];
    let stop = false;
    const writer = async (h: string) => {
      let ok = 0;
      let refused = 0;
      while (!stop) {
        try {
          await handles.get(h)!.transaction().execute(async (trx) => {
            const e = validated.get(h)!;
            // Validated, not yet written: the window a takeover must not slip into.
            await new Promise((r) => setTimeout(r, Math.random() * 8));
            await trx.insertInto('w').values({ epoch: e }).execute();
          });
          ok++;
        } catch (err) {
          if (!(err instanceof LeaseLostError)) throw err;
          refused++;
          await new Promise((r) => setTimeout(r, 2));
        }
      }
      return { ok, refused };
    };
    const writers = holders.flatMap((h) => [writer(h), writer(h)]);
    for (let i = 0; i < 30; i++) {
      const h = holders[i % holders.length];
      await q(`UPDATE $S.host_lease SET expires_at = clock_timestamp() - interval '1 ms'`);
      const e = await s.tryAcquire(h, 0, 30_000);
      expect(e).not.toBeNull();
      takeovers.push({ epoch: e!, seq: Number((await q(`SELECT nextval('$S.wseq') AS n`)).rows[0].n) });
      held.set(h, e);
      await new Promise((r) => setTimeout(r, 20));
    }
    stop = true;
    const stats = await Promise.all(writers);
    expect(stats.reduce((n, x) => n + x.ok, 0)).toBeGreaterThan(30);
    expect(stats.reduce((n, x) => n + x.refused, 0)).toBeGreaterThan(0);
    const rows = (await q(`SELECT epoch, seq FROM $S.w`)).rows.map((r) => ({ epoch: Number(r.epoch), seq: Number(r.seq) }));
    for (const tk of takeovers) expect(rows.filter((r) => r.epoch < tk.epoch && r.seq > tk.seq)).toEqual([]);
  }, 60_000);
});
```

Raw `pool.query` bypasses the store's `search_path` (G3), so `q()` schema-qualifies through `$S`.

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
add_pg_suite('src/host/pgLease.test.ts')
EOF
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/pgLease.test.ts`
Expected: FAIL, "Cannot find module './pgLease.js'".

- [ ] **Step 2: Implement the lease store and the fence**

`src/host/pgLease.ts`:

```ts
// host_lease on the host DB, and the fence every store write passes through.
// Expiry is judged on the DB's clock_timestamp(), never the pod's clock.
import { sql, type Kysely } from 'kysely';
import type { WriteHook } from '../main/store/postgres.js';
import type { HostDb } from './hostSchema.js';
import type { LeaseStore } from './lease.js';

const ms = (n: number) => sql`${n} * interval '1 millisecond'`;

/** `k` must be unfenced. clock_timestamp(), not now(): a statement that waited on the row lock judges expiry at grant time. */
export function postgresLeaseStore(k: Kysely<HostDb>, workspaceId: string): LeaseStore {
  return {
    async tryAcquire(holder, _now, ttlMs) {
      const r = await sql<{ epoch: number }>`
        INSERT INTO host_lease AS l (workspace_id, holder, epoch, expires_at)
          VALUES (${workspaceId}, ${holder}, 1, clock_timestamp() + ${ms(ttlMs)})
        ON CONFLICT (workspace_id) DO UPDATE
          SET holder = EXCLUDED.holder, epoch = l.epoch + 1, expires_at = clock_timestamp() + ${ms(ttlMs)}
          WHERE l.holder IS NULL OR l.holder = EXCLUDED.holder OR l.expires_at <= clock_timestamp()
        RETURNING epoch`.execute(k);
      return r.rows[0]?.epoch ?? null;
    },
    async renew(holder, epoch, _now, ttlMs) {
      const r = await sql`
        UPDATE host_lease SET expires_at = clock_timestamp() + ${ms(ttlMs)}
         WHERE workspace_id = ${workspaceId} AND holder = ${holder} AND epoch = ${epoch}`.execute(k);
      return r.numAffectedRows === 1n;
    },
    async release(holder, epoch) {
      await sql`
        UPDATE host_lease SET holder = NULL, expires_at = clock_timestamp()
         WHERE workspace_id = ${workspaceId} AND holder = ${holder} AND epoch = ${epoch}`.execute(k);
    }
  };
}

export class LeaseLostError extends Error {
  constructor(detail: string) {
    super(`lease lost: ${detail}`);
    this.name = 'LeaseLostError';
  }
}

export interface FenceTarget {
  workspaceId: string;
  holder: string;
  /** The epoch this process holds, or null when it holds none. */
  epoch(): number | null;
  onLost(err: LeaseLostError): void;
}

/** part 3's afterBeginWrite. FOR SHARE makes a takeover wait for in-flight fenced writes, and every write after it see the new epoch. */
export function leaseFence(t: FenceTarget): WriteHook {
  const lost = (detail: string): never => {
    const err = new LeaseLostError(detail);
    t.onLost(err);
    throw err;
  };
  return async (exec) => {
    const mine = t.epoch();
    if (mine === null) return lost('not the holder');
    const rows = (await exec(
      'SELECT holder, epoch, expires_at > clock_timestamp() AS live FROM host_lease WHERE workspace_id = $1 FOR SHARE',
      [t.workspaceId]
    )) as { holder: string | null; epoch: number; live: boolean }[];
    const row = rows[0];
    if (!row) return lost('no lease row');
    if (row.holder !== t.holder || Number(row.epoch) !== mine || !row.live) {
      lost(`epoch ${row.epoch}, held by ${row.holder === t.holder ? 'this process' : 'another'}${row.live ? '' : ', expired'}`);
    }
  };
}
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/pgLease.test.ts` three times.
Expected: PASS each time, 5 tests.

- [ ] **Step 3: Mutation-check the fence**

```bash
cp src/host/pgLease.ts /tmp/pgLease.ts.bak
sed -i "s/ WHERE workspace_id = \$1 FOR SHARE'/ WHERE workspace_id = \$1'/" src/host/pgLease.ts
grep -c 'FOR SHARE' src/host/pgLease.ts       # only the comment remains: 1
for i in 1 2 3; do CI=true npx vitest run -c vitest.pg.config.ts src/host/pgLease.test.ts | grep -E '×|Tests'; done
cp /tmp/pgLease.ts.bak src/host/pgLease.ts
```

Expected: each run fails at least one of the two concurrency tests.

- [ ] **Step 4: `LeaseManager.markLost()`**

Add to `src/host/lease.test.ts`, inside its top-level `describe`:

```ts
  it('markLost gives up a held lease and emits lost once', async () => {
    const m = new LeaseManager({ holder: 'h', store: memoryLeaseStore() });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    expect(m.state).toBe('holder');
    m.markLost();
    m.markLost();
    expect(m.state).toBe('standby');
    expect(lost).toHaveBeenCalledTimes(1);
    await m.stop();
  });
```

Run: `npx vitest run src/host/lease.test.ts` → FAIL, "m.markLost is not a function".

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/lease.ts', [
  ("""  private lose(): void {""", """  /** A fenced write found the lease row moved on: give up now, as a failed renew would. */
  markLost(): void {
    this.lose();
  }

  private lose(): void {""", 1),
])
EOF
```

Run: `npx vitest run src/host/lease.test.ts` → PASS.

- [ ] **Step 5: Holder-only stores**

`src/host/holder.ts`:

```ts
// What only the lease holder runs: the stores, fenced by the lease epoch.
import { closeDb } from '../main/db.js';
import { openPgStores, type PgStores } from '../main/store/pgStores.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import type { Logger } from './log.js';
import { leaseFence } from './pgLease.js';

export interface HolderOptions {
  db: PostgresStoreConfig;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  holder: string;
  epoch(): number | null;
  onLost(): void;
  log: Logger;
}

export interface Holder {
  stores: PgStores;
  stop(): Promise<void>;
}

export async function startHolder(o: HolderOptions): Promise<Holder> {
  const fence = leaseFence({
    workspaceId: o.workspaceId,
    holder: o.holder,
    epoch: o.epoch,
    onLost: (err) => {
      o.log.log('error', 'write fenced off; giving up the lease', { error: err.message });
      o.onLost();
    }
  });
  const stores = await openPgStores(o.db, {
    state: true,
    env: o.env,
    afterBeginWrite: fence,
    onPoolError: (e) => o.log.log('warn', 'store pool error', { error: e.message })
  });
  let stopping: Promise<void> | null = null;
  return {
    stores,
    stop() {
      stopping ??= (async () => {
        await stores.inbox.close();
        await closeDb();
        await stores.end();
      })();
      return stopping;
    }
  };
}
```

- [ ] **Step 6: Wire the lease and holder into `runHost`**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/main.ts', [
  ("""import { LeaseManager, memoryLeaseStore, type LeaseStore } from './lease.js';""",
   """import { startHolder, type Holder } from './holder.js';
import { LeaseManager, memoryLeaseStore, type LeaseStore } from './lease.js';
import { postgresLeaseStore } from './pgLease.js';""", 1),
  ("""  /** Defaults to memoryLeaseStore(), which is correct only for a single replica. */
  leaseStore?: LeaseStore;""", """  /** Defaults to the host DB's lease, or memoryLeaseStore() (single replica only) without db. */
  leaseStore?: LeaseStore;
  leaseRenewMs?: number;
  leaseTtlMs?: number;""", 1),
  ("""  const leaseMgr = new LeaseManager({
    holder: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    store: opts.leaseStore ?? memoryLeaseStore(),""", """  const holderId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const leaseMgr = new LeaseManager({
    holder: holderId,
    store: opts.leaseStore ?? (hostDb ? postgresLeaseStore(hostDb.k, workspaceId) : memoryLeaseStore()),
    renewMs: opts.leaseRenewMs,
    ttlMs: opts.leaseTtlMs,""", 1),
  ("""      server.halt(1001, 'host shutting down');
      await leaseMgr.stop();""", """      server.halt(1001, 'host shutting down');
      // Holder resources close while the lease still fences their last writes.
      const holder = await holderP;
      await holder?.stop().catch((err: Error) => log.log('warn', 'holder stop failed', { error: err.message }));
      await leaseMgr.stop();""", 1),
  ("""  leaseMgr.on('acquired', (epoch: number) => log.log('info', 'lease acquired', { epoch, workspaceId }));""",
   """  let holderP: Promise<Holder | null> | null = null;
  leaseMgr.on('acquired', (epoch: number) => {
    log.log('info', 'lease acquired', { epoch, workspaceId });
    const db = config.db;
    if (!db) return;
    holderP = startHolder({
      db,
      env: opts.env ?? process.env,
      workspaceId,
      holder: holderId,
      epoch: () => (leaseMgr.state === 'holder' ? leaseMgr.epoch : null),
      onLost: () => leaseMgr.markLost(),
      log
    }).catch((err: Error) => {
      log.log('error', 'holder start failed; giving up the lease', { error: err.message });
      leaseMgr.markLost();
      return null;
    });
  });""", 1),
])
EOF
```

`leaseMgr.on('acquired', …)` is registered before `leaseMgr.start()` (unchanged c1 order), so the first acquire is never missed.

- [ ] **Step 7: Write the two-host Postgres test**

`src/host/main.pg.test.ts`:

```ts
// Two fleet-host processes' worth of runHost on one schema. db.ts is a module
// singleton, so only one holder may have its stores open at a time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../main/db.js';
import { IdentityError, type IdentityProvider } from '../main/identity/types.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { runHost, type RunHostOptions } from './main.js';
import { fakeBroker, person, TOKEN } from './testFakes.js';

const ID = '01JC0000000000000000000000';
const verify: IdentityProvider['verify'] = async (t) => {
  if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad credentials', 401);
  return person('owner', 1, ['acme/platform']);
};

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.skipIf(!isPg)('runHost on Postgres', () => {
  let t: TestPg | null = null;
  const hosts: Awaited<ReturnType<typeof runHost>>[] = [];
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.shutdown(0);
    await t?.drop();
    t = null;
  });

  async function start(opts: Partial<RunHostOptions> = {}) {
    t ??= await testPgSchema();
    const dir = mkdtempSync(join(tmpdir(), 'fh-pg-'));
    const cfgPath = join(dir, 'config.yaml');
    const dbBlock = JSON.stringify({ connectionString: process.env.PG_TEST_URL, schema: t.schema, poolMax: 2 });
    writeFileSync(cfgPath, `workspace: { id: ${ID}, name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${dbBlock}\n`);
    const port = await freePort();
    const exit = vi.fn();
    const logs: string[] = [];
    const host = await runHost({
      env: { FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },
      exit, proc: new EventEmitter(), logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000,
      ...opts
    });
    hosts.push(host);
    return { url: `http://127.0.0.1:${port}`, host, exit, logs };
  }
  const leader = async (url: string) => (await fetch(`${url}/leader`)).status;
  const storesOpen = () => vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });

  it('one holder and one ready standby; the standby takes over after the holder stops', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200));
    await storesOpen();
    const b = await start();
    expect(await leader(b.url)).toBe(503);
    await vi.waitFor(async () => expect(await (await fetch(`${b.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'standby', db: 'ok' }));
    await a.host.shutdown(0);
    await vi.waitFor(async () => expect(await leader(b.url)).toBe(200), { timeout: 5_000 });
    await storesOpen();
    const row = await t!.pool.query(`SELECT holder, epoch FROM ${t!.schema}.host_lease`);
    expect(row.rows[0].epoch).toBe(2);
    await db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' });
  }, 30_000);

  it('a stale holder’s store write fails and the process exits 1', async () => {
    const a = await start({ leaseRenewMs: 10_000, leaseTtlMs: 30_000 });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200));
    await storesOpen();
    await db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' });
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET holder = 'intruder', epoch = epoch + 1, expires_at = clock_timestamp() + interval '1 minute'`);
    await expect(db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' })).rejects.toThrow(/lease lost/);
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(1));
    expect(a.logs.join('\n')).toMatch(/write fenced off/);
  }, 30_000);
});
```

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
add_pg_suite('src/host/main.pg.test.ts')
EOF
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/main.pg.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Run the gates**

Run the three gate commands and `npm run build:host`.
Expected: PASS; tsc exit 0; the bundle builds (its graph now reaches `db.ts`, through the `better-sqlite3` alias).

- [ ] **Step 9: Commit**

```bash
git add src/host/pgLease.ts src/host/pgLease.test.ts src/host/holder.ts src/host/main.pg.test.ts src/host/lease.ts src/host/lease.test.ts src/host/main.ts vitest.pg.config.ts
git commit -m "feat(host): Postgres host_lease with an epoch fence on every store write; stores open only on the holder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The workspace id in `host_meta`, and the file reconciled from it

**Files:**
- Create: `src/host/hostState.pg.test.ts`
- Modify: `src/host/hostState.ts`, `src/host/main.ts`, `src/host/cli.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: Task 3's `HostDb`, `HOST_TRACK`, `openHostDb`.
- Produces:
  - `readWorkspaceIdFile(stateDir): Promise<string | null>`; `writeWorkspaceIdFile(stateDir, id): Promise<void>`
  - `resolveHostWorkspaceId(k: Kysely<HostDb>, stateDir, configuredId: string | null, log: Logger, mint?): Promise<string>`

- [ ] **Step 1: Write the failing tests**

`src/host/hostState.pg.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { resolveHostWorkspaceId, WORKSPACE_ID_FILE } from './hostState.js';
import { createLogger } from './log.js';

const A = '01JC0000000000000000000000';
const B = '01JC0000000000000000000001';
const C = '01JC0000000000000000000002';

describe.skipIf(!isPg)('resolveHostWorkspaceId', () => {
  let t: TestPg | null = null;
  afterEach(async () => {
    await t?.drop();
    t = null;
  });

  async function rig() {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    const dir = mkdtempSync(join(tmpdir(), 'hs-'));
    const logs: string[] = [];
    return { k, dir, logs, log: createLogger((l) => logs.push(l)) };
  }
  const fileId = (dir: string) => JSON.parse(readFileSync(join(dir, WORKSPACE_ID_FILE), 'utf8')).id;
  const putFile = (dir: string, id: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKSPACE_ID_FILE), JSON.stringify({ id, createdAt: 1 }) + '\n');
  };

  it('seeds from config, and writes the file', async () => {
    const { k, dir, log } = await rig();
    expect(await resolveHostWorkspaceId(k, dir, A, log, () => C)).toBe(A);
    expect(fileId(dir)).toBe(A);
  });

  it('adopts the c1 file’s id when config has none', async () => {
    const { k, dir, log } = await rig();
    putFile(dir, B);
    expect(await resolveHostWorkspaceId(k, dir, null, log, () => C)).toBe(B);
  });

  it('mints when there is neither, and the row then wins over a later config-less start', async () => {
    const { k, dir, log } = await rig();
    expect(await resolveHostWorkspaceId(k, dir, null, log, () => C)).toBe(C);
    expect(await resolveHostWorkspaceId(k, dir, null, log, () => A)).toBe(C);
  });

  it('refuses a configured id that differs from the row, naming both', async () => {
    const { k, dir, log } = await rig();
    await resolveHostWorkspaceId(k, dir, A, log);
    await expect(resolveHostWorkspaceId(k, dir, B, log)).rejects.toThrow(new RegExp(`${A}.*${B}`));
  });

  it('rewrites a file that disagrees with the row, with a warning', async () => {
    const { k, dir, log, logs } = await rig();
    await resolveHostWorkspaceId(k, dir, A, log);
    putFile(dir, B);
    expect(await resolveHostWorkspaceId(k, dir, null, log)).toBe(A);
    expect(fileId(dir)).toBe(A);
    expect(logs.join('\n')).toMatch(/workspace-id.json differs from host_meta/);
  });

  it('two pods seeding at once agree on one id', async () => {
    const { k, dir, log } = await rig();
    const k2: Kysely<HostDb> = postgresKysely<HostDb>(t!.pool);
    const [x, y] = await Promise.all([
      resolveHostWorkspaceId(k, join(dir, 'p1'), null, log, () => A),
      resolveHostWorkspaceId(k2, join(dir, 'p2'), null, log, () => B)
    ]);
    expect(x).toBe(y);
  });
});
```

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
add_pg_suite('src/host/hostState.pg.test.ts')
EOF
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/hostState.pg.test.ts`
Expected: FAIL, "resolveHostWorkspaceId is not a function" (or a missing export).

- [ ] **Step 2: Implement**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/hostState.ts', [
  ("""import { link, mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';""",
   """import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';""", 1),
  ("""import { ULID_RE } from './config.js';""", """import type { Kysely } from 'kysely';
import { ULID_RE } from './config.js';
import type { HostDb } from './hostSchema.js';
import type { Logger } from './log.js';""", 1),
])
s = open('src/host/hostState.ts').read()
s += '''
export function readWorkspaceIdFile(stateDir: string): Promise<string | null> {
  return readId(join(stateDir, WORKSPACE_ID_FILE));
}

/** Replaces the file atomically (temp file, fsync, rename). */
export async function writeWorkspaceIdFile(stateDir: string, id: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, `${TMP_PREFIX}${randomUUID()}`);
  await writeDurably(tmp, JSON.stringify({ id, createdAt: Date.now() }) + '\\n');
  try {
    await rename(tmp, join(stateDir, WORKSPACE_ID_FILE));
    await syncDir(stateDir);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * With a host DB, host_meta is authoritative. An empty table is seeded from
 * config workspace.id, else the c1 file, else a new ULID; the file is then
 * rewritten from the row so `fleet-host init` and older tooling agree.
 */
export async function resolveHostWorkspaceId(
  k: Kysely<HostDb>,
  stateDir: string,
  configuredId: string | null,
  log: Logger,
  mint: () => string = ulid
): Promise<string> {
  const read = async () => (await k.selectFrom('host_meta').select('workspace_id').executeTakeFirst())?.workspace_id ?? null;
  let id = await read();
  if (!id) {
    const fromFile = configuredId ? null : await readWorkspaceIdFile(stateDir).catch(() => null);
    await k
      .insertInto('host_meta')
      .values({ singleton: true, workspace_id: configuredId ?? fromFile ?? mint(), created_at: Date.now() })
      .onConflict((oc) => oc.column('singleton').doNothing())
      .execute();
    id = await read();
    if (!id) throw new Error('host_meta is empty after seeding');
    log.log('info', 'workspace id seeded', { workspaceId: id, from: configuredId ? 'config' : fromFile ? 'file' : 'minted' });
  }
  if (configuredId && id !== configuredId) {
    throw new Error(`host_meta holds workspace id ${id} but config workspace.id is ${configuredId}; refusing to start`);
  }
  const file = await readWorkspaceIdFile(stateDir).catch(() => undefined);
  if (file !== id) {
    if (file) log.log('warn', 'workspace-id.json differs from host_meta; rewriting it', { file, workspaceId: id });
    await writeWorkspaceIdFile(stateDir, id);
  }
  return id;
}
'''
open('src/host/hostState.ts', 'w').write(s)
EOF
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/hostState.pg.test.ts && npx vitest run src/host/hostState.test.ts`
Expected: PASS (6 Postgres tests; the c1 file tests unchanged).

- [ ] **Step 3: Use it in `runHost` and `fleet-host init`**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/main.ts', [
  ("""import { resolveWorkspaceId } from './hostState.js';""", """import { resolveHostWorkspaceId, resolveWorkspaceId } from './hostState.js';""", 1),
  ("""  const workspaceId = await resolveWorkspaceId(env.stateDir, config.workspace.id);
""", """  const workspaceId = hostDb
    ? await resolveHostWorkspaceId(hostDb.k, env.stateDir, config.workspace.id, log)
    : await resolveWorkspaceId(env.stateDir, config.workspace.id);
""", 1),
])
EOF
```

Replace `src/host/cli.ts` with:

```ts
// Bundle entry. `fleet-host init` resolves (or mints) the workspace id and exits.
import { existsSync } from 'node:fs';
import { loadHostConfig, readHostEnv } from './config.js';
import { openHostDb } from './hostDb.js';
import { resolveHostWorkspaceId, resolveWorkspaceId } from './hostState.js';
import { createLogger, redactSecrets } from './log.js';
import { runHost } from './main.js';

async function init(): Promise<string> {
  const env = readHostEnv(process.env);
  // Honour a configured workspace.id so init can't mint one the server would then refuse.
  const config = existsSync(env.configPath) ? await loadHostConfig(env.configPath) : null;
  const configured = config?.workspace.id ?? null;
  if (!config?.db) return resolveWorkspaceId(env.stateDir, configured);
  const log = createLogger((l) => process.stderr.write(l + '\n'));
  const db = await openHostDb(config.db, { log });
  try {
    return await resolveHostWorkspaceId(db.k, env.stateDir, configured, log);
  } finally {
    await db.end();
  }
}

async function cli(argv: string[]): Promise<void> {
  if (argv[0] === 'init') {
    process.stdout.write(JSON.stringify({ workspaceId: await init() }) + '\n');
    return;
  }
  await runHost();
}

cli(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(JSON.stringify({ level: 'error', msg: 'fleet-host failed to start', error: redactSecrets(err.message) }) + '\n');
  process.exit(1);
});
```

Add a check to `src/host/main.pg.test.ts` (inside the `describe`):

```ts
  it('serves the id from host_meta and keeps the state file in step', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200));
    const meta = await t!.pool.query(`SELECT workspace_id FROM ${t!.schema}.host_meta`);
    expect(meta.rows).toEqual([{ workspace_id: ID }]);
  }, 30_000);
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/main.pg.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 4: Run the gates**

Run the three gate commands.
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host/hostState.ts src/host/hostState.pg.test.ts src/host/main.ts src/host/main.pg.test.ts src/host/cli.ts vitest.pg.config.ts
git commit -m "feat(host): workspace id in host_meta, seeded from config or the c1 file; file reconciled from the row

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Ingest of the host's own transcripts

**Files:**
- Create: `src/main/state/transcriptPaths.ts`, `src/host/hostIngest.ts`, `src/host/hostIngest.test.ts`
- Modify: `src/main/jsonlWatcher.ts`, `src/host/holder.ts`, `src/host/config.ts` (`projectsDir`), `src/host/config.test.ts`, `src/host/main.ts`, `src/host/main.pg.test.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `ingestBatch(workspaceId, sessionId, lines)` (`db.ts`); `keyedSerialQueue` (`state/serialQueue.ts`); Task 3's `HostDb`; Task 4's `leaseFence`, `startHolder`.
- Produces:
  - `parseTranscriptFilename`, `parseSubagentPath` in `src/main/state/transcriptPaths.ts` (still re-exported by `jsonlWatcher.ts`)
  - `class HostIngest { start(); scan(); stop() }`, `HostIngestOptions { projectsDir; workspaceId; offsets: Kysely<HostDb>; log; ingest?; rescanMs? }`, `RESCAN_MS`, `MAX_READ_BYTES`
  - `HostEnv.projectsDir` (`FLEET_HOST_PROJECTS`, default `~/.claude/projects`); `HolderOptions.projectsDir`

- [ ] **Step 1: Move the path parsers out of `jsonlWatcher.ts`**

`jsonlWatcher.ts` reaches `electron` through `paths.ts`, so the host can't import it.

```bash
python3 - <<'EOF'
p = 'src/main/jsonlWatcher.ts'
s = open(p).read()
start = s.index('const UUID_RE =')
end_marker = '  return { sessionId: stem, sidecar };\n}\n'
end = s.index(end_marker) + len(end_marker)
block = s[start:end]
assert 'export function parseSubagentPath' in block and 'export function parseTranscriptFilename' in block
s = s[:start] + "export { parseSubagentPath, parseTranscriptFilename };\n" + s[end:]
s = s.replace("import { join, basename, extname, sep as pathSep } from 'node:path';", "import { join, extname, sep as pathSep } from 'node:path';", 1)
s = s.replace("import { keyedSerialQueue } from './state/serialQueue.js';", "import { keyedSerialQueue } from './state/serialQueue.js';\nimport { parseSubagentPath, parseTranscriptFilename } from './state/transcriptPaths.js';", 1)
open(p, 'w').write(s)
open('src/main/state/transcriptPaths.ts', 'w').write(
    "// Transcript path → session id, shared by the desktop watcher and fleet-host ingest.\n"
    "import { basename, extname } from 'node:path';\n\n" + block)
EOF
npx vitest run src/main/jsonlWatcher.test.ts src/main/jsonlWatcher.subagent.test.ts
```

Expected: PASS (the parsers' tests import them from `jsonlWatcher.js`, which re-exports).

- [ ] **Step 2: Add `projectsDir` to the env contract**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/config.ts', [
  ("""import { readFile } from 'node:fs/promises';""", """import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';""", 1),
  ("""  credSocket: string;
}""", """  credSocket: string;
  /** Claude's transcripts in this container, ingested by the holder. */
  projectsDir: string;
}""", 1),
  ("""    credSocket: env.FLEET_HOST_CRED_SOCKET || '/run/fleet-host/cred.sock'
  };""", """    credSocket: env.FLEET_HOST_CRED_SOCKET || '/run/fleet-host/cred.sock',
    projectsDir: env.FLEET_HOST_PROJECTS || join(homedir(), '.claude', 'projects')
  };""", 1),
])
edit('src/host/config.test.ts', [
  ("""import { tmpdir } from 'node:os';""", """import { homedir, tmpdir } from 'node:os';""", 1),
  ("""      credSocket: '/run/fleet-host/cred.sock',""", """      credSocket: '/run/fleet-host/cred.sock',
      projectsDir: join(homedir(), '.claude', 'projects'),""", 1),
])
EOF
npx vitest run src/host/config.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write the failing ingest tests**

`src/host/hostIngest.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import * as db from '../main/db.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, openTestState, queryRows } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { HostIngest } from './hostIngest.js';
import { createLogger } from './log.js';
import { LeaseLostError } from './pgLease.js';

const WS = '01JC0000000000000000000000';
const S1 = '11111111-1111-4111-8111-111111111111';
const line = (uuid: string) =>
  JSON.stringify({ type: 'user', uuid, sessionId: S1, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: `hi ${uuid}` } }) + '\n';

describe.skipIf(!isPg)('HostIngest', () => {
  const running: HostIngest[] = [];
  afterEach(async () => {
    for (const h of running.splice(0)) await h.stop();
  });

  async function rig() {
    const st = await openTestState();
    const offsets = postgresKysely<HostDb>(st.pg!.pool);
    await migratePostgres(offsets, st.pg!.schema, HOST_TRACK);
    const projects = mkdtempSync(join(tmpdir(), 'proj-'));
    mkdirSync(join(projects, '-workspace'));
    const logs: string[] = [];
    const make = (o: { ingest?: typeof db.ingestBatch; offsets?: Kysely<HostDb> } = {}) => {
      const h = new HostIngest({ projectsDir: projects, workspaceId: WS, offsets: o.offsets ?? offsets, log: createLogger((l) => logs.push(l)), ingest: o.ingest, rescanMs: 3_600_000 });
      running.push(h);
      return h;
    };
    return { st, offsets, projects, logs, make, file: join(projects, '-workspace', `${S1}.jsonl`) };
  }
  const events = async (where = 'workspace_id = ?', params: unknown[] = [WS]) =>
    Number((await queryRows<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, params))[0].n);

  it('ingests complete lines under the hosted workspace and keeps a partial line for later', async () => {
    const { make, file } = await rig();
    const c = line('c');
    writeFileSync(file, line('a') + line('b') + c.slice(0, 20));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(2);
    appendFileSync(file, c.slice(20));
    await h.scan();
    expect(await events()).toBe(3);
  });

  it('resumes from persisted offsets after a restart instead of re-reading', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a') + line('b'));
    const first = make();
    await first.start();
    await first.scan();
    await first.stop();
    const spy = vi.fn(db.ingestBatch);
    const second = make({ ingest: spy });
    await second.start();
    await second.scan();
    expect(spy).not.toHaveBeenCalled();
    appendFileSync(file, line('c'));
    await second.scan();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toHaveLength(1);
  });

  it('re-reads a file that shrank (compaction) without duplicating rows', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a') + line('b'));
    const h = make();
    await h.start();
    await h.scan();
    writeFileSync(file, line('d'));
    await h.scan();
    expect(await events()).toBe(3);
  });

  it('attributes a subagent transcript to its parent session', async () => {
    const { make, projects } = await rig();
    const sub = join(projects, '-workspace', S1, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-x.jsonl'), line('s'));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events('session_id = ?', [S1])).toBe(1);
  });

  it('picks up an append from the directory watch, without a scan call', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a'));
    const h = make();
    await h.start();
    await h.scan();
    appendFileSync(file, line('b'));
    await vi.waitFor(async () => expect(await events()).toBe(2), { timeout: 5_000 });
  });

  it('a fenced-off offset write stops that file and is logged', async () => {
    const { make, file, st, logs } = await rig();
    writeFileSync(file, line('a'));
    const fencedOff = postgresKysely<HostDb>(st.pg!.pool, { afterBeginWrite: async () => { throw new LeaseLostError('test'); } });
    const h = make({ offsets: fencedOff });
    await h.start();
    await h.scan();
    expect(logs.join('\n')).toMatch(/transcript ingest failed.*lease lost/);
  });
});
```

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
add_pg_suite('src/host/hostIngest.test.ts')
EOF
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts`
Expected: FAIL, "Cannot find module './hostIngest.js'".

- [ ] **Step 4: Implement ingest**

`src/host/hostIngest.ts`:

```ts
// Ingest of this container's own transcripts into the host store (holder only).
// Offsets persist in host_ingest_offsets, so a restart resumes instead of
// re-reading every transcript on shared storage.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { ingestBatch } from '../main/db.js';
import { keyedSerialQueue, type KeyedSerialQueue } from '../main/state/serialQueue.js';
import { parseSubagentPath, parseTranscriptFilename } from '../main/state/transcriptPaths.js';
import type { HostDb } from './hostSchema.js';
import type { Logger } from './log.js';

export const RESCAN_MS = 60_000;
/** One read's bound; a larger delta is ingested over several reads. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface HostIngestOptions {
  projectsDir: string;
  workspaceId: string;
  /** Fenced: offsets are written only while this process holds the lease. */
  offsets: Kysely<HostDb>;
  log: Logger;
  ingest?: typeof ingestBatch;
  rescanMs?: number;
}

export class HostIngest {
  private readonly done = new Map<string, number>();
  private readonly queue: KeyedSerialQueue;
  private readonly ingest: typeof ingestBatch;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly o: HostIngestOptions) {
    this.ingest = o.ingest ?? ingestBatch;
    this.queue = keyedSerialQueue((path, err) => o.log.log('warn', 'transcript ingest failed', { path, error: (err as Error).message }));
  }

  /** Loads offsets and starts watching; the first full scan runs in the background. */
  async start(): Promise<void> {
    const rows = await this.o.offsets.selectFrom('host_ingest_offsets').select(['path', 'byte_offset']).orderBy('path').execute();
    for (const r of rows) this.done.set(r.path, r.byte_offset);
    await mkdir(this.o.projectsDir, { recursive: true });
    try {
      // Writers are local processes, so inotify fires even on an NFS mount.
      this.watcher = watch(this.o.projectsDir, { recursive: true }, (_event, name) => {
        if (name?.endsWith('.jsonl')) void this.enqueue(join(this.o.projectsDir, name));
      });
      this.watcher.on('error', (err) => this.o.log.log('warn', 'transcript watch failed; rescans continue', { error: err.message }));
    } catch (err) {
      this.o.log.log('warn', 'transcript watch unavailable; rescans only', { error: (err as Error).message });
    }
    this.timer = setInterval(() => void this.scan(), this.o.rescanMs ?? RESCAN_MS);
    this.timer.unref();
    void this.scan();
  }

  /** Enqueues every transcript and subagent transcript, and waits for them. */
  async scan(): Promise<void> {
    const files: string[] = [];
    for (const proj of await readdir(this.o.projectsDir, { withFileTypes: true }).catch(() => [])) {
      if (!proj.isDirectory()) continue;
      const pdir = join(this.o.projectsDir, proj.name);
      for (const e of await readdir(pdir, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(pdir, e.name));
        else if (e.isDirectory()) {
          const sub = join(pdir, e.name, 'subagents');
          for (const f of await readdir(sub).catch(() => [] as string[])) if (f.endsWith('.jsonl')) files.push(join(sub, f));
        }
      }
    }
    await Promise.all(files.map((f) => this.enqueue(f)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    await this.queue.drain();
  }

  private enqueue(path: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.queue.enqueue(path, () => this.process(path));
  }

  private async process(path: string): Promise<void> {
    if (this.stopped) return;
    const sessionId = parseSubagentPath(path)?.parentSessionId ?? parseTranscriptFilename(path)?.sessionId;
    if (!sessionId) return;
    const size = (await stat(path).catch(() => null))?.size;
    if (size === undefined) return;
    let offset = this.done.get(path) ?? 0;
    // Shrunk (compaction): re-read; dedup keys keep existing rows.
    if (size < offset) offset = 0;
    while (offset < size && !this.stopped) {
      const next = await this.readFrom(path, offset, size, sessionId);
      if (next === offset) break;
      offset = next;
      const at = Date.now();
      await this.o.offsets
        .insertInto('host_ingest_offsets')
        .values({ path, byte_offset: offset, updated_at: at })
        .onConflict((oc) => oc.column('path').doUpdateSet({ byte_offset: offset, updated_at: at }))
        .execute();
      this.done.set(path, offset);
    }
  }

  /** Ingests the complete lines from `offset`; returns the offset after the last one. */
  private async readFrom(path: string, offset: number, size: number, sessionId: string): Promise<number> {
    const fh = await open(path, 'r');
    try {
      let want = Math.min(size - offset, MAX_READ_BYTES);
      let buf = Buffer.alloc(want);
      let { bytesRead } = await fh.read(buf, 0, want, offset);
      let lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNl === -1 && want < size - offset) {
        // One line longer than the bound: read the rest in one go.
        want = size - offset;
        buf = Buffer.alloc(want);
        ({ bytesRead } = await fh.read(buf, 0, want, offset));
        lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      }
      if (lastNl === -1) return offset;
      const lines = buf.subarray(0, lastNl + 1).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) await this.ingest(this.o.workspaceId, sessionId, lines);
      return offset + lastNl + 1;
    } finally {
      await fh.close();
    }
  }
}
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Start ingest on the holder**

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/holder.ts', [
  ("""// What only the lease holder runs: the stores, fenced by the lease epoch.
import { closeDb } from '../main/db.js';""", """// What only the lease holder runs: the stores, fenced by the lease epoch, and ingest.
import { closeDb } from '../main/db.js';
import { postgresKysely } from '../main/store/postgres.js';""", 1),
  ("""import type { Logger } from './log.js';""", """import { HostIngest } from './hostIngest.js';
import type { HostDb } from './hostSchema.js';
import type { Logger } from './log.js';""", 1),
  ("""  onLost(): void;
  log: Logger;
}""", """  onLost(): void;
  log: Logger;
  projectsDir: string;
}""", 1),
  ("""  let stopping: Promise<void> | null = null;
  return {
    stores,
    stop() {
      stopping ??= (async () => {
        await stores.inbox.close();""", """  const offsets = postgresKysely<HostDb>(stores.pool, { afterBeginWrite: fence });
  const ingest = new HostIngest({ projectsDir: o.projectsDir, workspaceId: o.workspaceId, offsets, log: o.log });
  const close = async () => {
    await offsets.destroy();
    await stores.inbox.close();
    await closeDb();
    await stores.end();
  };
  try {
    await ingest.start();
  } catch (err) {
    await close();
    throw err;
  }
  let stopping: Promise<void> | null = null;
  return {
    stores,
    stop() {
      stopping ??= (async () => {
        await ingest.stop();
        await offsets.destroy();
        await stores.inbox.close();""", 1),
])
edit('src/host/main.ts', [
  ("""      onLost: () => leaseMgr.markLost(),
      log
    }).catch""", """      onLost: () => leaseMgr.markLost(),
      log,
      projectsDir: env.projectsDir
    }).catch""", 1),
])
edit('src/host/main.pg.test.ts', [
  ("""CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },""", """CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'), FLEET_HOST_PROJECTS: join(dir, 'projects') },""", 1),
])
EOF
```

`postgresKysely`'s `destroy()` leaves the shared pool open (part 3), so `offsets.destroy()` before `stores.end()` is safe.

Add an end-to-end check to `src/host/main.pg.test.ts` (inside the `describe`; `projects` is derived from the same `FLEET_HOST_PROJECTS`, so `start()` must return `dir`: add `dir` to its returned object):

```ts
  it('the holder ingests transcripts written in its container', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200));
    await storesOpen();
    const sid = '22222222-2222-4222-8222-222222222222';
    const proj = join(a.dir, 'projects', '-workspace');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${sid}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u1', sessionId: sid, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n');
    await vi.waitFor(async () => {
      const r = await t!.pool.query(`SELECT COUNT(*)::int AS n FROM ${t!.schema}.events WHERE workspace_id = $1 AND session_id = $2`, [ID, sid]);
      expect(r.rows[0].n).toBe(1);
    }, { timeout: 10_000 });
  }, 30_000);
```

with these two edits to the test file:

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('src/host/main.pg.test.ts', [
  ("""import { mkdtempSync, writeFileSync } from 'node:fs';""", """import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';""", 1),
  ("""    return { url: `http://127.0.0.1:${port}`, host, exit, logs };""", """    return { url: `http://127.0.0.1:${port}`, host, exit, logs, dir };""", 1),
])
EOF
```

Run: `CI=true npx vitest run -c vitest.pg.config.ts src/host/main.pg.test.ts src/host/hostIngest.test.ts`
Expected: PASS (4 + 6 tests).

- [ ] **Step 6: Run the gates**

Run the three gate commands and `npm run build:host`.
Expected: PASS; tsc exit 0; the bundle builds.

- [ ] **Step 7: Commit**

```bash
git add src/main/state/transcriptPaths.ts src/main/jsonlWatcher.ts src/host/hostIngest.ts src/host/hostIngest.test.ts src/host/holder.ts \
  src/host/config.ts src/host/config.test.ts src/host/main.ts src/host/main.pg.test.ts vitest.pg.config.ts
git commit -m "feat(host): holder-only ingest of the container's transcripts with persisted offsets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: SPEC.md, the image smoke, and the PR

**Files:**
- Modify: `docs/SPEC.md`

**Interfaces:**
- Consumes: everything above.
- Produces: SPEC §4 *Host images*, §7 *Remote host* (env, config, workspace id, lease, *Host store*, *Ingest*, *GitHub App credentials*), §9 (the App helper's limits), §11 *Remote host automations* (replacing *Remote host DB*).

- [ ] **Step 1: Apply the SPEC edits**

Each `old` string was checked against `docs/SPEC.md` at `origin/main` 0767e75.

```bash
python3 - <<'EOF'
exec(open('/tmp/c3_edit.py').read())
edit('docs/SPEC.md', [
  ("""- `/usr/local/lib/fleet-host/fleet-host.mjs` is one Vite-bundled ESM file for plain Node 22 (`vite.host.config.ts`, `npm run build:host`), so the image has no `node_modules`. A build stage runs `npm ci --ignore-scripts` and the bundle.""",
   """- `/usr/local/lib/fleet-host/` holds the Vite bundle for plain Node 22 (`vite.host.config.ts`, `npm run build:host`): two entries, `fleet-host.mjs` and `fleet-host-cred.mjs`, plus shared and lazily loaded chunks under `chunks/` (the AWS SDK's credential providers), so the image has no `node_modules`. `better-sqlite3` is aliased to a stub that throws (`src/host/sqliteStub.ts`): the host store is Postgres only. A build stage runs `npm ci --ignore-scripts` and the bundle.""", 1),
  ("""- `/usr/local/bin/fleet-host` wraps it (`fleet-host init`); `/usr/local/bin/fleet-host-entry` is the `CMD`, run by the base's tini.""",
   """- `/usr/local/bin/fleet-host` wraps it (`fleet-host init`); `/usr/local/bin/fleet-host-entry` is the `CMD`, run by the base's tini. `/usr/local/bin/fleet-host-cred` wraps the credential client (§7 *Remote host*, *GitHub App credentials*). `/etc/gitconfig` sets `credential.https://github.com.helper` to `!fleet-host-cred git-credential` with `useHttpPath = true`; `/usr/local/lib/fleet-host/bin/gh` is a `gh` shim first on `PATH` that exports a scoped `GH_TOKEN` and execs `/usr/local/bin/gh`. `/run/fleet-host` (0700, `fleet`) holds the credential socket.""", 1),
  ("""- Env defaults: `FLEET_HOST_PORT=8080`, `FLEET_HOST_CONFIG=/etc/fleet-host/config.yaml`, `FLEET_HOST_STATE=/home/fleet/.claude/fleet-host`; uid/gid 1000 (`fleet`).""",
   """- Env defaults: `PATH=/usr/local/lib/fleet-host/bin:$PATH`, `FLEET_HOST_PORT=8080`, `FLEET_HOST_CONFIG=/etc/fleet-host/config.yaml`, `FLEET_HOST_STATE=/home/fleet/.claude/fleet-host`; uid/gid 1000 (`fleet`).""", 1),
  ("""It runs no scheduler and no ingest and has no DB yet (§11 *Remote host DB*).""",
   """With a `db:` block it keeps its lease, identity and ingested history in Postgres (*Host store*, below); it runs no scheduler yet (§11 *Remote host automations*).""", 1),
  ("""| `CLAUDE_FLEET_BROKER_SOCKET` | `/run/broker/broker.sock` | the in-pod broker |""",
   """| `CLAUDE_FLEET_BROKER_SOCKET` | `/run/broker/broker.sock` | the in-pod broker |
| `FLEET_HOST_PROJECTS` | `~/.claude/projects` | transcripts the holder ingests |
| `FLEET_HOST_CRED_SOCKET` | `/run/fleet-host/cred.sock` | App credential socket |
| `FLEET_HOST_GITHUB_APP_ID`, `FLEET_HOST_GITHUB_INSTALLATION_ID`, `FLEET_HOST_GITHUB_APP_KEY_FILE` | unset | the App credential helper: all three or none (a partial set refuses start); the key is a **path** to a PEM mounted from a Secret (0400, uid 1000), never the PEM itself |""", 1),
  ("""- `trustedProxyHops` (integer 0–10, default 0).""",
   """- `db` (optional): part 3's Postgres store config without `kind` (§6 *Settings* `store`): `{ connectionString | env | host, port?, database, user, password: { kind: static | env | aws-rds-iam, … }, ssl?, caFile?, schema?, poolMax? }`, static secrets allowed (the config is a mounted secret). On AWS: the writer endpoint as `host`, `database: fleet`, `user: fleet_agent`, `password: { kind: aws-rds-iam, region }`; `ssl` defaults to `verify-full` with the image's RDS bundle. Absent: a process-local lease and no ingest (one replica only), with a startup warning.
- `github` (optional): `{ repositories?: string[], permissions?: { <name>: read | write } }`, limits on App tokens (*GitHub App credentials*).
- `trustedProxyHops` (integer 0–10, default 0).""", 1),
  ("""or whose `workspace.id` differs from the running one (including set ↔ unset), is refused""",
   """or whose `workspace.id` (including set ↔ unset) or `db` differs from the running one, is refused""", 1),
])
edit('docs/SPEC.md', [
  ("""**Workspace id.** A configured `workspace.id` is authoritative. Without one, a ULID is minted once into `$FLEET_HOST_STATE/workspace-id.json` (written, fsynced, then `link()`ed so concurrent pods agree). A state file holding a different id than the config refuses start. `fleet-host init` resolves the id the same way and prints `{"workspaceId": …}`.""",
   """**Workspace id.** With `db:`, `host_meta` (one row) is authoritative. An empty table is seeded from config `workspace.id`, else `$FLEET_HOST_STATE/workspace-id.json`, else a new ULID (`INSERT … ON CONFLICT DO NOTHING`, then re-read, so concurrent pods agree). A configured `workspace.id` that differs from the row refuses start, naming both. The state file is then rewritten from the row (temp file + `rename`), with a warning if it differed. Without `db:`, a configured `workspace.id` is authoritative; otherwise a ULID is minted once into the state file (written, fsynced, then `link()`ed so concurrent pods agree), and a state file holding a different id than the config refuses start. `fleet-host init` resolves the id the same way and prints `{"workspaceId": …}`.""", 1),
  ("""**Lease and standby.** The lease is a `LeaseStore` seam (`lease.ts`); c1 ships `memoryLeaseStore()`, correct only for one replica. The holder renews every 10 s with a 30 s TTL, fenced by epoch; a store call is raced against the remaining validity.""",
   """**Lease and standby.** The lease is a `LeaseStore` seam (`lease.ts`). With `db:` it is `host_lease(workspace_id PK, holder, epoch, expires_at)` (`pgLease.ts`): one statement per operation, expiry judged on the DB's `clock_timestamp()` (not `now()`, the statement start, which is stale after a row-lock wait); `tryAcquire` takes a free, expired or own row and bumps `epoch`. Without `db:` it is `memoryLeaseStore()`, correct only for one replica. The holder renews every 10 s with a 30 s TTL; a store call is raced against the remaining validity.""", 1),
  ("""`/healthz` is 200 `{status:"ok", lease}` while the lease loop runs, holder or standby; `/leader` is 200 only on the holder. Losing the lease shuts the process down with exit 1.""",
   """`/healthz` is 200 `{status:"ok", lease, db}` while the lease loop runs and, with `db:`, the last DB ping (every 5 s, 3 s timeout) succeeded within 15 s, holder or standby; otherwise 503 `{status:"unhealthy", …}`. `db` is `ok`, `down` or `none`. Use it for readiness, not liveness: a DB outage makes the pod unready. `/leader` is 200 only on the holder. Losing the lease shuts the process down with exit 1.

**Host store** (`db:`). Two pools on the one schema (`fleet`; it and pgvector must exist, the store never creates them):
- **Host pool** (`hostDb.ts`, max 2, opened at start by holder and standby alike): the `host` migration track (`host_meta`, `host_lease`, `host_ingest_offsets`, beside part 3's `state` and `inbox` tracks in `schema_migrations`), the lease and the health ping, on an unfenced Kysely handle. Opening retries with backoff (1 s doubling to 30 s), logging each failure with the IAM hint, so a DB blip during a restart doesn't crash-loop the container; an invalid `db:` block fails at once.
- **Store pool** (`holder.ts`, holder only): `openPgStores(cfg, { state: true, afterBeginWrite: fence })`, opened after the lease is acquired, so `state`/`inbox` migrations also run as the holder. Closed (ingest drained first) before the lease is released on shutdown.
- **The fence** (`leaseFence`, part 3's `afterBeginWrite`): the first statement of every read-write transaction and around every bare write is `SELECT holder, epoch, expires_at > clock_timestamp() AS live FROM host_lease WHERE workspace_id = $1 FOR SHARE`. Another holder, another epoch, an expired or missing row, or no local epoch throws `LeaseLostError` (rolling the transaction back) and calls `LeaseManager.markLost()`, which shuts down with exit 1. `FOR SHARE` makes a takeover's row lock wait for in-flight fenced writes, and every write after it sees the new epoch; the holder's own renew also waits behind an in-flight write transaction.
- All host SQL goes through `postgresKysely` handles: a bare `pool.query()` skips the per-connection `SET search_path`.
- `db` can't change on reload (refused like `workspace.id`).

**Ingest** (`hostIngest.ts`, holder only). Every `*.jsonl` under `$FLEET_HOST_PROJECTS/*/` and `*/<session>/subagents/` is ingested with `ingestBatch` under the hosted workspace id (subagent files under the parent session). Changes come from a recursive `fs.watch` (writers are local, so inotify fires on EFS too) plus a full rescan every 60 s. Per-file byte offsets persist in `host_ingest_offsets`, written through the fenced handle after each batch, so a restart resumes instead of re-reading shared storage; a file that shrank is re-read from 0 (dedup keys keep rows unique). Reads are bounded at 8 MiB per step. No transcript mirror, no tab mapping, no embeddings or summaries on the host yet.

**GitHub App credentials** (`appToken.ts`, `credServer.ts`, `credCli.ts`). On only when all three `FLEET_HOST_GITHUB_*` vars are set.
- The key is read once into a `KeyObject`; each GitHub call signs an RS256 App JWT (`iss` = App id, `iat` = now − 60 s, `exp` = `iat` + 540 s). The installation's account login is fetched once (`GET /app/installations/{id}`).
- Every token is scoped: a request names 1–100 repositories (and optionally `owner`, which must equal the account, and `permissions`). The minter calls `POST /app/installations/{id}/access_tokens` with `repositories` (and `permissions`, defaulting to config `github.permissions`) and returns the token only when GitHub's repository list equals the request. Config `github.repositories`, when set, refuses anything outside it (403) without calling GitHub. Tokens are cached per scope until 5 min before `expires_at`; concurrent identical requests share one call; at most 64 cached.
- Served over HTTP on the Unix socket `FLEET_HOST_CRED_SOCKET` (0600, in a 0700 directory): `POST /token` with a JSON body ≤ 8 KiB → `{ token, expiresAt }` or `{ error }` with 400/403/502/503. The log records the repositories, never a token.
- `fleet-host-cred` (the second bundle entry; `serve`'s config and server load lazily so a git lookup stays cheap): `git-credential get` answers git's protocol for the one `owner/repo` in `path` (`username=x-access-token`); `gh-token -- <args>` resolves the repo from `-R`/`--repo`, `GH_REPO`, a `gh api repos/<o>/<r>/…` path, or the cwd's `origin`, and prints a token or nothing; `token --repo <name|owner/name>…` for scripts; `serve` runs the socket standalone. Without the helper, git and `gh` get nothing and fall through (`gh search` and org-wide `gh api` calls always run without a token).""", 1),
  ("""Until fleet-host runs under a separate uid, grant `steer` only to people trusted with every other viewer's GitHub token.""",
   """Until fleet-host runs under a separate uid, grant `steer` only to people trusted with every other viewer's GitHub token.
- **The App credential helper is not a boundary against a session.** It keeps the App key out of env, logs and arguments and hands out short-lived tokens scoped to one repo. But sessions share uid 1000 with fleet-host, so any session can read the mounted key file (0400, uid 1000) and mint any token the installation allows (org-wide for `sumer-fleet-agent`), or ask the socket for any repo `github.repositories` permits. The durable fix is running the credential server (`fleet-host-cred serve`) in its own container or uid with the Secret mounted only there and the socket shared through an `emptyDir` (mode 0660, shared group); nothing else in the code changes.""", 1),
  ("""### Remote host DB
The `fleet-host` lease (`memoryLeaseStore`) is process-local and the workspace id is file-backed until the host store lands (Postgres, `host_lease`, `host_meta` adopting the file's id). Until then a deployment must run one replica without overlap (`maxSurge: 0`, `maxUnavailable: 1`).""",
   """### Remote host automations
`fleet-host` has its Postgres store, fenced lease and ingest (§7 *Remote host*) but runs no scheduler, serves no fleet-state MCP on the container socket, and registers no store-backed RPC (c3b in `superpowers/plans/2026-11-04-remote-c-3-host-store.md`): fresh automation sessions report through the MCP inbox tools, and `mcpServer.ts` still reaches Electron and, on Postgres, has its history tools off until part 4's `ReadSource`. Store-backed reads arrive with (d), automation actions with (g). Deployments keep one replica without overlap (`maxSurge: 0`, `maxUnavailable: 1`); with `db:` the fenced lease makes an overlap safe, but the invariant stays until it is deliberately relaxed. A host without `db:` must run one replica.""", 1),
  ("""§11 *Remote host DB*""", """§11 *Remote host automations*""", 1),
  ("""├── vite.host.config.ts                # bundles src/host/cli.ts → out/host/fleet-host.mjs""",
   """├── vite.host.config.ts                # bundles src/host/cli.ts + credMain.ts → out/host/fleet-host{,-cred}.mjs + chunks/""", 1),
])
edit('docs/SPEC.md', [
  ("""(probes on 8080, `/whoami` 401, uid 1000, `fleet-host init`, the CA bundle, a clean SIGTERM)""",
   """(probes on 8080, `/whoami` 401, uid 1000, `fleet-host init`, the CA bundle, the git credential helper and `gh` shim with the helper off, a clean SIGTERM)""", 1),
])
EOF
grep -c 'Remote host DB' docs/SPEC.md   # 0
```

- [ ] **Step 2: Handoff check**

Read §7 *Remote host* top to bottom and answer from it alone: which tables the host owns; what a standby holds open; what makes a stale write fail and what happens next; where the workspace id comes from on an empty DB; what `/healthz` returns with the DB down; which repo a `git push` token covers; and what the helper does not protect against. Each answer must be in the text; add what's missing.

- [ ] **Step 3: The full gate**

```bash
CI=true npx vitest run src
CI=true PG_TEST_POOL_MAX=8 npm run test:unit:pg
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx tsc -p tsconfig.host.json
npm run build:host
bash docker/host/gh.test.sh
```

Expected: all PASS; exit 0. Where Docker works, also `docker build -f docker/host/Dockerfile --build-arg BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest -t rh . && bash docker/host/smoke.test.sh rh` → `runner-host smoke: OK` (CI's `test-runner-images.yml` runs it on the PR).

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): fleet-host Postgres store, fenced lease, ingest and App credentials

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/remote-c3
gh pr create --title "feat(host): Postgres store, fenced lease, ingest and GitHub App credentials (remote c3)" --body "$(cat <<'BODY'
Implements docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md (c3; c3b is outlined there).

- `db:` host config block opening part 3's Postgres store; host pool with a retrying open and a 5 s health ping; `/healthz` reports `db`.
- `host_lease` (`pgLease.ts`) replaces the process-local lease when `db:` is set. Every store write runs a `FOR SHARE` epoch check (`afterBeginWrite`); a stale holder's write fails and the process exits 1. Stores open only on the holder.
- `host_meta` holds the workspace id, seeded from config, else the c1 state file, else a new ULID; the file is rewritten from the row.
- Holder-only ingest of `~/.claude/projects` with offsets persisted in `host_ingest_offsets`.
- GitHub App credential helper: per-request repo-scoped installation tokens on `/run/fleet-host/cred.sock`, `fleet-host-cred` (git credential helper, `gh` shim). Not a boundary against sessions while they share uid 1000 (SPEC §9).
- Image: bundle directory with a second entry, `/etc/gitconfig`, `gh` shim, `/run/fleet-host`.

Deploy: no change needed without `db:`. With it, the `fleet` schema and pgvector must exist (bootstrap script). Keep one replica without overlap.

Test: `CI=true npx vitest run src`; `CI=true npm run test:unit:pg` (lease fence under real concurrency, two-host takeover, ingest, id seeding); `bash docker/host/gh.test.sh`; image smoke in CI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
gh pr merge --auto --squash
```

---

## Open items for the Work workspace (infra)

1. **ConfigMap keys.** c3 adds two top-level keys, `db` and `github`; the strict parser refuses anything else. The database key is `database`, not `name`:

   ```yaml
   db:
     host: <Aurora cluster writer endpoint>   # the real writer endpoint: IAM tokens are signed for it
     port: 5432
     database: fleet
     user: fleet_agent
     password: { kind: aws-rds-iam, region: us-east-1 }
     # ssl: verify-full (default) with /etc/ssl/certs/rds-global-bundle.pem (default)
   github:
     repositories: [fleet-reviews, fleet-expertise]   # see question 2 for Troy
   ```

2. **App env and key mount** (as agreed 2026-11-04): `FLEET_HOST_GITHUB_APP_ID` ← `GITHUB_APP_ID`, `FLEET_HOST_GITHUB_INSTALLATION_ID` ← `GITHUB_APP_INSTALLATION_ID`, `FLEET_HOST_GITHUB_APP_KEY_FILE=/var/run/secrets/github-app/key.pem` with `GITHUB_APP_PRIVATE_KEY` mounted there from a Secret (0400, uid 1000).
3. **Probes:** `/healthz` returns 503 while the DB is unreachable. Use it for readiness (and the ALB health check), not liveness.
4. **Bootstrap:** unchanged. The host needs the `fleet` schema owned by `fleet_agent` and the `vector` extension; it creates neither.

---

## c3b outline (written in full when part 4's `ReadSource` lands)

**Goal:** remote automations run on the host, and its sessions get the fleet-state MCP tools.

**Gate:** c3 merged; async-store part 4's typed tools on a `ReadSource` (D34's history tools on Postgres). The inbox and automation tools don't need part 4, but splitting the MCP server twice isn't worth it.

- **MCP on the container socket.** Split `mcpServer.ts` so the tool registry and socket server reach no `electron` (`config.ts`, `errorLog.ts`, `paths.ts`) and no OpenTelemetry (`perf.ts`): inject the error log, perf status and config getters. `fleet-host` serves it on the socket the container's `claude` already dials, scoped to the hosted workspace; `query` stays off until (d)'s role + RLS.
- **Scheduler and runner on the holder** (outline F7): `automationService` with `spawnFresh`/`freshState`/`closeFresh` through c1's `BrokerOps` (CREATE with the bot as owner), `runIn: host` and cross-workspace targets refused at definition validation on the host, `execScript` in the container. Started after the stores open, stopped before they close; their writes are fenced like every other.
- **Events:** `automations:changed` and `proposals:changed` to the `EventHub` (already allowlisted).
- **Tests:** a run fires once across two hosts on one schema (the fence plus the lease); a timer-started run on a host that loses the lease records nothing after the takeover.
- **`ReadSource` gaps that (d)'s `FederatedReader` must close** (found in the 4a review):
  - *No origin identity.* Rows carry no field naming the store or host they came from. Merged results can't be attributed or deduplicated across sources.
  - *No stable cursor.* `list_sessions`/`list_events` page by `since` on a timestamp, and that isn't tie-safe: rows sharing a `ts` at a page boundary are skipped or repeated. (d) needs a total-order cursor, e.g. `(ts, origin, id)`.

## Questions for Troy

1. **Credential server under its own uid or container (G13).** Until then the App helper scopes tokens for well-behaved sessions but any session can read the key. Moving it is a chart change plus socket mode 0660; the code is ready (`fleet-host-cred serve`).
2. **`github.repositories`.** Set an allowlist (which repos?), or leave it unset so any SumerSports repo can get a token (still one repo per token)? The review agent reads and comments on PRs across many repos, so a short list would block reviews outside it.
3. **The split (G1).** c3 no longer runs automations on the host; c3b does, after part 4. Say if automations should come first instead, with MCP limited to the inbox tools.

## Self-review notes

- **Coverage against the request and the outline:**
  - `db:` → part 3 factory: Task 3 (`parseDb`, `openHostDb`), Task 4 (`openPgStores` on the holder).
  - Fenced lease with epochs on the store's clock, replacing `memoryLeaseStore`: Task 4 (`postgresLeaseStore`, `clock_timestamp()`); `afterBeginWrite` fence: Task 4 (`leaseFence`), tested under real concurrency and mutation-checked.
  - `host_meta` seeded from the c1 file, file reconciled: Task 5.
  - Ingest of host transcripts: Task 6.
  - App credential helper, scoped tokens, never exposing the PEM, the shared-uid limitation: Tasks 1–2, G12, G13, SPEC §9.
  - Outline items not in the request: health (G8, Task 3), the RDS CA (already in the image since c1; part 3's `rds-ca-bundle.sh` isn't needed), SDK pins (part 3), `/healthz` standby while 200 (Task 4 test). C3-5/6/7 → c3b, (d), (g) with reasons (G1).
- **Validated before writing** (scratch worktree, PG 16.15, removed afterwards): the lease store and fence including both concurrency tests and the `FOR SHARE` mutation; the minter against the fake API with three mutations; the multi-entry bundle with the `better-sqlite3` alias running `openPgStores` + `ingestBatch` against Postgres; `tsc -p tsconfig.host.json` over `pgStores.ts`/`db.ts` (NodeNext). Two defects found there are designed out: `pool.query` skipping `search_path` (G3) and `now()` staleness after a lock wait (G4).
- **Names used across tasks:** `HostDb`, `HOST_TRACK`, `HostDbHandle.k`, `postgresLeaseStore(k, workspaceId)`, `leaseFence({ workspaceId, holder, epoch, onLost })`, `LeaseManager.markLost()`, `startHolder({ …, projectsDir })`, `HostIngest({ projectsDir, workspaceId, offsets, log })`, `resolveHostWorkspaceId(k, stateDir, configuredId, log, mint?)`, `startCredHelper({ appEnv, socketPath, github, log, apiBase? })`, `HostEnv.credSocket`/`projectsDir`.
