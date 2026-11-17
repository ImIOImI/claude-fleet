# Graceful drain of remote fleet-host pods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Kubernetes replaces the workspace pod, running claude turns finish (up to a 30 min soft deadline), automation runs that are cut off re-run once without double-posting, and every open desktop tab resumes on the new pod by itself. The host pod's own shutdown gets a hard 20 s deadline, an immediate not-ready signal and a 5 s preStop.

**Architecture:**
- **Broker (Go).** A `drain` state machine (`serving → draining → done`) is driven by:
  - a `preStop` exec of `broker drain` over a local control Unix socket;
  - SIGTERM, as a fallback.

  It reads claude's own status file (`~/.claude/sessions/<pid>.json`) to find idle and waiting sessions, closes those at once, lets busy turns finish, interrupts at the soft deadline (Esc for interactive sessions, SIGINT for headless ones) and kills everything at the hard deadline. While draining it refuses `INPUT` (answering `NOTICE`) and `CREATE`, and it pushes `STATE` to `WATCH` connections.
- **fleet-host.**
  - A `DrainGate` holds one persistent `WATCH` connection and pauses automation dispatch.
  - It records drained interactive sessions (`host_drained_sessions`) and drain-cut automation runs (`host_run_retries`, host track v5), and re-runs each cut run once when the new broker serves.
  - It publishes the sticky `/events` channel `broker:drain`.
  - Shutdown gets `/healthz` `draining` and a 20 s deadline.
- **Desktop.**
  - Main relays `broker:drain` to the renderer.
  - `attachRemotePty` resumes a drained session through `sessions:drained`.
  - The renderer shows the restarting chip and banner, makes tabs read-only, and re-attaches the tabs that ended during the drain.

**Tech Stack:** Go 1.22 (broker, `creack/pty`), Bash (entry script), TypeScript (fleet-host on Node 22, Electron main/preload, React renderer), Kysely on Postgres (host store), vitest, `go test -race`.

**Spec:** `docs/superpowers/specs/2026-11-17-graceful-drain-design.md` (approved by the owner 2026-11-17).

## Global Constraints

Every task's requirements include this section.

**Binding design (owner-approved)**
- Workspace pod:
  - preStop drain;
  - freeze input and CREATE;
  - idle and waiting sessions close at once, busy turns finish, headless sessions count as busy until they exit;
  - Esc / SIGINT at 30 min, everything closed at 35 min;
  - `terminationGracePeriodSeconds: 2400`.
- Host pod: `terminationGracePeriodSeconds: 45`, no session drain, a 20 s deadline, `/healthz` 503 `draining`, `preStop: sleep 5`, the proxy stopping after the app.
- An interrupted run is recorded as `interrupted` with the reason `interrupted by host restart`, never `failed`. It re-runs once from the start, never twice, and never after posting.
- The desktop auto-resumes the drained sessions and reattaches the open tabs.

**Security**
- **Drain is never reachable on :7070 (D142).** `DRAIN` exists only on the control socket (`/run/broker/ctl.sock`, 0600), which is opened only when `CLAUDE_FLEET_BROKER_DRAIN=1`. The main listener drops the frame as unknown.
- **TCP stays mesh-only (D96).** No new TCP listener or port is added. `STATUS`/`WATCH` ride :7070 under the existing AuthorizationPolicy.
- **Host replies are untrusted on the desktop (§9).** `broker:drain` and `sessions:drained` payloads are validated field by field, and a bad payload is dropped.
- **No CREATEROLE (D71).** Host track v5 only creates tables and an index (expand-only, compatible with the previous release).

**Data**
- **No new run status.** `interrupted` already exists in `RunStatus`, `RUN_STATUSES` and the desktop validators, and only the `error` text distinguishes host restarts.
- **Every host write is fenced and holder-only** (`afterBeginWrite: leaseFence`), as in §7 *Host store*.
- `freshState` must never report `ended` (which the runner records as success) for a session the drain cut off.

**Process**
- **SPEC.md is updated in the same PR as the code (Task 17)** (`.claude/rules/spec-maintenance.md`). This docs PR only adds the §11 *Open decisions* entry.
- **Comments are terse and necessary** (`.claude/rules/review-conventions.md`).
- **The environment has no Docker, no Kubernetes and no display.**
  - Go: `cd broker && go test -race ./...` (Go is at `~/toolchains/go/bin`, no cgo; set `CGO_ENABLED=0` and drop `-race` if the toolchain refuses it).
  - TS: `npx vitest run <file>`.
  - Postgres tests: `STORE_TEST_DIALECT=postgres PG_TEST_URL=… npm run test:unit:pg`.
  - Docker tests (`docker/host/*.test.sh` beyond `fleet-host-entry.test.sh`) run in CI (`test-runner-images.yml`).
  - The UI is checked by eye on the host.
  - Cluster behaviour is checked by Work (spec Appendix B).
- **Run both typecheck configs separately:** `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`.
- Work in a git worktree; never `cd` into the shared `/workspace/claude-fleet` checkout.

---

## Decisions (continuing from D141)

**D142. The drain is triggered by a preStop exec over a local control socket.**
- `lifecycle.preStop.exec: ["/usr/local/bin/broker", "drain"]`. `broker drain` connects to `/run/broker/ctl.sock`, sends `DRAIN`, prints compact state lines, and exits 0 at `done` or when the socket closes. It exits 1 if it can't connect.
- The control socket is mode 0600, uid 1000, opened only when `CLAUDE_FLEET_BROKER_DRAIN=1`; `fleet-host-entry workspace` sets that variable. `CLAUDE_FLEET_BROKER_CTL_SOCKET` overrides the path (tests).
- Why:
  - A Unix socket can't be reached from another pod.
  - kubelet's `httpGet` hook can't use a Unix socket.
  - A loopback HTTP port would be a new listener whose reachability depends on the sidecar's inbound forwarding.
  - A preStop hook has no mesh identity for :7070.
- Sessions (uid 1000) can open the socket. That is no more than their existing ability to `kill` the broker (§9).
- Readiness is `exec: ["/usr/local/bin/broker", "ready"]`: exit 0 only while `serving`.

**D143. SIGTERM also drains when `CLAUDE_FLEET_BROKER_DRAIN=1`.**
- A failed preStop doesn't lose the turns. A SIGTERM during a drain is logged and waits for `done`, and the deadlines don't move.
- SIGINT always closes everything at once (an operator escape).
- After a preStop drain, the broker exits on the following SIGTERM. After a SIGTERM drain, it exits at `done`.
- With the variable unset (desktop containers, `single`), SIGTERM keeps today's `CloseAll`.

**D144. Busy and idle come from claude's status file, read by the broker.**
- The file is `$HOME/.claude/sessions/<root pid>.json`, `status: busy | idle | waiting` (the #286 source). `CLAUDE_FLEET_BROKER_STATUS_DIR` overrides the directory.
- `idle` and `waiting` count as idle. `busy`, a missing or malformed file, or a `pid` mismatch count as busy.
- Not hook-fed:
  - remote sessions' hooks report to `signal_input_wait`, which the host MCP doesn't serve;
  - the hooks miss permission prompts;
  - a feed through fleet-host would make the drain depend on the host pod.
- fleet-host feeds the broker nothing.

**D145. Headless sessions.**
- `CREATE` carries `headless: true` for fleet-host fresh steps. A headless session is busy until it exits; its status file is never consulted.
- At `softAt` its process group gets SIGINT, once. If it then exits non-zero or by a signal, the reason is `drain-interrupted`. If it exits 0, the reason is `exit`: it finished and may have posted.
- At `hardAt` it is SIGKILLed with reason `drain-killed`.
- The SIGINT exit status of the pinned `claude -p` is a cluster check (spec Appendix B).

**D146. The state machine and end reasons.**
- Phases: `serving → draining → done`. The first pass runs 2 s after start (`FirstPass`), then every 1 s (`Poll`).
- Esc goes to busy interactive sessions at `softAt` and every 60 s after (`EscEvery`).
- Closing an idle session sends SIGTERM to its process group, then SIGKILL after 5 s (`TerminateGrace`), and acts once.
- End reasons are `exit`, `drain-idle`, `drain-interrupted` and `drain-killed`. Ended sessions stay listed until the broker exits; user `CLOSE` still removes them.
- `done` comes when no session is alive, or at `hardAt` after `KillAll`.

**D147. The input freeze.**
- While not `serving`:
  - `INPUT` on a PTY channel is dropped, and the broker answers `NOTICE {channel, code: "draining"}` at most every 5 s per channel;
  - `CREATE` answers `draining: the workspace is restarting`.
  - Everything else works.
- The drain's Esc bypasses `INPUT`.
- fleet-host's hub applies the same two refusals as soon as its gate reads `draining`.
- The desktop's `NOTICE` text is fixed client-side: `[host is restarting; your input wasn't sent]`.

**D148. fleet-host learns about the drain over a persistent WATCH, not a poll.**
- `WATCH` makes the broker send `STATE` at once and on every change (session created or ended, phase change), on that connection.
- `DrainGate` keeps one such connection, reconnecting with a 1 s backoff that doubles to 10 s. Its phases:
  - `serving`;
  - `draining` (broker `draining` or `done`);
  - `unknown`: not connected or no `STATE`;
  - `legacy`: connected, but no `STATE` within 5 s.
- Why not a poll: a terminating pod may not accept new connections (endpoint removal), while a connection opened before the drain keeps working.
- The gate remembers each session's end reason across broker instances (the last 1000) for `freshState`.

**D149. Automation dispatch is paused unless the gate is `serving` or `legacy`.**
- The scheduler tick is skipped (slots aren't consumed; one catch-up comes later).
- A due event debounce is re-armed for 30 s.
- A manual, MCP or RPC start throws `<name> can't start now: the workspace is restarting; try again when it's back`.
- A fresh step waits for `serving` before its `CREATE`, for up to 45 min (`STEP_WAIT_MS`), and then fails with `the workspace is still restarting`.
- A fresh step already running keeps running.

**D150. Interrupted runs and the single re-run.**
- `freshState` returns `interrupted` for a session that ended `drain-interrupted` or `drain-killed`, or that vanished with a broker instance whose `STATE` never showed how it ended.
- The runner records the step and the run as `interrupted` with error `<step>: interrupted by host restart`.
- `host_run_retries` (host track v5) holds one row per run. A row is `pending` only when the gate saw an `auto-<runId>-<step>` session end `drain-interrupted` or `drain-killed`, and the run isn't itself a retry (no `trigger.retryOf`, and not anyone's `retry_run_id`).
- Dispatch runs when the gate enters `serving` or `legacy`, and once at holder start:
  - it claims first (`pending → started`);
  - it skips with a note when the original run isn't `interrupted`, its automation is gone or disabled, or the row is older than 24 h;
  - otherwise it starts with the original trigger plus `retryOf` and the original args, bypasses the per-minute cap, and records `retry_run_id`.
- A retry that is itself cut off is not retried again.

**D151. Interactive resume uses the host's drained list and the desktop's open tabs.**
- While draining, fleet-host upserts `host_drained_sessions(instance, broker_session_id, session_id, reason, drained_at)` for each interactive session that is alive or `drain-*`-ended. It maps the broker id to the claude id through the newest `session_owners` row (`latestSessionOf`). Rows older than 24 h are pruned at holder start and hourly.
- `sessions:drained` (`read`) → `{ rows: [{ brokerSessionId, sessionId, drainedAt }] }`, newest per broker id, last 24 h, ≤ 200. Without `db:` it is `{ rows: [] }`; with `db:` and no holder, 503.
- `attachRemotePty`, on `no such session`:
  - looks up the drained list and `CREATE`s with the tab's broker id plus `--resume <sessionId>`;
  - on `session: id already in use` it `ATTACH`es instead (another viewer resumed first);
  - a failed lookup on a `db:` host fails the attach with `The host is starting; reopen this tab in a moment.`, never a fresh claude;
  - a 404 from an older host means no rows.
- The renderer re-attaches the tabs whose session ended while the pane was restarting, when `broker:drain` turns `serving`.

**D152. What a viewer sees.**
- `broker:drain` is sticky in `EventHub`: a new subscriber gets the last value at once.
- The chip reads `restarting · input paused` (or `waiting for the workspace pod`).
- The pane banner shows the soft-deadline time.
- Tabs are read-only, with a `paused` tag, and no new tabs can be opened.
- A tab that ends during the drain shows a "waiting for the host to restart" card, and then resumes.

**D153. Timings are operator settings in the workspace pod's env.**
- `CLAUDE_FLEET_BROKER_DRAIN_SOFT` (default `30m`) and `CLAUDE_FLEET_BROKER_DRAIN_HARD` (default `35m`) are Go durations, with 1 s ≤ soft < hard ≤ 24 h. A bad value makes the broker exit 1 naming the variable.
- `CLAUDE_FLEET_BROKER_DRAIN` accepts `''`, `0` or `1` only (as D95).
- These are operator settings in the pod spec beside `terminationGracePeriodSeconds`. The owner's "no hand-editing env/JSON" rule applies to user-facing settings.

**D154. Host pod shutdown.**
- `shutdown()` first sets `draining`, so `/healthz` answers 503 `{status: "draining", …}`.
- `SHUTDOWN_DEADLINE_MS` = 20 s: on expiry fleet-host logs `shutdown deadline passed; exiting` and exits with its code, once.
- `preStop: sleep 5` and `terminationGracePeriodSeconds: 45` complete it.

**D155. Istio, on both pods.**
- Native sidecars (Kubernetes ≥ 1.29: istiod `ENABLE_NATIVE_SIDECARS=true`, or the pod annotation `sidecar.istio.io/nativeSidecar: "true"` where supported) stop the proxy after the app.
- Fallback: `proxy.istio.io/config` with `terminationDrainDuration` (host 40 s, workspace 2390 s) and `EXIT_ON_ZERO_ACTIVE_CONNECTIONS: "true"`.
- The workspace Service sets `publishNotReadyAddresses: true`, so the draining pod stays dialable. That Istio routes to it is a cluster check.

**D156. The host pod restarting during a drain.**
- The new holder's `recover()` marks in-flight runs `the app quit mid-run`.
- If its gate later sees that run's session end `drain-interrupted` or `drain-killed`, the run's error is rewritten to `interrupted by host restart` (`AutomationStore.noteInterrupted`) and a re-run is queued.
- A session that exits 0 posts as today and isn't re-run.
- If fleet-host never learns how a session ended, its run isn't re-run, because it may have posted.
- Drained-session rows already written persist in Postgres.

**D157. No drain in `single`, desktop containers or local workspaces.**
- Their broker has no control socket, and SIGTERM behaves as today.
- `STATUS` and `WATCH` answer there too (`phase: serving`); the desktop doesn't use them.
- Without `db:` the host keeps the drain stores in memory.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `broker/internal/proto/proto.go` | modify | `STATUS`/`STATE`/`WATCH`/`DRAIN`/`NOTICE` frames; `CreateRequest.Headless`; `SessionInfo.Ended`; `StateNotice`, `Notice` |
| `broker/internal/notify/notify.go` | create | change bus (wakes WATCH connections and the drain CLI stream) |
| `broker/internal/session/session.go`, `manager.go` | modify | headless flag, end reasons, `Terminate`/`Interrupt`/`KillWith`, `Snapshot`, `KillAll`, `OnChange` |
| `broker/internal/activity/activity.go` | create | claude status-file reader |
| `broker/internal/drain/drain.go` | create | the drain state machine |
| `broker/internal/server/server.go` | modify | input freeze, CREATE refusal, `STATUS`/`WATCH`, `ENDED` reason, `LIST.ended` |
| `broker/internal/server/control.go` | create | control-socket server (`DRAIN`, `STATUS`) |
| `broker/cmd/broker/cli.go`, `settings.go`, `main.go` | create/modify | `broker drain`/`broker ready`, env parsing, SIGTERM drain, wiring |
| `docker/host/fleet-host-entry` (+ tests), `split.test.sh`, `smoke.test.sh` | modify | `workspace` exports `CLAUDE_FLEET_BROKER_DRAIN=1`; CI drain checks |
| `src/main/broker.ts` | modify | TS codec: new frames, `status()`, `watch()`, `notice`/`state` events, `parseBrokerState`, `createSession(…, {headless})` |
| `src/host/brokerOps.ts`, `testFakes.ts` | modify | `create(…, opts)`, `watch()`, `onNotice` |
| `src/host/events.ts` | modify | `broker:drain` channel, `publishSticky` |
| `src/host/drainGate.ts` | create | the WATCH reducer, phases, sticky event, `waitServing`, ended memory |
| `src/host/attachHub.ts` | modify | hub-side refusals and NOTICE fan-out |
| `src/host/hostSchema.ts` | modify | host track v5 (`host_run_retries`, `host_drained_sessions`) |
| `src/host/drainStore.ts` | create | pg + memory stores for retries and drained sessions |
| `src/host/sessionOwners.ts` | modify | `latestSessionOf` |
| `src/main/automations/automationService.ts`, `runner.ts`, `automationStore.ts`, `src/preload/inboxTypes.ts` | modify | `paused()`, `retryOf`, `interrupted` fresh state, `noteInterrupted`, `APP_QUIT_MID_RUN` |
| `src/host/hostAutomations.ts` | modify | gate-aware `paused`/`spawnFresh`/`freshState`, headless CREATE, expose `store` |
| `src/host/hostDrain.ts` | create | the holder's drain hooks: cut runs, drained rows, re-run dispatch, prune |
| `src/host/drainRpc.ts` | create | `sessions:drained` |
| `src/host/holder.ts`, `main.ts`, `server.ts` | modify | wiring, `/healthz` draining, 20 s deadline |
| `src/main/remoteDrain.ts` | create | `broker:drain` validation and the per-host relay |
| `src/main/federation/summaryRelay.ts`, `ipc.ts`, `remoteIpc.ts`, `remote.ts`, `remoteAttach.ts` | modify | relay, IPC push and query, drained-list resume, NOTICE line |
| `src/preload/index.ts`, `src/preload/remoteTypes.ts` | modify | `remote.onDrain`, `remote.drainStates`, `RemoteDrain` |
| `src/renderer/src/remoteView.ts`, `components/WorkspaceTabStrip.tsx`, `TerminalPane.tsx`, `TerminalSession.tsx`, `App.tsx`, `styles.css` | modify | chip, rules, banner, restarting card, auto-resume |
| `docs/SPEC.md` | modify | §4, §7, §8, §9, §11 |

Task order: 1–6 broker; 7 entry script; 8 TS codec; 9–14 fleet-host; 15–16 desktop; 17 SPEC and the full gate. Tasks 1–6 are independent of 8–16 except for the wire shapes in Task 1, which Task 8 mirrors.

---

### Task 1: Wire protocol: drain frames and shapes (Go)

**Files:**
- Modify: `broker/internal/proto/proto.go`
- Test: `broker/internal/proto/proto_test.go`

**Interfaces:**
- Produces:
  - `FrameStatus 0x1a`, `FrameState 0x1b`, `FrameWatch 0x1c`, `FrameDrain 0x1d`, `FrameNotice 0x1e`
  - `CreateRequest.Headless bool` (`headless,omitempty`)
  - `SessionInfo.Ended string` (`ended,omitempty`)
  - `StateNotice{Instance, Phase, StartedAt, SoftAt, HardAt int64 (epoch ms, omitempty), Sessions []StateSession}`
  - `StateSession{ID, Alive, Headless, Ended}`
  - `Notice{Channel uint32, Code string}`, `NoticeDraining = "draining"`

**Verifiable:** locally, `cd broker && go test -race ./internal/proto/`.

- [ ] **Step 1: Write the failing test.** Append to `broker/internal/proto/proto_test.go`:

```go
func TestDrainFrameTypesAndShapes(t *testing.T) {
	for ft, name := range map[FrameType]string{
		FrameStatus: "STATUS", FrameState: "STATE", FrameWatch: "WATCH", FrameDrain: "DRAIN", FrameNotice: "NOTICE",
	} {
		if ft.String() != name {
			t.Errorf("%#x: got %q, want %q", uint8(ft), ft.String(), name)
		}
	}
	b, _ := json.Marshal(CreateRequest{ID: "a", Cols: 1, Rows: 1})
	if strings.Contains(string(b), "headless") {
		t.Errorf("headless must be omitted when false: %s", b)
	}
	b, _ = json.Marshal(CreateRequest{ID: "a", Cols: 1, Rows: 1, Headless: true})
	if !strings.Contains(string(b), `"headless":true`) {
		t.Errorf("headless missing: %s", b)
	}
	b, _ = json.Marshal(SessionInfo{ID: "s", Alive: true})
	if string(b) != `{"id":"s","alive":true}` {
		t.Errorf("SessionInfo wire shape changed: %s", b)
	}
	b, _ = json.Marshal(StateNotice{Instance: "i", Phase: "serving", Sessions: []StateSession{{ID: "s", Alive: false, Ended: "drain-idle"}}})
	if string(b) != `{"instance":"i","phase":"serving","sessions":[{"id":"s","alive":false,"ended":"drain-idle"}]}` {
		t.Errorf("StateNotice: %s", b)
	}
	b, _ = json.Marshal(Notice{Channel: 3, Code: NoticeDraining})
	if string(b) != `{"channel":3,"code":"draining"}` {
		t.Errorf("Notice: %s", b)
	}
}
```

Add `"encoding/json"` and `"strings"` to the test's imports if they're missing.

- [ ] **Step 2: Run it and watch it fail.** `cd broker && go test ./internal/proto/` → compile errors (`undefined: FrameStatus`).

- [ ] **Step 3: Implement.** In `proto.go`:

Extend the catalog comment under `Port forward (JSON):` with:

```go
//	Drain (JSON):
//	  STATUS     C→S  {}                                       one STATE reply
//	  STATE      S→C  {"instance":"…","phase":"serving|draining|done","startedAt"?,"softAt"?,"hardAt"?,"sessions":[{id,alive,headless?,ended?}]}
//	  WATCH      C→S  {}                                       STATE now and on every change, on this connection
//	  DRAIN      C→S  {}                                       control socket only: start the drain, stream STATE until done
//	  NOTICE     S→C  {"channel":N,"code":"draining"}          INPUT on N was dropped
```

Add the constants after `FrameKilled`:

```go
	FrameStatus    FrameType = 0x1a
	FrameState     FrameType = 0x1b
	FrameWatch     FrameType = 0x1c
	FrameDrain     FrameType = 0x1d
	FrameNotice    FrameType = 0x1e
```

Add these cases to `String()`:

```go
	case FrameStatus:
		return "STATUS"
	case FrameState:
		return "STATE"
	case FrameWatch:
		return "WATCH"
	case FrameDrain:
		return "DRAIN"
	case FrameNotice:
		return "NOTICE"
```

Add `Headless` to `CreateRequest` and `Ended` to `SessionInfo`:

```go
	// Headless marks an unattended `claude -p` session: a drain treats it as busy until it exits.
	Headless bool `json:"headless,omitempty"`
```

```go
type SessionInfo struct {
	ID    string `json:"id"`
	Alive bool   `json:"alive"`
	Ended string `json:"ended,omitempty"`
}
```

Add the new shapes after `KilledResponse`:

```go
// ── Drain shapes ─────────────────────────────────────────────────────────

const NoticeDraining = "draining"

type StateSession struct {
	ID       string `json:"id"`
	Alive    bool   `json:"alive"`
	Headless bool   `json:"headless,omitempty"`
	Ended    string `json:"ended,omitempty"`
}

// StateNotice times are epoch milliseconds, present once a drain has started.
type StateNotice struct {
	Instance  string         `json:"instance"`
	Phase     string         `json:"phase"`
	StartedAt int64          `json:"startedAt,omitempty"`
	SoftAt    int64          `json:"softAt,omitempty"`
	HardAt    int64          `json:"hardAt,omitempty"`
	Sessions  []StateSession `json:"sessions"`
}

type Notice struct {
	Channel uint32 `json:"channel"`
	Code    string `json:"code"`
}
```

- [ ] **Step 4: Run it and watch it pass.** `cd broker && go test -race ./internal/proto/` → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(broker): drain wire frames and shapes"` (with the attribution trailer).

---

### Task 2: Change bus, end reasons and session drain actions (Go)

