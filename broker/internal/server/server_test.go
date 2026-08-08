package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/portscan"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

// startTestServer brings up a real net.Listener on a temp Unix socket
// backed by a Manager that uses /bin/cat in place of claude. Returns a
// client *net.UnixConn already connected, plus a cleanup that shuts
// the server + manager down.
func startTestServer(t *testing.T) (client *net.UnixConn, cleanup func()) {
	t.Helper()
	conn, _, cleanup := startTestServerWithPath(t)
	return conn, cleanup
}

// startTestServerWithPath is startTestServer that also returns the socket
// path, so a test can dial a second connection to the same broker (the #64
// concurrent-attach repro).
func startTestServerWithPath(t *testing.T) (client *net.UnixConn, sockPath string, cleanup func()) {
	t.Helper()
	dir := t.TempDir()
	sockPath = filepath.Join(dir, "broker.sock")

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	if err := os.Chmod(sockPath, 0o666); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	mgr := session.NewManager(session.ManagerConfig{
		ClaudeExec:   "/bin/cat",
		RingBufBytes: 1024,
	})
	srv := New(mgr)

	ctx, cancel := context.WithCancel(context.Background())
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ctx, ln) }()

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		cancel()
		_ = ln.Close()
		mgr.CloseAll()
		t.Fatalf("dial: %v", err)
	}
	uc := conn.(*net.UnixConn)

	cleanup = func() {
		_ = uc.Close()
		cancel()
		_ = ln.Close()
		mgr.CloseAll()
		<-serveErr
	}
	return uc, sockPath, cleanup
}

// expectFrame reads one frame and asserts the type, returning the payload.
func expectFrame(t *testing.T, conn net.Conn, want proto.FrameType) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	defer conn.SetReadDeadline(time.Time{})
	got, payload, err := proto.ReadFrame(conn)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	if got != want {
		t.Fatalf("frame type: got %v, want %v (payload %q)", got, want, payload)
	}
	return payload
}

// readUntilFrame keeps reading frames until one of wantType arrives (or
// the deadline hits), skipping any frames in between. Needed when a stray
// channel-data frame — e.g. the PTY line-discipline echo of just-sent
// input, which arrives as a second OUTPUT alongside the program's own
// stdout — may still be in flight ahead of a control-frame ack. The real
// host client demuxes by frame type rather than expecting a rigid order.
func readUntilFrame(t *testing.T, conn net.Conn, want proto.FrameType) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		got, payload, err := proto.ReadFrame(conn)
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		if got == want {
			return payload
		}
	}
	t.Fatalf("did not see frame %v before deadline", want)
	return nil
}

// readUntilFrameContains keeps reading frames until one of the given
// type carries `needle` in its body, or the deadline hits. Returns true
// on hit. We're tolerant of OUTPUT vs HISTORY ordering — both can be
// channel-data frames.
func readUntilFrameContains(t *testing.T, conn net.Conn, wantType proto.FrameType, needle []byte) bool {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		ft, payload, err := proto.ReadFrame(conn)
		if err != nil {
			t.Logf("read error: %v", err)
			return false
		}
		if ft != wantType {
			continue
		}
		_, body, decErr := proto.DecodeChannelData(payload)
		if decErr != nil {
			continue
		}
		if bytes.Contains(body, needle) {
			return true
		}
	}
	return false
}

func TestServer_CreateAttachInputOutput(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()

	// CREATE session "alpha"
	if err := proto.WriteJSONFrame(conn, proto.FrameCreate, proto.CreateRequest{
		ID: "alpha", Cols: 80, Rows: 24,
	}); err != nil {
		t.Fatalf("write CREATE: %v", err)
	}
	createdPayload := expectFrame(t, conn, proto.FrameCreated)
	var createResp proto.CreateResponse
	if err := json.Unmarshal(createdPayload, &createResp); err != nil {
		t.Fatalf("decode CREATED: %v", err)
	}
	if !createResp.OK {
		t.Fatalf("CREATE failed: %s", createResp.Error)
	}

	// ATTACH channel 1 to "alpha"
	if err := proto.WriteJSONFrame(conn, proto.FrameAttach, proto.AttachRequest{
		ID: "alpha", Channel: 1,
	}); err != nil {
		t.Fatalf("write ATTACH: %v", err)
	}
	attachedPayload := expectFrame(t, conn, proto.FrameAttached)
	var attachResp proto.AttachResponse
	if err := json.Unmarshal(attachedPayload, &attachResp); err != nil {
		t.Fatalf("decode ATTACHED: %v", err)
	}
	if !attachResp.OK || attachResp.Channel != 1 {
		t.Fatalf("ATTACH failed: %+v", attachResp)
	}

	// INPUT some bytes — cat will echo them via the PTY back through
	// OUTPUT frames. (HISTORY would only fire if there were ring bytes
	// before attach; we attached on a fresh session so it doesn't.)
	if err := proto.WriteFrame(conn, proto.FrameInput, proto.EncodeChannelData(1, []byte("hello\n"))); err != nil {
		t.Fatalf("write INPUT: %v", err)
	}

	if !readUntilFrameContains(t, conn, proto.FrameOutput, []byte("hello")) {
		t.Fatal("did not see expected OUTPUT containing 'hello' within deadline")
	}
}

func TestServer_AttachUnknownSessionFails(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()

	_ = proto.WriteJSONFrame(conn, proto.FrameAttach, proto.AttachRequest{
		ID: "does-not-exist", Channel: 1,
	})
	payload := expectFrame(t, conn, proto.FrameAttached)
	var resp proto.AttachResponse
	_ = json.Unmarshal(payload, &resp)
	if resp.OK {
		t.Errorf("expected failure, got OK=true")
	}
	if resp.Error == "" {
		t.Errorf("expected error message, got empty")
	}
}

