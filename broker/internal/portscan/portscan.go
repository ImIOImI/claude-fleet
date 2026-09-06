// Package portscan enumerates the TCP ports a process inside the broker's
// container is listening on, by parsing /proc/net/tcp[6], and attributes
// each to its owning process (socket inode → /proc/*/fd scan → cmdline).
// The fleet user owns every process in the container, so no CAP_NET_ADMIN
// or root is required. Attribution is best-effort: a Detail with Pid 0 is
// a port whose owner could not be resolved (fd race, exotic mounts).
package portscan

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// tcpStateListen is the value of the "st" column for a LISTEN socket
// (kernel TCP_LISTEN == 10 == 0x0A), rendered as a 2-char hex string.
const tcpStateListen = "0A"

// maxCmdline bounds what we ship over the wire per port; the rail
// truncates further for display, this is just a payload cap.
const maxCmdline = 120

// Detail is one listening TCP port and (best-effort) its owner.
type Detail struct {
	Port    uint16
	Pid     int    // 0 when unresolved
	Cmdline string // "" when unresolved
	Session string // owning broker session id; "" when unresolved
}

// Listening returns the deduped set of TCP ports in LISTEN state across
// IPv4 and IPv6, each attributed to its owning process where possible.
// A missing /proc file (non-Linux dev hosts) is not an error — it
// contributes nothing.
func Listening() ([]Detail, error) {
	inodes := map[uint16]uint64{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		err = parseProcNet(f, inodes)
		_ = f.Close()
		if err != nil {
			return nil, err
		}
	}
	owners := resolveOwners(inodes)
	out := make([]Detail, 0, len(inodes))
	for port, inode := range inodes {
		d := Detail{Port: port}
		if o, ok := owners[inode]; ok {
			d.Pid = o.pid
			d.Cmdline = o.cmdline
		}
		out = append(out, d)
	}
	return out, nil
}

// parseProcNet scans one /proc/net/tcp-format stream, recording the local
// port and socket inode of every LISTEN row. Lines it can't parse are
// skipped (defensive: a malformed row must never abort detection). A port
// already present keeps its first inode (v4 wins over a dual-stack v6 row
// — same process either way).
func parseProcNet(r io.Reader, into map[uint16]uint64) error {
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if first {
			first = false // header row
			continue
		}
		fields := strings.Fields(line)
		// fields: sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode ...
		if len(fields) < 10 || fields[3] != tcpStateListen {
			continue
		}
		local := fields[1] // "IPHEX:PORTHEX"
		colon := strings.LastIndex(local, ":")
		if colon < 0 {
			continue
		}
		port, err := strconv.ParseUint(local[colon+1:], 16, 16)
		if err != nil {
			continue
		}
		if _, exists := into[uint16(port)]; exists {
			continue
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		into[uint16(port)] = inode
	}
	return sc.Err()
}

type owner struct {
	pid     int
	cmdline string
}

// resolveOwners maps socket inodes to their owning process by scanning
// /proc/*/fd for "socket:[inode]" symlinks. Entirely best-effort: any
// unreadable dir or vanished process just resolves nothing.
func resolveOwners(inodes map[uint16]uint64) map[uint64]owner {
	want := map[uint64]struct{}{}
	for _, ino := range inodes {
		want[ino] = struct{}{}
	}
	out := map[uint64]owner{}
	if len(want) == 0 {
		return out
	}
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	for _, p := range procs {
		pid, err := strconv.Atoi(p.Name())
		if err != nil {
			continue
		}
		fdDir := "/proc/" + p.Name() + "/fd"
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(fdDir + "/" + fd.Name())
			if err != nil || !strings.HasPrefix(link, "socket:[") || !strings.HasSuffix(link, "]") {
				continue
			}
			ino, err := strconv.ParseUint(link[len("socket:["):len(link)-1], 10, 64)
			if err != nil {
				continue
			}
			if _, wanted := want[ino]; !wanted {
				continue
			}
			if _, done := out[ino]; done {
				continue
			}
			out[ino] = owner{pid: pid, cmdline: readCmdline(pid)}
		}
		if len(out) == len(want) {
			break
		}
	}
	return out
}

// readCmdline renders /proc/<pid>/cmdline (NUL-separated argv) as a
// space-joined string, capped at maxCmdline runes.
func readCmdline(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	s := strings.TrimRight(strings.ReplaceAll(string(b), "\x00", " "), " ")
	if r := []rune(s); len(r) > maxCmdline {
		s = string(r[:maxCmdline]) + "…"
	}
	return s
}

