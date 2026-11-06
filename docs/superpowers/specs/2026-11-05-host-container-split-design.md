# Split fleet-host into a host pod and a workspace pod

**Status:** approved (Troy, 2026-11-06): two pods, broker transport D73. Infra: platform-ops#46 (Pod Identity roles `fleet-host`, `fleet-workspace`), tofumate#2502 (`infra-llmbot-viewonly`). Thread: `/shared/remote-agent-design/threads/001-kickoff.md`, 2026-11-06T17:25Z.
**Plan:** `docs/superpowers/plans/2026-11-05-host-container-split.md` describes the earlier one-pod layout and has to be rewritten for this spec before implementation.
**Replaces:** the "Known risk: fleet-host, the broker and every claude session share uid 1000" and "The shared uid also defeats the host's other controls" bullets in SPEC §9.

## 1. Problem

Today one container runs tini → `fleet-host-entry` → broker + fleet-host, and every claude session runs as uid 1000, the same uid as fleet-host, with the pod's AWS identity. A session at `steer` or above can:

- read the GitHub App key (`keyFile`, 0440 with `fsGroup: 1000`) and mint any token the installation allows;
- read `/proc/<fleet-host>/environ` and, where ptrace is allowed, its memory, which holds the bearer tokens of open sockets;
- kill fleet-host, or listen on :8080 while it restarts and collect reconnecting viewers' bearer tokens;
- use the pod's AWS identity to mint RDS IAM tokens and write to the host DB directly, bypassing the lease fence.

## 2. Decisions

- **Two pods (Option B), not one pod with two containers and audience-split IRSA (Option A).** Each pod gets its own SA and Pod Identity role, so the session side never holds the DB identity, the App key, the ConfigMap or viewers' bearer tokens, and shares no network or PID namespace with fleet-host and no volume but the transcripts (read-only on the host side). Cost: the broker, credential and MCP channels cross the network (D73).
- **D73. Broker transport: Istio mTLS plus an AuthorizationPolicy, nothing else.** PeerAuthentication `STRICT` on the broker port and an AuthorizationPolicy that allows only `cluster.local/ns/platform-ops/sa/fleet-agent`. The same pattern covers the host pod's credential and MCP ports (§4), with `fleet-agent-workspace` as the only allowed principal. No TokenReview, no shared secret, no NetworkPolicy requirement. Rejected:
  - TokenReview: an extra lock on top of the mesh; declined.
  - A shared secret: static, and readable by anything that can read the pod's env or volumes.
  - One pod with per-container IRSA audiences (Option A): superseded by two pods.