func TestServer_ListReturnsLiveSessions(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()

	// Create two sessions.
	for _, id := range []string{"sess-a", "sess-b"} {
		_ = proto.WriteJSONFrame(conn, proto.FrameCreate, proto.CreateRequest{
			ID: id, Cols: 80, Rows: 24,
		})
		expectFrame(t, conn, proto.FrameCreated)
	}

	_ = proto.WriteJSONFrame(conn, proto.FrameList, struct{}{})
	payload := expectFrame(t, conn, proto.FrameSessions)
	var resp proto.SessionsResponse
	_ = json.Unmarshal(payload, &resp)
	if len(resp.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(resp.Sessions))
	}
	ids := map[string]bool{}
	for _, s := range resp.Sessions {
		ids[s.ID] = s.Alive
	}
	if !ids["sess-a"] || !ids["sess-b"] {
		t.Errorf("missing session in list: %+v", resp.Sessions)
	}
}

func TestServer_DetachAndReattachReplaysHistory(t *testing.T) {
	conn, cleanup := startTestServer(t)
	defer cleanup()

	// CREATE + ATTACH ch=1
	_ = proto.WriteJSONFrame(conn, proto.FrameCreate, proto.CreateRequest{ID: "rep", Cols: 80, Rows: 24})
	expectFrame(t, conn, proto.FrameCreated)
	_ = proto.WriteJSONFrame(conn, proto.FrameAttach, proto.AttachRequest{ID: "rep", Channel: 1})
	expectFrame(t, conn, proto.FrameAttached)

	// INPUT some bytes and let them flow into the ring/output.
	_ = proto.WriteFrame(conn, proto.FrameInput, proto.EncodeChannelData(1, []byte("aaa\n")))
	if !readUntilFrameContains(t, conn, proto.FrameOutput, []byte("aaa")) {
		t.Fatal("did not see initial OUTPUT")
	}

	// DETACH ch=1. A second OUTPUT frame (the PTY echo of "aaa\n") may still
	// be in flight, so skip past any stray frames to the DETACHED ack.
	_ = proto.WriteJSONFrame(conn, proto.FrameDetach, proto.ChannelRequest{Channel: 1})
	readUntilFrame(t, conn, proto.FrameDetached)

	// Re-ATTACH ch=2. Should produce a HISTORY frame containing the
	// earlier "aaa" bytes.
	_ = proto.WriteJSONFrame(conn, proto.FrameAttach, proto.AttachRequest{ID: "rep", Channel: 2})
	expectFrame(t, conn, proto.FrameAttached)

	if !readUntilFrameContains(t, conn, proto.FrameHistory, []byte("aaa")) {
		t.Fatal("expected HISTORY frame with 'aaa' after re-attach")
	}
}

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

// startTestServerReturningServer is startTestServer but also returns the
// *Server so tests can inject fields (ListPorts, KillPort) after construction.
func startTestServerReturningServer(t *testing.T) (client *net.UnixConn, srv *Server, cleanup func()) {
	t.Helper()
	dir := t.TempDir()
	sockPath := filepath.Join(dir, "broker.sock")

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	if err := os.Chmod(sockPath, 0o666); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	mgr := session.NewManager(session.ManagerConfig{
		ClaudeExec:   "/bin/cat",
		RingBufBytes: 1024,
	})
	srv = New(mgr)

	ctx, cancel := context.WithCancel(context.Background())
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ctx, ln) }()

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		cancel()
		_ = ln.Close()
		mgr.CloseAll()
		t.Fatalf("dial: %v", err)
	}
	uc := conn.(*net.UnixConn)

	cleanup = func() {
		_ = uc.Close()
		cancel()
		_ = ln.Close()
		mgr.CloseAll()
		<-serveErr
	}
	return uc, srv, cleanup
}

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

func TestServer_SecondConnAttachToHeldSessionRejected(t *testing.T) {
	// #64 repro: a second connection ATTACHing a session that another
	// connection already holds must be rejected (OK:false), not silently
	// stomp the first connection's writer and blind it.
	conn, sockPath, cleanup := startTestServerWithPath(t)
	defer cleanup()

	_ = proto.WriteJSONFrame(conn, proto.FrameCreate, proto.CreateRequest{ID: "held", Cols: 80, Rows: 24})
	expectFrame(t, conn, proto.FrameCreated)
	_ = proto.WriteJSONFrame(conn, proto.FrameAttach, proto.AttachRequest{ID: "held", Channel: 1})
	expectFrame(t, conn, proto.FrameAttached)

	// A separate connection probes the same session id.
	conn2, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial second conn: %v", err)
	}
	defer conn2.Close()
	_ = proto.WriteJSONFrame(conn2, proto.FrameAttach, proto.AttachRequest{ID: "held", Channel: 1})
	payload := expectFrame(t, conn2, proto.FrameAttached)
	var resp proto.AttachResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("unmarshal AttachResponse: %v", err)
	}
	if resp.OK {
		t.Fatal("second attach to a held session should be rejected, got OK=true")
	}

	// The first connection still receives live OUTPUT — it was never stomped.
	_ = proto.WriteFrame(conn, proto.FrameInput, proto.EncodeChannelData(1, []byte("zzz\n")))
	if !readUntilFrameContains(t, conn, proto.FrameOutput, []byte("zzz")) {
		t.Fatal("first connection went blind after the rejected second attach")
	}
}
