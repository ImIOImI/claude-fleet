package session

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

// Session owns a single claude PTY and the bytes flowing through it.
// One Session has one ring buffer, one optional attached writer
// (whoever's claimed it for delivery), and the underlying os.Process
// that gets killed when the session is closed.
//
// Lifecycle:
//
//	newSession → ALIVE (PTY pump running)
//	          → DEAD  (wait() saw exit; ring buffer still readable)
//
// Concurrency: a Session is touched by:
//   - exactly one PTY-output goroutine (writes ring + attached writer)
//   - at most one connection at a time (input writes, resize, attach/detach)
//   - the manager (for List/Close)
//
// The mu protects the attach state (writer, channel, dead flag). The
// ring buffer has its own mu. The PTY file is set-once at construction.

type Session struct {
	id   string
	cmd  *exec.Cmd
	ptmx *os.File

	ring *ringBuffer

	mu       sync.Mutex
	attached attachState
	dead     bool
	exitErr  error
	done     chan struct{}
}

type attachState struct {
	// writer receives output frames bound for this session's channel.
	// nil when no connection is attached. The writer is owned by the
	// connection goroutine — the session doesn't close it.
	writer ChannelWriter
	// channel id reserved by the active connection. Only meaningful
	// when writer != nil.
	channel uint32
}

// ChannelWriter is what an attached connection exposes to a session:
// "deliver this chunk of stdout bytes on my channel." A narrow
// interface so tests can stub it without spinning up sockets.
type ChannelWriter interface {
	WriteChannelData(channel uint32, body []byte) error
}

func newSession(id, command string, args []string, cols, rows uint16, ringBytes int) (*Session, error) {
	cmd := exec.Command(command, args...)
	// TERM for the TUI; CLAUDE_FLEET_BROKER_SESSION_ID so in-container hooks
	// can pair their claude session with the tab that owns this PTY (#207).
	cmd.Env = append(cmd.Environ(),
		"TERM=xterm-256color",
		"CLAUDE_FLEET_BROKER_SESSION_ID="+id,
	)
	// Detach the child from the broker's controlling tty so signals
	// the broker receives don't propagate automatically.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}

	s := &Session{
		id:   id,
		cmd:  cmd,
		ptmx: f,
		ring: newRingBuffer(ringBytes),
		done: make(chan struct{}),
	}
	go s.pump()
	return s, nil
}

// pump reads from the PTY forever, appending to the ring buffer and
// forwarding to any attached writer. Exits on PTY EOF (the child
// exited, or the PTY was closed).
func (s *Session) pump() {
	buf := make([]byte, 16*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			s.ring.Write(chunk)
			s.mu.Lock()
			w := s.attached.writer
			ch := s.attached.channel
			s.mu.Unlock()
			if w != nil {
				// Ignore write errors — they mean the host disconnected.
				// The session lives on; the next attach catches up via
				// the ring buffer.
				_ = w.WriteChannelData(ch, chunk)
			}
		}
		if err != nil {
			break
		}
	}
}

// wait blocks until claude exits, then marks the session dead. Called
// by the manager in a goroutine right after newSession returns.
func (s *Session) wait() {
	err := s.cmd.Wait()
	s.mu.Lock()
	s.dead = true
	s.exitErr = err
	close(s.done)
	s.mu.Unlock()
}

// Done returns a channel closed when the session has ended.
func (s *Session) Done() <-chan struct{} { return s.done }

// ID returns the session id.
func (s *Session) ID() string { return s.id }

// Alive reports whether claude is still running.
func (s *Session) Alive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.dead
}

// ExitError returns the wait() error after the session ends, or nil.
func (s *Session) ExitError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exitErr
}

// Attach claims the session for delivery on the given channel via w.
// Returns the ring buffer's current contents — the caller is expected
// to ship these as HISTORY frames before live OUTPUT begins.
// ErrEnded if the session has already exited; ErrAlreadyAttached if a
// live writer already holds the session (the caller must DETACH first).
func (s *Session) Attach(w ChannelWriter, channel uint32) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return s.ring.ReplaySnapshot(), ErrEnded
	}
	if s.attached.writer != nil {
		// Already claimed by a live connection. Reject rather than stomp
		// the existing writer — otherwise the original connection silently
		// goes blind (its OUTPUT flows to the new writer) while still
		// believing it's attached (#64). The host's normal re-attach
		// DETACHes first, so it never trips this; only a second connection
		// (external probe, future second window) reaches here.
		return nil, ErrAlreadyAttached
	}
	s.attached = attachState{writer: w, channel: channel}
	return s.ring.ReplaySnapshot(), nil
}

// Detach drops the current writer if it's the one passed in. The
// owner check prevents a stale connection from clobbering a fresh
// attach. No-op otherwise.
func (s *Session) Detach(w ChannelWriter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attached.writer == w {
		s.attached = attachState{}
	}
}

// Input feeds bytes into the PTY's stdin. Returns the write error if
// the PTY is closed (session ended).
func (s *Session) Input(b []byte) error {
	_, err := s.ptmx.Write(b)
	return err
}

// Resize forwards a window-size change to the PTY.
func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// kill terminates the PTY (and thus claude). Safe to call multiple times.
func (s *Session) kill() {
	_ = s.ptmx.Close()
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

// Pid returns the root pid of the session's claude process, or 0 when the
// process is gone or never started. Used for port→session attribution.
func (s *Session) Pid() int {
	if s.cmd != nil && s.cmd.Process != nil {
		return s.cmd.Process.Pid
	}
	return 0
}
