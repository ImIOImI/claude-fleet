package session

import "sync"

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
		return
	}

	for _, by := range b {
		writeAt := (r.start + r.size) % len(r.buf)
		r.buf[writeAt] = by
		if r.size < len(r.buf) {
			r.size++
		} else {
			r.start = (r.start + 1) % len(r.buf)
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

// Len returns the current valid-byte count. Mostly for tests.
func (r *ringBuffer) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.size
}