**Files:**
- Create: `broker/internal/notify/notify.go`, `broker/internal/notify/notify_test.go`
- Modify: `broker/internal/session/session.go`, `broker/internal/session/manager.go`
- Test: `broker/internal/session/drain_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `notify.Bus{}`: `Subscribe() (<-chan struct{}, func())` and `Notify()`.
  - `session.ReasonExit`, `ReasonIdle`, `ReasonInterrupted`, `ReasonKilled` (`"exit"`, `"drain-idle"`, `"drain-interrupted"`, `"drain-killed"`); `session.TerminateGrace = 5 * time.Second`.
  - `ManagerConfig.OnChange func()`.
  - Manager methods: `CreateWith(id, cols, rows, args, headless) (*Session, error)`, `Snapshot() []Snap`, `Terminate(id, reason)`, `Interrupt(id)`, `KillAll(reason)`.
  - `Snap{ID, Alive, Headless, Pid, Ended}`; `SessionInfo.Ended`.
  - Session methods: `Headless()`, `EndReason()`, `Terminate(reason, grace)`, `Interrupt()`, `KillWith(reason)`.

**Verifiable:** locally, `cd broker && go test -race ./internal/notify/ ./internal/session/` (real processes: `/bin/sh`, `/bin/cat`).

- [ ] **Step 1: Write the failing tests.**

`broker/internal/notify/notify_test.go`:

```go
package notify

import "testing"

func TestNotifyWakesEverySubscriberWithoutBlocking(t *testing.T) {
	var b Bus
	a, cancelA := b.Subscribe()
	c, cancelC := b.Subscribe()
	defer cancelC()
	b.Notify()
	b.Notify() // coalesces: the buffer holds one wake-up
	for _, ch := range []<-chan struct{}{a, c} {
		select {
		case <-ch:
		default:
			t.Fatal("subscriber not woken")
		}
		select {
		case <-ch:
			t.Fatal("two wake-ups were not coalesced")
		default:
		}
	}
	cancelA()
	b.Notify()
	select {
	case <-a:
		t.Fatal("cancelled subscriber woken")
	default:
	}
}
```

`broker/internal/session/drain_test.go`:

```go
package session

import (
	"bytes"
	"testing"
	"time"
)

func shManager(onChange func()) *Manager {
	return NewManager(ManagerConfig{ClaudeExec: "/bin/sh", RingBufBytes: 4096, OnChange: onChange})
}

func ended(t *testing.T, s *Session) string {
	t.Helper()
	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end")
	}
	return s.EndReason()
}

func TestNaturalExitIsExit(t *testing.T) {
	m := shManager(nil)
	s, err := m.CreateWith("a", 80, 24, []string{"-c", "exit 0"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := ended(t, s); got != ReasonExit {
		t.Fatalf("reason %q", got)
	}
}

func TestHeadlessInterruptNonZeroIsInterrupted(t *testing.T) {
	m := shManager(nil)
	s, _ := m.CreateWith("h", 80, 24, []string{"-c", "trap 'exit 3' INT; while :; do sleep 0.05; done"}, true)
	time.Sleep(100 * time.Millisecond)
	m.Interrupt("h")
	if got := ended(t, s); got != ReasonInterrupted {
		t.Fatalf("reason %q", got)
	}
	if !s.Headless() {
		t.Fatal("headless flag lost")
	}
}

func TestHeadlessInterruptExitZeroCountsAsFinished(t *testing.T) {
	m := shManager(nil)
	s, _ := m.CreateWith("h", 80, 24, []string{"-c", "trap 'exit 0' INT; while :; do sleep 0.05; done"}, true)
	time.Sleep(100 * time.Millisecond)
	m.Interrupt("h")
	if got := ended(t, s); got != ReasonExit {
		t.Fatalf("reason %q", got)
	}
}

func TestInteractiveInterruptSendsEsc(t *testing.T) {
	m := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 4096})
	s, _ := m.CreateWith("i", 80, 24, nil, false)
	defer m.CloseAll()
	m.Interrupt("i")
	ok := waitUntil(func() bool {
		out := s.ring.ReplaySnapshot()
		return bytes.Contains(out, []byte{0x1b}) || bytes.Contains(out, []byte("^["))
	})
	if !ok {
		t.Fatal("no Esc echoed")
	}
	if !s.Alive() {
		t.Fatal("Esc must not end an interactive session")
	}
}

func TestTerminateIdleThenEscalates(t *testing.T) {
	m := shManager(nil)
	s, _ := m.CreateWith("t", 80, 24, []string{"-c", "trap '' TERM; while :; do sleep 0.05; done"}, false)
	time.Sleep(100 * time.Millisecond)
	s.Terminate(ReasonIdle, 150*time.Millisecond)
	s.Terminate(ReasonInterrupted, time.Hour) // second call is a no-op
	if got := ended(t, s); got != ReasonIdle {
		t.Fatalf("reason %q", got)
	}
}

func TestKillAllKeepsSessionsListedWithReason(t *testing.T) {
	m := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	a, _ := m.CreateWith("a", 80, 24, nil, false)
	b, _ := m.CreateWith("b", 80, 24, nil, true)
	m.KillAll(ReasonKilled)
	ended(t, a)
	ended(t, b)
	snap := m.Snapshot()
	if len(snap) != 2 || snap[0].ID != "a" || snap[1].ID != "b" {
		t.Fatalf("snapshot %+v", snap)
	}
	for _, x := range snap {
		if x.Alive || x.Ended != ReasonKilled {
			t.Fatalf("%+v", x)
		}
	}
	if !snap[1].Headless {
		t.Fatal("headless not in snapshot")
	}
	for _, info := range m.List() {
		if info.Ended != ReasonKilled {
			t.Fatalf("list %+v", info)
		}
	}
}

func TestOnChangeOnCreateAndExit(t *testing.T) {
	n := make(chan struct{}, 8)
	m := shManager(func() { n <- struct{}{} })
	s, _ := m.CreateWith("c", 80, 24, []string{"-c", "exit 0"}, false)
	ended(t, s)
	got := 0
	for done := false; !done; {
		select {
		case <-n:
			got++
		case <-time.After(200 * time.Millisecond):
			done = true
		}
	}
	if got < 2 {
		t.Fatalf("OnChange fired %d times, want create + exit", got)
	}
}
```

- [ ] **Step 2: Run them and watch them fail.** `cd broker && go test ./internal/notify/ ./internal/session/` → compile errors.

- [ ] **Step 3: Implement the bus.** `broker/internal/notify/notify.go`:

```go
// Package notify wakes WATCH connections when sessions or the drain phase change.
package notify

import "sync"

type Bus struct {
	mu   sync.Mutex
	subs map[chan struct{}]struct{}
}

// Subscribe returns a wake-up channel (buffer 1, so bursts coalesce) and its cancel.
func (b *Bus) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = map[chan struct{}]struct{}{}
	}
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}
}

func (b *Bus) Notify() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
```

- [ ] **Step 4: Implement the session changes.** In `session.go`:

Add `"time"` to the imports, then add the reasons:

```go
const (
	ReasonExit        = "exit"
	ReasonIdle        = "drain-idle"
	ReasonInterrupted = "drain-interrupted"
	ReasonKilled      = "drain-killed"
)

// TerminateGrace is how long a drain-closed session gets between SIGTERM and SIGKILL.
const TerminateGrace = 5 * time.Second
```

Add these fields to `Session` (under `done chan struct{}`):

```go
	headless    bool
	mark        string // end reason a drain action chose; applied at exit
	terminating bool
	endReason   string
	onEnd       func()
```

Change the `newSession` signature to take `headless bool` last, and set `headless: headless` in the struct literal.

Replace `wait()`:

```go
// wait blocks until claude exits, then marks the session dead. Called
// by the manager in a goroutine right after newSession returns.
func (s *Session) wait() {
	err := s.cmd.Wait()
	s.mu.Lock()
	s.dead = true
	s.exitErr = err
	s.endReason = endReason(s.mark, s.headless, err)
	close(s.done)
	onEnd := s.onEnd
	s.mu.Unlock()
	if onEnd != nil {
		onEnd()
	}
}

// A headless claude that exits 0 after SIGINT finished its work (it may have posted).
func endReason(mark string, headless bool, err error) string {
	switch {
	case mark == "":
		return ReasonExit
	case mark == ReasonInterrupted && headless && err == nil:
		return ReasonExit
	default:
		return mark
	}
}
```

Add the new methods after `Pid()`:

```go
func (s *Session) Headless() bool { return s.headless }

// EndReason is "" while the session is alive.
func (s *Session) EndReason() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.endReason
}

// Terminate sends SIGTERM to the process group and SIGKILL after grace. Only the first call acts.
func (s *Session) Terminate(reason string, grace time.Duration) {
	s.mu.Lock()
	if s.dead || s.terminating {
		s.mu.Unlock()
		return
	}
	s.terminating = true
	if s.mark != ReasonKilled {
		s.mark = reason
	}
	s.mu.Unlock()
	s.signalGroup(syscall.SIGTERM)
	go func() {
		select {
		case <-s.done:
		case <-time.After(grace):
			s.kill()
		}
	}()
}

// Interrupt stops a busy turn: Esc to an interactive claude, SIGINT to a headless one's group.
func (s *Session) Interrupt() {
	if !s.headless {
		_, _ = s.ptmx.Write([]byte{0x1b})
		return
	}
	s.mu.Lock()
	if s.mark == "" {
		s.mark = ReasonInterrupted
	}
	s.mu.Unlock()
	s.signalGroup(syscall.SIGINT)
}

func (s *Session) KillWith(reason string) {
	s.mu.Lock()
	s.mark = reason
	s.mu.Unlock()
	s.kill()
}

// Setsid made the root pid the group leader.
func (s *Session) signalGroup(sig syscall.Signal) {
	if pid := s.Pid(); pid > 0 {
		_ = syscall.Kill(-pid, sig)
	}
}
```

- [ ] **Step 5: Implement the manager changes.** In `manager.go`:

Add `"sort"` to the imports, and `OnChange` to the config:

```go
type ManagerConfig struct {
	ClaudeExec   string // executable to run for each session ("claude")
	RingBufBytes int    // per-session ring buffer size
	// OnChange runs after a session is created, ends or is closed.
	OnChange func()
}
```

Replace `Create` with:

```go
// Create spawns an interactive claude PTY under id; see CreateWith.
func (m *Manager) Create(id string, cols, rows uint16, args []string) (*Session, error) {
	return m.CreateWith(id, cols, rows, args, false)
}

// CreateWith spawns a claude PTY under id. ErrIDInUse if the id already
// has a session. The session lives until Close(id) or natural exit.
// args, when non-empty, are appended to the claude exec.
func (m *Manager) CreateWith(id string, cols, rows uint16, args []string, headless bool) (*Session, error) {
	m.mu.Lock()
	if _, ok := m.sessions[id]; ok {
		m.mu.Unlock()
		return nil, ErrIDInUse
	}
	s, err := newSession(id, m.cfg.ClaudeExec, args, cols, rows, m.cfg.RingBufBytes, headless)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	s.onEnd = m.changed
	m.sessions[id] = s
	m.mu.Unlock()
	// Dead sessions stay in the map (LIST shows them, ATTACH answers "ended"); Close removes.
	go s.wait()
	m.changed()
	return s, nil
}

func (m *Manager) changed() {
	if m.cfg.OnChange != nil {
		m.cfg.OnChange()
	}
}
```

At the end of `Close`, after `s.kill()`, call `m.changed()` (outside the `if`).

Add `Ended` to `List`'s rows (`out = append(out, SessionInfo{ID: id, Alive: s.Alive(), Ended: s.EndReason()})`) and to the struct:

```go
type SessionInfo struct {
	ID    string
	Alive bool
	Ended string
}
```

Add:

```go
type Snap struct {
	ID       string
	Alive    bool
	Headless bool
	Pid      int
	Ended    string
}

