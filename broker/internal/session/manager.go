// Package session owns the broker's session map: the set of live claude
// PTYs and the ring buffers fronting them. The server package routes
// frames in and out through Manager; this package knows nothing about
// the wire protocol, only about PTYs and bytes.
package session

import (
	"errors"
	"sync"
)

type ManagerConfig struct {
	ClaudeExec   string // executable to run for each session ("claude")
	RingBufBytes int    // per-session ring buffer size
}

type Manager struct {
	cfg      ManagerConfig
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager(cfg ManagerConfig) *Manager {
	if cfg.RingBufBytes <= 0 {
		cfg.RingBufBytes = 64 * 1024
	}
	if cfg.ClaudeExec == "" {
		cfg.ClaudeExec = "claude"
	}
	return &Manager{cfg: cfg, sessions: map[string]*Session{}}
}

// Create spawns a new claude PTY under id. ErrIDInUse if the id already
// has a session. The session lives until Close(id) or natural exit.
// args, when non-empty, are appended to the claude exec (e.g.
// ["--resume", "<uuid>"] to resume a prior session).
func (m *Manager) Create(id string, cols, rows uint16, args []string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sessions[id]; ok {
		return nil, ErrIDInUse
	}
	s, err := newSession(id, m.cfg.ClaudeExec, args, cols, rows, m.cfg.RingBufBytes)
	if err != nil {
		return nil, err
	}
	m.sessions[id] = s
	go func() {
		s.wait()
		// Don't remove from the map on natural exit — leave the session
		// marked dead so a LIST still surfaces it (and ATTACH on it
		// returns "ended"). Explicit Close removes.
	}()
	return s, nil
}

// Get returns the session with the given id, or nil if not present.
func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// Close kills the session's PTY and drops it from the map. No-op if
// the id is unknown.
func (m *Manager) Close(id string) {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s != nil {
		s.kill()
	}
}

// List returns a snapshot of every session id + alive flag.
func (m *Manager) List() []SessionInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SessionInfo, 0, len(m.sessions))
	for id, s := range m.sessions {
		out = append(out, SessionInfo{ID: id, Alive: s.Alive()})
	}
	return out
}

// CloseAll kills every session. Used at broker shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	for _, s := range sessions {
		s.kill()
	}
}

type SessionInfo struct {
	ID    string
	Alive bool
}

var (
	ErrIDInUse         = errors.New("session: id already in use")
	ErrNotFound        = errors.New("session: not found")
	ErrEnded           = errors.New("session: already ended")
	ErrAlreadyAttached = errors.New("session: already attached")
)
