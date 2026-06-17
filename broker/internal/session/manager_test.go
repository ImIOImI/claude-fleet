package session

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureWriter records every WriteChannelData call. It satisfies
// ChannelWriter.
type captureWriter struct {
	mu     sync.Mutex
	frames []capturedFrame
}

type capturedFrame struct {
	Channel uint32
	Body    []byte
}

func (w *captureWriter) WriteChannelData(channel uint32, body []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	cp := make([]byte, len(body))
	copy(cp, body)
	w.frames = append(w.frames, capturedFrame{Channel: channel, Body: cp})
	return nil
}

func (w *captureWriter) all() []capturedFrame {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]capturedFrame, len(w.frames))
	copy(out, w.frames)
	return out
}

func (w *captureWriter) joined() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []byte
	for _, f := range w.frames {
		out = append(out, f.Body...)
	}
	return out
}

// waitUntil polls fn every 5ms up to 2s. Returns true if fn returned
// true within the window. Lets tests avoid arbitrary sleep durations.
func waitUntil(fn func() bool) bool {
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func TestManager_CreateAndList(t *testing.T) {
	// /bin/cat is a deterministic stand-in for `claude` in PTY tests:
	// it reads stdin and writes back stdout. We never give it any input
	// here, so it just sits waiting.
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, err := mgr.Create("sess-1", 80, 24, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sess.ID() != "sess-1" {
		t.Errorf("ID: got %q, want sess-1", sess.ID())
	}
	if !sess.Alive() {
		t.Error("expected alive after Create")
	}

	infos := mgr.List()
	if len(infos) != 1 || infos[0].ID != "sess-1" || !infos[0].Alive {
		t.Errorf("List: got %+v", infos)
	}
}

func TestManager_CreatePassesArgsToExec(t *testing.T) {
	// /bin/echo writes its args to stdout (and thus the PTY → ring buffer)
	// then exits. Proves the Args from CREATE reach exec.Command — the
	// mechanism behind `claude --resume <uuid>`.
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/echo", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, err := mgr.Create("sess-args", 80, 24, []string{"--resume", "abc-123"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Wait for echo to run and the pump to drain its output into the ring.
	if !waitUntil(func() bool {
		return strings.Contains(string(sess.ring.Snapshot()), "--resume abc-123")
	}) {
		t.Errorf("ring buffer never saw the args; got %q", sess.ring.Snapshot())
	}
}

func TestManager_CreateRejectsDuplicateID(t *testing.T) {
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer mgr.CloseAll()

	if _, err := mgr.Create("dup", 80, 24, nil); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	if _, err := mgr.Create("dup", 80, 24, nil); err != ErrIDInUse {
		t.Errorf("second Create: got %v, want ErrIDInUse", err)
	}
}

func TestSession_AttachStreamsOutput(t *testing.T) {
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, err := mgr.Create("sess-2", 80, 24, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	cw := &captureWriter{}
	history, err := sess.Attach(cw, 7)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if len(history) != 0 {
		t.Errorf("history at fresh attach should be empty, got %d bytes", len(history))
	}

	// Feed `cat` some bytes. The PTY's default line discipline echoes
	// them AND cat sends them back on its stdout, so the visible output
	// contains the input at least once. We assert "needle" appears.
	if err := sess.Input([]byte("needle\n")); err != nil {
		t.Fatalf("Input: %v", err)
	}

	if !waitUntil(func() bool { return bytes.Contains(cw.joined(), []byte("needle")) }) {
		t.Errorf("did not see expected output within 2s; got %q", cw.joined())
	}
}

func TestSession_DetachStopsDelivery(t *testing.T) {
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, _ := mgr.Create("sess-3", 80, 24, nil)
	cw := &captureWriter{}
	_, _ = sess.Attach(cw, 1)
	_ = sess.Input([]byte("pre-detach\n"))
	waitUntil(func() bool { return bytes.Contains(cw.joined(), []byte("pre-detach")) })

	sess.Detach(cw)
	beforeDetachCount := len(cw.all())

	_ = sess.Input([]byte("post-detach\n"))
	// Give the PTY a moment to process and dump to ring (not to cw).
	time.Sleep(100 * time.Millisecond)

	if len(cw.all()) != beforeDetachCount {
		t.Errorf("writer received bytes after Detach: %d new frames", len(cw.all())-beforeDetachCount)
	}

	// The bytes ARE in the ring though — a fresh attach should see them.
	cw2 := &captureWriter{}
	history, _ := sess.Attach(cw2, 1)
	if !bytes.Contains(history, []byte("post-detach")) {
		t.Errorf("history on re-attach missing post-detach bytes; got %q", history)
	}
}

func TestSession_AttachRejectedWhenAlreadyAttached(t *testing.T) {
	// A second ATTACH for a session that already has a live writer must be
	// rejected, never silently stomp the first writer (#64). A stomped
	// writer goes blind — claude's OUTPUT flows to the new writer while the
	// original connection still thinks it's attached.
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, err := mgr.Create("sess-dual", 80, 24, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	cw1 := &captureWriter{}
	if _, err := sess.Attach(cw1, 1); err != nil {
		t.Fatalf("first Attach: %v", err)
	}

	// A second connection probing the same session id (any channel) must be
	// rejected outright.
	cw2 := &captureWriter{}
	if _, err := sess.Attach(cw2, 2); err != ErrAlreadyAttached {
		t.Fatalf("second Attach: got %v, want ErrAlreadyAttached", err)
	}

	// The original writer keeps receiving live output; the rejected one
	// receives nothing.
	if err := sess.Input([]byte("needle\n")); err != nil {
		t.Fatalf("Input: %v", err)
	}
	if !waitUntil(func() bool { return bytes.Contains(cw1.joined(), []byte("needle")) }) {
		t.Errorf("original writer went blind after a rejected attach; got %q", cw1.joined())
	}
	if len(cw2.all()) != 0 {
		t.Errorf("rejected writer received %d frames, want 0", len(cw2.all()))
	}
}

func TestSession_ReattachReplaysHistory(t *testing.T) {
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, _ := mgr.Create("sess-4", 80, 24, nil)
	cw := &captureWriter{}
	_, _ = sess.Attach(cw, 1)
	_ = sess.Input([]byte("burst-1\n"))
	waitUntil(func() bool { return bytes.Contains(cw.joined(), []byte("burst-1")) })
	sess.Detach(cw)

	// New connection re-attaches. The ring buffer should hand back what
	// happened previously.
	cw2 := &captureWriter{}
	history, err := sess.Attach(cw2, 9)
	if err != nil {
		t.Fatalf("re-Attach: %v", err)
	}
	if !bytes.Contains(history, []byte("burst-1")) {
		t.Errorf("history missing burst-1; got %q", history)
	}
}

func TestSession_DoneClosesOnExit(t *testing.T) {
	// Use a one-shot command that exits immediately, so we can observe
	// the Done() channel close and Alive() flip to false.
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/true", RingBufBytes: 1024})
	defer mgr.CloseAll()

	sess, err := mgr.Create("sess-exit", 80, 24, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	select {
	case <-sess.Done():
		// expected
	case <-time.After(2 * time.Second):
		t.Fatal("session.Done did not close within 2s after /bin/true exit")
	}

	if sess.Alive() {
		t.Error("Alive should be false after exit")
	}
}

func TestManager_CloseDropsAndKills(t *testing.T) {
	mgr := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	sess, _ := mgr.Create("sess-close", 80, 24, nil)
	mgr.Close("sess-close")

	if mgr.Get("sess-close") != nil {
		t.Error("session should be removed from manager after Close")
	}
	// kill is async at the OS level; wait for the wait() goroutine to see exit.
	select {
	case <-sess.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("killed session never reached Done()")
	}
}
