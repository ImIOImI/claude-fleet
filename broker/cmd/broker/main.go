// Command broker is the in-container session-multiplexer for
// claude-fleet. It owns every claude PTY in a workspace and exposes
// them over a Unix socket bind-mounted to the host. The host
// (Electron main) attaches via that socket instead of running
// `docker exec claude` directly, so PTYs survive a host disconnect
// (app quit, app crash, network jitter).
//
// Lifecycle: broker is started by tini at container start as PID 1's
// supervised child and runs forever. It replaces the previous
// `sleep infinity` keep-alive — the broker itself keeps the container
// up. SIGTERM cleanly closes all PTYs (sending each child SIGHUP),
// then exits. SIGKILL drops everything (cgroups freezer / `docker
// pause` doesn't reach the broker either way, since it just freezes
// the cgroup atomically).
//
// All knobs are env vars rather than flags so the runner image can
// pass them through Docker's `Env` without parsing args:
//
//	CLAUDE_FLEET_BROKER_SOCKET    path of the unix socket to listen on
//	                              (default: /run/broker/broker.sock)
//	CLAUDE_FLEET_BROKER_TCP_PORT  if set (e.g. 7070), listen on TCP
//	                              0.0.0.0:<port> instead of a unix socket:
//	                              the Windows desktop (Docker publishes it to
//	                              127.0.0.1) and the remote workspace pod
//	                              (behind the Istio sidecar).
//	                              (default: unset → unix)
//	CLAUDE_FLEET_BROKER_REQUIRE_MESH  "1": wait up to 60 s for the Istio
//	                              sidecar (FLEET_MESH_READY_URL, default
//	                              http://127.0.0.1:15021/healthz/ready) and
//	                              exit 1 without listening if it never answers.
//	CLAUDE_FLEET_BROKER_RING      ring-buffer bytes per session
//	                              (default: 65536 = 64 KiB)
//	CLAUDE_FLEET_BROKER_CLAUDE    command run for each session
//	                              (default: claude)

package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/server"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

const (
	defaultSocketPath = "/run/broker/broker.sock"
	defaultRingBytes  = 64 * 1024
	defaultClaudeExec = "claude"
	defaultLogPrefix  = "claude-fleet-broker: "
	meshWait          = 60 * time.Second
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix(defaultLogPrefix)

	ringBytes := envInt("CLAUDE_FLEET_BROKER_RING", defaultRingBytes)
	claudeExec := envDefault("CLAUDE_FLEET_BROKER_CLAUDE", defaultClaudeExec)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ln, listenAddr, err := listen(ctx, os.Getenv, meshWait, log.Printf)
	if err != nil {
		log.Fatalf("%v", err)
	}

	mgr := session.NewManager(session.ManagerConfig{
		ClaudeExec:   claudeExec,
		RingBufBytes: ringBytes,
	})
	srv := server.New(mgr)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("shutdown signal: %v", sig)
		cancel()
		_ = ln.Close()
	}()

	log.Printf("listening on %s (ring=%d, claude=%q)", listenAddr, ringBytes, claudeExec)
	if err := srv.Serve(ctx, ln); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, context.Canceled) {
		log.Printf("serve error: %v", err)
	}
	mgr.CloseAll()
	log.Print("exited")
}

func envDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}
