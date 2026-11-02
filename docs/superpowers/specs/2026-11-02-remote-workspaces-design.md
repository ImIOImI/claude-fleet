# Remote workspaces

A **remote workspace** is an ordinary claude-fleet workspace whose container runs somewhere other
than the user's desktop: in a cluster, on a shared VM, anywhere that can run the runner image.
Several people attach to it, start their own sessions in it, and see and steer its automations
from their own desktops. Its agents can search the transcripts people choose to publish to it.
There is no separate "agent" concept. An always-on reviewer or triager is just a remote workspace
with automations.

This spec covers the runtime, identity, transport, data architecture, UX and security model, and
splits the work into independently shippable sub-projects. File sharing between nodes is already
covered by the git-sync loadout (§10).

## 1. Goal and non-goals

**Goal**
- **Any workspace can be remote.** It's a new backend `kind`, beside `container` and `local`.
- **Shared by people.** Everyone granted access sees the workspace's sessions, transcripts,
  automations, runs and proposals. Depending on their tier, they can also steer it and start their
  own sessions in it.
- **Automations per workspace.** A remote workspace owns its automations, and its host runs them
  with no desktop involved.
- **Agents benefit from people's transcripts.** People publish opted-in transcripts one way to a
  remote workspace, where its sessions can search them (`search_transcripts`) and rank them by
  proven usefulness.

**Non-goals**
- **Driving remote Docker, SSH or Kubernetes from the desktop.** The remote container's lifecycle
  belongs to its deployment. The desktop only talks to the host's API. §3 "Not a remote
  orchestrator" still holds in that sense.
- **Two-way data replication.** There's no mirror of remote data in the local DB, no sync engine
  and no conflict resolution. Reads federate (§7).
- **Offline viewing of remote data.** Remote data is live-only: visible while the host is
  reachable, absent otherwise. A local cache may come later (§13).
- **Changing local workspaces.** `container` and `local` workspaces behave exactly as they do
  today.

## 2. Concepts

- **Remote workspace = `kind: 'remote'`.** `WorkspaceKind` becomes `'container' | 'local' |
  'remote'`, and `backendRouter.ts:resolveKind` routes it to a new `remote.ts` backend (§6). Its
  manifest at `<userData>/state/<id>/workspace.json` is a *bookmark*, not a spec: the host URL,
  the workspace id the host reports, and display fields (name, colour). The authoritative spec
  (image, env, loadouts) belongs to the host's deployment.
- **One remote host serves exactly one workspace.** The host mints the workspace's ULID at first
  start and stores it in its DB. Desktops adopt that id, so a remote workspace has the same id on
  every desktop.
- **Automations belong to their workspace** and run wherever that workspace is hosted. A local
  workspace's automations stay in the desktop's `inbox.db` and the desktop's scheduler runs them.
  A remote workspace's automations, runs, proposals and todos live in its host's DB, and the
  host's scheduler runs them. Their steps target that workspace (`runIn: $self`, prompt steps to
  its own sessions). `runIn: host` and steps that target other workspaces are refused on a remote
  host, because it has no other workspaces and no desktop shell.
- **One writer per workspace.** Only the process hosting a workspace writes that workspace's
  data: the desktop for local workspaces, and the lease-holding `fleet-host` for a remote one
  (§3). Desktops never write remote rows directly. Every action (run now, approve, post) is an
  RPC that the host applies. The one cross-boundary write is **publish** (§7): a person
  appending their own transcripts into an owner partition on a remote host, which only that
  person writes.
- **No special agent.** "The agent" is whatever the remote workspace's sessions and automations
  do. Distinctions such as "marks on the agent's own sessions don't count" (§7) key off whether a
  session belongs to the hosting workspace or to a published partition, not off an agent identity.

## 3. Remote host

**What runs in the container.**
- The **runner image** (or a variant built `FROM` it, such as devops) plus the **broker**,
  unchanged. The broker owns every `claude` PTY, exactly as in a desktop container.
- **`fleet-host`**, a headless Node process that reuses the Electron-free core:
  - the automation scheduler and runner: `automations/{automationService,scheduler,runner,
    definition,cron,classify,proposalService,reschedule,template,scriptProtocol}.ts`;
  - the inbox services: `inbox/{inboxService,inboxCore,inboxPolicy}.ts`;
  - the fleet-state MCP server (`mcpServer.ts`), served on the container's own MCP socket, so
    sessions in the container get the same `claude-fleet-state` tools as on a desktop;
  - transcript ingest (`jsonlWatcher.ts`) of the container's own `~/.claude/projects/`;
  - embeddings and summaries (`embeddings.ts`, `vectors.ts`), with the same model as desktops;
  - a `BrokerClient` (`broker.ts`) over the in-container broker socket;
  - the transport endpoint (§6).
