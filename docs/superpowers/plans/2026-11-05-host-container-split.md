# Host/workspace split (two pods) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a remote workspace as two pods from one image: a host pod (fleet-host, uid 1001, the App key, the DB identity; :8080 viewers, :8081 credentials, :8082 fleet-state MCP) and a workspace pod (the broker on TCP :7070 and the claude sessions, uid 1000), joined only by Istio mTLS and AuthorizationPolicies.

**Architecture:** The broker gains a mesh guard and listens on TCP in the workspace pod. fleet-host dials it by address, serves the credential server and the host MCP on TCP ports instead of Unix sockets, and opens those ports only after it sees an Istio sidecar. `fleet-host-entry` takes a required mode (`host`, `workspace`, `single`); `single` is today's one-container layout. Everything is switched on by env, so desktop runners and `single` keep Unix sockets.

**Tech Stack:** Go 1.22 (broker), TypeScript on Node 22 (fleet-host bundle), vitest, bash, Docker, GitHub Actions. Kubernetes and Istio manifests are handed to platform-ops#36 (Appendix A); none are committed here.

**Spec:** `docs/superpowers/specs/2026-11-05-host-container-split-design.md` (binding; S1–S9, §5 pod specs, §6 residual risks). SPEC §4 *Host images*, §7 *Remote host*, §9, §11 *Host/workspace split*.

## Global Constraints

- **D73.** Host pod: SA `fleet-agent`, Pod Identity role `fleet-host`, uid:gid 1001:1001, `fleet-host-entry host`, listens :8080, :8081 (credentials), :8082 (fleet-state MCP). Workspace pod: SA `fleet-agent-workspace`, role `fleet-workspace` (chains to `infra-llmbot-viewonly`), uid:gid 1000:1000, `fleet-host-entry workspace`, listens :7070 (broker). Transport: Istio mTLS `STRICT` plus AuthorizationPolicies only. No TokenReview, no shared secret, no first-line token.
- **Port/SA matrix (verbatim from the spec):** 8080 host HTTP/WS ← the ingress gateway's principal; 8081 host HTTP ← SA `fleet-agent-workspace`; 8082 host TCP newline-delimited JSON-RPC ← SA `fleet-agent-workspace`; 7070 workspace TCP broker frames ← SA `fleet-agent`. Nothing else is exposed.
- Gateway principal prefix: `cluster.local/ns/platform-ops/sa/platform-ops-infra-gateway-*`.
- Sidecar readiness URL: `http://127.0.0.1:15021/healthz/ready`; overridable only by `FLEET_MESH_READY_URL` (tests).
- Broker refuses to listen unless the sidecar answers 200 within 60 s when `CLAUDE_FLEET_BROKER_REQUIRE_MESH=1`; it logs `refusing to listen: no Istio sidecar` and exits 1.
- fleet-host with `FLEET_HOST_REQUIRE_MESH=1` keeps :8081/:8082 closed without a ready sidecar, logs at `error` exactly `no Istio sidecar: credential and MCP ports stay closed; broker connections are plaintext and a STRICT peer will refuse them`, and `/healthz` reports `mesh: "missing"`. :8080 and the lease still start.
- The MCP caller is the `host_meta` workspace id on every transport, fixed by fleet-host, never read from the wire.
- New env, exact names: `CLAUDE_FLEET_BROKER_REQUIRE_MESH`, `FLEET_MESH_READY_URL`, `CLAUDE_FLEET_BROKER_ADDR`, `FLEET_HOST_CRED_TCP_PORT`, `FLEET_HOST_CRED_ADDR`, `FLEET_HOST_MCP_TCP_PORT`, `FLEET_HOST_MCP_ADDR`, `FLEET_HOST_REQUIRE_MESH`, `FLEET_HOST_RESCAN_MS`, `FLEET_WORKSPACE_UID`. Sessions dial the MCP through the bridge's existing `CLAUDE_FLEET_MCP_TCP`.
- `FLEET_HOST_RESCAN_MS` default 60000; `fleet-host-entry host` sets 5000 when unset. EFS mounts with `actimeo=1` (Appendix A).
- Config parse refuses a `machines` rule whose `appId` equals `github.appId`: `machines[i].appId is this host's credential App; sessions hold its tokens`.
- DestinationRule on the broker Service: `connectionPool.tcp.idleTimeout: 0s` for :7070.
- **D71:** host `query` signs in as `fleet_agent_query` (IAM login); `fleet_agent` never gets `CREATEROLE`. Already built in (d1); this plan changes nothing there.
- **D81/D83:** the `fleet-embedder` sidecar is a child of fleet-host, so it runs in the host pod; the host pod's memory request rises by 256 Mi (Appendix A). No code change.
- **D82:** host images are `linux/amd64` only. No workflow arch change.
- **Unchanged:** desktop runners keep the broker's Unix socket (and the Windows loopback TCP mode) and the local MCP bridge. `fleet-host-cred serve` keeps the Unix socket only. `single` keeps Unix sockets for broker, credentials and MCP.
- **Infra split:** chart and manifest changes are platform-ops#36 (Work workspace). This repo ships code, images, tests, SPEC, and the manifests in Appendix A as a handoff.
- **SPEC rule** (`.claude/rules/spec-maintenance.md`): every env, image-layout or §9 change updates `docs/SPEC.md` in the same commit. Each task names its SPEC edit.
- Code comments: terse, only for a non-obvious why (`.claude/rules/review-conventions.md`).
- Secret hygiene: never `bash -x`/`set -x`, `env` or `printenv`.
- Worktree: `W=/workspace/claude-fleet/.claude/worktrees/<name>`; `git -C "$W"`; never `cd /workspace/claude-fleet`; never stage `node_modules` or `.superpowers/`. In this shell `grep` skips gitignored paths; use `command grep -a`.
- Tooling: run `npm ci --ignore-scripts` once in the worktree. Unit: `npx vitest run <files>`. Typecheck the host graph with `npx tsc --noEmit -p tsconfig.host.json` (run `tsconfig.node.json` separately; `npm run typecheck` short-circuits). Postgres suites (`*.pg.test.ts`, and `describe.skipIf(!isPg)` blocks) run in CI's PG job; locally only with `PG_TEST_URL`. Go: `/usr/local/go/bin/go` (`cd "$W/broker" && go test -race ./...`). No Docker daemon and no cluster in a workspace container: image tests run in CI.

## Decisions taken in this plan

- **D84.** `/healthz` carries `mesh` only when `FLEET_HOST_REQUIRE_MESH=1`: `checking`, `ready` or `missing`. `checking` and `missing` both make it 503 `unhealthy`. Without the flag the body is unchanged.
- **D85.** The prep-era group-socket mode goes: `FLEET_HOST_MCP_SOCKET_GROUP`, `socketDir.ts`'s group branch and the `/run/fleet/mcp/` default. `prep` doesn't exist in the two-pod design (S1); `single` keeps its private 0600 socket in a 0700 directory.
- **D86.** `FLEET_HOST_MCP_TCP_PORT` and `FLEET_HOST_MCP_ADDR` are set together or start is refused, so sessions never dial a socket nobody serves.
- **D87.** Addresses are `host:port` with a DNS name or IPv4 (no IPv6 literals). A malformed value refuses fleet-host start; `fleet-host-cred` exits 1 naming the variable.
- **D88.** The image `CMD` stays `fleet-host-entry` with no mode, so a pod spec without `args` exits 2 rather than silently running `single`. Rollout: platform-ops#36 adds `args` before it bumps the digest; the current image's entry script ignores its arguments, so `args: ["fleet-host-entry", "single"]` is safe to land first.
- **D89.** The sidecar wait is the same on both sides: up to 60 s, a probe every 1 s, 2 s per probe.
- **D90.** With `FLEET_HOST_REQUIRE_MESH=1` the credential server starts after the mesh check, in the background; a failure then (a bad key file) logs `credential server start failed; exiting` and exits 1. Without the flag it starts before :8080 as today.
- **D91.** `split.test.sh` runs Postgres (`pgvector/pgvector:0.8.7-pg16`, the digest `build-app.yml` pins) and `fleet-host bootstrap`, because :8082 is served only by a lease holder, which needs `db:`. It sets `search: { embedder: false }`. It drives the broker over :7070 with a small frame client from inside the host container, because fleet-host's `/rpc` needs a GitHub-verified bearer. A container that answers the readiness URL owns each pod's network namespace.
- **D92.** fleet-host's own rescan default stays 60 s; only `host` mode sets 5000. `FLEET_HOST_RESCAN_MS` accepts 1000–3600000.
- **D93.** No idle-timeout DestinationRule for :8082: the MCP bridge reconnects and resends unanswered requests. :8081 is per-request HTTP.
- **D94.** The image adds user `fleet-host` (1001:1001, home `/var/lib/fleet-host/state`, nologin) and creates `/var/lib/fleet-host/{state,projects}` (state 0700, owned 1001), so `docker run -u 1001` works without mounts.
- **D95.** `FLEET_HOST_REQUIRE_MESH` accepts `''`, `0` or `1`; anything else refuses start.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `broker/internal/mesh/mesh.go` (+ `_test.go`) | create | wait for the sidecar's readiness URL |
| `broker/cmd/broker/listen.go` (+ `_test.go`) | create | the broker's transport from env, behind the mesh guard |
| `broker/cmd/broker/main.go` | modify | call `listen()`; header knob list |
| `src/host/endpoint.ts` (+ `.test.ts`) | create | `host:port` and port parsing; `ListenTarget`, `listenOn` |
| `src/host/mesh.ts` (+ `.test.ts`) | create | fleet-host's sidecar wait |
| `src/host/config.ts` (+ test) | modify | new `HostEnv` fields; the `machines` refusal |
| `src/host/brokerOps.ts` | modify | dial a socket path or `{host, port}` |
| `src/host/credServer.ts`, `credCli.ts`, `credServe.ts` (+ tests) | modify | credentials on TCP; `FLEET_HOST_CRED_ADDR` |
| `src/host/hostMcp.ts`, `socketDir.ts` (+ tests) | modify | MCP on TCP; group mode removed; `hostMcpArgs` TCP form |
| `src/host/holder.ts` | modify | MCP listen target, args, mesh gate; rescan interval |
| `src/host/server.ts` (+ test) | modify | `/healthz` `mesh` |
| `src/host/main.ts` (+ `main.test.ts`, `main.pg.test.ts`) | modify | wiring |
| `src/host/hostIngest.ts` (+ test) | modify | no symlinks, regular files, realpath containment; comment |
| `src/host/broker.integration.test.ts`, `hostQuery.pg.test.ts`, `hostAutomations.test.ts` | modify | new signatures; broker over TCP |
| `docker/host/fleet-host-entry` (+ `.test.sh`) | modify | `host`, `workspace`, `single` |
| `docker/host/Dockerfile`, `docker/host/smoke.test.sh` | modify | `fleet-host` user; smoke runs `single` |
| `docker/host/split.test.sh` | create | two-pod wiring test with plain Docker |
| `.github/workflows/test-runner-images.yml` | modify | run `split.test.sh` |
| `docs/SPEC.md` | modify | §4, §5, §7, §9, §10, §11 |

New files under `src/host/` are inside the host import graph's `host/` prefix and `.dockerignore`'s `!src/host/**`; no `src/main` module is added, so `src/host/importGraph.test.ts`, `.dockerignore` and both workflows' path filters need no change. New Go files are under `broker/**`, already opted in; `*_test.go` stays excluded.

Task order keeps `main` shippable: Tasks 1–7 add env-gated behaviour with every default unchanged; Task 8 is the first that changes the image's default behaviour (no mode → exit 2, D88).

---

### Task 1: Broker mesh guard and TCP listen

**Files:**
- Create: `broker/internal/mesh/mesh.go`, `broker/internal/mesh/mesh_test.go`
- Create: `broker/cmd/broker/listen.go`, `broker/cmd/broker/listen_test.go`
- Modify: `broker/cmd/broker/main.go` (header knob list; the transport block between `lc := net.ListenConfig{}` and `mgr := session.NewManager`)
- Modify: `docs/SPEC.md` §4 *Host images*

**Interfaces:**
- Produces: `mesh.DefaultURL`; `mesh.WaitReady(ctx context.Context, url string, timeout, interval time.Duration) error`; package-main `listen(ctx context.Context, getenv func(string) string, meshWait time.Duration, logf func(string, ...any)) (net.Listener, string, error)`; env `CLAUDE_FLEET_BROKER_REQUIRE_MESH`, `FLEET_MESH_READY_URL`.

**Verify locally:** `go test -race` and the build. **CI/cluster only:** the guard against a real sidecar (cluster checklist, Appendix B).

- [ ] **Step 1: Write the failing mesh tests** — `broker/internal/mesh/mesh_test.go`:

```go
package mesh

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func server(t *testing.T, status func(n int32) int) (*httptest.Server, *int32) {
	var hits int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status(atomic.AddInt32(&hits, 1)))
	}))
	t.Cleanup(s.Close)
	return s, &hits
}

func TestReadyAtOnce(t *testing.T) {
	s, _ := server(t, func(int32) int { return 200 })
	if err := WaitReady(context.Background(), s.URL, time.Second, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
}

func TestReadyAfterSomeProbes(t *testing.T) {
	s, hits := server(t, func(n int32) int {
		if n < 3 {
			return 503
		}
		return 200
	})
	if err := WaitReady(context.Background(), s.URL, 2*time.Second, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(hits); got != 3 {
		t.Fatalf("probes = %d, want 3", got)
	}
}

func TestNeverReady(t *testing.T) {
	s, _ := server(t, func(int32) int { return 503 })
	err := WaitReady(context.Background(), s.URL, 100*time.Millisecond, 10*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no Istio sidecar") {
		t.Fatalf("err = %v", err)
	}
}

func TestAbsent(t *testing.T) {
	s, _ := server(t, func(int32) int { return 200 })
	url := s.URL
	s.Close()
	if err := WaitReady(context.Background(), url, 100*time.Millisecond, 10*time.Millisecond); err == nil {
		t.Fatal("ready with nothing listening")
	}
}

func TestCancelled(t *testing.T) {
	s, _ := server(t, func(int32) int { return 503 })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := WaitReady(ctx, s.URL, time.Minute, 10*time.Millisecond); err == nil {
		t.Fatal("ready after cancel")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "$W/broker" && go test ./internal/mesh/`
Expected: FAIL, `undefined: WaitReady`.

- [ ] **Step 3: Implement** — `broker/internal/mesh/mesh.go`:

```go
// Package mesh waits for the pod's Istio sidecar before the broker listens:
// the broker has no authentication of its own (SPEC §9).
package mesh

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// DefaultURL is the sidecar's readiness endpoint.
const DefaultURL = "http://127.0.0.1:15021/healthz/ready"

// WaitReady polls url every interval until it answers 200, or fails once
// timeout has passed or ctx ends.
func WaitReady(ctx context.Context, url string, timeout, interval time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().Add(interval).After(deadline) {
			return fmt.Errorf("no Istio sidecar: %s not ready after %s", url, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}
```

- [ ] **Step 4: Run** `cd "$W/broker" && go test -race ./internal/mesh/` — Expected: PASS.

- [ ] **Step 5: Write the failing listen tests** — `broker/cmd/broker/listen_test.go`:

```go
package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readiness(t *testing.T, status int) string {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
	t.Cleanup(s.Close)
	return s.URL
}

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestRequireMeshRefusesWithoutSidecar(t *testing.T) {
	env := envOf(map[string]string{
		"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1",
		"FLEET_MESH_READY_URL":             readiness(t, 503),
		"CLAUDE_FLEET_BROKER_TCP_PORT":     "0",
	})
	ln, _, err := listen(context.Background(), env, 200*time.Millisecond, t.Logf)
	if err == nil {
		ln.Close()
		t.Fatal("listened without a sidecar")
	}
	if !strings.Contains(err.Error(), "refusing to listen: no Istio sidecar") {
		t.Fatalf("err = %v", err)
	}
}

func TestRequireMeshListensOnTCPWhenReady(t *testing.T) {
	env := envOf(map[string]string{
		"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1",
		"FLEET_MESH_READY_URL":             readiness(t, 200),
		"CLAUDE_FLEET_BROKER_TCP_PORT":     "0",
	})
	ln, addr, err := listen(context.Background(), env, time.Second, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if addr != "0.0.0.0:0" {
		t.Fatalf("addr = %q", addr)
	}
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

func TestTCPWithoutTheGuardNeverProbes(t *testing.T) {
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_TCP_PORT": "0", "FLEET_MESH_READY_URL": "http://127.0.0.1:1/never"})
	ln, _, err := listen(context.Background(), env, time.Millisecond, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
}

func TestUnixSocketIsWorldRW(t *testing.T) {
	d, err := os.MkdirTemp("", "bl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	p := filepath.Join(d, "run", "b.sock")
	ln, addr, err := listen(context.Background(), envOf(map[string]string{"CLAUDE_FLEET_BROKER_SOCKET": p}), time.Millisecond, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	st, err := os.Stat(p)
	if err != nil || addr != p || st.Mode().Perm() != 0o666 {
		t.Fatalf("stat %v, addr %q, err %v", st, addr, err)
	}
}
```

- [ ] **Step 6: Run to verify failure**

