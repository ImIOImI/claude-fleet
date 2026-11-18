// Package activity reads claude's own per-process status file
// (~/.claude/sessions/<pid>.json, status busy|idle|waiting; SPEC §5).
// Anything unreadable counts as busy, so a drain waits instead of cutting a turn.
package activity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

type Kind int

const (
	Busy Kind = iota
	Idle
	Waiting
)

func (k Kind) String() string {
	switch k {
	case Idle:
		return "idle"
	case Waiting:
		return "waiting"
	}
	return "busy"
}

const maxFileBytes = 64 << 10

type Reader struct{ Dir string }

func (r Reader) Of(pid int) Kind {
	if pid <= 0 || r.Dir == "" {
		return Busy
	}
	b, err := os.ReadFile(filepath.Join(r.Dir, strconv.Itoa(pid)+".json"))
	if err != nil || len(b) > maxFileBytes {
		return Busy
	}
	var f struct {
		Pid    *int   `json:"pid"`
		Status string `json:"status"`
	}
	if json.Unmarshal(b, &f) != nil || (f.Pid != nil && *f.Pid != pid) {
		return Busy
	}
	switch f.Status {
	case "idle":
		return Idle
	case "waiting":
		return Waiting
	}
	return Busy
}

func DefaultDir(getenv func(string) string) string {
	if d := getenv("CLAUDE_FLEET_BROKER_STATUS_DIR"); d != "" {
		return d
	}
	if h := getenv("HOME"); h != "" {
		return filepath.Join(h, ".claude", "sessions")
	}
	return ""
}
