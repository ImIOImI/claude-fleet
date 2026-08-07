package portscan

import (
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"testing"
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
