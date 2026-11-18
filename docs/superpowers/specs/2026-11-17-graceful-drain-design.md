# Graceful drain of remote fleet-host pods — design

Status: approved by the owner (Troy) 2026-11-17. Decisions D142–D157 are recorded in the plan (`docs/superpowers/plans/2026-11-17-graceful-drain.md`) and summarised here.

## Goal

When Kubernetes replaces the workspace pod (an image rollout, a node drain, an eviction), running claude turns finish instead of being killed, automation runs that are cut off re-run once, and every open tab comes back on the new pod by itself. The host pod's own restart gets shorter and better-ordered.

## Scope

- **Workspace pod** (`fleet-host-entry workspace`): a broker **drain**, triggered by a `preStop` hook.
- **Host pod** (`fleet-host-entry host`): no session drain; shutdown hardening only.
- **fleet-host**: learns about the drain, pauses automation dispatch, records interrupted runs and drained sessions, re-runs once, tells desktops.
- **Desktop**: shows the workspace as restarting, makes its tabs read-only, and resumes the open tabs on the new pod.
- Out of scope: `single` mode, desktop containers and local workspaces (no drain; the control socket is off). Draining the host pod's viewers onto a second replica (one holder only).

## Today

- `docker/host/fleet-host-entry workspace` `exec`s the broker; tini forwards SIGTERM; `broker/cmd/broker/main.go` closes the listener and calls `mgr.CloseAll()`, which closes each PTY and `SIGKILL`s claude. A turn in progress is lost and every tab shows "claude session ended".
- fleet-host sees the broker connections drop. An automation fresh step's `freshState` then reads `missing`/`ended`, and the runner records the step **succeeded** (it can't tell a kill from an exit).
- fleet-host's own SIGTERM path (§7 *Shutdown and crashes*) is bounded per step (worst case ~17 s) but has no overall deadline, and `/healthz` stays 200 until the process exits.

## Workspace pod drain

### Trigger (D142, D143)

- The workspace container gets `lifecycle.preStop.exec.command: ["/usr/local/bin/broker", "drain"]`. `broker drain` is a subcommand of the broker binary. It connects to the broker's **control socket**, sends `DRAIN`, prints each state line, and exits 0 when the drain is `done` (or the socket closes: the broker is gone). It exits 1 when it can't connect.
- **Control socket:** `/run/broker/ctl.sock`, mode 0600, opened only when `CLAUDE_FLEET_BROKER_DRAIN=1`. `fleet-host-entry workspace` sets that variable; `single`, desktop containers and local workspaces don't, so they have no control socket and no drain. `CLAUDE_FLEET_BROKER_CTL_SOCKET` overrides the path (tests).
- **Why a Unix socket and a CLI:**
  - A Unix socket can't be reached from another pod, so drain is never on :7070. The mesh gates :7070 to the host SA only, and drain must not be reachable there: fleet-host has no reason to drain, and a preStop hook has no mesh identity to dial :7070 with.
  - kubelet's `httpGet` hook can't use a Unix socket, so the hook is an `exec`.
  - A loopback HTTP port was rejected: it adds a listener whose reachability depends on how the sidecar forwards inbound traffic, which is the class of exposure D96 rules out.
  - Sessions run as the broker's uid (1000) and can open the socket, so `DRAIN` checks the caller's ancestry (§9 below): a drain never ends on its own, so a session draining its pod would leave it unusable until the pod is deleted.
- **SIGTERM also drains** when `CLAUDE_FLEET_BROKER_DRAIN=1`. If the hook fails (a bad image, the binary missing), kubelet sends SIGTERM early and the drain still runs, with its deadlines counted from then. While draining, a further SIGTERM is logged and ignored. SIGINT still closes everything at once, as an escape hatch for operators.
- After `done` the broker waits for SIGTERM, then exits 0. When SIGTERM started the drain, the broker exits as soon as the drain is `done`.
- **Readiness:** `readinessProbe.exec.command: ["/usr/local/bin/broker", "ready"]` exits 0 only while the broker is `serving`. It fails before the broker listens (the mesh wait) and from the first moment of a drain.

### State machine (D146)

`serving` → `draining` → `done`. `broker/internal/drain` owns it; it is pure apart from an injected clock, session target and activity reader.

