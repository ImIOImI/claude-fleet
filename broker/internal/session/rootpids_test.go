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
