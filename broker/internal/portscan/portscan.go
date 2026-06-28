// Package portscan enumerates the TCP ports a process inside the broker's
// container is listening on, by parsing /proc/net/tcp[6]. The fleet user
// can read these without privilege, and we only need the local port — no
// PID/owner mapping — so no CAP_NET_ADMIN or root is required.
package portscan

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
)

// tcpStateListen is the value of the "st" column for a LISTEN socket
// (kernel TCP_LISTEN == 10 == 0x0A), rendered as a 2-char hex string.
const tcpStateListen = "0A"

// Listening returns the deduped set of TCP ports in LISTEN state across
// IPv4 and IPv6. A missing /proc file (non-Linux dev hosts) is not an
// error — it contributes nothing.
func Listening() ([]uint16, error) {
	into := map[uint16]struct{}{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		err = parseProcNet(f, into)
		_ = f.Close()
		if err != nil {
			return nil, err
		}
	}
	out := make([]uint16, 0, len(into))
	for p := range into {
		out = append(out, p)
	}
	return out, nil
}

// parseProcNet scans one /proc/net/tcp-format stream, adding the local
// port of every LISTEN row to `into`. Lines it can't parse are skipped
// (defensive: a malformed row must never abort detection).
func parseProcNet(r io.Reader, into map[uint16]struct{}) error {
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if first {
			first = false // header row
			continue
		}
		fields := strings.Fields(line)
		// fields: sl local_address rem_address st ...
		if len(fields) < 4 || fields[3] != tcpStateListen {
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
		into[uint16(port)] = struct{}{}
	}
	return sc.Err()
}
