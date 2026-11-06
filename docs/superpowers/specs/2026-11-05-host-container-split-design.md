# Split the fleet-host pod into a host container and a workspace container

**Status:** approved direction (Troy, 2026-11-05). Per-container AWS identity is pending infra (platform-ops#36, thread `001-kickoff.md` 2026-11-05T16:13Z).
**Plan:** `docs/superpowers/plans/2026-11-05-host-container-split.md`.
**Replaces:** the "Known risk: fleet-host, the broker and every claude session share uid 1000" and "The shared uid also defeats the host's other controls" bullets in SPEC §9.

## 1. Problem

Today one container runs tini → `fleet-host-entry` → broker + fleet-host, and every claude session runs as uid 1000, the same uid as fleet-host. A session at `steer` or above can:

- read the GitHub App key (`keyFile`, 0440 with `fsGroup: 1000`) and mint any token the installation allows;
- read `/proc/<fleet-host>/environ` and, where ptrace is allowed, its memory, which holds the bearer tokens of open sockets;
- kill fleet-host, or listen on :8080 while it restarts and collect reconnecting viewers' bearer tokens;
- use the pod's AWS identity to mint RDS IAM tokens and write to the host DB directly, bypassing the lease fence.

## 2. Target

One pod, two containers, one image (`runner-host` / `runner-devops-host`), plus one initContainer from the same image.

| | `prep` (initContainer) | `host` | `workspace` |
|---|---|---|---|
| command | `fleet-host-entry prep` | `fleet-host-entry host` | `fleet-host-entry workspace` |
| uid:gid | 1001:1001 (`fleet-host`) | 1001:1001 (`fleet-host`) | 1000:1000 (`fleet`) |
| supplementary group | 1500 (`fleet-run`, pod-level) | 1500 | 1500 |
| runs | makes the socket dir, copies the App key | fleet-host + the credential socket | broker, claude sessions, tools |
| mounts | `run` (root), App key Secret, `app-key` | ConfigMap, `app-key`, `run` (subPath `sock`), `claude` subPath `projects` read-only, `host-state`, `host-tmp`, its AWS token | `claude`, `workspace` (EFS), `run` (subPath `sock`), its AWS token |
| AWS | none | DB role only (`fleet-agent-rds`) | `fleet-agent-workspace` → `infra-llmbot-readonly` |
| ports | — | :8080 | none |

No `shareProcessNamespace`: a session can't see, signal or ptrace fleet-host. A host container restart doesn't touch PTYs, because the broker lives in the workspace container. Kubernetes restarts each container on its own.

The shared directory (`/run/fleet` in both containers) holds exactly two sockets:
- `broker.sock`: the broker listens (uid 1000), fleet-host dials in. Mode 0660, group 1500.
- `cred.sock`: fleet-host listens (uid 1001), sessions dial in through `fleet-host-cred`. Mode 0660, group 1500.

## 3. Decisions

**D1. Entrypoints: one script, one required mode argument.** `fleet-host-entry host|workspace|prep|single`. One script keeps the shared helpers (logging, port check, run-dir check) in one place and one test harness covers it. The image `CMD` stays `["fleet-host-entry"]`; with no mode the script prints usage and exits 2, so nothing runs in the unsafe layout by default. Jobs that pass `args: ["fleet-host", …]` (bootstrap, migrate) are unaffected.

**D2. The old single-container layout stays as `single`, explicit opt-in.** `fleet-host-entry single` is today's script unchanged (supervision loop, crash-loop give-up, exit-75 rule, squat check, TCP refusal), plus a startup warning: `single-container mode: sessions share fleet-host's uid (SPEC §9); local and dev only`. It serves local `docker run`, the smoke test, and is the fallback if the split has to be rolled back. It is not safe for a shared host and SPEC §9 says so.

**D3. Socket paths.** Both containers mount the same emptyDir subdirectory at `/run/fleet` (`FLEET_RUN_DIR`). `host` and `workspace` modes default `CLAUDE_FLEET_BROKER_SOCKET=/run/fleet/broker.sock` and `FLEET_HOST_CRED_SOCKET=/run/fleet/cred.sock` when unset, and export them. fleet-host reads the same variables it reads today; nothing new in `readHostEnv` for the broker. fleet-host already dials the broker per operation, so container start order doesn't matter: `/healthz` doesn't depend on the broker, and broker ops fail until it is up. Sessions inherit `FLEET_HOST_CRED_SOCKET` from the broker's env.

**D4. Socket directory permissions: made by `prep`, checked by both modes.**
- The emptyDir root is 0777 root-owned (kubelet). `prep` (uid 1001, supplementary 1500) creates `sock/` in it, `chgrp 1500`, `chmod 3770` (setgid + sticky). Both containers mount only `sock/` (subPath), so neither can rename the directory out from under the other.
- Setgid gives every socket group 1500. Sticky means a session can't unlink or replace `cred.sock`; fleet-host owns the directory and can always remove a stale entry.
- `host` and `workspace` modes refuse to start unless `/run/fleet` is a real directory (not a symlink) in group `FLEET_RUN_GID` (default 1500), group rwx, no access for others. The error names `fleet-host-entry prep`.
- Broker: new env `CLAUDE_FLEET_BROKER_SOCKET_GROUP=<gid>`. When set, the broker doesn't create the directory, creates the socket 0660 and chowns it to that group. Unset keeps today's 0666 (the desktop's host is another uid).
- Credential server: new env `FLEET_HOST_CRED_SOCKET_GROUP=<gid>` (`HostEnv.credSocketGroup`). When set, it leaves the directory alone, checks it as above, replaces whatever stale entry holds the socket name, and creates the socket 0660 in that group. Unset keeps 0600 in a 0700 directory.
- What a session can still do through the shared dir: create files there and fill the 1 MiB tmpfs (the pod is evicted, which a session can already cause by killing the broker), and dial `broker.sock`, which it can already reach. A fake socket gains nothing: fleet-host sends the broker only what sessions can already see, and sessions are the only clients of `cred.sock`.

- **Amendment (c3b, fleet-state MCP socket):** `prep` also creates `sock/mcp/`, owned by uid 1001, group 1500, mode 2750. fleet-host serves `mcp.sock` there (`FLEET_HOST_MCP_SOCKET`, default `/run/fleet/mcp/mcp.sock` when `FLEET_HOST_MCP_SOCKET_GROUP` is set), 0660 in group 1500. fleet-host refuses to serve unless the directory is a real directory it owns, in that group, with group r-x and no group write or other access. Sessions can connect but can't create anything in it, so they can't plant a file, symlink or directory at the socket path.

**D5. App key: copied by `prep` into a memory emptyDir, 0400 uid 1001. No pod `fsGroup`.**
- A Secret volume is root-owned; with `fsGroup` its files get group read (kubelet ORs in 0440), so `defaultMode` alone can't make it 1001-only. A pod-level `fsGroup` would also apply to the emptyDirs and could chown the EFS volumes.
- `prep` alone mounts the Secret (`defaultMode: 0444`) and runs `install -m 0400 key.pem` into the `app-key` emptyDir (`medium: Memory`). `host` mounts `app-key` read-only at `/var/run/secrets/github-app`, so the ConfigMap's `keyFile` path is unchanged. The workspace container mounts neither.
- Cost: a rotated key needs a pod restart. fleet-host already reads the key once at start, so this changes nothing.
- No pod `fsGroup` at all. The EFS access points already force uid/gid 1000. Group 1500 comes from pod `supplementalGroups`.

**D6. Host mode supervision.** `fleet-host-entry host` runs fleet-host as a child:
- Port check (`/proc/net/tcp{,6}`) before every start. The containers share the pod's network namespace, so a session can still listen on :8080 while the host container is down. A bound port exits the container non-zero, never starting onto it. The host container is then not ready, so the pod leaves the Service endpoints.
- Exit 75 (DB unavailable) restarts in the container with the 1 s → 10 s doubling backoff and no give-up, the same as today. Kubernetes `CrashLoopBackOff` caps at 5 min, which would keep the host down for minutes after a DB outage ends.
- Any other exit ends the container with fleet-host's status, and Kubernetes restarts it. No in-container crash-loop counter.
- SIGTERM/SIGINT go to fleet-host (it releases the lease) and never restart it. SIGHUP is forwarded (config reload).
- Refuses to run as `FLEET_WORKSPACE_UID` (default 1000), so a misconfigured `runAsUser` can't silently restore the shared uid.

**D7. Workspace mode.** `fleet-host-entry workspace` refuses `CLAUDE_FLEET_BROKER_TCP_PORT` (TCP mode would serve the broker unauthenticated on the pod IP; the pod IP is reachable from the mesh), checks the run dir, exports the socket variables and `CLAUDE_FLEET_BROKER_SOCKET_GROUP`, then `exec`s the broker. tini stays PID 1. The broker exiting ends the container and its sessions; Kubernetes restarts it. `single` keeps the same refusal.

**D8. Host state and transcripts.**
- `FLEET_HOST_STATE=/var/lib/fleet-host/state` on a `host-state` emptyDir. It held `workspace-id.json` on the session-writable EFS, where a session could plant a different id and stop the host from starting. With `db:` the `host_meta` row is authoritative and the file is rewritten from it. Without `db:`, set `workspace.id` in the ConfigMap (platform-ops#36 already does).
- `FLEET_HOST_PROJECTS=/var/lib/fleet-host/projects`: the `claude` EFS volume, subPath `projects`, mounted read-only. Ingest needs the transcripts; read-only keeps fleet-host from writing session files.
- Transcript files are session-controlled and now sit beside the key in fleet-host's mount namespace, so ingest opens with `O_NOFOLLOW`, ingests regular files only, and refuses a file whose directory's realpath is outside `FLEET_HOST_PROJECTS`. Without this a session could symlink `x.jsonl` to `/var/run/secrets/github-app/key.pem`.

**D9. AWS: the SDK default chain, per-container web identity.**
- fleet-host keeps using the SDK default chain (`aws-rds-iam`); claude-fleet ships no AWS change. Each container gets its own `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE` and its own projected SA token volume (host audience `fleet-host-db`; workspace audience `sts.amazonaws.com`). Each role's trust conditions on `sub` and its own `aud`.
- The `fleet-agent` SA has no Pod Identity association and no `eks.amazonaws.com/role-arn` annotation, so neither webhook injects a shared identity. `automountServiceAccountToken: false`: no container needs the Kubernetes API.
- Fallback if audience-split IRSA isn't approved: two pods. The broker socket then needs an authenticated channel across pods; that is a separate spec. D1–D8 carry over (uids, modes, key handling).

**D10. Tests.**
- `docker/host/fleet-host-entry.test.sh` covers all four modes with fake broker and fleet-host processes. Every existing case runs under `single`; new cases: no mode → 2; `workspace` env, exec and refusals; `host` env, exit passthrough, exit-75 restart, squat, uid refusal, SIGHUP; `prep` dir and key.
- Unit tests: `broker/internal/listen` (group and world modes, stale socket, missing dir), `credServer` shared-group mode (0660, group, dir untouched, refusals), `readHostEnv` (`FLEET_HOST_CRED_SOCKET_GROUP`), ingest symlink refusal.
- `docker/host/split.test.sh`: a plain-`docker run` emulation of the pod (no compose), run in `test-runner-images.yml` after the smoke test. Two named volumes stand in for the emptyDirs; `--network container:<host>` shares the netns; PID namespaces stay separate; `--group-add 1500`. It asserts: `/healthz` through the host; both sockets 0660 group 1500 in a 3770 dir; a workspace process reaches `cred.sock` (400 for an unscoped request) and a uid-1001 process in the host container connects to `broker.sock`; the workspace container sees no fleet-host process and has no key file; `docker exec -u 1000` *inside the host container* can't read the key or `/proc/<fleet-host>/environ`; `docker restart` of the host container leaves the workspace container and its broker running.
- CI's runner (ubuntu-24.04, Docker) supports all of it. The `/proc` check is meaningful only in the split layout, so it lives in `split.test.sh`, not the smoke test.
- `smoke.test.sh` runs `fleet-host-entry single` and also asserts the no-mode refusal.

## 4. Pod spec for platform-ops#36

Reference shape; names in `<>` are infra's. The Istio sidecar is injected as today. The `migrate` Job runs under the same SA and so needs the host's projected token and `AWS_ROLE_ARN` too once Pod Identity is removed.

```yaml
spec:
  serviceAccountName: fleet-agent
  automountServiceAccountToken: false
  # shareProcessNamespace defaults to false; leave it unset.
  securityContext:
    runAsNonRoot: true
    supplementalGroups: [1500]
    seccompProfile: { type: RuntimeDefault }
    # no fsGroup (D5)
  initContainers:
    - name: prep
      image: <runner-devops-host@sha256:…>
      args: ["fleet-host-entry", "prep"]
      securityContext: &locked
        runAsUser: 1001
        runAsGroup: 1001
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      volumeMounts:
        - { name: run, mountPath: /prep/run }
        - { name: app-key-src, mountPath: /prep/secret, readOnly: true }
        - { name: app-key, mountPath: /prep/key }
  containers:
    - name: host
      image: <runner-devops-host@sha256:…>
      args: ["fleet-host-entry", "host"]
      ports: [{ name: http, containerPort: 8080 }]
      securityContext: *locked
      env:
        - { name: AWS_ROLE_ARN, value: "arn:aws:iam::<infra>:role/fleet-agent-rds" }
        - { name: AWS_WEB_IDENTITY_TOKEN_FILE, value: /var/run/secrets/fleet-aws/token }
        - { name: AWS_REGION, value: us-east-1 }
        - { name: AWS_STS_REGIONAL_ENDPOINTS, value: regional }
        - { name: FLEET_HOST_STATE, value: /var/lib/fleet-host/state }
        - { name: FLEET_HOST_PROJECTS, value: /var/lib/fleet-host/projects }
        - { name: HOME, value: /var/lib/fleet-host/state }
      readinessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 5 }
      volumeMounts:
        - { name: config, mountPath: /etc/fleet-host, readOnly: true }
        - { name: app-key, mountPath: /var/run/secrets/github-app, readOnly: true }
        - { name: run, mountPath: /run/fleet, subPath: sock }
        - { name: claude, mountPath: /var/lib/fleet-host/projects, subPath: projects, readOnly: true }
        - { name: host-state, mountPath: /var/lib/fleet-host/state }
        - { name: host-tmp, mountPath: /tmp }
        - { name: aws-token-host, mountPath: /var/run/secrets/fleet-aws, readOnly: true }
    - name: workspace
      image: <runner-devops-host@sha256:…>
      args: ["fleet-host-entry", "workspace"]
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL] }
      env:
        - { name: AWS_ROLE_ARN, value: "arn:aws:iam::<infra>:role/fleet-agent-workspace" }
        - { name: AWS_WEB_IDENTITY_TOKEN_FILE, value: /var/run/secrets/fleet-aws/token }
        - { name: AWS_REGION, value: us-east-1 }
        - { name: AWS_STS_REGIONAL_ENDPOINTS, value: regional }
      volumeMounts:
        - { name: claude, mountPath: /home/fleet/.claude }
        - { name: workspace, mountPath: /workspace }
        - { name: run, mountPath: /run/fleet, subPath: sock }
        - { name: aws-token-workspace, mountPath: /var/run/secrets/fleet-aws, readOnly: true }
  volumes:
    - { name: run, emptyDir: { medium: Memory, sizeLimit: 1Mi } }
    - { name: app-key, emptyDir: { medium: Memory, sizeLimit: 1Mi } }
    - name: app-key-src
      secret:
        secretName: fleet-agent-secrets
        items: [{ key: GITHUB_APP_PRIVATE_KEY, path: key.pem }]
        defaultMode: 0444   # mounted only in prep (D5)
    - { name: config, configMap: { name: fleet-agent-host-config } }
    - { name: host-state, emptyDir: {} }
    - { name: host-tmp, emptyDir: { medium: Memory, sizeLimit: 64Mi } }
    - { name: claude, persistentVolumeClaim: { claimName: <claude-efs> } }
    - { name: workspace, persistentVolumeClaim: { claimName: <workspace-efs> } }
    - name: aws-token-host
      projected:
        sources: [{ serviceAccountToken: { audience: fleet-host-db, expirationSeconds: 86400, path: token } }]
    - name: aws-token-workspace
      projected:
        sources: [{ serviceAccountToken: { audience: sts.amazonaws.com, expirationSeconds: 86400, path: token } }]