Run: `cd "$W/broker" && go test ./cmd/broker/`
Expected: FAIL, `undefined: listen`.

- [ ] **Step 7: Implement** — `broker/cmd/broker/listen.go`:

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/mesh"
)

// listen binds TCP when CLAUDE_FLEET_BROKER_TCP_PORT is set, else the Unix
// socket. With CLAUDE_FLEET_BROKER_REQUIRE_MESH=1 it first needs the sidecar.
func listen(ctx context.Context, getenv func(string) string, meshWait time.Duration, logf func(string, ...any)) (net.Listener, string, error) {
	if getenv("CLAUDE_FLEET_BROKER_REQUIRE_MESH") == "1" {
		url := getenv("FLEET_MESH_READY_URL")
		if url == "" {
			url = mesh.DefaultURL
		}
		if err := mesh.WaitReady(ctx, url, meshWait, time.Second); err != nil {
			return nil, "", fmt.Errorf("refusing to listen: %w", err)
		}
	}
	var lc net.ListenConfig
	if port := getenv("CLAUDE_FLEET_BROKER_TCP_PORT"); port != "" {
		// Not loopback: Istio forwards inbound traffic to the pod IP, and Docker's port proxy needs it too.
		addr := net.JoinHostPort("0.0.0.0", port)
		ln, err := lc.Listen(ctx, "tcp", addr)
		return ln, addr, err
	}
	path := getenv("CLAUDE_FLEET_BROKER_SOCKET")
	if path == "" {
		path = defaultSocketPath
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, "", fmt.Errorf("mkdir socket dir: %w", err)
	}
	// A host-bind-mounted dir can keep a stale socket across container restarts.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", fmt.Errorf("remove stale socket: %w", err)
	}
	ln, err := lc.Listen(ctx, "unix", path)
	if err != nil {
		return nil, "", err
	}
	// The desktop host connects as another uid.
	if err := os.Chmod(path, 0o666); err != nil {
		logf("chmod socket: %v (continuing)", err)
	}
	return ln, path, nil
}
```

- [ ] **Step 8: Wire `main.go`.**
  - In the header knob list, replace the `CLAUDE_FLEET_BROKER_TCP_PORT` entry with:

```go
//	CLAUDE_FLEET_BROKER_TCP_PORT  if set (e.g. 7070), listen on TCP
//	                              0.0.0.0:<port> instead of a unix socket:
//	                              the Windows desktop (Docker publishes it to
//	                              127.0.0.1) and the remote workspace pod
//	                              (behind the Istio sidecar).
//	                              (default: unset → unix)
//	CLAUDE_FLEET_BROKER_REQUIRE_MESH  "1": wait up to 60 s for the Istio
//	                              sidecar (FLEET_MESH_READY_URL, default
//	                              http://127.0.0.1:15021/healthz/ready) and
//	                              exit 1 without listening if it never answers.
```

  - Add `meshWait = 60 * time.Second` to the `const` block and `"time"` to the imports.
  - Replace everything from `lc := net.ListenConfig{}` through the closing `}` of the unix `else` branch with:

```go
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ln, listenAddr, err := listen(ctx, os.Getenv, meshWait, log.Printf)
	if err != nil {
		log.Fatalf("%v", err)
	}
```

  - Delete the `tcpPort` and `socketPath` locals. Remove `path/filepath` from `main.go`'s imports (now in `listen.go`); keep `errors` (the serve error check) and `net`.

- [ ] **Step 9: Run the whole module and build**

Run: `cd "$W/broker" && gofmt -l . && go vet ./... && go test -race ./... && CGO_ENABLED=0 go build -o /tmp/fleet-broker-split ./cmd/broker`
Expected: `gofmt -l` prints nothing; all PASS; build succeeds.

- [ ] **Step 10: SPEC.** §4 *Host images*, after the *Supervision* bullet, add:

```markdown
- **Broker transport in the workspace pod:** with `CLAUDE_FLEET_BROKER_TCP_PORT` the broker listens on `0.0.0.0:<port>` (Istio forwards inbound traffic to the pod IP). With `CLAUDE_FLEET_BROKER_REQUIRE_MESH=1` it first polls `FLEET_MESH_READY_URL` (default `http://127.0.0.1:15021/healthz/ready`, the sidecar's readiness; only tests override it) every 1 s, 2 s per probe, for up to 60 s, and exits 1 (`refusing to listen: no Istio sidecar: …`) if it never answers 200. The check runs before any session exists, so no session can answer it.
```

- [ ] **Step 11: Commit**

```bash
git -C "$W" add broker/internal/mesh broker/cmd/broker docs/SPEC.md
git -C "$W" commit -m "feat(broker): mesh guard before listening on TCP

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: fleet-host dials the broker by address

**Files:**
- Create: `src/host/endpoint.ts`, `src/host/endpoint.test.ts`
- Modify: `src/host/config.ts` (`HostEnv`, `readHostEnv`), `src/host/config.test.ts`
- Modify: `src/host/brokerOps.ts` (`withClient`, `brokerOps` parameter type)
- Modify: `src/host/main.ts` (the `realBrokerOps(...)` line)
- Modify: `src/host/broker.integration.test.ts`
- Modify: `docs/SPEC.md` §7 *Remote host* env table

**Interfaces:**
- Consumes: Task 1's broker env.
- Produces: `interface HostPort { host: string; port: number }`; `parsePort(text: string): number | null`; `parseHostPort(text: string): HostPort | null`; `HostEnv.brokerAddr: HostPort | null`; `type BrokerEndpoint = string | HostPort`; `brokerOps(endpoint: BrokerEndpoint): BrokerOps`.

**Verify locally:** unit tests, `tsc -p tsconfig.host.json`, and the integration test against `/tmp/fleet-broker-split` from Task 1. **CI only:** the integration test in CI's unit job.

- [ ] **Step 1: Failing endpoint tests** — `src/host/endpoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseHostPort, parsePort } from './endpoint.js';

describe('parsePort', () => {
  it('takes 1-65535 as plain digits only', () => {
    expect(parsePort('8081')).toBe(8081);
    expect(parsePort('65535')).toBe(65535);
    for (const bad of ['0', '65536', '-1', '80.5', ' 80', '0x50', '']) expect(parsePort(bad), bad).toBeNull();
  });
});

describe('parseHostPort', () => {
  it('takes a DNS name or IPv4 with a port', () => {
    expect(parseHostPort('fleet-agent-workspace.platform-ops.svc:7070')).toEqual({ host: 'fleet-agent-workspace.platform-ops.svc', port: 7070 });
    expect(parseHostPort('10.0.0.7:8081')).toEqual({ host: '10.0.0.7', port: 8081 });
  });
  it('refuses schemes, paths, IPv6 literals and missing parts', () => {
    for (const bad of ['http://h:1', 'h:1/x', '[::1]:1', '::1:1', 'h', ':1', 'h:', 'h:0', 'a b:1']) expect(parseHostPort(bad), bad).toBeNull();
  });
});
```

- [ ] **Step 2: Failing env test.** In `src/host/config.test.ts`, add `brokerAddr: null,` after `brokerSocket: '/run/broker/broker.sock',` in *applies the deployment contract defaults*, and add to `describe('readHostEnv')`:

```ts
  it('reads CLAUDE_FLEET_BROKER_ADDR as host:port', () => {
    expect(readHostEnv({ CLAUDE_FLEET_BROKER_ADDR: 'ws.platform-ops.svc:7070' }).brokerAddr).toEqual({ host: 'ws.platform-ops.svc', port: 7070 });
    expect(() => readHostEnv({ CLAUDE_FLEET_BROKER_ADDR: 'ws:x' })).toThrow('CLAUDE_FLEET_BROKER_ADDR ws:x is not host:port');
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/host/endpoint.test.ts src/host/config.test.ts`
Expected: FAIL (missing module; `brokerAddr` absent).

- [ ] **Step 4: Implement `src/host/endpoint.ts`:**

```ts
// host:port parsing for the two-pod layout's TCP endpoints.
export interface HostPort {
  host: string;
  port: number;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

/** A DNS name or IPv4 address and a port; IPv6 literals are not accepted. */
export function parseHostPort(text: string): HostPort | null {
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = parsePort(m[2]);
  return port === null ? null : { host: m[1], port };
}
```

- [ ] **Step 5: Implement `config.ts`.** Add `import { parseHostPort, type HostPort } from './endpoint.js';`. In `HostEnv`, after `brokerSocket: string;`:

```ts
  /** The workspace pod's broker; replaces brokerSocket when set. */
  brokerAddr: HostPort | null;
```

Add above `readHostEnv`:

```ts
function envHostPort(env: NodeJS.ProcessEnv, name: string): HostPort | null {
  const text = env[name];
  if (!text) return null;
  const v = parseHostPort(text);
  if (!v) throw new HostConfigError(`${name} ${text} is not host:port`);
  return v;
}
```

and in the returned object, after `brokerSocket: …,` add `brokerAddr: envHostPort(env, 'CLAUDE_FLEET_BROKER_ADDR'),`.

- [ ] **Step 6: `brokerOps.ts`.** Add `import type { HostPort } from './endpoint.js';` and:

```ts
/** A Unix socket path, or the workspace pod's broker on TCP. */
export type BrokerEndpoint = string | HostPort;
```

Change `withClient<T>(socket: string, …)` to `withClient<T>(endpoint: BrokerEndpoint, …)` with `new BrokerClient(endpoint)`, and `brokerOps(socket: string)` to `brokerOps(endpoint: BrokerEndpoint)`, replacing every `socket` inside with `endpoint`. `BrokerClient`'s constructor already takes `string | { host: string; port: number } | Duplex`.

- [ ] **Step 7: `main.ts`.** Replace `const ops = opts.brokerOps ?? realBrokerOps(env.brokerSocket);` with:

```ts
  const ops = opts.brokerOps ?? realBrokerOps(env.brokerAddr ?? env.brokerSocket);
```

- [ ] **Step 8: Integration test over TCP.** In `src/host/broker.integration.test.ts`, add to the imports `import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';` and `import { createServer as createNetServer, type AddressInfo } from 'node:net';`, and append:

```ts
async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.runIf(BIN)('fleet-host against the real broker on TCP behind the mesh guard', () => {
  let proc: ChildProcess;
  let ready: HttpServer;
  let port = 0;

  beforeAll(async () => {
    ready = createHttpServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => ready.listen(0, '127.0.0.1', () => r()));
    port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'fh-broker-tcp-'));
    const fake = join(dir, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\nexec cat\n');
    chmodSync(fake, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_FLEET_BROKER_TCP_PORT: String(port),
      CLAUDE_FLEET_BROKER_REQUIRE_MESH: '1',
      FLEET_MESH_READY_URL: `http://127.0.0.1:${(ready.address() as AddressInfo).port}/healthz/ready`,
      CLAUDE_FLEET_BROKER_CLAUDE: fake
    };
    proc = spawn(BIN!, [], { env, stdio: 'ignore' });
    const ops = brokerOps({ host: '127.0.0.1', port });
    for (let i = 0; i < 50; i++) {
      try {
        await ops.list();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(() => {
    proc?.kill();
    ready?.close();
  });

  it('creates and lists a session over TCP', async () => {
    const ops = brokerOps({ host: '127.0.0.1', port });
    expect(await ops.create('tcp1', 80, 24, [])).toMatchObject({ ok: true });
    expect(await ops.list()).toContainEqual(expect.objectContaining({ id: 'tcp1', alive: true }));
  });
});
```

- [ ] **Step 9: Run**

Run: `npx vitest run src/host/endpoint.test.ts src/host/config.test.ts && FLEET_BROKER_BIN=/tmp/fleet-broker-split npx vitest run src/host/broker.integration.test.ts && npx tsc --noEmit -p tsconfig.host.json`
Expected: PASS; no type errors.

- [ ] **Step 10: SPEC.** §7 *Remote host* env table, after the `CLAUDE_FLEET_BROKER_SOCKET` row:

```markdown
| `CLAUDE_FLEET_BROKER_ADDR` | unset | host pod: the workspace pod's broker as `host:port` (DNS name or IPv4); replaces `CLAUDE_FLEET_BROKER_SOCKET`. Dialed per operation, so pod start order doesn't matter: `/healthz` doesn't depend on the broker, and broker operations fail until it is up |
```

- [ ] **Step 11: Commit**

```bash
git -C "$W" add src/host/endpoint.ts src/host/endpoint.test.ts src/host/config.ts src/host/config.test.ts src/host/brokerOps.ts src/host/main.ts src/host/broker.integration.test.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): dial the broker at CLAUDE_FLEET_BROKER_ADDR

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Credential server on TCP

**Files:**
- Modify: `src/host/endpoint.ts`, `src/host/endpoint.test.ts` (`ListenTarget`, `listenOn`)
- Modify: `src/host/credServer.ts` (`listenCredSocket` → `listenCred`, `CredServer.port`, `CredHelperOptions.listen`)
- Modify: `src/host/credCli.ts` (`requestToken`, `runCredCli`)
- Modify: `src/host/credServe.ts`, `src/host/main.ts`, `src/host/config.ts`
- Test: `src/host/credServer.test.ts`, `src/host/credCli.test.ts`, `src/host/config.test.ts`, `src/host/main.test.ts`
- Modify: `docs/SPEC.md` §7 env table and *GitHub App credentials*

**Interfaces:**
- Consumes: `HostPort`, `parsePort`, `parseHostPort` (Task 2).
- Produces: `type ListenTarget = { path: string } | { port: number; host?: string }`; `listenOn(server: net.Server, target: ListenTarget): Promise<number | null>`; `interface CredServer { close(): Promise<void>; port: number | null }`; `listenCred(listen: ListenTarget, minter: TokenMinter, log: Logger): Promise<CredServer>`; `CredHelperOptions.listen: ListenTarget` (replaces `socketPath`); `type CredEndpoint = string | HostPort`; `requestToken(endpoint: CredEndpoint, body: unknown): Promise<string>`; `HostEnv.credPort: number | null`; env `FLEET_HOST_CRED_TCP_PORT`, `FLEET_HOST_CRED_ADDR`.

**Verify locally:** all unit tests here. **Cluster only:** mTLS on :8081 (Appendix B).

- [ ] **Step 1: Failing `listenOn` test.** Append to `src/host/endpoint.test.ts` (add `import { createServer } from 'node:net';`, `import { mkdtempSync, statSync } from 'node:fs';`, `import { tmpdir } from 'node:os';`, `import { join } from 'node:path';` and `listenOn` to the `./endpoint.js` import):

```ts
describe('listenOn', () => {
  it('returns the bound TCP port, or null for a Unix socket', async () => {
    const tcp = createServer();
    const port = await listenOn(tcp, { port: 0, host: '127.0.0.1' });
    expect(port).toBeGreaterThan(0);
    tcp.close();
    const unix = createServer();
    const path = join(mkdtempSync(join(tmpdir(), 'ep-')), 's.sock');
    expect(await listenOn(unix, { path })).toBeNull();
    expect(statSync(path).isSocket()).toBe(true);
    unix.close();
  });

  it('rejects when the port is taken', async () => {
    const a = createServer();
    const port = (await listenOn(a, { port: 0, host: '127.0.0.1' }))!;
    await expect(listenOn(createServer(), { port, host: '127.0.0.1' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    a.close();
  });
});
```

- [ ] **Step 2: Failing credential tests.**
  - In `src/host/credServer.test.ts`: change the import to `import { CRED_CLOSE_GRACE_MS, listenCred, startCredHelper, type CredServer } from './credServer.js';`; in `rig()` replace `socketPath: sock,` with `listen: { path: sock },`; replace both `listenCredSocket(sock, minter, …)`/`listenCredSocket(file, minter, …)`/`listenCredSocket(join(dir, 'cred.sock'), minter, …)` calls with `listenCred({ path: sock }, minter, …)`, `listenCred({ path: file }, minter, …)` and `listenCred({ path: join(dir, 'cred.sock') }, minter, …)`. Append:

