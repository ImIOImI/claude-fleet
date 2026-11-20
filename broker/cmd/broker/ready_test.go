package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
)

func TestReadyPort(t *testing.T) {
	if p, err := readyPort(envOf(nil)); err != nil || p != "7071" {
		t.Fatalf("default: %q %v", p, err)
	}
	for _, ok := range []string{"1", "8080", "65535"} {
		if p, err := readyPort(envOf(map[string]string{"CLAUDE_FLEET_BROKER_READY_PORT": ok})); err != nil || p != ok {
			t.Errorf("%s: %q %v", ok, p, err)
		}
	}
	for _, bad := range []string{"0", "65536", "-1", "http", "70 71", "7071 "} {
		_, err := readyPort(envOf(map[string]string{"CLAUDE_FLEET_BROKER_READY_PORT": bad}))
		if err == nil || !strings.Contains(err.Error(), "CLAUDE_FLEET_BROKER_READY_PORT") {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestOpenReadyOnlyWithDrain(t *testing.T) {
	ln, addr, err := openReady(context.Background(), false, envOf(map[string]string{"CLAUDE_FLEET_BROKER_READY_PORT": "bogus"}))
	if ln != nil || addr != "" || err != nil {
		t.Fatalf("drain off: %v %q %v", ln, addr, err)
	}
	if _, _, err := openReady(context.Background(), true, envOf(map[string]string{"CLAUDE_FLEET_BROKER_READY_PORT": "bogus"})); err == nil {
		t.Fatal("drain on accepted a bad port")
	}
}

func TestServeReadyAnswersAndStopsWithTheBroker(t *testing.T) {
	_, d, srv := controlServer(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- serveReady(ctx, ln, srv.ReadyHandler()) }()
	url := "http://" + ln.Addr().String() + "/ready"
	status := func() (int, string) {
		t.Helper()
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, strings.TrimSpace(string(b))
	}
	if code, body := status(); code != 200 || body != drain.PhaseServing {
		t.Fatalf("serving: %d %q", code, body)
	}
	if resp, err := http.Post(url, "text/plain", strings.NewReader("DRAIN")); err != nil || resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %v %v", resp, err)
	} else {
		resp.Body.Close()
	}
	if d.Phase() != drain.PhaseServing {
		t.Fatalf("POST changed the phase to %s", d.Phase())
	}
	d.Start()
	if code, body := status(); code != 503 || body != drain.PhaseDraining {
		t.Fatalf("draining: %d %q", code, body)
	}
	cancel()
	select {
	case err := <-served:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ready listener outlived the broker")
	}
	if _, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second); err == nil {
		t.Fatal("still accepting after shutdown")
	}
}
