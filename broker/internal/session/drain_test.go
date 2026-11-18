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

// Owner decision 1A: claude -p exits 0 on SIGINT mid-request without a result.
func TestHeadlessInterruptExitZeroIsStillInterrupted(t *testing.T) {
	m := shManager(nil)
	s, _ := m.CreateWith("h", 80, 24, []string{"-c", "trap 'exit 0' INT; while :; do sleep 0.05; done"}, true)
	time.Sleep(100 * time.Millisecond)
	m.Interrupt("h")
	if got := ended(t, s); got != ReasonInterrupted {
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

func TestInterruptedSessionIsNotDowngradedToIdle(t *testing.T) {
	m := shManager(nil)
	s, _ := m.CreateWith("i", 80, 24, []string{"-c", "while :; do sleep 0.05; done"}, false)
	time.Sleep(100 * time.Millisecond)
	m.Interrupt("i")
	m.Terminate("i", ReasonIdle)
	if got := ended(t, s); got != ReasonInterrupted {
		t.Fatalf("reason %q", got)
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

func TestKillAfterInterruptIsKilled(t *testing.T) {
	m := shManager(nil)
	s, _ := m.CreateWith("h", 80, 24, []string{"-c", "trap '' INT; while :; do sleep 0.05; done"}, true)
	time.Sleep(100 * time.Millisecond)
	m.Interrupt("h")
	m.KillAll(ReasonKilled)
	if got := ended(t, s); got != ReasonKilled {
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

func TestKillAllReturnsAfterReasonsAreRecorded(t *testing.T) {
	m := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	m.CreateWith("a", 80, 24, nil, false)
	m.CreateWith("b", 80, 24, nil, true)
	m.KillAll(ReasonKilled)
	for _, x := range m.Snapshot() {
		if x.Alive || x.Ended != ReasonKilled {
			t.Fatalf("not recorded when KillAll returned: %+v", x)
		}
	}
}

// The child exits but wait() hasn't run yet: a drain action in that window must not mark it.
func TestExitedButUnreapedIsNotMarked(t *testing.T) {
	for name, act := range map[string]func(*Session){
		"terminate": func(s *Session) { s.Terminate(ReasonIdle, time.Hour) },
		"interrupt": func(s *Session) { s.Interrupt() },
		"kill":      func(s *Session) { s.KillWith(ReasonKilled) },
	} {
		t.Run(name, func(t *testing.T) {
			s, err := newSession("x", "/bin/sh", []string{"-c", "exit 0"}, 80, 24, 1024, true)
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(5 * time.Second)
			for !s.exited() {
				if time.Now().After(deadline) {
					t.Fatal("child never exited")
				}
				time.Sleep(5 * time.Millisecond)
			}
			act(s)
			s.wait()
			if got := s.EndReason(); got != ReasonExit {
				t.Fatalf("reason %q, want exit", got)
			}
		})
	}
}

func TestLiveSessionIsNotExited(t *testing.T) {
	m := NewManager(ManagerConfig{ClaudeExec: "/bin/cat", RingBufBytes: 1024})
	defer m.CloseAll()
	s, _ := m.CreateWith("a", 80, 24, nil, false)
	if s.exited() {
		t.Fatal("live session reads exited")
	}
}
