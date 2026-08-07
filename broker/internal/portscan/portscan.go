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
