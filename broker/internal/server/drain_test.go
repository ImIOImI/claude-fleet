package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
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
	return startDrainRigCfg(t, act, drain.Config{Soft: time.Hour, Hard: 2 * time.Hour, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute})
}

func startDrainRigCfg(t *testing.T, act func(int) activity.Kind, cfg drain.Config) *drainRig {
	t.Helper()
	dir := t.TempDir()
	bus := &notify.Bus{}
	mgr := session.NewManager(session.ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024, OnChange: bus.Notify})
	d := drain.New(cfg, mgr, act, time.Now, "inst1", bus)
	srv := New(mgr)
	srv.Drain, srv.Bus, srv.Instance = d, bus, "inst1"
	srv.ProcRoot = fakeProc(t, map[int]int{os.Getpid(): 0})
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

func TestEndedReasonOnAttachAfterEnd(t *testing.T) {
	r := startDrainRig(t, busyAll)
	c := dial(t, r.main)
	_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: "s1", Cols: 80, Rows: 24})
	readUntilFrame(t, c, proto.FrameCreated)
	r.mgr.KillAll(session.ReasonKilled)
	_ = proto.WriteJSONFrame(c, proto.FrameAttach, proto.AttachRequest{ID: "s1", Channel: 2})
	var e proto.EndedNotice
	_ = json.Unmarshal(readUntilFrame(t, c, proto.FrameEnded), &e)
	if e.Channel != 2 || e.Reason != session.ReasonKilled {
		t.Fatalf("%+v", e)
	}
}

func TestNoticeIsRateLimitedPerChannel(t *testing.T) {
	r := startDrainRig(t, busyAll)
	c := dial(t, r.main)
	for _, ch := range []uint32{1, 2} {
		_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: fmt.Sprint("s", ch), Cols: 80, Rows: 24})
		readUntilFrame(t, c, proto.FrameCreated)
		_ = proto.WriteJSONFrame(c, proto.FrameAttach, proto.AttachRequest{ID: fmt.Sprint("s", ch), Channel: ch})
		readUntilFrame(t, c, proto.FrameAttached)
	}
	r.d.Start()
	for i := 0; i < 5; i++ {
		_ = proto.WriteFrame(c, proto.FrameInput, proto.EncodeChannelData(1, []byte("x")))
	}
	_ = proto.WriteFrame(c, proto.FrameInput, proto.EncodeChannelData(2, []byte("x")))
	_ = proto.WriteJSONFrame(c, proto.FrameList, struct{}{}) // a fence: everything above was dispatched
	notices := map[uint32]int{}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		ft, p, err := proto.ReadFrame(c)
		if err != nil {
			t.Fatal(err)
		}
		if ft == proto.FrameSessions {
			break
		}
		if ft == proto.FrameNotice {
			var n proto.Notice
			_ = json.Unmarshal(p, &n)
			notices[n.Channel]++
		}
	}
	if notices[1] != 1 || notices[2] != 1 {
		t.Fatalf("notices %v", notices)
	}
}

func TestControlSocketAcceptsOnlyStatusAndDrain(t *testing.T) {
	r := startDrainRig(t, busyAll)
	ctl := dial(t, r.ctl)
	_ = proto.WriteJSONFrame(ctl, proto.FrameCreate, proto.CreateRequest{ID: "viactl", Cols: 80, Rows: 24})
	_ = proto.WriteJSONFrame(ctl, proto.FrameStatus, struct{}{})
	if st := state(t, ctl); st.Phase != drain.PhaseServing || len(st.Sessions) != 0 {
		t.Fatalf("%+v", st)
	}
	if r.mgr.Get("viactl") != nil {
		t.Fatal("CREATE served on the control socket")
	}
}

func TestDoneStateHasEveryReason(t *testing.T) {
	r := startDrainRigCfg(t, busyAll, drain.Config{Soft: 50 * time.Millisecond, Hard: 150 * time.Millisecond, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute})
	c := dial(t, r.main)
	for _, id := range []string{"a", "b", "c"} {
		_ = proto.WriteJSONFrame(c, proto.FrameCreate, proto.CreateRequest{ID: id, Cols: 80, Rows: 24})
		readUntilFrame(t, c, proto.FrameCreated)
	}
	ctl := dial(t, r.ctl)
	_ = proto.WriteJSONFrame(ctl, proto.FrameDrain, struct{}{})
	for {
		st := state(t, ctl)
		if st.Phase != drain.PhaseDone {
			continue
		}
		for _, s := range st.Sessions {
			if s.Alive || s.Ended != session.ReasonKilled {
				t.Fatalf("done STATE before the reasons: %+v", st.Sessions)
			}
		}
		return
	}
}