- New code is a small entry point (`src/host/`) plus host-side replacements for the few Electron
  dependencies. Secrets come from the container env (the deployment's secret store) instead of
  `safeStorage`, and broadcasts (`inbox:changed`, `automations:changed`, …) go to WebSocket
  subscribers instead of `webContents.send`.
- claude-fleet publishes a host image variant, `runner-host` (and `runner-devops-host`): the runner
  image plus the bundled `fleet-host`. `tini` supervises both the broker and `fleet-host`.
  Organisations extend it `FROM <pinned digest>` with their own layers, as with any runner image.

**Credentials (decided, option A).** The host's sessions all use the **workspace's** credentials,
from the container env:
- an Anthropic credential (an API key, or a gateway base URL and key);
- a GitHub identity for the workspace, normally a GitHub App. `fleet-host` mints short-lived
  installation tokens on demand and serves them to `gh` and git through a credential helper, so
  long-lived sessions never hold an expired token.

No person's credentials ever enter the container.

**Singleton: one live `fleet-host` per workspace.** Typical deployments briefly run two pods: a
canary or rolling deploy overlaps old and new, and a warm-standby cluster may run a second copy.
Two schedulers would fire every automation twice, and two ingesters would race on the same
transcripts. So:
- **The deployment should run one replica and avoid overlap** (scale a standby to zero,
  `Recreate` where the platform offers it). That's the first line of defence, but it isn't relied on; canary and rolling deploys also work because of the lease (below).
- **A fenced lease in the host DB is the correctness backstop.** The row is
  `host_lease(workspace_id PK, holder, epoch, expires_at)`.
  - On start, `fleet-host` acquires the lease by taking it when expired and bumping `epoch`, then
    renews it every 10 s with a 30 s TTL.
  - Until it holds the lease, the process is **standby**. It runs no scheduler or ingest, serves no
    RPC or attach, and creates no broker sessions.
  - **Readiness is not lease state.** The pod is *ready* when the process is healthy (DB reachable,
    lease loop running), whether it's holder or standby. Lease state is reported as data (below). If
    readiness waited for the lease, a rolling or canary deploy would deadlock: the new pod waits on
    the lease the old pod keeps renewing, and the rollout waits on the new pod.
  - **On SIGTERM the holder releases the lease.** It finishes or abandons the in-flight step, closes
    broker sessions cleanly, then clears `holder`, so the next pod takes it within one renew tick (≤10 s).
  - Every write transaction checks `epoch` against the lease row inside the transaction. A stale
    holder's write fails, and the process drops to standby and exits.

**Storage.**
- **Shared file storage** (an NFS / ReadWriteMany volume such as EFS, Filestore or Azure Files)
  holds `~/.claude` (transcripts, the source of truth; peer-status files) and `/workspace`
  (working trees). It's mounted wherever the pod lands, so a host move, cluster flip or redeploy
  keeps every transcript and checkout. PTYs don't survive a move, because the processes restart.
  Sessions resume from their transcripts through the normal resume flow (`claude --resume`, §8
  *Browse & resume*).
- **The DB is not on shared file storage.** NFS locking and fsync semantics don't suit a database.
  The host's DB is **Postgres with pgvector** on a managed database service or on a block volume
  attached to the host. The DB holds the same tables desktops have (`events`, `sessions`,
  `broker_sessions`, `embeddings`, `session_summaries`, `usage_events`, the inbox and automation
  tables), plus `host_lease`, `session_owners` (§4) and the publish partitions (§7). Ingest is
  rebuildable from the JSONL on shared storage, like `state.db`. The automation and inbox tables
  are authoritative, like `inbox.db`.

## 4. Sessions

- **Sessions live in the remote container.** Its broker owns the PTYs, and the transcripts on
  shared storage are the source of truth. `fleet-host` ingests them into its own DB.
- **Sharing scope (decided, C).** Anyone who attaches can see and steer the workspace's sessions,
  according to their tier (§5), and can **start their own sessions** in it.
- **Attribution.** A session is attributed to the GitHub user who started it.
  - When `fleet-host` sends the broker `CREATE` for a person, it records
    `session_owners(session_id, broker_session_id, login, github_id, name, avatar_url,
    started_at)`. The claude session id is filled in when `broker_sessions` maps it.
  - Automation sessions (`auto-<runId>-<stepId>`) and sessions started by the deployment's bot are
    owned by the workspace's bot identity.
  - Usage and cost are attributed to the owner: `get_cost`/`session_summary` and the observability
    rollups can group by owner.
- **Visibility (decided, A).** **Everyone with `read` sees every session.** The Sessions pane shows
  each session's owner as avatar + name + @login, with a **Mine / Everyone** filter. Hiding
  sessions from other people wouldn't be honest about the trust model (below), so the UI doesn't
  pretend to.
- **Authorship.** Sessions use the workspace's credentials (§3), so on GitHub the work appears as
  the workspace's bot. The person is credited through a **per-session attribution layer**:
  - `fleet-host` writes `<state>/sessions/<brokerSessionId>/attribution.settings.json` and passes
    `--settings <path>` in the `CREATE` args. The broker already appends `CREATE` args to the
    claude exec, so the broker doesn't change.
  - Commits get the trailer `Co-authored-by: <name> <id+login@users.noreply.github.com>`. The name
    is the GitHub profile name, or the login when it's unset.
  - PR bodies and comments get a line "on behalf of @login".
  - This uses claude's `attribution` settings (commit and PR text). Support must be verified at
    the pinned claude version. **Fallback** when it isn't supported: the same values as session
    env (`FLEET_SESSION_OWNER_LOGIN`, `…_NAME`, `…_EMAIL`), plus a session instruction appended
    with `--append-system-prompt` that tells claude to add the trailer and the line.
- **Trust note.** All sessions in one container run as **one Linux user**. Any session can read
  another session's files, environment and transcript, and act with the workspace's credentials.
  The `session` tier is therefore **owner-equivalent**: granting it means trusting that person
  with everything the workspace can do.

## 5. Identity and auth

**Identity-provider interface.** The host verifies every request through a pluggable provider:

```ts
interface IdentityProvider {
  id: 'github' | string;
  verify(token: string): Promise<{
    user: { login: string; id: number; name: string | null; avatarUrl?: string };
    teams: string[];          // 'org/team-slug'
    kind: 'user' | 'machine';
  }>;
}
```

Results are cached per token for 5 minutes, so revoking a token or removing someone from a team
takes effect within that window.

**GitHub first: device flow.**
- The desktop signs in with the **OAuth device flow** (`POST /login/device/code`, then poll
  `/login/oauth/access_token`) and requests scopes `read:user read:org`.
- It uses **claude-fleet's own OAuth app**, separate from the `gh` CLI. Every `gh auth login`
  counts against the gh app's per-user token cap, and the oldest token is revoked when a new one
  is minted, so sharing gh's app would sign people out at random. An organisation that restricts
  OAuth apps can approve claude-fleet's app, or set its own client id (`config.json`
  `identity.github.clientId`).
