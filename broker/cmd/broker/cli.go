package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
	"github.com/ImIOImI/claude-fleet/broker/internal/server"
)

// runCLI serves the preStop hook (drain) and an operator check (ready: exit 0 while serving).
// The readiness probe is GET /ready, not this.
func runCLI(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	path := ctlPath(getenv)
	switch args[0] {
	case "drain":
		return cliDrain(path, stdout, stderr)
	case "ready":
		return cliReady(path)
	}
	fmt.Fprintln(stderr, "usage: broker [drain|ready]")
	return 2
}

func cliDrain(path string, stdout, stderr io.Writer) int {
	c, err := net.Dial("unix", path)
	if err != nil {
		fmt.Fprintf(stderr, "broker drain: %v\n", err)
		return 1
	}
	defer c.Close()
	if err := proto.WriteJSONFrame(c, proto.FrameDrain, struct{}{}); err != nil {
		fmt.Fprintf(stderr, "broker drain: %v\n", err)
		return 1
	}
	for {
		ft, payload, err := proto.ReadFrame(c)
		if err != nil {
			// The broker is gone: nothing is left to wait for.
			fmt.Fprintln(stdout, `{"phase":"gone"}`)
			return 0
		}
		if ft == proto.FrameNotice {
			var n proto.Notice
			if json.Unmarshal(payload, &n) == nil && n.Code == server.NoticeDrainRefused {
				fmt.Fprintln(stderr, "broker drain: refused: run it from outside the workspace's sessions (preStop or kubectl exec)")
				return 1
			}
			continue
		}
		if ft != proto.FrameState {
			continue
		}
		var st proto.StateNotice
		if json.Unmarshal(payload, &st) != nil {
			continue
		}
		alive := 0
		for _, s := range st.Sessions {
			if s.Alive {
				alive++
			}
		}
		fmt.Fprintf(stdout, "{\"phase\":%q,\"alive\":%d,\"softAt\":%d,\"hardAt\":%d}\n", st.Phase, alive, st.SoftAt, st.HardAt)
		if st.Phase == drain.PhaseDone {
			return 0
		}
	}
}

func cliReady(path string) int {
	c, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		return 1
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if proto.WriteJSONFrame(c, proto.FrameStatus, struct{}{}) != nil {
		return 1
	}
	for {
		ft, payload, err := proto.ReadFrame(c)
		if err != nil {
			return 1
		}
		if ft != proto.FrameState {
			continue
		}
		var st proto.StateNotice
		if json.Unmarshal(payload, &st) != nil || st.Phase != drain.PhaseServing {
			return 1
		}
		return 0
	}
}
