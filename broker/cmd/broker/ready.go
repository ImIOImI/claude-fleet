package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"
)

const defaultReadyPort = "7071"

// readyPort reads CLAUDE_FLEET_BROKER_READY_PORT (default 7071).
func readyPort(getenv func(string) string) (string, error) {
	port := getenv("CLAUDE_FLEET_BROKER_READY_PORT")
	if port == "" {
		return defaultReadyPort, nil
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("CLAUDE_FLEET_BROKER_READY_PORT must be an integer from 1 to 65535, got %q", port)
	}
	return port, nil
}

// openReady binds the readiness listener only when the drain is on.
func openReady(ctx context.Context, drainOn bool, getenv func(string) string) (net.Listener, string, error) {
	if !drainOn {
		return nil, "", nil
	}
	port, err := readyPort(getenv)
	if err != nil {
		return nil, "", err
	}
	// Not loopback: Istio's rewritten probe is dialled by pilot-agent at the pod IP.
	addr := net.JoinHostPort("0.0.0.0", port)
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	return ln, addr, err
}

// serveReady serves h on ln until ctx is cancelled.
func serveReady(ctx context.Context, ln net.Listener, h http.Handler) error {
	hs := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       2 * time.Second,
		WriteTimeout:      2 * time.Second,
		IdleTimeout:       5 * time.Second,
		MaxHeaderBytes:    4 << 10,
	}
	hs.SetKeepAlivesEnabled(false)
	go func() {
		<-ctx.Done()
		_ = hs.Close()
	}()
	return hs.Serve(ln)
}
