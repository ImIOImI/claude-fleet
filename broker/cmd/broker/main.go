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
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/ImIOImI/claude-fleet/broker/internal/server"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

const (
	defaultSocketPath  = "/run/broker/broker.sock"
	defaultRingBytes   = 64 * 1024
	defaultClaudeExec  = "claude"
	defaultLogPrefix   = "claude-fleet-broker: "
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix(defaultLogPrefix)

	socketPath := envDefault("CLAUDE_FLEET_BROKER_SOCKET", defaultSocketPath)
	ringBytes := envInt("CLAUDE_FLEET_BROKER_RING", defaultRingBytes)
	claudeExec := envDefault("CLAUDE_FLEET_BROKER_CLAUDE", defaultClaudeExec)

	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		log.Fatalf("mkdir socket dir: %v", err)
	}
	// Stale socket from a prior run blocks Listen; remove it first.
	// (Container restarts re-mkdir the bind-mounted dir empty in most cases,
	// but be defensive — if the dir is host-bind-mounted, files can persist.)
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatalf("remove stale socket: %v", err)
	}

	lc := net.ListenConfig{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ln, err := lc.Listen(ctx, "unix", socketPath)
	if err != nil {
		log.Fatalf("listen %s: %v", socketPath, err)
	}
	// Make the socket world-rw so the host (a different UID) can connect.
	// The bind-mount + container User flag means the host user already owns
	// the dir; this is belt-and-suspenders in case future changes use a
	// different UID inside the container.
	if err := os.Chmod(socketPath, 0o666); err != nil {
		log.Printf("chmod socket: %v (continuing)", err)
	}

	mgr := session.NewManager(session.ManagerConfig{
		ClaudeExec:    claudeExec,
		RingBufBytes:  ringBytes,
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

	log.Printf("listening on %s (ring=%d, claude=%q)", socketPath, ringBytes, claudeExec)
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
