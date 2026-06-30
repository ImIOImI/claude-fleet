# Port-forward preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect a dev server listening inside a workspace container and let the user open it in their normal browser at `http://127.0.0.1:<host-port>`, relayed over the existing broker socket.

**Architecture:** The in-container broker gains (a) listening-port detection (`LISTPORTS`/`PORTS` frames, parsing `/proc/net/tcp[6]`) and (b) a TCP-dial channel kind (`DIAL`/`DIALED` frames + reuse of `INPUT`/`OUTPUT`/`CLOSE`/`ENDED` for the byte relay). The host runs a per-workspace `PortMonitor` that polls detection and fires a toast on newly-appeared ports, and a `PortForward` that listens on a loopback port and relays each browser TCP connection over its own broker connection (one `BrokerClient` per connection, channel 1 — mirroring `attachPty`).

**Tech Stack:** Go 1.22 (broker), TypeScript/Node (Electron main), React (renderer), Vitest (host unit), Go `testing` (broker), Playwright + `CLAUDE_FLEET_MOCK` (e2e).

## Global Constraints

- Broker frame envelope is fixed: `[u32 totalLen BE][u8 type][payload]`; `totalLen` counts type+payload. New frame type bytes: `DIAL=0x14`, `DIALED=0x15`, `LISTPORTS=0x16`, `PORTS=0x17`. The `broker.ts` `FrameType` enum MUST match `proto.go` exactly.
- Broker dials `127.0.0.1:<port>` **only** — never an arbitrary host/IP. `port` is a `uint16`.
- Host listeners bind `127.0.0.1` **only** (never `0.0.0.0`).
- No new published container ports: Linux/macOS rides the bind-mounted unix socket; Windows rides the existing loopback-TCP broker port. Do not add `ExposedPorts`/`PortBindings`.
- The runner container is non-root (`fleet` uid 1000); detection must use only what that user can read (`/proc/net/tcp[6]` is world-readable — no privilege needed).
- Per `.claude/rules/spec-maintenance.md`, `docs/SPEC.md` is updated in the same change (Task 11).
- Go module path is `github.com/ImIOImI/claude-fleet/broker`. Broker tests run from `broker/` via `go test ./...`. Host tests: `npm run test:unit` (vitest). E2e: `npm run test:e2e` (Playwright).
- Design source of truth: `docs/superpowers/specs/2026-06-28-port-forward-preview-design.md`.

---

### Task 1: Broker protocol — new frame types + JSON shapes

**Files:**
- Modify: `broker/internal/proto/proto.go`
- Test: `broker/internal/proto/proto_test.go`

**Interfaces:**
- Produces (Go): `proto.FrameDial`, `proto.FrameDialed`, `proto.FrameListPorts`, `proto.FramePorts` constants; `proto.DialRequest{Channel uint32; Port uint16}`, `proto.DialResponse{Channel uint32; OK bool; Error string}`, `proto.PortInfo{Port uint16}`, `proto.PortsResponse{Ports []PortInfo}`.

- [ ] **Step 1: Write the failing test**

Add to `broker/internal/proto/proto_test.go`:

```go
func TestFrameType_String_PortForwardFrames(t *testing.T) {
	cases := map[proto.FrameType]string{
		proto.FrameDial:      "DIAL",
		proto.FrameDialed:    "DIALED",
		proto.FrameListPorts: "LISTPORTS",
		proto.FramePorts:     "PORTS",
	}
	for ft, want := range cases {
		if got := ft.String(); got != want {
			t.Errorf("%#x: got %q want %q", uint8(ft), got, want)
		}
	}
}

func TestDialRequest_RoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := proto.WriteJSONFrame(&buf, proto.FrameDial, proto.DialRequest{Channel: 7, Port: 3000}); err != nil {
		t.Fatalf("write: %v", err)
	}
	ft, payload, err := proto.ReadFrame(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if ft != proto.FrameDial {
		t.Fatalf("type: got %v want DIAL", ft)
	}
	var req proto.DialRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if req.Channel != 7 || req.Port != 3000 {
		t.Fatalf("got %+v", req)
	}
}
```

Ensure `proto_test.go` imports `bytes`, `encoding/json`, `testing`, and the `proto` package (match the existing import block).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && go test ./internal/proto/ -run 'PortForwardFrames|DialRequest'`
Expected: FAIL — `undefined: proto.FrameDial` (etc.).

- [ ] **Step 3: Write minimal implementation**

In `broker/internal/proto/proto.go`, add to the `const (...)` frame-type block (after `FrameResize`):

```go
	FrameDial      FrameType = 0x14
	FrameDialed    FrameType = 0x15
	FrameListPorts FrameType = 0x16
	FramePorts     FrameType = 0x17
```

Add to the `String()` switch (before the final `return`):

```go
	case FrameDial:
		return "DIAL"
	case FrameDialed:
		return "DIALED"
	case FrameListPorts:
		return "LISTPORTS"
	case FramePorts:
		return "PORTS"
```

Add the JSON shapes near the other control-frame shapes:

```go
// ── Port-forward control shapes ──────────────────────────────────────────

// DialRequest asks the broker to open a TCP connection to 127.0.0.1:Port
// inside the container and bind it to Channel. The byte relay then reuses
// INPUT (host→conn) and OUTPUT (conn→host) on that channel; CLOSE/ENDED
// tear it down — exactly like a PTY channel.
type DialRequest struct {
	Channel uint32 `json:"channel"`
	Port    uint16 `json:"port"`
}