// Snapshot lists every session, dead ones included, sorted by id.
func (m *Manager) Snapshot() []Snap {
	m.mu.Lock()
	out := make([]Snap, 0, len(m.sessions))
	for id, s := range m.sessions {
		out = append(out, Snap{ID: id, Alive: s.Alive(), Headless: s.headless, Pid: s.Pid(), Ended: s.EndReason()})
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (m *Manager) Terminate(id, reason string) {
	if s := m.Get(id); s != nil {
		s.Terminate(reason, TerminateGrace)
	}
}

func (m *Manager) Interrupt(id string) {
	if s := m.Get(id); s != nil {
		s.Interrupt()
	}
}

// KillAll kills every live session with reason and keeps them listed (CloseAll drops them).
func (m *Manager) KillAll(reason string) {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	for _, s := range list {
		if s.Alive() {
			s.KillWith(reason)
		}
	}
}
```

- [ ] **Step 6: Run the tests and watch them pass.** `cd broker && go test -race ./internal/notify/ ./internal/session/` → PASS. The existing session tests must still pass; `newSession`'s only caller is `CreateWith`.

- [ ] **Step 7: Commit.** `feat(broker): end reasons, headless sessions and drain actions`.

---

### Task 3: Activity reader (claude's status file) (Go)

**Files:**
- Create: `broker/internal/activity/activity.go`, `broker/internal/activity/activity_test.go`

**Interfaces:**
- Produces:
  - `activity.Kind` (`Busy`, `Idle`, `Waiting`);
  - `activity.Reader{Dir string}` with `Of(pid int) Kind`;
  - `activity.DefaultDir(getenv func(string) string) string`.

**Verifiable:** locally, `cd broker && go test -race ./internal/activity/`.

- [ ] **Step 1: Write the failing test.**

```go
package activity

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOf(t *testing.T) {
	dir := t.TempDir()
	r := Reader{Dir: dir}
	write(t, dir, "10.json", `{"pid":10,"sessionId":"x","status":"idle"}`)
	write(t, dir, "11.json", `{"pid":11,"sessionId":"x","status":"waiting","waitingFor":"input needed"}`)
	write(t, dir, "12.json", `{"pid":12,"sessionId":"x","status":"busy"}`)
	write(t, dir, "13.json", `{"pid":99,"sessionId":"x","status":"idle"}`)
	write(t, dir, "14.json", `{"pid":14,"status":`)
	write(t, dir, "15.json", `{"sessionId":"x","status":"idle"}`)
	cases := map[int]Kind{10: Idle, 11: Waiting, 12: Busy, 13: Busy, 14: Busy, 15: Idle, 16: Busy, 0: Busy, -1: Busy}
	for pid, want := range cases {
		if got := r.Of(pid); got != want {
			t.Errorf("pid %d: got %v, want %v", pid, got, want)
		}
	}
	if (Reader{}).Of(10) != Busy {
		t.Error("no dir must read busy")
	}
}

func TestDefaultDir(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if got := DefaultDir(env(map[string]string{"HOME": "/home/fleet"})); got != "/home/fleet/.claude/sessions" {
		t.Errorf("got %q", got)
	}
	if got := DefaultDir(env(map[string]string{"HOME": "/h", "CLAUDE_FLEET_BROKER_STATUS_DIR": "/x"})); got != "/x" {
		t.Errorf("got %q", got)
	}
	if got := DefaultDir(env(nil)); got != "" {
		t.Errorf("got %q", got)
	}
}
```

- [ ] **Step 2: Run it and watch it fail.** It doesn't compile yet.

- [ ] **Step 3: Implement.** `broker/internal/activity/activity.go`:

```go
// Package activity reads claude's own per-process status file
// (~/.claude/sessions/<pid>.json, status busy|idle|waiting; SPEC §5).
// Anything unreadable counts as busy, so a drain waits instead of cutting a turn.
package activity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

type Kind int

const (
	Busy Kind = iota
	Idle
	Waiting
)

func (k Kind) String() string {
	switch k {
	case Idle:
		return "idle"
	case Waiting:
		return "waiting"
	}
	return "busy"
}

const maxFileBytes = 64 << 10

type Reader struct{ Dir string }

func (r Reader) Of(pid int) Kind {
	if pid <= 0 || r.Dir == "" {
		return Busy
	}
	b, err := os.ReadFile(filepath.Join(r.Dir, strconv.Itoa(pid)+".json"))
	if err != nil || len(b) > maxFileBytes {
		return Busy
	}
	var f struct {
		Pid    *int   `json:"pid"`
		Status string `json:"status"`
	}
	if json.Unmarshal(b, &f) != nil || (f.Pid != nil && *f.Pid != pid) {
		return Busy
	}
	switch f.Status {
	case "idle":
		return Idle
	case "waiting":
		return Waiting
	}
	return Busy
}

func DefaultDir(getenv func(string) string) string {
	if d := getenv("CLAUDE_FLEET_BROKER_STATUS_DIR"); d != "" {
		return d
	}
	if h := getenv("HOME"); h != "" {
		return filepath.Join(h, ".claude", "sessions")
	}
	return ""
}
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Commit.** `feat(broker): read claude's status file for drain idleness`.

---

### Task 4: The drain state machine (Go)

**Files:**
- Create: `broker/internal/drain/drain.go`, `broker/internal/drain/drain_test.go`

**Interfaces:**
- Consumes: `session.Snap`, the `session.Reason*` constants, `activity.Kind`, `notify.Bus`.
- Produces:
  - `drain.PhaseServing`, `PhaseDraining`, `PhaseDone`.
  - `drain.Config{Soft, Hard, FirstPass, Poll, EscEvery}` and `drain.DefaultConfig()`.
  - `drain.Target` interface: `Snapshot`, `Terminate`, `Interrupt`, `KillAll` (`*session.Manager` satisfies it).
  - `drain.State{Instance, Phase, StartedAt, SoftAt, HardAt, Sessions}`.
  - `drain.New(cfg, target, act func(int) activity.Kind, now func() time.Time, instance string, bus *notify.Bus) *Drainer`.
  - `Drainer` methods: `Start() bool`, `Step()`, `Run(ctx)`, `Phase()`, `State()`, `Done()`.

**Verifiable:** locally, `cd broker && go test -race ./internal/drain/`, with a fake clock, fake sessions and a fake activity reader.

- [ ] **Step 1: Write the failing tests.** `broker/internal/drain/drain_test.go`:

```go
package drain

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/notify"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

type fakeTarget struct {
	mu         sync.Mutex
	sessions   map[string]*session.Snap
	terminated map[string]string
	interrupts map[string]int
	killedAll  string
}

func newTarget(snaps ...session.Snap) *fakeTarget {
	f := &fakeTarget{sessions: map[string]*session.Snap{}, terminated: map[string]string{}, interrupts: map[string]int{}}
	for i := range snaps {
		s := snaps[i]
		f.sessions[s.ID] = &s
	}
	return f
}

func (f *fakeTarget) Snapshot() []session.Snap {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]session.Snap, 0, len(f.sessions))
	for _, s := range f.sessions {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (f *fakeTarget) Terminate(id, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.terminated[id] = reason
	f.sessions[id].Alive = false
	f.sessions[id].Ended = reason
}

func (f *fakeTarget) Interrupt(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.interrupts[id]++
}

func (f *fakeTarget) KillAll(reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.killedAll = reason
	for _, s := range f.sessions {
		if s.Alive {
			s.Alive, s.Ended = false, reason
		}
	}
}

func (f *fakeTarget) exit(id, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[id].Alive = false
	f.sessions[id].Ended = reason
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

type acts map[int]activity.Kind

func (a acts) of(pid int) activity.Kind { return a[pid] }

var cfg = Config{Soft: 30 * time.Minute, Hard: 35 * time.Minute, FirstPass: 2 * time.Second, Poll: time.Second, EscEvery: time.Minute}

func rig(a acts, snaps ...session.Snap) (*Drainer, *fakeTarget, *clock) {
	t := newTarget(snaps...)
	c := &clock{t: time.Unix(1_000_000, 0)}
	return New(cfg, t, a.of, c.now, "inst", &notify.Bus{}), t, c
}

func TestStartIsIdempotentAndStateCarriesDeadlines(t *testing.T) {
	d, _, c := rig(acts{})
	if d.Phase() != PhaseServing {
		t.Fatal("not serving")
	}
	if !d.Start() || d.Start() {
		t.Fatal("Start must succeed exactly once")
	}
	st := d.State()
	if st.Phase != PhaseDraining || st.Instance != "inst" || !st.StartedAt.Equal(c.t) ||
		!st.SoftAt.Equal(c.t.Add(30*time.Minute)) || !st.HardAt.Equal(c.t.Add(35*time.Minute)) {
		t.Fatalf("%+v", st)
	}
}

func TestStepBeforeStartDoesNothing(t *testing.T) {
	d, tg, _ := rig(acts{1: activity.Idle}, session.Snap{ID: "a", Alive: true, Pid: 1})
	d.Step()
	if len(tg.terminated) != 0 {
		t.Fatal("closed a session while serving")
	}
}

func TestIdleAndWaitingCloseAtOnceBusyWaits(t *testing.T) {
	d, tg, _ := rig(acts{1: activity.Idle, 2: activity.Waiting, 3: activity.Busy},
		session.Snap{ID: "idle", Alive: true, Pid: 1},
		session.Snap{ID: "wait", Alive: true, Pid: 2},
		session.Snap{ID: "busy", Alive: true, Pid: 3},
		session.Snap{ID: "gone", Alive: false, Pid: 4, Ended: session.ReasonExit})
	d.Start()
	d.Step()
	if tg.terminated["idle"] != session.ReasonIdle || tg.terminated["wait"] != session.ReasonIdle {
		t.Fatalf("terminated %v", tg.terminated)
	}
	if _, ok := tg.terminated["busy"]; ok || len(tg.interrupts) != 0 {
		t.Fatal("busy session touched before the soft deadline")
	}
	if d.Phase() != PhaseDraining {
		t.Fatal("finished with a busy session alive")
	}
}

func TestEscAtSoftThenEveryMinuteThenClosedAsInterrupted(t *testing.T) {
	a := acts{3: activity.Busy}
	d, tg, c := rig(a, session.Snap{ID: "busy", Alive: true, Pid: 3})
	d.Start()
	c.advance(29 * time.Minute)
	d.Step()
	if tg.interrupts["busy"] != 0 {
		t.Fatal("Esc before soft")
	}
	c.advance(time.Minute)
	d.Step()
	c.advance(30 * time.Second)
	d.Step()
	if tg.interrupts["busy"] != 1 {
		t.Fatalf("interrupts %d, want 1", tg.interrupts["busy"])
	}
	c.advance(30 * time.Second)
	d.Step()
	if tg.interrupts["busy"] != 2 {
		t.Fatalf("interrupts %d, want 2 after a minute", tg.interrupts["busy"])
	}
	a[3] = activity.Idle
	d.Step()
	if tg.terminated["busy"] != session.ReasonInterrupted {
		t.Fatalf("reason %q", tg.terminated["busy"])
	}
	d.Step()
	if d.Phase() != PhaseDone {
		t.Fatal("not done once every session ended")
	}
}

func TestHeadlessIsBusyUntilExitAndGetsOneInterrupt(t *testing.T) {
	d, tg, c := rig(acts{5: activity.Idle}, session.Snap{ID: "auto-R-s", Alive: true, Pid: 5, Headless: true})
	d.Start()
	d.Step()
	if len(tg.terminated) != 0 {
		t.Fatal("headless closed although its status file says idle")
	}
	c.advance(30 * time.Minute)
	d.Step()
	c.advance(2 * time.Minute)
	d.Step()
	if tg.interrupts["auto-R-s"] != 1 {
		t.Fatalf("interrupts %d, want exactly 1", tg.interrupts["auto-R-s"])
	}
	tg.exit("auto-R-s", session.ReasonInterrupted)
	d.Step()
	if d.Phase() != PhaseDone {
		t.Fatal("not done")
	}
}

func TestHardStopKillsEverythingAndFinishes(t *testing.T) {
	d, tg, c := rig(acts{3: activity.Busy}, session.Snap{ID: "busy", Alive: true, Pid: 3})
	d.Start()
	c.advance(35 * time.Minute)
	d.Step()
	if tg.killedAll != session.ReasonKilled || d.Phase() != PhaseDone {
		t.Fatalf("killedAll %q phase %s", tg.killedAll, d.Phase())
	}
	select {
	case <-d.Done():
	default:
		t.Fatal("Done not closed")
	}
}

func TestNoSessionsFinishesOnFirstPass(t *testing.T) {
	d, _, _ := rig(acts{})
	d.Start()
	d.Step()
	if d.Phase() != PhaseDone {
		t.Fatal("not done")
	}
	if d.Start() {
		t.Fatal("restarted a finished drain")
	}
}

func TestRunDrivesPassesAfterStart(t *testing.T) {
	tg := newTarget(session.Snap{ID: "idle", Alive: true, Pid: 1})
	fast := Config{Soft: time.Minute, Hard: 2 * time.Minute, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute}
	d := New(fast, tg, acts{1: activity.Idle}.of, time.Now, "i", &notify.Bus{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)
	time.Sleep(30 * time.Millisecond)
	if len(tg.terminated) != 0 {
		t.Fatal("Run acted before Start")
	}
	d.Start()
	select {
	case <-d.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("drain never finished")
	}
}
```

- [ ] **Step 2: Run them and watch them fail.** They don't compile yet.

- [ ] **Step 3: Implement.** `broker/internal/drain/drain.go`:

```go
// Package drain runs the broker's graceful drain (SPEC §7 *Workspace pod drain*):
// serving → draining → done. Idle and waiting sessions close at once, busy
// turns finish until Soft (then Esc / SIGINT), and everything dies at Hard.
package drain

import (
	"context"
	"sync"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/notify"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

const (
	PhaseServing  = "serving"
	PhaseDraining = "draining"
	PhaseDone     = "done"
)

type Config struct {
	Soft, Hard time.Duration
	// FirstPass lets fleet-host and desktops hear "draining" before anything closes.
	FirstPass time.Duration
	Poll      time.Duration
	EscEvery  time.Duration
}

func DefaultConfig() Config {
	return Config{Soft: 30 * time.Minute, Hard: 35 * time.Minute, FirstPass: 2 * time.Second, Poll: time.Second, EscEvery: time.Minute}
}

type Target interface {
	Snapshot() []session.Snap
	Terminate(id, reason string)
	Interrupt(id string)
	KillAll(reason string)
}

type State struct {
	Instance  string
	Phase     string
	StartedAt time.Time
	SoftAt    time.Time
	HardAt    time.Time
	Sessions  []session.Snap
}

type Drainer struct {
	cfg      Config
	target   Target
	activity func(pid int) activity.Kind
	now      func() time.Time
	instance string
	bus      *notify.Bus

	mu          sync.Mutex
	phase       string
	startedAt   time.Time
	lastEsc     map[string]time.Time
	interrupted map[string]bool
	started     chan struct{}
	done        chan struct{}
}

func New(cfg Config, t Target, act func(int) activity.Kind, now func() time.Time, instance string, bus *notify.Bus) *Drainer {
	return &Drainer{
		cfg: cfg, target: t, activity: act, now: now, instance: instance, bus: bus,
		phase: PhaseServing, lastEsc: map[string]time.Time{}, interrupted: map[string]bool{},
		started: make(chan struct{}), done: make(chan struct{}),
	}
}

func (d *Drainer) Phase() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.phase
}

func (d *Drainer) Done() <-chan struct{} { return d.done }

// Start begins the drain; false if one already started (the deadlines never move).
func (d *Drainer) Start() bool {
	d.mu.Lock()
	if d.phase != PhaseServing {
		d.mu.Unlock()
		return false
	}
	d.phase = PhaseDraining
	d.startedAt = d.now()
	close(d.started)
	d.mu.Unlock()
	d.bus.Notify()
	return true
}

func (d *Drainer) State() State {
	d.mu.Lock()
	st := State{Instance: d.instance, Phase: d.phase}
	if !d.startedAt.IsZero() {
		st.StartedAt = d.startedAt
		st.SoftAt = d.startedAt.Add(d.cfg.Soft)
		st.HardAt = d.startedAt.Add(d.cfg.Hard)
	}
	d.mu.Unlock()
	st.Sessions = d.target.Snapshot()
	return st
}

// Step is one pass; Run calls it, tests call it with a fake clock.
func (d *Drainer) Step() {
	d.mu.Lock()
	if d.phase != PhaseDraining {
		d.mu.Unlock()
		return
	}
	now := d.now()
	elapsed := now.Sub(d.startedAt)
	d.mu.Unlock()
	if elapsed >= d.cfg.Hard {
		d.target.KillAll(session.ReasonKilled)
		d.finish()
		return
	}
	alive := 0
	for _, s := range d.target.Snapshot() {
		if !s.Alive {
			continue
		}
		alive++
		if !s.Headless {
			if k := d.activity(s.Pid); k == activity.Idle || k == activity.Waiting {
				reason := session.ReasonIdle
				if d.wasInterrupted(s.ID) {
					reason = session.ReasonInterrupted
				}
				d.target.Terminate(s.ID, reason)
				continue
			}
		}
		if elapsed >= d.cfg.Soft && d.escDue(s.ID, s.Headless, now) {
			d.target.Interrupt(s.ID)
		}
	}
	if alive == 0 {
		d.finish()
	}
}

func (d *Drainer) wasInterrupted(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.interrupted[id]
}

// Headless sessions get one SIGINT; interactive ones get Esc every EscEvery.
func (d *Drainer) escDue(id string, headless bool, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	last, sent := d.lastEsc[id]
	if sent && (headless || now.Sub(last) < d.cfg.EscEvery) {
		return false
	}
	d.lastEsc[id] = now
	d.interrupted[id] = true
	return true
}

func (d *Drainer) finish() {
	d.mu.Lock()
	if d.phase == PhaseDone {
		d.mu.Unlock()
		return
	}
	d.phase = PhaseDone
	close(d.done)
	d.mu.Unlock()
	d.bus.Notify()
}

// Run waits for Start, then passes every Poll until done or ctx ends.
func (d *Drainer) Run(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-d.started:
	}
	t := time.NewTimer(d.cfg.FirstPass)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.done:
			return
		case <-t.C:
			d.Step()
			t.Reset(d.cfg.Poll)
		}
	}
}
```

- [ ] **Step 4: Run them and watch them pass.** `cd broker && go test -race ./internal/drain/` → PASS.

- [ ] **Step 5: Commit.** `feat(broker): drain state machine`.

---

### Task 5: Server: input freeze, CREATE refusal, STATUS/WATCH, control socket (Go)

**Files:**
- Modify: `broker/internal/server/server.go`
- Create: `broker/internal/server/control.go`, `broker/internal/server/drain_test.go`

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.
- Produces:
  - `Server` fields: `Drain *drain.Drainer` (nil means always serving), `Bus *notify.Bus`, `Instance string`.
  - `server.ErrDraining = "draining: the workspace is restarting"`.
  - `(*Server).ServeControl(ctx, ln) error`.
  - `ENDED.reason` is now the session's end reason; `SESSIONS[].ended`.

**Verifiable:** locally, `cd broker && go test -race ./internal/server/` (`/bin/cat` sessions).

- [ ] **Step 1: Write the failing tests.** `broker/internal/server/drain_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/notify"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

type drainRig struct {
	srv     *Server
	mgr     *session.Manager
	d       *drain.Drainer
	main    string
	ctl     string
	cleanup func()
}

func startDrainRig(t *testing.T, act func(int) activity.Kind) *drainRig {
	t.Helper()
	dir := t.TempDir()
	bus := &notify.Bus{}
	mgr := session.NewManager(session.ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024, OnChange: bus.Notify})
	cfg := drain.Config{Soft: time.Hour, Hard: 2 * time.Hour, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute}
	d := drain.New(cfg, mgr, act, time.Now, "inst1", bus)
	srv := New(mgr)
	srv.Drain, srv.Bus, srv.Instance = d, bus, "inst1"
	r := &drainRig{srv: srv, mgr: mgr, d: d, main: filepath.Join(dir, "b.sock"), ctl: filepath.Join(dir, "ctl.sock")}
	ln, err := net.Listen("unix", r.main)
	if err != nil {
		t.Fatal(err)
	}
	cl, err := net.Listen("unix", r.ctl)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.Serve(ctx, ln) }()
	go func() { _ = srv.ServeControl(ctx, cl) }()
	go d.Run(ctx)
	r.cleanup = func() { cancel(); ln.Close(); cl.Close(); mgr.CloseAll() }
	t.Cleanup(r.cleanup)
	return r
}

func dial(t *testing.T, path string) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func state(t *testing.T, c net.Conn) proto.StateNotice {
	t.Helper()
	var st proto.StateNotice
	if err := json.Unmarshal(readUntilFrame(t, c, proto.FrameState), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func busyAll(int) activity.Kind { return activity.Busy }

func TestStatusAndWatch(t *testing.T) {
	r := startDrainRig(t, busyAll)
	c := dial(t, r.main)
	_ = proto.WriteJSONFrame(c, proto.FrameStatus, struct{}{})
	if st := state(t, c); st.Instance != "inst1" || st.Phase != "serving" || st.SoftAt != 0 {
		t.Fatalf("%+v", st)
	}
	w := dial(t, r.main)
	_ = proto.WriteJSONFrame(w, proto.FrameWatch, struct{}{})
	state(t, w)
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "s1", Cols: 80, Rows: 24, Headless: true})
	readUntilFrame(t, c, proto.FrameCreated)
	st := state(t, w)
	for len(st.Sessions) == 0 {
		st = state(t, w)
	}
	if st.Sessions[0].ID != "s1" || !st.Sessions[0].Alive || !st.Sessions[0].Headless {
		t.Fatalf("%+v", st.Sessions)
	}
	r.d.Start()
	for st.Phase != "draining" {
		st = state(t, w)
	}
	if st.SoftAt == 0 || st.HardAt <= st.SoftAt {
		t.Fatalf("deadlines %+v", st)
	}
}

func TestDrainingRefusesInputAndCreate(t *testing.T) {
	r := startDrainRig(t, busyAll)
	c := dial(t, r.main)
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "s1", Cols: 80, Rows: 24})
	readUntilFrame(t, c, proto.FrameCreated)
	_ = proto.WriteJSONFrame(c, proto.FrameAttach, proto.AttachRequest{ID: "s1", Channel: 7})
	readUntilFrame(t, c, proto.FrameAttached)
	r.d.Start()
	_ = proto.WriteFrame(c, proto.FrameInput, proto.EncodeChannelData(7, []byte("typed\n")))
	var n proto.Notice
	if err := json.Unmarshal(readUntilFrame(t, c, proto.FrameNotice), &n); err != nil || n.Channel != 7 || n.Code != proto.NoticeDraining {
		t.Fatalf("notice %+v %v", n, err)
	}
	if out := r.mgr.Get("s1"); out == nil || !out.Alive() {
		t.Fatal("session gone")
	}
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "s2", Cols: 80, Rows: 24})
	var cr proto.CreateResponse
	_ = json.Unmarshal(readUntilFrame(t, c, proto.FrameCreated), &cr)
	if cr.OK || cr.Error != ErrDraining {
		t.Fatalf("create %+v", cr)
	}
}

func TestDrainOnlyOnControlSocketAndStreamsUntilDone(t *testing.T) {
	r := startDrainRig(t, func(int) activity.Kind { return activity.Idle })
	c := dial(t, r.main)
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "s1", Cols: 80, Rows: 24})
	readUntilFrame(t, c, proto.FrameCreated)
	_ = proto.WriteJSONFrame(c, proto.FrameDrain, struct{}{})
	time.Sleep(100 * time.Millisecond)
	if r.d.Phase() != drain.PhaseServing {
		t.Fatal("DRAIN on the main listener started a drain")
	}
	ctl := dial(t, r.ctl)
	_ = proto.WriteJSONFrame(ctl, proto.FrameDrain, struct{}{})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st := state(t, ctl); st.Phase == drain.PhaseDone {
			if len(st.Sessions) != 1 || st.Sessions[0].Ended != session.ReasonIdle {
				t.Fatalf("%+v", st.Sessions)
			}
			return
		}
	}
	t.Fatal("never done")
}

func TestEndedCarriesTheReason(t *testing.T) {
	r := startDrainRig(t, busyAll)
	c := dial(t, r.main)
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "s1", Cols: 80, Rows: 24})
	readUntilFrame(t, c, proto.FrameCreated)
	_ = proto.WriteJSONFrame(c, proto.FrameAttach, proto.AttachRequest{ID: "s1", Channel: 1})
	readUntilFrame(t, c, proto.FrameAttached)
	r.mgr.KillAll(session.ReasonKilled)
	var e proto.EndedNotice
	_ = json.Unmarshal(readUntilFrame(t, c, proto.FrameEnded), &e)
	if e.Reason != session.ReasonKilled {
		t.Fatalf("reason %q", e.Reason)
	}
	_ = proto.WriteJSONFrame(c, proto.FrameList, struct{}{})
	var l proto.SessionsResponse
	_ = json.Unmarshal(readUntilFrame(t, c, proto.FrameSessions), &l)
	if len(l.Sessions) != 1 || l.Sessions[0].Ended != session.ReasonKilled {
		t.Fatalf("%+v", l)
	}
}
```

- [ ] **Step 2: Run them and watch them fail.** They don't compile yet.

- [ ] **Step 3: Implement the server changes.** In `server.go`:

Add imports `drain` and `notify`. Add fields to `Server`:

```go
	// Drain is nil when the broker has no drainer (tests); it then always serves.
	Drain    *drain.Drainer
	Bus      *notify.Bus
	Instance string
```

Add constants and helpers:

```go
const ErrDraining = "draining: the workspace is restarting"

// One NOTICE per channel per interval; a held key would otherwise flood the viewer.
const noticeEvery = 5 * time.Second

func (s *Server) phase() string {
	if s.Drain == nil {
		return drain.PhaseServing
	}
	return s.Drain.Phase()
}

func (s *Server) stateNotice() proto.StateNotice {
	var st drain.State
	if s.Drain != nil {
		st = s.Drain.State()
	} else {
		st = drain.State{Instance: s.Instance, Phase: drain.PhaseServing, Sessions: s.mgr.Snapshot()}
	}
	out := proto.StateNotice{Instance: st.Instance, Phase: st.Phase, Sessions: make([]proto.StateSession, len(st.Sessions))}
	if !st.StartedAt.IsZero() {
		out.StartedAt, out.SoftAt, out.HardAt = st.StartedAt.UnixMilli(), st.SoftAt.UnixMilli(), st.HardAt.UnixMilli()
	}
	for i, x := range st.Sessions {
		out.Sessions[i] = proto.StateSession{ID: x.ID, Alive: x.Alive, Headless: x.Headless, Ended: x.Ended}
	}
	return out
}

// streamState sends STATE now and on every change until stop closes, the write fails, or (untilDone) the drain is done.
func (s *Server) streamState(cw *connWriter, stop <-chan struct{}, untilDone bool) {
	var wake <-chan struct{}
	if s.Bus != nil {
		ch, cancel := s.Bus.Subscribe()
		defer cancel()
		wake = ch
	}
	for {
		st := s.stateNotice()
		if cw.writeJSON(proto.FrameState, st) != nil || (untilDone && st.Phase == drain.PhaseDone) {
			return
		}
		select {
		case <-stop:
			return
		case <-wake:
		case <-time.After(5 * time.Second):
		}
	}
}
```

Replace the per-connection maps with one state struct. In `handleConn`, after `cw := &connWriter{w: c}`:

```go
	cs := &connState{cw: cw, attached: map[uint32]string{}, dialed: map[uint32]net.Conn{}, notices: map[uint32]time.Time{}, done: make(chan struct{})}
	defer close(cs.done)
```

Point the two deferred cleanups at `cs.attached` and `cs.dialed`, and change the dispatch call to `s.dispatch(ft, payload, cs)`. Define:

```go
type connState struct {
	cw       *connWriter
	attached map[uint32]string
	dialed   map[uint32]net.Conn
	notices  map[uint32]time.Time
	done     chan struct{}
	watching bool
}
```

Change the `dispatch` signature to `func (s *Server) dispatch(ft proto.FrameType, payload []byte, c *connState) error`. Its first line is `cw, attached, dialed := c.cw, c.attached, c.dialed`, so the existing cases compile unchanged, apart from these edits:

- **CREATE:** before `s.mgr.Create(...)`, add the refusal, and replace the `Create` call:

```go
		if s.phase() != drain.PhaseServing {
			return cw.writeJSON(proto.FrameCreated, proto.CreateResponse{ID: req.ID, OK: false, Error: ErrDraining})
		}
		if _, err := s.mgr.CreateWith(req.ID, req.Cols, req.Rows, req.Args, req.Headless); err != nil {
```

- **ATTACH:** both `EndedNotice` sends use `Reason: sess.EndReason()`, in place of the literal `"exit"`.

- **INPUT:** after `id, ok := attached[channel]; if !ok { return nil }`, add:

```go
		if s.phase() != drain.PhaseServing {
			if last, seen := c.notices[channel]; !seen || time.Since(last) >= noticeEvery {
				c.notices[channel] = time.Now()
				return cw.writeJSON(proto.FrameNotice, proto.Notice{Channel: channel, Code: proto.NoticeDraining})
			}
			return nil
		}
```

- **LIST:** `resp.Sessions[i] = proto.SessionInfo{ID: info.ID, Alive: info.Alive, Ended: info.Ended}`.

- **New cases** before `default:`:

```go
	case proto.FrameStatus:
		return cw.writeJSON(proto.FrameState, s.stateNotice())

	case proto.FrameWatch:
		if !c.watching {
			c.watching = true
			go s.streamState(cw, c.done, false)
		}
		return nil
```

`DRAIN` stays unhandled here: it falls through to `default` (logged and dropped), so it can't be reached on :7070 (D142).

- [ ] **Step 4: Implement the control socket.** `broker/internal/server/control.go`:

```go
package server

import (
	"context"
	"errors"
	"log"
	"net"

	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
)

// ServeControl serves the local control socket (D142): DRAIN starts the drain
// and streams STATE until done; STATUS answers once. Nothing else is accepted.
func (s *Server) ServeControl(ctx context.Context, ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			log.Printf("control accept: %v", err)
			continue
		}
		go s.handleControl(c)
	}
}

func (s *Server) handleControl(c net.Conn) {
	defer c.Close()
	cw := &connWriter{w: c}
	for {
		ft, _, err := proto.ReadFrame(c)
		if err != nil {
			return
		}
		switch ft {
		case proto.FrameStatus:
			if cw.writeJSON(proto.FrameState, s.stateNotice()) != nil {
				return
			}
		case proto.FrameDrain:
			if s.Drain == nil {
				return
			}
			if s.Drain.Start() {
				log.Printf("drain started (control socket)")
			}
			s.streamState(cw, nil, true)
			return
		default:
			log.Printf("control: unknown frame type 0x%02x", uint8(ft))
		}
	}
}
```

- [ ] **Step 5: Run the tests and watch them pass.** `cd broker && go test -race ./internal/server/` → PASS, both the new tests and the existing ones.

- [ ] **Step 6: Commit.** `feat(broker): freeze input and CREATE while draining; STATUS/WATCH; control socket`.

---

### Task 6: `broker drain` / `broker ready`, settings, SIGTERM drain (Go)

**Files:**
- Create: `broker/cmd/broker/cli.go`, `broker/cmd/broker/cli_test.go`, `broker/cmd/broker/settings.go`, `broker/cmd/broker/settings_test.go`
- Modify: `broker/cmd/broker/main.go`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - CLI: `broker drain` (exit 0 when done or the broker is gone, 1 when it can't connect) and `broker ready` (exit 0 only while serving).
  - Env: `CLAUDE_FLEET_BROKER_DRAIN`, `CLAUDE_FLEET_BROKER_DRAIN_SOFT`, `CLAUDE_FLEET_BROKER_DRAIN_HARD`, `CLAUDE_FLEET_BROKER_CTL_SOCKET`, `CLAUDE_FLEET_BROKER_STATUS_DIR`.

**Verifiable:**
- Locally: `cd broker && go test -race ./cmd/broker/`.
- SIGTERM semantics end to end: CI only (`split.test.sh`, Task 7), which needs Docker.

- [ ] **Step 1: Write the failing tests.**

`broker/cmd/broker/settings_test.go`:

```go
package main

import (
	"strings"
	"testing"
	"time"
)

func TestDrainSettings(t *testing.T) {
	on, cfg, err := drainSettings(envOf(nil))
	if err != nil || on || cfg.Soft != 30*time.Minute || cfg.Hard != 35*time.Minute {
		t.Fatalf("defaults: %v %+v %v", on, cfg, err)
	}
	on, cfg, err = drainSettings(envOf(map[string]string{"CLAUDE_FLEET_BROKER_DRAIN": "1", "CLAUDE_FLEET_BROKER_DRAIN_SOFT": "3s", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "6s"}))
	if err != nil || !on || cfg.Soft != 3*time.Second || cfg.Hard != 6*time.Second {
		t.Fatalf("override: %v %+v %v", on, cfg, err)
	}
	for _, bad := range []map[string]string{
		{"CLAUDE_FLEET_BROKER_DRAIN": "yes"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "soon"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "500ms"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "40m"},
		{"CLAUDE_FLEET_BROKER_DRAIN_HARD": "25h", "CLAUDE_FLEET_BROKER_DRAIN_SOFT": "1h"},
	} {
		if _, _, err := drainSettings(envOf(bad)); err == nil {
			t.Errorf("accepted %v", bad)
		} else if !strings.Contains(err.Error(), "CLAUDE_FLEET_BROKER_DRAIN") {
			t.Errorf("error doesn't name the variable: %v", err)
		}
	}
}
```

`broker/cmd/broker/cli_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/notify"
	"github.com/ImIOImI/claude-fleet/broker/internal/server"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

func controlRig(t *testing.T) (string, *drain.Drainer) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ctl.sock")
	bus := &notify.Bus{}
	mgr := session.NewManager(session.ManagerConfig{ClaudeExec: "/bin/cat", OnChange: bus.Notify})
	d := drain.New(drain.Config{Soft: time.Minute, Hard: 2 * time.Minute, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute},
		mgr, func(int) activity.Kind { return activity.Idle }, time.Now, "i", bus)
	srv := server.New(mgr)
	srv.Drain, srv.Bus = d, bus
	ln, err := listenCtl(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.ServeControl(ctx, ln) }()
	go d.Run(ctx)
	t.Cleanup(func() { cancel(); ln.Close(); mgr.CloseAll() })
	return path, d
}

func TestReadyThenDrainReturnsWhenDone(t *testing.T) {
	path, d := controlRig(t)
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_CTL_SOCKET": path})
	var out, errOut bytes.Buffer
	if code := runCLI([]string{"ready"}, env, &out, &errOut); code != 0 {
		t.Fatalf("ready while serving: %d %s", code, errOut.String())
	}
	if code := runCLI([]string{"drain"}, env, &out, &errOut); code != 0 {
		t.Fatalf("drain: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), `"phase":"done"`) || d.Phase() != drain.PhaseDone {
		t.Fatalf("output %q phase %s", out.String(), d.Phase())
	}
	if code := runCLI([]string{"ready"}, env, &out, &errOut); code != 1 {
		t.Fatalf("ready after drain: %d", code)
	}
}

func TestCLIWithoutBrokerAndUsage(t *testing.T) {
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_CTL_SOCKET": filepath.Join(t.TempDir(), "none.sock")})
	var out, errOut bytes.Buffer
	if code := runCLI([]string{"drain"}, env, &out, &errOut); code != 1 {
		t.Fatalf("drain without broker: %d", code)
	}
	if code := runCLI([]string{"ready"}, env, &out, &errOut); code != 1 {
		t.Fatalf("ready without broker: %d", code)
	}
	if code := runCLI([]string{"bogus"}, env, &out, &errOut); code != 2 {
		t.Fatalf("usage: %d", code)
	}
}

func TestControlSocketIsOwnerOnly(t *testing.T) {
	path, _ := controlRig(t)
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", fi.Mode().Perm(), err)
	}
}
```

`envOf` already exists in `listen_test.go`.

- [ ] **Step 2: Run them and watch them fail.** They don't compile yet.

- [ ] **Step 3: Implement the settings.** `broker/cmd/broker/settings.go`:

```go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
)

const defaultCtlSocket = "/run/broker/ctl.sock"

// drainSettings reads the operator settings (D153); on is CLAUDE_FLEET_BROKER_DRAIN=1.
func drainSettings(getenv func(string) string) (bool, drain.Config, error) {
	cfg := drain.DefaultConfig()
	on := getenv("CLAUDE_FLEET_BROKER_DRAIN")
	switch on {
	case "", "0", "1":
	default:
		return false, cfg, fmt.Errorf("CLAUDE_FLEET_BROKER_DRAIN must be '', 0 or 1, got %q", on)
	}
	for _, v := range []struct {
		key string
		dst *time.Duration
	}{{"CLAUDE_FLEET_BROKER_DRAIN_SOFT", &cfg.Soft}, {"CLAUDE_FLEET_BROKER_DRAIN_HARD", &cfg.Hard}} {
		raw := getenv(v.key)
		if raw == "" {
			continue
		}
		d, err := time.ParseDuration(raw)
		if err != nil {
			return false, cfg, fmt.Errorf("%s: %v", v.key, err)
		}
		*v.dst = d
	}
	if cfg.Soft < time.Second || cfg.Hard <= cfg.Soft || cfg.Hard > 24*time.Hour {
		return false, cfg, fmt.Errorf("CLAUDE_FLEET_BROKER_DRAIN_SOFT and CLAUDE_FLEET_BROKER_DRAIN_HARD need 1s <= soft < hard <= 24h, got %v and %v", cfg.Soft, cfg.Hard)
	}
	return on == "1", cfg, nil
}

func ctlPath(getenv func(string) string) string {
	if p := getenv("CLAUDE_FLEET_BROKER_CTL_SOCKET"); p != "" {
		return p
	}
	return defaultCtlSocket
}

func listenCtl(ctx context.Context, path string) (net.Listener, error) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale control socket: %w", err)
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod control socket: %w", err)
	}
	return ln, nil
}

func newInstance() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

- [ ] **Step 4: Implement the CLI.** `broker/cmd/broker/cli.go`:

```go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
)

// runCLI serves the preStop hook (drain) and the readiness probe (ready).
func runCLI(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	path := ctlPath(getenv)
	switch args[0] {
	case "drain":
		return cliDrain(path, stdout, stderr)
	case "ready":
		return cliReady(path)
	}
	fmt.Fprintln(stderr, "usage: broker [drain|ready]")
	return 2
}

func cliDrain(path string, stdout, stderr io.Writer) int {
	c, err := net.Dial("unix", path)
	if err != nil {
		fmt.Fprintf(stderr, "broker drain: %v\n", err)
		return 1
	}
	defer c.Close()
	if err := proto.WriteJSONFrame(c, proto.FrameDrain, struct{}{}); err != nil {
		fmt.Fprintf(stderr, "broker drain: %v\n", err)
		return 1
	}
	for {
		ft, payload, err := proto.ReadFrame(c)
		if err != nil {
			// The broker is gone: nothing is left to wait for.
			fmt.Fprintln(stdout, `{"phase":"gone"}`)
			return 0
		}
		if ft != proto.FrameState {
			continue
		}
		var st proto.StateNotice
		if json.Unmarshal(payload, &st) != nil {
			continue
		}
		alive := 0
		for _, s := range st.Sessions {
			if s.Alive {
				alive++
			}
		}
		fmt.Fprintf(stdout, "{\"phase\":%q,\"alive\":%d,\"softAt\":%d,\"hardAt\":%d}\n", st.Phase, alive, st.SoftAt, st.HardAt)
		if st.Phase == drain.PhaseDone {
			return 0
		}
	}
}

func cliReady(path string) int {
	c, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		return 1
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if proto.WriteJSONFrame(c, proto.FrameStatus, struct{}{}) != nil {
		return 1
	}
	for {
		ft, payload, err := proto.ReadFrame(c)
		if err != nil {
			return 1
		}
		if ft != proto.FrameState {
			continue
		}
		var st proto.StateNotice
		if json.Unmarshal(payload, &st) != nil || st.Phase != drain.PhaseServing {
			return 1
		}
		return 0
	}
}
```

- [ ] **Step 5: Wire `main.go`.** Add to the env list in the header comment:

```go
//	CLAUDE_FLEET_BROKER_DRAIN     "1": open the control socket (broker drain / broker ready)
//	                              and drain on SIGTERM (SPEC §7 *Workspace pod drain*)
//	CLAUDE_FLEET_BROKER_DRAIN_SOFT / _HARD  Go durations (default 30m / 35m)
//	CLAUDE_FLEET_BROKER_CTL_SOCKET  control socket path (default /run/broker/ctl.sock)
//	CLAUDE_FLEET_BROKER_STATUS_DIR  claude status files (default $HOME/.claude/sessions)
```

Replace the SIGTERM sentence in the lifecycle comment with: `SIGTERM closes all PTYs, or with CLAUDE_FLEET_BROKER_DRAIN=1 drains first (D143); SIGINT always closes at once.`

Replace the body of `main()` from `ringBytes := …` to the end:

```go
	if len(os.Args) > 1 {
		os.Exit(runCLI(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
	}
	ringBytes := envInt("CLAUDE_FLEET_BROKER_RING", defaultRingBytes)
	claudeExec := envDefault("CLAUDE_FLEET_BROKER_CLAUDE", defaultClaudeExec)
	drainOn, dcfg, err := drainSettings(os.Getenv)
	if err != nil {
		log.Fatalf("%v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ln, listenAddr, err := listen(ctx, os.Getenv, meshWait, log.Printf)
	if err != nil {
		log.Fatalf("%v", err)
	}

	bus := &notify.Bus{}
	mgr := session.NewManager(session.ManagerConfig{ClaudeExec: claudeExec, RingBufBytes: ringBytes, OnChange: bus.Notify})
	instance := newInstance()
	reader := activity.Reader{Dir: activity.DefaultDir(os.Getenv)}
	d := drain.New(dcfg, mgr, reader.Of, time.Now, instance, bus)
	srv := server.New(mgr)
	srv.Drain, srv.Bus, srv.Instance = d, bus, instance
	go d.Run(ctx)

	var ctlLn net.Listener
	if drainOn {
		ctlLn, err = listenCtl(ctx, ctlPath(os.Getenv))
		if err != nil {
			log.Fatalf("control socket: %v", err)
		}
		go func() { _ = srv.ServeControl(ctx, ctlLn) }()
	}

	stop := func() { cancel(); _ = ln.Close() }
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		for sig := range sigCh {
			if sig == syscall.SIGTERM && drainOn {
				if d.Start() {
					log.Printf("SIGTERM: draining (soft %v, hard %v)", dcfg.Soft, dcfg.Hard)
				} else {
					log.Printf("SIGTERM while %s; exiting when the drain is done", d.Phase())
				}
				go func() { <-d.Done(); stop() }()
				continue
			}
			log.Printf("shutdown signal: %v", sig)
			stop()
			return
		}
	}()

	log.Printf("listening on %s (ring=%d, claude=%q, drain=%v, instance=%s)", listenAddr, ringBytes, claudeExec, drainOn, instance)
	if err := srv.Serve(ctx, ln); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, context.Canceled) {
		log.Printf("serve error: %v", err)
	}
	if ctlLn != nil {
		_ = ctlLn.Close()
	}
	mgr.CloseAll()
	log.Print("exited")
```

Imports: add `activity`, `drain` and `notify`. `net` and `time` are already imported.

- [ ] **Step 6: Run the tests and watch them pass.** `cd broker && go test -race ./...` → PASS. Also build: `CGO_ENABLED=0 go build -ldflags="-s -w" -o /tmp/broker ./cmd/broker`.

- [ ] **Step 7: Smoke-test locally without Docker:**

```bash
cd broker && CGO_ENABLED=0 go build -o /tmp/broker ./cmd/broker
d=$(mktemp -d)
CLAUDE_FLEET_BROKER_SOCKET=$d/b.sock CLAUDE_FLEET_BROKER_CTL_SOCKET=$d/ctl.sock CLAUDE_FLEET_BROKER_DRAIN=1 \
  CLAUDE_FLEET_BROKER_DRAIN_SOFT=2s CLAUDE_FLEET_BROKER_DRAIN_HARD=4s CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat /tmp/broker & b=$!
sleep 0.5
CLAUDE_FLEET_BROKER_CTL_SOCKET=$d/ctl.sock /tmp/broker ready; echo "ready=$?"   # 0
kill -TERM $b; sleep 0.2
CLAUDE_FLEET_BROKER_CTL_SOCKET=$d/ctl.sock /tmp/broker ready; echo "ready=$?"   # 1
wait $b; echo "exit=$?"                                                          # 0 within ~3 s (no sessions)
```

- [ ] **Step 8: Commit.** `feat(broker): broker drain/ready, drain settings, SIGTERM drain`.

---

### Task 7: Entry script and image checks

**Files:**
- Modify: `docker/host/fleet-host-entry`, `docker/host/fleet-host-entry.test.sh`, `docker/host/split.test.sh`, `docker/host/smoke.test.sh`

**Interfaces:**
- Consumes: Task 6 (`broker drain`, `broker ready`, `CLAUDE_FLEET_BROKER_DRAIN`).
- Produces: `fleet-host-entry workspace` exports `CLAUDE_FLEET_BROKER_DRAIN=1`. `single` and `host` don't.

**Verifiable:**
- Locally: `bash docker/host/fleet-host-entry.test.sh` (fake broker, no Docker).
- CI only: `split.test.sh` and `smoke.test.sh`, which build the image (`test-runner-images.yml`).

- [ ] **Step 1: Write the failing entry tests.** In `fleet-host-entry.test.sh`, make the fake broker record the drain flag and act as the preStop CLI. Replace the fake `broker` heredoc with:

```bash
cat > "$tmp/broker" <<'SH'
#!/usr/bin/env bash
# As the preStop hook: `broker drain` / `broker ready` record their call and succeed.
if [ $# -gt 0 ]; then echo "cli $*" >> "$FAKE_DIR/events"; exit 0; fi
trap 'echo broker-term >> "$FAKE_DIR/events"; exit 0' TERM
echo $$ >> "$FAKE_DIR/pids"
echo broker-start >> "$FAKE_DIR/events"
echo "env ${CLAUDE_FLEET_BROKER_TCP_PORT:-} ${CLAUDE_FLEET_BROKER_REQUIRE_MESH:-} ${FLEET_HOST_CRED_ADDR:-}" >> "$FAKE_DIR/events"
echo "drain ${CLAUDE_FLEET_BROKER_DRAIN:-}" >> "$FAKE_DIR/events"
if [ -n "${FAKE_BROKER_EXIT:-}" ]; then sleep 0.3; exit "$FAKE_BROKER_EXIT"; fi
while :; do sleep 0.05; done
SH
```

Add `-u CLAUDE_FLEET_BROKER_DRAIN` to the `env -u …` list in `run()`. Before the final `[ "$fails" -eq 0 ]` line, add:

```bash
# 30. workspace turns the drain on (the preStop's `broker drain` needs the control socket); single doesn't.
run wsdrain workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1 CLAUDE_FLEET_BROKER_DRAIN=0
until_count broker-start 1
assert "$(grep '^drain ' "$dir/events")" "drain 1" "workspace forces CLAUDE_FLEET_BROKER_DRAIN=1"
kill -TERM "$pid"; finish
assert "$st" "0" "workspace drain run exits with the broker"
run singledrain single
until_count broker-start 1
assert "$(grep '^drain ' "$dir/events")" "drain " "single runs no drain"
kill -TERM "$pid"; finish

# 31. The preStop hook is the broker binary itself; the entry script plays no part in it.
FAKE_DIR="$tmp" "$tmp/broker" drain; assert "$?" "0" "preStop command runs"
grep -qx 'cli drain' "$tmp/events"; assert "$?" "0" "preStop reaches the broker CLI"
```

Create `"$tmp/events"` first: `: > "$tmp/events"` just before test 31.

- [ ] **Step 2: Run it and watch it fail.** `bash docker/host/fleet-host-entry.test.sh` → `FAIL: workspace forces CLAUDE_FLEET_BROKER_DRAIN=1 (got 'drain 0' …)`.

- [ ] **Step 3: Implement.** In `run_workspace` in `fleet-host-entry`, after `export CLAUDE_FLEET_BROKER_REQUIRE_MESH=1`:

```bash
  # The preStop `broker drain` needs the control socket; SIGTERM then drains too (D142, D143).
  export CLAUDE_FLEET_BROKER_DRAIN=1
```

Update the header comment's `workspace` line to `the broker and its sessions (workspace pod, uid 1000): broker :7070, drain on preStop/SIGTERM`.

- [ ] **Step 4: Run it and watch it pass.** `bash docker/host/fleet-host-entry.test.sh` → `ALL PASS`.

- [ ] **Step 5: CI image checks.**

In `docker/host/smoke.test.sh`, next to the other `docker run` checks, add:

```bash
# No broker running: the readiness probe fails and the preStop drain reports it can't connect.
docker run --rm --entrypoint /usr/local/bin/broker "$image" ready && fail "broker ready passed with no broker"
docker run --rm --entrypoint /usr/local/bin/broker "$image" drain 2>&1 | grep -q 'broker drain:' || fail "broker drain without a broker"
```

Use the script's existing `fail` helper and image variable names.

In `docker/host/split.test.sh`:
- Pass `-e CLAUDE_FLEET_BROKER_DRAIN_SOFT=3s -e CLAUDE_FLEET_BROKER_DRAIN_HARD=8s` to the `$n-ws` container.
- Extend `brokerctl.js`: `OP=status` sends `0x1a` and waits for `0x1b`. Change `want` and the request:

```js
const op = process.env.OP;
const want = op === 'create' ? 0x02 : op === 'status' ? 0x1b : 0x0b;
const req = op === 'create' ? frame(0x01, { id: process.env.ID, cols: 80, rows: 24 }) : op === 'status' ? frame(0x1a, {}) : frame(0x0a);
const c = net.connect(Number(p), h, () => c.write(req));
```

Then add, after the host-restart block and before the sidecar-less block:

```bash
# Drain (D142–D147): an idle session closes at once, a busy one is killed at the hard deadline, then the preStop returns.
bctl create drainidle | grep -q '"ok":true' || fail "CREATE drainidle"
bctl create drainbusy | grep -q '"ok":true' || fail "CREATE drainbusy"
docker exec "$n-ws" /usr/local/bin/broker ready || fail "broker not ready before the drain"
idle_pid=$(docker exec "$n-ws" sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/environ 2>/dev/null | tr "\0" "\n" | grep -x CLAUDE_FLEET_BROKER_SESSION_ID=drainidle)" ] && basename $p; done' | head -1)
docker exec "$n-ws" sh -c "mkdir -p ~/.claude/sessions && printf '{\"pid\":$idle_pid,\"sessionId\":\"x\",\"status\":\"idle\"}' > ~/.claude/sessions/$idle_pid.json"
start=$SECONDS
docker exec "$n-ws" /usr/local/bin/broker drain > "$tmp/drain.out" || fail "broker drain exited non-zero"
grep -q '"phase":"done"' "$tmp/drain.out" || fail "drain never reported done"
(( SECONDS - start <= 20 )) || fail "drain took longer than the hard deadline allows"
docker exec "$n-ws" /usr/local/bin/broker ready && fail "broker ready while drained"
bctl status | grep -q '"id":"drainidle","alive":false,"ended":"drain-idle"' || fail "idle session not closed as drain-idle"
bctl status | grep -q '"id":"drainbusy","alive":false,"ended":"drain-killed"' || fail "busy session not killed at the hard deadline"
bctl create late | grep -q 'draining: the workspace is restarting' || fail "CREATE accepted while drained"
docker stop -t 15 "$n-ws" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$n-ws")" = 0 || fail "drained broker did not exit 0 on SIGTERM"
```

`/bin/cat` writes no status file, so `drainbusy` stays busy (D144): it gets Esc at 3 s and is killed at 8 s.

- [ ] **Step 6: Commit.** `feat(host-image): workspace mode drains; drain checks in the image tests`.

---

### Task 8: TypeScript broker codec

**Files:**
- Modify: `src/main/broker.ts`
- Test: `src/main/broker.test.ts`

**Interfaces:**
- Consumes: Task 1's wire shapes.
- Produces:
  - `FrameType.STATUS`, `STATE`, `WATCH`, `DRAIN`, `NOTICE`.
  - Types: `DrainPhase`, `BrokerState`, `BrokerStateSession`; `DRAIN_CUT_REASONS`.
  - `parseBrokerState(raw: string): BrokerState | null`.
  - `SessionInfo.ended?: string`.
  - `BrokerClient` methods: `status()`, `watch()`.
  - `BrokerClient` events: `'state'` `(BrokerState)` and `'notice'` `(channel, code)`.
  - `createSession(id, cols, rows, args?, opts?: { headless?: boolean })`.

**Verifiable:** locally, `npx vitest run src/main/broker.test.ts`.

- [ ] **Step 1: Write the failing tests.** Append to `src/main/broker.test.ts`. Reuse its existing fake-socket helper; the snippet below uses a `Duplex` pair so it is self-contained:

```ts
import { PassThrough, Duplex } from 'node:stream';
import { BrokerClient, encodeFrame, FrameType, parseBrokerState, DRAIN_CUT_REASONS } from './broker.js';

function pair(): { client: BrokerClient; toClient: PassThrough; fromClient: Buffer[] } {
  const toClient = new PassThrough();
  const fromClient: Buffer[] = [];
  const d = new Duplex({
    read() {},
    write(chunk, _enc, cb) { fromClient.push(Buffer.from(chunk)); cb(); }
  });
  toClient.on('data', (b) => d.push(b));
  return { client: new BrokerClient(d), toClient, fromClient };
}

describe('drain frames', () => {
  it('parses STATE strictly', () => {
    expect(parseBrokerState('{"instance":"i","phase":"draining","softAt":5,"hardAt":9,"sessions":[{"id":"a","alive":false,"ended":"drain-idle"},{"id":"h","alive":true,"headless":true}]}'))
      .toEqual({ instance: 'i', phase: 'draining', softAt: 5, hardAt: 9, sessions: [{ id: 'a', alive: false, ended: 'drain-idle' }, { id: 'h', alive: true, headless: true }] });
    expect(parseBrokerState('{"instance":"i","phase":"weird","sessions":[]}')).toBeNull();
    expect(parseBrokerState('{"instance":"i","phase":"serving","sessions":[{"id":1}]}')).toBeNull();
    expect(parseBrokerState('not json')).toBeNull();
    expect([...DRAIN_CUT_REASONS].sort()).toEqual(['drain-interrupted', 'drain-killed']);
  });

  it('status() resolves on STATE; unsolicited STATE and NOTICE become events; watch() sends WATCH', async () => {
    const { client, toClient, fromClient } = pair();
    const states: unknown[] = [];
    const notices: unknown[] = [];
    client.on('state', (s) => states.push(s));
    client.on('notice', (ch, code) => notices.push([ch, code]));
    const p = client.status();
    toClient.write(encodeFrame(FrameType.STATE, Buffer.from('{"instance":"i","phase":"serving","sessions":[]}')));
    expect(await p).toEqual({ instance: 'i', phase: 'serving', sessions: [] });
    client.watch();
    expect(fromClient.at(-1)![4]).toBe(FrameType.WATCH);
    toClient.write(encodeFrame(FrameType.STATE, Buffer.from('{"instance":"i","phase":"draining","sessions":[]}')));
    toClient.write(encodeFrame(FrameType.NOTICE, Buffer.from('{"channel":3,"code":"draining"}')));
    await new Promise((r) => setTimeout(r, 10));
    expect(states).toEqual([{ instance: 'i', phase: 'draining', sessions: [] }]);
    expect(notices).toEqual([[3, 'draining']]);
  });

  it('createSession sends headless only when asked', async () => {
    const { client, toClient, fromClient } = pair();
    const p = client.createSession('a', 80, 24, ['-p', 'x'], { headless: true });
    toClient.write(encodeFrame(FrameType.CREATED, Buffer.from('{"id":"a","ok":true}')));
    await p;
    expect(JSON.parse(fromClient.at(-1)!.subarray(5).toString())).toEqual({ id: 'a', cols: 80, rows: 24, args: ['-p', 'x'], headless: true });
  });
});
```

- [ ] **Step 2: Run them and watch them fail.** `npx vitest run src/main/broker.test.ts`.

- [ ] **Step 3: Implement.** In `src/main/broker.ts`:

Add the enum members after `KILLED = 0x19`:

```ts
  STATUS = 0x1a,
  STATE = 0x1b,
  WATCH = 0x1c,
  DRAIN = 0x1d,
  NOTICE = 0x1e
```

Extend `SessionInfo` and add the drain types next to it:

```ts
export interface SessionInfo {
  id: string;
  alive: boolean;
  /** exit | drain-idle | drain-interrupted | drain-killed, once ended (drain-capable brokers). */
  ended?: string;
}

export type DrainPhase = 'serving' | 'draining' | 'done';
export interface BrokerStateSession { id: string; alive: boolean; headless?: boolean; ended?: string }
/** Times are epoch ms, present once a drain started. */
export interface BrokerState { instance: string; phase: DrainPhase; startedAt?: number; softAt?: number; hardAt?: number; sessions: BrokerStateSession[] }
/** End reasons that cut a turn short (the drain's Esc/SIGINT, or its hard stop). */
export const DRAIN_CUT_REASONS: ReadonlySet<string> = new Set(['drain-interrupted', 'drain-killed']);

const DRAIN_PHASES = new Set<string>(['serving', 'draining', 'done']);

export function parseBrokerState(raw: string): BrokerState | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.instance !== 'string' || typeof r.phase !== 'string' || !DRAIN_PHASES.has(r.phase) || !Array.isArray(r.sessions)) return null;
  const sessions: BrokerStateSession[] = [];
  for (const s of r.sessions) {
    if (!s || typeof s !== 'object') return null;
    const x = s as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.alive !== 'boolean') return null;
    sessions.push({ id: x.id, alive: x.alive, ...(x.headless === true ? { headless: true } : {}), ...(typeof x.ended === 'string' ? { ended: x.ended } : {}) });
  }
  const out: BrokerState = { instance: r.instance, phase: r.phase as DrainPhase, sessions };
  for (const k of ['startedAt', 'softAt', 'hardAt'] as const) {
    const v = r[k];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) out[k] = v;
  }
  return out;
}
```

Add to the `Events:` doc comment: `'state' (BrokerState) — unsolicited STATE (after watch())` and `'notice' (channel, code) — INPUT dropped (code "draining")`.

In `dispatch`, before `default:`:

```ts
      case FrameType.NOTICE: {
        const obj = JSON.parse(payload.toString('utf8')) as { channel: number; code: string };
        this.emit('notice', obj.channel, obj.code);
        return;
      }
      case FrameType.STATE: {
        const waiter = this.waiters[FrameType.STATE];
        if (waiter) {
          this.waiters[FrameType.STATE] = undefined;
          waiter.resolve(payload);
          return;
        }
        const st = parseBrokerState(payload.toString('utf8'));
        if (st) this.emit('state', st);
        return;
      }
```

Change `createSession`:

```ts
  async createSession(
    id: string,
    cols: number,
    rows: number,
    args?: string[],
    opts: { headless?: boolean } = {}
  ): Promise<CreateResponse> {
    const body = {
      id, cols, rows,
      ...(args && args.length > 0 ? { args } : {}),
      ...(opts.headless ? { headless: true } : {})
    };
```

The rest of the method stays as it is.

Add after `listSessions`:

```ts
  async status(): Promise<BrokerState | null> {
    const payload = await this.rpc({ type: FrameType.STATUS, payload: Buffer.from('{}') }, FrameType.STATE);
    return parseBrokerState(payload.toString('utf8'));
  }

  /** STATE now and on every change, as 'state' events, until the connection closes. */
  watch(): void {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(FrameType.WATCH, Buffer.from('{}')));
  }
```

- [ ] **Step 4: Run them and watch them pass.** Also run `npx vitest run src/main/broker.test.ts src/host/` to make sure nothing regresses.

- [ ] **Step 5: Commit.** `feat(broker-client): drain frames in the TS codec`.

---

### Task 9: fleet-host's DrainGate, broker ops and the sticky `broker:drain` event

**Files:**
- Modify: `src/host/brokerOps.ts`, `src/host/testFakes.ts`, `src/host/events.ts`
- Create: `src/host/drainGate.ts`, `src/host/drainGate.test.ts`
- Test: `src/host/events.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - `BrokerOps.create(id, cols, rows, args, opts?: { headless?: boolean })`.
  - `BrokerOps.watch?(h: { onState(s: BrokerState): void; onClose(): void }): Promise<{ stop(): void }>`.
  - `UpstreamHandlers.onNotice?(code: string)`.
  - `EventHub.publishSticky(channel, payload)`; `'broker:drain'` added to `EVENT_CHANNELS`.
  - `GatePhase`, `DrainEvent`.
  - `startDrainGate(o: DrainGateOptions): DrainGate`, with `phase()`, `last()`, `ended(id)`, `waitServing(ms)`, `subscribe(fn)` and `stop()`.
  - Constants: `LEGACY_AFTER_MS` = 5000, `WATCH_RETRY_MS` = 1000, `WATCH_RETRY_MAX_MS` = 10000.
  - `fakeBroker()` gains `watchers`, `pushState(s)` and `dropWatch()`.

**Verifiable:** locally, `npx vitest run src/host/drainGate.test.ts src/host/events.test.ts src/host/attachHub.test.ts`.

- [ ] **Step 1: Extend the fakes.** In `src/host/testFakes.ts`'s `fakeBroker`, add a watch implementation (and import `BrokerState` from `../main/broker.js`):

```ts
  const watchers = new Set<{ onState(s: BrokerState): void; onClose(): void }>();
  let watchable = true;
```

In `ops`:

```ts
    async create(id, _c, _r, args, opts) {
      if (sessions.has(id)) return { ok: false, error: 'session id in use' };
      add(id);
      created.push({ id, args, headless: opts?.headless === true });
      return { ok: true };
    },
    async watch(h) {
      if (!watchable) throw new Error('broker unreachable');
      watchers.add(h);
      return { stop: () => watchers.delete(h) };
    },
```

Widen `created`'s element type to `{ id: string; args: string[]; headless?: boolean }`, and return:

```ts
  return {
    ops, sessions, created, killed, ports, attachCalls: () => attachCalls, watchers,
    pushState: (s: BrokerState) => { for (const w of [...watchers]) w.onState(s); },
    dropWatch: () => { for (const w of [...watchers]) { watchers.delete(w); w.onClose(); } },
    setWatchable: (v: boolean) => { watchable = v; }
  };
```

- [ ] **Step 2: Write the failing tests.**

Append to `src/host/events.test.ts`:

```ts
it('a sticky channel replays its last value to a new subscriber', () => {
  const hub = new EventHub();
  const a: string[] = [];
  hub.add({ send: (t) => a.push(t) });
  hub.publishSticky('broker:drain', { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' });
  hub.publishSticky('broker:drain', { phase: 'serving', softAt: null, hardAt: null, instance: 'j' });
  const b: string[] = [];
  hub.add({ send: (t) => b.push(t) });
  expect(a).toHaveLength(2);
  expect(b.map((t) => JSON.parse(t))).toEqual([{ channel: 'broker:drain', payload: { phase: 'serving', softAt: null, hardAt: null, instance: 'j' } }]);
});
```

`src/host/drainGate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BrokerState } from '../main/broker.js';
import { EventHub } from './events.js';
import { createLogger } from './log.js';
import { startDrainGate, type GatePhase } from './drainGate.js';
import { fakeBroker } from './testFakes.js';

const st = (phase: BrokerState['phase'], instance = 'i1', sessions: BrokerState['sessions'] = []): BrokerState =>
  ({ instance, phase, sessions, ...(phase !== 'serving' ? { softAt: 100, hardAt: 200 } : {}) });

function rig(opts: { legacyMs?: number } = {}) {
  const broker = fakeBroker([]);
  const events = new EventHub();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  events.add({ send: (t) => sent.push(JSON.parse(t)) });
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, ms, live: true };
    timers.push(t);
    return () => { t.live = false; };
  };
  const fire = (ms: number) => { for (const t of timers.filter((x) => x.live && x.ms === ms)) { t.live = false; t.fn(); } };
  const gate = startDrainGate({ ops: broker.ops, log: createLogger(() => undefined), events, schedule, legacyMs: opts.legacyMs ?? 5000, retryMs: 1000, retryMaxMs: 4000 });
  const drain = () => sent.filter((e) => e.channel === 'broker:drain').map((e) => e.payload);
  return { broker, gate, drain, fire, timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('DrainGate', () => {
  it('starts unknown, follows STATE, publishes sticky phases, remembers end reasons', async () => {
    const { broker, gate, drain } = rig();
    expect(gate.phase()).toBe('unknown');
    await tick();
    broker.pushState(st('serving'));
    expect(gate.phase()).toBe('serving');
    broker.pushState(st('draining', 'i1', [{ id: 'auto-R-s', alive: false, headless: true, ended: 'drain-interrupted' }]));
    expect(gate.phase()).toBe('draining');
    expect(gate.ended('auto-R-s')).toBe('drain-interrupted');
    broker.pushState(st('done'));
    expect(gate.phase()).toBe('draining');
    expect(drain()).toEqual([
      { phase: 'unknown', softAt: null, hardAt: null, instance: null },
      { phase: 'serving', softAt: null, hardAt: null, instance: 'i1' },
      { phase: 'draining', softAt: 100, hardAt: 200, instance: 'i1' }
    ]);
  });

  it('a dropped watch goes unknown and reconnects with doubling backoff; a new instance serves', async () => {
    const { broker, gate, fire, timers } = rig();
    await tick();
    broker.pushState(st('draining'));
    broker.setWatchable(false);
    broker.dropWatch();
    expect(gate.phase()).toBe('unknown');
    fire(1000);
    await tick();
    expect(timers.some((t) => t.live && t.ms === 2000)).toBe(true);
    broker.setWatchable(true);
    fire(2000);
    await tick();
    broker.pushState(st('serving', 'i2'));
    expect(gate.phase()).toBe('serving');
    expect(gate.last()?.instance).toBe('i2');
  });

  it('a broker that never sends STATE is legacy (treated as serving)', async () => {
    const { gate, fire } = rig();
    await tick();
    fire(5000);
    expect(gate.phase()).toBe('legacy');
    expect(await gate.waitServing(10)).toBe(true);
  });

  it('waitServing resolves when serving returns, or false after the bound', async () => {
    const { broker, gate, fire } = rig();
    await tick();
    broker.pushState(st('draining'));
    const seen: GatePhase[] = [];
    gate.subscribe((p) => seen.push(p));
    const w = gate.waitServing(60_000);
    broker.pushState(st('serving', 'i2'));
    expect(await w).toBe(true);
    broker.pushState(st('draining', 'i2'));
    const late = gate.waitServing(30_000);
    fire(30_000);
    expect(await late).toBe(false);
    expect(seen).toContain('serving');
  });

  it('without a watch op the gate is legacy at once', () => {
    const events = new EventHub();
    const gate = startDrainGate({ ops: {}, log: createLogger(() => undefined), events });
    expect(gate.phase()).toBe('legacy');
    gate.stop();
  });
});
```

- [ ] **Step 3: Run them and watch them fail.**

- [ ] **Step 4: Implement the broker ops.** In `src/host/brokerOps.ts`:
- Import `BrokerState`.
- Add `onNotice?(code: string): void;` to `UpstreamHandlers`.
- Change `create` in the interface to `create(id: string, cols: number, rows: number, args: string[], opts?: { headless?: boolean }): Promise<{ ok: boolean; error?: string }>;`.
- Add:

```ts
  /** One persistent WATCH connection; rejects when the broker can't be reached. Absent: an old broker client. */
  watch?(h: { onState(s: BrokerState): void; onClose(): void }): Promise<{ stop(): void }>;
```

In `brokerOps(endpoint)`:
- In `attach`, after the `ended` listener: `c.on('notice', (ch: number, code: string) => ch === UPSTREAM_CHANNEL && h.onNotice?.(code));`.
- Replace `create` and add `watch`:

```ts
    create: (id, cols, rows, args, opts) => withClient(endpoint, (c) => c.createSession(id, cols, rows, args, opts)),
    async watch(h) {
      const c = new BrokerClient(endpoint);
      try {
        await c.ready();
      } catch (err) {
        c.close();
        throw err;
      }
      c.on('state', (s: BrokerState) => h.onState(s));
      c.on('error', () => undefined);
      c.once('close', () => h.onClose());
      c.watch();
      return {
        stop: () => {
          c.removeAllListeners('close');
          c.close();
        }
      };
    },
```

- [ ] **Step 5: Implement the sticky event.** In `src/host/events.ts`, add `'broker:drain'` to `EVENT_CHANNELS`, then:

```ts
export class EventHub {
  private readonly subs = new Set<Subscriber>();
  /** channel → its last frame, sent to every new subscriber. */
  private readonly sticky = new Map<string, string>();

  add(s: Subscriber): () => void {
    this.subs.add(s);
    for (const text of this.sticky.values()) s.send(text);
    return () => this.subs.delete(s);
  }

  get size(): number {
    return this.subs.size;
  }

  publish(channel: string, payload: unknown): void {
    const text = this.encode(channel, payload);
    for (const s of this.subs) s.send(text);
  }

  publishSticky(channel: string, payload: unknown): void {
    const text = this.encode(channel, payload);
    this.sticky.set(channel, text);
    for (const s of this.subs) s.send(text);
  }

  private encode(channel: string, payload: unknown): string {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`unknown event channel ${channel}`);
    // Titles and session text can carry a printed token. Strings first (escapes hide boundaries), the line as a backstop.
    return redactSecrets(JSON.stringify({ channel, payload }, redactStrings));
  }
}
```

- [ ] **Step 6: Implement the gate.** `src/host/drainGate.ts`:

```ts
// The workspace pod's drain as fleet-host sees it (SPEC §7 *Workspace pod drain*, D148): one persistent
// WATCH connection, reduced to serving / draining / unknown / legacy and published as sticky `broker:drain`.
import type { BrokerState } from '../main/broker.js';
import type { BrokerOps } from './brokerOps.js';
import type { EventHub } from './events.js';
import type { Logger } from './log.js';

export type GatePhase = 'serving' | 'draining' | 'unknown' | 'legacy';
export const LEGACY_AFTER_MS = 5_000;
export const WATCH_RETRY_MS = 1_000;
export const WATCH_RETRY_MAX_MS = 10_000;
const ENDED_MEMORY = 1_000;

export interface DrainEvent {
  phase: 'serving' | 'draining' | 'unknown';
  softAt: number | null;
  hardAt: number | null;
  instance: string | null;
}

export interface DrainGate {
  phase(): GatePhase;
  /** The last STATE from the broker currently or last watched. */
  last(): BrokerState | null;
  /** How a session ended, on any broker instance seen since start. */
  ended(sessionId: string): string | undefined;
  /** True once serving or legacy; false after maxMs. */
  waitServing(maxMs: number): Promise<boolean>;
  /** Called after every STATE and every phase change. */
  subscribe(fn: (phase: GatePhase, s: BrokerState | null) => void): () => void;
  stop(): void;
}

export interface DrainGateOptions {
  ops: Pick<BrokerOps, 'watch'>;
  log: Logger;
  events: Pick<EventHub, 'publishSticky'>;
  legacyMs?: number;
  retryMs?: number;
  retryMaxMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export const isOpen = (p: GatePhase): boolean => p === 'serving' || p === 'legacy';

export function startDrainGate(o: DrainGateOptions): DrainGate {
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  });
  const retryStart = o.retryMs ?? WATCH_RETRY_MS;
  const listeners = new Set<(p: GatePhase, s: BrokerState | null) => void>();
  const endedBy = new Map<string, string>();
  let phase: GatePhase = o.ops.watch ? 'unknown' : 'legacy';
  let last: BrokerState | null = null;
  let stopped = false;
  let delay = retryStart;
  let pending: (() => void) | null = null;
  let current: { stop(): void } | null = null;

  const emit = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn(phase, last);
      } catch (err) {
        o.log.log('warn', 'drain listener failed', { error: (err as Error).message });
      }
    }
  };
  const publish = (): void => {
    const draining = phase === 'draining';
    const e: DrainEvent = {
      phase: isOpen(phase) ? 'serving' : phase === 'draining' ? 'draining' : 'unknown',
      softAt: draining ? last?.softAt ?? null : null,
      hardAt: draining ? last?.hardAt ?? null : null,
      instance: last?.instance ?? null
    };
    o.events.publishSticky('broker:drain', e);
  };
  const setPhase = (p: GatePhase): void => {
    if (p === phase) return;
    const was = phase;
    phase = p;
    o.log.log(isOpen(p) ? 'info' : 'warn', 'broker drain state', { phase: p, was, instance: last?.instance ?? null });
    publish();
  };
  const remember = (s: BrokerState): void => {
    for (const x of s.sessions) {
      if (!x.ended || endedBy.get(x.id) === x.ended) continue;
      endedBy.delete(x.id);
      endedBy.set(x.id, x.ended);
      if (endedBy.size > ENDED_MEMORY) endedBy.delete(endedBy.keys().next().value as string);
    }
  };
  const retry = (): void => {
    if (stopped || pending) return;
    const ms = delay;
    delay = Math.min(delay * 2, o.retryMaxMs ?? WATCH_RETRY_MAX_MS);
    pending = schedule(() => {
      pending = null;
      connect();
    }, ms);
  };
  const connect = (): void => {
    const watch = o.ops.watch;
    if (stopped || !watch) return;
    let gotState = false;
    let legacy: (() => void) | null = null;
    watch({
      onState: (s) => {
        gotState = true;
        legacy?.();
        legacy = null;
        delay = retryStart;
        last = s;
        remember(s);
        setPhase(s.phase === 'serving' ? 'serving' : 'draining');
        emit();
      },
      onClose: () => {
        legacy?.();
        legacy = null;
        current = null;
        if (stopped) return;
        setPhase('unknown');
        emit();
        retry();
      }
    }).then(
      (w) => {
        if (stopped) return w.stop();
        current = w;
        if (!gotState) {
          legacy = schedule(() => {
            legacy = null;
            if (!gotState) {
              setPhase('legacy');
              emit();
            }
          }, o.legacyMs ?? LEGACY_AFTER_MS);
        }
      },
      (err: Error) => {
        if (stopped) return;
        o.log.log('warn', 'broker watch failed', { error: err.message });
        setPhase('unknown');
        emit();
        retry();
      }
    );
  };

  const subscribe = (fn: (p: GatePhase, s: BrokerState | null) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  publish();
  connect();
  return {
    phase: () => phase,
    last: () => last,
    ended: (id) => endedBy.get(id),
    subscribe,
    waitServing(maxMs) {
      if (isOpen(phase)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let cancel: () => void = () => undefined;
        const off = subscribe((p) => {
          if (!isOpen(p)) return;
          off();
          cancel();
          resolve(true);
        });
        cancel = schedule(() => {
          off();
          resolve(false);
        }, maxMs);
      });
    },
    stop() {
      stopped = true;
      pending?.();
      pending = null;
      current?.stop();
      current = null;
      listeners.clear();
    }
  };
}
```

- [ ] **Step 7: Run the tests and watch them pass.** `npx vitest run src/host/drainGate.test.ts src/host/events.test.ts src/host/` (the whole host suite must stay green; `created[i].headless` is the only fake change visible to existing tests).

- [ ] **Step 8: Commit.** `feat(fleet-host): DrainGate over a persistent broker WATCH; sticky broker:drain`.

---

### Task 10: The hub refuses input and CREATE while draining

**Files:**
- Modify: `src/host/attachHub.ts`
- Test: `src/host/attachHub.test.ts`

**Interfaces:**
- Consumes: Task 9 (`onNotice`), Task 8 (`FrameType.NOTICE`).
- Produces:
  - `AttachHubOptions.draining?: () => boolean`.
  - `HUB_NOTICE_MS` = 5000.
  - `Viewer.deliverNotice(channel, code)`.
  - `DRAINING_CREATE_ERROR = 'draining: the workspace is restarting'`.

**Verifiable:** locally, `npx vitest run src/host/attachHub.test.ts`.

- [ ] **Step 1: Write the failing tests.** Append to `src/host/attachHub.test.ts`. It already has a rig that builds a hub over `fakeBroker`, a `Viewer` with `sinkRecorder()`, and frame helpers; adapt the variable names to it:

```ts
describe('while the workspace pod drains', () => {
  it('drops INPUT with one NOTICE per channel per 5 s, refuses CREATE, and fans broker NOTICEs out', async () => {
    let draining = false;
    let now = 0;
    const broker = fakeBroker(['s1']);
    const hub = new AttachHub(broker.ops, { draining: () => draining, now: () => now });
    const sink = sinkRecorder();
    const v = new Viewer(hub, { identity: person('ann', 1), tier: 'session' }, sink);
    await v.receive(encodeJSONFrame(FrameType.ATTACH, { id: 's1', channel: 2 }));
    draining = true;
    await v.receive(encodeFrame(FrameType.INPUT, encodeChannelData(2, Buffer.from('a'))));
    await v.receive(encodeFrame(FrameType.INPUT, encodeChannelData(2, Buffer.from('b'))));
    now += 5_000;
    await v.receive(encodeFrame(FrameType.INPUT, encodeChannelData(2, Buffer.from('c'))));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
    const notices = sink.frames().filter((f) => f.type === FrameType.NOTICE).map((f) => f.json);
    expect(notices).toEqual([{ channel: 2, code: 'draining' }, { channel: 2, code: 'draining' }]);
    await v.receive(encodeJSONFrame(FrameType.CREATE, { id: 's9', cols: 80, rows: 24 }));
    expect(sink.frames().at(-1)!.json).toMatchObject({ id: 's9', ok: false, error: 'draining: the workspace is restarting' });
    expect(broker.created).toEqual([]);
    broker.sessions.get('s1')!.handlers!.onNotice!('draining');
    expect(sink.frames().filter((f) => f.type === FrameType.NOTICE)).toHaveLength(3);
    draining = false;
    await v.receive(encodeFrame(FrameType.INPUT, encodeChannelData(2, Buffer.from('d'))));
    expect(broker.sessions.get('s1')!.inputs.map(String)).toEqual(['d']);
  });
});
```

If `sinkRecorder()` exposes decoded frames under another name (e.g. `decodeAll(sink.bytes())`), use that.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** In `attachHub.ts`:

```ts
/** One drain NOTICE per viewer channel per interval (D147). */
export const HUB_NOTICE_MS = 5_000;
export const DRAINING_CREATE_ERROR = 'draining: the workspace is restarting';
```

- `AttachHubOptions`: add `/** The workspace pod is draining (DrainGate): INPUT and CREATE are refused here. */ draining?: () => boolean;`.
- `AttachHub`: add `readonly draining: () => boolean;` and set `this.draining = opts.draining ?? (() => false);` in the constructor.
- `SessionTap.open()`: add `onNotice: (code) => { for (const [v, ch] of this.viewers) v.deliverNotice(ch, code); },` to the handlers.
- `Viewer`: add the field `private readonly noticedAt = new Map<number, number>();` and the methods:

```ts
  deliverNotice(channel: number, code: string): void {
    if (!this.closed) this.sink.send(encodeJSONFrame(FrameType.NOTICE, { channel, code }));
  }

  private refuseInput(channel: number): void {
    const t = this.hub.now();
    const last = this.noticedAt.get(channel);
    if (last !== undefined && t - last < HUB_NOTICE_MS) return;
    this.noticedAt.set(channel, t);
    this.deliverNotice(channel, 'draining');
  }
```

- `Viewer.handle`, in the `INPUT` case:

```ts
      case FrameType.INPUT: {
        const { channel, body } = decodeChannelData(payload);
        if (this.hub.draining()) return this.refuseInput(channel);
        this.channels.get(channel)?.input(body);
        return;
      }
```

- `Viewer.create`, as its first line after reading `id`:

```ts
    if (this.hub.draining()) return this.reply(FrameType.CREATED, { id, ok: false, error: DRAINING_CREATE_ERROR });
```

- [ ] **Step 4: Run them and watch them pass.** `npx vitest run src/host/attachHub.test.ts`.

- [ ] **Step 5: Commit.** `feat(fleet-host): refuse input and CREATE at the hub while the workspace drains`.

---

### Task 11: Host track v5, drain stores and `latestSessionOf`

**Files:**
- Modify: `src/host/hostSchema.ts`, `src/host/hostSchema.pg.test.ts`, `src/host/sessionOwners.ts`, `src/host/sessionOwners.pg.test.ts`, `vitest.pg.config.ts`
- Create: `src/host/drainStore.ts`, `src/host/drainStore.test.ts`, `src/host/drainStore.pg.test.ts`

**Interfaces:**
- Produces:
  - `HostDb.host_run_retries`, `HostDb.host_drained_sessions`.
  - `DrainStore`, `pgDrainStore(k)`, `memoryDrainStore()`.
  - Constants: `DRAINED_TTL_MS` = 24 h, `MAX_DRAINED_ROWS` = 200, `RETRY_MAX_AGE_MS` = 24 h.
  - `SessionOwnerStore.latestSessionOf(brokerSessionIds): Promise<Map<string, string>>`.

```ts
export interface PendingRetry { runId: string; automationId: string; createdAt: number }
export interface DrainedRow { instance: string; brokerSessionId: string; sessionId: string; reason: string | null }
export interface DrainStore {
  /** Queue one re-run; false when the run already has a row or is itself a re-run. */
  markRetry(runId: string, automationId: string, now: number): Promise<boolean>;
  /** Pending rows, moved to `started` (claim before start: at most once). */
  claimPending(now: number): Promise<PendingRetry[]>;
  settle(runId: string, o: { retryRunId: string } | { skipped: string }, now: number): Promise<void>;
  recordDrained(rows: DrainedRow[], now: number): Promise<void>;
  /** Newest row per broker session at or after `since`, newest first. */
  drained(since: number, limit: number): Promise<Array<{ brokerSessionId: string; sessionId: string; drainedAt: number }>>;
  prune(before: number): Promise<void>;
}
```

**Verifiable:**
- Locally: `npx vitest run src/host/drainStore.test.ts` (the memory store).
- Pg tests: against the private PG (`STORE_TEST_DIALECT=postgres PG_TEST_URL=… npx vitest run -c vitest.pg.config.ts src/host/drainStore.pg.test.ts src/host/hostSchema.pg.test.ts src/host/sessionOwners.pg.test.ts`), and in CI.

- [ ] **Step 1: Write the failing tests.** A shared contract, run against both stores:

`src/host/drainStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { memoryDrainStore, type DrainStore } from './drainStore.js';

export function drainStoreContract(name: string, make: () => Promise<DrainStore>, skip = false) {
  describe.skipIf(skip)(`${name} drain store`, () => {
    it('queues a run once, never a re-run, and claims each pending row once', async () => {
      const s = await make();
      expect(await s.markRetry('R1', 'A', 10)).toBe(true);
      expect(await s.markRetry('R1', 'A', 11)).toBe(false);
      const [a, b] = await Promise.all([s.claimPending(20), s.claimPending(20)]);
      expect([...a, ...b]).toEqual([{ runId: 'R1', automationId: 'A', createdAt: 10 }]);
      await s.settle('R1', { retryRunId: 'R2' }, 30);
      expect(await s.markRetry('R2', 'A', 40)).toBe(false);
      expect(await s.claimPending(50)).toEqual([]);
      expect(await s.markRetry('R3', 'A', 60)).toBe(true);
      await s.claimPending(61);
      await s.settle('R3', { skipped: 'the automation is disabled' }, 62);
      expect(await s.markRetry('R3', 'A', 63)).toBe(false);
    });

    it('keeps the newest drained row per broker session and prunes old ones', async () => {
      const s = await make();
      await s.recordDrained([{ instance: 'i1', brokerSessionId: 'tab1', sessionId: 'c1', reason: null }, { instance: 'i1', brokerSessionId: 'tab2', sessionId: 'c2', reason: 'drain-idle' }], 100);
      await s.recordDrained([{ instance: 'i1', brokerSessionId: 'tab2', sessionId: 'c2', reason: 'drain-idle' }], 150);
      await s.recordDrained([{ instance: 'i2', brokerSessionId: 'tab1', sessionId: 'c9', reason: null }], 200);
      expect(await s.drained(0, 10)).toEqual([
        { brokerSessionId: 'tab1', sessionId: 'c9', drainedAt: 200 },
        { brokerSessionId: 'tab2', sessionId: 'c2', drainedAt: 150 }
      ]);
      expect(await s.drained(160, 10)).toEqual([{ brokerSessionId: 'tab1', sessionId: 'c9', drainedAt: 200 }]);
      expect(await s.drained(0, 1)).toHaveLength(1);
      await s.prune(199);
      expect(await s.drained(0, 10)).toEqual([{ brokerSessionId: 'tab1', sessionId: 'c9', drainedAt: 200 }]);
    });
  });
}

drainStoreContract('memory', async () => memoryDrainStore());
```

`src/host/drainStore.pg.test.ts`:

```ts
import { afterEach } from 'vitest';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { pgDrainStore } from './drainStore.js';
import { drainStoreContract } from './drainStore.test.js';

let t: TestPg | null = null;
afterEach(async () => { await t?.drop(); t = null; });

drainStoreContract('postgres', async () => {
  t = await testPgSchema();
  await migratePostgres(postgresKysely<unknown>(t.pool), t.schema, HOST_TRACK);
  return pgDrainStore(postgresKysely<HostDb>(t.pool));
}, !isPg);
```

In `hostSchema.pg.test.ts`, change the expected host version from `4` to `5` and add:

```ts
  it('v5 adds the drain tables: one retry row per run, a unique re-run id, drained rows per instance', async () => {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await k.insertInto('host_run_retries').values({ run_id: 'R1', automation_id: 'A', state: 'started', retry_run_id: 'R2', created_at: 1, settled_at: null, note: null }).execute();
    await expect(k.insertInto('host_run_retries').values({ run_id: 'R3', automation_id: 'A', state: 'started', retry_run_id: 'R2', created_at: 1, settled_at: null, note: null }).execute()).rejects.toThrow(/unique/i);
    await expect(k.insertInto('host_run_retries').values({ run_id: 'R4', automation_id: 'A', state: 'bogus', retry_run_id: null, created_at: 1, settled_at: null, note: null }).execute()).rejects.toThrow(/check/i);
    await k.insertInto('host_drained_sessions').values({ instance: 'i', broker_session_id: 'tab', session_id: 'c', reason: null, drained_at: 1 }).execute();
    await expect(k.insertInto('host_drained_sessions').values({ instance: 'i', broker_session_id: 'tab', session_id: 'd', reason: null, drained_at: 2 }).execute()).rejects.toThrow(/duplicate|unique/i);
  });
```

Append to `sessionOwners.pg.test.ts`, using its rig (a migrated schema plus `sessionOwnerStore(() => k, WS)`):

```ts
  it('latestSessionOf maps each broker session to its newest claude session in the workspace', async () => {
    const { store } = await setup();
    const owner = { kind: 'user' as const, provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null };
    await store.record({ brokerSessionId: 'tab1', sessionId: 'c1', owner, startedAt: 100 });
    await store.record({ brokerSessionId: 'tab1', sessionId: 'c2', owner, startedAt: 200 });
    await store.record({ brokerSessionId: 'tab2', sessionId: 'c3', owner, startedAt: 150 });
    expect(await store.latestSessionOf(['tab1', 'tab2', 'tab3'])).toEqual(new Map([['tab1', 'c2'], ['tab2', 'c3']]));
    expect(await store.latestSessionOf([])).toEqual(new Map());
  });
```

Match the existing rig's `owner` shape (`SessionOwner` in `sessionOwners.ts`).

Add `'src/host/drainStore.pg.test.ts'` to `vitest.pg.config.ts`'s include list.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement the schema.** In `hostSchema.ts`, add to `HostDb`:

```ts
  host_run_retries: {
    run_id: string; automation_id: string; state: 'pending' | 'started' | 'skipped'; retry_run_id: string | null;
    created_at: number; settled_at: number | null; note: string | null;
  };
  host_drained_sessions: { instance: string; broker_session_id: string; session_id: string; reason: string | null; drained_at: number };
```

Then:

```ts
// Graceful drain (D150, D151): one re-run per cut-off automation run; interactive sessions to resume.
const HOST_DRAIN_V5 = `
CREATE TABLE host_run_retries (
  run_id TEXT COLLATE "C" PRIMARY KEY,
  automation_id TEXT COLLATE "C" NOT NULL,
  state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending', 'started', 'skipped')),
  retry_run_id TEXT COLLATE "C" UNIQUE,
  created_at BIGINT NOT NULL,
  settled_at BIGINT,
  note TEXT
);
CREATE TABLE host_drained_sessions (
  instance TEXT COLLATE "C" NOT NULL,
  broker_session_id TEXT COLLATE "C" NOT NULL,
  session_id TEXT COLLATE "C" NOT NULL,
  reason TEXT COLLATE "C",
  drained_at BIGINT NOT NULL,
  PRIMARY KEY (instance, broker_session_id)
);
CREATE INDEX idx_host_drained_sessions_at ON host_drained_sessions (drained_at);
`;
```

Append `{ version: 5, postgres: HOST_DRAIN_V5 }` to `HOST_TRACK.steps`.

- [ ] **Step 4: Implement the stores.** `src/host/drainStore.ts`:

```ts
// Graceful-drain bookkeeping on the holder's fenced host handle (D150, D151).
import { sql, type Kysely } from 'kysely';
import type { HostDb } from './hostSchema.js';

export const DRAINED_TTL_MS = 24 * 3_600_000;
export const MAX_DRAINED_ROWS = 200;
export const RETRY_MAX_AGE_MS = 24 * 3_600_000;
const NOTE_MAX = 200;

export interface PendingRetry { runId: string; automationId: string; createdAt: number }
export interface DrainedRow { instance: string; brokerSessionId: string; sessionId: string; reason: string | null }
export interface DrainStore {
  markRetry(runId: string, automationId: string, now: number): Promise<boolean>;
  claimPending(now: number): Promise<PendingRetry[]>;
  settle(runId: string, o: { retryRunId: string } | { skipped: string }, now: number): Promise<void>;
  recordDrained(rows: DrainedRow[], now: number): Promise<void>;
  drained(since: number, limit: number): Promise<Array<{ brokerSessionId: string; sessionId: string; drainedAt: number }>>;
  prune(before: number): Promise<void>;
}

const newestFirst = (a: { drainedAt: number }, b: { drainedAt: number }): number => b.drainedAt - a.drainedAt;

export function pgDrainStore(k: Kysely<HostDb>): DrainStore {
  return {
    async markRetry(runId, automationId, now) {
      const r = await sql<{ run_id: string }>`
        INSERT INTO host_run_retries (run_id, automation_id, state, created_at)
        SELECT ${runId}, ${automationId}, 'pending', ${now}
        WHERE NOT EXISTS (SELECT 1 FROM host_run_retries WHERE retry_run_id = ${runId})
        ON CONFLICT (run_id) DO NOTHING
        RETURNING run_id`.execute(k);
      return r.rows.length === 1;
    },
    async claimPending(now) {
      const r = await sql<{ run_id: string; automation_id: string; created_at: string | number }>`
        UPDATE host_run_retries SET state = 'started', settled_at = ${now}
        WHERE state = 'pending' RETURNING run_id, automation_id, created_at`.execute(k);
      return r.rows.map((x) => ({ runId: x.run_id, automationId: x.automation_id, createdAt: Number(x.created_at) }));
    },
    async settle(runId, o, now) {
      const set = 'retryRunId' in o ? { retry_run_id: o.retryRunId, settled_at: now } : { state: 'skipped' as const, note: o.skipped.slice(0, NOTE_MAX), settled_at: now };
      await k.updateTable('host_run_retries').set(set).where('run_id', '=', runId).execute();
    },
    async recordDrained(rows, now) {
      if (!rows.length) return;
      await k.insertInto('host_drained_sessions')
        .values(rows.map((r) => ({ instance: r.instance, broker_session_id: r.brokerSessionId, session_id: r.sessionId, reason: r.reason, drained_at: now })))
        .onConflict((oc) => oc.columns(['instance', 'broker_session_id']).doUpdateSet((eb) => ({
          session_id: eb.ref('excluded.session_id'), reason: eb.ref('excluded.reason'), drained_at: eb.ref('excluded.drained_at')
        })))
        .execute();
    },
    async drained(since, limit) {
      const r = await sql<{ broker_session_id: string; session_id: string; drained_at: string | number }>`
        SELECT * FROM (
          SELECT DISTINCT ON (broker_session_id) broker_session_id, session_id, drained_at
          FROM host_drained_sessions WHERE drained_at >= ${since}
          ORDER BY broker_session_id, drained_at DESC
        ) d ORDER BY drained_at DESC LIMIT ${limit}`.execute(k);
      return r.rows.map((x) => ({ brokerSessionId: x.broker_session_id, sessionId: x.session_id, drainedAt: Number(x.drained_at) }));
    },
    async prune(before) {
      await k.deleteFrom('host_drained_sessions').where('drained_at', '<', before).execute();
    }
  };
}

/** Without `db:`: one process, nothing survives a restart. */
export function memoryDrainStore(): DrainStore {
  const retries = new Map<string, { automationId: string; state: 'pending' | 'started' | 'skipped'; retryRunId: string | null; createdAt: number }>();
  const drainedRows = new Map<string, DrainedRow & { drainedAt: number }>();
  return {
    async markRetry(runId, automationId, now) {
      if (retries.has(runId) || [...retries.values()].some((r) => r.retryRunId === runId)) return false;
      retries.set(runId, { automationId, state: 'pending', retryRunId: null, createdAt: now });
      return true;
    },
    async claimPending() {
      const out: PendingRetry[] = [];
      for (const [runId, r] of retries) {
        if (r.state !== 'pending') continue;
        r.state = 'started';
        out.push({ runId, automationId: r.automationId, createdAt: r.createdAt });
      }
      return out;
    },
    async settle(runId, o) {
      const r = retries.get(runId);
      if (!r) return;
      if ('retryRunId' in o) r.retryRunId = o.retryRunId;
      else r.state = 'skipped';
    },
    async recordDrained(rows, now) {
      for (const r of rows) drainedRows.set(`${r.instance}\0${r.brokerSessionId}`, { ...r, drainedAt: now });
    },
    async drained(since, limit) {
      const best = new Map<string, { brokerSessionId: string; sessionId: string; drainedAt: number }>();
      for (const r of drainedRows.values()) {
        if (r.drainedAt < since) continue;
        const cur = best.get(r.brokerSessionId);
        if (!cur || r.drainedAt > cur.drainedAt) best.set(r.brokerSessionId, { brokerSessionId: r.brokerSessionId, sessionId: r.sessionId, drainedAt: r.drainedAt });
      }
      return [...best.values()].sort(newestFirst).slice(0, limit);
    },
    async prune(before) {
      for (const [key, r] of drainedRows) if (r.drainedAt < before) drainedRows.delete(key);
    }
  };
}
```

- [ ] **Step 5: Implement `latestSessionOf`.** In `sessionOwners.ts`, add to the interface:

```ts
  /** broker session id → the claude session of its newest owner row in this workspace. */
  latestSessionOf(brokerSessionIds: readonly string[]): Promise<Map<string, string>>;
```

In `sessionOwnerStore` (import `sql` from `kysely` if it isn't imported):

```ts
    async latestSessionOf(ids) {
      const out = new Map<string, string>();
      if (!ids.length) return out;
      const r = await sql<{ broker_session_id: string; session_id: string }>`
        SELECT DISTINCT ON (broker_session_id) broker_session_id, session_id FROM session_owners
        WHERE workspace_id = ${workspaceId} AND broker_session_id IN (${sql.join([...ids])})
        ORDER BY broker_session_id, started_at DESC, session_id`.execute(k());
      for (const row of r.rows) out.set(row.broker_session_id, row.session_id);
      return out;
    },
```

- [ ] **Step 6: Run the tests and watch them pass.** Memory store locally; the pg tests against the private PG.

- [ ] **Step 7: Commit.** `feat(fleet-host): host track v5 drain tables and stores`.

---

### Task 12: Shared automations: pause, `retryOf`, interrupted fresh steps

**Files:**
- Modify: `src/main/automations/automationService.ts`, `src/main/automations/runner.ts`, `src/main/automations/automationStore.ts`, `src/preload/inboxTypes.ts`
- Test: `src/main/automations/automationService.test.ts`, `src/main/automations/runner.test.ts`, `src/main/automations/automationStore.test.ts`

**Interfaces:**
- Produces:
  - `AutomationDeps.paused?(): string | null`.
  - `RunRequest.retryOf?: string`; `RunRow['trigger'].retryOf?: string`.
  - `RunnerDeps.freshState` may return `'interrupted'`.
  - `HOST_RESTART_ERROR = 'interrupted by host restart'` (exported from `runner.ts`).
  - `APP_QUIT_MID_RUN = 'the app quit mid-run'`.
  - `AutomationStore.noteInterrupted(id, error): Promise<boolean>`.
  - `PAUSE_RETRY_MS` = 30000.
- The desktop passes no `paused` and never returns `interrupted`, so its behaviour is unchanged.

**Verifiable:** locally, `npx vitest run src/main/automations/` (SQLite unit tests). Run `npm run test:unit:pg` for the store change on Postgres.

- [ ] **Step 1: Write the failing tests.**

`runner.test.ts`: reuse its `deps()` helper and fresh-step definition:

```ts
it('a fresh step whose session the drain cut off is interrupted by host restart, not succeeded', async () => {
  const d = deps({ freshState: async () => 'interrupted' as const });
  const out = await executeRun(d, freshAutomation, run, { callerSupplied: false });
  expect(out).toEqual({ status: 'interrupted', error: 'review: interrupted by host restart' });
  expect(d.store.finishStep).toHaveBeenCalledWith(expect.any(Number), 'interrupted', { error: 'interrupted by host restart' }, expect.any(Number));
});
```

Use the step id of the test file's fresh fixture in place of `review`.

`automationService.test.ts`: reuse its service rig (fake timers, a schedule automation, an event automation):

```ts
describe('paused (fleet-host draining)', () => {
  it('skips the tick without consuming the slot, re-arms event debounces, refuses manual starts', async () => {
    let paused: string | null = "the workspace is restarting; try again when it's back";
    const { svc, store, clock, timers } = rig({ paused: () => paused });
    const a = await createScheduled(svc, '*/5 * * * *');
    clock.set(atNextSlot(a));
    expect(await svc.tick()).toEqual([]);
    expect((await store.get(a.id))!.lastScheduledAt).toBeNull();
    await expect(svc.run(a.id, { kind: 'manual', by: { kind: 'user', id: 'ann' } }))
      .rejects.toThrow(`${a.name} can't start now: the workspace is restarting; try again when it's back`);
    const e = await createEventTriggered(svc);
    await svc.onEvent({ on: 'todo.created', todo: { id: 't', title: 'x', tags: [], source: { kind: 'user', id: null } } });
    timers.fire(120_000);
    expect(timers.pending()).toContainEqual(expect.objectContaining({ ms: 30_000 }));
    expect(await store.runs(e.id, 5)).toEqual([]);
    paused = null;
    timers.fire(30_000);
    await svc.settle();
    expect(await store.runs(e.id, 5)).toHaveLength(1);
    expect((await svc.tick()).map((r) => r.automationId)).toEqual([a.id]);
  });

  it('a retry carries retryOf, skips the per-minute cap, and keeps the original args', async () => {
    const { svc } = rig({});
    const a = await createScheduled(svc, '*/5 * * * *');
    const first = await svc.run(a.id, { kind: 'schedule', args: {} });
    await svc.settle();
    const again = await svc.run(a.id, { kind: 'schedule', args: {}, retryOf: first.id });
    expect(again.status).toBe('running');
    expect(again.trigger).toMatchObject({ kind: 'schedule', retryOf: first.id });
  });
});
```

`rig`, `createScheduled`, `createEventTriggered`, `atNextSlot` and `timers` stand for the existing test file's helpers; add thin wrappers where a helper is missing. Their contracts: `timers.fire(ms)` runs the pending timers of that delay; `timers.pending()` lists `{ ms }`.

`automationStore.test.ts`:

```ts
it('noteInterrupted rewrites only an interrupted run\'s error', async () => {
  const { store, a } = await withAutomation();
  const r = await store.startRun(a, { kind: 'manual' }, {}, 'running', 1);
  await store.markInterrupted(2);
  expect((await store.getRun(r.id))!.error).toBe(APP_QUIT_MID_RUN);
  expect(await store.noteInterrupted(r.id, 'interrupted by host restart')).toBe(true);
  expect((await store.getRun(r.id))!.error).toBe('interrupted by host restart');
  const ok = await store.startRun(a, { kind: 'manual' }, {}, 'succeeded', 3);
  expect(await store.noteInterrupted(ok.id, 'x')).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.**

`src/preload/inboxTypes.ts`: in `RunRow['trigger']`, add `retryOf?: string;` (comment: `/** The run this one re-runs after a host restart (D150). */`).

`automationStore.ts`:

```ts
export const APP_QUIT_MID_RUN = 'the app quit mid-run';
```

Use it in `markInterrupted` (in place of the literal), and add:

```ts
  /** Rewrites the reason of a run already recorded `interrupted`; false otherwise. */
  async noteInterrupted(id: string, error: string): Promise<boolean> {
    const r = await this.db.updateTable('runs').set({ error }).where('id', '=', id).where('status', '=', 'interrupted').executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }
```

`runner.ts`:

```ts
export const HOST_RESTART_ERROR = 'interrupted by host restart';
```

Widen `freshState`'s return type to `Promise<'alive' | 'ended' | 'missing' | 'interrupted'>`. In `waitFresh`:

```ts
    const st = await deps.freshState(ws, sessionId);
    if (st === 'interrupted') throw new StepError(HOST_RESTART_ERROR, 'interrupted');
    if (st !== 'alive') return;
```

`automationService.ts`:
- Add to `AutomationDeps`: `/** Why runs may not start now (fleet-host: the workspace pod is draining); null runs them. */ paused?(): string | null;`.
- Add `PAUSE_RETRY_MS`, a new error class and a `RunRequest` field:

```ts
export const PAUSE_RETRY_MS = 30_000;

/** The runtime is paused; timer callers try again later. */
class PausedError extends Error {
  constructor(name: string, reason: string) { super(`${name} can't start now: ${reason}`); }
}
```

```ts
  /** Re-run of this run after a host restart (D150): skips the per-minute cap. */
  retryOf?: string;
```

In `start()`:
- after the `refused` check, add: `const paused = deps.paused?.(); if (paused) throw new PausedError(a.name, paused);`;
- build the trigger with `...(req.retryOf ? { retryOf: req.retryOf } : {})`;
- change the rate check to `if (!userManual && !req.retryOf && last !== undefined && now - last < RATE_MS && !running)`.

In `tickOnce()`, add as the first line: `if (deps.paused?.()) return [];`.

In `onEvent`'s timer callback, factor the start into a re-armable function:

```ts
        const fire = (): void => {
          const fired = pending.get(a.id);
          if (!fired) return;
          if (deps.paused?.()) {
            fired.timer = setTimer(fire, PAUSE_RETRY_MS);
            return;
          }
          pending.delete(a.id);
          const p = (async () => {
            try {
              await start(a.id, { kind: 'event', event: fired.event });
            } catch (err) {
              if (err instanceof DisabledError) return;
              if (err instanceof RefusedError) throw err;
              const cur = await store.get(a.id);
              if (cur) await failedStart(cur, { kind: 'event', event: fired.event }, (err as Error).message);
            }
            deps.changed();
          })().catch((err) => deps.onError?.(err));
          track(p);
        };
        pending.set(a.id, { event, timer: setTimer(fire, ms) });
```

`PausedError` thrown from the MCP and RPC paths reaches the caller as its message.

- [ ] **Step 4: Run them and watch them pass.** `npx vitest run src/main/automations/`. Also run `npx vitest run src/main/federation/remoteAutomationRows.test.ts`: it must be unchanged, because `retryOf` isn't copied into desktop rows.

- [ ] **Step 5: Commit.** `feat(automations): pause hook, retryOf, interrupted fresh steps`.

---

### Task 13: Host automations and the holder's drain hooks (re-run once, drained sessions, `sessions:drained`)

**Files:**
- Modify: `src/host/hostAutomations.ts`, `src/host/holder.ts`
- Create: `src/host/hostDrain.ts`, `src/host/hostDrain.test.ts`, `src/host/drainRpc.ts`, `src/host/drainRpc.test.ts`
- Test: `src/host/hostAutomations.test.ts`, `src/host/hostAutomations.pg.test.ts`

**Interfaces:**
- Consumes: Tasks 9, 11 and 12.
- Produces:
  - `HostAutomationsOptions.gate?: Pick<DrainGate, 'phase' | 'last' | 'ended' | 'waitServing'>`.
  - `HostAutomationsOptions.stepWaitMs?`.
  - `STEP_WAIT_MS` = 45 min; `RESTARTING` text.
  - `startHostAutomations` returns `store`.
  - `startHostDrain(d: HostDrainDeps): { stop(): Promise<void>; idle(): Promise<void> }`.
  - `freshRunId(sessionId): string | null`.
  - `drainRpcChannels(drains: () => DrainStore | null, o: { db: boolean; now?: () => number })`.
  - `HolderOptions.gate?`; `Holder.drains: DrainStore`.

```ts
export interface HostDrainDeps {
  gate: Pick<DrainGate, 'phase' | 'subscribe'>;
  drains: DrainStore;
  automations: Pick<HostAutomations, 'automations' | 'store'>;
  owners: Pick<SessionOwnerStore, 'latestSessionOf'>;
  log: Logger;
  now?: () => number;
  pruneEveryMs?: number;
}
```

**Verifiable:**
- Locally: `npx vitest run src/host/hostDrain.test.ts src/host/drainRpc.test.ts src/host/hostAutomations.test.ts` (memory stores and fakes).
- The pg idempotency test runs against the private PG and in CI.

- [ ] **Step 1: Write the failing tests.**

`src/host/hostDrain.test.ts`. It drives a real automation runtime over SQLite stores. Reuse `hostAutomations.test.ts`'s rig, which builds `startHostAutomations` over an in-memory inbox store with `fakeBroker`; export it from that file as `hostAutomationsRig` if it isn't already exported.

```ts
import { describe, expect, it } from 'vitest';
import type { BrokerState } from '../main/broker.js';
import type { GatePhase } from './drainGate.js';
import { memoryDrainStore } from './drainStore.js';
import { freshRunId, startHostDrain } from './hostDrain.js';
import { createLogger } from './log.js';
import { hostAutomationsRig } from './hostAutomations.test.js';

function fakeGate(initial: GatePhase = 'serving') {
  let phase = initial;
  const subs = new Set<(p: GatePhase, s: BrokerState | null) => void>();
  return {
    phase: () => phase,
    subscribe: (fn: (p: GatePhase, s: BrokerState | null) => void) => { subs.add(fn); return () => subs.delete(fn); },
    push(p: GatePhase, s: BrokerState | null) { phase = p; for (const fn of [...subs]) fn(p, s); }
  };
}
const owners = (m: Record<string, string>) => ({ latestSessionOf: async (ids: readonly string[]) => new Map(ids.filter((i) => m[i]).map((i) => [i, m[i]])) });

describe('freshRunId', () => {
  it('parses auto-<ULID>-<step> only', () => {
    expect(freshRunId('auto-01JC0000000000000000000000-review')).toBe('01JC0000000000000000000000');
    expect(freshRunId('tab-1')).toBeNull();
    expect(freshRunId('auto-short-review')).toBeNull();
  });
});

describe('host drain hooks', () => {
  it('queues one re-run for a drain-cut fresh step and starts it once when the new broker serves', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const run = await r.runtime.automations.run(a.id, { kind: 'manual', by: { kind: 'user', id: 'ann' } });
    const sid = `auto-${run.id}-review`;
    await r.untilCreated(sid);
    const gate = fakeGate();
    const drains = memoryDrainStore();
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: createLogger(() => undefined) });
    r.gate.cut(sid, 'drain-interrupted');
    gate.push('draining', { instance: 'i1', phase: 'draining', sessions: [{ id: sid, alive: false, headless: true, ended: 'drain-interrupted' }] });
    await r.runtime.automations.settle();
    await h.idle();
    const cut = await r.runtime.store.getRun(run.id);
    expect(cut).toMatchObject({ status: 'interrupted', error: 'review: interrupted by host restart' });
    gate.push('serving', { instance: 'i2', phase: 'serving', sessions: [] });
    await h.idle();
    gate.push('draining', { instance: 'i2', phase: 'draining', sessions: [] });
    gate.push('serving', { instance: 'i3', phase: 'serving', sessions: [] });
    await h.idle();
    const runs = await r.runtime.store.runs(a.id, 10);
    const retries = runs.filter((x) => x.trigger.retryOf === run.id);
    expect(retries).toHaveLength(1);
    await h.stop();
  });

  it('never re-runs a re-run, and skips a stale, finished or disabled original', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const drains = memoryDrainStore();
    const gate = fakeGate('draining');
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: createLogger(() => undefined), now: () => 10 });
    const done = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'succeeded', 1);
    gate.push('draining', { instance: 'i1', phase: 'draining', sessions: [{ id: `auto-${done.id}-review`, alive: false, headless: true, ended: 'drain-killed' }] });
    const retry = await r.runtime.store.startRun(a.raw, { kind: 'manual', retryOf: 'X' }, {}, 'interrupted', 2);
    gate.push('draining', { instance: 'i1', phase: 'draining', sessions: [{ id: `auto-${retry.id}-review`, alive: false, headless: true, ended: 'drain-killed' }] });
    await h.idle();
    gate.push('serving', { instance: 'i2', phase: 'serving', sessions: [] });
    await h.idle();
    const runs = await r.runtime.store.runs(a.id, 10);
    expect(runs.some((x) => x.trigger.retryOf === done.id)).toBe(false);
    expect(runs.some((x) => x.trigger.retryOf === retry.id)).toBe(false);
    await h.stop();
  });

  it('records drained interactive sessions (not auto-, mapped through owners) while draining', async () => {
    const r = await hostAutomationsRig();
    const drains = memoryDrainStore();
    const gate = fakeGate();
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({ tab1: 'c1', tab2: 'c2' }), log: createLogger(() => undefined), now: () => 500 });
    gate.push('serving', { instance: 'i1', phase: 'serving', sessions: [{ id: 'tab1', alive: true }] });
    await h.idle();
    expect(await drains.drained(0, 10)).toEqual([]);
    gate.push('draining', { instance: 'i1', phase: 'draining', sessions: [
      { id: 'tab1', alive: true }, { id: 'tab2', alive: false, ended: 'drain-idle' }, { id: 'tab3', alive: false, ended: 'exit' },
      { id: 'auto-01JC0000000000000000000000-review', alive: true, headless: true }, { id: 'tab4', alive: true }
    ] });
    await h.idle();
    expect((await drains.drained(0, 10)).map((x) => [x.brokerSessionId, x.sessionId]).sort()).toEqual([['tab1', 'c1'], ['tab2', 'c2']]);
    await h.stop();
  });
});
```

The rig's contract:
- `createFreshAutomation(stepId)` creates and enables a host-config automation with one `mode: fresh` step on `$self`, and returns `{ id, raw: AutomationRecord }`.
- `untilCreated(id)` waits for `fakeBroker.created` to contain the id.
- `gate` is the `fakeGate`-like object passed to `startHostAutomations` as `gate`; `gate.cut(id, reason)` records `ended(id) = reason`.
- `runtime` is the `startHostAutomations` result.

Add these helpers to `hostAutomations.test.ts`.

In `hostAutomations.test.ts`, add:

```ts
it('while the workspace drains: no ticks or manual starts; a fresh step waits for serving and is created headless', async () => {
  const r = await hostAutomationsRig({ phase: 'draining' });
  const a = await r.createFreshAutomation('review');
  await expect(r.runtime.automations.run(a.id, { kind: 'manual', by: { kind: 'user', id: 'ann' } }))
    .rejects.toThrow("can't start now: the workspace is restarting; try again when it's back");
  r.gate.setPhase('serving');
  const run = await r.runtime.automations.run(a.id, { kind: 'manual', by: { kind: 'user', id: 'ann' } });
  await r.untilCreated(`auto-${run.id}-review`);
  expect(r.broker.created.at(-1)).toMatchObject({ headless: true });
});