- **D71 (noted).** Host MCP `query` runs as `fleet_agent_query`, a fixed `LOGIN NOINHERIT` IAM login (`rds_iam`, no password) that `fleet-host bootstrap` provisions as a member of the RLS reader roles, not of `fleet_agent`. fleet-host connects as it with an RDS IAM token on its own small pool. The app role `fleet_agent` never gets `CREATEROLE`. The `fleet-host` role carries `rds-db:connect` for both logins (platform-ops#46 `d1774ca`); the `fleet-workspace` role has no RDS access.

## 3. Target

| | host pod | workspace pod |
|---|---|---|
| Deployment | Rollout, 1 replica, `maxSurge: 0`, `maxUnavailable: 1` (unchanged) | 1 replica, `Recreate`; two brokers behind one Service would split the session list |
| SA | `fleet-agent` | `fleet-agent-workspace` |
| Pod Identity role | `fleet-host`: `rds-db:connect` as `fleet_agent` and `fleet_agent_query` | `fleet-workspace`, chained by AWS profiles to `arn:aws:iam::<acct>:role/infra-llmbot-viewonly` (ViewOnlyAccess; deny `secretsmanager:GetSecretValue`, `ssm:GetParameter*`, `kms:Decrypt`) |
| command | `fleet-host-entry host` | `fleet-host-entry workspace` |
| uid:gid | 1001:1001 (`fleet-host`) | 1000:1000 (`fleet`) |
| runs | fleet-host: HTTP :8080, credential server, fleet-state MCP | broker, claude sessions, tools |
| holds | GitHub App key, ConfigMap, DB access, viewers' bearer tokens | `claude` EFS (rw), `workspace` EFS; no key, no DB access, no ConfigMap |
| transcripts | `claude` EFS subPath `projects`, read-only | writes them |
| listens | :8080, :8081 (credentials), :8082 (MCP) | :7070 (broker) |
| Istio sidecar | yes | yes |

**Ports and callers.**

| Port | Pod | Protocol | Allowed caller | Serves |
|---|---|---|---|---|
| 8080 | host | HTTP/WS | the ingress gateway's principal (viewers, Bearer) | `/healthz`, `/leader`, `/whoami`, `/rpc`, `/attach`, `/events` |
| 8081 | host | HTTP | SA `fleet-agent-workspace` | `POST /token` (GitHub App credentials) |
| 8082 | host | TCP, newline-delimited JSON-RPC | SA `fleet-agent-workspace` | fleet-state MCP; caller is the hosted workspace |
| 7070 | workspace | TCP, broker frames | SA `fleet-agent` | broker (session create, attach, list, ports) |

Nothing else is exposed. Sessions never reach :8080 directly or :7070 through the mesh. fleet-host never dials anything in the workspace pod except :7070. Inside the workspace pod a session reaches the broker on `127.0.0.1:7070` without passing the sidecar; it already shares the broker's uid, as before (§6).

**What crossed the old shared volume, and where it goes.**

| Old (`/run/fleet`) | Users | Now |
|---|---|---|
| `broker.sock` | fleet-host → broker | broker on TCP :7070 in the workspace pod; fleet-host dials `CLAUDE_FLEET_BROKER_ADDR` |
| `cred.sock` | sessions (`fleet-host-cred`, git helper, `gh` shim) → fleet-host | fleet-host serves the same HTTP API on :8081; `fleet-host-cred` posts to `FLEET_HOST_CRED_ADDR` |
| `mcp/mcp.sock` | sessions (`mcp-bridge.cjs`) → fleet-host | fleet-host serves the MCP on :8082; `--mcp-config` names `CLAUDE_FLEET_MCP_TCP` |
| transcripts (`claude` EFS) | sessions write, fleet-host ingests | unchanged: both pods mount the EFS PVC (ReadWriteMany), the host read-only |

The credential server stays in the host pod because it needs the App key. The MCP stays there because it needs the DB.

## 4. Design

**S1. Entrypoints.** `fleet-host-entry host|workspace|single`, one required mode. With no mode the script prints usage and exits 2. Jobs that pass `args: ["fleet-host", …]` (bootstrap, migrate) are unaffected. `prep` is gone: there is no shared directory and no key copy.

**S2. `single` is today's layout, explicit opt-in.** `fleet-host-entry single` is today's script unchanged (supervision loop, crash-loop give-up, exit-75 rule, squat check, TCP refusal), plus a startup warning: `single-container mode: sessions share fleet-host's uid (SPEC §9); local and dev only`. It serves local `docker run`, the smoke test, and a rollback. It keeps Unix sockets for the broker, credentials and MCP. Desktop runners keep the broker's Unix socket (and the Windows loopback TCP mode); nothing here changes them.

**S3. Broker TCP mode and the mesh guard.**
- The broker already listens on `0.0.0.0:<CLAUDE_FLEET_BROKER_TCP_PORT>` when that env is set (the desktop's Windows mode). It binds `0.0.0.0`, not loopback, because Istio forwards inbound traffic to the pod IP.
- New env `CLAUDE_FLEET_BROKER_REQUIRE_MESH=1`: before binding, the broker polls the sidecar's readiness endpoint `http://127.0.0.1:15021/healthz/ready` for up to 60 s and exits 1 if it never answers 200 (`refusing to listen: no Istio sidecar`). A missing sidecar fails closed. The check runs before any session exists, so no session can answer it.
- `fleet-host-entry workspace` sets `CLAUDE_FLEET_BROKER_TCP_PORT` (default `7070`) and `CLAUDE_FLEET_BROKER_REQUIRE_MESH=1`, refuses to start without `FLEET_HOST_CRED_ADDR`, exports it for sessions (they inherit the broker's env), then `exec`s the broker. tini stays PID 1. The broker exiting ends the container and its sessions.
- `single` keeps refusing `CLAUDE_FLEET_BROKER_TCP_PORT`.

**S4. fleet-host side.**
- New env `CLAUDE_FLEET_BROKER_ADDR=<host>:<port>` (`HostEnv.brokerAddr`). When set it replaces `CLAUDE_FLEET_BROKER_SOCKET`; `brokerOps` passes `{ host, port }` to `BrokerClient`, which already dials TCP. fleet-host dials per operation, so pod start order doesn't matter: `/healthz` doesn't depend on the broker, and broker ops fail until it is up.
- New env `FLEET_HOST_CRED_TCP_PORT` and `FLEET_HOST_MCP_TCP_PORT`: when set, the credential server and the host MCP listen on `0.0.0.0:<port>` instead of their Unix sockets. Same handlers, caps, timeouts and logging. The MCP caller is still the `host_meta` workspace id, fixed by fleet-host and never read from the wire. No first-line token: the mesh establishes the caller (D73).
- New env `FLEET_HOST_MCP_ADDR=<host>:<port>`: the address sessions dial. `hostMcpArgs` then emits `env: { CLAUDE_FLEET_MCP_TCP: <addr>, CLAUDE_FLEET_MCP_UNIX: "" }` and no `CLAUDE_FLEET_MCP_TOKEN_FILE`, so the bridge sends no token line. Tools, `--mcp-config` placement and the frame gate are unchanged.
- `fleet-host-entry host` sets `FLEET_HOST_CRED_TCP_PORT=8081` and `FLEET_HOST_MCP_TCP_PORT=8082` when unset, refuses to start without `CLAUDE_FLEET_BROKER_ADDR` and `FLEET_HOST_MCP_ADDR`, and sets `FLEET_HOST_REQUIRE_MESH=1`.
- **Mesh check at start** (`FLEET_HOST_REQUIRE_MESH=1`): fleet-host polls `127.0.0.1:15021/healthz/ready` for up to 60 s before opening :8081 and :8082. Without a ready sidecar it doesn't open them (they would serve tokens and MCP to the whole cluster in plaintext) and logs at `error`: `no Istio sidecar: credential and MCP ports stay closed; broker connections are plaintext and a STRICT peer will refuse them`. :8080 and the lease still start, so the pod reports why on `/healthz` (`mesh: "missing"`) and is unready.
- **What fleet-host can't see.** The sidecar's presence is detectable; whether a given connection is mTLS, whether the workspace pod's PeerAuthentication is `STRICT`, and whether the AuthorizationPolicies exist are not. The app hands Envoy plaintext either way, and the broker and MCP are raw TCP, so there is no `X-Forwarded-Client-Cert` header to inspect. These are enforced only by the chart and checked on the host checklist (S9).

**S5. `fleet-host-cred` over TCP.** When `FLEET_HOST_CRED_ADDR` is set, `requestToken` sends `POST http://<addr>/token` instead of using the socket; the request, body cap, timeout and responses are unchanged. The sidecar adds mTLS. The git helper and `gh` shim work as before. `fleet-host-cred serve` (standalone) keeps the Unix socket only.

**S6. App key.** The host pod mounts the Secret directly at `/var/run/secrets/github-app`, `defaultMode: 0444`. Nothing else runs in that container, so file mode isn't a boundary there; no `fsGroup`, no copy. The workspace pod doesn't mount it. A rotated key still needs a pod restart.

**S7. A session's App installation token is never a host grant.** Config parse refuses a `machines` rule whose `appId` equals `github.appId` (`machines[i].appId is this host's credential App; sessions hold its tokens`). Otherwise a session could take a token from :8081 and use it as a Bearer on :8080.

**S8. Host state, transcripts and ingest.**
- `FLEET_HOST_STATE=/var/lib/fleet-host/state` on a `host-state` emptyDir, not the session-writable EFS. With `db:` the `host_meta` row is authoritative.
- `FLEET_HOST_PROJECTS=/var/lib/fleet-host/projects`: the `claude` EFS volume, subPath `projects`, read-only.
- Ingest opens transcripts with `O_NOFOLLOW`, ingests regular files only, and refuses a file whose directory's realpath is outside `FLEET_HOST_PROJECTS`. A session controls those files; without this a symlink could point ingest at the key.
- The writers are in another pod, so `fs.watch` gets no inotify events from EFS. Ingest relies on the rescan: new env `FLEET_HOST_RESCAN_MS` (default 60000); host mode sets 5000 when unset.

**S9. Supervision, AWS, tests.**
- Host mode supervises fleet-host as before: exit 75 restarts in-container with the 1 s → 10 s doubling backoff and no give-up; any other exit ends the container; SIGTERM/SIGINT go to fleet-host and never restart it; SIGHUP is forwarded. It refuses to run as `FLEET_WORKSPACE_UID` (default 1000). The port-squat check stays (cheap), though nothing else runs in the host pod.
- AWS: the SDK default chain in both pods picks up Pod Identity (`AWS_CONTAINER_CREDENTIALS_FULL_URI`). claude-fleet ships no AWS change. `automountServiceAccountToken: false` on both pods; the Pod Identity and Istio webhooks mount their own projected tokens. Sessions reach `infra-llmbot-viewonly` through `~/.aws/config` profiles (`role_arn = arn:aws:iam::<acct>:role/infra-llmbot-viewonly`, `credential_source = EcsContainer`), supplied by a loadout or the EFS home. The `migrate` Job runs under SA `fleet-agent` and gets the `fleet-host` role the same way.
- Unit tests: broker mesh guard (fake readiness server: 200, non-200, absent; timeout), `readHostEnv` (`brokerAddr`, the TCP ports, `FLEET_HOST_MCP_ADDR`, `FLEET_HOST_RESCAN_MS`), the credential server and host MCP on TCP (same assertions as their socket tests, caller fixed), `requestToken` over TCP, `hostMcpArgs` TCP form, fleet-host's mesh check (ports stay closed, `/healthz` `mesh: "missing"`), the `machines` refusal, ingest symlink refusal. The readiness URL is overridable for tests only (`FLEET_MESH_READY_URL`).
- `docker/host/fleet-host-entry.test.sh`: all three modes with fake broker and fleet-host processes; no mode → 2; `workspace` env, exec and refusals; `host` env, exit passthrough, exit-75 restart, uid refusal, SIGHUP.
- `docker/host/split.test.sh` (in `test-runner-images.yml` after the smoke test): two containers on a user-defined Docker network with a fake readiness responder. It checks wiring only: `/healthz` through the host; fleet-host lists and creates a broker session over :7070; a workspace process gets a 400 for an unscoped `POST /token` on :8081 and `tools/list` on :8082; the workspace container has no key file and no fleet-host process; restarting the host container leaves the broker and its sessions running. Docker has no mesh, so it can't test D73.
- **Host checklist (cluster, before go-live).** From a mesh pod under another SA, and from an out-of-mesh pod: :7070, :8081 and :8082 refuse. From the workspace pod: :8080 and the host pod's other ports refuse; :8081 and :8082 work. From the host pod: :7070 works. A workspace pod started without its sidecar never listens.

## 5. Pod specs for platform-ops#36

Reference shapes; names in `<>` are infra's. Both pods are in the mesh (`istio.enabled: true`).

```yaml
# host pod (Rollout fleet-agent)
spec:
  serviceAccountName: fleet-agent
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1001
    runAsGroup: 1001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: host
      image: <runner-devops-host@sha256:…>
      args: ["fleet-host-entry", "host"]
      ports:
        - { name: http, containerPort: 8080 }
        - { name: http-cred, containerPort: 8081 }
        - { name: tcp-mcp, containerPort: 8082 }
      securityContext: &locked
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      env:
        - { name: CLAUDE_FLEET_BROKER_ADDR, value: "<workspace-svc>.platform-ops.svc:7070" }
        - { name: FLEET_HOST_MCP_ADDR, value: "<host-internal-svc>.platform-ops.svc:8082" }
        - { name: FLEET_HOST_STATE, value: /var/lib/fleet-host/state }
        - { name: FLEET_HOST_PROJECTS, value: /var/lib/fleet-host/projects }
        - { name: HOME, value: /var/lib/fleet-host/state }
      readinessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 5 }
      volumeMounts:
        - { name: config, mountPath: /etc/fleet-host, readOnly: true }
        - { name: app-key, mountPath: /var/run/secrets/github-app, readOnly: true }
        - { name: claude, mountPath: /var/lib/fleet-host/projects, subPath: projects, readOnly: true }
        - { name: host-state, mountPath: /var/lib/fleet-host/state }
        - { name: host-tmp, mountPath: /tmp }
  volumes:
    - name: app-key
      secret:
        secretName: fleet-agent-secrets
        items: [{ key: GITHUB_APP_PRIVATE_KEY, path: key.pem }]
        defaultMode: 0444   # S6
    - { name: config, configMap: { name: fleet-agent-host-config } }
    - { name: host-state, emptyDir: {} }
    - { name: host-tmp, emptyDir: { medium: Memory, sizeLimit: 64Mi } }
    - { name: claude, persistentVolumeClaim: { claimName: <claude-efs> } }
---
# workspace pod (Deployment fleet-agent-workspace, replicas: 1, strategy: Recreate)
spec:
  serviceAccountName: fleet-agent-workspace
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: workspace
      image: <runner-devops-host@sha256:…>
      args: ["fleet-host-entry", "workspace"]
      ports: [{ name: tcp-broker, containerPort: 7070 }]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL] }
      env:
        - { name: FLEET_HOST_CRED_ADDR, value: "<host-internal-svc>.platform-ops.svc:8081" }
      volumeMounts:
        - { name: claude, mountPath: /home/fleet/.claude }
        - { name: workspace, mountPath: /workspace }
  volumes:
    - { name: claude, persistentVolumeClaim: { claimName: <claude-efs> } }
    - { name: workspace, persistentVolumeClaim: { claimName: <workspace-efs> } }