```ts
describe('credential server over TCP', () => {
  async function tcpRig(allow: string[] | null = null) {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a', 'b'] });
    const dir = mkdtempSync(join(tmpdir(), 'cred-tcp-'));
    const keyFile = join(dir, 'key.pem');
    writeFileSync(keyFile, gh.privatePem, { mode: 0o400 });
    const logs: string[] = [];
    srv = await startCredHelper({
      app: { appId: '1', installationId: '2', keyFile },
      listen: { port: 0, host: '127.0.0.1' },
      github: () => (allow ? { app: null, repositories: allow, permissions: null } : null),
      log: createLogger((l) => logs.push(l)),
      apiBase: gh.url
    });
    return { at: { host: '127.0.0.1', port: srv.port! }, logs };
  }

  it('answers, refuses and caps exactly as on the socket', async () => {
    const { at, logs } = await tcpRig(['a']);
    const token = await requestToken(at, { owner: 'acme', repositories: ['a'] });
    expect(token).toMatch(/^ghs_fake/);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a'], permissions: DEFAULT_PERMISSIONS });
    await expect(requestToken(at, { repositories: ['b'] })).rejects.toThrow(/403.*not in github.repositories/);
    await expect(requestToken(at, { repositories: [] })).rejects.toThrow(/400/);
    await expect(requestToken(at, { repositories: ['a'], pad: 'x'.repeat(9000) })).rejects.toThrow(/413/);
    expect(logs.join('\n')).not.toContain(token);
  });

  it('answers 404 off POST /token', async () => {
    const { at } = await tcpRig();
    expect((await fetch(`http://127.0.0.1:${at.port}/token`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${at.port}/other`, { method: 'POST' })).status).toBe(404);
  });
});
```

  - In `src/host/credCli.test.ts`: in `rig()` replace `socketPath: sock,` with `listen: { path: sock },`. Append inside `describe('runCredCli')`:

```ts
  it('posts to FLEET_HOST_CRED_ADDR over TCP when it is set', async () => {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'credcli-tcp-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    srv = await startCredHelper({
      app: { appId: '1', installationId: '2', keyFile: join(dir, 'key.pem') }, listen: { port: 0, host: '127.0.0.1' },
      github: () => null, log: createLogger(() => undefined), apiBase: gh.url
    });
    const out: string[] = [];
    const o: CredIo = {
      env: { FLEET_HOST_CRED_ADDR: `127.0.0.1:${srv.port}`, FLEET_HOST_CRED_SOCKET: '/nonexistent/cred.sock' },
      stdin: async () => 'protocol=https\nhost=github.com\npath=acme/a.git\n\n', out: (s) => out.push(s), err: () => undefined,
      stdoutIsTty: false, cwdRemotes: () => []
    };
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
  });

  it('exits 1 on a malformed FLEET_HOST_CRED_ADDR', async () => {
    const err: string[] = [];
    const o: CredIo = {
      env: { FLEET_HOST_CRED_ADDR: 'http://h:1' }, stdin: async () => '', out: () => undefined, err: (s) => err.push(s),
      stdoutIsTty: false, cwdRemotes: () => []
    };
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(1);
    expect(err.join('')).toBe('fleet-host-cred: FLEET_HOST_CRED_ADDR http://h:1 is not host:port\n');
  });
```

  - In `src/host/config.test.ts`: add `credPort: null,` after `credSocket: '/run/fleet-host/cred.sock',` in the defaults object, and:

```ts
  it('reads FLEET_HOST_CRED_TCP_PORT', () => {
    expect(readHostEnv({ FLEET_HOST_CRED_TCP_PORT: '8081' }).credPort).toBe(8081);
    expect(() => readHostEnv({ FLEET_HOST_CRED_TCP_PORT: '99999' })).toThrow('FLEET_HOST_CRED_TCP_PORT 99999 is not a port');
  });
```

  - In `src/host/main.test.ts`, after the test *serves App tokens on the credential socket…*, add:

```ts
  it('serves App tokens on FLEET_HOST_CRED_TCP_PORT instead of the socket', async () => {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const { requestToken } = await import('./credCli.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'fh-cred-tcp-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + `github: { appId: 9, installationId: 8, keyFile: ${join(dir, 'key.pem')} }\n`);
    const [port, credPort] = [await freePort(), await freePort()];
    const host = await runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_SOCKET: join(dir, 'run', 'cred.sock'), FLEET_HOST_CRED_TCP_PORT: String(credPort)
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, githubApiBase: gh.url
    });
    try {
      expect(await requestToken({ host: '127.0.0.1', port: credPort }, { repositories: ['a'] })).toMatch(/^ghs_fake/);
      expect(existsSync(join(dir, 'run', 'cred.sock'))).toBe(false);
    } finally {
      await host.shutdown(0);
      await gh.close();
    }
  });
```

  (add `existsSync` to `main.test.ts`'s `node:fs` import).

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/host/endpoint.test.ts src/host/credServer.test.ts src/host/credCli.test.ts src/host/config.test.ts src/host/main.test.ts`
Expected: FAIL (`listenOn`, `listenCred`, `listen` option, `credPort` missing).

- [ ] **Step 4: `endpoint.ts`.** Add at the top `import type { Server } from 'node:net';` and append:

```ts
/** A Unix socket path, or a TCP port on `host` (default 0.0.0.0, which Istio's inbound forwarding needs). */
export type ListenTarget = { path: string } | { port: number; host?: string };

/** Resolves with the bound TCP port, or null for a Unix socket. */
export function listenOn(server: Server, target: ListenTarget): Promise<number | null> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = (): void => {
      server.off('error', reject);
      const a = server.address();
      resolve(a && typeof a === 'object' ? a.port : null);
    };
    if ('path' in target) server.listen(target.path, done);
    else server.listen(target.port, target.host ?? '0.0.0.0', done);
  });
}
```

- [ ] **Step 5: `credServer.ts`.** Import `listenOn, type ListenTarget` from `./endpoint.js`. Change `export interface CredServer { close(): Promise<void> }` to:

```ts
export interface CredServer {
  close(): Promise<void>;
  /** The bound TCP port; null on a Unix socket. */
  port: number | null;
}
```

Replace `listenCredSocket` with:

```ts
async function prepareCredSocket(socketPath: string): Promise<void> {
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const st = await lstat(socketPath).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
    await unlink(socketPath);
  }
}

export async function listenCred(listen: ListenTarget, minter: TokenMinter, log: Logger): Promise<CredServer> {
  if ('path' in listen) await prepareCredSocket(listen.path);
```

keep the `createServer(…)` handler and `server.requestTimeout = 20_000;` unchanged, then replace the listen block, the `chmod` and the `return {` line with:

```ts
  const port = await listenOn(server, listen);
  if ('path' in listen) await chmod(listen.path, 0o600);
  return {
    port,
```

(the `close:` member stays). In `CredHelperOptions` replace `socketPath: string;` with `listen: ListenTarget;`, and end `startCredHelper` with `return listenCred(o.listen, minter, o.log);`.

- [ ] **Step 6: `credCli.ts`.** Import `parseHostPort, type HostPort` from `./endpoint.js`. Replace `requestToken`'s signature and `request(...)` options:

```ts
/** A Unix socket path, or the host pod's credential port. */
export type CredEndpoint = string | HostPort;

export function requestToken(endpoint: CredEndpoint, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const where = typeof endpoint === 'string' ? { socketPath: endpoint } : { host: endpoint.host, port: endpoint.port };
    const req = request({ ...where, path: '/token', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15_000 }, (res) => {
```

(the rest of the body is unchanged). In `runCredCli`, replace `const sock = io.env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET;` with:

```ts
  const addrText = io.env.FLEET_HOST_CRED_ADDR;
  const addr = addrText ? parseHostPort(addrText) : null;
  if (addrText && !addr) {
    io.err(`fleet-host-cred: FLEET_HOST_CRED_ADDR ${addrText} is not host:port\n`);
    return 1;
  }
  const sock: CredEndpoint = addr ?? (io.env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET);
```

- [ ] **Step 7: `config.ts`.** Import `parsePort` from `./endpoint.js`. Add to `HostEnv` after `credSocket: string;`:

```ts
  /** Serve credentials on 0.0.0.0:<port> instead of credSocket. */
  credPort: number | null;
```

Add next to `envHostPort`:

```ts
function envPort(env: NodeJS.ProcessEnv, name: string): number | null {
  const text = env[name];
  if (!text) return null;
  const v = parsePort(text);
  if (v === null) throw new HostConfigError(`${name} ${text} is not a port`);
  return v;
}
```

and in the returned object after `credSocket: …,` add `credPort: envPort(env, 'FLEET_HOST_CRED_TCP_PORT'),`.

- [ ] **Step 8: Callers.**
  - `src/host/main.ts`: add `import type { ListenTarget } from './endpoint.js';`; replace `if (app) cred = await startCredHelper({ app, socketPath: env.credSocket, … });` with:

```ts
    const credListen: ListenTarget = env.credPort !== null ? { port: env.credPort } : { path: env.credSocket };
    if (app) cred = await startCredHelper({ app, listen: credListen, github: () => config.github, log, apiBase: opts.githubApiBase });
```

  - `src/host/credServe.ts`: `startCredHelper({ app, listen: { path: env.credSocket }, … })` (S5: `serve` stays on the socket), and return `{ port: server.port, close: async () => { … } }`.

- [ ] **Step 9: Run**

Run: `npx vitest run src/host/ && npx tsc --noEmit -p tsconfig.host.json`
Expected: PASS (Postgres suites skip without `PG_TEST_URL`); no type errors.

- [ ] **Step 10: SPEC.** §7 env table, after `FLEET_HOST_CRED_SOCKET`:

```markdown
| `FLEET_HOST_CRED_TCP_PORT` | unset | host pod: serve the credential API on `0.0.0.0:<port>` instead of the socket (`fleet-host-entry host` sets 8081); same handler, caps and timeouts |
| `FLEET_HOST_CRED_ADDR` | unset | workspace pod, read by `fleet-host-cred`: post to `http://<host:port>/token` instead of the socket; a malformed value exits 1 naming it |
```

In *GitHub App credentials*, change **Socket:** to **Socket or port:** and its first words to "HTTP on `FLEET_HOST_CRED_SOCKET` (0600, in a 0700 directory), or on `FLEET_HOST_CRED_TCP_PORT` in the host pod, where the mesh admits only `fleet-agent-workspace` (D73):". In the `fleet-host-cred` bullet, after "`serve` runs the socket standalone" add "(Unix socket only)", and add the sentence "With `FLEET_HOST_CRED_ADDR` set, `git-credential` and `gh-token` post to that address; the sidecar adds mTLS."

- [ ] **Step 11: Commit**

```bash
git -C "$W" add src/host/endpoint.ts src/host/endpoint.test.ts src/host/credServer.ts src/host/credServer.test.ts src/host/credCli.ts src/host/credCli.test.ts src/host/credServe.ts src/host/config.ts src/host/config.test.ts src/host/main.ts src/host/main.test.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): credential server on FLEET_HOST_CRED_TCP_PORT; fleet-host-cred dials FLEET_HOST_CRED_ADDR

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Host MCP on TCP; group-socket mode removed

**Files:**
- Modify: `src/host/hostMcp.ts` (`startHostMcp` options, `HostMcp.port`, `McpDial`, `hostMcpArgs`)
- Modify: `src/host/socketDir.ts` (drop the group parameter)
- Modify: `src/host/holder.ts` (`HolderOptions.mcp`, `mcpServer`, the automations `mcpArgs`)
- Modify: `src/host/config.ts` (`mcpPort`, `mcpAddr`; remove `mcpSocketGroup`)
- Modify: `src/host/main.ts` (`mcpArgs`, holder `mcp`)
- Test: `src/host/hostMcp.test.ts`, `src/host/socketDir.test.ts`, `src/host/config.test.ts`, `src/host/hostQuery.pg.test.ts`, `src/host/hostAutomations.test.ts`, `src/host/main.pg.test.ts`
- Modify: `docs/SPEC.md` §4, §7 env table and *Host MCP*, §9 host MCP bullet

**Interfaces:**
- Consumes: `ListenTarget`, `listenOn`, `HostPort` (Tasks 2–3); `envPort`, `envHostPort` in `config.ts`.
- Produces: `startHostMcp(o: { listen: ListenTarget; workspaceId: string; readSource: OwnedReadSource; log: Logger; maxConnections?: number; now?: () => number; embed?: EmbedFn }): Promise<HostMcp>`; `interface HostMcp { close(): Promise<void>; port: number | null }`; `type McpDial = { unix: string } | { tcp: string }`; `hostMcpArgs(dial: McpDial, bridge?: string): string[]`; `prepareSocketPath(path: string)`, `finishSocket(path: string)`; `HolderOptions.mcp: { listen: ListenTarget; args: string[] }`; `HostEnv.mcpPort: number | null`, `HostEnv.mcpAddr: HostPort | null`; env `FLEET_HOST_MCP_TCP_PORT`, `FLEET_HOST_MCP_ADDR`. Removes `HostEnv.mcpSocketGroup` and `FLEET_HOST_MCP_SOCKET_GROUP` (D85).

**Verify locally:** non-PG unit tests, `tsc`. **CI only:** `hostQuery.pg.test.ts`, `main.pg.test.ts`.

- [ ] **Step 1: Mechanical call-site edits, then the failing tests.**

```bash
sed -i "s/socketPath, socketGroup: null, /listen: { path: socketPath }, /; s/socketPath: p + '2', socketGroup: null, /listen: { path: p + '2' }, /" "$W/src/host/hostMcp.test.ts" "$W/src/host/hostQuery.pg.test.ts"
sed -i "s|hostMcpArgs('/run/fleet/mcp.sock')|hostMcpArgs({ unix: '/run/fleet/mcp.sock' })|" "$W/src/host/hostMcp.test.ts" "$W/src/host/hostAutomations.test.ts"
sed -i "s|hostMcpArgs(mcpSock(a.dir))|hostMcpArgs({ unix: mcpSock(a.dir) })|" "$W/src/host/main.pg.test.ts"
sed -i 's/, null)/)/g' "$W/src/host/socketDir.test.ts"
command grep -an 'socketGroup\|, gid)' "$W/src/host/hostMcp.test.ts" "$W/src/host/hostQuery.pg.test.ts" "$W/src/host/socketDir.test.ts"
```

The last command lists only the group-mode tests. Delete them: in `hostMcp.test.ts` the `it('group mode: serves a 0660 socket in the group from a prepped directory', …)` block; in `socketDir.test.ts` the `it('group mode: needs our own directory …')` block, the `groupDir` helper and the `it('group mode: replaces a planted regular file or symlink …')` block, then drop the now-unused `existsSync` and `readFileSync` imports there and `lstatSync`/`chmodSync` from `hostMcp.test.ts` if `tsc` reports them unused.

In `hostMcp.test.ts`, make `rpc` take either transport — change its first line to `function rpc(at: string | { host: string; port: number }, msgs: object[]): Promise<Array<Record<string, any>>> {` and `const c: Socket = connect(path);` to `const c: Socket = connect(typeof at === 'string' ? { path: at } : at);`. Append:

```ts
describe('startHostMcp on TCP', () => {
  it('serves the tools on a port, caller fixed to the hosted workspace, and leaves no socket file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    mcp = await startHostMcp({ listen: { port: 0, host: '127.0.0.1' }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) });
    expect(mcp.port).toBeGreaterThan(0);
    const [list, sessions] = await rpc({ host: '127.0.0.1', port: mcp.port! }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }
    ]).then((ms) => [1, 2].map((id) => ms.find((m) => m.id === id)!));
    expect(list.result.tools).toHaveLength(HOST_MCP_TOOLS.size);
    expect(sessions.result.isError).toBeUndefined();
    expect(scopes).toEqual([[WS]]);
  });
});

describe('hostMcpArgs on TCP', () => {
  it('points the bridge at the address with no token file', () => {
    const [arg] = hostMcpArgs({ tcp: 'fleet-agent-host.platform-ops.svc:8082' });
    expect(JSON.parse(arg.slice('--mcp-config='.length))).toEqual({
      mcpServers: { 'claude-fleet-state': { type: 'stdio', command: 'node', args: [HOST_MCP_BRIDGE], env: { CLAUDE_FLEET_MCP_TCP: 'fleet-agent-host.platform-ops.svc:8082', CLAUDE_FLEET_MCP_UNIX: '' } } }
    });
  });
});
```

In `config.test.ts`: in the defaults object delete `mcpSocketGroup: null,` and add `mcpPort: null,` and `mcpAddr: null,` after `mcpSocket: '/run/fleet/mcp.sock',`. Replace the whole `it('reads the MCP socket and its group', …)` with:

```ts
  it('reads the MCP socket, or its TCP port with the address sessions dial', () => {
    expect(readHostEnv({}).mcpSocket).toBe('/run/fleet/mcp.sock');
    expect(() => readHostEnv({ FLEET_HOST_MCP_SOCKET: 'run/mcp.sock' })).toThrow(/FLEET_HOST_MCP_SOCKET must be an absolute path/);
    expect(readHostEnv({ FLEET_HOST_MCP_SOCKET: '/' + 'a'.repeat(106) }).mcpSocket).toHaveLength(107);
    expect(() => readHostEnv({ FLEET_HOST_MCP_SOCKET: '/' + 'a'.repeat(107) })).toThrow(/FLEET_HOST_MCP_SOCKET is longer than 107 bytes/);
    expect(readHostEnv({ FLEET_HOST_MCP_TCP_PORT: '8082', FLEET_HOST_MCP_ADDR: 'fleet-agent-host.platform-ops.svc:8082' })).toMatchObject({
      mcpPort: 8082, mcpAddr: { host: 'fleet-agent-host.platform-ops.svc', port: 8082 }
    });
    expect(() => readHostEnv({ FLEET_HOST_MCP_TCP_PORT: '8082' })).toThrow('FLEET_HOST_MCP_TCP_PORT and FLEET_HOST_MCP_ADDR are set together');
    expect(() => readHostEnv({ FLEET_HOST_MCP_ADDR: 'h:8082' })).toThrow('FLEET_HOST_MCP_TCP_PORT and FLEET_HOST_MCP_ADDR are set together');
    expect(() => readHostEnv({ FLEET_HOST_MCP_TCP_PORT: '0', FLEET_HOST_MCP_ADDR: 'h:1' })).toThrow('FLEET_HOST_MCP_TCP_PORT 0 is not a port');
    expect(readHostEnv({ FLEET_HOST_MCP_SOCKET_GROUP: '1500' })).not.toHaveProperty('mcpSocketGroup');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/host/hostMcp.test.ts src/host/socketDir.test.ts src/host/config.test.ts src/host/hostAutomations.test.ts`
