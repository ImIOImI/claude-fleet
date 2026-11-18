// Package activity reads claude's own per-process status file
// (~/.claude/sessions/<pid>.json, status busy|idle|waiting; SPEC §5).
// Anything unreadable counts as busy, so a drain waits instead of cutting a turn.
package activity

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
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

type Reader struct {
	Dir string
	// ProcStart returns /proc/<pid>/stat field 22; nil reads /proc.
	ProcStart func(pid int) (string, bool)
}

func (r Reader) Of(pid int) Kind {
	if pid <= 0 || r.Dir == "" {
		return Busy
	}
	b, ok := readBounded(filepath.Join(r.Dir, strconv.Itoa(pid)+".json"))
	if !ok {
		return Busy
	}
	var f struct {
		Pid       *int    `json:"pid"`
		ProcStart *string `json:"procStart"`
		Status    string  `json:"status"`
	}
	if json.Unmarshal(b, &f) != nil || f.Pid == nil || *f.Pid != pid || f.ProcStart == nil {
		return Busy
	}
	ps := r.ProcStart
	if ps == nil {
		ps = procStart
	}
	// A reused pid inherits a dead claude's file; the start time tells them apart.
	if cur, ok := ps(pid); !ok || cur != *f.ProcStart {
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

// The file is writable by every session (same uid): no symlinks, FIFOs or unbounded reads.
func readBounded(path string) ([]byte, bool) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil || len(b) > maxFileBytes {
		return nil, false
	}
	return b, true
}

func procStart(pid int) (string, bool) {
	b, ok := readBounded("/proc/" + strconv.Itoa(pid) + "/stat")
	if !ok {
		return "", false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 || i+2 > len(s) {
		return "", false
	}
	// Fields after "(comm) " start at field 3, so starttime (22) is index 19.
	fields := strings.Fields(s[i+2:])
	if len(fields) < 20 {
		return "", false
	}
	return fields[19], true
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