```

Services:
- `<workspace-svc>`: ClusterIP, selects the workspace pod, one port `tcp-broker` 7070 (`appProtocol: tcp`, so Istio doesn't sniff the broker's binary frames). No gateway, no external host.
- `<host-internal-svc>`: ClusterIP, selects the host pod, ports `http-cred` 8081 and `tcp-mcp` 8082 (`appProtocol: tcp`). Not routed by any gateway or VirtualService. The existing `fleet-agent-svc` keeps only :8080.

Mesh policy (both required; without them the ports are open to the cluster):

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata: { name: fleet-agent-workspace, namespace: platform-ops }
spec:
  selector: { matchLabels: { app: <workspace-pod-label> } }
  mtls: { mode: STRICT }
  portLevelMtls: { "7070": { mode: STRICT } }
---
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata: { name: fleet-agent-workspace, namespace: platform-ops }
spec:
  selector: { matchLabels: { app: <workspace-pod-label> } }
  action: ALLOW
  rules:
    - from: [{ source: { principals: ["cluster.local/ns/platform-ops/sa/fleet-agent"] } }]
      to: [{ operation: { ports: ["7070"] } }]
---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata: { name: fleet-agent-host, namespace: platform-ops }
spec:
  selector: { matchLabels: { app: <host-pod-label> } }
  portLevelMtls: { "8081": { mode: STRICT }, "8082": { mode: STRICT } }
---
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata: { name: fleet-agent-host, namespace: platform-ops }
spec:
  selector: { matchLabels: { app: <host-pod-label> } }
  action: ALLOW
  rules:
    - from: [{ source: { principals: ["cluster.local/ns/platform-ops/sa/fleet-agent-workspace"] } }]
      to: [{ operation: { ports: ["8081", "8082"] } }]
    - from: [{ source: { principals: ["cluster.local/ns/platform-ops/sa/platform-ops-infra-gateway-*"] } }]
      to: [{ operation: { ports: ["8080"] } }]
```

