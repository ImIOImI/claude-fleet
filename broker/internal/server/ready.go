package server

import (
	"net/http"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
)

// ReadyHandler is the kubelet readiness probe: GET /ready is 200 while serving,
// else 503 with the phase. Read-only, so no caller can change the drain through it.
func (s *Server) ReadyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ready" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		phase := s.phase()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if phase != drain.PhaseServing {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_, _ = w.Write([]byte(phase + "\n"))
	})
}
