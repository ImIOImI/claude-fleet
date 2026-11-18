package server

import (
	"context"
	"errors"
	"log"
	"net"

	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
)

// ServeControl serves the local control socket (D142): DRAIN starts the drain
// and streams STATE until done; STATUS answers once. Nothing else is accepted.
func (s *Server) ServeControl(ctx context.Context, ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			log.Printf("control accept: %v", err)
			continue
		}
		go s.handleControl(c)
	}
}

// NoticeDrainRefused answers a DRAIN from a session's own process tree.
const NoticeDrainRefused = "drain-refused"

func (s *Server) handleControl(c net.Conn) {
	defer c.Close()
	cw := &connWriter{w: c}
	for {
		ft, _, err := proto.ReadFrame(c)
		if err != nil {
			return
		}
		switch ft {
		case proto.FrameStatus:
			if cw.writeJSON(proto.FrameState, s.stateNotice()) != nil {
				return
			}
		case proto.FrameDrain:
			if s.Drain == nil {
				return
			}
			if err := s.vetDrainCaller(c); err != nil {
				log.Printf("drain refused: %v", err)
				_ = cw.writeJSON(proto.FrameNotice, proto.Notice{Code: NoticeDrainRefused})
				return
			}
			if s.Drain.Start() {
				log.Printf("drain started (control socket)")
			}
			s.streamState(cw, nil, true)
			return
		default:
			log.Printf("control: unknown frame type 0x%02x", uint8(ft))
		}
	}
}
