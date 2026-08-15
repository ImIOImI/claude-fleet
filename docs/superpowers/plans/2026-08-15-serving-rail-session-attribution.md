# Serving-Rail Session Attribution + Always-Visible Kill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every serving port with the broker session that owns it (clickable chip → focuses the tab) and show the kill button unconditionally, failing loudly on old brokers.

**Architecture:** The broker (which already owns every claude PTY and attributes ports to pids) walks the port-owner's `/proc` ppid ancestry against its live session-root map and ships a `session` field in the `PORTS` payload. The host threads it through `ServingPort.sessionId`; the renderer resolves it to a tab name via `sessions.json` and reuses the existing `activateRequest` jump-to-tab plumbing. Kill's `pid !== null` gate is removed — an old broker's dropped `KILLPORT` frame times out and surfaces as an actionable toast.

**Tech Stack:** Go (broker), TypeScript (Electron main + preload), React (renderer), vitest, Playwright, `go test`.

**Spec:** `docs/superpowers/specs/2026-08-15-serving-rail-session-attribution-design.md` (same worktree).

## Global Constraints

- Work in the worktree `/workspace/claude-fleet/.claude/worktrees/serving-rail-session-attribution` (branch `feat/serving-rail-session-attribution`). NEVER `cd /workspace/claude-fleet` — that's the shared base checkout on another branch. Run npm/npx/go with the worktree as cwd (`cd` into the worktree is fine).
- **Go toolchain:** `~/toolchains/go/bin/go`. No cgo in this container → run `go test ./...` WITHOUT `-race` locally (CI runs the race build).
- **Vitest env prep (container lacks a C++ compiler; worktrees resolve node_modules up to the BASE checkout's `/workspace/claude-fleet/node_modules`):**
  1. If `/workspace/claude-fleet/node_modules/better-sqlite3/build/Release/better_sqlite3.node` is missing: `cd /tmp && mkdir -p bs3probe && cd bs3probe && npm init -y && npm install better-sqlite3@12.10.0` then copy the built `.node` file to that path.
  2. If `require('electron')` throws in tests: `printf 'electron-stub' > /workspace/claude-fleet/node_modules/electron/path.txt`.
  3. If imports fail for packages missing from the old base branch (`@huggingface/transformers`, `@opentelemetry/*`): install ALL of them in ONE `npm install --prefix /workspace/claude-fleet --no-save --ignore-scripts …` command (separate runs prune each other).
- **No UI verification in this container** (no display/electron). Gate with `npm run typecheck` + `npm run test:unit` + `npm run build`; note that in the PR. The e2e specs are written here but validated in CI.
- **Copy rules (from spec):** old-broker kill error text is exactly `runner image too old — recreate the workspace to enable kill`. Chip = bordered pill, `--info` tint, ▸ glyph, max-width 110px, radius 99px. Row order (workspace scope): `:port · cmdline · [chip] · uptime · ↗ · ✕`.
- **Behavior rules (from spec):** pid change → replace row + reset `firstSeenAt` (restart). sessionId change alone → update in place, KEEP `firstSeenAt`. `sessionId: null` or unresolvable name → no chip, row otherwise unchanged. Kill keeps the serving-snapshot membership gate in `killPort`.
- `docs/SPEC.md` must be updated in this PR (proto payload + data model + user-flow changes) — Task 8.

---

### Task 1: Broker — expose session root pids

**Files:**
- Modify: `broker/internal/session/session.go` (Session struct is at ~line 30; `s.cmd`/`s.cmd.Process` already used in `kill()` ~line 197)
- Modify: `broker/internal/session/manager.go`
- Test: `broker/internal/session/rootpids_test.go` (new)

**Interfaces:**
- Produces: `(s *Session) Pid() int` (0 when process gone/never started); `(m *Manager) RootPids() map[int]string` (live sessions only, pid → session id). Task 3 consumes `RootPids`.

- [ ] **Step 1: Write the failing test**

```go
package session

import "testing"

// Sessions spawn /bin/cat in tests (no claude binary needed) — same
// stand-in the rest of the package's tests use.
func TestRootPids(t *testing.T) {
	m := NewManager(ManagerConfig{ClaudeExec: "/bin/cat"})
	defer m.CloseAll()

	s, err := m.Create("tab-1", 80, 24, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s.Pid() <= 0 {
		t.Fatalf("Pid() = %d, want > 0", s.Pid())
	}

	roots := m.RootPids()
	if got := roots[s.Pid()]; got != "tab-1" {
		t.Fatalf("RootPids()[%d] = %q, want %q (map: %v)", s.Pid(), got, "tab-1", roots)
	}

	// A closed session must drop out of the map.
	m.Close("tab-1")
	if _, ok := m.RootPids()[s.Pid()]; ok {
		t.Fatalf("RootPids still contains closed session")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from the worktree): `cd broker && ~/toolchains/go/bin/go test ./internal/session/ -run TestRootPids -v`
Expected: FAIL — `s.Pid undefined` / `m.RootPids undefined` (compile error).

- [ ] **Step 3: Implement**

In `session.go`, add below the Session struct's existing methods:

```go
// Pid returns the root pid of the session's claude process, or 0 when the
// process is gone or never started. Used for port→session attribution.
func (s *Session) Pid() int {
	if s.cmd != nil && s.cmd.Process != nil {
		return s.cmd.Process.Pid
	}
	return 0
}
```

In `manager.go`, add after `List()`:

```go
// RootPids maps each live session's PTY root pid → session id. LISTPORTS
// uses it to attribute a listening port to the session whose process tree
// spawned the server. Dead-but-listed sessions are excluded: their pid may
// already be reused by an unrelated process.
func (m *Manager) RootPids() map[int]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int]string, len(m.sessions))
	for id, s := range m.sessions {
		if !s.Alive() {
			continue
		}
		if pid := s.Pid(); pid > 0 {
			out[pid] = id
		}
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && ~/toolchains/go/bin/go test ./internal/session/ -v`
Expected: PASS (all package tests, not just the new one).

- [ ] **Step 5: Commit**

```bash
git add internal/session/session.go internal/session/manager.go internal/session/rootpids_test.go
git commit -m "feat(broker): expose live session root pids for port attribution"
```

---

### Task 2: Broker — ancestry walk in portscan

**Files:**
- Modify: `broker/internal/portscan/portscan.go` (add `Session` to `Detail`, ~line 31)
- Create: `broker/internal/portscan/attribute.go`
- Test: `broker/internal/portscan/attribute_test.go` (new)

**Interfaces:**
- Consumes: `Detail{Port, Pid, Cmdline}` (existing).
- Produces: `Detail.Session string` ("" when unresolved); `AttributeSessions(details []Detail, roots map[int]string)` (mutates in place, best-effort, never errors). Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

```go
package portscan

import "testing"

// fake ppid table: child → parent. Missing key = unreadable /proc entry.
func ppidFrom(table map[int]int) func(int) (int, bool) {
	return func(pid int) (int, bool) {
		p, ok := table[pid]
		return p, ok
	}
}

func TestAttributeSessions(t *testing.T) {
	roots := map[int]string{100: "tab-a", 200: "tab-b"}
	tree := map[int]int{
		100: 1,          // session root a
		200: 1,          // session root b
		150: 100,        // shell under tab-a
		155: 150,        // dev server under that shell
		300: 1,          // orphan (reparented to init)
		400: 999, 999: 1, // chain that never hits a root
	}

	cases := []struct {
		name string
		pid  int
		want string
	}{
		{"direct child of root", 150, "tab-a"},
		{"deep descendant", 155, "tab-a"},
		{"the root itself", 200, "tab-b"},
		{"orphan reparented to init", 300, ""},
		{"chain missing any root", 400, ""},
		{"unresolved owner (pid 0)", 0, ""},
	}
	for _, c := range cases {
		details := []Detail{{Port: 8080, Pid: c.pid}}
		attributeSessions(details, roots, ppidFrom(tree))
		if details[0].Session != c.want {
			t.Errorf("%s: Session = %q, want %q", c.name, details[0].Session, c.want)
		}
	}
}

func TestAttributeSessionsHopLimit(t *testing.T) {
	// A pathological chain longer than the hop limit must terminate empty.
	tree := map[int]int{}
	for i := 2; i < 200; i++ {
		tree[i] = i + 1
	}
	details := []Detail{{Port: 1, Pid: 2}}
	attributeSessions(details, map[int]string{99999: "never"}, ppidFrom(tree))
	if details[0].Session != "" {
		t.Fatalf("Session = %q, want empty (hop limit)", details[0].Session)
	}
}

func TestAttributeSessionsNoRoots(t *testing.T) {
	details := []Detail{{Port: 1, Pid: 42}}
	attributeSessions(details, nil, func(int) (int, bool) { t.Fatal("ppid must not be called with no roots"); return 0, false })
	if details[0].Session != "" {
		t.Fatalf("Session = %q, want empty", details[0].Session)
	}
}

func TestProcPpidParsesCommWithParens(t *testing.T) {
	// comm may contain spaces AND parens: "(my (weird) cmd)". Parse after the
	// LAST ')'. parsePpidFromStat is the pure core of procPpid.
	ppid, ok := parsePpidFromStat("155 (my (weird) cmd) S 150 155 100 0 -1")
	if !ok || ppid != 150 {
		t.Fatalf("parsePpidFromStat = %d,%v want 150,true", ppid, ok)
	}
	if _, ok := parsePpidFromStat("garbage with no close paren"); ok {
		t.Fatal("malformed stat line must not parse")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && ~/toolchains/go/bin/go test ./internal/portscan/ -run 'TestAttribute|TestProcPpid' -v`
Expected: FAIL — `Detail` has no field `Session`; `attributeSessions`/`parsePpidFromStat` undefined.

- [ ] **Step 3: Implement**

In `portscan.go`, extend `Detail`:

```go
// Detail is one listening TCP port and (best-effort) its owner.
type Detail struct {
	Port    uint16
	Pid     int    // 0 when unresolved
	Cmdline string // "" when unresolved
	Session string // owning broker session id; "" when unresolved
}
```

Create `attribute.go`:

```go
// Port→session attribution: walk a port-owner's /proc ppid ancestry until
// it hits a live broker session's PTY root pid. Best-effort everywhere — a
// read failure, an orphaned process (reparented to init), or a chain past
// the hop limit just leaves Session empty; attribution must never fail a
// LISTPORTS response.
package portscan

import (
	"os"
	"strconv"
	"strings"
)

// maxAncestryHops bounds the walk; real container process trees are a
// handful deep, so 32 only guards against ppid-table cycles or churn.
const maxAncestryHops = 32

// AttributeSessions stamps each attributed Detail with the session whose
// process tree contains the port's owner. roots maps session root pid →
// session id (from session.Manager.RootPids).
func AttributeSessions(details []Detail, roots map[int]string) {
	attributeSessions(details, roots, procPpid)
}

func attributeSessions(details []Detail, roots map[int]string, ppid func(int) (int, bool)) {
	if len(roots) == 0 {
		return
	}
	for i := range details {
		details[i].Session = sessionFor(details[i].Pid, roots, ppid)
	}
}

func sessionFor(pid int, roots map[int]string, ppid func(int) (int, bool)) string {
	for hops := 0; pid > 1 && hops < maxAncestryHops; hops++ {
		if id, ok := roots[pid]; ok {
			return id
		}
		next, ok := ppid(pid)
		if !ok {
			return ""
		}
		pid = next
	}
	return ""
}

// procPpid reads a process's parent pid from /proc/<pid>/stat.
func procPpid(pid int) (int, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	return parsePpidFromStat(string(b))
}

// parsePpidFromStat extracts field 4 (ppid) from a /proc/<pid>/stat line.
// The comm field may itself contain spaces and parens, so fields are
// counted after the LAST ')'.
func parsePpidFromStat(stat string) (int, bool) {
	close := strings.LastIndexByte(stat, ')')
	if close < 0 {
		return 0, false
	}
	fields := strings.Fields(stat[close+1:])
	// fields after comm: state ppid pgrp session ... — ppid is index 1.
	if len(fields) < 2 {
		return 0, false
	}
	p, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, false
	}
	return p, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && ~/toolchains/go/bin/go test ./internal/portscan/ -v`
Expected: PASS (including the pre-existing portscan tests).

- [ ] **Step 5: Commit**

```bash
git add internal/portscan/portscan.go internal/portscan/attribute.go internal/portscan/attribute_test.go
git commit -m "feat(broker): attribute listening ports to owning sessions via ppid ancestry"
```

---

### Task 3: Broker — ship `session` in the PORTS payload

**Files:**
- Modify: `broker/internal/proto/proto.go` (`PortInfo` ~line 215; protocol doc-comment table ~line 41)
- Modify: `broker/internal/server/server.go` (`New()` ~line 43; `FrameListPorts` handler ~line 326)
- Test: `broker/internal/server/ports_session_test.go` (new)

**Interfaces:**
- Consumes: `portscan.AttributeSessions`, `mgr.RootPids()` (Tasks 1–2).
- Produces: wire JSON `{ports:[{port,pid?,cmdline?,session?}]}`. Task 4 consumes `session` on the host.

- [ ] **Step 1: Write the failing test**

Look at the existing tests in `broker/internal/server/server_test.go` FIRST and reuse the package's connection/frame helpers if present (there are existing LISTPORTS tests — mirror how they drive a Server with an injected `ListPorts`). If the helpers don't fit, this self-contained pattern works: inject `srv.ListPorts` to return Details WITH `Session` set, invoke the frame path the same way the existing LISTPORTS test does, and assert the JSON payload.

```go
package server

// (imports to match the package's existing test file conventions)

func TestListPortsCarriesSession(t *testing.T) {
	// Drive the same code path the existing LISTPORTS test uses, but with
	// an injected scanner whose Details carry Session, and assert the
	// PORTS JSON includes `"session":"tab-1"` for the attributed row and
	// OMITS the key for the unattributed one (omitempty).
	srv := New(session.NewManager(session.ManagerConfig{ClaudeExec: "/bin/cat"}))
	srv.ListPorts = func() ([]portscan.Detail, error) {
		return []portscan.Detail{
			{Port: 3000, Pid: 42, Cmdline: "vite", Session: "tab-1"},
			{Port: 8080},
		}, nil
	}
	// ... drive FrameListPorts / read FramePorts exactly as server_test.go does ...
	// assert payload contains `"session":"tab-1"` and the 8080 entry has no "session" key.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && ~/toolchains/go/bin/go test ./internal/server/ -run TestListPortsCarriesSession -v`
Expected: FAIL — `unknown field Session in struct literal of type proto.PortInfo` (after you write the assertion against `session` in the payload; the compile error comes when Step 3's handler change is attempted first — either failure mode is acceptable evidence).

- [ ] **Step 3: Implement**

`proto.go` — extend `PortInfo` and the doc-comment table:

```go
// PortInfo is one listening TCP port detected inside the container,
// attributed (best-effort) to its owning process and broker session.
// Pid/Cmdline/Session are omitted when unresolved; the host treats a
// missing session as "no owning tab" (orphaned or pre-session server).
type PortInfo struct {
	Port    uint16 `json:"port"`
	Pid     int    `json:"pid,omitempty"`
	Cmdline string `json:"cmdline,omitempty"`
	Session string `json:"session,omitempty"`
}
```

In the frame-table doc comment near the top (the `PORTS` row, ~line 42), update the payload sketch to `{"ports":[{port,pid?,cmdline?,session?},...]}`.

`server.go` — attribute in the default scanner (so injected test scanners bypass it) and copy the field:

```go
func New(mgr *session.Manager) *Server {
	return &Server{
		mgr: mgr,
		ListPorts: func() ([]portscan.Detail, error) {
			details, err := portscan.Listening()
			if err == nil {
				portscan.AttributeSessions(details, mgr.RootPids())
			}
			return details, err
		},
		KillPort: func(port uint16) error { return portscan.KillOwner(port, 2*time.Second) },
	}
}
```

Handler (~line 334):

```go
resp.Ports[i] = proto.PortInfo{Port: p.Port, Pid: p.Pid, Cmdline: p.Cmdline, Session: p.Session}
```

- [ ] **Step 4: Run the full broker suite**

Run: `cd broker && ~/toolchains/go/bin/go test ./...`
Expected: PASS across all packages.

- [ ] **Step 5: Commit**

```bash
git add internal/proto/proto.go internal/server/server.go internal/server/ports_session_test.go
git commit -m "feat(broker): PORTS payload carries owning session id"
```

---

### Task 4: Host — thread `sessionId` through ServingPort

**Files:**
- Modify: `src/main/broker.ts` (`BrokerPortInfo` ~line 157)
- Modify: `src/main/portforward.ts` (`ServingPort` ~line 40; `poll()` new-port add ~line 229 and restart-detect loop ~line 207)
- Modify: `src/preload/index.ts` (`ServingPort` mirror ~line 110)
- Test: `src/main/portforward.test.ts` (extend)

**Interfaces:**
- Consumes: broker JSON `session?: string` (Task 3).
- Produces: `ServingPort { port, pid, cmdline, sessionId: string | null, firstSeenAt }` — consumed by renderer (Task 7) and mock (Task 6). Change semantics: pid change → new row + reset `firstSeenAt`; sessionId-only change → update in place, KEEP `firstSeenAt`, still fires `onChanged`.

- [ ] **Step 1: Write the failing tests** (append to `portforward.test.ts`; reuse its existing `stubClient`/fake-timer patterns — note the existing stub's `listPorts` returns `{ port }` objects, extend a local variant to return full details):

```ts
describe('ServingPort session attribution', () => {
  function mgrWith(listPorts: () => Array<{ port: number; pid?: number; cmdline?: string; session?: string }>, onChanged: (id: string, ports: ServingPort[]) => void): PortForwardManager {
    return new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve(listPorts()),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        }) as never,
      onDetected: () => {},
      onChanged,
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000,
      now: () => 111
    });
  }

  it('carries the broker session id into the snapshot', async () => {
    let last: ServingPort[] = [];
    const mgr = mgrWith(() => [{ port: 3000, pid: 42, cmdline: 'vite', session: 'tab-1' }], (_id, p) => (last = p));
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last).toEqual([{ port: 3000, pid: 42, cmdline: 'vite', sessionId: 'tab-1', firstSeenAt: 111 }]);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('late attribution updates sessionId in place without resetting firstSeenAt', async () => {
    let last: ServingPort[] = [];
    let calls = 0;
    const details = [{ port: 3000, pid: 42, cmdline: 'vite' } as { port: number; pid?: number; cmdline?: string; session?: string }];
    const mgr = mgrWith(() => details, (_id, p) => ((last = p), calls++));
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last[0].sessionId).toBeNull();
    const seenAt = last[0].firstSeenAt;
    details[0].session = 'tab-1'; // fd-race resolved on a later scan
    await vi.advanceTimersByTimeAsync(1000);
    expect(last[0].sessionId).toBe('tab-1');
    expect(last[0].firstSeenAt).toBe(seenAt); // NOT a restart
    expect(calls).toBe(2);
    mgr.dispose();
    vi.useRealTimers();
  });

  it('a pid change still resets the row (restart) and takes the new sessionId', async () => {
    let last: ServingPort[] = [];
    const details = [{ port: 3000, pid: 42, cmdline: 'vite', session: 'tab-1' } as { port: number; pid?: number; cmdline?: string; session?: string }];
    let t = 100;
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve(details),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        }) as never,
      onDetected: () => {},
      onChanged: (_id, p) => (last = p),
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000,
      now: () => t
    });
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000);
    t = 200;
    details[0].pid = 43;
    details[0].session = 'tab-2';
    await vi.advanceTimersByTimeAsync(1000);
    expect(last[0]).toEqual({ port: 3000, pid: 43, cmdline: 'vite', sessionId: 'tab-2', firstSeenAt: 200 });
    mgr.dispose();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from the worktree): `npx vitest run src/main/portforward.test.ts`
Expected: FAIL — `sessionId` missing from emitted rows (type error or `toEqual` mismatch).

- [ ] **Step 3: Implement**

`broker.ts`:

```ts
export interface BrokerPortInfo {
  port: number;
  pid?: number;
  cmdline?: string;
  /** Owning broker session id (ppid-ancestry attribution); absent when
   *  unresolved or on a pre-session-attribution broker. */
  session?: string;
}
```

`portforward.ts` — the interface:

```ts
/** One HTTP-serving container port in the authoritative rail snapshot. */
export interface ServingPort {
  port: number;
  pid: number | null;
  cmdline: string | null;
  /** Broker session id of the tab whose process tree owns the server;
   *  null when the broker couldn't attribute one (orphan, old image). */
  sessionId: string | null;
  firstSeenAt: number; // epoch ms (host clock)
}
```

The restart-detect loop in `poll()` (replacing the existing pid-only block at ~line 207):

```ts
      // A pid change behind a still-listening port is a server restart:
      // replace the row and restart its uptime clock. A sessionId change
      // alone is late attribution (fd race on an earlier scan) — update in
      // place, keeping firstSeenAt.
      for (const [port, sp] of monitor.serving) {
        const d = byPort.get(port);
        if (!d) continue;
        const pid = d.pid ?? null;
        const sessionId = d.session ?? null;
        if (pid !== sp.pid) {
          monitor.serving.set(port, {
            port,
            pid,
            cmdline: d.cmdline ?? null,
            sessionId,
            firstSeenAt: this.deps.now()
          });
          changed = true;
        } else if (sessionId !== sp.sessionId) {
          monitor.serving.set(port, { ...sp, sessionId });
          changed = true;
        }
      }
```

The new-port admission (~line 229) gains `sessionId: d?.session ?? null`.

`src/preload/index.ts` — mirror the interface (add `sessionId: string | null;` with the same comment).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/portforward.test.ts` — expected: PASS (new + all pre-existing).
Run: `npm run typecheck` — expected: clean. If other files break on the new required field (e.g. `mockPorts.ts`, `ipc.ts` test handler callers), add `sessionId: null` literals there as part of this task — Task 6 replaces the mock's with real stamping.

- [ ] **Step 5: Commit**

```bash
git add src/main/broker.ts src/main/portforward.ts src/main/portforward.test.ts src/preload/index.ts src/main/mockPorts.ts
git commit -m "feat: ServingPort carries the owning broker session id"
```

---

### Task 5: Kill — always visible, graceful old-broker failure

**Files:**
- Modify: `src/main/portforward.ts` (`killPort` catch ~line 290)
- Modify: `src/renderer/src/components/PortsSection.tsx` (remove `row.pid !== null` gate ~line 107)
- Test: `src/main/portforward.test.ts` (extend); `tests/ports-rail.spec.ts` (flip the pid-null assertion)

**Interfaces:**
- Consumes: `BrokerClient.killPort` rejecting with `broker: KILLED timed out` on old brokers (existing `RPC_TIMEOUT_MS` behavior, `src/main/broker.ts:404`).
- Produces: `killPort` error copy `runner image too old — recreate the workspace to enable kill` (exact); ✕ rendered for every row. App.tsx's existing `killServingPort` toast (`App.tsx:450`) already prints `error` verbatim — no renderer handler change needed.

- [ ] **Step 1: Write the failing unit test** (append to `portforward.test.ts`):

```ts
describe('killPort old-broker fallback', () => {
  it('maps a KILLED rpc timeout to actionable copy', async () => {
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () =>
        ({
          ready: () => Promise.resolve(),
          close: () => {},
          listPorts: () => Promise.resolve([{ port: 3000, pid: 42 }]),
          killPort: () => Promise.reject(new Error('broker: KILLED timed out')),
          dial: () => Promise.reject(new Error('stub')),
          closeChannel: () => Promise.resolve()
        }) as never,
      onDetected: () => {},
      onChanged: () => {},
      excludePorts: () => [],
      probePort: () => Promise.resolve(true),
      pollMs: 1000
    });
    vi.useFakeTimers();
    mgr.reconcile(['ws']);
    await vi.advanceTimersByTimeAsync(1000); // port 3000 enters the snapshot
    vi.useRealTimers();
    const res = await mgr.killPort('ws', 3000);
    expect(res).toEqual({
      ok: false,
      error: 'runner image too old — recreate the workspace to enable kill'
    });
    mgr.dispose();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/portforward.test.ts -t 'old-broker'`
Expected: FAIL — error is the raw `broker: KILLED timed out`.

- [ ] **Step 3: Implement**

`portforward.ts` `killPort` catch block:

```ts
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A pre-KILLPORT broker logs-and-drops the unknown frame, so the RPC
      // times out. Translate into copy the toast can show as-is.
      if (/timed out/.test(msg)) {
        return { ok: false, error: 'runner image too old — recreate the workspace to enable kill' };
      }
      return { ok: false, error: msg };
    }
```

`PortsSection.tsx` — replace the gated kill button:

```tsx
          <button
            type="button"
            className="obs-port-btn kill"
            title="Kill server"
            aria-label={`Kill server on port ${row.port}`}
            onClick={() => setConfirming(true)}
          >
            ✕
          </button>
```

(i.e. delete the surrounding `{row.pid !== null && (...)}` wrapper — the button always renders.)
Also update the component's doc comment: the kill button is no longer hidden for pid-less rows; old brokers fail at kill time with a toast.

- [ ] **Step 4: Update the e2e expectation** in `tests/ports-rail.spec.ts`: the injected `{ port: 8765, pid: null, ... }` row (add `sessionId: null` to both injected rows while here) previously asserted `toHaveCount(0)` for `.obs-port-btn.kill` — flip it:

```ts
    // pid:null row (old broker) still gets a kill button — the failure is
    // surfaced at kill time via toast, not by hiding the affordance.
    await expect(rows.nth(1).locator('.obs-port-btn.kill')).toHaveCount(1);
```

- [ ] **Step 5: Verify**

Run: `npx vitest run src/main/portforward.test.ts` — PASS.
Run: `npm run typecheck` — clean. (e2e runs in CI — no display here; say so in the PR.)

- [ ] **Step 6: Commit**

```bash
git add src/main/portforward.ts src/main/portforward.test.ts src/renderer/src/components/PortsSection.tsx tests/ports-rail.spec.ts
git commit -m "feat: always show the serving-row kill button; old brokers fail with actionable copy"
```

---

### Task 6: Mock feed — stamp real session ids

**Files:**
- Modify: `src/main/mockPorts.ts`
- Modify: `src/main/ipc.ts` (mock wiring ~line 211)
- Test: `src/main/mockPorts.test.ts` (extend)

**Interfaces:**
- Consumes: `readInventory(workspaceId)` from `src/main/sessions.ts:67` (already imported by ipc.ts for the `sessions:read` handler at ~line 972 — reuse that import).
- Produces: `MockServingPorts` constructor gains a third optional param `resolveSessionId?: (workspaceId: string) => Promise<string | null>`; the FIRST fake port gets the workspace's first inventory session id (chip exercisable under `CLAUDE_FLEET_MOCK=1` once a tab exists), the second stays `null` (exercises the no-chip row).

- [ ] **Step 1: Write the failing test** (extend `mockPorts.test.ts`, following its existing fake-timer style — read it first):

```ts
it('stamps the first fake port with the resolved session id, second stays null', async () => {
  vi.useFakeTimers();
  const snapshots: ServingPort[][] = [];
  const mock = new MockServingPorts(
    (_id, ports) => snapshots.push(ports),
    () => 111,
    async () => 'tab-1'
  );
  mock.reconcile(['ws']);
  await vi.advanceTimersByTimeAsync(25_000);
  await vi.advanceTimersByTimeAsync(0); // let the async resolve settle
  const last = snapshots.at(-1)!;
  expect(last.find((p) => p.port === 3000)?.sessionId).toBe('tab-1');
  expect(last.find((p) => p.port === 8765)?.sessionId).toBeNull();
  mock.dispose();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/mockPorts.test.ts` — FAIL (constructor arity / sessionId undefined).

- [ ] **Step 3: Implement**

`mockPorts.ts`:

```ts
const FAKES: ReadonlyArray<{ afterMs: number; port: number; pid: number; cmdline: string; attributed: boolean }> = [
  { afterMs: 10_000, port: 3000, pid: 4242, cmdline: 'node /workspace/node_modules/.bin/vite dev', attributed: true },
  { afterMs: 25_000, port: 8765, pid: 4343, cmdline: 'python3 -m http.server 8765', attributed: false }
];
```

Constructor gains:

```ts
  constructor(
    private readonly onChanged: (workspaceId: string, ports: ServingPort[]) => void,
    private readonly now: () => number = Date.now,
    /** Maps a workspace to the broker session id its first fake port is
     *  attributed to (mock stand-in for the broker's ancestry walk).
     *  Undefined/null → the port renders without a session chip. */
    private readonly resolveSessionId?: (workspaceId: string) => Promise<string | null>
  ) {}
```

`add()` becomes async-tolerant:

```ts
  private add(id: string, f: (typeof FAKES)[number]): void {
    void (f.attributed && this.resolveSessionId ? this.resolveSessionId(id) : Promise.resolve(null))
      .catch(() => null)
      .then((sessionId) => {
        if (!this.timers.has(id)) return; // stopped while resolving
        let ports = this.serving.get(id);
        if (!ports) {
          ports = new Map();
          this.serving.set(id, ports);
        }
        ports.set(f.port, { port: f.port, pid: f.pid, cmdline: f.cmdline, sessionId, firstSeenAt: this.now() });
        this.emit(id);
      });
  }
```

(`kill`/`snapshot`/`emit` are untouched.) In `ipc.ts` (~line 211):

```ts
const mockPorts: MockServingPorts | null = MOCK_MODE && process.env.CLAUDE_FLEET_E2E !== '1'
  ? new MockServingPorts(broadcastPortsChanged, undefined, async (workspaceId) => {
      const inv = await readInventory(workspaceId);
      return inv.sessions[0]?.id ?? null;
    })
  : null;
```

(Passing `undefined` for `now` keeps the `Date.now` default; verify `readInventory` is already imported in ipc.ts — it backs `sessions:read` — and import it if it's accessed some other way there.)

- [ ] **Step 4: Verify**

Run: `npx vitest run src/main/mockPorts.test.ts` — PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/mockPorts.ts src/main/mockPorts.test.ts src/main/ipc.ts
git commit -m "feat(mock): fake serving ports stamp a real inventory session id"
```

---

### Task 7: Renderer — session chip with click-to-focus

**Files:**
- Create: `src/renderer/src/useServingSessionNames.ts`
- Test: `src/renderer/src/useServingSessionNames.test.ts` (pure helper only — renderer unit tests in this repo are pure-TS, no jsdom)
- Modify: `src/renderer/src/components/PortsSection.tsx`
- Modify: `src/renderer/src/components/ObservabilityPane.tsx` (props ~line 48; workspace-scope call ~line 151; `FleetView` ~line 251 + its call ~line 316)
- Modify: `src/renderer/src/App.tsx` (hook + focus callback near `killServingPort` ~line 450; ObservabilityPane props ~line 1325)
- Modify: `src/renderer/src/styles.css` (after the `.obs-port-kill-confirm` block ~line 1060)
- Test: `tests/ports-rail.spec.ts` (new spec block)

**Interfaces:**
- Consumes: `ServingPort.sessionId` (Task 4); `window.api.sessions.read(workspaceId): Promise<SessionInventory>` (existing, preload ~line 318); App's existing `activateRequest` state + `activateTokenRef` (`App.tsx:324-329`) and `setSelectedId`.
- Produces:
  - `workspacesNeedingNames(servingPorts: Record<string, ServingPort[]>): string[]` (pure, exported for tests)
  - `useServingSessionNames(servingPorts): Record<string, Record<string, string>>` (wsId → brokerSessionId → tab name)
  - `PortRowData` gains `sessionName?: string`; `PortsSection` props gain `onFocusSession: (workspaceId: string, brokerSessionId: string) => void`
  - `ObservabilityPane` props gain `sessionNames: Record<string, Record<string, string>>` and `onFocusSession` (threaded to both PortsSection call sites)
  - CSS classes `.obs-port-chip`, `.obs-port-chip-glyph`, `.obs-port-chip-name`

- [ ] **Step 1: Write the failing pure-helper test** (`useServingSessionNames.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { workspacesNeedingNames } from './useServingSessionNames.js';
import type { ServingPort } from '../../preload';

const port = (sessionId: string | null): ServingPort => ({
  port: 3000,
  pid: 1,
  cmdline: 'x',
  sessionId,
  firstSeenAt: 0
});

describe('workspacesNeedingNames', () => {
  it('returns only workspaces with at least one attributed port, sorted', () => {
    expect(
      workspacesNeedingNames({
        b: [port('tab-1')],
        a: [port(null), port('tab-2')],
        c: [port(null)],
        d: []
      })
    ).toEqual(['a', 'b']);
  });
  it('empty input → empty output', () => {
    expect(workspacesNeedingNames({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/useServingSessionNames.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement the hook** (`useServingSessionNames.ts`):

```ts
import { useEffect, useState } from 'react';
import type { ServingPort } from '../../preload';

/** Workspace ids (sorted) with at least one serving port attributed to a
 *  session — the set of session inventories worth fetching. Pure for tests. */
export function workspacesNeedingNames(
  servingPorts: Record<string, ServingPort[]>
): string[] {
  return Object.keys(servingPorts)
    .filter((id) => (servingPorts[id] ?? []).some((p) => p.sessionId !== null))
    .sort();
}

/**
 * broker-session-id → tab-name maps per workspace, for the Serving rail's
 * session chips. Reads sessions.json (sessions:read) for exactly the
 * workspaces that currently have attributed ports; re-fetches when the set
 * of (workspace, sessionId) pairs changes. A tab rename can leave a chip
 * name stale until the next ports change — acceptable for a rail label.
 */
export function useServingSessionNames(
  servingPorts: Record<string, ServingPort[]>
): Record<string, Record<string, string>> {
  const [names, setNames] = useState<Record<string, Record<string, string>>>({});
  const key = Object.entries(servingPorts)
    .flatMap(([ws, ports]) =>
      ports.filter((p) => p.sessionId).map((p) => `${ws}:${p.sessionId}`)
    )
    .sort()
    .join(',');
  useEffect(() => {
    if (key === '') return;
    let alive = true;
    void Promise.all(
      workspacesNeedingNames(servingPorts).map(async (id) => {
        try {
          const inv = await window.api.sessions.read(id);
          return [id, Object.fromEntries(inv.sessions.map((s) => [s.id, s.name]))] as const;
        } catch {
          return [id, {} as Record<string, string>] as const;
        }
      })
    ).then((entries) => {
      if (alive) setNames(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
    // servingPorts is captured intentionally; `key` is its change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return names;
}
```

Run: `npx vitest run src/renderer/src/useServingSessionNames.test.ts` — PASS.

- [ ] **Step 4: PortsSection chip.** In `PortsSection.tsx`: `PortRowData` gains `sessionName?: string`; both `PortsSection` and `PortRow` gain `onFocusSession: (workspaceId: string, brokerSessionId: string) => void` (thread it like `onOpen`/`onKill`). Insert the chip between the cmdline span and the uptime span (workspace scope) / before the buttons (it's the same JSX position — after `.obs-port-cmd`):

```tsx
      {row.sessionId && row.sessionName && (
        <button
          type="button"
          className="obs-port-chip"
          title={`Session "${row.sessionName}" started this server — click to focus its tab`}
          aria-label={`Focus session ${row.sessionName}`}
          onClick={() => onFocusSession(row.workspaceId, row.sessionId!)}
        >
          <span className="obs-port-chip-glyph">▸</span>
          <span className="obs-port-chip-name">{row.sessionName}</span>
        </button>
      )}
```

Update the component doc comment (chip: owning session, click focuses the tab; absent when the broker couldn't attribute or the tab is gone).

- [ ] **Step 5: ObservabilityPane threading.** Add to `Props` (~line 48) and destructure:

```ts
  /** wsId → brokerSessionId → tab name, for Serving-row session chips. */
  sessionNames: Record<string, Record<string, string>>;
  onFocusSession: (workspaceId: string, brokerSessionId: string) => void;
```

Workspace-scope call site (~line 151):

```tsx
              <PortsSection
                rows={(servingPorts[workspace.id] ?? []).map((p) => ({
                  ...p,
                  workspaceId: workspace.id,
                  sessionName: p.sessionId ? sessionNames[workspace.id]?.[p.sessionId] : undefined
                }))}
                showWorkspace={false}
                onOpen={onOpenPort}
                onKill={onKillPort}
                onFocusSession={onFocusSession}
              />
```

`FleetView` (~line 251): add `sessionNames` and `onFocusSession` to its props (same types), pass them from the `<FleetView …>` call inside ObservabilityPane, and mirror the same `sessionName` join in its rows `flatMap` (~line 316), using `r.id` as the workspace key.

- [ ] **Step 6: App wiring.** In `App.tsx`, next to `killServingPort` (~line 462, after `const servingPorts = usePorts();`):

```ts
  const servingSessionNames = useServingSessionNames(servingPorts);

  // Serving-row session chip → jump to the owning tab (same activateRequest
  // path the Sessions-list jump uses).
  const focusServingSession = useCallback((workspaceId: string, brokerSessionId: string) => {
    setSelectedId(workspaceId);
    setActivateRequest({ workspaceId, brokerSessionId, token: ++activateTokenRef.current });
  }, []);
```

Import the hook (`import { useServingSessionNames } from './useServingSessionNames';`). Pass to `<ObservabilityPane … sessionNames={servingSessionNames} onFocusSession={focusServingSession} />` (~line 1325 block).

- [ ] **Step 7: CSS.** After `.obs-port-kill-confirm` (~line 1060) in `styles.css`:

```css
/* Serving-row session chip: the tab whose process tree owns the server.
   Click focuses that tab (switching workspace first in fleet scope). Info-
   tinted pill so it reads as clickable next to the quiet uptime text. */
.obs-port-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  max-width: 110px;
  font-size: 10.5px;
  padding: 1px 7px 2px;
  background: color-mix(in oklab, var(--info) 8%, transparent);
  border: 1px solid color-mix(in oklab, var(--info) 40%, var(--rule));
  border-radius: 99px;
  color: var(--ink-1);
  cursor: pointer;
  overflow: hidden;
}
.obs-port-chip:hover { color: var(--ink); border-color: var(--info); }
.obs-port-chip-glyph { font-size: 9px; color: var(--info); flex-shrink: 0; }
.obs-port-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 8: e2e spec** (append to `tests/ports-rail.spec.ts`; the preload API is reachable from page context, so the test can read the REAL tab id the mock pane created):

```ts
test('session chip names the owning tab and click focuses it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    // The pane auto-creates a first tab and persists it to sessions.json.
    await window.locator('.session-tab').first().waitFor();
    const { id: tabId, name: tabName } = await window.evaluate(async (ws) => {
      const inv = await window.api.sessions.read(ws);
      return { id: inv.sessions[0].id, name: inv.sessions[0].name };
    }, WS);

    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [
        { port: 3000, pid: 42, cmdline: 'node vite dev', sessionId: tabId, firstSeenAt: Date.now() },
        { port: 8765, pid: 43, cmdline: 'python3 -m http.server', sessionId: null, firstSeenAt: Date.now() }
      ]
    ]);

    const section = window.locator('.obs-section', { hasText: 'Serving' });
    const rows = section.locator('.obs-port-row');
    await expect(rows.first().locator('.obs-port-chip')).toContainText(tabName);
    // Unattributed row: no chip.
    await expect(rows.nth(1).locator('.obs-port-chip')).toHaveCount(0);

    // Click focuses the owning tab.
    await rows.first().locator('.obs-port-chip').click();
    await expect(window.locator(`.session-tab.active`)).toContainText(tabName);
  } finally {
    await app.close();
  }
});
```

(If the auto-created-tab assumption doesn't hold in mock+e2e mode, mirror how `multi-session.spec.ts` opens its first tab and reuse that instead — the sessions.read → inject → assert flow stays the same.)

- [ ] **Step 9: Verify**

Run: `npx vitest run src/renderer/src/useServingSessionNames.test.ts src/main/portforward.test.ts` — PASS.
Run: `npm run typecheck` — clean.
Run: `npm run build` — clean.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/useServingSessionNames.ts src/renderer/src/useServingSessionNames.test.ts \
  src/renderer/src/components/PortsSection.tsx src/renderer/src/components/ObservabilityPane.tsx \
  src/renderer/src/App.tsx src/renderer/src/styles.css tests/ports-rail.spec.ts
git commit -m "feat(ui): serving-row session chip — owning tab name, click to focus"
```

---

### Task 8: SPEC.md

**Files:**
- Modify: `docs/SPEC.md`

Per `.claude/rules/spec-maintenance.md` — edit in place, no changelog prose. Grep `docs/SPEC.md` for these anchors and update each:

- [ ] **Step 1: Frame table** (~line 145): `PORTS` payload → `JSON {ports:[{port,pid?,cmdline?,session?},...]}` — "listening-port snapshot with best-effort owner + session attribution".
- [ ] **Step 2: §5 port-detection paragraph** (~line 149): after the pid/cmdline attribution sentence, add: attribution continues one step further — the owner's `/proc` ppid ancestry is walked (bounded, best-effort) against the session manager's live root-pid map, and the owning broker session id ships as `session` (omitted when unresolved: orphaned server, fd race, hop limit). Delete the final sentence "A port with `pid` absent in the `PORTS` payload has no kill capability." — kill no longer depends on host-visible attribution.
- [ ] **Step 3: §5 Observability pane** (~line 177): in the Serving-section sentence, replace "kill button hidden when `pid` is null — old runner image broker cannot attribute or kill" with: every row has ✕; a session chip (owning tab's name, info-tinted pill) renders when the broker attributed the port to a live session AND that session is in the workspace's `sessions.json` — clicking it selects the workspace and focuses the tab via the `activateRequest` jump path; chip absent otherwise. Fleet scope: chip after the cmdline. Session names come from `sessions:read`, fetched per workspace-with-attributed-ports (`useServingSessionNames`).
- [ ] **Step 4: §6 `ServingPort` shape** (~line 258): `{ port, pid: number | null, cmdline: string | null, sessionId: string | null, firstSeenAt }` — `sessionId` = owning broker session id, null when unattributed.
- [ ] **Step 5: §6 `ports:changed`** (~line 262): membership/owner change now includes "or its sessionId resolved late (updated in place — `firstSeenAt` preserved; only a pid change resets it)".
- [ ] **Step 6: §6 `ports:kill`** (~line 264): add — on a pre-KILLPORT broker the RPC times out and the handler returns `{ ok:false, error: 'runner image too old — recreate the workspace to enable kill' }`, which the renderer toasts verbatim.
- [ ] **Step 7: §8 user flow step 5** (~line 922): kill button is always visible; two-step confirm unchanged; old-broker failure surfaces as an error toast (copy above). Add to the mock paragraph (~line 266): mock's first fake port is stamped with the workspace's first inventory session id (chip exercisable without a container).
- [ ] **Step 8: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): port session attribution + always-visible kill"
```

---

### Task 9: Full gate + PR

- [ ] **Step 1: Broker suite**: `cd broker && ~/toolchains/go/bin/go test ./...` — PASS.
- [ ] **Step 2: Unit suite**: `npm run test:unit` — PASS (apply the Global Constraints env prep if native imports fail).
- [ ] **Step 3: `npm run typecheck` && `npm run build`** — clean.
- [ ] **Step 4: Push + PR** against `main`. PR body must include:
  - Summary (both halves: kill-always + session chips) + screenshots note: **no display in this container — gated with typecheck + unit + build; e2e specs added but validated in CI; Troy eyeballs the UI on the host.**
  - **Rollout:** kill-always + toast is live on app update. Session chips (and pid/cmdline on old rows) require the runner-image republish + workspace recreate — same rebuild the #302 summarizer fix is waiting on.
  - Spec + plan docs are in the PR (`docs/superpowers/specs/…`, `docs/superpowers/plans/…`).

---

## Self-review notes (already applied)

- Spec coverage: broker walk (T1–3), host plumbing + late-attribution semantics (T4), kill-always + copy (T5), mock (T6), chip UI + focus + fleet scope + CSS (T7), SPEC.md (T8), tests at every layer (each task) + e2e (T5/T7). Non-goals respected: no grouping, no ended-session attribution (falls out of the walk naturally).
- Type consistency: broker wire field is `session` (Go `Session`, JSON `session,omitempty`); host/renderer field is `sessionId: string | null`; chip needs `sessionId && sessionName`. `onFocusSession(workspaceId, brokerSessionId)` is the one callback name everywhere.
- Known softness (acceptable, called out): T3's server test asks the implementer to mirror existing `server_test.go` helpers; T7's e2e first-tab assumption has a stated fallback (`multi-session.spec.ts` pattern).
