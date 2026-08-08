# Serving-Ports Rail Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable "Serving" section on the observability rail listing live HTTP-serving ports per workspace (both rail scopes), each row with open-preview and kill actions.

**Architecture:** The broker's `PORTS` reply gains `pid`/`cmdline` (socket inode → `/proc` scan) plus new `KILLPORT 0x18`/`KILLED 0x19` frames that resolve the PID at kill time. The host-side `PortForwardManager` keeps an authoritative per-workspace snapshot of probe-passed ports and broadcasts `ports:changed`; new `ports:list`/`ports:kill` IPC handles round it out. The renderer seeds from `ports:list`, applies broadcasts, and renders a `PortsSection` in `ObservabilityPane`. Mock mode gets a fake-ports feed so the UI works without Docker.

**Tech Stack:** Go 1.22 (broker), TypeScript + Electron main (host), React (renderer), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-07-serving-ports-rail-design.md` (approved).

## Global Constraints

- Work happens in the worktree `/workspace/claude-fleet/.claude/worktrees/serving-ports-rail` on branch `feat/serving-ports-rail-spec`. **Never `cd` into `/workspace/claude-fleet` itself** (it's the shared main checkout on a different branch). Run repo commands as `(cd /workspace/claude-fleet/.claude/worktrees/serving-ports-rail && <cmd>)`. Below, `$WT` means that worktree path.
- Worktrees resolve node modules up to `/workspace/claude-fleet/node_modules` (the base install). Do not run `npm install` in the worktree.
- This container has **no display**: UI changes are gated by `npm run typecheck` + `npm run test:unit` + `npm run build` only. Say so in the PR; Troy eyeballs the UI on his host.
- `docs/SPEC.md` must be updated in the same PR (Task 13) — rule `.claude/rules/spec-maintenance.md`.
- Existing behavior that must NOT change: the `ports:detected` sticky toast, `ports:open`'s verify-then-forward flow, `MAX_PROBE_ATTEMPTS = 3`, poll interval 3000 ms, `INFRA_PORTS` exclusion.
- Old runner images (broker without `pid` in `PORTS`) must keep working: rows render port-only and the kill button is hidden. No version handshake.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Frame numbering: `KILLPORT = 0x18`, `KILLED = 0x19` (verified free after `PORTS 0x17`).

---

### Task 1: Toolchain + test-env setup

**Files:** none in-repo (environment only).

**Interfaces:**
- Consumes: nothing.
- Produces: a working `go` (≥1.22) on PATH via `$HOME/toolchains/go/bin`, and confirmed-working vitest env.

- [ ] **Step 1: Install Go 1.22 locally** (no root needed)

```bash
mkdir -p $HOME/toolchains && cd /tmp \
  && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
  && curl -fsSLo go.tgz https://go.dev/dl/go1.22.12.linux-${ARCH}.tar.gz \
  && tar -C $HOME/toolchains -xzf go.tgz && rm go.tgz \
  && $HOME/toolchains/go/bin/go version
```

Expected: `go version go1.22.12 linux/amd64` (or arm64).

Every broker command below assumes `export PATH=$HOME/toolchains/go/bin:$PATH` at the start of the shell invocation.

- [ ] **Step 2: Verify broker tests pass at baseline**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && CGO_ENABLED=0 go test -race ./...)
```

Expected: `ok` for all packages (module `github.com/creack/pty` downloads from the proxy on first run).

- [ ] **Step 3: Verify vitest env fixes are in place**

The base `node_modules` needs two container-specific fixes (prebuilt `better_sqlite3.node`, electron `path.txt` stub). They were applied in a prior session; confirm:

```bash
ls /workspace/claude-fleet/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && cat /workspace/claude-fleet/node_modules/electron/path.txt
```

Expected: the `.node` file exists and `path.txt` prints `electron-stub`. If missing, redo per `~/.claude/projects/-workspace/memory/run-unit-tests-env.md`.

- [ ] **Step 4: Verify baseline unit tests pass**

```bash
(cd $WT && npx vitest run src/main/portforward.test.ts)
```

Expected: PASS. No commit for this task.

---

### Task 2: Broker — portscan owner resolution

**Files:**
- Modify: `broker/internal/portscan/portscan.go` (74 lines — full rewrite below)
- Modify: `broker/internal/portscan/portscan_test.go`
- Modify (compile fix only): `broker/internal/server/server.go:36,40` (`ListPorts` field type)

**Interfaces:**
- Consumes: `/proc/net/tcp[6]`, `/proc/<pid>/fd/*`, `/proc/<pid>/cmdline`.
- Produces: `type Detail struct { Port uint16; Pid int; Cmdline string }` and `func Listening() ([]Detail, error)` — `Pid == 0` / `Cmdline == ""` mean "unresolved". Task 5 consumes `Detail`; Task 3 adds `KillOwner` beside it.

- [ ] **Step 1: Write the failing tests**

Replace the body of `broker/internal/portscan/portscan_test.go` with (keep the package line):

```go
package portscan

import (
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"testing"
)

// Two LISTEN rows (ports 3000/0x0BB8 inode 12345, 8765/0x223D inode 67890)
// and one ESTABLISHED row that must be ignored.
const sampleProcNet = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:0400 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
`

func TestParseProcNet_CapturesListenPortsAndInodes(t *testing.T) {
	into := map[uint16]uint64{}
	if err := parseProcNet(strings.NewReader(sampleProcNet), into); err != nil {
		t.Fatalf("parseProcNet: %v", err)
	}
	if len(into) != 2 {
		t.Fatalf("want 2 LISTEN ports, got %v", into)
	}
	if into[3000] != 12345 || into[8765] != 67890 {
		t.Fatalf("wrong port→inode map: %v", into)
	}
}

func TestParseProcNet_DedupesAcrossCalls(t *testing.T) {
	into := map[uint16]uint64{}
	_ = parseProcNet(strings.NewReader(sampleProcNet), into)
	_ = parseProcNet(strings.NewReader(sampleProcNet), into) // tcp6 pass, same ports
	if len(into) != 2 {
		t.Fatalf("want 2 ports after double parse, got %d", len(into))
	}
}

// Integration: listen on a real socket and assert Listening() attributes it
// to this test process.
func TestListening_ResolvesOwnPidAndCmdline(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc/net/tcp on this host")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	details, err := Listening()
	if err != nil {
		t.Fatalf("Listening: %v", err)
	}
	var mine *Detail
	for i := range details {
		if details[i].Port == port {
			mine = &details[i]
		}
	}
	if mine == nil {
		ports := make([]int, 0, len(details))
		for _, d := range details {
			ports = append(ports, int(d.Port))
		}
		sort.Ints(ports)
		t.Fatalf("own port %d not in scan %v", port, ports)
	}
	if mine.Pid != os.Getpid() {
		t.Fatalf("want pid %d, got %+v", os.Getpid(), mine)
	}
	// cmdline of a `go test` binary contains the package's test binary name.
	if !strings.Contains(mine.Cmdline, "portscan.test") {
		t.Fatalf("cmdline %q does not look like this test binary", mine.Cmdline)
	}
	_ = fmt.Sprintf // keep fmt imported if assertions change
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && go test ./internal/portscan/)
```

Expected: compile FAIL (`parseProcNet` signature, `Detail` undefined).

- [ ] **Step 3: Rewrite `portscan.go`**

Replace the whole file with:

```go
// Package portscan enumerates the TCP ports a process inside the broker's
// container is listening on, by parsing /proc/net/tcp[6], and attributes
// each to its owning process (socket inode → /proc/*/fd scan → cmdline).
// The fleet user owns every process in the container, so no CAP_NET_ADMIN
// or root is required. Attribution is best-effort: a Detail with Pid 0 is
// a port whose owner could not be resolved (fd race, exotic mounts).
package portscan

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// tcpStateListen is the value of the "st" column for a LISTEN socket
// (kernel TCP_LISTEN == 10 == 0x0A), rendered as a 2-char hex string.
const tcpStateListen = "0A"

// maxCmdline bounds what we ship over the wire per port; the rail
// truncates further for display, this is just a payload cap.
const maxCmdline = 120

// Detail is one listening TCP port and (best-effort) its owner.
type Detail struct {
	Port    uint16
	Pid     int    // 0 when unresolved
	Cmdline string // "" when unresolved
}

// Listening returns the deduped set of TCP ports in LISTEN state across
// IPv4 and IPv6, each attributed to its owning process where possible.
// A missing /proc file (non-Linux dev hosts) is not an error — it
// contributes nothing.
func Listening() ([]Detail, error) {
	inodes := map[uint16]uint64{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		err = parseProcNet(f, inodes)
		_ = f.Close()
		if err != nil {
			return nil, err
		}
	}
	owners := resolveOwners(inodes)
	out := make([]Detail, 0, len(inodes))
	for port, inode := range inodes {
		d := Detail{Port: port}
		if o, ok := owners[inode]; ok {
			d.Pid = o.pid
			d.Cmdline = o.cmdline
		}
		out = append(out, d)
	}
	return out, nil
}