// KillTree terminates the whole process subtree a listening port belongs to
// — the command the user launched plus everything it spawned — rather than
// just the socket-owning leaf. The owner pid is resolved live (no PID-reuse
// hazard), then its /proc ppid ancestry is walked up to the child of the
// owning session's PTY root: that child is the launched command, and its
// entire subtree is signalled. This is what makes "kill" stick for
// supervisors (nodemon, `next dev`, npm, a shell respawn loop) that would
// otherwise relaunch a SIGTERM'd leaf and reopen the port. When the owner
// can't be attributed to any session root, the subtree rooted at the owner
// itself is used — conservative: the walk never climbs past an unknown
// boundary toward the session shell. SIGTERM the subtree, then SIGKILL any
// survivors after grace. `roots` is session-root-pid → session-id, as from
// session.Manager.RootPids.
func KillTree(port uint16, roots map[int]string, grace time.Duration) error {
	details, err := Listening()
	if err != nil {
		return err
	}
	owner := 0
	for _, d := range details {
		if d.Port == port {
			owner = d.Pid
			break
		}
	}
	if owner == 0 {
		return fmt.Errorf("no resolvable owner for port %d", port)
	}
	root := subtreeRoot(owner, roots, procPpid)

	// Snapshot the subtree once, then track liveness per pid — never by
	// re-walking from root. A common dev-server shape is a light parent
	// (npm/sh) over the socket-owning child; SIGTERM fells the parent first
	// and the child, if it traps SIGTERM (graceful shutdown / "reload"),
	// reparents to init while still holding the port. A tree re-walk from
	// root loses that reparented child and would report a false success with
	// the port still up. The captured set keeps every pid addressable so the
	// SIGKILL escalation still reaches it. The owner is always in the set (it
	// is root or a descendant of root).
	targets := descendants(root)
	signalPids(targets, syscall.SIGTERM)
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !anyAlive(targets) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Escalate to survivors, folding in any late forks still linked to root.
	signalPids(mergePids(targets, descendants(root)), syscall.SIGKILL)
	return nil
}

// subtreeRoot walks up from the port owner and returns the pid of the
// command launched under a session — the highest ancestor whose parent is a
// session root. When no ancestor is a session root (unattributed / orphaned),
// it returns the owner itself so the kill can never climb toward the shell.
func subtreeRoot(owner int, roots map[int]string, ppid func(int) (int, bool)) int {
	cur := owner
	for hops := 0; hops < maxAncestryHops; hops++ {
		parent, ok := ppid(cur)
		if !ok {
			break
		}
		if _, isRoot := roots[parent]; isRoot {
			return cur
		}
		if parent <= 1 {
			break
		}
		cur = parent
	}
	return owner
}

// descendants returns root plus every process transitively descended from it,
// by building the child map from a single /proc scan. A process that exits
// mid-scan simply doesn't appear — callers re-scan to confirm liveness.
func descendants(root int) []int {
	children := map[int][]int{}
	if procs, err := os.ReadDir("/proc"); err == nil {
		for _, p := range procs {
			pid, err := strconv.Atoi(p.Name())
			if err != nil {
				continue
			}
			if pp, ok := procPpid(pid); ok {
				children[pp] = append(children[pp], pid)
			}
		}
	}
	// A root with no /proc entry and no children is already gone.
	if _, exists := procPpid(root); !exists && len(children[root]) == 0 {
		return nil
	}
	out := []int{}
	seen := map[int]bool{}
	stack := []int{root}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
		stack = append(stack, children[n]...)
	}
	return out
}

// signalPids sends sig to each pid, skipping pid<=1 (init / process-group
// sentinels). Errors on already-gone pids are ignored: the caller polls
// liveness. Unlike a tree walk this hits reparented survivors too, because
// the pids were captured while the subtree was intact.
func signalPids(pids []int, sig syscall.Signal) {
	for _, pid := range pids {
		if pid > 1 {
			_ = syscall.Kill(pid, sig)
		}
	}
}

// alive reports whether pid still names a process. Signal 0 is delivered to
// no one but performs the kernel's existence/permission check: nil or EPERM
// means the pid exists (EPERM = exists but not ours — can't happen for our
// own children, kept for safety), ESRCH means it is gone. A zombie still
// "exists" until reaped, which is fine — the escalation SIGKILL is a no-op on
// it and the real survivor in the set is what we care about.
func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// anyAlive reports whether any pid in the captured set is still running.
func anyAlive(pids []int) bool {
	for _, pid := range pids {
		if alive(pid) {
			return true
		}
	}
	return false
}

// mergePids returns the union of two pid slices, preserving first-seen order.
func mergePids(a, b []int) []int {
	seen := make(map[int]bool, len(a)+len(b))
	out := make([]int, 0, len(a)+len(b))
	for _, group := range [][]int{a, b} {
		for _, pid := range group {
			if !seen[pid] {
				seen[pid] = true
				out = append(out, pid)
			}
		}
	}
	return out
}

// KillOwner terminates the process listening on port. The PID is resolved
// from the live socket AT CALL TIME — never accepted from the host — which
// removes any PID-reuse hazard. SIGTERM first; if the process survives
// `grace`, SIGKILL. Returns an error when the port has no resolvable owner
// or the first signal fails.
func KillOwner(port uint16, grace time.Duration) error {
	details, err := Listening()
	if err != nil {
		return err
	}
	pid := 0
	for _, d := range details {
		if d.Port == port {
			pid = d.Pid
			break
		}
	}
	if pid == 0 {
		return fmt.Errorf("no resolvable owner for port %d", port)
	}
	proc, err := os.FindProcess(pid) // never fails on unix
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			return nil // gone
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = proc.Signal(syscall.SIGKILL)
	return nil
}
