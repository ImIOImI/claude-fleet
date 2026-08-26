package portscan

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Two LISTEN rows (ports 3000/0x0BB8 inode 12345, 8765/0x223D inode 67890)
// and one ESTABLISHED row that must be ignored.
const sampleProcNet = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:0400 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
`

func TestParseProcNet_CapturesListenPortsAndInodes(t *testing.T) {
	into := map[uint16]uint64{}
	if err := parseProcNet(strings.NewReader(sampleProcNet), into); err != nil {
		t.Fatalf("parseProcNet: %v", err)
	}
	if len(into) != 2 {
		t.Fatalf("want 2 LISTEN ports, got %v", into)
	}
	if into[3000] != 12345 || into[8765] != 67890 {
		t.Fatalf("wrong port→inode map: %v", into)
	}
}

func TestParseProcNet_DedupesAcrossCalls(t *testing.T) {
	into := map[uint16]uint64{}
	_ = parseProcNet(strings.NewReader(sampleProcNet), into)
	_ = parseProcNet(strings.NewReader(sampleProcNet), into) // tcp6 pass, same ports
	if len(into) != 2 {
		t.Fatalf("want 2 ports after double parse, got %d", len(into))
	}
}

// Integration: listen on a real socket and assert Listening() attributes it
// to this test process.
func TestListening_ResolvesOwnPidAndCmdline(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc/net/tcp on this host")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	details, err := Listening()
	if err != nil {
		t.Fatalf("Listening: %v", err)
	}
	var mine *Detail
	for i := range details {
		if details[i].Port == port {
			mine = &details[i]
		}
	}
	if mine == nil {
		ports := make([]int, 0, len(details))
		for _, d := range details {
			ports = append(ports, int(d.Port))
		}
		sort.Ints(ports)
		t.Fatalf("own port %d not in scan %v", port, ports)
	}
	if mine.Pid != os.Getpid() {
		t.Fatalf("want pid %d, got %+v", os.Getpid(), mine)
	}
	// cmdline of a `go test` binary contains the package's test binary name.
	if !strings.Contains(mine.Cmdline, "portscan.test") {
		t.Fatalf("cmdline %q does not look like this test binary", mine.Cmdline)
	}
	_ = fmt.Sprintf // keep fmt imported if assertions change
}

// Spawn a child that listens on a port and ignores nothing (default TERM
// disposition = die), then KillOwner it and assert the port closes.
func TestKillOwner_TerminatesListener(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	// A python one-liner is the most portable always-present listener in the
	// runner image and dev containers alike; skip if python3 is missing.
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not on PATH")
	}
	cmd := exec.Command(py, "-c",
		`import socket,sys,time
s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen()
print(s.getsockname()[1], flush=True)
time.sleep(300)`)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start listener: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()

	var port uint16
	if _, err := fmt.Fscan(out, &port); err != nil {
		t.Fatalf("read child port: %v", err)
	}

	if err := KillOwner(port, 2*time.Second); err != nil {
		t.Fatalf("KillOwner: %v", err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("child exited 0 — expected signal death")
	}

	// And the port must be gone from the scan.
	details, err := Listening()
	if err != nil {
		t.Fatalf("Listening after kill: %v", err)
	}
	for _, d := range details {
		if d.Port == port {
			t.Fatalf("port %d still listening after KillOwner", port)
		}
	}
}

func TestKillOwner_NoOwnerIsError(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	// Port 1 requires root to bind; nothing in a test env listens there.
	if err := KillOwner(1, time.Millisecond); err == nil {
		t.Fatal("expected error for unowned port")
	}
}

// A supervisor that respawns its listener child is the case KillOwner cannot
// handle: signalling only the socket-owning leaf lets the parent reopen the
// port. KillTree must walk from the owner up to the command launched under
// the session (the child of the session's PTY root) and take out the whole
// subtree, so the port stays gone.
func TestKillTree_TakesOutRespawningSupervisor(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not on PATH")
	}
	// A listener that rebinds a fixed port (SO_REUSEADDR so a respawn can
	// grab it immediately) and holds it open.
	pyPath := writeTempScript(t, `import socket,sys,time
p=int(sys.argv[1])
s=socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1",p)); s.listen()
time.sleep(300)`)

	// Grab a free port number, then hand it to a shell supervisor that
	// respawns the listener whenever it dies.
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := uint16(probe.Addr().(*net.TCPAddr).Port)
	_ = probe.Close()

	sup := exec.Command("sh", "-c",
		fmt.Sprintf("while true; do python3 %s %d; sleep 0.1; done", pyPath, port))
	sup.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // isolate for cleanup
	if err := sup.Start(); err != nil {
		t.Fatalf("start supervisor: %v", err)
	}
	defer func() { _ = syscall.Kill(-sup.Process.Pid, syscall.SIGKILL); _, _ = sup.Process.Wait() }()

	if !waitPortListening(port, 5*time.Second) {
		t.Fatalf("port %d never came up", port)
	}

	// This test process stands in for the session's PTY root; the supervisor
	// is the command launched under it.
	roots := map[int]string{os.Getpid(): "sess-test"}
	if err := KillTree(port, roots, 2*time.Second); err != nil {
		t.Fatalf("KillTree: %v", err)
	}

	// The supervisor is dead, so nothing respawns the listener: the port must
	// stay gone across a respawn window.
	if waitPortListening(port, 1500*time.Millisecond) {
		t.Fatalf("port %d still (or again) listening — supervisor was not killed", port)
	}
}

// writeTempScript writes body to a temp file and returns its path.
func writeTempScript(t *testing.T, body string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "listener-*.py")
	if err != nil {
		t.Fatalf("temp script: %v", err)
	}
	if _, err := f.WriteString(body); err != nil {
		t.Fatalf("write script: %v", err)
	}
	_ = f.Close()
	return f.Name()
}

// waitPortListening polls Listening() until port appears or the deadline
// passes. Returns whether it is listening.
func waitPortListening(port uint16, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		details, err := Listening()
		if err == nil {
			for _, d := range details {
				if d.Port == port {
					return true
				}
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}