1. **Start** (the `DRAIN` op or SIGTERM; idempotent). It records `startedAt`, `softAt = startedAt + soft` and `hardAt = startedAt + hard`, and freezes input (below). The first pass runs 2 s later, so fleet-host and desktops hear `draining` before any session closes. After that it passes every 1 s.
2. **Each pass:**
   - An interactive session whose activity is `idle` or `waiting` is closed: SIGTERM to its process group, then SIGKILL after 5 s. Its end reason is `drain-idle`, or `drain-interrupted` if it was sent Esc.
   - A busy interactive session is left alone until `softAt`. From then on it gets Esc (`\x1b`) once, and again every 60 s while it stays busy. claude stops at a safe point and goes idle, and the next pass closes it.
   - A **headless** session (an automation fresh step) is busy until it exits. At `softAt` its process group gets SIGINT, once. If it then exits with a non-zero status or by a signal, the end reason is `drain-interrupted`. If it exits 0, the reason is `exit`: it finished.
   - When no session is alive, the phase becomes `done`.
3. **Hard stop at `hardAt`:** every PTY still alive is closed (the current `CloseAll`) with reason `drain-killed`, and the phase becomes `done`.
4. Ended sessions stay listed (`LIST`, `STATE`) with their end reason until the broker exits, so fleet-host can read why each one ended.

A session's in-progress turn is lost only if it is still running at the soft deadline (Esc) or the hard stop. Otherwise the turn finishes, and the transcript on the `claude` EFS holds it for the resume.

### Busy and idle (D144)

