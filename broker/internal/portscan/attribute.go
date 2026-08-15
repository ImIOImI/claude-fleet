// Port→session attribution: walk a port-owner's /proc ppid ancestry until
// it hits a live broker session's PTY root pid. Best-effort everywhere — a
// read failure, an orphaned process (reparented to init), or a chain past
// the hop limit just leaves Session empty; attribution must never fail a
// LISTPORTS response.
package portscan

import (
	"os"
	"strconv"
	"strings"
)

// maxAncestryHops bounds the walk; real container process trees are a
// handful deep, so 32 only guards against ppid-table cycles or churn.
const maxAncestryHops = 32

// AttributeSessions stamps each attributed Detail with the session whose
// process tree contains the port's owner. roots maps session root pid →
// session id (from session.Manager.RootPids).
func AttributeSessions(details []Detail, roots map[int]string) {
	attributeSessions(details, roots, procPpid)
}

func attributeSessions(details []Detail, roots map[int]string, ppid func(int) (int, bool)) {
	if len(roots) == 0 {
		return
	}
	for i := range details {
		details[i].Session = sessionFor(details[i].Pid, roots, ppid)
	}
}

func sessionFor(pid int, roots map[int]string, ppid func(int) (int, bool)) string {
	for hops := 0; pid > 1 && hops < maxAncestryHops; hops++ {
		if id, ok := roots[pid]; ok {
			return id
		}
		next, ok := ppid(pid)
		if !ok {
			return ""
		}
		pid = next
	}
	return ""
}

// procPpid reads a process's parent pid from /proc/<pid>/stat.
func procPpid(pid int) (int, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	return parsePpidFromStat(string(b))
}

// parsePpidFromStat extracts field 4 (ppid) from a /proc/<pid>/stat line.
// The comm field may itself contain spaces and parens, so fields are
// counted after the LAST ')'.
func parsePpidFromStat(stat string) (int, bool) {
	closeIdx := strings.LastIndexByte(stat, ')')
	if closeIdx < 0 {
		return 0, false
	}
	fields := strings.Fields(stat[closeIdx+1:])
	// fields after comm: state ppid pgrp session ... — ppid is index 1.
	if len(fields) < 2 {
		return 0, false
	}
	p, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, false
	}
	return p, true
}