it('freshState: drain-cut → interrupted; exit → ended; vanished with an old instance → interrupted', async () => {
  const r = await hostAutomationsRig();
  const fs = r.deps.freshState!;
  r.gate.cut('auto-A-s', 'drain-killed');
  expect(await fs('ws', 'auto-A-s')).toBe('interrupted');
  r.gate.cut('auto-B-s', 'exit');
  expect(await fs('ws', 'auto-B-s')).toBe('ended');
  r.spawnedOn('auto-C-s', 'i1');
  r.gate.setLast({ instance: 'i2', phase: 'serving', sessions: [] });
  expect(await fs('ws', 'auto-C-s')).toBe('interrupted');
  r.gate.setPhase('unknown');
  expect(await fs('ws', 'auto-D-s')).toBe('alive');
});
```

`r.deps` is the deps object `startHostAutomations` built (exposed through the test-only `onDeps` hook, added below), and `r.spawnedOn` writes to the spawned-instance map through the same hook.

`src/host/drainRpc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { memoryDrainStore } from './drainStore.js';
import { drainRpcChannels } from './drainRpc.js';
import { RpcUnavailableError } from './rpc.js';

const caller = { identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier: 'read' } as const;

describe('sessions:drained', () => {
  it('is read tier, last 24 h, newest first; empty without db; 503 with db and no holder', async () => {
    const s = memoryDrainStore();
    await s.recordDrained([{ instance: 'i', brokerSessionId: 'tab1', sessionId: 'c1', reason: null }], 1_000);
    await s.recordDrained([{ instance: 'i', brokerSessionId: 'tab2', sessionId: 'c2', reason: null }], 90_000_000);
    const ch = drainRpcChannels(() => s, { db: true, now: () => 90_000_000 }).get('sessions:drained')!;
    expect(ch.tier).toBe('read');
    expect(await ch.handle([], caller as never)).toEqual({ rows: [{ brokerSessionId: 'tab2', sessionId: 'c2', drainedAt: 90_000_000 }] });
    expect(await drainRpcChannels(() => null, { db: false }).get('sessions:drained')!.handle([], caller as never)).toEqual({ rows: [] });
    await expect(drainRpcChannels(() => null, { db: true }).get('sessions:drained')!.handle([], caller as never)).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});
```

`hostAutomations.pg.test.ts`: add the cross-holder idempotency case.

```ts
it('two holders on one store re-run a drain-cut run exactly once', async () => {
  const { k, runtime, drains, store, automation } = await pgHostRig();   // existing pg rig + pgDrainStore(k)
  const run = await store.startRun(automation, { kind: 'manual' }, {}, 'interrupted', 1, 'review: interrupted by host restart');
  expect(await drains.markRetry(run.id, automation.id, 2)).toBe(true);
  const [a, b] = await Promise.all([drains.claimPending(3), pgDrainStore(k).claimPending(3)]);
  expect(a.length + b.length).toBe(1);
  expect(await drains.markRetry(run.id, automation.id, 4)).toBe(false);
  void runtime;
});
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement the host automations changes.** In `hostAutomations.ts`:

```ts
import { DRAIN_CUT_REASONS } from '../main/broker.js';
import type { DrainGate } from './drainGate.js';
```

```ts
/** A fresh step queued behind a drain waits at most this long for the new pod (D149). */
export const STEP_WAIT_MS = 45 * 60_000;
export const RESTARTING = "the workspace is restarting; try again when it's back";
```

Add to `HostAutomationsOptions`:

```ts
  /** The workspace pod's drain (D148); absent: never paused. */
  gate?: Pick<DrainGate, 'phase' | 'last' | 'ended' | 'waitServing'>;
  stepWaitMs?: number;
  /** Tests: the service deps and the spawned-instance map. */
  onDeps?: (deps: Parameters<typeof createAutomationService>[0], spawnedOn: Map<string, string | null>) => void;
```

In `startHostAutomations`, before `createAutomationService`:

```ts
  /** Fresh session id → the broker instance it was created on. */
  const spawnedOn = new Map<string, string | null>();
  const open = (): boolean => !o.gate || o.gate.phase() === 'serving' || o.gate.phase() === 'legacy';
```

Then build the deps object as a `const deps = { … }`, passed to `createAutomationService(deps)` and `o.onDeps?.(deps, spawnedOn)`, with these changes:

```ts
    busy: () => false,
    paused: () => (open() ? null : RESTARTING),
    spawnFresh: async (_ws, sessionId, args) => {
      if (o.gate && !(await o.gate.waitServing(o.stepWaitMs ?? STEP_WAIT_MS))) throw new Error('the workspace is still restarting');
      const claudeId = randomUUID();
      const argv = freshArgv(args, o.mcpArgs, claudeId);
      // A write transaction runs the lease fence. A takeover after it still starts this one session; its run's next write fails.
      await o.inbox.kysely.transaction().execute(async () => undefined);
      const recorded = (await o.owners?.record({ brokerSessionId: sessionId, sessionId: claudeId, owner: automationOwner(o.workspace().id), startedAt: now() })) ?? false;
      const r = await o.ops.create(sessionId, 120, 40, argv, { headless: true });
      if (!r.ok) {
        if (recorded) await o.owners?.release?.(sessionId, claudeId).catch(warn('session owner release failed'));
        throw new Error(`could not start a fresh session: ${r.error ?? 'unknown broker error'}`);
      }
      spawnedOn.set(sessionId, o.gate?.last()?.instance ?? null);
    },
    // Never `ended` for a session the drain cut off: the runner would record success (D150).
    freshState: async (_ws, sessionId) => {
      const how = o.gate?.ended(sessionId);
      if (how) return DRAIN_CUT_REASONS.has(how) ? 'interrupted' : 'ended';
      const last = o.gate?.last();
      const on = spawnedOn.get(sessionId);
      if (last && on && last.instance !== on) return 'interrupted';
      if (last?.sessions.some((x) => x.id === sessionId && x.alive)) return 'alive';
      if (!open()) return 'alive';
      const s = (await o.ops.list()).find((x) => x.id === sessionId);
      if (!s) return 'missing';
      return s.alive ? 'alive' : DRAIN_CUT_REASONS.has(s.ended ?? '') ? 'interrupted' : 'ended';
    },
```

In `closeFresh`, add `spawnedOn.delete(sessionId);` after the attach-and-close. In the returned object, add `store,`.

- [ ] **Step 4: Implement the drain hooks.** `src/host/hostDrain.ts`:

```ts
// The holder's side of a workspace-pod drain (SPEC §7 *Workspace pod drain*): queue one re-run per
// drain-cut fresh step (D150, D156), record the interactive sessions to resume (D151), dispatch re-runs
// once the new broker serves. Work is serialized; a failure is logged and the next event retries.
import { DRAIN_CUT_REASONS, type BrokerState } from '../main/broker.js';
import { APP_QUIT_MID_RUN } from '../main/automations/automationStore.js';
import { HOST_RESTART_ERROR } from '../main/automations/runner.js';
import { isOpen, type DrainGate, type GatePhase } from './drainGate.js';
import { DRAINED_TTL_MS, RETRY_MAX_AGE_MS, type DrainStore } from './drainStore.js';
import type { HostAutomations } from './hostAutomations.js';
import type { Logger } from './log.js';
import type { SessionOwnerStore } from './sessionOwners.js';

const FRESH_RE = /^auto-([0-9A-HJKMNP-TV-Z]{26})-[A-Za-z0-9_-]+$/;
const PRUNE_EVERY_MS = 3_600_000;
const SEEN_MAX = 5_000;

export function freshRunId(sessionId: string): string | null {
  return FRESH_RE.exec(sessionId)?.[1] ?? null;
}

export interface HostDrainDeps {
  gate: Pick<DrainGate, 'phase' | 'subscribe'>;
  drains: DrainStore;
  automations: Pick<HostAutomations, 'automations' | 'store'>;
  owners: Pick<SessionOwnerStore, 'latestSessionOf'>;
  log: Logger;
  now?: () => number;
  pruneEveryMs?: number;
}

export function startHostDrain(d: HostDrainDeps): { stop(): Promise<void>; idle(): Promise<void> } {
  const now = d.now ?? Date.now;
  const store = d.automations.store;
  const seenCut = new Set<string>();
  const seenDrained = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let wasOpen = isOpen(d.gate.phase());
  const enqueue = (what: string, fn: () => Promise<void>): void => {
    chain = chain.then(() => (stopped ? undefined : fn())).catch((err: Error) => d.log.log('warn', 'drain bookkeeping failed', { what, error: err.message }));
  };
  const bounded = (s: Set<string>, key: string): void => {
    s.add(key);
    if (s.size > SEEN_MAX) s.delete(s.values().next().value as string);
  };

  async function noteCuts(s: BrokerState): Promise<void> {
    for (const x of s.sessions) {
      if (!x.ended || !DRAIN_CUT_REASONS.has(x.ended) || seenCut.has(x.id)) continue;
      bounded(seenCut, x.id);
      const runId = freshRunId(x.id);
      if (!runId) continue;
      const run = await store.getRun(runId);
      if (!run || run.trigger.retryOf) continue;
      if (await d.drains.markRetry(runId, run.automationId, now())) d.log.log('info', 'automation run will re-run after the restart', { runId });
      if (run.status === 'interrupted' && run.error === APP_QUIT_MID_RUN) await store.noteInterrupted(runId, HOST_RESTART_ERROR);
    }
  }

  async function recordDrained(s: BrokerState): Promise<void> {
    const want = s.sessions.filter((x) => !x.headless && !freshRunId(x.id) && (x.alive || (x.ended?.startsWith('drain-') ?? false)));
    const fresh = want.filter((x) => !seenDrained.has(`${s.instance}\0${x.id}\0${x.ended ?? ''}`));
    if (!fresh.length) return;
    const map = await d.owners.latestSessionOf(fresh.map((x) => x.id));
    const rows = fresh.flatMap((x) => {
      const sessionId = map.get(x.id);
      return sessionId ? [{ instance: s.instance, brokerSessionId: x.id, sessionId, reason: x.ended ?? null }] : [];
    });
    await d.drains.recordDrained(rows, now());
    for (const x of fresh) bounded(seenDrained, `${s.instance}\0${x.id}\0${x.ended ?? ''}`);
  }

  async function dispatch(): Promise<void> {
    for (const p of await d.drains.claimPending(now())) {
      const run = await store.getRun(p.runId);
      const a = run ? await store.get(run.automationId) : null;
      const why = !run ? 'the run is gone'
        : run.status !== 'interrupted' ? `the run is ${run.status}`
        : !a ? 'the automation is gone'
        : !a.enabled ? 'the automation is disabled'
        : now() - p.createdAt > RETRY_MAX_AGE_MS ? 'older than 24 h'
        : null;
      if (why || !run || !a) {
        await d.drains.settle(p.runId, { skipped: why ?? 'unknown' }, now());
        d.log.log('info', 'automation re-run skipped', { runId: p.runId, why });
        continue;
      }
      try {
        const t = run.trigger;
        const next = await d.automations.automations.run(a.id, {
          kind: t.kind, ...(t.by ? { by: t.by } : {}), ...(t.cron ? { cron: t.cron } : {}), ...(t.event ? { event: t.event } : {}),
          args: run.args, callerSupplied: t.by?.kind === 'workspace', retryOf: run.id
        });
        await d.drains.settle(p.runId, { retryRunId: next.id }, now());
        d.log.log('info', 'automation re-run started', { runId: p.runId, retryRunId: next.id });
      } catch (err) {
        await d.drains.settle(p.runId, { skipped: (err as Error).message }, now());
        d.log.log('warn', 'automation re-run refused', { runId: p.runId, error: (err as Error).message });
      }
    }
  }

  const onGate = (phase: GatePhase, s: BrokerState | null): void => {
    if (s) enqueue('cuts', () => noteCuts(s));
    if (s && phase === 'draining') enqueue('drained', () => recordDrained(s));
    const open = isOpen(phase);
    if (open && !wasOpen) enqueue('dispatch', dispatch);
    wasOpen = open;
  };
  const off = d.gate.subscribe(onGate);
  const prune = (): void => enqueue('prune', () => d.drains.prune(now() - DRAINED_TTL_MS));
  prune();
  if (wasOpen) enqueue('dispatch', dispatch);
  const timer = setInterval(prune, d.pruneEveryMs ?? PRUNE_EVERY_MS);
  timer.unref?.();
  return {
    idle: () => chain,
    async stop() {
      stopped = true;
      off();
      clearInterval(timer);
      await chain;
    }
  };
}
```

`src/host/drainRpc.ts`:

```ts
// sessions:drained (D151): the interactive sessions a drain closed, for desktops to resume.
import { DRAINED_TTL_MS, MAX_DRAINED_ROWS, type DrainStore } from './drainStore.js';
import { RpcUnavailableError, type RpcChannel } from './rpc.js';

export function drainRpcChannels(drains: () => DrainStore | null, o: { db: boolean; now?: () => number }): Map<string, RpcChannel> {
  return new Map<string, RpcChannel>([[
    'sessions:drained',
    {
      tier: 'read',
      handle: async () => {
        if (!o.db) return { rows: [] };
        const d = drains();
        if (!d) throw new RpcUnavailableError('sessions unavailable');
        return { rows: await d.drained((o.now ?? Date.now)() - DRAINED_TTL_MS, MAX_DRAINED_ROWS) };
      }
    }
  ]]);
}
```

If `RpcChannel.handle` has a different signature in `rpc.ts`, match it; the channel ignores its args.

- [ ] **Step 5: Wire the holder.** In `holder.ts`:
- `HolderOptions`: add `/** The workspace pod's drain (D148). */ gate?: DrainGate;`.
- `Holder`: add `drains: DrainStore;`.
- After `ledgerK`: `const drains = pgDrainStore(ledgerK);` (the same fenced `HostDb` handle as the ledger).
- Declare `let drainHooks: { stop(): Promise<void> } | null = null;`.
- In `stopAll`, before `await automations?.stop();`: `await drainHooks?.stop();`.
- Pass `gate: o.gate` to `startHostAutomations({ … })`. After `await automations.reconcile(o.automations());`:

```ts
    if (o.gate) drainHooks = startHostDrain({ gate: o.gate, drains, automations, owners, log: o.log });
```

- Return `drains,` in the holder object.

- [ ] **Step 6: Run the tests and watch them pass.** `npx vitest run src/host/` locally; the pg file against the private PG.

- [ ] **Step 7: Commit.** `feat(fleet-host): pause automations while draining, re-run cut runs once, record drained sessions`.

---

### Task 14: fleet-host wiring, `/healthz` draining and the 20 s shutdown deadline

**Files:**
- Modify: `src/host/main.ts`, `src/host/server.ts`
- Test: `src/host/main.test.ts`

**Interfaces:**
- Consumes: Tasks 9, 10 and 13.
- Produces:
  - `SHUTDOWN_DEADLINE_MS` = 20000.
  - `RunHostOptions.shutdownDeadlineMs?`.
  - `HostServerDeps.draining?(): boolean`.
  - `/healthz` → 503 `{status: "draining", …}` from the first moment of `shutdown()`.
  - `sessions:drained` is registered.

**Verifiable:** locally, `npx vitest run src/host/main.test.ts src/host/server.test.ts`.

- [ ] **Step 1: Write the failing tests.** Append to `main.test.ts`:

```ts
it('SIGTERM marks /healthz draining at once', async () => {
  let release!: () => void;
  const stuck = new Promise<void>((r) => (release = r));
  const r = await start(CONFIG, { leaseStore: { ...memoryLeaseStore(), release: () => stuck } as LeaseStore });
  r.proc.emit('SIGTERM');
  const h = await fetch(`${r.url}/healthz`);
  expect(h.status).toBe(503);
  expect(await h.json()).toMatchObject({ status: 'draining' });
  release();
});

it('the shutdown deadline exits once even if a step hangs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const hang = new Promise<void>(() => undefined);
    const r = await start(CONFIG, { leaseStore: { ...memoryLeaseStore(), release: () => hang } as LeaseStore, shutdownDeadlineMs: 20_000 });
    r.proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(r.logs.some((l) => l.includes('shutdown deadline passed; exiting'))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('broker:drain reaches a new /events subscriber first', async () => {
  const r = await start();
  r.broker.pushState({ instance: 'i1', phase: 'draining', softAt: 10, hardAt: 20, sessions: [] });
  const ws = new WebSocket(`${r.url.replace('http', 'ws')}/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const first = await new Promise<string>((res) => ws.once('message', (d) => res(String(d))));
  expect(JSON.parse(first)).toEqual({ channel: 'broker:drain', payload: { phase: 'draining', softAt: 10, hardAt: 20, instance: 'i1' } });
  ws.close();
});
```

If the `memoryLeaseStore()` object can't be spread, wrap its methods explicitly. `start()` uses `fakeBroker(['s1'])`, which now has `watch` (Task 9).

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** In `server.ts`:
- Add to `HostServerDeps`: `/** SIGTERM received: /healthz answers 503 draining (D154). */ draining?(): boolean;`.
- In the `/healthz` branch:

```ts
        const status = deps.draining?.() ? 'draining' : deps.starting?.() ? 'starting' : deps.healthy() ? 'ok' : 'unhealthy';
