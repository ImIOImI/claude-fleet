# Remote workspaces (c3): the host store, automations on the host, and App credentials — Outline Plan

> **For agentic workers:** this is a **gated outline**, like *Part 2b outline* in `2026-11-04-async-store-part2.md`. Expand it into a full TDD plan (superpowers:writing-plans) when its gate opens. Don't execute it as written.

**Goal:** Give `fleet-host` its Postgres store, so that:
- the lease is fenced across pods;
- the host ingests its own transcripts and runs its own automations;
- RPC and `/events` serve the store-backed channels;
- in-container sessions get the fleet-state MCP tools.

Also give sessions short-lived GitHub App credentials.

**Ships:** remote automations run on the host, with no desktop involved. The host's sessions, history and automations are readable over RPC. (The desktop's federated views are (d) and (g).)

## Gate

c3 has five parts, each with its own gate:

| Part | Needs |
|---|---|
| C3-1 (App credential helper) | **Nothing.** Do it first; it can ship on its own. |
| C3-2 (DB connection) | Async-store **part 3** (`docs/superpowers/plans/2026-11-04-async-store-part3.md`, D36). That covers `pg`; `src/main/store/postgres.ts` with the `afterBeginWrite` hook; `storeConfig.ts`, `passwordProvider.ts`, `pgSsl.ts` and `pgStores.ts`; per-dialect migrations with a `migratePostgres` track per store; `docker/scripts/rds-ca-bundle.sh`; and the CI `pgvector/pgvector:0.8.7-pg16` service with `PG_TEST_URL`. |
| C3-3 (schema, lease, fencing) | C3-2. |
| C3-4 – C3-7 | C3-3. Also async-store part 2b, because ingest and RPC read through the async read API. |

## Global Constraints (verbatim from the spec and design-state)

- "The host's DB is **Postgres with pgvector** on a managed database service or on a block volume attached to the host." / "**The DB is not on shared file storage.**" (§3)
- "`fleet-host` uses the same store layer, always on Postgres." (§7)
- "A fenced lease in the host DB is the correctness backstop. The row is `host_lease(workspace_id PK, holder, epoch, expires_at)`." / "Every write transaction checks `epoch` against the lease row inside the transaction. A stale holder's write fails, and the process drops to standby and exits." (§3)
- "**Readiness is not lease state.** The pod is *ready* when the process is healthy (DB reachable, lease loop running), whether it's holder or standby." (§3)
- DB credentials (design-state, 2026-11-03):
  - "The `aws-rds-iam` password provider must use the SDK's default Node chain (container credentials: `AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`), pinned to an SDK release with Pod Identity support (verify the minimum at implementation), with a unit test against a fake credentials endpoint."
  - "IAM tokens are signed for that exact hostname (a Route53 alias can't be signed; any future alias needs resolve-then-sign). Use `sslmode=verify-full`, which means **the host image must ship the AWS RDS CA bundle** (`global-bundle.pem`) and the pg client must be pointed at it."
- "The pool calls the provider on **every new connection** (the `pg` pool's async `password` function)." (§7)
- "Automation sessions (`auto-<runId>-<stepId>`) and sessions started by the deployment's bot are owned by the workspace's bot identity." / "`runIn: host` and steps that target other workspaces are refused on a remote host, because it has no other workspaces and no desktop shell." (§2, §4)
- "`fleet-host` mints short-lived installation tokens on demand and serves them to `gh` and git through a credential helper, so long-lived sessions never hold an expired token." / "No person's credentials ever enter the container." (§3)
- The c1 seams are unchanged:
  - `LeaseStore`;
  - `runHost({ leaseStore })`;
  - `RpcChannel { tier, handle }`;
  - `EventHub.publish` with its `EVENT_CHANNELS` allowlist;
  - `HostServerDeps.healthy()`.

## Decisions taken now (so the expansion doesn't re-litigate them)

- **F1 — The workspace id moves into `host_meta(workspace_id, created_at)`.**
  - On the first migration, the host seeds it from c1's `$FLEET_HOST_STATE/workspace-id.json` if that file exists, so desktop bookmarks keep working.
  - After that, the DB row is authoritative, and the file is rewritten from it.
- **F2 — `postgresLeaseStore` uses one conditional statement per operation.**
  - `tryAcquire`: `INSERT … ON CONFLICT (workspace_id) DO UPDATE SET holder=$h, epoch=host_lease.epoch+1, expires_at=$t WHERE host_lease.holder IS NULL OR host_lease.expires_at <= now() RETURNING epoch`.
  - `renew` and `release` use `WHERE holder=$h AND epoch=$e`.
  - Times come from the DB clock (`now()`), not the pod's.
- **F3 — Fencing is `withFence(trx, epoch)`.**
  - It runs `SELECT epoch FROM host_lease WHERE workspace_id=$1 FOR SHARE` as the first statement of every write transaction on the host's Kysely handle.
  - A mismatch throws `LeaseLostError`, which `runHost` turns into `lease.emit('lost')`, so the process exits.
  - The host wraps the store's `transaction()` once, so store code doesn't change.
