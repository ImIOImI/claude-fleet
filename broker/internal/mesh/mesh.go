// Package mesh waits for the pod's Istio sidecar before the broker listens:
// the broker has no authentication of its own (SPEC §9).
package mesh

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// DefaultURL is the sidecar's readiness endpoint.
const DefaultURL = "http://127.0.0.1:15021/healthz/ready"

// WaitReady polls url every interval until it answers 200, or fails once
// timeout has passed or ctx ends.
func WaitReady(ctx context.Context, url string, timeout, interval time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().Add(interval).After(deadline) {
			return fmt.Errorf("no Istio sidecar: %s not ready after %s", url, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}
