package proto

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestFrameRoundtrip(t *testing.T) {
	cases := []struct {
		name    string
		ft      FrameType
		payload []byte
	}{
		{"empty payload", FrameList, nil},
		{"small json", FrameClose, []byte(`{"channel":7}`)},
		{"big binary", FrameOutput, bytes.Repeat([]byte{0xab}, 64*1024)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := WriteFrame(&buf, tc.ft, tc.payload); err != nil {
				t.Fatalf("WriteFrame: %v", err)
			}
			ft, payload, err := ReadFrame(&buf)
			if err != nil {
				t.Fatalf("ReadFrame: %v", err)
			}
			if ft != tc.ft {
				t.Errorf("frame type: got %v, want %v", ft, tc.ft)
			}
			if !bytes.Equal(payload, tc.payload) {
				t.Errorf("payload mismatch: got %d bytes, want %d", len(payload), len(tc.payload))
			}
		})
	}
}

func TestReadFrameRejectsOversizedPayload(t *testing.T) {
	// Build a frame header advertising 2 MiB but supply nothing — ReadFrame
	// should bail out at the size check rather than trying to allocate.
	var buf bytes.Buffer
	buf.Write([]byte{0x00, 0x20, 0x00, 0x01}) // u32 = 0x200001 ≈ 2 MiB + 1
	_, _, err := ReadFrame(&buf)
	if err == nil || !strings.Contains(err.Error(), "exceeds max") {
		t.Fatalf("expected oversized-payload error, got %v", err)
	}
}

func TestReadFrameRejectsZeroLength(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0x00, 0x00, 0x00, 0x00})
	_, _, err := ReadFrame(&buf)
	if err == nil || !strings.Contains(err.Error(), "zero-length") {
		t.Fatalf("expected zero-length error, got %v", err)
	}
}

func TestReadFrameCleanEOFOnBoundary(t *testing.T) {
	var buf bytes.Buffer
	_, _, err := ReadFrame(&buf)
	if err != io.EOF {
		t.Fatalf("expected io.EOF on empty input, got %v", err)
	}
}

func TestWriteJSONFrameAndDecode(t *testing.T) {
	var buf bytes.Buffer
	req := CreateRequest{ID: "abc", Cols: 80, Rows: 24}
	if err := WriteJSONFrame(&buf, FrameCreate, req); err != nil {
		t.Fatalf("WriteJSONFrame: %v", err)
	}
	ft, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if ft != FrameCreate {
		t.Errorf("frame type: got %v, want CREATE", ft)
	}
	var got CreateRequest
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, req) {
		t.Errorf("decoded payload: got %+v, want %+v", got, req)
	}
}

func TestChannelDataRoundtrip(t *testing.T) {
	body := []byte("hello world")
	payload := EncodeChannelData(42, body)
	ch, decoded, err := DecodeChannelData(payload)
	if err != nil {
		t.Fatalf("DecodeChannelData: %v", err)
	}
	if ch != 42 {
		t.Errorf("channel: got %d, want 42", ch)
	}
	if !bytes.Equal(decoded, body) {
		t.Errorf("body: got %q, want %q", decoded, body)
	}
}

func TestChannelDataRejectsShortPayload(t *testing.T) {
	_, _, err := DecodeChannelData([]byte{0, 1, 2})
	if err == nil {
		t.Fatal("expected error on payload shorter than 4 bytes")
	}
}

func TestResizeRoundtrip(t *testing.T) {
	payload := EncodeResize(3, 120, 30)
	ch, cols, rows, err := DecodeResize(payload)
	if err != nil {
		t.Fatalf("DecodeResize: %v", err)
	}
	if ch != 3 || cols != 120 || rows != 30 {
		t.Errorf("decoded: ch=%d cols=%d rows=%d", ch, cols, rows)
	}
}

func TestResizeRejectsWrongSize(t *testing.T) {
	_, _, _, err := DecodeResize([]byte{0, 0, 0, 1, 80, 0}) // 6 bytes
	if err == nil {
		t.Fatal("expected error on wrong-sized resize payload")
	}
}

func TestFrameTypeStringCoversAllNames(t *testing.T) {
	// Sanity check that no known frame type renders as "UNKNOWN" — keeps
	// the constant list and the String() switch in sync.
	known := []FrameType{
		FrameCreate, FrameCreated, FrameAttach, FrameAttached,
		FrameDetach, FrameDetached, FrameClose, FrameClosed,
		FrameEnded, FrameList, FrameSessions,
		FrameInput, FrameOutput, FrameHistory, FrameResize,
	}
	for _, ft := range known {
		if strings.HasPrefix(ft.String(), "UNKNOWN") {
			t.Errorf("FrameType(0x%02x) renders as %q — missing case in String()", uint8(ft), ft.String())
		}
	}
}

func TestFrameType_String_PortForwardFrames(t *testing.T) {
	cases := map[FrameType]string{
		FrameDial:      "DIAL",
		FrameDialed:    "DIALED",
		FrameListPorts: "LISTPORTS",
		FramePorts:     "PORTS",
		FrameKillPort:  "KILLPORT",
		FrameKilled:    "KILLED",
	}
	for ft, want := range cases {
		if got := ft.String(); got != want {
			t.Errorf("%#x: got %q want %q", uint8(ft), got, want)
		}
	}
}

func TestDialRequest_RoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSONFrame(&buf, FrameDial, DialRequest{Channel: 7, Port: 3000}); err != nil {
		t.Fatalf("write: %v", err)
	}
	ft, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if ft != FrameDial {
		t.Fatalf("type: got %v want DIAL", ft)
	}
	var req DialRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if req.Channel != 7 || req.Port != 3000 {
		t.Fatalf("got %+v", req)
	}
}