```

In `main.ts`:

```ts
/** The whole SIGTERM path, inside the host pod's 45 s grace after its 5 s preStop (D154). */
export const SHUTDOWN_DEADLINE_MS = 20_000;
```

- `RunHostOptions`: add `shutdownDeadlineMs?: number;`.
- Wrap `exit` once, right after it is defined:

```ts
  const exitRaw = opts.exit ?? ((code: number) => process.exit(code));
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitRaw(code);
  };
```

- Create the event hub and gate before the hub. Move `const events = new EventHub();` above `const hub = new AttachHub(…)`, then:

```ts
  const gate = startDrainGate({ ops, log, events });
```

- Pass `draining: () => gate.phase() === 'draining'` to the `AttachHub` options.
- Declare `let draining = false;` near `let stopping`, and add `draining: () => draining,` to the `createHostServer` deps.
- Register `...drainRpcChannels(() => holderNow?.drains ?? null, { db: !!config.db }),` in the `rpc` map.
- Pass `gate` to `startHolder({ … })`.
- In `shutdown(code)`, make the first statements inside the IIFE:

```ts
      draining = true;
      const deadline = setTimeout(() => {
        log.log('warn', 'shutdown deadline passed; exiting', { ms: opts.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS });
        uninstallGuards();
        exit(code);
      }, opts.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS);
      deadline.unref?.();
