// Package server accepts host connections on the broker socket and
// routes wire-protocol frames to/from the session.Manager.
//
// One Server, many connections. Each accepted connection runs in its
// own goroutine (handleConn) and has its own attach-table (channel id
// → session id). Channels are scoped to a connection: when a
// connection ends, the sessions it was attached to are detached but
// keep running — the broker is the durable layer.
//
// The Server is concurrency-safe at the API level (Manager has its own
// mutex). Per-connection state is goroutine-local; we serialize writes
// to the same net.Conn via a mutex inside connWriter.

package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/portscan"
	"github.com/ImIOImI/claude-fleet/broker/internal/proto"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

type Server struct {
	mgr *session.Manager
	// ListPorts enumerates listening TCP ports (with best-effort owner
	// attribution) for LISTPORTS. Field so tests can inject a deterministic
	// scanner; defaults to a closure that calls portscan.Listening then
	// portscan.AttributeSessions with the manager's current root PIDs.
	ListPorts func() ([]portscan.Detail, error)
	// KillPort terminates the process behind a listening port for KILLPORT.
	// Injectable for tests; defaults to portscan.KillTree (the whole command
	// subtree, so a supervisor like nodemon/`next dev` can't respawn the
	// listener and reopen the port) with a 2s grace.
	KillPort func(port uint16) error
}

func New(mgr *session.Manager) *Server {
	return &Server{
		mgr: mgr,
		ListPorts: func() ([]portscan.Detail, error) {
			details, err := portscan.Listening()
			if err == nil {
				portscan.AttributeSessions(details, mgr.RootPids())
			}
			return details, err
		},
		// RootPids is read fresh per kill so attribution reflects live sessions.
		KillPort: func(port uint16) error { return portscan.KillTree(port, mgr.RootPids(), 2*time.Second) },
	}
}

// Serve accepts connections on ln until ctx is canceled or the listener
// closes. Each connection runs in its own goroutine.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			log.Printf("accept: %v", err)
			continue
		}
		go s.handleConn(ctx, c)
	}
}

// connWriter serializes writes to one net.Conn. Multiple goroutines
// produce frames (the connection's read loop + every attached
// session's pump), so we need a mutex around each WriteFrame.
type connWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (cw *connWriter) writeFrame(t proto.FrameType, payload []byte) error {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	return proto.WriteFrame(cw.w, t, payload)
}

func (cw *connWriter) writeJSON(t proto.FrameType, v any) error {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	return proto.WriteJSONFrame(cw.w, t, v)
}

// WriteChannelData satisfies session.ChannelWriter — the session pump
// calls this with each chunk of PTY output for the channel it's
// attached on.
func (cw *connWriter) WriteChannelData(channel uint32, body []byte) error {
	return cw.writeFrame(proto.FrameOutput, proto.EncodeChannelData(channel, body))
}

func (s *Server) handleConn(ctx context.Context, c net.Conn) {
	defer c.Close()
	cw := &connWriter{w: c}

	// Channel id → session id, scoped to this connection only.
	attached := map[uint32]string{}
	defer func() {
		// On disconnect, detach every channel we owned. Sessions stay
		// alive in the manager; the next attach catches up via ring.
		for _, id := range attached {
			if sess := s.mgr.Get(id); sess != nil {
				sess.Detach(cw)
			}
		}
	}()

	// Channel id → dialed TCP conn (port-forward relay), scoped to this
	// connection. Disjoint from `attached` (PTY channels).
	dialed := map[uint32]net.Conn{}
	defer func() {
		for _, conn := range dialed {
			_ = conn.Close()
		}
	}()

	for {
		if ctx.Err() != nil {
			return
		}
		ft, payload, err := proto.ReadFrame(c)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				log.Printf("read frame: %v", err)
			}
			return
		}
		if err := s.dispatch(ft, payload, cw, attached, dialed); err != nil {
			log.Printf("dispatch %v: %v", ft, err)
			// Protocol-level errors are non-fatal — keep the conn
			// open so the host can recover. Truly fatal errors would
			// return them; today there are none.
		}
	}
}

