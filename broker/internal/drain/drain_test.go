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

var _ Target = (*session.Manager)(nil)

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
	c.advance(29 * time.Minute)
	d.Step()
	if tg.interrupts["auto-R-s"] != 0 {
		t.Fatal("SIGINT before soft")
	}
	c.advance(time.Minute)
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

func TestUnreadableStatusIsBusy(t *testing.T) {
	tg := newTarget(session.Snap{ID: "a", Alive: true, Pid: 42})
	c := &clock{t: time.Unix(1_000_000, 0)}
	d := New(cfg, tg, activity.Reader{Dir: t.TempDir()}.Of, c.now, "i", &notify.Bus{})
	d.Start()
	d.Step()
	if len(tg.terminated) != 0 || d.Phase() != PhaseDraining {
		t.Fatal("a session without a status file was closed")
	}
}

func TestEscOnlyAfterSoftNotBeforeAndOnlyForBusy(t *testing.T) {
	d, tg, c := rig(acts{1: activity.Idle, 3: activity.Busy},
		session.Snap{ID: "busy", Alive: true, Pid: 3})
	d.Start()
	c.advance(30*time.Minute - time.Second)
	d.Step()
	if tg.interrupts["busy"] != 0 {
		t.Fatal("Esc one second before soft")
	}
	c.advance(time.Second)
	d.Step()
	if tg.interrupts["busy"] != 1 {
		t.Fatalf("interrupts %d at soft", tg.interrupts["busy"])
	}
}

func TestInertWithoutStart(t *testing.T) {
	d, tg, c := rig(acts{1: activity.Idle, 3: activity.Busy},
		session.Snap{ID: "idle", Alive: true, Pid: 1},
		session.Snap{ID: "busy", Alive: true, Pid: 3})
	c.advance(36 * time.Minute)
	d.Step()
	if len(tg.terminated) != 0 || len(tg.interrupts) != 0 || tg.killedAll != "" || d.Phase() != PhaseServing {
		t.Fatal("acted while serving")
	}
	st := d.State()
	if !st.StartedAt.IsZero() || !st.SoftAt.IsZero() || !st.HardAt.IsZero() {
		t.Fatalf("deadlines while serving: %+v", st)
	}
	select {
	case <-d.Done():
		t.Fatal("done while serving")
	default:
	}
}

func TestPhaseChangesNotifyTheBus(t *testing.T) {
	tg := newTarget()
	bus := &notify.Bus{}
	ch, cancel := bus.Subscribe()
	defer cancel()
	d := New(cfg, tg, acts{}.of, time.Now, "i", bus)
	d.Start()
	select {
	case <-ch:
	default:
		t.Fatal("Start did not notify")
	}
	d.Step()
	select {
	case <-ch:
	default:
		t.Fatal("done did not notify")
	}
}

type orderBus struct {
	d          *Drainer
	doneAtLast bool
}

func (o *orderBus) Notify() {
	select {
	case <-o.d.Done():
		o.doneAtLast = true
	default:
		o.doneAtLast = false
	}
}

// A WATCH woken by Done must already have its wake-up, or the final STATE can be lost.
func TestDoneNotifiesBeforeClosing(t *testing.T) {
	ob := &orderBus{}
	ob.d = New(cfg, newTarget(), acts{}.of, time.Now, "i", ob)
	ob.d.Start()
	ob.d.Step()
	if ob.d.Phase() != PhaseDone || ob.doneAtLast {
		t.Fatalf("phase %s; Done closed before the final notify: %v", ob.d.Phase(), ob.doneAtLast)
	}
}

// Real sessions: a headless run that exits 0 on SIGINT is still interrupted (owner decision 1A),
// and an interactive one without a status file is busy until the hard kill.
func TestRealManagerEndReasons(t *testing.T) {
	m := session.NewManager(session.ManagerConfig{ClaudeExec: "/bin/sh", RingBufBytes: 1024})
	defer m.CloseAll()
	if _, err := m.CreateWith("auto", 80, 24, []string{"-c", "trap 'exit 0' INT; while :; do sleep 0.02; done"}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CreateWith("tab", 80, 24, []string{"-c", "while :; do sleep 0.02; done"}, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	fast := Config{Soft: 100 * time.Millisecond, Hard: 600 * time.Millisecond, FirstPass: 10 * time.Millisecond, Poll: 20 * time.Millisecond, EscEvery: time.Minute}
	d := New(fast, m, activity.Reader{Dir: t.TempDir()}.Of, time.Now, "i", &notify.Bus{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)
	d.Start()
	select {
	case <-d.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("drain never finished")
	}
	// No polling: the reasons must already be recorded when Done fires.
	got := map[string]string{}
	for _, s := range d.State().Sessions {
		got[s.ID] = s.Ended
	}
	if got["auto"] != session.ReasonInterrupted || got["tab"] != session.ReasonKilled {
		t.Fatalf("end reasons %v", got)
	}
}

func TestFirstPassDelaysTheFirstClose(t *testing.T) {
	tg := newTarget(session.Snap{ID: "idle", Alive: true, Pid: 1})
	slow := Config{Soft: time.Minute, Hard: 2 * time.Minute, FirstPass: 300 * time.Millisecond, Poll: 5 * time.Millisecond, EscEvery: time.Minute}
	d := New(slow, tg, acts{1: activity.Idle}.of, time.Now, "i", &notify.Bus{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)
	time.Sleep(400 * time.Millisecond) // past FirstPass: a Run that didn't wait for Start would now poll every 5ms
	d.Start()
	time.Sleep(100 * time.Millisecond)
	tg.mu.Lock()
	n := len(tg.terminated)
	tg.mu.Unlock()
	if n != 0 {
		t.Fatal("closed before FirstPass")
	}
	select {
	case <-d.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("drain never finished")
	}
}
