package server

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
)

// fakeProc writes <root>/<pid>/stat for each pid → ppid.
func fakeProc(t *testing.T, tree map[int]int) string {
	t.Helper()
	root := t.TempDir()
	setProc(t, root, tree)
	return root
}

// setProc rewrites stat files under a root the server already reads (no field write: no race).
func setProc(t *testing.T, root string, tree map[int]int) {
	t.Helper()
	for pid, ppid := range tree {
		dir := filepath.Join(root, strconv.Itoa(pid))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		line := fmt.Sprintf("%d (a b) c) S %d %d %d 0 -1\n", pid, ppid, pid, pid)
		if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(line), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDrainCallerErr(t *testing.T) {
	const self = 7
	roots := map[int]string{50: "tab1"}
	cases := []struct {
		name string
		pid  int
		tree map[int]int
		ok   bool
		msg  string
	}{
		{"exec'd from outside the namespace", 300, map[int]int{300: 0}, true, ""},
		{"a shell exec'd from outside, then the CLI", 301, map[int]int{301: 300, 300: 0}, true, ""},
		{"a session's child", 400, map[int]int{400: 50, 50: self, self: 1, 1: 0}, false, "session tab1"},
		{"the session root itself", 50, map[int]int{50: self}, false, "session tab1"},
		{"under a root whose parent is unseen", 450, map[int]int{450: 50, 50: 0}, false, "session tab1"},
		{"an orphan reparented to pid 1", 500, map[int]int{500: 1, 1: 0}, false, "pid 1"},
		{"a child of the broker", 600, map[int]int{600: self, self: 1}, false, "pid 7"},
		{"unreadable ancestry", 700, map[int]int{}, false, "can't read"},
		{"a broken link mid-chain", 701, map[int]int{701: 702}, false, "can't read"},
		{"a ppid cycle", 800, map[int]int{800: 801, 801: 800}, false, "too deep"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := drainCallerErr(c.pid, self, roots, func(p int) (int, bool) { pp, ok := c.tree[p]; return pp, ok })
			if (err == nil) != c.ok || (err != nil && !strings.Contains(err.Error(), c.msg)) {
				t.Fatalf("err = %v, want ok=%v %q", err, c.ok, c.msg)
			}
		})
	}
}

func TestDrainCallerHopBound(t *testing.T) {
	chain := map[int]int{}
	for p := 1000; p < 1000+64-1; p++ {
		chain[p] = p + 1
	}
	chain[1000+64-1] = 0
	ppid := func(p int) (int, bool) { pp, ok := chain[p]; return pp, ok }
	if err := drainCallerErr(1000, 7, nil, ppid); err != nil {
		t.Fatalf("a 64-deep chain must pass: %v", err)
	}
	chain[1000+64-1] = 2000
	chain[2000] = 0
	if err := drainCallerErr(1000, 7, nil, ppid); err == nil {
		t.Fatal("a chain past the bound must be refused")
	}
}

func TestPeerPidIsTheCaller(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		if c, err := net.Dial("unix", path); err == nil {
			time.Sleep(200 * time.Millisecond)
			c.Close()
		}
	}()
	c, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if pid, err := peerPid(c); err != nil || pid != os.Getpid() {
		t.Fatalf("peerPid = %d %v, want %d", pid, err, os.Getpid())
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if _, err := peerPid(a); err == nil {
		t.Fatal("a non-unix conn has no peer pid")
	}
}

func refused(t *testing.T, c net.Conn) {
	t.Helper()
	var n proto.Notice
	if err := json.Unmarshal(readUntilFrame(t, c, proto.FrameNotice), &n); err != nil || n.Code != NoticeDrainRefused {
		t.Fatalf("notice %+v %v", n, err)
	}
}

func TestDrainFromASessionIsRefused(t *testing.T) {
	r := startDrainRig(t, busyAll)
	c := dial(t, r.main)
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "tab1", Cols: 80, Rows: 24})
	readUntilFrame(t, c, proto.FrameCreated)
	root := r.mgr.Get("tab1").Pid()
	setProc(t, r.srv.ProcRoot, map[int]int{os.Getpid(): 4242, 4242: root, root: os.Getpid()})

	ctl := dial(t, r.ctl)
	_ = proto.WriteJSONFrame(ctl, proto.FrameStatus, struct{}{})
	if st := state(t, ctl); st.Phase != drain.PhaseServing {
		t.Fatalf("STATUS from a session: %+v", st)
	}
	_ = proto.WriteJSONFrame(ctl, proto.FrameDrain, struct{}{})
	refused(t, ctl)
	time.Sleep(50 * time.Millisecond)
	if r.d.Phase() != drain.PhaseServing {
		t.Fatal("a session drained its own workspace")
	}
}

func TestDrainRefusedWhenAncestryIsUnreadable(t *testing.T) {
	r := startDrainRig(t, busyAll)
	if err := os.RemoveAll(filepath.Join(r.srv.ProcRoot, strconv.Itoa(os.Getpid()))); err != nil {
		t.Fatal(err)
	}
	ctl := dial(t, r.ctl)
	_ = proto.WriteJSONFrame(ctl, proto.FrameDrain, struct{}{})
	refused(t, ctl)
	if r.d.Phase() != drain.PhaseServing {
		t.Fatal("drain started without a readable ancestry")
	}
}