func (s *Server) dispatch(
	ft proto.FrameType,
	payload []byte,
	cw *connWriter,
	attached map[uint32]string,
	dialed map[uint32]net.Conn,
) error {
	switch ft {
	case proto.FrameCreate:
		var req proto.CreateRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameCreated, proto.CreateResponse{ID: req.ID, OK: false, Error: "bad json"})
		}
		if req.ID == "" {
			return cw.writeJSON(proto.FrameCreated, proto.CreateResponse{ID: req.ID, OK: false, Error: "missing id"})
		}
		if req.Cols == 0 || req.Rows == 0 {
			req.Cols, req.Rows = 80, 24
		}
		if _, err := s.mgr.Create(req.ID, req.Cols, req.Rows, req.Args); err != nil {
			return cw.writeJSON(proto.FrameCreated, proto.CreateResponse{ID: req.ID, OK: false, Error: err.Error()})
		}
		return cw.writeJSON(proto.FrameCreated, proto.CreateResponse{ID: req.ID, OK: true})

	case proto.FrameAttach:
		var req proto.AttachRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameAttached, proto.AttachResponse{Channel: req.Channel, OK: false, Error: "bad json"})
		}
		sess := s.mgr.Get(req.ID)
		if sess == nil {
			return cw.writeJSON(proto.FrameAttached, proto.AttachResponse{Channel: req.Channel, OK: false, Error: "no such session"})
		}
		// If the channel is already attached to something else on this
		// connection, reject — the host should DETACH first.
		if existing, ok := attached[req.Channel]; ok {
			return cw.writeJSON(proto.FrameAttached, proto.AttachResponse{
				Channel: req.Channel, OK: false,
				Error: "channel in use by session " + existing,
			})
		}
		history, err := sess.Attach(cw, req.Channel)
		if err != nil && !errors.Is(err, session.ErrEnded) {
			return cw.writeJSON(proto.FrameAttached, proto.AttachResponse{Channel: req.Channel, OK: false, Error: err.Error()})
		}
		attached[req.Channel] = req.ID
		if ackErr := cw.writeJSON(proto.FrameAttached, proto.AttachResponse{Channel: req.Channel, OK: true}); ackErr != nil {
			return ackErr
		}
		if len(history) > 0 {
			if hErr := cw.writeFrame(proto.FrameHistory, proto.EncodeChannelData(req.Channel, history)); hErr != nil {
				return hErr
			}
		}
		if errors.Is(err, session.ErrEnded) {
			// Session already gone — send ENDED right after history so
			// the host knows not to expect live output.
			return cw.writeJSON(proto.FrameEnded, proto.EndedNotice{Channel: req.Channel, Reason: "exit"})
		}
		// Wire up an ENDED notice if/when the session finishes while
		// this connection is still attached on this channel.
		go func(ch uint32, id string) {
			<-sess.Done()
			// Check that this channel is still ours.
			if _, ok := attached[ch]; ok && attached[ch] == id {
				_ = cw.writeJSON(proto.FrameEnded, proto.EndedNotice{Channel: ch, Reason: "exit"})
			}
		}(req.Channel, req.ID)
		return nil

	case proto.FrameDetach:
		var req proto.ChannelRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameDetached, proto.ChannelResponse{Channel: req.Channel, OK: false, Error: "bad json"})
		}
		id, ok := attached[req.Channel]
		if !ok {
			return cw.writeJSON(proto.FrameDetached, proto.ChannelResponse{Channel: req.Channel, OK: false, Error: "channel not attached"})
		}
		if sess := s.mgr.Get(id); sess != nil {
			sess.Detach(cw)
		}
		delete(attached, req.Channel)
		return cw.writeJSON(proto.FrameDetached, proto.ChannelResponse{Channel: req.Channel, OK: true})

	case proto.FrameClose:
		var req proto.ChannelRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: false, Error: "bad json"})
		}
		if conn, ok := dialed[req.Channel]; ok {
			_ = conn.Close()
			delete(dialed, req.Channel)
			return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: true})
		}
		id, ok := attached[req.Channel]
		if !ok {
			return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: false, Error: "channel not attached"})
		}
		s.mgr.Close(id)
		delete(attached, req.Channel)
		return cw.writeJSON(proto.FrameClosed, proto.ChannelResponse{Channel: req.Channel, OK: true})

	case proto.FrameInput:
		channel, body, err := proto.DecodeChannelData(payload)
		if err != nil {
			return err
		}
		if conn, ok := dialed[channel]; ok {
			_, _ = conn.Write(body) // ignore: closed conn just drops bytes
			return nil
		}
		id, ok := attached[channel]
		if !ok {
			return nil // silently drop input for unknown channels
		}
		sess := s.mgr.Get(id)
		if sess == nil {
			return nil
		}
		return sess.Input(body)

	case proto.FrameResize:
		channel, cols, rows, err := proto.DecodeResize(payload)
		if err != nil {
			return err
		}
		id, ok := attached[channel]
		if !ok {
			return nil
		}
		sess := s.mgr.Get(id)
		if sess == nil {
			return nil
		}
		return sess.Resize(cols, rows)

	case proto.FrameList:
		infos := s.mgr.List()
		resp := proto.SessionsResponse{Sessions: make([]proto.SessionInfo, len(infos))}
		for i, info := range infos {
			resp.Sessions[i] = proto.SessionInfo{ID: info.ID, Alive: info.Alive}
		}
		return cw.writeJSON(proto.FrameSessions, resp)

	case proto.FrameDial:
		var req proto.DialRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: false, Error: "bad json"})
		}
		if _, exists := dialed[req.Channel]; exists {
			return cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: false, Error: "channel in use"})
		}
		// Security: only ever 127.0.0.1 — never an arbitrary host/IP.
		addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(req.Port)))
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			return cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: false, Error: err.Error()})
		}
		dialed[req.Channel] = conn
		if err := cw.writeJSON(proto.FrameDialed, proto.DialResponse{Channel: req.Channel, OK: true}); err != nil {
			_ = conn.Close()
			delete(dialed, req.Channel)
			return err
		}
		// Pump conn → OUTPUT frames on this channel until the conn closes,
		// then signal ENDED (mirrors a PTY session ending). The conn stays
		// in `dialed` until CLOSE or disconnect cleanup — the read loop owns
		// the map, so this goroutine never touches it.
		go func(ch uint32, c net.Conn) {
			buf := make([]byte, 32*1024)
			for {
				n, rerr := c.Read(buf)
				if n > 0 {
					_ = cw.WriteChannelData(ch, buf[:n])
				}
				if rerr != nil {
					break
				}
			}
			_ = cw.writeJSON(proto.FrameEnded, proto.EndedNotice{Channel: ch, Reason: "exit"})
		}(req.Channel, conn)
		return nil

	case proto.FrameListPorts:
		ports, err := s.ListPorts()
		if err != nil {
			log.Printf("listports: %v", err)
			ports = nil
		}
		resp := proto.PortsResponse{Ports: make([]proto.PortInfo, len(ports))}
		for i, p := range ports {
			resp.Ports[i] = proto.PortInfo{Port: p.Port, Pid: p.Pid, Cmdline: p.Cmdline, Session: p.Session}
		}
		return cw.writeJSON(proto.FramePorts, resp)

	case proto.FrameKillPort:
		var req proto.KillPortRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return cw.writeJSON(proto.FrameKilled, proto.KilledResponse{OK: false, Error: "bad json"})
		}
		if err := s.KillPort(req.Port); err != nil {
			return cw.writeJSON(proto.FrameKilled, proto.KilledResponse{OK: false, Error: err.Error()})
		}
		return cw.writeJSON(proto.FrameKilled, proto.KilledResponse{OK: true})

	default:
		// Unknown frame types: log and drop. The host can roll forward.
		log.Printf("unknown frame type 0x%02x", uint8(ft))
		return nil
	}
}