- **F4 — Host config gains `db:`:**
  - either `{ connectionString | env }`;
  - or `{ host, port, database, user, password: { kind: 'static'|'env'|'aws-rds-iam', region? }, ssl: 'verify-full' }`.
  - `host` must be the real writer endpoint. The RDS CA is `/usr/local/share/fleet-host/rds-global-bundle.pem`, fetched at image build from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` with its sha256 pinned in `docker/versions.yaml`.
- **F5 — `healthy()` becomes "the last DB ping (≤15 s old) succeeded and the lease loop is running".** `/healthz` reports `{ status, lease, db }`.
- **F6 — The host's `query` MCP tool stays disabled until (d)**, which brings role + RLS on the host. The typed fleet-state tools are served on the container's MCP socket, scoped to the hosted workspace.
- **F7 — Automation sessions run through the in-container broker.**
  - The host's `spawnHeadless`, `headlessState` and `closeHeadless` go through c1's `BrokerOps`.
  - Their owner is the bot identity.
  - `runIn: host` and cross-workspace targets are refused at definition validation (`automations/definition.ts`), on the host only.
- **F8 — The App credential helper:**
  - Env: `FLEET_HOST_GITHUB_APP_ID`, `FLEET_HOST_GITHUB_APP_KEY_FILE`, `FLEET_HOST_GITHUB_INSTALLATION_ID`.
  - fleet-host signs an RS256 JWT with `node:crypto` and caches the installation token until 5 minutes before `expires_at`.
  - It serves the token on a 0600 Unix socket, `/run/fleet-host/cred.sock`.
  - `fleet-host git-credential get` answers git (`credential.helper`).
  - A `gh` shim on `PATH` runs `GH_TOKEN=$(fleet-host token) exec gh-real "$@"`.
  - Without the env vars the helper is off.

## Outline tasks

- **C3-1 — The GitHub App credential helper (ungated).**
  - Files: `src/host/appToken.ts` (+ test), `src/host/credServer.ts` (+ test), `src/host/cli.ts` (`token` and `git-credential` subcommands), and in `docker/host/` the gh shim and the git config.
  - Tests:
    - the JWT verifies with the generated public key (`iat` −60 s, `exp` +9 min, `iss` = app id);
    - the token is cached and refreshed at expiry −5 min;
    - concurrent requests share one fetch;
    - the key and token never appear in logs or errors (mutation-checked);
    - the socket is 0600;
    - git-credential output is the `username=x-access-token\npassword=…` protocol.
- **C3-2 — The DB connection.**
  - Files: `src/host/hostDb.ts` (+ test), on part 3's `parseStoreConfig(…, { allowStaticSecrets: true })` and `openPgStores(…, { afterBeginWrite })`.
  - The SDK pins and the Pod Identity test are in part 3 (`3.1162.0`, SPEC §4). The host image runs `docker/scripts/rds-ca-bundle.sh /etc/ssl/certs/rds-global-bundle.pem`, which `verify-full` uses by default when `caFile` is unset.
  - Tests:
    - against a fake container-credentials endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`), the token is signed for the configured hostname and port, and the provider runs per new connection;
    - `ssl` carries the bundle's CA with `rejectUnauthorized: true` (verify-full);
    - the image smoke checks the bundle's sha256.
- **C3-3 — Schema, the lease row and fencing.**
  - Files: `src/host/hostSchema.ts`, `src/host/pgLease.ts` (+ tests on `PG_TEST_URL`), `src/host/fence.ts`.
  - Tests:
    - two managers on one DB: one holds, the other is standby, and takeover happens within one tick after release or expiry;
    - a stale epoch's write throws `LeaseLostError`;
    - the workspace id is adopted from the file;
    - `/healthz` reports standby while still answering 200.
- **C3-4 — Ingest on the host.**
  - `jsonlWatcher` over `~/.claude/projects`, writing the Postgres state store, holder only.
  - Its rows are attributed to the hosted workspace id.
- **C3-5 — The scheduler and runner on the host** (F7). Fires only while the host holds the lease. `automations:changed` and `proposals:changed` go to the `EventHub`.
- **C3-6 — Store-backed RPC channels**, registered beside c1's:

  | Tier | Channels |
  |---|---|
  | `read` | `sessions:list`, `observability:summaryForWorkspace`, `observability:eventsForSession`, `automations:list`, `automations:get`, `proposals:list`, `inbox:list` |
  | `steer` | `automations:run`, `proposals:approve`, `inbox:update` |

  Plus the broadcasts `observability:summary` and `inbox:changed`. Tests: one tier row per channel (mutation-checked, like c1 Task 7).
- **C3-7 — fleet-state MCP on the container's socket** (F6), plus SPEC.md:
  - §7 *Remote host*: the DB, `host_meta`/`host_lease`, fencing, the `db:` config;
  - §4: the RDS CA and SDK pins;
  - §9: App credentials;
  - §11: the host's MCP scope.

## Open items for the Work workspace / Troy

1. Helm values for `db:` (the writer endpoint, region, IAM user `fleet_agent`) and the three App env vars in Doppler.
2. Until C3-3 ships, the deployment must run **one replica with no overlap**, because c1's lease is process-local. The aws-microservice chart's canary Rollout overlaps pods. Does `scaleToZeroWhenWarm` plus a Recreate-style strategy cover this, or should c1 deployments accept a brief split of viewers during a deploy? With no scheduler running before c3, an overlap can't fire anything twice.
