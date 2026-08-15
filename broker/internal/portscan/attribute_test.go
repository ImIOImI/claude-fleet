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