- A selector-scoped ALLOW policy denies everything it doesn't match, so the host policy must list :8080 for the gateway. Kubelet probes still pass: Istio rewrites them through the sidecar's agent.
- The gateway SA is the upstream Istio `gateway` chart's default, named after the Argo Application `platform-ops-infra-gateway-<color>-controller`; the prefix matches every hub color.
- The EFS transcripts/session volume mounts with `actimeo=1`; NFS defaults would hide new transcript files for up to 60 s.
- Don't set `traffic.sidecar.istio.io/excludeInboundPorts` (or `excludeOutboundPorts`) to any of these ports; that bypasses the sidecar.
- A DestinationRule on `<workspace-svc>` with `connectionPool.tcp.idleTimeout: 0s` (disabled). Envoy's TCP proxy otherwise cuts a connection idle for 1 h, which would drop a quiet viewer's attach.

## 6. Residual risks (go into SPEC §9)

- **The broker port's security rests entirely on the mesh.** The broker has no authentication of its own. A missing sidecar on the workspace pod (S3 refuses to listen), a non-`STRICT` PeerAuthentication, a missing or widened AuthorizationPolicy, or an inbound-port exclusion exposes session control (create, type into, attach to every session) to the whole cluster. The chart must enforce `STRICT` and the policy; the app can't detect their absence (S4).
- **:8081 and :8082 rest on the mesh the same way.** Without the host policy, any mesh workload can mint repo tokens within `github.repositories`/`github.permissions` and read or write the workspace's todos and automations through MCP.
- **Sessions share one uid with each other and with the broker.** Every session can read and signal every other session and the broker, and can drive the broker on `127.0.0.1:7070`, which doesn't pass the sidecar. Unchanged; tiers already treat `steer` as running code in the workspace.
- **Sessions share the workspace pod's netns with its sidecar.** They reach its admin port (:15000) and can stop it. That fails closed (the broker, :8081 and :8082 become unreachable); it is a denial of service, not a bypass.
- **Ingest lags by the rescan interval** (S8), plus EFS attribute caching.
- **`single` mode keeps every risk in §1.**

## 7. Out of scope

Per-session uids; an authentication layer on the broker beyond the mesh; the infra changes in §5.
