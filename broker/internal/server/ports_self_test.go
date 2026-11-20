package server

import (
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
)

func TestBrokersOwnPortIsHiddenAndUnkillable(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc on this host")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	conn, _, cleanup := startTestServerReturningServer(t)
	defer cleanup()

	_ = proto.WriteJSONFrame(conn, proto.FrameListPorts, struct{}{})
	var ports proto.PortsResponse
	if err := json.Unmarshal(expectFrame(t, conn, proto.FramePorts), &ports); err != nil {
		t.Fatal(err)
	}
	for _, p := range ports.Ports {
		if p.Port == port {
			t.Fatalf("broker's own port listed: %+v", p)
		}
	}

	_ = proto.WriteJSONFrame(conn, proto.FrameKillPort, proto.KillPortRequest{Port: port})
	var killed proto.KilledResponse
	if err := json.Unmarshal(expectFrame(t, conn, proto.FrameKilled), &killed); err != nil {
		t.Fatal(err)
	}
	if killed.OK || !strings.Contains(killed.Error, "port belongs to the broker") {
		t.Fatalf("KILLPORT on the broker's port: %+v", killed)
	}
}