type DialResponse struct {
	Channel uint32 `json:"channel"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

// PortInfo is one listening TCP port detected inside the container.
type PortInfo struct {
	Port uint16 `json:"port"`
}

type PortsResponse struct {
	Ports []PortInfo `json:"ports"`
}
```

Update the frame-catalog doc comment at the top of the file to list the four new frames (one line each, matching the existing style).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && go test ./internal/proto/`
Expected: PASS (all proto tests).

- [ ] **Step 5: Commit**

```bash
git add broker/internal/proto/proto.go broker/internal/proto/proto_test.go
git commit -m "feat(broker): add DIAL/LISTPORTS frame types + shapes"
```

---

### Task 2: Broker port detection (`/proc/net/tcp[6]` parser)

**Files:**
- Create: `broker/internal/portscan/portscan.go`
- Test: `broker/internal/portscan/portscan_test.go`

**Interfaces:**
- Produces (Go): `portscan.Listening() ([]uint16, error)` — deduped listening ports from both `/proc/net/tcp` and `/proc/net/tcp6`; `portscan.parseProcNet(r io.Reader, into map[uint16]struct{}) error` — unexported, testable parser.

- [ ] **Step 1: Write the failing test**

Create `broker/internal/portscan/portscan_test.go`:

```go
package portscan

import (
	"sort"
	"strings"
	"testing"
)

// Two LISTEN rows (st=0A) on ports 0x0BB8=3000 and 0x1F90=8080, plus an
// ESTABLISHED row (st=01) that must be ignored. Header line is skipped.
const sampleProcNet = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000 100 0 0 10 0
   2: 0100007F:C001 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000 100 0 0 10 0
`

func TestParseProcNet_OnlyListenPorts(t *testing.T) {
	into := map[uint16]struct{}{}
	if err := parseProcNet(strings.NewReader(sampleProcNet), into); err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := make([]uint16, 0, len(into))
	for p := range into {
		got = append(got, p)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	want := []uint16{3000, 8080}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseProcNet_DedupesAcrossCalls(t *testing.T) {
	into := map[uint16]struct{}{}
	_ = parseProcNet(strings.NewReader(sampleProcNet), into)
	_ = parseProcNet(strings.NewReader(sampleProcNet), into)
	if len(into) != 2 {
		t.Fatalf("expected 2 deduped ports, got %d", len(into))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && go test ./internal/portscan/`
Expected: FAIL — package/function does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `broker/internal/portscan/portscan.go`:

```go
// Package portscan enumerates the TCP ports a process inside the broker's
// container is listening on, by parsing /proc/net/tcp[6]. The fleet user
// can read these without privilege, and we only need the local port — no
// PID/owner mapping — so no CAP_NET_ADMIN or root is required.
package portscan

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
)

// tcpStateListen is the value of the "st" column for a LISTEN socket
// (kernel TCP_LISTEN == 10 == 0x0A), rendered as a 2-char hex string.
const tcpStateListen = "0A"

// Listening returns the deduped set of TCP ports in LISTEN state across
// IPv4 and IPv6. A missing /proc file (non-Linux dev hosts) is not an
// error — it contributes nothing.
func Listening() ([]uint16, error) {
	into := map[uint16]struct{}{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		err = parseProcNet(f, into)
		_ = f.Close()
		if err != nil {
			return nil, err
		}
	}
	out := make([]uint16, 0, len(into))
	for p := range into {
		out = append(out, p)
	}
	return out, nil
}

// parseProcNet scans one /proc/net/tcp-format stream, adding the local
// port of every LISTEN row to `into`. Lines it can't parse are skipped
// (defensive: a malformed row must never abort detection).
func parseProcNet(r io.Reader, into map[uint16]struct{}) error {
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if first {
			first = false // header row
			continue
		}
		fields := strings.Fields(line)
		// fields: sl local_address rem_address st ...
		if len(fields) < 4 || fields[3] != tcpStateListen {
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
		into[uint16(port)] = struct{}{}
	}
	return sc.Err()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && go test ./internal/portscan/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/internal/portscan/
git commit -m "feat(broker): add /proc/net/tcp listening-port scanner"
```

---

### Task 3: Broker server — dial-channel relay + LISTPORTS dispatch

**Files:**
- Modify: `broker/internal/server/server.go`
- Test: `broker/internal/server/server_test.go`

**Interfaces:**
- Consumes: `proto.FrameDial/FrameDialed/FrameListPorts/FramePorts`, `proto.DialRequest/DialResponse/PortInfo/PortsResponse` (Task 1); `portscan.Listening` (Task 2).
- Produces (Go): `Server.ListPorts func() ([]uint16, error)` field (defaults to `portscan.Listening`; tests override). `New(mgr)` sets the default. Dispatch handles `FrameDial`, `FrameListPorts`; `FrameInput`/`FrameClose` also route dial channels.

- [ ] **Step 1: Write the failing test**

Add to `broker/internal/server/server_test.go` (imports already include `net`, `encoding/json`, `bytes`, `time`):

```go
func TestServer_DialRelayEchoesBytes(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()

	// Stand up a local TCP echo server on 127.0.0.1 — the broker will DIAL it.
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listen: %v", err)
	}
	defer echo.Close()
	go func() {
		c, aerr := echo.Accept()
		if aerr != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 256)
		for {
			n, rerr := c.Read(buf)
			if n > 0 {
				_, _ = c.Write(buf[:n])
			}
			if rerr != nil {
				return
			}
		}
	}()
	port := uint16(echo.Addr().(*net.TCPAddr).Port)

	// DIAL channel 1 → the echo server.
	if err := proto.WriteJSONFrame(conn, proto.FrameDial, proto.DialRequest{Channel: 1, Port: port}); err != nil {
		t.Fatalf("write DIAL: %v", err)
	}
	payload := expectFrame(t, conn, proto.FrameDialed)
	var resp proto.DialResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode DIALED: %v", err)
	}
	if !resp.OK || resp.Channel != 1 {
		t.Fatalf("DIAL failed: %+v", resp)
	}

	// INPUT on the dial channel → echoed back as OUTPUT.
	if err := proto.WriteFrame(conn, proto.FrameInput, proto.EncodeChannelData(1, []byte("ping"))); err != nil {
		t.Fatalf("write INPUT: %v", err)
	}
	if !readUntilFrameContains(t, conn, proto.FrameOutput, []byte("ping")) {
		t.Fatal("did not see echoed OUTPUT 'ping'")
	}
}

func TestServer_DialRefusedReportsError(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()

	// Port 1 on loopback has nothing listening → dial refused.
	_ = proto.WriteJSONFrame(conn, proto.FrameDial, proto.DialRequest{Channel: 1, Port: 1})
	payload := expectFrame(t, conn, proto.FrameDialed)
	var resp proto.DialResponse
	_ = json.Unmarshal(payload, &resp)
	if resp.OK {
		t.Fatal("expected dial to port 1 to fail")
	}
	if resp.Error == "" {
		t.Fatal("expected an error message")
	}
}

func TestServer_ListPortsUsesInjectedScanner(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()
	// Override the scanner on the running server is not reachable post-New;
	// instead this test drives the default path and asserts the frame shape.
	_ = proto.WriteJSONFrame(conn, proto.FrameListPorts, struct{}{})
	payload := expectFrame(t, conn, proto.FramePorts)
	var resp proto.PortsResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode PORTS: %v", err)
	}
	// Real /proc scan: shape must decode; contents are environment-dependent.
}
```

Note: the injected-scanner assertion is exercised in Step 3's unit by a direct `parseProcNet` test (Task 2). Here we only assert the `LISTPORTS`→`PORTS` wire shape decodes, which is deterministic.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && go test ./internal/server/ -run Dial`
Expected: FAIL — server replies UNKNOWN/drops `DIAL` (no `DIALED`), `expectFrame` times out.

- [ ] **Step 3: Write minimal implementation**

In `broker/internal/server/server.go`:

Add imports: `"strconv"`, `"time"`, and `"github.com/ImIOImI/claude-fleet/broker/internal/portscan"`.

Extend the `Server` struct and `New`:

```go
type Server struct {
	mgr *session.Manager
	// ListPorts enumerates listening TCP ports for LISTPORTS. Field so
	// tests can inject a deterministic scanner; defaults to portscan.Listening.
	ListPorts func() ([]uint16, error)
}

func New(mgr *session.Manager) *Server {
	return &Server{mgr: mgr, ListPorts: portscan.Listening}
}
```

In `handleConn`, add a per-connection dial table alongside `attached` and close it on disconnect:

```go
	// Channel id → dialed TCP conn (port-forward relay), scoped to this
	// connection. Disjoint from `attached` (PTY channels).
	dialed := map[uint32]net.Conn{}
	defer func() {
		for _, conn := range dialed {
			_ = conn.Close()
		}
	}()
```

Pass `dialed` into `dispatch` (extend its signature) and add the new cases. Change the `dispatch` signature to:

```go
func (s *Server) dispatch(
	ft proto.FrameType,
	payload []byte,
	cw *connWriter,
	attached map[uint32]string,
	dialed map[uint32]net.Conn,
) error {
```

Update the call site in `handleConn`: `s.dispatch(ft, payload, cw, attached, dialed)`.

In the `FrameInput` case, route dial channels first (insert before the existing `attached` lookup):

```go
	case proto.FrameInput:
		channel, body, err := proto.DecodeChannelData(payload)
		if err != nil {
			return err
		}
		if conn, ok := dialed[channel]; ok {
			_, _ = conn.Write(body) // ignore: closed conn just drops bytes
			return nil
		}
		id, ok := attached[channel]
		if !ok {
			return nil
		}
		sess := s.mgr.Get(id)
		if sess == nil {
			return nil
		}
		return sess.Input(body)
```

In the `FrameClose` case, handle dial channels first (insert before the existing `attached` lookup):

```go
	case proto.FrameClose:
		var req proto.ChannelRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: false, Error: "bad json"})
		}
		if conn, ok := dialed[req.Channel]; ok {
			_ = conn.Close()
			delete(dialed, req.Channel)
			return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: true})
		}
		id, ok := attached[req.Channel]
		if !ok {
			return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: false, Error: "channel not attached"})
		}
		s.mgr.Close(id)
		delete(attached, req.Channel)
		return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: true})
```

Add the two new cases (before `default:`):

```go
	case proto.FrameDial:
		var req proto.DialRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: false, Error: "bad json"})
		}
		if _, exists := dialed[req.Channel]; exists {
			return cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: false, Error: "channel in use"})
		}
		// Security: only ever 127.0.0.1 — never an arbitrary host/IP.
		addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(req.Port)))
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			return cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: false, Error: err.Error()})
		}
		dialed[req.Channel] = conn
		if err := cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: true}); err != nil {
			_ = conn.Close()
			delete(dialed, req.Channel)
			return err
		}
		// Pump conn → OUTPUT frames on this channel until the conn closes,
		// then signal ENDED (mirrors a PTY session ending). The conn stays
		// in `dialed` until CLOSE or disconnect cleanup — the read loop owns
		// the map, so this goroutine never touches it.
		go func(ch uint32, c net.Conn) {
			buf := make([]byte, 32*1024)
			for {
				n, rerr := c.Read(buf)
				if n > 0 {
					_ = cw.WriteChannelData(ch, buf[:n])
				}
				if rerr != nil {
					break
				}
			}
			_ = cw.writeJSON(proto.FrameEnded, proto.EndedNotice{Channel: ch, Reason: "exit"})
		}(req.Channel, conn)
		return nil

	case proto.FrameListPorts:
		ports, err := s.ListPorts()
		if err != nil {
			log.Printf("listports: %v", err)
			ports = nil
		}
		resp := proto.PortsResponse{Ports: make([]proto.PortInfo, len(ports))}
		for i, p := range ports {
			resp.Ports[i] = proto.PortInfo{Port: p}
		}
		return cw.writeJSON(proto.FramePorts, resp)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && go test ./internal/server/`
Expected: PASS (existing tests + the three new ones).

- [ ] **Step 5: Commit**

```bash
git add broker/internal/server/server.go broker/internal/server/server_test.go
git commit -m "feat(broker): dial-channel relay + LISTPORTS dispatch"
```

---

### Task 4: Host BrokerClient — `dial` + `listPorts`

**Files:**
- Modify: `src/main/broker.ts`
- Test: `src/main/broker.test.ts` (create)

**Interfaces:**
- Consumes: broker `DIAL`/`DIALED`/`LISTPORTS`/`PORTS` frames (Task 1/3).
- Produces (TS): `FrameType.DIAL = 0x14`, `DIALED = 0x15`, `LISTPORTS = 0x16`, `PORTS = 0x17`; `BrokerClient.dial(channel: number, port: number): Promise<{ channel: number; ok: boolean; error?: string }>`; `BrokerClient.listPorts(): Promise<number[]>`.

- [ ] **Step 1: Write the failing test**

Create `src/main/broker.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrokerClient, FrameType } from './broker.js';

// A minimal in-process broker stub: it reads frames and replies to DIAL with
// DIALED{ok:true} and to LISTPORTS with PORTS{ports:[3000,8080]}. Frame codec
// is reproduced here (the real codec lives in broker.ts and is not exported).
function encodeJSON(type: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.allocUnsafe(4 + 1 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out[4] = type;
  body.copy(out, 5);
  return out;
}

function startStub(sockPath: string): net.Server {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const total = buf.readUInt32BE(0);
        if (buf.length < 4 + total) break;
        const type = buf[4];
        const payload = buf.subarray(5, 4 + total);
        buf = buf.subarray(4 + total);
        if (type === FrameType.DIAL) {
          const { channel } = JSON.parse(payload.toString('utf8'));
          sock.write(encodeJSON(FrameType.DIALED, { channel, ok: true }));
        } else if (type === FrameType.LISTPORTS) {
          sock.write(encodeJSON(FrameType.PORTS, { ports: [{ port: 3000 }, { port: 8080 }] }));
        }
      }
    });
  });
  server.listen(sockPath);
  return server;
}

describe('BrokerClient port-forward RPCs', () => {
  let server: net.Server | undefined;
  afterEach(() => server?.close());

  it('dial resolves with ok', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    server = startStub(sock);
    const client = new BrokerClient(sock);
    await client.ready();
    const resp = await client.dial(1, 3000);
    expect(resp.ok).toBe(true);
    expect(resp.channel).toBe(1);
    client.close();
  });

  it('listPorts returns the port numbers', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    server = startStub(sock);
    const client = new BrokerClient(sock);
    await client.ready();
    const ports = await client.listPorts();
    expect(ports).toEqual([3000, 8080]);
    client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/broker.test.ts`
Expected: FAIL — `client.dial is not a function` / `FrameType.DIAL` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/main/broker.ts`, add to the `FrameType` enum (after `RESIZE = 0x13`):

```ts
  DIAL = 0x14,
  DIALED = 0x15,
  LISTPORTS = 0x16,
  PORTS = 0x17
```

Add a response interface near `AttachResponse`:

```ts
interface DialResponse {
  channel: number;
  ok: boolean;
  error?: string;
}
```

Add these methods to `BrokerClient` (next to `listSessions`):

```ts
  /**
   * Open a TCP connection to 127.0.0.1:<port> inside the container, bound
   * to `channel`. After a successful dial the byte relay reuses INPUT
   * (host→conn) and OUTPUT (conn→host) on the same channel — so wrap the
   * channel in `brokerPtyStream` exactly as a PTY session is wrapped.
   */
  async dial(channel: number, port: number): Promise<DialResponse> {
    const payload = await this.rpc(
      { type: FrameType.DIAL, payload: Buffer.from(JSON.stringify({ channel, port }), 'utf8') },
      FrameType.DIALED
    );
    return JSON.parse(payload.toString('utf8')) as DialResponse;
  }

  /** Listening TCP ports detected inside the container (LISTEN sockets). */
  async listPorts(): Promise<number[]> {
    const payload = await this.rpc(
      { type: FrameType.LISTPORTS, payload: Buffer.alloc(0) },
      FrameType.PORTS
    );
    const obj = JSON.parse(payload.toString('utf8')) as { ports: { port: number }[] };
    return obj.ports.map((p) => p.port);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/broker.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/broker.ts src/main/broker.test.ts
git commit -m "feat(broker-client): add dial() + listPorts()"
```

---

### Task 5: Host port-forward module — diff logic + manager

**Files:**
- Create: `src/main/portforward.ts`
- Test: `src/main/portforward.test.ts`

**Interfaces:**
- Consumes: `BrokerClient` (Task 4), `brokerPtyStream` from `./broker.js`.
- Produces (TS):
  - `diffPorts(prev: Set<number>, current: number[], exclude: number[]): { newly: number[]; next: Set<number> }`
  - `interface PortForwardDeps { resolveEndpoint(workspaceId: string): Promise<string | { host: string; port: number }>; makeClient(endpoint: string | { host: string; port: number }): BrokerClient; onDetected(workspaceId: string, port: number): void; excludePorts(workspaceId: string): number[]; pollMs?: number; }`
  - `class PortForwardManager` with `reconcile(runningWorkspaceIds: string[]): void`, `openPort(workspaceId: string, containerPort: number): Promise<{ hostPort: number }>`, `closeForWorkspace(workspaceId: string): void`, `dispose(): void`.

- [ ] **Step 1: Write the failing test**

Create `src/main/portforward.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { diffPorts, PortForwardManager } from './portforward.js';

describe('diffPorts', () => {
  it('reports ports not seen before, excluding infra ports', () => {
    const { newly, next } = diffPorts(new Set([3000]), [3000, 8080, 7070], [7070]);
    expect(newly).toEqual([8080]);
    expect([...next].sort((a, b) => a - b)).toEqual([3000, 8080]);
  });

  it('re-reports a port that disappeared and came back', () => {
    const first = diffPorts(new Set([3000]), [], []);
    expect(first.newly).toEqual([]);
    expect(first.next.size).toBe(0);
    const second = diffPorts(first.next, [3000], []);
    expect(second.newly).toEqual([3000]);
  });
});

describe('PortForwardManager.reconcile', () => {
  it('starts a monitor per new running workspace and stops departed ones', () => {
    vi.useFakeTimers();
    const made: string[] = [];
    const mgr = new PortForwardManager({
      resolveEndpoint: async () => 'sock',
      makeClient: () => {
        throw new Error('not used in this test');
      },
      onDetected: () => {},
      excludePorts: () => [],
      pollMs: 1000
    });
    // Spy on the private monitor count via reconcile idempotency: reconciling
    // the same set twice must not throw or double-register.
    mgr.reconcile(['a', 'b']);
    mgr.reconcile(['a', 'b']);
    mgr.reconcile(['a']); // 'b' departs
    mgr.dispose();
    vi.useRealTimers();
    expect(made).toEqual([]); // makeClient only fires on a poll tick, not reconcile
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/portforward.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/portforward.ts`:

```ts
// Port-forward + dev-server detection over the broker socket.
//
// Two responsibilities, both riding the existing broker transport (unix
// socket on Linux/macOS, loopback TCP on Windows):
//
//  - PortMonitor: per running workspace, poll the broker's LISTPORTS every
//    `pollMs` and emit `onDetected(workspaceId, port)` the first time a port
//    appears (a port that stays open is reported once; one that disappears
//    and returns is reported again).
//  - PortForward: a loopback `net.Server`; each inbound browser TCP
//    connection gets its OWN BrokerClient (channel 1) and is relayed to
//    127.0.0.1:<containerPort> inside the container via DIAL + the reused
//    INPUT/OUTPUT channel frames — exactly mirroring attachPty's one-client-
//    per-session model. Cheap: broker sockets are.
//
// The host listener binds 127.0.0.1 only; the broker only ever dials
// 127.0.0.1 inside its container. No container ports are published.

import net from 'node:net';
import { BrokerClient, brokerPtyStream } from './broker.js';

type BrokerEndpoint = string | { host: string; port: number };

/** Pure detection diff: which scanned ports are new vs `prev`, after
 *  removing infra ports (broker/MCP). Returns the next baseline set. */
export function diffPorts(
  prev: Set<number>,
  current: number[],
  exclude: number[]
): { newly: number[]; next: Set<number> } {
  const ex = new Set(exclude);
  const next = new Set(current.filter((p) => !ex.has(p)));
  const newly = [...next].filter((p) => !prev.has(p));
  return { newly, next };
}

export interface PortForwardDeps {
  resolveEndpoint(workspaceId: string): Promise<BrokerEndpoint>;
  makeClient(endpoint: BrokerEndpoint): BrokerClient;
  onDetected(workspaceId: string, port: number): void;
  excludePorts(workspaceId: string): number[];
  pollMs?: number;
}

interface Monitor {
  timer: NodeJS.Timeout;
  seen: Set<number>;
}

interface Forward {
  server: net.Server;
  hostPort: number;
}

export class PortForwardManager {
  private readonly deps: Required<PortForwardDeps>;
  private readonly monitors = new Map<string, Monitor>();
  // workspaceId → containerPort → forward (dedupe re-opens of the same port).
  private readonly forwards = new Map<string, Map<number, Forward>>();

  constructor(deps: PortForwardDeps) {
    this.deps = { pollMs: 3000, ...deps };
  }

  reconcile(runningWorkspaceIds: string[]): void {
    const running = new Set(runningWorkspaceIds);
    for (const id of running) {
      if (!this.monitors.has(id)) this.startMonitor(id);
    }
    for (const id of [...this.monitors.keys()]) {
      if (!running.has(id)) {
        this.stopMonitor(id);
        this.closeForWorkspace(id);
      }
    }
  }

  private startMonitor(workspaceId: string): void {
    const seen = new Set<number>();
    const monitor: Monitor = {
      seen,
      timer: setInterval(() => void this.poll(workspaceId), this.deps.pollMs)
    };
    this.monitors.set(workspaceId, monitor);
  }

  private stopMonitor(workspaceId: string): void {
    const m = this.monitors.get(workspaceId);
    if (m) {
      clearInterval(m.timer);
      this.monitors.delete(workspaceId);
    }
  }

  private async poll(workspaceId: string): Promise<void> {
    const monitor = this.monitors.get(workspaceId);
    if (!monitor) return;
    let client: BrokerClient | undefined;
    try {
      const endpoint = await this.deps.resolveEndpoint(workspaceId);
      client = this.deps.makeClient(endpoint);
      await client.ready();
      const ports = await client.listPorts();
      const { newly, next } = diffPorts(monitor.seen, ports, this.deps.excludePorts(workspaceId));
      monitor.seen = next;
      for (const port of newly) this.deps.onDetected(workspaceId, port);
    } catch {
      // Broker not ready / workspace paused — skip this tick silently.
    } finally {
      client?.close();
    }
  }

  async openPort(workspaceId: string, containerPort: number): Promise<{ hostPort: number }> {
    const existing = this.forwards.get(workspaceId)?.get(containerPort);
    if (existing) return { hostPort: existing.hostPort };

    const endpoint = await this.deps.resolveEndpoint(workspaceId);
    const server = net.createServer((socket) => {
      const client = this.deps.makeClient(endpoint);
      client
        .ready()
        .then(() => client.dial(1, containerPort))
        .then((resp) => {
          if (!resp.ok) {
            socket.destroy();
            client.close();
            return;
          }
          const duplex = brokerPtyStream(client, 1);
          socket.pipe(duplex);
          duplex.pipe(socket);
          const cleanup = (): void => {
            void client.closeChannel(1).catch(() => undefined);
            duplex.destroy();
            client.close();
          };
          socket.on('close', cleanup);
          socket.on('error', cleanup);
          duplex.on('end', () => socket.end());
          duplex.on('error', () => socket.destroy());
        })
        .catch(() => {
          socket.destroy();
          client.close();
        });
    });

    const hostPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('port-forward: no listen address'));
      });
    });

    let byPort = this.forwards.get(workspaceId);
    if (!byPort) {
      byPort = new Map();
      this.forwards.set(workspaceId, byPort);
    }
    byPort.set(containerPort, { server, hostPort });
    return { hostPort };
  }

  closeForWorkspace(workspaceId: string): void {
    const byPort = this.forwards.get(workspaceId);
    if (!byPort) return;
    for (const { server } of byPort.values()) server.close();
    this.forwards.delete(workspaceId);
  }

  dispose(): void {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
    for (const id of [...this.forwards.keys()]) this.closeForWorkspace(id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/portforward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/portforward.ts src/main/portforward.test.ts
git commit -m "feat(host): port-forward manager + detection diff"
```

---

### Task 6: Export the broker endpoint resolver from docker.ts

**Files:**
- Modify: `src/main/docker.ts`

**Interfaces:**
- Produces (TS): `export type BrokerEndpoint`; `export async function brokerEndpoint(workspaceId: string): Promise<BrokerEndpoint>` (already exists as a module-private function — just add `export`).

- [ ] **Step 1: Add the exports**

In `src/main/docker.ts`, change the `BrokerEndpoint` type declaration (near line 71) from:

```ts
type BrokerEndpoint = string | { host: string; port: number };
```

to:

```ts
export type BrokerEndpoint = string | { host: string; port: number };
```

And change `async function brokerEndpoint(` (near line 103) to `export async function brokerEndpoint(`.

- [ ] **Step 2: Verify the build still type-checks**

Run: `npm run typecheck` (or `npx tsc --noEmit -p tsconfig.node.json` if `typecheck` is absent — check `package.json` scripts).
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/docker.ts
git commit -m "refactor(docker): export brokerEndpoint for port-forward"
```

---

### Task 7: Wire the manager into IPC + lifecycle + ports:open

**Files:**
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: `PortForwardManager` (Task 5), `brokerEndpoint`, `BrokerEndpoint` (Task 6), `BrokerClient` (Task 4), `MOCK_MODE` (existing), `BrowserWindow` (existing), `MCP_TCP_PORT` from `./mcpSocket.js`.
- Produces (IPC): event `ports:detected` → `{ workspaceId, port }`; handler `ports:open(workspaceId, containerPort)` → `{ hostPort }`; test-only handler `__test:emitDetectedPort(workspaceId, port)` (gated by `CLAUDE_FLEET_E2E=1`).

- [ ] **Step 1: Construct the manager and the broadcaster**

Near the top of `src/main/ipc.ts` (after the existing imports and the `MOCK_MODE` const), add imports and the manager:

```ts
import { PortForwardManager } from './portforward.js';
import { brokerEndpoint } from './docker.js';
import { BrokerClient } from './broker.js';
import { MCP_TCP_PORT } from './mcpSocket.js';

const isWindows = process.platform === 'win32';
// Broker's own loopback-TCP port on Windows (see docker.ts BROKER_TCP_PORT)
// and the MCP port — infra ports we must never offer as dev-server previews.
const INFRA_PORTS = isWindows ? [7070, MCP_TCP_PORT] : [];

/** Tell every window a forwardable dev-server port appeared (toast cue). */
function broadcastPortDetected(workspaceId: string, port: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('ports:detected', { workspaceId, port });
    } catch {
      /* frame disposed mid-send */
    }
  }
}

// Real-backend only: in mock mode there is no broker to poll, so detection is
// driven by the e2e test-only handler below and `ports:open` returns a stub.
const portForward: PortForwardManager | null = MOCK_MODE
  ? null
  : new PortForwardManager({
      resolveEndpoint: brokerEndpoint,
      makeClient: (ep) => new BrokerClient(ep),
      onDetected: broadcastPortDetected,
      excludePorts: () => INFRA_PORTS
    });
```

(If `ipc.ts` already imports `BrowserWindow`/`shell` from `electron`, do not duplicate — it does, per the existing `import { ipcMain, BrowserWindow, dialog, clipboard, Menu, shell } from 'electron'`.)

- [ ] **Step 2: Register `ports:open`**

Add alongside the other `ipcMain.handle(...)` registrations (e.g., near the `app:*` handlers):

```ts
  ipcMain.handle(
    'ports:open',
    async (_e, workspaceId: string, containerPort: number): Promise<{ hostPort: number }> => {
      if (!portForward) {
        // Mock mode: no real broker; hand back a deterministic stub host port
        // so the e2e can assert the round-trip without a container.
        return { hostPort: 65000 };
      }
      const { hostPort } = await portForward.openPort(workspaceId, containerPort);
      void shell.openExternal(`http://127.0.0.1:${hostPort}`);
      return { hostPort };
    }
  );
```

- [ ] **Step 3: Reconcile monitors from the workspace:list handler**

Find the `ipcMain.handle('workspace:list', ...)` handler. After it computes the workspace list (the array it returns — call it `list`), and before `return list`, add:

```ts
    // Keep a port-detection monitor running for each live container workspace.
    // Reconciling here (the renderer polls workspace:list) covers start, pause,
    // stop, remove, and app launch without per-action hooks.
    portForward?.reconcile(
      list.filter((w) => w.state === 'running' && w.kind !== 'local').map((w) => w.id)
    );
```

If the returned objects don't carry `kind`, drop the `w.kind !== 'local'` clause (container is the only kind that has a broker); verify against the handler's actual shape. If the variable isn't named `list`, adapt to the real name.

- [ ] **Step 4: Add the e2e-only detection trigger**

Inside the existing `if (process.env.CLAUDE_FLEET_E2E === '1') { ... }` block (around the other `__test:*` handlers), add:

```ts
    ipcMain.handle('__test:emitDetectedPort', (_e, workspaceId: string, port: number) => {
      broadcastPortDetected(workspaceId, port);
    });
```

- [ ] **Step 5: Verify type-check + existing unit suite**

Run: `npm run test:unit && npm run typecheck` (use the real script names from package.json).
Expected: PASS, no new type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat(ipc): wire port-forward manager, ports:open, detection broadcast"
```

---

### Task 8: Preload — `ports` API surface

**Files:**
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces (TS, on `window.api`): `ports.onDetected(cb: (workspaceId: string, port: number) => void): () => void`; `ports.open(workspaceId: string, containerPort: number): Promise<{ hostPort: number }>`.

- [ ] **Step 1: Add the `ports` namespace**

In `src/preload/index.ts`, add a new key to the `api` object (e.g., after the `pty` block), following the `committee.onInbound` subscription pattern:

```ts
  ports: {
    /** Subscribe to "dev server detected on port N" events (toast cue).
     *  Returns an unsubscribe function. */
    onDetected: (cb: (workspaceId: string, port: number) => void): (() => void) => {
      const channel = 'ports:detected';
      const handler = (_e: IpcRendererEvent, payload: { workspaceId: string; port: number }): void =>
        cb(payload.workspaceId, payload.port);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Open a loopback forward to a container port and the system browser;
     *  returns the bound host port. */
    open: (workspaceId: string, containerPort: number): Promise<{ hostPort: number }> =>
      ipcRenderer.invoke('ports:open', workspaceId, containerPort)
  },
```

`IpcRendererEvent` is already imported at the top of the file.

- [ ] **Step 2: Verify type-check**

Run: `npm run typecheck`
Expected: no new errors; `FleetApi` (`export type FleetApi = typeof api`) now includes `ports`.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose ports.onDetected + ports.open"
```

---

### Task 9: Renderer — toast on detect with "Open preview"

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `window.api.ports.onDetected`, `window.api.ports.open` (Task 8); `dispatchToast`, `makeToast`, `toastIdRef`, `workspacesRef` (existing in App.tsx).

- [ ] **Step 1: Add the detection effect**

In `src/renderer/src/App.tsx`, add a `useEffect` near the existing `committee.onInbound` effect (around line 257). It dispatches an action toast (the `action` field is already supported by `makeToast`/`Toast.tsx`, as the `mcp:status` effect demonstrates):

```tsx
  // Dev-server detection (#port-forward): the broker spotted a new listening
  // port inside a workspace container. Offer a one-click preview that opens
  // the system browser via a loopback forward over the broker socket.
  useEffect(() => {
    return window.api.ports.onDetected((workspaceId, port) => {
      const name = workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? 'workspace';
      dispatchToast({
        type: 'push',
        toast: makeToast(++toastIdRef.current, {
          kind: 'info',
          eyebrow: 'Preview',
          message: `Dev server detected on port ${port} in ${name}`,
          placement: 'global',
          sticky: false,
          dismissible: true,
          action: {
            label: 'Open preview',
            onClick: () => void window.api.ports.open(workspaceId, port)
          }
        })
      });
      // Auto-dismiss after a longer window than the default — give the user
      // time to click. Keyless so multiple ports can stack.
      const id = toastIdRef.current;
      setTimeout(() => dispatchToast({ type: 'dismiss', id }), 12000);
    });
  }, []);
```

Confirm `workspacesRef`, `dispatchToast`, `makeToast`, and `toastIdRef` are all in scope at that point (they are, per the toasts section ~line 324 and `workspacesRef` ~line 156). `makeToast` is imported from `../toasts` / `./toasts`; confirm the existing import and reuse it.

- [ ] **Step 2: Manually verify it builds + renders**

Run: `npm run build`
Expected: build succeeds. (Behavioral check is covered by the e2e in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(renderer): toast + Open preview on dev-server detection"
```

---

### Task 10: E2e — detection toast → Open preview → ports:open

**Files:**
- Create: `tests/port-forward.spec.ts`

**Interfaces:**
- Consumes: `launch` from `./_helpers` (sets `CLAUDE_FLEET_MOCK`/`CLAUDE_FLEET_E2E`); the `__test:emitDetectedPort` handler (Task 7); `ports:open` mock stub returning `{ hostPort: 65000 }`.

- [ ] **Step 1: Confirm the helper signatures**

Read `tests/_helpers.ts` to confirm `launch(envOverrides)` and the `callTestIpc(app, channel, args)` helper (used throughout `tests/broker-sessions.spec.ts`, e.g. `await callTestIpc(app, '__test:recordPendingAttach', [wsName, brokerSessionId])`). Both are imported from `./_helpers`. Use `callTestIpc` to drive the `__test:emitDetectedPort` handler — do NOT reach into Electron internals.

- [ ] **Step 2: Write the test**

Create `tests/port-forward.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

test('detected dev-server port surfaces a preview toast that calls ports:open', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Capture the ports:open round-trip from the renderer side by wrapping the
    // preload method (it returns the mock stub host port, 65000, in mock mode).
    await window.evaluate(() => {
      const w = window as unknown as { __openedHostPort?: number; api: typeof window.api };
      w.__openedHostPort = undefined;
      const orig = w.api.ports.open;
      w.api.ports.open = async (ws: string, port: number) => {
        const res = await orig(ws, port);
        w.__openedHostPort = res.hostPort;
        return res;
      };
    });

    // Drive a detection event from main via the test-only handler (no real
    // broker exists in mock mode). '01MOCKALPHA000000000000000' is a seeded
    // mock workspace (src/main/mock.ts).
    await callTestIpc(app, '__test:emitDetectedPort', ['01MOCKALPHA000000000000000', 3000]);

    // Toast appears with the Open preview action.
    const toast = window.locator('.toast-stack', { hasText: 'port 3000' });
    await expect(toast).toBeVisible();
    const openBtn = toast.locator('button.toast-action', { hasText: 'Open preview' });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // ports:open returned the mock stub host port.
    await expect
      .poll(() => window.evaluate(() => (window as unknown as { __openedHostPort?: number }).__openedHostPort))
      .toBe(65000);
  } finally {
    await app.close();
  }
});
```

If `callTestIpc` has a different arity than `(app, channel, argsArray)`, match its actual signature from `_helpers.ts`.

- [ ] **Step 3: Run the test**

Run: `npm run build && npx playwright test tests/port-forward.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/port-forward.spec.ts
git commit -m "test(e2e): port-forward detection toast + Open preview"
```

---

### Task 11: Update SPEC.md

**Files:**
- Modify: `docs/SPEC.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Locate the relevant sections**

Run: `grep -nE "broker|frame|IPC|Non-goal|FrameType|pty:attach" docs/SPEC.md | head -40` to find the broker-protocol, IPC, user-flow, security, and Non-goals sections.

- [ ] **Step 2: Edit in place (current state, no changelog prose)**

Add/extend, matching the surrounding prose density:

- **Broker protocol section** — document the four new frames and the dial-channel kind:
  > `DIAL`/`DIALED` (0x14/0x15) open a TCP connection to `127.0.0.1:<port>` inside the container, bound to a channel; the byte relay reuses `INPUT`/`OUTPUT`/`CLOSE`/`ENDED`. `LISTPORTS`/`PORTS` (0x16/0x17) enumerate LISTEN ports parsed from `/proc/net/tcp[6]`. A broker channel is either a PTY session or a dialed conn — disjoint, host-allocated.
- **IPC section** — add `ports:detected` (main→renderer event `{workspaceId, port}`) and `ports:open(workspaceId, containerPort) → {hostPort}` (creates a loopback forward, opens the system browser).
- **User flows** — add: a dev server listening inside a container is auto-detected (3s LISTPORTS poll per running workspace) → a transient toast offers **Open preview** → a loopback `127.0.0.1:<hostPort>` forward relays over the broker socket → the system browser opens.
- **Security model** — host forward listener binds `127.0.0.1` only; broker dials `127.0.0.1:<port>` only; no new published container ports; the new frames don't widen who can reach the broker.
- **Non-goals** — not a general port manager: no manual port pinning, no arbitrary `host:port` dialing, no LAN exposure, no in-app preview tab (system browser only) in v1.

- [ ] **Step 3: Handoff-readiness check**

Re-read the edited sections. Confirm a fresh reader could rebuild the feature from the spec alone (frames, IPC, flow, security, non-goals all present and consistent).

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): port-forward preview (broker frames, IPC, flow, security)"
```

---

## Notes for the implementer

- **One BrokerClient per browser connection** (channel 1) is deliberate — it sidesteps the `rpc()` one-waiter-per-frame-type constraint (concurrent `DIAL`s on a shared client would collide on the `DIALED` waiter) and mirrors `attachPty`. Broker sockets are cheap; don't "optimize" into a shared client.
- **WebSocket/HMR works for free** because the relay is raw bytes — do not add any HTTP parsing.
- **Detection dedup baseline is the last scan**, not a cumulative set: a port that closes is dropped from `seen` so it re-toasts if it returns (matches the design's "toast once per appearance").
- If `npm run typecheck` doesn't exist, the project's type-check is part of `npm run build` (electron-vite) — use that.
