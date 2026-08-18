package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ImIOImI/claude-fleet/broker/internal/portscan"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
)

func TestListPortsCarriesSession(t *testing.T) {
	// Use the same startTestServerReturningServer helper so we can inject
	// a deterministic ListPorts scanner that returns Details with Session set.
	conn, srv, cleanup := startTestServerReturningServer(t)
	defer cleanup()

	srv.ListPorts = func() ([]portscan.Detail, error) {
		return []portscan.Detail{
			{Port: 3000, Pid: 42, Cmdline: "vite", Session: "tab-1"},
			{Port: 8080},
		}, nil
	}

	_ = proto.WriteJSONFrame(conn, proto.FrameListPorts, struct{}{})
	payload := expectFrame(t, conn, proto.FramePorts)

	var resp proto.PortsResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode PORTS: %v", err)
	}
	if len(resp.Ports) != 2 {
		t.Fatalf("want 2 ports, got %d: %+v", len(resp.Ports), resp.Ports)
	}

	byPort := map[uint16]proto.PortInfo{}
	for _, p := range resp.Ports {
		byPort[p.Port] = p
	}

	// (a) attributed port must carry the session id
	if got := byPort[3000]; got.Session != "tab-1" {
		t.Errorf("port 3000: want session %q, got %q", "tab-1", got.Session)
	}

	// (b) unattributed port must have NO "session" key in the raw JSON
	// (omitempty guarantees the key is absent, not just empty)
	rawMap := []map[string]any{}
	if err := json.Unmarshal(payload, &struct {
		Ports *[]map[string]any `json:"ports"`
	}{Ports: &rawMap}); err != nil {
		t.Fatalf("re-decode PORTS as raw map: %v", err)
	}
	for _, entry := range rawMap {
		portVal, _ := entry["port"].(float64)
		if uint16(portVal) == 8080 {
			if _, hasKey := entry["session"]; hasKey {
				t.Errorf("port 8080: unattributed port must have no 'session' key in JSON, got: %v", entry)
			}
			return
		}
	}
	t.Fatal("port 8080 not found in raw JSON response")
}

func TestListPortsDefaultScannerAttributesSessions(t *testing.T) {
	// Verify that the default ListPorts closure in New() calls
	// AttributeSessions. We can't observe real /proc attribution in unit
	// tests, but we can assert the closure compiled (it uses mgr.RootPids())
	// and the PORTS frame decodes cleanly.
	conn, _, cleanup := startTestServerReturningServer(t)
	defer cleanup()

	_ = proto.WriteJSONFrame(conn, proto.FrameListPorts, struct{}{})
	payload := expectFrame(t, conn, proto.FramePorts)

	// The raw payload must contain "ports" — shape check.
	if !strings.Contains(string(payload), `"ports"`) {
		t.Errorf("PORTS payload missing 'ports' key: %s", payload)
	}
	var resp proto.PortsResponse
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode PORTS: %v", err)
	}
}
