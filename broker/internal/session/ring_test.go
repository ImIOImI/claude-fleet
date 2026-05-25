package session

import (
	"bytes"
	"strings"
	"testing"
)

func TestRingBuffer_WriteSmallerThanCapacity(t *testing.T) {
	r := newRingBuffer(10)
	r.Write([]byte("abc"))
	if got := r.Snapshot(); !bytes.Equal(got, []byte("abc")) {
		t.Errorf("got %q, want %q", got, "abc")
	}
	if r.Len() != 3 {
		t.Errorf("Len: got %d, want 3", r.Len())
	}
}

func TestRingBuffer_WriteFillsExactlyToCapacity(t *testing.T) {
	r := newRingBuffer(5)
	r.Write([]byte("hello"))
	if got := r.Snapshot(); !bytes.Equal(got, []byte("hello")) {
		t.Errorf("got %q, want hello", got)
	}
	if r.Len() != 5 {
		t.Errorf("Len: got %d, want 5", r.Len())
	}
}

func TestRingBuffer_OverflowDropsOldestBytes(t *testing.T) {
	r := newRingBuffer(5)
	r.Write([]byte("abcdef")) // 6 > 5, oldest 'a' is dropped … actually whole input replaces ring
	if got := r.Snapshot(); !bytes.Equal(got, []byte("bcdef")) {
		t.Errorf("got %q, want bcdef", got)
	}
}

func TestRingBuffer_MultipleWritesWrapAround(t *testing.T) {
	r := newRingBuffer(5)
	r.Write([]byte("abc"))
	r.Write([]byte("def")) // total 6 → oldest 'a' dropped
	if got := r.Snapshot(); !bytes.Equal(got, []byte("bcdef")) {
		t.Errorf("got %q, want bcdef", got)
	}
}

func TestRingBuffer_LargeIncomingTrimmedToTail(t *testing.T) {
	r := newRingBuffer(4)
	r.Write([]byte("0123456789"))
	if got := r.Snapshot(); !bytes.Equal(got, []byte("6789")) {
		t.Errorf("got %q, want 6789", got)
	}
}

func TestRingBuffer_EmptySnapshot(t *testing.T) {
	r := newRingBuffer(8)
	if got := r.Snapshot(); len(got) != 0 {
		t.Errorf("expected empty snapshot, got %q", got)
	}
}

func TestRingBuffer_ZeroCapClampedToOne(t *testing.T) {
	r := newRingBuffer(0)
	r.Write([]byte("xyz"))
	// "z" is the only byte that survives in a 1-byte ring.
	if got := r.Snapshot(); !bytes.Equal(got, []byte("z")) {
		t.Errorf("got %q, want z", got)
	}
}

func TestRingBuffer_SnapshotIsACopy(t *testing.T) {
	r := newRingBuffer(8)
	r.Write([]byte("hello"))
	snap := r.Snapshot()
	snap[0] = 'X'
	if got := r.Snapshot(); !bytes.Equal(got, []byte("hello")) {
		t.Errorf("snapshot mutation leaked into ring: got %q", got)
	}
}

func TestRingBuffer_ConcurrentWriteAndSnapshot(t *testing.T) {
	// Smoke: spawn writers, snapshot in between, nothing panics or races
	// (run with -race to catch races).
	r := newRingBuffer(1024)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			r.Write([]byte(strings.Repeat("a", 13)))
		}
		close(done)
	}()
	for {
		_ = r.Snapshot()
		select {
		case <-done:
			return
		default:
		}
	}
}
