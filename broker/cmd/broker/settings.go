package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
)

const defaultCtlSocket = "/run/broker/ctl.sock"

// drainSettings reads the operator settings (D153); on is CLAUDE_FLEET_BROKER_DRAIN=1.
func drainSettings(getenv func(string) string) (bool, drain.Config, error) {
	cfg := drain.DefaultConfig()
	on := getenv("CLAUDE_FLEET_BROKER_DRAIN")
	switch on {
	case "", "0", "1":
	default:
		return false, cfg, fmt.Errorf("CLAUDE_FLEET_BROKER_DRAIN must be '', 0 or 1, got %q", on)
	}
	for _, v := range []struct {
		key string
		dst *time.Duration
	}{{"CLAUDE_FLEET_BROKER_DRAIN_SOFT", &cfg.Soft}, {"CLAUDE_FLEET_BROKER_DRAIN_HARD", &cfg.Hard}} {
		raw := getenv(v.key)
		if raw == "" {
			continue
		}
		d, err := time.ParseDuration(raw)
		if err != nil {
			return false, cfg, fmt.Errorf("%s: %v", v.key, err)
		}
		*v.dst = d
	}
	if cfg.Soft < time.Second || cfg.Hard <= cfg.Soft || cfg.Hard > 24*time.Hour {
		return false, cfg, fmt.Errorf("CLAUDE_FLEET_BROKER_DRAIN_SOFT and CLAUDE_FLEET_BROKER_DRAIN_HARD need 1s <= soft < hard <= 24h, got %v and %v", cfg.Soft, cfg.Hard)
	}
	return on == "1", cfg, nil
}

func ctlPath(getenv func(string) string) string {
	if p := getenv("CLAUDE_FLEET_BROKER_CTL_SOCKET"); p != "" {
		return p
	}
	return defaultCtlSocket
}

// openControl opens the control socket only when the drain is on (D142).
func openControl(ctx context.Context, drainOn bool, getenv func(string) string) (net.Listener, error) {
	if !drainOn {
		return nil, nil
	}
	return listenCtl(ctx, ctlPath(getenv))
}

func listenCtl(ctx context.Context, path string) (net.Listener, error) {
	return listenCtlHook(ctx, path, nil)
}

// umaskMu serialises the process-wide umask swap.
var umaskMu sync.Mutex

// listenCtlHook binds under umask 0177 so the socket is 0600 from the first instant;
// afterBind (tests) runs before anything else touches it.
func listenCtlHook(ctx context.Context, path string, afterBind func()) (net.Listener, error) {
	if fi, err := os.Lstat(path); err == nil {
		st, _ := fi.Sys().(*syscall.Stat_t)
		if fi.Mode().Type() != os.ModeSocket || st == nil || int(st.Uid) != os.Geteuid() {
			return nil, fmt.Errorf("refusing to replace %s: not our socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("remove stale control socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var lc net.ListenConfig
	umaskMu.Lock()
	old := syscall.Umask(0o177)
	ln, err := lc.Listen(ctx, "unix", path)
	syscall.Umask(old)
	umaskMu.Unlock()
	if err != nil {
		return nil, err
	}
	if afterBind != nil {
		afterBind()
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod control socket: %w", err)
	}
	return ln, nil
}

func newInstance() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