- The host's `github` provider calls `GET /user` and `GET /user/teams`.
- **SSO organisations.** Under SAML SSO a token is useless for the org until it's authorised for
  that org once. When GitHub answers with an `X-GitHub-SSO` header, or the teams list lacks the
  org the host expects, the desktop shows "Authorise claude-fleet for *org*". It explains that this
  is a one-time GitHub step and links the URL from the header. After that, it retries.
- **Later providers.** OIDC (for example Entra ID) is a second provider: an ID token is verified
  against the issuer's JWKS, and groups map to teams. It isn't in the first release.
- **Machines.** Callers such as CI use **GitHub App installation tokens**. An installation token
  can't call `GET /user` (403 "Resource not accessible by integration"), so the provider verifies
  it with an installation-scoped call (`GET /installation/repositories`) and maps it to a **bot
  identity configured explicitly** in the host config: `machines: [{ appId, login:
  "acme-reviewer[bot]", tier }]`.

**Grants.** The host config maps GitHub teams (and, optionally, individual logins) to tiers. This
extends the committee grant model (§11 *Cross-workspace committee control*: `read`/`post`/`pause`)
to people. Tiers are cumulative:

| Tier | Allows |
|---|---|
| `read` | See everything: sessions (watch-only attach), transcripts, cost, automations, runs, proposals, todos. Publish one's own transcripts (§7). |
| `steer` | Also: type into existing sessions; run, enable, disable and edit automations; approve or reject proposals; create and update todos; kill a served port; port preview. |
| `session` | Also: start and close one's own sessions. Owner-equivalent (§4). |

