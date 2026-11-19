// Package drain runs the broker's graceful drain (SPEC §7 *Workspace pod drain*):
// serving → draining → done. Idle and waiting sessions close at once, busy
// turns finish until Soft (then Esc / SIGINT), and everything dies at Hard.
package drain

import (
	"context"
	"sync"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

const (
	PhaseServing  = "serving"
	PhaseDraining = "draining"
	PhaseDone     = "done"
)

type Config struct {
	Soft, Hard time.Duration
	// FirstPass lets fleet-host and desktops hear "draining" before anything closes.
	FirstPass time.Duration
	Poll      time.Duration
	EscEvery  time.Duration
}

func DefaultConfig() Config {
	return Config{Soft: 30 * time.Minute, Hard: 35 * time.Minute, FirstPass: 2 * time.Second, Poll: time.Second, EscEvery: time.Minute}
}

type Target interface {
	Snapshot() []session.Snap
	Terminate(id, reason string)
	Interrupt(id string)
	KillAll(reason string)
}

type State struct {
	Instance  string
	Phase     string
	StartedAt time.Time
	SoftAt    time.Time
	HardAt    time.Time
	Sessions  []session.Snap
}

type Notifier interface{ Notify() }

type Drainer struct {
	cfg      Config
	target   Target
	activity func(pid int) activity.Kind
	now      func() time.Time
	instance string
	bus      Notifier

	mu          sync.Mutex
	phase       string
	startedAt   time.Time
	lastEsc     map[string]time.Time
	interrupted map[string]bool
	started     chan struct{}
	done        chan struct{}
}

func New(cfg Config, t Target, act func(int) activity.Kind, now func() time.Time, instance string, bus Notifier) *Drainer {
	return &Drainer{
		cfg: cfg, target: t, activity: act, now: now, instance: instance, bus: bus,
		phase: PhaseServing, lastEsc: map[string]time.Time{}, interrupted: map[string]bool{},
		started: make(chan struct{}), done: make(chan struct{}),
	}
}

func (d *Drainer) Phase() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.phase
}

func (d *Drainer) Done() <-chan struct{} { return d.done }

// Start begins the drain; false if one already started (the deadlines never move).
func (d *Drainer) Start() bool {
	d.mu.Lock()
	if d.phase != PhaseServing {
		d.mu.Unlock()
		return false
	}
	d.phase = PhaseDraining
	d.startedAt = d.now()
	close(d.started)
	d.mu.Unlock()
	d.bus.Notify()
	return true
}

func (d *Drainer) State() State {
	d.mu.Lock()
	st := State{Instance: d.instance, Phase: d.phase}
	if !d.startedAt.IsZero() {
		st.StartedAt = d.startedAt
		st.SoftAt = d.startedAt.Add(d.cfg.Soft)
		st.HardAt = d.startedAt.Add(d.cfg.Hard)
	}
	d.mu.Unlock()
	st.Sessions = d.target.Snapshot()
	return st
}

// Step is one pass; Run calls it, tests call it with a fake clock.
func (d *Drainer) Step() {
	d.mu.Lock()
	if d.phase != PhaseDraining {
		d.mu.Unlock()
		return
	}
	now := d.now()
	elapsed := now.Sub(d.startedAt)
	d.mu.Unlock()
	if elapsed >= d.cfg.Hard {
		d.target.KillAll(session.ReasonKilled)
		d.finish()
		return
	}
	alive := 0
	for _, s := range d.target.Snapshot() {
		if !s.Alive {
			continue
		}
		alive++
		if !s.Headless {
			if k := d.activity(s.Pid); k == activity.Idle || k == activity.Waiting {
				reason := session.ReasonIdle
				if d.wasInterrupted(s.ID) {
					reason = session.ReasonInterrupted
				}
				d.target.Terminate(s.ID, reason)
				continue
			}
		}
		if elapsed >= d.cfg.Soft && d.escDue(s.ID, s.Headless, now) {
			d.target.Interrupt(s.ID)
		}
	}
	if alive == 0 {
		d.finish()
	}
}

func (d *Drainer) wasInterrupted(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.interrupted[id]
}

// Headless sessions get one SIGINT; interactive ones get Esc every EscEvery.
func (d *Drainer) escDue(id string, headless bool, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	last, sent := d.lastEsc[id]
	if sent && (headless || now.Sub(last) < d.cfg.EscEvery) {
		return false
	}
	d.lastEsc[id] = now
	d.interrupted[id] = true
	return true
}

func (d *Drainer) finish() {
	d.mu.Lock()
	if d.phase == PhaseDone {
		d.mu.Unlock()
		return
	}
	d.phase = PhaseDone
	d.mu.Unlock()
	// Wake WATCH before Done releases the shutdown, so the final STATE gets written.
	d.bus.Notify()
	close(d.done)
}

// Run waits for Start, then passes every Poll until done or ctx ends.
func (d *Drainer) Run(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-d.started:
	}
	t := time.NewTimer(d.cfg.FirstPass)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.done:
			return
		case <-t.C:
			d.Step()
			t.Reset(d.cfg.Poll)
		}
	}
}
