package server

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"

	"github.com/ImIOImI/claude-fleet/broker/internal/portscan"
)

const maxCallerHops = 64

func peerPid(c net.Conn) (int, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, errors.New("not a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if credErr != nil {
		return 0, credErr
	}
	return int(cred.Pid), nil
}

// drainCallerErr: DRAIN on the control socket is refused unless the caller's process chain reaches
// ppid 0 (exec'd by the container runtime) without passing a session root, the broker, or pid 1
// (where orphans are reparented). A session can still SIGTERM the broker (same uid), which drains and
// then restarts the container, so it can't leave the pod stuck. Residual: a session can ptrace an
// exec'd process such as the readiness probe (spec Appendix B: ptrace_scope >= 1 or seccomp).
func drainCallerErr(pid, self int, roots map[int]string, ppid func(int) (int, bool)) error {
	for hops := 0; hops < maxCallerHops; hops++ {
		if id, ok := roots[pid]; ok {
			return fmt.Errorf("caller runs in session %s", id)
		}
		// hops > 0: the broker never dials its own socket, but tests do.
		if (hops > 0 && pid == self) || pid == 1 {
			return fmt.Errorf("caller descends from pid %d", pid)
		}
		parent, ok := ppid(pid)
		if !ok {
			return fmt.Errorf("can't read the ancestry of pid %d", pid)
		}
		if parent == 0 {
			return nil
		}
		pid = parent
	}
	return errors.New("caller ancestry is too deep")
}

func (s *Server) vetDrainCaller(c net.Conn) error {
	pid, err := peerPid(c)
	if err != nil {
		return err
	}
	root := s.ProcRoot
	if root == "" {
		root = "/proc"
	}
	return drainCallerErr(pid, os.Getpid(), s.mgr.RootPids(), func(p int) (int, bool) { return portscan.ProcPpid(root, p) })
}