// parseProcNet scans one /proc/net/tcp-format stream, recording the local
// port and socket inode of every LISTEN row. Lines it can't parse are
// skipped (defensive: a malformed row must never abort detection). A port
// already present keeps its first inode (v4 wins over a dual-stack v6 row
// — same process either way).
func parseProcNet(r io.Reader, into map[uint16]uint64) error {
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if first {
			first = false // header row
			continue
		}
		fields := strings.Fields(line)
		// fields: sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode ...
		if len(fields) < 10 || fields[3] != tcpStateListen {
			continue
		}
		local := fields[1] // "IPHEX:PORTHEX"
		colon := strings.LastIndex(local, ":")
		if colon < 0 {
			continue
		}
		port, err := strconv.ParseUint(local[colon+1:], 16, 16)
		if err != nil {
			continue
		}
		if _, exists := into[uint16(port)]; exists {
			continue
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		into[uint16(port)] = inode
	}
	return sc.Err()
}

type owner struct {
	pid     int
	cmdline string
}

// resolveOwners maps socket inodes to their owning process by scanning
// /proc/*/fd for "socket:[inode]" symlinks. Entirely best-effort: any
// unreadable dir or vanished process just resolves nothing.
func resolveOwners(inodes map[uint16]uint64) map[uint64]owner {
	want := map[uint64]struct{}{}
	for _, ino := range inodes {
		want[ino] = struct{}{}
	}
	out := map[uint64]owner{}
	if len(want) == 0 {
		return out
	}
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	for _, p := range procs {
		pid, err := strconv.Atoi(p.Name())
		if err != nil {
			continue
		}
		fdDir := "/proc/" + p.Name() + "/fd"
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(fdDir + "/" + fd.Name())
			if err != nil || !strings.HasPrefix(link, "socket:[") || !strings.HasSuffix(link, "]") {
				continue
			}
			ino, err := strconv.ParseUint(link[len("socket:["):len(link)-1], 10, 64)
			if err != nil {
				continue
			}
			if _, wanted := want[ino]; !wanted {
				continue
			}
			if _, done := out[ino]; done {
				continue
			}
			out[ino] = owner{pid: pid, cmdline: readCmdline(pid)}
		}
		if len(out) == len(want) {
			break
		}
	}
	return out
}

// readCmdline renders /proc/<pid>/cmdline (NUL-separated argv) as a
// space-joined string, capped at maxCmdline runes.
func readCmdline(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	s := strings.TrimRight(strings.ReplaceAll(string(b), "\x00", " "), " ")
	if r := []rune(s); len(r) > maxCmdline {
		s = string(r[:maxCmdline]) + "…"
	}
	return s
}
```

- [ ] **Step 4: Fix `server.go` to compile against `[]Detail`**

In `broker/internal/server/server.go` change the field and the `FrameListPorts` case *minimally* (full enrichment lands in Task 5):

```go
// field (line ~36):
ListPorts func() ([]portscan.Detail, error)
```

and in the `case proto.FrameListPorts:` block:

```go
resp := proto.PortsResponse{Ports: make([]proto.PortInfo, len(ports))}
for i, p := range ports {
	resp.Ports[i] = proto.PortInfo{Port: p.Port}
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && CGO_ENABLED=0 go test -race ./...)
```

Expected: all packages PASS (including the own-pid integration test).

- [ ] **Step 6: Commit**

```bash
git -C $WT add broker/internal/portscan/ broker/internal/server/server.go \
  && git -C $WT commit -m "feat(broker): attribute listening ports to pid+cmdline via /proc inode scan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Broker — KillOwner

**Files:**
- Modify: `broker/internal/portscan/portscan.go` (append)
- Modify: `broker/internal/portscan/portscan_test.go` (append)

**Interfaces:**
- Consumes: `Listening()` from Task 2.
- Produces: `func KillOwner(port uint16, grace time.Duration) error` — resolves the owning PID at call time, SIGTERM, waits up to `grace`, then SIGKILL. Task 5 wires it to `KILLPORT`.

- [ ] **Step 1: Write the failing test** (append to `portscan_test.go`; add `"os/exec"`, `"time"` to imports)

The killed process must be a real child that listens; `os/exec` + a tiny shell loop keeps it dependency-free:

```go
// Spawn a child that listens on a port and ignores nothing (default TERM
// disposition = die), then KillOwner it and assert the port closes.
func TestKillOwner_TerminatesListener(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	// A python one-liner is the most portable always-present listener in the
	// runner image and dev containers alike; skip if python3 is missing.
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not on PATH")
	}
	cmd := exec.Command(py, "-c",
		`import socket,sys,time
s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen()
print(s.getsockname()[1], flush=True)
time.sleep(300)`)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start listener: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()

	var port uint16
	if _, err := fmt.Fscan(out, &port); err != nil {
		t.Fatalf("read child port: %v", err)
	}

	if err := KillOwner(port, 2*time.Second); err != nil {
		t.Fatalf("KillOwner: %v", err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("child exited 0 — expected signal death")
	}

	// And the port must be gone from the scan.
	details, err := Listening()
	if err != nil {
		t.Fatalf("Listening after kill: %v", err)
	}
	for _, d := range details {
		if d.Port == port {
			t.Fatalf("port %d still listening after KillOwner", port)
		}
	}
}

func TestKillOwner_NoOwnerIsError(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	// Port 1 requires root to bind; nothing in a test env listens there.
	if err := KillOwner(1, time.Millisecond); err == nil {
		t.Fatal("expected error for unowned port")
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && go test ./internal/portscan/ -run TestKillOwner)
```

Expected: compile FAIL (`KillOwner` undefined).

- [ ] **Step 3: Implement** (append to `portscan.go`; add `"syscall"`, `"time"` to imports)

```go
// KillOwner terminates the process listening on port. The PID is resolved
// from the live socket AT CALL TIME — never accepted from the host — which
// removes any PID-reuse hazard. SIGTERM first; if the process survives
// `grace`, SIGKILL. Returns an error when the port has no resolvable owner
// or the first signal fails.
func KillOwner(port uint16, grace time.Duration) error {
	details, err := Listening()
	if err != nil {
		return err
	}
	pid := 0
	for _, d := range details {
		if d.Port == port {
			pid = d.Pid
			break
		}
	}
	if pid == 0 {
		return fmt.Errorf("no resolvable owner for port %d", port)
	}
	proc, err := os.FindProcess(pid) // never fails on unix
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			return nil // gone
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = proc.Signal(syscall.SIGKILL)
	return nil
}
```

- [ ] **Step 4: Run to verify pass**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && CGO_ENABLED=0 go test -race ./internal/portscan/)
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C $WT add broker/internal/portscan/ \
  && git -C $WT commit -m "feat(broker): KillOwner — TERM-then-KILL the process behind a listening port

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Broker — proto frames + enriched PortInfo

**Files:**
- Modify: `broker/internal/proto/proto.go`
- Modify: `broker/internal/proto/proto_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FrameKillPort FrameType = 0x18`, `FrameKilled FrameType = 0x19`, `type KillPortRequest struct { Port uint16 }`, `type KilledResponse struct { OK bool; Error string }`, and `PortInfo` gaining `Pid int` / `Cmdline string` (both `omitempty`). Task 5 and Task 6 consume these.

- [ ] **Step 1: Extend the failing name-table test**

In `broker/internal/proto/proto_test.go`, the `String()` table test (~line 150) maps frame constants to names. Add two entries:

```go
		FrameKillPort:  "KILLPORT",
		FrameKilled:    "KILLED",
```

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && go test ./internal/proto/)
```

Expected: compile FAIL (undefined constants).

- [ ] **Step 3: Implement in `proto.go`**

(a) Constants (after `FramePorts FrameType = 0x17`):

```go
	FrameKillPort  FrameType = 0x18
	FrameKilled    FrameType = 0x19
```

(b) `String()` cases (after the `FramePorts` case):

```go
	case FrameKillPort:
		return "KILLPORT"
	case FrameKilled:
		return "KILLED"
```

(c) `PortInfo` (replace the existing struct; owner fields are best-effort — absent when the broker couldn't resolve them, which is also how an OLD broker's payload reads, so the host gates the kill affordance on `pid` presence):

```go
// PortInfo is one listening TCP port detected inside the container,
// attributed (best-effort) to its owning process. Pid/Cmdline are omitted
// when unresolved; the host treats their absence as "no kill capability".
type PortInfo struct {
	Port    uint16 `json:"port"`
	Pid     int    `json:"pid,omitempty"`
	Cmdline string `json:"cmdline,omitempty"`
}
```

(d) Request/response shapes (after `PortsResponse`):

```go
// KillPortRequest asks the broker to terminate the process listening on
// Port. The broker resolves port→PID itself at kill time (SIGTERM, 2s
// grace, then SIGKILL) — it never trusts a host-supplied PID.
type KillPortRequest struct {
	Port uint16 `json:"port"`
}

type KilledResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}
```

(e) Header doc-comment catalog — in the `Port forward (JSON):` block of the package comment, extend the `PORTS` line and add two lines:

```
//	  PORTS      S→C  {"ports":[{"port":P,"pid":N,"cmdline":"..."},...]}  listening ports + best-effort owners
//	  KILLPORT   C→S  {"port":P}                               TERM (then KILL) the process listening on P
//	  KILLED     S→C  {"ok":true,"error":"..."}                kill outcome
```

- [ ] **Step 4: Run to verify pass**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && CGO_ENABLED=0 go test -race ./...)
```

Expected: PASS (all packages — server_test still compiles because `PortInfo{Port: ...}` remains valid).

- [ ] **Step 5: Commit**

```bash
git -C $WT add broker/internal/proto/ \
  && git -C $WT commit -m "feat(broker): KILLPORT/KILLED frames + pid/cmdline on PORTS

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Broker — server dispatch (enriched LISTPORTS + KILLPORT)

**Files:**
- Modify: `broker/internal/server/server.go`
- Modify: `broker/internal/server/server_test.go`

**Interfaces:**
- Consumes: `portscan.Detail`, `portscan.KillOwner`, proto shapes from Task 4.
- Produces: server answers `LISTPORTS` with owner-enriched `PortInfo` and handles `KILLPORT`→`KILLED`. New injectable field `KillPort func(port uint16) error` (defaults to `KillOwner` with 2 s grace).

- [ ] **Step 1: Write the failing tests** (append to `server_test.go`)

The existing `startTestServer` helper constructs the Server; check how it does so and inject through the returned/constructed value if reachable, otherwise mirror its body inline. The tests to add:

```go
func TestServer_ListPortsCarriesOwnerInfo(t *testing.T) {
	// A server with an injected scanner must relay pid/cmdline verbatim.
	conn, srv, cleanup := startTestServerReturningServer(t)
	defer cleanup()
	srv.ListPorts = func() ([]portscan.Detail, error) {
		return []portscan.Detail{{Port: 3000, Pid: 42, Cmdline: "vite dev"}, {Port: 9999}}, nil
	}
	_ = proto.WriteJSONFrame(conn, proto.FrameListPorts, struct{}{})
	payload := expectFrame(t, conn, proto.FramePorts)
	var resp proto.PortsResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode PORTS: %v", err)
	}
	if len(resp.Ports) != 2 {
		t.Fatalf("want 2 ports, got %+v", resp.Ports)
	}
	byPort := map[uint16]proto.PortInfo{}
	for _, p := range resp.Ports {
		byPort[p.Port] = p
	}
	if got := byPort[3000]; got.Pid != 42 || got.Cmdline != "vite dev" {
		t.Fatalf("owner info lost: %+v", got)
	}
	if got := byPort[9999]; got.Pid != 0 || got.Cmdline != "" {
		t.Fatalf("unresolved port must have zero owner fields: %+v", got)
	}
}

func TestServer_KillPortDispatch(t *testing.T) {
	conn, srv, cleanup := startTestServerReturningServer(t)
	defer cleanup()
	var killed []uint16
	srv.KillPort = func(port uint16) error {
		killed = append(killed, port)
		return nil
	}
	_ = proto.WriteJSONFrame(conn, proto.FrameKillPort, proto.KillPortRequest{Port: 8765})
	payload := expectFrame(t, conn, proto.FrameKilled)
	var resp proto.KilledResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode KILLED: %v", err)
	}
	if !resp.OK || len(killed) != 1 || killed[0] != 8765 {
		t.Fatalf("kill not dispatched: resp=%+v killed=%v", resp, killed)
	}
}

func TestServer_KillPortErrorSurfaces(t *testing.T) {
	conn, srv, cleanup := startTestServerReturningServer(t)
	defer cleanup()
	srv.KillPort = func(uint16) error { return errors.New("no resolvable owner") }
	_ = proto.WriteJSONFrame(conn, proto.FrameKillPort, proto.KillPortRequest{Port: 1})
	payload := expectFrame(t, conn, proto.FrameKilled)
	var resp proto.KilledResponse
	_ = json.Unmarshal(payload, &resp)
	if resp.OK || resp.Error == "" {
		t.Fatalf("want ok=false with error, got %+v", resp)
	}
}
```

If the existing helper doesn't expose the `*Server`, add a `startTestServerReturningServer` variant that duplicates `startTestServer` but also returns the `*Server` it constructed (leave the original helper untouched — other tests use it). Import `portscan` in the test file.

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && go test ./internal/server/ -run 'ListPortsCarries|KillPort')
```

Expected: compile FAIL (`KillPort` field undefined).

- [ ] **Step 3: Implement in `server.go`**

(a) Struct + constructor:

```go
type Server struct {
	mgr *session.Manager
	// ListPorts enumerates listening TCP ports (with best-effort owner
	// attribution) for LISTPORTS. Field so tests can inject a deterministic
	// scanner; defaults to portscan.Listening.
	ListPorts func() ([]portscan.Detail, error)
	// KillPort terminates the process behind a listening port for KILLPORT.
	// Injectable for tests; defaults to portscan.KillOwner with a 2s grace.
	KillPort func(port uint16) error
}

func New(mgr *session.Manager) *Server {
	return &Server{
		mgr:       mgr,
		ListPorts: portscan.Listening,
		KillPort:  func(port uint16) error { return portscan.KillOwner(port, 2*time.Second) },
	}
}
```

(b) `FrameListPorts` case — relay owner fields:

```go
	case proto.FrameListPorts:
		ports, err := s.ListPorts()
		if err != nil {
			log.Printf("listports: %v", err)
			ports = nil
		}
		resp := proto.PortsResponse{Ports: make([]proto.PortInfo, len(ports))}
		for i, p := range ports {
			resp.Ports[i] = proto.PortInfo{Port: p.Port, Pid: p.Pid, Cmdline: p.Cmdline}
		}
		return cw.writeJSON(proto.FramePorts, resp)
```

(c) New `FrameKillPort` case (before `default:`):

```go
	case proto.FrameKillPort:
		var req proto.KillPortRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameKilled, proto.KilledResponse{OK: false, Error: "bad json"})
		}
		if err := s.KillPort(req.Port); err != nil {
			return cw.writeJSON(proto.FrameKilled, proto.KilledResponse{OK: false, Error: err.Error()})
		}
		return cw.writeJSON(proto.FrameKilled, proto.KilledResponse{OK: true})
```

- [ ] **Step 4: Run full broker suite**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && CGO_ENABLED=0 go test -race ./...)
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C $WT add broker/internal/server/ \
  && git -C $WT commit -m "feat(broker): serve owner-enriched PORTS and dispatch KILLPORT

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Host BrokerClient — port details + killPort

**Files:**
- Modify: `src/main/broker.ts` (FrameType enum ~line 28, `listPorts` ~line 380)
- Modify: `src/main/portforward.ts:164` (poll consumes new shape — minimal adaptation)
- Modify: `src/main/portforward.test.ts` (stub `listPorts` shape)

**Interfaces:**
- Consumes: broker wire protocol from Tasks 4–5.
- Produces: `interface BrokerPortInfo { port: number; pid?: number; cmdline?: string }`, `BrokerClient.listPorts(): Promise<BrokerPortInfo[]>`, `BrokerClient.killPort(port: number): Promise<{ ok: boolean; error?: string }>`. Task 7 consumes both.

- [ ] **Step 1: Adapt the test stubs to the new shape** (they double as the failing "test")

In `src/main/portforward.test.ts`, change every stub client's `listPorts` from returning `number[]` to `BrokerPortInfo[]`:

```ts
// stubClient helper:
listPorts: () => Promise.resolve(ports().map((port) => ({ port }))),
```

(There are two stub definitions — the named `stubClient` helper and the inline stub inside the reconcile test whose `listPorts` rejects; the rejecting one needs no change.)

- [ ] **Step 2: Run to verify failure**

```bash
(cd $WT && npx vitest run src/main/portforward.test.ts && npm run typecheck)
```

Expected: typecheck FAIL (stub no longer matches `BrokerClient.listPorts(): Promise<number[]>` — and after Step 3, `portforward.ts` would fail on `number[]` use). One of the two gates must be red before Step 3.

- [ ] **Step 3: Implement in `broker.ts`**

(a) FrameType enum — after `PORTS = 0x17`:

```ts
  KILLPORT = 0x18,
  KILLED = 0x19
```

(b) Near the other response interfaces, add:

```ts
/** One listening container port; pid/cmdline are absent when the broker
 *  (or an old runner image's broker) couldn't attribute the socket. */
export interface BrokerPortInfo {
  port: number;
  pid?: number;
  cmdline?: string;
}
```

(c) Replace `listPorts` and add `killPort`:

```ts
  /** Listening TCP ports detected inside the container (LISTEN sockets),
   *  with best-effort owning pid/cmdline. */
  async listPorts(): Promise<BrokerPortInfo[]> {
    const payload = await this.rpc(
      { type: FrameType.LISTPORTS, payload: Buffer.alloc(0) },
      FrameType.PORTS
    );
    const obj = JSON.parse(payload.toString('utf8')) as { ports: BrokerPortInfo[] };
    return obj.ports;
  }

  /** Terminate the process listening on a container port. The broker
   *  resolves port→pid itself at kill time (TERM, 2s grace, then KILL).
   *  On an old broker without KILLPORT the rpc times out and this rejects —
   *  callers surface that as { ok:false }. */
  async killPort(port: number): Promise<{ ok: boolean; error?: string }> {
    const payload = await this.rpc(
      { type: FrameType.KILLPORT, payload: Buffer.from(JSON.stringify({ port }), 'utf8') },
      FrameType.KILLED
    );
    return JSON.parse(payload.toString('utf8')) as { ok: boolean; error?: string };
  }
```

(d) In `portforward.ts` `poll()` (line ~164), adapt minimally (Task 7 rewrites this properly):

```ts
      const details = await client.listPorts();
      const { newly, next } = diffPorts(
        monitor.seen,
        details.map((d) => d.port),
        this.deps.excludePorts(workspaceId)
      );
```

- [ ] **Step 4: Run to verify pass**