```

  Then add `gate.stop();` next to `clearInterval(pruner);`, and `clearTimeout(deadline);` before the final `if (!fatal) exit(code);`.

- [ ] **Step 4: Run them and watch them pass.** `npx vitest run src/host/`.
  - Every host test must pass. Fakes without `watch` give a `legacy` gate, which never pauses.
  - Every `/events` subscriber now gets the sticky `broker:drain` frame first. Existing tests that take the first `/events` message must skip it, with a helper that waits for a named channel.

- [ ] **Step 5: Commit.** `feat(fleet-host): healthz draining, 20 s shutdown deadline, drain gate wiring`.

---

### Task 15: Desktop main: drain relay, IPC, resume through `sessions:drained`, NOTICE line

**Files:**
- Create: `src/main/remoteDrain.ts`, `src/main/remoteDrain.test.ts`
- Modify: `src/main/federation/summaryRelay.ts` (+ test), `src/main/remoteAttach.ts` (+ test), `src/main/remote.ts`, `src/main/remoteIpc.ts` (+ test), `src/main/ipc.ts`, `src/preload/remoteTypes.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: Tasks 8, 13 and 14 (the wire).
- Produces:
  - `RemoteDrain { phase: 'serving' | 'draining' | 'unknown'; softAt: number | null; hardAt: number | null; instance: string | null }` (in `remoteTypes.ts`).
  - `parseDrainEvent(p: unknown): RemoteDrain | null`.
  - `createDrainRelay(send)`, with `update(origin, payload)`, `snapshot()` and `forget(origin)`.
  - `SummaryRelayDeps.onDrain?(origin, payload)`.
  - IPC: the `remote:drain` push (`{ workspaceId, drain }`) and `remote:drainStates` (invoke → `Record<workspaceId, RemoteDrain>`).
  - Preload: `window.api.remote.onDrain(cb)` and `window.api.remote.drainStates()`.
  - `RemoteAttachOptions.drained?: () => Promise<Array<{ brokerSessionId: string; sessionId: string }>>`.
  - `fetchDrained(client)` in `remoteAttach.ts`.
  - `DRAIN_NOTICE_TEXT`.

