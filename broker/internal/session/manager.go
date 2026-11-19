// Package session owns the broker's session map: the set of live claude
// PTYs and the ring buffers fronting them. The server package routes
// frames in and out through Manager; this package knows nothing about
// the wire protocol, only about PTYs and bytes.
package session

import (
	"errors"
	"sort"
	"sync"
	"time"
)

type ManagerConfig struct {
	ClaudeExec   string // executable to run for each session ("claude")
	RingBufBytes int    // per-session ring buffer size
	// OnChange runs after a session is created, ends or is closed.
	OnChange func()
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

// Create spawns an interactive claude PTY under id; see CreateWith.
func (m *Manager) Create(id string, cols, rows uint16, args []string) (*Session, error) {
	return m.CreateWith(id, cols, rows, args, false)
}

// CreateWith spawns a claude PTY under id. ErrIDInUse if the id already
// has a session. The session lives until Close(id) or natural exit.
// args, when non-empty, are appended to the claude exec (e.g.
// ["--resume", "<uuid>"] to resume a prior session).
func (m *Manager) CreateWith(id string, cols, rows uint16, args []string, headless bool) (*Session, error) {
	m.mu.Lock()
	if _, ok := m.sessions[id]; ok {
		m.mu.Unlock()
		return nil, ErrIDInUse
	}
	s, err := newSession(id, m.cfg.ClaudeExec, args, cols, rows, m.cfg.RingBufBytes, headless)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	s.onEnd = m.changed
	m.sessions[id] = s
	m.mu.Unlock()
	// Dead sessions stay in the map (LIST shows them, ATTACH answers "ended"); Close removes.
	go s.wait()
	m.changed()
	return s, nil
}

func (m *Manager) changed() {
	if m.cfg.OnChange != nil {
		m.cfg.OnChange()
	}
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
	m.changed()
}

// List returns a snapshot of every session id + alive flag.
func (m *Manager) List() []SessionInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SessionInfo, 0, len(m.sessions))
	for id, s := range m.sessions {
		out = append(out, SessionInfo{ID: id, Alive: s.Alive(), Ended: s.EndReason()})
	}
	return out
}

// RootPids maps each live session's PTY root pid → session id. LISTPORTS
// uses it to attribute a listening port to the session whose process tree
// spawned the server. Dead-but-listed sessions are excluded: their pid may
// already be reused by an unrelated process.
func (m *Manager) RootPids() map[int]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int]string, len(m.sessions))
	for id, s := range m.sessions {
		if !s.Alive() {
			continue
		}
		if pid := s.Pid(); pid > 0 {
			out[pid] = id
		}
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
	Ended string
}

type Snap struct {
	ID       string
	Alive    bool
	Headless bool
	Pid      int
	Ended    string
}

// Snapshot lists every session, dead ones included, sorted by id.
func (m *Manager) Snapshot() []Snap {
	m.mu.Lock()
	out := make([]Snap, 0, len(m.sessions))
	for id, s := range m.sessions {
		out = append(out, Snap{ID: id, Alive: s.Alive(), Headless: s.headless, Pid: s.Pid(), Ended: s.EndReason()})
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (m *Manager) Terminate(id, reason string) {
	if s := m.Get(id); s != nil {
		s.Terminate(reason, TerminateGrace)
	}
}

func (m *Manager) Interrupt(id string) {
	if s := m.Get(id); s != nil {
		s.Interrupt()
	}
}

// KillAllWait bounds how long KillAll waits for killed sessions to record their reason.
const KillAllWait = 2 * time.Second

// KillAll kills every live session with reason and keeps them listed (CloseAll drops them).
// It returns once each has recorded its end reason, or after KillAllWait.
func (m *Manager) KillAll(reason string) {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	for _, s := range list {
		s.KillWith(reason)
	}
	t := time.NewTimer(KillAllWait)
	defer t.Stop()
	for _, s := range list {
		select {
		case <-s.Done():
		case <-t.C:
			return
		}
	}
}

var (
	ErrIDInUse         = errors.New("session: id already in use")
	ErrNotFound        = errors.New("session: not found")
	ErrEnded           = errors.New("session: already ended")
	ErrAlreadyAttached = errors.New("session: already attached")
)