Expected: FAIL (`listen` option unknown, `hostMcpArgs` object form, `mcpPort` missing).

- [ ] **Step 3: `socketDir.ts`.** Replace the whole file with:

```ts
// The holder's private MCP socket (single-container mode): sessions share
// fleet-host's uid there, so the 0700 directory is the only gate (SPEC §9).
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function prepareSocketPath(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const st = await lstat(path).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
    await unlink(path);
  }
}

export async function finishSocket(path: string): Promise<void> {
  await assertOwnSocket(path);
  await chmod(path, 0o600);
  await assertOwnSocket(path);
}

async function assertOwnSocket(path: string): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isSocket() || st.uid !== process.getuid!()) throw new Error(`${path} is not a socket owned by this process's user`);
}
```

- [ ] **Step 4: `hostMcp.ts`.** Import `listenOn, type ListenTarget` from `./endpoint.js`. Change `export interface HostMcp { close(): Promise<void> }` to `export interface HostMcp { close(): Promise<void>; port: number | null }`. In `startHostMcp`'s options replace `socketPath: string;` and `socketGroup: number | null;` with:

```ts
  /** A Unix socket (single) or a TCP port (host pod; the mesh admits only the workspace pod). */
  listen: ListenTarget;
```

Replace the `try { … }` listen block and the `mcp serving` log with:

```ts
  let port: number | null = null;
  try {
    if ('path' in o.listen) await prepareSocketPath(o.listen.path);
    port = await listenOn(server, o.listen);
    if ('path' in o.listen) await finishSocket(o.listen.path);
  } catch (err) {
    server.close();
    reset();
    throw err;
  }
  server.on('error', (err) => o.log.log('warn', 'mcp listener error', { error: err.message }));
  o.log.log('info', 'mcp serving', 'path' in o.listen ? { socket: o.listen.path } : { port });
  let closing: Promise<void> | null = null;
  return {
    port,
```

(the `close()` member is unchanged). Replace `hostMcpArgs` with:

```ts
/** Where a session's bridge dials: the private socket (single) or the host pod's MCP port. */
export type McpDial = { unix: string } | { tcp: string };

/** Appended to every claude fleet-host creates; the name is the prefix INBOX_TOOLS uses.
 *  `--mcp-config` is variadic: the `=` form keeps a later positional from being read as a config. */
export function hostMcpArgs(dial: McpDial, bridge: string = HOST_MCP_BRIDGE): string[] {
  // No CLAUDE_FLEET_MCP_TOKEN_FILE: on TCP the mesh establishes the caller (D73).
  const env = 'tcp' in dial
    ? { CLAUDE_FLEET_MCP_TCP: dial.tcp, CLAUDE_FLEET_MCP_UNIX: '' }
    : { CLAUDE_FLEET_MCP_UNIX: dial.unix, CLAUDE_FLEET_MCP_TCP: '' };
  const entry = { type: 'stdio', command: 'node', args: [bridge], env };
  return [`--mcp-config=${JSON.stringify({ mcpServers: { 'claude-fleet-state': entry } })}`];
}
```

- [ ] **Step 5: `holder.ts`.** Import `type ListenTarget` from `./endpoint.js`; drop `hostMcpArgs` from the `./hostMcp.js` import. In `HolderOptions` replace `mcp: { socketPath: string; socketGroup: number | null };` with:

```ts
  /** The MCP's listener, and the `--mcp-config` argument fresh steps get. */
  mcp: { listen: ListenTarget; args: string[] };
```

Replace `mcpArgs: hostMcpArgs(o.mcp.socketPath)` with `mcpArgs: o.mcp.args`, and in `mcpServer` replace `startHostMcp({ socketPath: o.mcp.socketPath, socketGroup: o.mcp.socketGroup, workspaceId: …` with `startHostMcp({ listen: o.mcp.listen, workspaceId: …`.

- [ ] **Step 6: `config.ts`.** In `HostEnv`, delete `mcpSocketGroup` and its comment; after `mcpSocket: string;` add:

```ts
  /** Serve the MCP on 0.0.0.0:<port> instead of mcpSocket; set with mcpAddr. */
  mcpPort: number | null;
  /** What sessions' bridges dial when mcpPort is set. */
  mcpAddr: HostPort | null;
```

In `readHostEnv`, delete the `groupText` lines and replace the `mcpSocket` line with:

```ts
  const mcpPort = envPort(env, 'FLEET_HOST_MCP_TCP_PORT');
  const mcpAddr = envHostPort(env, 'FLEET_HOST_MCP_ADDR');
  if ((mcpPort === null) !== (mcpAddr === null)) throw new HostConfigError('FLEET_HOST_MCP_TCP_PORT and FLEET_HOST_MCP_ADDR are set together');
  const mcpSocket = env.FLEET_HOST_MCP_SOCKET || '/run/fleet/mcp.sock';
```

and in the returned object replace `mcpSocketGroup: groupText ? Number(groupText) : null,` with `mcpPort,` and `mcpAddr,`.

- [ ] **Step 7: `main.ts`.** Replace `const mcpArgs = hostMcpArgs(env.mcpSocket);` with:

```ts
  const mcpListen: ListenTarget = env.mcpPort !== null ? { port: env.mcpPort } : { path: env.mcpSocket };
  const mcpArgs = hostMcpArgs(env.mcpAddr ? { tcp: `${env.mcpAddr.host}:${env.mcpAddr.port}` } : { unix: env.mcpSocket });
```

and in the `startHolder({ … })` call replace `mcp: { socketPath: env.mcpSocket, socketGroup: env.mcpSocketGroup },` with `mcp: { listen: mcpListen, args: mcpArgs },`.

- [ ] **Step 8: Run**

Run: `npx vitest run src/host/ && npx tsc --noEmit -p tsconfig.host.json && command grep -anr 'socketGroup\|MCP_SOCKET_GROUP' "$W/src"`
Expected: PASS; no type errors; the grep prints nothing.

- [ ] **Step 9: SPEC.**
  - §7 env table: replace the `FLEET_HOST_MCP_SOCKET` and `FLEET_HOST_MCP_SOCKET_GROUP` rows with:

```markdown
| `FLEET_HOST_MCP_SOCKET` | `/run/fleet/mcp.sock` | single container: the fleet-state MCP socket the holder serves (absolute, ≤ 107 bytes; 0600 in a 0700 directory fleet-host creates) |
| `FLEET_HOST_MCP_TCP_PORT` | unset | host pod: serve the MCP on `0.0.0.0:<port>` instead (`fleet-host-entry host` sets 8082). Set together with `FLEET_HOST_MCP_ADDR`, else start is refused |
| `FLEET_HOST_MCP_ADDR` | unset | host pod: the `host:port` sessions' bridges dial (the host pod's internal Service); `hostMcpArgs` emits it as `CLAUDE_FLEET_MCP_TCP` |
```

  - §7 *Host MCP*, replace the **Socket.** bullet with: "**Listener.** Single container: fleet-host creates the directory 0700 (tightening an existing one), refuses any non-socket at the path (a file, a symlink), unlinks a stale socket and creates it 0600; sessions share fleet-host's uid, so they connect; after `listen` the path is `lstat`ed before and after the chmod and must be a socket owned by fleet-host's uid. Host pod (`FLEET_HOST_MCP_TCP_PORT`): the same server on `0.0.0.0:<port>`, with the same caps and logging; the mesh admits only `fleet-agent-workspace` (D73), and there is no first-line token."
  - In the **Sessions get the tools through `--mcp-config`** bullet, replace "`hostMcpArgs(socket)` is one argument" with "`hostMcpArgs(dial)` is one argument" and "`env: { CLAUDE_FLEET_MCP_UNIX: <socket>, CLAUDE_FLEET_MCP_TCP: "" }`" with "`env: { CLAUDE_FLEET_MCP_UNIX: <socket>, CLAUDE_FLEET_MCP_TCP: "" }` in a single container, or `{ CLAUDE_FLEET_MCP_TCP: <FLEET_HOST_MCP_ADDR>, CLAUDE_FLEET_MCP_UNIX: "" }` in the host pod (no `CLAUDE_FLEET_MCP_TOKEN_FILE`, so the bridge sends no token line)".
  - §4 *Host images*: replace "`/run/fleet` (0700, `fleet`) holds the fleet-state MCP socket in the single-container layout; the container split mounts its own directory there (§7 *Remote host*, *Host MCP*)." with "`/run/fleet` (0700, `fleet`) holds the fleet-state MCP socket in `single` mode; the host pod serves it on TCP (§7 *Remote host*, *Host MCP*)."
  - §9, in the **The host MCP socket** bullet, replace everything from "In the container split it is 0660 in `prep`'s…" to the end of the bullet with: "In the two-pod layout it is TCP :8082 in the host pod, reachable only through the mesh from `fleet-agent-workspace` (residual risks below)."

- [ ] **Step 10: Commit**

```bash
git -C "$W" add src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/socketDir.ts src/host/socketDir.test.ts src/host/holder.ts src/host/config.ts src/host/config.test.ts src/host/main.ts src/host/hostQuery.pg.test.ts src/host/hostAutomations.test.ts src/host/main.pg.test.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): host MCP on FLEET_HOST_MCP_TCP_PORT; drop the prep-era group socket mode

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mesh check and `/healthz` `mesh`

**Files:**
- Create: `src/host/mesh.ts`, `src/host/mesh.test.ts`
- Modify: `src/host/config.ts` (`requireMesh`, `meshReadyUrl`), `src/host/server.ts` (`HostServerDeps.mesh`, `/healthz`), `src/host/holder.ts` (`mcp.ready`), `src/host/main.ts`
- Test: `src/host/config.test.ts`, `src/host/server.test.ts`, `src/host/main.test.ts`, `src/host/main.pg.test.ts`
- Modify: `docs/SPEC.md` §7 env table, *Health*, *Host MCP*

**Interfaces:**
- Consumes: Tasks 3–4 (`credPort`, `mcpPort`, `HolderOptions.mcp`).
- Produces: `MESH_READY_URL`, `MESH_WAIT_MS`, `MESH_POLL_MS`; `type MeshState = 'checking' | 'ready' | 'missing'`; `waitForMesh(o: { url: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<boolean>`; `HostEnv.requireMesh: boolean`, `HostEnv.meshReadyUrl: string`; `HostServerDeps.mesh?(): MeshState | null`; `HolderOptions.mcp.ready: Promise<boolean>`; `RunHostOptions.meshWaitMs?: number`.

**Verify locally:** unit tests, `tsc`. **CI only:** `main.pg.test.ts`. **Cluster only:** a real sidecar (Appendix B).

- [ ] **Step 1: Failing tests.**
  - `src/host/mesh.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { waitForMesh } from './mesh.js';

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function probe(status: (n: number) => number): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  const s = createServer((_q, r) => {
    r.statusCode = status(++n);
    r.end();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/healthz/ready`, hits: () => n };
}

describe('waitForMesh', () => {
  it('is true once the sidecar answers 200', async () => {
    const p = await probe((n) => (n < 3 ? 503 : 200));
    expect(await waitForMesh({ url: p.url, timeoutMs: 2_000, pollMs: 10 })).toBe(true);
    expect(p.hits()).toBe(3);
  });

  it('is false when it never does', async () => {
    const p = await probe(() => 503);
    expect(await waitForMesh({ url: p.url, timeoutMs: 100, pollMs: 10 })).toBe(false);
  });

  it('is false with nothing listening', async () => {
    const p = await probe(() => 200);
    servers.splice(0).forEach((s) => s.close());
    expect(await waitForMesh({ url: p.url, timeoutMs: 100, pollMs: 10 })).toBe(false);
  });

  it('is false at once when aborted', async () => {
    const p = await probe(() => 503);
    const ac = new AbortController();
    const t0 = Date.now();
    const done = waitForMesh({ url: p.url, timeoutMs: 60_000, pollMs: 50, signal: ac.signal });
    ac.abort();
    expect(await done).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
```

  - `src/host/config.test.ts`: add `requireMesh: false,` and `meshReadyUrl: 'http://127.0.0.1:15021/healthz/ready',` before `embedDir` in the defaults object, and:

```ts
  it('reads FLEET_HOST_REQUIRE_MESH and FLEET_MESH_READY_URL', () => {
    expect(readHostEnv({ FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: 'http://127.0.0.1:9/r' })).toMatchObject({ requireMesh: true, meshReadyUrl: 'http://127.0.0.1:9/r' });
    expect(readHostEnv({ FLEET_HOST_REQUIRE_MESH: '0' }).requireMesh).toBe(false);
    expect(() => readHostEnv({ FLEET_HOST_REQUIRE_MESH: 'yes' })).toThrow('FLEET_HOST_REQUIRE_MESH must be 0 or 1');
  });
```

  - `src/host/server.test.ts`, in `describe('unauthenticated routes')`:

```ts
  it('/healthz carries mesh only when the host requires it, and only ready is healthy', async () => {
    let mesh: 'checking' | 'ready' | 'missing' = 'checking';
    const r = await start([], { mesh: () => mesh, healthy: () => mesh === 'ready' });
    let res = await fetch(`${r.url}/healthz`);
    expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'checking' }]);
    mesh = 'missing';
    res = await fetch(`${r.url}/healthz`);
    expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'missing' }]);
    mesh = 'ready';
    expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'none', mesh: 'ready' });
  });
```

  - `src/host/main.test.ts`: add `import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';` and append:

```ts
describe('runHost behind the mesh check', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of open.splice(0)) await c();
  });

  async function meshRig(status: number | null) {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a'] });
    let probe: HttpServer | null = null;
    let probeUrl = `http://127.0.0.1:${await freePort()}/healthz/ready`;
    if (status !== null) {
      probe = createHttpServer((_q, r) => { r.statusCode = status; r.end(); });
      await new Promise<void>((r) => probe!.listen(0, '127.0.0.1', () => r()));
      probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
    }
    const dir = mkdtempSync(join(tmpdir(), 'fh-mesh-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + `github: { appId: 9, installationId: 8, keyFile: ${join(dir, 'key.pem')} }\n`);
    const [port, credPort] = [await freePort(), await freePort()];
    const logs: string[] = [];
    const host = await runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_TCP_PORT: String(credPort), FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: probeUrl
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, githubApiBase: gh.url, meshWaitMs: 300
    });
    open.push(async () => {
      await host.shutdown(0);
      probe?.close();
      await gh.close();
    });
    return { url: `http://127.0.0.1:${port}`, cred: { host: '127.0.0.1', port: credPort }, logs };
  }

  it('opens the credential port once the sidecar is ready, and /healthz says mesh ready', async () => {
    const { requestToken } = await import('./credCli.js');
    const r = await meshRig(200);
    await vi.waitFor(async () => expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'none', mesh: 'ready' }));
    await vi.waitFor(async () => expect(await requestToken(r.cred, { repositories: ['a'] })).toMatch(/^ghs_fake/));
  });

  for (const [what, status] of [['answers 503', 503], ['is absent', null]] as const) {
    it(`keeps the credential port closed and is unready with mesh missing when the sidecar ${what}`, async () => {
      const { requestToken } = await import('./credCli.js');
      const r = await meshRig(status);
      await vi.waitFor(async () => {
        const res = await fetch(`${r.url}/healthz`);
        expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'missing' }]);
      });
      await expect(requestToken(r.cred, { repositories: ['a'] })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(r.logs.map((l) => JSON.parse(l) as { level: string; msg: string })).toContainEqual(expect.objectContaining({
        level: 'error', msg: 'no Istio sidecar: credential and MCP ports stay closed; broker connections are plaintext and a STRICT peer will refuse them'
      }));
    });
  }
});
```

  - `src/host/main.pg.test.ts`: make `rpc` take either transport (first line `function rpc(at: string | { host: string; port: number }, msgs: object[]): Promise<Array<Record<string, any>>> {`, connect line `const c: Socket = connect(typeof at === 'string' ? { path: at } : at);`), add `import { createServer as createHttpServer } from 'node:http';`, and append inside `describe.skipIf(!isPg)('runHost on Postgres', …)`:

```ts
  it('serves the MCP on its TCP port once the sidecar is ready, never without one', async () => {
    const probe = createHttpServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    try {
      const readyUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
      const tcpEnv = (port: number, url: string) => () => ({
        FLEET_HOST_MCP_TCP_PORT: String(port), FLEET_HOST_MCP_ADDR: `127.0.0.1:${port}`, FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: url
      });
      const p1 = await freePort();
      const a = await start({}, undefined, '', tcpEnv(p1, readyUrl));
      await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
      await vi.waitFor(async () => {
        const [list] = await rpc({ host: '127.0.0.1', port: p1 }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
        expect(list.result.tools.map((x: { name: string }) => x.name)).toContain('list_sessions');
      }, { timeout: 10_000 });
      expect(existsSync(mcpSock(a.dir))).toBe(false);
      await a.host.shutdown(0);

      const p2 = await freePort();
      const b = await start({ meshWaitMs: 300 }, undefined, '', tcpEnv(p2, `http://127.0.0.1:${await freePort()}/healthz/ready`));
      await vi.waitFor(async () => expect(await leader(b.url)).toBe(200), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await (await fetch(`${b.url}/healthz`)).json()).toMatchObject({ status: 'unhealthy', mesh: 'missing' }), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 500));
      await expect(rpc({ host: '127.0.0.1', port: p2 }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      probe.close();
    }
  }, 40_000);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/host/mesh.test.ts src/host/config.test.ts src/host/server.test.ts src/host/main.test.ts`
Expected: FAIL (`./mesh.js` missing; `requireMesh`; `mesh` field; `meshWaitMs`).

- [ ] **Step 3: `src/host/mesh.ts`:**

```ts
// The Istio sidecar check before fleet-host opens the ports only the mesh may reach (SPEC §7 *Remote host*).
import { setTimeout as sleep } from 'node:timers/promises';

export const MESH_READY_URL = 'http://127.0.0.1:15021/healthz/ready';
export const MESH_WAIT_MS = 60_000;
export const MESH_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;

export type MeshState = 'checking' | 'ready' | 'missing';

/** True once the readiness URL answers 200; false at the deadline or on abort. */
export async function waitForMesh(o: { url: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<boolean> {
  const deadline = Date.now() + (o.timeoutMs ?? MESH_WAIT_MS);
  const poll = o.pollMs ?? MESH_POLL_MS;
  while (!o.signal?.aborted) {
    try {
      const res = await fetch(o.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.body?.cancel();
      if (res.status === 200) return true;
    } catch {
      // Not listening yet.
    }
    if (Date.now() + poll > deadline) return false;
    try {
      await sleep(poll, undefined, { signal: o.signal });
    } catch {
      return false;
    }
  }
  return false;
}
```

- [ ] **Step 4: `config.ts`.** Import `MESH_READY_URL` from `./mesh.js`. Add to `HostEnv` before `embedDir`:

```ts
  /** Host pod: open the credential and MCP ports only behind a ready Istio sidecar. */
  requireMesh: boolean;
  /** The sidecar's readiness URL; tests override it. */
  meshReadyUrl: string;
```

In `readHostEnv`, before `return`:

```ts
  const meshText = env.FLEET_HOST_REQUIRE_MESH ?? '';
  if (!['', '0', '1'].includes(meshText)) throw new HostConfigError('FLEET_HOST_REQUIRE_MESH must be 0 or 1');
```

and in the returned object add `requireMesh: meshText === '1',` and `meshReadyUrl: env.FLEET_MESH_READY_URL || MESH_READY_URL,`.

- [ ] **Step 5: `server.ts`.** Import `type MeshState` from `./mesh.js`. Add to `HostServerDeps` after `starting?(): boolean;`:

```ts
  /** null or absent: the host doesn't require the mesh, and /healthz omits it. */
  mesh?(): MeshState | null;
```

Replace the `/healthz` `sendJson` line with:

```ts
        const mesh = deps.mesh?.() ?? null;
        sendJson(res, status === 'ok' ? 200 : 503, { status, lease: deps.lease(), db: deps.db?.() ?? 'none', ...(mesh ? { mesh } : {}) });
```

- [ ] **Step 6: `holder.ts`.** Change `HolderOptions.mcp` to:

```ts
  /** The MCP's listener, the `--mcp-config` argument fresh steps get, and the mesh gate (false: never serve). */
  mcp: { listen: ListenTarget; args: string[]; ready: Promise<boolean> };
```

In `mcpServer`'s returned object replace `start: tryStart,` with:

```ts
    start: () => void o.mcp.ready.then((ok) => {
      if (ok && !stopped) tryStart();
    }),
```

- [ ] **Step 7: `main.ts`.**
  - Imports: `import { MESH_WAIT_MS, waitForMesh, type MeshState } from './mesh.js';`.
  - `RunHostOptions`: add `/** Tests: how long to wait for the sidecar. */ meshWaitMs?: number;`.
  - Add a module constant after `PG_CONN_ERRNO`:

```ts
const NO_MESH = 'no Istio sidecar: credential and MCP ports stay closed; broker connections are plaintext and a STRICT peer will refuse them';
```

  - Move `const startAbort = new AbortController();` up to just before `let cred: CredServer | null = null;`, and replace the whole credential block (from `let cred: CredServer | null = null;` through the `catch` that rethrows) with:

```ts
  let mesh: MeshState | null = env.requireMesh ? 'checking' : null;
  // Without a sidecar :8081/:8082 would serve tokens and the MCP to the whole cluster in plaintext.
  const meshReady: Promise<boolean> = env.requireMesh
    ? waitForMesh({ url: env.meshReadyUrl, timeoutMs: opts.meshWaitMs ?? MESH_WAIT_MS, signal: startAbort.signal }).then((ok) => {
        mesh = ok ? 'ready' : 'missing';
        if (ok) log.log('info', 'istio sidecar ready');
        else if (!startAbort.signal.aborted) log.log('error', NO_MESH);
        return ok;
      })
    : Promise.resolve(true);
  let cred: CredServer | null = null;
  const credListen: ListenTarget = env.credPort !== null ? { port: env.credPort } : { path: env.credSocket };
  async function startCred(): Promise<void> {
    const app = config.github?.app;
    if (!app) {
      log.log('info', 'github app credential helper off (github.appId unset)');
      return;
    }
    const c = await startCredHelper({ app, listen: credListen, github: () => config.github, log, apiBase: opts.githubApiBase });
    if (startAbort.signal.aborted) await c.close();
    else cred = c;
  }
  if (!env.requireMesh) {
    try {
      await startCred();
    } catch (err) {
      uninstallGuards();
      throw err;
    }
  } else {
    void meshReady
      .then((ok) => (ok && !startAbort.signal.aborted ? startCred() : undefined))
      .catch((err: Error) => {
        log.log('error', 'credential server start failed; exiting', { error: err.message });
        void shutdown(1);
      });
  }
```

  - In `createHostServer({ … })`: change `healthy:` to `healthy: () => !!leaseMgr?.running && (dbHealth?.ok() ?? true) && (mesh === null || mesh === 'ready'),` and add `mesh: () => mesh,`.
  - In `startHolder({ … })`: `mcp: { listen: mcpListen, args: mcpArgs, ready: meshReady },`.

- [ ] **Step 8: Run**

Run: `npx vitest run src/host/ && npx tsc --noEmit -p tsconfig.host.json`
Expected: PASS (PG suites skip locally); no type errors.

- [ ] **Step 9: SPEC.**
  - §7 env table, append:

```markdown
| `FLEET_HOST_REQUIRE_MESH` | unset | `1` (host pod): poll the sidecar's readiness for up to 60 s (1 s apart, 2 s per probe) before opening the credential and MCP ports; without it they stay closed and `/healthz` reports `mesh: "missing"`. Only `''`, `0` or `1` |
| `FLEET_MESH_READY_URL` | `http://127.0.0.1:15021/healthz/ready` | the sidecar's readiness URL; tests only |
```

  - *Health*: append "With `FLEET_HOST_REQUIRE_MESH=1` the body adds `mesh`: `checking` until the sidecar answers, then `ready` or `missing`; only `ready` is healthy. Without it there is no `mesh` field. Without a sidecar fleet-host logs at `error` `no Istio sidecar: credential and MCP ports stay closed; broker connections are plaintext and a STRICT peer will refuse them`; :8080 and the lease still run, so the pod reports why and stays unready. fleet-host can see the sidecar, not whether a connection is mTLS, whether the workspace pod's PeerAuthentication is `STRICT`, or whether the AuthorizationPolicies exist: the chart enforces those and the host checklist checks them."
  - *Host MCP* → *Holder start and stop*: after "the MCP socket" add "(in the host pod: once the mesh check passes; never if it fails)". In *Startup*, add "With `FLEET_HOST_REQUIRE_MESH=1` the credential server starts after the mesh check, in the background; a start failure then exits 1."

- [ ] **Step 10: Commit**

```bash
git -C "$W" add src/host/mesh.ts src/host/mesh.test.ts src/host/config.ts src/host/config.test.ts src/host/server.ts src/host/server.test.ts src/host/holder.ts src/host/main.ts src/host/main.test.ts src/host/main.pg.test.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): open credential and MCP ports only behind a ready Istio sidecar

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: A session's App token is never a host grant

**Files:**
- Modify: `src/host/config.ts` (`parseHostConfig`)
- Test: `src/host/config.test.ts`
- Modify: `docs/SPEC.md` §7 *Config*

**Interfaces:**
- Consumes: `HostGithubConfig.app.appId: string`, `GrantConfig.machines[i].appId: number`.
- Produces: the refusal text `machines[i].appId is this host's credential App; sessions hold its tokens` (on start and on reload, since reload parses with the same function).

**Verify locally:** unit tests.

- [ ] **Step 1: Failing test.** In `describe('parseHostConfig')` of `src/host/config.test.ts`:

```ts
  it('refuses a machines grant for the credential App, whose tokens sessions hold', () => {
    const github = { appId: 123456, installationId: 2, keyFile: '/k.pem' };
    expect(() => parseHostConfig({ ...base, github })).toThrow("machines[0].appId is this host's credential App; sessions hold its tokens");
    expect(parseHostConfig({ ...base, github: { ...github, appId: 7 } }).grants.machines).toHaveLength(1);
    expect(parseHostConfig({ ...base, github: { repositories: ['a'] } }).grants.machines).toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/host/config.test.ts`. Expected: FAIL (no throw).

- [ ] **Step 3: Implement.** In `parseHostConfig`, after the `grants` try/catch:

```ts
  const github = o.github === undefined ? null : parseGithub(o.github);
  const credApp = github?.app?.appId;
  // Otherwise a session could take a token from the credential server and present it as a Bearer on :8080.
  grants.machines.forEach((m, i) => {
    if (credApp !== undefined && String(m.appId) === credApp) {
      throw new HostConfigError(`machines[${i}].appId is this host's credential App; sessions hold its tokens`);
    }
  });
```

and in the returned object replace `github: o.github === undefined ? null : parseGithub(o.github),` with `github,`.

- [ ] **Step 4: Run** `npx vitest run src/host/config.test.ts src/host/configReload.test.ts && npx tsc --noEmit -p tsconfig.host.json` — Expected: PASS.

- [ ] **Step 5: SPEC.** §7 *Config*, in the `grants` and `machines` bullet append "A `machines` rule whose `appId` equals `github.appId` is refused (`machines[i].appId is this host's credential App; sessions hold its tokens`): sessions hold that App's installation tokens." In the `github` bullet replace "(an absolute path to the App's PEM, mounted from a Secret, 0400, uid 1000)" with "(an absolute path to the App's PEM, mounted from a Secret: 0444 in the host pod, where nothing else runs; `single` keeps 0400 uid 1000)".

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/host/config.ts src/host/config.test.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): refuse a machines grant for the credential App

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Ingest across pods: rescan interval and no symlinks

**Files:**
- Modify: `src/host/config.ts` (`rescanMs`), `src/host/holder.ts` (`HolderOptions.rescanMs`), `src/host/main.ts`
- Modify: `src/host/hostIngest.ts` (`process`, `inProjects`, the watch comment)
- Test: `src/host/config.test.ts`, `src/host/hostIngest.test.ts` (Postgres suite)
- Modify: `docs/SPEC.md` §7 env table and *Ingest*

**Interfaces:**
- Produces: `DEFAULT_RESCAN_MS = 60_000` (config.ts); `HostEnv.rescanMs: number`; `HolderOptions.rescanMs?: number`; env `FLEET_HOST_RESCAN_MS`.

**Verify locally:** config tests, `tsc`. **CI only:** `hostIngest.test.ts` (Postgres). **Cluster only:** ingest latency over EFS with `actimeo=1`.

- [ ] **Step 1: Failing tests.**
  - `config.test.ts`: add `rescanMs: 60000,` before `embedDir` in the defaults object, and:

```ts
  it('reads FLEET_HOST_RESCAN_MS in [1000, 3600000]', () => {
    expect(readHostEnv({ FLEET_HOST_RESCAN_MS: '5000' }).rescanMs).toBe(5000);
    for (const bad of ['999', '3600001', '5s', '-1']) expect(() => readHostEnv({ FLEET_HOST_RESCAN_MS: bad }), bad).toThrow('FLEET_HOST_RESCAN_MS must be an integer from 1000 to 3600000');
  });
```

  - `hostIngest.test.ts`: add `symlinkSync` to the `node:fs` import, and after *attributes a subagent transcript to its parent session*:

```ts
  it('never follows a symlink out of the projects directory', async () => {
    const { make, projects } = await rig();
    const S2 = '22222222-2222-4222-8222-222222222222';
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(outside, 'agent-x.jsonl'), line('o'));
    writeFileSync(join(outside, 'top.jsonl'), line('t'));
    mkdirSync(join(projects, '-workspace', S1));
    symlinkSync(outside, join(projects, '-workspace', S1, 'subagents'));
    mkdirSync(join(projects, '-workspace', S2, 'subagents'), { recursive: true });
    symlinkSync(join(outside, 'agent-x.jsonl'), join(projects, '-workspace', S2, 'subagents', 'agent-y.jsonl'));
    symlinkSync(join(outside, 'top.jsonl'), join(projects, '-workspace', `${S2}.jsonl`));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(0);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/host/config.test.ts` (FAIL: `rescanMs`); with Postgres: `npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts -t symlink` (FAIL: `expected 3 to be 0`).

- [ ] **Step 3: `config.ts`.** Add `export const DEFAULT_RESCAN_MS = 60_000;` beside the other constants and to `HostEnv`:

```ts
  /** Full transcript rescans; the only change signal when the writers are in another pod. */
  rescanMs: number;
```

In `readHostEnv` before `return`:

```ts
  const rescanText = env.FLEET_HOST_RESCAN_MS || String(DEFAULT_RESCAN_MS);
  const rescanMs = Number(rescanText);
  if (!/^\d+$/.test(rescanText) || rescanMs < 1000 || rescanMs > 3_600_000) {
    throw new HostConfigError('FLEET_HOST_RESCAN_MS must be an integer from 1000 to 3600000');
  }
```

and add `rescanMs,` to the returned object.

- [ ] **Step 4: `holder.ts` and `main.ts`.** Add `/** Full rescan interval for ingest. */ rescanMs?: number;` to `HolderOptions`, pass `rescanMs: o.rescanMs` in `new HostIngest({ … })`, and in `main.ts`'s `startHolder({ … })` add `rescanMs: env.rescanMs,`.

- [ ] **Step 5: `hostIngest.ts`.** Change imports to `import { constants, watch, type FSWatcher } from 'node:fs';`, add `realpath` to the `node:fs/promises` import and `dirname, sep` to `node:path`. Replace the watch comment `// Writers are local processes, so inotify fires even on an NFS mount.` with `// Fires only for writers in this pod; in the two-pod layout the rescan carries ingest.` Add to the class:

```ts
  private projectsReal: string | null = null;

  private async inProjects(path: string): Promise<boolean> {
    this.projectsReal ??= await realpath(this.o.projectsDir);
    const dir = await realpath(dirname(path));
    return dir === this.projectsReal || dir.startsWith(this.projectsReal + sep);
  }
```

In `process`, replace `fh = await open(path, 'r');` with:

```ts
      // Sessions control these names.
      if (!(await this.inProjects(path))) return;
      fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
```

and right after `const st = await fh.stat({ bigint: true });` add `if (!st.isFile()) return;` (the `finally` closes `fh`).

- [ ] **Step 6: Run** `npx vitest run src/host/ && npx tsc --noEmit -p tsconfig.host.json` — Expected: PASS (PG suites skip locally; CI runs `hostIngest.test.ts`).

- [ ] **Step 7: SPEC.**
  - §7 env table: `| FLEET_HOST_RESCAN_MS | 60000 | full transcript rescan interval, 1000–3600000; \`fleet-host-entry host\` sets 5000, since inotify sees no writes from another pod |` (backticked var name in the first column).
  - *Ingest*: replace "Changes come from a recursive `fs.watch` (writers are local, so inotify fires on EFS too) plus a full rescan every 60 s;" with "Changes come from a recursive `fs.watch`, which fires only for writers in the same pod (`single`), plus a full rescan every `FLEET_HOST_RESCAN_MS` (60 s; 5 s in the host pod, where the writers are in the workspace pod and the EFS mount uses `actimeo=1` so new files show within about a second);". Append a bullet: "Transcript names are session-controlled: a file is opened with `O_NOFOLLOW`, only a regular file is read, and a file whose directory's realpath is outside `FLEET_HOST_PROJECTS` is skipped."

- [ ] **Step 8: Commit**

