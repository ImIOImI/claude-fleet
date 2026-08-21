package session

import (
	"bytes"
	"sync"
)

// ringBuffer is a fixed-capacity byte FIFO. Writes that exceed the
// remaining capacity overwrite the oldest bytes. Snapshot returns the
// current contents in chronological order (oldest first).
//
// One ring per session. Sized at construction; not resizable. Safe for
// concurrent Write + Snapshot (one writer, many readers).
//
// Why a plain ring instead of e.g. a chunked log: PTY output is a byte
// stream — there are no message boundaries to preserve, and what the
// host wants on reattach is "the last K bytes of what was on screen."
// A flat byte ring is the cheapest way to give them that.

type ringBuffer struct {
	mu  sync.Mutex
	buf []byte
	// start is the index of the oldest byte. size is the number of
	// valid bytes. When size == cap, start advances on every write.
	start int
	size  int
	// wrapped is true once the ring has overwritten its oldest byte. Until
	// then start==0 is the real beginning of the session's output and must be
	// replayed verbatim; only a wrapped ring can begin mid-sequence (#268).
	wrapped bool
}

func newRingBuffer(cap int) *ringBuffer {
	if cap <= 0 {
		cap = 1
	}
	return &ringBuffer{buf: make([]byte, cap)}
}

// Write appends b. If b is larger than the ring, only the last
// len(buf) bytes of b are retained.
func (r *ringBuffer) Write(b []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(b) >= len(r.buf) {
		// Incoming data alone overruns the ring — keep only its tail.
		copy(r.buf, b[len(b)-len(r.buf):])
		r.start = 0
		r.size = len(r.buf)
		r.wrapped = true
		return
	}

	for _, by := range b {
		writeAt := (r.start + r.size) % len(r.buf)
		r.buf[writeAt] = by
		if r.size < len(r.buf) {
			r.size++
		} else {
			r.start = (r.start + 1) % len(r.buf)
			r.wrapped = true
		}
	}
}

// Snapshot returns a copy of the current contents in chronological
// order. Safe to mutate.
func (r *ringBuffer) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, r.size)
	if r.size == 0 {
		return out
	}
	end := r.start + r.size
	if end <= len(r.buf) {
		copy(out, r.buf[r.start:end])
	} else {
		n := copy(out, r.buf[r.start:])
		copy(out[n:], r.buf[:end-len(r.buf)])
	}
	return out
}

// ReplaySnapshot returns the ring contents trimmed to a byte position that is
// safe to feed a terminal as the start of a stream (#268).
//
// Snapshot alone is not safe for that. This is a byte ring: once full it
// overwrites one byte at a time, so its oldest byte sits at an arbitrary
// offset in the PTY stream — routinely inside an escape sequence, and inside
// a multi-byte codepoint. Ship that as HISTORY and the terminal renders the
// sequence's tail as ordinary text: strip the ESC from `ESC[6n` (the
// cursor-position query) and a literal `[6n` is printed into the user's
// transcript, where nothing ever repairs it. The file comment above is right
// that a PTY stream has no *message* boundaries, but escape sequences and
// UTF-8 codepoints are boundaries that do matter on replay.
//
// Two positions are guaranteed not to be mid-sequence: an ESC (0x1B), which
// always starts one, and the byte after a newline, which a CSI sequence
// cannot span. Take whichever comes first, to discard as little restored
// scrollback as possible; both are ASCII, so the result is also on a UTF-8
// boundary. Costs at most one partial line of history.
func (r *ringBuffer) ReplaySnapshot() []byte {
	r.mu.Lock()
	wrapped := r.wrapped
	r.mu.Unlock()
	snap := r.Snapshot()
	if !wrapped {
		// Nothing was ever evicted: this is the true head of the stream.
		return snap
	}
	return trimToSafeStart(snap)
}

// trimToSafeStart is the pure half of ReplaySnapshot, split out so it can be
// tested directly against hand-built byte sequences.
func trimToSafeStart(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	esc := bytes.IndexByte(b, 0x1b)
	nl := bytes.IndexByte(b, '\n')

	switch {
	case esc < 0 && nl < 0:
		// One unterminated line with no escapes: nothing can be cut safely,
		// but don't hand the decoder a dangling UTF-8 continuation byte.
		i := 0
		for i < len(b) && b[i]&0xc0 == 0x80 {
			i++
		}
		return b[i:]
	case esc < 0:
		return b[nl+1:]
	case nl < 0:
		return b[esc:]
	default:
		if esc < nl+1 {
			return b[esc:]
		}
		return b[nl+1:]
	}
}

// Len returns the current valid-byte count. Mostly for tests.
func (r *ringBuffer) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.size
}
