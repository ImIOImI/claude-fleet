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

// #268: HISTORY replay must not begin inside an escape sequence.
//
// This is a byte ring — once full it evicts one byte at a time, so its oldest
// byte sits at an arbitrary offset in the PTY stream. Ship that verbatim and
// the terminal prints the sequence's tail as text: strip the ESC from
// `ESC[6n` and a literal `[6n` lands in the user's transcript, permanently.

func TestTrimToSafeStart_SkipsOrphanedEscapeTail(t *testing.T) {
	// ESC evicted; "[6n" would otherwise be printed as literal text.
	got := string(trimToSafeStart([]byte("[6n\x1b[38;5;33mhello\r\n")))
	if want := "\x1b[38;5;33mhello\r\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestTrimToSafeStart_DropsPartialLineWhenItComesFirst(t *testing.T) {
	got := string(trimToSafeStart([]byte("own fox jumps.\nrow-1 \x1b[0mfull\n")))
	if want := "row-1 \x1b[0mfull\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestTrimToSafeStart_KeepsAlreadyCleanStart(t *testing.T) {
	in := []byte("\x1b[2Jclean")
	if got := string(trimToSafeStart(in)); got != string(in) {
		t.Fatalf("got %q, want unchanged %q", got, in)
	}
}

func TestTrimToSafeStart_NeverStartsOnUTF8Continuation(t *testing.T) {
	// Cut inside ⏵ (U+23F5, 3 bytes) with no ESC or newline to anchor to.
	glyph := []byte("⏵")
	in := append(append([]byte{}, glyph[1:]...), []byte("abc")...)
	if got := string(trimToSafeStart(in)); got != "abc" {
		t.Fatalf("got %q, want %q", got, "abc")
	}
}

func TestTrimToSafeStart_Empty(t *testing.T) {
	if got := trimToSafeStart(nil); len(got) != 0 {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestReplaySnapshot_UnwrappedRingIsReplayedVerbatim(t *testing.T) {
	// Nothing evicted yet: byte 0 is the real start of the session's output,
	// so trimming here would silently eat the first line of scrollback.
	r := newRingBuffer(1024)
	r.Write([]byte("first line\nsecond line\n"))
	if got, want := string(r.ReplaySnapshot()), "first line\nsecond line\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReplaySnapshot_WrappedRingSkipsPartialSequence(t *testing.T) {
	// Construct the eviction deterministically rather than relying on modular
	// arithmetic over a repeated unit — an arithmetic-dependent version of
	// this test silently SKIPPED instead of failing when the fix was removed,
	// which is worse than having no test at all.
	//
	// Ring holds N bytes. Write exactly N+1, with ESC as the very first byte,
	// so precisely that ESC is evicted and the retained head begins with the
	// orphaned "[6n" tail of a cursor-position query.
	const n = 128
	r := newRingBuffer(n)

	const tail = "\nGOOD"
	fillerLen := n + 1 - len("\x1b[6n") - len(tail)
	payload := "\x1b[6n" + strings.Repeat("A", fillerLen) + tail
	if len(payload) != n+1 {
		t.Fatalf("test setup: payload is %d bytes, want %d", len(payload), n+1)
	}
	r.Write([]byte(payload))

	// Precondition: the raw snapshot is broken in exactly the reported way.
	raw := string(r.Snapshot())
	if !strings.HasPrefix(raw, "[6n") {
		t.Fatalf("test setup: raw snapshot should start with the orphaned %q, got %q", "[6n", raw[:8])
	}

	// The fix: drop the partial line so no control residue is replayed.
	if got, want := string(r.ReplaySnapshot()), "GOOD"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
