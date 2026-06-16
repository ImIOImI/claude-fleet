// Package proto defines the wire protocol between claude-fleet's host
// (Electron main process) and the in-container broker.
//
// Frame format — all numbers big-endian:
//
//	[u32 totalLen][u8 frameType][payload (totalLen-1 bytes)]
//
// totalLen counts frameType + payload (so 0 is illegal — minimum is 1).
// frameType picks the payload schema.
//
// Control frames carry JSON payloads. Data frames carry a u32 channel id
// followed by raw bytes. Channel ids are per-connection — the host picks
// them when it attaches to a session. Sessions, by contrast, are
// identified by a stable session id (UUID) that persists across
// connections.
//
// Frame type catalog (lowercase verb in flight, uppercase constant in code):
//
//	Control (JSON):
//	  CREATE     C→S  {"id":"<uuid>","cols":N,"rows":M,"args":[...]}  spawn a claude PTY (args optional, e.g. ["--resume","<uuid>"])
//	  CREATED    S→C  {"id":"<uuid>","ok":true,"error":"..."}
//	  ATTACH     C→S  {"id":"<uuid>","channel":N}              claim a channel for a session
//	  ATTACHED   S→C  {"channel":N,"ok":true,"error":"..."}
//	  DETACH     C→S  {"channel":N}                            release a channel; session lives on
//	  DETACHED   S→C  {"channel":N,"ok":true}
//	  CLOSE      C→S  {"channel":N}                            kill the PTY, drop the session
//	  CLOSED     S→C  {"channel":N,"ok":true}
//	  ENDED      S→C  {"channel":N,"reason":"exit|error"}      claude exited on its own
//	  LIST       C→S  {}                                       enumerate broker's live sessions
//	  SESSIONS   S→C  {"sessions":[{"id":"...","alive":true},...]}
//
//	Data / resize (binary, prefixed by [u32 channel]):
//	  INPUT      C→S  [u32 ch][bytes...]                       feed PTY stdin
//	  OUTPUT     S→C  [u32 ch][bytes...]                       PTY stdout/stderr
//	  HISTORY    S→C  [u32 ch][bytes...]                       ring-buffer dump after ATTACH
//	  RESIZE     C→S  [u32 ch][u16 cols][u16 rows]             window resize
//
// Why split INPUT/OUTPUT instead of one DATA: makes direction explicit in
// logs and lets either side reject mis-directed frames as a bug rather
// than silently consume them.

package proto

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

type FrameType uint8

const (
	FrameCreate   FrameType = 0x01
	FrameCreated  FrameType = 0x02
	FrameAttach   FrameType = 0x03
	FrameAttached FrameType = 0x04
	FrameDetach   FrameType = 0x05
	FrameDetached FrameType = 0x06
	FrameClose    FrameType = 0x07
	FrameClosed   FrameType = 0x08
	FrameEnded    FrameType = 0x09
	FrameList     FrameType = 0x0a
	FrameSessions FrameType = 0x0b
	FrameInput    FrameType = 0x10
	FrameOutput   FrameType = 0x11
	FrameHistory  FrameType = 0x12
	FrameResize   FrameType = 0x13
)

// MaxFramePayload caps individual frame payloads so a malformed length
// can't make us allocate gigabytes. 1 MiB is comfortably larger than any
// reasonable PTY chunk + control frame, and a ring buffer dump on
// ATTACH may be sent as several HISTORY frames if the configured ring
// is larger than this.
const MaxFramePayload = 1 << 20

// String renders a frame type for logs without leaking magic numbers.
func (t FrameType) String() string {
	switch t {
	case FrameCreate:
		return "CREATE"
	case FrameCreated:
		return "CREATED"
	case FrameAttach:
		return "ATTACH"
	case FrameAttached:
		return "ATTACHED"
	case FrameDetach:
		return "DETACH"
	case FrameDetached:
		return "DETACHED"
	case FrameClose:
		return "CLOSE"
	case FrameClosed:
		return "CLOSED"
	case FrameEnded:
		return "ENDED"
	case FrameList:
		return "LIST"
	case FrameSessions:
		return "SESSIONS"
	case FrameInput:
		return "INPUT"
	case FrameOutput:
		return "OUTPUT"
	case FrameHistory:
		return "HISTORY"
	case FrameResize:
		return "RESIZE"
	}
	return fmt.Sprintf("UNKNOWN(0x%02x)", uint8(t))
}