```yaml
# host config (deployment-provided; read at start and on SIGHUP)
identity: { provider: github, org: acme }
grants:
  - { team: acme/platform, tier: session }
  - { team: acme/engineering, tier: read }
  - { login: some-contractor, tier: steer }
machines:
  - { appId: 123456, login: "acme-reviewer[bot]", tier: steer }
```

A person's tier is the highest tier any matching rule grants. No match means 403. Grants are
deployment config, not editable from the desktop.

**Network reach is a separate layer.** Identity says who may do what. Whether a laptop can reach
the host at all is up to the deployment: a VPN, a zero-trust network, a private ingress, or a
public ingress. claude-fleet assumes nothing about it.

## 6. Transport

**One authenticated HTTPS/WebSocket endpoint per remote host**, served by `fleet-host`. Every
request carries `Authorization: Bearer <GitHub token>`. WebSockets send it on upgrade.

| Route | Purpose | Tier |
|---|---|---|
| `GET /healthz` | Process health, used by liveness/readiness probes. 200 whenever healthy, holder or standby. The body reports `{"lease": "holder" \| "standby"}`. Unauthenticated. | none |
| `GET /leader` | 200 only on the lease holder, 503 on a standby. For routing or diagnostics; **no Kubernetes probe uses it.** Unauthenticated. | none |
| `GET /whoami` | `{ workspace: {id, name, description, color}, user, tier }` | read |
| `POST /rpc/<channel>` | RPC mirroring IPC channel names and payloads (`sessions:list`, `observability:summaryForWorkspace`, `observability:eventsForSession`, `automations:list`, `automations:get`, `automations:run`, `proposals:list`, `proposals:approve`, `inbox:list`, `inbox:update`, …). Each channel declares its tier. | per channel |
| `GET /attach` (WebSocket) | Terminal attach: tunnels the broker frame protocol (`[u32 len][u8 type][payload]`, §5 *Broker frame protocol*). | read; frame-gated |
| `GET /events` (WebSocket) | Server push of the same channel names desktops use internally: `observability:summary`, `sessionstatus:update`, `inputwait:update`, `ports:changed`, `automations:changed`, `proposals:changed`, `inbox:changed`, plus `sessions:changed`. | read |
| `POST /publish` | Transcript publish (§7). | read |

- **Per-route and per-frame tier checks.** RPC channels are allowlisted with a tier. Unlisted
  channels (vault, filesystem, config, image or Docker channels) don't exist on the host. On
  `/attach`, `fleet-host` terminates the frames and checks each one:
  - `ATTACH`, `HISTORY`, `LIST` and `LISTPORTS` need `read`;
  - `INPUT`, `RESIZE`, `KILLPORT` and `DIAL` need `steer`;
  - `CREATE` and `CLOSE` need `session`. A `session`-tier user may `CLOSE` only sessions they own;
    `steer` and above can't close other people's sessions.
- **Many viewers, one broker writer.** The broker allows one writer per session. `fleet-host` holds
  that single attachment and fans `OUTPUT` out to every viewer. It accepts `INPUT` from any
  `steer` viewer. A newcomer gets `HISTORY` replay, as on a desktop reattach.
- **The desktop side.** `remote.ts` implements the `Backend` contract:
  - `ping` is `/healthz`. `listLiveWorkspaces` reports `running` or `unreachable`.
  - `attachPty` opens `/attach` and adapts it to the same handle the renderer's `pty:*` channels
    already drive.
  - `start`, `pause`, `stop` and `ensureImage` throw "managed by its deployment".
  - `removeWorkspace` forgets the bookmark: it deletes the manifest. The GitHub token stays,
    because other remote workspaces use it too.

  A new `RemoteClient` (`src/main/remoteClient.ts`) owns the RPC, the `/events` socket (reconnect
  with backoff) and the token.
- **TLS** terminates wherever the deployment provides it: an ingress, a load balancer or a
  service-mesh gateway. In-pod TLS is optional. It isn't needed where a mesh already encrypts
  pod-to-pod traffic and the client path is encrypted (TLS ingress or an encrypted tunnel). Plain
  `http://` host URLs are **allowed** for now, so deployments that rely on network-level encryption
  (a mesh or an encrypted tunnel) work without in-pod certificates. The add-workspace form shows a
  one-line warning for a non-loopback `http://` URL, because bearer tokens cross the wire. Requiring
  TLS is an open question (§13).

## 7. Data architecture: federation, not replication

