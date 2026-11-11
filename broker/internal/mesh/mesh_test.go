package mesh

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func server(t *testing.T, status func(n int32) int) (*httptest.Server, *int32) {
	var hits int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status(atomic.AddInt32(&hits, 1)))
	}))
	t.Cleanup(s.Close)
	return s, &hits
}

func TestReadyAtOnce(t *testing.T) {
	s, _ := server(t, func(int32) int { return 200 })
	if err := WaitReady(context.Background(), s.URL, time.Second, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
}

func TestReadyAfterSomeProbes(t *testing.T) {
	s, hits := server(t, func(n int32) int {
		if n < 3 {
			return 503
		}
		return 200
	})
	if err := WaitReady(context.Background(), s.URL, 2*time.Second, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(hits); got != 3 {
		t.Fatalf("probes = %d, want 3", got)
	}
}

func TestNeverReady(t *testing.T) {
	s, _ := server(t, func(int32) int { return 503 })
	err := WaitReady(context.Background(), s.URL, 100*time.Millisecond, 10*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no Istio sidecar") {
		t.Fatalf("err = %v", err)
	}
}

func TestAbsent(t *testing.T) {
	s, _ := server(t, func(int32) int { return 200 })
	url := s.URL
	s.Close()
	if err := WaitReady(context.Background(), url, 100*time.Millisecond, 10*time.Millisecond); err == nil {
		t.Fatal("ready with nothing listening")
	}
}

func TestCancelled(t *testing.T) {
	s, _ := server(t, func(int32) int { return 503 })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := WaitReady(ctx, s.URL, time.Minute, 10*time.Millisecond); err == nil {
		t.Fatal("ready after cancel")
	}
}

// A redirect to a 200 must not count as ready: Istio's readiness endpoint never redirects,
// and following one would let an unrelated 200 elsewhere pass the check.
func TestRedirectIsNotReady(t *testing.T) {
	target, _ := server(t, func(int32) int { return 200 })
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	t.Cleanup(redirecting.Close)
	err := WaitReady(context.Background(), redirecting.URL, 100*time.Millisecond, 10*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no Istio sidecar") {
		t.Fatalf("err = %v", err)
	}
}

func TestDefaultURL(t *testing.T) {
	if DefaultURL != "http://127.0.0.1:15021/healthz/ready" {
		t.Fatal(DefaultURL)
	}
}

// The budget bounds the wait: a sidecar that never answers fails near timeout, not before.
func TestGivesUpAtTheBudget(t *testing.T) {
	s, _ := server(t, func(int32) int { return 503 })
	start := time.Now()
	if err := WaitReady(context.Background(), s.URL, 300*time.Millisecond, 20*time.Millisecond); err == nil {
		t.Fatal("ready")
	}
	if d := time.Since(start); d < 250*time.Millisecond || d > 2*time.Second {
		t.Fatalf("gave up after %s, want ~300ms", d)
	}
}