```bash
(cd $WT && npx vitest run src/main/portforward.test.ts && npm run typecheck)
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/main/broker.ts src/main/portforward.ts src/main/portforward.test.ts \
  && git -C $WT commit -m "feat(main): BrokerClient killPort + owner-enriched listPorts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: PortForwardManager — serving snapshot, onChanged, killPort

**Files:**
- Modify: `src/main/portforward.ts`
- Modify: `src/main/portforward.test.ts`

**Interfaces:**
- Consumes: `BrokerPortInfo`, `BrokerClient.killPort` (Task 6).
- Produces (consumed by Task 9's IPC layer):

```ts
export interface ServingPort {
  port: number;
  pid: number | null;
  cmdline: string | null;
  firstSeenAt: number; // epoch ms
}
// New PortForwardDeps members:
//   onChanged(workspaceId: string, ports: ServingPort[]): void   (required)
//   now?: () => number                                           (test hook, default Date.now)
// New PortForwardManager methods:
//   snapshot(): Array<{ workspaceId: string; ports: ServingPort[] }>
//   killPort(workspaceId: string, port: number): Promise<{ ok: boolean; error?: string }>
```

Snapshot semantics (the state machine under test):
- probe passes → entry added with `firstSeenAt = now()`; `onChanged` fires (after `onDetected`, same tick).
- port absent from the scan → entry removed; `onChanged` fires.
- same port, different pid → entry replaced (`firstSeenAt` reset); `onChanged` fires.
- same port, same pid → untouched, no emit.
- monitor stops (workspace paused/stopped/removed) → if it had entries, `onChanged(workspaceId, [])`.
- emitted arrays are sorted by port ascending.

- [ ] **Step 1: Write the failing tests** (append a new `describe` to `portforward.test.ts`)

```ts
describe('PortForwardManager serving snapshot', () => {
  /** Manager wired for snapshot tests: detailed ports come from `feed()`,
   *  every probe passes, time is `clock.t`. */
  function servingHarness(feed: () => Array<{ port: number; pid?: number; cmdline?: string }>) {
    const changes: Array<{ workspaceId: string; ports: ServingPort[] }> = [];
    const clock = { t: 1000 };
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve(feed()),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: () => Promise.resolve({ ok: true })
        }) as never,
      onDetected: () => {},
      onChanged: (workspaceId, ports) => changes.push({ workspaceId, ports }),
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      now: () => clock.t,
      pollMs: 1000
    });
    return { mgr, changes, clock };
  }

  it('adds a probe-passed port to the snapshot and emits onChanged', async () => {
    vi.useFakeTimers();
    let ports: Array<{ port: number; pid?: number; cmdline?: string }> = [];
    const { mgr, changes } = servingHarness(() => ports);
    mgr.reconcile(['ws1']);
    ports = [{ port: 3000, pid: 42, cmdline: 'vite dev' }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([
      {
        workspaceId: 'ws1',
        ports: [{ port: 3000, pid: 42, cmdline: 'vite dev', firstSeenAt: 1000 }]
      }
    ]);
    expect(mgr.snapshot()).toEqual([
      { workspaceId: 'ws1', ports: [{ port: 3000, pid: 42, cmdline: 'vite dev', firstSeenAt: 1000 }] }
    ]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('does not re-emit while nothing changes, removes a vanished port', async () => {
    vi.useFakeTimers();
    let ports: Array<{ port: number; pid?: number }> = [{ port: 3000, pid: 42 }];
    const { mgr, changes } = servingHarness(() => ports);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000); // add → emit 1
    await vi.advanceTimersByTimeAsync(1000); // steady → no emit
    expect(changes).toHaveLength(1);
    ports = [];
    await vi.advanceTimersByTimeAsync(1000); // removal → emit 2
    expect(changes).toHaveLength(2);
    expect(changes[1].ports).toEqual([]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('resets firstSeenAt when the pid behind a port changes', async () => {
    vi.useFakeTimers();
    let ports = [{ port: 3000, pid: 42, cmdline: 'vite dev' }];
    const { mgr, changes, clock } = servingHarness(() => ports);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    clock.t = 5000;
    ports = [{ port: 3000, pid: 99, cmdline: 'vite dev (restarted)' }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveLength(2);
    expect(changes[1].ports).toEqual([
      { port: 3000, pid: 99, cmdline: 'vite dev (restarted)', firstSeenAt: 5000 }
    ]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('missing pid/cmdline (old broker) become nulls', async () => {
    vi.useFakeTimers();
    const { mgr, changes } = servingHarness(() => [{ port: 3000 }]);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes[0].ports).toEqual([{ port: 3000, pid: null, cmdline: null, firstSeenAt: 1000 }]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('emits an empty snapshot when a workspace with serving ports departs', async () => {
    vi.useFakeTimers();
    const { mgr, changes } = servingHarness(() => [{ port: 3000, pid: 42 }]);
    mgr.reconcile(['ws1']);
    await vi.advanceTimersByTimeAsync(1000);
    mgr.reconcile([]); // ws1 stops
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ workspaceId: 'ws1', ports: [] });
    expect(mgr.snapshot()).toEqual([]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('killPort forwards to the broker client', async () => {
    const calls: number[] = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([]),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve(),
          killPort: (port: number) => {
            calls.push(port);
            return Promise.resolve({ ok: true });
          }
        }) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => []
    });
    const res = await mgr.killPort('ws1', 8765);
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([8765]);
    mgr.dispose();
  });

  it('killPort surfaces broker failure as ok:false', async () => {
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => {
        throw new Error('workspace not running');
      },
      makeClient: () => ({}) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => []
    });
    const res = await mgr.killPort('ws1', 8765);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('workspace not running');
    mgr.dispose();
  });
});
```

Add `ServingPort` to the imports from `./portforward.js`. The pre-existing tests in this file construct `PortForwardManager` without `onChanged` — add `onChanged: () => {}` to each of those constructions.

- [ ] **Step 2: Run to verify failure**

```bash
(cd $WT && npx vitest run src/main/portforward.test.ts)
```

Expected: FAIL (`onChanged` not a known dep / `ServingPort` not exported / `snapshot` undefined).

- [ ] **Step 3: Implement in `portforward.ts`**

(a) Export the type; extend deps:

```ts
/** One HTTP-serving container port in the authoritative rail snapshot. */
export interface ServingPort {
  port: number;
  pid: number | null;
  cmdline: string | null;
  firstSeenAt: number; // epoch ms (host clock)
}
```

```ts
export interface PortForwardDeps {
  resolveEndpoint(workspaceId: string): Promise<BrokerEndpoint>;
  makeClient(endpoint: BrokerEndpoint): BrokerClient;
  onDetected(workspaceId: string, port: number): void;
  /** Full per-workspace snapshot after every membership/owner change —
   *  including an empty array when the workspace's monitor stops. */
  onChanged(workspaceId: string, ports: ServingPort[]): void;
  excludePorts(workspaceId: string): number[];
  pollMs?: number;
  probePort?(endpoint: BrokerEndpoint, port: number): Promise<boolean>;
  /** Clock, injectable for tests. */
  now?(): number;
}
```

Constructor defaults gain `now: () => Date.now(), ...deps` (put it before the `...deps` spread like `pollMs`).

(b) `Monitor` gains the snapshot map:

```ts
interface Monitor {
  timer: NodeJS.Timeout;
  seen: Set<number>;
  probeFails: Map<number, number>;
  polling: boolean;
  /** Authoritative "Serving" rail state: ports that passed the HTTP probe,
   *  keyed by port. Source of truth for ports:list / ports:changed. */
  serving: Map<number, ServingPort>;
}
```

`startMonitor` initializes `serving: new Map()`.

(c) `stopMonitor` emits the clearing snapshot:

```ts
  private stopMonitor(workspaceId: string): void {
    const m = this.monitors.get(workspaceId);
    if (m) {
      clearInterval(m.timer);
      this.monitors.delete(workspaceId);
      if (m.serving.size > 0) this.deps.onChanged(workspaceId, []);
    }
  }
```

(d) Rewrite the middle of `poll()` (between `await client.ready()` and the `catch`):

```ts
      const details = await client.listPorts();
      const byPort = new Map(details.map((d) => [d.port, d]));
      const { newly, next } = diffPorts(
        monitor.seen,
        details.map((d) => d.port),
        this.deps.excludePorts(workspaceId)
      );
      let changed = false;
      // Serving ports that stopped listening drop out of the snapshot.
      for (const port of [...monitor.serving.keys()]) {
        if (!byPort.has(port)) {
          monitor.serving.delete(port);
          changed = true;
        }
      }
      // A pid change behind a still-listening port is a server restart:
      // replace the row and restart its uptime clock.
      for (const [port, sp] of monitor.serving) {
        const d = byPort.get(port);
        if (!d) continue;
        const pid = d.pid ?? null;
        if (pid !== sp.pid) {
          monitor.serving.set(port, {
            port,
            pid,
            cmdline: d.cmdline ?? null,
            firstSeenAt: this.deps.now()
          });
          changed = true;
        }
      }
      // Ports that stopped listening get a fresh probe budget if they return.
      for (const p of [...monitor.probeFails.keys()]) {
        if (!next.has(p)) monitor.probeFails.delete(p);
      }
      for (const port of newly) {
        if (await this.deps.probePort(endpoint, port)) {
          monitor.probeFails.delete(port);
          const d = byPort.get(port);
          monitor.serving.set(port, {
            port,
            pid: d?.pid ?? null,
            cmdline: d?.cmdline ?? null,
            firstSeenAt: this.deps.now()
          });
          changed = true;
          this.deps.onDetected(workspaceId, port);
          continue;
        }
        const fails = (monitor.probeFails.get(port) ?? 0) + 1;
        monitor.probeFails.set(port, fails);
        // Keep an unconfirmed port out of `seen` so the next tick re-probes it
        // (a dev server can listen before it serves). Past the attempt budget
        // it stays in `seen`: a non-HTTP listener, never reported.
        if (fails < MAX_PROBE_ATTEMPTS) next.delete(port);
      }
      monitor.seen = next;
      if (changed) this.deps.onChanged(workspaceId, servingSorted(monitor));
```

(e) New helpers/methods (module-level function + two methods on the class):

```ts
function servingSorted(monitor: { serving: Map<number, ServingPort> }): ServingPort[] {
  return [...monitor.serving.values()].sort((a, b) => a.port - b.port);
}
```

```ts
  /** Current Serving state across all monitored workspaces — seeds the
   *  renderer on mount/reload (`ports:list`). Workspaces with nothing
   *  serving are omitted. */
  snapshot(): Array<{ workspaceId: string; ports: ServingPort[] }> {
    const out: Array<{ workspaceId: string; ports: ServingPort[] }> = [];
    for (const [workspaceId, monitor] of this.monitors) {
      if (monitor.serving.size > 0) out.push({ workspaceId, ports: servingSorted(monitor) });
    }
    return out;
  }

  /** Terminate the process behind a serving port. The broker re-resolves
   *  port→pid at kill time; the snapshot row disappears via the normal
   *  poll once the socket closes. */
  async killPort(workspaceId: string, port: number): Promise<{ ok: boolean; error?: string }> {
    let client: BrokerClient | undefined;
    try {
      const endpoint = await this.deps.resolveEndpoint(workspaceId);
      client = this.deps.makeClient(endpoint);
      await client.ready();
      return await client.killPort(port);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      client?.close();
    }
  }
```

Also update the file-top doc comment's PortMonitor paragraph to mention the snapshot + `onChanged` responsibility.

- [ ] **Step 4: Run to verify pass**

```bash
(cd $WT && npx vitest run src/main/portforward.test.ts && npm run typecheck)
```

Expected: vitest PASS; typecheck FAILS in `ipc.ts` (missing `onChanged` in the constructor there) — fix by adding a placeholder `onChanged: () => {}` to the `PortForwardManager` construction in `src/main/ipc.ts` (Task 9 replaces it with the real broadcast). Re-run: both PASS.

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/main/portforward.ts src/main/portforward.test.ts src/main/ipc.ts \
  && git -C $WT commit -m "feat(main): authoritative serving-ports snapshot with onChanged + killPort

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: MockServingPorts (mock-fleet fake ports)

**Files:**
- Create: `src/main/mockPorts.ts`
- Create: `src/main/mockPorts.test.ts`

**Interfaces:**
- Consumes: `ServingPort` from Task 7.
- Produces (consumed by Task 9): `class MockServingPorts` with `reconcile(runningIds: string[])`, `snapshot()`, `kill(workspaceId, port): { ok: boolean }`, `dispose()`, constructor `(onChanged: (workspaceId, ports: ServingPort[]) => void, now?: () => number)`. Fake port 3000 (`vite dev`) appears 10 s after a workspace is first reconciled as running; port 8765 (`python http.server`) at 25 s.

- [ ] **Step 1: Write the failing test** (`src/main/mockPorts.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
import { MockServingPorts } from './mockPorts.js';
import type { ServingPort } from './portforward.js';

describe('MockServingPorts', () => {
  it('emits fake ports on schedule and clears on departure', () => {
    vi.useFakeTimers();
    const changes: Array<{ id: string; ports: ServingPort[] }> = [];
    const mock = new MockServingPorts((id, ports) => changes.push({ id, ports }), () => 0);

    mock.reconcile(['ws1']);
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(changes).toHaveLength(1);
    expect(changes[0].ports.map((p) => p.port)).toEqual([3000]);
    expect(changes[0].ports[0].pid).not.toBeNull();
    expect(changes[0].ports[0].cmdline).toContain('vite');

    vi.advanceTimersByTime(15_000);
    expect(changes).toHaveLength(2);
    expect(changes[1].ports.map((p) => p.port)).toEqual([3000, 8765]);
    expect(mock.snapshot()).toEqual([{ workspaceId: 'ws1', ports: changes[1].ports }]);

    mock.reconcile([]); // workspace stopped
    expect(changes).toHaveLength(3);
    expect(changes[2].ports).toEqual([]);
    expect(mock.snapshot()).toEqual([]);

    mock.dispose();
    vi.useRealTimers();
  });

  it('reconcile is idempotent (no duplicate timers)', () => {
    vi.useFakeTimers();
    const changes: unknown[] = [];
    const mock = new MockServingPorts(() => changes.push(1), () => 0);
    mock.reconcile(['ws1']);
    mock.reconcile(['ws1']);
    vi.advanceTimersByTime(60_000);
    expect(changes).toHaveLength(2); // one per fake port, not four
    mock.dispose();
    vi.useRealTimers();
  });

  it('kill removes the port and emits', () => {
    vi.useFakeTimers();
    const changes: Array<{ ports: ServingPort[] }> = [];
    const mock = new MockServingPorts((_id, ports) => changes.push({ ports }), () => 0);
    mock.reconcile(['ws1']);
    vi.advanceTimersByTime(30_000); // both fakes live
    const res = mock.kill('ws1', 3000);
    expect(res.ok).toBe(true);
    expect(changes.at(-1)!.ports.map((p) => p.port)).toEqual([8765]);
    mock.dispose();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
(cd $WT && npx vitest run src/main/mockPorts.test.ts)
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/main/mockPorts.ts`**

```ts
// Mock-mode stand-in for the PortForwardManager's Serving snapshot
// (CLAUDE_FLEET_MOCK=1 — no Docker, no broker). Fake dev servers appear on
// a schedule after a workspace starts so the rail's Serving section is
// fully exercisable without a container: port 3000 ("vite dev") at 10s,
// port 8765 ("python http.server") at 25s. Same onChanged/snapshot/kill
// contract as the real manager.

import type { ServingPort } from './portforward.js';

const FAKES: ReadonlyArray<{ afterMs: number; port: number; pid: number; cmdline: string }> = [
  { afterMs: 10_000, port: 3000, pid: 4242, cmdline: 'node /workspace/node_modules/.bin/vite dev' },
  { afterMs: 25_000, port: 8765, pid: 4343, cmdline: 'python3 -m http.server 8765' }
];

export class MockServingPorts {
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly serving = new Map<string, Map<number, ServingPort>>();

  constructor(
    private readonly onChanged: (workspaceId: string, ports: ServingPort[]) => void,
    private readonly now: () => number = Date.now
  ) {}

  reconcile(runningIds: string[]): void {
    const running = new Set(runningIds);
    for (const id of running) {
      if (this.timers.has(id)) continue;
      this.timers.set(
        id,
        FAKES.map((f) => setTimeout(() => this.add(id, f), f.afterMs))
      );
    }
    for (const id of [...this.timers.keys()]) {
      if (!running.has(id)) this.stop(id);
    }
  }

  private add(id: string, f: (typeof FAKES)[number]): void {
    let ports = this.serving.get(id);
    if (!ports) {
      ports = new Map();
      this.serving.set(id, ports);
    }
    ports.set(f.port, { port: f.port, pid: f.pid, cmdline: f.cmdline, firstSeenAt: this.now() });
    this.emit(id);
  }

  private stop(id: string): void {
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
    if (this.serving.delete(id)) this.onChanged(id, []);
  }

  private emit(id: string): void {
    const ports = [...(this.serving.get(id)?.values() ?? [])].sort((a, b) => a.port - b.port);
    this.onChanged(id, ports);
  }

  snapshot(): Array<{ workspaceId: string; ports: ServingPort[] }> {
    return [...this.serving.entries()]
      .filter(([, m]) => m.size > 0)
      .map(([workspaceId, m]) => ({
        workspaceId,
        ports: [...m.values()].sort((a, b) => a.port - b.port)
      }));
  }

  kill(workspaceId: string, port: number): { ok: boolean; error?: string } {
    const ports = this.serving.get(workspaceId);
    if (!ports?.delete(port)) return { ok: false, error: 'no such port' };
    this.emit(workspaceId);
    return { ok: true };
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.stop(id);
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
(cd $WT && npx vitest run src/main/mockPorts.test.ts)
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/main/mockPorts.ts src/main/mockPorts.test.ts \
  && git -C $WT commit -m "feat(main): mock-fleet fake serving ports for Docker-free UI work

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: IPC handles + preload API

**Files:**
- Modify: `src/main/ipc.ts` (construction ~line 151, `workspace:list` ~line 745, `ports:open` block ~line 1152, E2E block ~line 1694)
- Modify: `src/preload/index.ts` (`ports` bridge ~line 504; type exports near `WorkspaceObservabilitySummary`)

**Interfaces:**
- Consumes: Task 7 manager API, Task 8 mock.
- Produces (consumed by Tasks 10–12):
  - broadcast `ports:changed` → payload `{ workspaceId: string, ports: ServingPort[] }`
  - `ports:list()` → `Array<{ workspaceId: string; ports: ServingPort[] }>`
  - `ports:kill(workspaceId: string, port: number)` → `{ ok: boolean; error?: string }`
  - E2E-only `__test:setServingPorts(workspaceId, ports)` — drives `ports:changed` directly
  - preload `window.api.ports` gains `onChanged(cb): unsub`, `list()`, `kill(workspaceId, port)`; preload exports `interface ServingPort` (renderer imports types from preload, not from main).

- [ ] **Step 1: Implement main-process wiring** (no unit test — this task's gate is typecheck + the Task 12 e2e; all logic lives in already-tested modules)

(a) In `ipc.ts` imports: add `MockServingPorts` and the `ServingPort` type:

```ts
import { PortForwardManager, type ServingPort } from './portforward.js';
import { MockServingPorts } from './mockPorts.js';
```

(b) Below `broadcastPortDetected`, add the snapshot broadcast and swap the placeholder from Task 7:

```ts
/** Tell every window a workspace's Serving snapshot changed (rail state). */
function broadcastPortsChanged(workspaceId: string, ports: ServingPort[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('ports:changed', { workspaceId, ports });
    } catch {
      /* frame disposed mid-send */
    }
  }
}
```

In the `PortForwardManager` construction replace `onChanged: () => {}` with `onChanged: broadcastPortsChanged`, and add the mock twin beneath it:

```ts
// Mock mode gets a scheduled fake feed instead (see mockPorts.ts) so the
// rail's Serving section works with CLAUDE_FLEET_MOCK=1.
const mockPorts: MockServingPorts | null = MOCK_MODE
  ? new MockServingPorts(broadcastPortsChanged)
  : null;
```

(c) In the `workspace:list` handler, extend the reconcile block:

```ts
    portForward?.reconcile(
      all.filter((w) => w.state === 'running' && w.kind !== 'local').map((w) => w.id)
    );
    mockPorts?.reconcile(all.filter((w) => w.state === 'running').map((w) => w.id));
```

(d) After the `ports:open` handler, add:

```ts
  // Serving rail state: seed on renderer mount/reload. Mock mode serves the
  // fake feed; real mode the PortForwardManager snapshot.
  ipcMain.handle('ports:list', () => (portForward ?? mockPorts)?.snapshot() ?? []);

  ipcMain.handle(
    'ports:kill',
    async (_e, workspaceId: string, port: number): Promise<{ ok: boolean; error?: string }> => {
      if (!portForward) return mockPorts?.kill(workspaceId, port) ?? { ok: false, error: 'unavailable' };
      return portForward.killPort(workspaceId, port);
    }
  );
```

(e) In the `CLAUDE_FLEET_E2E === '1'` block, next to `__test:emitDetectedPort`:

```ts
    ipcMain.handle('__test:setServingPorts', (_e, workspaceId: string, ports: ServingPort[]) => {
      broadcastPortsChanged(workspaceId, ports);
    });
```

- [ ] **Step 2: Extend the preload bridge**

(a) Near the other exported interfaces in `src/preload/index.ts` (around `WorkspaceObservabilitySummary`), add:

```ts
/** One HTTP-serving container port in the rail's Serving section. pid /
 *  cmdline are null when the runner image's broker predates attribution
 *  (the kill affordance is hidden in that case). */
export interface ServingPort {
  port: number;
  pid: number | null;
  cmdline: string | null;
  firstSeenAt: number;
}
```

(b) Extend the `ports:` object after `open:`:

```ts
    /** Subscribe to per-workspace Serving snapshots (full replace per event;
     *  an empty array clears the workspace). Returns an unsubscribe fn. */
    onChanged: (cb: (workspaceId: string, ports: ServingPort[]) => void): (() => void) => {
      const channel = 'ports:changed';
      const handler = (
        _e: IpcRendererEvent,
        payload: { workspaceId: string; ports: ServingPort[] }
      ): void => cb(payload.workspaceId, payload.ports);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Current Serving snapshots for all running workspaces (mount seed). */
    list: (): Promise<Array<{ workspaceId: string; ports: ServingPort[] }>> =>
      ipcRenderer.invoke('ports:list'),
    /** Kill the process behind a serving port (broker resolves the pid at
     *  kill time). The row clears via the next poll's ports:changed. */
    kill: (workspaceId: string, port: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ports:kill', workspaceId, port)
```

- [ ] **Step 3: Verify**

```bash
(cd $WT && npm run typecheck && npm run test:unit)
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git -C $WT add src/main/ipc.ts src/preload/index.ts \
  && git -C $WT commit -m "feat(ipc): ports:changed broadcast + ports:list/ports:kill handles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Renderer — PortsSection component + styles

**Files:**
- Create: `src/renderer/src/components/PortsSection.tsx`
- Create: `src/renderer/src/components/portsFormat.ts`
- Create: `src/renderer/src/components/portsFormat.test.ts`
- Modify: `src/renderer/src/styles.css` (append after `.obs-tool-err`, ~line 993)

**Interfaces:**
- Consumes: `ServingPort` from preload.
- Produces (consumed by Task 11):

```tsx
export interface PortRowData extends ServingPort {
  workspaceId: string;
  /** Fleet scope only: dot hue + name shown before the port. */
  workspaceName?: string;
  hue?: string;
}
export function PortsSection(props: {
  rows: PortRowData[];
  /** True in fleet scope: show the workspace dot+name, drop inline uptime. */
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
}): JSX.Element | null;
// portsFormat.ts:
export function formatUptime(firstSeenAt: number, now?: number): string; // "up 42s" | "up 12m" | "up 2h" | "up 3d"
```

- [ ] **Step 1: Write the failing formatter test** (`portsFormat.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { formatUptime } from './portsFormat';

describe('formatUptime', () => {
  const t0 = 1_000_000;
  it('seconds under a minute', () => {
    expect(formatUptime(t0, t0 + 42_000)).toBe('up 42s');
  });
  it('minutes under an hour', () => {
    expect(formatUptime(t0, t0 + 12 * 60_000)).toBe('up 12m');
  });
  it('hours under a day', () => {
    expect(formatUptime(t0, t0 + 2 * 3_600_000)).toBe('up 2h');
  });
  it('days beyond', () => {
    expect(formatUptime(t0, t0 + 3 * 86_400_000)).toBe('up 3d');
  });
  it('clock skew clamps to zero', () => {
    expect(formatUptime(t0, t0 - 5_000)).toBe('up 0s');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
(cd $WT && npx vitest run src/renderer/src/components/portsFormat.test.ts)
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `portsFormat.ts`**

```ts
/** Relative uptime for a Serving row, coarsest single unit ("up 12m"). */
export function formatUptime(firstSeenAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - firstSeenAt) / 1000));
  if (s < 60) return `up ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `up ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `up ${h}h`;
  return `up ${Math.floor(h / 24)}d`;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
(cd $WT && npx vitest run src/renderer/src/components/portsFormat.test.ts)
```

Expected: PASS.

- [ ] **Step 5: Implement `PortsSection.tsx`** (gate: typecheck — component behavior is covered by the Task 12 e2e)

```tsx
import { useEffect, useState } from 'react';
import type { ServingPort } from '../../../preload';
import { formatUptime } from './portsFormat';

export interface PortRowData extends ServingPort {
  workspaceId: string;
  /** Fleet scope only: dot hue + name shown before the port. */
  workspaceName?: string;
  hue?: string;
}

/**
 * "Serving" rail section — the durable home of the port-preview flow. One
 * row per HTTP-serving container port; ↗ opens the loopback preview (same
 * path as the detection toast), ✕ kills the server via the broker behind a
 * two-step inline confirm. Renders nothing when no port is serving. The
 * kill button is hidden for rows without a pid (old runner image's broker
 * can't attribute or kill).
 */
export function PortsSection({
  rows,
  showWorkspace,
  onOpen,
  onKill
}: {
  rows: PortRowData[];
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="obs-section">
      <div className="obs-section-title">Serving</div>
      {rows.map((r) => (
        <PortRow
          key={`${r.workspaceId}:${r.port}`}
          row={r}
          showWorkspace={showWorkspace}
          onOpen={onOpen}
          onKill={onKill}
        />
      ))}
    </section>
  );
}

function PortRow({
  row,
  showWorkspace,
  onOpen,
  onKill
}: {
  row: PortRowData;
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
}) {
  // Two-step kill confirm: first ✕ swaps the actions for a "kill?" chip
  // that reverts after 3s untouched; the second click sends the kill.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const startedAt = new Date(row.firstSeenAt).toLocaleString();
  return (
    <div className="obs-port-row">
      {showWorkspace && (
        <>
          <span className="obs-fleet-dot" style={{ background: row.hue }} />
          <span className="obs-port-ws" title={`${row.workspaceName} · ${formatUptime(row.firstSeenAt)} (since ${startedAt})`}>
            {row.workspaceName}
          </span>
        </>
      )}
      <span className="obs-port-num mono">:{row.port}</span>
      {row.cmdline && (
        <span className="obs-port-cmd" title={row.cmdline}>
          {row.cmdline}
        </span>
      )}
      {!showWorkspace && (
        <span className="obs-port-up" title={`since ${startedAt}`}>
          {formatUptime(row.firstSeenAt)}
        </span>
      )}
      {confirming ? (
        <button
          type="button"
          className="obs-port-kill-confirm"
          onClick={() => {
            setConfirming(false);
            onKill(row.workspaceId, row.port);
          }}
        >
          kill?
        </button>
      ) : (
        <>
          <button
            type="button"
            className="obs-port-btn"
            title="Open preview"
            aria-label={`Open preview of port ${row.port}`}
            onClick={() => onOpen(row.workspaceId, row.port)}
          >
            ↗
          </button>
          {row.pid !== null && (
            <button
              type="button"
              className="obs-port-btn kill"
              title="Kill server"
              aria-label={`Kill server on port ${row.port}`}
              onClick={() => setConfirming(true)}
            >
              ✕
            </button>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Append styles to `styles.css`** (after `.obs-tool-err`, keeping the obs block together; approved in the brainstorm mockups)

```css
/* Serving rows: port + owning cmdline + uptime, with hover-revealed
   open-preview / kill buttons. Blue left accent distinguishes serving
   ports from the green tool rows above. Kill is a two-step inline
   confirm (the ✕ swaps to a red "kill?" chip that reverts after 3s). */
.obs-port-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 2px 4px 2px 6px;
  border-left: 2px solid var(--info);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  transition: background 120ms ease;
}
.obs-port-row:hover { background: var(--bg-hover); }
.obs-port-num { font-weight: 600; color: var(--ink); flex-shrink: 0; }
.obs-port-cmd {
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 11px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.obs-port-up { color: var(--ink-1); font-size: 11px; flex-shrink: 0; }
.obs-port-ws {
  color: var(--ink);
  flex-shrink: 0;
  max-width: 92px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.obs-port-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  opacity: 0.55;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}
.obs-port-row:hover .obs-port-btn { opacity: 1; }
.obs-port-btn:hover { background: var(--bg-2); color: var(--ink); }
.obs-port-btn.kill:hover { color: var(--danger); }
.obs-port-kill-confirm {
  font-family: var(--font-mono);
  font-size: 10px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--danger);
  border-radius: var(--r-sm);
  color: var(--danger);
  padding: 2px 6px;
  cursor: pointer;
}
```

- [ ] **Step 7: Verify + commit**

```bash
(cd $WT && npm run typecheck) \
  && git -C $WT add src/renderer/src/components/PortsSection.tsx src/renderer/src/components/portsFormat.ts src/renderer/src/components/portsFormat.test.ts src/renderer/src/styles.css \
  && git -C $WT commit -m "feat(ui): PortsSection component + serving-row styles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Rail + App integration

**Files:**
- Create: `src/renderer/src/usePorts.ts`
- Modify: `src/renderer/src/components/ObservabilityPane.tsx` (Props ~line 10, workspace-scope stack ~line 128, `FleetView` ~line 230)
- Modify: `src/renderer/src/App.tsx` (toast effect ~line 295, `<ObservabilityPane …>` ~line 1246)

**Interfaces:**
- Consumes: `PortsSection`/`PortRowData` (Task 10), preload `ports` API (Task 9), existing `colorFor(w)` and `pushToast(message, eyebrow, ttl, kind)` in App.
- Produces: `usePorts(): Record<string, ServingPort[]>`; `ObservabilityPane` Props gain `servingPorts: Record<string, ServingPort[]>`, `onOpenPort(workspaceId, port)`, `onKillPort(workspaceId, port)`.

- [ ] **Step 1: Implement `usePorts.ts`**

```ts
import { useEffect, useState } from 'react';
import type { ServingPort } from '../../preload';

/**
 * Live Serving snapshots keyed by workspace id. Seeds from ports:list on
 * mount (so a renderer reload rebuilds instantly) then applies
 * ports:changed broadcasts (full per-workspace replace; empty = clear).
 */
export function usePorts(): Record<string, ServingPort[]> {
  const [byWorkspace, setByWorkspace] = useState<Record<string, ServingPort[]>>({});
  useEffect(() => {
    let alive = true;
    void window.api.ports.list().then((all) => {
      if (!alive) return;
      setByWorkspace((prev) => {
        const seed: Record<string, ServingPort[]> = {};
        for (const { workspaceId, ports } of all) seed[workspaceId] = ports;
        // Broadcasts that raced the seed win: overlay prev on top.
        return { ...seed, ...prev };
      });
    });
    const unsub = window.api.ports.onChanged((workspaceId, ports) => {
      setByWorkspace((prev) => {
        if (ports.length === 0) {
          if (!(workspaceId in prev)) return prev;
          const next = { ...prev };
          delete next[workspaceId];
          return next;
        }
        return { ...prev, [workspaceId]: ports };
      });
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return byWorkspace;
}
```

- [ ] **Step 2: Thread props through `ObservabilityPane.tsx`**

(a) Imports:

```ts
import type { WorkspaceObservabilitySummary, UsageBudget, ServingPort } from '../../../preload';
import { PortsSection, type PortRowData } from './PortsSection';
```

(b) `Props` gains (with the other members):

```ts
  /** Live Serving snapshots keyed by workspace id (App's usePorts). */
  servingPorts: Record<string, ServingPort[]>;
  /** Open the loopback preview for a serving port (same path as the toast). */
  onOpenPort: (workspaceId: string, port: number) => void;
  /** Kill the server behind a serving port. */
  onKillPort: (workspaceId: string, port: number) => void;
```

Destructure all three in the component signature.

(c) Workspace scope — in the `obs-stack` div, between the Summary/Empty block and `{workspace && <WorkspaceBlock …>}`:

```tsx
            {workspace && (
              <PortsSection
                rows={(servingPorts[workspace.id] ?? []).map((p) => ({
                  ...p,
                  workspaceId: workspace.id
                }))}
                showWorkspace={false}
                onOpen={onOpenPort}
                onKill={onKillPort}
              />
            )}
```

(d) Fleet scope — pass the three props into `<FleetView …>`; in `FleetView`, after the `Workspaces` section, build fleet rows (dot hue + name from the already-computed `rows`) and render:

```tsx
      <PortsSection
        rows={rows.flatMap((r) =>
          (servingPorts[r.id] ?? []).map((p) => ({
            ...p,
            workspaceId: r.id,
            workspaceName: r.name,
            hue: r.hue
          }))
        )}
        showWorkspace
        onOpen={onOpenPort}
        onKill={onKillPort}
      />
```

`FleetView`'s signature grows the same three props with the same types.

- [ ] **Step 3: Wire App.tsx**

(a) Extract the toast's open-preview logic into a shared callback (place near the ports toast effect; `pushToast` and `workspacesRef` already exist):

```ts
  // Open the loopback preview for a serving port — shared by the detection
  // toast and the rail's Serving section. Errors surface as toasts.
  const openPreview = useCallback((workspaceId: string, port: number) => {
    const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
    void window.api.ports
      .open(workspaceId, port)
      .then(({ hostPort }) => {
        if (hostPort === null) {
          pushToast(
            `Nothing is answering on port ${port} in ${name} anymore — the server may have stopped.`,
            'Preview',
            6000,
            'error'
          );
        }
      })
      .catch(() => {
        pushToast(`Couldn't open the preview for port ${port} in ${name}.`, 'Preview', 6000, 'error');
      });
  }, []);

  const killServingPort = useCallback((workspaceId: string, port: number) => {
    const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
    void window.api.ports.kill(workspaceId, port).then(({ ok, error }) => {
      if (!ok) {
        pushToast(
          `Couldn't kill the server on port ${port} in ${name}${error ? ` — ${error}` : ''}.`,
          'Serving',
          6000,
          'error'
        );
      }
    });
  }, []);

  const servingPorts = usePorts();
```

(`pushToast` is a stable `useCallback([])` — same dependency reasoning as the existing toast effect's comment. Import `usePorts` from `'./usePorts'`.)

(b) In the detection-toast effect, replace the action's inline `onClick` body after `dispatchToast({ type: 'dismiss', id });` with a call to the shared callback:

```ts
            onClick: () => {
              dispatchToast({ type: 'dismiss', id });
              openPreview(workspaceId, port);
            }
```

(add `openPreview` to that effect's dependency array — it's stable, so the effect still runs once).

(c) Pass the new props at the `<ObservabilityPane …>` call site:

```tsx
          servingPorts={servingPorts}
          onOpenPort={openPreview}
          onKillPort={killServingPort}
```

- [ ] **Step 4: Verify**

```bash
(cd $WT && npm run typecheck && npm run test:unit && npm run build)
```

Expected: all PASS. (No display here — visual check happens on Troy's host with `CLAUDE_FLEET_MOCK=1 npm run dev`, where fake ports appear at 10 s/25 s.)

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/renderer/src/usePorts.ts src/renderer/src/components/ObservabilityPane.tsx src/renderer/src/App.tsx \
  && git -C $WT commit -m "feat(ui): Serving section on the observability rail (both scopes)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: e2e spec

**Files:**
- Create: `tests/ports-rail.spec.ts`

**Interfaces:**
- Consumes: `__test:setServingPorts` (Task 9), mock workspace `'01MOCKALPHA000000000000000'` (seeded by `src/main/mock.ts`), `launch`/`callTestIpc` from `tests/_helpers.ts`.
- Produces: regression coverage for section render, kill-confirm swap, and clearing. Runs in CI (needs a display; this container can't run it — note that in the PR).

- [ ] **Step 1: Write the spec** (mirror `tests/port-forward.spec.ts` conventions)

```ts
import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

const WS = '01MOCKALPHA000000000000000'; // seeded mock workspace (src/main/mock.ts)

test('serving ports render in the rail; kill uses a two-step confirm', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Drive a Serving snapshot from main (no broker in mock mode).
    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [
        { port: 3000, pid: 42, cmdline: 'node vite dev', firstSeenAt: Date.now() - 60_000 },
        { port: 8765, pid: null, cmdline: null, firstSeenAt: Date.now() }
      ]
    ]);

    // Select the mock workspace so the workspace-scope rail shows it.
    await window.locator('.workspace-chip', { hasText: 'alpha' }).first().click();

    const section = window.locator('.obs-section', { hasText: 'Serving' });
    await expect(section).toBeVisible();
    const rows = section.locator('.obs-port-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(':3000');
    await expect(rows.first()).toContainText('vite dev');
    await expect(rows.first()).toContainText('up 1m');

    // pid:null row (old broker) has no kill button.
    await expect(rows.nth(1).locator('.obs-port-btn.kill')).toHaveCount(0);

    // Kill is two-step: first ✕ shows the confirm chip, no kill yet.
    await rows.first().hover();
    await rows.first().locator('.obs-port-btn.kill').click();
    await expect(rows.first().locator('.obs-port-kill-confirm')).toBeVisible();

    // An empty snapshot clears the section entirely.
    await callTestIpc(app, '__test:setServingPorts', [WS, []]);
    await expect(section).toHaveCount(0);
  } finally {
    await app.close();
  }
});
```

Adapt the workspace-selection locator to whatever `tests/mock-mode.spec.ts` uses to click the seeded workspace (read that spec first; the chip text/name of the mock workspace is defined in `src/main/mock.ts`).

- [ ] **Step 2: Verify it compiles** (it cannot run here — no display)

```bash
(cd $WT && npm run typecheck && npx playwright test tests/ports-rail.spec.ts --list)
```

Expected: typecheck PASS; `--list` shows the test discovered (listing does not need a display).

- [ ] **Step 3: Commit**

```bash
git -C $WT add tests/ports-rail.spec.ts \
  && git -C $WT commit -m "test(e2e): serving-ports rail section spec (CI-only, needs display)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: SPEC.md updates

**Files:**
- Modify: `docs/SPEC.md`

**Interfaces:** none (documentation). Rule: `.claude/rules/spec-maintenance.md` — edit in place, no changelog prose.

- [ ] **Step 1: Update the four touched areas**

Locate each by grep, then edit in place:

1. **Broker protocol catalog (§5)** — `grep -n "LISTPORTS" docs/SPEC.md`. Update the `PORTS` payload description to `{"ports":[{"port":P,"pid":N,"cmdline":"..."},...]}` (pid/cmdline best-effort, omitted when unresolved: socket inode → `/proc/*/fd` scan, cmdline capped at 120 chars) and add `KILLPORT {"port":P}` / `KILLED {"ok":bool,"error":""}` (0x18/0x19) with the kill-time-PID-resolution invariant (SIGTERM, 2 s grace, SIGKILL; the broker never accepts a host-supplied PID).
2. **IPC surface** — `grep -n "ports:open" docs/SPEC.md`. Add `ports:changed` (main→renderer broadcast, `{workspaceId, ports: ServingPort[]}`, full per-workspace replace, empty clears), `ports:list` (mount seed), `ports:kill(workspaceId, port) → {ok, error?}`. Note the `ServingPort` shape `{port, pid|null, cmdline|null, firstSeenAt}` and that the snapshot holds only HTTP-probe-passed ports.
3. **Observability rail description** — `grep -n "Observability pane" docs/SPEC.md`. Add the Serving section: workspace scope (between Recent tools and the workspace card; port, cmdline, uptime, hover ↗/✕, two-step kill confirm, kill hidden when pid is null) and fleet scope (workspace dot + name per row). Section hidden when empty. Mock mode: scheduled fake ports (10 s/25 s).
4. **Security model (§9)** — `grep -n "security" docs/SPEC.md`. One sentence: port-kill is host-mediated and travels only over the target workspace's own broker socket — no cross-workspace control path; the broker resolves the victim PID itself from the live socket.

- [ ] **Step 2: Handoff-readiness check**

Re-read the diff asking: could a fresh engineer rebuild the Serving feature from SPEC.md alone (frames, IPC shapes, state transitions, UI placement, skew behavior)? Fix any gap.

- [ ] **Step 3: Commit**

```bash
git -C $WT add docs/SPEC.md \
  && git -C $WT commit -m "docs(spec): serving-ports rail — broker frames, IPC surface, rail UI, security note

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Full gate + PR

**Files:** none.

- [ ] **Step 1: Full verification**

```bash
export PATH=$HOME/toolchains/go/bin:$PATH \
  && (cd $WT/broker && CGO_ENABLED=0 go test -race ./...) \
  && (cd $WT && npm run typecheck && npm run test:unit && npm run build)
```

Expected: everything PASS. (`npm test`'s Playwright leg cannot run here — no display.)

- [ ] **Step 2: Push and open the PR** (Troy's auth: if push fails, ask him to run `! gh auth login` then `gh auth setup-git`)

```bash
git -C $WT push -u origin feat/serving-ports-rail-spec
```

PR body must include: summary; UI verified by typecheck+unit+build only (no display in this container) — visual check on host via `CLAUDE_FLEET_MOCK=1 npm run dev` (fake ports at 10 s/25 s); e2e `tests/ports-rail.spec.ts` runs in CI; note that the enriched broker ships with the next runner-image build and old images degrade gracefully (port-only rows, no kill button). End the body with the standard Claude Code attribution line.

---

## Self-review notes (done at plan time)

- **Spec coverage:** broker enrichment (T2), KILLPORT (T3–T5), skew gating (T6/T10: `pid` optional → kill hidden), snapshot semantics incl. pid-change reset + pause clearing (T7), mock feed (T8), IPC + preload (T9), UI both scopes + inline confirm (T10–T11), e2e (T12), SPEC (T13). Non-goals respected: no copy-URL, no non-HTTP listeners, no DB persistence, no per-session attribution.
- **Type consistency:** `ServingPort` defined once in main (`portforward.ts`), mirrored once in preload (renderer imports the preload one — matches the existing `WorkspaceObservabilitySummary` pattern). `BrokerPortInfo` (optional fields, wire shape) vs `ServingPort` (nulls, snapshot shape) conversion happens exactly once, in `poll()`.
- **Known judgment calls for the executor:** `startTestServerReturningServer` may instead be a small refactor of the existing helper if it already exposes the server; the e2e workspace-selection locator must be copied from `tests/mock-mode.spec.ts` reality.