```

Infra-side prerequisites (from the 16:13Z entry): `fleet-host-db` added to the green OIDC provider's client IDs; `fleet-agent-rds` trust moved to web identity with `aud = fleet-host-db`; the `fleet-agent-workspace` role (`aud = sts.amazonaws.com`, `sts:AssumeRole` on `infra-llmbot-readonly`) and the matching trust line in each account; the Pod Identity association removed. Sessions need `~/.aws/config` profiles chained from `fleet-agent-workspace` (like `llmbot-ro-*`), supplied by a loadout or the EFS home.

## 5. Residual risks (go into SPEC §9)

- **Port squat while the host container is down.** A session can still bind :8080 in the shared netns during a host restart. The entry refuses to start onto it and the host container goes unready, so the pod leaves the endpoints, but connections already routed during the few seconds of endpoint propagation can reach the squatter. A session can no longer cause the restart by killing fleet-host; it still needs a host crash or DB outage. A privileged port was considered and rejected: `allowPrivilegeEscalation: false` (PSS restricted) disables file capabilities, and Kubernetes has no ambient caps.
- **Shared netns with the Istio sidecar.** Sessions reach localhost ports of every container, including the sidecar's admin port. Unchanged by this design.
- **Sessions share one uid with each other.** Every session can read and signal every other session and the broker. Unchanged; tiers already treat `steer` as running code in the workspace.
- **`single` mode keeps every risk in §1.**

## 6. Out of scope

The two-pod fallback's authenticated broker channel; per-session uids; the infra changes listed in §4.
