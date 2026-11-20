package portscan

import (
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

func TestIsSelfOrAncestor(t *testing.T) {
	chain := map[int]int{10: 5, 5: 1, 7: 5}
	ppid := func(p int) (int, bool) { q, ok := chain[p]; return q, ok }
	for pid, want := range map[int]bool{10: true, 5: true, 1: true, 7: false, 11: false} {
		if got := isSelfOrAncestor(pid, 10, ppid); got != want {
			t.Errorf("pid %d: %v, want %v", pid, got, want)
		}
	}
	got := withoutSelf([]Detail{{Port: 1, Pid: 10}, {Port: 2, Pid: 1}, {Port: 3, Pid: 7}, {Port: 4}}, 10, ppid)
	if len(got) != 2 || got[0].Port != 3 || got[1].Port != 4 {
		t.Fatalf("withoutSelf: %+v", got)
	}
}

// Without the guard this SIGTERMs the test process itself.
func TestKillTree_RefusesTheBrokersOwnPort(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	if err := KillTree(port, map[int]string{}, 100*time.Millisecond); !errors.Is(err, ErrBrokerPort) {
		t.Fatalf("KillTree on own port: %v", err)
	}
	if err := KillOwner(port, 100*time.Millisecond); !errors.Is(err, ErrBrokerPort) {
		t.Fatalf("KillOwner on own port: %v", err)
	}
	for _, d := range WithoutSelf([]Detail{{Port: port, Pid: os.Getpid()}}) {
		t.Fatalf("own port listed: %+v", d)
	}
}
