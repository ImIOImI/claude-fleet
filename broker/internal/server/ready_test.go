package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
)

func get(t *testing.T, h http.Handler, method, path string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	b, _ := io.ReadAll(rec.Result().Body)
	return rec.Code, strings.TrimSpace(string(b))
}

func TestReadyHandlerFollowsThePhase(t *testing.T) {
	r := startDrainRigCfg(t, busyAll, drain.Config{Soft: 50 * time.Millisecond, Hard: 100 * time.Millisecond, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute})
	h := r.srv.ReadyHandler()
	if code, body := get(t, h, http.MethodGet, "/ready"); code != http.StatusOK || body != drain.PhaseServing {
		t.Fatalf("serving: %d %q", code, body)
	}
	r.d.Start()
	if code, body := get(t, h, http.MethodGet, "/ready"); code != http.StatusServiceUnavailable || body != drain.PhaseDraining {
		t.Fatalf("draining: %d %q", code, body)
	}
	<-r.d.Done()
	if code, body := get(t, h, http.MethodGet, "/ready"); code != http.StatusServiceUnavailable || body != drain.PhaseDone {
		t.Fatalf("done: %d %q", code, body)
	}
}

func TestReadyHandlerRejectsEverythingElse(t *testing.T) {
	r := startDrainRig(t, busyAll)
	h := r.srv.ReadyHandler()
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		if code, _ := get(t, h, m, "/ready"); code != http.StatusMethodNotAllowed {
			t.Errorf("%s /ready: %d", m, code)
		}
	}
	for _, p := range []string{"/", "/drain", "/ready/", "/readyz", "/healthz"} {
		if code, _ := get(t, h, http.MethodGet, p); code != http.StatusNotFound {
			t.Errorf("GET %s: %d", p, code)
		}
	}
	if r.d.Phase() != drain.PhaseServing {
		t.Fatalf("phase changed to %s", r.d.Phase())
	}
}

func TestReadyHandlerWithoutDrainerServes(t *testing.T) {
	if code, body := get(t, New(nil).ReadyHandler(), http.MethodGet, "/ready"); code != http.StatusOK || body != drain.PhaseServing {
		t.Fatalf("%d %q", code, body)
	}
}