// ── Control-frame JSON shapes ────────────────────────────────────────────

type CreateRequest struct {
	ID   string `json:"id"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
	// Args, when non-empty, are appended to the claude exec for this
	// session — the host uses this to spawn `claude --resume <uuid>`
	// instead of a fresh session. Empty for ordinary new sessions.
	Args []string `json:"args,omitempty"`
}

type CreateResponse struct {
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type AttachRequest struct {
	ID      string `json:"id"`
	Channel uint32 `json:"channel"`
}

type AttachResponse struct {
	Channel uint32 `json:"channel"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

type ChannelRequest struct {
	Channel uint32 `json:"channel"`
}

type ChannelResponse struct {
	Channel uint32 `json:"channel"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

type EndedNotice struct {
	Channel uint32 `json:"channel"`
	Reason  string `json:"reason"` // "exit" | "error" | "signal"
}

type SessionInfo struct {
	ID    string `json:"id"`
	Alive bool   `json:"alive"`
}

type SessionsResponse struct {
	Sessions []SessionInfo `json:"sessions"`
}

// ── Codec ────────────────────────────────────────────────────────────────

// ReadFrame reads exactly one frame from r. Returns the frame type and
// the payload (without the totalLen / type header). Returns io.EOF if
// the connection closed cleanly on a frame boundary.
func ReadFrame(r io.Reader) (FrameType, []byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return 0, nil, err
	}
	totalLen := binary.BigEndian.Uint32(lenBuf[:])
	if totalLen == 0 {
		return 0, nil, errors.New("proto: zero-length frame")
	}
	if totalLen-1 > MaxFramePayload {
		return 0, nil, fmt.Errorf("proto: frame payload %d exceeds max %d", totalLen-1, MaxFramePayload)
	}
	buf := make([]byte, totalLen)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return FrameType(buf[0]), buf[1:], nil
}

// WriteFrame writes one frame to w. payload is the bytes after the type
// byte (so for control frames, the JSON bytes; for data frames, the
// channel header + body).
func WriteFrame(w io.Writer, t FrameType, payload []byte) error {
	if len(payload)+1 > int(^uint32(0)) {
		return fmt.Errorf("proto: frame too large (%d bytes)", len(payload)+1)
	}
	totalLen := uint32(len(payload) + 1)
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], totalLen)
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	if _, err := w.Write([]byte{byte(t)}); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// WriteJSONFrame is a convenience for control frames whose payload is
// just a JSON-encoded value.
func WriteJSONFrame(w io.Writer, t FrameType, v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return WriteFrame(w, t, payload)
}

// EncodeChannelData builds the payload of a channel-tagged frame
// (INPUT, OUTPUT, HISTORY): [u32 channel][bytes].
func EncodeChannelData(channel uint32, body []byte) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out[:4], channel)
	copy(out[4:], body)
	return out
}

// DecodeChannelData parses the channel-prefix off a data frame payload.
// Returns the channel id and the body (which aliases payload[4:]).
func DecodeChannelData(payload []byte) (uint32, []byte, error) {
	if len(payload) < 4 {
		return 0, nil, errors.New("proto: channel-data frame too short")
	}
	return binary.BigEndian.Uint32(payload[:4]), payload[4:], nil
}

// EncodeResize builds the payload of a RESIZE frame:
// [u32 channel][u16 cols][u16 rows].
func EncodeResize(channel uint32, cols, rows uint16) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint32(out[:4], channel)
	binary.BigEndian.PutUint16(out[4:6], cols)
	binary.BigEndian.PutUint16(out[6:8], rows)
	return out
}

// DecodeResize parses a RESIZE payload.
func DecodeResize(payload []byte) (channel uint32, cols, rows uint16, err error) {
	if len(payload) != 8 {
		return 0, 0, 0, fmt.Errorf("proto: resize payload must be 8 bytes, got %d", len(payload))
	}
	channel = binary.BigEndian.Uint32(payload[:4])
	cols = binary.BigEndian.Uint16(payload[4:6])
	rows = binary.BigEndian.Uint16(payload[6:8])
	return
}