- The broker reads claude's own status file, `$HOME/.claude/sessions/<pid>.json`, for each session's root pid. The broker starts claude directly, so the PTY's root pid is claude's pid. This is the authoritative source from §5 *Authoritative session status* (#286): `status` is `busy`, `idle` or `waiting`.
  - `idle` means the turn ended, which is what the `Stop` hook reports.
  - `waiting` means claude is waiting for the person: an AskUserQuestion prompt (the hook's `waiting=true`), a permission prompt (no hook covers this), or idle input.
- `CLAUDE_FLEET_BROKER_STATUS_DIR` overrides the directory (tests); the default is `$HOME/.claude/sessions`.
- A missing, unreadable or malformed file, or one whose `pid` doesn't match, counts as **busy**. The drain then waits rather than kill a turn it can't see.
- **Why not the hooks:**
  - The hook signals (`input-wait-report.sh` on `Stop`, `UserPromptSubmit` and AskUserQuestion) go to the `signal_input_wait` MCP tool. The host MCP doesn't serve that tool (§7 *Host MCP*), so on a remote host they reach nothing today.
  - The hooks don't cover permission prompts.
  - Feeding hook state through fleet-host would make the drain depend on the host pod, which may itself be restarting.
  - claude's status file is written by the same process the hooks observe, and it is local to the broker.
- fleet-host feeds the broker nothing.

### Input freeze and CREATE (D147)

- While the phase isn't `serving`:
  - `INPUT` on a PTY channel is dropped, and the broker answers `NOTICE {channel, code: "draining"}`, at most once per channel every 5 s.
  - `CREATE` answers `CREATED {ok: false, error: "draining: the workspace is restarting"}`.
  - `ATTACH`, `DETACH`, `RESIZE`, `LIST`, `CLOSE`, `KILLPORT`, `LISTPORTS`, `STATUS` and `WATCH` keep working. Output keeps streaming, and a person can still end their own session.
- The drain's own Esc bytes go straight to the PTY, not through `INPUT`.
- fleet-host refuses the same frames at the hub as soon as it knows about the drain (D148), so in practice the broker's refusal covers only the moment before fleet-host hears of it.

### How fleet-host learns about the drain (D148)

- New broker ops on the main listener (:7070, so the mesh still gates them to the host SA):
  - `STATUS` → `STATE`.
  - `WATCH`: the broker sends `STATE` at once, then again on every change, on that connection until it closes.
- `STATE` is `{instance, phase, startedAt?, softAt?, hardAt?, sessions: [{id, alive, headless, ended?}]}`. `instance` is 16 random hex characters, minted at broker start. `ended` is one of `exit`, `drain-idle`, `drain-interrupted`, `drain-killed`, present once the session has ended.
- fleet-host holds **one persistent WATCH connection** (`brokerOps.watch`), reconnecting with a 1 s backoff that doubles to 10 s.
  - Chosen over polling `STATUS`: once the pod is terminating, new connections to it may not be routed (Service endpoints drop terminating pods; see *Pod spec*). A connection opened before the drain keeps working.
- `DrainGate` (`src/host/drainGate.ts`) reduces the stream to one of four states:
  - `serving`;
  - `draining`;
  - `unknown`: not connected, or no `STATE` yet;
  - `legacy`: connected, but no `STATE` within 5 s. This is an older broker without the op, and it is treated like `serving`.
- The gate publishes the sticky `/events` channel `broker:drain` with `{phase, softAt, hardAt, instance}` on every change. A new `/events` subscriber gets the last value at once. `phase` is `serving`, `draining` or `unknown`; `legacy` is published as `serving`.

### Automations during a drain (D149)

Dispatch is paused unless the gate is `serving` or `legacy`.

- The scheduler tick is skipped. Due slots aren't consumed, so the first tick after the drain fires them once, as the existing one-catch-up rule does.
- An event-triggered start whose debounce fires while paused is re-armed for 30 s.
- A manual, MCP or RPC start is refused with `<name> can't start now: the workspace is restarting; try again when it's back`.
- A run that is between steps waits before its next fresh step until the gate is `serving` again: on the new pod, up to 45 min, after which the step fails. Its earlier steps are not repeated. The wait counts against the run's own timeout only at the next step boundary, as today.
- A fresh step already running keeps running. It is a headless session and drains as above.

### Interrupted runs and the one re-run (D150, D156)

- When a fresh step's session ends `drain-interrupted` or `drain-killed`:
  - `freshState` returns `interrupted`.
  - The runner records the step and the run as `interrupted`, with error `<step>: interrupted by host restart`. This is not `failed`, and it is distinct from `the app quit mid-run`, which `recover()` records for runs cut off by a host restart.
  - No new run status is added, so desktop validators are unchanged.
- **Retry ledger** `host_run_retries`, host migration track v5:

  ```sql
  CREATE TABLE host_run_retries (
    run_id TEXT COLLATE "C" PRIMARY KEY,
    automation_id TEXT COLLATE "C" NOT NULL,
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending', 'started', 'skipped')),
    retry_run_id TEXT COLLATE "C" UNIQUE,
    created_at BIGINT NOT NULL,
    settled_at BIGINT,
    note TEXT
  );
  ```
- **Marking a run pending.** The gate sees a session `auto-<runId>-<stepId>` end `drain-interrupted` or `drain-killed`. Any holder can see this: the one that was running the run, or the next one after a host restart.
  - It inserts `(runId, pending)` with `ON CONFLICT DO NOTHING`, unless the run is itself a retry (a `retry_run_id` row names it, or its trigger has `retryOf`).
  - If the run reads `interrupted` with `the app quit mid-run`, its error is rewritten to `interrupted by host restart`.
- **Dispatch.** When the gate enters `serving`, and once at holder start, each pending row is claimed first: `UPDATE … SET state = 'started' WHERE state = 'pending' RETURNING`. Then the run is started with the original trigger plus `retryOf`, and the original args. `retry_run_id` is recorded.
  - The retry skips the per-minute rate cap and keeps the concurrency rules.
  - A row whose original run isn't `interrupted`, whose automation is gone or disabled, or which is older than 24 h becomes `skipped`, with a note.
  - Claiming first makes the re-run at-most-once, even across a holder change.
- **No double posting.** The retry starts from the beginning. The original was cut off before it ended (a non-zero exit after SIGINT, or SIGKILL), and reviews post at the end, so nothing was posted. A session that exited 0 counts as finished and is never retried.
- **No loop.** A retry that is itself interrupted is recorded `interrupted` and is not retried again.
- **If the host pod also restarts during the drain:**
  - The new holder's `recover()` marks the run `interrupted` (`the app quit mid-run`).
  - If the new fleet-host's WATCH reaches the draining broker, it sees the session's drain end, rewrites the reason and queues the re-run.
  - If the session instead finishes on its own, it posts as today, and the run keeps the `app quit` reason.
  - If the new fleet-host can't reach the draining pod, that run isn't re-run. This is the gap the *Pod spec* routing check closes.

### Interactive sessions after the restart (D151)

- **The host records what was running.** While the gate is `draining`, every `STATE` upserts `host_drained_sessions` (host track v5) for each interactive session (not `auto-*`) that is alive or ended with a `drain-*` reason. Each row maps the broker id to the claude session id through the newest `session_owners` row for that broker id.

  ```sql
  CREATE TABLE host_drained_sessions (
    instance TEXT COLLATE "C" NOT NULL,
    broker_session_id TEXT COLLATE "C" NOT NULL,
    session_id TEXT COLLATE "C" NOT NULL,
    reason TEXT COLLATE "C",
    drained_at BIGINT NOT NULL,
    PRIMARY KEY (instance, broker_session_id)
  );
  ```

  Rows older than 24 h are deleted at holder start and hourly.
- **New RPC** `sessions:drained` (`read`) → `{ rows: [{ brokerSessionId, sessionId, drainedAt }] }`: the newest row per broker id in the last 24 h, at most 200. Without `db:` it answers `{ rows: [] }`.
- **The desktop resumes the tabs it has open.**
  - On `broker:drain` → `serving`, after a `draining` phase, each open tab of that workspace whose session ended during the drain re-runs its attach.
  - `attachRemotePty` answers `no such session` as today. Before creating a session, it asks `sessions:drained` for the tab's broker id. On a match it sends `CREATE` with that broker id and `--resume <sessionId>`. claude's `--resume` keeps the session id, and fleet-host's pin check accepts an id that has an owner row.
  - If another desktop resumed it first, `CREATE` answers `session: id already in use`, and the tab `ATTACH`es instead. Two viewers of one session therefore never start two claudes.
  - A desktop that was closed during the drain resumes its tabs the same way when they next attach.
  - A tab whose broker id isn't in the list behaves as today.
- **Why both lists.**
  - Only the host knows the claude id for every session, through its owner rows. A tab doesn't always know it: a second viewer, or a session started from another desktop.
  - Only the desktop knows which sessions a person still has open. If the host resumed sessions on its own, it would start claudes nobody is watching, under an identity it would have to choose.
- **Tier.** Resuming is a `CREATE`, so it needs `session`. A `read` or `steer` viewer reattaches when someone with `session` resumes the session (the existing `sessions:changed` join path).

### What a viewer sees (D152)

- The chip's sub-line reads `restarting · input paused`, in the warn tone.
- The pane banner:
  - while draining: "The host is restarting. Running turns finish first (until HH:MM); idle sessions close now. Typing is paused. Tabs resume on their own when the host is back."
  - after `softAt`: "The host is restarting. Stopping turns that are still running."
  - `unknown`: "Waiting for the workspace pod…".
- Tabs are read-only (the `paused` tag, as for `watching`): keystrokes are dropped locally and output keeps streaming.
- If a key slips through, the host's `NOTICE` prints `[host is restarting; your input wasn't sent]` in yellow, locally, without touching the session.
- A tab whose session ends during the drain shows a "Waiting for the host to restart; this tab resumes by itself" card instead of "claude session ended".
- When the new pod serves, the card goes away and the tab resumes.

### Settings (D153)

| Env (workspace pod) | Default | Meaning |
|---|---|---|
| `CLAUDE_FLEET_BROKER_DRAIN` | unset; `fleet-host-entry workspace` sets `1` | opens the control socket and makes SIGTERM drain |
| `CLAUDE_FLEET_BROKER_DRAIN_SOFT` | `30m` | Go duration; Esc / SIGINT to sessions still busy |
| `CLAUDE_FLEET_BROKER_DRAIN_HARD` | `35m` | Go duration; close everything |

- The values must satisfy 1 s ≤ soft < hard ≤ 24 h. Any other value, or a malformed one, makes the broker exit 1 at start, naming the variable.
- These are **operator settings in the pod spec**. The owner's rule against hand-editing env or JSON applies to user-facing settings, and these are set by the people who run the cluster, next to `terminationGracePeriodSeconds`, which must exceed the hard deadline by at least 60 s.
- The timing data supports the defaults: agent reviews have a median of 11.4 min, p95 21.2 min and a maximum of 36.9 min (thread 003). A run that started just before the drain almost always finishes inside 30 min.

## Host pod (D154)

- **(b) Not ready at once.** The first statement of `shutdown()` sets `draining`, so `/healthz` answers 503 `{status: "draining", lease, db, mesh?}` from then on. Authenticated routes answer 503 `shutting down`, as today.
- **(a) Overall deadline.** `SHUTDOWN_DEADLINE_MS` = 20 s, started with the shutdown. When it fires, fleet-host logs `shutdown deadline passed; exiting` and exits with its code. Whatever was released by then is released; the lease expires on its TTL otherwise. The existing per-step bounds (stores 5 s, lease 4 s, server 1 s, credential socket 2 s, hub 5 s) stay.
- **(c)** `preStop: exec: ["sleep", "5"]`, so the endpoints are removed before SIGTERM. The image has coreutils `sleep`.
- `terminationGracePeriodSeconds: 45`: 5 s preStop + 20 s deadline + margin.
- No session drain: PTYs live in the workspace pod, and `hub.shutdown()` only detaches.

## Istio (D155)

- **(d) The proxy stops after the app, on both pods.**
  - **Preferred:** Kubernetes native sidecars (Kubernetes ≥ 1.29). Either istiod runs with `ENABLE_NATIVE_SIDECARS=true`, or the pod template has the annotation `sidecar.istio.io/nativeSidecar: "true"` where the cluster's Istio honours it. Work confirms which. With native sidecars kubelet stops the main container first (preStop included) and the proxy last.
  - **Fallback:** `proxy.istio.io/config` with `terminationDrainDuration` sized to the app's shutdown (host 40 s, workspace 2390 s) and `proxyMetadata.EXIT_ON_ZERO_ACTIVE_CONNECTIONS: "true"`.
    - The workspace pod's proxy then lives through the 35 min drain while fleet-host's connections stay open.
    - In this mode pilot-agent gets SIGTERM at the same time as the app and starts draining its listeners. Whether new inbound connections are still accepted during that drain is version-dependent, and Work checks it.
- **The workspace Service sets `publishNotReadyAddresses: true`.** The draining pod is not ready (its readiness fails) and is terminating. With this flag the EndpointSlice keeps it `ready`, so fleet-host can still dial it: a host pod restarted mid-drain, or a viewer reconnecting.
  - Whether the cluster's Istio sends such endpoints to the host pod's proxy is a cluster check (Appendix B).
  - If it doesn't, a host pod that restarts mid-drain can't see the drain. It pauses dispatch (`unknown`), its viewers see "Waiting for the workspace pod…", and runs interrupted in that window aren't re-run (D156).

## Failure modes

| Case | Outcome |
|---|---|
| preStop can't reach the broker | exits 1; kubelet sends SIGTERM; the broker drains on SIGTERM (D143) |
| A second `DRAIN` or SIGTERM | no-op; the deadlines don't move |
| SIGINT during a drain | `CloseAll` at once, then exit (operator escape) |
| The broker crashes mid-drain | the container ends; fleet-host's gate goes `unknown`; recorded drained rows still resume tabs on the new pod |
| The host pod restarts mid-drain | D156 above; drained rows persist in Postgres |
| Status file never written (another claude version) | sessions count as busy; Esc at soft, kill at hard; the drain takes up to 35 min |
| A session goes busy again after being judged idle | it is re-read just before closing; still idle → close; busy → left until soft |
| Grace period shorter than hard | kubelet SIGKILLs at the grace; the turns still running are lost (the Appendix pins 2400 s) |
| Old broker (no WATCH) | gate `legacy`; no drain; dispatch as today |

## Security (§9 additions)

- The control socket is a Unix socket, 0600, owned by uid 1000, only in the workspace pod. It isn't reachable from other pods or from the mesh. `/run/broker` is `1777`. `STATUS` is open to any caller.
- `DRAIN` on the control socket is refused unless the caller's process chain reaches ppid 0 (exec'd by the container runtime); a session can still SIGTERM the broker (same uid), which drains and then restarts the container, so it can't leave the pod stuck.
  - The chain is read from `SO_PEERCRED`, then `/proc/<pid>/stat`, at most 64 hops. Passing a session root, the broker or pid 1 refuses it (`NOTICE drain-refused`), so a session's processes, including orphans reparented to pid 1, can't drain; kubelet's preStop and `kubectl exec` can. An unreadable chain is refused.
  - **Known residual:** a session runs as the same uid as the exec'd readiness probe (`broker ready`, every 5 s) and can `ptrace` it into sending `DRAIN`. Appendix B recommends `kernel.yama.ptrace_scope ≥ 1` or a seccomp profile that denies `ptrace`.
- `STATUS` and `WATCH` are on :7070 under the existing mesh policy (host SA only). They expose session ids and drain timings, which fleet-host already sees through `LIST`.
- `DRAIN` on :7070 is refused (`unknown frame`, dropped), so only the control socket starts a drain.
- `STATE`, `NOTICE` and `broker:drain` carry no session content. Desktops treat `broker:drain` fields as untrusted: the phase must be one of the three, the times must be safe integers, and the strings are one-lined and capped at 32.
- `sessions:drained` is `read` tier and is limited to the hosted workspace (the SQL names the `host_meta` id), like `history:*`.

## Testing

- **Go:** the drain state machine with fake sessions, a fake clock and a fake activity reader (idle closed at once; busy waits; Esc at soft and every 60 s; headless SIGINT; exit-0 versus interrupted; hard stop; done; idempotent start); the status-file reader; the session end reasons with `/bin/sh` stand-ins; server gating (INPUT → NOTICE, CREATE refused, WATCH pushes, DRAIN refused on the main listener); the control socket and the CLI (`drain`, `ready`); env parsing.
- **Entry script:** `fleet-host-entry workspace` exports `CLAUDE_FLEET_BROKER_DRAIN=1`; the fake broker's `drain` subcommand is what the preStop runs (`docker/host/fleet-host-entry.test.sh`). `docker/host/split.test.sh` (CI, Docker) runs a real drain end to end: a busy `sh` session survives, an idle one closes, `broker drain` returns when everything has ended, and `broker ready` flips.
- **Host:** `DrainGate` transitions and sticky events; hub refusals; dispatch pausing (tick skipped, events re-armed, manual refused, between-step wait); interrupted-run marking and re-run idempotency (pg: one re-run per run across two "holders", none for a retry, skipped when stale); drained-session recording and `sessions:drained`; `/healthz` draining; the 20 s deadline.
- **Desktop:** the codec (new frames); `attachRemotePty` resume via the drained list and the `id already in use` → ATTACH path; NOTICE text; the renderer helpers (chip, pane rules, banner, resume decision).
- **Cluster (Work, Appendix B):** native sidecar order, routing to a terminating workspace pod, a real rollout with a busy session, readiness flip.

## SPEC.md changes (same PR as the code)

- §4 *Supervision* (`workspace` sets `CLAUDE_FLEET_BROKER_DRAIN=1`), the broker frame table (`STATUS`/`STATE`/`WATCH`/`DRAIN`/`NOTICE`, `CREATE.headless`, `SESSIONS[].ended`), *Broker transport* (the control socket).
- §7 *Remote host*:
  - *Env contract*: the drain variables.
  - *Health*: `draining`.
  - *Shutdown*: the 20 s deadline, preStop.
  - *Host automations*: pausing, `interrupted by host restart`, the re-run.
  - *Host store*: track v5.
  - *Routes*: `sessions:drained`.
  - */events*: `broker:drain`, sticky.
  - A new *Workspace pod drain* subsection: the sequence, the reasons, and "a turn is lost only past the soft deadline".
- §8: a new flow, *Remote workspace restarting*.
- §9: the control socket, and `DRAIN` refused on :7070.
- §11 *Remote host: what remains*: the routing check, the native-sidecar check, and the SIGINT exit-status check.

---

## Appendix A: pod-spec snippets for platform-ops#36

Additions to the 2026-11-11 two-pod handoff. Names in `<>` are infra's.

```yaml
# Host pod (Rollout fleet-agent) — template additions
metadata:
  annotations:
    sidecar.istio.io/nativeSidecar: "true"        # or istiod ENABLE_NATIVE_SIDECARS=true; see fallback below
spec:
  terminationGracePeriodSeconds: 45
  containers:
    - name: host
      lifecycle:
        preStop:
          exec: { command: ["sleep", "5"] }       # endpoints go before SIGTERM
      readinessProbe:
        httpGet: { path: /healthz, port: 8080 }  # 503 {status:"draining"} from SIGTERM on
        periodSeconds: 5
        failureThreshold: 1
```

```yaml
# Workspace pod (Deployment fleet-agent-workspace) — template additions
metadata:
  annotations:
    sidecar.istio.io/nativeSidecar: "true"
spec:
  terminationGracePeriodSeconds: 2400             # hard stop 35 min + margin
  containers:
    - name: workspace
      env:
        - { name: FLEET_HOST_CRED_ADDR, value: "<host-internal-svc>.platform-ops.svc:8081" }
        # Operator settings (defaults shown); 1s <= soft < hard <= 24h, hard + 60s <= grace.
        - { name: CLAUDE_FLEET_BROKER_DRAIN_SOFT, value: "30m" }
        - { name: CLAUDE_FLEET_BROKER_DRAIN_HARD, value: "35m" }
      lifecycle:
        preStop:
          exec: { command: ["/usr/local/bin/broker", "drain"] }   # blocks until drained (<= hard)
      readinessProbe:
        exec: { command: ["/usr/local/bin/broker", "ready"] }     # fails while draining
        periodSeconds: 5
        failureThreshold: 1
---
apiVersion: v1
kind: Service
metadata: { name: <workspace-svc>, namespace: platform-ops }
spec:
  type: ClusterIP
  publishNotReadyAddresses: true                  # keep the draining pod dialable by fleet-host
  selector: { app: <workspace-pod-label> }
  ports: [{ name: tcp-broker, port: 7070, targetPort: 7070, appProtocol: tcp }]
```

Fallback when native sidecars aren't available (instead of the `nativeSidecar` annotation):

```yaml
# Host pod template
metadata:
  annotations:
    proxy.istio.io/config: |
      terminationDrainDuration: 40s
      proxyMetadata:
        EXIT_ON_ZERO_ACTIVE_CONNECTIONS: "true"
---
# Workspace pod template
metadata:
  annotations:
    proxy.istio.io/config: |
      terminationDrainDuration: 2390s
      proxyMetadata:
        EXIT_ON_ZERO_ACTIVE_CONNECTIONS: "true"
```

**Probe interplay:**
- Host: readiness `/healthz` goes 503 `draining` at SIGTERM. Liveness stays off (or `tcpSocket :8080`, per the handoff). The 5 s preStop lets the endpoint removal propagate before the app stops.
- Workspace: readiness `broker ready` fails from the start of a drain. `publishNotReadyAddresses` keeps the pod routable for fleet-host. Keep no liveness probe: a draining broker must not be restarted.
- The workspace Deployment stays `strategy: Recreate`. The new pod is created only after the old one has finished draining (up to 40 min), so a workspace rollout takes that long when sessions are busy, and about a minute when they are idle.
- An image bump that rolls both pods at once restarts the host in ≤ 25 s, while the workspace drains. The new host must reach the draining pod (Appendix B).

## Appendix B: cluster checks before relying on the drain

- `kubectl get pod <workspace> -o jsonpath='{.spec.initContainers[*].name}'` lists `istio-proxy` with `restartPolicy: Always` (native sidecar), or the fallback annotation is in place.
- Start a long busy turn in a remote tab, then `kubectl delete pod <workspace>`:
  - the tab turns read-only and the turn keeps streaming;
  - `kubectl get pod` shows `Terminating` and not ready;
  - when the turn ends, the session closes;
  - the preStop returns and the new pod starts;
  - the tab resumes on the same conversation.
- During that drain, restart the host pod (`kubectl delete pod <host>`). The new host's log shows `broker drain state` with `phase: draining` (it reached the terminating pod), and the desktop's banner comes back. If it shows `unknown` instead, the terminating pod isn't routable: report it, and roll the host pod only after the workspace pod has finished (a sync wave) until it is.
- An idle-only workspace: `kubectl delete pod` finishes within about 10 s.
- `kubectl exec <workspace> -- /usr/local/bin/broker ready; echo $?` prints 0 while serving.
- `kernel.yama.ptrace_scope` on the workspace nodes is `≥ 1` (`cat /proc/sys/kernel/yama/ptrace_scope` in the pod), or the workspace container runs a seccomp profile that denies `ptrace`. Otherwise a session can ptrace the exec'd readiness probe into sending `DRAIN` (§9 residual).
- `hostPID` pods: preStop DRAIN is refused (the chain reaches the host's pid 1); SIGTERM still drains (D143).
- In a workspace pod, an automation fresh step sent SIGINT (`kill -INT -<pgid>`) exits non-zero on the pinned claude. If it exits 0, report it (D145 depends on it).
