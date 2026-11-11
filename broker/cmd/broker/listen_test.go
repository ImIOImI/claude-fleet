package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func readiness(t *testing.T, status int) string {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
	t.Cleanup(s.Close)
	return s.URL
}

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

// freeTCPPort hands back a port number the kernel just had free, for tests that need a real one.
func freeTCPPort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return strconv.Itoa(port)
}

func TestRequireMeshRefusesWithoutSidecar(t *testing.T) {
	env := envOf(map[string]string{
		"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1",
		"FLEET_MESH_READY_URL":             readiness(t, 503),
		"CLAUDE_FLEET_BROKER_TCP_PORT":     "0",
	})
	ln, _, err := listen(context.Background(), env, 200*time.Millisecond, t.Logf)
	if err == nil {
		ln.Close()
		t.Fatal("listened without a sidecar")
	}
	if !strings.Contains(err.Error(), "refusing to listen: no Istio sidecar") {
		t.Fatalf("err = %v", err)
	}
}

func TestRequireMeshListensOnTCPWhenReady(t *testing.T) {
	port := freeTCPPort(t)
	env := envOf(map[string]string{
		"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1",
		"FLEET_MESH_READY_URL":             readiness(t, 200),
		"CLAUDE_FLEET_BROKER_TCP_PORT":     port,
	})
	ln, addr, err := listen(context.Background(), env, time.Second, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if addr != "0.0.0.0:"+port {
		t.Fatalf("addr = %q", addr)
	}
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

// TCP without the mesh flag on is refused before any probe (D96): a
// plaintext pod-IP listener is never opened, no matter what
// FLEET_MESH_READY_URL says.
func TestTCPWithoutMeshFlagRefusedBeforeProbing(t *testing.T) {
	for _, v := range []string{"", "0"} {
		env := envOf(map[string]string{
			"CLAUDE_FLEET_BROKER_TCP_PORT":     freeTCPPort(t),
			"CLAUDE_FLEET_BROKER_REQUIRE_MESH": v,
			"FLEET_MESH_READY_URL":             "http://127.0.0.1:1/never",
		})
		ln, _, err := listen(context.Background(), env, time.Millisecond, t.Logf)
		if err == nil {
			ln.Close()
			t.Fatalf("%q: listened without the mesh flag", v)
		}
		if !strings.Contains(err.Error(), "CLAUDE_FLEET_BROKER_TCP_PORT") || !strings.Contains(err.Error(), "CLAUDE_FLEET_BROKER_REQUIRE_MESH=1") {
			t.Fatalf("%q: err = %v", v, err)
		}
	}
}

// Anything outside 1-65535 refuses to start, once the mesh flag itself clears.
func TestInvalidTCPPortRefuses(t *testing.T) {
	url := readiness(t, 200)
	for _, p := range []string{"0", "-1", "65536", "99999", "abc", " 7070"} {
		env := envOf(map[string]string{
			"CLAUDE_FLEET_BROKER_TCP_PORT":     p,
			"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1",
			"FLEET_MESH_READY_URL":             url,
		})
		ln, _, err := listen(context.Background(), env, time.Second, t.Logf)
		if err == nil {
			ln.Close()
			t.Fatalf("port %q: listened", p)
		}
		if !strings.Contains(err.Error(), "CLAUDE_FLEET_BROKER_TCP_PORT must be") {
			t.Fatalf("port %q: err = %v", p, err)
		}
	}
}

func TestUnixSocketIsWorldRW(t *testing.T) {
	d, err := os.MkdirTemp("", "bl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	p := filepath.Join(d, "run", "b.sock")
	ln, addr, err := listen(context.Background(), envOf(map[string]string{"CLAUDE_FLEET_BROKER_SOCKET": p}), time.Millisecond, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	st, err := os.Stat(p)
	if err != nil || addr != p || st.Mode().Perm() != 0o666 {
		t.Fatalf("stat %v, addr %q, err %v", st, addr, err)
	}
}

// The guard must also cover the Unix socket, and refuse before binding it.
func TestRequireMeshRefusesBeforeBindingUnixSocket(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "b.sock")
	env := envOf(map[string]string{
		"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1",
		"FLEET_MESH_READY_URL":             readiness(t, 503),
		"CLAUDE_FLEET_BROKER_SOCKET":       p,
	})
	if ln, _, err := listen(context.Background(), env, 50*time.Millisecond, t.Logf); err == nil {
		ln.Close()
		t.Fatal("listened without a sidecar")
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("socket created before the mesh check: %v", err)
	}
}

// Unset or "0" leaves the guard off (exercised on the Unix socket, since TCP
// now requires the flag on regardless (D96)); anything else refuses to start
// (D95 also applies to the broker's CLAUDE_FLEET_BROKER_REQUIRE_MESH).
func TestRequireMeshOnlyOnOne(t *testing.T) {
	d := t.TempDir()
	for i, v := range []string{"", "0"} {
		env := envOf(map[string]string{
			"CLAUDE_FLEET_BROKER_REQUIRE_MESH": v,
			"FLEET_MESH_READY_URL":             readiness(t, 503),
			"CLAUDE_FLEET_BROKER_SOCKET":       filepath.Join(d, strconv.Itoa(i)+".sock"),
		})
		ln, _, err := listen(context.Background(), env, 50*time.Millisecond, t.Logf)
		if err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		ln.Close()
	}
	for _, v := range []string{"true", "yes", " 1"} {
		env := envOf(map[string]string{
			"CLAUDE_FLEET_BROKER_REQUIRE_MESH": v,
			"CLAUDE_FLEET_BROKER_TCP_PORT":     freeTCPPort(t),
		})
		ln, _, err := listen(context.Background(), env, 10*time.Millisecond, t.Logf)
		if err == nil {
			ln.Close()
			t.Fatalf("%q: listened", v)
		}
		if !strings.Contains(err.Error(), `CLAUDE_FLEET_BROKER_REQUIRE_MESH must be '', 0 or 1, got`) {
			t.Fatalf("%q: err = %v", v, err)
		}
	}
}

func TestMeshWaitBudget(t *testing.T) {
	if meshWait != 60*time.Second {
		t.Fatalf("meshWait = %s, want 60s (D89)", meshWait)
	}
}

func TestRequireMeshDefaultsToTheSidecarURL(t *testing.T) {
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_REQUIRE_MESH": "1", "CLAUDE_FLEET_BROKER_TCP_PORT": freeTCPPort(t)})
	ln, _, err := listen(context.Background(), env, 10*time.Millisecond, t.Logf)
	if err == nil {
		ln.Close()
		t.Skip("something answers the sidecar URL on this machine")
	}
	if !strings.Contains(err.Error(), "http://127.0.0.1:15021/healthz/ready") {
		t.Fatalf("err = %v", err)
	}
}
