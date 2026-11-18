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
// up. SIGTERM closes all PTYs, or with CLAUDE_FLEET_BROKER_DRAIN=1 drains
// first (D143); SIGINT always closes at once. SIGKILL drops everything (cgroups freezer / `docker
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
//	CLAUDE_FLEET_BROKER_DRAIN     "1": open the control socket (broker drain / broker ready)
//	                              and drain on SIGTERM (SPEC §7 *Workspace pod drain*)
//	CLAUDE_FLEET_BROKER_DRAIN_SOFT / _HARD  Go durations (default 30m / 35m)
//	CLAUDE_FLEET_BROKER_CTL_SOCKET  control socket path (default /run/broker/ctl.sock)
//	CLAUDE_FLEET_BROKER_STATUS_DIR  claude status files (default $HOME/.claude/sessions)

package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/notify"
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

	if len(os.Args) > 1 {
		os.Exit(runCLI(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
	}
	ringBytes := envInt("CLAUDE_FLEET_BROKER_RING", defaultRingBytes)
	claudeExec := envDefault("CLAUDE_FLEET_BROKER_CLAUDE", defaultClaudeExec)
	drainOn, dcfg, err := drainSettings(os.Getenv)
	if err != nil {
		log.Fatalf("%v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ln, listenAddr, err := listen(ctx, os.Getenv, meshWait, log.Printf)
	if err != nil {
		log.Fatalf("%v", err)
	}

	bus := &notify.Bus{}
	mgr := session.NewManager(session.ManagerConfig{ClaudeExec: claudeExec, RingBufBytes: ringBytes, OnChange: bus.Notify})
	instance := newInstance()
	reader := activity.Reader{Dir: activity.DefaultDir(os.Getenv)}
	d := drain.New(dcfg, mgr, reader.Of, time.Now, instance, bus)
	srv := server.New(mgr)
	srv.Drain, srv.Bus, srv.Instance = d, bus, instance
	go d.Run(ctx)

	ctlLn, err := openControl(ctx, drainOn, os.Getenv)
	if err != nil {
		log.Fatalf("control socket: %v", err)
	}
	if ctlLn != nil {
		go func() { _ = srv.ServeControl(ctx, ctlLn) }()
	}

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go handleSignals(sigCh, drainOn, d, func() { cancel(); _ = ln.Close() })

	log.Printf("listening on %s (ring=%d, claude=%q, drain=%v, instance=%s)", listenAddr, ringBytes, claudeExec, drainOn, instance)
	if err := srv.Serve(ctx, ln); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, context.Canceled) {
		log.Printf("serve error: %v", err)
	}
	if ctlLn != nil {
		_ = ctlLn.Close()
	}
	mgr.CloseAll()
	log.Print("exited")
}

type drainer interface {
	Start() bool
	Phase() string
	Done() <-chan struct{}
}

// handleSignals calls stop once: SIGTERM with the drain on waits for it (D143); anything else stops at once.
func handleSignals(sigCh <-chan os.Signal, drainOn bool, d drainer, stop func()) {
	var once sync.Once
	stopOnce := func() { once.Do(stop) }
	waiting := false
	for sig := range sigCh {
		if sig == syscall.SIGTERM && drainOn {
			if d.Start() {
				log.Printf("SIGTERM: draining")
			} else {
				log.Printf("SIGTERM while %s; exiting when the drain is done", d.Phase())
			}
			if !waiting {
				waiting = true
				go func() { <-d.Done(); stopOnce() }()
			}
			continue
		}
		log.Printf("shutdown signal: %v", sig)
		stopOnce()
		return
	}
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