**Verifiable:** locally, `npx vitest run src/main/remoteDrain.test.ts src/main/federation/summaryRelay.test.ts src/main/remoteAttach.test.ts src/main/remoteIpc.test.ts`, plus both typecheck configs.

- [ ] **Step 1: Write the failing tests.**

`src/main/remoteDrain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDrainRelay, parseDrainEvent } from './remoteDrain.js';

describe('broker:drain from a host', () => {
  it('accepts only the documented shape', () => {
    expect(parseDrainEvent({ phase: 'draining', softAt: 10, hardAt: 20, instance: 'abc' })).toEqual({ phase: 'draining', softAt: 10, hardAt: 20, instance: 'abc' });
    expect(parseDrainEvent({ phase: 'serving', softAt: null, hardAt: null, instance: null })).toEqual({ phase: 'serving', softAt: null, hardAt: null, instance: null });
    for (const bad of [null, {}, { phase: 'done', softAt: null, hardAt: null, instance: null }, { phase: 'draining', softAt: -1, hardAt: null, instance: null },
      { phase: 'draining', softAt: 1.5, hardAt: null, instance: null }, { phase: 'serving', softAt: null, hardAt: null, instance: 'x'.repeat(33) },
      { phase: 'serving', softAt: null, hardAt: null, instance: 'a\nb' }]) {
      expect(parseDrainEvent(bad)).toBeNull();
    }
  });

  it('pushes changes only and keeps a snapshot per host', () => {
    const sent: unknown[] = [];
    const r = createDrainRelay((u) => sent.push(u));
    r.update('W1', { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' });
    r.update('W1', { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' });
    r.update('W1', { phase: 'bogus' });
    r.update('W2', { phase: 'serving', softAt: null, hardAt: null, instance: 'j' });
    expect(sent).toHaveLength(2);
    expect(r.snapshot()).toEqual({ W1: { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' }, W2: { phase: 'serving', softAt: null, hardAt: null, instance: 'j' } });
    r.forget('W1');
    expect(Object.keys(r.snapshot())).toEqual(['W2']);
  });
});
```

`summaryRelay.test.ts` (reuse its fake `subscribe`, which captures `onEvent`):

```ts
it('hands broker:drain payloads to onDrain', () => {
  const drains: Array<[string, unknown]> = [];
  const { relay, emit } = relayRig({ onDrain: (o, p) => drains.push([o, p]) });
  relay.sync();
  emit('W1', { channel: 'broker:drain', payload: { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' } });
  expect(drains).toEqual([['W1', { phase: 'draining', softAt: 1, hardAt: 2, instance: 'i' }]]);
});
```

`remoteAttach.test.ts` (reuses `rig`):

