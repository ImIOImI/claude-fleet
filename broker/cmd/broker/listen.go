package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/mesh"
)

// listen binds TCP when CLAUDE_FLEET_BROKER_TCP_PORT is set, else the Unix
// socket. With CLAUDE_FLEET_BROKER_REQUIRE_MESH=1 it first needs the sidecar.
// TCP without the flag stays allowed for the Windows desktop's loopback-published
// port; `fleet-host-entry workspace` always sets the flag.
func listen(ctx context.Context, getenv func(string) string, meshWait time.Duration, logf func(string, ...any)) (net.Listener, string, error) {
	requireMesh := getenv("CLAUDE_FLEET_BROKER_REQUIRE_MESH")
	switch requireMesh {
	case "", "0", "1":
	default:
		return nil, "", fmt.Errorf("CLAUDE_FLEET_BROKER_REQUIRE_MESH must be '', 0 or 1, got %q", requireMesh)
	}
	tcpPort := getenv("CLAUDE_FLEET_BROKER_TCP_PORT")
	if requireMesh == "1" {
		url := getenv("FLEET_MESH_READY_URL")
		if url == "" {
			url = mesh.DefaultURL
		}
		if err := mesh.WaitReady(ctx, url, meshWait, time.Second); err != nil {
			return nil, "", fmt.Errorf("refusing to listen: %w", err)
		}
	}
	var lc net.ListenConfig
	if port := tcpPort; port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, "", fmt.Errorf("CLAUDE_FLEET_BROKER_TCP_PORT must be an integer from 1 to 65535, got %q", port)
		}
		// Not loopback: Istio forwards inbound traffic to the pod IP, and Docker's port proxy needs it too.
		addr := net.JoinHostPort("0.0.0.0", port)
		ln, err := lc.Listen(ctx, "tcp", addr)
		return ln, addr, err
	}
	path := getenv("CLAUDE_FLEET_BROKER_SOCKET")
	if path == "" {
		path = defaultSocketPath
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, "", fmt.Errorf("mkdir socket dir: %w", err)
	}
	// A host-bind-mounted dir can keep a stale socket across container restarts.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", fmt.Errorf("remove stale socket: %w", err)
	}
	ln, err := lc.Listen(ctx, "unix", path)
	if err != nil {
		return nil, "", err
	}
	// The desktop host connects as another uid.
	if err := os.Chmod(path, 0o666); err != nil {
		logf("chmod socket: %v (continuing)", err)
	}
	return ln, path, nil
}