**The local DB is the user's choice at setup** (`config.json` `store`):
- **SQLite** (default): today's `state.db` and `inbox.db`. Needs no setup and works without Docker.
- **Postgres** (`store: { kind: 'postgres', managed: true }`): an app-managed Postgres + pgvector
  container (a pinned image started through `dockerode`, data in a named volume), with
  multi-connection access and pgvector search. It needs Docker running: while the daemon is down,
  history and inbox are unavailable, and the setup step says so.

**One store layer.**
- `db.ts`, `inboxDb.ts` and the stores built on them (`automationStore.ts`, `proposalStore.ts`,
  `notifyStore.ts`) move behind one **async** store interface. It's written once with **Kysely**
  against both dialects (better-sqlite3 and `pg`).
- Migrations are per dialect where the SQL differs (`AUTOINCREMENT` vs identity columns, BLOB vs
  `vector`), driven from one migration list.
- **Vector search is per backend.** SQLite keeps today's brute-force cosine search over Float32
  BLOBs (`vectors.ts`). Postgres uses pgvector (`vector(384)`, cosine distance, an HNSW index).
  Both sit behind `searchEmbeddings(query, scope, limit)`.
- `fleet-host` uses the same store layer, always on Postgres.
- **Connection config: a connection string or fields, plus a password provider.**
  - **A connection string** (`connectionString: 'postgres://user:pass@host:5432/db?sslmode=…'`, or
    `env: DATABASE_URL`) is the simple path. It's what the app-managed local container uses, and the
    vault holds it.
  - **Or discrete fields** (`host`, `port`, `database`, `user`, `ssl`) plus
    `password: { kind: 'static' | 'env' | 'aws-rds-iam' }`. The pool calls the provider on **every new
    connection** (the `pg` pool's async `password` function).
  - **On AWS, use `aws-rds-iam`.** It mints a 15-minute token with the RDS signer from the pod's
    workload identity, so no long-lived DB password exists. That's the recommended setup for any
    host running in AWS. Other clouds' IAM tokens can be added as providers.

**Remote hosts keep their own data.** Each remote host's Postgres holds its workspace's data. None
of it is copied into a desktop's DB.

**Reads federate.**
- A `FederatedReader` in main fans each read out to the local store plus every connected
  `RemoteClient`, applies a per-source timeout (3 s), and merges the results.
- Merging is by the field the channel already sorts on (`last_active_at`, priority then recency,
  `nextFireAt`). Each row carries `origin: 'local' | <remoteWorkspaceId>`.
- Semantic search results merge by score. Scores are comparable because every source embeds with
  the same model key (`Xenova/bge-small-en-v1.5@q8`). A source reporting a different model key is
  left out of the merge and flagged.
- A source that times out or errors is dropped from that result, and the response lists it under
  `unavailable`.
- Actions are not federated. Each one is an RPC to the host that owns the row.

**Remote data is live-only (decided, A).** A desktop's own data always works offline. A remote
workspace's history, sessions and automations are visible only while its host is reachable.
Nothing remote is persisted locally, apart from the bookmark manifest and a cached avatar per
login.

**One-way transcript publish** (people's transcripts → a remote workspace):
- **Opt-in per workspace.** A local or container workspace's manifest gains `publish?: { to:
  string[] }`, a list of remote workspace ids. Its Edit form gets a "Publish transcripts to…"
  control. Off by default.
- **Client-side scrubbing** before anything leaves the desktop:
  - every secret value in that workspace's vault bag, plus the signed-in GitHub token, is replaced
    with `[redacted:<KEY>]`;
  - known token patterns are redacted: `sk-ant-…`, `ghp_`/`gho_`/`ghs_`/`github_pat_…`, AWS
    `AKIA…`, PEM private-key blocks, `Bearer …`, and generic `*_KEY=`/`*_TOKEN=`/`*_SECRET=`
    assignments.
- **Server-side scrubbing.** The host repeats the pattern scrub and also scrubs its own secret
  values. Either side's rules are enough to redact a match.
- **Owner-partitioned, append-only.**
  - The desktop's ingest pushes newly ingested events (`POST /publish`, batches ≤1 MB,
    resume-from-last-acked cursor) as `{ sourceWorkspaceId, sessionId, events[] }`.
  - The host stores them under the verified caller's partition: `owner_login` plus
    `source_workspace_id`, which the host derives and never takes from the payload.
  - Rows are inserted idempotently on `(owner_login, session_id, dedup_key)`. There's no update
    path.
  - The host ingests published rows into its embeddings like its own sessions, so its
    `search_transcripts` finds them.
  - Nothing flows back. A desktop never pulls a host's transcripts into its local DB.
- **MCP visibility on the host.** Sessions in the remote workspace see their own workspace plus
  every published partition. That's the point of publishing, and the publish control tells the
  person so ("visible to everyone with read on *host* and to its sessions").

**MCP `query` isolation on Postgres.** The SQLite path keeps the in-memory snapshot
(`buildSnapshot`). On Postgres, isolation is structural in a different way:
- Each MCP caller gets its own **read-only role**: `SELECT` only, no `raw_jsonl` column unless
  `include_raw`, which uses a sibling role.
- **Row-level security** on `events`, `sessions` and `broker_sessions` limits rows to the caller's
  allowed scope (`workspace_id IN (SELECT … FROM query_scope WHERE role = current_user)`).
  `query_scope` is rewritten whenever grants change, so revocation is instant.
- Each `query` runs in a `READ ONLY` transaction under `SET LOCAL ROLE`, with `statement_timeout`.
- The existing guards still apply: single statement, row cap, result cap.

**Usefulness signals.**
- `usage_events` rows on a host carry an `origin` (the host's own workspace, or a publisher
  partition).
- A `marked-useful` written by the remote workspace's sessions **on a published (people's)
  session counts** toward that session's ranking and retention. Marks on the workspace's **own**
  sessions don't count, so the agent can't promote its own output.
- Signals that leave their origin (for example, a publisher seeing how often their sessions
  helped) are **counts only**: `kind`, `session_id`, `origin`, `ts`. No query text, no notes.

## 8. Desktop UX

**Adding a remote workspace.**
- The `+` modal's New tab gets a third kind, **Remote**, with a Host URL field and **Sign in with
  GitHub**.
- Sign-in shows the device code with Copy and "Open github.com/login/device", and polls until it
  completes. A user who has already signed in skips this step, because one token serves every host.
- The app calls `/whoami` and shows the workspace name, description and **your tier**, then
  writes the bookmark manifest under the host's workspace id.
- Errors are specific: not reachable (check your network or VPN); 403 no grant (ask the host's
  admins to add you to a team); SSO authorisation needed (§5).
- **Settings → Account** shows the signed-in identity (avatar, name, @login), **Sign out** (which
  deletes the token from the vault), and the SSO re-authorise hint when it applies.

**Chip and strip.** A remote chip looks like any other workspace chip, plus a **remote glyph**
(cloud) and a small tier badge (`read` / `steer` / `session`). Its status dot follows
`/healthz`. Its ⋮ menu has Rename locally, Copy host URL and Forget. It has no Pause, Stop or Edit
spec, because the deployment owns those.

**Sessions with owners.**
- The left rail's Sessions list for a remote workspace shows each row's owner (avatar + name +
  @login) and a **Mine / Everyone** filter, defaulting to Everyone.
- **New session** appears only for the `session` tier.
- A session the viewer can't type into (`read` tier) opens its tab **watch-only**: input is
  disabled and the tab is labelled "watching".
- Cost in the Observability rail is per owner when grouped.

**Automations of a remote workspace.**
- The Inbox's Automations, Activity and Needs approval views include remote automations,
  proposals and todos through federation, each badged with the workspace chip.
- Run now…, enable/disable, Edit YAML, Approve/Reject and todo updates are RPCs to the host. For a
  `read` viewer they're disabled, with a tooltip naming the needed tier.
- The "Draft with Claude" composer can target a remote workspace's own sessions, when the viewer
  has `steer`.
- Desktop notifications for remote items go through the local notification policy (§8
  *Notifications*): pushed `inbox:changed` events feed the same `notifyPolicy.ts`, so rules,
  pauses and downtimes apply.

**Degraded state.** When a host is unreachable:
- its chip renders dimmed and inert (`unreachable`, as with a Docker outage, #380);
- a slim banner names it ("*review-bot* unreachable: its sessions and automations are hidden until
  it's back");
- federated views show local data plus a "1 source unavailable" note.

Nothing remote is shown stale, because remote data is live-only.

## 9. Security model changes

- **What crosses the network**, always to a host the user added and always under the user's own
  bearer token:
  - RPC requests and responses for that host's own workspace;
  - terminal frames for sessions on that host;
  - server-push events;
  - published transcripts (scrubbed) for workspaces the user opted in.

  Vault contents, local transcripts of non-published workspaces, `config.json` and local inbox
  rows never leave the desktop.
- **Token storage.** The GitHub token is stored in the safeStorage vault in a reserved app-level
  bag (`"__app": { "identity:github": … }`) and is never sent to the renderer. `RemoteClient`
  (main) attaches it to requests. The renderer sees only `{login, name, avatar}`. A degraded
  vault (no keychain) means sign-in isn't persisted, and the user signs in each run.
- **Who can do what** is the tier table in §5, enforced per route and per frame on the host. The
  desktop greys out controls too, but only as UX, not enforcement.
- **Publish scrubbing** happens on both sides (§7). Partitions are derived from the verified
  identity, so nobody can write into someone else's partition. Publishing is opt-in per workspace
  and off by default.
- **Shared Linux user.** Sessions in a remote container aren't isolated from each other (§4). The
  `session` tier is owner-equivalent, and `steer` lets someone type into any session, so it's
  nearly as strong. Grant them accordingly.
- **The host's MCP server** keeps the §11 invariants: read-only, scoped visibility, identity
  ambient from the socket. On Postgres, `query` isolation is role plus RLS (§7).
- **Local workspaces don't change.** Their MCP sockets, the host-private `<userData>` zone, the
  vault, Docker isolation and committee gates all stay as they are. A remote workspace is never a
  committee target or manager in the first release (`decideControl` keeps requiring
  `kind: 'container'`).

## 10. File sharing

Files are shared through the existing **`git-sync` loadout** (§8 *Sharing folders between nodes*,
spec `2026-10-30-git-synced-folders-design.md`). A remote workspace installs it like any node, and
its clones live on the workspace's shared file storage under `/shared/<name>`. Its author
identity is its GitHub identity: the bot's `GIT_SYNC_IDENTITY` for an App token, or `gh api user`
for a person. The same login that §5 uses for grants and §4 for attribution names the author
folder. Nothing in this spec changes git-sync.

## 11. Implementation sub-projects

Ordered. Each one ships on its own and leaves the app working.

1. **(a) Async store layer + local Postgres choice.**
   - Move `db.ts`, `inboxDb.ts` and the stores on them to an async Kysely store with SQLite and
     Postgres dialects.
   - Add per-backend vector search (brute force / pgvector), the app-managed Postgres container,
     and the setup choice.
   - MCP `query` isolation on local Postgres (role + RLS) ships here, because the local Postgres
     choice needs it.
   - *Ships:* users can pick Postgres locally. SQLite behaviour is unchanged.
2. **(b) Identity provider + GitHub device flow + grants.**
   - The `IdentityProvider` interface, the `github` provider (device flow, `/user`, `/user/teams`,
     SSO detection), machine tokens, grant resolution (team/login → tier) as a pure tested module,
     and the vault `__app` bag.
   - Settings → Account sign-in and sign-out.
   - *Ships:* a signed-in identity on the desktop, and the grant module ready for hosts.
3. **(c) `fleet-host` + `kind: 'remote'` + transport.**
   - The `src/host/` entry point, the `runner-host` image variants, the lease, Postgres on the
     host, and the endpoint (`/healthz`, `/whoami`, `/rpc`, `/attach` with viewer fan-out,
     `/events`) with per-route and per-frame tier checks.
   - On the desktop: `remote.ts`, `RemoteClient`, add-remote UX, the chip, watch-only tabs and the
     unreachable banner.
   - Remote automations run on the host. On the desktop, the first release reaches them through
     the workspace's own sessions; the Inbox integration is (g).
   - *Ships:* attach to and work in a remote workspace.
4. **(d) Federated reads + MCP isolation on the host.**
   - `FederatedReader` across Sessions, Observability and `search_transcripts`-backed UI, with
     merge, origin badges and unavailable sources.
   - Role + RLS `query` isolation on the host's Postgres.
   - *Ships:* one merged history and search view across local and remote.
5. **(e) Transcript publish.**
   - The manifest `publish` block and form control.
   - The client scrubber, the ingest-driven publisher with cursor, and `POST /publish` with
     server scrub, owner partitions and idempotent inserts.
   - Host-side embedding of published rows, MCP visibility of partitions, and `usage_events`
     origin with the "own marks don't count" rule.
   - *Ships:* remote agents search people's opted-in transcripts.
6. **(f) Per-session attribution + session ownership UI.**
   - `session_owners`, the `--settings` attribution layer (verified at the pinned claude version)
     with the env + instructions fallback, and per-owner cost.
   - The Sessions pane's avatar + name + @login and the Mine / Everyone filter.
   - *Ships:* multi-person remote workspaces with credited work.
7. **(g) Remote automations UX.**
   - Federated Automations, Activity and Needs-approval views with chip badges; tier-gated
     actions as RPCs.
   - "Draft with Claude" against a remote workspace, and local notification policy for pushed
     remote items.
   - *Ships:* remote automations are seen and acted on like local ones.

Dependencies: (c) needs (a) (the host's Postgres store) and (b). (d), (e), (f) and (g) each need
(c) and are independent of each other, although (e)'s value shows best after (d).

## 12. SPEC.md impact

Each change lands in the same commit as the sub-project that causes it.

- **(a):**
  - §4 *Stack*: Kysely, `pg`, the optional Postgres container.
  - §7 *JSONL→SQLite cache* and *Inbox store*: dialect-neutral schema, per-dialect migrations,
    pgvector.
  - §6 *Settings*: the `store` config key.
  - §11 *In-container SQLite access via MCP*: role + RLS isolation on Postgres.
  - §8 *Startup*: the store choice.
- **(b):**
  - §6: the `identity:*` channels (sign-in start/poll/status/sign-out).
  - §7 *Vault layout*: the `__app` bag.
  - §9: token handling.
  - §8: Settings → Account.
- **(c):**
  - §1/§3: remote workspaces, replacing "not multi-user" / "not a remote orchestrator" with the
    precise boundary. The desktop still never drives remote Docker.
  - §5: `fleet-host` in the architecture diagram.
  - §6 *Workspace*: `kind: 'remote'` semantics per channel.
  - §7 *Workspace manifest*: `WorkspaceKind` gains `'remote'` plus the `remote` block.
  - §7 *Backend dispatch*: `remote.ts`.
  - A new §7 subsection *Remote host*: lease, storage, the host DB tables, the transport routes
    and tiers.
  - §4 *Runner image build*: the `runner-host` variants.
  - §8: adding a remote workspace and the unreachable banner.
  - §9: the network and trust rules.
- **(d):**
  - §6 *Observability* / *Sessions*: federated results with `origin` and `unavailable`.
  - §11 *Fleet-state MCP*: host-side isolation.
- **(e):**
  - §7: the manifest `publish` block, the publish partition tables, `usage_events.origin`.
  - §9: publish scrubbing.
  - §11 *Fleet-state MCP*: partition visibility and the `mark_useful` counting rule.
- **(f):**
  - §7: `session_owners`.
  - §5 *Sessions pane*: owners and the filter.
  - §8 *Attach a terminal*: watch-only tabs.
  - §4 *How claude authenticates*: the attribution layer.
- **(g):**
  - §8 *Automations* / *Proposals* / *Notifications*: remote items, tier-gated actions.
  - §6 *Automations*: the channels as host RPC.

## 13. Open questions

1. **How a remote host is created and registered.** This spec assumes the host already exists and
   the desktop adds it by URL. *Recommendation:* claude-fleet publishes the `runner-host` images,
   a reference deployment (one Helm chart and one docker-compose file: one replica, `Recreate`,
   an RWX volume, Postgres, host config from a secret), and a `fleet-host init` command that
   prints the workspace id and a ready-to-paste URL. There's no desktop-driven provisioning.
2. **Terminal size with several viewers.** One PTY has one size, but viewers' panes differ (the
   width-agreement problem of §7 *Local backend*). *Recommendation:* the PTY follows the most
   recent `steer` viewer that sent `INPUT` or `RESIZE`, and other viewers render at that size
   (scrolling horizontally) with a "sized for @login" hint.
3. **Whether local workspaces' MCP tools federate to remote hosts.** Federation (§7) covers desktop
   UI reads. A local session's `search_transcripts` currently sees local data only.
   *Recommendation:* defer. If it's added later, gate it per local workspace (opt-in), query with
   the signed-in user's token, and cap the result by that user's tier.
4. **Unpublishing.** Publish is append-only, but a person may need to withdraw a session they
   published by mistake. *Recommendation:* an owner-only `DELETE /publish/<sessionId>` that drops
   the caller's own partition rows and their embeddings. It doesn't break append-only for anyone
   else.
5. **Caching remote data later.** Live-only is decided for now. If offline viewing becomes
   necessary, *recommendation:* a read-through cache of recent session metadata and summaries
   (not raw events) with a visible "as of" time, keeping the host authoritative.
6. **Requiring TLS.** Plain `http://` is allowed for now (§6), relying on network-level encryption.
   *Recommendation:* revisit before any deployment where the client path isn't encrypted by a mesh
   or tunnel. The options are refusing non-loopback `http://`, or an explicit per-host opt-in.