```ts
it('resumes a drained session with its claude id under the same broker id', async () => {
  const { broker, client } = await rig([]);
  const h = await attachRemotePty({
    client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true,
    drained: async () => [{ brokerSessionId: 'tab1', sessionId: '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a' }]
  });
  expect(broker.created[0]).toMatchObject({ id: 'tab1' });
  expect(broker.created[0].args).toContain('--resume');
  expect(broker.created[0].args).toContain('0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a');
  h.detach();
});

it('attaches instead when another viewer resumed first', async () => {
  const { broker, client } = await rig([]);
  const realCreate = broker.ops.create;
  broker.ops.create = async (id, c, r, args, opts) => { await realCreate(id, c, r, args, opts); return { ok: false, error: 'session: id already in use' }; };
  const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => [] });
  expect(broker.sessions.get('tab1')!.handlers).not.toBeNull();
  h.detach();
});

it('a failed drained lookup never starts a fresh claude', async () => {
  const { broker, client } = await rig([]);
  await expect(attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => { throw new Error('503'); } }))
    .rejects.toThrow('The host is starting; reopen this tab in a moment.');
  expect(broker.created).toEqual([]);
});

it('prints the fixed notice when the host drops input', async () => {
  const { broker, client } = await rig(['s1']);
  const h = await attachRemotePty({ client: client(OWNER), sessionId: 's1', cols: 80, rows: 24, canCreate: true });
  const out = collect(h);
  await expect.poll(() => broker.sessions.get('s1')!.handlers !== null).toBe(true);
  broker.sessions.get('s1')!.handlers!.onNotice!('draining');
  await expect.poll(() => out.text()).toContain("[host is restarting; your input wasn't sent]");
  h.detach();
});
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement the relay.**

`src/preload/remoteTypes.ts`:

```ts
/** A remote host's view of its workspace pod (`broker:drain`, D152). Times are epoch ms. */
export interface RemoteDrain {
  phase: 'serving' | 'draining' | 'unknown';
  softAt: number | null;
  hardAt: number | null;
  instance: string | null;
}
```

`src/main/remoteDrain.ts`:

```ts
// `broker:drain` from a host's /events (D152): validated, deduplicated, kept per host for the renderer.
import type { RemoteDrain } from '../preload/remoteTypes.js';

const PHASES = new Set(['serving', 'draining', 'unknown']);
const INSTANCE_RE = /^[\x21-\x7e]{1,32}$/;
const ms = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

export function parseDrainEvent(p: unknown): RemoteDrain | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.phase !== 'string' || !PHASES.has(o.phase) || !ms(o.softAt) || !ms(o.hardAt)) return null;
  if (o.instance !== null && (typeof o.instance !== 'string' || !INSTANCE_RE.test(o.instance))) return null;
  return { phase: o.phase as RemoteDrain['phase'], softAt: o.softAt, hardAt: o.hardAt, instance: o.instance };
}

export function createDrainRelay(send: (u: { workspaceId: string; drain: RemoteDrain }) => void) {
  const states = new Map<string, RemoteDrain>();
  return {
    update(origin: string, payload: unknown): void {
      const d = parseDrainEvent(payload);
      if (!d) return;
      const prev = states.get(origin);
      if (prev && prev.phase === d.phase && prev.softAt === d.softAt && prev.hardAt === d.hardAt && prev.instance === d.instance) return;
      states.set(origin, d);
      send({ workspaceId: origin, drain: d });
    },
    snapshot(): Record<string, RemoteDrain> {
      return Object.fromEntries(states);
    },
    forget(origin: string): void {
      states.delete(origin);
    }
  };
}
```

`summaryRelay.ts`:
- Add `/** A host's broker:drain payload (unvalidated). */ onDrain?(origin: string, payload: unknown): void;` to `SummaryRelayDeps`.
- In the event callback, after the `REMOTE_CHANGE_CHANNELS` line: `if (e.channel === 'broker:drain') d.onDrain?.(id, e.payload);`.

`ipc.ts`, next to `summaryRelay`:

```ts
const drainRelay = createDrainRelay((u) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send('remote:drain', u); } catch { /* mid-teardown */ }
  }
});
```

Pass `onDrain: (origin, payload) => drainRelay.update(origin, payload),` to `createSummaryRelay`, and `drainStates: () => drainRelay.snapshot(),` to `registerRemoteIpc`. A removed bookmark's entry stays in the snapshot; no pane renders it, so it is harmless (`forget` is there for tests and a later cleanup).

`remoteIpc.ts`:
- Add `'remote:drainStates'` to `REMOTE_CHANNELS`.
- Add `/** Last broker:drain per remote workspace (D152). */ drainStates?(): Record<string, RemoteDrain>;` to `RemoteIpcDeps`.
- Add `ipc.handle('remote:drainStates', async () => deps.drainStates?.() ?? {});`.
- Update `remoteIpc.test.ts`'s channel-list assertion.

`src/preload/index.ts`, in `remote`:

```ts
    /** Last known drain state per remote workspace. */
    drainStates: (): Promise<Record<string, RemoteDrain>> => ipcRenderer.invoke('remote:drainStates'),
    /** A remote workspace pod started or finished restarting (D152). */
    onDrain: (cb: (u: { workspaceId: string; drain: RemoteDrain }) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, u: { workspaceId: string; drain: RemoteDrain }) => cb(u);
      ipcRenderer.on('remote:drain', h);
      return () => ipcRenderer.removeListener('remote:drain', h);
    },
```

Export `RemoteDrain` from the preload's type re-export line.

- [ ] **Step 4: Implement the attach changes.** In `remoteAttach.ts`:

```ts
export const DRAIN_NOTICE_TEXT = "[host is restarting; your input wasn't sent]";
const HOST_STARTING = 'The host is starting; reopen this tab in a moment.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DRAINED = 200;

/** The host's drained sessions (D151); an older host without the channel has none. */
export async function fetchDrained(client: RemoteClient): Promise<Array<{ brokerSessionId: string; sessionId: string }>> {
  try {
    const r = await client.rpc<{ rows?: unknown }>('sessions:drained', []);
    const rows = Array.isArray(r?.rows) ? r.rows.slice(0, MAX_DRAINED) : [];
    return rows.flatMap((x) => {
      const o = x as { brokerSessionId?: unknown; sessionId?: unknown } | null;
      return o && typeof o.brokerSessionId === 'string' && typeof o.sessionId === 'string' && UUID_RE.test(o.sessionId)
        ? [{ brokerSessionId: o.brokerSessionId, sessionId: o.sessionId }] : [];
    });
  } catch (err) {
    if (err instanceof RemoteError && err.status === 404) return [];
    throw err;
  }
}
```

Add to `RemoteAttachOptions`:

```ts
  /** Drained-session lookup for a missing session (D151); absent: none. */
  drained?: () => Promise<Array<{ brokerSessionId: string; sessionId: string }>>;
```

In `attachRemotePty`, after `const stream = brokerPtyStream(…)`:

```ts
  broker.on('notice', (ch: number) => {
    if (ch === CHANNEL && !stream.destroyed && !stream.readableEnded) stream.push(Buffer.from(`\r\n\x1b[33m${DRAIN_NOTICE_TEXT}\x1b[0m\r\n`));
  });
```

Replace the `no such session` branch:

```ts
  if (!r.ok && /no such session/i.test(r.error ?? '')) {
    if (!o.canCreate) fail('This session is not running on the host, and your tier cannot start one');
    let resumeOf = o.resumeOf;
    if (!resumeOf && o.drained) {
      const rows = await o.drained().catch(() => null);
      if (rows === null) fail(HOST_STARTING);
      resumeOf = rows!.find((x) => x.brokerSessionId === o.sessionId)?.sessionId;
    }
    const created = await step(broker.createSession(o.sessionId, o.cols, o.rows, claudeCreateArgs(resumeOf, resumeOf ? undefined : randomUUID())));
    if (!created.ok && !/id already in use/i.test(created.error ?? '')) fail(`host refused to start the session: ${await hostSays(created.error)}`);
    r = await step(broker.attachSession(o.sessionId, CHANNEL));
  }
```

In `remote.ts` `attachPty`:

```ts
      const client = clientFor(spec.remote.url);
      return attachRemotePty({ client, sessionId, cols, rows, resumeOf, canCreate: who.tier === 'session', drained: () => fetchDrained(client) });
```

`fail` throws, so `rows!` is safe after it. If the linter objects to the non-null assertion, restructure with an `if (rows === null) return fail(…)` wrapper.

- [ ] **Step 5: Run the tests and watch them pass.** Then run both typecheck configs.

- [ ] **Step 6: Commit.** `feat(desktop): relay remote drains, resume drained sessions, show the input notice`.

---

### Task 16: Renderer: restarting chip, read-only tabs, banner, auto-resume

**Files:**
- Modify: `src/renderer/src/remoteView.ts` (+ `remoteView.test.ts`), `src/renderer/src/components/WorkspaceTabStrip.tsx`, `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/components/TerminalSession.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 15 (`RemoteDrain`, `remote.onDrain`, `remote.drainStates`).
- Produces:
  - `remoteChip(w, drain?)`, with a new phase `'restarting'`.
  - `paneRules(t, drain?)`, with a new field `restarting`.
  - `drainBanner(d, now, fmt)`.
  - `drainEnded(prev, next)`.
  - `TerminalSession` props `restarting?: boolean` and `resumeToken?: number | null`.
  - `TerminalPane` prop `drain?: RemoteDrain | null`.
  - `WorkspaceTabStrip` prop `drains`.

**Verifiable:**
- Locally: `npx vitest run src/renderer/src/remoteView.test.ts`, both typecheck configs, and `npm run build` where the env allows it.
- The UI itself is checked by eye on the host (spec Appendix B step 2).

- [ ] **Step 1: Write the failing tests.** Append to `remoteView.test.ts`:

```ts
import { drainBanner, drainEnded, paneRules, remoteChip } from './remoteView';

const draining = { phase: 'draining' as const, softAt: 1_000, hardAt: 2_000, instance: 'i' };
const serving = { phase: 'serving' as const, softAt: null, hardAt: null, instance: 'j' };
const unknown = { phase: 'unknown' as const, softAt: null, hardAt: null, instance: null };

describe('drain view', () => {
  it('chip', () => {
    const w = { kind: 'remote', state: 'running' };
    expect(remoteChip(w, draining)).toEqual({ phase: 'restarting', sub: 'restarting · input paused' });
    expect(remoteChip(w, unknown)).toEqual({ phase: 'restarting', sub: 'waiting for the workspace pod' });
    expect(remoteChip(w, serving)).toEqual({ phase: 'live', sub: null });
    expect(remoteChip({ kind: 'container', state: 'running' }, draining)).toBeNull();
  });

  it('pane rules: read-only and no new tabs while restarting', () => {
    expect(paneRules('session', draining)).toEqual({ remote: true, readOnly: true, canNew: false, defaultTab: true, restarting: true });
    expect(paneRules('session', serving)).toEqual({ remote: true, readOnly: false, canNew: true, defaultTab: true, restarting: false });
    expect(paneRules(undefined, draining)).toEqual({ remote: false, readOnly: false, canNew: true, defaultTab: true, restarting: false });
  });

  it('banner text by phase and deadline', () => {
    const fmt = (ms: number) => `T${ms}`;
    expect(drainBanner(serving, 0, fmt)).toBeNull();
    expect(drainBanner(unknown, 0, fmt)).toBe('Waiting for the workspace pod…');
    expect(drainBanner(draining, 500, fmt)).toBe('The host is restarting. Running turns finish first (until T1000); idle sessions close now. Typing is paused. Tabs resume on their own when the host is back.');
    expect(drainBanner(draining, 1_000, fmt)).toBe('The host is restarting. Stopping turns that are still running.');
  });

  it('a drain ends when a restarting host serves again', () => {
    expect(drainEnded(draining, serving)).toBe(true);
    expect(drainEnded(unknown, serving)).toBe(true);
    expect(drainEnded(serving, serving)).toBe(false);
    expect(drainEnded(null, serving)).toBe(false);
    expect(drainEnded(draining, unknown)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement the helpers.** In `remoteView.ts`, import `RemoteDrain` from the preload types, then:

```ts
export interface RemoteChip {
  phase: 'live' | 'checking' | 'unreachable' | 'restarting';
  /** Replaces the chip's sub-line, or null to keep the normal activity text. */
  sub: string | null;
}

const restarting = (d: RemoteDrain | null | undefined): boolean => d?.phase === 'draining' || d?.phase === 'unknown';

export function remoteChip(w: { kind: string; state: string; status?: string }, drain?: RemoteDrain | null): RemoteChip | null {
  if (w.kind !== 'remote') return null;
  if (w.state !== 'unreachable') {
    if (drain?.phase === 'draining') return { phase: 'restarting', sub: 'restarting · input paused' };
    if (drain?.phase === 'unknown') return { phase: 'restarting', sub: 'waiting for the workspace pod' };
    return { phase: 'live', sub: null };
  }
  if (w.status === CHECKING_STATUS) return { phase: 'checking', sub: 'checking host…' };
  return { phase: 'unreachable', sub: 'host unreachable' };
}

export interface PaneRules {
  remote: boolean;
  /** Keystrokes are dropped; the host drops them too. */
  readOnly: boolean;
  canNew: boolean;
  /** An empty inventory (or closing the last tab) gets a fresh tab; creating one would fail below `session`. */
  defaultTab: boolean;
  /** The workspace pod is restarting (D152). */
  restarting: boolean;
}

export function paneRules(t: RemoteTier | null | undefined, drain?: RemoteDrain | null): PaneRules {
  if (t === undefined) return { remote: false, readOnly: false, canNew: true, defaultTab: true, restarting: false };
  const canNew = canStartSessions(t);
  const r = restarting(drain);
  return { remote: true, readOnly: !canType(t) || r, canNew: canNew && !r, defaultTab: canNew, restarting: r };
}

export function drainBanner(d: RemoteDrain | null | undefined, now: number, fmt: (ms: number) => string): string | null {
  if (!d || d.phase === 'serving') return null;
  if (d.phase === 'unknown') return 'Waiting for the workspace pod…';
  if (d.softAt !== null && now >= d.softAt) return 'The host is restarting. Stopping turns that are still running.';
  const until = d.softAt !== null ? ` (until ${fmt(d.softAt)})` : '';
  return `The host is restarting. Running turns finish first${until}; idle sessions close now. Typing is paused. Tabs resume on their own when the host is back.`;
}

/** The restart is over: re-attach the tabs that ended during it. */
export function drainEnded(prev: RemoteDrain | null | undefined, next: RemoteDrain | null | undefined): boolean {
  return restarting(prev) && next?.phase === 'serving';
}
```

Update the existing `paneRules` assertions in `remoteView.test.ts` to include `restarting: false`.

- [ ] **Step 4: Wire `TerminalSession`.**
- Props: `restarting?: boolean;` (doc: `The workspace pod is restarting: a session that ends now shows the restarting card (D152).`) and `resumeToken?: number | null;` (doc: `Bumped when the restart is over; a tab that ended during it re-attaches.`).
- Refs: `const restartingRef = useRef(restarting); restartingRef.current = restarting;` and `const endedInDrainRef = useRef(false);`.
- Widen `endedReason`'s type with `| { kind: 'restarting' }`.
- In the `pty.onEnd` handler, replace `setEndedReason({ kind: 'natural' });` with:

```ts
            if (restartingRef.current) {
              endedInDrainRef.current = true;
              setEndedReason({ kind: 'restarting' });
            } else {
              setEndedReason({ kind: 'natural' });
            }
```

- Add an effect after the reload effect:

```ts
  useEffect(() => {
    if (resumeToken == null || !endedInDrainRef.current) return;
    endedInDrainRef.current = false;
    // Attach finds no session; main resumes it from the host's drained list (D151).
    setSessionEpoch((e) => e + 1);
  }, [resumeToken]);
```

- Add an overlay next to the `natural` one:

```tsx
        {endedReason?.kind === 'restarting' && (
          <div className="session-ended-overlay" role="status" aria-label="Waiting for the host">
            <div className="session-ended-card restarting">
              <div className="session-ended-title">waiting for the host to restart</div>
              <div className="session-ended-help">This tab resumes by itself when the host is back.</div>
            </div>
          </div>
        )}
```

- [ ] **Step 5: Wire `TerminalPane`.**
- Add the prop `drain?: RemoteDrain | null;`.
- Change `const rules = paneRules(remoteTier, drain);`. In the `remoteTierRef` inventory check, keep `paneRules(remoteTierRef.current)`: no drain there, because `defaultTab` ignores it.
- Add:

```ts
  const [resumeToken, setResumeToken] = useState<number | null>(null);
  const prevDrainRef = useRef(drain);
  useEffect(() => {
    if (drainEnded(prevDrainRef.current, drain)) setResumeToken((t) => (t ?? 0) + 1);
    prevDrainRef.current = drain;
  }, [drain]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!rules.restarting) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [rules.restarting]);
  const banner = drainBanner(drain, now, (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
```

- Render the banner above the terminal area, where `restartBanner` renders:

```tsx
      {banner && (
        <div className="drain-banner" role="status">{banner}</div>
      )}
```

- In the tab name, show a `paused` tag while restarting, in place of `watching`:

```tsx
                  {rules.readOnly && (
                    <span className="session-tab-watching" title={rules.restarting ? 'The host is restarting; typing is paused' : tierTitle(remoteTier)}>
                      {rules.restarting ? 'paused' : 'watching'}
                    </span>
                  )}
```

- Pass `restarting={rules.restarting}` and `resumeToken={resumeToken}` to each `TerminalSession`.

- [ ] **Step 6: Wire `App` and the chip strip.** In `App.tsx`:

```ts
  const [drains, setDrains] = useState<Record<string, RemoteDrain>>({});
  useEffect(() => {
    void window.api.remote.drainStates().then(setDrains).catch(() => undefined);
    return window.api.remote.onDrain((u) => setDrains((p) => ({ ...p, [u.workspaceId]: u.drain })));
  }, []);
```

- Pass `drain={w.kind === 'remote' ? drains[w.id] ?? null : null}` to `TerminalPane`.
- Pass `drains={drains}` to `WorkspaceTabStrip`.

In `WorkspaceTabStrip.tsx`:
- Add the prop `drains: Record<string, RemoteDrain>`.
- Change the call to `const rc = remoteChip(w, drains[w.id]);`.
- Add `rc?.phase === 'restarting' ? 'restarting' : ''` to the chip-group class list.
- Where the chip renders its sub-line from `rc?.sub`, nothing changes: the restarting phase already provides `sub`.

`styles.css`:

```css
.drain-banner { padding: 6px 12px; background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); font-size: 12px; }
.ws-chip-group.restarting .ws-chip-sub { color: var(--warn); }
.session-ended-card.restarting .session-ended-title { color: var(--warn); }
```

If the sub-line's class name differs, use the existing one.

- [ ] **Step 7: Run the tests and watch them pass.** `npx vitest run src/renderer/src/remoteView.test.ts`, then `npx tsc --noEmit -p tsconfig.web.json` and `npx tsc --noEmit -p tsconfig.node.json`.

- [ ] **Step 8: Commit.** `feat(renderer): restarting chip, paused tabs, drain banner, auto-resume`.

---

### Task 17: SPEC.md and the full gate

**Files:**
- Modify: `docs/SPEC.md`

**Verifiable:**
- Locally: `npm run test:unit`, `cd broker && go test -race ./...`, `bash docker/host/fleet-host-entry.test.sh`, and both typecheck configs.
- CI: the image tests and the pg suite.
- Cluster: Work runs spec Appendix B.

- [ ] **Step 1: Update SPEC.md in place.** Describe the current state, with no history.
- **§4 *Host images*, *Supervision*, `workspace`:** add "exports `CLAUDE_FLEET_BROKER_DRAIN=1` (the control socket and SIGTERM drain, §7 *Workspace pod drain*)".
- **§4 *Broker transport in the workspace pod*:** the control socket `/run/broker/ctl.sock` (0600, only with `CLAUDE_FLEET_BROKER_DRAIN=1`); `broker drain` / `broker ready`.
- **§5 *Broker frame protocol*:**
  - add the rows `STATUS 0x1a`, `STATE 0x1b`, `WATCH 0x1c`, `DRAIN 0x1d` (control socket only), `NOTICE 0x1e`;
  - `CREATE.headless`, `SESSIONS[].ended`;
  - `ENDED.reason` ∈ `exit | drain-idle | drain-interrupted | drain-killed`.
- **§7 *Remote host*, a new subsection *Workspace pod drain*** (after *Shutdown and crashes*):
  - the trigger (D142, D143);
  - the phases and passes (D146);
  - busy and idle from the status file (D144);
  - headless sessions (D145);
  - the input freeze (D147);
  - the env table (D153);
  - the sentence: **"A session's in-progress turn is lost only if it is still running at the soft deadline (Esc / SIGINT) or the hard stop; otherwise it finishes, and the tab resumes it on the new pod."**
- **§7 *Env contract*:** the drain variables (workspace pod).
- **§7 *Health*:** `draining`.
- **§7 *Shutdown and crashes*:** the 20 s deadline, the preStop sleep, grace 45 (D154).
- **§7 *Host automations*:** pausing (D149), `interrupted by host restart`, the single re-run (D150, D156).
- **§7 *Host store*:** host track v5.
- **§7 *Routes*:** `sessions:drained`.
- **§7 */events*:** `broker:drain` (sticky).
- **§7 *`/attach`*:** the hub refuses `INPUT` (NOTICE) and `CREATE` while draining.
- **§8:** a new flow, *Remote workspace restarting* (D151, D152): chip, banner, paused tabs, the restarting card, auto-resume, the `id already in use` → attach path, the tier rule.
- **§9:** the control socket's reach (local only; sessions can drain their own pod, which equals killing the broker), `DRAIN` refused on :7070, `broker:drain` validated on the desktop.
- **§11 *Remote host: what remains*:**
  - replace the *Graceful drain (approved, not built)* entry with the cluster checks (native sidecars, routing to a terminating pod with `publishNotReadyAddresses`, the SIGINT exit status of `claude -p`);
  - add the gap "a host that can't reach a draining pod re-runs nothing it couldn't see end".

- [ ] **Step 2: Run the full gate.** `npm run test:unit`; `cd broker && go test -race ./...`; `bash docker/host/fleet-host-entry.test.sh`; `npx tsc --noEmit -p tsconfig.node.json`; `npx tsc --noEmit -p tsconfig.web.json`. Run `npm run build` where the env allows it (memory notes say `@xterm` addons may block it here; CI builds it).

- [ ] **Step 3: Commit and open the PR.** In the PR body, say that the UI and the cluster behaviour are verified on the host and the cluster, and link the spec's Appendix B for Work (platform-ops#36).

---

## Self-review

**Spec coverage:**
- Trigger, preStop and the control socket: Tasks 5, 6, 7 (D142, D143).
- Freeze input and CREATE: Task 5 (broker), Task 10 (hub), Task 15 (NOTICE text) (D147).
- fleet-host learns about the drain: Task 9 (D148).
- Automations stop dispatching: Tasks 12, 13 (D149).
- The desktop shows "restarting" with read-only tabs: Tasks 15, 16 (D152).
- Waiting for idle (status file; headless counts as busy): Tasks 2, 3, 4 (D144, D145).
- Soft and hard deadlines; headless SIGINT; interrupted runs: Tasks 2, 4, 12, 13 (D146, D150).
- Pod values: spec Appendix A; timings as operator settings: Task 6 (D153).
- Re-run once, no double post, no loop: Tasks 11, 12, 13 (D150).
- Interactive auto-resume: Tasks 11, 13, 15, 16 (D151).
- Host pod (a)–(d): Task 14 and the spec appendix (D154, D155).
- Host restart during a drain: D156; `freshState` and `noteCuts` in Task 13.
- SPEC.md: Task 17. This PR adds the §11 open-decision entry.

**Placeholder scan:** every step names exact files and carries the code. Four places adapt to existing test rigs instead of restating them:
- `hostAutomationsRig` (Task 13): its contract is stated;
- `relayRig` (Task 15);
- the `attachHub` sink helpers (Task 10);
- the automation-service helpers (Task 12).

Each of these says what the helper must do.

**Type consistency:**
- `BrokerState`/`DrainPhase` (Task 8) feed `DrainGate` (Task 9), `hostDrain` (Task 13) and `freshState` (Task 13).
- `DRAIN_CUT_REASONS` (Task 8) is used by Task 13.
- `RemoteDrain` (Task 15) is used by Task 16.
- `HOST_RESTART_ERROR`/`APP_QUIT_MID_RUN` (Task 12) are used by Task 13.
- `DrainStore` (Task 11) is used by Tasks 13 and 14.
- The Go `session.Reason*` strings equal the TS literals in `DRAIN_CUT_REASONS` and in `hostDrain`'s `drain-` prefix check.

**Risks called out:**
- Routing to a terminating pod (D155) and `claude -p`'s SIGINT exit status (D145) are cluster checks. Neither can be proven in this environment.
- `/events` tests that read the first frame: `broker:drain` is now sent first to every subscriber (Task 9), so adjust any existing test that assumes the first frame is `sessions:changed`.