```bash
git -C "$W" add src/host/config.ts src/host/config.test.ts src/host/holder.ts src/host/main.ts src/host/hostIngest.ts src/host/hostIngest.test.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): FLEET_HOST_RESCAN_MS; ingest never follows a symlink

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `fleet-host-entry` modes, the `fleet-host` user, smoke on `single`

**Files:**
- Modify: `docker/host/fleet-host-entry` (full rewrite below)
- Test: `docker/host/fleet-host-entry.test.sh`
- Modify: `docker/host/Dockerfile`, `docker/host/smoke.test.sh`
- Modify: `docs/SPEC.md` §4 *Host images*, §7 *Exit codes*, §10

**Interfaces:**
- Consumes: env from Tasks 1–7.
- Produces: `fleet-host-entry host|workspace|single`; usage line `usage: fleet-host-entry host|workspace|single`; env `FLEET_WORKSPACE_UID` (default 1000); image user `fleet-host` 1001:1001.

**Verify locally:** `bash docker/host/fleet-host-entry.test.sh` (needs bash and node only). **CI only:** the image build and `smoke.test.sh` (`test-runner-images.yml`; Docker isn't available in a workspace container).

- [ ] **Step 1: Harness.** In `docker/host/fleet-host-entry.test.sh`:
  - Broker fake: after `echo broker-start >> "$FAKE_DIR/events"` add

```bash
echo "env ${CLAUDE_FLEET_BROKER_TCP_PORT:-} ${CLAUDE_FLEET_BROKER_REQUIRE_MESH:-} ${FLEET_HOST_CRED_ADDR:-}" >> "$FAKE_DIR/events"
```

  - Host fake: after `note('host-start');` add

```js
note(`env ${process.env.FLEET_HOST_CRED_TCP_PORT ?? ''} ${process.env.FLEET_HOST_MCP_TCP_PORT ?? ''} ${process.env.FLEET_HOST_REQUIRE_MESH ?? ''} ${process.env.FLEET_HOST_RESCAN_MS ?? ''}`);
```

  - Replace `run()` with:

```bash
# run <case> <mode|none> [env...]: starts the entry script in the background; sets $pid and $dir.
run() {
  dir="$tmp/case-$1"; local mode=$2; shift 2
  mkdir -p "$dir"; : > "$dir/events"
  local args=("$mode"); [ "$mode" = none ] && args=()
  env -u CLAUDE_FLEET_BROKER_TCP_PORT -u CLAUDE_FLEET_BROKER_REQUIRE_MESH -u FLEET_HOST_CRED_ADDR -u CLAUDE_FLEET_BROKER_ADDR \
    -u FLEET_HOST_MCP_ADDR -u FLEET_HOST_CRED_TCP_PORT -u FLEET_HOST_MCP_TCP_PORT -u FLEET_HOST_REQUIRE_MESH -u FLEET_HOST_RESCAN_MS \
    FAKE_DIR="$dir" FLEET_BROKER_BIN="$tmp/broker" FLEET_HOST_JS="$tmp/host.mjs" FLEET_HOST_PORT="$(free_port)" \
    FLEET_HOST_BACKOFF_START_MS=20 FLEET_HOST_BACKOFF_MAX_MS=80 FLEET_WORKSPACE_UID=99999 "$@" \
    bash "$here/fleet-host-entry" "${args[@]}" 2> "$dir/log" &
  pid=$!
}
```

  - Existing cases 1–10 run `single`: `sed -i -E 's/^run ([a-z0-9]+)( |$)/run \1 single\2/' "$W/docker/host/fleet-host-entry.test.sh"` (the `run() {` line has no space after `run` and is untouched).

- [ ] **Step 2: New cases**, before the final `[ "$fails" -eq 0 ]` line:

```bash
# 11. No mode refuses with usage and starts nothing.
run nomode none
finish
assert "$st" "2" "no mode exits 2"
assert "$(count broker-start)" "0" "no mode starts no broker"
grep -q 'usage: fleet-host-entry host|workspace|single' "$dir/log"; assert "$?" "0" "usage logged"

# 12. single warns about the shared uid.
run singlewarn single
until_count host-start 1
grep -q 'single-container mode: sessions share fleet-host' "$dir/log"; assert "$?" "0" "single warns"
kill -TERM "$pid"; finish

# 13. workspace execs the broker on TCP behind the mesh guard and exports the credential address.
run ws workspace FLEET_HOST_CRED_ADDR=host-svc:8081
until_count broker-start 1
assert "$(grep '^env ' "$dir/events")" "env 7070 1 host-svc:8081" "workspace exports broker and credential env"
assert "$(head -1 "$dir/pids")" "$pid" "workspace execs the broker"
assert "$(count host-start)" "0" "workspace runs no fleet-host"
kill -TERM "$pid"; finish
assert "$st" "0" "workspace exits with the broker"

# 14. workspace keeps an explicit port and propagates the broker's exit status.
run wsexit workspace FLEET_HOST_CRED_ADDR=h:1 CLAUDE_FLEET_BROKER_TCP_PORT=7171 FAKE_BROKER_EXIT=4
finish
assert "$st" "4" "workspace exit status is the broker's"
assert "$(grep '^env ' "$dir/events")" "env 7171 1 h:1" "workspace keeps an explicit broker port"

# 15. workspace refuses to start without FLEET_HOST_CRED_ADDR.
run wsnocred workspace
finish
assert "$st" "1" "workspace refuses a missing FLEET_HOST_CRED_ADDR"
assert "$(count broker-start)" "0" "no broker without FLEET_HOST_CRED_ADDR"
grep -q 'FLEET_HOST_CRED_ADDR is not set' "$dir/log"; assert "$?" "0" "missing credential address logged"

# 16. host refuses a missing broker or MCP address.
run hostnobroker host FLEET_HOST_MCP_ADDR=h:8082
finish
assert "$st" "1" "host refuses a missing CLAUDE_FLEET_BROKER_ADDR"
run hostnomcp host CLAUDE_FLEET_BROKER_ADDR=w:7070
finish
assert "$st" "1" "host refuses a missing FLEET_HOST_MCP_ADDR"
assert "$(count host-start)" "0" "fleet-host never started without its addresses"

HOSTENV=(CLAUDE_FLEET_BROKER_ADDR=w:7070 FLEET_HOST_MCP_ADDR=h:8082)

# 17. host exports the host-pod env; a non-75 exit ends the container with its status; no broker.
run hostexit host "${HOSTENV[@]}" FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=3
finish
assert "$st" "3" "host exit status is fleet-host's"
assert "$(count host-start)" "1" "host leaves other exits to Kubernetes"
assert "$(grep -m1 '^env ' "$dir/events")" "env 8081 8082 1 5000" "host exports ports, mesh and rescan"
assert "$(count broker-start)" "0" "host runs no broker"

# 18. host restarts exit 75 with backoff, never gives up, and SIGTERM in backoff exits 0.
run host75 host "${HOSTENV[@]}" FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=75 FLEET_HOST_MAX_RESTARTS=2
until_count host-start 4
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "host still running after repeated exit 75"
grep -q '"delayMs":80' "$dir/log"; assert "$?" "0" "host exit-75 restarts back off"
kill -TERM "$pid"; finish
assert "$st" "0" "host SIGTERM in backoff exits 0"

# 19. host forwards SIGHUP and SIGTERM and never restarts on them.
run hosthup host "${HOSTENV[@]}"
until_count host-start 1
sleep 0.2
kill -HUP "$pid"
until_count host-hup 1; assert "$(count host-hup)" "1" "host forwards SIGHUP"
kill -TERM "$pid"; finish
assert "$st" "0" "host SIGTERM exits 0"
assert "$(count host-term)" "1" "SIGTERM reaches fleet-host"
assert "$(count host-start)" "1" "host never restarted on HUP or TERM"

# 20. host never starts onto a taken port.
squat_port=$(free_port)
node -e "require('net').createServer().listen($squat_port,'0.0.0.0')" &
squatter=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$squat_port") 2>/dev/null && break; sleep 0.05; done
run hostsquat host "${HOSTENV[@]}" FLEET_HOST_PORT="$squat_port"
finish
kill "$squatter" 2>/dev/null; wait "$squatter" 2>/dev/null
assert "$st" "1" "host refuses a taken port"
assert "$(count host-start)" "0" "host never starts onto a taken port"

# 21. host refuses to run as the workspace uid.
run hostuid host "${HOSTENV[@]}" FLEET_WORKSPACE_UID="$(id -u)"
finish
assert "$st" "1" "host refuses the workspace uid"
assert "$(count host-start)" "0" "fleet-host never started as the workspace uid"
grep -q 'refuses to run as the workspace uid' "$dir/log"; assert "$?" "0" "uid refusal logged"

# 22. host keeps an explicit rescan interval.
run hostrescan host "${HOSTENV[@]}" FLEET_HOST_RESCAN_MS=2000 FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^env ' "$dir/events")" "env 8081 8082 1 2000" "host keeps FLEET_HOST_RESCAN_MS"
```

- [ ] **Step 3: Run to verify failure**

Run: `bash "$W/docker/host/fleet-host-entry.test.sh"`
Expected: cases 1–10 `ok:` (today's script ignores `$1`); cases 11–22 have `FAIL:` lines; no `ALL PASS`.

- [ ] **Step 4: Rewrite `docker/host/fleet-host-entry`:**

```bash
#!/usr/bin/env bash
# fleet-host-entry <mode> (SPEC §4 Host images):
#   host       fleet-host alone (host pod, uid 1001): credentials :8081, MCP :8082
#   workspace  the broker and its sessions (workspace pod, uid 1000): broker :7070
#   single     broker and fleet-host in one container under one uid; local and dev only
set -u
mode=${1:-}
broker_bin=${FLEET_BROKER_BIN:-/usr/local/bin/broker}
host_js=${FLEET_HOST_JS:-/usr/local/lib/fleet-host/fleet-host.mjs}
host_port=${FLEET_HOST_PORT:-8080}
max_restarts=${FLEET_HOST_MAX_RESTARTS:-5}
window_s=${FLEET_HOST_RESTART_WINDOW_S:-60}
backoff_start_ms=${FLEET_HOST_BACKOFF_START_MS:-1000}
backoff_max_ms=${FLEET_HOST_BACKOFF_MAX_MS:-10000}
workspace_uid=${FLEET_WORKSPACE_UID:-1000}

log() { printf '{"level":"%s","msg":"fleet-host-entry: %s"%s}\n' "$1" "$2" "${3:-}" >&2; }

need() {
  if [ -z "${!1:-}" ]; then
    log error "$1 is not set; refusing to start ($mode mode)"
    exit 1
  fi
}

# True if any socket in this network namespace listens on $host_port (IPv4 or IPv6, any address).
port_bound() {
  local hex sl local_addr rem st rest
  hex=$(printf '%04X' "$host_port")
  for f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$f" ] || continue
    while read -r sl local_addr rem st rest; do
      [ "$st" = 0A ] && [ "${local_addr##*:}" = "$hex" ] && return 0
    done < "$f"
  done
  return 1
}

host=
pause=
delay_ms=$backoff_start_ms

# Sleeps delay_ms (a trapped signal cuts it short), then doubles it up to the max.
backoff_sleep() {
  sleep "$(( delay_ms / 1000 )).$(printf '%03d' $(( delay_ms % 1000 )))" &
  pause=$!
  while kill -0 "$pause" 2>/dev/null; do wait "$pause" 2>/dev/null; done
  pause=
  delay_ms=$(( delay_ms * 2 > backoff_max_ms ? backoff_max_ms : delay_ms * 2 ))
}

stop_host() {
  [ -n "$pause" ] && kill "$pause" 2>/dev/null
  if [ -n "$host" ]; then
    kill -TERM "$host" 2>/dev/null
    wait "$host" 2>/dev/null
  fi
}

run_workspace() {
  need FLEET_HOST_CRED_ADDR
  # Sessions inherit the broker's env, so fleet-host-cred finds the host pod.
  export FLEET_HOST_CRED_ADDR
  export CLAUDE_FLEET_BROKER_TCP_PORT=${CLAUDE_FLEET_BROKER_TCP_PORT:-7070}
  export CLAUDE_FLEET_BROKER_REQUIRE_MESH=1
  exec "$broker_bin"
}

run_host() {
  if [ "$(id -u)" = "$workspace_uid" ]; then
    log error "host mode refuses to run as the workspace uid $workspace_uid"
    exit 1
  fi
  need CLAUDE_FLEET_BROKER_ADDR
  need FLEET_HOST_MCP_ADDR
  export FLEET_HOST_CRED_TCP_PORT=${FLEET_HOST_CRED_TCP_PORT:-8081}
  export FLEET_HOST_MCP_TCP_PORT=${FLEET_HOST_MCP_TCP_PORT:-8082}
  export FLEET_HOST_REQUIRE_MESH=1
  # The transcript writers are in the workspace pod: inotify sees nothing.
  export FLEET_HOST_RESCAN_MS=${FLEET_HOST_RESCAN_MS:-5000}
  trap 'stop_host; exit 0' TERM INT
  trap '[ -n "$host" ] && kill -HUP "$host" 2>/dev/null' HUP
  local status
  while :; do
    if port_bound; then
      log error "port $host_port is already bound; refusing to start fleet-host" ",\"port\":$host_port"
      exit 1
    fi
    node "$host_js" &
    host=$!
    while :; do
      wait "$host"; status=$?
      kill -0 "$host" 2>/dev/null || break
    done
    host=
    # 75 = EXIT_DB_UNAVAILABLE in src/host/main.ts. Restarted here: CrashLoopBackOff would hold the host down for minutes after the DB recovers.
    if (( status != 75 )); then
      log error "fleet-host exited" ",\"status\":$status"
      exit "$status"
    fi
    log warn "fleet-host exited (db unavailable); restarting" ",\"status\":$status,\"delayMs\":$delay_ms"
    backoff_sleep
  done
}

# fleet-host never starts onto a port someone else holds: sessions share its
# uid, so a session could kill it and listen in its place to collect bearer
# tokens. The container exits instead.
run_single() {
  # TCP mode would serve the broker, unauthenticated, on the pod IP.
  if [ -n "${CLAUDE_FLEET_BROKER_TCP_PORT:-}" ]; then
    log error "CLAUDE_FLEET_BROKER_TCP_PORT is set; refusing to start (the broker must stay on its Unix socket)"
    exit 1
  fi
  log warn "single-container mode: sessions share fleet-host's uid (SPEC §9); local and dev only"
  stop() {
    stop_host
    kill -TERM "$broker" 2>/dev/null
    wait "$broker" 2>/dev/null
  }
  trap 'stop; exit 0' TERM INT
  trap '[ -n "$host" ] && kill -HUP "$host" 2>/dev/null' HUP

  "$broker_bin" &
  broker=$!

  starts=()
  start_host() {
    if port_bound; then
      log error "port $host_port is already bound; refusing to start fleet-host" ",\"port\":$host_port"
      stop
      exit 1
    fi
    node "$host_js" &
    host=$!
    starts+=("$SECONDS")
  }
  start_host

  while :; do
    done_pid=
    wait -n -p done_pid "$broker" "$host"
    status=$?
    # A trapped signal (e.g. HUP) interrupts wait without any child exiting.
    [ -z "${done_pid:-}" ] && continue
    if [ "$done_pid" = "$broker" ]; then
      log error "broker exited; stopping" ",\"status\":$status"
      broker=
      kill -TERM "$host" 2>/dev/null
      wait "$host" 2>/dev/null
      exit "$status"
    fi
    host=
    # 75 = EXIT_DB_UNAVAILABLE in src/host/main.ts.
    if (( status == 75 )); then
      unset 'starts[-1]'
      starts=("${starts[@]}")
    fi
    recent=()
    for t in "${starts[@]}"; do (( SECONDS - t < window_s )) && recent+=("$t"); done
    starts=("${recent[@]}")
    # starts holds this run plus the restarts inside the window.
    if (( ${#starts[@]} > max_restarts )); then
      log error "fleet-host crash-looping; giving up" ",\"status\":$status,\"restarts\":$(( ${#starts[@]} - 1 ))"
      stop
      (( status == 0 )) && status=1
      exit "$status"
    fi
    (( status != 75 && ${#starts[@]} == 1 )) && delay_ms=$backoff_start_ms
    if (( status == 75 )); then
      log warn "fleet-host exited (db unavailable); restarting" ",\"status\":$status,\"delayMs\":$delay_ms"
    else
      log warn "fleet-host exited; restarting" ",\"status\":$status,\"delayMs\":$delay_ms"
    fi
    backoff_sleep
    if ! kill -0 "$broker" 2>/dev/null; then
      wait "$broker"
      status=$?
      log error "broker exited; stopping" ",\"status\":$status"
      exit "$status"
    fi
    start_host
  done
}

case "$mode" in
  host) run_host ;;
  workspace) run_workspace ;;
  single) run_single ;;
  *) log error "usage: fleet-host-entry host|workspace|single"; exit 2 ;;
esac
```

- [ ] **Step 5: Run** `bash "$W/docker/host/fleet-host-entry.test.sh"` — Expected: every line `ok:`, last line `ALL PASS`. Also `bash -n "$W/docker/host/fleet-host-entry"` (syntax only; never `-x`).

- [ ] **Step 6: Dockerfile (D94).** In the `RUN find /usr/local/lib/fleet-host …` chain, insert before ` && mkdir -p /etc/fleet-host /run/fleet-host \`:

```dockerfile
 && groupadd --gid 1001 fleet-host \
 && useradd --uid 1001 --gid 1001 --home-dir /var/lib/fleet-host/state --no-create-home --shell /usr/sbin/nologin fleet-host \
 && mkdir -p /var/lib/fleet-host/state /var/lib/fleet-host/projects \
 && chown fleet-host:fleet-host /var/lib/fleet-host/state && chmod 0700 /var/lib/fleet-host/state \
```

Leave `USER fleet` and `CMD ["/usr/local/bin/fleet-host-entry"]` unchanged (D88: no mode exits 2).

- [ ] **Step 7: Smoke test.** In `docker/host/smoke.test.sh`:
  - change the `cid=$(docker run -d …` line to end `"$image" fleet-host-entry single)`;
  - after the `trap` line add:

```bash
rc=0; docker run --rm "$image" >/dev/null 2>&1 || rc=$?
test "$rc" = 2
test "$(docker run --rm --entrypoint id "$image" -u fleet-host)" = 1001
test "$(docker run --rm --entrypoint stat "$image" -c '%a %u' /var/lib/fleet-host/state)" = '700 1001'
```

  - change the header's "uid 1000," to "uid 1000 under `single`, the no-mode refusal, the `fleet-host` user,".

- [ ] **Step 8: SPEC.**
  - §4 *Host images*: replace the whole **Supervision** bullet with:

```markdown
- **Supervision** (`fleet-host-entry <mode>`; no mode prints `usage: fleet-host-entry host|workspace|single` and exits 2, and the image `CMD` passes none, so a pod spec names one):
  - `single`: the broker and fleet-host side by side under one uid, after logging `single-container mode: sessions share fleet-host's uid (SPEC §9); local and dev only`. Broker exit ends the container (with the broker's status, after stopping fleet-host); fleet-host is restarted with backoff (1 s doubling to 10 s; PTYs live in the broker and survive), and the container exits only when fleet-host exits more than 5 times in 60 s. Exit 75 (`EXIT_DB_UNAVAILABLE`) is restarted with the same backoff but never counts toward that limit. SIGTERM/SIGINT stops fleet-host first (so it releases the lease), then the broker, and never restarts. SIGHUP is forwarded to fleet-host. It refuses `CLAUDE_FLEET_BROKER_TCP_PORT`, since TCP would serve the broker unauthenticated on the pod IP. Knobs: `FLEET_HOST_MAX_RESTARTS`, `FLEET_HOST_RESTART_WINDOW_S`, `FLEET_HOST_BACKOFF_START_MS`, `FLEET_HOST_BACKOFF_MAX_MS`.
  - `host` (host pod, uid 1001): refuses to run as `FLEET_WORKSPACE_UID` (default 1000) and without `CLAUDE_FLEET_BROKER_ADDR` or `FLEET_HOST_MCP_ADDR`; defaults `FLEET_HOST_CRED_TCP_PORT=8081`, `FLEET_HOST_MCP_TCP_PORT=8082` and `FLEET_HOST_RESCAN_MS=5000`, and sets `FLEET_HOST_REQUIRE_MESH=1`. It runs fleet-host alone, checking the port before every start; exit 75 restarts with the doubling backoff and no give-up; any other exit ends the container with its status; SIGTERM/SIGINT and SIGHUP reach fleet-host, which is never restarted on them.
  - `workspace` (workspace pod, uid 1000): refuses to start without `FLEET_HOST_CRED_ADDR` and exports it (sessions inherit the broker's env), defaults `CLAUDE_FLEET_BROKER_TCP_PORT=7070`, sets `CLAUDE_FLEET_BROKER_REQUIRE_MESH=1`, and `exec`s the broker. tini stays PID 1; the broker exiting ends the container and its sessions.
  - Jobs that pass `args: ["fleet-host", …]` (`bootstrap`, `migrate`) are unaffected.
```

  - §4 env-defaults bullet: append "; users `fleet` (1000) and `fleet-host` (1001:1001, home `/var/lib/fleet-host/state`, nologin); `/var/lib/fleet-host/state` (0700, `fleet-host`) and `/var/lib/fleet-host/projects` exist for the host pod's mounts".
  - §4 smoke bullet: replace "uid 1000," with "uid 1000 under `single`, the no-mode refusal (exit 2), the `fleet-host` user,".
  - §7 *Exit codes*: replace "`fleet-host-entry` doesn't count it toward its give-up (§4 *Host images*)" with "`fleet-host-entry` restarts it in the container (`single`: never counted toward the give-up; `host`: there is no give-up) (§4 *Host images*)".
  - §10: change the `fleet-host-entry` line's comment to `# tini CMD: host | workspace | single modes`.

- [ ] **Step 9: Commit**

```bash
git -C "$W" add docker/host/fleet-host-entry docker/host/fleet-host-entry.test.sh docker/host/Dockerfile docker/host/smoke.test.sh docs/SPEC.md
git -C "$W" commit -m "feat(host): fleet-host-entry host, workspace and single modes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Push and watch CI.** `git -C "$W" push -u origin HEAD`, open the PR (Task 11 Step 2) if it isn't open yet, and `gh run watch` the `Test runner images` run: the image build, `fleet-host-entry.test.sh` and `smoke.test.sh` must pass.

---

### Task 9: Two-pod wiring test with plain Docker

**Files:**
- Create: `docker/host/split.test.sh`
- Modify: `.github/workflows/test-runner-images.yml`
- Modify: `docs/SPEC.md` §4 smoke bullet

**Interfaces:**
- Consumes: the image from Task 8 and every env from Tasks 1–7.
- Produces: `bash docker/host/split.test.sh <image>` printing `runner-host two-pod split: OK`.

**Verify locally:** `bash -n` only. **CI only:** the run (Docker, Postgres). **Not testable in Docker:** D73 (mTLS, AuthorizationPolicies); Appendix B.

- [ ] **Step 1: Write `docker/host/split.test.sh`:**

```bash
#!/usr/bin/env bash
# The two-pod layout with plain Docker: wiring only. Docker has no mesh, so
# D73 is a cluster check. A container answering the sidecar readiness URL owns
# each "pod" network namespace, as istio-proxy would.
set -euo pipefail
image=$1
pg_image=pgvector/pgvector:0.8.7-pg16@sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f
n=split-$$
tmp=$(mktemp -d)
ids=()
cleanup() {
  for c in "${ids[@]}"; do echo "--- $c"; docker logs "$c" 2>&1 | tail -20 || true; docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$n" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
retry() { for _ in $(seq 1 30); do "$@" && return 0; sleep 1; done; return 1; }
until_eq() { local want=$1; shift; for _ in $(seq 1 30); do [ "$("$@" 2>/dev/null)" = "$want" ] && return 0; sleep 1; done; return 1; }

docker network create "$n" >/dev/null
mkdir -p "$tmp/cfg" "$tmp/key"
openssl genrsa -out "$tmp/key/key.pem" 2048 2>/dev/null
cat > "$tmp/cfg/config.yaml" <<'YAML'
workspace: { name: split }
grants:
  - { team: acme/platform, tier: session }
github: { appId: 1, installationId: 2, keyFile: /var/run/secrets/github-app/key.pem }
db: { host: pg, database: fleet, user: fleet_agent, password: { kind: env, name: FLEET_DB_PASSWORD }, ssl: disable }
search: { embedder: false }
YAML
chmod 0755 "$tmp/cfg" "$tmp/key"; chmod 0444 "$tmp/key/key.pem" "$tmp/cfg/config.yaml"

cat > "$tmp/brokerctl.js" <<'JS'
// OP=list|create [ID=…]: one broker request over CLAUDE_FLEET_BROKER_ADDR; prints the reply's JSON.
const net = require('net');
const [h, p] = process.env.CLAUDE_FLEET_BROKER_ADDR.split(':');
const frame = (t, o) => {
  const b = Buffer.from(o === undefined ? '' : JSON.stringify(o));
  const f = Buffer.alloc(5 + b.length);
  f.writeUInt32BE(b.length + 1, 0);
  f[4] = t;
  b.copy(f, 5);
  return f;
};
const create = process.env.OP === 'create';
const want = create ? 0x02 : 0x0b;
const c = net.connect(Number(p), h, () => c.write(create ? frame(0x01, { id: process.env.ID, cols: 80, rows: 24 }) : frame(0x0a)));
let buf = Buffer.alloc(0);
c.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const len = buf.readUInt32BE(0);
    const type = buf[4];
    const body = buf.subarray(5, 4 + len);
    buf = buf.subarray(4 + len);
    if (type === want) { console.log(body.toString()); c.destroy(); return; }
  }
});
c.on('error', (e) => { console.error(e.code || e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000).unref();
JS

ids+=("$(docker run -d --name "$n-pg" --network "$n" --network-alias pg -e POSTGRES_PASSWORD=admin "$pg_image")")
# -h 127.0.0.1: the image's init-time server listens on the Unix socket only.
retry docker exec "$n-pg" pg_isready -h 127.0.0.1 -U postgres -q || fail "postgres never came up"
docker run --rm --network "$n" -v "$tmp/cfg:/etc/fleet-host:ro" -e PGADMIN_PW=admin -e FLEET_DB_PASSWORD=app-pw \
  "$image" fleet-host bootstrap --admin-password-env PGADMIN_PW --admin-user postgres || fail "bootstrap"

ready_js="require('http').createServer((q,r)=>{r.statusCode=q.url==='/healthz/ready'?200:404;r.end()}).listen(15021,'127.0.0.1')"

# A workspace pod with no sidecar must never listen.
ids+=("$(docker run -d --name "$n-nomesh" --network "$n" -u 1000:1000 -e FLEET_HOST_CRED_ADDR=host-svc:8081 "$image" fleet-host-entry workspace)")

ids+=("$(docker run -d --name "$n-wsnet" --network "$n" --network-alias workspace-svc --entrypoint node "$image" -e "$ready_js")")
ids+=("$(docker run -d --name "$n-ws" --network "container:$n-wsnet" -u 1000:1000 \
  -e FLEET_HOST_CRED_ADDR=host-svc:8081 -e CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat \
  "$image" fleet-host-entry workspace)")
ids+=("$(docker run -d --name "$n-hostnet" --network "$n" --network-alias host-svc -p 127.0.0.1::8080 --entrypoint node "$image" -e "$ready_js")")
ids+=("$(docker run -d --name "$n-host" --network "container:$n-hostnet" -u 1001:1001 --read-only \
  --tmpfs /tmp --tmpfs /var/lib/fleet-host/state:mode=1777 \
  -e CLAUDE_FLEET_BROKER_ADDR=workspace-svc:7070 -e FLEET_HOST_MCP_ADDR=host-svc:8082 \
  -e FLEET_HOST_STATE=/var/lib/fleet-host/state -e FLEET_HOST_PROJECTS=/var/lib/fleet-host/projects \
  -e HOME=/var/lib/fleet-host/state -e FLEET_DB_PASSWORD=app-pw \
  -v "$tmp/cfg:/etc/fleet-host:ro" -v "$tmp/key:/var/run/secrets/github-app:ro" \
  "$image" fleet-host-entry host)")
port=$(docker port "$n-hostnet" 8080/tcp | head -1 | sed 's/.*://')

healthy() {
  local body=
  for _ in $(seq 1 60); do
    body=$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null || true)
    case $body in *'"lease":"holder"'*'"mesh":"ready"'*) return 0 ;; esac
    sleep 1
  done
  echo "last /healthz: ${body:-none}"
  return 1
}
bctl() { docker exec -i -e OP="$1" -e ID="${2:-}" "$n-host" node < "$tmp/brokerctl.js"; }

healthy || fail "host never became holder with mesh ready"
if [ "$(docker inspect -f '{{.State.Running}}' "$n-nomesh")" = true ]; then
  # 1B9E = 7070; 0A = LISTEN.
  docker exec "$n-nomesh" sh -c '! grep -q ":1B9E 00000000:0000 0A" /proc/net/tcp' || fail "broker listened without a sidecar"
fi

# fleet-host's side of :7070.
retry bctl list >/dev/null || fail "broker unreachable over :7070"
bctl create split1 | grep -q '"ok":true' || fail "CREATE over :7070"
bctl list | grep -q '{"id":"split1","alive":true}' || fail "LIST over :7070"

# A workspace process reaches :8081 (unscoped → 400) and :8082 (tools/list).
cred_js="const [h,p]=process.env.FLEET_HOST_CRED_ADDR.split(':');const r=require('http').request({host:h,port:Number(p),method:'POST',path:'/token',headers:{'content-type':'application/json'}},(s)=>{console.log(s.statusCode);s.resume()});r.on('error',(e)=>console.log(e.code));r.end('{\"repositories\":[]}')"
until_eq 400 docker exec "$n-ws" node -e "$cred_js" || fail "unscoped POST /token from the workspace pod"
mcp_js="const s=require('net').connect(8082,'host-svc',()=>s.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n'));let b='';s.setEncoding('utf8');s.on('data',(d)=>{b+=d;if(b.includes('\n')){console.log(JSON.parse(b).result.tools.length);s.destroy()}});s.on('error',(e)=>console.log(e.code))"
until_eq 14 docker exec "$n-ws" node -e "$mcp_js" || fail "tools/list on :8082 from the workspace pod"

# What each pod holds.
test "$(docker exec "$n-host" id -u)" = 1001 || fail "host pod uid"
test "$(docker exec "$n-ws" id -u)" = 1000 || fail "workspace pod uid"
docker exec "$n-ws" test ! -e /var/run/secrets/github-app/key.pem || fail "key file in the workspace pod"
docker exec "$n-ws" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "fleet-host[.]mjs" && exit 1; done; exit 0' \
  || fail "fleet-host runs in the workspace pod"

# Restarting the host pod leaves the broker and its sessions running.
ws_pid=$(docker inspect -f '{{.State.Pid}}' "$n-ws")
docker restart -t 15 "$n-host" >/dev/null
healthy || fail "host did not recover after a restart"
test "$(docker inspect -f '{{.State.Running}} {{.State.Pid}}' "$n-ws")" = "true $ws_pid" || fail "workspace pod restarted with the host"
bctl list | grep -q '{"id":"split1","alive":true}' || fail "session lost across a host restart"
docker logs "$n-host" 2>&1 | grep -q '"msg":"shutting down"' || fail "host restart was not a clean shutdown"

# The sidecar-less workspace pod gives up after 60 s and exits 1.
for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Running}}' "$n-nomesh")" = false ] && break; sleep 1; done
test "$(docker inspect -f '{{.State.ExitCode}}' "$n-nomesh")" = 1 || fail "workspace without a sidecar did not exit 1"
docker logs "$n-nomesh" 2>&1 | grep -q 'refusing to listen: no Istio sidecar' || fail "no-sidecar refusal not logged"
echo "runner-host two-pod split: OK"
```

- [ ] **Step 2: Syntax check** — `bash -n "$W/docker/host/split.test.sh"`. Expected: no output.

- [ ] **Step 3: Workflow.** In `.github/workflows/test-runner-images.yml`, after the *Smoke host image* step:

```yaml
      - name: Two-pod split test
        run: bash docker/host/split.test.sh claude-fleet/runner-host:test
```

- [ ] **Step 4: SPEC.** §4 smoke bullet, append: "`docker/host/split.test.sh` runs the two-pod layout with plain Docker (Postgres and `fleet-host bootstrap` so a holder serves :8082; a container answering the readiness URL owns each pod's network namespace): `/healthz` reports holder and `mesh: "ready"`, a frame client in the host container creates and lists a broker session over :7070, a workspace process gets 400 for an unscoped `POST /token` on :8081 and `tools/list` on :8082, the workspace container has no key file and no fleet-host process, restarting the host container leaves the broker and its session running, and a workspace container with no responder never listens and exits 1. Docker has no mesh, so it can't test D73. `test-runner-images.yml` runs it after the smoke test."

- [ ] **Step 5: Commit, push, watch CI**

```bash
git -C "$W" add docker/host/split.test.sh .github/workflows/test-runner-images.yml docs/SPEC.md
git -C "$W" commit -m "test(host): two-pod wiring test with plain Docker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$W" push
```

Then `gh run watch` the `Test runner images` run; `Two-pod split test` must print `runner-host two-pod split: OK`.

---

### Task 10: SPEC: the two-pod layout as built

**Files:**
- Modify: `docs/SPEC.md` §5 *Architecture* (remote-workspace diagram), §7 *Remote host* (intro, *Topology*, *Embedder* placement, `query` note), §9, §11

**Interfaces:** none (docs only).

**Verify locally:** `command grep -an 'prep\b\|fsGroup\|share uid 1000\|Until the container split' "$W/docs/SPEC.md"` prints nothing about the host split.

- [ ] **Step 1: §5.** Replace the remote-workspace sentence and diagram (from "A **remote workspace** runs `fleet-host` next to the broker in one container;" through the closing code fence) with:

````markdown
A **remote workspace** is two pods from one image (§7 *Remote host*); desktops reach fleet-host over HTTP/WebSocket. `single` mode runs both halves in one container for local and dev use.

```
┌───────────── host pod (uid 1001) ──────┐        ┌──── workspace pod (uid 1000) ────┐
│ fleet-host (node)            :8080 ◄───┼─ gateway ◄── desktops (Bearer)           │
│   credentials                :8081 ◄───┼── mTLS ── fleet-host-cred, gh, git       │
│   fleet-state MCP            :8082 ◄───┼── mTLS ── mcp-bridge.cjs                 │
│   broker client ───────── mTLS ────────┼──► :7070 broker ── claude PTYs           │
│ App key, ConfigMap, DB role            │        │ transcripts → claude EFS (rw)    │
│ transcripts ◄── claude EFS (ro)        │        │                                  │
└────────────────────────────────────────┘        └──────────────────────────────────┘
```
````

- [ ] **Step 2: §7.**
  - Intro: replace "from a `runner-host` pod (§4 *Host images*)" with "from a host pod, with the broker and sessions in a separate workspace pod (§4 *Host images*, *Supervision*; `single` keeps both in one container)".
  - **Topology**: append "Inside the cluster: the host pod (SA `fleet-agent`, Pod Identity `fleet-host`) dials the workspace pod's broker at `CLAUDE_FLEET_BROKER_ADDR` (:7070); the workspace pod's sessions reach the host pod's credential server (:8081) and MCP (:8082) through an internal Service. Istio `STRICT` mTLS and selector-scoped AuthorizationPolicies admit only `fleet-agent` to :7070, only `fleet-agent-workspace` to :8081/:8082, and only the gateway's principal (`cluster.local/ns/platform-ops/sa/platform-ops-infra-gateway-*`) to :8080 (D73). The two pods share only the `claude` EFS volume, read-only on the host (`FLEET_HOST_PROJECTS`). Reference pod specs and policies: `superpowers/specs/2026-11-05-host-container-split-design.md` §5."
  - *Embedder* → **Placement**: replace "Under the host/workspace split (§11) that is the host pod; the workspace pod has the same files but never starts fleet-host, and `search_transcripts` reaches the host pod over the MCP's :8082 with the same handler and scope. In the single-container image the sidecar shares the session container (§9)." with "That is the host pod; the workspace pod has the same files but never starts fleet-host, and `search_transcripts` reaches the host pod over :8082 with the same handler and scope. In `single` the sidecar shares the session container (§9)."
  - *Host MCP* → **`query`**: replace the last sentence ("Until the container split, sessions can reach the app role itself …") with "In the two-pod layout sessions hold neither the app role nor the query login (the `fleet-workspace` role has no RDS access), so this is a boundary; in `single` sessions share fleet-host's identity and it is defense in depth."
  - *GitHub App credentials*: replace "It is not a boundary against a session while sessions share fleet-host's uid (§9)." with "It is a boundary against a session in the two-pod layout, and not in `single` (§9)."

- [ ] **Step 3: §9.** Replace "The broker stays on its Unix socket: `fleet-host-entry` refuses to start with `CLAUDE_FLEET_BROKER_TCP_PORT` set." with "In `single` the broker stays on its Unix socket (`fleet-host-entry single` refuses `CLAUDE_FLEET_BROKER_TCP_PORT`); in the two-pod layout it is on TCP behind the mesh (below)." Replace the two bullets starting **Known risk: fleet-host, the broker and every claude session share uid 1000.** and **The shared uid also defeats the host's other controls.** (including its sub-bullets and closing paragraph) with:

```markdown
- **In the two-pod layout a session can't reach fleet-host's process, key, config or DB identity.** fleet-host runs alone in the host pod (uid 1001, SA `fleet-agent`, Pod Identity `fleet-host` with `rds-db:connect` as `fleet_agent` and `fleet_agent_query`), with the App key (Secret, 0444; nothing else runs there), the ConfigMap and viewers' bearer tokens. The broker and sessions run in the workspace pod (uid 1000, SA `fleet-agent-workspace`, Pod Identity `fleet-workspace` chained by AWS profiles to `infra-llmbot-viewonly`, no RDS access). They share no network or PID namespace and no volume but the transcripts, read-only on the host. Both pods set `automountServiceAccountToken: false`.
- **The broker port's security rests entirely on the mesh.** The broker has no authentication of its own. A missing sidecar on the workspace pod (the broker then refuses to listen), a non-`STRICT` PeerAuthentication, a missing or widened AuthorizationPolicy, or an inbound-port exclusion exposes session control (create, type into, attach to every session) to the whole cluster. The chart must enforce `STRICT` and the policy; the app can't detect their absence.
- **:8081 and :8082 rest on the mesh the same way.** Without the host policy any mesh workload can mint repo tokens within `github.repositories`/`github.permissions` and read or write the workspace's todos and automations through the MCP. fleet-host keeps both closed without a ready sidecar and reports `mesh: "missing"`.
- **A session's App installation token is never a host grant:** config parse refuses a `machines` rule for `github.appId`.
- **Sessions share one uid with each other and with the broker.** Every session can read and signal every other session and the broker, and can drive the broker on `127.0.0.1:7070`, which doesn't pass the sidecar. Tiers already treat `steer` as running code in the workspace.
- **Sessions share the workspace pod's network namespace with its sidecar.** They reach its admin port (:15000) and can stop it. That fails closed (the broker, :8081 and :8082 become unreachable): a denial of service, not a bypass.
- **Ingest lags** by `FLEET_HOST_RESCAN_MS` (5 s in the host pod) plus EFS attribute caching (`actimeo=1`). Ingest never follows a symlink or reads outside `FLEET_HOST_PROJECTS`.
- **`single` mode keeps the shared uid.** Sessions can signal fleet-host, read its `/proc/<pid>` (environ, and memory where ptrace is allowed, which holds open sockets' raw tokens), read the App key, use the pod's AWS identity against the host DB (bypassing the lease fence), read the config and fleet-host's environment, or kill fleet-host and listen on :8080 to collect reconnecting viewers' tokens. The port check before every start ends the container instead of starting onto a squatted port; nothing else is mitigated. Local and dev only.
```

In the **The embedder sidecar parses session-written transcript text** bullet, replace "In single-container mode" with "In `single`".

- [ ] **Step 4: §11.** Delete the `### Host/workspace split` subsection. In *Remote host: what remains*: delete the **The two-pod MCP listener** bullet; in **Script steps on the host** replace "after the host/workspace split, only fleet-host's pod holds the DB role" with "only the host pod holds the DB role"; add a bullet "**Host checklist for the two-pod split:** the cluster checks in the plan's Appendix B (`superpowers/plans/2026-11-05-host-container-split.md`) before go-live."

- [ ] **Step 5: Verify and commit**

Run: `command grep -an 'prep\b\|fsGroup\|share uid 1000\|Until the container split\|container split' "$W/docs/SPEC.md"`
Expected: no line about the host split (unrelated uses of the words are fine; read each hit).

```bash
git -C "$W" add docs/SPEC.md
git -C "$W" commit -m "docs(spec): the host/workspace split as two pods

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Gate, PR, infra handoff

**Files:** none new.

**Verify locally:** the gate below. **CI:** every workflow on the PR. **Cluster:** Appendix B, by Work after platform-ops#36.

- [ ] **Step 1: Full local gate**, each command separately:

```bash
cd "$W" && npx vitest run src/host/
cd "$W" && npx tsc --noEmit -p tsconfig.host.json
cd "$W" && npx tsc --noEmit -p tsconfig.node.json
cd "$W" && npx tsc --noEmit -p tsconfig.web.json
cd "$W/broker" && go test -race ./...
cd "$W" && FLEET_BROKER_BIN=/tmp/fleet-broker-split npx vitest run src/host/broker.integration.test.ts
bash "$W/docker/host/fleet-host-entry.test.sh"
bash "$W/docker/host/gh.test.sh"
bash -n "$W/docker/host/split.test.sh"
```

Expected: all pass. (The vitest/tsc lines `cd` into the worktree, never the main checkout.)

- [ ] **Step 2: PR.** One PR for Tasks 1–10 (or one per task if reviewers prefer; each task leaves `main` shippable). Factual body: the new env per task, that the image `CMD` now needs a mode (D88), the test commands, and that platform-ops#36 must set `args` before taking the new digest. End with the Claude Code footer. `gh pr merge --auto --squash <n>`.

- [ ] **Step 3: Handoff to Work.** Append to `/shared/remote-agent-design/threads/001-kickoff.md`: the PR URL; the `runner-devops-host` digest once `publish-runner.yml` publishes it; Appendix A and B of this plan verbatim; and these call-outs: (a) D88 — add `args: ["fleet-host-entry", "single"]` to today's Rollout now (the current image ignores it), then switch to the two-pod specs with the new digest; (b) `fsGroup: 1000` and any key copy go away (S6); (c) `FLEET_HOST_STATE` moves off EFS to an emptyDir; (d) the EFS PV's `mountOptions` gain `actimeo=1`; (e) the host pod's memory request rises by 256 Mi (D83); (f) the `migrate`/`bootstrap` Jobs run under SA `fleet-agent` as uid 1001.

---

## Appendix A: Kubernetes and Istio manifests for platform-ops#36

Reference shapes for Work; names in `<>` are infra's. Not committed as deployable files in this repo. Both pods are in the mesh (`istio.enabled: true`). The same image serves both pods (`runner-devops-host`, `linux/amd64` only, D82).

```yaml
# Host pod (Rollout fleet-agent; 1 replica, maxSurge: 0, maxUnavailable: 1)
spec:
  serviceAccountName: fleet-agent                 # Pod Identity association: fleet-host
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
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      env:
        - { name: CLAUDE_FLEET_BROKER_ADDR, value: "<workspace-svc>.platform-ops.svc:7070" }
        - { name: FLEET_HOST_MCP_ADDR, value: "<host-internal-svc>.platform-ops.svc:8082" }
        - { name: FLEET_HOST_STATE, value: /var/lib/fleet-host/state }
        - { name: FLEET_HOST_PROJECTS, value: /var/lib/fleet-host/projects }
        - { name: HOME, value: /var/lib/fleet-host/state }
      resources:
        requests:
          memory: <current host request + 256Mi>    # D83: fleet-embedder runs here (D81)
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
        defaultMode: 0444
    - { name: config, configMap: { name: fleet-agent-host-config } }
    - { name: host-state, emptyDir: {} }
    - { name: host-tmp, emptyDir: { medium: Memory, sizeLimit: 64Mi } }
    - { name: claude, persistentVolumeClaim: { claimName: <claude-efs> } }
---
# Workspace pod (Deployment fleet-agent-workspace; replicas: 1, strategy: Recreate)
spec:
  serviceAccountName: fleet-agent-workspace       # Pod Identity association: fleet-workspace
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
---
apiVersion: v1
kind: Service
metadata: { name: <workspace-svc>, namespace: platform-ops }
spec:
  type: ClusterIP
  selector: { app: <workspace-pod-label> }
  ports: [{ name: tcp-broker, port: 7070, targetPort: 7070, appProtocol: tcp }]
---
apiVersion: v1
kind: Service
metadata: { name: <host-internal-svc>, namespace: platform-ops }
spec:
  type: ClusterIP
  selector: { app: <host-pod-label> }
  ports:
    - { name: http-cred, port: 8081, targetPort: 8081 }
    - { name: tcp-mcp, port: 8082, targetPort: 8082, appProtocol: tcp }
# Not routed by any gateway or VirtualService. fleet-agent-svc keeps only :8080.
---
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
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata: { name: fleet-agent-workspace-broker, namespace: platform-ops }
spec:
  host: <workspace-svc>.platform-ops.svc.cluster.local
  trafficPolicy:
    portLevelSettings:
      - port: { number: 7070 }
        connectionPool: { tcp: { idleTimeout: 0s } }   # Envoy otherwise cuts a quiet viewer's attach after 1 h
```

Notes for Work:
- A selector-scoped ALLOW policy denies everything it doesn't match, so the host policy lists :8080 for the gateway. Kubelet `httpGet` probes still pass: Istio rewrites them through the sidecar agent.
- The gateway SA is the upstream Istio `gateway` chart's default, named after the Argo Application `platform-ops-infra-gateway-<color>-controller`; the prefix matches every hub color.
- The `claude` EFS PersistentVolume carries `mountOptions: [actimeo=1]`; NFS defaults would hide new transcript files from the host for up to 60 s.
- Never set `traffic.sidecar.istio.io/excludeInboundPorts` or `excludeOutboundPorts` to 7070, 8080, 8081 or 8082.
- No DestinationRule for :8082 (D93): the MCP bridge reconnects and resends.
- Sessions reach `infra-llmbot-viewonly` through `~/.aws/config` profiles on the EFS home or from a loadout: `role_arn = arn:aws:iam::<acct>:role/infra-llmbot-viewonly`, `credential_source = EcsContainer`. claude-fleet ships no AWS change.
- `migrate` and `bootstrap` Jobs: SA `fleet-agent`, `runAsUser: 1001`, `args: ["fleet-host", "migrate"]` / `["fleet-host", "bootstrap", …]`; they get the `fleet-host` role through Pod Identity.
- Rollout order (D88): land `args: ["fleet-host-entry", "single"]` on today's Rollout first; then switch to the two pods above together with the new digest.

## Appendix B: Host checklist (cluster, before go-live)

- From a mesh pod under another SA, and from an out-of-mesh pod: :7070 (workspace Service), :8081 and :8082 (host internal Service) refuse.
- From the workspace pod: :8080 and the host pod's other ports refuse; `fleet-host-cred git-credential get` for an allowed repo returns a token through :8081; a session's `claude-fleet-state` tools work through :8082 (`list_sessions` sees only the hosted workspace; `search_transcripts` returns hits).
- From the host pod: :7070 works (a desktop can create, attach to and list sessions).
- A workspace pod started without its sidecar never listens and exits 1 (`refusing to listen: no Istio sidecar`).
- A host pod started without its sidecar is unready with `/healthz` `mesh: "missing"`, and :8081/:8082 refuse.
- `aws sts get-caller-identity` in a session shows the `fleet-workspace` role (or `infra-llmbot-viewonly` through the profile), and `aws rds generate-db-auth-token` for `fleet_agent` then fails to connect.
- A new transcript line appears in the desktop's history within about 6 s (`FLEET_HOST_RESCAN_MS` 5 s + `actimeo=1`).
- An attach left idle for over an hour still receives output.
- `fleet-host embed-check` in the host pod prints `"ok":true` (D81).

## Self-review

**Spec coverage.**
- S1 entrypoint modes, no mode → 2, `prep` gone: Task 8 (modes, usage, exit 2), Task 4 (D85 removes the group mode prep relied on).
- S2 `single` unchanged plus warning, Unix sockets, desktop unaffected: Task 8 (`run_single`), Global Constraints.
- S3 broker TCP on 0.0.0.0, `REQUIRE_MESH`, 60 s, exit 1, `workspace` sets env and requires `FLEET_HOST_CRED_ADDR`, `single` refuses TCP: Task 1, Task 8.
- S4 `CLAUDE_FLEET_BROKER_ADDR`, per-op dial: Task 2. `FLEET_HOST_CRED_TCP_PORT`: Task 3. `FLEET_HOST_MCP_TCP_PORT`, caller fixed, no token: Task 4. `FLEET_HOST_MCP_ADDR`/`hostMcpArgs` TCP form: Task 4. `host` mode defaults and refusals: Task 8. Mesh check, ports closed, error log, `/healthz` `mesh: "missing"`: Task 5. What fleet-host can't see: Task 5 SPEC, Task 10 §9.
- S5 `fleet-host-cred` over TCP; `serve` socket-only: Task 3.
- S6 App key 0444, host pod only: Appendix A, Task 6 SPEC, Task 9 (no key in workspace container).
- S7 `machines` refusal: Task 6.
- S8 state on emptyDir, projects read-only, `O_NOFOLLOW`/regular/realpath, `FLEET_HOST_RESCAN_MS` 60000 / 5000: Task 7, Task 8, Appendix A.
- S9 supervision in `host`, uid refusal, squat check; AWS and `automountServiceAccountToken`; unit tests (mesh guard Task 1, `readHostEnv` Tasks 2–7, cred/MCP on TCP Tasks 3–4, `requestToken` TCP Task 3, `hostMcpArgs` TCP Task 4, mesh check Task 5, `machines` Task 6, ingest symlinks Task 7, `FLEET_MESH_READY_URL` Tasks 1 and 5); `fleet-host-entry.test.sh` all three modes Task 8; `split.test.sh` Task 9; host checklist Appendix B.
- §5 pod specs, Services, PeerAuthentication, AuthorizationPolicy, gateway prefix, `actimeo=1`, no port exclusions, DestinationRule `idleTimeout: 0s`: Appendix A.
- §6 residual risks into SPEC §9: Task 10.
- D71, D81, D82, D83: Global Constraints; D83 in Appendix A.

**Placeholder scan.** No TBD/TODO. The only `<…>` values are infra-owned names and the current memory request in Appendix A, which the spec also leaves to infra.

**Type consistency.** `HostPort`, `parseHostPort`, `parsePort` (Task 2) are used by Tasks 3–4; `ListenTarget`/`listenOn` (Task 3) by Task 4 and `main.ts`; `CredServer.port` and `HostMcp.port` are `number | null` throughout; `HolderOptions.mcp` is `{ listen, args }` in Task 4 and gains `ready` in Task 5, matching `main.ts` in both; `MeshState` is `'checking' | 'ready' | 'missing'` in `mesh.ts`, `server.ts` and the tests; `HostEnv` field names (`brokerAddr`, `credPort`, `mcpPort`, `mcpAddr`, `requireMesh`, `meshReadyUrl`, `rescanMs`) match the defaults object built up across Tasks 2–7.
